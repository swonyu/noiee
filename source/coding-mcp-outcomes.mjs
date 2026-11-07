import {open,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';

const FILE='coding-mcp-outcomes.json',LOCK='coding-mcp-outcomes.lock',MAX_BYTES=1048576,MAX_RECORDS=256;
const PROVIDER=new Set(['returned_ok','returned_error','unsupported','unknown','not_sent']);
const DELIVERY=new Set(['written','failed','withheld','unknown']);
const REASONS=new Set(['declined','cancelled','expired','refused']);
const META=['ownerGeneration','processGeneration','threadId','turnId','callId','rpcId','server','name'];
const ROW=['attemptId',...META,'createdAt','intendedAt','providerAt','deliveryAt','provider','delivery','reason'];
const plain=v=>v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const exact=(v,keys)=>plain(v)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const id=(v,max=160)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const time=v=>Number.isSafeInteger(v)&&v>=0;
const hash=v=>createHash('sha256').update(v).digest('hex');
const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const validIdentity=v=>exact(v,['dev','ino'])&&Object.values(v).every(x=>typeof x==='string'&&/^\d{1,30}$/.test(x));
const version=s=>['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const renameVersion=s=>['dev','ino','mode','uid','nlink','size','mtimeNs'].map(k=>String(s[k])).join(':');
const freeze=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
const callKey=r=>JSON.stringify([r.ownerGeneration,r.processGeneration,r.threadId,r.turnId,r.callId]);
function metadata(value){
 if(!exact(value,META)||!META.filter(k=>!['rpcId','server','name'].includes(k)).every(k=>id(value[k]))||!(id(value.rpcId)||Number.isSafeInteger(value.rpcId))||typeof value.server!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(value.server)||!id(value.name,256))throw Error('Invalid Coding MCP outcome identity; arguments and results are not accepted.');
 return Object.fromEntries(META.map(k=>[k,value[k]]));
}

/** Bounded evidence only, never execution authority. The owner supplies an
 * existing canonical private directory. initialize() is an explicit first-owner
 * operation; normal opens never turn missing evidence into an empty journal.
 * Tokens are exact in-memory objects and cannot be adopted after restart.
 *
 * Files are private, no-follow, version checked, atomically replaced and synced.
 * An exclusive lock fences cooperating writers; it is not a hostile same-user
 * pathname CAS. The host must retain its trusted owner-directory lifetime.
 * No raw arguments, results, error strings, credentials, grants or retry intent
 * are stored. Provider reports and transport writes do not prove external effects.
 *
 * fault is an optional trusted test seam, called at persistence boundaries only.
 * No UI/native route should ever supply it. Read-only inspect performs no writes.
 */
export class CodingMCPOutcomes {
 #directory;#nativeHelper;#filesystem=null;#ownerId;#readOnly;#fault;#ancestors=null;#data=null;#disk=null;#blocked=null;
 #queue=Promise.resolve();#tokens=new WeakMap();#uncertain=new Map();#allUncertain=false;
 constructor({directory,ownerId,nativeHelper,readOnly=false,fault}={}){
  if(typeof directory!=='string'||!isAbsolute(directory)||directory.length>4096||/[\x00-\x1f\x7f]/.test(directory)||directory!=='/'&&directory.endsWith('/')||!uuid(ownerId)||typeof readOnly!=='boolean'||fault!==undefined&&typeof fault!=='function')throw Error('Invalid Coding MCP outcome store configuration.');
  this.#directory=directory;this.#nativeHelper=nativeHelper;this.#ownerId=ownerId;this.#readOnly=readOnly;this.#fault=fault;
 }
 get ownerId(){return this.#ownerId;}
 get readOnly(){return this.#readOnly;}
 #serial(work){const result=this.#queue.then(work);this.#queue=result.catch(()=>{});return result;}
 #writable(){if(this.#readOnly)throw Error('Coding MCP outcome history is read-only.');if(this.#blocked)throw this.#blocked;}
 #block(reason,row=null,operation=null){
  if(row&&this.#uncertain.size<MAX_RECORDS)this.#uncertain.set(row.attemptId,{row:structuredClone(row),field:operation==='delivery'?'delivery':'both'});
  return this.#blocked??=Object.assign(Error('Coding MCP outcome journal blocked: '+reason+' Evidence was preserved; do not retry automatically.'),{code:'MCP_OUTCOME_BLOCKED'});
 }
 async #phase(name){await this.#fault?.(name);}
 async #guard(){
  const paths=[];for(let p=this.#directory;;p=dirname(p)){paths.unshift(p);if(dirname(p)===p)break;}
  const handles=[],observed=[];
  try{
   for(let i=0;i<paths.length;i++){
    const path=paths[i],before=await lstat(path,{bigint:true});
    if(!before.isDirectory()||before.isSymbolicLink()||await realpath(path)!==path)throw Error('unsafe directory');
    if(i===paths.length-1&&(before.uid!==BigInt(process.getuid())||(before.mode&0o077n)))throw Error('nonprivate directory');
    const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(file);const info=await file.stat({bigint:true});
    const stamp={...identity(info),mode:String(info.mode),uid:String(info.uid)};
    if(!same(identity(info),identity(before))||info.mode!==before.mode||info.uid!==before.uid||this.#ancestors&&(this.#ancestors.length!==paths.length||JSON.stringify(this.#ancestors[i])!==JSON.stringify(stamp)))throw Error('directory identity changed');
    observed.push(stamp);
   }
   for(let i=0;i<paths.length;i++){const info=await lstat(paths[i],{bigint:true});if(!same(identity(info),observed[i])||String(info.mode)!==observed[i].mode||String(info.uid)!==observed[i].uid||await realpath(paths[i])!==paths[i])throw Error('directory changed while reading');}
   if(this.#nativeHelper){
    const filesystem=await readFilesystemIdentity({path:this.#directory,nativeHelper:this.#nativeHelper});
    const info=await handles.at(-1).stat({bigint:true}),named=await lstat(this.#directory,{bigint:true});
    if(!same(identity(info),observed.at(-1))||!same(identity(named),observed.at(-1))||[info,named].some(s=>String(s.mode)!==observed.at(-1).mode||String(s.uid)!==observed.at(-1).uid)||filesystem.ino!==String(info.ino))throw Error('Directory changed during durable identity binding.');
    if(this.#filesystem&&!sameFilesystemIdentity(this.#filesystem,filesystem))throw Error('Directory volume identity changed.');
    this.#filesystem=filesystem;
   }
   this.#ancestors??=observed;return this.#filesystem??identity(await handles.at(-1).stat({bigint:true}));
  }finally{await Promise.allSettled(handles.map(f=>f.close()));}
 }
 async #read(path,max=MAX_BYTES){
  let before;try{before=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const valid=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.uid===BigInt(process.getuid())&&!(s.mode&0o077n)&&s.size<=BigInt(max);
  if(!valid(before))throw Error('invalid journal file');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const opened=await file.stat({bigint:true});if(!valid(opened)||version(opened)!==version(before))throw Error('file changed while opening');
   const buffer=Buffer.alloc(max+1);let used=0;while(used<buffer.length){const r=await file.read(buffer,used,buffer.length-used,used);if(!r.bytesRead)break;used+=r.bytesRead;}
   if(used>max||BigInt(used)!==opened.size)throw Error('file size changed');
   const after=await file.stat({bigint:true}),named=await lstat(path,{bigint:true});
   if(!valid(after)||!valid(named)||version(after)!==version(opened)||version(named)!==version(opened)||await realpath(path)!==path)throw Error('file changed during read');
   const bytes=buffer.subarray(0,used);return {bytes,hash:hash(bytes),stamp:version(after),renameStamp:renameVersion(after)};
  }finally{await file.close();}
 }
 #validate(data,directory){
  if(!exact(data,['version','ownerId','storeId','directory','revision','records'])||![1,2].includes(data.version)||data.ownerId!==this.#ownerId||!uuid(data.storeId)||!(data.version===2?this.#nativeHelper&&isFilesystemIdentity(data.directory)&&sameFilesystemIdentity(data.directory,directory):validIdentity(data.directory)&&same(data.directory,this.#ancestors.at(-1)))||!Number.isSafeInteger(data.revision)||data.revision<1||!Array.isArray(data.records)||data.records.length>MAX_RECORDS)throw Error('invalid journal schema');
  const attempts=new Set(),calls=new Set();
  for(const row of data.records){
   if(!exact(row,ROW)||!uuid(row.attemptId)||attempts.has(row.attemptId)||calls.has(callKey(row)))throw Error('invalid duplicate attempt');
   metadata(Object.fromEntries(META.map(k=>[k,row[k]])));attempts.add(row.attemptId);calls.add(callKey(row));
   if(!time(row.createdAt)||!(row.intendedAt===null||row.intendedAt===row.createdAt)||![row.providerAt,row.deliveryAt].every(x=>x===null||time(x)&&x>=row.createdAt)||!PROVIDER.has(row.provider)||!DELIVERY.has(row.delivery))throw Error('invalid outcome state');
   if(row.providerAt===null&&row.provider!=='unknown'||row.deliveryAt===null&&row.delivery!=='unknown'||row.deliveryAt!==null&&row.providerAt===null||row.providerAt!==null&&row.deliveryAt!==null&&row.deliveryAt<row.providerAt)throw Error('invalid observation order');
   if(row.intendedAt===null){if(!REASONS.has(row.reason)||row.provider!=='not_sent'||row.providerAt!==row.createdAt)throw Error('invalid no-dispatch record');}
   else if(row.reason!==null)throw Error('invalid dispatch record');
  }
  return data;
 }
 #lockUncertainty(disk){
  try{const lock=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(disk.bytes));if(exact(lock,['version','ownerId','attemptId','operation','nonce'])&&lock.version===1&&lock.ownerId===this.#ownerId&&uuid(lock.attemptId)&&uuid(lock.nonce)&&['intent','not-sent','provider','delivery'].includes(lock.operation)){const row=this.#data?.records.find(r=>r.attemptId===lock.attemptId);if(row){this.#uncertain.set(row.attemptId,{row:structuredClone(row),field:lock.operation==='delivery'?'delivery':'both'});return;}}}catch{}
  this.#allUncertain=true;
 }
 #advance(next){
  if(next.storeId!==this.#data.storeId||next.revision<=this.#data.revision||next.records.length<this.#data.records.length)throw Error('journal rollback or replacement');
  for(let i=0;i<this.#data.records.length;i++){
   const prior=this.#data.records[i],row=next.records[i];
   if(['attemptId',...META,'createdAt','intendedAt','reason'].some(k=>row[k]!==prior[k]))throw Error('journal attempt identity changed');
   if(prior.providerAt!==null&&(row.providerAt!==prior.providerAt||row.provider!==prior.provider)||prior.deliveryAt!==null&&(row.deliveryAt!==prior.deliveryAt||row.delivery!==prior.delivery))throw Error('journal observation changed');
  }
 }
 async #load({allowMissing=false,lockProof=null}={}){
  if(this.#blocked)throw this.#blocked;
  try{
   const directory=await this.#guard(),disk=await this.#read(join(this.#directory,FILE));await this.#guard();
   if(!disk&&!allowMissing)throw Error('missing journal');
   if(this.#data){
    const changed=(disk?.stamp??null)!==(this.#disk?.stamp??null)||(disk?.hash??null)!==(this.#disk?.hash??null);
    if(changed){
     if(!this.#readOnly||!disk)throw Error('stale or missing journal');
     const next=this.#validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(disk.bytes)),directory);
     this.#advance(next);
     this.#data=next;this.#disk=disk;
    }
   }else if(disk){this.#data=this.#validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(disk.bytes)),directory);this.#disk=disk;}
   const lock=await this.#read(join(this.#directory,LOCK),1024);
   if(lockProof){if(!lock||lock.stamp!==lockProof.stamp||lock.hash!==lockProof.hash)throw Error('write lock changed');}
   else if(lock){this.#lockUncertainty(lock);throw Error('unresolved write lock');}
   return directory;
  }catch(error){if(error===this.#blocked)throw error;throw this.#block('Evidence is missing, unavailable, changed, corrupt, or has an unresolved write.');}
 }
 async #syncDirectory(){const file=await open(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{if(!same(identity(await file.stat({bigint:true})),this.#ancestors.at(-1)))throw Error('directory changed before sync');await file.sync();}finally{await file.close();}}
 async #save(next,row,operation,initial=false){
  try{
   next.revision=(this.#data?.revision??0)+1;this.#validate(next,next.directory);
   const bytes=Buffer.from(JSON.stringify(next));if(bytes.length>MAX_BYTES)throw Error('journal size quota exceeded');
   await this.#load({allowMissing:initial});
   const lockPath=join(this.#directory,LOCK),temp=join(this.#directory,'.coding-mcp-outcomes.'+randomUUID()+'.tmp');
   const lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await lock.writeFile(JSON.stringify({version:1,ownerId:this.#ownerId,attemptId:row?.attemptId??null,operation,nonce:randomUUID()}));await lock.sync();}finally{await lock.close();}
   const lockProof=await this.#read(lockPath,1024);await this.#syncDirectory();await this.#phase('after-lock-sync');await this.#load({allowMissing:initial,lockProof});
   const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   const written=await this.#read(temp);if(written.hash!==hash(bytes))throw Error('temporary journal changed');
   await this.#phase('after-temp-sync');await this.#load({allowMissing:initial,lockProof});
   await rename(temp,join(this.#directory,FILE));await this.#phase('after-rename');
   await this.#syncDirectory();await this.#phase('after-directory-sync');await this.#guard();
   const committed=await this.#read(join(this.#directory,FILE));if(committed?.hash!==written.hash||committed?.renameStamp!==written.renameStamp)throw Error('committed journal changed');
   await this.#phase('after-commit-verify');this.#data=next;this.#disk=committed;
   const ending=await this.#read(lockPath,1024);if(ending?.stamp!==lockProof.stamp||ending?.hash!==lockProof.hash)throw Error('write lock changed before release');
   await unlink(lockPath);await this.#syncDirectory();await this.#phase('after-lock-release');await this.#load();
  }catch{throw this.#block('Persistence is unconfirmed or exceeded its quota.',row,operation);}
 }
 async initialize(){
  return this.#serial(async()=>{
   this.#writable();const directory=await this.#load({allowMissing:true});if(this.#data)throw Error('Coding MCP outcome journal already exists.');
   // This temporary empty object supplies the pinned directory for fsync only.
   this.#data={version:this.#nativeHelper?2:1,ownerId:this.#ownerId,storeId:randomUUID(),directory,revision:0,records:[]};
   await this.#save(structuredClone(this.#data),null,'initialize',true);
   return freeze({ownerId:this.#ownerId,storeId:this.#data.storeId,revision:this.#data.revision});
  });
 }
 #token(row){const token=Object.freeze({attemptId:row.attemptId,ownerId:this.#ownerId});this.#tokens.set(token,row.attemptId);return token;}
 async #create(meta,reason){
  this.#writable();await this.#load();
  if(this.#data.records.length>=MAX_RECORDS)throw this.#block('Record quota limit reached (256); no history was removed.');
  if(this.#data.records.some(r=>callKey(r)===callKey(meta)))throw Error('Coding MCP call attempt already exists; automatic retry is refused.');
  const now=Date.now(),noDispatch=reason!==null,row={attemptId:randomUUID(),...meta,createdAt:now,intendedAt:noDispatch?null:now,providerAt:noDispatch?now:null,deliveryAt:null,provider:noDispatch?'not_sent':'unknown',delivery:'unknown',reason};
  const next=structuredClone(this.#data);next.records.push(row);await this.#save(next,row,noDispatch?'not-sent':'intent');return this.#token(row);
 }
 beginAttempt(value){let meta;try{meta=metadata(value);}catch(error){return Promise.reject(error);}return this.#serial(()=>this.#create(meta,null));}
 recordNotSent(value,options){let meta;try{meta=metadata(value);if(!exact(options,['reason'])||!REASONS.has(options.reason))throw Error('Invalid no-dispatch outcome.');}catch(error){return Promise.reject(error);}const reason=options.reason;return this.#serial(()=>this.#create(meta,reason));}
 async #observe(token,options,provider){
  this.#writable();if(!exact(options,['state'])||!(provider?PROVIDER:DELIVERY).has(options.state))throw Error('Invalid Coding MCP outcome observation.');
  const attemptId=this.#tokens.get(token);if(!attemptId)throw Error('Outcome update requires the original in-memory attempt token.');await this.#load();
  const old=this.#data.records.find(r=>r.attemptId===attemptId);if(!old)throw Error('Outcome attempt is unavailable.');
  if(provider?old.providerAt!==null:old.deliveryAt!==null||old.providerAt===null)throw Error('Outcome observation is duplicate or out of order.');
  const next=structuredClone(this.#data),row=next.records.find(r=>r.attemptId===attemptId),date=Math.max(Date.now(),row.createdAt,row.providerAt??0);
  if(provider){row.provider=options.state;row.providerAt=date;}else{row.delivery=options.state;row.deliveryAt=date;}
  await this.#save(next,row,provider?'provider':'delivery');return this.#projection(row);
 }
 #observation(token,options,provider){
  if(!exact(options,['state'])||!(provider?PROVIDER:DELIVERY).has(options.state))return Promise.reject(Error('Invalid Coding MCP outcome observation.'));
  const copied={state:options.state};return this.#serial(()=>this.#observe(token,copied,provider));
 }
 recordProvider(token,options){return this.#observation(token,options,true);}
 recordDelivery(token,options){return this.#observation(token,options,false);}
 #projection(row){
  const field=this.#allUncertain?'both':this.#uncertain.get(row.attemptId)?.field;
  return {...structuredClone(row),...(field==='both'?{provider:'unknown',providerAt:null}:{}),...(field?{delivery:'unknown',deliveryAt:null}:{}),persistence:field?'unconfirmed':'durable'};
 }
 inspect(options){
  if(!exact(options,['threadId'])||!id(options.threadId))return Promise.reject(Error('Outcome inspection requires one exact thread identity.'));
  const threadId=options.threadId;
  return this.#serial(async()=>{
   if(!this.#blocked)try{await this.#load();}catch{}
   const rows=new Map((this.#data?.records??[]).map(r=>[r.attemptId,r]));
   for(const [key,{row}] of this.#uncertain)if(!rows.has(key)&&rows.size<MAX_RECORDS)rows.set(key,row);
   return freeze({threadId,ownerId:this.#ownerId,storeId:this.#disk?this.#data.storeId:null,revision:this.#disk?this.#data.revision:0,blocked:!!this.#blocked,warning:this.#blocked?.message??'',cached:!!this.#blocked&&!!this.#disk,complete:!this.#blocked&&!!this.#disk,records:[...rows.values()].filter(r=>r.threadId===threadId).map(r=>this.#projection(r))});
  });
 }
}
