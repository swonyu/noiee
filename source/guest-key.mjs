import {spawn} from 'node:child_process';
import {lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,normalize,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {verifyHandoffHelper,verifyHandoffProcessIdentity,verifyHandoffProcessReceipt} from './handoff-process.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const guestUUID=/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=v=>createHash('sha256').update(v).digest('hex');
const same=isDeepStrictEqual;
const dirStamp=s=>({dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode),uid:Number(s.uid)});
const diskStamp=s=>({dev:String(s.dev),ino:String(s.ino),size:String(s.size),mode:Number(s.mode),uid:Number(s.uid),nlink:Number(s.nlink),mtimeNS:String(s.mtimeNs),ctimeNS:String(s.ctimeNs)});
const frozen=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))frozen(item);Object.freeze(v);}return v;};
const shape=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())throw Error('Invalid guest key receipt schema.');};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};
const stopped=()=>Object.assign(Error('Guest key extraction stopped.'),{code:'KEY_STOPPED'});
const failureOf=value=>value instanceof Error?value:Error('Guest key operation rejected without an Error.');
function priorReceipt(value,ownerId,generation){
 const v=structuredClone(value),c=v?.claim,t=v?.terminal;
 if(!v||v.ownerId!==ownerId||v.generation!==generation||v.launched!==true||v.closureConfirmed!==true||v.outputClosed!==true||v.exitCode!==0||v.exitSignal!==null||!digest(v.claimSHA256)||c?.ownerId!==ownerId||c?.generation!==generation||!guestUUID.test(c?.guestId)||c?.trustedProvisioningOnly!==true||c?.executionAdmitted!==false||c?.restartAllowed!==false||t?.event!=='stop-completed'||t?.claimSHA256!==v.claimSHA256||!['ownerId','generation','guestId','epoch'].every(k=>t[k]===c[k])||t.closureConfirmed!==true||t.started!==true||t.faulted!==false||t.state!==0||t.errorCode!==0||t.errorDomain!==''||t.reason!=='provisioning complete')throw Error('Observed successful provisioning closure is required.');
 verifyHandoffProcessIdentity(c.parent,{pid:process.pid,uid:process.getuid()});return frozen(v);
}

// Caller must pass the completed provisioning stop() result, not only its durable
// terminal, and serialize phases. The borrowed directory FD stays caller-owned.
export function startGuestKeyExtraction({root,rootFD,ownerId,generation,helper,provisioning,signal,recordClaim}={}){
 if(typeof root!=='string'||!isAbsolute(root)||normalize(root)!==root||root.includes('\0')||root.length>4096||!Number.isSafeInteger(rootFD)||rootFD<3||!uuid.test(ownerId)||!uuid.test(generation)||!(signal instanceof AbortSignal)||typeof recordClaim!=='function')throw Error('Invalid trusted guest key extraction request.');
 const prior=priorReceipt(provisioning,ownerId,generation),guestId=prior.claim.guestId;
 let child,helperIdentity,claim,claimSHA256,claimIdentity,provisionTerminalHash,recordWork,stopWork,failure,operationFailure,protocolFailure,terminal,requested=false,stopSent=false,settled=false,forced=false,shutdownTimer;
 let pending=Buffer.alloc(0),bytes=0,diagnosticBytes=0,stdoutEnded=false,stderrEnded=false;
 const claimed=deferred(),death=deferred(),cancel=deferred(),closure=deferred(),shutdown=deferred();
 function requestStop(){
  requested=true;cancel.reject(stopped());
  if(child&&!stopSent){
   stopSent=true;if(!settled)child.stdin.end('stop\n');
   shutdownTimer=setTimeout(()=>{
    forced=true;const error=Error('Guest key shutdown deadline exceeded; outcome remains unknown.');failure??=error;shutdown.reject(error);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   },75000);
   // Do not fabricate child/pipe closure or abandon a losing durable callback.
   void Promise.allSettled([closure.promise,recordWork]).then(()=>clearTimeout(shutdownTimer));
  }
 }
 const abort=()=>requestStop();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)requestStop();
 const active=()=>{if(requested||signal.aborted)throw stopped();if(failure)throw failure;};
 const wait=p=>Promise.race([p,death.promise,cancel.promise,shutdown.promise]);
 function broken(error){protocolFailure??=error;failure??=error;death.reject(error);requestStop();}
 async function rootCheck(){
  const s=await lstat(root,{bigint:true});
  if(!s.isDirectory()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(root)!==root||!same(dirStamp(s),prior.claim.root))throw Error('Guest key root identity changed.');
 }
 async function privateFile(name){
  await rootCheck();const path=join(root,name),before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||(before.mode&0o077n)||before.size<1n||before.size>65536n)throw Error('Unsafe guest key receipt file.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   if(!same(diskStamp(await file.stat({bigint:true})),diskStamp(before)))throw Error('Guest key receipt changed while opening.');
   const buffer=Buffer.alloc(65537),{bytesRead}=await file.read(buffer,0,buffer.length,0),bytes=buffer.subarray(0,bytesRead);
   if(BigInt(bytesRead)!==before.size||!same(diskStamp(await file.stat({bigint:true})),diskStamp(before))||!same(diskStamp(await lstat(path,{bigint:true})),diskStamp(before)))throw Error('Guest key receipt changed while reading.');
   await rootCheck();return {bytes,sha256:sha(bytes),identity:diskStamp(before)};
  }finally{await file.close();}
 }
 async function privateJSON(name){const r=await privateFile(name);return {...r,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.bytes))};}
 function tuple(v){if(v.ownerId!==ownerId||v.generation!==generation||v.guestId!==guestId||v.claimSHA256!==claimSHA256)throw Error('Guest key receipt identity mismatch.');}
 async function readClaim(){
  const data=await privateJSON('key-claim.json'),c=data.value;
  shape(c,['version','ownerId','generation','guestId','root','process','parent','provisioningClaimSHA256','provisioningTerminalSHA256','disk']);
  if(c.version!==1||c.ownerId!==ownerId||c.generation!==generation||c.guestId!==guestId||!same(c.root,prior.claim.root)||!same(c.parent,prior.claim.parent)||c.provisioningClaimSHA256!==prior.claimSHA256||c.provisioningTerminalSHA256!==provisionTerminalHash)throw Error('Guest key claim differs from observed provisioning.');
  verifyHandoffProcessReceipt(c.process,{nonce:generation,pid:child.pid});verifyHandoffProcessIdentity(c.parent,{pid:process.pid,uid:process.getuid(),bootSession:c.process.bootSession});
  shape(c.disk,['dev','ino','size','mode','uid','nlink','mtimeNS','ctimeNS']);
  if(!['dev','ino','size','mtimeNS','ctimeNS'].every(k=>typeof c.disk[k]==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(c.disk[k]))||!['mode','uid','nlink'].every(k=>Number.isSafeInteger(c.disk[k]))||!['dev','ino','size','mode','uid','nlink'].every(k=>c.disk[k]===prior.claim.artifacts?.['disk.img']?.[k]))throw Error('Guest key disk differs from provisioned storage.');
  const s=await lstat(join(root,'disk.img'),{bigint:true});
  if(!s.isFile()||s.uid!==BigInt(process.getuid())||s.nlink!==1n||(s.mode&0o077n)||!same(diskStamp(s),c.disk))throw Error('Guest key disk changed before extraction.');
  return data;
 }
 function output(chunk){
  bytes+=chunk.length;if(protocolFailure)return;
  if(bytes>131072){pending=Buffer.alloc(0);broken(Error('Guest key output exceeded its bound.'));return;}
  pending=Buffer.concat([pending,chunk]);
  try{
   for(;;){const at=pending.indexOf(10);if(at<0)break;if(at>16384)throw Error('Guest key line exceeded its bound.');
    const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(0,at)));pending=pending.subarray(at+1);
    if(row.event==='claimed'){
     shape(row,['event','ownerId','generation','guestId','claimSHA256']);
     if(claimSHA256||row.ownerId!==ownerId||row.generation!==generation||row.guestId!==guestId||!digest(row.claimSHA256))throw Error('Invalid guest key claim event.');claimSHA256=row.claimSHA256;claimed.resolve(row);
    }else if(row.event==='completed'){
     if(terminal)throw Error('Duplicate guest key terminal.');terminal=frozen(row);
    }else throw Error('Invalid guest key event.');
   }
   if(pending.length>16384)throw Error('Guest key line exceeded its bound.');
  }catch(error){pending=Buffer.alloc(0);broken(error);}
 }
 async function finished(code,exitSignal){
  settled=true;signal.removeEventListener('abort',abort);
  try{
   if(protocolFailure)throw protocolFailure;
   if(forced||code!==0||exitSignal!==null||!stdoutEnded||!stderrEnded||pending.length||!terminal)throw Error('Guest key helper or attachment closure is unconfirmed.');
   if(!claim){const data=await readClaim();if(data.sha256!==claimSHA256)throw Error('Guest key claim digest mismatch.');claim=frozen(data.value);}
   const data=await privateJSON('key-terminal.json'),v=data.value;
   shape(v,['event','ownerId','generation','guestId','claimSHA256','passed','closed','detached','diskUnchanged','cancelled','error','hostKeySHA256','knownHostsSHA256']);tuple(v);
   if(!same(v,terminal)||v.event!=='completed'||v.closed!==true||v.detached!==true||v.diskUnchanged!==true||typeof v.passed!=='boolean'||typeof v.cancelled!=='boolean'||typeof v.error!=='string'||v.error.length>1024||(v.passed?(v.cancelled||v.error!==''||!digest(v.hostKeySHA256)||!digest(v.knownHostsSHA256)):(v.hostKeySHA256!==null||v.knownHostsSHA256!==null)))throw Error('Guest key terminal does not prove exact closure.');
   closure.resolve(frozen({ownerId,generation,guestId,launched:true,closed:true,claimSHA256,claim,terminal:v,exitCode:code,exitSignal,outputClosed:true}));
  }catch(error){closure.reject(error);}
 }
 async function pinResult(){
  const data=await privateJSON('host-key.json'),hosts=await privateFile('known_hosts'),v=data.value;
  if(data.sha256!==terminal.hostKeySHA256||hosts.sha256!==terminal.knownHostsSHA256||v?.passed!==true||v.detached!==true||v.diskUnchanged!==true||v.attachmentOutcomeKnown!==true||v.readOnly!==true||v.ownersHonored!==true||v.guestId!==guestId||v.provisioningClaimSHA256!==prior.claimSHA256||v.provisioningTerminalSHA256!==provisionTerminalHash||!same(v.disk,claim.disk)||!digest(v.publicKeySHA256)||typeof v.publicKey!=='string')throw Error('Guest key pin evidence mismatch.');
  const match=/^ssh-ed25519 ([A-Za-z0-9+/]{68})$/.exec(v.publicKey),blob=match&&Buffer.from(match[1],'base64');
  if(!blob||blob.length!==51||blob.toString('base64')!==match[1]||!blob.subarray(0,19).equals(Buffer.from('0000000b7373682d6564323535313900000020','hex'))||!hosts.bytes.equals(Buffer.from(guestId+' '+v.publicKey+'\n')))throw Error('Guest key pin format is invalid.');
  if(!same(diskStamp(await lstat(join(root,'disk.img'),{bigint:true})),claim.disk))throw Error('Guest key disk changed after extraction.');
  active();return frozen({ownerId,generation,guestId,hostKey:v,hostKeySHA256:data.sha256,knownHosts:join(root,'known_hosts'),knownHostsSHA256:hosts.sha256});
 }
 const result=(async()=>{
  let claimTimer;
  try{
   active();await rootCheck();active();
   const provision=await privateJSON('provision-claim.json'),terminal=await privateJSON('provision-terminal.json');
   if(provision.sha256!==prior.claimSHA256||!same(provision.value,prior.claim)||!same(terminal.value,prior.terminal))throw Error('Provisioning records differ from observed closure.');provisionTerminalHash=terminal.sha256;
   active();helperIdentity=await verifyHandoffHelper(helper);active();
   child=spawn(helper,[root,ownerId,generation,'4'],{detached:true,cwd:root,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:root,LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe','ignore',rootFD]});
   child.stdin.on('error',()=>{});child.stdout.on('data',output);child.stdout.once('end',()=>stdoutEnded=true);child.stderr.once('end',()=>stderrEnded=true);
   child.stdout.on('error',()=>broken(Error('Guest key output failed.')));child.stderr.on('error',()=>broken(Error('Guest key diagnostics failed.')));
   child.stderr.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>16384)broken(Error('Guest key diagnostics exceeded their bound.'));});
   child.once('error',()=>broken(Error('Guest key helper could not run.')));
   child.once('exit',()=>death.reject(Error('Guest key helper exited before admission.')));
   child.once('close',(code,sig)=>{void finished(code,sig);});
   claimTimer=setTimeout(()=>broken(Error('Guest key claim/record deadline exceeded.')),10000);
   await wait(claimed.promise);active();const data=await wait(readClaim());
   if(data.sha256!==claimSHA256)throw Error('Guest key claim digest mismatch.');claim=frozen(data.value);claimIdentity=data.identity;active();
   recordWork=Promise.resolve().then(()=>recordClaim(frozen({ownerId,generation,guestId,claimSHA256,claim})));void recordWork.catch(()=>{});
   await wait(recordWork);active();
   const latest=await wait(privateJSON('key-claim.json'));if(latest.sha256!==claimSHA256||!same(latest.identity,claimIdentity))throw Error('Guest key claim changed before release.');
   await verifyHandoffHelper(helper,helperIdentity);active();clearTimeout(claimTimer);
   await wait(new Promise((resolve,reject)=>child.stdin.write('start '+claimSHA256+'\n',e=>e?reject(Error('Guest key release failed.')):resolve())));
   const closed=await Promise.race([closure.promise,cancel.promise,shutdown.promise]);active();
   if(!closed.terminal.passed){operationFailure=Error(closed.terminal.error||'Guest key extraction failed.');throw operationFailure;}return await pinResult();
  }catch(error){
   // A verified failed terminal rejects admission without undoing physical closure.
   const cause=failureOf(error);if(cause.code!=='KEY_STOPPED'&&cause!==operationFailure)failure??=cause;requestStop();
   if(child)await Promise.race([closure.promise,shutdown.promise]).catch(()=>{});throw cause;
  }finally{
   clearTimeout(claimTimer);
   if(!child){signal.removeEventListener('abort',abort);closure.resolve(frozen({ownerId,generation,guestId,launched:false,closed:true}));}
  }
 })();void result.catch(()=>{});
 function stop(){
  requestStop();
  return stopWork??=Promise.race([(async()=>{
   await result.catch(()=>{});try{await recordWork;}catch(error){failure??=failureOf(error);}
   const closed=await closure.promise;if(failure)throw failure;return closed;
  })(),shutdown.promise]);
 }
 return Object.freeze({result,closed:closure.promise,stop});
}
