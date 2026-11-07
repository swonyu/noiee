import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm,rename,lstat,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter,once} from 'node:events';
import {PassThrough} from 'node:stream';
import {CodingEngine} from './coding-engine.mjs';
import {createServer,watchParent} from './server.mjs';
import childProcess,{spawn} from 'node:child_process';
import {fstatSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {nativeSignature} from './agent.mjs';
let module;try{module=await import('./coding-owners.mjs');}catch{}
assert.equal(typeof module?.CodingOwners,'function','Durable CodingOwners must exist');
const {CodingOwners}=module;
const root=await realpath(await mkdtemp(join(tmpdir(),'coding-owners-check-'))),model='qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp';
const calls=[],allocations=[],engines=[];let gate=null,revoked=true,failStart=false,stopGate=null,retirementFault=null,resolveHook=null,failEnsure=false,readerCloseGate=null,pageSize=0,readHook=null,scheduleBeginHook=null,scheduleStartGate=null,scheduleBusy=false,missingRootError=null,forkReplyGate=null,forkLoseReply=false,fileGate=null;
class FixtureEngine extends CodingEngine {
 constructor(options){super(options);this.nativeFixture=options.executor===undefined;engines.push(this);}
 async ensure(){if(this.closed)throw Error('closed');if(!this.processLife){this.child={killed:false};this.processLife={child:this.child,exited:false};}if(failEnsure){failEnsure=false;this.fail(Error('lost process before ensure continuation'));}}
 fail(error){if(this.processLife)this.processLife.exited=true;this.processLife=null;this.child=null;super.fail(error);}
 async close(){if(!this.closed){this.closed=true;this.fail(Error('fixture close'));}if(this.historyOnly&&readerCloseGate)await readerCloseGate;return super.close();}
 async stop(){if(this.historyOnly)return this.close();if(stopGate)await stopGate;this.fail(Error('fixture Stop'));return {message:'fixture stopped'};}
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
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// This fixture models the helper contract; native anchored-copy/process gates are checked separately.
async function fixtureFiles(action,input,{signal,record,closed,check}){
 if(fileGate)await fileGate;check();assert(!signal.aborted);
 const source=input.root??input.source,paths=input.paths??Object.keys(input.stamps);
 if(action==='copy')await record({version:1,nonce:randomUUID(),pid:process.pid,pgid:process.pid,uid:process.getuid(),startSec:'1',startUsec:0,bootSession:'11111111-1111-4111-8111-111111111111'});
 try{
  const stamps={};for(const name of paths){const path=join(source.path,name),st=await lstat(path,{bigint:true});let destination=path;
   if(action==='copy'){destination=join(input.destination.path,name);if(st.isDirectory())await mkdir(destination,{mode:Number(st.mode&0o777n)});else await copyFile(path,destination);}
   const info=await lstat(destination,{bigint:true}),row={identity:{dev:String(info.dev),ino:String(info.ino)},kind:info.isDirectory()?'directory':'file',mode:Number(info.mode&0o7777n),uid:Number(info.uid),nlink:Number(info.nlink)};
   if(info.isFile()){const bytes=await readFile(destination);Object.assign(row,{bytes:bytes.length,sha256:digest(bytes)});}stamps[name]=row;
  }return {stamps};
 }finally{if(action==='copy')await closed();}
}
async function materialize(owner,thread,observe=true){
 const e=engines.findLast(e=>e.threadInfo.has(thread.id)),path=join(e.dataDir,'sessions',thread.id+'.jsonl');await mkdir(join(e.dataDir,'sessions'),{recursive:true,mode:0o700});
 const instructions='You are a coding assistant in Saleh Uncensored. Work in the selected project. Read applicable project instructions. Preserve user work. Use the available tools to inspect, edit, and verify requested changes. Request approval when required. Report actual results and unresolved failures accurately. Never claim tests or actions ran without tool evidence. The current TMPDIR environment variable identifies app-owned scratch space; use it for temporary files and do not commit that directory.';
 const header={type:'session_meta',payload:{id:thread.id,cwd:thread.cwd,model_provider:thread.modelProvider,multi_agent_version:'v2',base_instructions:{provenance:{type:'custom'},text:instructions}}};const context={type:'turn_context',payload:{turn_id:'saved-turn',root_turn_id:'saved-turn',cwd:thread.cwd,model:thread.model,effort:'none',collaboration_mode:{mode:'default',settings:{model:thread.model,reasoning_effort:'none',developer_instructions:null}}}};await writeFile(path,JSON.stringify(header)+'\n'+JSON.stringify(context)+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'saved-turn'}})+'\n',{mode:0o600});
 const saved={...thread,path,ephemeral:false,status:{type:'idle'},historyMode:'legacy',turns:[{id:'saved-turn',status:'completed',items:[{id:'message',type:'agentMessage',text:'retained'}]}]};await writeFile(join(e.dataDir,'fixture-threads.json'),JSON.stringify([saved]));e.rememberThread(saved);if(observe)await owner.handle({action:'read',threadId:thread.id});return e;
}
function fixtureHelper(_file,args){
 const child=new EventEmitter(),streams=Array.from({length:5},()=>new PassThrough()),action=args.at(-1),nonce=args[0]==='--handoff-process'?args[2]:null;
 Object.assign(child,{pid:900000011,exitCode:null,signalCode:null,killed:false,stdio:streams,stdin:streams[0],stdout:streams[1],stderr:streams[2]});
 const finish=(code,signal=null)=>{if(child.exitCode!==null||child.signalCode!==null)return;child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);child.stdout.end();child.stderr.end();child.emit('close',code,signal);};
 child.kill=signal=>{child.killed=true;finish(null,signal);return true;};
 let body='';child.stdin.on('data',b=>body+=b);child.stdin.once('end',async()=>{try{const result=await fixtureFiles(action,JSON.parse(body),{signal:new AbortController().signal,check(){},record:async()=>{},closed:async()=>{}});child.stdout.write(JSON.stringify(result));finish(0);}catch(e){child.stderr.write(e.message);finish(1);}});
 if(nonce)queueMicrotask(()=>streams[3].end(JSON.stringify({version:1,nonce,pid:child.pid,pgid:child.pid,uid:process.getuid(),startSec:'1',startUsec:0,bootSession:'11111111-1111-4111-8111-111111111111'})+'\n'));
 return child;
}
// Only this fixture's direct filesystem-identity transport is synthetic. The
// actual reader retains its no-follow FD, canonical path and identity checks.
async function withFixtureFilesystemIdentity(home,helper,body,groupRequired=true,beforeIdentity){
 const priorSpawn=childProcess.spawn,priorOpen=fsPromises.open,priorKill=process.kill,files=new Map();let identities=0,groups=0;
 fsPromises.open=async(...args)=>{const file=await priorOpen(...args);files.delete(file.fd);const path=args[0];if(typeof path==='string'&&(path===home||path.startsWith(home+'/')))files.set(file.fd,path);return file;};
 childProcess.spawn=(file,args,options)=>{
  assert.equal(file,helper);assert.deepEqual(args,['--handoff-process','filesystem-identity']);assert.deepEqual(options.stdio.slice(0,3),['ignore','pipe','pipe']);assert.equal(options.stdio.length,4);
  const fd=options.stdio[3],path=files.get(fd);assert(path,'Filesystem FD must have been opened inside this fixture');
  const held=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});assert(!named.isSymbolicLink());assert(held.isDirectory()||held.isFile());assert.equal(held.dev,named.dev);assert.equal(held.ino,named.ino);identities++;
  const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),kill(){throw Error('Unexpected filesystem fixture cancellation');}});
  queueMicrotask(()=>{Promise.resolve().then(()=>beforeIdentity?.(path)).then(()=>{child.stdout.end(JSON.stringify({volumeUUID:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',ino:String(held.ino)})+'\n');child.stderr.end();child.emit('close',0,null);},error=>{child.stdout.end();child.stderr.end(error.message);child.emit('close',1,null);});});return child;
 };
 process.kill=(pid,signal)=>{assert.equal(pid,-900000011);assert.equal(signal,0);groups++;throw Object.assign(Error('Synthetic helper is closed'),{code:'ESRCH'});};
 syncBuiltinESMExports();
 try{const value=await body();assert(identities>0,'Durable identity transport must actually execute');if(groupRequired)assert(groups>0,'Copy helper closure must actually be checked');return value;}
 finally{childProcess.spawn=priorSpawn;fsPromises.open=priorOpen;process.kill=priorKill;syncBuiltinESMExports();}
}
const localModels={async resolve(id,{effort}){return {id,generation:{max_tokens:effort==='high'?32768:2048,reasoning_effort:effort}};}};
const options=dataDir=>({dataDir,engineOptions:{localModels,binary:join(root,'fixture-codex')},forkFiles:fixtureFiles,engineFactory:o=>new FixtureEngine(o),openExecutor:async context=>{allocations.push(context);if(gate)await gate;return {binding:{url:'ws://127.0.0.1:19999',authToken:'never-persist-this-secret',launch:{argv:['/fixture/codex'],cwd:'file:///private/var/empty',env:{HOME:context.dataDir}}},retire:async()=>{if(retirementFault)throw Error(retirementFault);return {ownerId:context.ownerId,generation:context.generation,closed:true,revoked};}};}});
async function projectPollChecks(){
 const {ManagedWorktrees}=await import('./managed-worktrees.mjs');
 const git=async(...args)=>new Promise((resolve,reject)=>childProcess.execFile('/Applications/Xcode.app/Contents/Developer/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
 for(const action of ['status','events','read']){
  const home=join(root,'poll-'+action),project=join(root,'poll-project-'+action);await mkdir(home,{mode:0o700});await mkdir(project,{mode:0o700});await git('init','-b','main',project);await writeFile(join(project,'file'),'COMMITTED\n');await git('-C',project,'add','file');await git('-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base');await writeFile(join(project,'file'),'UNSENT SOURCE EDIT\n');const index=await readFile(join(project,'.git/index'));
  const owner=new CodingOwners(options(home)),manager=new ManagedWorktrees({dataDir:home,managedMutationBlocked:true,reserveMutation:(resolve,policy)=>owner.reserveProjectMutation(resolve,policy)});
  try{
   const thread=(await owner.handle({action:'start',cwd:project})).thread;
   // handle registers the poll before its first await, exactly as native live updates do.
   const polling=owner.handle({action,...(action==='read'?{threadId:thread.id}:{})}),preparing=action==='read'?owner.reserveProjectMutation(async()=>[project],{kind:'createWorktree',target:()=>project}):manager.handle({action:'prepare',cwd:project,ref:'HEAD'});
   if(action==='read'){await assert.rejects(preparing,error=>error.code==='PROJECT_BUSY');await polling;assert.equal(manager.records.length,0);assert.equal(manager.plans.size,0);}
   else{const [,prepared]=await Promise.all([polling,preparing]);const result=await manager.handle({action:'create',planId:prepared.plan.id});assert.equal(result.worktree.state,'ready',result.worktree.message);assert.equal(await readFile(join(result.worktree.cwd,'file'),'utf8'),'COMMITTED\n');assert.equal(await readFile(join(project,'file'),'utf8'),'UNSENT SOURCE EDIT\n');assert.deepEqual(await readFile(join(project,'.git/index')),index);}
   console.log('PASS project mutation '+action+' concurrency');
  }finally{await manager.close();await owner.close();}
 }
}
if(process.argv.includes('--project-poll-check')){try{await projectPollChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function recoveryReaderChecks(){
 const variants=['closed','read','first-marker-reader','wrong-owner','unknown-closure','failed-reader-close','active-recovery','stop-reader-close','selected-stop-reader-close','filesystem'];
 for(const variant of variants){
  if(process.argv[3]&&process.argv[3]!==variant)continue;
  const home=join(root,'recovery-reader-'+variant),project=join(root,'recovery-project-'+variant),helper=join(home,'fixture-helper');
  await mkdir(home,{mode:0o700});await mkdir(project,{mode:0o700});await writeFile(helper,'inert fixture identity transport',{mode:0o700});
  await withFixtureFilesystemIdentity(home,helper,async()=>{
   const settings=options(home);settings.engineOptions.nativeHelper=helper;
   settings.openExecutor=async()=>{throw Error('Native recovery must not allocate a guest');};
   settings.engineFactory=o=>{const engine=new FixtureEngine(o);if(!o.historyOnly){engine.stop=async()=>{engine.epoch++;engine.runs.clear();engine.terminals.clear();return {message:'tracked fixture work stopped'};};}return engine;};
   const file=join(home,'coding-owners.json'),catalog=async()=>JSON.parse(await readFile(file,'utf8'));
   let owner=new CodingOwners(settings),reader,releaseClose,originalClose;
   try{
    const thread=(await owner.handle({action:'start',cwd:project,executionMode:'native'})).thread;
    await materialize(owner,thread);assert.equal((await owner.close()).stopped,true);
    const saved=await catalog(),row=saved.owners[0],context={id:randomUUID(),worktreeId:randomUUID(),source:project,destination:join(root,'retained-destination-'+variant),fingerprint:'a'.repeat(64),owner:{ownerId:row.id,home:row.home,rootThreadId:row.rootThreadId,generation:row.generation.id,executionMode:'native',model:row.model,provider:row.provider},recovery:{directory:{dev:'1',ino:'2'},manifest:{identity:{dev:'1',ino:'3'},hash:'b'.repeat(64),bytes:123}}};
    if(variant!=='first-marker-reader'){saved.version=12;row.handoff={context,commit:null};}
    if(variant==='unknown-closure')row.generation.nativeOpen=true;
    await writeFile(file,JSON.stringify(saved));owner=new CodingOwners(settings);
    const history=join(home,'owners',row.id,'sessions',thread.id+'.jsonl'),beforeHistory=await readFile(history),beforeEngines=engines.length;
    if(['read','first-marker-reader','wrong-owner','failed-reader-close','stop-reader-close','selected-stop-reader-close'].includes(variant)){
     assert.equal((await owner.handle({action:'read',threadId:thread.id})).thread.id,thread.id);
     reader=engines.at(-1);assert.equal(reader.historyOnly,true);assert.equal(reader.closed,false);
     assert.equal((await catalog()).owners[0].generation.nativeOpen,true);
    }
    if(variant==='wrong-owner'){
     await assert.rejects(owner.loadHandoffRecovery({...context,owner:{...context.owner,ownerId:randomUUID()}}),/does not belong/);
     assert.equal(reader.closed,false);assert.equal(engines.length,beforeEngines+1);
    }else if(variant==='unknown-closure'){
     await assert.rejects(owner.loadHandoffRecovery(context),/confirmed closure/);assert.equal(engines.length,beforeEngines);
    }else if(variant==='failed-reader-close'){
     originalClose=reader.close.bind(reader);reader.close=async()=>{throw Error('Injected reader close failure');};
     await assert.rejects(owner.loadHandoffRecovery(context),/reader close failure/);
     assert.equal((await catalog()).owners[0].generation.nativeOpen,true);assert.equal(engines.length,beforeEngines+1);
    }else if(['stop-reader-close','selected-stop-reader-close'].includes(variant)){
     let entered;const enteredClose=new Promise(r=>entered=r),held=new Promise(r=>releaseClose=r);originalClose=reader.close.bind(reader);
     reader.close=async()=>{entered();await held;return originalClose();};
     const loading=owner.loadHandoffRecovery(context),rejected=assert.rejects(loading,/stop|cancel/i);
     let timer;try{await Promise.race([enteredClose,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Reader retirement did not start')),1500))]);}finally{clearTimeout(timer);}
     const stopping=variant==='stop-reader-close'?owner.stop():owner.handle({action:'interruptFamily',threadId:thread.id});releaseClose();await rejected;await stopping;assert.equal((await owner.stop()).stopped,true);assert.equal(engines.length,beforeEngines+1);
    }else{
     await assert.doesNotReject(owner.loadHandoffRecovery(context),'A verified read-only history reader must not block recovery enrollment');
     assert.equal(engines.at(-1).historyOnly,false);if(reader)assert.equal(reader.closed,true);
     if(variant==='filesystem'){
      const engine=engines.at(-1),forwarded=[],snapshot={rootThreadId:thread.id,cwd:project,fingerprint:context.fingerprint,model:row.model,modelProvider:'saleh_local',members:[{id:thread.id,compatibility:{version:1,headerHash:'c'.repeat(64),identity:{dev:'9',ino:'10'}}}]},filesystem={fromDevice:'9',toDevice:context.recovery.directory.dev,volumeUUID:row.home.volumeUUID};
      engine.prepareHandoffRecovery=async(...args)=>{forwarded.push(args);return {snapshot:args[0]};};
      for(const [key,value] of [['volumeUUID','BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'],['toDevice','7'],['fromDevice','8']])await assert.rejects(owner.prepareHandoffRecovery(snapshot,context.destination,{}, {...filesystem,[key]:value}),/filesystem admission/);
      const wrongMember=structuredClone(snapshot);wrongMember.members[0].compatibility.identity.dev='8';await assert.rejects(owner.prepareHandoffRecovery(wrongMember,context.destination,{},filesystem),/filesystem admission/);
      assert.equal(forwarded.length,0,'Wrong owner volume, destination device, or original member device never reaches the engine');
      await owner.prepareHandoffRecovery(snapshot,context.destination,{},filesystem);assert.deepEqual(forwarded[0][3],filesystem);assert(Object.isFrozen(forwarded[0][3]));assert.notEqual(forwarded[0][3],filesystem);
      await owner.prepareHandoffRecovery(snapshot,context.destination,{});assert.equal(forwarded[1][3],null,'Ordinary recovery has no mount admission');
     }
     if(variant==='active-recovery'){
      const count=engines.length,engine=engines.at(-1);await assert.rejects(owner.loadHandoffRecovery(context),/confirmed closure/);assert.equal(engine.closed,false);assert.equal(engines.length,count);
     }
    }
    assert.deepEqual(await readFile(history),beforeHistory,'Recovery enrollment leaves saved history intact');
    assert.deepEqual((await catalog()).owners[0].handoff,{context,commit:null},'Retain exact original owner and recovery binding');
   }finally{
    releaseClose?.();if(originalClose&&reader)reader.close=originalClose;await owner.close();
   }
  },false);
  console.log('PASS recovery reader '+variant);
 }
 assert(!process.argv[3]||variants.includes(process.argv[3]),'Unknown recovery-reader variant');
}

async function handoffReconnectOwnerChecks(){
 for(const variant of ['closed','reader','wrong-generation','wrong-family','unknown-closure','publish-failure','selected-stop','late-reader']){
  const home=join(root,'reconnect-owner-'+variant),project=join(root,'reconnect-project-'+variant),destination=join(root,'reconnect-target-'+variant),helper=join(home,'fixture-helper');
  await mkdir(home,{mode:0o700});await mkdir(project,{mode:0o700});await mkdir(destination,{mode:0o700});await writeFile(helper,'inert fixture identity transport',{mode:0o700});
  await withFixtureFilesystemIdentity(home,helper,async()=>{
   const settings=options(home);settings.engineOptions.nativeHelper=helper;settings.openExecutor=async()=>{throw Error('Reconnect must not allocate an executor');};
   settings.engineFactory=o=>{const engine=new FixtureEngine(o);if(!o.historyOnly)engine.stop=async()=>{engine.epoch++;engine.runs.clear();engine.terminals.clear();return {message:'tracked fixture work stopped'};};return engine;};
   let owner=new CodingOwners(settings),lease;
   try{
    const thread=(await owner.handle({action:'start',cwd:project,executionMode:'native'})).thread;await materialize(owner,thread);await owner.close();
    const file=join(home,'coding-owners.json'),saved=JSON.parse(await readFile(file)),row=saved.owners[0],context={id:randomUUID(),worktreeId:randomUUID(),source:project,destination,fingerprint:'a'.repeat(64),owner:{ownerId:row.id,home:row.home,rootThreadId:row.rootThreadId,generation:row.generation.id,executionMode:'native',model:row.model,provider:row.provider},recovery:{directory:{dev:'1',ino:'2'},manifest:{identity:{dev:'1',ino:'3'},hash:'b'.repeat(64),bytes:123}}};
    saved.version=12;row.handoff={context,commit:null};if(variant==='unknown-closure')row.generation.nativeOpen=true;await writeFile(file,JSON.stringify(saved));
    owner=new CodingOwners(settings);const history=join(home,'owners',row.id,'sessions',thread.id+'.jsonl'),historyBytes=await readFile(history),count=engines.length;
    const family={rootThreadId:thread.id,cwd:project,fingerprint:context.fingerprint,model:row.model,modelProvider:'saleh_local',members:row.threads.map(id=>({id}))};
    if(variant==='reader')await owner.handle({action:'read',threadId:thread.id});
    const input=structuredClone(context),snapshot=structuredClone(family);if(variant==='wrong-generation')input.owner.generation=randomUUID();if(variant==='wrong-family')snapshot.members=[];
    if(['wrong-generation','wrong-family','unknown-closure'].includes(variant)){
     await assert.rejects(owner.reserveHandoffReconnect(async()=>[project,destination],input,snapshot),/owner|family|closed/i);assert.equal(engines.length,count);assert.deepEqual(JSON.parse(await readFile(file)),saved);
    }else{
     lease=await owner.reserveHandoffReconnect(async()=>[project,destination],context,family);assert.equal(engines.length,count+(variant==='reader'?1:0));if(variant==='reader')assert.equal(engines.at(-1).closed,true);
     const before=JSON.parse(await readFile(file));assert.deepEqual(before.owners[0].generation,row.generation);const next={...context,recovery:{directory:{dev:'4',ino:'2'},manifest:{identity:{dev:'4',ino:'5'},hash:'c'.repeat(64),bytes:124}}};let published=false;
     await assert.rejects(lease.rebind({...next,owner:{...next.owner,model:'other'}},async()=>{published=true;}),/descriptor/);assert.equal(published,false);
     if(variant==='late-reader'){await assert.rejects(owner.handle({action:'read',threadId:thread.id}),{code:'PROJECT_BUSY'});await lease.revalidateScope();assert.deepEqual(JSON.parse(await readFile(file)),before);}
     else if(variant==='selected-stop'){await owner.handle({action:'interruptFamily',threadId:thread.id});await assert.rejects(lease.revalidateScope(),/owner|cancel|changed/i);}
     else if(variant==='publish-failure'){await assert.rejects(lease.rebind(next,async()=>{throw Error('injected publication failure');}),/injected/);assert.deepEqual(JSON.parse(await readFile(file)),before);}
     else{
      await lease.rebind(next,async()=>{published=true;});assert(published);await lease.revalidateScope();const after=JSON.parse(await readFile(file));assert.deepEqual(after,{...before,owners:before.owners.map(r=>({...r,handoff:{context:next,commit:null}}))});
      await assert.rejects(lease.rebind(next,async()=>{}),/consumed/);
     }
    }
    assert.deepEqual(await readFile(history),historyBytes);
   }finally{await lease?.release();await owner.close();}
  },false);console.log('PASS closed-owner reconnect '+variant);
 }
}
if(process.argv.includes('--handoff-reconnect-owner-check')){try{await handoffReconnectOwnerChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--recovery-reader-check')){try{await recoveryReaderChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function closePending(owner){
 let settled=false;const work=owner.close();work.then(()=>settled=true,()=>settled=true);
 await new Promise(r=>setTimeout(r,30));assert.equal(settled,false,'Final close must wait for admitted work, not cache a premature unconfirmed result');
 assert.equal(owner.close(),work,'Repeated close must retain the same pending operation');assert.equal(owner.disposal,work);
 return {work};
}
async function emptyTerminalChecks(){
 for(const mode of ['vm','native']){
  const home=join(root,'empty-terminal-'+mode);await mkdir(home,{mode:0o700});const helper=join(home,'fixture-helper');await writeFile(helper,'inert transport',{mode:0o700});
  await withFixtureFilesystemIdentity(home,helper,async()=>{
   const settings=options(home);settings.engineOptions.nativeHelper=helper;
   settings.engineFactory=options=>{const engine=new FixtureEngine(options),handle=engine.handle.bind(engine);
    const close=engine.close.bind(engine);engine.close=async()=>{engine.terminals.clear();return close();};
    engine.handle=async input=>{
     if(input.action==='terminalStart'){const processId=randomUUID();engine.terminals.set(processId,{threadId:input.threadId});return {processId};}
     if(['terminalWrite','terminalInput','terminalStop'].includes(input.action)){assert(engine.terminals.has(input.processId));if(input.action==='terminalStop')engine.terminals.delete(input.processId);return {processId:input.processId};}
     return handle(input);
    };
    if(mode==='native'&&!options.historyOnly){engine.interruptFamily=async id=>{engine.terminals.clear();return {rootThreadId:id,state:'stopping'};};engine.stop=async()=>{engine.epoch++;engine.terminals.clear();return {message:'inert tracked drain'};};}
    return engine;
   };
   const owner=new CodingOwners(settings),catalog=async()=>JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8'));let first,second,creation;
   try{
    first=(await owner.handle({action:'start',cwd:root,executionMode:mode})).thread;creation=(await catalog()).owners[0].creation;
    const pipe=await owner.handle({action:'terminalStart',threadId:first.id,command:'inert fixture command'});await owner.handle({action:'terminalWrite',processId:pipe.processId,text:'inert input'});await owner.handle({action:'terminalStop',processId:pipe.processId});
    const pty=await owner.handle({action:'terminalStart',threadId:first.id,command:'',mode:'pty',cols:80,rows:24});await owner.handle({action:'terminalInput',processId:pty.processId,dataBase64:'eA=='});
    await owner.handle({action:'interruptFamily',threadId:first.id});await owner.disposal;second=(await owner.handle({action:'start',cwd:root,executionMode:mode})).thread;
   }finally{assert.equal((await owner.close()).stopped,true);}
   // VM starts retain the old unmaterialized contract; native starts now persist zero turns.
   const saved=await catalog();if(mode==='vm')for(const row of saved.owners)await writeFile(join(home,'owners',row.id,'fixture-threads.json'),'[]');
   const cold=new CodingOwners(settings);try{const list=await cold.handle({action:'list'});assert.deepEqual(new Set(list.threads.map(t=>t.id)),new Set([first.id,second.id]),'Cold list retains the terminal-only empty chat');assert.deepEqual(saved.owners[0].creation,creation);const read=await cold.handle({action:'read',threadId:first.id});assert.equal(read.historySource,mode==='vm'?'creation-receipt':undefined);assert.deepEqual(read.thread.turns,[]);assert.equal((await cold.handle({action:'family',threadId:first.id})).root.id,first.id);if(mode==='native'){assert.equal(saved.owners[0].creation,null);assert.equal(read.thread.executionMode,'native');assert((await cold.handle({action:'send',threadId:first.id,text:'first explicit message after reopen'})).turn);}}finally{await cold.close();}
   console.log('PASS '+mode+' empty chat survives terminal Start/Write/Input, Stop, second chat and cold list/read/family');
  },false);
 }
}
async function nativeOwnerChecks(){
 const home=join(root,'native-mixed'),runtime=join(home,'runtime'),project=join(root,'native-project');await mkdir(home,{mode:0o700});await mkdir(runtime,{mode:0o700});await mkdir(project,{mode:0o700});
 const helper=join(home,'fixture-helper');await writeFile(helper,'not executable fixture transport',{mode:0o700});
 const originalStatfs=fsPromises.statfs;fsPromises.statfs=async path=>{assert.equal(path,runtime);return {bsize:4096n,bavail:268435456n};};syncBuiltinESMExports();
 try{await withFixtureFilesystemIdentity(home,helper,async()=>{
  const oldHome=join(root,'native-v9');await mkdir(oldHome,{mode:0o700});const oldOwner=new CodingOwners(options(oldHome));
  try{await oldOwner.handle({action:'status'});const path=join(oldHome,'coding-owners.json'),before=await readFile(path,'utf8');await assert.rejects(oldOwner.handle({action:'start',cwd:project,executionMode:'native'}),/durable.*identity/i);assert.equal(await readFile(path,'utf8'),before);assert.equal((await oldOwner.handle({action:'status'})).owners.length,0);}finally{await oldOwner.close();}
  const settings=options(home),allocate=settings.openExecutor,resource={cpu:1,memoryBytes:1073741824,diskBytes:68719476736};
  settings.engineOptions.nativeHelper=helper;settings.executorPolicy={runtimeDir:runtime,resources:resource,limits:{cpu:3,memoryBytes:3221225472,diskBytes:206158430208,concurrent:3}};
  settings.openExecutor=async context=>{const path=join(runtime,context.ownerId+'-'+context.generation);await mkdir(path,{mode:0o700});const info=await lstat(path,{bigint:true});await context.recordAllocation({path,identity:{volumeUUID:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',ino:String(info.ino)}});return allocate(context);};
  const nativeEngines=[];let holdFamily=null,closeFault=null;
  settings.engineFactory=o=>{const e=new FixtureEngine(o);if(!o.historyOnly&&o.executor===undefined){nativeEngines.push(e);e.stopCalls=0;e.interruptCalls=0;e.stop=async()=>{e.stopCalls++;e.epoch++;if(closeFault){e.exitUnconfirmed=true;throw Error(closeFault);}await Promise.all(e.familyStops.values());e.runs.clear();e.terminals.clear();return {message:'tracked fixture work stopped'};};e.interruptFamily=async id=>{e.interruptCalls++;const work=(async()=>{if(holdFamily)await holdFamily;e.runs.clear();})();e.familyStops.set(id,work);void work.finally(()=>{if(e.familyStops.get(id)===work)e.familyStops.delete(id);});return {rootThreadId:id,targetThreadId:id,state:'stopping'};};}return e;};
  const catalog=async()=>JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8'));
  const seed=new CodingOwners(settings);for(let n=0;n<3;n++){const cwd=join(root,'vm-project-'+n);await mkdir(cwd,{mode:0o700});const t=(await seed.handle({action:'start',cwd})).thread;await materialize(seed,t);}await seed.close();
  const before=await catalog(),oldRows=JSON.stringify(before.owners),oldExecutor=JSON.stringify(before.executor),allocationCount=allocations.length;
  assert.equal(before.version,10);assert.equal(before.executor.allocations.length,3);assert(before.executor.allocations.every(a=>a.closed&&!a.diskRelease));
  const owner=new CodingOwners(settings);let thread,first;
  try{
   await assert.rejects(owner.handle({action:'start',cwd:project}),/storage is full/);
   const savedBeforeInvalid=await readFile(join(home,'coding-owners.json'),'utf8');for(const mode of ['other','',null,1])await assert.rejects(owner.handle({action:'start',cwd:project,executionMode:mode}),/mode|field/);assert.equal(await readFile(join(home,'coding-owners.json'),'utf8'),savedBeforeInvalid);
   const reply=await owner.handle({action:'start',cwd:project,executionMode:'native'});thread=reply.thread;assert.equal(reply.executionMode,'native');assert.equal(thread.executionMode,'native');first=nativeEngines.at(-1);assert(first);assert.equal(allocations.length,allocationCount);
   await materialize(owner,thread);assert.equal((await owner.handle({action:'read',threadId:thread.id})).thread.executionMode,'native');assert.equal((await owner.handle({action:'family',threadId:thread.id})).root.executionMode,'native');
   const list=await owner.handle({action:'list'});assert.equal(list.threads.find(t=>t.id===thread.id).executionMode,'native');assert(list.threads.filter(t=>t.id!==thread.id).every(t=>t.executionMode==='vm'));
   await owner.handle({action:'send',threadId:thread.id,text:'native one'});first.runs.set(thread.id,'held-turn');let release;holdFamily=new Promise(r=>release=r);
   const stopped=await owner.handle({action:'interruptFamily',threadId:thread.id});assert.equal(stopped.state,'stopping');assert.equal(first.closed,false);assert.equal((await catalog()).owners.find(r=>r.rootThreadId===thread.id).generation.execution,'native-active');
   await assert.rejects(owner.handle({action:'send',threadId:thread.id,text:'blocked until tracked stop'}),/Stop|stopping|pending/);release();await owner.disposal;holdFamily=null;
   const settled=(await catalog()).owners.find(r=>r.rootThreadId===thread.id);assert.equal(settled.generation.execution,'native-stopped');assert.equal(settled.generation.nativeOpen,true);assert.equal(settled.generation.executorClosed,false);assert.equal(first.closed,false);assert.equal(first.interruptCalls,1);
   assert.equal(owner.exitUnconfirmed,false,'Current idle native engine is an observed owner, not an unresolved VM');await mkdir(join(root,'unrelated-project'),{mode:0o700});const lease=await owner.reserveProjectMutation(async()=>[join(root,'unrelated-project')]);await lease.release();
   await owner.handle({action:'send',threadId:thread.id,text:'continue same local engine'});assert.equal(nativeEngines.at(-1),first);assert.equal((await catalog()).owners.find(r=>r.id===settled.id).generation.execution,'native-active');
   await owner.handle({action:'interruptFamily',threadId:thread.id});await owner.disposal;assert.equal((await catalog()).owners.find(r=>r.id===settled.id).generation.execution,'native-stopped','Stop also settles an already completed turn');
   await owner.handle({action:'send',threadId:thread.id,text:'Stop overlap'});first.runs.set(thread.id,'overlap-turn');holdFamily=new Promise(r=>release=r);await owner.handle({action:'interruptFamily',threadId:thread.id});const globalStop=owner.stop();await new Promise(r=>setImmediate(r));release();assert.equal((await globalStop).stopped,true,'Global Stop joins the selected native Stop before changing engine lifetime');holdFamily=null;
   const result=await owner.close();assert.equal(result.stopped,true);assert.equal(result.executionRevoked,false,'Native tracked closure is not VM revocation');assert(first.stopCalls>0);
  }finally{holdFamily=null;await owner.close().catch(()=>{});}
  const after=await catalog();assert.equal(after.version,11);assert.equal(JSON.stringify(after.owners.slice(0,3)),oldRows);assert.equal(JSON.stringify(after.executor),oldExecutor);const nativeRow=after.owners.at(-1);assert.equal(nativeRow.executionMode,'native');assert.equal(nativeRow.generation.execution,'native-stopped');assert.equal(nativeRow.generation.nativeOpen,false);assert.equal(nativeRow.generation.executorClosed,true);
  const cold=new CodingOwners(settings);try{assert.equal((await cold.handle({action:'read',threadId:thread.id})).thread.id,thread.id);assert((await cold.handle({action:'send',threadId:thread.id,text:'after cold reopen'})).turn);assert.equal(allocations.length,allocationCount);}finally{await cold.close();}
  assert.equal(JSON.stringify((await catalog()).owners.slice(0,3)),oldRows);assert.equal(JSON.stringify((await catalog()).executor),oldExecutor);
  const validBytes=await readFile(join(home,'coding-owners.json'),'utf8');
  for(const mutate of [row=>row.executionMode='vm',row=>row.generation.execution='revoked',row=>row.generation.execution='native-active']){
   const malformed=JSON.parse(validBytes);mutate(malformed.owners.at(-1));await writeFile(join(home,'coding-owners.json'),JSON.stringify(malformed));const invalid=new CodingOwners(settings);
   try{await assert.rejects(invalid.handle({action:'status'}),/mode|generation/);}finally{await invalid.close().catch(()=>{});await writeFile(join(home,'coding-owners.json'),validBytes);}
  }
  const failed=new CodingOwners(settings);await failed.handle({action:'send',threadId:thread.id,text:'closure failure'});closeFault='native tracked closure fixture failure';await assert.rejects(failed.close(),/native tracked closure/);await lstat(join(home,'coding-owners.lock'));const unknown=(await catalog()).owners.at(-1);assert.equal(unknown.generation.execution,'native-active');assert.equal(unknown.generation.executorClosed,false);assert.equal(unknown.generation.nativeOpen,true);
  const contender=new CodingOwners(settings);await assert.rejects(contender.handle({action:'send',threadId:thread.id,text:'must remain fenced'}),/lease|closure|pending/);await contender.close().catch(()=>{});closeFault=null;
  console.log('PASS native full-VM-capacity admission, explicit mode, scoped/idle/global Stop, cold resume, VM conservation, invalid mode/catalog and failed closure fence');
 },false);}finally{fsPromises.statfs=originalStatfs;syncBuiltinESMExports();}
}
async function nativeForkChecks(){
 for(const variant of ['preserve','stop-cold-bind','stop-snapshot','stop-copy','stop-dispatch']){
  if(process.argv[3]&&process.argv[3]!==variant)continue;
  const home=join(root,'native-fork-'+variant),project=join(root,'native-fork-project-'+variant),helper=join(home,'fixture-helper');
  await mkdir(home,{mode:0o700});await mkdir(project,{mode:0o700});await writeFile(helper,'inert fixture transport',{mode:0o700});
  let identityGate;
  await withFixtureFilesystemIdentity(home,helper,async()=>{
   const settings=options(home);settings.engineOptions.nativeHelper=helper;
   settings.openExecutor=async()=>{throw Error('Native fork must not allocate a VM');};
   settings.engineFactory=o=>{const e=new FixtureEngine(o);if(!o.historyOnly&&o.executor===undefined){e.stop=async()=>{e.epoch++;await Promise.all(e.familyStops.values());e.runs.clear();e.terminals.clear();return {message:'tracked fixture work stopped'};};e.interruptFamily=async id=>{e.runs.clear();return {rootThreadId:id,state:'stopping'};};}return e;};
   const catalog=async()=>JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8'));
   let owner=new CodingOwners(settings),release,work;
   try{
    const source=(await owner.handle({action:'start',cwd:project,executionMode:'native'})).thread,sourceEngine=await materialize(owner,source),sourcePath=(await sourceEngine.rows())[0].path,sourceBytes=await readFile(sourcePath,'utf8'),before=await catalog(),allocationCount=allocations.length;
    if(variant==='preserve'){
     const result=await owner.handle({action:'fork',threadId:source.id}),fork=result.thread;
     assert.equal(result.executionMode,'native');assert.equal(fork.executionMode,'native');assert.notEqual(fork.id,source.id);assert.equal(fork.forkedFromId,source.id);
     assert.equal(await readFile(sourcePath,'utf8'),sourceBytes,'Fork leaves source history byte-for-byte intact');
     const forkBytes=await readFile(fork.path,'utf8'),sourceLines=sourceBytes.trimEnd().split('\n'),forkLines=forkBytes.trimEnd().split('\n');assert.deepEqual(forkLines.slice(1),sourceLines.slice(1),'Fork inherits complete saved history');assert.equal(JSON.parse(forkLines[0]).payload.id,fork.id);
     const rows=(await catalog()).owners;assert.equal(rows.length,2);assert(rows.every(r=>r.executionMode==='native'));assert.notEqual(rows[0].home.ino,rows[1].home.ino);assert.equal(rows[1].fork.sourceOwnerId,rows[0].id);assert.equal(rows[1].creation,null);assert.equal(rows[0].generation.execution,'native-stopped');assert.equal(rows[0].generation.nativeOpen,false);assert.equal(rows[0].generation.executorClosed,true);
     assert.equal((await owner.handle({action:'read',threadId:fork.id})).thread.executionMode,'native');assert.equal((await owner.handle({action:'family',threadId:fork.id})).root.executionMode,'native');assert((await owner.handle({action:'list'})).threads.every(t=>t.executionMode==='native'));
     assert((await owner.handle({action:'send',threadId:fork.id,text:'explicit fork continuation'})).turn);
     await owner.close();owner=new CodingOwners(settings);
     for(const id of [source.id,fork.id]){assert.equal((await owner.handle({action:'read',threadId:id})).thread.id,id);assert((await owner.handle({action:'send',threadId:id,text:'explicit cold continuation'})).turn);}
     assert.equal(await readFile(sourcePath,'utf8'),sourceBytes);assert.equal(allocations.length,allocationCount);assert.deepEqual((await catalog()).executor,before.executor);
    }else if(variant==='stop-cold-bind'){
     await owner.close();owner=new CodingOwners(settings);
     let entered=false,settled=false,failure;const held=new Promise(r=>release=r),engineCount=engines.length;
     // The first source-home identity check follows cold catalog loading, before
     // #fork binds its source or opens a history reader. Hold the real FD check.
     identityGate=path=>{if(path===sourceEngine.dataDir){identityGate=null;entered=true;return held;}};
     work=owner.handle({action:'fork',threadId:source.id});work.then(()=>settled=true,e=>{settled=true;failure=e;});
     const deadline=Date.now()+3000;while(Date.now()<deadline&&!settled&&!entered)await new Promise(r=>setTimeout(r,1));
     assert(entered&&!settled,'Cold fork must reach its first source-home identity check: '+failure?.message);
     assert.equal(engines.length,engineCount,'No owner reader starts before the cold binding gate');
     assert.equal((await owner.handle({action:'interruptFamily',threadId:source.id})).state,'stopped');
     release();await assert.rejects(work,/selected Stop/,'Cold source Stop must cancel its pending unbound fork');await owner.disposal;
     const cancelled=await catalog();assert.equal(cancelled.owners.length,1,'Cancelled cold fork must not create a destination owner');
     assert.equal(cancelled.owners[0].generation.nativeOpen,false);assert.equal(cancelled.owners[0].generation.execution,'native-stopped');assert.equal(cancelled.owners[0].generation.executorClosed,true);
     assert(!calls.some(c=>c.home.startsWith(home+'/')&&c.input.action==='nativeFork'),'Cancelled cold fork must not dispatch');
     assert.equal(engines.length,engineCount,'Cancelled cold fork must not open an owner engine');
     assert.equal(allocations.length,allocationCount);assert.deepEqual(cancelled.executor,before.executor);assert.equal(await readFile(sourcePath,'utf8'),sourceBytes);
     const resumed=await owner.handle({action:'fork',threadId:source.id});assert.equal(resumed.executionMode,'native');assert.notEqual(resumed.thread.id,source.id);
     const final=await catalog();assert.equal(final.owners.length,2);assert(final.owners.every(r=>r.executionMode==='native'));assert.equal(final.owners[1].fork.sourceOwnerId,final.owners[0].id);
     assert.equal(calls.filter(c=>c.home.startsWith(home+'/')&&c.input.action==='nativeFork').length,1,'A later explicit fork remains usable');
     assert.equal(allocations.length,allocationCount);assert.deepEqual(final.executor,before.executor);assert.equal(await readFile(sourcePath,'utf8'),sourceBytes);
    }else{
     let entered=false,settled=false,failure;const held=new Promise(r=>release=r),files=settings.forkFiles;
     if(variant==='stop-dispatch')forkReplyGate=held;
     else settings.forkFiles=async(action,input,context)=>{if(action===(variant==='stop-snapshot'?'snapshot':'copy')){entered=true;await held;}return files(action,input,context);};
     // Recreate the coordinator so the chosen file gate enters through its trusted constructor seam.
     await owner.close();owner=new CodingOwners(settings);
     let peer,peerEngine,peerGeneration;if(variant==='stop-dispatch'){const peerProject=join(root,'native-fork-peer');await mkdir(peerProject,{mode:0o700});peer=(await owner.handle({action:'start',cwd:peerProject,executionMode:'native'})).thread;peerEngine=engines.findLast(e=>e.threadInfo.has(peer.id));peerGeneration=(await catalog()).owners.find(r=>r.rootThreadId===peer.id).generation.id;}
     work=owner.handle({action:'fork',threadId:source.id});work.then(()=>settled=true,e=>{settled=true;failure=e;});
     const deadline=Date.now()+3000;while(Date.now()<deadline&&!settled&&!(entered||variant==='stop-dispatch'&&calls.some(c=>c.home.startsWith(home+'/')&&c.input.action==='nativeFork')))await new Promise(r=>setTimeout(r,1));
     assert(!settled,'Fork must reach the cancellation gate: '+failure?.message);
     const current=await catalog(),destination=current.owners.find(r=>r.fork);assert.equal(current.owners[0].generation.nativeOpen,false,'Source closes before the snapshot and fork dispatch');
     const stopped=await owner.handle({action:'interruptFamily',threadId:source.id});assert.equal(stopped.state,'stopping','Source Stop must cancel its pending fork even after source retirement');
     release();forkReplyGate=null;await assert.rejects(work,/Stop|cancelled|closed|lifecycle/);await owner.disposal;
     const final=await catalog(),stoppedRows=final.owners.filter(r=>r.rootThreadId!==peer?.id);assert(stoppedRows.every(r=>!r.generation?.nativeOpen));assert(stoppedRows.every(r=>!r.generation||r.generation.execution==='native-stopped'&&r.generation.executorClosed));assert(final.owners.every(r=>r.executionMode==='native'));assert.equal(allocations.length,allocationCount);assert.deepEqual(final.executor,before.executor);assert.equal(await readFile(sourcePath,'utf8'),sourceBytes);
     if(variant==='stop-snapshot')assert.equal(final.owners.length,1);
     if(variant==='stop-copy')assert(!calls.some(c=>c.home===join(home,'owners',destination.id)&&c.input.action==='nativeFork'));
     if(variant==='stop-dispatch'){assert.equal(final.owners.length,3);const fork=final.owners.find(r=>r.fork),savedPeer=final.owners.find(r=>r.rootThreadId===peer.id);assert.equal(fork.state,'ready','Valid late fork identity remains recoverable');assert.notEqual(fork.rootThreadId,source.id);assert.equal(savedPeer.generation.id,peerGeneration);assert.equal(savedPeer.generation.nativeOpen,true);assert.equal(peerEngine.closed,false,'Source Stop leaves unrelated native owner live');assert((await owner.handle({action:'send',threadId:peer.id,text:'peer remains usable'})).turn);assert.equal(engines.findLast(e=>e.threadInfo.has(peer.id)),peerEngine);}
    }
   }finally{release?.();forkReplyGate=null;if(work)await Promise.allSettled([work]);await owner.close().catch(()=>{});}
   console.log('PASS native fork '+variant+' preserves owner/history/mode and closes tracked work');
  },false,path=>identityGate?.(path));
 }
}
async function nativeMaterializationChecks(){
 for(const variant of ['omitted-active','omitted-archived','archive-failure','archive-moved-error','unarchive-failure','stop-after-archive']){
  if(process.argv[3]&&process.argv[3]!==variant)continue;
  const home=join(root,'native-materialization-'+variant),helper=join(home,'fixture-helper');await mkdir(home,{mode:0o700});await writeFile(helper,'inert fixture transport',{mode:0o700});
  await withFixtureFilesystemIdentity(home,helper,async()=>{
   const settings=options(home);settings.engineOptions.nativeHelper=helper;settings.openExecutor=async()=>{throw Error('Native materialization must not allocate a VM');};
   let release,entered=false,settled=false,failure,work;const held=new Promise(r=>release=r);
   settings.engineFactory=o=>{const e=new FixtureEngine(o),handle=e.handle.bind(e);if(!o.historyOnly&&o.executor===undefined){e.stop=async()=>{e.epoch++;e.runs.clear();e.terminals.clear();return {message:'tracked fixture stopped'};};e.interruptFamily=async id=>({rootThreadId:id,state:'stopping'});}e.handle=async input=>{if(input.action==='archive'&&variant==='archive-failure'||input.action==='unarchive'&&variant==='unarchive-failure')throw Error('materialization fixture failure');const result=await handle(input);if(input.action==='list')return {...result,threads:[],nextCursor:null};if(input.action==='archive'&&variant==='archive-moved-error')throw Error('materialization fixture failure after move');if(input.action==='archive'&&variant==='stop-after-archive'){entered=true;await held;}return result;};return e;};
   const catalog=async()=>JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8'));let owner=new CodingOwners(settings);
   try{
    work=owner.handle({action:'start',cwd:root,executionMode:'native'});work.then(()=>settled=true,e=>{settled=true;failure=e;});
    if(variant==='stop-after-archive'){
     const deadline=Date.now()+3000;while(Date.now()<deadline&&!entered&&!settled)await new Promise(r=>setTimeout(r,1));assert(entered,'Must reach confirmed archive before Stop: '+failure?.message);
     const row=(await catalog()).owners[0];assert.equal(row.state,'ready');assert(row.rootThreadId);assert.equal((await owner.handle({action:'interruptFamily',threadId:row.rootThreadId})).state,'stopping');release();await assert.rejects(work,/Stop|cancelled/);await owner.disposal;
    }else if(variant.startsWith('omitted-')){const started=await work;if(variant==='omitted-archived')await owner.handle({action:'archive',threadId:started.thread.id});}else await assert.rejects(work,/materialization fixture failure/);
    const row=(await catalog()).owners[0],id=row.rootThreadId;assert.equal(row.state,'ready');assert(id);assert.equal(row.executionMode,'native');assert.equal(calls.filter(c=>c.home===join(home,'owners',row.id)&&c.input.action==='start').length,1,'No replacement chat is created');assert(!calls.some(c=>c.home===join(home,'owners',row.id)&&['send','nativeFork'].includes(c.input.action)),'Persistence adds no prompt or fork');
    await owner.close();
    if(variant==='archive-failure'){assert(row.creation);await writeFile(join(home,'owners',row.id,'fixture-threads.json'),'[]');}else if(variant==='archive-moved-error')assert(row.creation,'Lost archive reply retains receipt while real archive membership wins');else assert.equal(row.creation,null);
    owner=new CodingOwners(settings);const archived=!['archive-failure','omitted-active'].includes(variant),list=await owner.handle({action:'list',archived});assert.equal(list.threads.length,1);assert.equal(list.threads[0].id,id);assert.deepEqual(list.threads[0].turns,[]);assert.equal(list.threads[0].name,variant==='archive-failure'?null:undefined);assert.equal((await owner.handle({action:'list',archived:!archived})).threads.length,0,'Interrupted materialization is not relisted in the wrong archive lane');const read=await owner.handle({action:'read',threadId:id});assert.equal(read.thread.id,id);assert.equal(read.historySource,variant==='archive-failure'?'creation-receipt':undefined);
   }finally{release();if(work)await Promise.allSettled([work]);await owner.close().catch(()=>{});}
   console.log('PASS native empty '+variant+' preserves original identity without invented turns');
  },false);
 }
}
async function nativeAdmissionStopChecks(){
 const bounded=async(work,label)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' did not settle within 3000 ms')),3000);})]);}finally{clearTimeout(timer);}};
 const failures=[];
 for(const control of ['selected','stop-all','close','direct-stop-all','direct-close']){
  const direct=control.startsWith('direct-');
  const home=join(root,'native-admission-'+control),project=join(home,'project'),helper=join(home,'fixture-helper');
  await mkdir(home,{mode:0o700});await mkdir(project,{mode:0o700});await writeFile(helper,'inert fixture transport',{mode:0o700});
  try{await withFixtureFilesystemIdentity(home,helper,async()=>{
   let release,entered,paused=false;const held=new Promise(r=>release=r),reached=new Promise(r=>entered=r),dispatches=[];
   // Exercise real admission, resume, begin and cancellation. Only native
   // process/config/RPC boundaries use the existing disposable fixture.
   class AdmissionEngine extends FixtureEngine {
    async handle(input,...args){return ['send','review'].includes(input.action)?CodingEngine.prototype.handle.call(this,input,...args):super.handle(input,...args);}
    async begin(...args){if(paused&&direct){entered();await held;}return CodingEngine.prototype.begin.apply(this,args);}
    interruptFamily(...args){return CodingEngine.prototype.interruptFamily.apply(this,args);}
    stop(...args){return CodingEngine.prototype.stop.apply(this,args);}
    async prepare(){if(paused&&!direct){entered();await held;}}
    async rpc(method,params){
     if(['turn/start','review/start'].includes(method)){dispatches.push({method,threadId:params.threadId});return {turn:{id:randomUUID(),status:'completed'}};}
     if(method==='turn/interrupt'){this.receive({method:'turn/completed',params:{threadId:params.threadId,turn:{id:params.turnId,status:'interrupted',items:[]}}});return {};}
     if(method==='thread/resume')return {thread:(await this.rows()).find(t=>t.id===params.threadId)};
     if(method==='thread/list')return {data:[],nextCursor:null};
     if(method==='thread/loaded/list')return {data:[...this.loaded],nextCursor:null};
     if(method==='thread/backgroundTerminals/list')return {data:[],nextCursor:null};
     return super.rpc(method,params);
    }
   }
   const settings=options(home);settings.engineOptions.nativeHelper=helper;settings.engineFactory=o=>new AdmissionEngine(o);
   settings.openExecutor=async()=>{throw Error('Native cancellation must not allocate a VM');};
   const owner=new CodingOwners(settings),catalog=async()=>JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8'));let pending,stopping,failure;
   try{
    const thread=(await owner.handle({action:'start',cwd:project,executionMode:'native'})).thread,engine=await materialize(owner,thread);
    engine.loaded.add(thread.id);
    const before=await catalog(),historyPath=(await engine.rows())[0].path,history=await readFile(historyPath);
    paused=true;
    pending=owner.handle({action:'send',threadId:thread.id,text:'must not dispatch after Stop'});
    const outcome=pending.then(value=>({value}),error=>({error}));
    await bounded(Promise.race([reached,outcome.then(result=>{throw Error('Send settled before preparation: '+result.error?.message);})]),'Preparation gate');
    assert.equal(engine.admissions.size,1,'Real send admission must remain pending in preparation');
    assert.equal(dispatches.length,0);
    if(direct){
     // Queue entry to real begin first. The owner must revoke this admission
     // synchronously; queued async cleanup has not called engine.stop yet.
     paused=false;release();stopping=control==='direct-close'?owner.close():owner.stop();
    }else{
     const requested=await owner.handle({action:'interruptFamily',threadId:thread.id});assert.equal(requested.state,'stopping');
     // The real engine family drain can finish before this admitted send. The
     // owner ticket still waits for send while a global cleanup joins it.
     await bounded(Promise.all([...engine.familyStops.values()]),'Selected engine Stop');
     if(control==='stop-all')stopping=owner.stop();
     if(control==='close')stopping=owner.close();
     paused=false;release();
    }
    const result=await bounded(outcome,'Cancelled send');
    assert.equal(dispatches.length,0,control+': no turn/start or review/start may dispatch after Stop');
    if(stopping)await bounded(stopping,control);
    await bounded(owner.disposal,'Owner Stop disposal');
    assert(result.error&&/Stop|cancelled|closed/i.test(result.error.message),'Pending send must reject as cancelled');
    assert.equal(engine.admissions.size,0);assert.equal(engine.familyOperations.size,0);assert.equal(engine.runs.size,0);
    if(direct)assert.equal((await bounded(owner.close(),'Direct Stop final close')).stopped,true);
    const after=await catalog();assert.deepEqual(after.executor,before.executor);assert.deepEqual(await readFile(historyPath),history);
    assert.equal(after.owners.length,1);assert.equal(after.owners[0].generation.execution,'native-stopped');
    if(control==='selected'){
     assert.equal(engine.closed,false,'Selected Stop retains the current native engine');
     assert.equal(after.owners[0].generation.nativeOpen,true);
     assert((await owner.handle({action:'send',threadId:thread.id,text:'new explicit work after Stop'})).turn);
     assert.equal(dispatches.length,1,'A new explicit request remains usable');
    }
    assert.equal((await bounded(owner.close(),'Final owner close')).stopped,true);
    console.log('PASS native admission '+control+' cancels prepared send without dispatch and settles cleanly');
   }catch(error){failure=error;throw error;}
   finally{paused=false;release();try{await bounded(Promise.allSettled([pending,stopping]),'Fixture work cleanup');await bounded(owner.close(),'Fixture owner cleanup');}catch(error){if(!failure)throw error;}}
  },false);}catch(error){failures.push(error);console.error('FAIL native admission '+control+': '+error.message);}
 }
 if(failures.length)throw new AggregateError(failures,'Native admission Stop regression failed');
}
if(process.argv.includes('--native-admission-stop-check')){try{await nativeAdmissionStopChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--native-materialization-check')){try{await nativeMaterializationChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--native-fork-check')){try{await nativeForkChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--native-owner-check')){try{await emptyTerminalChecks();await nativeOwnerChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--empty-terminal-check')){try{await emptyTerminalChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--closure-parent-child')){
 const home=join(root,'parent-home');await mkdir(home,{mode:0o700});const settings=options(home),open=settings.openExecutor;let release;const held=new Promise(r=>release=r);
 process.on('message',()=>release());
 settings.openExecutor=async context=>({...await open(context),retire:async()=>{process.send({event:'retiring'});await held;return {ownerId:context.ownerId,generation:context.generation,closed:process.argv[3]==='closed',revoked:false};}});
 const owner=new CodingOwners(settings);await owner.handle({action:'start',cwd:root});const inert={start(){},async close(){return{stopped:true};}};
 const server=createServer({instanceToken:randomUUID(),coding:owner,hub:inert,worktrees:{...inert},gitWorkflow:inert,schedules:inert});server.listen(0,'127.0.0.1');await once(server,'listening');
 watchParent(async()=>{const result=await server.shutdownTools();process.send({event:'settled',stopped:result.stopped});return result;});process.send({event:'ready',root,home});await new Promise(()=>{});
}
async function closureChecks(){
 const home=join(root,'physical-signed');await mkdir(home,{mode:0o700});const settings=options(home),allocate=settings.openExecutor;let retired=0;
 settings.openExecutor=async context=>({...await allocate(context),retire:async()=>{retired++;return {ownerId:context.ownerId,generation:context.generation,closed:true,revoked:false};}});
 const owner=new CodingOwners(settings),thread=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,thread);
 const token=randomUUID(),inert={start(){},async close(){return{stopped:true};},async stop(){return{stopped:true};}};
 const server=createServer({instanceToken:token,coding:owner,hub:inert,worktrees:{...inert},gitWorkflow:inert,schedules:inert});server.listen(0,'127.0.0.1');await once(server,'listening');
 const post=async route=>{const body='{}',nonce=randomUUID(),time=String(Date.now()),response=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:{'content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)},body});assert.equal(response.status,200);return response.json();};
 try{
  const stopped=await post('/api/tools/stop');
  assert.equal(stopped.stopped,true,'Confirmed current physical closure permits Stop while historical execution stays fenced');
  assert.equal(stopped.executionRevoked,false);assert.equal(stopped.results.coding.executionRevoked,false);
  const row=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0];assert.equal(row.generation.executorClosed,true,'Persist exact physical closure separately');assert.equal(row.generation.execution,'unrevoked');
  assert.equal(owner.exitUnconfirmed,true);assert.equal(owner.shutdownUnconfirmed,false);
  const result=await post('/api/tools/shutdown');assert.equal(result.stopped,true);assert.equal(result.results.coding.executionRevoked,false);assert.deepEqual(await post('/api/tools/shutdown'),result);assert.equal(retired,1);await assert.rejects(lstat(join(home,'coding-owners.lock')),{code:'ENOENT'});
 }finally{await owner.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
 const before=allocations.length,cold=new CodingOwners(settings);
 try{assert.equal((await cold.handle({action:'read',threadId:thread.id})).thread.id,thread.id);await assert.rejects(cold.handle({action:'send',threadId:thread.id,text:'must remain blocked'}),/revocation|pending/);await assert.rejects(cold.reserveProjectMutation(async()=>[root]),/pending/);assert.equal(allocations.length,before);}
 finally{assert.equal((await cold.close()).stopped,true);}
 assert.equal(JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0].generation.executorClosed,true,'History reader preserves domain closure');
 console.log('PASS physical closure signed shutdown and cold execution fences');
 for(const mode of ['missing','false','malformed','wrong-generation','revoked-open']){
  const home=join(root,'physical-'+mode);await mkdir(home,{mode:0o700});const settings=options(home),open=settings.openExecutor;let attempts=0;
  settings.openExecutor=async context=>({...await open(context),retire:async()=>{attempts++;return {ownerId:context.ownerId,generation:mode==='wrong-generation'?randomUUID():context.generation,revoked:mode==='revoked-open',...(mode==='missing'?{}:{closed:mode==='false'||mode==='revoked-open'?false:mode==='malformed'?'true':true})};}});
  const owner=new CodingOwners(settings);await owner.handle({action:'start',cwd:root});
  await assert.rejects(owner.close(),/closure|generation/);await assert.rejects(owner.close(),/closure|generation/);assert.equal(attempts,1);assert.equal(owner.shutdownUnconfirmed,true);await lstat(join(home,'coding-owners.lock'));
  const saved=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0];assert.equal(saved.generation.executorClosed,false);assert.equal(saved.generation.execution,'unrevoked');
  console.log('PASS physical closure '+mode);
 }
 for(const version of [1,2,3,4]){
  const home=join(root,'physical-v'+version);await mkdir(home,{mode:0o700});const settings=options(home),open=settings.openExecutor;settings.openExecutor=async context=>({...await open(context),retire:async()=>({ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true})});
  const seed=new CodingOwners(settings),thread=(await seed.handle({action:'start',cwd:root})).thread;await materialize(seed,thread);if(version===4)await seed.handle({action:'fork',threadId:thread.id});await seed.close();
  const file=join(home,'coding-owners.json'),saved=JSON.parse(await readFile(file,'utf8'));saved.version=version;delete saved.executor;if(version===1)delete saved.legacy;for(const row of saved.owners){delete row.mcp;delete row.generation.executorClosed;if(version<3)delete row.creation;if(version<4)delete row.fork;}await writeFile(file,JSON.stringify(saved));
  const cold=new CodingOwners(settings);await cold.handle({action:'status'});const upgraded=JSON.parse(await readFile(file,'utf8'));assert.equal(upgraded.version,9);assert(upgraded.owners.every(r=>r.generation.executorClosed===false));assert.deepEqual(upgraded.owners,saved.owners.map(r=>({...r,mcp:{kind:'never-enabled'},creation:r.creation??null,fork:r.fork??null,generation:{...r.generation,executorClosed:false}})));
  await assert.rejects(cold.handle({action:'send',threadId:thread.id,text:'old closure unknown'}),/closure|pending/);assert.equal((await cold.handle({action:'read',threadId:thread.id})).thread.id,thread.id);
  assert.equal((await cold.close()).stopped,false);await lstat(join(home,'coding-owners.lock'));assert(JSON.parse(await readFile(file,'utf8')).owners.every(r=>r.generation.executorClosed===false));console.log('PASS physical closure conservative v'+version+' migration');
 }
 for(const mode of ['closed','unknown']){
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--closure-parent-child',mode],{stdio:['pipe','pipe','pipe','ipc']}),events=[];let diagnostics='',ended=false;
  child.stdout.resume();child.stderr.on('data',chunk=>diagnostics+=chunk);child.on('message',event=>events.push(event));const closed=once(child,'close');closed.then(()=>ended=true);
  const until=async name=>{for(let i=0;i<300&&!events.some(e=>e.event===name)&&!ended;i++)await new Promise(r=>setTimeout(r,10));assert(events.some(e=>e.event===name),'Parent fixture event '+name);return events.find(e=>e.event===name);};let ready;
  try{ready=await until('ready');child.stdin.end();await until('retiring');await new Promise(r=>setTimeout(r,50));assert.equal(ended,false);await lstat(join(ready.home,'coding-owners.lock'));child.send('release');const result=await until('settled');assert.equal(result.stopped,mode==='closed');
   if(mode==='closed'){const result=await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('Physical shutdown did not exit')),2000).unref())]);assert.deepEqual(result,[0,null]);await assert.rejects(lstat(join(ready.home,'coding-owners.lock')),{code:'ENOENT'});}
   else{await new Promise(r=>setTimeout(r,100));assert.equal(ended,false);assert.match(diagnostics,/unconfirmed/);await lstat(join(ready.home,'coding-owners.lock'));}
   const saved=JSON.parse(await readFile(join(ready.home,'coding-owners.json'),'utf8')).owners[0];assert.equal(saved.generation.executorClosed,mode==='closed');assert.equal(saved.generation.execution,'unrevoked');console.log('PASS physical closure parent EOF '+mode);
  }finally{if(!ended)child.kill('SIGKILL');await closed;if(ready)await rm(ready.root,{recursive:true,force:true});}
 }
 const failedHome=join(root,'physical-allocation-rejected');await mkdir(failedHome,{mode:0o700});let attempted=0;
 const failed=new CodingOwners({...options(failedHome),openExecutor:async()=>{attempted++;throw Error('Allocation may have side effects');}});
 await assert.rejects(failed.handle({action:'start',cwd:root}),/side effects/);await assert.rejects(failed.close(),/side effects/);assert.equal(attempted,1);await lstat(join(failedHome,'coding-owners.lock'));assert.equal(JSON.parse(await readFile(join(failedHome,'coding-owners.json'),'utf8')).owners[0].generation.executorClosed,false);console.log('PASS physical closure rejected allocation remains unknown');
 const legacyHome=join(root,'physical-legacy');await mkdir(join(legacyHome,'sessions'),{recursive:true,mode:0o700});let legacyAdmissions=0;
 const legacyOptions={...options(legacyHome),assertLegacyClosed:async()=>{legacyAdmissions++;}};
 for(let n=0;n<2;n++){const legacy=new CodingOwners(legacyOptions);await legacy.handle({action:'list'});const result=await legacy.close();assert.equal(result.stopped,true);assert.equal(result.executionRevoked,false);assert.equal(legacy.exitUnconfirmed,true);assert.equal(legacy.shutdownUnconfirmed,false);}
 assert.equal(legacyAdmissions,2);const legacyFile=join(legacyHome,'coding-owners.json'),legacyData=JSON.parse(await readFile(legacyFile,'utf8'));legacyData.legacy.nativeOpen=true;await writeFile(legacyFile,JSON.stringify(legacyData));const legacyUnknown=new CodingOwners(legacyOptions);await legacyUnknown.handle({action:'status'});assert.equal((await legacyUnknown.close()).stopped,false);await lstat(join(legacyHome,'coding-owners.lock'));console.log('PASS physical closure legacy reader scope and unknown native owner');
 const cancelHome=join(root,'physical-before-allocation');await mkdir(cancelHome,{mode:0o700});const cancelled=new CodingOwners(options(cancelHome)),file=join(cancelHome,'coding-owners.json'),original=fsPromises.rename;
 let enter,release,seen=false;const ready=new Promise(r=>enter=r),held=new Promise(r=>release=r),beforeCancel=allocations.length;
 fsPromises.rename=async(...args)=>{const result=await original(...args);if(args[1]===file&&!seen&&JSON.parse(await readFile(file,'utf8')).owners.some(r=>r.generation)){seen=true;enter();await held;}return result;};syncBuiltinESMExports();
 const start=assert.rejects(cancelled.handle({action:'start',cwd:root}),/Stop|cancelled/);
 try{await ready;const closing=await closePending(cancelled);release();await start;assert.equal((await closing.work).stopped,true);assert.equal(allocations.length,beforeCancel);const row=JSON.parse(await readFile(file,'utf8')).owners[0];assert.equal(row.generation.executorClosed,true);assert.equal(row.generation.execution,'unrevoked');console.log('PASS physical closure never-invoked allocator');}
 finally{release();fsPromises.rename=original;syncBuiltinESMExports();await start;await cancelled.close();}
}
if(process.argv.includes('--closure-check')){try{await closureChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function readinessChecks(){
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const within=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),1000))]);}finally{clearTimeout(timer);}};
 for(const mode of ['success','reject','stop-late-success','stop-late-failure']){
  const home=join(root,'readiness-'+mode);await mkdir(home,{mode:0o700});const settings=options(home),open=settings.openExecutor,ready=deferred(),acquired=deferred(),retiring=deferred();
  const before=engines.length;let settled=false,bindingReads=0,retirements=0,context;
  settings.openExecutor=async value=>{context=value;const original=await open(value);acquired.resolve();return {ready:ready.promise,get binding(){bindingReads++;return original.binding;},retire:async()=>{retirements++;retiring.resolve();await ready.promise.catch(()=>{});return {ownerId:value.ownerId,generation:value.generation,closed:true,revoked:false};}};};
  const owner=new CodingOwners(settings),start=owner.handle({action:'start',cwd:root}).then(value=>{settled=true;return {value};},error=>{settled=true;return {error};});
  try{
   await acquired.promise;await tick();assert.equal(settled,false,'Readiness must hold admission');assert.equal(bindingReads,0,'Binding must not be read before readiness');assert.equal(engines.length,before,'No engine exists before readiness');
   await assert.rejects(owner.reserveProjectMutation(async()=>[root]),/pending/);
   if(mode.startsWith('stop-')){
    assert.equal((await owner.stop()).stopped,false);assert(context.signal.aborted);await within(retiring.promise,'Stop did not reach retirement while readiness was held');assert.equal(retirements,1);assert.equal(settled,false,'Retirement must drain the pending readiness operation');
    const closing=await closePending(owner);await lstat(join(home,'coding-owners.lock'));
    if(mode.endsWith('success'))ready.resolve();else ready.reject(Error('late readiness failure'));
    const result=await within(start,'Cancelled admission did not drain');assert.match(result.error?.message??'',/cancelled|Stop/);assert.equal((await closing.work).stopped,true);assert.equal(engines.length,before);assert.equal(bindingReads,0,'Late readiness cannot admit binding');
   }else if(mode==='reject'){
    ready.reject(Error('readiness failed'));const result=await within(start,'Rejected readiness did not drain');assert.match(result.error?.message??'',/readiness failed/);assert.equal(retirements,1);assert.equal(engines.length,before);assert.equal((await owner.close()).stopped,true);
   }else{
    ready.resolve();const result=await within(start,'Ready executor was not admitted');assert(result.value?.thread);assert.equal(engines.length,before+1);assert(bindingReads>0);assert.equal((await owner.close()).stopped,true);assert.equal(retirements,1);
   }
   const row=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0];assert.equal(row.generation.executorClosed,true);assert.equal(row.generation.execution,'unrevoked');assert.equal(owner.exitUnconfirmed,true);assert.equal(owner.shutdownUnconfirmed,false);console.log('PASS executor readiness '+mode);
  }finally{ready.resolve();await start;await owner.close().catch(()=>{});}
 }
 for(const [mode,value] of [['null',null],['boolean',true],['object',{}],['noncallable-then',{then:1}]]){
  const home=join(root,'readiness-malformed-'+mode);await mkdir(home,{mode:0o700});const settings=options(home),open=settings.openExecutor,before=engines.length;let retirements=0;
  settings.openExecutor=async context=>({...await open(context),ready:value,retire:async()=>{retirements++;return {ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true};}});
  const owner=new CodingOwners(settings);try{await assert.rejects(owner.handle({action:'start',cwd:root}),/readiness/);assert.equal(retirements,1);assert.equal(engines.length,before);assert.equal((await owner.close()).stopped,true);console.log('PASS malformed executor readiness '+mode);}finally{await owner.close().catch(()=>{});}
 }
 for(const [mode,value] of [['absent',undefined],['null',null],['boolean',true]]){
  const home=join(root,'readiness-retire-'+mode);await mkdir(home,{mode:0o700});const settings=options(home),open=settings.openExecutor,before=engines.length,ready=deferred();
  settings.openExecutor=async context=>({...await open(context),ready:ready.promise,retire:value});
  const owner=new CodingOwners(settings),unhandled=[],observe=error=>unhandled.push(error);process.on('unhandledRejection',observe);
  try{await within(assert.rejects(owner.handle({action:'start',cwd:root}),/allocation/),'Malformed retirement waited for readiness');assert.equal(engines.length,before);await assert.rejects(owner.close());await lstat(join(home,'coding-owners.lock'));assert.equal(owner.shutdownUnconfirmed,true);ready.reject(Error('Malformed allocator late readiness failure'));await tick();await tick();assert.deepEqual(unhandled,[],'Retained invalid resources must still observe late readiness rejection');const row=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0];assert.equal(row.generation.executorClosed,false);assert.equal(row.generation.execution,'unrevoked');console.log('PASS invalid executor retirement '+mode);}finally{ready.resolve();await owner.close().catch(()=>{});process.off('unhandledRejection',observe);}
 }
}
if(process.argv.includes('--readiness-check')){try{await readinessChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function shutdownChecks(){
 for(const stage of ['allocation','allocation-failure','resolving-lease','held-lease','selected-stop','selected-failure','unrevoked']){
  const home=join(root,'shutdown-'+stage);await mkdir(home,{mode:0o700});const settings=options(home);let release,entered,lease,operation;
  const held=new Promise(r=>release=r),ready=new Promise(r=>entered=r),open=settings.openExecutor;
  let retireAttempts=0;
  if(stage.startsWith('allocation'))settings.openExecutor=async context=>{entered(context);await held;const resource=await open(context);return {...resource,retire:async()=>{retireAttempts++;if(stage==='allocation-failure'&&retireAttempts===1)throw Error('Retirement failed during final close');return resource.retire();}};};
  if(stage.startsWith('selected-'))settings.openExecutor=async context=>({...await open(context),retire:async()=>{retireAttempts++;entered();await held;if(stage==='selected-failure'&&retireAttempts===1)throw Error('Retirement failed during final close');return {ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true};}});
  const owner=new CodingOwners(settings);
  try{
   if(stage.startsWith('allocation')){
    operation=assert.rejects(owner.handle({action:'start',cwd:root}),/cancelled|Stop/);const context=await ready;
    const closing=await closePending(owner);assert(context.signal.aborted);release();await operation;
    if(stage==='allocation-failure'){await assert.rejects(closing.work,/Retirement failed during final close/);await lstat(join(home,'coding-owners.lock'));}else await closing.work;
   }else if(stage==='resolving-lease'){
    operation=assert.rejects(owner.reserveProjectMutation(async()=>{entered();await held;return [root];}),/cancelled|Stop/);await ready;
    const closing=await closePending(owner);release();await operation;assert.equal((await closing.work).stopped,true);
   }else if(stage==='held-lease'){
    lease=await owner.reserveProjectMutation(async()=>[root]);const closing=await closePending(owner);
    const contender=new CodingOwners(options(home));await assert.rejects(contender.handle({action:'status'}),/lease/);await contender.close();
    lease.release();lease=null;assert.equal((await closing.work).stopped,true);
   }else if(stage.startsWith('selected-')){
    const thread=(await owner.handle({action:'start',cwd:root})).thread;await owner.handle({action:'interruptFamily',threadId:thread.id});await ready;
    const closing=await closePending(owner);release();
    if(stage==='selected-failure'){
     await assert.rejects(closing.work,/Retirement failed during final close/);await assert.rejects(owner.close(),/Retirement failed during final close/);await lstat(join(home,'coding-owners.lock'));
    }else assert.equal((await closing.work).stopped,true);
   }else{
    revoked=false;await owner.handle({action:'start',cwd:root});const result=await owner.close();assert.equal(result.stopped,true);assert.equal(result.executionRevoked,false);assert.equal(owner.exitUnconfirmed,true);assert.equal(await owner.close(),result);
    const row=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0];assert.equal(row.generation.nativeOpen,false);assert.equal(row.generation.execution,'unrevoked');
   }
   await assert.rejects(owner.handle({action:'start',cwd:root}),/closed/);
   if(stage.endsWith('-failure')){await assert.rejects(owner.close(),/Retirement failed during final close/);assert.equal(retireAttempts,1,'Final close must preserve failure without retrying cleanup');}
   console.log('PASS owner shutdown '+stage);
  }finally{release();lease?.release();await operation;if(stage.endsWith('-failure'))await owner.close().catch(()=>{});else await owner.close();revoked=true;}
 }
 const legacyHome=join(root,'shutdown-legacy-failure');await mkdir(join(legacyHome,'sessions'),{recursive:true,mode:0o700});
 let releaseLegacy,enterLegacy,legacyCloses=0;const legacyHeld=new Promise(r=>releaseLegacy=r),legacyReady=new Promise(r=>enterLegacy=r);
 const legacySettings={...options(legacyHome),assertLegacyClosed:async()=>{}};
 legacySettings.engineFactory=options=>{const engine=new FixtureEngine(options),close=engine.close.bind(engine);
  engine.handle=async()=>{throw Error('Legacy inventory fixture fault');};
  engine.close=async()=>{legacyCloses++;if(legacyCloses===1){enterLegacy();await legacyHeld;throw Error('Legacy retirement failed during final close');}return close();};return engine;};
 const legacyOwner=new CodingOwners(legacySettings),reading=assert.rejects(legacyOwner.handle({action:'list'}),/Legacy inventory fixture fault/);
 try{await legacyReady;const closing=await closePending(legacyOwner);releaseLegacy();await reading;
  await assert.rejects(closing.work,/Legacy retirement failed during final close/);await assert.rejects(legacyOwner.close(),/Legacy retirement failed during final close/);
  assert.equal(legacyCloses,2,'Final drain cannot retry the failed legacy retirement');await lstat(join(legacyHome,'coding-owners.lock'));
  console.log('PASS owner shutdown legacy failure retention');
 }finally{releaseLegacy();await reading;await legacyOwner.close().catch(()=>{});}
 const home=join(root,'shutdown-signed');await mkdir(home,{mode:0o700});const settings=options(home),open=settings.openExecutor;
 let enter,releaseAllocation,enterRetirement,releaseRetirement,retirements=0;
 const ready=new Promise(r=>enter=r),allocated=new Promise(r=>releaseAllocation=r),retiring=new Promise(r=>enterRetirement=r),retired=new Promise(r=>releaseRetirement=r);
 settings.openExecutor=async context=>{enter(context);await allocated;return {...await open(context),retire:async()=>{retirements++;enterRetirement();await retired;return {ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true};}};};
 const owner=new CodingOwners(settings),inert={start(){},async close(){return {stopped:true};}},token=randomUUID();
 const server=createServer({instanceToken:token,coding:owner,hub:inert,worktrees:{...inert},gitWorkflow:inert,schedules:inert});server.listen(0,'127.0.0.1');await once(server,'listening');
 const post=async(route,input)=>{const body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now());const response=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:{'content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)},body});return {status:response.status,body:await response.json()};};
 const starting=post('/api/tools/coding',{action:'start',cwd:root});let shutdown;
 try{
  const context=await ready;let settled=false;shutdown=post('/api/tools/shutdown',{}).then(result=>{settled=true;return result;});
  for(let i=0;i<200&&!context.signal.aborted;i++)await new Promise(r=>setTimeout(r,5));assert(context.signal.aborted);
  assert.equal(settled,false);await lstat(join(home,'coding-owners.lock'));releaseAllocation();await retiring;
  await new Promise(r=>setTimeout(r,30));assert.equal(settled,false,'Signed shutdown must retain late retirement');await lstat(join(home,'coding-owners.lock'));
  releaseRetirement();assert.equal((await starting).status,400);const result=await shutdown;
  assert.equal(result.status,200);assert.equal(result.body.stopped,true);assert.deepEqual(await post('/api/tools/shutdown',{}),result);assert.equal(retirements,1);
  await assert.rejects(lstat(join(home,'coding-owners.lock')),{code:'ENOENT'});console.log('PASS owner shutdown signed late allocation and retirement');
 }finally{releaseAllocation();releaseRetirement();await Promise.allSettled([starting,shutdown]);await server.shutdownTools();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
if(process.argv.includes('--shutdown-check')){try{await shutdownChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function preparationChecks(){
 const home=join(root,'preparation'),prepared=[],retired=[];await mkdir(home,{mode:0o700});
 const settings=options(home),allocate=settings.openExecutor,readyEngines=new Set();let hold=null,entered;
 settings.engineFactory=options=>{const engine=new FixtureEngine(options),handle=engine.handle.bind(engine);engine.handle=async input=>{if(['send','review','terminalStart'].includes(input.action)){assert(readyEngines.has(engine),'Execution cannot precede workspace readiness');if(input.action!=='send')return {prepared:true};}return handle(input);};return engine;};
 settings.openExecutor=async context=>{
  const resource=await allocate(context);
  return {...resource,prepare:async request=>{
   const {threadId,engine,life,signal,check}=request;check();assert.equal(engine.processLife,life);assert(engine.verifiedThreads.has(threadId));
   const saved=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners.find(r=>r.id===context.ownerId);
   assert.equal(saved.state,'ready');assert.equal(saved.rootThreadId,threadId);assert.equal(saved.generation.id,context.generation);
   assert.equal(engine.publications(threadId).length,1,'Preparation must own the production publication admission');
   prepared.push({context,request});entered?.();if(hold)await hold;
   readyEngines.add(engine);
  },retire:async()=>{retired.push(context.generation);return resource.retire();}};
 };
 let owner=new CodingOwners(settings);
 try{
  const A=(await owner.handle({action:'start',cwd:root})).thread;
  assert.equal(prepared.length,1,'Workspace must be prepared before start returns');
  await owner.handle({action:'send',threadId:A.id,text:'ready'});
  assert((await owner.handle({action:'review',threadId:A.id})).prepared);
  assert((await owner.handle({action:'terminalStart',threadId:A.id,command:'pwd'})).prepared);await materialize(owner,A);
  await owner.handle({action:'read',threadId:A.id});assert.equal(prepared.length,1,'Preparation runs once per live generation');
  const B=(await owner.handle({action:'fork',threadId:A.id})).thread;
  assert.equal(prepared.length,2,'Fork destination must prepare after native association');assert.equal(prepared.at(-1).request.threadId,B.id);
  await owner.close();owner=new CodingOwners(settings);
  await owner.handle({action:'read',threadId:A.id});await owner.handle({action:'list'});assert.equal(prepared.length,2,'Cold history must not prepare a guest');
  await owner.handle({action:'send',threadId:A.id,text:'cold execution'});assert.equal(prepared.length,3,'Cold continuation prepares the new generation');
  assert.notEqual(prepared[0].context.generation,prepared[2].context.generation);
  await owner.close();owner=new CodingOwners(settings);
  const before=prepared.length;scheduleBeginHook=async(_engine,id)=>{assert.equal(prepared.length,before+1);assert.equal(prepared.at(-1).request.threadId,id);};
  const scheduled=await owner.runScheduled({cwd:root,prompt:'prepared schedule',onClaim:async()=>{}});assert.equal(scheduled.status,'completed');scheduleBeginHook=null;
  await owner.close();
  console.log('Owner preparation association, fork, cold history/continuation and schedule checks passed');
 }finally{scheduleBeginHook=null;await owner.close();}
 for(const kind of ['selected','global']){
  const dir=join(root,'prepare-stop-'+kind);await mkdir(dir,{mode:0o700});const config=options(dir),open=config.openExecutor;let release,request,retiring=false,settled=false;
  const held=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  config.openExecutor=async context=>({...await open(context),prepare:async value=>{request=value;entered();await held;},retire:async()=>{retiring=true;return {ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true};}});
  const stopping=new CodingOwners(config),starting=stopping.handle({action:'start',cwd:root});starting.catch(()=>{}).finally(()=>settled=true);
  try{
   await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Preparation was not entered')),2000))]);
   if(kind==='selected')await stopping.handle({action:'interruptFamily',threadId:request.threadId});else await stopping.stop();
   assert(request.signal.aborted);assert.throws(request.check,/Stop|cancel|lifecycle|closed|process/i);
   await new Promise(r=>setTimeout(r,30));assert.equal(settled,false,'Do not release a pending preparation');
   // Retirement starts after bounded grace even if preparation needs VM shutdown to unblock.
   for(let i=0;i<800&&!retiring;i++)await new Promise(r=>setTimeout(r,5));assert(retiring,'Guest retirement must not deadlock behind preparation');
   const rows=JSON.parse(await readFile(join(dir,'coding-owners.json'),'utf8')).owners;assert.equal(rows[0].state,'ready');assert(rows[0].rootThreadId);assert(rows[0].generation.nativeOpen);
   release();await assert.rejects(starting,/Stop|cancel|lifecycle|closed|process/i);await stopping.disposal;
  }finally{release();await starting.catch(()=>{});await stopping.close();}
 }
 {
  const dir=join(root,'prepare-schedule-abort');await mkdir(dir,{mode:0o700});const config=options(dir),open=config.openExecutor;
  let enter,release,request,recorded;const ready=new Promise(r=>enter=r),held=new Promise(r=>release=r),abort=new AbortController();
  config.openExecutor=async context=>({...await open(context),prepare:async value=>{request=value;enter();await held;}});
  const scheduledOwner=new CodingOwners(config),running=scheduledOwner.runScheduled({cwd:root,prompt:'cancel preparation only',signal:abort.signal,onClaim:async()=>{},onThread:async id=>{recorded=id;}});
  try{await ready;assert.equal(recorded,request.threadId,'Persist the scheduled root receipt before preparing its workspace');abort.abort();await new Promise(r=>setTimeout(r,30));assert(request.signal.aborted,'Schedule cancellation must abort the workspace preparation signal');}
  finally{release();await running;await scheduledOwner.close();}
 }
 const failedHome=join(root,'preparation-failed');await mkdir(failedHome,{mode:0o700});const config=options(failedHome),open=config.openExecutor;let tries=0;
 config.openExecutor=async context=>({...await open(context),prepare:async()=>{tries++;throw Error('workspace seed failed');}});
 const failed=new CodingOwners(config);
 try{await assert.rejects(failed.handle({action:'start',cwd:root}),/workspace seed failed/);const row=JSON.parse(await readFile(join(failedHome,'coding-owners.json'),'utf8')).owners[0];await assert.rejects(failed.handle({action:'send',threadId:row.rootThreadId,text:'no retry'}));assert.equal(tries,1);}
 finally{await assert.rejects(failed.close(),/workspace seed failed/);assert(failed.exitUnconfirmed);}
 const badHome=join(root,'preparation-invalid');await mkdir(badHome,{mode:0o700});const invalid=options(badHome),badOpen=invalid.openExecutor;invalid.openExecutor=async context=>({...await badOpen(context),prepare:true});
 const bad=new CodingOwners(invalid);try{await assert.rejects(bad.handle({action:'start',cwd:root}),/allocation|prepar|resource/i);}finally{await bad.close();}
 console.log('Owner preparation Stop/drain, failure retention and invalid callback checks passed');
}
async function publicationChecks(){
 const home=join(root,'publication'),projectA=join(root,'publication-A'),projectB=join(root,'publication-B');
 for(const path of [home,projectA,projectB])await mkdir(path,{mode:0o700});
 const settings=options(home),allocate=settings.openExecutor;let beforeAssociation=0;
 settings.openExecutor=async context=>{
  assert.equal(typeof context.publish,'function','Executor needs a generation-bound publisher');
  await assert.rejects(context.publish({threadId:randomUUID(),operation:async()=>assert.fail('unassociated publication')}),/owner|publication|associated/i);beforeAssociation++;
  return allocate(context);
 };
 const owner=new CodingOwners(settings);let release;
 try{
  const A=(await owner.handle({action:'start',cwd:projectA})).thread,B=(await owner.handle({action:'start',cwd:projectB})).thread;
  const a=allocations.findLast(x=>x.cwd===projectA),b=allocations.findLast(x=>x.cwd===projectB);
  assert.equal(beforeAssociation,2);
  await assert.rejects(a.publish({threadId:B.id,operation:async()=>assert.fail('cross-owner publication')}),/owner|publication/i);
  let entered,aborted=false;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  const write=a.publish({threadId:A.id,operation:async({signal,check})=>{check();signal.addEventListener('abort',()=>aborted=true,{once:true});entered();await held;return 'saved';}});
  const result=write.catch(error=>error);await started;
  assert.equal((await owner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');assert(a.signal.aborted&&aborted);
  await assert.rejects(a.publish({threadId:A.id,operation:async()=>assert.fail('closed admission')}),/owner|publication|Stop/i);
  assert.equal(await b.publish({threadId:B.id,operation:async()=>42}),42);
  const during=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners.find(r=>r.rootThreadId===A.id);
  assert.equal(during.generation.nativeOpen,true);assert.equal(during.generation.execution,'unrevoked');
  release();assert(await result instanceof Error);await owner.disposal;
  const after=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners.find(r=>r.rootThreadId===A.id);
  assert.equal(after.generation.nativeOpen,false);assert.equal(after.generation.execution,'revoked');
  await owner.handle({action:'send',threadId:A.id,text:'fresh generation'});
  await assert.rejects(a.publish({threadId:A.id,operation:async()=>assert.fail('old generation')}),/owner|publication/i);
  assert.equal(await allocations.findLast(x=>x.cwd===projectA).publish({threadId:A.id,operation:async()=>43}),43);
  console.log('PASS owner-bound publication, pre-association and stale-generation refusal, selected Stop drainage, sibling progress');
 }finally{release?.();await owner.close();}
}
if(process.argv.includes('--publication-check')){try{await publicationChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function workspaceCallbackChecks(){
 const home=join(root,'workspace-callback'),project=join(root,'workspace-project');await mkdir(home,{mode:0o700});await mkdir(project,{mode:0o700});
 const settings=options(home),allocate=settings.openExecutor,seen=[],published=[];let statusGate,enterStatus;
 settings.engineFactory=options=>{seen.push(options);const engine=new FixtureEngine(options),handle=engine.handle.bind(engine);engine.workspaceSyncView=()=>[{rootThreadId:[...engine.threadInfo.keys()][0],state:'waiting',round:1,message:'fixture pending save',...engine.syncFixture}];engine.handle=async input=>{const result=await handle(input);if(input.action==='status'){result.workspaceSync=engine.workspaceSyncView();if(statusGate&&engine.threadInfo.has(statusGate.threadId)){enterStatus();await statusGate.wait;}}return result;};return engine;};
 settings.openExecutor=async context=>{const resource={...await allocate(context),publishChanges(request){assert.equal(this,resource,'Publisher must retain resource receiver');return context.publish({threadId:request.threadId,operation:async()=>{published.push(context.generation);return {published:true,renewed:true};}});}};return resource;};
 const owner=new CodingOwners(settings);
 try{
  const A=(await owner.handle({action:'start',cwd:root})).thread,B=(await owner.handle({action:'start',cwd:project})).thread;
  assert.equal(typeof seen[0].publishWorkspace,'function');assert.equal(typeof seen[1].publishWorkspace,'function');
  assert.deepEqual(await seen[0].publishWorkspace({threadId:A.id}),{published:true,renewed:true});
  await assert.rejects(seen[0].publishWorkspace({threadId:B.id}),/owner|publication|associated/i);
  const status=await owner.handle({action:'status'});assert.deepEqual(status.workspaceSync.map(x=>x.rootThreadId).sort(),[A.id,B.id].sort());assert.equal(published.length,1);
  const engineA=engines.findLast(e=>e.threadInfo.has(A.id));let releaseStatus;const statusEntered=new Promise(r=>enterStatus=r);statusGate={threadId:B.id,wait:new Promise(r=>releaseStatus=r)};
  const pendingStatus=owner.handle({action:'status'});await statusEntered;
  engineA.syncFixture={state:'failed',round:2,message:'newer saved status'};engineA.push('coding/workspaceSync',engineA.workspaceSyncView()[0]);releaseStatus();
  const freshStatus=await pendingStatus;statusGate=null;assert.equal(freshStatus.workspaceSync.find(x=>x.rootThreadId===A.id).round,2,'Workspace snapshot must be taken after asynchronous status work');assert.equal(freshStatus.workspaceSyncCursor,engineA.sequence);
  engineA.closed=true;try{const retained=await owner.handle({action:'status'});assert.equal(retained.workspaceSync.find(x=>x.rootThreadId===A.id)?.state,'failed','Closed-but-retained owner must keep its save failure visible');}finally{engineA.closed=false;}
  await owner.handle({action:'interruptFamily',threadId:A.id});await assert.rejects(seen[0].publishWorkspace({threadId:A.id}),/owner|publication|Stop/i);assert.equal(published.length,1);
 }finally{await owner.close();}
 const invalidHome=join(root,'invalid-workspace-callback');await mkdir(invalidHome,{mode:0o700});const invalid=options(invalidHome),open=invalid.openExecutor;invalid.openExecutor=async context=>({...await open(context),publishChanges:true});
 const bad=new CodingOwners(invalid);try{await assert.rejects(bad.handle({action:'start',cwd:root}),/allocation/i);}finally{await bad.close();}
 console.log('PASS workspace publisher receiver, owner scope, Stop, status aggregation and invalid callback checks');
}
if(process.argv.includes('--workspace-callback-check')){try{await workspaceCallbackChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function retirementChecks(){
 const waitFor=async(predicate,label)=>{const end=Date.now()+4000;while(!predicate()&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert(predicate(),label);};
 const tracked=home=>{const settings=options(home),allocate=settings.openExecutor,retired=[];settings.openExecutor=async context=>{const resource=await allocate(context);return {...resource,retire:async()=>{retired.push(context.ownerId);return resource.retire();}};};return {settings,retired};};
 if(!process.argv[3]||process.argv[3]==='native-failure'){
  const home=join(root,'retirement-native-failure');await mkdir(home,{mode:0o700});const {settings,retired}=tracked(home),owner=new CodingOwners(settings);
  const first=(await owner.handle({action:'start',cwd:root})).thread;await owner.handle({action:'start',cwd:root});
  const engine=engines.findLast(e=>e.threadInfo.has(first.id)),close=engine.close.bind(engine);engine.close=async()=>{throw Error('native close fixture fault');};
  try{
   await assert.rejects(owner.close(),/native close fixture fault/);
   assert.equal(new Set(retired).size,2,'Native close failure must not skip its executor or a sibling executor');
   const catalog=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')),failed=catalog.owners.find(r=>r.rootThreadId===first.id),peer=catalog.owners.find(r=>r!==failed);
   assert.equal(failed.generation.nativeOpen,true);assert.equal(failed.generation.execution,'unrevoked','Unknown native closure must not authorize revocation');
   assert.equal(peer.generation.nativeOpen,false);assert.equal(peer.generation.execution,'revoked');
   const contender=new CodingOwners(options(home));await assert.rejects(contender.handle({action:'status'}),/lease/);await contender.close();
  }finally{engine.close=close;await close();await assert.rejects(owner.close(),/native close fixture fault/);}
  assert.equal(retired.length,2,'Repeated failed close must retain the original outcome and successful executor receipts');
 }
 if(!process.argv[3]||process.argv[3]==='native-wait'){
  const home=join(root,'retirement-native-wait');await mkdir(home,{mode:0o700});const {settings,retired}=tracked(home),owner=new CodingOwners(settings);
  const first=(await owner.handle({action:'start',cwd:root})).thread;await owner.handle({action:'start',cwd:root});
  const engine=engines.findLast(e=>e.threadInfo.has(first.id)),close=engine.close.bind(engine);let release;const held=new Promise(r=>release=r);engine.close=async()=>{await held;return close();};
  const closing=owner.close();closing.catch(()=>{});
  try{await waitFor(()=>new Set(retired).size===2,'Slow native close must not suppress either executor retirement beyond bounded grace');}
  finally{release();await closing;}
 }
 if(!process.argv[3]||process.argv[3]==='pending-reply'){
  const home=join(root,'retirement-pending-reply');await mkdir(home,{mode:0o700});const {settings,retired}=tracked(home),owner=new CodingOwners(settings),thread=(await owner.handle({action:'start',cwd:root})).thread;
  const engine=engines.findLast(e=>e.threadInfo.has(thread.id));let entered=false,release;const held=new Promise(r=>release=r);
  resolveHook=async e=>{if(e===engine){entered=true;await held;}};
  const reading=assert.rejects(owner.handle({action:'read',threadId:thread.id}),/Stop|lifecycle|cancelled/);
  try{
   await waitFor(()=>entered,'Read reply fixture entered');const result=await owner.stop();assert.equal(result.stopped,false);
   await waitFor(()=>new Set(retired).size===1,'Pending admitted reply must not suppress resource retirement');
  }finally{resolveHook=null;release();await reading;await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='native-grace'){
  const home=join(root,'retirement-native-grace');await mkdir(home,{mode:0o700});const {settings,retired}=tracked(home),owner=new CodingOwners(settings);
  const thread=(await owner.handle({action:'start',cwd:root})).thread,engine=engines.findLast(e=>e.threadInfo.has(thread.id)),close=engine.close.bind(engine);
  let entered=false,release;const held=new Promise(r=>release=r);engine.close=async()=>{entered=true;await held;return close();};
  const closing=owner.close();closing.catch(()=>{});
  try{await waitFor(()=>entered,'Native close entered');await new Promise(r=>setTimeout(r,30));assert.equal(retired.length,0,'Executor must remain available during bounded graceful native drain');}
  finally{release();await closing;}
  assert.equal(retired.length,1);
 }
 if(!process.argv[3]||process.argv[3]==='read-retry'){
  const home=join(root,'retirement-read-retry');await mkdir(home,{mode:0o700});const {settings,retired}=tracked(home),owner=new CodingOwners(settings);
  const thread=(await owner.handle({action:'start',cwd:root})).thread,engine=engines.findLast(e=>e.threadInfo.has(thread.id)),close=engine.close.bind(engine);
  engine.close=async()=>{throw Error('native close retry fault');};
  try{assert.equal((await owner.stop()).stopped,false);assert.equal(retired.length,1);engine.close=close;assert.equal((await owner.handle({action:'read',threadId:thread.id})).thread.id,thread.id);assert.equal(retired.length,1,'Read retry must reuse confirmed resource retirement');}
  finally{engine.close=close;await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='late-startup'){
  const home=join(root,'retirement-late-startup');await mkdir(home,{mode:0o700});const {settings}=tracked(home);let entered=false,releaseStart,releaseDisposal,settled=false;
  const starting=new Promise(r=>releaseStart=r),lateDisposal=new Promise(r=>releaseDisposal=r);
  settings.engineFactory=o=>{const e=new FixtureEngine(o);e.ensure=async()=>{entered=true;await starting;e.disposal=lateDisposal;throw Error('late startup cancelled');};return e;};
  const owner=new CodingOwners(settings),creating=assert.rejects(owner.handle({action:'start',cwd:root}),/late startup cancelled/).finally(()=>{settled=true;});
  try{
   await waitFor(()=>entered,'Startup entered');assert.equal((await owner.stop()).stopped,false);releaseStart();
   await new Promise(r=>setTimeout(r,30));assert.equal(settled,false,'Late startup disposal must finish before native closure is committed');
   assert.equal(JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0].generation.nativeOpen,true);
   await closePending(owner);
  }finally{releaseStart();releaseDisposal();await creating;await owner.close();}
 }
 console.log('Owner retirement foundation checks passed');
}
async function modelMergeChecks(){
 const selected='fixture/selected-65k',which=process.argv[3];
 const waitFor=async test=>{for(let i=0;i<200&&!test();i++)await new Promise(r=>setTimeout(r,5));assert(test(),'Fixture reached deferred boundary');};
 const rows=async home=>{try{return JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners;}catch(error){if(error.code!=='ENOENT')throw error;return [];}};
 if(!which||which==='offline'){
  const home=join(root,'model-offline-preflight'),settings=options(home),order=[];await mkdir(home,{mode:0o700});
  settings.engineOptions={...settings.engineOptions,assertProject:async()=>{order.push('project');},localModels:{async resolve(){order.push('catalog');throw Error('model offline');}}};
  const owner=new CodingOwners(settings),before=allocations.length;
  try{await assert.rejects(owner.handle({action:'start',cwd:root,model:selected}),/offline/);assert.deepEqual(order,['project','catalog']);assert.equal(allocations.length,before);assert.deepEqual(await rows(home),[]);}finally{await owner.close();}
 }
 if(!which||which==='schedule-selected'){
  const home=join(root,'model-selected-schedule'),settings=options(home),chosen='local/saleh-qwen38-uncensored-8bit',dispatched=[];await mkdir(home,{mode:0o700});
  settings.engineFactory=options=>{const engine=new FixtureEngine(options),begin=engine.begin.bind(engine);engine.begin=async(...args)=>{dispatched.push(args[2].model);return begin(...args);};return engine;};
  const owner=new CodingOwners(settings);try{const result=await owner.runScheduled({cwd:root,prompt:'Fixture selected schedule',model:chosen,onClaim:async()=>{}});assert.equal(result.status,'completed');assert.equal((await rows(home))[0].model,chosen);assert.deepEqual(dispatched,[chosen]);assert(calls.some(c=>c.home.startsWith(home+'/')&&c.input.action==='start'&&c.input.model===chosen));}finally{await owner.close();}
 }
 for(const route of ['manual','schedule','fork'])if(!which||which==='wrong-'+route){
  const home=join(root,'model-wrong-'+route),settings=options(home);await mkdir(home,{mode:0o700});let corrupt=false;
  settings.engineFactory=options=>{
   const engine=new FixtureEngine(options),handle=engine.handle.bind(engine),fork=engine.forkFromSnapshot.bind(engine);
   if(route==='manual')engine.handle=async input=>{const value=await handle(input);if(corrupt&&input.action==='start')return {...value,thread:{...value.thread,model:'wrong-model'}};return value;};
   if(route==='schedule')engine.runScheduled=async callbacks=>{await callbacks.onCreated({id:randomUUID(),cwd:root,model:'wrong-model',modelProvider:'saleh_local',turns:[]});return {status:'completed'};};
   if(route==='fork')engine.forkFromSnapshot=async input=>fork({...input,onCreated:thread=>input.onCreated({...thread,model:'wrong-model'})});
   return engine;
  };
  const owner=new CodingOwners(settings);
  try{
   corrupt=true;
   if(route==='manual')await assert.rejects(owner.handle({action:'start',cwd:root,model:selected}),/identity|model/);
   if(route==='schedule'){const result=await owner.runScheduled({cwd:root,prompt:'fixture',model:selected,onClaim:async()=>{}});assert.equal(result.status,'failed');assert.match(result.message,/identity|model/);}
   if(route==='fork'){const source=(await owner.handle({action:'start',cwd:root,model:selected})).thread;await materialize(owner,source);await assert.rejects(owner.handle({action:'fork',threadId:source.id}),/identity|model/);}
   const saved=await rows(home),pending=saved.at(-1);assert.equal(pending.state,'creating');assert.equal(pending.rootThreadId,null);assert.equal(pending.model,null);assert(Object.hasOwn(pending,'creation')&&Object.hasOwn(pending,'fork'));
  }finally{await owner.close();}
 }
 if(!which||which==='global-stop'){
  const home=join(root,'model-preflight-stop'),settings=options(home);await mkdir(home,{mode:0o700});let entered=false,release;
  settings.engineOptions.localModels={async resolve(id){entered=true;await new Promise(r=>release=r);return {id};}};
  const owner=new CodingOwners(settings),before=allocations.length,pending=owner.handle({action:'start',cwd:root,model:selected});pending.catch(()=>{});
  try{await waitFor(()=>entered);assert.equal((await owner.stop()).stopped,false);release();await assert.rejects(pending,/cancelled|Stop/);assert.equal(allocations.length,before);assert.deepEqual(await rows(home),[]);}finally{release?.();await owner.close();}
 }
 if(!which||which==='late-manual'){
  const home=join(root,'model-late-manual'),settings=options(home);await mkdir(home,{mode:0o700});let entered=false,release;
  settings.engineFactory=options=>{const engine=new FixtureEngine(options),handle=engine.handle.bind(engine);engine.handle=async input=>{const result=await handle(input);if(input.action==='start'){entered=true;await new Promise(r=>release=r);}return result;};return engine;};
  const owner=new CodingOwners(settings),pending=owner.handle({action:'start',cwd:root,model:selected});pending.catch(()=>{});
  try{await waitFor(()=>entered);assert.equal((await owner.stop()).stopped,false);release();await assert.rejects(pending,/cancelled|Stop/);const saved=(await rows(home))[0];assert.equal(saved.state,'ready');assert.equal(saved.model,selected);assert(saved.rootThreadId);assert(saved.creation);assert.equal(saved.fork,null);}finally{release?.();await owner.close();}
 }
 if(!which||which==='selected-stop')for(const [action,targetKind] of [['send','selected'],['review','selected'],['send','sibling'],['send','unknown']]){
  const home=join(root,'model-owner-stop-'+action+'-'+targetKind),settings=options(home),events=[],retired=[];await mkdir(home,{mode:0o700});let held=false,entered=false,release,lookupSignal;
  settings.engineOptions.localModels={async resolve(id,options){if(held){entered=true;lookupSignal=options.signal;await new Promise(r=>release=r);}return localModels.resolve(id,options);}};
  const allocate=settings.openExecutor;settings.openExecutor=async context=>{const resource=await allocate(context);return {...resource,retire:async()=>{retired.push(context.ownerId);return resource.retire();}};};
  settings.engineFactory=options=>{
   const engine=new FixtureEngine(options),handle=engine.handle.bind(engine),rpc=engine.rpc.bind(engine);
   engine.thread=async id=>(await engine.rows()).find(t=>t.id===id);
   engine.rpc=async(method,params)=>{if(method==='thread/resume'){events.push({kind:'resume',id:params.threadId,model:params.model});return {thread:{...await engine.thread(params.threadId),model:params.model,modelProvider:params.modelProvider}};}return rpc(method,params);};
   engine.begin=async(id,method,params)=>{events.push({kind:'dispatch',id,model:params.model});return {turn:{id:randomUUID(),status:'completed'}};};
   engine.handle=async input=>['send','review'].includes(input.action)?CodingEngine.prototype.handle.call(engine,input):handle(input);
   return engine;
  };
  const owner=new CodingOwners(settings),first=(await owner.handle({action:'start',cwd:root,model:selected})).thread;await materialize(owner,first);
  const sibling=(await owner.handle({action:'start',cwd:root,model:'fixture/peer-65k'})).thread;await materialize(owner,sibling);
  const engine=engines.findLast(e=>e.threadInfo.has(first.id)),peer=engines.findLast(e=>e.threadInfo.has(sibling.id)),saved=await rows(home),a=saved.find(r=>r.rootThreadId===first.id),b=saved.find(r=>r.rootThreadId===sibling.id);
  const target=targetKind==='sibling'?sibling.id:targetKind==='unknown'?'not-owned':first.id;
  held=true;const pending=owner.handle({action,threadId:first.id,...(action==='send'?{text:'fixture'}:{})});pending.catch(()=>{});let control;
  try{
   await waitFor(()=>entered);control=owner.handle({action:'interruptFamily',threadId:target});control.catch(()=>{});
   if(targetKind!=='unknown'){
    assert.equal((await control).state,'stopping');assert.equal((await owner.handle({action:'interruptFamily',threadId:target})).state,'stopping');
    await waitFor(()=>retired.includes(targetKind==='selected'?a.id:b.id));
    assert.equal(engine.closed,targetKind==='selected');assert.equal(peer.closed,targetKind==='sibling');
    assert.equal(retired.length,1);assert.deepEqual(events,[],'Stop cleanup starts before the held inventory returns');
   }
   held=false;release();
   if(targetKind==='selected'){assert.equal(lookupSignal.aborted,true);await assert.rejects(pending,error=>error===lookupSignal.reason);assert.deepEqual(events,[]);}
   else {await pending;assert(events.some(e=>e.kind==='dispatch'&&e.id===first.id&&e.model===selected));}
   if(targetKind==='unknown')await assert.rejects(control,/live owner/);else await owner.disposal;
   if(targetKind==='selected'){
    const status=await owner.handle({action:'status'}),stopped=status.owners.find(r=>r.id===a.id);assert.equal(stopped.nativeOpen,false);assert.equal(stopped.stopping,false);
    await owner.handle({action:'send',threadId:sibling.id,text:'peer remains available'});assert(events.some(e=>e.kind==='dispatch'&&e.id===sibling.id&&e.model==='fixture/peer-65k'));
   }
  }finally{held=false;release?.();await pending.catch(()=>{});await control?.catch(()=>{});await owner.close();}
 }
 console.log('Owner model merge checks passed: preflight, exact manual/scheduled/fork receipt, selected lookup Stop and retained late identity');
}
if(process.argv.includes('--model-merge-check')){try{await modelMergeChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
async function selectedStopChecks(){
 const waitFor=async(test,label)=>{const end=Date.now()+4000;while(!await test()&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert(await test(),label);};
 const setup=async name=>{const home=join(root,'selected-'+name);await mkdir(home,{mode:0o700});const settings=options(home),allocate=settings.openExecutor,retired=[];settings.openExecutor=async c=>{const r=await allocate(c);return {...r,retire:async()=>{retired.push(c.ownerId);return r.retire();}};};return {home,settings,retired,owner:new CodingOwners(settings)};};
 if(!process.argv[3]||process.argv[3]==='settled-notification'){
  for(const failed of [false,true]){
   const {owner,retired}=await setup('settled-notification-'+failed),A=(await owner.handle({action:'start',cwd:root})).thread;
   const engine=await materialize(owner,A),close=engine.close.bind(engine);let release;
   const held=new Promise(resolve=>release=resolve),fault='selected notification native close fault';
   engine.close=async()=>{await held;if(failed)throw Error(fault);return close();};
   const after=(await owner.handle({action:'events',after:0})).cursor;
   const updates=result=>result.events.filter(event=>event.method==='coding/family/updated'&&event.params.rootThreadId===A.id);
   try{
    assert.equal((await owner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping','Stop must acknowledge before held cleanup settles');
    assert.equal((await owner.handle({action:'status'})).owners.find(row=>row.rootThreadId===A.id).stopping,true);
    await assert.rejects(owner.handle({action:'family',threadId:A.id}),/selected Stop/,'A family refresh during closure must remain fenced');
    assert.equal(updates(await owner.handle({action:'events',after})).length,0,'Held Stop must not publish a completion invalidation');
    release();await owner.disposal;
    const status=await owner.handle({action:'status'}),row=status.owners.find(row=>row.rootThreadId===A.id);
    assert.equal(row.stopping,false);assert.equal(retired.length,1);
    const notifications=updates(await owner.handle({action:'events',after}));
    assert.equal(notifications.length,1,'Settled owner Stop must invalidate its family after success or failure');
    assert.deepEqual(notifications[0].params,{threadId:A.id,rootThreadId:A.id});
    if(failed){
     assert.match(row.stopError,new RegExp(fault));assert.equal(row.nativeOpen,true);assert.equal(row.execution,'unrevoked');
     await assert.rejects(owner.handle({action:'family',threadId:A.id}),new RegExp(fault),'A failure notification must not grant closed-history authority');
    }else{
     assert.equal(row.stopError,null);assert.equal(row.nativeOpen,false);assert.equal(row.executorClosed,true);assert.equal(row.execution,'revoked');
     const beforeFamilyRead=allocations.length,family=await owner.handle({action:'family',threadId:A.id});
     assert.equal(family.rootThreadId,A.id);assert.equal(family.root.id,A.id);assert.equal(family.root.turns[0].items[0].text,'retained');
     assert.deepEqual(family.stoppingTargets??[],[]);assert.equal(allocations.length,beforeFamilyRead,'Fresh family read must not allocate another executor');
    }
   }finally{release();engine.close=close;await owner.close();}
  }
 }
 if(!process.argv[3]||process.argv[3]==='queued-peer'){
  const {home,owner,retired}=await setup('queued-peer'),A=(await owner.handle({action:'start',cwd:root})).thread,B=(await owner.handle({action:'start',cwd:root})).thread;
  const ae=engines.findLast(e=>e.threadInfo.has(A.id)),be=engines.findLast(e=>e.threadInfo.has(B.id)),aid=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners.find(r=>r.rootThreadId===A.id).id;
  let entered=false,release;const held=new Promise(r=>release=r);resolveHook=async e=>{if(e===be){entered=true;await held;}};
  const peer=owner.handle({action:'read',threadId:B.id});await waitFor(()=>entered,'Peer entered');
  const queued=owner.handle({action:'send',threadId:A.id,text:'must not dispatch'});queued.catch(()=>{});
  const stopping=owner.handle({action:'interruptFamily',threadId:A.id});stopping.catch(()=>{});
  try{
   await waitFor(()=>retired.includes(aid),'Selected Stop must request retirement before the peer queue head is released');
   assert.equal((await stopping).state,'stopping');assert.equal((await owner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');
   assert(ae.closed);assert(!be.closed);assert.equal(retired.length,1);
   release();await peer;await assert.rejects(queued,/Stop|cancelled|stopping/);
   await waitFor(async()=>!(await owner.handle({action:'status'})).owners.find(r=>r.id===aid).stopping,'Selected commit settled');
   assert.equal((await owner.handle({action:'send',threadId:B.id,text:'peer continues'})).ownerHome,be.dataDir);
   assert(!calls.some(x=>x.home===ae.dataDir&&x.input.action==='send'));assert.equal(retired.length,1);
  }finally{resolveHook=null;release();await Promise.allSettled([peer,queued,stopping]);await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='native-wait-peer'){
  const {owner,retired}=await setup('native-wait-peer'),A=(await owner.handle({action:'start',cwd:root})).thread,B=(await owner.handle({action:'start',cwd:root})).thread;
  const ae=engines.findLast(e=>e.threadInfo.has(A.id)),close=ae.close.bind(ae);let release;const held=new Promise(r=>release=r);ae.close=async()=>{await held;return close();};
  let replied=false;const stopping=owner.handle({action:'interruptFamily',threadId:A.id});stopping.catch(()=>{});
  const peer=owner.handle({action:'send',threadId:B.id,text:'peer while A closes'}).then(v=>{replied=true;return v;});peer.catch(()=>{});
  try{assert.equal((await stopping).state,'stopping');await waitFor(()=>replied,'Pending A cleanup must not own the ordinary B queue');await waitFor(()=>retired.length===1,'Stalled native close still retires its resource');}
  finally{release();await Promise.allSettled([peer,stopping]);await waitFor(async()=>!(await owner.handle({action:'status'})).owners.some(r=>r.stopping),'Stop settled');await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='late-allocation'){
  const {home,owner,retired}=await setup('late-allocation'),A=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,A);await owner.stop();const count=retired.length,before=allocations.length;
  let release;gate=new Promise(r=>release=r);const send=owner.handle({action:'send',threadId:A.id,text:'must not start'});send.catch(()=>{});
  try{await waitFor(()=>allocations.length>before,'Replacement allocation entered');const allocation=allocations.at(-1);assert.equal((await owner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');assert(allocation.signal.aborted);release();gate=null;await assert.rejects(send,/Stop|cancelled/);await waitFor(async()=>!(await owner.handle({action:'status'})).owners.some(r=>r.stopping),'Late allocation settled');assert.equal(retired.length,count+1);assert(!calls.some(x=>x.home.startsWith(home+'/')&&x.input.action==='send'));}
  finally{release();gate=null;await Promise.allSettled([send]);await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='cold-admission'){
  const {owner,settings,retired}=await setup('cold-admission'),A=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,A);await owner.close();
  const cold=new CodingOwners(settings),before=allocations.length,send=cold.handle({action:'send',threadId:A.id,text:'cold queued before Stop'});send.catch(()=>{});const stopping=cold.handle({action:'interruptFamily',threadId:A.id});
  try{await assert.rejects(send,/Stop|cancelled/);assert.equal((await stopping).state,'stopping');await waitFor(async()=>!(await cold.handle({action:'status'})).owners.some(r=>r.stopping),'Cold Stop settled');assert.equal(allocations.length,before);assert.equal(retired.length,1);}
  finally{await Promise.allSettled([send,stopping]);await cold.close();}
 }
 if(!process.argv[3]||process.argv[3]==='pre-home'){
  const {home,settings,owner}=await setup('pre-home'),A=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,A);await owner.close();const cold=new CodingOwners(settings);await cold.handle({action:'status'});
  const row=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0],target=join(home,'owners',row.id),original=fsPromises.lstat;let entered=false,release;const held=new Promise(r=>release=r);
  fsPromises.lstat=async(...args)=>{if(args[0]===target&&!entered){entered=true;await held;}return original(...args);};syncBuiltinESMExports();const before=allocations.length,send=cold.handle({action:'send',threadId:A.id,text:'pre-home cancel'});send.catch(()=>{});
  try{await waitFor(()=>entered,'Home verification entered');assert.equal((await cold.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');release();await assert.rejects(send,/Stop|cancelled/);await waitFor(async()=>!(await cold.handle({action:'status'})).owners.some(r=>r.stopping),'Pre-home Stop settled');assert.equal(allocations.length,before);}
  finally{release();fsPromises.lstat=original;syncBuiltinESMExports();await Promise.allSettled([send]);await cold.close();}
 }
 if(!process.argv[3]||process.argv[3]==='child-only'){
  const {owner,retired}=await setup('child-only'),A=(await owner.handle({action:'start',cwd:root})).thread,B=(await owner.handle({action:'start',cwd:root})).thread,engine=engines.findLast(e=>e.threadInfo.has(A.id));
  const child={...A,id:randomUUID(),parentThreadId:A.id};await writeFile(join(engine.dataDir,'fixture-threads.json'),JSON.stringify([A,child]));engine.rememberThread(child);await owner.handle({action:'read',threadId:child.id});
  try{await owner.handle({action:'interruptFamily',threadId:child.id});assert.equal(retired.length,0);assert(!engine.closed);assert.equal(calls.filter(x=>x.home===engine.dataDir&&x.input.action==='interruptFamily').at(-1).input.threadId,child.id);assert((await owner.handle({action:'send',threadId:B.id,text:'B'})).turn);}
  finally{await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='scheduled-receipt'){
  const {home,owner,retired}=await setup('scheduled-receipt');let threadId,release;const held=new Promise(r=>release=r);
  const run=owner.runScheduled({cwd:root,prompt:'must not dispatch',onClaim:async()=>{},onThread:async id=>{threadId=id;await held;}});run.catch(()=>{});
  try{await waitFor(()=>threadId,'Scheduled receipt committed');const engine=engines.findLast(e=>e.threadInfo.has(threadId));assert(engine);assert.equal((await owner.handle({action:'interruptFamily',threadId})).state,'stopping');assert.equal((await run).status,'interrupted');await closePending(owner);release();await engine.scheduledDisposal;await owner.disposal;assert.equal(JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners[0].rootThreadId,threadId);await waitFor(()=>retired.length===1,'Scheduled executor retired');}
  finally{release();await Promise.allSettled([run]);await owner.disposal;await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='fork-copy'){
  const {owner,settings,retired}=await setup('fork-copy'),A=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,A);let release,entered=false;const held=new Promise(r=>release=r),files=settings.forkFiles;
  // New coordinator uses the same saved owner and a held trusted snapshot helper.
  await owner.close();settings.forkFiles=async(action,...args)=>{if(action==='snapshot'){entered=true;await held;}return files(action,...args);};const forkOwner=new CodingOwners(settings),before=allocations.length,fork=forkOwner.handle({action:'fork',threadId:A.id});fork.catch(()=>{});
  try{await waitFor(()=>entered,'Fork source retired before snapshot');assert.equal((await forkOwner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');release();await assert.rejects(fork,/Stop|cancelled/);await waitFor(async()=>!(await forkOwner.handle({action:'status'})).owners.some(r=>r.stopping),'Source-only fork Stop settled');assert.equal(allocations.length,before);assert.equal(retired.length,1);}
  finally{release();await Promise.allSettled([fork]);await forkOwner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='fork-allocation'){
  const {home,owner,retired}=await setup('fork-allocation'),A=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,A);const before=allocations.length;let release;gate=new Promise(r=>release=r);const fork=owner.handle({action:'fork',threadId:A.id});fork.catch(()=>{});
  try{await waitFor(()=>allocations.length>before,'Fork destination allocation entered');const destination=allocations.at(-1);assert.equal((await owner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');assert(destination.signal.aborted);release();gate=null;await assert.rejects(fork,/Stop|cancelled/);await waitFor(async()=>!(await owner.handle({action:'status'})).owners.some(r=>r.stopping),'Fork destination Stop settled');assert.equal(retired.length,2);assert(!calls.some(x=>x.home===destination.dataDir&&x.input.action==='nativeFork'));const rows=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners;assert.equal(rows.length,2);assert(rows.every(r=>!r.generation?.nativeOpen));}
  finally{release();gate=null;await Promise.allSettled([fork]);await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='late-fork-receipt'){
  const {home,owner,retired}=await setup('late-fork-receipt'),A=(await owner.handle({action:'start',cwd:root,model:'fixture/late-fork-model'})).thread;await materialize(owner,A);let release;forkReplyGate=new Promise(r=>release=r);const fork=owner.handle({action:'fork',threadId:A.id});fork.catch(()=>{});
  try{await waitFor(()=>calls.some(x=>x.home.startsWith(home+'/')&&x.input.action==='nativeFork'),'Native fork reply admitted');assert.equal((await owner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');release();forkReplyGate=null;await assert.rejects(fork,/Stop|cancelled|closed|lifecycle/);await waitFor(async()=>!(await owner.handle({action:'status'})).owners.some(r=>r.stopping),'Late fork Stop settled');const rows=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners;assert.equal(rows.length,2);assert(rows.every(r=>r.state==='ready'&&!r.generation.nativeOpen));assert.notEqual(rows[1].rootThreadId,A.id);assert(rows.every(r=>r.model==='fixture/late-fork-model'));assert.equal(retired.length,2);}
  finally{release();forkReplyGate=null;await Promise.allSettled([fork]);await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='list-peer'){
  const {home,owner,retired}=await setup('list-peer'),B=(await owner.handle({action:'start',cwd:root})).thread,A=(await owner.handle({action:'start',cwd:root})).thread;
  const ae=engines.findLast(e=>e.threadInfo.has(A.id)),be=engines.findLast(e=>e.threadInfo.has(B.id));let entered=false,release;const held=new Promise(r=>release=r);resolveHook=async e=>{if(e===ae){entered=true;await held;}};
  const listing=owner.handle({action:'list'});listing.catch(()=>{});
  try{await waitFor(()=>entered,'List observed B before A');assert.equal((await owner.handle({action:'interruptFamily',threadId:A.id})).state,'stopping');await waitFor(()=>retired.length===1,'List cancellation reaches only selected resource');assert(!be.closed);release();await assert.rejects(listing,/Stop|cancelled|lifecycle/);await waitFor(async()=>!(await owner.handle({action:'status'})).owners.some(r=>r.stopping),'List Stop settled');assert.equal(retired.length,1);assert((await owner.handle({action:'send',threadId:B.id,text:'peer preserved'})).turn);}
  finally{resolveHook=null;release();await Promise.allSettled([listing]);await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='retirement-retry'){
  const {home,owner,retired}=await setup('retirement-retry'),A=(await owner.handle({action:'start',cwd:root})).thread,B=(await owner.handle({action:'start',cwd:root})).thread,engine=engines.findLast(e=>e.threadInfo.has(A.id)),close=engine.close.bind(engine);
  engine.close=async()=>{throw Error('selected native close fault');};
  try{await owner.handle({action:'interruptFamily',threadId:A.id});await owner.disposal;const status=await owner.handle({action:'status'}),row=status.owners.find(r=>r.rootThreadId===A.id);assert.equal(row.stopping,false);assert.match(row.stopError,/selected native close fault/);assert.equal(row.nativeOpen,true);assert.equal(row.execution,'unrevoked');assert.equal(retired.length,1);assert((await owner.handle({action:'send',threadId:B.id,text:'peer despite A failure'})).turn);engine.close=close;await owner.handle({action:'interruptFamily',threadId:A.id});await owner.disposal;assert.equal(retired.length,1);const saved=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners.find(r=>r.rootThreadId===A.id);assert.equal(saved.generation.nativeOpen,false);assert.equal(saved.generation.execution,'revoked');}
  finally{engine.close=close;await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='overlapping-fork-stops'){
  const {home,owner,retired}=await setup('overlapping-fork-stops'),A=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,A);let release;forkReplyGate=new Promise(r=>release=r);const fork=owner.handle({action:'fork',threadId:A.id});fork.catch(()=>{});
  try{await waitFor(()=>calls.some(x=>x.home.startsWith(home+'/')&&x.input.action==='nativeFork'),'Overlapping native fork entered');const destination=engines.findLast(e=>e.dataDir.startsWith(home+'/')&&!e.closed),rows=await destination.rows();
   // Catalog does not know this returned identity yet: source Stop must fence it
   // as a provisional dependency until the reply is committed.
   await owner.handle({action:'interruptFamily',threadId:A.id});release();forkReplyGate=null;await assert.rejects(fork,/Stop|cancelled|closed|lifecycle/);await owner.handle({action:'interruptFamily',threadId:rows[0].id});await owner.disposal;assert.equal(retired.length,2);assert(JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8')).owners.every(r=>!r.generation.nativeOpen));}
  finally{release();forkReplyGate=null;await Promise.allSettled([fork]);await owner.disposal;await owner.close();}
 }
 if(!process.argv[3]||process.argv[3]==='stale-cleanup-attempt'){
  const {home,settings}=await setup('stale-cleanup-attempt'),allocate=settings.openExecutor;let roles=0,attempts=0,releaseRetry;const heldRetry=new Promise(r=>releaseRetry=r);
  settings.openExecutor=async context=>{const role=++roles,resource=await allocate(context);return {...resource,retire:async()=>{if(role===3){attempts++;if(attempts===1)throw Error('first retirement attempt fails');if(attempts===2)await heldRetry;}return resource.retire();}};};
  const owner=new CodingOwners(settings),A=(await owner.handle({action:'start',cwd:root})).thread,B=(await owner.handle({action:'start',cwd:root})).thread;await materialize(owner,A);
  const be=engines.findLast(e=>e.threadInfo.has(B.id));let releaseReply,releasePeer,peerEntered=false;forkReplyGate=new Promise(r=>releaseReply=r);const heldPeer=new Promise(r=>releasePeer=r);resolveHook=async e=>{if(e===be){peerEntered=true;await heldPeer;}};
  const fork=owner.handle({action:'fork',threadId:A.id});fork.catch(()=>{});let peer,closing;
  try{
   await waitFor(()=>calls.some(x=>x.home.startsWith(home+'/')&&x.input.action==='nativeFork'),'Fork reply held for stale cleanup case');peer=owner.handle({action:'read',threadId:B.id});peer.catch(()=>{});
   await owner.handle({action:'interruptFamily',threadId:A.id});await waitFor(()=>attempts===1,'First cleanup failed');releaseReply();forkReplyGate=null;await assert.rejects(fork,/Stop|cancelled|closed|lifecycle/);await waitFor(()=>peerEntered,'Peer holds old Stop commit');
   await closePending(owner);await waitFor(()=>attempts===2,'Global close started replacement cleanup');releasePeer();resolveHook=null;await Promise.allSettled([peer]);await new Promise(r=>setImmediate(r));
   closing=owner.close();closing.catch(()=>{});await new Promise(r=>setImmediate(r));assert.equal(attempts,2,'Old Stop outcome must not discard a newer in-flight cleanup attempt');
  }finally{releaseReply();releasePeer();releaseRetry();forkReplyGate=null;resolveHook=null;await Promise.allSettled([fork,peer,closing]);await assert.rejects(owner.disposal,/first retirement attempt fails/);await assert.rejects(owner.close(),/first retirement attempt fails/);await lstat(join(home,'coding-owners.lock'));assert.equal(attempts,2);}
 }
 console.log('Selected owner Stop checks passed');
}
if(process.argv.includes('--selected-stop-check')){try{await selectedStopChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--preparation-check')){try{await preparationChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
if(process.argv.includes('--retirement-check')){try{await retirementChecks();}finally{await rm(root,{recursive:true,force:true});}process.exit(0);}
const home=join(root,'app');await mkdir(home,{mode:0o700});const a=new CodingOwners(options(home));
try{
 await assert.rejects(a.handle({action:'start',cwd:root,executor:'browser supplied'}),/field/);assert.equal(allocations.length,0);
 const A=await a.handle({action:'start',cwd:root}),B=await a.handle({action:'start',cwd:root});
 const ledger=JSON.parse(await readFile(join(home,'coding-owners.json'),'utf8'));
 assert.equal(ledger.owners.length,2);assert.deepEqual(new Set(ledger.owners.map(o=>o.rootThreadId)),new Set([A.thread.id,B.thread.id]));
 assert(!JSON.stringify(ledger).includes('never-persist'));assert(allocations.every(x=>x.dataDir.startsWith(join(home,'owners')+'/')));
 assert.notEqual((await a.handle({action:'send',threadId:A.thread.id,text:'A'})).ownerHome,(await a.handle({action:'send',threadId:B.thread.id,text:'B'})).ownerHome);

 const ae=engines.findLast(e=>e.threadInfo.has(A.thread.id)),be=engines.findLast(e=>e.threadInfo.has(B.thread.id));const aid=randomUUID();ae.approvals.set(aid,{id:aid,method:'fixture',params:{threadId:A.thread.id}});
 assert.equal((await a.handle({action:'approvalInfo',id:aid})).ownerHome,ae.dataDir);ae.approvals.delete(aid);await assert.rejects(a.handle({action:'approvalInfo',id:aid}),/Expired/);
 be.approvals.set(aid,{id:aid,method:'fixture',params:{threadId:B.thread.id}});await assert.rejects(a.handle({action:'approvalInfo',id:aid}),/stale/);be.approvals.delete(aid);
 const concurrent=new CodingOwners(options(home));await assert.rejects(concurrent.handle({action:'list'}),/lease|owned/i);await concurrent.close();
 await a.close();const before=allocations.length,b=new CodingOwners(options(home));
 assert.equal((await b.handle({action:'read',threadId:B.thread.id})).thread.id,B.thread.id);assert.equal((await b.handle({action:'read',threadId:A.thread.id})).thread.id,A.thread.id);assert.equal(allocations.length,before,'cold history must not allocate an executor');
 for(const thread of [A.thread,B.thread]){const page=await b.handle({action:'historyPage',threadId:thread.id});assert.equal(page.threadId,thread.id);assert.equal(calls.at(-1).historyOnly,true);}assert.equal(allocations.length,before,'Saved pages must not allocate an executor');
 const listing=await b.handle({action:'list'});assert.deepEqual(new Set(listing.threads.map(t=>t.id)),new Set([A.thread.id,B.thread.id]));
 const reader=engines.findLast(e=>e.historyOnly&&e.threadInfo.has(A.thread.id));await b.handle({action:'send',threadId:A.thread.id,text:'resume'});assert(reader.closed&&reader.closeSettled);
 await assert.rejects(b.handle({action:'send',threadId:'unknown',text:'reject'}),/unknown|owner/i);
 await assert.rejects(b.handle({action:'approval',id:'stale',decision:'accept'}),/expired|unknown|stale/i);
 await b.close();

 // Real core scheduling preserves the occurrence -> owner -> thread -> turn chain.
 const scheduleHome=join(root,'scheduled');await mkdir(scheduleHome,{mode:0o700});const scheduled=new CodingOwners(options(scheduleHome));let claimed=false,threadSaved=false,scheduledID;
 const scheduleArgs={cwd:root,prompt:'bounded fixture',onClaim:async()=>{assert.equal(allocations.filter(x=>x.dataDir.startsWith(scheduleHome+'/')).length,0);claimed=true;},onThread:async threadId=>{assert(claimed);const catalog=JSON.parse(await readFile(join(scheduleHome,'coding-owners.json'),'utf8'));assert.equal(catalog.owners.length,1);assert.equal(catalog.owners[0].rootThreadId,threadId);assert.equal(catalog.owners[0].state,'ready');scheduledID=threadId;threadSaved=true;},onTurn:async turnId=>{assert(threadSaved);assert(turnId);}};
 scheduleBeginHook=async(e,threadId)=>{assert(threadSaved);assert.equal(threadId,scheduledID);assert.equal(JSON.parse(await readFile(join(scheduleHome,'coding-owners.json'),'utf8')).owners[0].creation,null,'Receipt invalidated durably before scheduled dispatch');};
 const scheduledResult=await scheduled.runScheduled(scheduleArgs);assert.equal(scheduledResult.status,'completed');assert.equal(scheduledResult.threadId,scheduledID);assert.equal(calls.filter(x=>x.home.startsWith(scheduleHome+'/')&&x.input.action==='start').length,1);scheduleBeginHook=null;await scheduled.close();

 // Retryable preclaim busy creates no new owner and consumes no occurrence.
 const busyHome=join(root,'scheduled-busy');await mkdir(busyHome,{mode:0o700});const scheduledBusy=new CodingOwners(options(busyHome));await scheduledBusy.handle({action:'start',cwd:root});const busyCount=allocations.length;let busyClaims=0;scheduleBusy=true;
 await assert.rejects(scheduledBusy.runScheduled({cwd:root,prompt:'fixture',onClaim:async()=>{busyClaims++;}}),e=>e.code==='PROJECT_BUSY');assert.equal(busyClaims,0);assert.equal(allocations.length,busyCount);assert.equal(JSON.parse(await readFile(join(busyHome,'coding-owners.json'),'utf8')).owners.length,1);scheduleBusy=false;await scheduledBusy.close();
 // A held ledger callback does not deadlock event routes or release the Stop lease.
 const heldHome=join(root,'scheduled-held'),heldCwd=join(root,'held-project');await mkdir(heldHome,{mode:0o700});await mkdir(heldCwd,{mode:0o700});const heldSchedule=new CodingOwners(options(heldHome));let heldThread,releaseThread;const heldGate=new Promise(r=>releaseThread=r);
 const heldRun=heldSchedule.runScheduled({cwd:heldCwd,prompt:'fixture',onClaim:async()=>{},onThread:async threadId=>{heldThread=threadId;await heldGate;}});
 while(!heldThread)await new Promise(r=>setImmediate(r));const heldEngine=engines.find(e=>e.threadInfo.has(heldThread));assert(heldEngine);await heldSchedule.handle({action:'events',after:0});const beforeHeld=allocations.length;
 await assert.rejects(heldSchedule.handle({action:'start',cwd:heldCwd}),e=>e.code==='PROJECT_BUSY');assert.equal(allocations.length,beforeHeld);assert.equal(JSON.parse(await readFile(join(heldHome,'coding-owners.json'),'utf8')).owners.length,1);await heldSchedule.handle({action:'events',after:0});
 await assert.rejects(heldSchedule.runScheduled({cwd:heldCwd,prompt:'second',onClaim:async()=>{throw Error('second claim');}}),e=>e.code==='PROJECT_BUSY');assert.equal(allocations.length,beforeHeld);await assert.rejects(heldSchedule.reserveProjectMutation(async()=>[root]),e=>e.code==='PROJECT_BUSY');
 const otherCwd=join(root,'unrelated-scheduled-project');await mkdir(otherCwd,{mode:0o700});await heldSchedule.handle({action:'start',cwd:otherCwd});assert.equal(allocations.length,beforeHeld+1);
 assert.equal((await heldSchedule.stop()).stopped,false);assert.equal((await heldRun).status,'interrupted');await closePending(heldSchedule);const heldContender=new CodingOwners(options(heldHome));await assert.rejects(heldContender.handle({action:'status'}),/lease/);await heldContender.close();
 releaseThread();await heldEngine.scheduledDisposal;await new Promise(r=>setImmediate(r));await heldSchedule.close();assert.equal(JSON.parse(await readFile(join(heldHome,'coding-owners.json'),'utf8')).owners[0].rootThreadId,heldThread);
 // A validated creation reply arriving after cancellation still commits ownership.
 const lateHome=join(root,'scheduled-late');await mkdir(lateHome,{mode:0o700});const late=new CodingOwners(options(lateHome));let releaseStart,lateThreadCallbacks=0;scheduleStartGate=new Promise(r=>releaseStart=r);const lateController=new AbortController();
 const lateRun=late.runScheduled({cwd:root,prompt:'fixture',signal:lateController.signal,onClaim:async()=>{},onThread:async()=>{lateThreadCallbacks++;}});
 while(!calls.some(x=>x.home.startsWith(lateHome+'/')&&x.input.action==='start'))await new Promise(r=>setImmediate(r));lateController.abort();assert.equal((await lateRun).status,'interrupted');await closePending(late);
 releaseStart();scheduleStartGate=null;await engines.findLast(e=>e.dataDir.startsWith(lateHome+'/')).scheduledDisposal;await new Promise(r=>setImmediate(r));assert.equal(lateThreadCallbacks,0);assert.equal(JSON.parse(await readFile(join(lateHome,'coding-owners.json'),'utf8')).owners[0].state,'ready');await late.close();
 // The durable root survives an outer scheduler ledger failure before inference.
 const failureHome=join(root,'scheduled-callback-failure');await mkdir(failureHome,{mode:0o700});const failedSchedule=new CodingOwners(options(failureHome));let deniedRoot;const failedRun=await failedSchedule.runScheduled({cwd:root,prompt:'fixture',onClaim:async()=>{},onThread:async threadId=>{deniedRoot=threadId;throw Error('ledger write failed');}});assert.equal(failedRun.status,'failed');assert.match(failedRun.message,/ledger write/);assert.equal((await failedSchedule.handle({action:'read',threadId:deniedRoot})).thread.id,deniedRoot);await failedSchedule.close();
 // Stop aborts an allocator before any native schedule is started.
 const allocatingHome=join(root,'scheduled-allocator');await mkdir(allocatingHome,{mode:0o700});const allocatingSchedule=new CodingOwners(options(allocatingHome));let releaseScheduleAllocation;gate=new Promise(r=>releaseScheduleAllocation=r);const allocationBefore=allocations.length;
 const allocatingRun=allocatingSchedule.runScheduled({cwd:root,prompt:'fixture',onClaim:async()=>{}});while(allocations.length===allocationBefore)await new Promise(r=>setImmediate(r));assert.equal((await allocatingSchedule.stop()).stopped,false);assert(allocations.at(-1).signal.aborted);await closePending(allocatingSchedule);releaseScheduleAllocation();gate=null;assert.equal((await allocatingRun).status,'interrupted');await allocatingSchedule.close();assert(!calls.some(x=>x.home.startsWith(allocatingHome+'/')&&x.input.action==='start'));

 // Empty native sessions retain their exact creation receipt, never invented turns.
 const emptyReceiptHome=join(root,'empty-receipt');await mkdir(emptyReceiptHome,{mode:0o700});const emptySeed=new CodingOwners(options(emptyReceiptHome)),emptyRoot=(await emptySeed.handle({action:'start',cwd:root})).thread;await emptySeed.close();let emptyCatalog=JSON.parse(await readFile(join(emptyReceiptHome,'coding-owners.json'),'utf8'));const emptyNativeHome=join(emptyReceiptHome,'owners',emptyCatalog.owners[0].id);await writeFile(join(emptyNativeHome,'fixture-threads.json'),'[]');const emptyReader=new CodingOwners(options(emptyReceiptHome)),emptyAllocations=allocations.length;
 const emptyPage=await emptyReader.handle({action:'historyPage',threadId:emptyRoot.id});assert.deepEqual(emptyPage,{threadId:emptyRoot.id,pageCursor:null,turn:null,nextCursor:null,truncated:false,historySource:'creation-receipt'});await assert.rejects(emptyReader.handle({action:'historyPage',threadId:emptyRoot.id,cursor:'stale-page'}),/no history pages/);await assert.rejects(emptyReader.handle({action:'historyPage',threadId:'unknown-empty-root'}),/owner|unknown/i);
 const emptyRead=await emptyReader.handle({action:'read',threadId:emptyRoot.id});assert.equal(emptyRead.thread.id,emptyRoot.id);assert.equal(emptyRead.historySource,'creation-receipt');assert.equal(emptyRead.thread.historyOnly,true);assert.equal(emptyRead.nativeHistoryAvailable,false);assert.deepEqual(emptyRead.thread.turns,[]);assert.equal(emptyRead.pendingMaterialization,undefined);assert.equal(emptyRead.thread.canAcceptDirectInput,null);
 assert.equal((await emptyReader.handle({action:'list'})).threads.find(t=>t.id===emptyRoot.id).historySource,'creation-receipt');assert.equal((await emptyReader.handle({action:'list',archived:true})).threads.length,0);assert.equal((await emptyReader.handle({action:'family',threadId:emptyRoot.id})).rootThreadId,emptyRoot.id);
 await assert.rejects(emptyReader.handle({action:'send',threadId:emptyRoot.id,text:'must not recreate'}),/creation|missing|saved/i);assert.equal(allocations.length,emptyAllocations);
 await assert.rejects(emptyReader.handle({action:'fork',threadId:emptyRoot.id}),/creation receipt|saved native fork history/i);assert.equal(allocations.length,emptyAllocations);
 await assert.rejects(emptyReader.handle({action:'family',threadId:emptyRoot.id,cursor:'stale-page'}),/no family pages/);
 missingRootError='empty rollout: '+emptyRoot.id;await assert.rejects(emptyReader.handle({action:'read',threadId:emptyRoot.id}),/empty rollout/);missingRootError=null;
 const emptyEngine=engines.findLast(e=>e.dataDir===emptyNativeHome);
 for(const flag of ['historyBlocked','historyWarning','liveHistoryEvicted']){const prior=emptyEngine[flag];emptyEngine[flag]=true;await assert.rejects(emptyReader.handle({action:'read',threadId:emptyRoot.id}),/thread not loaded/);emptyEngine[flag]=prior;}
 emptyEngine.liveHistory.set(emptyRoot.id,{turns:[{id:'partial',items:[]}]});await assert.rejects(emptyReader.handle({action:'read',threadId:emptyRoot.id}),/thread not loaded/);emptyEngine.liveHistory.clear();
 await assert.rejects(emptyReader.handle({action:'read',threadId:'unknown-empty-root'}),/owner|unknown/i);
 await emptyReader.close();
 // Migration cannot infer emptiness from old rows.
 emptyCatalog=JSON.parse(await readFile(join(emptyReceiptHome,'coding-owners.json'),'utf8'));emptyCatalog.version=2;delete emptyCatalog.executor;delete emptyCatalog.owners[0].mcp;delete emptyCatalog.owners[0].generation.executorClosed;delete emptyCatalog.owners[0].creation;delete emptyCatalog.owners[0].fork;await writeFile(join(emptyReceiptHome,'coding-owners.json'),JSON.stringify(emptyCatalog));
 const migratedEmpty=new CodingOwners(options(emptyReceiptHome));await assert.rejects(migratedEmpty.handle({action:'read',threadId:emptyRoot.id}),/thread not loaded/);await migratedEmpty.close();assert.equal(JSON.parse(await readFile(join(emptyReceiptHome,'coding-owners.json'),'utf8')).owners[0].creation,null);
 // Native persisted history wins and permanently consumes the empty receipt, even without live events.
 const materialHome=join(root,'materialized-receipt');await mkdir(materialHome,{mode:0o700});const materialSeed=new CodingOwners(options(materialHome)),materialRoot=(await materialSeed.handle({action:'start',cwd:root})).thread;await materialSeed.close();const materialCatalog=JSON.parse(await readFile(join(materialHome,'coding-owners.json'),'utf8')),materialNative=join(materialHome,'owners',materialCatalog.owners[0].id);
 await writeFile(join(materialNative,'fixture-threads.json'),JSON.stringify([{...materialRoot,turns:[{id:'persisted-turn',status:'completed',items:[]}]}]));
 const materialReader=new CodingOwners(options(materialHome));assert.equal((await materialReader.handle({action:'read',threadId:materialRoot.id})).thread.turns.length,1);assert.equal(JSON.parse(await readFile(join(materialHome,'coding-owners.json'),'utf8')).owners[0].creation,null,'Native persisted turns invalidate an eligible receipt');
 await writeFile(join(materialNative,'fixture-threads.json'),'[]');await assert.rejects(materialReader.handle({action:'read',threadId:materialRoot.id}),/thread not loaded/);await materialReader.close();

 // Even an ambiguous failed metadata action consumes fallback eligibility.
 const renamedHome=join(root,'renamed-empty');await mkdir(renamedHome,{mode:0o700});const renamed=new CodingOwners(options(renamedHome)),renamedRoot=(await renamed.handle({action:'start',cwd:root})).thread;
 await assert.rejects(renamed.handle({action:'rename',threadId:renamedRoot.id,name:'changed'}),/unhandled fixture/);await renamed.close();const renamedCatalog=JSON.parse(await readFile(join(renamedHome,'coding-owners.json'),'utf8'));assert.equal(renamedCatalog.owners[0].creation,null);
 // Verified descendants contradict an empty-root receipt even without turn events.
 const childHome=join(root,'receipt-descendant');await mkdir(childHome,{mode:0o700});const childSeed=new CodingOwners(options(childHome)),childRoot=(await childSeed.handle({action:'start',cwd:root})).thread;await childSeed.close();const childCatalog=JSON.parse(await readFile(join(childHome,'coding-owners.json'),'utf8')),childNative=join(childHome,'owners',childCatalog.owners[0].id),childID=randomUUID();
 await writeFile(join(childNative,'fixture-threads.json'),JSON.stringify([childRoot,{...childRoot,id:childID,parentThreadId:childRoot.id,canAcceptDirectInput:false}]));const childReader=new CodingOwners(options(childHome));assert.equal((await childReader.handle({action:'list'})).threads.length,2);const withChild=JSON.parse(await readFile(join(childHome,'coding-owners.json'),'utf8')).owners[0];assert.equal(withChild.creation,null);assert(withChild.threads.includes(childID));await writeFile(join(childNative,'fixture-threads.json'),'[]');await assert.rejects(childReader.handle({action:'read',threadId:childRoot.id}),/thread not loaded/);await childReader.close();
 // Strict v3 schema rejects malformed receipts rather than silently removing evidence.
 const malformedHome=join(root,'malformed-receipt');await mkdir(malformedHome,{mode:0o700});const malformedSeed=new CodingOwners(options(malformedHome));await malformedSeed.handle({action:'start',cwd:root});await malformedSeed.close();
 const malformedFile=join(malformedHome,'coding-owners.json'),malformedCatalog=JSON.parse(await readFile(malformedFile,'utf8'));malformedCatalog.owners[0].creation={createdAt:-1,updatedAt:1,name:null,historyMode:'legacy'};await writeFile(malformedFile,JSON.stringify(malformedCatalog));const malformed=new CodingOwners(options(malformedHome));await assert.rejects(malformed.handle({action:'status'}),/creation receipt/);await malformed.close();

 // Forks must have their own durable owner and preserve their source relation.
 const forkHome=join(root,'independent-fork');await mkdir(forkHome,{mode:0o700});const forking=new CodingOwners(options(forkHome)),forkSource=(await forking.handle({action:'start',cwd:root})).thread;
 const forkSourceEngine=await materialize(forking,forkSource);const sourceBytes=await readFile((await forkSourceEngine.rows())[0].path);
 const forked=await forking.handle({action:'fork',threadId:forkSource.id});assert.notEqual(forked.thread.id,forkSource.id);assert.equal(forked.thread.forkedFromId,forkSource.id);const forkCatalog=JSON.parse(await readFile(join(forkHome,'coding-owners.json'),'utf8'));assert.equal(forkCatalog.owners.length,2);assert.equal(forkCatalog.owners.find(r=>r.rootThreadId===forked.thread.id).creation,null);assert.equal(forkCatalog.version,9);const forkRow=forkCatalog.owners.find(r=>r.rootThreadId===forked.thread.id);assert.equal(forkRow.fork.sourceThreadId,forkSource.id);assert.equal(forkRow.fork.dispatched,true);assert.equal(forkRow.fork.worker.closed,true);assert.equal(forkRow.fork.sha256,digest(sourceBytes));assert.notEqual(forkRow.id,forkRow.fork.sourceOwnerId);await forking.close();

 // The captured source generation is historical after the source is reopened.
 const sourceAgain=new CodingOwners(options(forkHome));await sourceAgain.handle({action:'send',threadId:forkSource.id,text:'new source generation'});await sourceAgain.close();const sourceAdvanced=JSON.parse(await readFile(join(forkHome,'coding-owners.json'),'utf8'));assert.notEqual(sourceAdvanced.owners.find(r=>r.rootThreadId===forkSource.id).generation.id,forkRow.fork.sourceGeneration);
 const historicalFork=new CodingOwners(options(forkHome));assert.equal((await historicalFork.handle({action:'read',threadId:forked.thread.id})).thread.id,forked.thread.id);await historicalFork.close();

 // A dispatched fork cannot lose its destination generation in the catalog.
 const forkCatalogFile=join(forkHome,'coding-owners.json'),invalidFork=JSON.parse(await readFile(forkCatalogFile,'utf8'));invalidFork.owners.find(r=>r.fork).generation=null;const invalidForkBytes=JSON.stringify(invalidFork);await writeFile(forkCatalogFile,invalidForkBytes);const invalidForkOwner=new CodingOwners(options(forkHome)),beforeInvalidFork=allocations.length;
 await assert.rejects(invalidForkOwner.handle({action:'status'}),/fork stage|dispatch/i);assert.equal(allocations.length,beforeInvalidFork);assert.equal(await readFile(forkCatalogFile,'utf8'),invalidForkBytes);await invalidForkOwner.close();

 // Stop after durable helper receipt publication still records confirmed closure.
 const copyStopHome=join(root,'fork-copy-stop');await mkdir(copyStopHome,{mode:0o700});const fixtureNativeHelper=await realpath(process.execPath);
 await withFixtureFilesystemIdentity(copyStopHome,fixtureNativeHelper,async()=>{
 const copyStop=new CodingOwners({...options(copyStopHome),forkFiles:undefined,engineOptions:{localModels,nativeHelper:fixtureNativeHelper,spawnProcess:fixtureHelper}}),copyRoot=(await copyStop.handle({action:'start',cwd:root})).thread;await materialize(copyStop,copyRoot);
 const durableCopy=JSON.parse(await readFile(join(copyStopHome,'coding-owners.json'),'utf8'));assert.equal(durableCopy.version,10);assert.deepEqual(durableCopy.directory,{volumeUUID:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',ino:String((await lstat(copyStopHome,{bigint:true})).ino)});
 const copyFilePath=join(copyStopHome,'coding-owners.json'),originalRename=fsPromises.rename;let copyEntered=false,releaseCopy;const copyGate=new Promise(r=>releaseCopy=r);
 fsPromises.rename=async(...args)=>{const result=await originalRename(...args);if(args[1]===copyFilePath&&!copyEntered&&JSON.parse(await readFile(copyFilePath,'utf8')).owners.some(r=>r.fork?.worker?.closed===false)){copyEntered=true;await copyGate;}return result;};syncBuiltinESMExports();
 try{
  const copying=copyStop.handle({action:'fork',threadId:copyRoot.id}),copyRejected=assert.rejects(copying,/cancelled|Stop|before its durable release/);
  while(!copyEntered)await new Promise(r=>setImmediate(r));assert.equal((await copyStop.stop()).stopped,false);await closePending(copyStop);
  const contender=new CodingOwners({...options(copyStopHome),engineOptions:{localModels,nativeHelper:fixtureNativeHelper}});await assert.rejects(contender.handle({action:'status'}),/lease/);await contender.close();
  releaseCopy();await copyRejected;assert.equal(JSON.parse(await readFile(copyFilePath,'utf8')).owners.find(r=>r.fork).fork.worker.closed,true,'Confirmed dead copy helper must not remain unresolved after late Stop');assert.equal((await copyStop.close()).stopped,true);
 }finally{releaseCopy();fsPromises.rename=originalRename;syncBuiltinESMExports();}
 });

 // Fork cannot implicitly close pending approval or family control work.
 for(const key of ['approvals','approvalChecks','familyOperations']){
  const pendingForkHome=join(root,'fork-pending-'+key);await mkdir(pendingForkHome,{mode:0o700});const pendingFork=new CodingOwners(options(pendingForkHome)),pendingRoot=(await pendingFork.handle({action:'start',cwd:root})).thread,source=await materialize(pendingFork,pendingRoot),before=allocations.length;
  const operation={params:{threadId:pendingRoot.id},threadId:pendingRoot.id};if(key==='familyOperations')source[key].add(operation);else source[key].set('pending',operation);
  await assert.rejects(pendingFork.handle({action:'fork',threadId:pendingRoot.id}),e=>e.code==='PROJECT_BUSY');assert.equal(allocations.length,before);assert.equal(source.closed,false,'Busy source must not be retired');source[key].clear();await pendingFork.close();
 }

 // Incomplete history, child roots, busy work and unrevoked domains cannot allocate a destination.
 for(const variant of ['empty','child','children','partial','header','busy','unrevoked']){
  const blockedHome=join(root,'fork-blocked-'+variant);await mkdir(blockedHome,{mode:0o700});const blockedFork=new CodingOwners(options(blockedHome)),rootThread=(await blockedFork.handle({action:'start',cwd:root})).thread;
  const source=variant==='empty'?engines.at(-1):await materialize(blockedFork,rootThread);let selected=rootThread.id,expected=/history|saved/;
  if(variant==='child'||variant==='children'){const rows=await source.rows(),child={...rows[0],id:randomUUID(),parentThreadId:rootThread.id};rows.push(child);await writeFile(join(source.dataDir,'fixture-threads.json'),JSON.stringify(rows));source.rememberThread(child);if(variant==='child')selected=child.id;expected=/root chat|child family/;}
  if(variant==='partial')source.liveHistory.set(rootThread.id,{truncated:true,turns:[]});
  if(variant==='header'){const path=(await source.rows())[0].path,records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);records[0].payload.id=randomUUID();await writeFile(path,records.map(JSON.stringify).join('\n')+'\n');expected=/header|identity|selected|source|rollout/i;}
  if(variant==='busy'){source.busy.add(rootThread.id);expected=/pending/;}
  if(variant==='unrevoked'){revoked=false;expected=/revocation/;}
  const before=allocations.length;await assert.rejects(blockedFork.handle({action:'fork',threadId:selected}),expected);assert.equal(allocations.length,before);assert.equal(JSON.parse(await readFile(join(blockedHome,'coding-owners.json'),'utf8')).owners.length,1);source.busy.clear();revoked=true;await blockedFork.close();
 }
 // An ambiguous native reply preserves a dispatched provisional owner and cannot retry.
 const lostForkHome=join(root,'fork-lost');await mkdir(lostForkHome,{mode:0o700});const lostFork=new CodingOwners(options(lostForkHome)),lostSource=(await lostFork.handle({action:'start',cwd:root})).thread;await materialize(lostFork,lostSource);forkLoseReply=true;
 await assert.rejects(lostFork.handle({action:'fork',threadId:lostSource.id}),/lost native fork reply/);forkLoseReply=false;const lostForkRows=JSON.parse(await readFile(join(lostForkHome,'coding-owners.json'),'utf8')).owners,lostDestination=lostForkRows.find(r=>r.fork);assert.equal(lostDestination.state,'creating');assert.equal(lostDestination.fork.dispatched,true);assert.equal(lostDestination.creation,null);assert.equal(lostDestination.rootThreadId,null);const beforeLostRetry=allocations.length;await assert.rejects(lostFork.handle({action:'events',after:0}),/creation|unresolved/);await assert.rejects(lostFork.handle({action:'fork',threadId:lostSource.id}),/pending/);assert.equal(allocations.length,beforeLostRetry);await lostFork.close();
 // A valid late reply is durably owned even when Stop cancels its public response.
 const lateForkHome=join(root,'fork-late');await mkdir(lateForkHome,{mode:0o700});const lateFork=new CodingOwners(options(lateForkHome)),lateSource=(await lateFork.handle({action:'start',cwd:root})).thread;await materialize(lateFork,lateSource);let releaseFork;forkReplyGate=new Promise(r=>releaseFork=r);const lateResult=lateFork.handle({action:'fork',threadId:lateSource.id}),lateRejected=assert.rejects(lateResult,/cancelled|Stop|lifecycle|closed/);
 while(!calls.some(x=>x.home.startsWith(lateForkHome+'/')&&x.input.action==='nativeFork'))await new Promise(r=>setImmediate(r));assert.equal((await lateFork.stop()).stopped,false);await closePending(lateFork);releaseFork();forkReplyGate=null;await lateRejected;const lateDestination=JSON.parse(await readFile(join(lateForkHome,'coding-owners.json'),'utf8')).owners.find(r=>r.fork);assert.equal(lateDestination.state,'ready');assert(lateDestination.rootThreadId);assert.equal(lateDestination.creation,null);await lateFork.close();
 // Version 3 creation receipts survive the fork-schema upgrade.
 const v3Home=join(root,'fork-v3');await mkdir(v3Home,{mode:0o700});const v3Owner=new CodingOwners(options(v3Home));await v3Owner.handle({action:'start',cwd:root});await v3Owner.close();const v3Path=join(v3Home,'coding-owners.json'),v3Doc=JSON.parse(await readFile(v3Path,'utf8'));v3Doc.version=3;delete v3Doc.executor;for(const row of v3Doc.owners){delete row.mcp;delete row.fork;delete row.generation.executorClosed;}await writeFile(v3Path,JSON.stringify(v3Doc));const v3Reader=new CodingOwners(options(v3Home));await v3Reader.handle({action:'status'});await v3Reader.close();const v4Doc=JSON.parse(await readFile(v3Path,'utf8'));assert.equal(v4Doc.version,9);assert(v4Doc.owners[0].creation);assert.deepEqual(v4Doc.owners,v3Doc.owners.map(row=>({...row,mcp:{kind:'never-enabled'},fork:null,generation:{...row.generation,executorClosed:false}})));
 // Rejected nonterminal history still proves the creation receipt is obsolete.
 const nonterminalHome=join(root,'fork-nonterminal');await mkdir(nonterminalHome,{mode:0o700});const nonterminal=new CodingOwners(options(nonterminalHome)),nonterminalRoot=(await nonterminal.handle({action:'start',cwd:root})).thread,nonterminalEngine=await materialize(nonterminal,nonterminalRoot,false),nonterminalRows=await nonterminalEngine.rows();nonterminalRows[0].turns[0].status='inProgress';await writeFile(join(nonterminalEngine.dataDir,'fixture-threads.json'),JSON.stringify(nonterminalRows));await assert.rejects(nonterminal.handle({action:'fork',threadId:nonterminalRoot.id}),/complete saved idle/);assert.equal(JSON.parse(await readFile(join(nonterminalHome,'coding-owners.json'),'utf8')).owners[0].creation,null);await nonterminal.close();
 // Reading saved turns through fork consumes an old never-dispatched receipt too.
 const freshHistoryHome=join(root,'fork-fresh-history');await mkdir(freshHistoryHome,{mode:0o700});const freshHistory=new CodingOwners(options(freshHistoryHome)),freshRoot=(await freshHistory.handle({action:'start',cwd:root})).thread;await materialize(freshHistory,freshRoot,false);await freshHistory.handle({action:'fork',threadId:freshRoot.id});assert.equal(JSON.parse(await readFile(join(freshHistoryHome,'coding-owners.json'),'utf8')).owners.find(r=>r.rootThreadId===freshRoot.id).creation,null);await freshHistory.close();

 // Retiring a same-host executor is not domain revocation, even after clean close.
 const uncertainHome=join(root,'unrevoked');await mkdir(uncertainHome,{mode:0o700});revoked=false;
 const u=new CodingOwners(options(uncertainHome)),saved=await u.handle({action:'start',cwd:root});await u.close();
 const cold=new CodingOwners(options(uncertainHome)),beforeCold=allocations.length;
 assert.equal((await cold.handle({action:'read',threadId:saved.thread.id})).thread.id,saved.thread.id);
 await assert.rejects(cold.handle({action:'send',threadId:saved.thread.id,text:'must not allocate'}),/revocation/);
 await assert.rejects(cold.reserveProjectMutation(async()=>[root]),/pending/);assert.equal(allocations.length,beforeCold);await cold.close();
 // A failed bound engine cannot invoke its normal automatic ensure restart.
 const failHome=join(root,'failed-life');await mkdir(failHome,{mode:0o700});const f=new CodingOwners(options(failHome)),ft=await f.handle({action:'start',cwd:root});
 const bound=engines.findLast(e=>!e.historyOnly&&e.threadInfo.has(ft.thread.id));bound.fail(Error('native failure'));
 const countBeforeFailure=allocations.length;assert.equal((await f.handle({action:'read',threadId:ft.thread.id})).thread.id,ft.thread.id);
 await assert.rejects(f.handle({action:'send',threadId:ft.thread.id,text:'no automatic restart'}),/revocation/);assert.equal(allocations.length,countBeforeFailure);await f.close();revoked=true;
 // Stop remains responsive while the allocator is pending and owns no native ID.
 const pendingHome=join(root,'pending');await mkdir(pendingHome,{mode:0o700});let release;gate=new Promise(r=>release=r);
 const pending=new CodingOwners(options(pendingHome)),countBeforePending=allocations.length,creation=pending.handle({action:'start',cwd:root}),cancelled=assert.rejects(creation,/cancelled/);
 while(allocations.length===countBeforePending)await new Promise(r=>setImmediate(r));
 assert.equal((await pending.stop()).stopped,false);assert(allocations.at(-1).signal.aborted);
 await closePending(pending);const locked=new CodingOwners(options(pendingHome));await assert.rejects(locked.handle({action:'list'}),/lease/);await locked.close();
 release();gate=null;await cancelled;await pending.close();const pendingLedger=JSON.parse(await readFile(join(pendingHome,'coding-owners.json'),'utf8'));assert.equal(pendingLedger.owners[0].state,'creating');assert.equal(pendingLedger.owners[0].rootThreadId,null);
 // Corrupt and duplicated durable ownership must preserve the original bytes.
 const brokenHome=join(root,'broken');await mkdir(brokenHome,{mode:0o700});const broken=new CodingOwners(options(brokenHome));await broken.handle({action:'start',cwd:root});await broken.handle({action:'start',cwd:root});await broken.close();
 const file=join(brokenHome,'coding-owners.json'),corrupt=JSON.parse(await readFile(file,'utf8'));corrupt.owners[1].rootThreadId=corrupt.owners[0].rootThreadId;corrupt.owners[1].threads=[corrupt.owners[0].rootThreadId];const bytes=JSON.stringify(corrupt);await writeFile(file,bytes);
 const duplicate=new CodingOwners(options(brokenHome)),beforeDuplicate=allocations.length;await assert.rejects(duplicate.handle({action:'list'}),/Duplicate/);assert.equal(await readFile(file,'utf8'),bytes);assert.equal(allocations.length,beforeDuplicate);await duplicate.close();

 // A lost creation reply cannot publish an unmapped native root through events.
 const lostHome=join(root,'lost-start');await mkdir(lostHome,{mode:0o700});const lost=new CodingOwners(options(lostHome));failStart=true;
 await assert.rejects(lost.handle({action:'start',cwd:root}),/lost native/);failStart=false;
 await assert.rejects(lost.handle({action:'events',after:0}),/creation|unresolved/);await lost.close();
 // Stop fences new admission before its first asynchronous engine cancellation.
 const stopHome=join(root,'stop-admission');await mkdir(stopHome,{mode:0o700});const stopOwner=new CodingOwners(options(stopHome));await stopOwner.handle({action:'start',cwd:root});let stopRelease;stopGate=new Promise(r=>stopRelease=r);
 const stopping=stopOwner.stop(),beforeStoppedAdmission=allocations.length;await assert.rejects(stopOwner.handle({action:'start',cwd:root}),/stopping|Stop/);assert.equal(allocations.length,beforeStoppedAdmission);stopRelease();stopGate=null;await stopping;await stopOwner.close();
 // Failure while retirement is settling retains the cross-owner mutation fence.
 const retireHome=join(root,'retire-failure');await mkdir(retireHome,{mode:0o700});const retireOwner=new CodingOwners(options(retireHome));await retireOwner.handle({action:'start',cwd:root});retirementFault='retirement unavailable';
 assert.equal((await retireOwner.stop()).stopped,false);await assert.rejects(retireOwner.reserveProjectMutation(async()=>[root]),/pending/);retirementFault=null;await retireOwner.close();
 // A native failure between metadata resolution and dispatch cannot auto-restart.
 const raceHome=join(root,'final-pin');await mkdir(raceHome,{mode:0o700});const race=new CodingOwners(options(raceHome)),raceThread=await race.handle({action:'start',cwd:root});resolveHook=async e=>{resolveHook=null;e.fail(Error('fail after metadata'));};
 const sendsBefore=calls.filter(x=>x.input.action==='send').length;await assert.rejects(race.handle({action:'send',threadId:raceThread.thread.id,text:'must not dispatch'}),/lifecycle/);assert.equal(calls.filter(x=>x.input.action==='send').length,sendsBefore);await race.close();

 // A held project lease outlives coordinator close until its holder releases it.
 const leaseHome=join(root,'held-mutation');await mkdir(leaseHome,{mode:0o700});const leaseOwner=new CodingOwners(options(leaseHome));await leaseOwner.handle({action:'status'});const lease=await leaseOwner.reserveProjectMutation(async()=>[root]);await closePending(leaseOwner);
 const successor=new CodingOwners(options(leaseHome));await assert.rejects(successor.handle({action:'status'}),/lease/);await successor.close();lease.release();await leaseOwner.close();
 // Reservation and status initialization share one load, not competing leases.
 const loadHome=join(root,'load-race');await mkdir(loadHome,{mode:0o700});const loading=new CodingOwners(options(loadHome)),loadLease=loading.reserveProjectMutation(async()=>[root]),loadStatus=loading.handle({action:'status'});const [held,loadedStatus]=await Promise.all([loadLease,loadStatus]);assert(loadedStatus.available);held.release();await loading.close();
 // Missing catalogs cannot erase previously assigned owner homes.
 const absentHome=join(root,'absent');await mkdir(join(absentHome,'owners','unexplained'),{recursive:true,mode:0o700});const absent=new CodingOwners(options(absentHome));await assert.rejects(absent.handle({action:'list'}),/missing|recovery/);await absent.close();
 // Existing legacy history needs its explicit reader route before activation.
 const legacyHome=join(root,'legacy');await mkdir(join(legacyHome,'sessions'),{recursive:true,mode:0o700});await writeFile(join(legacyHome,'sessions','preserve.txt'),'legacy fixture');const legacy=new CodingOwners(options(legacyHome));await assert.rejects(legacy.handle({action:'list'}),/legacy/i);assert.equal(await readFile(join(legacyHome,'sessions','preserve.txt'),'utf8'),'legacy fixture');await legacy.close();
 // Trusted legacy admission reads the original store beside a closed managed owner.
 const mixedHome=join(root,'mixed-legacy');await mkdir(mixedHome,{mode:0o700});const seed=new CodingOwners(options(mixedHome)),managed=await seed.handle({action:'start',cwd:root});await seed.close();
 const oldRoot={id:randomUUID(),cwd:root,model,modelProvider:'saleh_local',parentThreadId:null,updatedAt:2,turns:[{id:'saved-turn',status:'completed',items:[]}]},oldArchive={...oldRoot,id:randomUUID(),archived:true},oldChild={...oldRoot,id:randomUUID(),parentThreadId:oldRoot.id};
 await mkdir(join(mixedHome,'sessions'),{mode:0o700});await writeFile(join(mixedHome,'sessions','preserve.txt'),'original legacy bytes');const oldBytes=JSON.stringify([oldRoot,oldArchive,oldChild]);await writeFile(join(mixedHome,'fixture-threads.json'),oldBytes);
 let legacyChecks=0;const legacyOptions={...options(mixedHome),assertLegacyClosed:async context=>{assert.equal(context.dataDir,mixedHome);assert(!context.signal.aborted);legacyChecks++;}},mixed=new CodingOwners(legacyOptions),allocationsBeforeLegacy=allocations.length;
 await assert.rejects(mixed.handle({action:'fork',threadId:oldRoot.id}),/Legacy execution|managed root/);assert.equal(allocations.length,allocationsBeforeLegacy);
 pageSize=1;const mixedList=await mixed.handle({action:'list'});pageSize=0;assert.deepEqual(new Set(mixedList.threads.map(t=>t.id)),new Set([managed.thread.id,oldRoot.id,oldChild.id]));assert(mixedList.threads.find(t=>t.id===oldRoot.id).historyOnly);assert(calls.some(c=>c.home===mixedHome&&c.input.action==='list'&&c.input.cursor==='1'));
 assert.deepEqual((await mixed.handle({action:'list',archived:true})).threads.map(t=>t.id),[oldArchive.id]);
 const legacyRead=await mixed.handle({action:'read',threadId:oldRoot.id});assert.deepEqual(legacyRead.thread.turns,oldRoot.turns);assert.equal(legacyRead.historyOnly,true);assert.equal(legacyRead.historySource,'legacy');
 readHook=e=>{readHook=null;e.push('coding/fixture',{afterLegacyRead:true});};const beforeEvent=await mixed.handle({action:'read',threadId:oldRoot.id}),afterRead=await mixed.handle({action:'events',after:beforeEvent.cursor});assert(afterRead.events.some(e=>e.sequence>beforeEvent.cursor&&e.params.afterLegacyRead));
 assert.equal((await mixed.handle({action:'family',threadId:oldRoot.id})).rootThreadId,oldRoot.id);assert.equal((await mixed.handle({action:'read',threadId:oldChild.id})).thread.id,oldChild.id);assert.equal((await mixed.handle({action:'read',threadId:managed.thread.id})).thread.id,managed.thread.id);
 for(const input of [{action:'start',cwd:root},{action:'send',threadId:oldRoot.id,text:'reject'},{action:'send',threadId:managed.thread.id,text:'reject'},{action:'rename',threadId:oldRoot.id,name:'reject'}])await assert.rejects(mixed.handle(input),/legacy|pending|history.only/i);
 await assert.rejects(mixed.runScheduled({cwd:root,prompt:'reject',onClaim:async()=>{throw Error('legacy claim');}}),e=>e.code==='PROJECT_BUSY');await assert.rejects(mixed.reserveProjectMutation(async()=>[root]),/pending/);assert.equal(allocations.length,allocationsBeforeLegacy);assert.equal(legacyChecks,1);assert.equal(await readFile(join(mixedHome,'fixture-threads.json'),'utf8'),oldBytes);assert.equal(await readFile(join(mixedHome,'sessions','preserve.txt'),'utf8'),'original legacy bytes');
 const mixedStop=await mixed.stop();assert.equal(mixedStop.stopped,true);assert.equal(mixedStop.executionRevoked,false);assert.equal(mixed.exitUnconfirmed,true);assert.equal(mixed.shutdownUnconfirmed,false);await assert.rejects(mixed.reserveProjectMutation(async()=>[root]),/pending/);assert.equal(allocations.length,allocationsBeforeLegacy);await mixed.close();const mixedCatalog=JSON.parse(await readFile(join(mixedHome,'coding-owners.json'),'utf8'));assert.equal(mixedCatalog.version,9);assert.deepEqual(mixedCatalog.legacy,{nativeOpen:false});
 const legacyCold=new CodingOwners(legacyOptions);assert.equal((await legacyCold.handle({action:'read',threadId:oldArchive.id})).thread.id,oldArchive.id);assert.equal(legacyChecks,2);await legacyCold.close();
 const noLegacyAuthority=new CodingOwners(options(mixedHome));assert.equal((await noLegacyAuthority.handle({action:'status'})).legacy.execution,'unknown');await assert.rejects(noLegacyAuthority.handle({action:'read',threadId:oldRoot.id}),/legacy/i);await assert.rejects(noLegacyAuthority.handle({action:'start',cwd:root}),/legacy|pending/i);await noLegacyAuthority.close();
 // Event polling during Stop must not construct a replacement legacy reader.
 const legacyStopRace=new CodingOwners(legacyOptions);await legacyStopRace.handle({action:'read',threadId:oldRoot.id});const checksBeforeStop=legacyChecks;let releaseReaderClose;readerCloseGate=new Promise(r=>releaseReaderClose=r);
 const legacyStopping=legacyStopRace.stop(),stopPoll=legacyStopRace.handle({action:'events',after:0});const rejectedPoll=assert.rejects(stopPoll,/stopping|Stop/);setTimeout(()=>{readerCloseGate=null;releaseReaderClose();},20);
 await Promise.all([legacyStopping,rejectedPoll]);assert.equal(legacyChecks,checksBeforeStop);await legacyStopRace.close();
 // A saved open reader cannot be reset by a new callback or omitted opt-in.
 const legacyFile=join(mixedHome,'coding-owners.json'),staleHome=join(root,'stale-legacy');await mkdir(join(staleHome,'sessions'),{recursive:true,mode:0o700});await writeFile(join(staleHome,'fixture-threads.json'),oldBytes);
 const staleOptions={...options(staleHome),assertLegacyClosed:async()=>{legacyChecks++;}},staleSeed=new CodingOwners(staleOptions);await staleSeed.handle({action:'list'});await staleSeed.close();const staleFile=join(staleHome,'coding-owners.json'),staleLegacy=JSON.parse(await readFile(staleFile,'utf8'));staleLegacy.legacy.nativeOpen=true;await writeFile(staleFile,JSON.stringify(staleLegacy));const staleLegacyOwner=new CodingOwners(staleOptions),checksBeforeStale=legacyChecks;
 await assert.rejects(staleLegacyOwner.handle({action:'read',threadId:oldRoot.id}),/unconfirmed/);assert.equal(legacyChecks,checksBeforeStale);assert.equal((await staleLegacyOwner.close()).stopped,false);assert.equal(JSON.parse(await readFile(staleFile,'utf8')).legacy.nativeOpen,true);await lstat(join(staleHome,'coding-owners.lock'));
 // Archived legacy IDs also conflict with active managed ownership.
 const conflictHome=join(root,'conflicting-legacy');await mkdir(conflictHome,{mode:0o700});const conflictSeed=new CodingOwners(options(conflictHome)),conflictRoot=(await conflictSeed.handle({action:'start',cwd:root})).thread;await conflictSeed.close();await mkdir(join(conflictHome,'sessions'),{mode:0o700});
 const conflictingBytes=JSON.stringify([oldRoot,{...oldArchive,id:conflictRoot.id},oldChild]);await writeFile(join(conflictHome,'fixture-threads.json'),conflictingBytes);const legacyConflict=new CodingOwners({...options(conflictHome),assertLegacyClosed:async()=>{}});
 await assert.rejects(legacyConflict.handle({action:'list'}),/Conflicting/);assert.equal(await readFile(join(conflictHome,'fixture-threads.json'),'utf8'),conflictingBytes);assert.equal((await legacyConflict.close()).stopped,false);await lstat(join(conflictHome,'coding-owners.lock'));
 // Stop cancels a pending trusted callback and retains the catalog lease.
 let releaseLegacyCheck,callbackEntered=false,legacySignal;const legacyCheckGate=new Promise(r=>releaseLegacyCheck=r),pendingLegacy=new CodingOwners({...options(mixedHome),assertLegacyClosed:async({signal})=>{callbackEntered=true;legacySignal=signal;await legacyCheckGate;}}),pendingRead=pendingLegacy.handle({action:'read',threadId:oldRoot.id}),cancelledRead=assert.rejects(pendingRead,/cancelled/);
 while(!callbackEntered)await new Promise(r=>setImmediate(r));assert.equal((await pendingLegacy.stop()).stopped,false);assert(legacySignal.aborted);await closePending(pendingLegacy);
 const legacyContender=new CodingOwners(legacyOptions);await assert.rejects(legacyContender.handle({action:'status'}),/lease/);await legacyContender.close();releaseLegacyCheck();await cancelledRead;await pendingLegacy.close();assert.equal(JSON.parse(await readFile(legacyFile,'utf8')).legacy.nativeOpen,false);
 // The prior catalog schema upgrades without changing its managed ownership.
 const upgradeHome=join(root,'v1-upgrade');await mkdir(upgradeHome,{mode:0o700});const upgradeSeed=new CodingOwners(options(upgradeHome));await upgradeSeed.handle({action:'start',cwd:root});await upgradeSeed.close();const upgradeFile=join(upgradeHome,'coding-owners.json'),v1=JSON.parse(await readFile(upgradeFile,'utf8'));v1.version=1;delete v1.executor;delete v1.legacy;for(const row of v1.owners){delete row.mcp;delete row.creation;delete row.fork;delete row.generation.executorClosed;}await writeFile(upgradeFile,JSON.stringify(v1));const upgrade=new CodingOwners(options(upgradeHome));await upgrade.handle({action:'status'});await upgrade.close();const v2=JSON.parse(await readFile(upgradeFile,'utf8'));assert.equal(v2.version,9);assert.equal(v2.legacy,null);assert.deepEqual(v2.owners,v1.owners.map(row=>({...row,mcp:{kind:'never-enabled'},creation:null,fork:null,generation:{...row.generation,executorClosed:false}})));
 // External edits and directory replacement preserve evidence and reject routes.
 const editHome=join(root,'external');await mkdir(editHome,{mode:0o700});const edited=new CodingOwners(options(editHome)),et=await edited.handle({action:'start',cwd:root});const editFile=join(editHome,'coding-owners.json'),originalBytes=await readFile(editFile,'utf8');await writeFile(editFile,originalBytes+' ');
 await assert.rejects(edited.handle({action:'send',threadId:et.thread.id,text:'reject'}),/externally/);assert.equal(await readFile(editFile,'utf8'),originalBytes+' ');await assert.rejects(edited.close(),/externally|blocked/);
 const replacedHome=join(root,'replaced');await mkdir(replacedHome,{mode:0o700});const originalOwner=new CodingOwners(options(replacedHome)),ot=await originalOwner.handle({action:'start',cwd:root});await originalOwner.close();const doc=JSON.parse(await readFile(join(replacedHome,'coding-owners.json'),'utf8')),nativeHome=join(replacedHome,'owners',doc.owners[0].id);await rename(nativeHome,nativeHome+'.saved');await mkdir(nativeHome,{mode:0o700});const replaced=new CodingOwners(options(replacedHome));await assert.rejects(replaced.handle({action:'read',threadId:ot.thread.id}),/identity/);await replaced.close();

 // Global list cursors are coordinator snapshots, never a native owner's cursor.
 const pageHome=join(root,'pages');await mkdir(pageHome,{mode:0o700});const paged=new CodingOwners(options(pageHome)),pt=await paged.handle({action:'start',cwd:root}),pe=engines.findLast(e=>e.threadInfo.has(pt.thread.id));
 const pageRows=[pt.thread,...Array.from({length:51},()=>({...pt.thread,id:randomUUID(),parentThreadId:pt.thread.id}))];await writeFile(join(pe.dataDir,'fixture-threads.json'),JSON.stringify(pageRows));const first=await paged.handle({action:'list'});assert.equal(first.threads.length,50);assert(first.nextCursor);
 await writeFile(join(pe.dataDir,'fixture-threads.json'),JSON.stringify([pt.thread]));const second=await paged.handle({action:'list',cursor:first.nextCursor});assert.equal(second.threads.length,2);assert.equal(second.nextCursor,null);assert.equal(new Set([...first.threads,...second.threads].map(t=>t.id)).size,52);await assert.rejects(paged.handle({action:'list',archived:true,cursor:first.nextCursor}),/cursor/);await paged.close();

 // Startup cannot pin a null/dead process as a healthy executable generation.
 const startupHome=join(root,'startup-life');await mkdir(startupHome,{mode:0o700});const startup=new CodingOwners(options(startupHome));failEnsure=true;const beforeStartup=calls.filter(x=>x.input.action==='start').length;await assert.rejects(startup.handle({action:'start',cwd:root}),/process|lifecycle/);assert.equal(calls.filter(x=>x.input.action==='start').length,beforeStartup);await startup.close();
 // Stop's admission barrier also covers a new project reservation on an empty host.
 const emptyHome=join(root,'empty-stop');await mkdir(emptyHome,{mode:0o700});const empty=new CodingOwners(options(emptyHome));await empty.handle({action:'status'});const emptyStopping=empty.stop();await assert.rejects(empty.reserveProjectMutation(async()=>[root]),/pending/);await emptyStopping;await empty.close();
 // Filesystem root overlaps every descendant project, including retained writers.
 const rootHome=join(root,'root-scope');await mkdir(rootHome,{mode:0o700});revoked=false;const rootOwner=new CodingOwners(options(rootHome));await rootOwner.handle({action:'start',cwd:'/'});await rootOwner.close();const rootCold=new CodingOwners(options(rootHome));await assert.rejects(rootCold.handle({action:'start',cwd:root}),/pending/);await rootCold.close();revoked=true;
 // Current provider settings live at the application root, never each owner home.
 const providerHome=join(root,'provider'),privateHome=join(providerHome,'private');await mkdir(privateHome,{recursive:true,mode:0o700});
 await writeFile(join(providerHome,'providers.json'),JSON.stringify({cloud:{name:'Global',model:'explicit-cloud',baseURL:'https://example.invalid/v1'}}));await writeFile(join(privateHome,'providers.json'),'not valid json');
 const profile=new CodingEngine({dataDir:privateHome,providerDataDir:providerHome,historyOnly:true});assert.equal((await profile.providerMetadata()).name,'Global');await profile.close();
 await readinessChecks();await retirementChecks();await selectedStopChecks();await modelMergeChecks();await publicationChecks();await preparationChecks();
 console.log('coding owner durable routing, uncertainty, Stop and provider checks passed');
}finally{await a.close();await rm(root,{recursive:true,force:true});}
