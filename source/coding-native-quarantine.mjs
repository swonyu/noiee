// Internal fixed-format evidence reader. No migration, process query or receipt admission API.
import {lstat,realpath,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute,normalize} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {verifyHandoffProcessIdentity} from './handoff-process.mjs';
const MAX=1048576,NAMES=['receipt.json','original-catalog.json','original-lease.json','original-shutdown.json','physical.json','preservation.json'];
const fail=()=>{throw Object.assign(Error('Native quarantine evidence is missing, changed or invalid; preserve its original failure.'),{code:'NATIVE_QUARANTINE_INVALID'});};
const need=v=>{if(!v)fail();};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const shape=(v,keys)=>need(object(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k)));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const path=v=>typeof v==='string'&&isAbsolute(v)&&normalize(v)===v&&!v.includes('\0')&&Buffer.byteLength(v)<=4096;
const stamp=s=>Object.fromEntries(['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].map(k=>[k,String(s[k])]));
const dirStamp=s=>Object.fromEntries(['dev','ino','mode','uid','gid'].map(k=>[k,String(s[k])]));
const hash=b=>createHash('sha256').update(b).digest('hex');
const ref=v=>{shape(v,['identity','sha256','bytes']);need(isFilesystemIdentity(v.identity)&&digest(v.sha256)&&integer(v.bytes,1,MAX));};
const incarnation=v=>[v.bootSession,v.pid,v.startSec,v.startUsec,v.uid];
function processRow(v,boot,uid){shape(v,['identity','ppid','executable']);verifyHandoffProcessIdentity(v.identity,{bootSession:boot,...(uid===undefined?{}:{uid})});need(integer(v.ppid,0,2147483647)&&v.ppid!==v.identity.pid&&path(v.executable));return v;}
function table(t){
 shape(t,['kind','listAPI','infoAPI','population','queries']);need(t.kind==='darwin-libproc-ancestry-v1'&&equal(t.listAPI,{name:'proc_listpids',type:1,typeinfo:0,pidBytes:4})&&equal(t.infoAPI,{name:'proc_pidinfo',flavor:13,arg:1,bufferBytes:64}));
 const p=t.population;shape(p,['estimateBytes','estimateErrno','capacityBytes','bytes','errno','pids']);need(integer(p.estimateBytes,1,262144)&&p.estimateBytes===p.capacityBytes&&p.estimateBytes%4===0&&p.estimateErrno===0&&p.errno===0&&integer(p.bytes,1,p.capacityBytes-1)&&p.bytes%4===0&&Array.isArray(p.pids)&&p.pids.length===p.bytes/4&&p.pids.every(pid=>integer(pid,0,2147483647))&&new Set(p.pids).size===p.pids.length);
 shape(t.queries,p.pids.map(String));const rows=new Map();
 for(const pid of p.pids){const q=t.queries[String(pid)];shape(q,['bytes','errno','rawHex']);need(q.bytes===64&&q.errno===0&&typeof q.rawHex==='string'&&/^[0-9a-f]{128}$/.test(q.rawHex));const b=Buffer.from(q.rawHex,'hex'),r=[0,4,8,36,44,52].map(offset=>b.readUInt32LE(offset));need(r[0]===pid&&r[1]<=2147483647&&r[2]<=2147483647);rows.set(pid,r);}
 // PID0/1 are raw ancestry terminals, never fabricated full process identities.
 const ended=new Set([0,1]);for(const pid of rows.keys()){const seen=new Set();let n=pid;while(!ended.has(n)){need(rows.has(n)&&!seen.has(n));seen.add(n);n=rows.get(n)[1];}for(const n of seen)ended.add(n);}
 return rows;
}
function physical(v,original,lease,shutdown,scopes){
 shape(v,['version','kind','ownerId','generationId','bootSession','originalProcessCapture','scopes','before','after']);need(v.version===2&&v.kind==='native-owner-quarantine-physical'&&v.ownerId===original.id&&v.generationId===original.generation.id&&v.bootSession===lease.owner.bootSession&&equal(v.scopes,scopes));
 const capture=v.originalProcessCapture;shape(capture,['observedAt','processes']);need(integer(capture.observedAt,shutdown.startedAt,shutdown.requestedAt)&&Array.isArray(capture.processes)&&capture.processes.length>=2&&capture.processes.length<=256);
 const known=new Map();let app,coordinator;
 for(const k of capture.processes){shape(k,['role','process']);need(['application','coordinator','owner-reader','provider'].includes(k.role));const r=processRow(k.process,v.bootSession,lease.owner.uid);need(!known.has(r.identity.pid));known.set(r.identity.pid,r);if(k.role==='application'){need(!app);app=r;}if(k.role==='coordinator'){need(!coordinator);coordinator=r;}}
 need(app&&coordinator&&equal(coordinator.identity,lease.owner)&&shutdown.pid===coordinator.identity.pid);
 const descends=(r,target)=>{const seen=new Set();let n=r.ppid;while(n>1){need(!seen.has(n));seen.add(n);if(n===target)return true;need(known.has(n));n=known.get(n).ppid;}return false;};
 for(const pid of known.keys()){const seen=new Set();let n=pid;while(known.has(n)){need(!seen.has(n));seen.add(n);n=known.get(n).ppid;}}
 need(descends(coordinator,app.identity.pid));for(const k of capture.processes)if(['owner-reader','provider'].includes(k.role))need(descends(k.process,coordinator.identity.pid));
 const groups=new Set([...known.values()].map(r=>r.identity.pgid));
 const boundary=o=>{
  shape(o,['startedAt','completedAt','bootSession','observer','ancestry','identities','fileUsers']);need(integer(o.startedAt,shutdown.updatedAt)&&integer(o.completedAt,o.startedAt)&&o.bootSession===v.bootSession);verifyHandoffProcessIdentity(o.observer,{bootSession:v.bootSession,uid:lease.owner.uid});need(!known.has(o.observer.pid));
  const rows=table(o.ancestry),occupied=[...known.keys()].filter(pid=>rows.has(pid)).sort((a,b)=>a-b),expected=[...new Set([o.observer.pid,...occupied])];shape(o.identities,expected.map(String));
  for(const pid of expected){const p=processRow(o.identities[String(pid)],v.bootSession,lease.owner.uid),r=rows.get(pid);need(r&&p.identity.pid===pid&&equal([pid,p.ppid,p.identity.pgid,p.identity.uid],r.slice(0,4)));if(known.has(pid))need(!equal(incarnation(p.identity),incarnation(known.get(pid).identity)));}
  need(equal(o.identities[String(o.observer.pid)].identity,o.observer));
  const safe=new Set([0,1]);for(const [pid,r] of rows){need(!groups.has(r[2]));if(pid<=1)continue;const chain=[];let n=r[1];while(!safe.has(n)){need(!known.has(n)&&rows.has(n));chain.push(n);n=rows.get(n)[1];}for(const n of chain)safe.add(n);}
  need(Array.isArray(o.fileUsers)&&o.fileUsers.length===3);for(const [i,scope] of ['coding','home','project'].entries()){shape(o.fileUsers[i],['scope','users']);need(o.fileUsers[i].scope===scope&&Array.isArray(o.fileUsers[i].users)&&o.fileUsers[i].users.length===0);}
  const relevant=new Map();for(const pid of expected){let n=pid;while(n>1){const r=rows.get(n);need(r);relevant.set(n,r);n=r[1];}relevant.set(n,rows.get(n)??null);}
  return {occupied:occupied.map(pid=>o.identities[String(pid)]),observer:o.identities[String(o.observer.pid)],ancestry:[...relevant].sort((a,b)=>a[0]-b[0])};
 };
 const before=boundary(v.before),after=boundary(v.after);need(v.before.completedAt<v.after.startedAt&&equal(before,after));
}

async function readBounded(file){const buffer=Buffer.alloc(MAX+1);let length=0;while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}need(length>0&&length<=MAX);return buffer.subarray(0,length);}
async function archive(dataDir,row,nativeHelper,expected){
 const directory=join(dataDir,'native-quarantine',row.id+'-'+row.generation.id),parents=[dataDir,join(dataDir,'native-quarantine'),directory],dirs=[],held=[];
 try{
  for(const name of parents){const s=await lstat(name,{bigint:true});need(path(name)&&s.isDirectory()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&(s.mode&0o7777n)===0o700n&&await realpath(name)===name);const prior=expected?.parents.find(d=>d.path===name);if(expected)need(prior&&equal(prior.stamp,dirStamp(s)));const identity=prior?.identity??await readFilesystemIdentity({path:name,nativeHelper});need(equal(dirStamp(s),dirStamp(await lstat(name,{bigint:true}))));dirs.push({path:name,identity,stamp:dirStamp(s)});}
  need(equal((await readdir(directory)).sort(),[...NAMES].sort()));
  for(const name of NAMES){const p=join(directory,name),s=await lstat(p,{bigint:true});need(s.isFile()&&!s.isSymbolicLink()&&s.mode===0o100600n&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&s.size>0n&&s.size<=BigInt(MAX));const f=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),record={name,path:p,f,stamp:stamp(s)};held.push(record);need(equal(record.stamp,stamp(await f.stat({bigint:true}))));record.bytes=await readBounded(f);need(BigInt(record.bytes.length)===s.size);if(expected)need(equal(record.stamp,expected.stamps[name]));record.identity=expected?.files[name].identity??await readFilesystemIdentity({path:p,nativeHelper});need(record.identity.ino===String(s.ino));}
  const files={},values={};for(const r of held){need(r.bytes.equals(await readBounded(r.f))&&equal(r.stamp,stamp(await r.f.stat({bigint:true})))&&equal(r.stamp,stamp(await lstat(r.path,{bigint:true}))));files[r.name]={identity:r.identity,sha256:hash(r.bytes),bytes:r.bytes.length};values[r.name]=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.bytes));}
  for(const d of dirs)need(equal(d.stamp,dirStamp(await lstat(d.path,{bigint:true})))&&await realpath(d.path)===d.path);
  need(equal((await readdir(directory)).sort(),[...NAMES].sort()));
  return {directory:dirs[2].identity,parents:dirs,files,values,stamps:Object.fromEntries(held.map(r=>[r.name,r.stamp]))};
 }finally{const results=await Promise.allSettled(held.map(r=>r.f.close())),failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;}
}
export async function readNativeQuarantine({dataDir,row,directory,ownersDirectory,nativeHelper,expected}){
 try{
  const pointer=row.quarantine;shape(pointer,['version','receiptSHA256','receiptIdentity']);need(pointer.version===1&&digest(pointer.receiptSHA256)&&isFilesystemIdentity(pointer.receiptIdentity)&&uuid(row.id)&&uuid(row.generation?.id));
  const a=await archive(dataDir,row,nativeHelper,expected),files=a.files,receipt=a.values['receipt.json'];
  need(sameFilesystemIdentity(a.parents[0].identity,directory)&&files['receipt.json'].sha256===pointer.receiptSHA256&&sameFilesystemIdentity(files['receipt.json'].identity,pointer.receiptIdentity));
  const inodes=new Set();for(const r of Object.values(files)){need(r.identity.volumeUUID===directory.volumeUUID&&!inodes.has(r.identity.ino));inodes.add(r.identity.ino);}
  shape(receipt,['version','action','directory','originalRow','references','nativeQuitPassed','trackedStopVerified','universalDescendantsVerified','executionPermanentlyBlocked']);need(receipt.version===1&&receipt.action==='failed-native-owner-quarantine'&&sameFilesystemIdentity(receipt.directory,a.directory)&&receipt.nativeQuitPassed===false&&receipt.trackedStopVerified===false&&receipt.universalDescendantsVerified===false&&receipt.executionPermanentlyBlocked===true);
  shape(receipt.references,NAMES.slice(1));for(const name of NAMES.slice(1)){ref(receipt.references[name]);need(equal(receipt.references[name],files[name]));}
  const original=receipt.originalRow,catalog=a.values['original-catalog.json'];
  need(object(original)&&original.state==='ready'&&original.executionMode==='native'&&original.mcp?.kind==='journal'&&original.creation===null&&original.fork===null&&!Object.hasOwn(original,'handoff')&&!Object.hasOwn(original,'quarantine')&&original.generation?.nativeOpen===true&&original.generation.execution==='native-active'&&original.generation.executorClosed===false&&catalog?.version===12&&Array.isArray(catalog.owners)&&catalog.owners.length<=256&&catalog.owners.filter(r=>equal(r,original)).length===1&&sameFilesystemIdentity(catalog.directory,directory)&&sameFilesystemIdentity(catalog.ownersDirectory,ownersDirectory));
  need(equal(row,{...original,generation:{...original.generation,nativeOpen:row.generation.nativeOpen},quarantine:pointer}));
  const lease=a.values['original-lease.json'];shape(lease,['version','nonce','owner']);need(lease.version===1&&uuid(lease.nonce));verifyHandoffProcessIdentity(lease.owner,{uid:process.getuid()});
  const s=a.values['original-shutdown.json'];shape(s,['version','id','pid','startedAt','requestedAt','updatedAt','revision','trigger','state','executionRevoked','subsystems']);shape(s.subsystems,['command','inference','tools','worktrees','git','schedules','coding']);need(s.version===1&&uuid(s.id)&&s.pid===lease.owner.pid&&integer(s.startedAt)&&integer(s.requestedAt,s.startedAt)&&integer(s.updatedAt,s.requestedAt)&&integer(s.revision,1)&&s.trigger==='native-request'&&s.state==='unconfirmed'&&s.executionRevoked===null&&s.subsystems.coding==='failed'&&['command','inference','tools','worktrees','git','schedules'].every(k=>s.subsystems[k]==='closed'));
  const p=a.values['physical.json'];need(Array.isArray(p?.scopes)&&p.scopes.length===3);const scopes=p.scopes;for(const [i,kind] of ['coding','home','project'].entries()){shape(scopes[i],['kind','path','identity']);need(scopes[i].kind===kind&&path(scopes[i].path)&&isFilesystemIdentity(scopes[i].identity));}
  need(scopes[0].path===dataDir&&sameFilesystemIdentity(scopes[0].identity,directory)&&scopes[1].path===join(dataDir,'owners',row.id)&&sameFilesystemIdentity(scopes[1].identity,original.home)&&scopes[2].path===original.cwd);physical(p,original,lease,s,scopes);
  const v=a.values['preservation.json'];shape(v,['version','kind','originalRow','originals','scopes','stableStoreCopies','ownerFiles']);need(v.version===1&&v.kind==='native-owner-quarantine-preservation'&&equal(v.originalRow,original)&&equal(v.scopes,scopes));shape(v.originals,NAMES.slice(1,4));for(const name of NAMES.slice(1,4)){ref(v.originals[name]);need(equal(v.originals[name],files[name]));}
  need(Array.isArray(v.stableStoreCopies)&&v.stableStoreCopies.length===4);for(const [i,name] of ['QwenLocal','WebKit','Preferences','HTTPStorages'].entries()){const copy=v.stableStoreCopies[i];shape(copy,['name','manifestSHA256','entries']);need(copy.name===name&&digest(copy.manifestSHA256)&&integer(copy.entries,1));}
  need(object(v.ownerFiles));const names=Object.keys(v.ownerFiles);need(names.length>=3&&names.length<=4096&&names.includes('coding-mcp-state.json')&&names.includes('coding-mcp-outcomes.json'));let histories=0;
  for(const name of names){need(Buffer.byteLength(name)<=4096&&!name.includes('\\')&&!name.includes('\0')&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'));if(!['coding-mcp-state.json','coding-mcp-outcomes.json'].includes(name)){need(/^(sessions|archived_sessions)\/.+\.jsonl$/.test(name));histories++;}ref(v.ownerFiles[name]);}
  need(histories>0);
  // CodingOwners validates this full original catalog with its existing parser before admission.
 return {originalCatalog:catalog,originalRow:original,bootSession:lease.owner.bootSession,project:scopes[2],seal:{directory:a.directory,parents:a.parents,files,stamps:a.stamps}};
 }catch(error){if(error?.code==='NATIVE_QUARANTINE_INVALID')throw error;fail();}
}
