import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,unlink,rmdir,link,chmod,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {CodingOwners} from './coding-owners.mjs';
import {CodingEngine} from './coding-engine.mjs';
import {readFilesystemIdentity} from './filesystem-identity.mjs';
import {GitWorkflow} from './git-workflow.mjs';
import {createServer} from './server.mjs';
import {nativeSignature} from './agent.mjs';

// Real filesystem, Git, owner lease and signed route. No model or original data.
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-failed-startups-'))),source=join(root,'source'),coldSource=join(root,'Cold-é'),dataDir=join(root,'Coding'),runtime=join(root,'runtime'),exec=promisify(execFile);
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const git=async(cwd,...args)=>(await exec('/usr/bin/git',['-C',cwd,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env,encoding:'buffer'})).stdout;
const identity=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode&0o777n)};};
const variant=process.argv.find(a=>a.startsWith('--'))??'--standard';
let clock=Date.now(),owner,leases=0,allocations=0,engines=0,raceChild=null;
let killWorker=false,unconfirmedGit=false;
const wallClock=Date.now,clockStart=clock;Date.now=()=>wallClock()+(clock-clockStart);
const calls=[];let failEnsure=false,readerCloseGate=null,stopGate=null,scheduleBusy=false,scheduleStartGate=null,scheduleBeginHook=null,resolveHook=null,readHook=null,pageSize=0,failStart=false,missingRootError=null,forkReplyGate=null,forkLoseReply=false;
class FixtureEngine extends CodingEngine {
 constructor(options){super(options);this.nativeFixture=options.executor===undefined;engines++;}
 async ensure(){if(this.closed)throw Error('closed');if(!this.processLife){this.child={killed:false};this.processLife={child:this.child,exited:false};}if(failEnsure){failEnsure=false;this.fail(Error('lost process before ensure continuation'));}}
 fail(error){if(this.processLife)this.processLife.exited=true;this.processLife=null;this.child=null;super.fail(error);}
 async close(){if(!this.closed){this.closed=true;this.fail(Error('fixture close'));}if(this.historyOnly&&readerCloseGate)await readerCloseGate;return super.close();}
 async stop(){if(this.historyOnly)return this.close();if(this.nativeFixture)return {stopped:true};if(stopGate)await stopGate;this.fail(Error('fixture Stop'));return {message:'fixture stopped'};}
 async prepare(){}
 async temporaryEnvironment(){return {};}
 async projectHasBackground(){return scheduleBusy;}
 async scheduledFamilyIdle(){return true;}
 async handoffScan(params){return (await this.rows()).filter(t=>!!t.archived===!!params.archived&&t.parentThreadId===params.ancestorThreadId);}
 async rpc(method,params){
  if(method==='thread/read'){const thread=(await this.rows()).find(t=>t.id===params.threadId);if(!thread)throw Error('unknown native thread');return {thread:structuredClone(thread)};}
  if(method==='thread/fork'){
   const records=(await readFile(params.path,'utf8')).trimEnd().split('\n').map(JSON.parse),source=records[0].payload.id,id=randomUUID(),path=join(this.dataDir,'sessions',id+'.jsonl');records[0].payload.id=id;
   await mkdir(join(this.dataDir,'sessions'),{recursive:true,mode:0o700});await writeFile(path,records.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
   const thread={id,path,forkedFromId:source,cwd:params.cwd,model:params.model,modelProvider:params.modelProvider,parentThreadId:null,ephemeral:false,status:{type:'idle'},historyMode:'legacy',turns:[]};await writeFile(join(this.dataDir,'fixture-threads.json'),JSON.stringify([thread]));
   calls.push({home:this.dataDir,input:{action:'nativeFork',source}});if(forkReplyGate)await forkReplyGate;if(forkLoseReply)throw Error('lost native fork reply');
   return {thread,cwd:params.cwd,model:params.model,modelProvider:params.modelProvider,approvalPolicy:'on-request',approvalsReviewer:'user',runtimeWorkspaceRoots:[params.cwd],sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}};
  }
  if(method!=='thread/start')throw Error('unexpected scheduled RPC '+method);const result=await this.handle({action:'start',cwd:params.cwd,model:params.model});if(scheduleStartGate)await scheduleStartGate;return result;}
 async begin(threadId,method,params){assert.equal(method,'turn/start');if(scheduleBeginHook)await scheduleBeginHook(this,threadId);return {turn:{id:randomUUID(),status:'completed'}};}
 async rows(){try{return JSON.parse(await readFile(join(this.dataDir,'fixture-threads.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 async handle(input){
  calls.push({home:this.dataDir,historyOnly:this.historyOnly,input:structuredClone(input)});await this.ensure();
  if(this.historyOnly&&!['read','historyPage','family','list','status','events'].includes(input.action))throw Error('reader execution');
  if(input.action==='status')return {available:true,model,provider:'local',providers:[{id:'local',model}],activeTurns:[],stoppingFamilies:[],terminals:[],busy:false,running:false};
  if(input.action==='approvalInfo'){assert(this.approvals.has(input.id));return {id:input.id,ownerHome:this.dataDir};}
  let rows=await this.rows();
  if(input.action==='start'){
   const thread={id:randomUUID(),cwd:input.cwd,model:input.model??model,modelProvider:'saleh_local',parentThreadId:null,updatedAt:1,turns:[]};if(this.nativeFixture){Object.assign(thread,{path:join(this.dataDir,'sessions',thread.id+'.jsonl'),historyMode:'legacy',ephemeral:false,status:{type:'idle'}});await mkdir(join(this.dataDir,'sessions'),{recursive:true,mode:0o700});await writeFile(thread.path,'fixture persisted rollout\n',{mode:0o600});}rows.push(thread);
   await writeFile(join(this.dataDir,'fixture-threads.json'),JSON.stringify(rows));this.rememberThread(thread);this.verifiedThreads.add(thread.id);if(failStart){this.push('thread/started',{thread});throw Error('lost native start reply');}return {thread};
  }
  if(input.action==='list'){const selected=rows.filter(t=>!!t.archived===!!input.archived),offset=Number(input.cursor??0),limit=pageSize||selected.length;return {threads:selected.slice(offset,offset+limit),nextCursor:offset+limit<selected.length?String(offset+limit):null,truncated:false};}
  const thread=rows.find(t=>t.id===input.threadId);if(!thread)throw Error('unknown native thread');this.rememberThread(thread);this.verifiedThreads.add(thread.id);
  if(input.action==='historyPage')return {threadId:thread.id,pageCursor:input.cursor??null,turn:thread.turns[0]??null,nextCursor:null,truncated:false};
  if(input.action==='read'){const result={thread,cursor:this.sequence};if(readHook)readHook(this);return result;}
  if(input.action==='family')return {rootThreadId:thread.id,root:thread,threads:[],nextCursor:null};
  if(['archive','unarchive'].includes(input.action)){const owner=JSON.parse(await readFile(join(this.providerDataDir,'coding-owners.json'),'utf8')).owners.find(r=>r.rootThreadId===thread.id);assert.equal(owner?.state,'ready','Persist root identity before materialization');thread.archived=input.action==='archive';if(thread.path){const path=join(this.dataDir,thread.archived?'archived_sessions':'sessions',thread.id+'.jsonl');await mkdir(join(this.dataDir,thread.archived?'archived_sessions':'sessions'),{recursive:true,mode:0o700});if(thread.path!==path)await rename(thread.path,path);thread.path=path;}await writeFile(join(this.dataDir,'fixture-threads.json'),JSON.stringify(rows));return {};}
  if(['send','rename'].includes(input.action))assert.equal(JSON.parse(await readFile(join(this.providerDataDir,'coding-owners.json'),'utf8')).owners.find(r=>r.rootThreadId===thread.id).creation,null,'Clear receipt before a native mutation can dispatch');
  if(input.action==='send')return {turn:{id:randomUUID(),status:'inProgress'},ownerHome:this.dataDir};
  if(input.action==='interruptFamily')return {turns:[]};
  throw Error('unhandled fixture action '+input.action);
 }
 async resolveFamily(id){const rows=await this.rows(),thread=rows.find(t=>t.id===id);if(!thread)throw Object.assign(Error(missingRootError??('thread not loaded: '+id)),missingRootError?{}:{code:'CODING_THREAD_NOT_LOADED',threadId:id,cursor:this.sequence});this.rememberThread(thread);this.verifiedThreads.add(id);if(resolveHook)await resolveHook(this);let ancestor=thread;while(ancestor.parentThreadId){ancestor=rows.find(t=>t.id===ancestor.parentThreadId);if(!ancestor)throw Error('missing parent');this.rememberThread(ancestor);this.verifiedThreads.add(ancestor.id);}return {thread,root:ancestor};}
}
const manager=new ManagedWorktrees({dataDir,nativeHelper:process.env.HANDOFF_FILES_HELPER,now:()=>clock,reserveMutation:async(resolve,policy)=>{const lease=await owner.reserveProjectMutation(resolve,policy);leases++;return {...lease,release:async()=>{try{return await lease.release();}finally{leases--;}}};}});
// The real cold owner lease needs an actual persisted allocation receipt; no VM starts.
// Use device identities here and exercise native durable identities in the unchanged helper groups.
const resources={cpu:1,memoryBytes:1048576,diskBytes:1048576};
const settings={dataDir,executorPolicy:{runtimeDir:runtime,resources,limits:{cpu:2,memoryBytes:2097152,diskBytes:2097152,concurrent:2}},engineFactory:o=>new FixtureEngine(o),engineOptions:{fullAccess:false,spawnProcess:(file,args,options)=>{const child=spawn(file,args,options);if(killWorker&&args[0]==='--handoff-process'&&args[1]==='git')raceChild=child;if(unconfirmedGit&&args[0]==='--handoff-process'&&args[1]==='git'){unconfirmedGit=false;const emit=child.emit.bind(child);child.emit=(event,...values)=>event==='close'?true:emit(event,...values);}return child;},nativeHelper:process.env.HANDOFF_FILES_HELPER,localModels:{resolve:async id=>({id,generation:{max_tokens:32}})},assertProject:path=>manager.assertProject(path)},openExecutor:async context=>{
  allocations++;const path=join(runtime,context.ownerId+'-'+context.generation);await mkdir(path,{mode:0o700});const s=await lstat(context.cwd,{bigint:true});
  await writeFile(join(path,'allocation.json'),JSON.stringify({version:2,ownerId:context.ownerId,generation:context.generation,cwd:context.cwd,hostIdentity:{dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode),uid:Number(s.uid)},root:null,resources:context.resources,account:null,bundle:null,restartAllowed:false}),{mode:0o600});
  const st=await lstat(path,{bigint:true});await context.recordAllocation({path,identity:await readFilesystemIdentity({path,nativeHelper:process.env.HANDOFF_FILES_HELPER})});
  const ready=Promise.reject(Error('SYNTHETIC_CLOSED_START_FAILURE'));ready.catch(()=>{});
  return {ready,retire:async()=>({ownerId:context.ownerId,generation:context.generation,closed:true,revoked:false})};
}};
owner=new CodingOwners(settings);
await mkdir(runtime,{mode:0o700});await mkdir(coldSource,{mode:0o700});await git(coldSource,'init','-b','main');await writeFile(join(coldSource,'file'),'COLD OWNER\n');await git(coldSource,'add','file');await git(coldSource,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','cold');
await assert.rejects(owner.handle({action:'start',cwd:coldSource}),/SYNTHETIC_CLOSED_START_FAILURE/);
const coldSourceB=variant==='--alias-output'?join(root,'RECOVERED PROJECTS'):join(root,'second-original');await mkdir(coldSourceB,{mode:0o700});await git(coldSourceB,'init','-b','main');await writeFile(join(coldSourceB,'second'),'KEEP SECOND ORIGINAL\n');await git(coldSourceB,'add','second');await git(coldSourceB,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','second');await assert.rejects(owner.handle({action:'start',cwd:coldSourceB}),/SYNTHETIC_CLOSED_START_FAILURE/);assert.equal((await owner.close()).stopped,true);
if(variant==='--overlap-output'){
 await git(root,'init','-b','main');await writeFile(join(root,'protected-original'),'KEEP PARENT ORIGINAL\n');await git(root,'add','protected-original');await git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','parent');
 const catalogPath=join(dataDir,'coding-owners.json'),catalog=JSON.parse(await readFile(catalogPath)),b=catalog.owners.find(r=>r.cwd===coldSourceB),receiptPath=join(runtime,b.id+'-'+b.generation.id,'allocation.json'),receipt=JSON.parse(await readFile(receiptPath)),st=await lstat(root,{bigint:true});b.cwd=root;receipt.cwd=root;receipt.hostIdentity={dev:String(st.dev),ino:String(st.ino),mode:Number(st.mode),uid:Number(st.uid)};await writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});await writeFile(catalogPath,JSON.stringify(catalog),{mode:0o600});
}
if(variant==='--alias-output'){
 const before=await readFile(join(dataDir,'coding-owners.json'));owner=new CodingOwners({...settings,engineOptions:{...settings.engineOptions,fullAccess:true}});await assert.rejects(owner.handle({action:'status'}),/private and canonical/);assert.deepEqual(await readFile(join(dataDir,'coding-owners.json')),before);await assert.rejects(lstat(join(dataDir,'Failed Startup Copies')),{code:'ENOENT'});assert.equal(engines,0);assert.equal((await owner.close()).stopped,false);console.log(JSON.stringify({passed:true,variant,root,aliasedControlRootRefusedBeforeAnyRecoveryWrite:true}));process.exit(0);
}
if(variant==='--cold-worker'){
 const artifact=join(dataDir,'Failed Startup Copies',randomUUID());await mkdir(artifact,{recursive:true,mode:0o700});const path=join(artifact,'worker-'+randomUUID()+'.json');await writeFile(path,JSON.stringify({version:1,kind:'git',receipt:{unclosedFixture:true}}),{mode:0o600});const before=await readFile(join(dataDir,'coding-owners.json'));
 owner=new CodingOwners({...settings,engineOptions:{...settings.engineOptions,fullAccess:true}});await assert.rejects(owner.handle({action:'status'}),/worker closure is unconfirmed/);assert.equal((await owner.close()).stopped,false);assert.deepEqual(await readFile(join(dataDir,'coding-owners.json')),before);assert((await lstat(join(dataDir,'coding-owners.lock'))).isFile());assert.equal(engines,0);console.log(JSON.stringify({passed:true,variant,root,coldUnclosedPreparationWorkerBlocksWithoutReplay:true,coordinatorLeasePreserved:true}));process.exit(0);
}
owner=new CodingOwners({...settings,engineOptions:{...settings.engineOptions,fullAccess:true}});await owner.handle({action:'status'});
const coldCatalog=await readFile(join(dataDir,'coding-owners.json')),cold=JSON.parse(coldCatalog),allocationPath=join(runtime,cold.owners[0].id+'-'+cold.owners[0].generation.id,'allocation.json'),allocationBytes=await readFile(allocationPath);
assert.equal(cold.owners[0].state,'creating');assert.equal(cold.owners[0].rootThreadId,null);assert.equal(cold.owners[0].generation.nativeOpen,false);assert.equal(cold.owners[0].generation.executorClosed,true);assert.equal(cold.executor.allocations[0].closed,true);

const model='local/saleh-qwen38-uncensored-8bit',saved=cold.owners[0];
await writeFile(join(coldSource,'file'),'STAGED\n');await git(coldSource,'add','file');await writeFile(join(coldSource,'file'),'WORKING\n');
await writeFile(join(coldSource,'.gitignore'),'ignored\n');await writeFile(join(coldSource,'ignored'),'KEEP IGNORED\n');
await mkdir(join(coldSource,'empty'));await writeFile(join(coldSource,'untracked'),'KEEP UNTRACKED\n');await link(join(coldSource,'untracked'),join(coldSource,'hardlink'));
if(variant==='--near-limit'){await mkdir(join(coldSource,'tiny'));await Promise.all(Array.from({length:1990},(_,i)=>writeFile(join(coldSource,'tiny',String(i).padStart(4,'0')),'TINY\n')));}
if(variant==='--metadata'){await writeFile(join(coldSource,'.gitignore'),'ignored\nmetadata/\n');await mkdir(join(coldSource,'metadata'));for(let at=0;at<10000;at+=128)await Promise.all(Array.from({length:Math.min(128,10000-at)},(_,i)=>writeFile(join(coldSource,'metadata','m'.repeat(80)+String(at+i).padStart(5,'0')),'')));}
if(variant==='--metadata')await exec('/usr/bin/python3',['-B','-c','import ctypes,os,sys;lib=ctypes.CDLL(None,use_errno=True);lib.setxattr.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_uint32,ctypes.c_int];data=b"x"*(4*1024*1024);assert lib.setxattr(os.fsencode(sys.argv[1]),b"com.apple.ResourceFork",data,len(data),0,0)==0,ctypes.get_errno()',join(coldSource,'ignored')]);
const expectedTree=await git(coldSource,'write-tree'),index=await readFile(join(coldSource,'.git/index')),head=await readFile(join(coldSource,'.git/HEAD'));
const request={action:'prepare',ownerId:saved.id,generation:saved.generation.id,model};
const exact=async()=>{assert.deepEqual(await readFile(join(dataDir,'coding-owners.json')),coldCatalog);assert.deepEqual(await readFile(allocationPath),allocationBytes);assert.deepEqual(await readFile(join(coldSource,'.git/index')),index);assert.deepEqual(await readFile(join(coldSource,'.git/HEAD')),head);assert.equal(await readFile(join(coldSource,'file'),'utf8'),'WORKING\n');};
try {
 await assert.rejects(owner.handle({action:'start',cwd:coldSource,executionMode:'native',model}),{code:'PROJECT_BUSY'});
 if(['--overlap-output','--alias-output'].includes(variant)){
  const artifact=join(dataDir,'Failed Startup Copies');await assert.rejects(owner.handleRecovery(request),/overlaps|protected|inside/);await assert.rejects(lstat(artifact),{code:'ENOENT'});if(variant==='--overlap-output')await assert.rejects(lstat(join(root,'Recovered Projects')),{code:'ENOENT'});assert.equal(engines,0);await exact();console.log(JSON.stringify({passed:true,variant,root,allOriginalOutputRootsAndAliasesRefusedBeforeMkdir:true}));await owner.close();process.exit(0);
 }
 if(variant==='--capacity'){
  const artifacts=join(dataDir,'Failed Startup Copies');await mkdir(artifacts,{mode:0o700});for(let i=0;i<256;i++)await mkdir(join(artifacts,randomUUID()),{mode:0o700});await assert.rejects(owner.handleRecovery(request),/capacity reached/);assert.equal((await fsPromises.readdir(artifacts)).length,256);await exact();assert.equal((await owner.close()).stopped,true);owner=new CodingOwners({...settings,engineOptions:{...settings.engineOptions,fullAccess:true}});await owner.handle({action:'status'});assert.equal((await owner.close()).stopped,true);console.log(JSON.stringify({passed:true,variant,root,capacityRefusedBefore257thArtifact:true,coldLoadRemainsUsable:true}));process.exit(0);
 }
 if(variant==='--unconfirmed-worker'){
  unconfirmedGit=true;await assert.rejects(owner.handleRecovery(request),/exit was not confirmed/);assert.equal(owner.shutdownUnconfirmed,true);assert.equal((await owner.stop()).stopped,false);await assert.rejects(owner.assertUnconfinedAccess(),/blocked|unconfirmed/);assert((await lstat(join(dataDir,'coding-owners.lock'))).isFile());await exact();let closed=false;void owner.close().then(()=>{closed=true;},()=>{closed=true;});await new Promise(r=>setTimeout(r,60));assert.equal(closed,false,'Unconfirmed project lease cannot be force-released by close');console.log(JSON.stringify({passed:true,variant,root,unconfirmedGitWorkerRetainsProjectAndCoordinatorLeases:true,stopAndShutdownCannotClaimClosure:true}));process.exit(0);
 }
 if(variant==='--disconnect'){
  const original=fsPromises.writeFile;let release,entered=false;const gate=new Promise(r=>release=r),token=randomUUID(),server=createServer({instanceToken:token,fullAccess:true,unconfinedBoot:true,coding:owner,worktrees:manager,hub:{stop:async()=>{},close:async()=>{}}});server.listen(0,'127.0.0.1');await once(server,'listening');
  fsPromises.writeFile=async(path,...args)=>{if(!entered&&String(path).includes('/worker-')&&String(path).endsWith('.json')){entered=true;await gate;}return original(path,...args);};syncBuiltinESMExports();
  const route='/api/tools/codingRecovery',body=JSON.stringify(request),nonce=randomUUID(),time=String(Date.now()),controller=new AbortController();const work=fetch(`http://127.0.0.1:${server.address().port}`+route,{method:'POST',headers:{'Content-Type':'application/json','X-Qwen-Nonce':nonce,'X-Qwen-Time':time,'X-Qwen-Permit':nativeSignature(token,route,nonce,time,body)},body,signal:controller.signal});const rejected=assert.rejects(work);while(!entered)await new Promise(r=>setTimeout(r,10));controller.abort();await rejected;await new Promise(r=>setTimeout(r,60));assert.equal(owner.shutdownUnconfirmed,true);release();for(let i=0;i<1000&&owner.shutdownUnconfirmed;i++)await new Promise(r=>setTimeout(r,10));assert.equal(owner.shutdownUnconfirmed,false);fsPromises.writeFile=original;syncBuiltinESMExports();await exact();assert.equal(engines,0);assert.equal(allocations,2);assert.deepEqual((await owner.handleRecovery({action:'list'})).candidates.flatMap(c=>c.continuations),[]);assert.equal((await owner.close()).stopped,true);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({passed:true,variant,root,signedDisconnectCancelsBeforeWorkerDispatch:true,recordCallbackJoinedAndNoCopyOrChatReplayed:true}));process.exit(0);
 }
 if(variant==='--record-race'){
  const original=fsPromises.writeFile;let release,entered=false,settled=false;const gate=new Promise(r=>release=r);killWorker=true;
  fsPromises.writeFile=async(path,...args)=>{if(!entered&&String(path).includes('/worker-')&&String(path).endsWith('.json')){entered=true;assert(raceChild);raceChild.kill('SIGKILL');await gate;}return original(path,...args);};syncBuiltinESMExports();
  const work=owner.handleRecovery(request).finally(()=>{settled=true;});const rejected=assert.rejects(work);while(!entered)await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);assert.equal(owner.shutdownUnconfirmed,true);assert.equal((await owner.stop()).stopped,false);release();await rejected;killWorker=false;fsPromises.writeFile=original;syncBuiltinESMExports();await exact();assert.equal((await owner.close()).stopped,true);owner=new CodingOwners({...settings,engineOptions:{...settings.engineOptions,fullAccess:true}});await owner.handle({action:'status'});assert.equal((await owner.close()).stopped,true);console.log(JSON.stringify({passed:true,variant,root,lateRecordCallbackJoinedBeforeLeaseRelease:true,stopPendingUntilCallbackSettles:true,coldClosureReceiptsValid:true}));process.exit(0);
 }
 const token=randomUUID(),server=createServer({instanceToken:token,fullAccess:true,unconfinedBoot:true,coding:owner,worktrees:manager,hub:{stop:async()=>{},close:async()=>{}}});server.listen(0,'127.0.0.1');await once(server,'listening');
 const route='/api/tools/codingRecovery',url=`http://127.0.0.1:${server.address().port}`+route;
 const post=async(input,{signed=true,status=200}={})=>{const body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now()),response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(signed?{'X-Qwen-Nonce':nonce,'X-Qwen-Time':time,'X-Qwen-Permit':nativeSignature(token,route,nonce,time,body)}:{})},body}),result=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;};
 try {
 await post({action:'list'},{signed:false,status:403});await post({...request,path:coldSource},{status:400});await post({action:'prepare',ownerId:randomUUID(),generation:saved.generation.id,model},{status:400});
 const list=await post({action:'list'});assert.equal(list.candidates.length,2);
 if(variant==='--standard'){
 await mkdir(join(coldSource,'nested'));await mkdir(join(coldSource,'nested','.git'));await post(request,{status:400});await rmdir(join(coldSource,'nested','.git'));await rmdir(join(coldSource,'nested'));await exact();
 const exclude=join(coldSource,'.git/info/exclude'),excludeBefore=await readFile(exclude);await writeFile(exclude,'ignored-by-info\n');await writeFile(join(coldSource,'ignored-by-info'),'KEEP SOURCE-ONLY IGNORED FILE\n');const unsupported=(await post(request)).plan;await post({action:'create',id:unsupported.id},{status:400});assert.equal(await readFile(join(coldSource,'ignored-by-info'),'utf8'),'KEEP SOURCE-ONLY IGNORED FILE\n');await writeFile(exclude,excludeBefore);await unlink(join(coldSource,'ignored-by-info'));await exact();
 const stopped=(await post(request)).plan;assert.equal((await owner.stop()).stopped,true);await post({action:'create',id:stopped.id},{status:400});await exact();
 const cancelled=(await post(request)).plan;await post({action:'cancel',id:cancelled.id});await post({action:'create',id:cancelled.id},{status:400});
 const stale=(await post(request)).plan;await writeFile(join(coldSource,'file'),'NEWER WORKING\n');await post({action:'create',id:stale.id},{status:400});assert.equal(await readFile(join(coldSource,'file'),'utf8'),'NEWER WORKING\n');await writeFile(join(coldSource,'file'),'WORKING\n');
 const expired=(await post(request)).plan;clock+=120001;try{await post({action:'create',id:expired.id},{status:400});}finally{clock-=120001;}
 }
 const plan=(await post(request)).plan;
 assert.equal(plan.source,coldSource);assert.equal(plan.model,model);assert.equal(plan.omittedCount,0);await exact();
 if(variant==='--target-record-failure'){
  const entry=join(root,'Recovered Projects',plan.id),receiptPath=join(entry,'receipt.json'),targetPath=join(entry,'target.json'),originalWrite=fsPromises.writeFile;
  assert.equal(plan.target,join(entry,'project'));const originalEngines=engines,originalAllocations=allocations;
  const allocationWitnesses=await Promise.all(cold.owners.map(async row=>{const path=join(runtime,row.id+'-'+row.generation.id,'allocation.json');return [path,await readFile(path)];}));
  let injected=0;
  fsPromises.writeFile=async(path,...args)=>{
   if(String(path)===targetPath&&!injected){
    const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
    assert.equal(receipt.state,'complete');assert.equal(receipt.copy.id,plan.id);assert.equal(receipt.copy.target,plan.target);assert.equal(receipt.copy.independent,true);assert.equal(receipt.copy.originalStartupRecovered,false);
    injected++;throw Object.assign(Error('SYNTHETIC_TARGET_RECORD_EIO'),{code:'EIO'});
   }
   return originalWrite(path,...args);
  };syncBuiltinESMExports();
  try{const failure=await post({action:'create',id:plan.id},{status:400});assert.match(JSON.stringify(failure),/SYNTHETIC_TARGET_RECORD_EIO/);}
  finally{fsPromises.writeFile=originalWrite;syncBuiltinESMExports();}
  assert.equal(injected,1,'The fault must occur only after this exact copy receipt was published');
  const receiptBytes=await readFile(receiptPath),entries=(await fsPromises.readdir(join(root,'Recovered Projects'))).sort();
  const retained=async()=>{
   assert.deepEqual(await readFile(receiptPath),receiptBytes);for(const name of ['target.json','open-intent.json','opened.json'])await assert.rejects(lstat(join(entry,name)),{code:'ENOENT'});
   assert.deepEqual((await fsPromises.readdir(join(root,'Recovered Projects'))).sort(),entries);await exact();
   for(const [path,bytes]of allocationWitnesses)assert.deepEqual(await readFile(path),bytes);
   assert.equal(await readFile(join(coldSourceB,'second'),'utf8'),'KEEP SECOND ORIGINAL\n');assert.equal(engines,originalEngines);assert.equal(allocations,originalAllocations);
  };
  const openRequest={action:'open',ownerId:saved.id,generation:saved.generation.id,model,id:plan.id};
  await assert.rejects(owner.handleRecovery({action:'create',id:plan.id}),/expired|cancelled|consumed/);
  await assert.rejects(owner.handleRecovery(request),/a continuation already exists/);
  await assert.rejects(owner.handleRecovery(openRequest),/copy is incomplete/);await retained();
  const warm=(await owner.handleRecovery({action:'list'})).candidates.find(c=>c.ownerId===saved.id).continuations.find(c=>c.id===plan.id);
  assert.deepEqual({...warm,state:null},{id:plan.id,target:plan.target,model,state:null,threadId:null});await retained();
  assert.equal((await owner.close()).stopped,true);owner=new CodingOwners({...settings,engineOptions:{...settings.engineOptions,fullAccess:true}});await owner.handle({action:'status'});
  const coldCopy=(await owner.handleRecovery({action:'list'})).candidates.find(c=>c.ownerId===saved.id).continuations.find(c=>c.id===plan.id);
  assert.deepEqual(coldCopy,warm,'Cold reload must retain the same copy disposition without promoting chat creation');
  await assert.rejects(owner.handleRecovery(request),/a continuation already exists/);await assert.rejects(owner.handleRecovery(openRequest),/copy is incomplete/);await retained();
  console.log(JSON.stringify({variant,phase:'target-record-failure-observed',receiptPublished:true,observedState:warm.state,coldState:coldCopy.state,targetAndChatRecordsAbsent:true,duplicateCopyAndOpenRefused:true,originalsExact:true,newEngines:engines-originalEngines,newAllocations:allocations-originalAllocations}));
  assert.equal(warm.state,'copy-needs-inspection','A completed copy missing its continuation proof must be inspectable, not offered as retryable incomplete output');
  console.log(JSON.stringify({passed:true,variant,root,copyCompletionDistinctFromChatCreation:true,retainedCopyNeedsInspection:true,coldDispositionPreserved:true,actualVMOrModelStarted:false}));
 }else{
 const copied=(await post({action:'create',id:plan.id})).copy;assert.equal(copied.independent,true);assert.notEqual(copied.target,coldSource);
 assert.equal(await readFile(join(copied.target,'file'),'utf8'),'WORKING\n');assert.equal(await readFile(join(copied.target,'ignored'),'utf8'),'KEEP IGNORED\n');assert.equal(await readFile(join(copied.target,'untracked'),'utf8'),'KEEP UNTRACKED\n');assert((await lstat(join(copied.target,'empty'))).isDirectory());
 assert.notEqual((await identity(join(copied.target,'file'))).ino,(await identity(join(coldSource,'file'))).ino);assert.equal((await identity(join(copied.target,'untracked'))).ino,(await identity(join(copied.target,'hardlink'))).ino);
 assert.deepEqual(await git(copied.target,'rev-parse','HEAD'),await git(coldSource,'rev-parse','HEAD'));assert.deepEqual(await git(copied.target,'write-tree'),expectedTree);
 await assert.rejects(lstat(join(copied.target,'.git/objects/info/alternates')),{code:'ENOENT'});await exact();
 await assert.rejects(owner.handleRecovery({action:'create',id:plan.id}));await assert.rejects(owner.handleRecovery(request));
 if(variant==='--metadata')assert((await lstat(copied.receiptPath)).size>8*1024*1024,'Combined metadata receipt crosses the old 8MiB reader ceiling');
 if(variant==='--changed-target'){await writeFile(join(copied.target,'file'),'NEW LOCAL COPY EDIT\n');const listed=await owner.handleRecovery({action:'list'});assert.equal(listed.candidates[0].continuations.find(c=>c.id===copied.id).state,'copy-changed');await assert.rejects(owner.handleRecovery({action:'open',ownerId:saved.id,generation:saved.generation.id,model,id:copied.id}),/changed/);assert.equal(engines,0);await exact();console.log(JSON.stringify({passed:true,variant,root,currentCopyChangeAdvertisedAndOpeningRefused:true}));await owner.close();process.exit(0);}
 assert.equal(allocations,2);assert.equal(engines,0);
 const opened=await owner.handleRecovery({action:'open',ownerId:saved.id,generation:saved.generation.id,model,id:copied.id});assert.equal(opened.thread.cwd,copied.target);assert.equal(opened.thread.model,model);assert.equal(opened.executionMode,'native');assert.equal(allocations,2);assert.equal(engines,1);
 await assert.rejects(owner.handleRecovery({action:'open',ownerId:saved.id,generation:saved.generation.id,model,id:copied.id}));assert.equal(engines,1);assert.deepEqual(JSON.parse(await readFile(join(dataDir,'coding-owners.json'))).owners.find(r=>r.id===saved.id),saved);
 const extra=await owner.handle({action:'start',cwd:copied.target,executionMode:'native',model});assert.equal(extra.thread.cwd,copied.target);assert.equal(engines,2);
 const second=cold.owners.find(r=>r.cwd===coldSourceB),secondRequest={action:'prepare',ownerId:second.id,generation:second.generation.id,model};const secondPlan=(await owner.handleRecovery(secondRequest)).plan,secondCopy=(await owner.handleRecovery({action:'create',id:secondPlan.id})).copy;
 const secondOpened=await owner.handleRecovery({action:'open',ownerId:second.id,generation:second.generation.id,model,id:secondCopy.id});assert.equal(secondOpened.thread.cwd,secondCopy.target);assert.equal(engines,3);assert.equal(allocations,2);assert.equal(await readFile(join(coldSourceB,'second'),'utf8'),'KEEP SECOND ORIGINAL\n');
 const finalOwners=JSON.parse(await readFile(join(dataDir,'coding-owners.json'))).owners;for(const row of cold.owners)assert.deepEqual(finalOwners.find(r=>r.id===row.id),row);
 if(variant==='--near-limit'){const artifacts=join(dataDir,'Failed Startup Copies'),counts=await Promise.all((await fsPromises.readdir(artifacts)).map(async n=>(await fsPromises.readdir(join(artifacts,n))).length));assert(Math.max(...counts)>4096,'Valid snapshot crosses the old worker inventory ceiling');}
 await owner.close();owner=new CodingOwners({...settings,engineOptions:{...settings.engineOptions,fullAccess:true}});const coldList=await owner.handleRecovery({action:'list'});assert.equal(coldList.candidates[0].continuations.filter(c=>c.state==='opened').length,1);assert.equal(allocations,2);
 }
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
} finally {assert.equal((await owner.close()).stopped,true);Date.now=wallClock;}
if(variant!=='--target-record-failure')console.log(JSON.stringify({passed:true,variant,root,oldOwnerStillFenced:true,independentGitNativeCopy:true,oldOwnerAllocationAndProjectExact:true,signedRoutesStaleExpiredCancelledConsumedAndStop:true,twoIndependentProjectsAndAdditionalNativeChatWithoutTurns:true,coldContinuationPersisted:true,actualVMOrModelStarted:false}));
