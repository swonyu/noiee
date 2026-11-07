import {spawn} from 'node:child_process';
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,isAbsolute,normalize} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {verifyHandoffHelper} from './handoff-process.mjs';

const helper=fileURLToPath(new URL('./guest-ssh.exp',import.meta.url));
export function verifyGuestSSHHelper(){return verifyHandoffHelper(helper);}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};
const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
const pathOK=p=>typeof p==='string'&&isAbsolute(p)&&normalize(p)===p&&p.length<=4096&&!/[\x00-\x1f\x7f%]/.test(p)&&!p.includes('${');
const stopped=()=>Error('Guest SSH stopped.');

// Bootstrap commands and the long-lived executor tunnel own exactly one SSH child.
// No TOFU: the allocator must obtain the pin through trusted VM provisioning first.
export function startGuestSSH({address,user,guestId,knownHosts,knownHostsSHA256,credential,signal,mode,command,hostPort,guestPort,source,sourceBytes,sourceSHA256,timeoutMs}={}){
 if(timeoutMs===undefined&&mode!=='upload')timeoutMs=30000;
 const octets=typeof address==='string'?address.split('.'):[];
 const port=n=>Number.isSafeInteger(n)&&n>0&&n<=65535;
 if(octets.length!==4||octets.some(x=>!/^(0|[1-9][0-9]{0,2})$/.test(x)||Number(x)>255)||!(Number(octets[0])===10||Number(octets[0])===172&&Number(octets[1])>=16&&Number(octets[1])<=31||Number(octets[0])===192&&Number(octets[1])===168)||typeof user!=='string'||!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)||typeof guestId!=='string'||!/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/.test(guestId)||!pathOK(knownHosts)||typeof knownHostsSHA256!=='string'||!/^[a-f0-9]{64}$/.test(knownHostsSHA256)||typeof credential!=='string'||!/^[A-Za-z0-9_-]{48}$/.test(credential)||!(signal instanceof AbortSignal)||!['command','forward','upload'].includes(mode)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647||(mode==='command'?(typeof command!=='string'||!command.length||Buffer.byteLength(command)>65536||command.includes('\0')||command.includes(credential)):mode==='forward'?!port(hostPort)||!port(guestPort):typeof source!=='string'||!isAbsolute(source)||normalize(source)!==source||source.length>4096||/[\x00-\x1f\x7f]/.test(source)||!Number.isSafeInteger(sourceBytes)||sourceBytes<0||sourceBytes>=Number.MAX_SAFE_INTEGER||typeof sourceSHA256!=='string'||!/^[a-f0-9]{64}$/.test(sourceSHA256)))throw Error('Invalid trusted guest SSH request.');
 const nonce=randomUUID(),result=deferred(),closed=deferred(),deadline=deferred();
 const stage='/private/tmp/saleh-upload-'+nonce;
 // Bootstrap artifacts go into a new private directory; never replace a guest file.
 if(mode==='upload')command=`set -euC; umask 077; dir=${stage}; /bin/mkdir -m 700 "$dir"; trap '/bin/rm -f "$dir/payload.part"; /bin/rmdir "$dir" 2>/dev/null || :' EXIT; /usr/bin/head -c ${sourceBytes+1} > "$dir/payload.part"; bytes=$(/usr/bin/stat -f %z "$dir/payload.part"); set -- $(/usr/bin/shasum -a 256 "$dir/payload.part"); [ "$bytes" = ${sourceBytes} ] && [ "$1" = ${sourceSHA256} ] || exit 65; /bin/mv "$dir/payload.part" "$dir/payload"; printf 'GUEST_UPLOAD ${nonce} ${sourceBytes} ${sourceSHA256}\\n'`;
 let child,sourceFile,sourceStamp,requested=false,stopWork,fault,operationError,shutdownTimer,workTimer,spawned,terminal,noChild;
 let out=Buffer.alloc(0),err=Buffer.alloc(0),diagnosticBytes=0,outEnded=false,errEnded=false,childClosed=false,settled=false;
 const active=()=>{if(requested||signal.aborted)throw stopped();};
 function stop(){
  if(stopWork)return stopWork;
  requested=true;
  if(!settled){
   if(child&&!childClosed)child.stdin.end('stop\n');
   shutdownTimer=setTimeout(()=>{
    fault??=Error('Guest SSH closure deadline exceeded; ownership retained.');deadline.reject(fault);result.reject(fault);
    if(child&&!childClosed&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   },5000);
  }
  stopWork=Promise.race([closed.promise,deadline.promise]);void stopWork.catch(()=>{});return stopWork;
 }
 const abort=()=>{void stop();};signal.addEventListener('abort',abort,{once:true});
 function broken(message){fault??=Error(message);void stop();}
 function diagnostics(chunk){
  diagnosticBytes+=chunk.length;
  if(diagnosticBytes>16384){broken('Guest SSH diagnostics limit exceeded.');return;}
  err=Buffer.concat([err,chunk]);
  try{
   let at;while((at=err.indexOf(10))>=0){
    const line=new TextDecoder('utf-8',{fatal:true}).decode(err.subarray(0,at));err=err.subarray(at+1);
    const parts=line.split(' ');if(parts[1]!==nonce)throw Error();
    if(parts[0]==='GUEST_SPAWNED'&&parts.length===3&&!spawned&&!terminal&&!noChild&&/^[1-9][0-9]{0,9}$/.test(parts[2]))spawned=Number(parts[2]);
    else if(parts[0]==='GUEST_CLOSED'&&parts.length===6&&spawned===Number(parts[2])&&!terminal&&!noChild&&((parts[3]==='exit'&&/^(0|[1-9][0-9]{0,2})$/.test(parts[4])&&Number(parts[4])<=255)||(parts[3]==='signal'&&/^SIG[A-Z0-9]+$/.test(parts[4])))&&/^(EOF|STOP|PARENT_EOF|SIGTERM|SIGINT|SIGHUP|AUTH_REPEAT|INPUT_FAILED|INPUT_REJECTED|OUTPUT_LIMIT)$/.test(parts[5]))terminal={kind:parts[3],value:parts[4],reason:parts[5]};
    else if(parts[0]==='GUEST_NO_CHILD'&&parts.length===3&&!spawned&&!terminal&&!noChild&&/^(INPUT_REJECTED|CREDENTIAL_REJECTED|SPAWN_FAILED|SIGTERM|SIGINT|SIGHUP)$/.test(parts[2]))noChild=parts[2];
    else if(parts[0]==='GUEST_ERROR'&&parts.length===3&&spawned&&!terminal&&parts[2]==='OUTPUT_REJECTED')operationError??=Error('Guest SSH output rejected.');
    else throw Error();
   }
  }catch{broken('Guest SSH receipt rejected.');}
 }
 async function verifyPin(){
  const parent=dirname(knownHosts),dir=await lstat(parent,{bigint:true}),before=await lstat(knownHosts,{bigint:true});
  if(!dir.isDirectory()||dir.uid!==BigInt(process.getuid())||(dir.mode&0o077n)||await realpath(parent)!==parent||!before.isFile()||before.uid!==BigInt(process.getuid())||before.nlink!==1n||(before.mode&0o077n)||before.size<1n||before.size>65536n)throw Error('Guest SSH host pin is unsafe.');
  const file=await open(knownHosts,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   if(stamp(await file.stat({bigint:true}))!==stamp(before))throw Error('Guest SSH host pin changed.');
   const buffer=Buffer.alloc(65537),{bytesRead}=await file.read(buffer,0,buffer.length,0);
   if(BigInt(bytesRead)!==before.size||createHash('sha256').update(buffer.subarray(0,bytesRead)).digest('hex')!==knownHostsSHA256||stamp(await file.stat({bigint:true}))!==stamp(before)||stamp(await lstat(knownHosts,{bigint:true}))!==stamp(before))throw Error('Guest SSH host pin changed.');
   const after=await lstat(parent,{bigint:true});if(after.dev!==dir.dev||after.ino!==dir.ino||after.mode!==dir.mode||await realpath(parent)!==parent)throw Error('Guest SSH pin directory changed.');
  }finally{await file.close();}
 }
 async function verifySource(){
  const before=await lstat(source,{bigint:true});active();
  if(!before.isFile()||![0n,BigInt(process.getuid())].includes(before.uid)||before.nlink!==1n||(before.mode&0o022n)||before.size!==BigInt(sourceBytes)||await realpath(source)!==source)throw Error('Guest SSH upload source is unsafe.');
  active();sourceFile=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);active();sourceStamp=stamp(before);
  if(stamp(await sourceFile.stat({bigint:true}))!==sourceStamp)throw Error('Guest SSH upload source changed.');
  const hash=createHash('sha256'),buffer=Buffer.alloc(262144);let position=0;
  // Positional reads preserve offset zero for SSH's inherited file descriptor.
  while(position<sourceBytes){active();const {bytesRead}=await sourceFile.read(buffer,0,Math.min(buffer.length,sourceBytes-position),position);if(!bytesRead)throw Error('Guest SSH upload source changed.');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
  active();if(hash.digest('hex')!==sourceSHA256||stamp(await sourceFile.stat({bigint:true}))!==sourceStamp||stamp(await lstat(source,{bigint:true}))!==sourceStamp||await realpath(source)!==source)throw Error('Guest SSH upload source changed or digest differs.');
 }
 async function closeSource(check=false){
  if(!sourceFile)return;
  try{if(check&&(stamp(await sourceFile.stat({bigint:true}))!==sourceStamp||stamp(await lstat(source,{bigint:true}))!==sourceStamp||await realpath(source)!==source))throw Error();}
  catch{operationError??=Error('Guest SSH upload source changed.');}
  finally{try{await sourceFile.close();sourceFile=null;}catch{fault??=Error('Guest SSH source closure is unconfirmed.');}}
 }
 async function finish(code,sig){
  childClosed=true;await closeSource(mode==='upload');
  settled=true;clearTimeout(workTimer);clearTimeout(shutdownTimer);signal.removeEventListener('abort',abort);
  if(!outEnded||!errEnded||err.length||sig!==null||(!noChild&&(code!==0||!terminal))||(noChild&&code!==64))fault??=Error('Guest SSH physical closure is unconfirmed.');
  if(fault){closed.reject(fault);result.reject(fault);return;}
  closed.resolve(Object.freeze({closed:true,nonce,helperPid:child.pid,sshPid:mode==='upload'?null:spawned??null,...(mode==='upload'?{launcherPid:spawned??null}:{}),launched:Boolean(spawned)}));
  try{
   if(operationError)throw operationError;
   if(requested)throw stopped();
   if(noChild)throw Error('Guest SSH setup rejected.');
   if(terminal.reason!=='EOF')throw Error(`Guest SSH ${terminal.reason.toLowerCase().replaceAll('_',' ')}.`);
   if(mode==='forward'||terminal.kind!=='exit')throw Error('Guest SSH exited unexpectedly.');
   const stdout=new TextDecoder('utf-8',{fatal:true}).decode(out);if(stdout.includes(credential))throw Error('Guest SSH output rejected.');
   if(mode==='upload'){
    const receipt=`GUEST_UPLOAD ${nonce} ${sourceBytes} ${sourceSHA256}\n`;
    if(Number(terminal.value)!==0)throw Error('Guest SSH upload verification failed (remote exit '+terminal.value+'; '+out.length+' output bytes; SHA256 '+createHash('sha256').update(out).digest('hex')+').');
    if(stdout!==receipt&&stdout!=='\n'+receipt)throw Error('Guest SSH upload verification failed (receipt mismatch; '+out.length+' output bytes; SHA256 '+createHash('sha256').update(out).digest('hex')+').');
    result.resolve(Object.freeze({path:stage+'/payload',bytes:sourceBytes,sha256:sourceSHA256}));
   }else result.resolve(Object.freeze({exitCode:Number(terminal.value),stdout}));
  }catch(error){result.reject(error);}finally{out=Buffer.alloc(0);}
 }
 void (async()=>{
  try{
   active();if(mode==='upload')workTimer=setTimeout(()=>{operationError??=Error('Guest SSH upload deadline exceeded.');void stop();},timeoutMs);
   await verifyPin();active();await verifyGuestSSHHelper();active();
   if(mode==='upload'){await verifySource();active();}
   // Store the actual handle and attach all observers before writing credentials.
   child=spawn('/usr/bin/expect',['-N','-n',helper,nonce,mode,address,user,knownHosts,guestId,mode==='forward'?String(hostPort):command,mode==='forward'?String(guestPort):''],{cwd:dirname(knownHosts),env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:dirname(knownHosts),LC_ALL:'C'},stdio:mode==='upload'?['pipe','pipe','pipe','ignore',sourceFile.fd]:['pipe','pipe','pipe']});
   child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{if(out.length+chunk.length>1048576){broken('Guest SSH output limit exceeded.');return;}out=Buffer.concat([out,chunk]);});
   child.stderr.on('data',diagnostics);child.stdout.once('end',()=>outEnded=true);child.stderr.once('end',()=>errEnded=true);
   child.stdout.on('error',()=>broken('Guest SSH output failed.'));child.stderr.on('error',()=>broken('Guest SSH diagnostics failed.'));
   child.once('error',()=>broken('Guest SSH helper failed.'));child.once('close',finish);
   child.stdin.write(credential+'\n',error=>{if(error&&!settled)broken('Guest SSH credential pipe failed.');});
   if(mode==='command')workTimer=setTimeout(()=>{operationError??=Error('Guest SSH command deadline exceeded.');void stop();},timeoutMs);
  }catch(error){
   if(child){broken('Guest SSH startup failed.');return;}
   await closeSource();settled=true;clearTimeout(workTimer);clearTimeout(shutdownTimer);signal.removeEventListener('abort',abort);result.reject(fault??operationError??error);
   if(fault)closed.reject(fault);else closed.resolve(Object.freeze({closed:true,nonce,helperPid:null,sshPid:null,launched:false}));
  }
 })();
 return Object.freeze({result:result.promise,closed:closed.promise,stop});
}
