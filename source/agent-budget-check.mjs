// Disposable synthetic Agent budget checks; never starts the app or a real model.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,webcrypto} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createContext,runInContext} from 'node:vm';
import {ChatRuns,chatRunDigest} from './chat-runs.mjs';
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-agent-budget-')));
async function until(fn,label){const end=Date.now()+5000;while(!await fn()){if(Date.now()>end)throw Error('Timed out: '+label);await delay(5);}}
async function fixture(name,reply){
 const directory=join(root,name);await mkdir(directory,{mode:0o700});let lease;
 const generation=randomUUID(),store=new ChatRuns({directory,admissionGeneration:()=>generation,beginInference:()=>{const controller=new AbortController();lease={controller,finished:false};return {controller,accept:()=>controller.signal.throwIfAborted(),finish:result=>{lease.finished=true;lease.result=result;}};},prepare:()=>{throw Error('No text preparation.');},fetchImpl:()=>{throw Error('No network.');},upstream:'http://127.0.0.1:1',agentReply:reply});
 const input={runId:randomUUID(),chatId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID(),messages:[{role:'user',content:'Synthetic Agent request'}],model:'explicit-nondefault-model',thinking:'standard',kind:'agent',sources:[]};
 const start=()=>{const prepared=store.prepareAdmission({runId:input.runId,inputDigest:chatRunDigest(input),generation});return store.start(input,{generation,ticket:prepared.ticket});};
 return {directory,store,input,start,lease:()=>lease,inspect:()=>store.inspect(input.runId)};
}
const callMessage=(i=0,name='execute_tool',args={server:'fixture',name:'echo',arguments:{value:'RESULT_'+i}})=>({role:'assistant',content:null,tool_calls:[{id:'call_'+i,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
async function claim(f,p){const seen=await f.store.agentStep({action:'inspect',runId:f.input.runId,stepId:p.stepId}),claimId=randomUUID();await f.store.agentStep({action:'claim',runId:seen.runId,stepId:seen.stepId,stepDigest:seen.stepDigest,generation:seen.generation,claimId});return claimId;}
const complete=(f,p,claimId,outcome)=>f.store.agentStep({action:'complete',runId:f.input.runId,stepId:p.stepId,claimId,outcome});
async function drive(f,result){
 while(!f.lease().finished){
  let value;await until(async()=>{value=await f.inspect();return f.lease().finished||value.run?.pendingStep?.state==='pending'&&value.persistence==='saved';},'next saved synthetic step');
  if(f.lease().finished)break;const p=value.run.pendingStep,claimId=await claim(f,p),outcome=await result(p,claimId);
  if(outcome){const saved=await complete(f,p,claimId,outcome);assert.equal(saved.persistence,'saved');assert(saved.durableRevision>=saved.completion.revision);}
 }
 return f.inspect();
}
const cold=f=>new ChatRuns({directory:f.directory,admissionGeneration:()=>randomUUID(),beginInference:()=>{throw Error('Cold inspection cannot reserve inference.');},prepare:()=>{throw Error('Cold inspection cannot prepare.');},fetchImpl:()=>{throw Error('Cold inspection cannot send network requests.');},upstream:'http://127.0.0.1:1',agentReply:()=>{throw Error('Cold inspection cannot replay.');}});

// Regression: the old runner stops at twelve actual effects.
{
 let effects=0,requests=0;
 const f=await fixture('thirteenth-request',async input=>{requests++;return {model:input.model,message:input.finalize||effects>=13?{role:'assistant',content:'FINISHED_'+effects}:callMessage(effects)};});
 await f.start();const final=await drive(f,async(p,claimId)=>{f.store.agentDispatch({runId:f.input.runId,stepId:p.stepId,claimId},'call',p.arguments).check();effects++;return {kind:'returned',result:{message:'SYNTHETIC_RESULT_'+effects,isError:false}};});
 console.log(JSON.stringify({requestedActions:13,observedEffects:effects,modelRequests:requests,status:final.run.status,budgetReached:final.run.budgetReached,receipts:final.run.receipts.length}));
 assert.equal(effects,13,'Requested action 13 must execute before the final review');assert.equal(final.run.status,'complete');assert.equal(final.run.budgetReached,false);
}
assert.deepEqual(globalThis.qwenWork.agentLimits,{actions:32,plans:6,receipts:64});assert(Object.isFrozen(globalThis.qwenWork.agentLimits));

// Each requested computer input produces a separate fresh-observation receipt.
let computerFinal;
{
 let inputs=0,observations=0,requests=0;
 const f=await fixture('computer-receipts',async input=>{requests++;return {model:input.model,message:input.finalize?{role:'assistant',content:'COMPUTER_FINAL_REVIEW'}:callMessage(inputs,'computer_key',{snapshotId:'synthetic_'+inputs,key:'tab'})};});
 await f.start();computerFinal=await drive(f,async p=>{if(p.name==='computer_observe'){observations++;return {kind:'returned',result:{snapshotId:'synthetic_'+observations,message:'FRESH_OBSERVATION_'+observations}};}assert.equal(p.name,'computer_key');inputs++;return {kind:'returned',result:{message:'SYNTHETIC_INPUT_'+inputs}};});
 assert.equal(inputs,32);assert.equal(observations,32);assert.equal(requests,33);assert.equal(computerFinal.run.receipts.length,64);assert.equal(computerFinal.run.status,'complete');assert.equal(computerFinal.run.budgetReached,true);assert.equal(computerFinal.run.content,'COMPUTER_FINAL_REVIEW');
 const disk=JSON.parse(await readFile(join(f.directory,f.input.runId+'.json'),'utf8'));assert.deepEqual(disk,computerFinal.run);const reloaded=await cold(f).inspect(f.input.runId);assert.deepEqual(reloaded.run,disk);assert.equal(reloaded.persistence,'saved');assert.equal(reloaded.live,false);
 const invalidDirectory=join(root,'sixty-fifth-receipt');await mkdir(invalidDirectory,{mode:0o700});const invalid={...disk,receipts:[...disk.receipts,{...disk.receipts[0],id:randomUUID()}]};
 const {writeFile}=await import('node:fs/promises');await writeFile(join(invalidDirectory,invalid.runId+'.json'),JSON.stringify(invalid),{mode:0o600});await assert.rejects(cold({directory:invalidDirectory}).inspect(invalid.runId),/Invalid Agent evidence/);
 console.log('PASS action 32, 64 computer receipts, saved-record reload and receipt 65 rejection');
}

// Both pages load the shared policy before the run client; a fresh client keeps all 64.
{
 const [work,client,app,index,coding]=await Promise.all(['work.js','chat-runs.js','app.js','index.html','coding.html'].map(name=>readFile(new URL(name,import.meta.url),'utf8')));
 for(const html of [index,coding]){const scripts=[...html.matchAll(/<script src="\/([^"]+)" defer><\/script>/g)].map(m=>m[1]);assert(scripts.indexOf('work.js')>=0&&scripts.indexOf('work.js')<scripts.indexOf('chat-runs.js'));assert(scripts.indexOf('attachments.js')<scripts.indexOf(html===index?'app.js':'coding.js'));}
 function clientReload(){const context=createContext({TextEncoder,crypto:webcrypto,setTimeout:()=>0,clearTimeout:()=>{},window:{addEventListener:()=>{},dispatchEvent:()=>{}},document:{getElementById:()=>null},LEGACY_LOCAL_MODEL:'explicit-nondefault-model'});runInContext(work,context);runInContext(client,context);return context;}
 const history={id:computerFinal.run.chatId,title:'64 saved receipts',draft:'Retained draft',messages:[{id:computerFinal.run.assistantMessageId,role:'assistant',content:computerFinal.run.content,receipts:computerFinal.run.receipts,plan:computerFinal.run.plan,sources:computerFinal.run.sources}]};
 for(let reload=0;reload<2;reload++){const context=clientReload();assert.equal(context.window.SalehChatRuns.validate(JSON.parse(JSON.stringify(computerFinal))).run.receipts.length,64);assert.throws(()=>context.window.SalehChatRuns.validate({...computerFinal,run:{...computerFinal.run,receipts:[...computerFinal.run.receipts,{...computerFinal.run.receipts[0],id:randomUUID()}]}}),/Invalid saved Agent observation/);context.history=JSON.parse(JSON.stringify([history]));runInContext(app.slice(app.indexOf('function normalizeChats('),app.indexOf('async function hydratedSnapshot(')),context);const saved=runInContext('normalizeChats(history)',context);assert.deepEqual(JSON.parse(JSON.stringify(saved[0].messages[0].receipts)),computerFinal.run.receipts);assert.equal(saved[0].draft,'Retained draft');}
 console.log('PASS Chat/Coding policy order and fresh client/history reload retain all receipt fields');
}

// Stop after a late claimed effect waits for its known or unknown completion.
{
 let effects=0,stopFinished=false,stopping;
 const f=await fixture('late-stop',async input=>({model:input.model,message:callMessage(effects)}));await f.start();
 const final=await drive(f,async(p,claimId)=>{const binding={runId:f.input.runId,stepId:p.stepId,claimId};f.store.agentDispatch(binding,'call',p.arguments).check();effects++;if(effects===31){stopping=f.store.stop(f.input.runId).then(value=>{stopFinished=true;return value;});await delay(10);assert.equal(stopFinished,false);assert.throws(()=>f.store.agentDispatch(binding,'call',p.arguments),/already dispatched|abort/i);return {kind:'unconfirmed',message:'Synthetic late effect outcome is unknown; inspect before any retry.'};}return {kind:'returned',result:{message:'LATE_RESULT_'+effects}};});
 await stopping;assert.equal(effects,31);assert.equal(final.run.status,'unconfirmed');assert.equal(final.run.receipts.at(-1).status,'unconfirmed');assert.equal(final.run.pendingStep,null);assert.equal(f.lease().result.stopped,false);const reopened=cold(f);assert.equal((await reopened.start(f.input,null)).run.status,'unconfirmed');assert.equal(effects,31);
 console.log('PASS late Stop drains the exact claim and unknown effect never replays');
}

// The existing context ceiling can end a run before the action allowance.
{
 let effects=0,finalReviews=0;
 const f=await fixture('context-stop',async input=>{if(input.finalize){finalReviews++;assert(input.messages.some(m=>typeof m.content==='string'&&m.content.startsWith('Context limit reached.')));return {model:input.model,message:{role:'assistant',content:'CONTEXT_FINAL_REVIEW'}};}return {model:input.model,message:callMessage(effects)};});await f.start();
 const final=await drive(f,async(p,claimId)=>{f.store.agentDispatch({runId:f.input.runId,stepId:p.stepId,claimId},'call',p.arguments).check();effects++;return {kind:'returned',result:{message:'LARGE_RESULT_'+effects,output:'x'.repeat(30000)}};});
 assert(effects>0&&effects<32);assert.equal(finalReviews,1);assert.equal(final.run.budgetReached,true);assert.equal(final.run.status,'complete');assert.equal(final.run.content,'CONTEXT_FINAL_REVIEW');assert.equal(final.run.receipts.length,effects);
 console.log('PASS context termination preserves receipts and requests one tool-free final review');
}

// Even a synthetic final response containing a tool request cannot dispatch it.
{
 let effects=0,reviews=0;
 const f=await fixture('final-review-refuses-tools',async input=>{if(input.finalize)reviews++;return {model:input.model,message:callMessage(effects)};});await f.start();
 const final=await drive(f,async(p,claimId)=>{f.store.agentDispatch({runId:f.input.runId,stepId:p.stepId,claimId},'call',p.arguments).check();effects++;return {kind:'returned',result:{message:'FINAL_BOUNDARY_'+effects}};});
 assert.equal(effects,32);assert.equal(reviews,1);assert.equal(final.run.receipts.length,32);assert.equal(final.run.pendingStep,null);assert.equal(final.run.status,'error');
 console.log('PASS final-review tool request performs zero additional effects');
}
console.log(JSON.stringify({passed:true,fixtureRoot:root,productionAppStarted:false,realModelCalls:0,nativeExecutionExercised:false}));
