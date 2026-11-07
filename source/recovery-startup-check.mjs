import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from './server.mjs';
import {nativeSignature} from './agent.mjs';
import {LocalModelCatalog} from './local-models.mjs';
import {chatRunDigest} from './chat-runs.mjs';

const token=randomUUID(),calls=[];
const fixture=await realpath(await mkdtemp(join(tmpdir(),'saleh-recovery-startup-'))),model='fixture/recovery-model';let inferenceRequests=0;
const transport=async(url,init)=>{
 if(new URL(url).pathname==='/api/v1/models')return Response.json({models:[{type:'llm',key:'fixture',loaded_instances:[{id:model,config:{context_length:65536}}],capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:['off','on']}}}]});
 assert.equal(new URL(url).pathname,'/v1/chat/completions');assert.equal(JSON.parse(init.body).model,model);inferenceRequests++;
 return new Response('data: {"choices":[{"delta":{"content":"RECOVERY_TEXT_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
const localModels=new LocalModelCatalog({upstream:'http://127.0.0.1:2345',fetchImpl:transport});
const record=name=>async input=>{calls.push([name,input?.action]);return {received:input?.action??name};};
const stop=async()=>({stopped:true}),close=async()=>({stopped:true});
const coding={dataDir:join(fixture,'Coding'),handle:record('coding'),handleQueue:record('queue'),handleDisk:record('disk'),handleMCP:record('mcp'),stop,close};
const worktrees={handle:record('worktrees'),assertProject:async()=>{},stop,close};
const gitWorkflow={handle:record('git'),stop,close};
let starts=0;
const schedules={handle:record('schedules'),start:()=>{starts++;},stop,close};
const hub={describe:record('describe'),tools:record('tools'),connect:record('connect'),call:record('call'),disconnect:record('disconnect'),stop,close};
const options={instanceToken:token,coding,worktrees,gitWorkflow,schedules,hub,localModels,chatRunOptions:{directory:join(fixture,'runs')},fullAccess:true,unconfinedBoot:false,recoveryStartup:true};
let server;
assert.doesNotThrow(()=>{server=createServer(options);},'Full Access must support an explicit recovery-only startup before unrestricted execution.');
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
const post=async(name,input,signed=true)=>{
 const route='/api/tools/'+name,body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now());
 const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(signed?{'X-Qwen-Nonce':nonce,'X-Qwen-Time':time,'X-Qwen-Permit':nativeSignature(token,route,nonce,time,body)}:{})},body});
 return {status:response.status,value:await response.json()};
};
try{
 const access=await (await fetch(base+'/api/access')).json();
 assert.equal(access.mode,'full');assert.equal(access.recoveryStartup,true);assert.equal(access.managedChangesBlocked,false);
 const heldList=await post('worktrees',{action:'list'});assert.equal(heldList.status,200);
 for(const capability of ['openAvailable','createAvailable','handoffAvailable'])assert.equal(heldList.value[capability],false,'Recovery startup must hold '+capability);
 assert.equal(starts,0,'Recovery startup must not start saved schedules, including an injected scheduler.');
 const runPost=async input=>{const response=await fetch(base+'/api/chat/runs',{method:'POST',headers:{'Content-Type':'application/json','X-Qwen-Chat':'1'},body:JSON.stringify(input)});return {status:response.status,value:await response.json()};};
 const initial=await runPost({action:'list'});assert.equal(initial.status,200,JSON.stringify(initial.value));const generation=initial.value.generation;
 const input={runId:randomUUID(),chatId:'recovery-startup-fixture',userMessageId:randomUUID(),assistantMessageId:randomUUID(),messages:[{role:'user',content:'Synthetic only'}],model,thinking:'standard',kind:'agent',sources:[]};
 let authorization=await runPost({action:'prepare',runId:input.runId,generation,inputDigest:chatRunDigest(input)});assert.equal(authorization.status,200);
 const rejectedAgent=await runPost({action:'start',...input,ticket:authorization.value.ticket,generation});
 assert.notEqual(rejectedAgent.status,200,'Agent must be refused before a durable run can occupy the exclusive slot.');assert.match(rejectedAgent.value.error,/recovery startup/i);
 assert.equal(inferenceRequests,0);assert.equal((await runPost({action:'list'})).value.runs.length,0,'Rejected Agent admission must not save a run.');
 const text={...input,runId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID()};delete text.kind;delete text.sources;
 authorization=await runPost({action:'prepare',runId:text.runId,generation,inputDigest:chatRunDigest(text)});assert.equal(authorization.status,200);
 assert.equal((await runPost({action:'start',...text,ticket:authorization.value.ticket,generation})).status,200,'Text Chat must still start after rejected Agent admission.');
 let saved;
 for(let n=0;n<200;n++){saved=await runPost({action:'read',runId:text.runId});if(saved.value.live===false)break;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(saved.value.live,false);assert.equal(saved.value.run.content,'RECOVERY_TEXT_OK');assert.equal(saved.value.run.status,'complete');assert.equal(saved.value.run.finishReason,'stop');assert.equal(saved.value.persistence,'saved');assert.equal(inferenceRequests,1);
 const plainText=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','X-Qwen-Chat':'1'},body:JSON.stringify({model,messages:input.messages,thinking:'standard'})});assert.equal(plainText.status,200,'Ordinary text Chat must remain available during recovery startup.');assert.match(await plainText.text(),/RECOVERY_TEXT_OK/);assert.equal(inferenceRequests,2);
 const plainAgent=await fetch(base+'/api/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Qwen-Chat':'1'},body:JSON.stringify({model,messages:input.messages,thinking:'standard'})});assert.notEqual(plainAgent.status,200);assert.match((await plainAgent.json()).error,/recovery startup/i);assert.equal(inferenceRequests,2);
 assert.deepEqual((await readdir(join(fixture,'runs'))).sort(),[text.runId+'.json'],'Only the completed text fixture may be saved.');
 const denied=[['command',{command:'touch /not-allowed',cwd:'/tmp'}],['connect',{id:'x'}],['call',{server:'x',name:'x',arguments:{}}],['search',{}],['catalog',{}],['describe',{}],['agentStep',{action:'claim'}],
  ...['start','send','steer','fork','terminalStart','terminalInput','terminalResize','approval','answer','bindProvider','reloadProviders'].map(action=>['coding',{action}]),
  ...['prepare','commit','inspect'].map(action=>['codingQueue',{action}]),
  ...['prepareStart','commitStart','inspect'].map(action=>['codingMCP',{action}]),
  ['codingStorage',{action:'prepare'}],['codingProvisioning',{action:'decide'}],['codingProvider',{action:'save'}],
  ...['prepare','execute','inspect'].map(action=>['git',{action}]),
  ...['prepare','create','prepareHandoff','handoff','resolve','unknown'].map(action=>['worktrees',{action}]),
  ...['list','commit','prepareRecovery','commitRecovery','pause'].map(action=>['schedules',{action}])];
 for(const [route,input] of denied){const before=calls.length,r=await post(route,input);assert.equal(r.status,409,route+':'+input.action);assert.match(r.value.error,/recovery startup/i);assert.equal(calls.length,before,'Blocked routes must not touch any handler.');}
 assert.equal((await post('worktrees',{action:'prepareHandoffRecovery'},false)).status,403,'Recovery still requires a body-bound native permit.');
 for(const action of ['list','stop','prepareReconnect','commitReconnect','prepareHandoffRecovery','recoverHandoff','prepareRecoveryCopy','createRecoveryCopy','prepareArchive','archive','prepareRestore','restore']){
  const r=await post('worktrees',{action});assert.equal(r.status,200);assert.equal(r.value.received,action);
 }
 for(const action of ['status','list','events','read','historyPage','readImage','family','mcpOutcomes','terminalResults','providerBindingInfo','approvalInfo','terminalSnapshot','interrupt','interruptFamily','terminalStop'])assert.equal((await post('coding',{action})).status,200,action);
 assert.equal((await post('coding',{action:'approval',decision:'decline'})).status,200);
 assert.equal((await post('stop',{})).status,200);
 for(const changes of [{recoveryStartup:'true'},{recoveryStartup:true,fullAccess:false},{recoveryStartup:true,unconfinedBoot:true},{recoveryStartup:false}])assert.throws(()=>createServer({...options,...changes}),/Invalid native tool access mode/);
 console.log('PASS: Full Access recovery startup admits reviewed lifecycle and explicit recovery, holds execution capabilities, remains signed, schedule-free and fail-closed before operational handlers.');
}finally{await server.shutdownTools();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(fixture,{recursive:true,force:true});}
