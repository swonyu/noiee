import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,realpath,lstat} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fstatSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodingEngine} from './coding-engine.mjs';
import {CodingOwners} from './coding-owners.mjs';
import {codingRuntimeContract} from './coding-runtime.mjs';

// No application, model, executor or Codex process is started by these fixtures.
// Only the filesystem-identity helper transport is replaced with FD-bound data.
export async function runGoalOwnerChecks({root,check}){
 const helper=await realpath(process.execPath),model='qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp',volumeUUID='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
 const priorSpawn=childProcess.spawn,priorOpen=fsPromises.open,files=new Map(),engines=[];let allocations=0,dispatches=0,lookups=0,resumes=0,nativeGoalReads=0,refuseModel=false,loseReply=false,nativeGoalReply={goal:null},nativeGoalsDisabled=true,nativeGoalReadError=false,nativeGoalGate=null,nativeGoalEntered=null,nativeGoalConfigOverride=undefined;
 fsPromises.open=async(...args)=>{const file=await priorOpen(...args);if(typeof args[0]==='string'&&(args[0]===root||args[0].startsWith(root+'/')))files.set(file.fd,args[0]);return file;};
 childProcess.spawn=(file,args,options)=>{
  assert.equal(file,helper,'No actual executable may be launched');assert.deepEqual(args,['--handoff-process','filesystem-identity']);const fd=options.stdio[3],path=files.get(fd);assert(path);const held=fstatSync(fd,{bigint:true}),named=lstatSync(path,{bigint:true});assert(!named.isSymbolicLink());assert.equal(held.dev,named.dev);assert.equal(held.ino,named.ino);
  const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),kill(){throw Error('Unexpected fixture cancellation');}});queueMicrotask(()=>{child.stdout.end(JSON.stringify({volumeUUID,ino:String(held.ino)})+'\n');child.stderr.end();child.emit('close',0,null);});return child;
 };syncBuiltinESMExports();
 class FixtureEngine extends CodingEngine {
  constructor(options){super(options);engines.push(this);/* Simulated verification only: this fixture never launches or qualifies the native runtime. */this.runtimeVerification=Object.freeze({path:this.binary,cliVersion:codingRuntimeContract.cliVersion,sha256:codingRuntimeContract.binary.sha256,protocolRevision:codingRuntimeContract.protocol.revision});}
  async ensure(){if(this.closed)throw Error('Fixture closed');if(!this.processLife){this.child={killed:false};this.processLife={child:this.child,exited:false};}}
  fail(error){if(this.processLife)this.processLife.exited=true;this.processLife=null;this.child=null;super.fail(error);}
  async close(){if(!this.closed){this.closed=true;this.fail(Error('Fixture close'));}return super.close();}
  async stop(){this.fail(Error('Fixture Stop'));return {message:'Fixture stopped'};}
  async prepare(){}
  async temporaryEnvironment(){return {};}
  async resume(threadId,cwd,profile,epoch,admission){resumes++;this.checkEpoch(epoch);this.checkAdmission(admission,cwd);this.loaded.add(threadId);}
  async projectHasBackground(){return false;}
  async scheduledFamilyIdle(){return true;}
  async rows(){try{return JSON.parse(await readFile(join(this.dataDir,'fixture-goals-threads.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
  async saveRows(rows){await writeFile(join(this.dataDir,'fixture-goals-threads.json'),JSON.stringify(rows),{mode:0o600});}
  async rpc(method,params){
   if(method==='config/read')return nativeGoalConfigOverride!==undefined?structuredClone(nativeGoalConfigOverride):{config:{features:{goals:nativeGoalsDisabled?false:true}}};
   if(method==='thread/goal/get'){nativeGoalReads++;nativeGoalEntered?.();if(nativeGoalGate)await nativeGoalGate;if(nativeGoalReadError)throw nativeGoalReadError===true?Error('Fixture native Goal read unavailable'):nativeGoalReadError;return structuredClone(nativeGoalReply);}
   const rows=await this.rows(),thread=rows.find(row=>row.id===params.threadId);
   if(method==='thread/read'){if(!thread)throw Error('Unknown fixture thread');return {thread:structuredClone(thread)};}
   if(method==='thread/turns/list')return {data:(thread?.turns??[]).slice().reverse(),nextCursor:null};
   if(method==='turn/start'){
    dispatches++;if(loseReply)throw Error('Fixture lost turn reply');const turn={id:randomUUID(),status:'inProgress',items:[]};thread.turns.push(turn);await this.saveRows(rows);this.receive({method:'turn/started',params:{threadId:thread.id,turn}});return {turn};
   }
   throw Error('Unexpected fixture RPC: '+method);
  }
  async handle(input,answer,hooks){
   if(input.action==='send')return super.handle(input,answer,hooks);
   await this.ensure();if(input.action==='status')return {available:true,activeTurns:[...this.runs].map(([threadId,turnId])=>({threadId,turnId})),stoppingFamilies:[],terminals:[],busy:false,running:this.runs.size>0};
   const rows=await this.rows();
   if(input.action==='start'){const thread={id:randomUUID(),cwd:input.cwd,model,modelProvider:'saleh_local',parentThreadId:null,status:{type:'idle'},turns:[]};rows.push(thread);await this.saveRows(rows);this.rememberThread(thread);this.verifiedThreads.add(thread.id);this.loaded.add(thread.id);return {thread};}
   const thread=rows.find(row=>row.id===input.threadId);if(!thread)throw Error('Unknown fixture thread');this.rememberThread(thread);this.verifiedThreads.add(thread.id);
   if(input.action==='read')return {thread,cursor:this.sequence};if(input.action==='family')return {rootThreadId:thread.id,root:thread,threads:[],nextCursor:null};throw Error('Unexpected fixture action: '+input.action);
  }
  async resolveFamily(id){const rows=await this.rows(),thread=rows.find(row=>row.id===id);if(!thread)throw Error('Unknown fixture family');let rootThread=thread;while(rootThread.parentThreadId)rootThread=rows.find(row=>row.id===rootThread.parentThreadId);for(const row of [rootThread,thread]){this.rememberThread(row);this.verifiedThreads.add(row.id);}return {root:rootThread,thread};}
  async finish(threadId,turnId,status='completed'){const rows=await this.rows(),thread=rows.find(row=>row.id===threadId),turn=thread.turns.find(turn=>turn.id===turnId);turn.status=status;await this.saveRows(rows);this.receive({method:'turn/completed',params:{threadId,turn}});}
 }
 const localModels={async resolve(id){lookups++;if(refuseModel)throw Error('Fixture model context unavailable');return {id,contextLength:39424,generation:{max_tokens:8192,reasoning_effort:'none'}};}};
 const options=dataDir=>({dataDir,engineOptions:{localModels,nativeHelper:helper,binary:join(root,'never-run-codex')},engineFactory:options=>new FixtureEngine(options),openExecutor:async context=>{allocations++;return {binding:{url:'ws://127.0.0.1:19999',authToken:'fixture-only',launch:{argv:['/fixture/codex'],cwd:'file:///private/var/empty',env:{HOME:context.dataDir}}},retire:async()=>({ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true})};}});
 let next=0;const opened=[];
 async function fixture(){const dataDir=join(root,'owner-'+(++next));await mkdir(dataDir,{mode:0o700});const project=join(dataDir,'project');await mkdir(project,{mode:0o700});const owner=new CodingOwners(options(dataDir));opened.push(owner);const thread=(await owner.handle({action:'start',cwd:project})).thread;return {dataDir,project,owner,thread,engine:engines.findLast(engine=>engine.threadInfo.has(thread.id))};}
 async function save(f,maxTurns=3){return f.owner.handle({action:'goalSave',threadId:f.thread.id,expectedRevision:0,objective:'Update only the fixture',completionCriteria:'Fixture command receipts prove the requested result.',maxTurns});}
 const continuation=(f,revision,mode='build',effort='none')=>f.owner.handle({action:'goalContinue',threadId:f.thread.id,expectedRevision:revision,mode,effort});
 try{
  await check('owner inspection, Save, Pause and Resume never start or resume execution',async()=>{
   const f=await fixture(),counts=[engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads];assert.equal((await f.owner.handle({action:'status'})).goals,true);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal,null);let view=await save(f);view=await f.owner.handle({action:'goalPause',threadId:f.thread.id,expectedRevision:view.revision});view=await f.owner.handle({action:'goalResume',threadId:f.thread.id,expectedRevision:view.revision});assert.equal(view.goal.state,'ready');assert.deepEqual([engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads],counts);
   await f.owner.close();const cold=new CodingOwners(options(f.dataDir));opened.push(cold);const before=[engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads];view=await cold.handle({action:'goalInspect',threadId:f.thread.id});assert.equal(view.goal.state,'ready');assert.deepEqual([engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads],before);await cold.close();
  });
  await check('explicit Continue uses actual send admission and stores one exact turn',async()=>{
   const f=await fixture(),saved=await save(f),before=dispatches,lookupsBefore=lookups,result=await continuation(f,saved.revision,'plan','high');assert.equal(dispatches,before+1);assert.equal(lookups,lookupsBefore+1);assert.equal(result.turn.id,result.turnId);assert.equal(result.goal.attempts[0].turnId,result.turnId);assert.equal(result.goal.attempts[0].mode,'plan');assert.equal(result.goal.attempts[0].effort,'high');await assert.rejects(continuation(f,saved.revision),/changed|unresolved|active/);assert.equal(dispatches,before+1);await f.engine.finish(f.thread.id,result.turnId);const view=await f.owner.handle({action:'goalInspect',threadId:f.thread.id});assert.equal(view.goal.attempts[0].status,'completed');assert.equal(dispatches,before+1);await f.owner.close();
  });
  await check('child Goal requests cannot provision another owner or send',async()=>{
   const f=await fixture(),rows=await f.engine.rows(),child={...rows[0],id:randomUUID(),parentThreadId:f.thread.id};rows.push(child);await f.engine.saveRows(rows);f.engine.rememberThread(child);const before=[engines.length,allocations,dispatches];for(const action of ['goalInspect','goalContinue'])await assert.rejects(f.owner.handle({action,threadId:child.id,...(action==='goalContinue'?{expectedRevision:1,mode:'build',effort:'none'}:{})}),/root task/);assert.deepEqual([engines.length,allocations,dispatches],before);await f.owner.close();
  });
  await check('model failure occurs before a Goal claim or turn dispatch',async()=>{const f=await fixture(),saved=await save(f),before=dispatches;refuseModel=true;try{await assert.rejects(continuation(f,saved.revision),/model context unavailable/);}finally{refuseModel=false;}assert.equal(dispatches,before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();});
  await check('family activity and workspace publication block Goal claims',async()=>{
   const f=await fixture(),saved=await save(f),before=dispatches;f.engine.runs.set(f.thread.id,'ordinary-active');await assert.rejects(continuation(f,saved.revision),/already running|active|idle/);f.engine.runs.delete(f.thread.id);const publication={publication:true,threadId:f.thread.id,cwd:f.project};f.engine.admissions.add(publication);await assert.rejects(continuation(f,saved.revision),/busy|idle/i);f.engine.admissions.delete(publication);assert.equal(dispatches,before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();
  });
  await check('queued follow-ups keep precedence over explicit Goal Continue',async()=>{
   const f=await fixture(),saved=await save(f);f.engine.runs.set(f.thread.id,'ordinary-active');const prepared=await f.owner.handleQueue({action:'prepare',id:randomUUID(),threadId:f.thread.id,text:'Queued fixture',attachments:[],effort:'none',mode:'build'});await f.owner.handleQueue({action:'commit',token:prepared.token});const before=dispatches;await assert.rejects(continuation(f,saved.revision),/Queued follow-ups have precedence/);assert.equal(dispatches,before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.handleQueue({action:'pause',threadId:f.thread.id});f.engine.runs.delete(f.thread.id);await f.owner.close();
  });
  await check('ambiguous native reply stays held across cold inspection without replay',async()=>{
   const f=await fixture(),saved=await save(f),before=dispatches;loseReply=true;try{await assert.rejects(continuation(f,saved.revision),/lost turn reply/);}finally{loseReply=false;}let view=await f.owner.handle({action:'goalInspect',threadId:f.thread.id});assert.equal(view.goal.state,'needsReview');assert.equal(view.goal.attemptsUsed,1);assert.equal(view.goal.attempts[0].turnId,null);await assert.rejects(continuation(f,view.revision),/unresolved/);assert.equal(dispatches,before+1);await f.owner.close();const cold=new CodingOwners(options(f.dataDir));opened.push(cold);const counts=[engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads];view=await cold.handle({action:'goalInspect',threadId:f.thread.id});assert.equal(view.goal.state,'needsReview');await assert.rejects(cold.handle({action:'goalContinue',threadId:f.thread.id,expectedRevision:view.revision,mode:'build',effort:'none'}),/unresolved/);assert.deepEqual([engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads],counts);await cold.close();
  });
  await check('manual completion rejects a still-active task family',async()=>{
   const f=await fixture(),saved=await save(f);f.engine.runs.set(f.thread.id,'ordinary-active');await assert.rejects(f.owner.handle({action:'goalComplete',threadId:f.thread.id,expectedRevision:saved.revision,evidence:'Reviewed fixture evidence'}),/become idle/);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.state,'ready');f.engine.runs.delete(f.thread.id);const done=await f.owner.handle({action:'goalComplete',threadId:f.thread.id,expectedRevision:saved.revision,evidence:'Reviewed fixture evidence'});assert.equal(done.goal.state,'complete');await f.owner.close();
  });
  await check('lost writer projects a held receipt before coordinator restart',async()=>{
   const f=await fixture(),saved=await save(f),result=await continuation(f,saved.revision),before=dispatches;f.engine.fail(Error('Fixture writer lost'));const view=await f.owner.handle({action:'goalInspect',threadId:f.thread.id});assert.equal(view.goal.state,'needsReview');assert.equal(view.goal.attempts[0].status,'unknown');assert.equal(view.goal.attempts[0].turnId,result.turnId);assert.equal(dispatches,before);await f.owner.close();
  });
  await check('acknowledgement publication failure retains both claim and staged receipt',async()=>{
   const f=await fixture(),saved=await save(f),before=dispatches,originalRename=fsPromises.rename;let failed=false;
   fsPromises.rename=async(...args)=>{if(args[1]===join(f.dataDir,'coding-goals.json')){const doc=JSON.parse(await readFile(args[0],'utf8'));if(!failed&&doc.goals[0].attempts[0]?.status==='running'){failed=true;throw Error('Fixture acknowledgement publication failed');}}return originalRename(...args);};syncBuiltinESMExports();
   try{await assert.rejects(continuation(f,saved.revision),/publication is unconfirmed/);}finally{fsPromises.rename=originalRename;syncBuiltinESMExports();}
   assert(failed);assert.equal(dispatches,before+1);const savedDoc=JSON.parse(await readFile(join(f.dataDir,'coding-goals.json'),'utf8'));assert.equal(savedDoc.goals[0].attempts.length,1);assert.equal(savedDoc.goals[0].attempts[0].status,'starting');assert.equal(savedDoc.goals[0].attempts[0].turnId,null);
   const stages=(await fsPromises.readdir(f.dataDir)).filter(name=>name.startsWith('coding-goals.json.')&&name.endsWith('.tmp'));assert.equal(stages.length,1);const staged=JSON.parse(await readFile(join(f.dataDir,stages[0]),'utf8'));assert(staged.goals[0].attempts[0].turnId);await assert.rejects(f.owner.handle({action:'goalInspect',threadId:f.thread.id}),/publication is unconfirmed/);await assert.rejects(continuation(f,saved.revision),/publication is unconfirmed/);assert.equal(dispatches,before+1);await f.owner.close();
  });
  await check('archived root inspection exposes its saved contract without execution',async()=>{
   const f=await fixture(),saved=await save(f),rows=await f.engine.rows();rows[0].archived=true;rows[0].path=join(f.engine.dataDir,'archived_sessions','fixture.jsonl');await f.engine.saveRows(rows);const before=[engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads],view=await f.owner.handle({action:'goalInspect',threadId:f.thread.id});assert.equal(view.goal.id,saved.goal.id);assert.deepEqual([engines.length,allocations,lookups,dispatches,resumes,nativeGoalReads],before);await f.owner.close();
  });
  await check('native Goal presence and unknown responses block before resume or claim',async()=>{
   for(const reply of [{goal:{status:'active'}},{goal:{status:'paused'}},{goal:{status:'complete'}},{},null,[],{goal:null,unexpected:true}]){
    const f=await fixture(),saved=await save(f),before=[resumes,dispatches];nativeGoalReply=reply;try{await assert.rejects(continuation(f,saved.revision),error=>error.code==='GOAL_NATIVE_UNCONFIRMED');}finally{nativeGoalReply={goal:null};}assert.deepEqual([resumes,dispatches],before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();
   }
  });
  await check('native Goal read failure and enabled lifecycle fail closed before resume',async()=>{
   for(const reason of ['read-error','enabled']){const f=await fixture(),saved=await save(f),before=[resumes,dispatches];nativeGoalReadError=reason==='read-error';nativeGoalsDisabled=reason!=='enabled';try{await assert.rejects(continuation(f,saved.revision),error=>error.code==='GOAL_NATIVE_UNCONFIRMED');}finally{nativeGoalReadError=false;nativeGoalsDisabled=true;}assert.deepEqual([resumes,dispatches],before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();}
  });
  await check('verified native disablement permits exactly one explicit Goal turn',async()=>{
   const f=await fixture(),saved=await save(f),before=[resumes,dispatches];nativeGoalReadError=Object.assign(Error('goals feature is disabled'),{rpcCode:-32600});
   try{const result=await continuation(f,saved.revision);assert.deepEqual([resumes,dispatches],[before[0]+1,before[1]+1]);assert.equal(result.goal.attempts.length,1);assert.equal(result.goal.attempts[0].turnId,result.turn.id);await f.engine.finish(f.thread.id,result.turn.id);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attempts[0].status,'completed');assert.equal(dispatches,before[1]+1);}finally{nativeGoalReadError=false;await f.owner.close();}
  });
  await check('same disabled message with a wrong or absent RPC code stays held',async()=>{
   for(const rpcCode of [-32601,-32603,'-32600',undefined]){const f=await fixture(),saved=await save(f),before=[resumes,dispatches];nativeGoalReadError=Object.assign(Error('goals feature is disabled'),{rpcCode});try{await assert.rejects(continuation(f,saved.revision),error=>error.code==='GOAL_NATIVE_UNCONFIRMED');}finally{nativeGoalReadError=false;}assert.deepEqual([resumes,dispatches],before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();}
  });
  await check('disabled RPC code with a different message stays held',async()=>{
   for(const message of ['Goals feature is disabled','goals feature is disabled ','goals feature is unavailable','thread not found']){const f=await fixture(),saved=await save(f),before=[resumes,dispatches];nativeGoalReadError=Object.assign(Error(message),{rpcCode:-32600});try{await assert.rejects(continuation(f,saved.revision),error=>error.code==='GOAL_NATIVE_UNCONFIRMED');}finally{nativeGoalReadError=false;}assert.deepEqual([resumes,dispatches],before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();}
  });
  await check('disabled API response cannot replace a fresh explicit false configuration',async()=>{
   for(const config of [null,{}, {config:{}},{config:{features:{}}},{config:{features:{goals:'false'}}},{config:{features:{goals:null}}}]){const f=await fixture(),saved=await save(f),before=[resumes,dispatches,nativeGoalReads];nativeGoalReadError=Object.assign(Error('goals feature is disabled'),{rpcCode:-32600});nativeGoalConfigOverride=config;try{await assert.rejects(continuation(f,saved.revision),error=>error.code==='GOAL_NATIVE_UNCONFIRMED');}finally{nativeGoalReadError=false;nativeGoalConfigOverride=undefined;}assert.deepEqual([resumes,dispatches,nativeGoalReads],before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();}
  });
  await check('unverified or changed runtime pins reject even explicit native absence',async()=>{
   for(const change of [null,{sha256:'0'.repeat(64)},{cliVersion:'codex-cli other'},{protocolRevision:'other'},{path:'/different/fixture'}]){const f=await fixture(),saved=await save(f),before=[resumes,dispatches,nativeGoalReads];f.engine.runtimeVerification=change===null?null:{...f.engine.runtimeVerification,...change};await assert.rejects(continuation(f,saved.revision),error=>error.code==='GOAL_NATIVE_UNCONFIRMED');assert.deepEqual([resumes,dispatches,nativeGoalReads],before);assert.equal((await f.owner.handle({action:'goalInspect',threadId:f.thread.id})).goal.attemptsUsed,0);await f.owner.close();}
  });
  await check('protocol preserves numeric RPC error codes without broadening local error codes',async()=>{
   const f=await fixture();for(const code of [-32600,'-32600',null]){const id=randomUUID();let received;f.engine.pending.set(id,{method:'thread/goal/get',params:{threadId:f.thread.id},timer:null,reject:error=>received=error,resolve:()=>assert.fail('Error response resolved')});f.engine.receive({id,error:{code,message:'goals feature is disabled'}});assert(received instanceof Error);assert.equal(received.message,'goals feature is disabled');assert.equal(received.rpcCode,typeof code==='number'?code:undefined);assert.equal(received.code,undefined);assert.equal(f.engine.pending.has(id),false);}await f.owner.close();
  });
  await check('Stop during native Goal inspection cancels before resume and claim',async()=>{
   const f=await fixture(),saved=await save(f),before=[resumes,dispatches];let release,entered;nativeGoalGate=new Promise(resolve=>release=resolve);const arrival=new Promise(resolve=>entered=resolve);nativeGoalEntered=entered;
   try{const pending=continuation(f,saved.revision),rejected=assert.rejects(pending,/cancelled|Stop|process changed|closed|lifecycle/i);await arrival;const stopping=f.owner.stop();await new Promise(resolve=>setImmediate(resolve));release();nativeGoalGate=null;nativeGoalEntered=null;await rejected;await stopping;assert.deepEqual([resumes,dispatches],before);const doc=JSON.parse(await readFile(join(f.dataDir,'coding-goals.json'),'utf8'));assert.equal(doc.goals[0].attempts.length,0);}finally{release();nativeGoalGate=null;nativeGoalEntered=null;await f.owner.close();}
  });
  await check('native project-grant and provisioning branches include explicit Continue',async()=>{
   const tools=await readFile(new URL('./Tools.swift',import.meta.url),'utf8'),provisioning=await readFile(new URL('./CodingProvisioning.swift',import.meta.url),'utf8');assert(tools.includes('if ["start","send","goalContinue","review","terminalStart","fork"].contains(action)'));assert(tools.includes('reviewCodingProject(scope,expected:expected)'));assert(tools.includes('if action=="goalContinue" {'));assert(provisioning.includes('"send","goalContinue","steer"'));assert(!tools.includes('case "goalResume": return true'));
  });
 }finally{for(const owner of opened)await owner.close().catch(()=>{});childProcess.spawn=priorSpawn;fsPromises.open=priorOpen;syncBuiltinESMExports();}
}
