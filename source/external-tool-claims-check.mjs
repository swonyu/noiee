import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ChatRuns,chatRunDigest} from './chat-runs.mjs';
const directory=await realpath(await mkdtemp(join(tmpdir(),'external-claims-'))),revision='a'.repeat(64);
const cases=[
 ['external_tool_artifact',{action:'install',url:'https://raw.githubusercontent.com/a/b/'+'b'.repeat(40)+'/x.mjs',sha256:revision,purpose:'fixture'},'externalArtifact'],
 ['external_tool_artifact',{action:'inspect'},'externalArtifact'],
 ['external_tool_artifact',{action:'connect',revision},'externalToolRuntime',{action:'prepare',revision}],
 ['external_tool_artifact',{action:'disconnect',revision},'externalToolRuntime'],
 ['external_tool_artifact',{action:'status'},'externalToolRuntime'],
 ['connect_tool_server',{server:'external-js-'+revision},'externalToolRuntime',{action:'prepare',revision}],
];
try{
 for(const [index,[name,args,operation,effect=args]]of cases.entries()){
  const root=join(directory,String(index));await mkdir(root,{mode:0o700});const generation=randomUUID();let turns=0,finished=false;
  const store=new ChatRuns({directory:root,admissionGeneration:()=>generation,beginInference:()=>({controller:new AbortController(),accept(){},finish(){finished=true;}}),prepare(){throw Error('No text inference');},fetchImpl(){throw Error('No network');},upstream:'http://127.0.0.1:1',agentReply:async input=>({model:input.model,message:turns++?{role:'assistant',content:'Fixture complete'}:{role:'assistant',content:null,tool_calls:[{id:'external_call',type:'function',function:{name,arguments:JSON.stringify(args)}}]}})});
  const input={runId:randomUUID(),chatId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID(),messages:[{role:'user',content:'Synthetic external claim'}],model:'fixture',thinking:'standard',kind:'agent',sources:[]};
  const admission=store.prepareAdmission({runId:input.runId,inputDigest:chatRunDigest(input),generation});await store.start(input,{generation,ticket:admission.ticket});let pending;
  for(let n=0;n<800;n++){pending=(await store.inspect(input.runId)).run?.pendingStep;if(pending?.state==='pending')break;await delay(5);}assert.equal(pending.state,'pending');
  const seen=await store.agentStep({action:'inspect',runId:input.runId,stepId:pending.stepId}),claimId=randomUUID();await store.agentStep({action:'claim',runId:input.runId,stepId:seen.stepId,stepDigest:seen.stepDigest,generation:seen.generation,claimId});
  const binding={runId:input.runId,stepId:seen.stepId,claimId};
  assert.throws(()=>store.agentDispatch(binding,'externalToolRuntime',{action:'commit',prepareId:randomUUID(),nonce:'b'.repeat(64),fingerprint:'c'.repeat(64)}),/differs/,'model cannot authorize native commit');
  assert.throws(()=>store.agentDispatch(binding,operation,{...effect,approved:true}),/differs/);
  const grant=store.agentDispatch(binding,operation,effect);grant.check();assert.throws(()=>store.agentDispatch(binding,operation,effect),/already dispatched/);
  await store.agentStep({action:'complete',...binding,outcome:{kind:'returned',result:{fixture:true}}});
  for(let n=0;n<800&&!finished;n++)await delay(5);assert(finished);
 }
 console.log('PASS: six real durable Agent claim families reject forged/mutated/replayed effects and model-made launch commits. No model/network/provider execution.');
}finally{await rm(directory,{recursive:true,force:true});}
