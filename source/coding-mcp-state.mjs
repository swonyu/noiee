import {open,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {createCodingMCPRegistry} from './coding-mcp-registry.mjs';

const FILE='coding-mcp-state.json',LOCK='coding-mcp-state.lock';
const MAX_BYTES=2*1024*1024,MAX_THREADS=256,MAX_SNAPSHOTS=16,SNAPSHOT_BYTES=131072;
const plain=v=>v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const thread=v=>typeof v==='string'&&/^[\w.-]{1,160}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hash=v=>createHash('sha256').update(v).digest('hex');
const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const validIdentity=v=>exact(v,['dev','ino'])&&Object.values(v).every(x=>typeof x==='string'&&/^\d{1,30}$/.test(x));
const version=s=>['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
function copySnapshot(value){
 let nodes=0;const seen=new Set();
 function visit(v,depth){
  if(++nodes>8192||depth>32)throw Error('Invalid snapshot JSON bounds.');
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
  if(!plain(v)&&!Array.isArray(v)||seen.has(v))throw Error('Invalid snapshot JSON.');
  const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
  if(keys.some(k=>typeof k!=='string')||Array.isArray(v)&&(keys.length!==v.length+1||keys.some(k=>k!=='length'&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length))))throw Error('Invalid snapshot JSON properties.');
  seen.add(v);for(const key of keys){if(Array.isArray(v)&&key==='length')continue;const d=descriptors[key];if(!Object.hasOwn(d,'value')||!d.enumerable)throw Error('Invalid snapshot JSON accessor.');visit(d.value,depth+1);}seen.delete(v);
 }
 visit(value,0);const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>SNAPSHOT_BYTES)throw Error('Snapshot size limit exceeded.');return JSON.parse(encoded);
}

/** Compatibility metadata, never execution authority or a restored permission.
 * directory must already be a canonical, private, caller-owned directory. This
 * store creates no owner, adopts no process, connects no service, and does not
 * recover uncertain start replies. The caller must still prove owner/process/
 * family/turn identity and obtain a new native approval for every tool call.
 *
 * A short exclusive metadata write lock plus exact version checks reject
 * cooperating concurrent/stale writers. Node pathname checks are NOT hostile
 * same-user filesystem CAS/openat authority; existing trusted owner lifetime
 * protection remains required. Unknown locks and uncertain writes are retained.
 */
export class CodingMCPState {
 #directory;#nativeHelper;#filesystem=null;#ownerId;#ancestors=null;#data=null;#disk=null;#blocked=null;#queue=Promise.resolve();#tokens=new Map();#snapshots=new Map();
 constructor({directory,ownerId,nativeHelper}={}){
  if(typeof directory!=='string'||!isAbsolute(directory)||directory.length>4096||/[\x00-\x1f\x7f]/.test(directory)||directory!=='/'&&directory.endsWith('/')||!uuid(ownerId))throw Error('Invalid Coding MCP state owner configuration.');
  this.#directory=directory;this.#nativeHelper=nativeHelper;this.#ownerId=ownerId;
 }
 #serial(operation){const work=this.#queue.then(operation);this.#queue=work.catch(()=>{});return work;}
 #block(error){return this.#blocked??=Error('Coding MCP metadata blocked and preserved: '+error.message);}
 async #guard(){
  if(this.#blocked)throw this.#blocked;
  const paths=[];for(let path=this.#directory;;path=dirname(path)){paths.unshift(path);if(dirname(path)===path)break;}
  const handles=[],observed=[];
  try{
   for(let i=0;i<paths.length;i++){
    const path=paths[i],before=await lstat(path,{bigint:true});
    if(!before.isDirectory()||before.isSymbolicLink()||await realpath(path)!==path)throw Error('State directory is not canonical or has a link.');
    if(i===paths.length-1&&(before.uid!==BigInt(process.getuid())||(before.mode&0o077n)))throw Error('State directory must be caller-owned and private.');
    const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(file);const info=await file.stat({bigint:true});
    const stamp={...identity(info),mode:String(info.mode),uid:String(info.uid)};
    if(!same(identity(info),identity(before))||info.mode!==before.mode||info.uid!==before.uid||this.#ancestors&&(JSON.stringify(this.#ancestors[i])!==JSON.stringify(stamp)||this.#ancestors.length!==paths.length))throw Error('State directory identity changed.');
    observed.push(stamp);
   }
   for(let i=0;i<paths.length;i++){const info=await lstat(paths[i],{bigint:true});if(!same(identity(info),observed[i])||String(info.mode)!==observed[i].mode||String(info.uid)!==observed[i].uid||await realpath(paths[i])!==paths[i])throw Error('State directory identity changed during verification.');}
   if(this.#nativeHelper){
    const filesystem=await readFilesystemIdentity({path:this.#directory,nativeHelper:this.#nativeHelper});
    const info=await handles.at(-1).stat({bigint:true}),named=await lstat(this.#directory,{bigint:true});
    if(!same(identity(info),observed.at(-1))||!same(identity(named),observed.at(-1))||[info,named].some(s=>String(s.mode)!==observed.at(-1).mode||String(s.uid)!==observed.at(-1).uid)||filesystem.ino!==String(info.ino))throw Error('Directory changed during durable identity binding.');
    if(this.#filesystem&&!sameFilesystemIdentity(this.#filesystem,filesystem))throw Error('Directory volume identity changed.');
    this.#filesystem=filesystem;
   }
   this.#ancestors??=observed;return this.#filesystem??identity(await handles.at(-1).stat({bigint:true}));
  }finally{await Promise.allSettled(handles.map(file=>file.close()));}
 }
 async #read(path,max=MAX_BYTES){
  let before;try{before=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const valid=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.uid===BigInt(process.getuid())&&!(s.mode&0o077n)&&s.size<=BigInt(max);
  if(!valid(before))throw Error('Invalid state file type, link, permission or size.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const opened=await file.stat({bigint:true});if(!valid(opened)||version(opened)!==version(before))throw Error('State file identity changed while opening.');
   const buffer=Buffer.alloc(max+1);let used=0;
   while(used<buffer.length){const result=await file.read(buffer,used,buffer.length-used,used);if(!result.bytesRead)break;used+=result.bytesRead;}
   if(used>max||BigInt(used)!==opened.size)throw Error('State file size changed or exceeds its limit.');
   const after=await file.stat({bigint:true}),named=await lstat(path,{bigint:true});
   if(!valid(after)||!valid(named)||version(after)!==version(opened)||version(named)!==version(opened)||await realpath(path)!==path)throw Error('State file changed during reading.');
   const bytes=buffer.subarray(0,used);return {bytes,hash:hash(bytes),stamp:version(after),renameStamp:['dev','ino','mode','uid','nlink','size','mtimeNs'].map(k=>String(after[k])).join(':')};
  }finally{await file.close();}
 }
 #snapshot(value){
  const copied=copySnapshot(value),encoded=JSON.stringify(copied),cached=this.#snapshots.get(encoded);if(cached)return cached;
  if(!exact(copied,['version','namespace','catalog','dynamicTools','fingerprint']))throw Error('Invalid registry snapshot schema.');
  const registry=createCodingMCPRegistry(copied.catalog);if(!registry.matches(copied))throw Error('Invalid or changed registry snapshot.');
  const saved=registry.snapshot();if(this.#snapshots.size<MAX_SNAPSHOTS)this.#snapshots.set(encoded,saved);return saved;
 }
 #validate(data,directory){
  if(!exact(data,['version','ownerId','directory','revision','snapshots','threads','intents'])||![1,2].includes(data.version)||data.ownerId!==this.#ownerId||!(data.version===2?this.#nativeHelper&&isFilesystemIdentity(data.directory)&&sameFilesystemIdentity(data.directory,directory):validIdentity(data.directory)&&same(data.directory,this.#ancestors.at(-1)))||!Number.isSafeInteger(data.revision)||data.revision<0||!Array.isArray(data.snapshots)||data.snapshots.length>MAX_SNAPSHOTS||!Array.isArray(data.threads)||data.threads.length>MAX_THREADS||!Array.isArray(data.intents)||data.intents.length>1)throw Error('Invalid state schema, version, owner binding or limit.');
  const snapshots=new Set(),threads=new Map();
  for(const value of data.snapshots){const saved=this.#snapshot(value);if(snapshots.has(saved.fingerprint))throw Error('Duplicate registry snapshot.');snapshots.add(saved.fingerprint);}
  for(const row of data.threads){if(!exact(row,['threadId','fingerprint','parentId'])||!thread(row.threadId)||threads.has(row.threadId)||!digest(row.fingerprint)||!snapshots.has(row.fingerprint)||row.parentId!==null&&threads.get(row.parentId)!==row.fingerprint)throw Error('Invalid or duplicate thread binding or inherited parent registry.');threads.set(row.threadId,row.fingerprint);}
  for(const item of data.intents)if(!exact(item,['id','fingerprint','createdAt'])||!uuid(item.id)||!digest(item.fingerprint)||!snapshots.has(item.fingerprint)||!Number.isSafeInteger(item.createdAt)||item.createdAt<0)throw Error('Invalid pending start intent.');
  return data;
 }
 async #load(){
  try{
   const directory=await this.#guard(),disk=await this.#read(join(this.#directory,FILE));await this.#guard();
   if(this.#data){if((disk?.stamp??null)!==(this.#disk?.stamp??null)||(disk?.hash??null)!==(this.#disk?.hash??null))throw Error('State changed by another writer; stale instance refused.');return;}
   if(disk){let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(disk.bytes));}catch{throw Error('Invalid state UTF8 or corrupt JSON.');}this.#data=this.#validate(parsed,directory);}
   else this.#data={version:this.#nativeHelper?2:1,ownerId:this.#ownerId,directory,revision:0,snapshots:[],threads:[],intents:[]};
   this.#disk=disk;
  }catch(error){throw this.#block(error);}
 }
 async #syncDirectory(){const file=await open(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{if(!same(identity(await file.stat({bigint:true})),this.#ancestors.at(-1)))throw Error('State directory changed before sync.');await file.sync();}finally{await file.close();}}
 async #save(next){
  next.revision=this.#data.revision+1;this.#validate(next,this.#data.directory);
  const bytes=Buffer.from(JSON.stringify(next));if(bytes.length>MAX_BYTES)throw Error('State size limit exceeded (2 MiB).');
  const lockPath=join(this.#directory,LOCK),temp=join(this.#directory,'.coding-mcp-state.'+randomUUID()+'.tmp');
  try{
   await this.#load();
   let lock;try{lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){if(error.code==='EEXIST')throw Error('Concurrent or unresolved metadata lock exists; it was preserved.');throw error;}
   try{await lock.writeFile(randomUUID());await lock.sync();}finally{await lock.close();}
   const lockProof=await this.#read(lockPath,128);await this.#syncDirectory();await this.#load();
   const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   const written=await this.#read(temp);if(written.hash!==hash(bytes))throw Error('Temporary state content changed.');
   await this.#load();const locked=await this.#read(lockPath,128);if(locked?.stamp!==lockProof?.stamp||locked?.hash!==lockProof?.hash)throw Error('Metadata write lock changed.');
   await rename(temp,join(this.#directory,FILE));await this.#syncDirectory();await this.#guard();
   // rename legitimately changes ctime; every other identity/content field must
   // still match the privately written and synced temporary file.
   const committed=await this.#read(join(this.#directory,FILE));if(committed?.hash!==written.hash||committed?.renameStamp!==written.renameStamp)throw Error('Committed state identity changed.');
   this.#data=next;this.#disk=committed;
   const ending=await this.#read(lockPath,128);if(ending?.stamp!==lockProof.stamp||ending?.hash!==lockProof.hash)throw Error('Metadata write lock changed before release.');
   await unlink(lockPath);await this.#syncDirectory();await this.#load();
  }catch(error){throw this.#block(error);}
 }
 #pin(row){return freeze({ownerId:this.#ownerId,...row});}
 #matching(threadId,registry){
  if(!thread(threadId))throw Error('Invalid thread identity.');
  const row=this.#data.threads.find(item=>item.threadId===threadId);if(!row)throw Error('Unregistered thread binding.');
  if(!registry||typeof registry.matches!=='function'||typeof registry.snapshot!=='function')throw Error('Coding MCP registry compatibility does not match the saved thread.');
  // Canonicalize a detached, validated saved snapshot before calling anything
  // supplied by the caller. Never expose mutable persisted data to matches().
  const saved=JSON.stringify(this.#snapshot(this.#data.snapshots.find(item=>item.fingerprint===row.fingerprint)));
  const current=JSON.stringify(this.#snapshot(registry.snapshot()));
  if(current!==saved)throw Error('Coding MCP registry compatibility does not match the saved thread.');return row;
 }
 async beginStart(snapshot){
  const saved=this.#snapshot(snapshot);
  return this.#serial(async()=>{
   await this.#load();if(this.#data.intents.length)throw Error('An unresolved start intent remains; automatic retry or adoption is refused.');
   if(this.#data.threads.length>=MAX_THREADS)throw Error('Thread binding limit reached (256).');
   const next=structuredClone(this.#data);if(!next.snapshots.some(item=>item.fingerprint===saved.fingerprint)){if(next.snapshots.length>=MAX_SNAPSHOTS)throw Error('Registry snapshot limit reached (16).');next.snapshots.push(saved);}
   const pending={id:randomUUID(),fingerprint:saved.fingerprint,createdAt:Date.now()};next.intents.push(pending);await this.#save(next);
   const token=freeze({id:pending.id,ownerId:this.#ownerId,fingerprint:pending.fingerprint});this.#tokens.set(token,pending.id);return token;
  });
 }
 async commitStart(intent,threadId){
  return this.#serial(async()=>{
   const id=this.#tokens.get(intent);if(!id)throw Error('Start commit requires the original unused in-memory intent token.');
   if(!thread(threadId))throw Error('Invalid thread identity.');await this.#load();
   const pending=this.#data.intents.find(item=>item.id===id);if(!pending)throw Error('Start intent is no longer pending.');
   if(this.#data.threads.some(item=>item.threadId===threadId))throw Error('Thread is already bound and cannot be rebound.');
   const next=structuredClone(this.#data),row={threadId,fingerprint:pending.fingerprint,parentId:null};next.threads.push(row);next.intents=[];await this.#save(next);this.#tokens.delete(intent);return this.#pin(row);
  });
 }
 async require(threadId,registry){return this.#serial(async()=>{await this.#load();return this.#pin(this.#matching(threadId,registry));});}
 async fork(parentId,childId,registry){
  return this.#serial(async()=>{
   await this.#load();const parent=this.#matching(parentId,registry);if(!thread(childId))throw Error('Invalid child thread identity.');
   if(this.#data.intents.length)throw Error('An unresolved start intent remains; fork binding is refused.');
   if(this.#data.threads.some(item=>item.threadId===childId))throw Error('Child thread is already bound.');
   if(this.#data.threads.length>=MAX_THREADS)throw Error('Thread binding limit reached (256).');
   const next=structuredClone(this.#data),row={threadId:childId,fingerprint:parent.fingerprint,parentId};next.threads.push(row);await this.#save(next);return this.#pin(row);
  });
 }
 async inspect(){return this.#serial(async()=>{await this.#load();return freeze({ownerId:this.#ownerId,revision:this.#data.revision,intents:structuredClone(this.#data.intents),threads:structuredClone(this.#data.threads),snapshots:this.#data.snapshots.map(s=>({fingerprint:s.fingerprint}))});});}
}
