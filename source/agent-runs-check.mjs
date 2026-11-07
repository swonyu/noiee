// Disposable backend-only Agent lifecycle. Root executes; no product startup.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ChatRuns,chatRunDigest} from './chat-runs.mjs';
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-agent-runs-')));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(fn,label){const end=Date.now()+4000;while(!await fn()){if(Date.now()>end)throw Error('Timed out: '+label);await delay(5);}}
async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Timed out: '+label)),4000))]);}finally{clearTimeout(timer);}}
async function fixture(name,reply,fault){
 const directory=join(root,name);await mkdir(directory,{mode:0o700});let generation=randomUUID(),lease;
 const store=new ChatRuns({directory,admissionGeneration:()=>generation,beginInference:kind=>{assert.equal(kind,'agent');const controller=new AbortController();lease={controller,accepted:false,finished:false};return {controller,accept:()=>{controller.signal.throwIfAborted();lease.accepted=true;},finish:result=>{lease.finished=true;lease.result=result;}};},prepare:()=>{throw Error('Text preparation must not be used by Agent.');},fetchImpl:()=>{throw Error('Raw text transport must not be used by Agent.');},upstream:'http://127.0.0.1:1',agentReply:reply,fault});
 const input={runId:randomUUID(),chatId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID(),messages:[{role:'user',content:'Synthetic Agent request'}],model:'explicit-nondefault-model',thinking:'standard',kind:'agent',sources:[]};
 const start=()=>{const prepared=store.prepareAdmission({runId:input.runId,inputDigest:chatRunDigest(input),generation});return store.start(input,{generation,ticket:prepared.ticket});};
 const inspect=()=>store.inspect(input.runId),pending=async()=>{let v;await until(async()=>{v=await inspect();return v.run?.pendingStep?.state==='pending'&&v.persistence==='saved';},'saved pending step');return v.run.pendingStep;};
 return {directory,store,input,start,inspect,pending,lease:()=>lease,rotate:()=>{generation=randomUUID();store.revokeAgentClaims();},generation:()=>generation};
}
const callMessage=(i=0)=>({role:'assistant',content:null,tool_calls:[{id:'call_'+i,type:'function',function:{name:'execute_tool',arguments:JSON.stringify({server:'fixture',name:'echo',arguments:{value:'RESULT_'+i}})}}]});
async function claim(f,p){const seen=await f.store.agentStep({action:'inspect',runId:f.input.runId,stepId:p.stepId});const claimId=randomUUID();const request={action:'claim',runId:seen.runId,stepId:seen.stepId,stepDigest:seen.stepDigest,generation:seen.generation,claimId};const value=await f.store.agentStep(request);return {seen,request,value,claimId};}
const complete=(f,p,c,outcome)=>f.store.agentStep({action:'complete',runId:f.input.runId,stepId:p.stepId,claimId:c.claimId,outcome});
// Existing bounded loop, current-tool pairs and selected model survive every step.
{
 const requests=[];const f=await fixture('budgets',async input=>{requests.push(structuredClone(input));assert.equal(input.model,'explicit-nondefault-model');assert.equal(input.thinking,'standard');
  const n=requests.length;if(input.finalize)return {model:input.model,message:{role:'assistant',content:'FINAL_EVIDENCE_ONLY'}};
  return {model:input.model,message:n<=6?{role:'assistant',content:null,tool_calls:[{id:'plan_'+n,type:'function',function:{name:'update_plan',arguments:JSON.stringify({steps:[{text:'Synthetic plan',status:'in_progress'}]})}}]}:callMessage(n)};
 });
 await f.start();assert(f.lease().accepted);let effects=0;
 for(let n=0;n<32;n++){
  const p=await f.pending(),c=await claim(f,p),binding={runId:f.input.runId,stepId:p.stepId,claimId:c.claimId};
  assert.throws(()=>f.store.agentDispatch(binding,'call',{...p.arguments,name:'wrong'}),/differs/);
  const dispatch=f.store.agentDispatch(binding,'call',p.arguments);dispatch.check();effects++;
  assert.throws(()=>f.store.agentDispatch(binding,'call',p.arguments),/already dispatched/);
  const outcome={kind:'returned',result:{content:[{type:'text',text:'EXACT_RESULT_'+n}],isError:false}};
  const saved=await complete(f,p,c,outcome);assert.equal(saved.persistence,'saved');assert(saved.durableRevision>=saved.completion.revision);assert.equal(saved.run.receipts.at(-1).id,p.stepId);
  const duplicate=await complete(f,p,c,outcome);assert.deepEqual(duplicate.completion,saved.completion);
  await assert.rejects(complete(f,p,c,{kind:'unconfirmed',message:'different'}),/Conflicting/);
 }
 await until(()=>f.lease().finished,'final receipt');const final=await f.inspect();assert.equal(final.run.status,'complete');assert.equal(final.run.budgetReached,true);assert.equal(final.run.content,'FINAL_EVIDENCE_ONLY');assert.equal(final.run.receipts.length,32);assert.equal(effects,32);assert.equal(requests.length,39);assert.equal(requests.at(-1).finalize,true);assert(requests.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('EXACT_RESULT_31')));
 console.log('PASS selected model on all 38 bounded plan/tool steps and tool-free final synthesis; exact claim at-most-once and durable result acknowledgement');
}
// Revocation fences already-reviewed but delayed claims and already-issued effects.
{
 const f=await fixture('revocation',async input=>({model:input.model,message:callMessage()}));await f.start();const p=await f.pending();
 const seen=await f.store.agentStep({action:'inspect',runId:f.input.runId,stepId:p.stepId});f.rotate();
 await assert.rejects(f.store.agentStep({action:'claim',runId:f.input.runId,stepId:p.stepId,stepDigest:p.stepDigest,generation:seen.generation,claimId:randomUUID()}),/expired/);
 const c=await claim(f,p);f.rotate();assert.throws(()=>f.store.agentDispatch({runId:f.input.runId,stepId:p.stepId,claimId:c.claimId},'call',p.arguments),/abort|expired/i);
 const stopped=f.store.stop(f.input.runId);await complete(f,p,c,{kind:'not-started',message:'Revoked before effect.'});await bounded(stopped,'claimed Stop drain');assert.equal((await f.inspect()).run.status,'stopped');assert.equal((await f.inspect()).run.receipts[0].status,'cancelled');
 console.log('PASS stale review and revoked claimed effect refuse; known not-started completion drains selected Stop');
}
// Stop and completion join the exact accepted claim while its intent is saving.
{
 const held=gate(),seen=gate();let holding=true;
 const f=await fixture('claim-save',async input=>({model:input.model,message:callMessage()}),async(stage,row)=>{if(holding&&row.pendingStep?.state==='claimed'){seen.resolve();await held.promise;}});
 await f.start();const p=await f.pending(),review=await f.store.agentStep({action:'inspect',runId:f.input.runId,stepId:p.stepId}),claimId=randomUUID();
 const claimWork=f.store.agentStep({action:'claim',runId:f.input.runId,stepId:p.stepId,stepDigest:p.stepDigest,generation:review.generation,claimId});const refused=assert.rejects(claimWork,/abort/i);await bounded(seen.promise,'held claim intent');
 let stopped=false;const stop=f.store.stop(f.input.runId).then(v=>{stopped=true;return v;});
 const completion=f.store.agentStep({action:'complete',runId:f.input.runId,stepId:p.stepId,claimId,outcome:{kind:'not-started',message:'Native did not execute without an acknowledged claim.'}});
 await delay(10);assert.equal(stopped,false);holding=false;held.resolve();await refused;await bounded(completion,'completion joins persisted claim');await bounded(stop,'Stop joins completion');assert.equal((await f.inspect()).run.status,'stopped');
 const disk=JSON.parse(await readFile(join(f.directory,f.input.runId+'.json'),'utf8'));assert.equal(disk.receipts[0].status,'cancelled');assert.equal(disk.pendingStep,null);
 console.log('PASS Stop during claim save: zero effects, serialized completion and final durable receipt before Stop settles');
}
// A new backend can inspect pending evidence but cannot replay model or native work.
{
 let calls=0;const f=await fixture('cold',async input=>{calls++;return {model:input.model,message:callMessage()};});await f.start();await f.pending();
 const cold=new ChatRuns({directory:f.directory,admissionGeneration:()=>randomUUID(),beginInference:()=>{throw Error('Cold inspection must not reserve inference.');},prepare:()=>{throw Error('Cold inspection must not prepare.');},fetchImpl:()=>{throw Error('Cold inspection must not dispatch.');},upstream:'http://127.0.0.1:1',agentReply:()=>{throw Error('Cold inspection must not replay.');}});
 const saved=await cold.inspect(f.input.runId);assert.equal(saved.run.status,'unconfirmed');assert.equal(saved.live,false);assert.equal(saved.run.pendingStep.state,'pending');assert.equal((await cold.start(f.input,null)).run.status,'unconfirmed');assert.equal(calls,1);await bounded(f.store.stop(f.input.runId),'pending Stop');
 console.log('PASS cold pending Agent evidence is inspectable and never replays model or native work');
}
// A failed native result commit cannot be acknowledged or release a successful Stop.
{
 let fail=false;const f=await fixture('completion-save-failure',async input=>({model:input.model,message:callMessage()}),async(stage,row)=>{if(fail&&row.pendingStep===null)throw Error('Synthetic result save failure.');});
 await f.start();const p=await f.pending(),c=await claim(f,p);fail=true;
 await assert.rejects(complete(f,p,c,{kind:'returned',result:{message:'Known result'}}),/saving is unconfirmed/);await until(()=>f.lease().finished,'failed completion finalizer');
 const saved=await f.inspect();assert.equal(saved.persistence,'failed');assert.equal(f.lease().result.stopped,false);const disk=JSON.parse(await readFile(join(f.directory,f.input.runId+'.json'),'utf8'));assert.equal(disk.pendingStep.state,'claimed');assert.equal(disk.receipts[0].status,'pending');
 console.log('PASS native result save failure withholds acknowledgement and retains the durable claimed intent');
}
console.log(JSON.stringify({passed:true,fixtureRoot:root,productionAppStarted:false,nativeExecutionExercised:false}));
