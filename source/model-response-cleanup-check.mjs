import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {LocalModelCatalog} from './local-models.mjs';
import {toolRoutes} from './agent.mjs';
import {ChatRuns,chatRunDigest} from './chat-runs.mjs';
function fixture({status=503,headers={},wire,cleanup='pending'}={}){
 let release,cancels=0;const pending=new Promise(r=>release=r);
 const body=new ReadableStream({start(c){if(wire)c.enqueue(wire);},cancel(){cancels++;return cleanup==='reject'?Promise.reject(Error('cleanup failure')):pending;}});
 return {response:new Response(body,{status,headers}),release,cancels:()=>cancels};
}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('blocked by response cleanup')),500))]);}finally{clearTimeout(timer);}}
for(const [name,options,status] of [
 ['HTTP503',{status:503},'server-error'],['authentication',{status:401},'authentication'],
 ['redirect',{status:302},'invalid'],['advertised oversize',{status:200,headers:{'content-length':String(1024*1024+1)}},'invalid'],
 ['stream oversize',{status:200,wire:new Uint8Array(1024*1024+1)},'invalid'],
 ['cleanup rejection',{status:503,cleanup:'reject'},'server-error']
])test('inventory '+name+' retains error without awaiting cleanup',async()=>{
 const f=fixture(options),catalog=new LocalModelCatalog({fetchImpl:async()=>f.response});
 try{const result=await bounded(catalog.catalog());assert.equal(result.online,false);assert.equal(result.status,status);assert.equal(f.cancels(),1);assert.equal(f.response.body.locked,false);}finally{f.release();}
});
test('inventory abort after headers retains exact abort reason',async()=>{
 const f=fixture({status:200}),controller=new AbortController(),reason=Error('Explicit Stop');
 const catalog=new LocalModelCatalog({fetchImpl:async()=>{controller.abort(reason);return f.response;}});
 try{await assert.rejects(bounded(catalog.catalog({signal:controller.signal})),e=>e===reason);assert.equal(f.cancels(),1);}finally{f.release();}
});
for(const status of [503,302])test('Agent HTTP'+status+' rejection never returns model output or waits on cleanup',async()=>{
 const f=fixture({status}),controller=new AbortController();
 const handler=toolRoutes({instanceToken:'fixture',upstream:'http://127.0.0.1:1234',fetchImpl:async()=>f.response,localModels:{async resolve(id){return {id,contextLength:262144,generation:{max_tokens:-1}};}}});
 try{await assert.rejects(bounded(handler.agentReply({model:'fixture-model',thinking:'standard',messages:[{role:'user',content:'Do not run tools.'}]},controller.signal)),status===302?/redirect/:/HTTP 503/);assert.equal(f.cancels(),1);}finally{f.release();}
});
test('Chat HTTP error reaches saved terminal receipt while cleanup stays pending',async()=>{
 const f=fixture(),directory=await realpath(await mkdtemp(join(tmpdir(),'noiee-cleanup-check-'))),generation=randomUUID();let finished=false;
 const store=new ChatRuns({directory,admissionGeneration:()=>generation,beginInference:()=>({controller:new AbortController(),accept(){},finish(){finished=true;}}),prepare:async input=>({model:input.model}),fetchImpl:async()=>f.response,upstream:'http://127.0.0.1:1234'});
 const input={runId:randomUUID(),chatId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID(),messages:[{role:'user',content:'Synthetic cleanup check'}],model:'fixture-model',thinking:'standard'};
 const ticket=store.prepareAdmission({runId:input.runId,inputDigest:chatRunDigest(input),generation});
 try{
  await store.start(input,{generation,ticket:ticket.ticket});
  await bounded((async()=>{while(!finished)await delay(5);})());
  const result=await store.inspect(input.runId);assert.equal(result.run.status,'error');assert.match(result.run.error,/HTTP 503/);assert.equal(result.run.content,'');assert.equal(result.persistence,'saved');assert.equal(f.cancels(),1);
 }finally{f.release();}
});
test('Agent abort after response headers preserves Stop rather than cleanup failure',async()=>{
 const f=fixture({status:200}),controller=new AbortController(),reason=Error('Explicit Agent Stop');
 const handler=toolRoutes({instanceToken:'fixture',upstream:'http://127.0.0.1:1234',fetchImpl:async()=>{controller.abort(reason);return f.response;},localModels:{async resolve(id){return {id,contextLength:262144,generation:{max_tokens:-1}};}}});
 try{await assert.rejects(bounded(handler.agentReply({model:'fixture-model',thinking:'standard',messages:[{role:'user',content:'No tools.'}]},controller.signal)),e=>e===reason);assert.equal(f.cancels(),1);}finally{f.release();}
});
test('synchronous cancellation errors do not replace inventory HTTP classification',async()=>{
 const catalog=new LocalModelCatalog({fetchImpl:async()=>({ok:false,status:503,body:{cancel(){throw Error('sync cleanup failure');}}})});
 const result=await bounded(catalog.catalog());assert.equal(result.status,'server-error');assert.equal(result.error.code,'LOCAL_MODEL_HTTP_ERROR');
});
