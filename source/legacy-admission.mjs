import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute,normalize} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {verifyHandoffHelper,verifyHandoffProcessIdentity} from './handoff-process.mjs';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {COLD_GIT_ADOPTION_SHA256,COLD_GIT_ADOPTION_RESOURCE,validateColdGitAdoption,coldGitHostEntry,coldGitAdoptionRequired} from './cold-git-host-adoption.mjs';

export const WORKTREE_HANDOFF_ADOPTION_SHA256="af1c4ef07e863d6b9c7f032f09b0ba648c0f025f7365ce9f7fc5c9e04169b1d5";
export const WORKTREE_HANDOFF_ADOPTION_RESOURCE='worktree-handoff-adoption.json';
const verifiers=new WeakSet(),digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value),boot=value=>typeof value==='string'&&/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const shape=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.sort().join())throw Error('Invalid legacy admission proof shape.');};
const absolute=value=>typeof value==='string'&&value.length<=4096&&!value.includes('\0')&&isAbsolute(value)&&normalize(value)===value;
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid&&a.nlink===b.nlink&&a.mode===b.mode&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
// macOS may change ctime for access metadata while the helper runs. Rehash
// bytes and retain every identity/permission/content-time field across that gap.
const samePayload=(a,b)=>a.sha256===b.sha256&&['dev','ino','uid','nlink','mode','size','mtimeNs'].every(key=>a.info[key]===b.info[key]);
const check=signal=>{if(signal?.aborted)throw Error('Legacy admission cancelled.');};
function directoryShape(value,version=1){shape(value,['path',version===1?'dev':'volumeUUID','ino','uid']);if(!absolute(value.path)||!(version===1?['dev','ino'].every(k=>typeof value[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(value[k])):isFilesystemIdentity({volumeUUID:value.volumeUUID,ino:value.ino}))||!Number.isSafeInteger(value.uid)||value.uid<0)throw Error('Invalid legacy directory proof.');}
async function directory(expected,{version=1,nativeHelper,signal,readIdentity}={}){
 directoryShape(expected,version);const info=await lstat(expected.path,{bigint:true});
 if(!info.isDirectory()||info.isSymbolicLink()||info.nlink<1n||info.uid!==BigInt(process.getuid())||Number(info.uid)!==expected.uid||(info.mode&0o077n)||String(info.ino)!==expected.ino||await realpath(expected.path)!==expected.path)throw Error('Legacy data directory identity or permissions changed.');
 if(version===1){if(String(info.dev)!==expected.dev)throw Error('Legacy data directory identity or permissions changed.');}
 else{
  const stable=await readIdentity({path:expected.path,nativeHelper,signal});check(signal);
  const current=await lstat(expected.path,{bigint:true});
  if(!sameFilesystemIdentity(stable,{volumeUUID:expected.volumeUUID,ino:expected.ino})||current.nlink<1n||!['dev','ino','uid','mode'].every(key=>info[key]===current[key])||await realpath(expected.path)!==expected.path)throw Error('Legacy data directory identity or permissions changed.');
 }
}
async function file(path,{immutable=false,privateFile=false,limit=1048576}={}){
 if(!absolute(path)||await realpath(path)!==path)throw Error('Legacy admission file is not canonical.');
 const before=await lstat(path,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||![0n,BigInt(process.getuid())].includes(before.uid)||(before.mode&0o022n)||immutable&&(before.mode&0o222n)||privateFile&&(before.uid!==BigInt(process.getuid())||(before.mode&0o077n))||before.size>BigInt(limit))throw Error('Unsafe legacy admission file identity, permissions or size.');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{if(!same(before,await handle.stat({bigint:true})))throw Error('Legacy admission file changed while opening.');const bytes=await handle.readFile();if(bytes.length>limit||!same(before,await handle.stat({bigint:true}))||!same(before,await lstat(path,{bigint:true}))||await realpath(path)!==path)throw Error('Legacy admission file changed while reading.');return {bytes,sha256:hash(bytes),info:before};}finally{await handle.close();}
}
const parse=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
function intentShape(value){
 shape(value,['version','kind','dataDirectory','bootSession','oldApplication','successorSha256',...(value?.version===2?['originalIntent','adoptionBootSession','evidence']:value?.version===3?['admissionIntent','predecessorIntentSha256']:[])]);directoryShape(value.dataDirectory,value.version);shape(value.oldApplication,['path','payloadSha256']);
 if(![1,2,3].includes(value.version)||value.kind!==({1:'legacy-history-admission',2:'legacy-history-postboot-rebind',3:'legacy-history-successor-update'})[value.version]||!boot(value.bootSession)||!absolute(value.oldApplication.path)||!digest(value.oldApplication.payloadSha256)||!digest(value.successorSha256)||value.version===3&&!digest(value.predecessorIntentSha256))throw Error('Legacy intent does not match the reviewed data and successor.');
}
function successorShape(value){
 shape(value,['files','nativeHelper']);shape(value.nativeHelper,['path','sha256']);
 if(!absolute(value.nativeHelper.path)||!digest(value.nativeHelper.sha256)||!Array.isArray(value.files)||value.files.length>4096)throw Error('Invalid reviewed successor payload.');
 const seen=new Set();for(const row of value.files){shape(row,['path','sha256']);if(typeof row.path!=='string'||!row.path||row.path.length>4096||row.path.includes('\0')||isAbsolute(row.path)||normalize(row.path)!==row.path||row.path==='..'||row.path.startsWith('../')||row.path==='legacy-admission.json'||row.path.split('/').includes('_CodeSignature')||seen.has(row.path)||!digest(row.sha256))throw Error('Invalid reviewed successor payload file.');seen.add(row.path);}
 for(const name of ['server.mjs','coding-owners.mjs','legacy-admission.mjs','handoff-process.mjs','coding-engine.mjs','owned-runtime.json'])if(!seen.has(name))throw Error('Reviewed successor payload omits an admission dependency.');
}
// This is saved provenance, never an authority token. Only a freshly verified
// capability below can authorize a trusted successor launch.
export function verifyLegacyProvenance(value){
 shape(value,['version','intentSha256','successorSha256','dataDirectory','previousBootSession','owner',...(value?.version>=2?['originalIntentSha256','adoptionBootSession']:[]),...(value?.version===3?['admissionIntentSha256','predecessorIntentSha256']:[])]);directoryShape(value.dataDirectory,value.version);
 if(![1,2,3].includes(value.version)||!digest(value.intentSha256)||!digest(value.successorSha256)||!boot(value.previousBootSession)||value.version>=2&&(!digest(value.originalIntentSha256)||!boot(value.adoptionBootSession)||value.adoptionBootSession===value.previousBootSession)||value.version===3&&(!digest(value.admissionIntentSha256)||!digest(value.predecessorIntentSha256)))throw Error('Invalid legacy admission provenance.');
 verifyHandoffProcessIdentity(value.owner,{uid:value.dataDirectory.uid});if(value.owner.bootSession===value.previousBootSession)throw Error('Legacy admission requires a changed kernel boot.');return value;
}
export const isLegacyAdmission=value=>verifiers.has(value);

async function nativeOwner({nativeHelper,signal}){
 check(signal);let failure,bytes=0;const chunks=[];
 const child=spawn(nativeHelper,['--handoff-process','owner'],{stdio:['ignore','pipe','pipe']});
 const fail=error=>{failure??=error;child.kill('SIGKILL');};
 const abort=()=>fail(Error('Legacy admission cancelled.'));
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const timer=setTimeout(()=>fail(Error('Native legacy boot verification timed out.')),5000);
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)fail(Error('Native legacy boot receipt exceeds its bound.'));else chunks.push(chunk);});
 child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>4096)fail(Error('Native legacy boot receipt exceeds its bound.'));});
 child.once('error',error=>{failure??=error;});child.stdout.on('error',fail);child.stderr.on('error',fail);
 try{
  const {code,termination}=await new Promise(resolve=>child.once('close',(code,termination)=>resolve({code,termination})));
  check(signal);if(failure)throw failure;if(code!==0||termination)throw Error('Native legacy boot verification failed.');
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));if(!raw.endsWith('\n')||raw.indexOf('\n')!==raw.length-1)throw Error('Invalid native legacy boot receipt framing.');
  const value=JSON.parse(raw);if((raw.match(/"(?:[^"\\]|\\.)*"\s*:/g)??[]).length!==10)throw Error('Invalid native legacy boot receipt keys.');return value;
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

// The fixed, read-only envelope is part of the reviewed successor bundle. Its
// separately signed legacy-boot-helper is fixed before the envelope and outer
// app signature; its full-file pin cannot create a resource-signature cycle. No request can select it.
// This does not exclude unrelated old copies launched later by the same user.
export function createLegacyAdmission({resources,readOwner=nativeOwner,readIdentity=readFilesystemIdentity}={}){
 if(!absolute(resources)||typeof readOwner!=='function'||typeof readIdentity!=='function')throw Error('Invalid trusted legacy admission configuration.');
 const nativeHelper=join(resources,'legacy-boot-helper');
 async function verify({dataDir,signal}={},receive){
  check(signal);if(!absolute(dataDir)||await realpath(resources)!==resources)throw Error('Invalid legacy admission location.');
  const resourceInfo=await lstat(resources,{bigint:true});if(!resourceInfo.isDirectory()||resourceInfo.nlink<1n||![0n,BigInt(process.getuid())].includes(resourceInfo.uid)||(resourceInfo.mode&0o022n))throw Error('Unsafe legacy admission bundle directory.');
  const envelopePath=join(resources,'legacy-admission.json'),envelopeFile=await file(envelopePath,{immutable:true});
  const envelope=parse(envelopeFile.bytes);shape(envelope,['version','intent','successor']);shape(envelope.intent,['path','sha256']);successorShape(envelope.successor);
  if(envelope.version!==1||!absolute(envelope.intent.path)||!digest(envelope.intent.sha256)||nativeHelper!==envelope.successor.nativeHelper.path)throw Error('Legacy admission bundle does not match the native helper.');
  const intentFile=await file(envelope.intent.path,{immutable:true,privateFile:true});if(intentFile.sha256!==envelope.intent.sha256)throw Error('Legacy pre-reboot intent digest changed.');
  const intent=parse(intentFile.bytes);intentShape(intent);
  if(intent.dataDirectory.path!==dataDir||intent.successorSha256!==hash(JSON.stringify(envelope.successor)))throw Error('Legacy intent does not match the reviewed data and successor.');
  let originalFile,admissionFile,admission=intent,admissionPath=envelope.intent.path;
  if(intent.version===3){
   shape(intent.admissionIntent,['path','sha256']);
   if(!absolute(intent.admissionIntent.path)||intent.admissionIntent.path===envelope.intent.path||!digest(intent.admissionIntent.sha256))throw Error('Invalid successor admission reference.');
   admissionPath=intent.admissionIntent.path;admissionFile=await file(admissionPath,{immutable:true,privateFile:true});
   if(admissionFile.sha256!==intent.admissionIntent.sha256)throw Error('Admission intent digest changed.');
   admission=parse(admissionFile.bytes);intentShape(admission);
   if(admission.version!==2||admission.bootSession!==intent.bootSession||!['path','volumeUUID','ino','uid'].every(key=>admission.dataDirectory[key]===intent.dataDirectory[key]))throw Error('Successor update does not preserve the reviewed admission lineage.');
  }
  if(intent.version>=2){
   if(!envelope.successor.files.some(row=>row.path==='filesystem-identity.mjs'))throw Error('Reviewed successor payload omits the filesystem identity dependency.');
   shape(admission.originalIntent,['path','sha256']);shape(admission.evidence,['prebootBaselineSHA256','postbootSnapshotSHA256','adoptionAuditSHA256']);
   if(!absolute(admission.originalIntent.path)||admission.originalIntent.path===admissionPath||!digest(admission.originalIntent.sha256)||!boot(admission.adoptionBootSession)||admission.adoptionBootSession===admission.bootSession||!Object.values(admission.evidence).every(digest))throw Error('Invalid reviewed postboot adoption evidence.');
   originalFile=await file(admission.originalIntent.path,{immutable:true,privateFile:true});
   if(originalFile.sha256!==admission.originalIntent.sha256)throw Error('Original legacy pre-reboot intent digest changed.');
   const original=parse(originalFile.bytes);shape(original,['version','kind','dataDirectory','bootSession','oldApplication','successorSha256']);directoryShape(original.dataDirectory);shape(original.oldApplication,['path','payloadSha256']);
   if(original.version!==1||original.kind!=='legacy-history-admission'||original.bootSession!==intent.bootSession||!['path','ino','uid'].every(key=>original.dataDirectory[key]===intent.dataDirectory[key])||!absolute(original.oldApplication.path)||!digest(original.oldApplication.payloadSha256)||!digest(original.successorSha256))throw Error('Postboot adoption does not preserve the original legacy intent.');
  }
  const directoryOptions={version:intent.version,nativeHelper,signal,readIdentity};
  const payload=[];for(const row of envelope.successor.files){check(signal);const path=join(resources,row.path),entry=await file(path,{limit:67108864});if(entry.sha256!==row.sha256)throw Error('Reviewed successor payload changed.');payload.push({path,info:entry.info,sha256:entry.sha256});}
  const helper=await verifyHandoffHelper(nativeHelper),helperFile=await file(nativeHelper,{limit:67108864});if(helperFile.sha256!==envelope.successor.nativeHelper.sha256)throw Error('Reviewed native helper payload changed.');
  await directory(intent.dataDirectory,directoryOptions);check(signal);
  check(signal);const receipt=await readOwner({nativeHelper,signal});check(signal);
  shape(receipt,['version','bootSession','owner']);if(receipt.version!==1||!boot(receipt.bootSession))throw Error('Invalid native boot receipt.');
  const owner=verifyHandoffProcessIdentity(receipt.owner,{pid:process.pid,uid:process.getuid(),bootSession:receipt.bootSession});
  if(owner.bootSession===intent.bootSession)throw Error('Legacy admission requires a changed kernel boot.');
  const recheck=async()=>{
  await directory(intent.dataDirectory,directoryOptions);check(signal);
  await verifyHandoffHelper(nativeHelper,helper);if(!samePayload(helperFile,await file(nativeHelper,{limit:67108864})))throw Error('Native helper changed during legacy admission.');
  if(!samePayload(envelopeFile,await file(envelopePath,{immutable:true}))||!samePayload(intentFile,await file(envelope.intent.path,{immutable:true,privateFile:true})))throw Error('Legacy admission proof changed during verification.');
  if(admissionFile&&!samePayload(admissionFile,await file(admissionPath,{immutable:true,privateFile:true})))throw Error('Admission intent changed during verification.');
  if(originalFile&&!samePayload(originalFile,await file(admission.originalIntent.path,{immutable:true,privateFile:true})))throw Error('Original legacy intent changed during verification.');
  for(const entry of payload){check(signal);if(!samePayload(entry,await file(entry.path,{limit:67108864})))throw Error('Reviewed successor payload changed during verification.');}
  const currentResources=await lstat(resources,{bigint:true});if(resourceInfo.dev!==currentResources.dev||resourceInfo.ino!==currentResources.ino||resourceInfo.uid!==currentResources.uid||resourceInfo.mode!==currentResources.mode||await realpath(resources)!==resources)throw Error('Legacy admission bundle directory changed.');
  check(signal);
  };await recheck();
  const proof=Object.freeze({...verifyLegacyProvenance({version:intent.version,intentSha256:intentFile.sha256,successorSha256:intent.successorSha256,dataDirectory:Object.freeze({...intent.dataDirectory}),previousBootSession:intent.bootSession,owner,...(originalFile?{originalIntentSha256:originalFile.sha256,adoptionBootSession:admission.adoptionBootSession}:{}),...(admissionFile?{admissionIntentSha256:admissionFile.sha256,predecessorIntentSha256:intent.predecessorIntentSha256}:{})})});
  return receive?receive({proof,envelope,payload,recheck}):proof;
 }
 const verifier=Object.freeze({verify:options=>verify(options),async prepareWorktreeHandoff({dataDir,signal,checkpoint}={}){
  if(!digest(WORKTREE_HANDOFF_ADOPTION_SHA256)||typeof checkpoint!=='function')throw Error('Reviewed worktree handoff admission is unavailable.');
  checkpoint();check(signal);
  return verify({dataDir,signal},async({proof,payload,recheck})=>{
   const path=join(resources,WORKTREE_HANDOFF_ADOPTION_RESOURCE),saved=payload.find(row=>row.path===path);
   if(!saved||saved.sha256!==WORKTREE_HANDOFF_ADOPTION_SHA256)throw Error('Worktree handoff proof is absent from the authenticated successor.');
   const mapFile=await file(path,{immutable:true});checkpoint();
   if(!samePayload(saved,mapFile))throw Error('Worktree handoff proof changed.');
   const document=parse(mapFile.bytes);shape(document,['version','kind','historicalContinuity','captureBootSession','dataDirectory','evidence','rows','namespaces']);
   if(document.version!==1||document.kind!=='reviewed-current-worktree-handoff-admission'||document.historicalContinuity!==false||!boot(document.captureBootSession)||proof.version!==3||JSON.stringify(document.dataDirectory)!==JSON.stringify(proof.dataDirectory))throw Error('Worktree handoff proof has a foreign data binding.');
   shape(document.evidence,['prebootCheckpointSHA256','closedCheckpointSHA256','observationSHA256','reviewSHA256']);if(!Object.values(document.evidence).every(digest))throw Error('Worktree handoff review evidence is invalid.');
   return Object.freeze({document,async recheck(){checkpoint();check(signal);await recheck();checkpoint();if(!samePayload(mapFile,await file(path,{immutable:true})))throw Error('Worktree handoff proof changed during inspection.');checkpoint();}});
  });
 },coldGitHostAdoptionRequired:ownerId=>coldGitAdoptionRequired(ownerId),async prepareColdGitHosts({dataDir,signal,checkpoint}={}){
  // Refuse before any path/native read. This source proposal cannot activate adoption.
  if(!digest(COLD_GIT_ADOPTION_SHA256))throw Error('Cold Git host adoption is disabled.');
  if(typeof checkpoint!=='function')throw Error('Cold Git adoption requires a live lease checkpoint.');
  checkpoint();check(signal);
  return verify({dataDir,signal},async({proof,envelope,payload,recheck})=>{
   checkpoint();const path=join(resources,COLD_GIT_ADOPTION_RESOURCE),saved=payload.find(p=>p.path===path);
   if(!saved||saved.sha256!==COLD_GIT_ADOPTION_SHA256||!envelope.successor.files.some(p=>p.path==='cold-git-host-adoption.mjs'))throw Error('Cold Git adoption is absent from the authenticated successor.');
   const mapFile=await file(path,{immutable:true});checkpoint();
   if(!samePayload(saved,mapFile))throw Error('Cold Git adoption resource changed.');
   const document=validateColdGitAdoption(parse(mapFile.bytes),proof);
   const proofCheck=async()=>{checkpoint();check(signal);await recheck();checkpoint();if(!samePayload(mapFile,await file(path,{immutable:true})))throw Error('Cold Git adoption changed during lease.');checkpoint();};
   await proofCheck();
   return Object.freeze({async host(input){
    checkpoint();const row=coldGitHostEntry(document,input),expected=row.currentHostIdentity;let liveHost=null;
    const hostCheck=async()=>{
     checkpoint();check(signal);
     const before=await lstat(row.cwd,{bigint:true});checkpoint();
     if(!before.isDirectory()||before.isSymbolicLink()||!['ino','mode','uid'].every(k=>String(before[k])===String(expected[k]))||liveHost&&!['dev','ino','mode','uid'].every(k=>before[k]===liveHost[k]))throw Error('Adopted cold host live identity changed.');liveHost??=before;
     await directory({path:row.cwd,volumeUUID:expected.volumeUUID,ino:expected.ino,uid:expected.uid},{version:2,nativeHelper,signal,readIdentity});checkpoint();
     const after=await lstat(row.cwd,{bigint:true});checkpoint();
     if(!['dev','ino','mode','uid'].every(k=>before[k]===after[k]))throw Error('Adopted cold host changed during inspection.');
    };
    await proofCheck();await hostCheck();await proofCheck();
    return async()=>{await proofCheck();await hostCheck();await proofCheck();checkpoint();};
   }});
  });
 }});verifiers.add(verifier);return verifier;
}
