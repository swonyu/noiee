import {AsyncLocalStorage} from 'node:async_hooks';
import {isLegacyAdmission} from './legacy-admission.mjs';
import {storageValues} from './handoff-storage.mjs';
import {GitRunner} from './git-runner.mjs';
import {GitWorkflow} from './git-workflow.mjs';
import {HandoffGit,ordinaryIndex} from './handoff-git.mjs';
import {prepareHandoffStages} from './handoff-stage.mjs';
import {captureHandoffGitBaseline,publishHandoffGit,verifyHandoffGitPublication,rehydrateHandoffGitStates,reviewHandoffGitRecovery,restoreHandoffGit,finishHandoffGit,verifyHandoffGitRecovery} from './handoff-publish.mjs';
import {handoffPublishedState} from './handoff-native.mjs';
import {reviewHandoffRecoveryFiles,prepareHandoffRecoveryFiles,handoffRecoveryPublishedState} from './handoff-recovery-stage.mjs';
import {prepareOriginalCopy,createOriginalCopy,readCopyBundle} from './handoff-copy.mjs';
import {verifyHandoffProcessIdentity,verifyHandoffProcessReceipt,verifyHandoffHelper,releaseHandoffProcess} from './handoff-process.mjs';
import {readFilesystemIdentities,isFilesystemIdentity} from './filesystem-identity.mjs';
import {isDeepStrictEqual as equal} from 'node:util';
import {spawn} from 'node:child_process';
import {mkdir,open,writeFile,rename,realpath,lstat,readdir,readlink,rmdir,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname,resolve,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const MAX=1048576,ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,OID=/^[0-9a-f]{40}$/;
const unconfinedViews=new WeakMap();
const immutable=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))immutable(item);Object.freeze(value);}return value;};
function checkUnconfinedView(view,manager,epoch=manager.epoch){if(view!==undefined){const bound=unconfinedViews.get(view);if(!bound||bound.manager!==manager||bound.epoch!==epoch||bound.reconnect&&bound.reconnect!==manager.operation)throw Error('Untrusted read-only handoff view.');manager.assertEpoch(epoch);return bound;}}
const HANDOFF_ROOT_DEVICE_CHANGED=Symbol('retained handoff root device changed');
const ROOT_DEVICE_CHANGED=Symbol('legacy worktree root device changed');
const BOOT=/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,NATIVE_WRITES=new Set(['copy','copyLocal','copyCheckout','materialize','publish','recoverPublish']);
const ARCHIVE_ENTRIES=20000,ARCHIVE_BYTES=128*MAX,FILE_BYTES=32*MAX,MANIFEST_BYTES=8*MAX,BUNDLE_BYTES=512*MAX;
const decode=b=>new TextDecoder('utf-8',{fatal:true}).decode(b),fold=s=>s.normalize('NFD').toUpperCase().toLowerCase();
const quote=s=>'"'+[...Buffer.from(s)].map(n=>n>=32&&n<127&&n!==34&&n!==92?String.fromCharCode(n):'\\'+n.toString(8).padStart(3,'0')).join('')+'"';
async function syncDirectory(path){const fd=await open(path,constants.O_RDONLY);try{await fd.sync();}finally{await fd.close();}}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pathLine=value=>value.endsWith('\n')?value.slice(0,-1):value;
const inside=(root,path)=>path===root||path.startsWith(root.endsWith(sep)?root:root+sep);
const overlaps=(a,b)=>{a=fold(a);b=fold(b);return inside(a,b)||inside(b,a);};
const bareGitDirectory=names=>names.includes('HEAD')&&names.includes('objects')&&(names.includes('refs')||names.includes('reftable'));
function text(value,max,name){if(typeof value!=='string'||!value||Buffer.byteLength(value)>max||/[\0\r\n]/.test(value))throw new Error(`Invalid ${name}.`);return value;}
function identifier(value){if(typeof value!=='string'||!ID.test(value))throw new Error('Invalid worktree identifier.');return value;}
function shape(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('Invalid worktree request fields.');}
async function identity(path,directory=true){const s=await lstat(path,{bigint:true});if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile()))throw new Error('Worktree path was replaced or has the wrong type: '+path);return {dev:String(s.dev),ino:String(s.ino)};}
const validIdentity=id=>id&&typeof id.dev==='string'&&typeof id.ino==='string'&&/^\d+$/.test(id.dev)&&/^\d+$/.test(id.ino);
const same=(a,b)=>validIdentity(a)&&validIdentity(b)&&a.dev===b.dev&&a.ino===b.ino;
const sameNamespace=(a,b)=>['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(key=>a[key]===b[key]);
async function privateDirectory(path){const stat=await lstat(path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==BigInt(process.getuid())||(stat.mode&0o077n)||await realpath(path)!==path)throw new Error('Managed worktree control directory must be private and canonical.');return {path,stat};}
async function verify(path,id,directory=true){if(!same(await identity(path,directory),id))throw new Error('Worktree path identity changed: '+path);}
async function optional(path){try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function limited(path,max=MAX){const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await file.stat();if(!s.isFile()||s.size>max)throw new Error('File is not regular or exceeds its size limit: '+path);const bytes=await file.readFile();if(bytes.length>max)throw new Error('File exceeds its size limit: '+path);return bytes;}finally{await file.close();}}
async function artifactStamp(path,max){const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const a=await f.stat({bigint:true});if(!a.isFile()||a.nlink!==1n||a.size>BigInt(max))throw new Error('Recovery file has invalid type, links or size.');const h=createHash('sha256');let count=0;for await(const b of f.createReadStream({autoClose:false})){count+=b.length;if(count>max)throw new Error('Recovery file exceeds its limit.');h.update(b);}const z=await f.stat({bigint:true});if(a.size!==z.size||a.mtimeNs!==z.mtimeNs||a.dev!==z.dev||a.ino!==z.ino)throw new Error('Recovery file changed while reading.');return {identity:{dev:String(a.dev),ino:String(a.ino)},hash:h.digest('hex'),bytes:count};}finally{await f.close();}}
function progressStamp(stamp){
  shape(stamp,['sequence','identity','hash','bytes']);shape(stamp.identity,['dev','ino']);
  if(!Number.isSafeInteger(stamp.sequence)||stamp.sequence<1||stamp.sequence>8192||!validIdentity(stamp.identity)||!/^[a-f0-9]{64}$/.test(stamp.hash)||!Number.isSafeInteger(stamp.bytes)||stamp.bytes<1||stamp.bytes>MANIFEST_BYTES)throw new Error('Invalid handoff progress stamp.');
  return stamp;
}
function handoffProcessProtocol(protocol,ownerRequired=false){
  shape(protocol,['version','bootSession',...(protocol?.version===2?['manager']:[])]);
  if(![1,2].includes(protocol.version)||ownerRequired&&protocol.version!==2||typeof protocol.bootSession!=='string'||protocol.bootSession.length!==36||!BOOT.test(protocol.bootSession))throw new Error('Handoff manifest process protocol changed.');
  if(protocol.version===2)verifyHandoffProcessIdentity(protocol.manager,{uid:process.getuid(),bootSession:protocol.bootSession});
}
const handoffFingerprint=(id,recovery,progress,receipts)=>sha(JSON.stringify({id,recovery,progress,receipts:receipts.map(x=>x.stamp)}));
export async function readHandoffJSON(path,expected,max=MANIFEST_BYTES){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const before=await file.stat({bigint:true}),stable=after=>['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(key=>before[key]===after[key]);
    if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid())||(before.mode&0o077n)||before.size<1n||before.size>BigInt(max))throw new Error('Handoff receipt must be a bounded private regular file without extra links.');
    const bytes=Buffer.alloc(Number(before.size)+1);let count=0;
    while(count<bytes.length){const read=await file.read(bytes,count,bytes.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
    if(count!==Number(before.size)||!stable(await file.stat({bigint:true}))||!stable(await lstat(path,{bigint:true})))throw new Error('Handoff receipt changed while reading.');
    const data=bytes.subarray(0,count),stamp={identity:{dev:String(before.dev),ino:String(before.ino)},hash:sha(data),bytes:count};
    if(expected&&!equal(stamp,expected))throw new Error('Handoff receipt changed or was replaced.');
    return {value:JSON.parse(decode(data)),stamp,bytes:data,stat:before};
  }finally{await file.close();}
}
function handoffProgress(p,sequence,entry){
  shape(entry,['version','id','manifestHash','sequence','phase','previous','details']);
  if(entry.version!==1||entry.id!==p.id||entry.manifestHash!==p.recovery.manifest.hash||entry.sequence!==sequence||typeof entry.phase!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(entry.phase)||sequence===1&&entry.previous!==null||sequence>1&&progressStamp(entry.previous).sequence!==sequence-1)throw new Error('Handoff progress chain changed.');
  if(typeof entry.details!=='string'&&(!entry.details||typeof entry.details!=='object'||Array.isArray(entry.details)))throw new Error('Invalid handoff progress details.');
  return entry;
}
const nativeLabels=['source','destination'],nativePhases=new Set(['native-recovery-plan','native-recovery-publishing','native-recovery-published']);
const nativeRequire=(ok,message)=>{if(!ok)throw new Error('Invalid native recovery journal: '+message);},nativeOrder=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const nativeObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function nativePath(name,excluded=false){nativeRequire(typeof name==='string'&&name&&Buffer.byteLength(name)<=4096&&Buffer.from(name).toString('utf8')===name&&name.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.includes('\0')&&(excluded||fold(part)!=='.git')),'unsafe relative path');return name;}
function nativeNames(names,excluded=false){nativeRequire(Array.isArray(names)&&names.length<=ARCHIVE_ENTRIES,'path array');const seen=new Set();for(const name of names){nativePath(name,excluded);nativeRequire(!seen.has(fold(name)),'duplicate or aliased path');seen.add(fold(name));}return names;}
function nativeRoot(root){shape(root,['path','dev','ino']);nativeRequire(validIdentity(root)&&isAbsolute(root.path)&&resolve(root.path)===root.path,'root descriptor');}
function nativeStamp(row,root=null){
  nativeRequire(nativeObject(row)&&['file','directory','symlink'].includes(row.kind),'entry kind');shape(row,['identity','kind','mode','uid','gid','flags','nlink','mtime','ctime','birthtime','xattrs','acl',...(Object.hasOwn(row,'storageXattrs')?['storageXattrs']:[]),...(row.kind==='file'?['bytes','sha256']:row.kind==='symlink'?['targetBase64']:[])]);shape(row.identity,['dev','ino']);nativeRequire(validIdentity(row.identity),'entry identity');
  for(const key of ['mode','uid','gid','flags','nlink'])nativeRequire(Number.isSafeInteger(row[key])&&row[key]>=0,'entry numeric field');for(const key of ['mtime','ctime','birthtime'])nativeRequire(typeof row[key]==='string'&&/^-?\d{1,19}:\d{1,9}$/.test(row[key]),'entry timestamp');
  nativeRequire(row.acl===null||typeof row.acl==='string','entry ACL');nativeRequire(nativeObject(row.xattrs)&&Object.keys(row.xattrs).length<=ARCHIVE_ENTRIES,'entry xattrs');for(const [name,value] of Object.entries(row.xattrs)){nativeRequire(name&&!name.includes('\0'),'xattr name');shape(value,['bytes','sha256']);nativeRequire(Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=FILE_BYTES&&/^[a-f0-9]{64}$/.test(value.sha256),'xattr structure');}
  if(row.kind==='file')nativeRequire(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=FILE_BYTES&&/^[a-f0-9]{64}$/.test(row.sha256),'file structure');if(row.kind==='symlink')nativeRequire(typeof row.targetBase64==='string'&&Buffer.from(row.targetBase64,'base64').toString('base64')===row.targetBase64&&Buffer.from(row.targetBase64,'base64').length<=4096,'symlink structure');
  storageValues(row);
  if(root)nativeRequire(row.kind==='directory'&&same(row.identity,root),'root metadata identity');
}
function nativeNamespace(rows){
  nativeRequire(nativeObject(rows),'selected namespace');nativeNames(Object.keys(rows));for(const [name,row] of Object.entries(rows)){nativeStamp(row);const parts=name.split('/');for(let i=1;i<parts.length;i++)nativeRequire(rows[parts.slice(0,i).join('/')]?.kind==='directory','missing selected directory ancestor');}
}
function nativeIntent(details,plan,manifest,retained){
  const {input,desired,excluded,captured,label}=details;shape(input,['root','stage','capture','before','staged','beforeRootStamp','stagedRootStamp','captureRootStamp','install','remove','retained','directoryTimes']);shape(desired,['stamps','rootStamp']);
  for(const [key,expected] of [['root',manifest.native[label].root],['stage',plan.roots[label].stage],['capture',plan.roots[label].capture]]){nativeRoot(input[key]);nativeRequire(equal(input[key],expected),'publication root lineage');}
  for(const [key,root] of [['beforeRootStamp',input.root],['stagedRootStamp',input.stage],['captureRootStamp',input.capture]])nativeStamp(input[key],root);nativeStamp(desired.rootStamp,input.root);
  for(const rows of [input.before,input.staged,desired.stamps])nativeNamespace(rows);
  nativeRequire(Array.isArray(input.retained)&&input.retained.length<=6&&equal(input.retained.map(row=>row?.root),retained),'retained root lineage or capacity');for(const row of input.retained){shape(row,['root','stamps','rootStamp']);nativeRoot(row.root);nativeStamp(row.rootStamp,row.root);nativeNamespace(row.stamps);}
  nativeNames(input.install);nativeNames(input.remove);const install=new Set(input.install),remove=new Set(input.remove);
  for(const name of remove)nativeRequire(!install.has(name)&&Object.hasOwn(input.before,name),'removal namespace');for(const name of install)nativeRequire(Object.hasOwn(input.staged,name)&&Object.hasOwn(desired.stamps,name),'install namespace');
  nativeRequire(equal([...new Set([...Object.keys(input.before).filter(name=>!remove.has(name)),...install])].sort(nativeOrder),Object.keys(desired.stamps).sort(nativeOrder)),'desired namespace');
  for(const [name,row] of Object.entries(input.staged))nativeRequire(install.has(name)||row.kind==='directory'&&input.install.some(child=>inside(name,child)),'uninstalled staged namespace');
  nativeNames(excluded,true);for(const name of ['.git',...manifest.native[label].ignored])nativeRequire(excluded.includes(name),'missing frozen exclusion');
  for(const rows of [input.before,input.staged,desired.stamps])for(const [name,row] of Object.entries(rows))nativeRequire(!excluded.some(path=>inside(fold(path),fold(name))||(row.kind!=='directory'||install.has(name)||remove.has(name))&&inside(fold(name),fold(path))),'selected/excluded namespace conflict');
  nativeRequire(nativeObject(input.directoryTimes)&&Object.hasOwn(input.directoryTimes,''),'directory timestamp map');for(const [name,value] of Object.entries(input.directoryTimes)){if(name)nativeRequire(nativePath(name)&&input.before[name]?.kind==='directory'&&desired.stamps[name]?.kind==='directory'&&!install.has(name)&&!remove.has(name),'directory timestamp namespace');nativeRequire(typeof value==='string'&&/^-?\d{1,19}:\d{1,9}$/.test(value),'directory timestamp');}
  const names=[...new Set([...remove,...input.install.filter(name=>Object.hasOwn(input.before,name))])].sort(nativeOrder),expected=Object.fromEntries(names.map((name,i)=>[name,String(i).padStart(8,'0')]));nativeRequire(nativeObject(captured)&&equal(captured,expected),'UTF-8 capture slot map');
}
async function nativeRecoveryJournal(manifest,directory,receipts,attempts,progress,check,{emptySequence=null,verifyIdentity=verify}={}){
  const result={version:1,plans:[],intents:[],results:[],roots:Object.fromEntries(nativeLabels.map(label=>[label,[manifest.stages[label].root,manifest.stages[label].capture.root]]))},reviews=new Set(),identities=new Set(),paths=new Set();
  for(const root of [manifest.stages.payload.root,...nativeLabels.flatMap(label=>[manifest.native[label].root,manifest.copies[label].root,manifest.stages[label].root,manifest.stages[label].capture.root,...(manifest.stages[label].immutable?[manifest.stages[label].immutable.root]:[])])]){identities.add(root.dev+':'+root.ino);paths.add(fold(root.path));}
  const verifyRoot=async(root,empty=false)=>{check();const stat=await lstat(root.path,{bigint:true});nativeRequire(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===BigInt(process.getuid())&&!(stat.mode&0o077n)&&await realpath(root.path)===root.path,'registered root replaced or not private/canonical');await verifyIdentity(root.path,root);if(empty)nativeRequire((await readdir(root.path)).length===0,'new registered root must be empty');check();};
  for(const {entry} of receipts){
    if(!entry.phase.startsWith('native-recovery-')||entry.details?.outcome==='failed')continue;nativeRequire(nativePhases.has(entry.phase),'unknown native phase');const d=entry.details,attempt=attempts.findLast(row=>row.sequence<entry.sequence);nativeRequire(attempt?.sequence>0&&attempt.processProtocol?.version===2,'explicit owned recovery attempt required');
    const common=['version','attemptId','reviewId'],extra=entry.phase==='native-recovery-plan'?['mode','roots']:entry.phase==='native-recovery-publishing'?['label','input','desired','excluded','captured']:['label','intentSequence','receipt'];shape(d,[...common,...extra]);nativeRequire(d.version===1&&d.attemptId===attempt.id&&typeof d.reviewId==='string'&&d.reviewId.length===36&&ID.test(d.reviewId),'native version or attempt lineage');
    const meta={sequence:entry.sequence,uncommitted:entry.sequence>(progress?.sequence??0)};
    if(entry.phase==='native-recovery-plan'){
      nativeRequire(!result.plans.some(row=>row.attemptId===attempt.id)&&!reviews.has(d.reviewId)&&['restore','finish'].includes(d.mode)&&attempt.target===manifest[d.mode==='restore'?'source':'destination'],'duplicate review or mode/target mismatch');shape(d.roots,nativeLabels);
      for(const label of nativeLabels){nativeRequire(result.roots[label].length<=6,'recovery witness capacity exhausted (original pair plus at most three recovery pairs)');shape(d.roots[label],['stage','capture']);for(const kind of ['stage','capture']){const root=d.roots[label][kind];nativeRoot(root);nativeRequire(root.path===join(directory,`recovery-${d.reviewId}-${label}-${kind}`)&&root.dev===manifest.native[label].root.dev&&!paths.has(fold(root.path))&&!identities.has(root.dev+':'+root.ino),'foreign or reused recovery root');await verifyRoot(root,entry.sequence===emptySequence);paths.add(fold(root.path));identities.add(root.dev+':'+root.ino);}}
      result.plans.push({...meta,...d});reviews.add(d.reviewId);for(const label of nativeLabels)result.roots[label].push(d.roots[label].stage,d.roots[label].capture);
    }else{
      const plan=result.plans.find(row=>row.attemptId===attempt.id);nativeRequire(plan&&plan.reviewId===d.reviewId&&nativeLabels.includes(d.label),'publication without matching plan/label');
      if(entry.phase==='native-recovery-publishing'){nativeRequire(!result.intents.some(row=>row.attemptId===attempt.id&&row.label===d.label),'reused publication intent');const retained=result.roots[d.label].slice(0,-2);nativeIntent(d,plan,manifest,retained);result.intents.push({...meta,...d});}
      else{const intent=result.intents.find(row=>row.attemptId===attempt.id&&row.label===d.label);nativeRequire(intent&&d.intentSequence===intent.sequence&&!result.results.some(row=>row.intentSequence===intent.sequence),'published result intent lineage');handoffRecoveryPublishedState(intent,d.receipt);result.results.push({...meta,...d});}
    }
  }
  for(const plan of result.plans)for(const label of nativeLabels)for(const kind of ['stage','capture'])await verifyRoot(plan.roots[label][kind],plan.sequence===emptySequence);return result;
}
const publicRecord=r=>Object.fromEntries(['id','source','commit','cwd','createdAt','state','message','head','dirty','archivedAt'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
// Only filesystem coordinates are projected. Owner/family and process evidence
// keep their original identities and boots; content and metadata stay exact.
function reconnectCoordinates(value,from,to){
  const copy=structuredClone(value),visit=v=>{if(!v||typeof v!=='object')return;if(validIdentity(v)){if(v.dev!==from)throw Error('Reconnect evidence spans an unadmitted device.');v.dev=to;}for(const next of Object.values(v))visit(next);};visit(copy);return copy;
}
function reconnectManifest(original,from,to){
  if(original.version!==5)throw Error('Only original owner-bound v5 handoffs support this reconnect.');
  const next=structuredClone(original);for(const key of ['temporary','peers','repositories','native','copies','candidate','stages','gitBaseline'])next[key]=reconnectCoordinates(next[key],from,to);next.version=6;return next;
}
function reconnectEntry(original,from,to,manifestHash,previous){
  if(original.phase==='recovery-attempt-started'||original.phase.startsWith('native-recovery-'))throw Error('A previous recovery attempt requires separate reconnect inspection.');
  const next=structuredClone(original);if(/^(git|native)-/.test(next.phase))next.details=reconnectCoordinates(next.details,from,to);next.manifestHash=manifestHash;next.previous=previous;return next;
}

export class ManagedWorktrees {
  #creationAdmission=new AsyncLocalStorage();
  constructor({dataDir=join(homedir(),'Library/Application Support/Qwen Local/Coding'),spawnProcess,reserveMutation=async resolvePaths=>{await resolvePaths();return {release(){}};},now=()=>Date.now(),coding=null,nativeHelper=process.env.QWEN_LOCAL_NATIVE_HELPER,readIdentities=readFilesystemIdentities,managedMutationBlocked=false,legacyAdmission=null}={}){
    if(legacyAdmission!==null&&!isLegacyAdmission(legacyAdmission))throw Error('Invalid trusted worktree admission verifier.');this.legacyAdmission=legacyAdmission;
    if(typeof managedMutationBlocked!=='boolean')throw Error('Invalid trusted worktree access setting.');this.managedMutationBlocked=managedMutationBlocked;
    if(!isAbsolute(dataDir))throw new Error('Worktree data directory must be absolute.');
    Object.assign(this,{dataDir,root:join(dataDir,'Worktrees'),ledger:join(dataDir,'managed-worktrees.json'),spawnProcess,reserveMutation,now,coding,nativeHelper,readIdentities,nativeChild:null,nativeBlocked:false,plans:new Map(),retainedLeases:new Set(),records:[],handoffs:[],handoffAdmission:null,ledgerTail:Promise.resolve(),loaded:false,ledgerHash:null,operation:null,admissionOperation:null,epoch:0,closed:false});this.runner=new GitRunner({dataDir,spawnProcess,nativeHelper,processGuard:({args,scope})=>this.activeHandoff&&(scope.checkout||['dirs','files','create'].some(key=>scope[key]?.length))?this.handoffWorker('git',{commandHash:sha(JSON.stringify({args,scope}))},this.epoch):null});
  }
  allowsCreationMutation(input){
    if(input?.action==='prepare')return true;
    const p=this.plans.get(input?.planId);
    return input?.action==='create'&&!!p&&!p.operation&&p.expiresAt>this.now();
  }
  get blocked(){return this.runner.blocked||this.nativeBlocked||Boolean(this.handoffInspector?.runner.blocked)||Boolean(this.handoffEngineBlocked)||Boolean(this.reconnectUnconfirmed);}
  withLedger(fn){const task=this.ledgerTail.then(fn);this.ledgerTail=task.catch(()=>{});return task;}
  load(){return this.withLedger(()=>this.loadLedger());}
  async loadLedger(){
    await this.reconnectGuard();
    if(this.loaded){await this.checkLedger();return;}
    await mkdir(this.dataDir,{recursive:true,mode:0o700});await mkdir(this.root,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    this.rootIdentity=await identity(this.root);const rootStat=await lstat(this.root);if(rootStat.uid!==process.getuid()||(rootStat.mode&0o077))throw new Error('Managed worktree root must be private to its owner.');if(await realpath(this.root)!==this.root)throw new Error('Managed worktree root must be a canonical directory.');
    await this.runner.verify();
    const file=await optional(this.ledger);
    if(file){
      if(file.uid!==process.getuid()||(file.mode&0o077)||file.nlink!==1)throw new Error('Managed worktree ledger permissions are invalid.');
      if(!file.isFile())throw new Error('Managed worktree ledger is not regular; preserved for inspection.');
      let data,bytes,receipt;try{receipt=await readHandoffJSON(this.ledger,null,MAX);bytes=receipt.bytes;data=receipt.value;this.validateLedger(data);}catch(e){throw new Error('Managed worktree ledger is corrupt or invalid; preserved for inspection. '+e.message);}
      if(!same(data.root,this.rootIdentity)){
        const error=new Error('Managed worktree root identity changed; ledger preserved.');
        if(data.version===1&&data.root.ino===this.rootIdentity.ino&&data.root.dev!==this.rootIdentity.dev){
          const directories=await Promise.all([this.dataDir,this.root].map(privateDirectory));await verify(this.root,this.rootIdentity);
          error[ROOT_DEVICE_CHANGED]={receipt,directories};
        }
        if(data.version===2&&data.handoffs.length&&data.root.ino===this.rootIdentity.ino&&data.root.dev!==this.rootIdentity.dev)error[HANDOFF_ROOT_DEVICE_CHANGED]=true;
        throw error;
      }
      this.records=data.records;this.handoffs=data.handoffs??[];this.ledgerHash=sha(bytes);this.ledgerIdentity=await identity(this.ledger,false);
    }
    this.loaded=true;
  }
  validateLedger(data){
    if(!data||![1,2].includes(data.version)||!validIdentity(data.root)||!Array.isArray(data.records)||data.records.length>128||data.version===1&&Object.hasOwn(data,'handoffs')||data.version===2&&!Array.isArray(data.handoffs))throw new Error('Invalid ledger schema.');
    const ids=new Set();for(const r of data.records){identifier(r.id);if(ids.has(r.id))throw new Error('Duplicate worktree record.');ids.add(r.id);for(const k of ['source','cwd','commonDir','admin','gitDir']){text(r[k],4096,k);if(!isAbsolute(r[k]))throw new Error('Invalid record path.');}
      if(r.cwd!==join(this.root,r.id)||r.admin!==join(r.commonDir,'worktrees',r.id)||!OID.test(r.commit)||!Number.isFinite(r.createdAt)||!['creating','ready','archiving','archived','restoring','needs-inspection','missing'].includes(r.state)||typeof r.message!=='string'||r.message.length>2000||!r.identities||!validIdentity(r.identities.source)||!validIdentity(r.identities.common)||!validIdentity(r.identities.sourceGit))throw new Error('Invalid record ownership.');
      if(r.state==='ready'&&(!validIdentity(r.identities.cwd)||!validIdentity(r.identities.admin)||!validIdentity(r.identities.gitfile)))throw new Error('Ready record lacks filesystem identity.');
      if(r.archive){identifier(r.archive.id);if(!OID.test(r.archive.head)||typeof r.archive.phase!=='string'||r.archive.phase.length>80)throw new Error('Invalid archive descriptor.');for(const k of ['parent','directory'])if(r.archive[k]&&!validIdentity(r.archive[k]))throw new Error('Invalid archive identity.');for(const k of ['manifest','index','bundle'])if(r.archive[k]&&(!validIdentity(r.archive[k].identity)||!/^[a-f0-9]{64}$/.test(r.archive[k].hash)))throw new Error('Invalid recovery artifact.');}
      if(r.state==='archived'&&(!r.archive?.bundle||!r.archive?.manifest||!r.archive?.index||!validIdentity(r.identities.cwd)))throw new Error('Archived record lacks verified recovery.');
    }
    const handoffs=data.handoffs??[];if(handoffs.length>128)throw new Error('Handoff recovery record limit exceeded.');
    const handoffIds=new Set();for(const h of handoffs){
      shape(h,['id','worktreeId','rootThreadId','source','destination','paths','phase','state','message','createdAt','updatedAt','recovery',...(Object.hasOwn(h,'progress')?['progress']:[])]);identifier(h.id);identifier(h.worktreeId);
      const r=data.records.find(r=>r.id===h.worktreeId);if(!r||handoffIds.has(h.id))throw new Error('Invalid handoff worktree ownership.');handoffIds.add(h.id);
      if(typeof h.rootThreadId!=='string'||! /^[\w.-]{1,160}$/.test(h.rootThreadId)||![[r.source,r.cwd],[r.cwd,r.source]].some(([s,d])=>s===h.source&&d===h.destination)||overlaps(h.source,h.destination))throw new Error('Invalid handoff chat or checkout pair.');
      if(!Array.isArray(h.paths)||h.paths.length<2||h.paths.length>128)throw new Error('Invalid handoff peer inventory.');
      const paths=new Set();for(const p of h.paths){shape(p,['path','identity']);text(p.path,4096,'handoff peer path');if(!isAbsolute(p.path)||resolve(p.path)!==p.path||!validIdentity(p.identity)||paths.has(fold(p.path)))throw new Error('Invalid handoff peer identity.');paths.add(fold(p.path));}
      for(const [path,id] of [[r.source,r.identities.source],[r.cwd,r.identities.cwd]])if(!h.paths.some(p=>p.path===path&&same(p.identity,id)))throw new Error('Handoff omits an owned checkout identity.');
      if(typeof h.phase!=='string'||! /^[a-z][a-z0-9-]{0,79}$/.test(h.phase)||!['pending','needs-inspection'].includes(h.state)||typeof h.message!=='string'||h.message.length>1600||!Number.isFinite(h.createdAt)||!Number.isFinite(h.updatedAt)||h.updatedAt<h.createdAt)throw new Error('Invalid handoff recovery state.');
      if(h.recovery!==null){shape(h.recovery,['directory','manifest']);const m=h.recovery.manifest;shape(m,['identity','hash','bytes']);if(!validIdentity(h.recovery.directory)||!validIdentity(m.identity)||!/^[a-f0-9]{64}$/.test(m.hash)||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>MANIFEST_BYTES)throw new Error('Invalid handoff recovery artifact.');}
      if(Object.hasOwn(h,'progress')){const p=h.progress;shape(p,['sequence','identity','hash','bytes']);if(!h.recovery||!Number.isSafeInteger(p.sequence)||p.sequence<1||p.sequence>8192||!validIdentity(p.identity)||!/^[a-f0-9]{64}$/.test(p.hash)||!Number.isSafeInteger(p.bytes)||p.bytes<1||p.bytes>MANIFEST_BYTES)throw new Error('Invalid handoff progress artifact.');}
    }
  }
  async checkLedger(){
    await this.reconnectGuard();
    await verify(this.root,this.rootIdentity);
    const present=await optional(this.ledger);if(present&&(present.uid!==process.getuid()||(present.mode&0o077)||present.nlink!==1))throw new Error('Managed worktree ledger permissions changed.');if(present&&this.ledgerIdentity)await verify(this.ledger,this.ledgerIdentity,false);const current=present?sha(await limited(this.ledger)):null;
    if(current!==this.ledgerHash)throw new Error('Managed worktree ledger changed externally; preserved and mutation blocked.');
  }
  save(){return this.withLedger(()=>this.saveLedger());}
  async saveLedger(handoffs=this.handoffs,beforeCommit=()=>{}){
    // v1 ledger consumers must reject these descriptors. Older ordinary-project
    // admission bypasses this ledger, so app downgrade protection remains a release gate.
    await this.checkLedger();const data={version:handoffs.length?2:1,root:this.rootIdentity,records:this.records,...(handoffs.length?{handoffs}:{})};this.validateLedger(data);const encoded=JSON.stringify(data);if(Buffer.byteLength(encoded)>MAX)throw new Error('Managed worktree ledger exceeds 1 MiB.');
    const temp=this.ledger+'.'+randomUUID()+'.tmp';await writeFile(temp,encoded,{flag:'wx',mode:0o600,flush:true});await this.checkLedger();beforeCommit();await rename(temp,this.ledger);this.ledgerHash=sha(encoded);this.ledgerIdentity=await identity(this.ledger,false);const directory=await open(this.dataDir,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}
  }
  async reconnectGuard(proof=null){
    const marker=this.ledger+'.reconnect';
    if(proof){await readHandoffJSON(marker,proof.stamp,MAX);return;}
    if(this.reconnectUnconfirmed||await optional(marker))throw Error('Unresolved managed worktree reconnect; preserve the ledger, backup and transaction evidence for inspection.');
  }
  async reconnectHandoffRead(epoch,signal,proof=null){
    if(this.managedMutationBlocked)throw Error('Unrestricted writers on this boot prevent handoff reconnect.');
    const saved=(await readHandoffJSON(this.ledger,null,MAX)).value;this.validateLedger(saved);if(saved.version!==2||saved.handoffs.length!==1)throw Error('Reconnect requires one individually inspected original handoff.');
    const view=await this.#unconfinedView(signal,epoch,{proof});
    if(view.handoffs.length!==1)throw Error('Reconnect requires one individually inspected original handoff.');
    const h=view.handoffs[0],review=await this.readHandoffRecovery(h.id,epoch,view),processes=await this.inspectHandoffProcesses(review,epoch,view);
    if(review.manifest.version!==5||!isFilesystemIdentity(review.manifest.owner?.home)||review.processJournal.attempts.length!==1||review.nativeJournal.plans.length||!processes.priorBootProcessesAbsent||!processes.helpersQuiescent||processes.managerQuiescence!=='prior-boot')throw Error('Reconnect requires the original closed owner and verified prior-boot handoff writers.');
    await view.checkLedger();return {view,review,processes,context:this.handoffOwnerContext({...review.manifest,recovery:h.recovery})};
  }
  async stageHandoffReconnect(p,write,check){
    const {handoff,current,next}=p.snapshot,{review}=handoff,from=current.value.root.dev,to=next.root.dev;
    const base=this.ledger+'.'+p.id,backupPath=base+'.handoff-original',stagePath=base+'.handoff-current';
    await mkdir(backupPath,{mode:0o700});await mkdir(stagePath,{mode:0o700});check();
    const originals=[{name:'manifest.json',stamp:current.value.handoffs[0].recovery.manifest},...review.receipts.map(row=>({name:'progress-'+String(row.stamp.sequence).padStart(8,'0')+'.json',stamp:(({sequence,...s})=>s)(row.stamp)}))],backups=[];
    for(const row of originals){
      check();const found=await readHandoffJSON(join(review.directory,row.name),reconnectCoordinates(row.stamp,from,to));await write(join(backupPath,row.name),found.bytes);backups.push({name:row.name,stamp:await artifactStamp(join(backupPath,row.name),MANIFEST_BYTES)});
    }
    await syncDirectory(backupPath);await syncDirectory(this.dataDir);check();
    const manifest={...handoff.manifest,reconnect:{version:1,id:p.id,historicalContinuity:false,bootSession:handoff.processes.bootSession,fromDevice:from,toDevice:to,volumeUUID:handoff.view.currentVolumeUUID,originalManifest:structuredClone(originals[0].stamp),originalProgress:review.receipts.map(row=>structuredClone(row.stamp)),originalCommitted:structuredClone(review.progress),backupDirectory:{path:backupPath,...await identity(backupPath)},backups}};
    await write(join(stagePath,'manifest.json'),Buffer.from(JSON.stringify(manifest)));const manifestStamp=await artifactStamp(join(stagePath,'manifest.json'),MANIFEST_BYTES),files=[{name:'manifest.json',stamp:manifestStamp}];let previous=null;
    for(const row of review.receipts){
      check();const entry=reconnectEntry(row.entry,from,to,manifestStamp.hash,previous),name='progress-'+String(entry.sequence).padStart(8,'0')+'.json';await write(join(stagePath,name),Buffer.from(JSON.stringify(entry)));const stamp=await artifactStamp(join(stagePath,name),MANIFEST_BYTES);files.push({name,stamp});previous={sequence:entry.sequence,...stamp};
      if(entry.sequence===review.progress?.sequence)next.handoffs[0].progress=structuredClone(previous);
    }
    if(review.progress===null)delete next.handoffs[0].progress;
    next.handoffs[0].recovery.manifest=manifestStamp;await syncDirectory(stagePath);await syncDirectory(this.dataDir);check();this.validateLedger(next);
    return {stagePath,backupPath,originals,files,manifest,nextContext:this.handoffOwnerContext({...manifest,recovery:next.handoffs[0].recovery})};
  }
  async verifyReconnectedHandoff(manifest,directory,receipts,manifestHash,committed=undefined){
    if(manifest.version!==6)return;
    const d=manifest.reconnect;shape(d,['version','id','historicalContinuity','bootSession','fromDevice','toDevice','volumeUUID','originalManifest','originalProgress','originalCommitted','backupDirectory','backups']);
    if(d.version!==1||!ID.test(d.id)||d.historicalContinuity!==false||!BOOT.test(d.bootSession)||!/^[0-9]+$/.test(d.fromDevice)||!/^[0-9]+$/.test(d.toDevice)||d.fromDevice===d.toDevice||!isFilesystemIdentity({volumeUUID:d.volumeUUID,ino:d.backupDirectory?.ino})||d.backupDirectory.path!==this.ledger+'.'+d.id+'.handoff-original'||d.backupDirectory.dev!==d.toDevice||directory!==join(this.root,'.handoffs',manifest.id)||!Array.isArray(d.originalProgress)||d.originalProgress.length>8192||d.originalProgress.length>receipts.length||!Array.isArray(d.backups)||d.backups.length!==d.originalProgress.length+1)throw Error('Invalid handoff reconnect provenance.');
    await privateDirectory(d.backupDirectory.path);await verify(d.backupDirectory.path,d.backupDirectory);
    const identities=await this.readIdentities({paths:[this.root,d.backupDirectory.path],nativeHelper:this.nativeHelper});if(identities.some(row=>row.volumeUUID!==d.volumeUUID))throw Error('Reconnected handoff volume changed.');
    const names=['manifest.json',...d.originalProgress.map((_,i)=>'progress-'+String(i+1).padStart(8,'0')+'.json')];
    if(!equal((await readdir(d.backupDirectory.path)).sort(),[...names].sort())||!equal(d.backups.map(row=>row.name),names))throw Error('Original reconnect evidence namespace changed.');
    const original=[];for(const row of d.backups){shape(row,['name','stamp']);original.push(await readHandoffJSON(join(d.backupDirectory.path,row.name),row.stamp));}
    shape(d.originalManifest,['identity','hash','bytes']);const m=original[0];if(!validIdentity(d.originalManifest.identity)||d.originalManifest.identity.dev!==d.fromDevice||m.stamp.hash!==d.originalManifest.hash||m.stamp.bytes!==d.originalManifest.bytes||m.value.version!==5||!equal(manifest,{...reconnectManifest(m.value,d.fromDevice,d.toDevice),reconnect:d}))throw Error('Reconnected manifest differs from the preserved original.');
    let previous=null;
    for(let i=0;i<d.originalProgress.length;i++){
      const stamp=progressStamp(d.originalProgress[i]),found=original[i+1],entry=handoffProgress({id:manifest.id,recovery:{manifest:d.originalManifest}},i+1,found.value);
      if(stamp.sequence!==i+1||stamp.identity.dev!==d.fromDevice||found.stamp.hash!==stamp.hash||found.stamp.bytes!==stamp.bytes||!equal(entry.previous,previous)||!equal(receipts[i].entry,reconnectEntry(entry,d.fromDevice,d.toDevice,manifestHash,i?receipts[i-1].stamp:null)))throw Error('Reconnected progress differs from the preserved original.');previous=stamp;
    }
    if(d.originalCommitted!==null&&(!Number.isSafeInteger(d.originalCommitted.sequence)||!equal(d.originalProgress[d.originalCommitted.sequence-1],d.originalCommitted)))throw Error('Original committed recovery pointer changed.');
    if(committed!==undefined){const sequence=committed?.sequence??0,originalSequence=d.originalCommitted?.sequence??0;if(sequence<originalSequence||sequence<=d.originalProgress.length&&sequence!==originalSequence)throw Error('Reconnect changed the original committed recovery pointer.');}
    await verify(d.backupDirectory.path,d.backupDirectory);
  }
  async reconnectSnapshot(epoch,signal,proof=null){
    const check=()=>{signal.throwIfAborted();this.assertEpoch(epoch);if(this.loaded||this.records.length||this.handoffs.length||this.commandReservation||this.activeHandoff||this.handoffAdmission)throw Error('Only an unloaded legacy worktree ledger can be reconnected.');};
    check();await this.reconnectGuard(proof);const control=await privateDirectory(this.dataDir),root=await privateDirectory(this.root),current=await readHandoffJSON(this.ledger,null,MAX),data=current.value;
    this.validateLedger(data);shape(data,['version','root','records',...(data.version===2?['handoffs']:[])]);shape(data.root,['dev','ino']);
    if(!data.records.length||data.root.ino!==String(root.stat.ino)||data.root.dev===String(root.stat.dev)||data.records.some(r=>r.state!=='ready'))throw Error('Reconnect requires intact legacy ready records with only a changed root device number.');
    const handoff=data.version===2?await this.reconnectHandoffRead(epoch,signal,proof):null;
    this.rootIdentity={dev:String(root.stat.dev),ino:String(root.stat.ino)};
    const next=structuredClone(data),targets=new Map(),bindings=[],pins=[],states=[],paths=new Set(),content=new Map();
    const add=(path,before,after,directory=true,privateMode=false)=>{
      shape(before,['dev','ino']);if(!validIdentity(before)||before.dev!==data.root.dev||resolve(path)!==path)throw Error('Legacy reconnect identity or path is inconsistent.');
      const prior=targets.get(path);if(prior){if(!equal(prior.before,before)||prior.directory!==directory)throw Error('Conflicting legacy worktree identity.');prior.refs.push(after);return;}
      targets.set(path,{path,before,refs:[after],directory,privateMode});
    };
    add(this.root,data.root,next.root,true,true);
    for(let i=0;i<data.records.length;i++){
      const r=data.records[i],n=next.records[i];shape(r.identities,['source','common','sourceGit','cwd','admin','gitfile']);
      for(const [key,path] of [['source',r.source],['common',r.commonDir],['sourceGit',r.gitDir],['cwd',r.cwd],['admin',r.admin],['gitfile',join(r.cwd,'.git')]])add(path,r.identities[key],n.identities[key],key!=='gitfile');
      if(r.archive){
        const a=r.archive,b=n.archive,p=this.recoveryPaths(r);
        if(a.phase!=='restored'||['parent','directory'].some(k=>!validIdentity(a[k]))||['index','manifest','bundle'].some(k=>!validIdentity(a[k]?.identity)||!/^[a-f0-9]{64}$/.test(a[k]?.hash)||!Number.isSafeInteger(a[k]?.bytes)||a[k].bytes<1))throw Error('Reconnect requires complete restored archive artifacts.');
        add(p.parent,a.parent,b.parent,true,true);add(p.directory,a.directory,b.directory,true,true);
        for(const key of ['index','manifest','bundle'])add(p[key],a[key].identity,b[key].identity,false);
        if(await optional(p.raw))throw Error('Restored archive still has a captured checkout; reconnect requires inspection.');
      }
    }
    const entries=[...targets.values()];if(entries.length>1025)throw Error('Reconnect identity inventory exceeds its bound.');
    for(const target of entries){
      check();const s=await lstat(target.path,{bigint:true});
      if(s.isSymbolicLink()||!(target.directory?s.isDirectory():s.isFile())||s.uid!==BigInt(process.getuid())||(s.mode&(target.privateMode?0o077n:0o022n))||!target.directory&&s.nlink!==1n||String(s.ino)!==target.before.ino||s.dev!==root.stat.dev||await realpath(target.path)!==target.path)throw Error('Reconnect object identity, ownership, permissions or canonical path changed: '+target.path);
      pins.push({path:target.path,stat:s});for(const ref of target.refs)ref.dev=String(s.dev);
    }
    for(let offset=0;offset<entries.length;offset+=32){
      const batch=entries.slice(offset,offset+32),found=await this.readIdentities({paths:batch.map(t=>t.path),nativeHelper:this.nativeHelper,signal});check();
      if(!Array.isArray(found)||found.length!==batch.length)throw Error('Incomplete reconnect filesystem identity receipt.');
      for(let i=0;i<batch.length;i++){const t=batch[i],id=found[i];if(!isFilesystemIdentity(id)||id.ino!==t.before.ino||bindings.length&&id.volumeUUID!==bindings[0].after.volumeUUID)throw Error('Reconnect filesystem identity changed or spans inconsistent volumes.');bindings.push({path:t.path,before:structuredClone(t.before),after:{dev:String(root.stat.dev),...id}});}
    }
    let fileCount=0,byteCount=0;
    for(const r of next.records){
      check();await this.sourceIdentity(r);await this.verifyRecord(r);
      const discovered=await this.project(r.source,r.commit,epoch);
      if(discovered.source!==r.source||discovered.gitDir!==r.gitDir||discovered.commonDir!==r.commonDir||discovered.commit!==r.commit)throw Error('Reconnect source Git topology changed.');
      const state=await this.archiveState(r,epoch),dirty=Boolean((await this.run([...this.scoped(r.cwd,r.admin),'status','--porcelain=v1','-z','--untracked-files=all'],{epoch})).stdout),sourceMetadata=[];
      for(const [path,limit] of [[join(r.gitDir,'HEAD'),8192],[join(r.gitDir,'index'),4*MAX],[join(r.commonDir,'config'),MAX]])sourceMetadata.push({path,...await artifactStamp(path,limit)});
      states.push({id:r.id,fingerprint:state.fingerprint,head:state.head,dirty,indexHash:state.indexHash,sourceMetadata});
      const registered=(await this.run([...this.scoped(r.source,r.gitDir),'worktree','list','--porcelain','-z'],{epoch})).stdout;
      const peers=registered.split('\0\0').filter(Boolean).map(block=>({block,path:block.split('\0').find(s=>s.startsWith('worktree '))?.slice(9)}));
      // A completed handoff may attach a branch. archiveState pins HEAD and the full registration across review.
      if(!peers.some(p=>p.path===r.source)||!peers.some(p=>p.path===r.cwd&&p.block.split('\0').some(s=>s==='locked'||s.startsWith('locked '))))throw Error('Reconnect Git registration does not match the retained locked worktree.');
      for(const p of peers){if(!p.path||!isAbsolute(p.path)||await realpath(p.path)!==p.path)throw Error('Reconnect peer Git topology is not canonical.');paths.add(p.path);}if(paths.size>128)throw Error('Reconnect shared repository scope exceeds 128 projects.');
      for(const path of [r.source,r.cwd])if(!content.has(path)){const files=path===r.cwd?state.files:await this.inventory(path);fileCount+=files.files;byteCount+=files.bytes;if(fileCount>ARCHIVE_ENTRIES||byteCount>ARCHIVE_BYTES)throw Error('Reconnect content snapshot exceeds 20,000 entries or 128 MiB.');content.set(path,{path,hash:files.hash,files:files.files,bytes:files.bytes});}
      if(r.archive)await this.verifyRecovery(r,epoch,false);
    }
    if(handoff){
      if(bindings.some(b=>b.after.volumeUUID!==handoff.view.currentVolumeUUID))throw Error('Reconnect differs from the authenticated handoff volume.');
      const manifest=reconnectManifest(handoff.review.manifest,data.root.dev,next.root.dev),h=next.handoffs[0];h.paths=reconnectCoordinates(h.paths,data.root.dev,next.root.dev);
      h.recovery.directory=reconnectCoordinates(h.recovery.directory,data.root.dev,next.root.dev);
      const inspector=this.handoffInspector??=new GitWorkflow({dataDir:this.dataDir,spawnProcess:this.spawnProcess}),check=()=>{signal.throwIfAborted();this.assertEpoch(epoch);};
      const states=await rehydrateHandoffGitStates({baseline:manifest.gitBaseline,repositories:manifest.repositories,candidate:manifest.candidate},{check});
      handoff.git=await reviewHandoffGitRecovery({...manifest,states},{runner:this.runner,inspector,check,locks:reconnectCoordinates(this.handoffRecoveryLocks(handoff.review),data.root.dev,next.root.dev)});
      const peers=await inspector.peerInventory(manifest.repositories.source,inspector.epoch);if(!equal(peers.records.map(row=>({path:row.path,identity:row.id})),h.paths))throw Error('Reconnect peer scope changed.');
      for(const copy of [...Object.values(manifest.copies),manifest.stages.payload,...Object.values(manifest.stages).map(stage=>stage.immutable).filter(Boolean)])await this.verifyHandoffNativeCopy(copy,epoch);
      handoff.manifest=manifest;
    }
    const controls=[control,root];
    const recheck=async()=>{
      check();for(const p of [...controls,...pins]){const s=await lstat(p.path,{bigint:true}),keys=p.stat.isDirectory()?['dev','ino','mode','uid','gid']:['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];if(!keys.every(k=>p.stat[k]===s[k])||await realpath(p.path)!==p.path)throw Error('Reconnect object changed during inspection.');}
      const last=await readHandoffJSON(this.ledger,current.stamp,MAX);if(!sameNamespace(last.stat,current.stat)||!last.bytes.equals(current.bytes))throw Error('Reconnect ledger changed during inspection.');await this.reconnectGuard(proof);await handoff?.view.checkLedger();check();
    };
    await recheck();this.validateLedger(next);
    return {current,next,bindings,states,content:[...content.values()],paths:[...paths],controls,pins,recheck,handoff};
  }
  async reconnectRecheck(saved,epoch,signal,proof=null){
    const fresh=await this.reconnectSnapshot(epoch,signal,proof);
    if(!sameNamespace(saved.current.stat,fresh.current.stat)||!saved.current.bytes.equals(fresh.current.bytes)||!equal([saved.bindings,saved.states,saved.content,saved.paths,saved.handoff?.git,saved.handoff?.review.fingerprint], [fresh.bindings,fresh.states,fresh.content,fresh.paths,fresh.handoff?.git,fresh.handoff?.review.fingerprint]))throw Error('Worktree reconnect source or reviewed content changed.');
    for(let i=0;i<saved.pins.length;i++){const a=saved.pins[i],b=fresh.pins[i];if(a.path!==b?.path||!sameNamespace(a.stat,b.stat))throw Error('Worktree reconnect reviewed object changed.');}
    return fresh;
  }
  reconnect(action,planId){
    if(this.closed||this.operation||this.stopping)throw Error('Another worktree operation is busy or stopped.');
    const epoch=this.epoch,controller=new AbortController();this.reconnectController=controller;
    const check=()=>{controller.signal.throwIfAborted();this.assertEpoch(epoch);};
    const task=this.withLedger(async()=>{
      let p,lease;
      try{
        check();await this.reconnectGuard();if(this.commandReservation||this.activeHandoff||this.handoffAdmission||this.retainedLeases.size)throw Error('Stop retained commands and handoffs before reconnecting worktrees.');
        if(action==='prepareReconnect'){
          await this.expirePlans();if(this.plans.size)throw Error('Another worktree review is pending.');let snapshot;
          const retained=(await readHandoffJSON(this.ledger,null,MAX)).value.version===2?await this.reconnectHandoffRead(epoch,controller.signal):null;
          if(retained&&typeof this.coding?.reserveHandoffReconnect!=='function')throw Error('Original closed owner reconnect authority is unavailable.');
          const reserve=retained?resolvePaths=>this.coding.reserveHandoffReconnect(resolvePaths,retained.context,retained.review.manifest.family):this.reserveMutation;
          lease=await reserve(async()=>{snapshot=await this.reconnectSnapshot(epoch,controller.signal);return snapshot.paths;});check();await snapshot.recheck();
          const id=randomUUID(),plan={id,operation:'reconnect',root:this.root,expiresAt:this.now()+120000,ledgerSHA256:snapshot.current.stamp.hash,historicalContinuity:false,records:snapshot.next.records.map(r=>{const state=snapshot.states.find(s=>s.id===r.id);return {...publicRecord(r),head:state.head,dirty:state.dirty};}),bindings:snapshot.bindings,content:snapshot.content};
          if(retained){const m=retained.review.manifest;plan.handoffs=[{id:m.id,worktreeId:m.worktreeId,rootThreadId:m.family.rootThreadId,source:m.source,destination:m.destination,ownerId:m.owner.ownerId,manifestSHA256:retained.context.recovery.manifest.hash,receipts:retained.review.receipts.length,committedSequence:retained.review.progress?.sequence??0}];}
          if(Buffer.byteLength(JSON.stringify(plan))>MAX)throw Error('Reconnect review exceeds 1 MiB.');
          p={...plan,lease,snapshot,epoch};this.plans.set(id,p);p.timer=setTimeout(()=>{if(this.plans.get(id)===p)void this.releasePlan(p).catch(()=>{});},120000);p.timer.unref?.();lease=null;return {plan};
        }
        p=this.plans.get(planId);this.plans.delete(planId);clearTimeout(p?.timer);
        if(!p||p.operation!=='reconnect'||p.epoch!==epoch||p.expiresAt<=this.now())throw Error('Worktree reconnect plan expired, consumed or stopped.');
        await p.lease.revalidateScope?.();check();await this.reconnectRecheck(p.snapshot,epoch,controller.signal);check();
        let bytes=Buffer.from(JSON.stringify(p.snapshot.next));const base=this.ledger+'.'+p.id,backupPath=base+(p.handoffs?'.v2.backup':'.v1.backup'),receiptPath=base+'.reconnect.receipt.json',temp=base+'.reconnect.tmp',marker=this.ledger+'.reconnect';
        const evidence={version:1,id:p.id,operation:'reconnect',historicalContinuity:false,ledgerSHA256:p.ledgerSHA256,nextSHA256:p.handoffs?null:sha(bytes),backupPath,receiptPath,bindings:p.bindings,records:p.records,content:p.content,...(p.handoffs?{handoffs:p.handoffs,originalOwner:p.snapshot.handoff.context,preparedPath:base+'.prepared.json'}:{})};
        const sync=async()=>{const dir=await open(this.dataDir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const s=await dir.stat({bigint:true}),prior=p.snapshot.controls[0].stat;if(!['dev','ino','mode','uid','gid'].every(k=>s[k]===prior[k]))throw Error('Reconnect data directory changed.');await dir.sync();}finally{await dir.close();}if(await realpath(this.dataDir)!==this.dataDir)throw Error('Reconnect data directory changed.');};
        const write=async(path,data)=>{const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(data);await file.sync();}finally{await file.close();}};
        let attempted=false;
        try{
          check();attempted=true;await write(marker,Buffer.from(JSON.stringify(evidence)));const proof=await readHandoffJSON(marker,null,MAX);await sync();check();
          await write(backupPath,p.snapshot.current.bytes);const backup=await readHandoffJSON(backupPath,null,MAX);if(!backup.bytes.equals(p.snapshot.current.bytes))throw Error('Reconnect backup does not preserve the original ledger.');await sync();check();
          let staged=null,prepared=null;
          if(p.handoffs){
            await this.reconnectRecheck(p.snapshot,epoch,controller.signal,proof);check();staged=await this.stageHandoffReconnect(p,write,check);bytes=Buffer.from(JSON.stringify(p.snapshot.next));
            const value={...evidence,nextSHA256:sha(bytes),nextOwner:staged.nextContext,originals:staged.originals,files:staged.files,stagePath:staged.stagePath,originalEvidence:staged.backupPath};await write(evidence.preparedPath,Buffer.from(JSON.stringify(value)));prepared=await readHandoffJSON(evidence.preparedPath,null,MAX);await sync();check();
          }
          await write(temp,bytes);const written=await readHandoffJSON(temp,null,MAX);if(!written.bytes.equals(bytes))throw Error('Reconnect temporary ledger changed.');
          await p.lease.revalidateScope?.();check();await this.reconnectRecheck(p.snapshot,epoch,controller.signal,proof);await readHandoffJSON(backupPath,backup.stamp,MAX);await this.reconnectGuard(proof);check();
          // ponytail: Single host writer. The full final recheck is not a CAS against arbitrary external writers.
          const publish=async()=>{
            if(staged){
              await readHandoffJSON(evidence.preparedPath,prepared.stamp,MAX);const from=p.snapshot.current.value.root.dev,to=p.snapshot.next.root.dev,directory=p.snapshot.handoff.review.directory;
              for(let i=0;i<staged.files.length;i++){check();const file=staged.files[i];await readHandoffJSON(join(directory,file.name),reconnectCoordinates(staged.originals[i].stamp,from,to));await readHandoffJSON(join(staged.stagePath,file.name),file.stamp);await rename(join(staged.stagePath,file.name),join(directory,file.name));}
              await syncDirectory(directory);await syncDirectory(staged.stagePath);
              const receipts=[];for(const row of staged.files.slice(1)){const found=await readHandoffJSON(join(directory,row.name),row.stamp);receipts.push({entry:found.value,stamp:{sequence:found.value.sequence,...found.stamp}});}
              await this.verifyReconnectedHandoff(staged.manifest,directory,receipts,staged.files[0].stamp.hash,p.snapshot.next.handoffs[0].progress??null);
            }
            check();await rename(temp,this.ledger);await sync();
          };
          if(staged)await p.lease.rebind(staged.nextContext,publish);else await publish();
          // Stop after publication drains durability, without rollback or automatic replay.
          await sync();const committed=await readHandoffJSON(this.ledger,written.stamp,MAX);
          if(staged)await p.lease.revalidateScope();
          await write(receiptPath,Buffer.from(JSON.stringify({...evidence,nextSHA256:sha(bytes),...(prepared?{prepared:prepared.stamp}:{}),published:true})));const receipt=await readHandoffJSON(receiptPath,null,MAX);if(receipt.value.nextSHA256!==committed.stamp.hash)throw Error('Reconnect publication receipt changed.');await sync();
          await this.reconnectGuard(proof);await unlink(marker);await sync();
          this.records=p.snapshot.next.records;this.handoffs=p.snapshot.next.handoffs??[];this.rootIdentity=p.snapshot.next.root;this.ledgerHash=committed.stamp.hash;this.ledgerIdentity=committed.stamp.identity;this.loaded=true;
          return {reconnected:true,backupPath,receiptPath,worktrees:p.records,message:'Retained worktrees reconnected on this boot. Files and Git history were preserved; opening a chat requires its own review.'};
        }catch(error){if(attempted){this.reconnectUnconfirmed=true;throw Error('Worktree reconnect persistence is unconfirmed; preserve the ledger, backup and transaction evidence. '+error.message);}throw error;}
      }finally{if(lease)await lease.release();if(p&&action==='commitReconnect')await this.releasePlan(p);}
    });
    this.operation=task;return task.finally(()=>{if(this.operation===task)this.operation=null;if(this.reconnectController===controller)this.reconnectController=null;});
  }
  assertOpenEpoch(epoch){if(this.closed||epoch!==this.epoch)throw new Error('Worktree operation cancelled.');}
  assertEpoch(epoch){this.assertOpenEpoch(epoch);if(this.blocked)throw new Error('Previous process exit was not confirmed; restart and inspect retained worktrees.');}
  handoffPaths(h){const r=this.records.find(r=>r.id===h.worktreeId);return [...h.paths,{path:r.commonDir,identity:r.identities.common}];}
  pendingHandoff(path){return this.handoffs.find(h=>this.handoffPaths(h).some(p=>overlaps(p.path,path)));}
  handoffError(h){return Object.assign(new Error('Handoff '+h.id+' needs inspection at '+h.phase+'; affected checkouts cannot execute or mutate.'),{code:'HANDOFF_PENDING',handoffId:h.id});}
  async assertNoHandoff(paths,except=null,admission=false){
    const pending=[...this.handoffs,...(admission&&this.handoffAdmission?[this.handoffAdmission]:[])].filter(h=>h!==except);if(!pending.length)return;
    for(const path of paths){
      let h=pending.find(h=>this.handoffPaths(h).some(p=>overlaps(p.path,resolve(path))));if(h)throw this.handoffError(h);
      let canonical;try{canonical=await realpath(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      h=pending.find(h=>this.handoffPaths(h).some(p=>overlaps(p.path,canonical)));if(h)throw this.handoffError(h);
      // A renamed checkout still has the reviewed inode; aliases to its children stay fenced.
      for(let ancestor=canonical;;ancestor=dirname(ancestor)){
        const s=await lstat(ancestor,{bigint:true}),id={dev:String(s.dev),ino:String(s.ino)};h=pending.find(h=>this.handoffPaths(h).some(p=>same(p.identity,id)));if(h)throw this.handoffError(h);
        if(dirname(ancestor)===ancestor)break;
      }
    }
  }
  handoffRecords(handoffs=this.handoffs){return handoffs.map(h=>({id:h.id,worktreeId:h.worktreeId,rootThreadId:h.rootThreadId,source:h.source,destination:h.destination,phase:h.phase,state:'needs-inspection',message:h.message,recoveryDirectory:h.recovery?join(this.root,'.handoffs',h.id):null}));}
  checkUnconfinedAccess(epoch){
    this.assertEpoch(epoch);
    if(this.operation&&this.#creationAdmission.getStore()!==this.operation||this.stopping)throw new Error('Another worktree operation is busy.');
    if(this.activeHandoff||this.handoffAdmission||[...this.plans.values()].some(p=>p.operation==='handoff'))throw new Error('Full Access is unavailable while a worktree handoff is preparing or under review. Saved chats remain readable.');
  }
  async #unconfinedView(signal,epoch,reconnect=null,legacyRoot=null){
    const operation=reconnect?this.operation:null,guard=()=>this.reconnectGuard(reconnect?.proof);
    const checkpoint=()=>{signal.throwIfAborted();if(reconnect){this.assertEpoch(epoch);if(!operation||this.operation!==operation||this.reconnectController?.signal!==signal||this.stopping||this.commandReservation||this.activeHandoff||this.handoffAdmission)throw Error('Reconnect inspection authority changed.');}else this.checkUnconfinedAccess(epoch);if(this.loaded||this.records.length||this.handoffs.length)throw Error('Read-only handoff admission cannot change loaded worktree state.');};
    checkpoint();if(!isLegacyAdmission(this.legacyAdmission))throw Error('Untrusted worktree admission verifier.');await guard();
    const proof=await this.legacyAdmission.prepareWorktreeHandoff({dataDir:this.dataDir,signal,checkpoint}),doc=proof.document;
    if(!Array.isArray(doc.rows)||!doc.rows.length||doc.rows.length>20000||!Array.isArray(doc.namespaces)||doc.namespaces.length>256)throw Error('Invalid reviewed worktree evidence bounds.');
    const rows=new Map(),live=new Map(),workingRoots=new Set(),fileLimits=new Map(),bundlePaths=new Set(),lockPaths=new Set(),controlNamespaces=new Set();
    if(legacyRoot){
      const held=legacyRoot.receipt,ledgerRow=doc.rows.find(row=>row?.path===this.ledger);
      if(!Buffer.isBuffer(held?.bytes)||!ledgerRow||ledgerRow.type!=='file'||!Number.isSafeInteger(ledgerRow.bytes)||ledgerRow.bytes<1||ledgerRow.bytes>MAX||held.bytes.length!==ledgerRow.bytes||sha(held.bytes)!==ledgerRow.sha256)throw Error('Held legacy ledger is not authenticated by the reviewed map.');
      const saved=JSON.parse(decode(held.bytes));
      this.validateLedger(saved);shape(saved,['version','root','records']);shape(saved.root,['dev','ino']);
      if(!this.managedMutationBlocked||saved.version!==1||!saved.records.length||saved.records.some(r=>r.state!=='ready')||saved.root.ino!==this.rootIdentity.ino||saved.root.dev===this.rootIdentity.dev)throw Error('Read-only legacy admission requires exact ready records with only a changed root device number.');
      const controls=new Set([this.dataDir,this.root]);fileLimits.set(this.ledger,MAX);controlNamespaces.add(this.root);
      for(const r of saved.records){
        shape(r.identities,['source','common','sourceGit','cwd','admin','gitfile']);workingRoots.add(r.source);workingRoots.add(r.cwd);
        for(const path of [r.commonDir,r.gitDir,r.admin]){controls.add(path);controlNamespaces.add(path);}
        for(const path of [join(r.cwd,'.git'),join(r.admin,'gitdir'),join(r.admin,'commondir'),join(r.admin,'locked')])fileLimits.set(path,8192);
        lockPaths.add(join(r.admin,'locked'));
        const sourceLink=doc.rows.find(row=>row?.path===join(r.source,'.git'));
        if(sourceLink?.type==='file')fileLimits.set(sourceLink.path,8192);
        else if(sourceLink?.type!=='directory'||sourceLink.path!==r.gitDir)throw Error('Reviewed source Git control binding is missing.');
        if(r.archive){
          const a=r.archive,paths=this.recoveryPaths(r);if(a.phase!=='restored')throw Error('Read-only legacy admission requires a complete restored archive.');
          for(const path of [paths.parent,paths.directory]){controls.add(path);controlNamespaces.add(path);}
          for(const [key,limit] of [['index',4*MAX],['manifest',MANIFEST_BYTES],['bundle',BUNDLE_BYTES]]){const artifact=a[key];if(!validIdentity(artifact?.identity)||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<1||artifact.bytes>limit)throw Error('Reviewed restored artifact exceeds its role bound.');fileLimits.set(paths[key],limit);if(key==='bundle')bundlePaths.add(paths[key]);}
        }
      }
      for(const path of workingRoots)if(controls.has(path)||[...fileLimits].some(([file])=>file===path)||inside(this.dataDir,path)&&!inside(this.root,path)||[...controls].some(control=>control!==this.root&&control!==this.dataDir&&inside(control,path)))throw Error('Working root collides with a Git or private control role.');
      for(const row of doc.namespaces)if(workingRoots.has(row.path))throw Error('A working-root child list cannot be an immutable control namespace.');
    }
    for(const row of doc.rows){
      shape(row,['path','historicalIdentity','identity','mode','uid','type',...(row.type==='file'?['sha256','bytes']:[])]);
      const limit=legacyRoot?fileLimits.get(row.path):MANIFEST_BYTES;
      if(typeof row.path!=='string'||row.path.length>4096||row.path.includes('\0')||!isAbsolute(row.path)||resolve(row.path)!==row.path||rows.has(row.path)||!['file','directory'].includes(row.type)||!isFilesystemIdentity(row.identity)||legacyRoot&&row.identity.volumeUUID!==doc.dataDirectory.volumeUUID||row.historicalIdentity!==null&&(!validIdentity(row.historicalIdentity)||row.historicalIdentity.ino!==row.identity.ino)||!Number.isSafeInteger(row.mode)||!Number.isSafeInteger(row.uid)||row.uid!==process.getuid()||row.type==='file'&&(!/^[a-f0-9]{64}$/.test(row.sha256)||!Number.isSafeInteger(row.bytes)||row.bytes<(lockPaths.has(row.path)?0:1)||!Number.isSafeInteger(limit)||row.bytes>limit))throw Error('Invalid reviewed worktree evidence row.');
      rows.set(row.path,row);
    }
    const namespacePaths=new Set();for(const row of doc.namespaces){shape(row,['path','names']);if(rows.get(row.path)?.type!=='directory'||namespacePaths.has(row.path)||!Array.isArray(row.names)||row.names.length>20000||row.names.some(name=>typeof name!=='string'||!name||name==='.'||name==='..'||/[\/\0]/.test(name))||!equal([...new Set(row.names)].sort(),row.names))throw Error('Invalid reviewed handoff namespace.');namespacePaths.add(row.path);}
    const stat=async path=>{
      checkpoint();const row=rows.get(path);if(!row)throw Error('Path is absent from the reviewed handoff evidence.');const current=await lstat(path,{bigint:true});
      const prior=live.get(path),stable=!prior||(workingRoots.has(path)?['dev','ino','mode','uid','gid'].every(key=>prior[key]===current[key]):sameNamespace(prior,current));
      if(current.isSymbolicLink()||!(row.type==='directory'?current.isDirectory():current.isFile())||String(current.ino)!==row.identity.ino||Number(current.mode)!==row.mode||Number(current.uid)!==row.uid||(row.type==='file'?current.nlink!==1n:current.nlink<1n)||await realpath(path)!==path||!stable)throw Error('Reviewed handoff path identity or metadata changed.');checkpoint();return current;
    };
    const checkLedger=async()=>{
      checkpoint();await guard();await proof.recheck();
      const workingBefore=new Map();for(const path of workingRoots)workingBefore.set(path,await stat(path));
      const entries=[...rows.values()];for(let at=0;at<entries.length;at+=32){
        const batch=entries.slice(at,at+32),before=await Promise.all(batch.map(row=>stat(row.path))),ids=await this.readIdentities({paths:batch.map(row=>row.path),nativeHelper:this.nativeHelper,signal});checkpoint();
        for(let i=0;i<batch.length;i++){
          const row=batch[i];if(!equal(ids[i],row.identity))throw Error('Reviewed handoff volume identity changed.');
          if(row.type==='file'){
            if(bundlePaths.has(row.path)){const found=await artifactStamp(row.path,fileLimits.get(row.path));checkpoint();if(found.bytes!==row.bytes||found.hash!==row.sha256||found.identity.dev!==String(before[i].dev)||found.identity.ino!==String(before[i].ino))throw Error('Reviewed restored bundle changed.');}
            else{const bytes=await limited(row.path,legacyRoot?fileLimits.get(row.path):MANIFEST_BYTES);if(bytes.length!==row.bytes||sha(bytes)!==row.sha256)throw Error('Reviewed handoff content changed.');}
          }
          const after=await stat(row.path);if(!sameNamespace(before[i],after))throw Error('Reviewed handoff evidence changed while reading.');live.set(row.path,after);
        }
      }
      for(const row of doc.namespaces)if(!equal((await readdir(row.path)).sort(),row.names))throw Error('Reviewed handoff namespace changed.');
      await proof.recheck();for(const [path,before] of workingBefore)if(!sameNamespace(before,await stat(path)))throw Error('Working-root metadata changed within the admission check.');checkpoint();
    };
    const historicalIdentity=async(path,directory=true)=>{const row=rows.get(path);if(!row?.historicalIdentity||row.type!==(directory?'directory':'file'))throw Error('Missing historical handoff identity binding.');await stat(path);return structuredClone(row.historicalIdentity);};
    const verifyHistorical=async(path,expected,directory=true)=>{if(!same(await historicalIdentity(path,directory),expected))throw Error('Historical handoff identity binding changed.');};
    const read=async(path,expected,max=MANIFEST_BYTES)=>{
      await stat(path);const row=rows.get(path),found=await readHandoffJSON(path,null,max);await stat(path);
      if(found.stamp.hash!==row.sha256||found.stamp.bytes!==row.bytes)throw Error('Reviewed handoff receipt changed.');
      const stamp={...found.stamp,identity:row.historicalIdentity??found.stamp.identity};if(expected&&!equal(stamp,expected))throw Error('Historical handoff receipt binding changed.');return {...found,stamp};
    };
    await checkLedger();const ledger=(await read(this.ledger,null,MAX)).value;this.validateLedger(ledger);
    if(!same(rows.get(this.root)?.historicalIdentity,ledger.root)||!namespacePaths.has(this.root))throw Error('Reviewed evidence does not bind the retained worktree ledger.');
    if(legacyRoot){
      shape(ledger,['version','root','records']);shape(ledger.root,['dev','ino']);
      if(!this.managedMutationBlocked||ledger.version!==1||!ledger.records.length||ledger.records.some(r=>r.state!=='ready')||ledger.root.ino!==this.rootIdentity.ino||ledger.root.dev===this.rootIdentity.dev)throw Error('Read-only legacy admission requires exact ready records with only a changed root device number.');
      const control=rows.get(this.dataDir),receipt=rows.get(this.ledger);
      if(control?.type!=='directory'||!equal(control.identity,{volumeUUID:doc.dataDirectory.volumeUUID,ino:doc.dataDirectory.ino})||(control.mode&0o077)||receipt?.type!=='file'||(receipt.mode&0o777)!==0o600)throw Error('Reviewed legacy control identity or permissions changed.');
      const bound=(path,id,directory=true,privateMode=false)=>{
        const row=rows.get(path);
        if(!validIdentity(id)||id.dev!==ledger.root.dev||row?.type!==(directory?'directory':'file')||!same(row.historicalIdentity??{},id)||row.identity.volumeUUID!==doc.dataDirectory.volumeUUID||(row.mode&(privateMode?0o077:0o022))||directory&&controlNamespaces.has(path)&&!namespacePaths.has(path))throw Error('Reviewed legacy record identity or complete control namespace is missing.');
      };
      bound(this.root,ledger.root,true,true);
      for(const r of ledger.records){
        shape(r.identities,['source','common','sourceGit','cwd','admin','gitfile']);
        for(const [key,path] of [['source',r.source],['common',r.commonDir],['sourceGit',r.gitDir],['cwd',r.cwd],['admin',r.admin],['gitfile',join(r.cwd,'.git')]])bound(path,r.identities[key],key!=='gitfile');
        const pointerText=async path=>{
          const row=rows.get(path);if(row?.type!=='file'||row.bytes>8192||(row.mode&0o022))throw Error('Reviewed Git registration control is missing or writable by another user.');
          const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
          try{const before=await file.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||before.size>8192n||String(before.dev)!==this.rootIdentity.dev||String(before.ino)!==row.identity.ino||Number(before.mode)!==row.mode)throw Error('Git control identity changed on open.');const buffer=Buffer.alloc(Number(before.size)+1);let count=0;while(count<buffer.length){const found=await file.read(buffer,count,buffer.length-count,count);if(!found.bytesRead)break;count+=found.bytesRead;}const bytes=buffer.subarray(0,count);if(count!==Number(before.size)||bytes.length!==row.bytes||sha(bytes)!==row.sha256||!sameNamespace(before,await file.stat({bigint:true}))||!sameNamespace(before,await lstat(path,{bigint:true}))||await realpath(path)!==path)throw Error('Git control changed while reading.');checkpoint();return pathLine(decode(bytes));}finally{await file.close();}
        };
        const pointer=async(path,expected,relative=false)=>{const text=await pointerText(path);if(relative?await realpath(resolve(dirname(path),text))!==expected:text!==expected)throw Error('Reviewed Git registration pointer changed.');};
        await pointer(join(r.cwd,'.git'),'gitdir: '+r.admin);await pointer(join(r.admin,'gitdir'),join(r.cwd,'.git'));await pointer(join(r.admin,'commondir'),r.commonDir,true);
        await pointerText(join(r.admin,'locked'));
        const sourceLink=rows.get(join(r.source,'.git'));if(sourceLink?.type==='file'){const text=await pointerText(sourceLink.path);if(!text.startsWith('gitdir: ')||await realpath(resolve(r.source,text.slice(8)))!==r.gitDir)throw Error('Reviewed source Git pointer changed.');}
        if(r.archive){
          const a=r.archive,paths=this.recoveryPaths(r);if(a.phase!=='restored')throw Error('Read-only legacy admission requires a complete restored archive.');
          for(const key of ['parent','directory'])bound(paths[key],a[key],true,true);
          for(const [key,limit] of [['index',4*MAX],['manifest',MANIFEST_BYTES],['bundle',BUNDLE_BYTES]]){
            const artifact=a[key],row=rows.get(paths[key]);bound(paths[key],artifact?.identity,false,key!=='bundle');
            if(!Number.isSafeInteger(artifact.bytes)||artifact.bytes<1||artifact.bytes>limit||row.sha256!==artifact.hash||row.bytes!==artifact.bytes)throw Error('Reviewed restored archive differs from its original artifact binding.');
          }
        }
      }
    }else{
      if(ledger.version!==2||!ledger.handoffs.length)throw Error('Reviewed evidence does not bind the retained worktree ledger.');
      for(const h of ledger.handoffs){const directory=join(this.root,'.handoffs',h.id);if(!namespacePaths.has(directory))throw Error('Reviewed evidence omits the complete handoff namespace.');}
    }
    const currentReadRoot=async root=>{
      await checkLedger();const row=rows.get(root.path);
      if(row?.type!=='directory'||!same(row.historicalIdentity,root))throw Error('Recovery copy donor lacks an authenticated current read binding.');
      const observed=await stat(root.path);return {path:root.path,dev:String(observed.dev),ino:String(observed.ino)};
    };
    immutable(ledger);const view=Object.freeze({records:ledger.records,handoffs:ledger.handoffs??[],checkLedger,identity:historicalIdentity,verify:verifyHistorical,read,currentReadRoot,currentVolumeUUID:doc.dataDirectory.volumeUUID});unconfinedViews.set(view,{manager:this,epoch,reconnect:operation});return view;
  }
  async #reviewedOrdinaryProject(cwd,view,epoch,check){
    checkUnconfinedView(view,this,epoch);
    const excluded=new Set([this.dataDir,this.root]),inodes=new Set(),observed=new Map();
    for(const r of view.records){
      for(const key of ['source','cwd','gitDir','commonDir','admin'])excluded.add(r[key]);
      for(const id of Object.values(r.identities))if(validIdentity(id))inodes.add(id.ino);
      if(r.archive){for(const path of Object.values(this.recoveryPaths(r)))excluded.add(path);for(const key of ['parent','directory'])if(validIdentity(r.archive[key]))inodes.add(r.archive[key].ino);}
    }
    for(const h of view.handoffs)for(const p of h.paths){excluded.add(p.path);inodes.add(p.identity.ino);}
    const observe=async path=>{
      if(observed.has(path))return observed.get(path);
      let stat;try{stat=await lstat(path,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;observed.set(path,null);return null;}
      const canonical=await realpath(path),entry={stat,canonical};observed.set(path,entry);return entry;
    };
    for(const path of [...excluded]){check();const entry=await observe(path);if(entry)excluded.add(entry.canonical);}
    const inspect=async path=>{
      check();const canonical=await realpath(path);
      if([...excluded].some(owned=>overlaps(resolve(path),owned)||overlaps(canonical,owned)))throw Error('Retained worktree or recovery data cannot execute; choose an unrelated project directory.');
      for(let parent=canonical;;parent=dirname(parent)){
        const stat=(await observe(parent))?.stat;
        // Historical inode matching only denies renamed retained paths; it never grants access.
        if(!stat?.isDirectory()||stat.isSymbolicLink()||inodes.has(String(stat.ino)))throw Error('Project overlaps a retained worktree identity.');
        if(dirname(parent)===parent)break;
      }
    };
    await this.projectPath(cwd);await inspect(cwd);let metadataCheck;
    for(const row of await this.handoffRepository(cwd,epoch,false,recheck=>{metadataCheck=recheck;}))await inspect(row.path);
    const recheck=async()=>{
      check();checkUnconfinedView(view,this,epoch);
      for(const [path,entry] of observed){
        if(entry===null){if(await optional(path))throw Error('Retained path appeared during admission.');continue;}
        const {stat,canonical}=entry,current=await lstat(path,{bigint:true});if(!['dev','ino','mode','uid','gid'].every(key=>current[key]===stat[key])||await realpath(path)!==canonical)throw Error('Project or retained path changed during admission.');
      }
      await metadataCheck();check();
    };
    await recheck();return recheck;
  }
  async inspectUnconfinedAccess(cwd,inventoryOnly=false){
    if(this.recoveryCopyOperation)throw Error('A recovery copy is being verified. Wait or Stop before dispatching tools.');
    if(cwd!==undefined){text(cwd,4096,'project directory');if(!isAbsolute(cwd))throw Error('Project directory must be absolute.');}
    if(this.unconfinedInspection)throw new Error('Full Access evidence is already being inspected.');
    const controller=new AbortController();this.unconfinedController=controller;
    const work=Promise.resolve().then(()=>this.inspectUnconfinedStatus(controller.signal,cwd,inventoryOnly));this.unconfinedInspection=work;
    try{return await work;}finally{if(this.unconfinedInspection===work){this.unconfinedInspection=null;this.unconfinedController=null;}}
  }
  async inspectUnconfinedStatus(signal,cwd,inventoryOnly=false){
    const epoch=this.epoch;let view;
    try{await this.load();}catch(error){if((!error[HANDOFF_ROOT_DEVICE_CHANGED]&&!error[ROOT_DEVICE_CHANGED])||!this.legacyAdmission)throw error;view=await this.#unconfinedView(signal,epoch,null,error[ROOT_DEVICE_CHANGED]??null);}
    this.checkUnconfinedAccess(epoch);
    if(inventoryOnly){
      if(!view||cwd!==undefined)throw Error('Read-only retained inventory requires its authenticated historical view.');
      await view.checkLedger();signal.throwIfAborted();this.checkUnconfinedAccess(epoch);
      const reconnectAvailable=!this.managedMutationBlocked&&view.handoffs.length===1&&view.records.every(r=>r.state==='ready');
      const reason=(this.managedMutationBlocked?'Managed worktree changes are unavailable for this Full Access boot. ':reconnectAvailable?'Review reconnect to admit current filesystem identities before original recovery. ':'Retained worktree identities require separate recovery admission. ')+'Saved worktrees are available for read-only inspection; restore and finish remain unavailable.';
      return {worktrees:view.records.map(r=>publicRecord({...r,state:'needs-inspection',message:`Saved status: ${r.state}. ${r.message} Current checkout state requires recovery inspection.`})),handoffs:this.handoffRecords(view.handoffs),busy:false,readOnly:true,reason,reconnectAvailable,recoveryCopyAvailable:true};
    }
    const retained=structuredClone(view?.handoffs??this.handoffs),reviews=[],handoffs=[];
    const check=()=>{signal.throwIfAborted();this.checkUnconfinedAccess(epoch);if(!equal(view?.handoffs??this.handoffs,retained))throw new Error('Retained handoff membership changed during admission.');};
    const boot=await this.handoffProcess('boot',undefined,epoch);check();shape(boot,['version','bootSession']);if(boot.version!==1||typeof boot.bootSession!=='string'||boot.bootSession.length!==36||!BOOT.test(boot.bootSession))throw new Error('Native boot identity is unavailable.');
    for(const h of retained){
      const review=await this.readHandoffRecovery(h.id,epoch,view);check();
      const proof=await this.inspectHandoffProcesses(review,epoch,view);check();
      if(![5,6].includes(review.manifest.version)||!review.manifest.owner||proof.bootSession!==boot.bootSession||proof.legacy||!proof.priorBootProcessesAbsent||!proof.helpersQuiescent||proof.managerQuiescence!=='prior-boot')throw new Error('Full Access requires verified prior-boot handoff writers and the original owner binding.');
      reviews.push(review);handoffs.push(this.handoffOwnerContext({...review.manifest,recovery:h.recovery}));
    }
    let projectRecheck;
    if(cwd!==undefined){if(view)projectRecheck=await this.#reviewedOrdinaryProject(cwd,view,epoch,check);else await this.assertProject(cwd);check();}
    await (view?view.checkLedger():this.checkLedger());check();
    for(const review of reviews){if((await this.readHandoffRecovery(review.id,epoch,view)).fingerprint!==review.fingerprint)throw new Error('Handoff evidence changed during admission.');check();}
    await projectRecheck?.();
    const recheck=async()=>{this.checkUnconfinedAccess(epoch);await projectRecheck?.();const current=await this.inspectUnconfinedAccess(cwd);this.checkUnconfinedAccess(epoch);await projectRecheck?.();if(current.bootSession!==boot.bootSession||!equal(current.handoffs,handoffs)||!equal(current.fingerprints,reviews.map(r=>r.fingerprint)))throw Error('Handoff evidence changed during admission.');};
    return {bootSession:boot.bootSession,handoffs,fingerprints:reviews.map(r=>r.fingerprint),recheck};
  }
  async assertUnconfinedAccess(){
    const epoch=this.epoch;await this.inspectUnconfinedAccess();this.checkUnconfinedAccess(epoch);
  }
  async reserveCommand({cwd,fullAccess=false}={}){
    const epoch=this.epoch;
    const check=()=>this.checkUnconfinedAccess(epoch);
    if(this.commandReservation)throw new Error('Another generic command is still running or its exit is unconfirmed.');check();
    const token={};this.commandReservation=token;const release=()=>{if(this.commandReservation===token)this.commandReservation=null;};
    try{
      if(fullAccess){
        const proof=await this.inspectUnconfinedAccess(cwd);check();
        if(proof.handoffs.length&&(!cwd||typeof this.coding?.assertUnconfinedAccess!=='function'))throw Error('Retained handoff commands require a declared project and confirmed Coding owner admission.');
        await this.coding?.assertUnconfinedAccess?.(cwd);check();await proof.recheck();check();return {release};
      }
      await this.load();check();
      if(this.handoffs.length)throw new Error('Generic commands are unavailable while a handoff is retained for inspection.');
      if(cwd!==undefined){await this.assertProject(cwd);check();}return {release};
    }catch(error){release();throw error;}
  }
  async handoffRepository(cwd,epoch,admission=false,retainCheck=null){
    const observed=[],absent=[],paths=[],directories=[],sameStat=(a,b)=>['dev','ino','mode','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
    const observe=async path=>{const s=await lstat(path,{bigint:true});observed.push({path,stat:s});return s;};
    const pointer=async(path,expected)=>{
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{const before=await file.stat({bigint:true});if(!sameStat(before,expected)||!before.isFile()||before.size>8192n)throw new Error('Invalid or changed Git metadata pointer.');
        const buffer=Buffer.alloc(8193),{bytesRead}=await file.read(buffer,0,buffer.length,0),after=await file.stat({bigint:true});if(bytesRead!==Number(before.size)||!sameStat(before,after))throw new Error('Git metadata pointer changed while reading.');return text(pathLine(decode(buffer.subarray(0,bytesRead))),8192,'Git metadata pointer');
      }finally{await file.close();}
    };
    const directory=async path=>{paths.push(path);if(admission)await this.assertNoHandoff([path],null,true);const canonical=await realpath(path);paths.push(canonical);const s=await observe(path);if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Git metadata directory is invalid or symbolic.');directories.push({path,canonical,identity:{dev:String(s.dev),ino:String(s.ino)}});return canonical;};
    const canonical=await realpath(cwd);
    for(let parent=canonical;;parent=dirname(parent)){
      const parentStat=await observe(parent);if(!parentStat.isDirectory()||parentStat.isSymbolicLink())throw new Error('Project ancestry changed during handoff admission.');
      const path=join(parent,'.git');let s;try{s=await observe(path);}catch(error){if(error.code!=='ENOENT')throw error;absent.push(path);}
      if(s){
        let gitDir;if(s.isDirectory()&&!s.isSymbolicLink())gitDir=await directory(path);
        else if(s.isFile()) {const value=await pointer(path,s);if(!value.startsWith('gitdir: ')||value.length===8)throw new Error('Invalid Git directory pointer.');gitDir=await directory(resolve(parent,value.slice(8)));}
        else throw new Error('Git metadata must be a directory or regular pointer file.');
        const common=join(gitDir,'commondir');let st;try{st=await observe(common);}catch(error){if(error.code!=='ENOENT')throw error;absent.push(common);}
        if(st)await directory(resolve(gitDir,await pointer(common,st)));
        break;
      }
      if(dirname(parent)===parent)break;
    }
    if(admission)await this.assertNoHandoff(paths,null,true);
    const recheck=async()=>{
      for(const entry of observed){const current=await lstat(entry.path,{bigint:true});if(entry.stat.isDirectory()?!['dev','ino','mode'].every(k=>current[k]===entry.stat[k]):!sameStat(current,entry.stat))throw new Error('Git metadata changed during handoff admission.');}
      for(const directory of directories)if(await realpath(directory.path)!==directory.canonical)throw new Error('Git metadata directory changed during handoff admission.');
      for(const path of absent)if(await optional(path))throw new Error('Git metadata appeared during handoff admission.');
      if(await realpath(cwd)!==canonical)throw new Error('Project path changed during handoff admission.');this.assertOpenEpoch(epoch);
    };
    await recheck();retainCheck?.(recheck);return directories;
  }
  async assertHandoffRepository(cwd,epoch){if(this.handoffs.length||this.handoffAdmission)await this.handoffRepository(cwd,epoch,true);}
  async exclusive(fn,admission=false){
    if(this.closed)throw new Error('Worktree manager is closed.');if(this.operation||this.stopping)throw new Error('Another worktree operation is busy.');const epoch=this.epoch;
    const task=Promise.resolve().then(async()=>{await this.load();this.assertEpoch(epoch);return fn(epoch);});this.operation=task;if(admission)this.admissionOperation=task;
    try{return await task;}finally{if(this.operation===task)this.operation=null;if(this.admissionOperation===task)this.admissionOperation=null;}
  }
  async run(args,{record=null,input='',epoch=this.epoch,allowOne=false,...options}={}){
    return this.runner.run(args,{scope:record?{dirs:[record.cwd,record.admin],create:[join(record.commonDir,'worktrees')]}:{},input,...options,check:()=>this.assertEpoch(epoch),allowCodes:allowOne?[0,1]:[0]});
  }
  handoffWorker(kind,details,epoch){
    const active=this.activeHandoff;this.assertHandoffActive(active,epoch);
    if(active.recoveryReview)throw new Error('Handoff recovery attempt is not durably recorded.');
    const protocol=active.attempt?.processProtocol??active.plan.processProtocol;
    if(![1,2].includes(protocol?.version))throw new Error('This handoff lacks durable process ownership; preserve it for inspection.');
    return async process=>{this.assertHandoffActive(active,epoch);if(process.bootSession!==protocol.bootSession)throw new Error('Handoff process boot identity changed.');await this.handoffCheckpoint(active,'worker-started',epoch,{kind,...details,process});};
  }
  handoffFiles(action,input,epoch){return this.handoffNative(['--handoff-files',action],input,epoch,this.activeHandoff&&NATIVE_WRITES.has(action)?this.handoffWorker('native',{action},epoch):null);}
  handoffProcess(action,input,epoch){if(!['boot','inspect','owner','inspect-owner'].includes(action))throw new Error('Invalid process inspection action.');return this.handoffNative(['--handoff-process',action],input,epoch);}
  async handoffManager(epoch){
    const result=await this.handoffProcess('owner',undefined,epoch);shape(result,['version','bootSession','owner']);if(result.version!==1)throw new Error('Native manager identity is unavailable.');
    const manager=verifyHandoffProcessIdentity(result.owner,{pid:process.pid,uid:process.getuid(),bootSession:result.bootSession});
    if(manager.bootSession!==result.bootSession)throw new Error('Native manager boot identity changed.');
    return {version:2,bootSession:manager.bootSession,manager};
  }
  async handoffNative(args,input,epoch,record=null){
    this.assertEpoch(epoch);if(this.nativeChild)throw new Error('Another native handoff operation is running.');
    const helperID=await verifyHandoffHelper(this.nativeHelper,this.nativeHelperIdentity);this.nativeHelperIdentity=helperID;
    if(this.nativeChild)throw new Error('Another native handoff operation is running.');
    const body=input===undefined?'':JSON.stringify(input);if(Buffer.byteLength(body)>MANIFEST_BYTES)throw new Error('Native handoff request exceeds 8 MiB.');this.assertEpoch(epoch);
    const nonce=record?randomUUID():null,argv=record?['--handoff-process','files',nonce,args[1]]:args;
    const child=(this.spawnProcess??spawn)(this.nativeHelper,argv,{cwd:'/private/var/empty',env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:record?['pipe','pipe','pipe','pipe','pipe']:['pipe','pipe','pipe'],detached:true});
    const state={child,pid:child.pid,cancelled:false},out=[],err=[];this.nativeChild=state;let count=0,diagnostics=0,failure,code,signal,expire;
    const expired=new Promise(resolve=>{expire=resolve;});
    const kill=()=>{if(Number.isInteger(state.pid)&&state.pid>1)try{process.kill(-state.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')failure??=e;}};
    state.cancel=()=>{state.cancelled=true;kill();state.exitLimit??=setTimeout(()=>expire(false),2500);};
    child.once('exit',()=>{state.exited=true;});
    const closed=new Promise(resolve=>{child.once('error',e=>{failure=e;state.cancel();});child.once('close',(c,s)=>{state.exited=true;code=c;signal=s;resolve(true);});});
    child.stdout.on('data',b=>{count+=b.length;if(count>MANIFEST_BYTES){failure=new Error('Native handoff output exceeds 8 MiB.');state.cancel();}else out.push(b);});
    child.stderr.on('data',b=>{diagnostics+=b.length;if(diagnostics<=65536)err.push(b);else state.cancel();});child.stdin.on('error',()=>{});
    const timer=setTimeout(()=>{failure=new Error('Native handoff operation timed out.');state.cancel();},20000);
    try{
      try{if(record)await releaseHandoffProcess(child,nonce,{record,abort:expired,check:()=>{this.assertEpoch(epoch);if(state.cancelled||state.exited)throw new Error('Native process release was cancelled.');}});this.assertEpoch(epoch);if(state.cancelled||state.exited)throw new Error('Native process is unavailable before input.');child.stdin.end(body);}catch(error){failure??=error;state.cancel();}
      if(!await Promise.race([closed,expired])){this.nativeBlocked=true;throw new Error('Native handoff process exit was not confirmed; recovery retained.');}
      // The helper has no subprocess API; still require its process group to be gone before releasing the lease.
      if(Number.isInteger(state.pid)&&state.pid>1){try{process.kill(-state.pid,0);this.nativeBlocked=true;kill();throw new Error('Native handoff process group exit was not confirmed.');}catch(e){if(e.code!=='ESRCH')throw e;}}
      if(failure)throw failure;this.assertEpoch(epoch);if(state.cancelled||signal||code!==0)throw new Error(decode(Buffer.concat(err)).slice(0,1600)||'Native handoff operation failed.');
      await verifyHandoffHelper(this.nativeHelper,helperID);this.assertEpoch(epoch);return JSON.parse(decode(Buffer.concat(out)));
    }finally{clearTimeout(timer);clearTimeout(state.exitLimit);if(this.nativeChild===state)this.nativeChild=null;}
  }
  async handoffTemporary(paths,epoch){
    const rows=[];for(const cwd of paths){const entry=await this.coding.handoffTemporary(cwd);this.assertEpoch(epoch);if(entry){
      if(entry.cwd!==cwd||dirname(entry.path)!==cwd||await realpath(entry.path)!==entry.path||!same(await identity(cwd),{dev:entry.projectDev,ino:entry.projectIno})||!same(await identity(entry.path),entry))throw new Error('Handoff scratch ownership changed.');rows.push(entry);
    }}return rows;
  }
  async handoffNativePaths(root,excluded,epoch){
    await verify(root.path,root);if(await realpath(root.path)!==root.path)throw new Error('Handoff native root is not canonical.');const names=[],emptyDirectories=[];
    const visit=async(relative,depth)=>{if(depth>64)throw new Error('Handoff exceeds depth 64.');const children=(await readdir(join(root.path,relative),{encoding:'buffer'})).sort(Buffer.compare);if(relative&&!children.length)emptyDirectories.push(relative);for(const raw of children){
      const name=decode(raw),path=relative?relative+'/'+name:name;
      if(excluded.some(p=>inside(fold(p),fold(path))))continue;
      if(!name||name==='.'||name==='..'||fold(name)==='.git'||Buffer.byteLength(path)>4096)throw new Error('Unsupported nested Git metadata or handoff path.');
      if(names.length>=ARCHIVE_ENTRIES)throw new Error('Handoff exceeds 20,000 selected entries.');
      names.push(path);const st=await lstat(join(root.path,path));if(st.isDirectory()&&!st.isSymbolicLink())await visit(path,depth+1);else if(!st.isFile()&&!st.isSymbolicLink())throw new Error('Handoff cannot capture special filesystem entries.');this.assertEpoch(epoch);
    }};await visit('',0);await verify(root.path,root);this.assertEpoch(epoch);return {names,emptyDirectories};
  }
  async handoffNativeState(r,temporary,epoch,frozen=null){
    await this.handoffInspector.verifyRepository(r);this.assertEpoch(epoch);
    const ignored=frozen?.ignored??(await this.run([...this.scoped(r.cwd,r.gitDir),'ls-files','--others','--ignored','--directory','--exclude-standard','-z'],{epoch})).stdout.split('\0').filter(Boolean).map(x=>x.endsWith('/')?x.slice(0,-1):x);
    const omitted=temporary.filter(t=>t.cwd===r.cwd).map(t=>t.path.slice(r.cwd.length+1)),root={path:r.cwd,...r.identities.cwd};
    const {names,emptyDirectories}=await this.handoffNativePaths(root,['.git',...ignored,...omitted],epoch),captured=await this.handoffFiles('snapshot',{root,paths:names},epoch);
    await this.handoffInspector.verifyRepository(r);this.assertEpoch(epoch);return {root,...captured,ignored,omitted,emptyDirectories};
  }
  async checkHandoffReview(p,epoch){
    this.assertEpoch(epoch);if(!this.records.includes(p.record)||p.record.state!=='ready')throw new Error('Handoff worktree ownership or state changed after review.');await this.sourceIdentity(p.record);await this.verifyRecord(p.record);
    if(JSON.stringify(await this.coding.prepareHandoff(p.family.rootThreadId))!==JSON.stringify(p.family))throw new Error('Handoff chat family changed after review.');this.assertEpoch(epoch);if(p.owner&&!equal(this.coding.handoffOwner(p.family,p.destination),p.owner))throw new Error('Handoff native owner changed after review.');
    if(JSON.stringify(await this.handoffTemporary([p.source,p.destination],epoch))!==JSON.stringify(p.temporary))throw new Error('Handoff scratch ownership changed after review.');
    const inspector=this.handoffInspector,read=async r=>{const omitUntracked=p.temporary.filter(t=>t.cwd===r.cwd).map(t=>t.path.slice(r.cwd.length+1));const s=await inspector.readState(r,inspector.epoch,{omitUntracked});this.assertEpoch(epoch);return s;};
    for(const label of ['source','destination']){const state=p.states[label];if((await read(state.r)).fingerprint!==state.fingerprint||JSON.stringify(await this.handoffNativeState(state.r,p.temporary,epoch))!==JSON.stringify(p.native[label]))throw new Error('Handoff '+label+' files, metadata, or Git state changed after review.');}
    if((await inspector.peerInventory(p.states.source.r,inspector.epoch)).fingerprint!==p.peers.fingerprint)throw new Error('Handoff peer inventory changed after review.');this.assertEpoch(epoch);
  }
  async prepareHandoff(id,threadId,epoch){
    if(this.commandReservation)throw new Error('Stop the generic command and confirm its exit before preparing a handoff.');
    identifier(id);if(typeof threadId!=='string'||!/^[\w.-]{1,160}$/.test(threadId)||!this.coding)throw new Error('Handoff requires an available root chat.');
    if(this.activeHandoff)throw new Error('A handoff transaction already requires completion or inspection.');
    const r=this.records.find(r=>r.id===id);if(!r||r.state!=='ready')throw new Error('Handoff requires a ready owned worktree.');
    const previous=this.handoffAdmission,expired=previous&&this.plans.get(previous.id);
    if(expired?.admission===previous&&expired.expiresAt<=this.now()){await this.releasePlan(expired);this.assertEpoch(epoch);}
    if(this.handoffAdmission)throw new Error('A handoff is already preparing or under review.');
    const admission={id:randomUUID(),worktreeId:id,rootThreadId:threadId,source:r.source,destination:r.cwd,paths:[{path:r.source,identity:r.identities.source},{path:r.cwd,identity:r.identities.cwd}],phase:'preparing'};this.handoffAdmission=admission;
    let p,lease;try{
    await this.expirePlans();if(this.plans.size>=32||this.handoffs.length>=128)throw new Error('Handoff review or recovery limit reached.');
    await this.sourceIdentity(r);await this.verifyRecord(r);
    const family=await this.coding.prepareHandoff(threadId);this.assertEpoch(epoch);if(![r.source,r.cwd].includes(family.cwd))throw new Error('Chat does not belong to the selected checkout pair.');
    const source=family.cwd,destination=source===r.source?r.cwd:r.source,owner=this.coding.handoffOwner?.(family,destination)??null;
    const inspector=this.handoffInspector??=new GitWorkflow({dataDir:this.dataDir,spawnProcess:this.spawnProcess});
      let sourceRepo,destinationRepo,peers;
      lease=await this.reserveMutation(async()=>{
        await this.sourceIdentity(r);await this.verifyRecord(r);sourceRepo=await inspector.repository(source,inspector.epoch);destinationRepo=await inspector.repository(destination,inspector.epoch);peers=await inspector.peerInventory(sourceRepo,inspector.epoch);
        const paths=peers.records.map(x=>x.path);await this.assertNoHandoff(paths);this.assertEpoch(epoch);
        const owned=await this.coding.projectMutationInventory();this.assertEpoch(epoch);
        for(const cwd of owned){if(paths.some(path=>inside(path,cwd)))continue;const metadata=await this.handoffRepository(cwd,epoch);if(metadata.some(dir=>overlaps(dir.canonical,r.commonDir)||same(dir.identity,r.identities.common)))paths.push(cwd);this.assertEpoch(epoch);}
        return paths;
      });
      for(const repo of [sourceRepo,destinationRepo])if([repo.gitDir,repo.commonDir].some(path=>inside(repo.cwd,path)&&!inside(join(repo.cwd,'.git'),path)))throw new Error('Embedded Git metadata outside the checkout .git path is unsupported.');
      this.assertEpoch(epoch);const temporary=await this.handoffTemporary([source,destination],epoch),states={};
      for(const [label,repo] of [['source',sourceRepo],['destination',destinationRepo]]){states[label]=await inspector.readState(repo,inspector.epoch,{omitUntracked:temporary.filter(t=>t.cwd===repo.cwd).map(t=>t.path.slice(repo.cwd.length+1))});this.assertEpoch(epoch);}
      const parent=join(this.root,'.handoffs');await mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const st=await lstat(parent);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||await realpath(parent)!==parent)throw new Error('Handoff recovery root must be private and canonical.');
      const planId=admission.id,directory=join(parent,planId);await mkdir(directory,{mode:0o700});await syncDirectory(parent);
      if([sourceRepo,destinationRepo].some(repo=>repo.identities.cwd.dev!==String(st.dev)))throw new Error('Handoff publication requires checkouts and recovery on the same filesystem.');
      p={id:planId,admission,operation:'handoff',worktreeId:id,rootThreadId:threadId,record:r,source,destination,directory,lease,family,owner,temporary,states,peers,native:{},copies:{},expiresAt:this.now()+120000};
      for(const label of ['source','destination']){
        p.native[label]=await this.handoffNativeState(states[label].r,temporary,epoch);const stage=join(directory,label+'-before');await mkdir(stage,{mode:0o700});const root={path:stage,...await identity(stage)};
        const copied=await this.handoffFiles('copy',{source:p.native[label].root,destination:root,stamps:p.native[label].stamps},epoch);p.copies[label]={root,...copied};
      }
      const builder=new HandoffGit({directory:join(directory,'git'),runner:this.runner,inspector,check:()=>this.assertEpoch(epoch)});p.candidate=await builder.prepare(states.source,states.destination,peers,{temporary});
      p.stages=await prepareHandoffStages(p,builder,(action,input)=>this.handoffFiles(action,input,epoch),()=>this.assertEpoch(epoch),this.now);
      await this.checkHandoffReview(p,epoch);
      p.gitBaseline=await captureHandoffGitBaseline(p,{runner:this.runner,inspector,check:()=>this.assertEpoch(epoch)});
      p.processProtocol=await this.handoffManager(epoch);
      const manifest={version:owner?5:4,id:planId,worktreeId:id,source,destination,family,...(owner?{owner}:{}),temporary,peers,repositories:{source:sourceRepo,destination:destinationRepo},native:p.native,copies:p.copies,candidate:p.candidate,stages:p.stages,gitBaseline:p.gitBaseline,processProtocol:p.processProtocol};
      const body=JSON.stringify(manifest,(_k,v)=>v instanceof Map?[...v]:v);if(Buffer.byteLength(body)>MANIFEST_BYTES)throw new Error('Handoff recovery manifest exceeds 8 MiB.');
      await writeFile(join(directory,'manifest.json'),body,{flag:'wx',mode:0o600,flush:true});await syncDirectory(directory);p.recovery={directory:await identity(directory),manifest:await artifactStamp(join(directory,'manifest.json'),MANIFEST_BYTES)};
      this.assertEpoch(epoch);admission.phase='review';p.expiresAt=this.now()+120000;this.plans.set(p.id,p);p.timer=setTimeout(()=>{if(this.plans.get(p.id)===p&&!this.operation)void this.releasePlan(p).catch(()=>{});},120000);p.timer.unref?.();
      return {plan:{id:p.id,operation:p.operation,worktreeId:id,rootThreadId:threadId,source,destination,branch:p.candidate.branch,family:family.members.map(t=>({id:t.id,archived:t.archived})),files:Object.values(p.native).reduce((n,x)=>n+Object.keys(x.stamps).length,0),bytes:Object.values(p.native).reduce((n,x)=>n+x.bytes,0),nativePolicy:p.stages.policy,synthesized:{source:p.stages.source.synthesized,destination:p.stages.destination.synthesized},recoveryDirectory:directory,expiresAt:p.expiresAt}};
    }catch(e){if(lease){if(this.blocked)this.retainedLeases.add(lease);else await lease.release();}if(!this.blocked&&this.handoffAdmission===admission)this.handoffAdmission=null;throw e;}
  }
  async verifyHandoffNativeCopy(saved,epoch){
    await verify(saved.root.path,saved.root);const paths=Object.keys(saved.stamps),current=await this.handoffFiles('snapshot',{root:saved.root,paths},epoch);
    if(!equal(current.stamps,saved.stamps)||!equal(current.rootStamp,saved.rootStamp)||current.bytes!==saved.bytes)throw new Error('Handoff native recovery changed.');
    for(const directory of ['',...paths.filter(path=>saved.stamps[path].kind==='directory')]){
      const expected=paths.filter(path=>dirname(path)===(directory||'.')).map(path=>path.slice(directory?directory.length+1:0)).sort();
      if(!equal((await readdir(join(saved.root.path,directory))).sort(),expected))throw new Error('Handoff native recovery changed: unexpected or missing staged entries.');
    }
    this.assertEpoch(epoch);
  }
  async verifyHandoffArtifacts(p,epoch){
    this.assertEpoch(epoch);await verify(p.directory,p.recovery.directory);if(await realpath(p.directory)!==p.directory)throw new Error('Handoff recovery directory changed.');
    const manifest=await artifactStamp(join(p.directory,'manifest.json'),MANIFEST_BYTES);if(JSON.stringify(manifest)!==JSON.stringify(p.recovery.manifest))throw new Error('Handoff recovery manifest changed.');
    const {artifacts,recovery}=p.candidate;
    for(const [key,path,limit] of [['bundle',artifacts.bundle,BUNDLE_BYTES],['sourceHead',artifacts.sourceOriginalHead,8192],['destinationHead',artifacts.destinationOriginalHead,8192],['sourceIndex',artifacts.sourceOriginalIndex,4*MAX],['destinationIndex',artifacts.destinationOriginalIndex,4*MAX],['index',artifacts.index,4*MAX],['sourceCleanupIndex',artifacts.sourceCleanupIndex,4*MAX]]){
      if(JSON.stringify(await artifactStamp(path,limit))!==JSON.stringify(recovery[key]))throw new Error('Handoff Git recovery '+key+' changed.');this.assertEpoch(epoch);
    }
    for(const copy of [...Object.values(p.copies),p.stages.payload,...Object.values(p.stages).map(stage=>stage.immutable).filter(Boolean)])await this.verifyHandoffNativeCopy(copy,epoch);
    this.assertEpoch(epoch);
  }
  async verifyHandoffRecovery(p,epoch,publications={}){
    await this.verifyHandoffArtifacts(p,epoch);
    for(const label of ['source','destination'])for(const copy of [publications[label]?.stage??p.stages[label],publications[label]?.capture??p.stages[label].capture])await this.verifyHandoffNativeCopy(copy,epoch);
    this.assertEpoch(epoch);
  }
  async beginHandoff(planId,epoch){
    if(this.activeHandoff)throw new Error('A handoff transaction already requires completion or inspection.');
    const p=this.plans.get(planId);if(!p||p.operation!=='handoff')throw new Error('Handoff review expired, consumed, or unknown.');this.plans.delete(planId);clearTimeout(p.timer);
    let h;
    try{
      if(p.expiresAt<=this.now())throw new Error('Handoff review expired.');await this.checkHandoffReview(p,epoch);await this.verifyHandoffRecovery(p,epoch);
      if(!equal(await this.handoffManager(epoch),p.processProtocol))throw new Error('Handoff manager ownership changed after review.');
      await p.lease.revalidateScope?.();this.assertEpoch(epoch);
      h={id:p.id,worktreeId:p.worktreeId,rootThreadId:p.rootThreadId,source:p.source,destination:p.destination,paths:p.peers.records.map(x=>({path:x.path,identity:x.id})),phase:'recovery-ready',state:'pending',message:'Verified recovery recorded before chat archival or checkout publication.',createdAt:this.now(),updatedAt:this.now(),recovery:p.recovery};
      this.handoffs.push(h);if(this.handoffAdmission===p.admission)this.handoffAdmission=null;this.activeHandoff={plan:p,record:h,epoch};await this.save();this.assertEpoch(epoch);return this.activeHandoff;
    }catch(e){if(h){h.state='needs-inspection';h.message=String(e.message).slice(0,1600);try{await this.save();}catch{}this.retainedLeases.add(p.lease);}else await this.releasePlan(p);throw e;}
  }
  assertHandoffActive(active,epoch){
    this.assertEpoch(epoch);if(!active||this.activeHandoff!==active||active.epoch!==epoch||!this.handoffs.includes(active.record)||!this.records.includes(active.plan.record)||active.plan.record.state!=='ready')throw new Error('Handoff transaction authority changed.');
    if(!active.familyReturned){if(active.checkRecovery)active.checkRecovery();else if(active.fence)this.coding.checkHandoffAuthority(active.plan.destination,active.fence,{snapshot:active.plan.family,lease:active.plan.lease});}
  }
  async readHandoffProgress(active,stamp,view){
    checkUnconfinedView(view,this);
    const p=active.plan;progressStamp(stamp);await (view?.verify??verify)(p.directory,p.recovery.directory);const {sequence,...expected}=stamp,path=join(p.directory,'progress-'+String(sequence).padStart(8,'0')+'.json');
    return handoffProgress(p,sequence,(await (view?.read??readHandoffJSON)(path,expected)).value);
  }
  handoffOwnerContext(p){return {id:p.id,worktreeId:p.worktreeId,source:p.source,destination:p.destination,fingerprint:p.family.fingerprint,owner:structuredClone(p.owner),recovery:structuredClone(p.recovery)};}
  async inspectOwnerHandoff(marker){
    const epoch=this.epoch;await this.load();this.assertEpoch(epoch);
    return this.withLedger(async()=>{
      await this.checkLedger();this.assertEpoch(epoch);const c=marker.context;
      identifier(c.id);identifier(c.worktreeId);if(!marker.commit)return false;
      const pending=this.handoffs.find(h=>h.id===c.id);if(pending){if(pending.worktreeId!==c.worktreeId||pending.rootThreadId!==c.owner.rootThreadId||pending.source!==c.source||pending.destination!==c.destination||!equal(pending.recovery,c.recovery))throw new Error('Retained owner handoff ledger binding changed.');return false;}
      const directory=join(this.root,'.handoffs',c.id);for(const path of [dirname(directory),directory])await privateDirectory(path);await verify(directory,c.recovery.directory);
      const manifest=(await readHandoffJSON(join(directory,'manifest.json'),c.recovery.manifest)).value;
      if(![5,6].includes(manifest.version)||!equal(this.handoffOwnerContext({...manifest,recovery:c.recovery}),c)||manifest.family.rootThreadId!==c.owner.rootThreadId||manifest.family.model!==c.owner.model||manifest.family.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[c.owner.provider]))throw new Error('Terminal owner handoff manifest changed.');
      const p={id:c.id,directory,recovery:c.recovery};let stamp=marker.commit.progress,total=0;
      const terminal=await this.readHandoffProgress({plan:p},stamp),family=terminal.details?.family;
      if(!['complete-verified','recovery-complete-verified'].includes(terminal.phase)||family?.cwd!==marker.commit.target||family.fingerprint!==marker.commit.fingerprint||family.rootThreadId!==manifest.family.rootThreadId||family.model!==manifest.family.model||family.modelProvider!==manifest.family.modelProvider||!equal(family.members,manifest.family.members.map(member=>({...member,cwd:marker.commit.target}))))throw new Error('Owner terminal receipt does not verify the original complete family.');
      const names=(await readdir(directory)).filter(name=>name.startsWith('progress-')).sort(),expected=Array.from({length:stamp.sequence},(_,i)=>'progress-'+String(i+1).padStart(8,'0')+'.json');if(!equal(names,expected))throw new Error('Terminal handoff receipt namespace changed.');
      const receipts=[];while(stamp){this.assertEpoch(epoch);total+=stamp.bytes;if(total>ARCHIVE_BYTES)throw new Error('Terminal handoff journal exceeds its limit.');const entry=await this.readHandoffProgress({plan:p},stamp);receipts.unshift({stamp,entry});stamp=entry.previous;}
      await this.verifyReconnectedHandoff(manifest,directory,receipts,c.recovery.manifest.hash);
      await readHandoffJSON(join(directory,'manifest.json'),c.recovery.manifest);await verify(directory,c.recovery.directory);if(!equal((await readdir(directory)).filter(name=>name.startsWith('progress-')).sort(),expected))throw new Error('Terminal handoff receipt namespace changed during inspection.');await this.checkLedger();this.assertEpoch(epoch);if(this.handoffs.some(h=>h.id===c.id))throw new Error('Handoff ledger reappeared during terminal inspection.');return true;
    });
  }
  async readHandoffRecovery(id,epoch,view){
    const bound=checkUnconfinedView(view,this,epoch);
    identifier(id);this.assertEpoch(epoch);if(!view&&!this.loaded)throw new Error('Load the handoff ledger before recovery inspection.');
    if(bound?.reconnect)return this.readHandoffRecoveryLedger(id,epoch,view);
    return this.withLedger(()=>this.readHandoffRecoveryLedger(id,epoch,view));
  }
  async readHandoffRecoveryLedger(id,epoch,view){
      checkUnconfinedView(view,this,epoch);
      const read=view?.read??readHandoffJSON,verifyIdentity=view?.verify??verify,getIdentity=view?.identity??identity,checkLedger=()=>view?view.checkLedger():this.checkLedger();
      const check=()=>this.assertEpoch(epoch);check();await checkLedger();
      const h=(view?.handoffs??this.handoffs).find(h=>h.id===id),r=h&&(view?.records??this.records).find(r=>r.id===h.worktreeId);
      if(!h?.recovery||!r||r.state!=='ready')throw new Error('Retained handoff lacks owned recovery artifacts.');
      const parent=join(this.root,'.handoffs'),directory=join(parent,id),p={id,directory,recovery:h.recovery};
      for(const path of [parent,directory]){const s=await lstat(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(path)!==path)throw new Error('Handoff recovery directory must remain private and canonical.');}
      await verifyIdentity(directory,h.recovery.directory);
      const manifest=(await read(join(directory,'manifest.json'),h.recovery.manifest)).value;
      shape(manifest,['version','id','worktreeId','source','destination','family','temporary','peers','repositories','native','copies','candidate','stages',...(manifest.version>=2?['gitBaseline']:[]),...(manifest.version>=3?['processProtocol']:[]),...(manifest.version>=5?['owner']:[]),...(manifest.version===6?['reconnect']:[])]);
      if(![1,2,3,4,5,6].includes(manifest.version)||manifest.id!==id||manifest.worktreeId!==h.worktreeId||manifest.source!==h.source||manifest.destination!==h.destination)throw new Error('Handoff manifest checkout ownership changed.');
      if(manifest.version>=3)handoffProcessProtocol(manifest.processProtocol,manifest.version>=4);
      const family=manifest.family;
      if(family?.rootThreadId!==h.rootThreadId||family.cwd!==h.source||typeof family.fingerprint!=='string'||!family.fingerprint||!Array.isArray(family.members)||!family.members.length||family.members.length>2001)throw new Error('Handoff manifest family changed.');
      const members=new Set();for(const member of family.members){if(typeof member.id!=='string'||!/^[\w.-]{1,160}$/.test(member.id)||members.has(member.id)||member.cwd!==h.source||member.model!==family.model||member.modelProvider!==family.modelProvider||typeof member.archived!=='boolean')throw new Error('Invalid handoff manifest family member.');members.add(member.id);}
      if(!members.has(h.rootThreadId)||family.members.some(member=>member.id===h.rootThreadId?member.parentThreadId!==null||member.archived:!members.has(member.parentThreadId)))throw new Error('Invalid handoff manifest family graph.');
      const graph=new Map(family.members.map(member=>[member.id,member.parentThreadId]));for(const member of family.members){const seen=new Set();for(let id=member.id;id!==null;id=graph.get(id)){if(seen.has(id))throw new Error('Cyclic handoff manifest family graph.');seen.add(id);}}
      if(!Array.isArray(manifest.peers?.records)||!equal(manifest.peers.records.map(row=>({path:row.path,identity:row.id})),h.paths))throw new Error('Handoff manifest peer inventory changed.');
      const inspector=this.handoffInspector??=new GitWorkflow({dataDir:this.dataDir,spawnProcess:this.spawnProcess});
      const artifacts=new HandoffGit({directory:join(directory,'git'),runner:this.runner,inspector,check}).artifacts;
      if(!equal(manifest.candidate?.artifacts,artifacts))throw new Error('Handoff manifest artifact paths changed.');
      for(const label of ['source','destination']){
        const path=h[label],repo=manifest.repositories?.[label],expected=path===r.source?r.identities.source:r.identities.cwd,gitDir=path===r.source?r.gitDir:r.admin;
        if(repo?.cwd!==path||repo.gitDir!==gitDir||repo.commonDir!==r.commonDir||!same(repo.identities?.cwd,expected)||!same(repo.identities?.git,path===r.source?r.identities.sourceGit:r.identities.admin)||!same(repo.identities?.common,r.identities.common)||typeof repo.linkDirectory!=='boolean'||!same(repo.identities?.link,await getIdentity(join(path,'.git'),repo.linkDirectory)))throw new Error('Handoff manifest repository identity changed.');
        const roots=[[manifest.native?.[label]?.root,path],[manifest.copies?.[label]?.root,join(directory,label+'-before')],[manifest.stages?.[label]?.root,join(directory,label+'-candidate')],[manifest.stages?.[label]?.capture?.root,join(directory,label+'-capture')]];
        if(manifest.version>=4||manifest.stages?.[label]?.immutable)roots.push([manifest.stages?.[label]?.immutable?.root,join(directory,label+'-candidate-before')]);
        for(const [root,expectedPath] of roots)if(root?.path!==expectedPath||!validIdentity(root))throw new Error('Handoff manifest native artifact path changed.');
        if(!same(manifest.native[label].root,expected))throw new Error('Handoff manifest native checkout changed.');
      }
      if(manifest.stages?.payload?.root?.path!==join(directory,'payloads')||!validIdentity(manifest.stages.payload.root))throw new Error('Handoff manifest payload artifact changed.');
      const names=async()=>{const all=(await readdir(directory)).filter(name=>name.startsWith('progress-')).sort();if(all.length>8192||all.some(name=>!/^progress-\d{8}\.json$/.test(name)))throw new Error('Invalid handoff progress receipt namespace.');return all;};
      const files=await names(),receipts=[],uncommitted=[],intents=[],workers=[],nonces=new Set(),incarnations=new Set();let previous=null,total=0;
      const attempts=[{id,sequence:0,target:h.destination,processProtocol:manifest.processProtocol??null}],attemptIds=new Set([id]);
      if(files.length<(h.progress?.sequence??0))throw new Error('Handoff progress sequence is missing.');
      for(let i=0;i<files.length;i++){
        check();const sequence=i+1;if(files[i]!=='progress-'+String(sequence).padStart(8,'0')+'.json')throw new Error('Handoff progress sequence has a gap.');
        const expected=h.progress?.sequence===sequence?(({sequence,...stamp})=>stamp)(h.progress):undefined;
        const found=await read(join(directory,files[i]),expected),entry=handoffProgress(p,sequence,found.value),stamp={sequence,...found.stamp};
        // ponytail: a bounded in-memory journal; stream projections if real handoffs exceed 128 MiB.
        total+=stamp.bytes;if(total>ARCHIVE_BYTES)throw new Error('Handoff recovery journal exceeds 128 MiB.');
        if(!equal(entry.previous,previous))throw new Error('Handoff progress journal link changed.');
        if(entry.details?.outcome!=='failed'&&entry.phase==='recovery-attempt-started'){
          const d=entry.details;shape(d,['id','previousAttemptId','target','processProtocol','reviewFingerprint','reviewProgress']);
          if(typeof d.id!=='string'||d.id.length!==36||!ID.test(d.id)||attemptIds.has(d.id)||d.previousAttemptId!==attempts.at(-1).id||![h.source,h.destination].includes(d.target))throw new Error('Invalid handoff recovery attempt ownership.');
          handoffProcessProtocol(d.processProtocol,true);
          if(d.reviewProgress!==null){progressStamp(d.reviewProgress);if(!equal(receipts[d.reviewProgress.sequence-1]?.stamp,d.reviewProgress))throw new Error('Handoff recovery attempt review progress changed.');}
          if(d.reviewFingerprint!==handoffFingerprint(id,h.recovery,d.reviewProgress,receipts))throw new Error('Handoff recovery attempt review fingerprint changed.');
          attempts.push({sequence,...d});attemptIds.add(d.id);
        }
        if(entry.details?.outcome!=='failed'&&['family-archive-intent','family-resume-intent','family-rearchive-intent'].includes(entry.phase)){
          const details=entry.details;if(!details||typeof details!=='object'||Array.isArray(details)||![h.source,h.destination].includes(details.destination)||(entry.phase==='family-archive-intent'?!equal(details.snapshot,family):!members.has(details.threadId)))throw new Error('Invalid handoff family journal intent.');
          intents.push({phase:entry.phase,...(entry.phase==='family-archive-intent'?{}:{threadId:details.threadId}),destination:details.destination});
        }
        if(entry.details?.outcome!=='failed'&&entry.phase==='worker-started'){
          const d=entry.details,attempt=attempts.at(-1);if(!attempt.processProtocol||!['git','native'].includes(d?.kind))throw new Error('Unowned handoff process receipt.');
          shape(d,['kind','process',d.kind==='git'?'commandHash':'action']);
          if(d.kind==='git'?(typeof d.commandHash!=='string'||!/^[a-f0-9]{64}$/.test(d.commandHash)):!NATIVE_WRITES.has(d.action))throw new Error('Invalid handoff worker operation.');
          const process=verifyHandoffProcessReceipt(d.process,{nonce:d.process?.nonce,pid:d.process?.pid}),incarnation=JSON.stringify([process.bootSession,process.pid,process.startSec,process.startUsec]);
          if(process.bootSession!==attempt.processProtocol.bootSession||nonces.has(process.nonce)||incarnations.has(incarnation))throw new Error('Repeated or foreign-boot handoff process receipt.');
          nonces.add(process.nonce);incarnations.add(incarnation);workers.push({sequence,attemptId:attempt.id,...d,process});
        }
        receipts.push({stamp,entry});if(sequence>(h.progress?.sequence??0))uncommitted.push(stamp);previous=stamp;
      }
      if(!equal(files,await names()))throw new Error('Handoff progress receipt namespace changed during inspection.');
      for(const {stamp} of receipts){check();await this.readHandoffProgress({plan:p},stamp,view);}
      await this.verifyReconnectedHandoff(manifest,directory,receipts,h.recovery.manifest.hash,h.progress??null);
      const nativeJournal=await nativeRecoveryJournal(manifest,directory,receipts,attempts,h.progress,check,{verifyIdentity});
      await read(join(directory,'manifest.json'),h.recovery.manifest);await verifyIdentity(directory,h.recovery.directory);await checkLedger();check();
      const result={id,directory,manifest,receipts,head:previous,progress:structuredClone(h.progress??null),uncommitted,nativeJournal,familyJournal:{version:1,snapshotFingerprint:family.fingerprint,destination:h.destination,intents},processJournal:{version:2,bootSession:manifest.processProtocol?.bootSession??null,legacy:manifest.version<3,manager:manifest.processProtocol?.manager??null,attempts,workers}};
      return {...result,fingerprint:handoffFingerprint(id,h.recovery,result.progress,receipts)};
  }
  async inspectHandoffProcesses(review,epoch,view){
    checkUnconfinedView(view,this,epoch);
    const fresh=await this.readHandoffRecovery(review?.id,epoch,view);if(fresh.fingerprint!==review.fingerprint)throw new Error('Handoff process review is stale.');
    const boot=await this.handoffProcess('boot',undefined,epoch);shape(boot,['version','bootSession']);if(boot.version!==1||typeof boot.bootSession!=='string'||boot.bootSession.length!==36||!BOOT.test(boot.bootSession))throw new Error('Native boot identity is unavailable.');
    const journal=fresh.processJournal,workers=[],attempts=[];
    for(const row of journal.attempts){
      const protocol=row.processProtocol,priorBoot=Boolean(protocol&&boot.bootSession!==protocol.bootSession);let manager=null,managerQuiescence=priorBoot?'prior-boot':'unverified';
      if(protocol?.manager){
        const inspection=await this.handoffProcess('inspect-owner',protocol.manager,epoch);shape(inspection,['version','bootSession','priorBoot','owner']);
        if(inspection.version!==1||inspection.bootSession!==boot.bootSession||inspection.priorBoot!==priorBoot||priorBoot&&inspection.owner!==null)throw new Error('Invalid native manager inspection.');
        if(inspection.owner!==null)verifyHandoffProcessIdentity(inspection.owner,{pid:protocol.manager.pid,bootSession:boot.bootSession});
        // UID or group changes do not establish exit; the same start identity remains the original process.
        const sameOwner=inspection.owner&&['pid','startSec','startUsec'].every(key=>inspection.owner[key]===protocol.manager[key]);
        managerQuiescence=priorBoot?'prior-boot':sameOwner?'live':'absent';manager={process:protocol.manager,inspection,quiescent:!sameOwner};
      }
      attempts.push({id:row.id,sequence:row.sequence,target:row.target,bootSession:protocol?.bootSession??null,priorBoot,managerQuiescence,manager});
    }
    for(const row of journal.workers){
      const priorBoot=boot.bootSession!==row.process.bootSession;
      const inspection=await this.handoffProcess('inspect',row.process,epoch);shape(inspection,['version','bootSession','priorBoot','leader','group','groupQuery']);
      const q=inspection.groupQuery;shape(q,['bytes','errno','positivePids']);
      if(inspection.version!==1||inspection.bootSession!==boot.bootSession||inspection.priorBoot!==priorBoot||!Array.isArray(inspection.group)||inspection.group.length>=4096||!Number.isSafeInteger(q.bytes)||q.bytes<0||q.bytes>=16384||q.bytes%4||q.errno!==0||q.positivePids!==inspection.group.length||q.positivePids>q.bytes/4)throw new Error('Invalid native process group inspection.');
      const currentIdentity=value=>verifyHandoffProcessIdentity(value,{bootSession:boot.bootSession});
      if(inspection.leader!==null){currentIdentity(inspection.leader);if(inspection.leader.pid!==row.process.pid)throw new Error('Native leader identity changed.');}
      const ids=new Set();for(const member of inspection.group){if(member.unavailable===true){shape(member,['pid','unavailable','errno']);if(!Number.isSafeInteger(member.pid)||member.pid<1||member.pid>2147483647||!Number.isSafeInteger(member.errno)||member.errno<0||member.errno>2147483647)throw new Error('Invalid unavailable process row.');}else{currentIdentity(member);if(member.pgid!==row.process.pgid)throw new Error('Native process group membership changed during inspection.');}if(ids.has(member.pid))throw new Error('Repeated native process group member.');ids.add(member.pid);}
      if(priorBoot&&(inspection.leader!==null||inspection.group.length||q.bytes))throw new Error('Prior-boot process inspection queried historical identities.');
      const leader=inspection.leader,sameLeader=leader&&['pid','startSec','startUsec'].every(key=>leader[key]===row.process[key]);
      workers.push({sequence:row.sequence,attemptId:row.attemptId,process:row.process,inspection,quiescent:priorBoot||!sameLeader&&inspection.group.length===0});
    }
    if((await this.readHandoffRecovery(fresh.id,epoch,view)).fingerprint!==fresh.fingerprint)throw new Error('Handoff journal changed during process inspection.');
    const priorBoot=attempts.every(row=>row.priorBoot),managerQuiescence=attempts.some(row=>row.managerQuiescence==='live')?'live':attempts.some(row=>row.managerQuiescence==='unverified')?'unverified':priorBoot?'prior-boot':'absent';
    // Boot change excludes saved processes, not current or externally relaunched jobs. Fresh scoped admission is still required.
    return {version:2,fingerprint:fresh.fingerprint,bootSession:boot.bootSession,priorBoot,priorBootProcessesAbsent:priorBoot,legacy:journal.legacy,helpersQuiescent:!journal.legacy&&workers.every(row=>row.quiescent),managerQuiescence,manager:attempts[0].manager,engineQuiescence:'unverified',attempts,workers};
  }
  async beginHandoffRecoveryAttempt(review,target,{lease,fence},epoch){
    this.assertEpoch(epoch);if(this.activeHandoff||this.commandReservation)throw new Error('Another handoff or command still owns execution.');
    const recovery=fence?.recovery,familyReview=recovery?.review;
    const fresh=await this.readHandoffRecovery(review?.id,epoch);
    if(fresh.fingerprint!==review.fingerprint||![fresh.manifest.source,fresh.manifest.destination].includes(target))throw new Error('Handoff recovery review or target changed.');
    const check=()=>{
      this.assertEpoch(epoch);
      if(!familyReview||typeof familyReview!=='object'||!fence?.running||fence.recovery!==recovery||recovery.review!==familyReview||!recovery.consumed||fence.originalDestination!==fresh.manifest.destination||!equal(recovery.journal,fresh.familyJournal))throw new Error('Handoff recovery attempt lacks the consumed family review.');
      this.coding.checkHandoffAuthority(target,fence,{snapshot:fresh.manifest.family,lease});
    };
    check();const proof=await this.inspectHandoffProcesses(fresh,epoch);check();
    if(!proof.priorBootProcessesAbsent||!proof.helpersQuiescent||proof.managerQuiescence!=='prior-boot')throw Object.assign(new Error('Prior handoff writers are unconfirmed; preserve the execution fences.'),{code:'HANDOFF_WRITERS_UNCONFIRMED'});
    const processProtocol=await this.handoffManager(epoch);check();if(processProtocol.bootSession!==proof.bootSession)throw new Error('Handoff recovery boot identity changed.');
    const record=this.handoffs.find(h=>h.id===fresh.id),worktree=this.records.find(r=>r.id===record?.worktreeId);
    if(!record||worktree?.state!=='ready'||this.activeHandoff||this.commandReservation)throw new Error('Handoff recovery ownership changed.');
    const details={id:randomUUID(),previousAttemptId:fresh.processJournal.attempts.at(-1).id,target,processProtocol,reviewFingerprint:fresh.fingerprint,reviewProgress:fresh.progress};
    const active={plan:{...fresh.manifest,directory:fresh.directory,recovery:record.recovery,record:worktree,lease},record,epoch,fence,target,recoveryReview:fresh,attempt:details,checkRecovery:check};
    this.activeHandoff=active;
    try{await this.handoffCheckpoint(active,'recovery-attempt-started',epoch,details);check();return active;}
    catch(error){active.recoveryReview=fresh;this.retainedLeases.add(lease);throw error;}
  }
  async handoffCheckpoint(active,phase,epoch,details={},failureOnly=false){
    if(typeof phase==='string'&&phase.startsWith('native-recovery-'))details=structuredClone(details);
    const check=()=>{if(!failureOnly)return this.assertHandoffActive(active,epoch);if(!active||this.activeHandoff!==active||!this.handoffs.includes(active.record)||details?.outcome!=='failed')throw new Error('Handoff failure receipt authority changed.');};
    check();if(typeof phase!=='string'||!/^[a-z][a-z0-9-]{0,79}$/.test(phase))throw new Error('Invalid handoff phase.');
    // Immutable linked receipts keep the bounded ledger small, including large chat families.
    await this.withLedger(async()=>{
      check();await this.checkLedger();const p=active.plan;let previous=active.record.progress??null,nativeBytes=0;
      if(active.recoveryReview){
        if(failureOnly||phase!=='recovery-attempt-started'||!equal(details,active.attempt))throw new Error('Handoff recovery attempt must be recorded before another checkpoint.');
        const fresh=await this.readHandoffRecoveryLedger(p.id,epoch);check();
        if(fresh.fingerprint!==active.recoveryReview.fingerprint)throw new Error('Handoff recovery attempt review is stale.');
        previous=fresh.head;
      }else if(phase==='recovery-attempt-started'&&!failureOnly)throw new Error('Handoff recovery attempt review authority is missing.');
      const sequence=(previous?.sequence??0)+1;
      if(sequence>8192)throw new Error('Handoff progress limit exceeded.');if(previous)await this.readHandoffProgress(active,previous);
      if(phase.startsWith('native-recovery-')&&details?.outcome!=='failed'){
        nativeRequire(active.attempt&&typeof active.checkRecovery==='function'&&!active.familyReturned&&!active.recoveryReview,'current consumed recovery attempt required');active.checkRecovery();
        const fresh=await this.readHandoffRecoveryLedger(p.id,epoch);check();const latest=fresh.processJournal.attempts.at(-1),{sequence:attemptSequence,...attempt}=latest;
        nativeRequire(attemptSequence>0&&equal(attempt,active.attempt)&&active.target===attempt.target&&equal(fresh.head,previous),'current recovery attempt or journal changed');
        nativeBytes=fresh.receipts.reduce((total,row)=>total+row.stamp.bytes,0);
        await nativeRecoveryJournal(fresh.manifest,p.directory,[...fresh.receipts,{entry:{sequence,phase,details}}],fresh.processJournal.attempts,previous,check,{emptySequence:sequence});check();
      }
      await verify(p.directory,p.recovery.directory);if(await realpath(p.directory)!==p.directory)throw new Error('Handoff recovery directory changed.');
      const body=JSON.stringify({version:1,id:p.id,manifestHash:p.recovery.manifest.hash,sequence,phase,previous,details});if(Buffer.byteLength(body)>MANIFEST_BYTES||nativeBytes+Buffer.byteLength(body)>ARCHIVE_BYTES)throw new Error('Handoff progress exceeds its receipt or journal byte limit.');
      const path=join(p.directory,'progress-'+String(sequence).padStart(8,'0')+'.json');check();await writeFile(path,body,{flag:'wx',mode:0o600,flush:true});await syncDirectory(p.directory);
      const progress={sequence,...await artifactStamp(path,MANIFEST_BYTES)};check();
      Object.assign(active.record,{phase,progress,updatedAt:this.now(),message:typeof details==='string'?details.slice(0,1600):failureOnly?String(details.message).slice(0,1600):'Verified phase: '+phase});await this.saveLedger();
      check();if(active.recoveryReview)active.recoveryReview=null;
    });check();
  }
  async verifyHandoffPublishedLive(p,label,publication,temporary,epoch,{newTemporary=false}={}){
    const current=await this.handoffNativeState(p.states[label].r,temporary,epoch,p.native[label]),expected=publication.live;
    if(!equal(current.stamps,expected.stamps)||current.bytes!==expected.bytes)throw new Error('Handoff '+label+' full published namespace or native metadata changed.');
    const root=s=>Object.fromEntries(Object.entries(s).filter(([key])=>!newTemporary||!['mtime','ctime','nlink'].includes(key)));
    if(!equal(root(current.rootStamp),root(expected.rootStamp)))throw new Error('Handoff '+label+' published root metadata changed.');
    return current;
  }
  async publishHandoffFiles(active,epoch){
    const p=active.plan;active.publications={};await this.verifyHandoffRecovery(p,epoch);
    if(!equal(await this.handoffTemporary([p.source,p.destination],epoch),p.temporary))throw new Error('Handoff scratch ownership changed before publication.');
    for(const label of ['destination','source']){
      this.assertHandoffActive(active,epoch);const stage=p.stages[label];
      if(!equal(await this.handoffNativeState(p.states[label].r,p.temporary,epoch,p.native[label]),p.native[label]))throw new Error('Handoff '+label+' native review changed before publication.');
      if(!stage.install.length&&!stage.remove.length){
        active.publications[label]={live:p.native[label],stage,capture:stage.capture};await this.handoffCheckpoint(active,'native-'+label+'-unchanged',epoch,{label,live:p.native[label]});continue;
      }
      await this.handoffCheckpoint(active,'native-'+label+'-publishing',epoch,{label,root:p.native[label].root,stage:stage.root,capture:stage.capture.root});
      const receipt=await this.handoffFiles('publish',{root:p.native[label].root,stage:stage.root,capture:stage.capture.root,before:stage.before,staged:stage.stamps,beforeRootStamp:stage.beforeRootStamp,stagedRootStamp:stage.rootStamp,captureRootStamp:stage.capture.rootStamp,install:stage.install,remove:stage.remove},epoch);
      this.assertHandoffActive(active,epoch);const publication=handoffPublishedState(p,label,receipt);active.publications[label]=publication;
      const live=await this.verifyHandoffPublishedLive(p,label,publication,p.temporary,epoch);await this.verifyHandoffNativeCopy(publication.stage,epoch);await this.verifyHandoffNativeCopy(publication.capture,epoch);
      await this.handoffCheckpoint(active,'native-'+label+'-published',epoch,{label,receipt,live});
    }
    return active.publications;
  }
  async completeHandoff(active,family,epoch,commitOwner){
    const p=active.plan;
      this.assertHandoffActive(active,epoch);
      if(!active.git||!active.publications?.source||!active.publications?.destination||family.rootThreadId!==p.rootThreadId||family.cwd!==p.destination||family.model!==p.family.model||family.modelProvider!==p.family.modelProvider||!equal(family.members,p.family.members.map(member=>({...member,cwd:p.destination}))))throw new Error('Handoff returned incomplete Git, native or chat family evidence.');
      const temporary=await this.handoffTemporary([p.source,p.destination],epoch);
      for(const before of p.temporary)if(!temporary.some(after=>equal(after,before)))throw new Error('Reviewed scratch ownership changed during handoff.');
      const created=temporary.filter(t=>!p.temporary.some(before=>before.cwd===t.cwd));
      for(const t of created)if(t.cwd!==p.destination||[...Object.keys(p.native.destination.stamps),...p.native.destination.ignored,...p.native.destination.omitted].some(path=>overlaps(path,t.path.slice(t.cwd.length+1))))throw new Error('Unexpected scratch creation during handoff.');
      const native={};for(const label of ['source','destination'])native[label]=await this.verifyHandoffPublishedLive(p,label,active.publications[label],temporary,epoch,{newTemporary:created.some(t=>t.cwd===p[label])});
      await this.verifyHandoffRecovery(p,epoch,active.publications);await verifyHandoffGitPublication(p,active.git,{runner:this.runner,inspector:this.handoffInspector,check:()=>this.assertHandoffActive(active,epoch)});
      await this.handoffCheckpoint(active,'complete-verified',epoch,{family,temporary,native,git:active.git});
      for(let stamp=active.record.progress;stamp;){this.assertHandoffActive(active,epoch);stamp=(await this.readHandoffProgress(active,stamp)).previous;}
      if(p.owner){if(typeof commitOwner!=='function')throw new Error('Native owner commit callback is missing.');await commitOwner({target:family.cwd,fingerprint:family.fingerprint,progress:structuredClone(active.record.progress)});this.assertHandoffActive(active,epoch);}
      // The verified ledger commit ends this operation; a later Stop cannot uncommit it.
      await this.withLedger(async()=>{this.assertHandoffActive(active,epoch);const remaining=this.handoffs.filter(h=>h!==active.record);await this.saveLedger(remaining,()=>this.assertHandoffActive(active,epoch));this.handoffs=remaining;active.completed=true;});
  }
  async executeHandoff(planId,epoch){
    const active=await this.beginHandoff(planId,epoch),p=active.plan;
    try{
      const family=await this.coding.relocateFamily(p.family,p.destination,{
        ...(p.owner?{ownerContext:this.handoffOwnerContext(p)}:{}),
        bind:fence=>{this.assertHandoffActive(active,epoch);this.coding.checkHandoffAuthority(p.destination,fence,{snapshot:p.family,lease:p.lease});active.fence=fence;},
        checkpoint:(phase,details)=>this.handoffCheckpoint(active,phase,epoch,details),
        transfer:async()=>{this.assertHandoffActive(active,epoch);if(!active.fence||active.git)throw new Error('Handoff transfer authority is missing or reused.');active.git=await publishHandoffGit(p,{runner:this.runner,inspector:this.handoffInspector,check:()=>this.assertHandoffActive(active,epoch),checkpoint:(phase,details)=>this.handoffCheckpoint(active,phase,epoch,details),publishFiles:()=>this.publishHandoffFiles(active,epoch)});},
        complete:(family,commitOwner)=>this.completeHandoff(active,family,epoch,commitOwner)
      });
      active.familyReturned=true;if(!active.completed)throw new Error('Handoff completion callback did not commit verified state.');
      this.activeHandoff=null;await this.releasePlan(p);return {handoff:{id:p.id,rootThreadId:p.rootThreadId,source:p.source,destination:p.destination,state:'complete',recoveryDirectory:p.directory},family};
    }catch(error){
      active.noFamilyEffects=error.handoffStarted===false&&!active.fence?.exitUnconfirmed;
      if(error.code==='HANDOFF_EXIT_UNCONFIRMED'||active.fence?.exitUnconfirmed)this.handoffEngineBlocked=true;
      active.record.state='needs-inspection';active.record.message=String(error.message).slice(0,1600);active.record.updatedAt=this.now();this.retainedLeases.add(p.lease);
      try{await this.handoffCheckpoint(active,active.record.phase,epoch,{outcome:'failed',message:active.record.message,code:error.code??null,handoffStarted:error.handoffStarted??null,git:error.handoffGit??error.cause?.handoffGit??null,engineExitUnconfirmed:Boolean(active.fence?.exitUnconfirmed)},true);}catch{try{await this.save();}catch{}}
      throw Object.assign(error,{handoffId:p.id,recoveryDirectory:p.directory,phase:active.record.phase});
    }
  }
  async handoffRecoveryTemporary(manifest,epoch){
    const temporary=await this.handoffTemporary([manifest.source,manifest.destination],epoch);
    for(const saved of manifest.temporary){
      if(temporary.some(row=>row.path===saved.path))continue;
      try{await this.coding.verifyTemporary(saved);this.assertEpoch(epoch);temporary.push(structuredClone(saved));}
      catch{this.assertEpoch(epoch);} // An old unverified basename is selected user work, never an exclusion.
    }
    return temporary;
  }
  async handoffRecoverySnapshot(manifest,label,roots,temporary,epoch){
    const repo=manifest.repositories[label];await this.handoffInspector.verifyRepository(repo);this.assertEpoch(epoch);
    const excluded=['.git',...manifest.native[label].ignored,...temporary.filter(t=>t.cwd===repo.cwd).map(t=>t.path.slice(repo.cwd.length+1))],selected=[];
    for(const [i,root] of roots.entries())selected.push({root,paths:(await this.handoffNativePaths(root,i===0?excluded:[],epoch)).names});
    const result=await this.handoffFiles('recoverySnapshot',{roots:selected},epoch);
    for(const [i,root] of roots.entries())if(!equal((await this.handoffNativePaths(root,i===0?excluded:[],epoch)).names,selected[i].paths))throw new Error('Handoff recovery namespace changed during inspection.');
    await this.handoffInspector.verifyRepository(repo);this.assertEpoch(epoch);return result;
  }
  handoffRecoveryLocks(review){
    const locks=new Map();for(const {entry} of review.receipts){
      if(entry.details?.outcome==='failed')continue;
      const rows=['git-lock-acquired','git-ref-lock-prepared','git-recovery-lock-acquired','git-recovery-ref-lock-prepared'].includes(entry.phase)?[entry.details.lock]:['git-locked','git-recovery-locked'].includes(entry.phase)?entry.details.locks:[];
      if(!Array.isArray(rows))throw new Error('Invalid journaled Git locks.');for(const row of rows){if(!row||typeof row.path!=='string')throw new Error('Invalid journaled Git lock.');locks.set(row.path,structuredClone(row));}
      if(locks.size>64)throw new Error('Handoff recovery Git lock limit exceeded.');
    }return [...locks.values()];
  }
  async reviewHandoffRecoveryNative(review,mode,temporary,epoch){
    const native={};for(const label of ['source','destination']){
      const roots=[review.manifest.native[label].root,...review.nativeJournal.roots[label]];
      const observed=await this.handoffRecoverySnapshot(review.manifest,label,roots,temporary,epoch);
      native[label]=reviewHandoffRecoveryFiles(review.manifest,label,mode,observed,{temporary});
    }return native;
  }
  async prepareHandoffRecovery(id,mode,epoch){
    identifier(id);if(!['restore','finish'].includes(mode)||!this.coding)throw new Error('Invalid handoff recovery mode.');
    await this.expirePlans();if(this.commandReservation||this.activeHandoff||this.handoffAdmission||this.plans.size>=32)throw new Error('Another command, handoff or review owns execution.');
    const review=await this.readHandoffRecovery(id,epoch),h=this.handoffs.find(h=>h.id===id),record=this.records.find(r=>r.id===h.worktreeId),manifest=review.manifest,target=manifest[mode==='restore'?'source':'destination'];
    if(this.coding.handoffOwner&&!manifest.owner)throw new Error('This retained handoff predates catalog-owner binding. Its recovery evidence is preserved; explicit owner migration is required before recovery.');
    const proof=await this.inspectHandoffProcesses(review,epoch);
    if(!proof.priorBootProcessesAbsent||!proof.helpersQuiescent||proof.managerQuiescence!=='prior-boot')throw Object.assign(new Error('Prior handoff writers are unconfirmed; preserve the execution fences.'),{code:'HANDOFF_WRITERS_UNCONFIRMED'});
    const ownerContext=manifest.owner?this.handoffOwnerContext({...manifest,recovery:h.recovery}):null;
    if(ownerContext)await this.coding.loadHandoffRecovery(ownerContext);this.assertEpoch(epoch);
    const admission={id:randomUUID(),worktreeId:h.worktreeId,paths:h.paths,phase:'recovery-review'};this.handoffAdmission=admission;let lease;
    try{
      const inspector=this.handoffInspector;let familyReview;
      const reserve=ownerContext?resolvePaths=>this.coding.reserveHandoffRecovery(resolvePaths,ownerContext):this.reserveMutation;
      lease=await reserve(async()=>{
        await this.sourceIdentity(record,h);await this.verifyRecord(record);
        const filesystem=manifest.version===6?Object.fromEntries(['fromDevice','toDevice','volumeUUID'].map(key=>[key,manifest.reconnect[key]])):null;
        familyReview=await this.coding.prepareHandoffRecovery(manifest.family,manifest.destination,review.familyJournal,filesystem);this.assertEpoch(epoch);
        const peers=await inspector.peerInventory(manifest.repositories.source,inspector.epoch),paths=peers.records.map(row=>row.path);await this.assertNoHandoff(paths,h);
        const owned=await this.coding.projectMutationInventory();this.assertEpoch(epoch);
        for(const cwd of owned){if(paths.some(path=>inside(path,cwd)))continue;const metadata=await this.handoffRepository(cwd,epoch);if(metadata.some(dir=>overlaps(dir.canonical,record.commonDir)||same(dir.identity,record.identities.common)))paths.push(cwd);this.assertEpoch(epoch);}
        return paths;
      });
      const p={...manifest,id:admission.id,handoffId:id,operation:'handoff-recovery',mode,target,record,admission,lease,review,familyReview,directory:review.directory,recovery:h.recovery,rootThreadId:manifest.family.rootThreadId,expiresAt:this.now()+120000};
      p.states=await rehydrateHandoffGitStates({baseline:p.gitBaseline,repositories:p.repositories,candidate:p.candidate},{check:()=>this.assertEpoch(epoch)});
      p.temporary=await this.handoffRecoveryTemporary(manifest,epoch);await this.verifyHandoffArtifacts(p,epoch);
      p.nativeReview=await this.reviewHandoffRecoveryNative(review,mode,p.temporary,epoch);
      p.gitReview=await reviewHandoffGitRecovery({...p,id}, {runner:this.runner,inspector,check:()=>this.assertEpoch(epoch),locks:this.handoffRecoveryLocks(review)});
      p.manager=await this.handoffManager(epoch);await this.checkHandoffRecoveryReview(p,epoch);
      p.expiresAt=this.now()+120000;this.plans.set(p.id,p);p.timer=setTimeout(()=>{if(this.plans.get(p.id)===p&&!this.operation)void this.releasePlan(p).catch(()=>{});},120000);p.timer.unref?.();
      return {plan:{id:p.id,operation:p.operation,handoffId:id,worktreeId:p.worktreeId,mode,target,source:p.source,destination:p.destination,rootThreadId:p.rootThreadId,phase:h.phase,family:p.family.members.map(t=>({id:t.id,archived:t.archived})),branch:p.candidate.branch,files:Object.values(p.nativeReview).reduce((n,r)=>n+Object.keys(r.desired.stamps).length,0),bytes:Object.values(p.nativeReview).reduce((n,r)=>n+r.bytes,0),retainedFiles:Object.values(p.nativeReview).reduce((n,r)=>n+Object.keys(r.captured).length,0),nativePolicy:p.stages.policy,recoveryDirectory:p.directory,expiresAt:p.expiresAt}};
    }catch(error){if(lease){if(this.blocked)this.retainedLeases.add(lease);else await lease.release();}if(!this.blocked&&this.handoffAdmission===admission)this.handoffAdmission=null;throw error;}
  }
  async checkHandoffRecoveryReview(p,epoch){
    this.assertEpoch(epoch);if(p.expiresAt<=this.now()||this.handoffAdmission!==p.admission||!this.records.includes(p.record)||p.record.state!=='ready')throw new Error('Handoff recovery review expired or ownership changed.');
    const fresh=await this.readHandoffRecovery(p.handoffId,epoch);if(fresh.fingerprint!==p.review.fingerprint)throw new Error('Handoff recovery journal changed after review.');
    const h=this.handoffs.find(h=>h.id===p.handoffId);await this.sourceIdentity(p.record,h);await this.verifyRecord(p.record);
    if(!equal(await this.handoffRecoveryTemporary(fresh.manifest,epoch),p.temporary))throw new Error('Handoff recovery scratch ownership changed after review.');
    await this.verifyHandoffArtifacts(p,epoch);
    if(!equal(await this.reviewHandoffRecoveryNative(fresh,p.mode,p.temporary,epoch),p.nativeReview))throw new Error('Handoff recovery native state changed after review.');
    const git=await reviewHandoffGitRecovery({...p,id:p.handoffId},{runner:this.runner,inspector:this.handoffInspector,check:()=>this.assertEpoch(epoch),locks:this.handoffRecoveryLocks(fresh)});
    if(!equal(git,p.gitReview)||!equal(await this.handoffManager(epoch),p.manager))throw new Error('Handoff recovery Git or manager state changed after review.');
  }
  async stageHandoffRecoveryFiles(active,p,epoch){
    const check=()=>this.assertHandoffActive(active,epoch);check();if(active.nativePlan)throw new Error('Recovery native staging already began.');
    if(!equal(await this.reviewHandoffRecoveryNative(p.review,p.mode,p.temporary,epoch),p.nativeReview))throw new Error('Handoff recovery native state changed before staging.');
    const roots={};for(const label of ['source','destination']){
      roots[label]={};for(const kind of ['stage','capture']){check();const path=join(p.directory,`recovery-${p.id}-${label}-${kind}`);await mkdir(path,{mode:0o700});check();roots[label][kind]={path,...await identity(path)};}
    }
    await syncDirectory(p.directory);check();const plan={version:1,attemptId:active.attempt.id,reviewId:p.id,mode:p.mode,roots};
    await this.handoffCheckpoint(active,'native-recovery-plan',epoch,plan);active.nativePlan=plan;active.nativeStages={};
    for(const label of ['source','destination'])active.nativeStages[label]=await prepareHandoffRecoveryFiles(p.nativeReview[label],{...roots[label],native:(action,input)=>this.handoffFiles(action,input,epoch),check});
  }
  async verifyHandoffRecoveryPublication(active,label,publication,temporary,epoch,{newTemporary=false}={}){
    const observed=await this.handoffRecoverySnapshot(active.plan,label,publication.roots.map(value=>value.root),temporary,epoch),expected={roots:publication.roots,bytes:publication.bytes};
    if(newTemporary){const trim=value=>{const copy=structuredClone(value);for(const key of ['mtime','ctime','nlink'])delete copy.roots[0].rootStamp[key];return copy;};if(!equal(trim(observed),trim(expected)))throw new Error('Handoff recovery full published namespace or metadata changed.');}
    else if(!equal(observed,expected))throw new Error('Handoff recovery full published namespace or metadata changed.');
    return observed;
  }
  async publishHandoffRecoveryFiles(active,p,epoch){
    if(!active.nativePlan||active.publications)throw new Error('Handoff recovery publication authority missing or reused.');active.publications={};
    for(const label of ['destination','source']){
      this.assertHandoffActive(active,epoch);const prepared=active.nativeStages[label];
      const current=await this.handoffRecoverySnapshot(p,label,p.nativeReview[label].observed.roots.map(row=>row.root),p.temporary,epoch);
      if(!equal(current,p.nativeReview[label].observed))throw new Error('Handoff recovery namespace changed before publication.');
      const intent={version:1,attemptId:active.attempt.id,reviewId:p.id,label,input:prepared.input,desired:prepared.desired,excluded:prepared.excluded,captured:prepared.captured};
      await this.handoffCheckpoint(active,'native-recovery-publishing',epoch,intent);const intentSequence=active.record.progress.sequence;
      const receipt=await this.handoffFiles('recoverPublish',prepared.input,epoch);this.assertHandoffActive(active,epoch);
      const publication=handoffRecoveryPublishedState(prepared,receipt);active.publications[label]=publication;
      await this.verifyHandoffRecoveryPublication(active,label,publication,p.temporary,epoch);
      await this.handoffCheckpoint(active,'native-recovery-published',epoch,{version:1,attemptId:active.attempt.id,reviewId:p.id,label,intentSequence,receipt});
    }return active.publications;
  }
  async completeHandoffRecovery(active,p,family,epoch,commitOwner){
      this.assertHandoffActive(active,epoch);
      if(!active.git||!active.publications?.source||!active.publications?.destination||family.rootThreadId!==p.rootThreadId||family.cwd!==p.target||family.model!==p.family.model||family.modelProvider!==p.family.modelProvider||!equal(family.members,p.family.members.map(member=>({...member,cwd:p.target}))))throw new Error('Handoff recovery returned incomplete Git, native or chat family evidence.');
      const temporary=await this.handoffRecoveryTemporary(p.review.manifest,epoch);
      for(const before of p.temporary)if(!temporary.some(after=>equal(after,before)))throw new Error('Recovery scratch ownership changed during execution.');
      const created=temporary.filter(t=>!p.temporary.some(before=>before.path===t.path));
      for(const t of created){const label=t.cwd===p.source?'source':'destination';if(t.cwd!==p.target||[...Object.keys(active.publications[label].live.stamps),...p.nativeReview[label].excluded].some(path=>overlaps(path,t.path.slice(t.cwd.length+1))))throw new Error('Unexpected scratch creation during recovery.');}
      const native={};for(const label of ['source','destination'])native[label]=await this.verifyHandoffRecoveryPublication(active,label,active.publications[label],temporary,epoch,{newTemporary:created.some(t=>t.cwd===p[label])});
      await this.verifyHandoffArtifacts(active.plan,epoch);await verifyHandoffGitRecovery(active.plan,active.git,{runner:this.runner,inspector:this.handoffInspector,check:()=>this.assertHandoffActive(active,epoch)});
      await this.handoffCheckpoint(active,'recovery-complete-verified',epoch,{mode:p.mode,family,temporary,native,git:active.git});await this.readHandoffRecovery(p.handoffId,epoch);
      if(p.owner){if(typeof commitOwner!=='function')throw new Error('Native owner commit callback is missing.');await commitOwner({target:family.cwd,fingerprint:family.fingerprint,progress:structuredClone(active.record.progress)});this.assertHandoffActive(active,epoch);}
      // The verified ledger commit ends this operation; a later Stop cannot uncommit it.
      await this.withLedger(async()=>{this.assertHandoffActive(active,epoch);const remaining=this.handoffs.filter(h=>h!==active.record);await this.saveLedger(remaining,()=>this.assertHandoffActive(active,epoch));this.handoffs=remaining;active.completed=true;});
  }
  async executeHandoffRecovery(planId,epoch){
    const p=this.plans.get(planId);if(!p||p.operation!=='handoff-recovery')throw new Error('Handoff recovery review expired, consumed or unknown.');this.plans.delete(planId);clearTimeout(p.timer);let active;
    try{
      await this.checkHandoffRecoveryReview(p,epoch);
      await p.lease.revalidateScope?.();this.assertEpoch(epoch);
      const family=await this.coding.recoverHandoffFamily(p.familyReview,p.target,{
        ...(p.owner?{ownerContext:this.handoffOwnerContext({...p,id:p.handoffId})}:{}),
        bind:async fence=>{active=await this.beginHandoffRecoveryAttempt(p.review,p.target,{lease:p.lease,fence},epoch);Object.assign(active.plan,{states:p.states,temporary:p.temporary,rootThreadId:p.rootThreadId,admission:p.admission});},
        checkpoint:(phase,details)=>this.handoffCheckpoint(active,phase,epoch,details),
        transfer:async()=>{this.assertHandoffActive(active,epoch);if(active.git)throw new Error('Handoff recovery transfer reused.');await this.stageHandoffRecoveryFiles(active,p,epoch);const options={runner:this.runner,inspector:this.handoffInspector,check:()=>this.assertHandoffActive(active,epoch),checkpoint:(phase,details)=>this.handoffCheckpoint(active,phase,epoch,details)};active.git=await (p.mode==='restore'?restoreHandoffGit(active.plan,p.gitReview,{...options,restoreFiles:()=>this.publishHandoffRecoveryFiles(active,p,epoch)}):finishHandoffGit(active.plan,p.gitReview,{...options,finishFiles:()=>this.publishHandoffRecoveryFiles(active,p,epoch)}));},
        complete:(family,commitOwner)=>this.completeHandoffRecovery(active,p,family,epoch,commitOwner)
      });
      active.familyReturned=true;if(!active.completed)throw new Error('Handoff completion callback did not commit verified state.');
      this.activeHandoff=null;await this.releasePlan(p);return {handoff:{id:p.handoffId,rootThreadId:p.rootThreadId,source:p.source,destination:p.destination,mode:p.mode,target:p.target,state:'complete',recoveryDirectory:p.directory},family};
    }catch(error){
      active??=this.activeHandoff;
      if(active&&active.record.id===p.handoffId)active.plan.admission=p.admission;
      if(active){active.noFamilyEffects=error.handoffStarted===false&&!active.fence?.exitUnconfirmed;if(error.code==='HANDOFF_EXIT_UNCONFIRMED'||active.fence?.exitUnconfirmed)this.handoffEngineBlocked=true;active.record.state='needs-inspection';active.record.message=String(error.message).slice(0,1600);active.record.updatedAt=this.now();this.retainedLeases.add(p.lease);try{await this.handoffCheckpoint(active,active.record.phase,epoch,{outcome:'failed',message:active.record.message,code:error.code??null,handoffStarted:error.handoffStarted??null,git:error.handoffGitRecovery??error.cause?.handoffGitRecovery??null},true);}catch{try{await this.save();}catch{}}}
      else await this.releasePlan(p);
      throw Object.assign(error,{handoffId:p.handoffId,recoveryDirectory:p.directory,phase:active?.record.phase??'recovery-review'});
    }
  }
  async releasePlan(plan){if(!plan)return;if(plan.operation==='handoff-copy')plan.controller.abort();clearTimeout(plan.timer);this.plans.delete(plan.id);if(this.blocked){this.retainedLeases.add(plan.lease);return;}await plan.lease?.release();this.retainedLeases.delete(plan.lease);if(this.handoffAdmission===plan.admission)this.handoffAdmission=null;}
  async expirePlans(){for(const plan of [...this.plans.values()])if(plan.expiresAt<=this.now())await this.releasePlan(plan);}
  scoped(cwd,gitDir){return [`--git-dir=${gitDir}`,`--work-tree=${cwd}`];}
  async inspect(source,gitDir,commit,epoch){
    const args=this.scoped(source,gitDir),config=(await this.run([...args,'config','--includes','--null','--show-origin','--list'],{epoch})).stdout;
    const parts=config.split('\0'),settings=new Map();for(let i=1;i<parts.length;i+=2){const split=parts[i].indexOf('\n');settings.set(split<0?parts[i]:parts[i].slice(0,split),split<0?'':parts[i].slice(split+1));}
    const booleans=(await this.run([...args,'config','--includes','--null','--type=bool','--get-regexp','^(core\\.(bare|sparsecheckout|sparsecheckoutcone)|remote\\..*\\.promisor)$'],{epoch,allowOne:true})).stdout;
    if(booleans.split('\0').some(entry=>entry.slice(entry.indexOf('\n')+1)==='true')||[...settings].some(([k,v])=>k==='extensions.partialclone'||k==='extensions.refstorage'&&v!=='files'||k==='extensions.objectformat'&&v!=='sha1'))throw new Error('Bare, sparse, partial-clone, or non-file-ref repositories are not supported.');
    const tree=(await this.run([...args,'ls-tree','-r','-z','--full-tree',commit],{epoch})).stdout,entries=tree.split('\0').filter(Boolean);if(entries.length>20000)throw new Error('This checkout exceeds the 20,000-file inspection limit.');
    const names=entries.map(line=>{const m=/^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);if(!m||!['100644','100755','120000'].includes(m[1])||m[2]!=='blob')throw new Error('Submodules or unsupported tree entries are not supported.');return m[4];});
    const attributes=(await this.run([...args,'check-attr','--source='+commit,'--stdin','-z','filter'],{epoch,input:names.length?names.join('\0')+'\0':''})).stdout;
    const attr=attributes.split('\0');for(let i=2;i<attr.length;i+=3)if(!['unspecified','unset'].includes(attr[i]))throw new Error('Active Git filter attributes are not supported; no incomplete checkout will be marked ready.');
    return sha(config+'\0'+tree+'\0'+attributes);
  }
  async project(source,ref,epoch){
    const top=pathLine((await this.run(['-C',source,'rev-parse','--show-toplevel'],{epoch})).stdout);const canonical=await this.projectPath(top);text(canonical,4096,'source');
    const gitDir=await realpath(pathLine((await this.run(['-C',canonical,'rev-parse','--absolute-git-dir'],{epoch})).stdout));const commonDir=await realpath(pathLine((await this.run(['-C',canonical,'rev-parse','--path-format=absolute','--git-common-dir'],{epoch})).stdout));
    if([gitDir,commonDir].some(path=>overlaps(path,dirname(this.root))))throw new Error('Protected app data cannot store source Git metadata.');
    const commit=(await this.run([...this.scoped(canonical,gitDir),'rev-parse','--verify','--end-of-options',ref+'^{commit}'],{epoch})).stdout.trim();if(!OID.test(commit))throw new Error('Revision must resolve to a locally available SHA-1 commit.');
    const identities={source:await identity(canonical),common:await identity(commonDir),sourceGit:await identity(gitDir)};
    const fingerprint=await this.inspect(canonical,gitDir,commit,epoch),dirty=Boolean((await this.run([...this.scoped(canonical,gitDir),'status','--porcelain=v1','-z','--untracked-files=normal'],{epoch})).stdout);
    return {source:canonical,gitDir,commonDir,commit,identities,fingerprint,dirty};
  }
  async creationChanges(p,epoch){
    const inspector=this.handoffInspector??=new GitWorkflow({dataDir:this.dataDir,spawnProcess:this.spawnProcess}),r=await inspector.repository(p.source,inspector.epoch);
    const excludedScratch=(await readdir(p.source)).filter(name=>fold(name).startsWith('.saleh-coding-tmp-')).sort();
    // ponytail: reuse the existing two-root omission bound; larger scratch inventories need an explicitly reviewed capture contract.
    if(excludedScratch.length>2)throw Error('Local changes cannot be copied with more than two reserved app scratch roots. Source files are kept.');
    const read=()=>inspector.readState(r,inspector.epoch,{omitUntracked:excludedScratch,includeDiff:false}),state=await read();this.assertEpoch(epoch);
    if(state.head!==p.commit)throw Error('Copy local changes requires the selected commit to equal source HEAD.');
    if(!state.index)throw Error('Copy local changes requires an ordinary source index.');ordinaryIndex(state.index);inspector.representable([...state.indexEntries.keys()]);
    for(const name of state.indexEntries.keys())inspector.switchPath(r,name);
    const ignored=(await this.run([...this.scoped(r.cwd,r.gitDir),'ls-files','--others','--ignored','--directory','--exclude-standard','-z'],{epoch})).stdout.split('\0').filter(Boolean).map(x=>x.endsWith('/')?x.slice(0,-1):x),root={path:r.cwd,...r.identities.cwd};
    const ignoredRemainders=state.entries.filter(entry=>entry.index==='D'&&state.files.get(entry.path).mode!=='0'&&ignored.some(path=>inside(fold(path),fold(entry.path)))).map(entry=>entry.path).sort(nativeOrder);
    const selected=async()=>{
      const names=new Set((await this.handoffNativePaths(root,['.git',...ignored,...excludedScratch],epoch)).names);
      // A staged deletion may retain an ignored working file. It is part of this reviewed change, unlike unrelated ignored files.
      for(const entry of state.entries)if(state.files.get(entry.path).mode!=='0'){const parts=entry.path.split('/');for(let i=1;i<=parts.length;i++)names.add(parts.slice(0,i).join('/'));}
      if(names.size>ARCHIVE_ENTRIES)throw Error('Local changes exceed 20,000 selected entries.');
      for(const name of names){inspector.switchPath(r,name);const stat=await optional(join(r.cwd,name));if(stat?.isDirectory()&&!stat.isSymbolicLink()&&bareGitDirectory(await readdir(join(r.cwd,name))))throw Error('Nested bare Git metadata cannot be copied with local changes.');this.assertEpoch(epoch);}
      return [...names].sort(nativeOrder);
    };
    const names=await selected(),native={root,...await this.handoffFiles('snapshot',{root,paths:names},epoch)};this.assertEpoch(epoch);
    if((await read()).fingerprint!==state.fingerprint||!equal(await selected(),names))throw Error('Local changes changed during capture; prepare again.');
    return {fingerprint:state.fingerprint,indexEntries:[...state.indexEntries],native,excludedScratch,ignoredRemainders,entries:state.entries.map(({path,index,worktree})=>({path,index,worktree,mode:state.files.get(path).mode,hash:state.files.get(path).hash}))};
  }
  async checkCreationChanges(p,epoch){if(p.changes&&!equal(await this.creationChanges(p,epoch),p.changes))throw Error('Local changes or source metadata changed after review; prepare again.');}
  async privateCheckout(r){
    const directory=await open(r.cwd,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const stat=await directory.stat({bigint:true});if(!same({dev:String(stat.dev),ino:String(stat.ino)},r.identities.cwd))throw Error('New checkout destination identity changed.');await directory.chmod(0o700);}finally{await directory.close();}
  }
  async copyCreationChanges(p,r,epoch){
    await this.checkCreationChanges(p,epoch);await this.verifyRecord(r);await p.lease.revalidateScope?.();this.assertEpoch(epoch);
    if(await optional(join(r.admin,'index')))throw Error('New checkout index is already occupied; retained for inspection.');
    await this.run([...this.scoped(r.cwd,r.admin),'read-tree','--empty'],{record:r,epoch});await this.verifyRecord(r);
    if(p.changes.indexEntries.length)await this.run([...this.scoped(r.cwd,r.admin),'update-index','-z','--index-info'],{record:r,epoch,input:p.changes.indexEntries.map(([path,{mode,oid}])=>`${mode} ${oid} 0\t${path}\0`).join('')});
    await this.privateCheckout(r);await this.verifyRecord(r);await p.lease.revalidateScope?.();this.assertEpoch(epoch);
    p.copiedChanges=await this.handoffFiles('copyCheckout',{source:p.changes.native.root,destination:{path:r.cwd,...r.identities.cwd},stamps:p.changes.native.stamps},epoch);
    await this.checkCreationChanges(p,epoch);await this.checkCreatedChanges(p,r,epoch);
  }
  async checkCreatedChanges(p,r,epoch,withSetup=false){
    const inspector=this.handoffInspector;await this.verifyRecord(r);const repository=await inspector.repository(r.cwd,inspector.epoch),state=await inspector.readState(repository,inspector.epoch,{includeDiff:false});this.assertEpoch(epoch);
    const changes=state.entries.filter(e=>!withSetup||e.index!=='?'||e.worktree!=='?'||!p.localSetup.paths.includes(e.path)||p.changes.entries.some(old=>old.path===e.path)).map(({path,index,worktree})=>({path,index,worktree,mode:state.files.get(path).mode,hash:state.files.get(path).hash}));
    if(state.head!==p.commit||!equal([...state.indexEntries],p.changes.indexEntries)||!equal(changes,p.changes.entries))throw Error('Copied staged or working changes differ from the reviewed source; retained for inspection.');
    const root={path:r.cwd,...r.identities.cwd},names=(await this.handoffNativePaths(root,['.git'],epoch)).names,setup=withSetup?p.copiedLocalSetup:null,expected={...p.copiedChanges.stamps,...setup?.stamps};
    if(!equal([...names].sort(nativeOrder),Object.keys(expected).sort(nativeOrder)))throw Error('Copied checkout namespace changed; retained for inspection.');
    const actual=await this.handoffFiles('snapshot',{root,paths:names},epoch);
    if(!equal(actual.stamps,expected)||!equal(actual.rootStamp,(setup??p.copiedChanges).rootStamp))throw Error('Copied checkout content or native metadata changed; retained for inspection.');
  }
  async localSetup(p,epoch){
    const control=join(p.source,'.worktreeinclude'),found=await optional(control),override=await optional(join(p.source,'AGENTS.override.md'));
    if(found&&(!found.isFile()||found.isSymbolicLink()||found.nlink!==1||found.size>65536))throw Error('.worktreeinclude must be a regular file up to 64 KiB without extra links.');
    const policy=found?await artifactStamp(control,65536):null;
    if(found&&decode(await limited(control,65536)).includes('\0'))throw Error('.worktreeinclude contains an invalid NUL byte.');
    const empty={policy,paths:[],stamps:{},bytes:0};if(!found&&!override)return empty;
    const args=this.scoped(p.source,p.gitDir),list=async extra=>(await this.run([...args,'ls-files','--others','--ignored','-z',...extra],{epoch})).stdout.split('\0').filter(Boolean);
    const ignored=new Set(await list(['--exclude-standard',...(!found?['--','AGENTS.override.md']:[])]));
    const selected=found?await list(['--exclude-from='+control]):[];if(ignored.has('AGENTS.override.md'))selected.push('AGENTS.override.md');
    const tracked=(await this.run([...args,'ls-tree','-r','-z','--name-only',p.commit],{epoch})).stdout.split('\0').filter(Boolean),paths=[],names=new Set();
    for(const path of [...new Set(selected)].sort()){
      if(!ignored.has(path))continue;
      const parts=path.split('/');if(parts.length>64||Buffer.byteLength(path)>4096||parts.some(x=>!x||x==='.'||x==='..'||fold(x)==='.git'))throw Error('Invalid local setup path.');
      if(tracked.some(x=>overlaps(x,path)))continue;
      let safe=true;for(let i=0;i<parts.length;i++){const stat=await optional(join(p.source,...parts.slice(0,i+1)));if(!stat||stat.isSymbolicLink()||!(i===parts.length-1?stat.isFile():stat.isDirectory())){safe=false;break;}}
      if(!safe)continue;paths.push(path);for(let i=1;i<=parts.length;i++)names.add(parts.slice(0,i).join('/'));
      if(names.size>ARCHIVE_ENTRIES)throw Error('Local setup exceeds 20,000 selected entries.');
    }
    const native=names.size?await this.handoffFiles('snapshot',{root:{path:p.source,...p.identities.source},paths:[...names]},epoch):{stamps:{},bytes:0};
    if(!equal(policy,found?await artifactStamp(control,65536):await optional(control)))throw Error('Local setup selection changed during review.');
    return {policy,paths,stamps:native.stamps,bytes:native.bytes};
  }
  async checkLocalSetup(p,epoch){if(!equal(await this.localSetup(p,epoch),p.localSetup))throw Error('Local setup files or selection changed after review; prepare again.');}
  async copyLocalSetup(p,r,epoch){
    if(!p.localSetup.paths.length)return 0;
    await this.checkLocalSetup(p,epoch);await this.verifyRecord(r);
    const paths=[],names=new Set();
    for(const path of p.localSetup.paths){const parts=path.split('/');let available=true;
      for(let i=1;i<=parts.length;i++){const current=await optional(join(r.cwd,...parts.slice(0,i)));if(current&&(i===parts.length||!current.isDirectory()||current.isSymbolicLink())){available=false;break;}}
      if(available){paths.push(path);for(let i=1;i<=parts.length;i++)names.add(parts.slice(0,i).join('/'));}
    }
    if(!paths.length)return 0;
    await this.privateCheckout(r);
    await this.verifyRecord(r);await p.lease.revalidateScope?.();this.assertEpoch(epoch);
    p.copiedLocalSetup=await this.handoffFiles('copyLocal',{source:{path:p.source,...p.identities.source},destination:{path:r.cwd,...r.identities.cwd},stamps:Object.fromEntries([...names].map(name=>[name,p.localSetup.stamps[name]]))},epoch);
    await this.checkLocalSetup(p,epoch);await this.verifyRecord(r);return paths.length;
  }
  async prepare(cwd,ref,epoch,copyChanges=false){
    if(typeof copyChanges!=='boolean')throw Error('Invalid local changes copy option.');
    text(cwd,4096,'source directory');text(ref,512,'revision');if(!isAbsolute(cwd)||ref.startsWith('-')||ref!==ref.trim())throw new Error('Invalid source directory or revision.');
    await this.expirePlans();if(this.plans.size>=32)throw new Error('Too many pending worktree reviews.');if(this.records.length>=128)throw new Error('Managed worktree record limit of 128 reached.');
    let p,lease;try{
      // Only this owner reservation may re-enter recovery inspection while creation holds its operation.
      lease=await this.#creationAdmission.run(this.operation,()=>this.reserveMutation(async()=>{await this.assertOwned(cwd,epoch);p=await this.project(await realpath(cwd),ref,epoch);const paths=[];for(const part of (await this.run([...this.scoped(p.source,p.gitDir),'worktree','list','--porcelain','-z'],{epoch})).stdout.split('\0'))if(part.startsWith('worktree ')){const path=part.slice(9);if(!isAbsolute(path)||await realpath(path)!==path)throw new Error('Registered worktree path cannot be verified.');paths.push(path);}if(!paths.includes(p.source)||paths.length>128)throw new Error('Registered worktree inventory is incomplete or exceeds 128 paths.');await this.assertNoHandoff(paths);return paths;},{kind:'createWorktree',target:()=>p.source}));
      this.assertEpoch(epoch);p.localSetup=await this.localSetup(p,epoch);p.copyChanges=copyChanges;p.changes=copyChanges?await this.creationChanges(p,epoch):null;this.assertEpoch(epoch);const id=randomUUID(),plan={...p,id,lease,cwd:join(this.root,id),expiresAt:this.now()+120000};this.plans.set(id,plan);plan.timer=setTimeout(()=>{if(this.plans.get(id)===plan)void this.releasePlan(plan).catch(()=>{});},120000);plan.timer.unref?.();
      return {plan:{...Object.fromEntries(['id','source','commonDir','commit','cwd','dirty','expiresAt','copyChanges'].map(k=>[k,plan[k]])),localChanges:p.changes?{files:Object.values(p.changes.native.stamps).filter(row=>row.kind!=='directory').length,bytes:p.changes.native.bytes,changes:p.changes.entries.map(({path,index,worktree})=>({path,index,worktree})),excludedScratch:p.changes.excludedScratch,ignoredRemainders:p.changes.ignoredRemainders}:null,localSetup:{files:p.localSetup.paths.length,bytes:p.localSetup.bytes,paths:p.localSetup.paths}}};
    }catch(e){if(lease){if(this.blocked)this.retainedLeases.add(lease);else await lease.release();}throw e;}
  }
  async sourceIdentity(r,except=null){await this.assertNoHandoff([r.source,r.cwd],except);await verify(this.root,this.rootIdentity);await verify(r.source,r.identities.source);await verify(r.commonDir,r.identities.common);await verify(r.gitDir,r.identities.sourceGit);}
  async create(planId,epoch){
    const p=this.plans.get(planId);this.plans.delete(planId);if(!p)throw new Error('Worktree plan expired, consumed, or unknown.');clearTimeout(p.timer);try{return await this.createPlan(p,epoch);}finally{await this.releasePlan(p);}
  }
  async createPlan(p,epoch){
    if(p.operation)throw new Error('Worktree plan operation does not match creation.');
    if(p.expiresAt<=this.now())throw new Error('Worktree plan expired.');if(this.records.length>=128)throw new Error('Managed worktree record limit of 128 reached.');
    await this.sourceIdentity(p);await this.checkLocalSetup(p,epoch);await this.checkCreationChanges(p,epoch);if(await this.inspect(p.source,p.gitDir,p.commit,epoch)!==p.fingerprint)throw new Error('Repository configuration or attributes changed after review; prepare again.');
    const r={id:p.id,source:p.source,gitDir:p.gitDir,commonDir:p.commonDir,commit:p.commit,cwd:p.cwd,admin:join(p.commonDir,'worktrees',p.id),createdAt:this.now(),state:'creating',message:'Creating detached worktree.',identities:p.identities};
    if(await optional(r.cwd)||await optional(r.admin))throw new Error('Generated destination or Git registration already exists; prepare again.');
    await p.lease.revalidateScope?.();this.assertEpoch(epoch);
    this.assertEpoch(epoch);this.records.push(r);await this.save();
    try{
      await this.sourceIdentity(r);const first=await this.run([...this.scoped(r.source,r.gitDir),'worktree','add','--detach','--lock','--reason','Saleh managed worktree '+r.id,'--no-guess-remote','--no-relative-paths','--no-checkout',r.cwd,r.commit],{record:r,epoch});
      if(first.stderr.trim()&&!/^Preparing worktree \(detached HEAD [0-9a-f]+\)\s*$/.test(first.stderr.trim()))throw new Error('Git reported an unexpected preparation diagnostic: '+first.stderr.trim());
      r.identities.cwd=await identity(r.cwd);r.identities.admin=await identity(r.admin);r.identities.gitfile=await identity(join(r.cwd,'.git'),false);await this.verifyRecord(r);
      const context=await this.inspect(r.cwd,r.admin,r.commit,epoch);await this.sourceIdentity(r);if(await this.inspect(r.source,r.gitDir,r.commit,epoch)!==p.fingerprint)throw new Error('Source configuration changed during creation.');
      if(p.copyChanges)await this.copyCreationChanges(p,r,epoch);else for(const phase of [['read-tree',r.commit],['checkout-index','--all']]){
        await this.verifyRecord(r);if(await this.inspect(r.cwd,r.admin,r.commit,epoch)!==context)throw new Error('Destination configuration or attributes changed during creation.');
        const result=await this.run([...this.scoped(r.cwd,r.admin),...phase],{record:r,epoch});if(result.stderr.trim())throw new Error('Git reported a checkout diagnostic: '+result.stderr.trim());
      }
      await this.verifyRecord(r);await this.sourceIdentity(r);if(await this.inspect(r.cwd,r.admin,r.commit,epoch)!==context||await this.inspect(r.source,r.gitDir,r.commit,epoch)!==p.fingerprint)throw new Error('Repository configuration or attributes changed during checkout.');
      const head=(await this.run([...this.scoped(r.cwd,r.admin),'rev-parse','--verify','HEAD'],{epoch})).stdout.trim();if(head!==r.commit||decode(await limited(join(r.admin,'HEAD'),8192))!==r.commit+'\n')throw new Error('Created worktree HEAD is not the approved detached commit.');
      const dirty=(await this.run([...this.scoped(r.cwd,r.admin),'status','--porcelain=v1','-z','--untracked-files=all'],{epoch})).stdout;if(dirty&&!p.copyChanges)throw new Error('Created worktree contains unexpected or incomplete files; retained for inspection.');
      const copied=await this.copyLocalSetup(p,r,epoch);
      if(p.copyChanges)await this.checkCreatedChanges(p,r,epoch,true);else{
        for(const args of [['diff','--name-only'],['diff','--cached','--name-only']])if((await this.run([...this.scoped(r.cwd,r.admin),...args],{epoch})).stdout)throw Error('Tracked files changed during local setup copy.');
        const untracked=(await this.run([...this.scoped(r.cwd,r.admin),'ls-files','--others','--exclude-standard','-z'],{epoch})).stdout.split('\0').filter(Boolean);if(untracked.some(path=>!p.localSetup.paths.includes(path)))throw Error('Unexpected files appeared during local setup copy.');
        const tracked=(await this.run([...this.scoped(r.cwd,r.admin),'ls-tree','-r','--name-only','-z',r.commit],{epoch})).stdout.split('\0').filter(Boolean),expected=new Set();
        for(const path of [...tracked,...p.localSetup.paths]){const parts=path.split('/');for(let i=1;i<=parts.length;i++)expected.add(parts.slice(0,i).join('/'));}
        const root={path:r.cwd,...r.identities.cwd},names=(await this.handoffNativePaths(root,['.git'],epoch)).names;if(names.some(name=>!expected.has(name))||tracked.some(name=>!names.includes(name)))throw Error('New checkout namespace changed during setup copy; retained for inspection.');
        if(p.copiedLocalSetup){const setup=await this.handoffFiles('snapshot',{root,paths:Object.keys(p.copiedLocalSetup.stamps)},epoch);if(!equal(setup.stamps,p.copiedLocalSetup.stamps)||!equal(setup.rootStamp,p.copiedLocalSetup.rootStamp))throw Error('Copied setup files or native metadata changed; retained for inspection.');}
      }
      await this.verifyRecord(r);await this.sourceIdentity(r);if(await this.inspect(r.cwd,r.admin,r.commit,epoch)!==context||await this.inspect(r.source,r.gitDir,r.commit,epoch)!==p.fingerprint||(await this.run([...this.scoped(r.cwd,r.admin),'rev-parse','--verify','HEAD'],{epoch})).stdout.trim()!==head||decode(await limited(join(r.admin,'HEAD'),8192))!==r.commit+'\n')throw Error('Repository or detached HEAD changed during local setup copy.');
      const changed=Boolean((await this.run([...this.scoped(r.cwd,r.admin),'status','--porcelain=v1','-z','--untracked-files=all'],{epoch})).stdout);
      await this.checkCreationChanges(p,epoch);this.assertEpoch(epoch);Object.assign(r,{state:'ready',message:p.copyChanges?`Detached worktree ready with copied local changes${copied?` and ${copied} local setup file${copied===1?'':'s'}`:''}. Source files and staging are kept.`:copied?`Detached worktree ready. Copied ${copied} local setup file${copied===1?'':'s'}.`:'Detached worktree ready.',head,dirty:changed});await this.save();this.assertEpoch(epoch);
    }catch(e){Object.assign(r,{state:'needs-inspection',message:String(e.message).slice(0,1600)});await this.save();}
    return {worktree:publicRecord(r)};
  }
  recoveryPaths(r){const parent=join(this.root,'.archives'),directory=join(parent,r.archive.id);return {parent,directory,raw:join(directory,'raw'),index:join(directory,'original-index'),manifest:join(directory,'manifest.json'),bundle:join(directory,'recovery.bundle'),git:join(directory,'snapshot.git'),verified:join(directory,'verified.git')};}
  async inventory(base,withData=false){
    const entries=[],aliases=new Map();let bytes=0;
    const visit=async(relative,depth)=>{if(depth>64)throw new Error('Archive exceeds depth 64.');const names=(await readdir(join(base,relative),{encoding:'buffer'})).map(decode).sort();if(relative&&bareGitDirectory(names))throw new Error('Nested bare Git metadata cannot be archived.');for(const name of names){
      if(!relative&&name==='.git')continue;
      if(!name||name==='.'||name==='..'||name.includes('\0')||fold(name)==='.git')throw new Error('Nested Git metadata or invalid archive path.');
      const path=relative?relative+'/'+name:name;if(Buffer.byteLength(path)>4096||entries.length>=ARCHIVE_ENTRIES)throw new Error('Archive exceeds 20,000 entries or 4,096-byte paths.');
      const key=fold(path);if(aliases.has(key)&&aliases.get(key)!==path)throw new Error('Archive contains ambiguous case or Unicode paths.');aliases.set(key,path);
      const full=join(base,path),s=await lstat(full,{bigint:true}),row={path,identity:{dev:String(s.dev),ino:String(s.ino)},mode:Number(s.mode&0o777n)};let data;
      if(s.isDirectory()){row.type='directory';entries.push(row);await visit(path,depth+1);continue;}
      if(s.isSymbolicLink()){row.type='symlink';data=await readlink(full,{encoding:'buffer'});}else if(s.isFile()){row.type='file';data=await limited(full,FILE_BYTES);}else throw new Error('Archive cannot capture special filesystem entries.');
      const after=await lstat(full,{bigint:true});if(s.dev!==after.dev||s.ino!==after.ino||s.size!==after.size||s.mtimeNs!==after.mtimeNs)throw new Error('Archive file changed during capture.');
      bytes+=data.length;if(bytes>ARCHIVE_BYTES)throw new Error('Archive exceeds 128 MiB of file content.');Object.assign(row,{bytes:data.length,hash:sha(data),mtime:String(s.mtimeNs),links:String(s.nlink)});if(withData)row.data=data;entries.push(row);
    }};await visit('',0);const summary=entries.map(({data,...row})=>row);if(Buffer.byteLength(JSON.stringify(summary))>MANIFEST_BYTES)throw new Error('Archive manifest exceeds 8 MiB.');return {entries,summary,bytes,files:entries.length,hash:sha(JSON.stringify(summary))};
  }
  async peerState(r,epoch){
    const output=(await this.run([...this.scoped(r.source,r.gitDir),'worktree','list','--porcelain','-z'],{epoch})).stdout,peers=[];
    for(const block of output.split('\0\0').filter(Boolean)){const path=block.split('\0').find(s=>s.startsWith('worktree '))?.slice(9);if(!path||!isAbsolute(path)||await realpath(path)!==path)throw new Error('Registered worktree path cannot be verified.');peers.push({path,identity:await identity(path),registration:block});}
    if(!peers.length||peers.length>=128)throw new Error('Worktree mutation lease exceeds 128 paths.');await this.assertNoHandoff(peers.map(p=>p.path));return {paths:[this.root,...peers.map(p=>p.path)],records:peers,hash:sha(JSON.stringify(peers))};
  }
  async lifecycleConfig(r,epoch,cwd=r.cwd,gitDir=r.admin){
    const args=this.scoped(cwd,gitDir),config=(await this.run([...args,'config','--includes','--null','--show-origin','--list'],{epoch})).stdout;
    const bool=(await this.run([...args,'config','--includes','--null','--type=bool','--get-regexp','^(core\\.(bare|sparsecheckout|sparsecheckoutcone|splitindex)|remote\\..*\\.promisor)$'],{epoch,allowOne:true})).stdout;
    if(bool.split('\0').some(x=>x.slice(x.indexOf('\n')+1)==='true')||/extensions\.(?:worktreeconfig|partialclone|objectformat|refstorage)\n/.test(config))throw new Error('Unsupported repository format, sparse, split or worktree-specific configuration.');return sha(config);
  }
  async archiveState(r,epoch){
    await this.sourceIdentity(r);await this.verifyRecord(r);const args=this.scoped(r.cwd,r.admin),config=await this.lifecycleConfig(r,epoch),sourceConfig=await this.lifecycleConfig(r,epoch,r.source,r.gitDir);
    for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'])if(await optional(join(r.admin,name)))throw new Error('In-progress Git operation cannot be archived.');
    const index=await limited(join(r.admin,'index'),4*MAX);if(index.subarray(0,4).toString()!=='DIRC'||![2,3].includes(index.readUInt32BE(4)))throw new Error('Unsupported index version.');
    // Ordinary v2/v3 entries only. Optional cache-tree/end-offset extensions can be rebuilt;
    // unknown state-bearing extensions must not disappear when the registration is removed.
    let offset=12;const count=index.readUInt32BE(8);if(count>ARCHIVE_ENTRIES)throw new Error('Index exceeds 20,000 entries.');for(let i=0;i<count;i++){const start=offset;if(offset+62>index.length-20)throw new Error('Invalid index entry.');const flags=index.readUInt16BE(offset+60);if(flags&0xf000)throw new Error('Unsupported index flags or conflict stages.');offset+=62;const nul=index.indexOf(0,offset);if(nul<0)throw new Error('Invalid index path.');offset=start+Math.ceil((nul+1-start)/8)*8;}
    while(offset<index.length-20){if(offset+8>index.length-20)throw new Error('Invalid index extension.');const type=index.subarray(offset,offset+4).toString('ascii'),size=index.readUInt32BE(offset+4);if(!['TREE','EOIE','IEOT'].includes(type))throw new Error('Unsupported index extension '+type+'.');offset+=8+size;}if(offset!==index.length-20)throw new Error('Invalid index extension length.');
    const flags=(await this.run([...args,'ls-files','-v','-z'],{epoch})).stdout;if(flags.split('\0').some(x=>x&&x[0]!=='H'))throw new Error('Unsupported assume-unchanged or skip-worktree index flags.');
    if((await this.run([...args,'rev-parse','--shared-index-path'],{epoch})).stdout.trim()||(await this.run([...args,'ls-files','--resolve-undo','-z'],{epoch})).stdout)throw new Error('Unsupported split index or resolve-undo state.');
    const staged=(await this.run([...args,'ls-files','--stage','-z'],{epoch})).stdout;if(staged.split('\0').some(x=>x&&!/^(100644|100755|120000) [0-9a-f]{40} 0\t/.test(x)))throw new Error('Unsupported conflicted index or submodule.');
    const head=(await this.run([...args,'rev-parse','--verify','HEAD^{commit}'],{epoch})).stdout.trim();if(!OID.test(head))throw new Error('Archive requires a committed SHA-1 HEAD.');const headText=decode(await limited(join(r.admin,'HEAD'),8192)),headRef=headText.startsWith('ref: refs/heads/')?headText.slice(5,-1):null;
    if(headText!==(headRef?'ref: '+headRef+'\n':head+'\n'))throw new Error('Archive requires a canonical local-branch or detached HEAD.');
    if(headRef){await this.run([...args,'check-ref-format',text(headRef,8000,'archive branch ref')],{epoch});if((await this.run([...args,'symbolic-ref','--quiet',headRef],{epoch,allowOne:true})).code===0)throw new Error('Archive cannot preserve an indirect symbolic branch.');}
    const headRaw=sha(Buffer.from(headText)),files=await this.inventory(r.cwd),peers=await this.peerState(r,epoch);
    return {head,headRef,index,indexHash:sha(index),headRaw,config,sourceConfig,files,peers,fingerprint:sha(JSON.stringify([head,headRaw,sha(index),config,sourceConfig,files.hash,peers.hash]))};
  }
  async verifyRecovery(r,epoch,raw=true,metadataOnly=false){
    await this.sourceIdentity(r);const a=r.archive,p=this.recoveryPaths(r);await verify(p.parent,a.parent);await verify(p.directory,a.directory);if(await realpath(p.directory)!==p.directory)throw new Error('Recovery directory is not canonical.');
    // Listing describes stored state; restore review and execution always verify complete content.
    if(metadataOnly){for(const key of ['index','manifest','bundle']){await verify(p[key],a[key].identity,false);const s=await lstat(p[key]);if(s.nlink!==1||s.size!==a[key].bytes)throw new Error('Recovery '+key+' changed size or links.');}if(raw){await verify(p.raw,r.identities.cwd);if(await realpath(p.raw)!==p.raw)throw new Error('Captured directory is not canonical.');await verify(join(p.raw,'.git'),r.identities.gitfile,false);}this.assertEpoch(epoch);return;}
    for(const [key,limit] of [['index',4*MAX],['manifest',MANIFEST_BYTES],['bundle',BUNDLE_BYTES]]){const found=await artifactStamp(p[key],limit);if(JSON.stringify(found)!==JSON.stringify(a[key]))throw new Error('Recovery '+key+' changed or was replaced.');}
    const m=JSON.parse(decode(await limited(p.manifest,MANIFEST_BYTES)));shape(m,['version','head',...(m.version===2?['headRef']:[]),'indexCommit','snapshot','indexHash','gitLinkHash','files','filesHash','bytes']);if(![1,2].includes(m.version)||m.version===2&&m.headRef!==null&&(typeof m.headRef!=='string'||!m.headRef.startsWith('refs/heads/')||m.headRef.length>8000||/[\0\r\n]/.test(m.headRef))||m.head!==a.head||!OID.test(m.snapshot)||!OID.test(m.indexCommit)||!Array.isArray(m.files)||m.files.length>ARCHIVE_ENTRIES||m.indexHash!==a.index.hash)throw new Error('Invalid recovery manifest.');
    if(raw){await verify(p.raw,r.identities.cwd);if(await realpath(p.raw)!==p.raw)throw new Error('Captured directory is not canonical.');if((await this.inventory(p.raw)).hash!==m.filesHash)throw new Error('Captured files changed after archive.');await verify(join(p.raw,'.git'),r.identities.gitfile,false);if(sha(await limited(join(p.raw,'.git'),8192))!==m.gitLinkHash)throw new Error('Captured Git pointer changed.');}
    this.assertEpoch(epoch);return m;
  }
  async restoreBranch(r,manifest,epoch){
    if(manifest.version===1||manifest.headRef===null)return null;
    const ref=manifest.headRef,args=this.scoped(r.source,r.gitDir),branch=ref.slice(11);
    await this.run([...args,'check-ref-format',ref],{epoch});
    if((await this.run([...args,'symbolic-ref','--quiet',ref],{epoch,allowOne:true})).code===0)throw new Error('Archived branch became an indirect symbolic ref; restore refused.');
    const current=(await this.run([...args,'rev-parse','--verify','--end-of-options',ref+'^{commit}'],{epoch})).stdout.trim();
    if(current!==manifest.head)throw new Error('Archived branch moved; restore refused without changing its tip.');
    const peers=await this.peerState(r,epoch);
    if(peers.records.some(peer=>peer.path!==r.cwd&&peer.registration.split('\0').includes('branch '+ref)))throw new Error('Archived branch is checked out in another worktree; restore refused.');
    return branch;
  }
  async prepareLifecycle(id,operation,epoch){
    await this.expirePlans();const r=this.records.find(r=>r.id===id);if(!r||r.state!==(operation==='archive'?'ready':'archived'))throw new Error('Worktree is not available for '+operation+'.');await this.assertNoHandoff([r.source,r.cwd]);let lease,state;
    try{lease=await this.reserveMutation(async()=>{await this.sourceIdentity(r);return (await this.peerState(r,epoch)).paths;},{kind:operation==='archive'?'archiveWorktree':'restoreWorktree',target:()=>r.source});this.assertEpoch(epoch);
      if(operation==='archive')state=await this.archiveState(r,epoch);else{if(await optional(r.cwd)||await optional(r.admin))throw new Error('Original restore path or registration is occupied.');const manifest=await this.verifyRecovery(r,epoch),peers=await this.peerState(r,epoch),config=await this.lifecycleConfig(r,epoch,r.source,r.gitDir);await this.restoreBranch(r,manifest,epoch);state={head:manifest.head,files:{files:manifest.files.length,bytes:manifest.bytes},manifest,peers,config};}
      const plan={id:randomUUID(),operation,worktreeId:r.id,cwd:r.cwd,source:r.source,commonDir:r.commonDir,commit:state.head,files:state.files.files,bytes:state.files.bytes,expiresAt:this.now()+120000,lease,state};this.plans.set(plan.id,plan);plan.timer=setTimeout(()=>{if(this.plans.get(plan.id)===plan)void this.releasePlan(plan).catch(()=>{});},120000);plan.timer.unref?.();return {plan:{...Object.fromEntries(['id','operation','worktreeId','cwd','source','commonDir','commit','files','bytes','expiresAt'].map(k=>[k,plan[k]])),...(operation==='restore'?{headRef:state.manifest.headRef??null,warning:state.manifest.version===1?'Legacy archive did not record branch attachment; it will restore detached.':null}:{})}};
    }catch(e){if(lease){if(this.blocked)this.retainedLeases.add(lease);else await lease.release();}throw e;}
  }
  async recoveryPhase(r,phase,epoch){this.assertEpoch(epoch);r.archive.phase=phase;await this.save();this.assertEpoch(epoch);}
  async buildRecovery(r,state,epoch){
    const p=this.recoveryPaths(r);await mkdir(p.parent,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const ps=await lstat(p.parent);if(!ps.isDirectory()||ps.isSymbolicLink()||ps.uid!==process.getuid()||(ps.mode&0o077))throw new Error('Recovery root must be a private owned directory.');r.archive.parent=await identity(p.parent);await mkdir(p.directory,{mode:0o700});r.archive.directory=await identity(p.directory);await syncDirectory(p.parent);await this.recoveryPhase(r,'building',epoch);
    const env={GIT_ALTERNATE_OBJECT_DIRECTORIES:quote(join(r.commonDir,'objects')),GIT_AUTHOR_NAME:'Saleh recovery snapshot',GIT_AUTHOR_EMAIL:'recovery@localhost',GIT_COMMITTER_NAME:'Saleh recovery snapshot',GIT_COMMITTER_EMAIL:'recovery@localhost'},run=(dir,args,options={})=>this.run(['--git-dir='+dir,...args],{epoch,...options});
    await this.run(['init','--bare',p.git],{epoch,scope:{dirs:[p.git]}});await writeFile(p.index,state.index,{flag:'wx',mode:0o600,flush:true});await writeFile(join(p.git,'index'),state.index,{flag:'wx',mode:0o600});
    const indexTree=(await run(p.git,['write-tree'],{scope:{dirs:[p.git]},env})).stdout.trim(),indexCommit=(await run(p.git,['commit-tree',indexTree,'-p',state.head,'-m','Private index recovery'],{scope:{dirs:[p.git]},env})).stdout.trim();
    const files=await this.inventory(r.cwd,true);if(files.hash!==state.files.hash)throw new Error('Working files changed while preparing recovery.');const chunks=[Buffer.from(`feature done\ncommit refs/saleh/recovery\ncommitter Saleh recovery snapshot <recovery@localhost> ${Math.floor(this.now()/1000)} +0000\ndata 16\nPrivate recovery\nfrom ${state.head}\nmerge ${indexCommit}\ndeleteall\n`)];
    for(const row of files.entries)if(row.data)chunks.push(Buffer.from(`M ${row.type==='symlink'?'120000':row.mode&0o100?'100755':'100644'} inline ${quote(row.path)}\ndata ${row.data.length}\n`),row.data,Buffer.from('\n'));chunks.push(Buffer.from('\ndone\n'));
    await run(p.git,['fast-import','--quiet','--done'],{scope:{dirs:[p.git]},env,input:Buffer.concat(chunks)});const snapshot=(await run(p.git,['rev-parse','refs/saleh/recovery'],{env})).stdout.trim();if(!OID.test(snapshot)||!OID.test(indexCommit))throw new Error('Invalid recovery object identity.');
    await run(p.git,['bundle','create',p.bundle,'refs/saleh/recovery'],{scope:{dirs:[p.directory]},env});r.archive.bundle=await artifactStamp(p.bundle,BUNDLE_BYTES);const bf=await open(p.bundle,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{await bf.sync();}finally{await bf.close();}
    await this.run(['init','--bare',p.verified],{epoch,scope:{dirs:[p.verified]}});await run(p.verified,['bundle','verify',p.bundle]);await run(p.verified,['bundle','unbundle',p.bundle],{scope:{dirs:[p.verified]}});await run(p.verified,['fsck','--full','--no-reflogs',snapshot]);
    const tree=(await run(p.verified,['ls-tree','-r','-z',snapshot],{maxOutputBytes:40*MAX})).stdout.split('\0').filter(Boolean),expected=new Map(files.summary.filter(x=>x.type!=='directory').map(x=>[x.path,x]));if(tree.length!==expected.size)throw new Error('Recovery tree differs from captured files.');let batch=[],size=0;
    const verifyBatch=async()=>{if(!batch.length)return;const result=await run(p.verified,['cat-file','--batch'],{input:batch.map(x=>x.oid).join('\n')+'\n',raw:true,maxOutputBytes:40*MAX});let offset=0;for(const row of batch){const end=result.stdout.indexOf(10,offset),header=result.stdout.subarray(offset,end).toString('ascii');if(header!==`${row.oid} blob ${row.file.bytes}`)throw new Error('Recovery blob header differs.');offset=end+1;if(sha(result.stdout.subarray(offset,offset+row.file.bytes))!==row.file.hash)throw new Error('Recovery blob bytes differ.');offset+=row.file.bytes;if(result.stdout[offset++]!==10)throw new Error('Invalid recovery blob boundary.');}if(offset!==result.stdout.length)throw new Error('Unexpected recovery output.');batch=[];size=0;};
    for(const entry of tree){const match=/^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry),file=match&&expected.get(match[3]);if(!file||match[1]!== (file.type==='symlink'?'120000':file.mode&0o100?'100755':'100644'))throw new Error('Recovery tree path or mode differs.');if(size+file.bytes+64>36*MAX)await verifyBatch();batch.push({oid:match[2],file});size+=file.bytes+64;}await verifyBatch();
    const manifest={version:2,head:state.head,headRef:state.headRef,indexCommit,snapshot,indexHash:state.indexHash,gitLinkHash:sha(await limited(join(r.cwd,'.git'),8192)),files:files.summary,filesHash:files.hash,bytes:files.bytes};const body=JSON.stringify(manifest);if(Buffer.byteLength(body)>MANIFEST_BYTES)throw new Error('Recovery manifest exceeds 8 MiB.');await writeFile(p.manifest,body,{flag:'wx',mode:0o600,flush:true});r.archive.manifest=await artifactStamp(p.manifest,MANIFEST_BYTES);r.archive.index=await artifactStamp(p.index,4*MAX);await syncDirectory(p.directory);await this.recoveryPhase(r,'verified',epoch);return manifest;
  }
  async lifecycle(planId,operation,epoch){
    const p=this.plans.get(planId);this.plans.delete(planId);if(!p)throw new Error('Worktree plan expired, consumed, or unknown.');clearTimeout(p.timer);let r,started=false;
    try{if(p.operation!==operation||p.expiresAt<=this.now())throw new Error('Worktree plan expired or operation does not match.');r=this.records.find(r=>r.id===p.worktreeId);if(!r||r.state!==(operation==='archive'?'ready':'archived'))throw new Error('Worktree state changed after review.');await this.sourceIdentity(r);
      if(operation==='archive'){
        const state=await this.archiveState(r,epoch);if(state.fingerprint!==p.state.fingerprint)throw new Error('Worktree changed after review; prepare again.');await p.lease.revalidateScope?.();this.assertEpoch(epoch);r.archive={id:randomUUID(),head:state.head,phase:'intent'};Object.assign(r,{state:'archiving',message:'Preparing verified recovery.'});started=true;await this.save();this.assertEpoch(epoch);const manifest=await this.buildRecovery(r,state,epoch);
        if((await this.archiveState(r,epoch)).fingerprint!==state.fingerprint)throw new Error('Worktree changed before capture.');await this.verifyRecovery(r,epoch,false);const paths=this.recoveryPaths(r);if(await optional(paths.raw))throw new Error('Recovery destination already exists.');await this.recoveryPhase(r,'capturing',epoch);await this.verifyRecord(r);this.assertEpoch(epoch);
        // ponytail: Same-host cooperative-writer ceiling: rename retains original inodes; it cannot revoke external open descriptors.
        await rename(r.cwd,paths.raw);await syncDirectory(this.root);await syncDirectory(paths.directory);await this.verifyRecovery(r,epoch);await this.recoveryPhase(r,'unregistering',epoch);
        await this.sourceIdentity(r);await verify(r.admin,r.identities.admin);if(sha(await limited(join(r.admin,'index'),4*MAX))!==state.indexHash||sha(await limited(join(r.admin,'HEAD'),8192))!==state.headRaw)throw new Error('Git state changed after capture; preserved.');if(await optional(r.cwd))throw new Error('Original path was replaced after capture; preserved.');await this.run([...this.scoped(r.source,r.gitDir),'worktree','remove','--force','--force',r.cwd],{epoch,scope:{dirs:[r.admin]}});
        if(await optional(r.cwd)||await optional(r.admin))throw new Error('Archive removal postcondition was not confirmed.');await this.verifyRecovery(r,epoch);await this.peerState(r,epoch);this.assertEpoch(epoch);Object.assign(r,{state:'archived',archivedAt:this.now(),head:manifest.head,message:'Archived. Restore the original checkout to continue.'});r.archive.phase='archived';await this.save();this.assertEpoch(epoch);
      }else{
        if(await optional(r.cwd)||await optional(r.admin))throw new Error('Original restore path or registration is occupied.');const manifest=await this.verifyRecovery(r,epoch);if((await this.peerState(r,epoch)).hash!==p.state.peers.hash||await this.lifecycleConfig(r,epoch,r.source,r.gitDir)!==p.state.config)throw new Error('Repository changed after restore review.');await this.restoreBranch(r,manifest,epoch);await p.lease.revalidateScope?.();this.assertEpoch(epoch);const paths=this.recoveryPaths(r);Object.assign(r,{state:'restoring',message:'Restoring original checkout.'});started=true;await this.recoveryPhase(r,'importing',epoch);
        await this.run([...this.scoped(r.source,r.gitDir),'bundle','unbundle',paths.bundle],{epoch,scope:{dirs:[join(r.commonDir,'objects')]}});await this.verifyRecovery(r,epoch);if(await optional(r.cwd)||await optional(r.admin))throw new Error('Restore destination became occupied.');await this.recoveryPhase(r,'registering',epoch);
        const branch=await this.restoreBranch(r,manifest,epoch);
        // Register by exact commit, then attach the validated full ref literally. Git's
        // worktree-add DWIM detaches valid leading-hyphen branch names even after --.
        await this.run([...this.scoped(r.source,r.gitDir),'worktree','add','--detach','--lock','--reason','Saleh restored worktree '+r.id,'--no-guess-remote','--no-relative-paths','--no-checkout','--',r.cwd,manifest.head],{record:r,epoch});
        const placeholder=await identity(r.cwd),priorAdmin=r.identities.admin,newAdmin=await identity(r.admin),newLink=await identity(join(r.cwd,'.git'),false),validation={...r,identities:{...r.identities,cwd:placeholder,admin:newAdmin,gitfile:newLink}};await this.verifyRecord(validation);if(branch){await this.restoreBranch(r,manifest,epoch);await this.run([...this.scoped(r.cwd,r.admin),'symbolic-ref','HEAD',manifest.headRef],{record:r,epoch});}if(JSON.stringify(await readdir(r.cwd))!==JSON.stringify(['.git'])||await optional(join(r.admin,'index')))throw new Error('Restore placeholder contains unexpected data.');await this.verifyRecovery(r,epoch);await this.recoveryPhase(r,'returning',epoch);await this.verifyRecord(validation);this.assertEpoch(epoch);
        await rename(join(r.cwd,'.git'),join(paths.raw,'.git'));await syncDirectory(paths.raw);await verify(r.cwd,placeholder);await rmdir(r.cwd);this.assertEpoch(epoch);await verify(paths.raw,r.identities.cwd);if(await optional(r.cwd))throw new Error('Original path became occupied before return.');await rename(paths.raw,r.cwd);await syncDirectory(this.root);await syncDirectory(paths.directory);await verify(r.cwd,r.identities.cwd);await verify(r.admin,newAdmin);this.assertEpoch(epoch);
        await writeFile(join(r.admin,'index'),await limited(paths.index,4*MAX),{flag:'wx',mode:0o600,flush:true});await syncDirectory(r.admin);r.identities.admin=newAdmin;r.identities.gitfile=newLink;await this.verifyRecord(r);if((await this.inventory(r.cwd)).hash!==manifest.filesHash||sha(await limited(join(r.admin,'index'),4*MAX))!==manifest.indexHash||(await this.run([...this.scoped(r.cwd,r.admin),'rev-parse','HEAD'],{epoch})).stdout.trim()!==manifest.head||decode(await limited(join(r.admin,'HEAD'),8192))!==(manifest.headRef?'ref: '+manifest.headRef+'\n':manifest.head+'\n'))throw new Error('Restored content or HEAD differs from recovery.');await this.restoreBranch(r,manifest,epoch);await this.sourceIdentity(r);this.assertEpoch(epoch);Object.assign(r,{state:'ready',head:manifest.head,message:manifest.version===1?'Legacy worktree restored detached; original branch attachment was not recorded.':'Original worktree restored.',dirty:true});r.archive.phase='restored';
        for(const dependent of this.records)if(dependent.source===r.cwd&&same(dependent.identities.source,r.identities.cwd)&&dependent.commonDir===r.commonDir&&same(dependent.identities.common,r.identities.common)&&dependent.gitDir===r.admin&&same(dependent.identities.sourceGit,priorAdmin))dependent.identities.sourceGit=newAdmin;
        await this.save();this.assertEpoch(epoch);
      }
      return {worktree:publicRecord(r)};
    }catch(e){if(!started)throw e;Object.assign(r,{state:'needs-inspection',message:String(e.message).slice(0,1600)});await this.save();return {worktree:publicRecord(r)};}finally{await this.releasePlan(p);}
  }
  async verifyRecord(r){
    await verify(this.root,this.rootIdentity);await verify(r.commonDir,r.identities.common);await verify(r.cwd,r.identities.cwd);await verify(r.admin,r.identities.admin);await verify(join(r.cwd,'.git'),r.identities.gitfile,false);
    if(await realpath(r.cwd)!==r.cwd||await realpath(r.admin)!==r.admin)throw new Error('Managed worktree or registration was replaced by a symbolic path.');
    const gitfile=pathLine(new TextDecoder('utf-8',{fatal:true}).decode(await limited(join(r.cwd,'.git'),8192)));if(gitfile!=='gitdir: '+r.admin)throw new Error('Managed worktree Git link changed.');
    const back=pathLine(new TextDecoder('utf-8',{fatal:true}).decode(await limited(join(r.admin,'gitdir'),8192)));if(back!==join(r.cwd,'.git'))throw new Error('Managed worktree reverse Git link changed.');
    const common=pathLine(new TextDecoder('utf-8',{fatal:true}).decode(await limited(join(r.admin,'commondir'),8192)));if(await realpath(resolve(r.admin,common))!==r.commonDir)throw new Error('Managed worktree common Git directory changed.');
    if(!(await optional(join(r.admin,'locked')))?.isFile())throw new Error('Managed worktree registration is no longer locked.');
  }
  async reconcile(r,epoch){
    const h=this.pendingHandoff(r.cwd)??this.pendingHandoff(r.source);if(h)return {...r,state:'needs-inspection',message:this.handoffError(h).message};
    if(['creating','archiving','restoring'].includes(r.state))return {...r,state:'needs-inspection',message:'Worktree operation was interrupted; recovery retained for inspection.'};
    if(r.state==='archived'){try{if(await optional(r.cwd)||await optional(r.admin))throw new Error('Archived original path or registration is occupied.');await this.verifyRecovery(r,epoch,true,true);return r;}catch(e){if(epoch!==this.epoch||this.closed)throw e;return {...r,state:'needs-inspection',message:String(e.message).slice(0,1600)};}}
    if(r.state!=='ready')return r;
    try{await this.verifyRecord(r);const head=(await this.run([...this.scoped(r.cwd,r.admin),'rev-parse','--verify','HEAD'],{epoch})).stdout.trim();if(!OID.test(head))throw new Error('Managed worktree HEAD is invalid.');await this.inspect(r.cwd,r.admin,head,epoch);const dirty=Boolean((await this.run([...this.scoped(r.cwd,r.admin),'status','--porcelain=v1','-z','--untracked-files=normal'],{epoch})).stdout);return {...r,head,dirty};}
    catch(e){if(epoch!==this.epoch||this.closed)throw e;return {...r,state:e.code==='ENOENT'?'missing':'needs-inspection',message:String(e.message).slice(0,1600)};}
  }
  async projectPath(cwd){
    const canonical=await realpath(cwd),data=fold(dirname(this.root)),worktrees=fold(this.root);
    for(const path of [resolve(cwd),canonical].map(fold))if(inside(path,data)||inside(data,path)&&!inside(worktrees,path))throw new Error('Protected app data cannot be a coding project.');
    return canonical;
  }
  async assertOwned(cwd,epoch){
    // Ordinary projects require no Git inspection; both lexical and canonical managed aliases are checked.
    await this.assertNoHandoff([cwd]);this.assertEpoch(epoch);const canonical=await this.projectPath(cwd);if(!inside(this.root,cwd)&&!inside(this.root,canonical))return;
    const r=this.records.find(r=>inside(r.cwd,cwd)||inside(r.cwd,canonical));if(!r)throw new Error('Unknown managed worktree path cannot execute.');
    const current=await this.reconcile(r,epoch);if(current.state!=='ready')throw new Error(current.message);if(!inside(r.cwd,canonical))throw new Error('Managed project path escapes its owned checkout.');
  }
  async assertLegacyOrdinaryProject(cwd,epoch,error){
    const check=task=>{
      this.assertEpoch(epoch);
      if(this.loaded||this.operation!==task||this.stopping||this.plans.size||this.retainedLeases.size||this.commandReservation||this.activeHandoff||this.handoffAdmission||this.handoffs.length||this.records.length)throw error;
    };
    check(null);
    // Reserve the existing operation slot so Stop/close drain this inspection.
    const task=this.withLedger(async()=>{
      check(task);const snapshot=error[ROOT_DEVICE_CHANGED],saved=await readHandoffJSON(this.ledger,snapshot.receipt.stamp,MAX);
      if(!sameNamespace(saved.stat,snapshot.receipt.stat)||!saved.bytes.equals(snapshot.receipt.bytes))throw error;
      const data=saved.value;this.validateLedger(data);shape(data,['version','root','records']);shape(data.root,['dev','ino']);
      if(data.version!==1||data.records.some(r=>r.state!=='ready'||['source','common','sourceGit','cwd','admin','gitfile'].some(key=>!validIdentity(r.identities[key]))))throw error;
      // A completed restore no longer uses its derived snapshot.git/verified.git
      // scratch. Keep its original recovery artifacts protected; never rebind the ledger.
      const artifacts=[['index',4*MAX],['manifest',MANIFEST_BYTES],['bundle',BUNDLE_BYTES]],recovery=[];
      for(const r of data.records)if(Object.hasOwn(r,'archive')){
        const a=r.archive;if(a?.phase!=='restored'||['parent','directory'].some(key=>!validIdentity(a[key]))||artifacts.some(([key,limit])=>!validIdentity(a[key]?.identity)||!/^[a-f0-9]{64}$/.test(a[key]?.hash)||!Number.isSafeInteger(a[key]?.bytes)||a[key].bytes<0||a[key].bytes>limit))throw error;
      }
      const controls=async()=>{for(const prior of [...snapshot.directories,...recovery]){const current=await privateDirectory(prior.path);if(!sameNamespace(prior.stat,current.stat))throw error;}await verify(this.root,this.rootIdentity);};
      await controls();check(task);
      const exclusions=new Set([this.dataDir,this.root]),inodes=new Set([data.root.ino]),observed=new Map();
      for(const r of data.records){
        for(const key of ['source','cwd','gitDir','commonDir','admin'])exclusions.add(r[key]);
        for(const id of Object.values(r.identities))if(validIdentity(id))inodes.add(id.ino);
        if(r.archive){for(const path of Object.values(this.recoveryPaths(r)))exclusions.add(path);for(const key of ['parent','directory'])inodes.add(r.archive[key].ino);for(const [key] of artifacts)inodes.add(r.archive[key].identity.ino);}
      }
      const observe=async path=>{
        if(observed.has(path))return observed.get(path);
        let stat;try{stat=await lstat(path,{bigint:true});}catch(e){if(e.code!=='ENOENT')throw e;observed.set(path,null);return null;}
        const entry={stat,canonical:await realpath(path)};observed.set(path,entry);return entry;
      };
      for(const path of [...exclusions]){if(resolve(path)!==path)throw error;const entry=await observe(path);if(entry)exclusions.add(entry.canonical);}
      for(const r of data.records)if(r.archive){
        const paths=this.recoveryPaths(r),a=r.archive;
        for(const key of ['parent','directory']){const prior=await privateDirectory(paths[key]);if(String(prior.stat.ino)!==a[key].ino)throw error;recovery.push(prior);}
        for(const [key,limit] of artifacts){
          const entry=await observe(paths[key]),s=entry?.stat,expected=a[key];
          if(!s?.isFile()||s.isSymbolicLink()||entry.canonical!==paths[key]||s.uid!==BigInt(process.getuid())||(s.mode&0o022n)||s.nlink!==1n||String(s.ino)!==expected.identity.ino||s.size!==BigInt(expected.bytes))throw error;
          const found=await artifactStamp(paths[key],limit);
          if(found.identity.dev!==String(s.dev)||found.identity.ino!==String(s.ino)||found.hash!==expected.hash||found.bytes!==expected.bytes||!sameNamespace(s,await lstat(paths[key],{bigint:true})))throw error;check(task);
        }
      }
      const inspect=async path=>{
        const canonical=await realpath(path);for(const name of [resolve(path),canonical])if([...exclusions].some(owned=>overlaps(name,owned)))throw error;
        for(let parent=canonical;;parent=dirname(parent)){
          const entry=await observe(parent);if(!entry||!entry.stat.isDirectory()||entry.stat.isSymbolicLink())throw error;
          // Old device numbers cannot prove continuity. Inode-only matching can
          // only DENY admission of a renamed retained directory, never grant it.
          if(inodes.has(String(entry.stat.ino)))throw error;
          if(dirname(parent)===parent)break;
        }
      };
      await this.projectPath(cwd);await inspect(cwd);let metadataCheck;
      const metadata=await this.handoffRepository(cwd,epoch,false,recheck=>{metadataCheck=recheck;});
      for(const entry of metadata)await inspect(entry.path);
      for(const [path,prior] of observed){
        if(!prior){if(await optional(path))throw error;continue;}
        const current=await lstat(path,{bigint:true}),keys=prior.stat.isDirectory()?['dev','ino','mode','uid','gid']:['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'];
        if(!keys.every(key=>current[key]===prior.stat[key])||await realpath(path)!==prior.canonical)throw error;
      }
      const final=await readHandoffJSON(this.ledger,snapshot.receipt.stamp,MAX);
      if(!sameNamespace(final.stat,snapshot.receipt.stat)||!final.bytes.equals(snapshot.receipt.bytes))throw error;
      await controls();await metadataCheck();check(task);
    });
    this.operation=task;this.admissionOperation=task;try{return await task;}finally{if(this.operation===task)this.operation=null;if(this.admissionOperation===task)this.admissionOperation=null;}
  }
  async assertProject(cwd,authority=null){
    if(this.recoveryCopyOperation)throw Error('A recovery copy is being verified. Wait or Stop before admitting a project.');
    const epoch=this.epoch;this.assertOpenEpoch(epoch);text(cwd,4096,'project directory');if(!isAbsolute(cwd))throw new Error('Project directory must be absolute.');
    // Mutation-scope inspection may re-enter admission while reconnect owns the ledger queue.
    if(this.reconnectController)throw Error('Worktree reconnect is active; stop it before admitting a project.');
    try{await this.load();}catch(error){if(authority===null&&error[ROOT_DEVICE_CHANGED])return this.assertLegacyOrdinaryProject(cwd,epoch,error);if(authority===null&&error[HANDOFF_ROOT_DEVICE_CHANGED]&&this.legacyAdmission){this.assertOpenEpoch(epoch);await this.inspectUnconfinedAccess(cwd);this.assertOpenEpoch(epoch);return;}throw error;}this.assertOpenEpoch(epoch);
    if(authority!==null){
      const active=this.activeHandoff;this.assertHandoffActive(active,epoch);const p=active.plan;
      if(authority!==active.fence||active.familyReturned||active.recoveryReview||cwd!==(active.target??p.destination))throw new Error('Project handoff authority does not match the active destination.');
      this.coding.checkHandoffAuthority(cwd,authority,{snapshot:p.family,lease:p.lease});await this.assertNoHandoff([cwd],active.record);await this.projectPath(cwd);
      const repository=active.attempt?p.repositories[cwd===p.source?'source':'destination']:p.states.destination.r;
      await this.sourceIdentity(p.record,active.record);await this.verifyRecord(p.record);await this.handoffInspector.verifyRepository(repository);this.assertHandoffActive(active,epoch);return;
    }
    await this.assertNoHandoff([cwd],null,true);await this.assertHandoffRepository(cwd,epoch);const canonical=await this.projectPath(cwd);this.assertOpenEpoch(epoch);if(!inside(this.root,cwd)&&!inside(this.root,canonical))return;
    return this.exclusive(epoch=>this.assertOwned(cwd,epoch),true);
  }
  recoveryCopy(input){
    if(this.closed||this.stopping||this.operation||this.recoveryCopyOperation||this.unconfinedInspection||this.activeHandoff||this.handoffAdmission||this.commandReservation||this.retainedLeases.size||this.blocked||[...this.plans.values()].some(p=>p.operation!=='handoff-copy'))throw Error('Another worktree operation is busy; recovery copy was not dispatched.');
    const epoch=this.epoch;let controller=new AbortController();this.recoveryCopyController=controller;
    const check=()=>{controller.signal.throwIfAborted();this.assertEpoch(epoch);};
    const task=Promise.resolve().then(async()=>{
      if(input.action==='createRecoveryCopy'){
        const p=this.plans.get(input.planId);if(!p||p.operation!=='handoff-copy'||p.epoch!==epoch||p.expiresAt<=this.now())throw Error('Recovery copy review expired, consumed or unknown.');
        this.plans.delete(p.id);clearTimeout(p.timer);controller=p.controller;this.recoveryCopyController=controller;
        try{check();return await createOriginalCopy(p.copy);}catch(error){throw Error(error.message+' New output retained for inspection: '+p.copy.entry,{cause:error});}
      }
      await this.expirePlans();check();if(this.plans.size>=32)throw Error('Recovery copy review limit reached.');
      let view;try{await this.load();}catch(error){if(!error[HANDOFF_ROOT_DEVICE_CHANGED]||!this.legacyAdmission)throw error;view=await this.#unconfinedView(controller.signal,epoch);}check();
      const review=await this.readHandoffRecovery(input.id,epoch,view);check();
      const recheck=async()=>{check();await(view?view.checkLedger():this.checkLedger());if((await this.readHandoffRecovery(input.id,epoch,view)).fingerprint!==review.fingerprint)throw Error('Recorded recovery copy evidence changed.');check();};
      const currentRoot=async root=>{check();if(view)return view.currentReadRoot(root);await verify(root.path,root);return structuredClone(root);};
      const readBundle=()=>readCopyBundle(review.manifest.candidate.artifacts.bundle,review.manifest.candidate.recovery.bundle,{volumeUUID:view?.currentVolumeUUID,readIdentity:async path=>(await this.readIdentities({paths:[path],nativeHelper:this.nativeHelper,signal:controller.signal}))[0],check});
      const copy=await prepareOriginalCopy({review,parent:join(dirname(this.dataDir),'Recovered Projects'),currentRoot,readBundle,native:(action,value)=>this.handoffFiles(action,value,epoch),runGit:(args,options)=>this.runner.run(args,{...options,check}),check,recheck,now:this.now});
      const p={id:copy.id,operation:'handoff-copy',epoch,controller,expiresAt:copy.publicPlan.expiresAt,copy};this.plans.set(p.id,p);p.timer=setTimeout(()=>{if(this.plans.get(p.id)===p)void this.releasePlan(p).catch(()=>{});},Math.max(1,p.expiresAt-this.now()));p.timer.unref?.();return {plan:copy.publicPlan};
    });this.recoveryCopyOperation=task;
    return task.finally(()=>{if(this.recoveryCopyOperation===task){this.recoveryCopyOperation=null;this.recoveryCopyController=null;}});
  }
  async handle(input){
    const fields={list:['action'],prepareRecoveryCopy:['action','id'],createRecoveryCopy:['action','planId'],prepareReconnect:['action'],commitReconnect:['action','planId'],prepare:['action','cwd','ref',...(Object.hasOwn(input??{},'copyChanges')?['copyChanges']:[])],create:['action','planId'],resolve:['action','id'],prepareArchive:['action','id'],archive:['action','planId'],prepareRestore:['action','id'],restore:['action','planId'],prepareHandoff:['action','id','threadId'],handoff:['action','planId'],prepareHandoffRecovery:['action','id','mode'],recoverHandoff:['action','planId'],stop:['action']};shape(input,fields[input?.action]??[]);if(!fields[input.action])throw new Error('Unknown worktree action.');
    if(input.action==='stop')return this.stop();
    if(this.recoveryCopyOperation)throw Error('Recovery copy is busy. Wait or Stop before another worktree action.');
    if(['prepareRecoveryCopy','createRecoveryCopy'].includes(input.action)){identifier(input[input.action==='prepareRecoveryCopy'?'id':'planId']);return this.recoveryCopy(input);}
    if(this.managedMutationBlocked&&!['list','stop','resolve'].includes(input.action)&&!this.allowsCreationMutation(input))throw Error('Retained worktree operations are unavailable for this Full Access boot. Verified ready checkouts can open a new chat and fresh detached checkouts can be created; saved worktrees and recovery evidence remain available for inspection.');
    if(input.action==='commitReconnect')identifier(input.planId);if(['prepareReconnect','commitReconnect'].includes(input.action))return this.reconnect(input.action,input.planId);
    if(input.action==='stop')return this.stop();if(['create','archive','restore','handoff','recoverHandoff'].includes(input.action))identifier(input.planId);if(['resolve','prepareArchive','prepareRestore','prepareHandoff','prepareHandoffRecovery'].includes(input.action))identifier(input.id);
    if(input.action==='prepareHandoff'&&(typeof input.threadId!=='string'||! /^[\w.-]{1,160}$/.test(input.threadId)))throw new Error('Invalid handoff root chat identifier.');
    if(input.action==='prepareHandoffRecovery'&&!['restore','finish'].includes(input.mode))throw new Error('Invalid handoff recovery mode.');
    if(['prepareHandoff','handoff','prepareHandoffRecovery','recoverHandoff'].includes(input.action)&&this.commandReservation)throw new Error('Stop the generic command and confirm its exit before a handoff.');
    if(input.action==='list'){
      try{await this.load();}catch(error){
        // Historical evidence is never installed as mutable manager state.
        if(error[HANDOFF_ROOT_DEVICE_CHANGED]&&this.legacyAdmission)return {...await this.inspectUnconfinedAccess(undefined,true),createAvailable:false};
        if(error[ROOT_DEVICE_CHANGED]){
          const saved=error[ROOT_DEVICE_CHANGED].receipt.value,reconnectAvailable=!this.managedMutationBlocked&&saved.records.length>0&&saved.records.every(r=>r.state==='ready');
          return {worktrees:[],handoffs:[],busy:false,readOnly:true,createAvailable:false,reconnectAvailable,reason:reconnectAvailable?'Retained legacy worktrees require reconnect review before use.':this.managedMutationBlocked?'Managed worktree changes are unavailable for this Full Access boot. The saved ledger is preserved.':'Retained worktree state requires inspection; the saved ledger is preserved.'};
        }
        throw error;
      }
      if(this.operation||this.managedMutationBlocked)return {worktrees:this.records.map(r=>{const h=this.pendingHandoff(r.cwd)??this.pendingHandoff(r.source);return publicRecord(h?{...r,state:'needs-inspection',message:this.handoffError(h).message}:r);}),handoffs:this.handoffRecords(),busy:!!this.operation,readOnly:this.managedMutationBlocked,openAvailable:!this.operation&&!this.blocked,createAvailable:!this.operation&&!this.blocked&&!this.plans.size&&!this.retainedLeases.size,reconnectAvailable:false,recoveryCopyAvailable:!this.operation&&!this.blocked,...(this.managedMutationBlocked?{reason:'Verified ready checkouts can open a new chat and fresh detached checkouts can be created. Archive, restore and handoff remain restricted for this Full Access boot; saved recovery evidence is kept.'}:{})};
    }
    return this.exclusive(async epoch=>{
      if(input.action==='prepare')return this.prepare(input.cwd,input.ref,epoch,input.copyChanges);
      if(input.action==='create')return this.create(input.planId,epoch);
      if(input.action==='prepareHandoff')return this.prepareHandoff(input.id,input.threadId,epoch);
      if(input.action==='handoff')return this.executeHandoff(input.planId,epoch);
      if(input.action==='prepareHandoffRecovery')return this.prepareHandoffRecovery(input.id,input.mode,epoch);
      if(input.action==='recoverHandoff')return this.executeHandoffRecovery(input.planId,epoch);
      if(['prepareArchive','prepareRestore'].includes(input.action))return this.prepareLifecycle(input.id,input.action==='prepareArchive'?'archive':'restore',epoch);
      if(['archive','restore'].includes(input.action))return this.lifecycle(input.planId,input.action,epoch);
      if(input.action==='resolve'){const r=this.records.find(r=>r.id===input.id);if(!r)throw new Error('Unknown managed worktree.');await this.assertNoHandoff([r.source,r.cwd]);const current=await this.reconcile(r,epoch);if(current.state!=='ready')throw new Error(current.message);return {worktree:publicRecord(current)};}
      const worktrees=[];for(const r of this.records)worktrees.push(publicRecord(await this.reconcile(r,epoch)));return {worktrees,handoffs:this.handoffRecords(),busy:false,readOnly:false,createAvailable:!this.blocked&&!this.plans.size&&!this.retainedLeases.size,reconnectAvailable:false,recoveryCopyAvailable:!this.blocked};
    });
  }
  cancelPageActions(){
    // Accepted backend work owns its read-only admission; departure revokes page actions.
    if(this.closed||this.stopping||this.recoveryCopyOperation||this.operation&&this.operation!==this.admissionOperation||this.activeHandoff||this.handoffAdmission||this.reconnectController||this.plans.size||this.retainedLeases.size||this.commandReservation)return this.stop();
    return Promise.resolve({stopped:!this.blocked,busy:false,...(this.blocked?{message:'Process exit was not confirmed; retained worktrees require inspection.'}:{})});
  }
  stop(){
    if(this.stopping)return this.stopping;
    this.epoch++;this.unconfinedController?.abort();this.reconnectController?.abort();this.recoveryCopyController?.abort();this.runner.cancel();this.nativeChild?.cancel();this.handoffInspector?.runner.cancel();const active=this.activeHandoff,task=this.operation,inspection=this.unconfinedInspection,copy=this.recoveryCopyOperation;
    const selected=active?.fence&&!active.completed&&!active.familyReturned&&!active.noFamilyEffects?this.coding.stopHandoff(active.fence,{snapshot:active.plan.family,lease:active.plan.lease}).then(()=>{this.handoffEngineBlocked=false;},error=>{this.handoffEngineBlocked=true;active.record.state='needs-inspection';active.record.message=String(error.message).slice(0,1600);}):Promise.resolve();
    const stopping=(async()=>{
      await Promise.all([selected,task?.catch(()=>{}),inspection?.catch(()=>{}),copy?.catch(()=>{})]);if(active?.fence?.exitUnconfirmed)this.handoffEngineBlocked=true;
      for(const plan of [...this.plans.values()])await this.releasePlan(plan);
      if(active&&this.activeHandoff===active){try{await this.save();}catch{}if(this.activeHandoff===active){await this.releasePlan(active.plan);if(!this.blocked)this.activeHandoff=null;}}
      return {stopped:!this.blocked,busy:false,...(this.blocked?{message:'Process exit was not confirmed; retained worktrees require inspection.'}:{})};
    })();this.stopping=stopping;void stopping.finally(()=>{if(this.stopping===stopping)this.stopping=null;}).catch(()=>{});return stopping;
  }
  async close(){this.closed=true;return this.stop();}
}
