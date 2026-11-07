import {spawn} from 'node:child_process';
import {lstat,realpath,open,readdir} from 'node:fs/promises';
import {constants,fstatSync} from 'node:fs';
import {isAbsolute,normalize,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {verifyHandoffHelper,verifyHandoffProcessIdentity,verifyHandoffProcessReceipt} from './handoff-process.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const guestUUID=/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=v=>createHash('sha256').update(v).digest('hex'),same=isDeepStrictEqual;
const dirStamp=s=>({dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode),uid:Number(s.uid)});
const fileStamp=s=>({...dirStamp(s),size:String(s.size),nlink:Number(s.nlink),mtimeNS:String(s.mtimeNs),ctimeNS:String(s.ctimeNs)});
const frozen=v=>{if(v&&typeof v==='object'){for(const item of Object.values(v))frozen(item);Object.freeze(v);}return v;};
const shape=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())throw Error('Invalid guest installation receipt schema.');};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};
const stopped=()=>Object.assign(Error('Guest installation stopped.'),{code:'INSTALL_STOPPED'});
const failureOf=v=>v instanceof Error?v:Error('Guest installation rejected without an Error.');
const validPath=p=>typeof p==='string'&&isAbsolute(p)&&normalize(p)===p&&!p.includes('\0')&&p.length<=4096;

// The allocator admits resources and retains the original directory descriptor.
// Downstream provisioning requires observed result + drained stop, never markers alone.
export function startGuestInstall({root,rootFD,ownerId,generation,helper,image,resources,signal,recordClaim,onProgress}={}){
 if(!validPath(root)||!validPath(image)||!Number.isSafeInteger(rootFD)||rootFD<3||!uuid.test(ownerId)||!uuid.test(generation)||!(signal instanceof AbortSignal)||typeof recordClaim!=='function')throw Error('Invalid trusted guest installation request.');
 if(!resources||Object.keys(resources).sort().join()!=='cpu,diskBytes,memoryBytes'||!['cpu','memoryBytes','diskBytes'].every(k=>Number.isSafeInteger(resources[k])&&resources[k]>0)||resources.memoryBytes%1048576||resources.diskBytes%1048576)throw Error('Invalid admitted guest resources.');
 resources=frozen({...resources});
 let child,helperIdentity,rootIdentity,imageIdentity,guestId,claim,claimSHA256,claimIdentity,recordWork,stopWork,failure,operationFailure,protocolFailure,terminal,terminalSHA256,preclaimFailure,prematureExit;
 let requested=false,stopSent=false,settled=false,forced=false,shutdownTimer,operationTimer;
 let pending=Buffer.alloc(0),bytes=0,diagnosticBytes=0,stdoutEnded=false,stderrEnded=false;
 const claimed=deferred(),death=deferred(),cancel=deferred(),closure=deferred(),shutdown=deferred();
 function requestStop(){
  requested=true;cancel.reject(stopped());clearTimeout(operationTimer);
  if(child&&!stopSent){
   stopSent=true;if(!settled)child.stdin.end('stop\n');
   shutdownTimer=setTimeout(()=>{
    forced=true;const error=Error('Guest installation shutdown deadline exceeded; outcome remains unknown.');failure??=error;shutdown.reject(error);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   },135000);
   // Keep observers after a deadline, including durable work after helper exit.
   void Promise.allSettled([closure.promise,recordWork]).then(()=>clearTimeout(shutdownTimer));
  }
 }
 const abort=()=>requestStop();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)requestStop();
 const active=()=>{if(requested||signal.aborted)throw stopped();if(failure)throw failure;};
 const wait=p=>Promise.race([p,death.promise,cancel.promise,shutdown.promise]);
 function broken(error){protocolFailure??=error;failure??=error;death.reject(error);requestStop();}
 async function rootCheck(){
  const s=await lstat(root,{bigint:true}),fd=fstatSync(rootFD,{bigint:true}),identity=dirStamp(s);
  if(!s.isDirectory()||!fd.isDirectory()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(root)!==root||!same(identity,dirStamp(fd))||(rootIdentity&&!same(identity,rootIdentity)))throw Error('Guest installation root identity changed.');
  rootIdentity??=identity;
 }
 async function imageCheck(){
  const s=await lstat(image,{bigint:true}),identity=fileStamp(s);
  if(!s.isFile()||s.size<1n||s.uid!==BigInt(process.getuid())||s.nlink!==1n||(s.mode&0o077n)||await realpath(image)!==image||(imageIdentity&&!same(identity,imageIdentity)))throw Error('Guest restore image identity changed.');
  imageIdentity??=identity;
 }
 async function privateFile(name){
  await rootCheck();const path=join(root,name),before=await lstat(path,{bigint:true});
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||(before.mode&0o077n)||before.size<1n||before.size>65536n)throw Error('Unsafe guest installation receipt file.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   if(!same(fileStamp(await file.stat({bigint:true})),fileStamp(before)))throw Error('Guest installation receipt changed while opening.');
   const buffer=Buffer.alloc(65537),{bytesRead}=await file.read(buffer,0,buffer.length,0),bytes=buffer.subarray(0,bytesRead);
   if(BigInt(bytesRead)!==before.size||!same(fileStamp(await file.stat({bigint:true})),fileStamp(before))||!same(fileStamp(await lstat(path,{bigint:true})),fileStamp(before)))throw Error('Guest installation receipt changed while reading.');
   await rootCheck();return {bytes,sha256:sha(bytes),identity:fileStamp(before)};
  }finally{await file.close();}
 }
 async function privateJSON(name){const r=await privateFile(name);return {...r,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(r.bytes))};}
 function storageRecord(storage){
  shape(storage,['hardware-model.bin','machine-id.bin','auxiliary.bin','disk.img']);
  for(const [name,item] of Object.entries(storage)){
   shape(item,['identity','sha256']);const id=item.identity;shape(id,['dev','ino','size','mode','uid','nlink','mtimeNS','ctimeNS']);
   const immutable=name==='hardware-model.bin'||name==='machine-id.bin';
   if(!['dev','ino','size','mtimeNS','ctimeNS'].every(k=>typeof id[k]==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(id[k]))||!['mode','uid','nlink'].every(k=>Number.isSafeInteger(id[k]))||id.uid!==process.getuid()||id.nlink!==1||(id.mode&0o170000)!==0o100000||(id.mode&0o077)||BigInt(id.size)<1n||BigInt(id.size)>BigInt(Number.MAX_SAFE_INTEGER)||(name==='disk.img'&&id.size!==String(resources.diskBytes))||(immutable?(BigInt(id.size)>65536n||!digest(item.sha256)):item.sha256!==null))throw Error('Invalid installed storage identity.');
  }
 }
 async function verifyStorage(storage){
  storageRecord(storage);
  for(const [name,item] of Object.entries(storage)){
   if(item.sha256!==null){const data=await privateFile(name);if(data.sha256!==item.sha256||!same(data.identity,item.identity))throw Error('Immutable installed storage changed.');}
   else{
    await rootCheck();const path=join(root,name),file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{if(!same(fileStamp(await file.stat({bigint:true})),item.identity)||!same(fileStamp(await lstat(path,{bigint:true})),item.identity))throw Error('Installed storage changed.');}finally{await file.close();}
    await rootCheck();
   }
  }
 }
 function tuple(v){if(v.ownerId!==ownerId||v.generation!==generation||v.guestId!==guestId||v.claimSHA256!==claimSHA256)throw Error('Guest installation receipt identity mismatch.');}
 async function readClaim(){
  const data=await privateJSON('install-claim.json'),c=data.value;
  shape(c,['version','ownerId','generation','guestId','root','process','parent','image','resources','restartAllowed']);
  if(c.version!==1||c.ownerId!==ownerId||c.generation!==generation||c.guestId!==guestId||c.restartAllowed!==false||!same(c.root,rootIdentity)||!same(c.image,{path:image,identity:imageIdentity})||!same(c.resources,resources))throw Error('Guest installation claim differs from admitted inputs.');
  verifyHandoffProcessReceipt(c.process,{nonce:generation,pid:child.pid});verifyHandoffProcessIdentity(c.parent,{pid:process.pid,uid:process.getuid(),bootSession:c.process.bootSession});
  return data;
 }
 function output(chunk){
  bytes+=chunk.length;if(protocolFailure)return;
  if(bytes>1048576){pending=Buffer.alloc(0);broken(Error('Guest installation output exceeded its bound.'));return;}
  pending=Buffer.concat([pending,chunk]);
  try{
   for(;;){const at=pending.indexOf(10);if(at<0)break;if(at>16384)throw Error('Guest installation line exceeded its bound.');
    const row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(0,at)));pending=pending.subarray(at+1);
    if(terminal||preclaimFailure)throw Error('Guest installation event after terminal.');
    if(row.event==='claimed'){
     shape(row,['event','ownerId','generation','guestId','claimSHA256']);
     if(claimSHA256||row.ownerId!==ownerId||row.generation!==generation||!guestUUID.test(row.guestId)||!digest(row.claimSHA256))throw Error('Invalid guest installation claim event.');
     guestId=row.guestId;claimSHA256=row.claimSHA256;claimed.resolve(row);
    }else if(row.event==='failed'){
     shape(row,['event','error','closed']);
     if(claimSHA256||row.closed!==true||typeof row.error!=='string'||!row.error.length||row.error.length>1024)throw Error('Invalid guest installation preclaim failure.');
     preclaimFailure=Error(row.error);
    }else if(row.event==='completed'){
     if(!claimSHA256)throw Error('Unclaimed guest installation terminal.');terminal=frozen(row);
    }else if(row.event==='install-progress'){
     shape(row,['event','ownerId','generation','guestId','claimSHA256','fraction','state']);tuple(row);
     if(!claim||typeof row.fraction!=='number'||!Number.isFinite(row.fraction)||row.fraction<0||row.fraction>1||!Number.isSafeInteger(row.state)||row.state<0)throw Error('Invalid guest installation progress.');
     // Validated display telemetry cannot fail the protocol or certify completion.
     if(!requested&&!signal.aborted&&!settled&&typeof onProgress==='function')try{onProgress(row.fraction);}catch{}
    }else throw Error('Invalid guest installation event.');
   }
   if(pending.length>16384)throw Error('Guest installation line exceeded its bound.');
  }catch(error){pending=Buffer.alloc(0);broken(error);}
 }
 async function finished(code,exitSignal){
  settled=true;signal.removeEventListener('abort',abort);clearTimeout(operationTimer);
  try{
   if(protocolFailure)throw protocolFailure;
   // The allocator observes closure before result; retain the checked diagnostic
   // on that rejection too, without certifying an unclaimed helper's closure.
   if(preclaimFailure&&!claimSHA256&&!terminal&&!forced&&code===1&&exitSignal===null&&stdoutEnded&&stderrEnded&&!pending.length)throw Error(preclaimFailure.message+'; guest installation closure remains unconfirmed.');
   if(forced||code!==0||exitSignal!==null||!stdoutEnded||!stderrEnded||pending.length||!terminal)throw Error('Guest installation helper or callback closure is unconfirmed.');
   const latest=await readClaim();if(latest.sha256!==claimSHA256||(claimIdentity&&!same(latest.identity,claimIdentity)))throw Error('Guest installation claim changed.');claim??=frozen(latest.value);
   const data=await privateJSON('install-terminal.json'),v=data.value;
   shape(v,['event','ownerId','generation','guestId','claimSHA256','passed','closed','started','cancelled','error','state','loadCallbackSettled','installCallbackSettled','stopCallbackSettled','imageUnchanged','fixtureSHA256','installedSHA256','storage',...(Object.hasOwn(v,'failureKind')?['failureKind']:[])]);tuple(v);
   if(Object.hasOwn(v,'failureKind')&&(v.failureKind!=='capacity-low'||v.passed!==false||v.started!==false||v.cancelled!==false||v.imageUnchanged!==true))throw Error('Invalid guest installation failure kind.');
   if(!same(v,terminal)||v.event!=='completed'||v.closed!==true||v.state!==0||v.loadCallbackSettled!==true||v.installCallbackSettled!==true||v.stopCallbackSettled!==true||typeof v.started!=='boolean'||typeof v.imageUnchanged!=='boolean'||typeof v.passed!=='boolean'||typeof v.cancelled!=='boolean'||typeof v.error!=='string'||v.error.length>1024||(v.passed?(!v.started||v.cancelled||v.error!==''||!v.imageUnchanged||!digest(v.fixtureSHA256)||!digest(v.installedSHA256)):(v.fixtureSHA256!==null||v.installedSHA256!==null||v.storage!==null)))throw Error('Guest installation terminal does not prove exact closure.');
   if(v.passed)storageRecord(v.storage);if(v.failureKind==='capacity-low')await imageCheck();terminalSHA256=data.sha256;
   closure.resolve(frozen({ownerId,generation,guestId,launched:true,closed:true,claimSHA256,claim,terminalSHA256,terminal:v,exitCode:code,exitSignal,outputClosed:true}));
  }catch(error){closure.reject(error);}
 }
 async function installedResult(){
  await imageCheck();const data=await privateJSON('fixture.json'),installed=await privateJSON('installed.json'),v=data.value,i=installed.value;
  shape(v,['version','guestId','controller','build','cpu','memoryBytes','diskBytes','macAddress','directoryShares','restoreImage']);shape(i,['controller','installed','state','build']);
  if(data.sha256!==terminal.fixtureSHA256||installed.sha256!==terminal.installedSHA256||v.version!==1||v.guestId!==guestId||!guestUUID.test(v.controller)||typeof v.build!=='string'||!v.build.length||v.build.length>100||!['cpu','memoryBytes','diskBytes'].every(k=>v[k]===resources[k])||typeof v.macAddress!=='string'||!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(v.macAddress)||v.directoryShares!==0||v.restoreImage!==image||i.controller!==v.controller||i.build!==v.build||i.installed!==true||i.state!=='stopped')throw Error('Guest installation artifacts differ from acquisition evidence.');
  await verifyStorage(terminal.storage);active();return frozen({ownerId,generation,guestId,claimSHA256,claim,terminalSHA256,terminal,fixture:v,fixtureSHA256:data.sha256,installed:i,installedSHA256:installed.sha256});
 }
 const result=(async()=>{
  let claimTimer;
  try{
   active();await rootCheck();active();if((await readdir(root)).length)throw Error('Guest installation root must be empty.');await imageCheck();active();
   helperIdentity=await verifyHandoffHelper(helper);active();
   child=spawn(helper,[root,ownerId,generation,'4',image,String(resources.cpu),String(resources.memoryBytes),String(resources.diskBytes)],{detached:true,cwd:root,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:root,LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe','ignore',rootFD]});
   child.stdin.on('error',()=>{});child.stdout.on('data',output);child.stdout.once('end',()=>stdoutEnded=true);child.stderr.once('end',()=>stderrEnded=true);
   child.stdout.on('error',()=>broken(Error('Guest installation output failed.')));child.stderr.on('error',()=>broken(Error('Guest installation diagnostics failed.')));
   child.stderr.on('data',chunk=>{diagnosticBytes+=chunk.length;if(diagnosticBytes>65536)broken(Error('Guest installation diagnostics exceeded their bound.'));});
   child.once('error',()=>broken(Error('Guest installation helper could not run.')));
   child.once('exit',()=>death.reject(prematureExit=Error('Guest installation helper exited before admission.')));
   child.once('close',(code,sig)=>{void finished(code,sig);});
   claimTimer=setTimeout(()=>broken(Error('Guest installation claim/record deadline exceeded.')),10000);
   await wait(claimed.promise);active();const data=await wait(readClaim());
   if(data.sha256!==claimSHA256)throw Error('Guest installation claim digest mismatch.');claim=frozen(data.value);claimIdentity=data.identity;active();
   recordWork=Promise.resolve().then(()=>recordClaim(frozen({ownerId,generation,guestId,claimSHA256,claim})));void recordWork.catch(()=>{});
   await wait(recordWork);active();
   const latest=await wait(privateJSON('install-claim.json'));if(latest.sha256!==claimSHA256||!same(latest.identity,claimIdentity))throw Error('Guest installation claim changed before release.');
   await imageCheck();await rootCheck();await verifyHandoffHelper(helper,helperIdentity);active();clearTimeout(claimTimer);
   operationTimer=setTimeout(()=>{failure??=Error('Guest installation operational deadline exceeded.');requestStop();},1800000);
   await wait(new Promise((resolve,reject)=>child.stdin.write('start '+claimSHA256+'\n',e=>e?reject(Error('Guest installation release failed.')):resolve())));
   const closed=await Promise.race([closure.promise,cancel.promise,shutdown.promise]);active();
   if(!closed.terminal.passed){const error=Error(closed.terminal.error||'Guest installation failed.');if(closed.terminal.failureKind==='capacity-low')operationFailure=error;throw error;}return await installedResult();
  }catch(error){
   const cause=failureOf(error);if(cause.code!=='INSTALL_STOPPED'&&cause!==operationFailure)failure??=cause;requestStop();
   if(child)await Promise.race([closure.promise,shutdown.promise]).catch(()=>{});
   // Exit can precede buffered stdout. Preserve only the validated native
   // diagnostic after normal output closure; it never certifies retirement.
   if(cause===prematureExit&&preclaimFailure&&!protocolFailure&&!forced&&child.exitCode===1&&child.signalCode===null&&stdoutEnded&&stderrEnded&&!pending.length)throw preclaimFailure;
   throw cause;
  }finally{
   clearTimeout(claimTimer);clearTimeout(operationTimer);
   if(!child){signal.removeEventListener('abort',abort);closure.resolve(frozen({ownerId,generation,launched:false,closed:true}));}
  }
 })();void result.catch(()=>{});
 function stop(){
  requestStop();return stopWork??=Promise.race([(async()=>{
   await result.catch(()=>{});try{await recordWork;}catch(error){failure??=failureOf(error);}
   const closed=await closure.promise;if(failure)throw failure;return closed;
  })(),shutdown.promise]);
 }
 return Object.freeze({result,closed:closure.promise,stop});
}
