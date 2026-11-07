import {spawn} from 'node:child_process';
import {lstat,realpath,open} from 'node:fs/promises';
import {constants,fstatSync} from 'node:fs';
import {isDeepStrictEqual as equal} from 'node:util';
import {isAbsolute,join} from 'node:path';
import {createHash} from 'node:crypto';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {verifyHandoffHelper,verifyHandoffProcessIdentity,verifyHandoffProcessReceipt} from './handoff-process.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const nativeUUID=/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const shape=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())throw Error('Invalid native VM receipt schema.');};
const frozen=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))frozen(item);Object.freeze(v);}return v;};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};
const directory=s=>({dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),mode:Number(s.mode)});
const same=(a,b)=>Object.keys(a).every(k=>a[k]===b[k])&&Object.keys(a).length===Object.keys(b).length;
const fileStamp=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mode:String(s.mode),uid:String(s.uid),nlink:String(s.nlink),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)});
const stopped=()=>Object.assign(Error('VM allocation stopped.'),{code:'VM_STOPPED'});

const failureOf=v=>v instanceof Error?v:Error('Native VM operation rejected without an Error.');
const installStamp=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mode:Number(s.mode),uid:Number(s.uid),nlink:Number(s.nlink),mtimeNS:String(s.mtimeNs),ctimeNS:String(s.ctimeNs)});
const claimStamp=s=>({dev:s.dev,ino:s.ino,size:s.size,mode:s.mode,uid:s.uid,nlink:s.nlink,mtimeNS:String(BigInt(s.mtimeSec)*1000000000n+BigInt(s.mtimeNS)),ctimeNS:String(BigInt(s.ctimeSec)*1000000000n+BigInt(s.ctimeNS))});
function acquisition(value,ownerId,generation){
 const v=structuredClone(value),r=v?.result,c=v?.closed,t=r?.terminal;
 if(!v||Object.keys(v).sort().join()!=='closed,result'||!r||!c||r.ownerId!==ownerId||r.generation!==generation||!nativeUUID.test(r.guestId)||!['ownerId','generation','guestId','claimSHA256','terminalSHA256'].every(k=>c[k]===r[k])||!digest(r.claimSHA256)||!digest(r.terminalSHA256)||c.launched!==true||c.closed!==true||c.outputClosed!==true||c.exitCode!==0||c.exitSignal!==null||!equal(c.claim,r.claim)||!equal(c.terminal,t)||r.claim?.ownerId!==ownerId||r.claim?.generation!==generation||r.claim?.guestId!==r.guestId||t?.event!=='completed'||t.ownerId!==ownerId||t.generation!==generation||t.guestId!==r.guestId||t.claimSHA256!==r.claimSHA256||t.passed!==true||t.closed!==true||t.started!==true||t.cancelled!==false||t.error!==''||t.state!==0||t.loadCallbackSettled!==true||t.installCallbackSettled!==true||t.stopCallbackSettled!==true||t.imageUnchanged!==true||!digest(r.fixtureSHA256)||r.fixtureSHA256!==t.fixtureSHA256||!digest(r.installedSHA256)||r.installedSHA256!==t.installedSHA256)throw Error('Observed successful installation and drained Stop are required.');
 const resources=r.claim.resources;
 if(!resources||Object.keys(resources).sort().join()!=='cpu,diskBytes,memoryBytes'||!['cpu','memoryBytes','diskBytes'].every(k=>Number.isSafeInteger(resources[k])&&resources[k]>0)||resources.memoryBytes%1048576||resources.diskBytes%1048576)throw Error('Invalid observed installation resources.');
 shape(t.storage,['hardware-model.bin','machine-id.bin','auxiliary.bin','disk.img']);
 for(const [name,item] of Object.entries(t.storage)){
  shape(item,['identity','sha256']);const id=item.identity;shape(id,['dev','ino','size','mode','uid','nlink','mtimeNS','ctimeNS']);const immutable=['hardware-model.bin','machine-id.bin'].includes(name);
  if(!['dev','ino','size','mtimeNS','ctimeNS'].every(k=>typeof id[k]==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(id[k]))||!['mode','uid','nlink'].every(k=>Number.isSafeInteger(id[k]))||id.uid!==process.getuid()||id.nlink!==1||(id.mode&0o170000)!==0o100000||(id.mode&0o077)||BigInt(id.size)<1n||BigInt(id.size)>BigInt(Number.MAX_SAFE_INTEGER)||(name==='disk.img'&&id.size!==String(resources.diskBytes))||(immutable?(BigInt(id.size)>65536n||!digest(item.sha256)):item.sha256!==null))throw Error('Invalid observed installation storage.');
 }
 verifyHandoffProcessReceipt(r.claim.process,{nonce:generation,pid:r.claim.process?.pid});verifyHandoffProcessIdentity(r.claim.parent,{pid:process.pid,uid:process.getuid(),bootSession:r.claim.process.bootSession});return frozen(v);
}
export function bootPolicy(value){
 if(!value||Object.keys(value).sort().join()!=='fullName,maximumRunSeconds,user'||typeof value.user!=='string'||!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.user)||typeof value.fullName!=='string'||!value.fullName.trim()||value.fullName.length>200||/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value.fullName)||!Number.isSafeInteger(value.maximumRunSeconds)||value.maximumRunSeconds<0||value.maximumRunSeconds>9223372036)throw Error('Invalid trusted boot policy.');return frozen({...value});
}

// Own the controller synchronously; ready is native running, not executor readiness.
// The allocator must await stop() after failed bootstrap before dropping this handle.
// Phased callers retain rootFD across provisioning stop(), key extraction/detach,
// and execution. A shared descriptor's flock does not serialize sibling phases.
export function startMacGuest({root,ownerId,generation,helper,credential,signal,recordClaim,phase='legacy',rootFD,installation,policy,nativeHelper}={}){
 if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0')||root.length>4096||!uuid.test(ownerId)||!uuid.test(generation)||typeof credential!=='string'||!/^[A-Za-z0-9_-]{48}$/.test(credential)||typeof recordClaim!=='function'||!signal||typeof signal.addEventListener!=='function')throw Error('Invalid trusted VM allocation.');
 if(!['legacy','provision','execute'].includes(phase)||(phase==='legacy'?rootFD!==undefined:!Number.isSafeInteger(rootFD)||rootFD<3))throw Error('Invalid trusted VM phase or borrowed descriptor.');
 const acquired=installation===undefined?null:acquisition(installation,ownerId,generation);
 if(acquired){if(phase==='legacy')throw Error('Installed acquisition requires an owned phase.');policy=bootPolicy(policy);}else if(policy!==undefined)throw Error('Boot policy requires installation admission.');
 const resources=acquired?.result.claim.resources;
 const prefix=phase==='provision'?'provision':'boot';
 let child,rootIdentity,helperIdentity,claim,claimSHA256,claimFile,terminalFile,claimRead,recordWork,stopWork,completionWork,deadlineFailure,failure,protocolFailure,stopRequested=false,stopSent=false,released=false,readyReached=false,completionSent=false,forced=false,shutdownTimer,terminalEvent;
 let pending=Buffer.alloc(0),outputBytes=0,diagnosticBytes=0,stdoutEnded=false,stderrEnded=false;
 const events=[],claimed=deferred(),running=deferred(),death=deferred(),cancel=deferred(),closure=deferred(),shutdown=deferred();
 function shutdownDeadline(){
  if(!shutdownTimer){
   shutdownTimer=setTimeout(()=>{
    forced=true;const error=Error('Native VM shutdown deadline exceeded; outcome remains unknown.');failure??=error;shutdown.reject(error);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   },75000);
   // Keep observing both resources after timeout; neither pipe EOF nor callback drain is implied.
   void Promise.allSettled([closure.promise,recordWork]).then(()=>clearTimeout(shutdownTimer));
  }
 }
 function requestStop(){
  stopRequested=true;cancel.reject(stopped());
  if(child&&!stopSent){
   stopSent=true;
   if(child.exitCode===null&&child.signalCode===null){
    child.stdin.write('stop\n',error=>{if(error)failure??=Error('Native VM Stop input failed.');});
   }
   shutdownDeadline();
  }
 }
 const abort=()=>requestStop();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)requestStop();
 const active=()=>{if(stopRequested)throw stopped();if(failure)throw failure;if(child&&(child.exitCode!==null||child.signalCode!==null))throw Error('Native VM exited before admission.');};
 const wait=promise=>Promise.race([promise,death.promise,cancel.promise]);
 function broken(error){protocolFailure??=error;failure??=error;death.reject(error);requestStop();}
 async function rootCheck(){
  const s=await lstat(root,{bigint:true});
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(root)!==root||rootIdentity&&!same(directory(s),rootIdentity))throw Error('Native VM root identity changed.');
  if(rootFD!==undefined&&!same(directory(fstatSync(rootFD,{bigint:true})),directory(s)))throw Error('Borrowed native VM root changed.');
  if(acquired&&!equal(directory(s),acquired.result.claim.root))throw Error('Installation root identity changed.');rootIdentity??=directory(s);
 }
 async function privateJSON(name){
  await rootCheck();const path=join(root,name),before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||(before.mode&0o077n)||before.size<1n||before.size>65536n)throw Error('Unsafe native VM receipt file.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   if(!same(fileStamp(await file.stat({bigint:true})),fileStamp(before)))throw Error('Native VM receipt changed while opening.');
   const buffer=Buffer.alloc(65537),{bytesRead}=await file.read(buffer,0,buffer.length,0),bytes=buffer.subarray(0,bytesRead);
   if(bytes.length!==Number(before.size)||bytes.length>65536||!same(fileStamp(await file.stat({bigint:true})),fileStamp(before))||!same(fileStamp(await lstat(path,{bigint:true})),fileStamp(before)))throw Error('Native VM receipt changed while reading.');
   await rootCheck();return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),sha256:hash(bytes),identity:fileStamp(before)};
  }finally{await file.close();}
 }
 async function installedInputs(){
  if(!acquired){
   for(const name of ['install-claim.json','install-terminal.json']){try{await lstat(join(root,name));}catch(error){if(error.code==='ENOENT')continue;throw error;}throw Error('Observed installation admission is required for this root.');}
   if(phase==='execute'){const provision=await privateJSON('provision-claim.json');if(['installationClaimSHA256','installationTerminalSHA256','resources','policy'].some(k=>Object.hasOwn(provision.value,k)))throw Error('Observed installation admission is required for this provisioning claim.');}
   return;
  }
  const r=acquired.result;
  for(const [name,value,sha256] of [['install-claim.json',r.claim,r.claimSHA256],['install-terminal.json',r.terminal,r.terminalSHA256],['fixture.json',r.fixture,r.fixtureSHA256],['installed.json',r.installed,r.installedSHA256]]){
   const data=await privateJSON(name);if(data.sha256!==sha256||!equal(data.value,value))throw Error('Observed installation records changed.');
  }
  if(phase==='provision')for(const [name,item] of Object.entries(r.terminal.storage)){
   await rootCheck();const path=join(root,name),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    if(!equal(installStamp(await file.stat({bigint:true})),item.identity)||!equal(installStamp(await lstat(path,{bigint:true})),item.identity))throw Error('Installed storage changed before provisioning.');
    if(item.sha256!==null){const buffer=Buffer.alloc(65537),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(String(bytesRead)!==item.identity.size||hash(buffer.subarray(0,bytesRead))!==item.sha256||!equal(installStamp(await file.stat({bigint:true})),item.identity)||!equal(installStamp(await lstat(path,{bigint:true})),item.identity))throw Error('Installed hardware metadata changed.');}
   }finally{await file.close();}
  }
 }
 function tuple(row){
  if(row.ownerId!==ownerId||row.generation!==generation||row.guestId!==claim?.guestId||row.epoch!==claim?.epoch||row.claimSHA256!==claimSHA256)throw Error('Native VM identity correlation failed.');
 }
 async function readClaim(){
  const data=await privateJSON(prefix+'-claim.json'),v=data.value;
  shape(v,['version','ownerId','generation','guestId','epoch','root','artifacts','metadataSHA256','process','parent','provisioning','restartAllowed',...(v.version===2?['filesystem']:[]),...(phase==='legacy'?[]:['trustedProvisioningOnly','executionAdmitted']),...(phase==='execute'?['provisioningClaimSHA256','hostKeyRecordSHA256']:[]),...(acquired?['installationClaimSHA256','installationTerminalSHA256','resources','policy']:[])]);
  if((nativeHelper?v.version!==2:![1,2].includes(v.version))||v.ownerId!==ownerId||v.generation!==generation||!nativeUUID.test(v.guestId)||!nativeUUID.test(v.epoch)||!same(v.root,rootIdentity)||v.provisioning!==(phase!=='execute')||v.restartAllowed!==false||(phase!=='legacy'&&(v.trustedProvisioningOnly!==(phase==='provision')||v.executionAdmitted!==(phase==='execute'))))throw Error('Native VM claim identity is invalid.');
  if(v.version===2){
   shape(v.filesystem,['root','disk']);
   if(!isFilesystemIdentity(v.filesystem.root)||!isFilesystemIdentity(v.filesystem.disk)||v.filesystem.root.ino!==v.root.ino||v.filesystem.disk.ino!==v.artifacts?.['disk.img']?.ino)throw Error('Invalid durable native VM identity.');
   if(nativeHelper)for(const [name,path] of [['root',root],['disk',join(root,'disk.img')]])if(!sameFilesystemIdentity(v.filesystem[name],await readFilesystemIdentity({path,nativeHelper})))throw Error('Durable native VM identity changed.');
   await rootCheck();
  }
  verifyHandoffProcessReceipt(v.process,{nonce:generation,pid:child.pid});verifyHandoffProcessIdentity(v.parent,{pid:process.pid,uid:process.getuid(),bootSession:v.process.bootSession});
  const extra=[...(phase==='execute'?['provision-claim.json','provision-terminal.json','host-key.json']:[]),...(acquired?['install-claim.json','install-terminal.json']:[])],names=['fixture.json','installed.json','hardware-model.bin','machine-id.bin','auxiliary.bin','disk.img',...extra];shape(v.artifacts,names);
  for(const [name,s] of Object.entries(v.artifacts)){
   shape(s,['dev','ino','size','mode','uid','nlink','mtimeSec','mtimeNS','ctimeSec','ctimeNS']);
   if(!['dev','ino','size'].every(k=>typeof s[k]==='string'&&/^\d{1,30}$/.test(s[k]))||!['mode','uid','nlink','mtimeSec','mtimeNS','ctimeSec','ctimeNS'].every(k=>Number.isSafeInteger(s[k]))||s.uid!==process.getuid()||s.nlink!==1||(s.mode&0o170000)!==0o100000||(s.mode&0o077)||BigInt(s.size)<1n||BigInt(s.size)>BigInt(name==='disk.img'?(resources?.diskBytes??64*1024**3):name==='auxiliary.bin'?(acquired?Number.MAX_SAFE_INTEGER:64*1024**2):65536)||s.mtimeNS<0||s.mtimeNS>=1e9||s.ctimeNS<0||s.ctimeNS>=1e9)throw Error('Invalid native VM artifact identity.');
  }
  if(v.artifacts['disk.img'].size!==String(resources?.diskBytes??64*1024**3))throw Error('Invalid native VM disk extent.');
  shape(v.metadataSHA256,[...names.slice(0,4),...extra]);if(!Object.values(v.metadataSHA256).every(digest))throw Error('Invalid native VM metadata hashes.');
  if(phase==='execute'&&(!digest(v.provisioningClaimSHA256)||!digest(v.hostKeyRecordSHA256)||v.provisioningClaimSHA256!==v.metadataSHA256['provision-claim.json']||v.hostKeyRecordSHA256!==v.metadataSHA256['host-key.json']))throw Error('Invalid native VM provisioning evidence hashes.');
  if(acquired){
   const r=acquired.result;
   if(v.guestId!==r.guestId||!equal(v.parent,r.claim.parent)||!equal(v.resources,resources)||!equal(v.policy,policy)||v.installationClaimSHA256!==r.claimSHA256||v.installationTerminalSHA256!==r.terminalSHA256||v.metadataSHA256['install-claim.json']!==r.claimSHA256||v.metadataSHA256['install-terminal.json']!==r.terminalSHA256||v.metadataSHA256['fixture.json']!==r.fixtureSHA256||v.metadataSHA256['installed.json']!==r.installedSHA256)throw Error('Native VM installation lineage or policy differs from admission.');
   for(const [name,item] of Object.entries(r.terminal.storage)){
    const stamp=claimStamp(v.artifacts[name]);
    if(phase==='provision'||item.sha256!==null){if(!equal(stamp,item.identity))throw Error('Native VM storage differs from installed acquisition.');}
    else if(!['dev','ino','mode','uid','nlink'].every(k=>stamp[k]===item.identity[k])||(name==='disk.img'&&stamp.size!==item.identity.size))throw Error('Native VM original storage identity changed.');
    if(item.sha256!==null&&v.metadataSHA256[name]!==item.sha256)throw Error('Native VM immutable installation metadata changed.');
   }
  }
  return data;
 }
 function output(chunk){
  outputBytes+=chunk.length;
  if(protocolFailure)return;
  if(outputBytes>262144){pending=Buffer.alloc(0);broken(Error('Native VM output exceeded its bound.'));return;}
  pending=Buffer.concat([pending,chunk]);
  try{
   for(;;){const at=pending.indexOf(10);if(at<0)break;if(at>16384)throw Error('Native VM line exceeded its bound.');
    const raw=new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(0,at));pending=pending.subarray(at+1);
    if(raw.includes(credential))throw Error('Native VM emitted provisioning data.');
    const row=JSON.parse(raw);if(!row||typeof row!=='object'||Array.isArray(row)||row.ownerId!==ownerId||row.generation!==generation||events.length>=256)throw Error('Invalid native VM event.');
    events.push(frozen(row));
    if(row.event==='claimed'){
     if(events.filter(e=>e.event==='claimed').length!==1||!digest(row.claimSHA256)||!nativeUUID.test(row.guestId)||!nativeUUID.test(row.epoch))throw Error('Invalid native claim event.');claimed.resolve(row);
    }else if(row.event==='running'){
     if(!released||events.filter(e=>e.event==='running').length!==1||row.state!==1)throw Error('Native VM ran before release.');tuple(row);running.resolve(row);
    }else if(row.event==='stop-completed'){if(terminalEvent)throw Error('Duplicate native VM terminal.');terminalEvent=row;}
    else if(row.event==='failed'||row.event==='stop-outcome-unknown')throw Error('Native VM reported unconfirmed lifecycle failure.');
   }
   if(pending.length>16384)throw Error('Native VM line exceeded its bound.');
  }catch(error){pending=Buffer.alloc(0);broken(error);}
 }
 async function settled(code,exitSignal){
  signal.removeEventListener('abort',abort);
  try{
   // Cancellation may win ready's race while this original inspection still owns a helper/FD.
   await claimRead;
   if(protocolFailure)throw protocolFailure;
   // A failed installed provisioning deadline can still have exact physical closure.
   // Runtime expiry needs its policy; shutdown expiry needs requested completion.
   // All other phases/exits retain their original successful-operation requirement.
   const deadlineCandidate=phase==='provision'&&acquired&&readyReached&&released&&code===1;
   if(forced||code!==0&&!deadlineCandidate||exitSignal!==null||!stdoutEnded||!stderrEnded||pending.length||!terminalEvent)throw Error('Native VM exit or output closure is unconfirmed.');
   if(!claim){const data=await readClaim();claim=frozen(data.value);claimSHA256=data.sha256;tuple(terminalEvent);}
   const data=await privateJSON(prefix+'-terminal.json'),v=data.value;
   const keys=['event','ownerId','generation','guestId','epoch','claimSHA256','reason','state','closureConfirmed','started','faulted','productionContainment'];
   shape(v,[...keys,...(v.cancelledBeforeBoot===true?['cancelledBeforeBoot']:['errorCode','errorDomain'])]);tuple(v);
   const graceful=phase==='provision'&&completionSent&&v.reason==='provisioning complete'&&v.cancelledBeforeBoot!==true;
   const deadline=deadlineCandidate&&(v.reason==='Guest runtime deadline'&&policy.maximumRunSeconds>0||v.reason==='Provisioning shutdown deadline'&&completionSent)&&v.faulted===true&&v.started===true&&v.cancelledBeforeBoot!==true;
   const {time,...event}=terminalEvent;if(!Number.isFinite(time)||Object.keys(v).some(k=>v[k]!==event[k])||Object.keys(v).length!==Object.keys(event).length||v.event!=='stop-completed'||v.state!==0||v.closureConfirmed!==true||code!==0&&!deadline||!deadline&&v.faulted!==false||v.productionContainment!==false||(!deadline&&!graceful&&v.reason!=='parent Stop')||(v.cancelledBeforeBoot===true?v.started!==false:v.started!==true||v.errorCode!==0||v.errorDomain!==''))throw Error('Native VM durable terminal does not prove requested closure.');
   if(deadline){const latest=await privateJSON('provision-claim.json');if(latest.sha256!==claimSHA256||!same(latest.identity,claimFile))throw Error('Original provisioning claim changed before closure.');}
    let spentExecution;
    if(phase==='execute'&&readyReached&&v.started===true&&v.cancelledBeforeBoot!==true){
     const latest=await privateJSON('boot-claim.json');
     if(latest.sha256!==claimSHA256||!same(latest.identity,claimFile))throw Error('Original execution claim changed before closure.');
     terminalFile=data.identity;
     spentExecution={claimIdentity:latest.identity,terminalSHA256:data.sha256};
    }
    closure.resolve(frozen({ownerId,generation,claimSHA256,claim,terminal:v,launched:true,closureConfirmed:true,exitCode:code,exitSignal,outputClosed:true,events:[...events],revoked:false,...(spentExecution?{spentExecution}:{})}));
  }catch(error){closure.reject(error);}
 }
 const ready=(async()=>{
  let claimTimer,startTimer;
  try{
   active();helperIdentity=await verifyHandoffHelper(helper);active();await rootCheck();await installedInputs();active();
   child=spawn(helper,[root,ownerId,generation,...(phase==='legacy'?[]:[phase,'4',...(acquired?['installed',JSON.stringify(policy)]:[])])],{detached:true,cwd:root,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:root,LANG:'en_US.UTF-8'},stdio:phase==='legacy'?['pipe','pipe','pipe']:['pipe','pipe','pipe','ignore',rootFD]});
   child.stdin.on('error',()=>{});child.stdout.on('data',output);child.stdout.once('end',()=>stdoutEnded=true);child.stderr.once('end',()=>stderrEnded=true);
   child.stdout.on('error',()=>broken(Error('Native VM output failed.')));child.stderr.on('error',()=>broken(Error('Native VM diagnostics failed.')));
   child.stderr.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>65536)broken(Error('Native VM diagnostics exceeded their bound.'));});
   child.once('error',()=>broken(Error('Native VM controller could not run.')));
   child.once('exit',()=>death.reject(Error('Native VM controller exited.')));
   child.once('close',(code,sig)=>{void settled(code,sig);});
   claimTimer=setTimeout(()=>broken(Error('Native VM claim/record deadline exceeded.')),8000);
   const event=await wait(claimed.promise);active();
   const data=await wait(claimRead=readClaim());claim=frozen(data.value);claimSHA256=data.sha256;claimFile=data.identity;tuple(event);active();
   const snapshot=frozen({ownerId,generation,claimSHA256,claim});
   recordWork=Promise.resolve().then(()=>recordClaim(snapshot));void recordWork.catch(()=>{});await wait(recordWork);active();
   const latest=await wait(privateJSON(prefix+'-claim.json'));if(latest.sha256!==claimSHA256||!same(latest.identity,claimFile))throw Error('Native VM claim changed before release.');
   await installedInputs();await verifyHandoffHelper(helper,helperIdentity);active();clearTimeout(claimTimer);released=true;
   await wait(new Promise((resolve,reject)=>child.stdin.write('start '+claimSHA256+'\n'+(phase==='execute'?'':credential+'\n'),error=>error?reject(Error('Native VM release failed.')):resolve())));active();
   startTimer=setTimeout(()=>broken(Error('Native VM startup deadline exceeded.')),180000);
   await wait(running.promise);active();readyReached=true;return snapshot;
  }catch(error){const cause=failureOf(error);if(cause.code!=='VM_STOPPED')failure??=cause;requestStop();if(child)await Promise.race([closure.promise,shutdown.promise]).catch(()=>{});throw cause;}
  finally{clearTimeout(claimTimer);clearTimeout(startTimer);if(!child){signal.removeEventListener('abort',abort);closure.resolve(frozen({ownerId,generation,launched:false,closureConfirmed:true,revoked:false}));}}
 })();void ready.catch(()=>{});
 function completeProvisioning(){
  if(completionWork)return completionWork;
  try{active();if(phase!=='provision'||!readyReached)throw Error('Only a ready provisioning handle can complete provisioning.');}catch(error){return Promise.reject(error);}
  completionSent=true;shutdownDeadline();
  completionWork=(async()=>{
   try{
    await Promise.race([new Promise((resolve,reject)=>child.stdin.write('finish\n',error=>error?reject(Error('Native VM provisioning completion input failed.')):resolve())),cancel.promise,shutdown.promise]);
    const outcome=await Promise.race([closure.promise,cancel.promise,shutdown.promise]);await recordWork;
    if(stopRequested||signal.aborted)throw stopped();if(failure)throw failure;
    if(outcome.terminal?.reason!=='provisioning complete'){
     const error=Error('Native VM graceful provisioning completion was not confirmed.');
     if(outcome.exitCode===1&&['Guest runtime deadline','Provisioning shutdown deadline'].includes(outcome.terminal?.reason)&&outcome.terminal.faulted===true)deadlineFailure=error;
     throw error;
    }return outcome;
   }catch(error){const cause=failureOf(error);if(cause.code!=='VM_STOPPED'&&cause!==deadlineFailure)failure??=cause;requestStop();throw cause;}
  })();void completionWork.catch(()=>{});return completionWork;
 }
 function stop(){
  requestStop();
  return stopWork??=Promise.race([(async()=>{
   await ready.catch(()=>{});
   try{await recordWork;}catch(error){failure??=failureOf(error);}
   const outcome=await closure.promise;if(failure)throw failure;return outcome;
  })(),shutdown.promise]);
 }
  async function reverifySpentExecution(){
   if(!stopRequested)throw Error('Execution Stop is required before reverification.');
   const outcome=await stop(),proof=outcome.spentExecution;
   if(!proof)throw Error('No admitted spent execution proof.');
   const latest=await privateJSON('boot-claim.json'),terminal=await privateJSON('boot-terminal.json');
   if(latest.sha256!==claimSHA256||!same(latest.identity,claimFile)||terminal.sha256!==proof.terminalSHA256||!same(terminal.identity,terminalFile))throw Error('Original execution proof changed after closure.');
   return proof;
  }
  return Object.freeze({ready,stop,completeProvisioning,reverifySpentExecution,closed:closure.promise});
}
