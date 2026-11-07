import {open,lstat,realpath,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,normalize,join,dirname} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {spawn} from 'node:child_process';
import {createServer,createConnection} from 'node:net';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {startGuestInstall} from './guest-install.mjs';
import {startMacGuest,bootPolicy} from './macos-guest.mjs';
import {startGuestKeyExtraction} from './guest-key.mjs';
import {startGuestSSH,verifyGuestSSHHelper} from './guest-ssh.mjs';
import {prepareGuestWorkspace,publishGuestWorkspace,prepareHostGitWorkspace,verifyHostGitWorkspace,refreshHostGitWorkspace,guestWorkspaceRepository} from './guest-workspace.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const gitFiles=Object.freeze({'Git/bin/git':'9a1c8fc68dc75e1b3c0cd8e5ad9d13ac9bc92cb53c9578b3cff4beaf2e9b1e70','Git/XcodeAcknowledgments.pdf':'08d855918383e2b661381a593c0a7d1f4760a19b393b982d5ba11f930e1a81f1'});
const nodeFiles=Object.freeze({'Node/bin/node':'3c9448363b9976bf3d9e8f4d320397975800131b42c7b1be342dadc05871dd25','Node/LICENSE':'148eacf7863ef4329224a29398623077200a27194aa075569faf4a0a85566ca5'});
const pathOK=v=>typeof v==='string'&&isAbsolute(v)&&normalize(v)===v&&v.length<=4096&&!/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(v);
const sha=v=>createHash('sha256').update(v).digest('hex');
const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
const overlaps=(a,b)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
const require=(ok,message)=>{if(!ok)throw Error('Guest executor: '+message);};
const identity=s=>({dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode),uid:Number(s.uid)});
const same=(a,b)=>isDeepStrictEqual(a,b);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};};
const errorOf=e=>e instanceof Error?e:Error('Guest executor operation failed.');

function configuration(value){
 const c=structuredClone(value);
 require(c&&pathOK(c.runtimeDir)&&pathOK(c.image)&&c.helpers&&['install','vm','key'].every(k=>pathOK(c.helpers[k])),'invalid trusted paths');
 require(c.resources&&Object.keys(c.resources).sort().join()==='cpu,diskBytes,memoryBytes'&&Object.values(c.resources).every(n=>Number.isSafeInteger(n)&&n>0)&&c.resources.memoryBytes%1048576===0&&c.resources.diskBytes%1048576===0,'invalid resources');
 require(c.account&&Object.keys(c.account).sort().join()==='fullName,user','invalid account');
 bootPolicy({...c.account,maximumRunSeconds:c.provisionSeconds});
 require(Number.isSafeInteger(c.startupTimeoutMs)&&c.startupTimeoutMs>0&&c.startupTimeoutMs<=2147483647&&Number.isSafeInteger(c.guestPort)&&c.guestPort>0&&c.guestPort<=65535,'invalid startup bounds');
 const b=c.bundle;
 require(b&&pathOK(b.path)&&Number.isSafeInteger(b.bytes)&&b.bytes>0&&b.bytes<Number.MAX_SAFE_INTEGER&&digest(b.sha256)&&b.files&&typeof b.files==='object'&&!Array.isArray(b.files)&&typeof b.version==='string'&&/^[\x20-\x7e]{1,200}$/.test(b.version),'invalid reviewed bundle');
 const names=Object.keys(b.files),folded=new Set();require(names.length>0&&names.length<=128,'invalid bundle file count');
 for(const name of names){
  require((name==='native'||name.startsWith('CodexCLI.app/Contents/')||Object.hasOwn(gitFiles,name)||Object.hasOwn(nodeFiles,name))&&name.length<=1024&&name.split('/').every(p=>/^[A-Za-z0-9_.+-]+$/.test(p)&&p!=='.'&&p!=='..')&&digest(b.files[name]),'invalid bundle member');
  const key=name.toLowerCase();require(!folded.has(key),'aliased bundle member');folded.add(key);
 }
 for(const name of ['CodexCLI.app/Contents/MacOS/codex','CodexCLI.app/Contents/Info.plist','CodexCLI.app/Contents/_CodeSignature/CodeResources','native'])require(Object.hasOwn(b.files,name),'required bundle member is absent');
 if(Object.keys(gitFiles).some(name=>Object.hasOwn(b.files,name)))for(const [name,hash] of Object.entries(gitFiles))require(b.files[name]===hash,'pinned Git runtime member is missing or changed');
 if(Object.keys(nodeFiles).some(name=>Object.hasOwn(b.files,name))){
  for(const [name,hash] of Object.entries(nodeFiles))require(b.files[name]===hash,'pinned Node runtime member is missing or changed');
  require(Object.keys(gitFiles).every(name=>b.files[name]===gitFiles[name]),'Node runtime requires the pinned Git runtime');
 }
 for(const name of names)require(!names.some(other=>other!==name&&other.startsWith(name+'/')),'bundle file is an ancestor');
 return freeze(c);
}

// The resource is retained before startup can acquire a native handle. Only the
// existing engine's authenticated environment/sidecar admission admits chat work.
export function openGuestExecutor(context,options,callbacks){
 const {ownerId,generation,cwd,dataDir,signal,nativeHelper}=context??{};
 const controller=new AbortController(),cancel=deferred(),resources=[],files=[],writes=new Set(),operations=new Set();
 let config,admission,validation,onProvisioningReady,rootFile,root,receipts,allocation,hostIdentity,binding,guestHome,guestGit,guestTemporary,temporaryRequest,temporaryEntry,preparation,prepared,publication,fenced=false,admitted=false,stopping=false,retirement,unknown,timer,startup,workerSequence=0;
 try{
  onProvisioningReady=callbacks?.onProvisioningReady;require(typeof onProvisioningReady==='function','trusted provisioning callback is required');
  require(signal instanceof AbortSignal,'owner cancellation signal is required');
  if(!signal.aborted){require(uuid.test(ownerId)&&uuid.test(generation)&&pathOK(cwd)&&pathOK(dataDir)&&typeof context.publish==='function','invalid owner context');config=configuration(options);
   guestHome='/Users/'+config.account.user+'/.saleh-executor-'+ownerId+'-'+generation;
   require(cwd!=='/'&&![config.runtimeDir,dataDir,guestHome].some(path=>overlaps(cwd,path)),'workspace overlaps protected executor or owner data');
   if(['resources','runtime','recordAllocation'].some(key=>Object.hasOwn(context,key))){
    const runtime=context.runtime;require(same(context.resources,config.resources)&&runtime&&Object.keys(runtime).sort().join()==='identity,path'&&runtime.path===config.runtimeDir&&runtime.identity&&(isFilesystemIdentity(runtime.identity)?pathOK(nativeHelper):Object.keys(runtime.identity).sort().join()==='dev,ino'&&Object.values(runtime.identity).every(v=>typeof v==='string'&&/^\d{1,30}$/.test(v)))&&typeof context.recordAllocation==='function','admitted resources or runtime differ from configuration');
    admission={runtime:freeze(structuredClone(runtime)),record:context.recordAllocation};
   }
  }
 }catch(error){validation=errorOf(error);}
 const active=()=>{if(fenced||signal?.aborted)throw Error('Guest executor stopped.');if(unknown)throw unknown;};
 // Observations do not grant authority, certify completion, or fail startup.
 const progress=(stage,fraction)=>{if(!fenced&&!signal?.aborted)try{callbacks?.onStartupProgress?.(stage,fraction);}catch{}};
 function stopOne(row){
  if(!row.stop){row.expected=true;try{row.stop=Promise.resolve(row.handle.stop());}catch(error){row.stop=Promise.reject(error);}void row.stop.catch(()=>{});}
  return row.stop;
 }
 function fence(reason=Error('Guest executor stopped.')){fenced=true;binding=undefined;cancel.reject(reason);}
 function requestStop(reason=Error('Guest executor stopped.')){
  fence(reason);if(!stopping){stopping=true;controller.abort();}
  for(const row of resources)stopOne(row);
 }
 function failed(error){unknown??=errorOf(error);requestStop(unknown);void retire().catch(()=>{});}
 function own(kind,handle,monitor=false){
  const row={kind,handle,expected:false};resources.push(row);
  require(handle&&typeof handle.stop==='function'&&handle.closed&&typeof handle.closed.then==='function','invalid acquired resource');
  row.closed=Promise.resolve(handle.closed);void row.closed.catch(()=>{});
  for(const promise of [handle.ready,handle.result])if(promise?.then)void promise.catch(()=>{});
  void row.closed.then(()=>{if(monitor&&!row.expected&&!stopping)failed(Error('Guest executor '+kind+' closed unexpectedly.'));},error=>{if(!stopping)failed(error);});
  if(stopping)stopOne(row);return row;
 }
 async function drained(row){
  const stopped=await stopOne(row),closed=await row.closed;
  require(same(stopped,closed)&&(closed?.closed===true||closed?.closureConfirmed===true),'resource Stop differs from physical closure');
  if(['installation','provisioning','key','execution'].includes(row.kind))require(closed.ownerId===ownerId&&closed.generation===generation,'resource closure owner changed');
  return closed;
 }
 function retire(){
  requestStop();
  if(!retirement){retirement=(async()=>{
   await startup?.catch(()=>{});
   const results=await Promise.allSettled(resources.map(drained));
   // Stop resources first, then retain the original workspace callbacks until
   // they settle. A cancelled operation is distinct from failed physical closure.
   await Promise.allSettled([...operations]);
   const persisted=await Promise.allSettled([...writes]);
   const closedFiles=await Promise.allSettled(files.filter(f=>f.closing).map(f=>f.closing));
   const failures=[...results,...persisted,...closedFiles].filter(r=>r.status==='rejected').map(r=>errorOf(r.reason));
   if(resources.some(r=>!r.closed))failures.push(Error('Acquired guest resource closure is unknown.'));
   if(failures.length)throw new AggregateError(failures,'Guest executor retirement is unconfirmed; original root descriptor retained.');
   // Bootstrap/SSH validation can fail with every resource nevertheless closed.
   // Wrapper Stop rejections above always remain failures, regardless of text.
    const executionIndex=resources.findIndex(row=>row.kind==='execution'),execution=results[executionIndex]?.value,proof=execution?.spentExecution;
    let revoked=false;
    if(admitted&&proof){
     const claim=execution.claim,terminal=execution.terminal,stamp=proof.claimIdentity;
     require(execution.launched===true&&execution.closureConfirmed===true&&execution.outputClosed===true&&execution.exitCode===0&&execution.exitSignal===null&&digest(execution.claimSHA256)&&claim?.ownerId===ownerId&&claim?.generation===generation&&same(claim.root,root.identity)&&/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/.test(claim.guestId)&&/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/.test(claim.epoch)&&claim.executionAdmitted===true&&claim.trustedProvisioningOnly===false&&claim.provisioning===false&&claim.restartAllowed===false,'spent execution identity differs from admission');
     require(terminal?.event==='stop-completed'&&['ownerId','generation','guestId','epoch'].every(key=>terminal[key]===claim[key])&&terminal.claimSHA256===execution.claimSHA256&&terminal.reason==='parent Stop'&&terminal.state===0&&terminal.closureConfirmed===true&&terminal.started===true&&terminal.cancelledBeforeBoot!==true&&terminal.faulted===false&&terminal.productionContainment===false&&terminal.errorCode===0&&terminal.errorDomain==='','spent execution terminal is not successful closure');
     require(Object.keys(proof).sort().join()==='claimIdentity,terminalSHA256'&&digest(proof.terminalSHA256)&&stamp&&Object.keys(stamp).sort().join()==='ctime,dev,ino,mode,mtime,nlink,size,uid'&&Object.values(stamp).every(value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,29})$/.test(value))&&stamp.mode===String(0o100600)&&stamp.uid===String(process.getuid())&&stamp.nlink==='1'&&BigInt(stamp.size)>0n&&BigInt(stamp.size)<=65536n,'invalid spent execution proof');
     const reverify=resources[executionIndex].handle.reverifySpentExecution;
     require(typeof reverify==='function'&&same(await reverify.call(resources[executionIndex].handle),proof),'spent execution proof could not be reverified');
     await verifyDir(root);await verifyDir(allocation);
     // This receipt records the proof basis, not descriptor closure or recovery.
     // Only the original retirement promise can return revocation after FD close.
     const stable=isFilesystemIdentity(admission?.runtime.identity),rootIdentity=await persistedDirectory(root),allocationIdentity=await persistedDirectory(allocation);
     let claimIdentity=stamp;
     if(stable){
      require(claim.version===2&&sameFilesystemIdentity(claim.filesystem?.root,{volumeUUID:rootIdentity.volumeUUID,ino:rootIdentity.ino}),'durable execution root changed');
      const filesystem=await readFilesystemIdentity({path:join(root.path,'boot-claim.json'),nativeHelper});
      require(filesystem.ino===stamp.ino,'durable execution claim changed');const {dev,...rest}=stamp;claimIdentity={...rest,...filesystem};
     }
     await durable(receipts,'retirement.json',{version:stable?2:1,ownerId,generation,allocation:allocationIdentity,root:rootIdentity,guestId:claim.guestId,epoch:claim.epoch,claimSHA256:execution.claimSHA256,claimIdentity,terminalSHA256:proof.terminalSHA256,restartAllowed:false});
     require(same(await reverify.call(resources[executionIndex].handle),proof),'spent execution proof changed during retirement durability');
     revoked=true;
    }
   for(const file of files)if(file!==root&&!file.closed)await closeFile(file);
   if(root&&!root.closed)await closeFile(root);
    return Object.freeze({ownerId,generation,closed:true,revoked});
  })();void retirement.catch(()=>{});}
  return retirement;
 }
 function holdFile(handle){const file={handle,closed:false,closing:null};files.push(file);return file;}
 function closeFile(file){
  if(!file.closing){file.closing=Promise.resolve().then(()=>file.handle.close()).then(()=>{file.closed=true;});void file.closing.catch(()=>{});}
  return file.closing;
 }
 async function directory(path,privateMode=true){
  const s=await lstat(path,{bigint:true});require(s.isDirectory()&&await realpath(path)===path&&(!privateMode||s.uid===BigInt(process.getuid())&&(s.mode&0o777n)===0o700n),'directory is not canonical and private');return identity(s);
 }
 async function retain(path){
  const expected=await directory(path),handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  const file=holdFile(handle);require(same(identity(await handle.stat({bigint:true})),expected)&&same(await directory(path),expected),'retained directory changed');return Object.assign(file,{path,identity:expected});
 }
 async function persistedDirectory(dir){
  await verifyDir(dir);if(!isFilesystemIdentity(admission?.runtime.identity))return dir.identity;
  const filesystem=await readFilesystemIdentity({path:dir.path,nativeHelper});await verifyDir(dir);
  require(filesystem.ino===dir.identity.ino,'durable directory identity changed');return {...filesystem,mode:dir.identity.mode,uid:dir.identity.uid};
 }
 async function verifyDir(dir){require(same(await directory(dir.path),dir.identity)&&same(identity(await dir.handle.stat({bigint:true})),dir.identity),'allocation directory changed');}
 function durable(dir,name,value,limit=1024*1024){
  const work=(async()=>{
   await verifyDir(dir);const bytes=Buffer.from(JSON.stringify(value)+'\n');require(bytes.length<=limit,'claim receipt exceeds its bound');
   const file=holdFile(await open(join(dir.path,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));
   try{await file.handle.writeFile(bytes);await file.handle.sync();}finally{await closeFile(file);}
   await verifyDir(dir);await dir.handle.sync();
  })();writes.add(work);void work.catch(()=>{});return work;
 }
 const record=name=>value=>durable(receipts,name+'.json',value);
 async function temporaryOperation(action,input){
  active();require(guestTemporary&&admitted,'guest temporary helper is not ready');
  const request=structuredClone(input),keys=action==='create'?['cwd','nonce']:['cwd','path','nonce','projectDev','projectIno','dev','ino'];
  require(['create','verify'].includes(action)&&request&&Object.keys(request).sort().join()===keys.sort().join()&&request.cwd===cwd&&uuid.test(request.nonce),'invalid guest temporary request');
  if(action==='create'){
   require(!temporaryRequest,'guest temporary allocation was already attempted');temporaryRequest=request;
  }else require(temporaryEntry&&same(request,temporaryEntry),'guest temporary identity differs');
  const result=await guestTemporary(action,request);active();
  if(action==='create'){
   require(result&&Object.keys(result).sort().join()==='cwd,dev,ino,nonce,path,projectDev,projectIno'&&result.cwd===cwd&&result.nonce===request.nonce&&pathOK(result.path)&&dirname(result.path)===cwd&&/^\.saleh-coding-tmp-[A-Za-z0-9_-]+$/.test(result.path.slice(cwd.length+1))&&['projectDev','projectIno','dev','ino'].every(k=>typeof result[k]==='string'&&/^\d{1,30}$/.test(result[k])),'invalid guest temporary receipt');
   temporaryEntry=freeze(structuredClone(result));await durable(receipts,'scratch.json',{ownerId,generation,scope:'guest',entry:temporaryEntry});active();
  }else require(same(result,{verified:true}),'guest temporary verification failed');
  return structuredClone(result);
 }
 async function verifyHost(){
  const current=await directory(cwd,false);require(!hostIdentity||same(current,hostIdentity),'host workspace identity changed');
  hostIdentity=current;
 }
 function retainOperation(work){operations.add(work);void work.then(()=>operations.delete(work),()=>operations.delete(work));return work;}
 const checkpoint=(name,data)=>durable(receipts,'workspace-'+name+'.json',{version:1,ownerId,generation,data},32*1024*1024);
 function nativeFor(operation){
  return (action,input,options={})=>{
   if(!['copy','materialize','publish'].includes(action))return operation.native(action,input,options);
   const id=++workerSequence;let recorded;
   return operation.native(action,input,{...options,
    record:async(process,ownership)=>{require(!recorded,'workspace native worker already recorded');recorded={process,ownership};await checkpoint('worker-'+id,recorded);},
    closed:ownership=>checkpoint('worker-'+id+'-closed',{ownership,recorded:!!recorded})});
  };
 }
 function prepare(operation){
  active();if(preparation)return preparation;
  preparation=retainOperation(Promise.resolve().then(async()=>{
   active();require(admitted&&temporaryEntry&&typeof operation?.native==='function'&&typeof operation.check==='function'&&operation.engine?.processLife===operation.life,'workspace preparation admission is missing');
   operation.check();await temporaryOperation('verify',temporaryEntry);operation.check();await verifyHost();operation.check();
   const directory=join(allocation.path,'workspace');await mkdir(directory,{mode:0o700});await verifyDir(allocation);await allocation.handle.sync();operation.check();
   let snapshot;const gitWorkers=new Map();
   const snapshotGit=()=>{
    require(guestGit&&typeof operation.snapshotGit==='function','Git snapshot preparation requires the admitted private runtime and owner capability');
    if(!snapshot)snapshot=Promise.resolve().then(async()=>{
     operation.check();await verifyDir(allocation);operation.check();
     return operation.snapshotGit({directory:join(allocation.path,'git-snapshot')},{
      record:async(process,ownership)=>{
       require(ownership?.ownerId===ownerId&&ownership.generation===generation&&ownership.action==='git-snapshot'&&digest(ownership.requestHash)&&!gitWorkers.has(ownership.requestHash),'Git worker ownership is invalid or duplicated');
       const row={id:++workerSequence,process,ownership:structuredClone(ownership),closed:false};gitWorkers.set(ownership.requestHash,row);
       await checkpoint('git-worker-'+row.id,{process,ownership});
      },
      closed:async ownership=>{
       const row=gitWorkers.get(ownership?.requestHash);require(row&&!row.closed&&same(row.ownership,ownership),'Git worker closure ownership differs');row.closed=true;
       await checkpoint('git-worker-'+row.id+'-closed',{ownership,recorded:true});
      }});
    });
    return snapshot;
   };
   const workspace=await prepareGuestWorkspace({...operation,native:nativeFor(operation),snapshotGit,gitPath:guestGit,hostRoot:{path:cwd,dev:hostIdentity.dev,ino:hostIdentity.ino},directory,scratch:temporaryEntry,guestHome,helper:guestHome+'/native',checkpoint});
   operation.check();active();prepared={workspace,threadId:operation.threadId,engine:operation.engine,life:operation.life};return Object.freeze({prepared:true});
  }));return preparation;
 }
 function publishChanges(request){
  active();require(prepared&&request&&Object.keys(request).join()==='threadId'&&request.threadId===prepared.threadId,'workspace publication requires its prepared root');
  if(publication)return publication;
  publication=retainOperation(Promise.resolve(context.publish({threadId:prepared.threadId,operation:operation=>{
   active();return publishGuestWorkspace({...operation,...prepared,native:nativeFor(operation),checkpoint});
  }})));
  const current=publication;void current.then(outcome=>{if(publication===current&&outcome?.renewed!==false)publication=null;},()=>{});
  return current;
 }
 function hostGitOperation(phase,operation,request={}){
  active();require(prepared&&!publication&&['prepare','verify','refresh'].includes(phase),'host Git coordination requires an idle prepared workspace');
  return retainOperation(Promise.resolve().then(async()=>{
   operation.check();active();await temporaryOperation('verify',temporaryEntry);await verifyHost();operation.check();
   let snapshot;const workers=new Map(),inspection=phase!=='refresh';
   const snapshotGit=()=>snapshot??=(inspection?operation.inspectGit:operation.snapshotGit)({directory:join(allocation.path,(inspection?'git-inspection-':'git-snapshot-')+randomUUID())},{
    record:async(process,ownership)=>{
     require(ownership?.ownerId===ownerId&&ownership.generation===generation&&ownership.action==='git-snapshot'&&digest(ownership.requestHash)&&!workers.has(ownership.requestHash),'host Git snapshot worker ownership differs');
     const row={id:++workerSequence,ownership:structuredClone(ownership),closed:false};workers.set(ownership.requestHash,row);await checkpoint('git-worker-'+row.id,{process,ownership});
    },
    closed:async ownership=>{const row=workers.get(ownership?.requestHash);require(row&&!row.closed&&same(row.ownership,ownership),'host Git snapshot closure differs');row.closed=true;await checkpoint('git-worker-'+row.id+'-closed',{ownership,recorded:true});}
   });
   const options={...operation,...prepared,...request,native:nativeFor(operation),...inspection?{inspectGit:snapshotGit}:{snapshotGit},gitPath:guestGit,checkpoint};
   const result=await (phase==='prepare'?prepareHostGitWorkspace(options):phase==='verify'?verifyHostGitWorkspace(options):refreshHostGitWorkspace(options));operation.check();active();return result;
  }));
 }
 async function pause(){
  active();await new Promise(resolve=>{const done=()=>{clearTimeout(t);controller.signal.removeEventListener('abort',done);resolve();},t=setTimeout(done,250);controller.signal.addEventListener('abort',done,{once:true});});active();
 }
 async function addressFor(mac){
  let file;try{file=holdFile(await open('/var/db/dhcpd_leases',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK));}catch(error){if(error.code==='ENOENT')return;throw error;}
  let text;try{const b=Buffer.alloc(1048577),{bytesRead}=await file.handle.read(b,0,b.length,0);require(bytesRead<=1048576,'DHCP lease database exceeds its bound');text=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,bytesRead));}finally{await closeFile(file);}
  active();require(!text.replace(/\{[^{}]*\}/g,'').trim(),'unrecognized DHCP lease database');const matches=[];
  for(const [,block] of text.matchAll(/\{([^{}]*)\}/g)){
   const row=Object.create(null);for(const line of block.split('\n').map(x=>x.trim()).filter(Boolean)){const at=line.indexOf('=');require(at>0&&!Object.hasOwn(row,line.slice(0,at)),'invalid DHCP lease row');row[line.slice(0,at)]=line.slice(at+1);}
   const match=/^1,([a-fA-F0-9:]+)$/.exec(row.hw_address??''),octets=match?.[1].split(':');
   if(octets?.length!==6||octets.some(x=>!/^[a-fA-F0-9]{1,2}$/.test(x))||octets.map(x=>x.padStart(2,'0').toLowerCase()).join(':')!==mac.toLowerCase())continue;
   const lease=Number(row.lease);require(Number.isFinite(lease),'invalid DHCP lease expiration');if(lease<=Date.now()/1000)continue;
   const ip=row.ip_address?.split('.');require(ip?.length===4&&ip.every(x=>/^(0|[1-9][0-9]{0,2})$/.test(x)&&Number(x)<=255)&&(Number(ip[0])===10||Number(ip[0])===172&&Number(ip[1])>=16&&Number(ip[1])<=31||Number(ip[0])===192&&Number(ip[1])===168),'guest lease is not a private IPv4 address');matches.push(row.ip_address);
  }
  require(matches.length<=1,'ambiguous guest lease');return matches[0];
 }
 function scan(address){
  active();const child=spawn('/usr/bin/ssh-keyscan',['-T','3','-t','ed25519',address],{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
  const closed=deferred(),result=deferred();let bytes=0,errors=0,fault,outEnded=false,errEnded=false,done=false,killTimer;
  const stop=()=>{if(!done){child.kill('SIGTERM');killTimer??=setTimeout(()=>{if(!done)child.kill('SIGKILL');},2000);}return closed.promise;};
  const row=own('keyscan',{closed:closed.promise,result:result.promise,stop});
  const t=setTimeout(()=>{fault=Error('Guest keyscan deadline exceeded.');stop();},8000);
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>8192){fault=Error('Guest keyscan output exceeds its bound.');stop();}});
  child.stderr.on('data',b=>{errors+=b.length;if(errors>8192){fault=Error('Guest keyscan diagnostics exceed their bound.');stop();}});
  child.stdout.once('end',()=>outEnded=true);child.stderr.once('end',()=>errEnded=true);
  for(const stream of [child.stdout,child.stderr])stream.on('error',()=>{fault=Error('Guest keyscan stream failed.');stop();});
  child.once('error',()=>{fault=Error('Guest keyscan could not run.');});
  child.once('close',(code,sig)=>{
   done=true;clearTimeout(t);clearTimeout(killTimer);
   if(!outEnded||!errEnded){const e=Error('Guest keyscan physical closure is unconfirmed.');closed.reject(e);result.reject(e);return;}
   closed.resolve(Object.freeze({closed:true,pid:child.pid??null,code,signal:sig}));
   if(fault)result.reject(fault);else result.resolve(code===0&&bytes>0);
  });return row;
 }
 async function freePort(){
  active();const server=createServer(),ready=deferred(),closed=deferred(),stopped=deferred();
  let listenSettled=false,requested=false,closing=false,port=null;
  const stop=()=>{
   requested=true;
   if(listenSettled&&!closing){
    closing=true;
    try{server.close(error=>{if(error)stopped.reject(error);else void closed.promise.then(stopped.resolve,stopped.reject);});}
    catch(error){stopped.reject(error);}
   }
   return stopped.promise;
  };
  const row=own('port reservation',{closed:closed.promise,stop});
  server.once('close',()=>closed.resolve(Object.freeze({closed:true,port})));
  server.once('error',error=>{listenSettled=true;ready.reject(error);stop();});
  try{
   server.listen(0,'127.0.0.1',()=>{
    listenSettled=true;
    try{port=server.address().port;ready.resolve(port);}catch(error){ready.reject(error);}
    if(requested)stop();
   });
   const value=await ready.promise;active();return value;
  }catch(error){listenSettled=true;throw error;}
  finally{await drained(row);}
 }
 async function connected(port){
  active();return await new Promise(resolve=>{
   const socket=createConnection({host:'127.0.0.1',port});let ok=false;
   const close=()=>socket.destroy(),t=setTimeout(close,500);controller.signal.addEventListener('abort',close,{once:true});
   socket.once('connect',()=>{ok=true;close();});socket.once('error',close);
   socket.once('close',()=>{clearTimeout(t);controller.signal.removeEventListener('abort',close);resolve(ok);});
  });
 }
 startup=Promise.resolve().then(async()=>{
  if(validation)throw validation;active();
  timer=setTimeout(()=>failed(Error('Guest executor startup deadline exceeded.')),config.startupTimeoutMs);
  await verifyGuestSSHHelper();active();
  const runtime=await retain(config.runtimeDir);active();await verifyHost();active();
  if(admission){const current=await persistedDirectory(runtime);active();require(isFilesystemIdentity(admission.runtime.identity)?sameFilesystemIdentity({volumeUUID:current.volumeUUID,ino:current.ino},admission.runtime.identity):same({dev:current.dev,ino:current.ino},admission.runtime.identity),'admitted runtime identity changed');}
  const allocationPath=join(config.runtimeDir,ownerId+'-'+generation);await mkdir(allocationPath,{mode:0o700});active();
  allocation=await retain(allocationPath);active();await verifyDir(runtime);await runtime.handle.sync();
  if(admission){const {mode,uid,...identity}=await persistedDirectory(allocation);active();await admission.record({path:allocationPath,identity});active();await verifyDir(allocation);await verifyDir(runtime);}
  await mkdir(join(allocationPath,'guest'),{mode:0o700});active();await mkdir(join(allocationPath,'receipts'),{mode:0o700});active();
  root=await retain(join(allocationPath,'guest'));rootFile=root.handle;active();receipts=await retain(join(allocationPath,'receipts'));active();
  const persistedRoot=await persistedDirectory(root);active();
  await durable(allocation,'allocation.json',{version:isFilesystemIdentity(admission?.runtime.identity)?2:1,ownerId,generation,cwd,hostIdentity,root:persistedRoot,resources:config.resources,account:config.account,bundle:{bytes:config.bundle.bytes,sha256:config.bundle.sha256,files:config.bundle.files,version:config.bundle.version},restartAllowed:false});active();
  const common={root:root.path,rootFD:rootFile.fd,ownerId,generation,signal:controller.signal,nativeHelper:isFilesystemIdentity(admission?.runtime.identity)?nativeHelper:undefined};
  const installation=own('installation',startGuestInstall({...common,helper:config.helpers.install,image:config.image,resources:config.resources,recordClaim:record('installation'),onProgress:fraction=>progress('installing',fraction)}));
  progress('installing');
  const installed=await installation.handle.result;active();const installationClosed=await drained(installation);active();
  const fixture=installed.fixture,acquisition={result:installed,closed:installationClosed};
  require(fixture&&/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/.test(fixture.guestId)&&/^(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/.test(fixture.macAddress)&&typeof fixture.build==='string'&&/^[A-Za-z0-9.]{1,80}$/.test(fixture.build),'invalid installed guest identity');
  const credential=randomBytes(36).toString('base64url'),authToken=randomBytes(32).toString('base64url');
  const provisioning=own('provisioning',startMacGuest({...common,helper:config.helpers.vm,credential,phase:'provision',installation:acquisition,policy:{...config.account,maximumRunSeconds:config.provisionSeconds},recordClaim:record('provisioning')}),true);
  progress('booting');
  const phase=(name,data={})=>durable(receipts,'startup-phase-'+name+'.json',{version:1,ownerId,generation,guestId:fixture.guestId,phase:name,...data},1024);
  await provisioning.handle.ready;active();await phase('ready-resolved');active();
  progress('waiting-connection');
  let addressObserved=false,scanObserved=false;
  for(;;){
   active();const address=await addressFor(fixture.macAddress);
   if(address){
    if(!addressObserved){await phase('address-found');addressObserved=true;active();}
    const first=!scanObserved,probe=scan(address);scanObserved=true;let available;
    try{available=await probe.handle.result;}
    catch(error){await phase('scan-rejected').catch(()=>{});throw error;} // Keep the original failure; durable rejection still blocks retirement.
    const observed=first?'scan-first':available?'scan-ready':null;
    if(observed)await phase(observed+'-result',{available});
    await drained(probe);active();if(observed){await phase(observed+'-drained');active();}
    if(available)break;
   }
   await pause();
  }
  // Startup retains the original callback until it settles, even after Stop.
  await phase('callback-entered');active();let approved;
  try{approved=await onProvisioningReady(Object.freeze({ownerId,generation,guestId:fixture.guestId}),controller.signal);}
  catch(error){await phase('callback-rejected').catch(()=>{});throw error;}
  await phase('callback-settled',{accepted:approved===true});active();
  require(approved===true,'provisioning approval was not granted');
  progress('finishing-setup');
  provisioning.expected=true;
  const completed=await provisioning.handle.completeProvisioning();active();
  const provisionClosed=await drained(provisioning);
  require(same(completed,provisionClosed)&&provisionClosed.terminal?.reason==='provisioning complete','guest provisioning did not complete a verified clean shutdown');active();
  const key=own('key',startGuestKeyExtraction({...common,helper:config.helpers.key,provisioning:provisionClosed,recordClaim:record('key')}));
  const pin=await key.handle.result;await drained(key);active();
  const execution=own('execution',startMacGuest({...common,helper:config.helpers.vm,credential,phase:'execute',installation:acquisition,policy:{...config.account,maximumRunSeconds:0},recordClaim:record('execution')}),true);
  progress('booting');
  await execution.handle.ready;active();
  progress('waiting-connection');
  let address;while(!(address=await addressFor(fixture.macAddress)))await pause();active();
  const sshBase={address,user:config.account.user,guestId:fixture.guestId,knownHosts:pin.knownHosts,knownHostsSHA256:pin.knownHostsSHA256,credential,signal:controller.signal};
  async function command(text,timeoutMs=30000){
   active();const row=own('ssh',startGuestSSH({...sshBase,mode:'command',command:text,timeoutMs}));let result;
   try{result=await row.handle.result;}finally{await drained(row);}active();return result;
  }
  const nonce=randomUUID(),identityCommand=`/usr/bin/printf '%s\\n' ${quote(nonce)}; /usr/bin/id -un; /usr/bin/sw_vers -buildVersion; /sbin/ifconfig en0 | /usr/bin/awk '/ether / {print $2}'`;
  for(;;){
   let result;try{result=await command(identityCommand,15000);}catch(error){active();if(resources.some(r=>r.stop)&&await Promise.allSettled(resources.filter(r=>r.stop).map(r=>r.stop)).then(rs=>rs.some(r=>r.status==='rejected')))throw error;await pause();continue;}
   if(result.exitCode!==0){await pause();continue;}
   require(result.stdout.trim()===[nonce,config.account.user,fixture.build,fixture.macAddress.toLowerCase()].join('\n'),'pinned guest identity differs');break;
  }
  progress('finishing-setup');
  const upload=own('upload',startGuestSSH({...sshBase,mode:'upload',source:config.bundle.path,sourceBytes:config.bundle.bytes,sourceSHA256:config.bundle.sha256,timeoutMs:config.startupTimeoutMs}));
  const uploaded=await upload.handle.result;await drained(upload);active();
  require(uploaded&&/^\/private\/tmp\/saleh-upload-[a-f0-9-]{36}\/payload$/.test(uploaded.path)&&uploaded.bytes===config.bundle.bytes&&uploaded.sha256===config.bundle.sha256,'uploaded bundle receipt differs');
  const archive=quote(uploaded.path),expected=new Set(Object.keys(config.bundle.files));
  for(const name of Object.keys(config.bundle.files)){const parts=name.split('/');for(let n=1;n<parts.length;n++)expected.add(parts.slice(0,n).join('/')+'/');}
  const list=await command('/usr/bin/tar -tf '+archive);require(list.exitCode===0,'bundle member inspection failed');
  const members=list.stdout.trim().split('\n');require(members.length===expected.size&&new Set(members).size===members.length&&members.every(name=>expected.has(name)),'archive members differ from reviewed bundle');
  const types=await command('/usr/bin/tar -tvf '+archive);require(types.exitCode===0&&types.stdout.trim().split('\n').length===members.length&&types.stdout.trim().split('\n').every(line=>/^[-d][rwxStTs-]{9}\s/.test(line)),'archive contains unsupported entry types');
  const home=guestHome,cli=home+'/CodexCLI.app/Contents/MacOS/codex',sidecar=home+'/sidecar',verified=randomUUID();
  const gitBin=Object.hasOwn(config.bundle.files,'Git/bin/git')?home+'/Git/bin':null;
  const nodeBin=Object.hasOwn(config.bundle.files,'Node/bin/node')?home+'/Node/bin':null;
  const gitEnv=gitBin?{GIT_EXEC_PATH:gitBin,PATH:gitBin+(nodeBin?':'+nodeBin:'')+':/usr/bin:/bin:/usr/sbin:/sbin'}:{};
  const gitCheck=gitBin?`[ -f ${quote(gitBin+'/git')} ]; [ ! -L ${quote(gitBin+'/git')} ]; [ -f ${quote(home+'/Git/XcodeAcknowledgments.pdf')} ]; [ ! -L ${quote(home+'/Git/XcodeAcknowledgments.pdf')} ]; /usr/bin/codesign --verify --strict -R ${quote('=anchor apple and identifier "com.apple.git"')} ${quote(gitBin+'/git')}; `:'';
  const nodeCheck=nodeBin?`[ -f ${quote(nodeBin+'/node')} ]; [ ! -L ${quote(nodeBin+'/node')} ]; [ -x ${quote(nodeBin+'/node')} ]; [ -f ${quote(home+'/Node/LICENSE')} ]; [ ! -L ${quote(home+'/Node/LICENSE')} ]; /usr/bin/codesign --verify --strict -R ${quote('=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"')} ${quote(nodeBin+'/node')}; `:'';
  const checks=Object.entries(config.bundle.files).map(([name,hash])=>`[ "$(/usr/bin/shasum -a 256 ${quote(home+'/'+name)} | /usr/bin/awk '{print $1}')" = ${quote(hash)} ]`).join('; ');
  const unpack=`set -eu; umask 077; [ "$(/usr/bin/stat -f %z ${archive})" = ${config.bundle.bytes} ]; [ "$(/usr/bin/shasum -a 256 ${archive} | /usr/bin/awk '{print $1}')" = ${quote(config.bundle.sha256)} ]; /bin/mkdir -m 700 ${quote(home)}; /usr/bin/tar -xf ${archive} -C ${quote(home)}; /usr/bin/codesign --verify --strict ${quote(home+'/CodexCLI.app')}; /usr/bin/codesign --verify --strict ${quote(home+'/native')}; ${checks}; ${gitCheck}${nodeCheck}/usr/bin/printf '%s\\n' ${quote(verified)}`;
  const unpacked=await command(unpack,120000);require(unpacked.exitCode===0&&unpacked.stdout.trim()===verified,'signed bundle verification failed');
  const version=await command(quote(cli)+' --version');require(version.exitCode===0&&version.stdout.trim()===config.bundle.version,'guest CLI version differs');
  if(gitBin){const version=await command(`/usr/bin/env -i HOME=${quote(home)} GIT_EXEC_PATH=${quote(gitBin)} PATH=${quote(gitEnv.PATH)} ${quote(gitBin+'/git')} --version`);require(version.exitCode===0&&version.stdout.trim()==='git version 2.54.0 (Apple Git-157)','guest Git version differs');guestGit=gitBin+'/git';}
  if(nodeBin){const version=await command(`/usr/bin/env -i HOME=${quote(home)} PATH=${quote(gitEnv.PATH)} ${quote(nodeBin+'/node')} --version`);require(version.exitCode===0&&version.stdout.trim()==='v24.19.0','guest Node version differs');}
  const launched=randomUUID(),parent=dirname(cwd);
  const launch=`set -eu; umask 077; /bin/mkdir -m 700 ${quote(sidecar)}; /bin/mkdir -p ${quote(parent)}; [ "$(cd ${quote(parent)} && /bin/pwd -P)" = ${quote(parent)} ]; /bin/mkdir -m 700 ${quote(cwd)}; /usr/bin/env -i HOME=${quote(home)} CODEX_HOME=${quote(home)} ${gitBin?`GIT_EXEC_PATH=${quote(gitBin)} PATH=${quote(gitEnv.PATH)}`:'PATH=/usr/bin:/bin:/usr/sbin:/sbin'} /usr/bin/nohup ${quote(cli)} exec-server --listen ws://127.0.0.1:${config.guestPort} --ws-auth capability-token --ws-token-sha256 ${sha(authToken)} > ${quote(home+'/executor.log')} 2>&1 < /dev/null &\n/usr/bin/printf '%s\\n' ${quote(launched)}`;
  const launchResult=await command(launch);require(launchResult.exitCode===0&&launchResult.stdout.trim()===launched,'guest executor launch failed');
  const hostPort=await freePort();active();
  const tunnel=own('tunnel',startGuestSSH({...sshBase,mode:'forward',hostPort,guestPort:config.guestPort,timeoutMs:2147483647}),true);
  void tunnel.handle.result.then(()=>{if(!stopping)failed(Error('Guest executor tunnel terminated unexpectedly.'));},()=>{if(!stopping)failed(Error('Guest executor tunnel terminated unexpectedly.'));});
  while(!await connected(hostPort))await pause();active();await verifyHost();active();await verifyDir(root);active();
  guestTemporary=async(action,input)=>{
   const result=await command([home+'/native','--coding-temp',action,JSON.stringify(input)].map(quote).join(' '));
   require(result.exitCode===0&&Buffer.byteLength(result.stdout)<=16384,'guest temporary helper failed');
   return JSON.parse(result.stdout);
  };
  binding=freeze({url:'ws://127.0.0.1:'+hostPort,authToken,launch:{argv:['/bin/zsh','-f','-c',`exec ${quote(cli)} app-server --listen stdio:// -c features.plugins=false -c allow_login_shell=false -c features.shell_snapshot=false -c features.hooks=false`],cwd:'file:///private/var/empty',env:{HOME:sidecar,CODEX_HOME:sidecar,ZDOTDIR:sidecar,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',...gitEnv}}});admitted=true;
 }).catch(error=>{requestStop(errorOf(error));void retire().catch(()=>{});throw error;}).finally(()=>clearTimeout(timer));
 void startup.catch(()=>{});
 // Once bound, CodingOwners fences admission before closing its native sidecar.
 // Keep that sidecar's tunnel alive until the owner's explicit retire call.
 const abort=()=>{fence();if(!admitted){requestStop();void retire().catch(()=>{});}};
 if(signal instanceof AbortSignal){signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}
 const ready=Promise.race([startup,cancel.promise]);void ready.catch(()=>{});
 return Object.freeze({ready,get binding(){active();require(binding,'binding is not ready');return binding;},get hasWorkspace(){return !!prepared;},get workspaceRepository(){return prepared?guestWorkspaceRepository(prepared.workspace):null;},temporaryOperation,prepare,publishChanges,hostGitOperation,retire});
}
