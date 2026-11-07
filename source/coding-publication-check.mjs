// Scripted engine lifetimes; native publication is covered by the task fixture.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CodingEngine,CodingProjects} from './coding-engine.mjs';

const root=await realpath(await mkdtemp(join(tmpdir(),'coding-publication-'))),projects=new CodingProjects();
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
const binding={url:'ws://127.0.0.1:19999',authToken:'fixture-only',launch:{argv:['/fixture/codex'],cwd:'file:///private/var/empty',env:{}}};
async function fixture(name,cwd){
  const dataDir=join(root,name);await mkdir(dataDir);cwd??=dataDir;
  const engine=new CodingEngine({dataDir,projects,executor:binding});
  const id=randomUUID();engine.child={};engine.processLife={child:engine.child};
  engine.threadInfo.set(id,{id,cwd,parentThreadId:null,status:{type:'idle'}});engine.verifiedThreads.add(id);
  engine.disposeProcess=async()=>{};engine.savePartialHistory=()=>{};
  engine.providerMetadata=async()=>null;engine.findBinary=async()=>'/fixture/codex';
  engine.projectHasBackground=async()=>false;
  return {engine,id,cwd,run:operation=>engine.runPublication({threadId:id,cwd,signal:new AbortController().signal,operation})};
}
assert.equal(typeof CodingEngine.prototype.runPublication,'function','Missing owner publication admission/drain');
const A=await fixture('A'),B=await fixture('B'),entered=deferred(),release=deferred();let aborted=false,finished=false;
const write=A.run(async({signal,check})=>{check();signal.addEventListener('abort',()=>aborted=true,{once:true});entered.resolve();await release.promise;finished=true;return 'durable';});
const writeResult=write.then(v=>({value:v}),error=>({error}));
assert.equal(A.engine.admissions.size,1,'admission must precede first await');
await entered.promise;
assert((await A.engine.handle({action:'status'})).busy);
await assert.rejects(A.engine.handle({action:'reloadProviders'}),/busy/);
await assert.rejects(B.engine.reserveProjectMutation(async()=>[A.cwd]),/busy/i);
const same=await fixture('same',A.cwd);await assert.rejects(same.run(async()=>assert.fail('overlap must not execute')),/busy/i);
let closed=false;const closing=A.engine.close().then(()=>closed=true);
assert.equal(aborted,true,'close must revoke publication synchronously');
await assert.rejects(A.run(async()=>assert.fail('stale publication must not execute')),/closed|cancel|Stop|changed/i);
assert.equal(await B.run(async({check})=>{check();return 'sibling';}),'sibling');
await tick();assert.equal(closed,false);assert.equal(finished,false);assert(A.engine.projectOccupied(A.cwd));
release.resolve();await closing;assert.equal(closed,true);assert.equal(finished,true);assert((await writeResult).error);
assert.equal(A.engine.admissions.size,0);assert.equal(A.engine.familyOperations.size,0);
console.log('PASS synchronous admission, shared project exclusion, owner close drainage and sibling publication');

const S=await fixture('scheduled'),scheduledEntered=deferred(),scheduledRelease=deferred();
S.engine.scheduled={cwd:S.cwd,threadId:S.id,cancelled:false,finished:false};
const scheduledWrite=S.run(async({check})=>{check();scheduledEntered.resolve();await scheduledRelease.promise;return 'scheduled edit';});
await Promise.race([scheduledEntered.promise,scheduledWrite]);
assert.equal(await S.engine.scheduledFamilyIdle(S.engine.scheduled),false,'scheduled completion must await publication');
const scheduledPeer=await fixture('scheduled-peer',S.cwd);
await assert.rejects(scheduledPeer.run(async()=>assert.fail('peer bypassed schedule')),/busy/i);
scheduledRelease.resolve();assert.equal(await scheduledWrite,'scheduled edit');S.engine.scheduled=null;
console.log('PASS exact scheduled owner can publish while peers and premature completion are refused');

const P=await fixture('prior-host-work'),host=new CodingEngine({dataDir:join(root,'host-engine'),projects});
for(const set of [host.admissions,host.commandRequests]){
 const admission={cwd:P.cwd};set.add(admission);
 await assert.rejects(P.run(async()=>assert.fail('publication raced an admitted host command')),/busy/i);set.delete(admission);
}
const hostThread=randomUUID();host.threadInfo.set(hostThread,{cwd:P.cwd});host.runs.set(hostThread,'active');
await assert.rejects(P.run(async()=>assert.fail('publication raced an active host turn')),/busy/i);host.runs.clear();
assert.equal(await P.run(async()=>44),44);
console.log('PASS preexisting peer admissions, commands and active turns block overlapping publication');

const F=await fixture('failure');await assert.rejects(F.run(async()=>{throw Error('durable receipt failed');}),/durable receipt failed/);
assert.equal(F.engine.familyOperations.size,0,'settled failure is not pending work');
assert.equal(F.engine.admissions.size,1,'uncertain effects retain the project fence');
for(let i=0;i<2;i++)await assert.rejects(F.engine.close(),/durable receipt failed/);
assert.notEqual(F.engine.closeSettled,true);assert(F.engine.projectOccupied(F.cwd));
await assert.rejects(B.engine.reserveProjectMutation(async()=>[F.cwd]),/busy|lifecycle/i);
console.log('PASS failed durable receipt remains uncertain across repeated close');

const C=await fixture('cancelled-before-entry'),controller=new AbortController();controller.abort();
await assert.rejects(C.engine.runPublication({threadId:C.id,cwd:C.cwd,signal:controller.signal,operation:async()=>assert.fail('aborted before entry')}),/cancel|Stop|stopped/i);
assert.equal(C.engine.admissions.size,0);
const invalid=new CodingEngine({dataDir:join(root,'no-executor')});
await assert.rejects(invalid.runPublication({threadId:C.id,cwd:C.cwd,signal:new AbortController().signal,operation:async()=>{}}),/executor|publication/i);
console.log('PASS aborted owner and unbound engine refuse publication');

const T=await fixture('targeted'),child=randomUUID(),other=randomUUID();
T.engine.threadInfo.set(child,{id:child,cwd:T.cwd,parentThreadId:T.id,status:{type:'idle'}});
T.engine.threadInfo.set(other,{id:other,cwd:B.cwd,parentThreadId:null,status:{type:'idle'}});
T.engine.verifiedThreads.add(child);T.engine.verifiedThreads.add(other);
T.engine.resolveFamily=async id=>({thread:T.engine.threadInfo.get(id),root:T.engine.threadInfo.get(T.id)});
T.engine.findActiveTurn=async()=>{};T.engine.familyPage=async()=>({data:[],nextCursor:null});T.engine.finishFamilyStop=async()=>{};
const childEntered=deferred(),childRelease=deferred();let childAborted=false;
const childWrite=T.engine.runPublication({threadId:child,cwd:T.cwd,signal:new AbortController().signal,operation:async({signal})=>{signal.addEventListener('abort',()=>childAborted=true,{once:true});childEntered.resolve();await childRelease.promise;}});
const childResult=childWrite.catch(error=>error);await childEntered.promise;
assert.equal((await T.engine.interruptFamily(T.id)).state,'stopping');assert(childAborted);
assert(T.engine.familyStopping(T.id));await assert.rejects(T.run(async()=>{}),/Stop|stopp|cancel/i);
assert.equal(await T.engine.runPublication({threadId:other,cwd:B.cwd,signal:new AbortController().signal,operation:async()=>42}),42);
childRelease.resolve();await childResult;await Promise.all([...T.engine.familyStops.values()]);await tick();assert.equal(T.engine.familyStopping(T.id),false);
console.log('PASS targeted Stop drains descendant publication and leaves unrelated family available');

const G=await fixture('global-stop'),globalEntered=deferred(),globalRelease=deferred();let globalAborted=false;
const globalWrite=G.run(async({signal})=>{signal.addEventListener('abort',()=>globalAborted=true,{once:true});globalEntered.resolve();await globalRelease.promise;});
const globalResult=globalWrite.catch(error=>error);await globalEntered.promise;
G.engine.processLife=null;G.engine.child=null;let stopDone=false;const stop=G.engine.stop().then(()=>stopDone=true);
assert(globalAborted);await tick();assert.equal(stopDone,false);globalRelease.resolve();await globalResult;await stop;
console.log('PASS global Stop drains publication even without a native process');
// Exercise real completion/admission/Stop code with only the native RPC and
// publisher boundaries replaced. No child process, VM, model, or network runs.
const until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Timed out waiting for workspace synchronization');};
async function synchronization(name,operation=async()=>{},shared={}){
 const dataDir=join(root,name);await mkdir(dataDir);const cwd=shared.cwd??dataDir,projects=shared.projects??new CodingProjects(),id=randomUUID(),events=[],calls=[];let engine;
 engine=new CodingEngine({dataDir,projects,executor:binding,publishWorkspace:async request=>{
  assert.deepEqual(request,{threadId:id});calls.push(request);
  return engine.runPublication({threadId:id,cwd,signal:new AbortController().signal,operation});
 }});
 engine.child={};engine.processLife={child:engine.child,exited:false};
 const life=engine.processLife,background=new Map(),turns=new Map();
 const member=(threadId=id,parentThreadId=null)=>{engine.threadInfo.set(threadId,{id:threadId,cwd,parentThreadId,status:{type:'idle'},model:'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp',modelProvider:'saleh_local'});engine.verifiedThreads.add(threadId);};member();
 engine.ensure=async()=>{};engine.disposeProcess=async()=>{};engine.savePartialHistory=()=>{};
 engine.providerMetadata=async()=>null;engine.findBinary=async()=>'/fixture/codex';
 engine.write=()=>{};engine.push=(method,params)=>{events.push({method,params});};
 const rpc=async(method,params)=>{
  if(method==='thread/read')return {thread:{...engine.threadInfo.get(params.threadId)}};
  if(method==='thread/list')return {data:[...engine.threadInfo.values()].filter(t=>t.id!==params.ancestorThreadId&&engine.within(t.id,params.ancestorThreadId)),nextCursor:null};
  if(method==='thread/loaded/list')return {data:[...engine.threadInfo.keys()],nextCursor:null};
  if(method==='thread/backgroundTerminals/list')return {data:(background.get(params.threadId)??[]).map(processId=>({processId})),nextCursor:null};
  if(method==='thread/turns/list')return {data:turns.has(params.threadId)?[turns.get(params.threadId)]:[]};
  if(method==='turn/interrupt')return {};
  if(method==='command/exec/terminate')return {terminated:true};
  throw Error('Unexpected synthetic RPC '+method);
 };
 engine.rpc=rpc;
 const start=(threadId=id,turnId=randomUUID())=>{engine.threadInfo.get(threadId).status={type:'active'};turns.set(threadId,{id:turnId,status:'inProgress'});engine.receive({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress'}}});return turnId;};
 const complete=(threadId,turnId)=>{engine.threadInfo.get(threadId).status={type:'idle'};turns.set(threadId,{id:turnId,status:'completed'});engine.receive({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});};
 const state=async()=>((await engine.handle({action:'status'})).workspaceSync??[]).find(s=>s.rootThreadId===id);
 return {engine,id,cwd,life,projects,member,start,complete,state,calls,events,background,turns,rpc};
}

{
 const f=await synchronization('family-sync'),child=randomUUID();f.member(child,f.id);
 const parentTurn=f.start(),childTurn=f.start(child);f.complete(child,childTurn);
 assert.equal((await f.state())?.state,'waiting','Child completion must synchronously reserve workspace synchronization');
 assert.equal(f.engine.publications().length,0,'Waiting for a parent must not acquire publication admission');
 await assert.rejects(f.engine.handle({action:'send',threadId:f.id,text:'new work'}),/busy|synchron/i);
 const mcp={mcp:true,threadId:f.id,turnId:parentTurn,cwd:f.cwd};
 f.engine.admissions.add(mcp);assert.doesNotThrow(()=>f.engine.checkAdmission(mcp));
 const approval={continuation:true,threadId:f.id,cwd:f.cwd};assert.doesNotThrow(()=>f.engine.checkAdmission(approval));
 await tick();assert.equal(f.calls.length,0);f.engine.admissions.delete(mcp);f.complete(f.id,parentTurn);
 await until(async()=> (await f.state())?.state==='complete');assert.equal(f.calls.length,1);
 f.complete(child,childTurn);f.complete(f.id,parentTurn);await tick();assert.equal(f.calls.length,1,'Duplicate terminal events cannot publish another round');
 const next=f.start();f.complete(f.id,next);await until(()=>f.calls.length===2);await until(async()=> (await f.state())?.state==='complete');
 assert(f.events.some(e=>e.method==='coding/workspaceSync'&&e.params.state==='complete'));
 console.log('PASS child completion coalesces, permits current MCP/approval, fences new input and deduplicates rounds');
}
{
 for(const eventFirst of [false,true]){
  const f=await synchronization('reply-'+eventFirst),turn=f.start(),response={turn:{id:turn,status:'completed'}};let resolved=false;
  f.engine.pending.set(99,{method:'turn/start',params:{threadId:f.id},resolve:()=>{resolved=true;},reject:assert.fail});
  if(eventFirst)f.complete(f.id,turn);else {f.engine.threadInfo.get(f.id).status={type:'idle'};f.turns.set(f.id,response.turn);}
  f.engine.receive({id:99,result:response});assert(resolved);assert.equal((await f.state())?.state,'waiting');
  f.complete(f.id,turn);await until(async()=> (await f.state())?.state==='complete');assert.equal(f.calls.length,1);
 }
 console.log('PASS terminal reply and notification use one synchronous completion hook in either order');
}
{
 const entered=deferred(),release=deferred(),f=await synchronization('terminal-sync',async()=>{entered.resolve();await release.promise;});
 const session=()=>{const value={threadId:f.id,cwd:f.cwd,life:f.life,decoders:new Map(),truncated:new Set(),inputQueue:Promise.resolve()};value.done=new Promise(r=>value.resolveDone=r);return value;};
 const first=session(),second=session(),a=randomUUID(),b=randomUUID();f.engine.terminals.set(a,first);f.engine.terminals.set(b,second);
 await f.engine.finishTerminal(a,{exitCode:0});await first.done;assert.equal((await f.state())?.state,'waiting');assert.equal(f.calls.length,0);
 const admission={continuation:true,threadId:f.id,cwd:f.cwd};await f.engine.terminalAuthority(b,second,f.engine.epoch,admission);
 let physicallyStopped=false;const stopped=f.engine.stopTerminal(b,second).then(()=>physicallyStopped=true);await tick();assert(!physicallyStopped);
 await f.engine.finishTerminal(b,{exitCode:0});await stopped;assert(physicallyStopped);
 await entered.promise;assert.equal((await f.state()).state,'publishing');assert.equal(f.calls.length,1);
 release.resolve();await until(async()=> (await f.state())?.state==='complete');
 console.log('PASS direct terminal completion keeps physical Stop independent and waits for another PTY');
}
{
 const f=await synchronization('held-admission'),held={cwd:f.cwd,threadId:f.id};f.engine.admissions.add(held);
 const turn=f.start();f.complete(f.id,turn);await tick();assert.equal(f.calls.length,0);
 await assert.rejects(f.engine.handle({action:'terminalStart',threadId:f.id,command:'echo no'}),/busy|synchron/i);
 f.engine.admissions.delete(held);f.background.set(f.id,['background']);await tick();assert.equal(f.calls.length,0);
 f.background.clear();await until(async()=> (await f.state())?.state==='complete');
 console.log('PASS prior execution admission and native background work drain before publication');
}
{
 const f=await synchronization('late-child'),gate=deferred(),entered=deferred();let held=true;
 f.engine.rpc=async(method,params)=>{if(method==='thread/backgroundTerminals/list'&&held){held=false;entered.resolve();await gate.promise;}return f.rpc(method,params);};
 const turn=f.start();f.complete(f.id,turn);await entered.promise;
 const child=randomUUID();f.member(child,f.id);const childTurn=f.start(child);gate.resolve();await tick();assert.equal(f.calls.length,0);
 f.complete(child,childTurn);await until(async()=> (await f.state())?.state==='complete');assert.equal(f.calls.length,1);
 console.log('PASS late child invalidates the family idle witness');
}
{
 const f=await synchronization('stop-waiting'),turn=f.start(),child=randomUUID();f.member(child,f.id);const childTurn=f.start(child);f.complete(child,childTurn);
 f.engine.finishFamilyStop=async()=>{};const stop=f.engine.interruptFamily(f.id);await stop;f.complete(f.id,turn);
 await Promise.all([...f.engine.familyStops.values()]);await tick();assert.equal(f.calls.length,0);assert.equal((await f.state()).state,'cancelled');
 assert.notEqual((await f.state()).blocked,true);assert.doesNotThrow(()=>f.engine.checkAdmission({threadId:f.id,cwd:f.cwd}));
 const entered=deferred(),release=deferred(),g=await synchronization('stop-publishing',async()=>{entered.resolve();await release.promise;return {published:true,renewed:false};});
 const finished=g.start();g.complete(g.id,finished);await entered.promise;g.engine.finishFamilyStop=async()=>{};
 await g.engine.interruptFamily(g.id);let drained=false;const drain=Promise.all([...g.engine.familyStops.values()]).then(()=>drained=true).catch(()=>{});
 await tick();assert(!drained,'Selected Stop must retain the original publication callback');release.resolve();await drain;
 await g.engine.drainWorkspaceSync();assert.equal((await g.state()).state,'cancelled');assert.equal(g.engine.publications().length,0);
 console.log('PASS selected Stop cancels waiting synchronization and retains active publication settlement');
}
{
 const entered=deferred(),release=deferred();let originalSignal,settled=false,renewals=0;
 const f=await synchronization('child-stop-publication',async({signal,check})=>{
  originalSignal=signal;entered.resolve();await release.promise;settled=true;
  if(signal.aborted)return {published:true,renewed:false};
  check();renewals++;return {published:true,renewed:true};
 });
 const child=randomUUID();f.member(child,f.id);const turn=f.start();f.complete(f.id,turn);await entered.promise;f.engine.finishFamilyStop=async()=>{};
 await f.engine.interruptFamily(child);assert(originalSignal.aborted,'Selected child Stop must abort the original root publication signal');
 let drained=false;const drain=f.engine.drainWorkspaceSync().then(()=>drained=true);await tick();assert(!settled&&!drained,'Selected child Stop must retain original effect settlement');
 release.resolve();await drain;assert(settled&&drained);assert.equal(renewals,0);assert.equal((await f.state()).state,'cancelled');assert.equal(f.engine.publications().length,0);
 assert.equal((await f.state()).blocked,true,'A consumed cancelled workspace must retain its execution fence');
 assert.equal((await f.state()).message,'Workspace save stopped. Stop the parent chat before continuing.');
 assert(f.events.some(e=>e.method==='coding/workspaceSync'&&e.params.state==='cancelled'&&e.params.blocked===true));
 let requests=0;f.engine.rpc=async(...args)=>{requests++;return f.rpc(...args);};
 await assert.rejects(f.engine.handle({action:'send',threadId:f.id,text:'must stay fenced'}),/busy|synchron/i);assert.equal(requests,0,'New parent input must be rejected before any native request');
 const peer=await synchronization('child-stop-peer',async()=>{},{cwd:f.cwd,projects:f.projects}),admission={publication:true,threadId:peer.id,cwd:f.cwd};
 assert.throws(()=>peer.engine.checkAdmission(admission),/busy/i);assert(f.projects.occupied(f.cwd));
 await Promise.all([...f.engine.familyStops.values()]);await f.engine.stop();assert(f.projects.occupied(f.cwd),'Physical Stop alone cannot restore the consumed workspace');
 await f.engine.close();assert.equal(f.projects.occupied(f.cwd),false,'Clean owner closure releases shared project authority');assert.doesNotThrow(()=>peer.engine.checkAdmission(admission));
 console.log('PASS selected child Stop aborts root publication and drains its settled outcome without renewal');
}
{
 const entered=deferred(),release=deferred(),f=await synchronization('scheduled-sync',async()=>{entered.resolve();await release.promise;});
 const turn=f.start(),s={cwd:f.cwd,threadId:f.id,turnId:turn,epoch:f.engine.epoch,life:f.life,active:new Map([[f.id,turn]]),completed:new Map(),revision:0,dispatched:true,finished:false,cancelled:false,resolve:()=>{},reject:assert.fail};
 f.engine.scheduled=s;f.complete(f.id,turn);const waiting=f.engine.waitScheduled(s);await entered.promise;assert.equal(s.finished,false);
 release.resolve();await waiting;assert.equal(s.finished,true);assert.equal((await f.state()).state,'complete');
 console.log('PASS scheduled result waits for synchronization without invalidating its own scheduled admission');
}
{
 const f=await synchronization('failed-sync',async()=>{throw Error('publication receipt failed');}),turn=f.start();f.complete(f.id,turn);
 await until(async()=> (await f.state())?.state==='failed');assert.match((await f.state()).message,/publication receipt failed/);
 f.complete(f.id,turn);await tick();assert.equal(f.calls.length,1);await assert.rejects(f.engine.handle({action:'send',threadId:f.id,text:'no retry'}),/busy|synchron/i);
 await assert.rejects(f.engine.close(),/publication receipt failed/);assert.equal(f.calls.length,1);
 console.log('PASS failed synchronization remains fenced with original failure and no replay');
}
{
 const f=await synchronization('failed-before-publication');
 f.engine.rpc=async()=>{throw Error('family inventory unverified');};const turn=f.start();f.complete(f.id,turn);
 await until(async()=> (await f.state())?.state==='failed');assert.equal(f.engine.publications().length,0);
 for(const admission of [{publication:true},{mcp:true},{continuation:true}])assert.throws(()=>f.engine.checkAdmission({...admission,threadId:f.id,cwd:f.cwd}),/busy/i);
 console.log('PASS failure before publication retains the project fence for every admission');
}
{
 const entered=deferred(),release=deferred(),f=await synchronization('duplicate-idle',async()=>{entered.resolve();await release.promise;});
 const turn=f.start();f.complete(f.id,turn);await entered.promise;
 f.engine.receive({method:'thread/status/changed',params:{threadId:f.id,status:{type:'idle'}}});f.complete(f.id,turn);
 release.resolve();await until(async()=> (await f.state())?.state==='complete');assert.equal(f.calls.length,1);
 const activeEntered=deferred(),activeRelease=deferred(),g=await synchronization('late-activity',async()=>{activeEntered.resolve();await activeRelease.promise;});
 const oldTurn=g.start();g.complete(g.id,oldTurn);await activeEntered.promise;g.start();activeRelease.resolve();
 await until(async()=> (await g.state())?.state==='failed');assert.match((await g.state()).message,/family changed/i);
 console.log('PASS repeated idle status and completion preserve the witness; new activity invalidates it');
}
{
 const firstEntered=deferred(),firstRelease=deferred(),secondEntered=deferred(),secondRelease=deferred();
 const a=await synchronization('overlap-first',async()=>{firstEntered.resolve();await firstRelease.promise;}),b=await synchronization('overlap-second',async()=>{secondEntered.resolve();await secondRelease.promise;},{cwd:a.cwd,projects:a.projects});
 const ta=a.start(),tb=b.start();a.complete(a.id,ta);b.complete(b.id,tb);await firstEntered.promise;await tick();assert.equal(b.calls.length,0);
 firstRelease.resolve();await secondEntered.promise;assert.equal((await a.state()).state,'complete');assert.equal((await b.state()).state,'publishing');secondRelease.resolve();await until(async()=> (await b.state()).state==='complete');
 assert.equal(a.calls.length,1);assert.equal(b.calls.length,1);
 console.log('PASS overlapping idle families serialize publication without mutual pending-fence deadlock');
}
{
 const entered=deferred(),release=deferred(),f=await synchronization('stop-integrity-failure',async()=>{entered.resolve();await release.promise;throw Error('Publication cancelled by Stop or owner closure.');});
 const turn=f.start();f.complete(f.id,turn);await entered.promise;const records=f.engine.cancelWorkspaceSync();f.engine.cancelPublications();release.resolve();
 await assert.rejects(f.engine.drainWorkspaceSync(records),/Publication cancelled/);assert.equal((await f.state()).state,'failed');assert.equal(f.engine.publications().length,1);
 console.log('PASS operation-thrown cancellation text remains sticky after Stop');
}
{
 const providerEntered=deferred(),providerRelease=deferred(),publicationEntered=deferred(),publicationRelease=deferred();
 const f=await synchronization('status-cursor',async()=>{publicationEntered.resolve();await publicationRelease.promise;});delete f.engine.push;
 f.engine.providerMetadata=async()=>{providerEntered.resolve();await providerRelease.promise;return null;};
 const before=f.engine.sequence,statusWork=f.engine.handle({action:'status'});await providerEntered.promise;
 const turn=f.start();f.complete(f.id,turn);await publicationEntered.promise;providerRelease.resolve();
 const status=await statusWork,event=f.engine.events.filter(e=>e.method==='coding/workspaceSync').at(-1);
 assert.equal(status.workspaceSync.find(row=>row.rootThreadId===f.id).state,'publishing');assert.equal(event.params.state,'publishing');
 assert.equal(status.workspaceSyncCursor,f.engine.sequence,'Status cursor must be captured with the fresh synchronization snapshot');assert(event.sequence>before&&event.sequence<=status.workspaceSyncCursor);
 publicationRelease.resolve();await until(async()=> (await f.state()).state==='complete');
 assert(f.engine.events.filter(e=>e.method==='coding/workspaceSync').at(-1).sequence>status.workspaceSyncCursor,'Later synchronization events must remain replayable');
 console.log('PASS direct status snapshot and cursor include events arriving during provider lookup');
}
console.log('coding publication checks passed; actual native children/VMs/models/network: 0');
