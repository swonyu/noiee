// Actual HTTP dispatch + private temporary receipts. No sockets, real model or app.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp,mkdir,readFile,writeFile,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from './server.mjs';
import {nativeSignature} from './agent.mjs';
import {chatRunDigest} from './chat-runs.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(predicate,label){const end=Date.now()+2500;while(!predicate()){if(Date.now()>=end)throw Error('Timed out: '+label);await delay(5);}}
class Reply extends EventEmitter{
 headers={};parts=[];statusCode=200;headersSent=false;destroyed=false;writableEnded=false;
 setHeader(k,v){this.headers[k.toLowerCase()]=v;}
 writeHead(code,headers={}){this.statusCode=code;for(const [k,v] of Object.entries(headers))this.setHeader(k,v);this.headersSent=true;}
 flushHeaders(){this.headersSent=true;}
 write(value){this.parts.push(Buffer.from(value));return true;}
 end(value){if(value!==undefined)this.write(value);this.writableEnded=true;}
 destroy(){this.destroyed=true;this.emit('close');}
 get text(){return Buffer.concat(this.parts).toString();}
 get json(){return JSON.parse(this.text);}
}
const text=(content,finish=null)=>'data: '+JSON.stringify({choices:[{delta:{content},finish_reason:finish}]})+'\n\n';
async function fixture({resolveGate,intentGate,fetchGate,finalGate,failFinal=false,responseType='text/event-stream',contextLength=65536}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-chat-runs-'))),dataDir=join(root,'Coding'),directory=join(root,'chat-runs');await mkdir(dataDir,{mode:0o700});
 const token=randomUUID(),signals=[],streams=[],requests=[];let resolving=0,finalizing=0,admitting=0,bodyCancelled=0;
 const localModels={upstream:'http://127.0.0.1:1234',async catalog(){return {online:true,models:[]};},async resolve(id){resolving++;if(resolveGate)await resolveGate.promise;return {id,contextLength,generation:{max_tokens:2048}};}};
 const fetchImpl=async(url,options)=>{assert.equal(url,'http://127.0.0.1:1234/v1/chat/completions');requests.push(JSON.parse(options.body));signals.push(options.signal);if(fetchGate)await fetchGate.promise;return new Response(new ReadableStream({start(controller){streams.push(controller);if(!fetchGate)options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});if(!fetchGate&&options.signal.aborted)controller.error(options.signal.reason);},cancel(){bodyCancelled++;}}),{headers:{'content-type':responseType}});};
 const inert={async stop(){return {stopped:true};},async close(){return {stopped:true};}};
 const options={instanceToken:token,model:'fixture',localModels,fetchImpl,coding:{...inert,dataDir},hub:{...inert},worktrees:{...inert},gitWorkflow:{...inert},chatRunOptions:{directory,fault:async(stage,row)=>{if(stage==='before-commit'&&row.status==='intent'){admitting++;if(intentGate)await intentGate.promise;}if(stage==='before-commit'&&!['intent','running'].includes(row.status)){finalizing++;if(finalGate)await finalGate.promise;if(failFinal)throw Error('Injected final save failure');}}}};
 const server=createServer(options);
 async function request(input,{route='/api/chat/runs',method='POST',signed=false}={}){
  if(input?.action==='start'&&!Object.hasOwn(input,'ticket')){const ready=await request({action:'list'});if(ready.statusCode!==200)return ready;const generation=ready.json.generation,prepared=await request({action:'prepare',runId:input.runId,inputDigest:chatRunDigest(input),generation});if(prepared.statusCode!==200)return prepared;input={...input,ticket:prepared.json.ticket,generation};}
  const body=input===undefined?'':JSON.stringify(input),nonce=randomUUID(),time=String(Date.now());
  const req=Readable.from(body?[Buffer.from(body)]:[]);Object.assign(req,{url:route,method,headers:{host:'127.0.0.1:8787','content-type':'application/json','x-qwen-chat':'1',...(signed?{'x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)}:{})},socket:{localPort:8787}});
  const res=new Reply();await server.listeners('request')[0](req,res);return res;
 }
 const input=()=>({action:'start',runId:randomUUID(),chatId:randomUUID(),userMessageId:randomUUID(),assistantMessageId:randomUUID(),messages:[{role:'user',content:'Synthetic detached text run'}],model:'fixture',thinking:'standard'});
 return {root,directory,server,options,request,input,requests,signals,streams,get bodyCancelled(){return bodyCancelled;},get admitting(){return admitting;},get resolving(){return resolving;},get finalizing(){return finalizing;},async close(){fetchGate?.resolve();intentGate?.resolve();resolveGate?.resolve();finalGate?.resolve();await server.shutdownTools();}};
}
const passed=[];
async function test(name,body){await body();passed.push(name);console.log('PASS '+name);}
for(const responseType of ['text/event-stream','application/json'])for(const scenario of [
 {name:'Deep reasoning only',thinking:'deep',content:null,reasoning:'Still solving 🧪',finish:'length',status:'length'},
 {name:'Deep absent answer',thinking:'deep',content:undefined,reasoning:' \nStill solving 🧪',finish:'length',status:'length'},
 {name:'Agent reasoning alone stays incomplete',thinking:'deep',content:null,reasoning:'Reasoning',finish:'length',status:'error',agent:true},
 {name:'Deep whitespace answer',thinking:'deep',content:'\n\n',reasoning:'Still solving 🧪',finish:'length',status:'length'},
 {name:'Partial answer',thinking:'deep',content:'Partial answer',reasoning:'Reasoning',finish:'length',status:'length'},
 {name:'Empty stop is not complete',thinking:'deep',content:null,reasoning:'Reasoning',finish:'stop',status:'error'},
 {name:'Empty reasoning is not a result',thinking:'deep',content:null,reasoning:'  \n',finish:'length',status:'error'},
 {name:'Standard reasoning alone is not admitted',thinking:'standard',content:null,reasoning:'Reasoning',finish:'length',status:'error'},
 {name:'Truncated tool request is not admitted',thinking:'deep',content:null,reasoning:'Reasoning',finish:'length',status:'error',tool_calls:[{id:'call_no_dispatch',type:'function',function:{name:'run_command',arguments:'{}'}}]}
])await test('Deep length classification '+responseType+' '+scenario.name,async()=>{
 const f=await fixture({responseType});try{
  const input={...f.input(),thinking:scenario.thinking,...(scenario.agent?{kind:'agent',sources:[]}:{} )};assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===1,'reasoning-limit upstream');
  const message={role:'assistant',content:scenario.content,reasoning_content:scenario.reasoning,...(scenario.tool_calls?{tool_calls:scenario.tool_calls}:{} )};
  const packet=responseType==='application/json'?JSON.stringify({choices:[{message,finish_reason:scenario.finish}]}):'data: '+JSON.stringify({choices:[{delta:{...message,...(scenario.tool_calls?{tool_calls:scenario.tool_calls.map((call,index)=>({...call,index}))}:{})},finish_reason:scenario.finish}]})+'\n\n';
  f.streams[0].enqueue(new TextEncoder().encode(packet));f.streams[0].close();let observed;
  for(let i=0;i<500;i++){observed=(await f.request({action:'read',runId:input.runId})).json;if(!observed.live)break;await delay(5);}
  assert.equal(observed.live,false);assert.equal(observed.run.status,scenario.status,'Provider length with Deep reasoning must retain its limit outcome without claiming an answer');assert.equal(observed.persistence,'saved');assert.equal(observed.run.content,scenario.content??'');assert.equal(observed.run.reasoning,scenario.agent?'\nStep 1\n'+scenario.reasoning:scenario.reasoning);if(scenario.agent){assert.deepEqual(observed.run.receipts,[]);assert.equal(observed.run.pendingStep,null);}assert.equal(f.requests.length,1);
  if(scenario.status==='length'){assert.equal(observed.run.finishReason,'length');assert.equal(observed.run.error,null);}else assert(observed.run.error);
  const file=join(f.directory,input.runId+'.json'),bytes=await readFile(file);await f.close();const cold=createServer(f.options);
  try{const value=await requestOn(cold,{action:'read',runId:input.runId});assert.deepEqual(value.run,observed.run);assert.equal(value.persistence,'saved');assert.deepEqual(await readFile(file),bytes);assert.equal(f.requests.length,1,'Cold observation must not replay inference');}finally{await cold.shutdownTools();}
 }finally{await f.close();}
});

for(const excerpt of ['Source detail '.repeat(140),'معلومة موثقة '.repeat(140)])await test('Agent research continuation budgets existing source annotations once: '+(excerpt.startsWith('S')?'ASCII':'Arabic'),async()=>{
 const f=await fixture({contextLength:32768});try{
  const sources=globalThis.qwenWork.normalizeSources(Array.from({length:8},(_,i)=>({url:'https://example.invalid/source-'+i,title:'Synthetic source '+i,excerpt,receipt:'source_receipt_'+i,provider:'fixture/browser_snapshot',observedAt:'2026-10-21T00:00:00.000Z',truncated:false}))),saved=structuredClone(sources);
  const history=[{role:'user',content:'Original short question.'},{role:'assistant',content:'Original answer.'},{role:'user',content:'Old exchange '+ 'x'.repeat(4000)},{role:'assistant',content:'Completed old exchange.'+'r'.repeat(4000)},{role:'user',content:'Use the saved sources to answer this short follow-up.'}];
  const messages=globalThis.qwenWork.boundContext(history,sources,'agent',null,32768),input={...f.input(),kind:'agent',sources,messages},before=structuredClone(messages);
  assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===1,'research continuation dispatch');
  const sent=f.requests[0],annotations=sent.messages.filter(m=>m.role==='assistant'&&typeof m.content==='string'&&m.content.startsWith('Historical observed sources'));
  assert.equal(annotations.length,1,'One bounded source annotation per request');assert.match(annotations[0].content,/older source excerpts omitted/);assert(Buffer.byteLength(JSON.stringify(sent))+sent.max_tokens+1024<=32768);
  f.streams[0].enqueue(new TextEncoder().encode(text('RESEARCH_FINAL','stop')));f.streams[0].close();let final;for(let i=0;i<500;i++){final=(await f.request({action:'read',runId:input.runId})).json;if(!final.live)break;await delay(5);}assert.equal(final.run.status,'complete');assert.equal(final.persistence,'saved');assert.deepEqual(final.run.sources,saved);assert.deepEqual(sources,saved);assert.deepEqual(messages,before);assert.equal(f.requests.length,1);
 }finally{await f.close();}
});
await test('Agent protects oversized current tool pair and ends with receipt-backed tool-free final on32k context',async()=>{
 const f=await fixture({contextLength:32768});try{
  const input={...f.input(),kind:'agent',sources:[]};assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===1,'first Agent model step');
  const call={index:0,id:'large_current_pair',type:'function',function:{name:'execute_tool',arguments:JSON.stringify({server:'fixture',name:'echo',arguments:{}})}};
  f.streams[0].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{tool_calls:[call]},finish_reason:'tool_calls'}]})+'\n\n'));f.streams[0].close();
  let pending;for(let i=0;i<500;i++){pending=(await f.request({action:'read',runId:input.runId})).json.run.pendingStep;if(pending?.state==='pending')break;await delay(5);}assert(pending);
  const inspected=(await f.request({action:'inspect',runId:input.runId,stepId:pending.stepId},{route:'/api/tools/agentStep',signed:true})).json,claimId=randomUUID();
  assert.equal((await f.request({action:'claim',runId:input.runId,stepId:pending.stepId,stepDigest:pending.stepDigest,generation:inspected.generation,claimId},{route:'/api/tools/agentStep',signed:true})).statusCode,200);
  const result={content:[{type:'text',text:'ع'.repeat(15000)}],isError:false};
  assert.equal((await f.request({action:'complete',runId:input.runId,stepId:pending.stepId,claimId,outcome:{kind:'returned',result}},{route:'/api/tools/agentStep',signed:true})).statusCode,200);
  await until(()=>f.streams.length===2,'receipt-backed final');assert.equal(f.requests[1].tool_choice,'none');assert(!Object.hasOwn(f.requests[1],'tools'));assert(f.requests[1].messages.some(m=>typeof m.content==='string'&&m.content.includes('Actual receipts from this run')));
  f.streams[1].enqueue(new TextEncoder().encode(text('FINAL_WITH_CONTEXT_LIMIT','stop')));f.streams[1].close();
  let saved;for(let i=0;i<500;i++){saved=(await f.request({action:'read',runId:input.runId})).json;if(!saved.live)break;await delay(5);}assert.equal(saved.run.status,'complete');assert.equal(saved.run.budgetReached,true);assert.equal(saved.persistence,'saved');assert.equal(saved.run.receipts.length,1);assert.match(saved.run.receipts[0].output,/ع/);assert.equal(f.requests.length,2);
 }finally{await f.close();}
});
for(const responseType of ['text/event-stream','application/json'])await test('malformed '+responseType+' reply cannot poison later independent runs',async()=>{
 const f=await fixture({responseType});try{
  const bad=f.input();assert.equal((await f.request(bad)).statusCode,200);await until(()=>f.streams.length===1,'malformed stream');
  const encode=new TextEncoder(),json=content=>JSON.stringify({choices:[{message:{role:'assistant',content},finish_reason:'stop'}]});
  f.streams[0].enqueue(encode.encode(responseType==='application/json'?json('\ud800'):text('kept partial ')+text('\ud800','stop')));f.streams[0].close();
  let failed;for(let i=0;i<500;i++){failed=(await f.request({action:'read',runId:bad.runId})).json;if(!failed.live)break;await delay(5);}
  assert.equal(failed.run.status,'error');assert.equal(failed.persistence,'saved');assert.match(failed.run.error,/encoding|formed|invalid/i);
  assert.equal(failed.run.content,responseType==='application/json'?'':'kept partial ');
  const good=f.input();assert.equal((await f.request(good)).statusCode,200,'Next run must admit on the same backend');await until(()=>f.streams.length===2,'valid subsequent stream');
  f.streams[1].enqueue(encode.encode(responseType==='application/json'?json('NEXT_SAVED'):text('NEXT_SAVED','stop')));f.streams[1].close();
  let saved;for(let i=0;i<500;i++){saved=(await f.request({action:'read',runId:good.runId})).json;if(!saved.live)break;await delay(5);}
  assert.equal(saved.run.status,'complete');assert.equal(saved.persistence,'saved');assert.equal(saved.run.content,'NEXT_SAVED');assert.equal(f.requests.length,2);
 }finally{await f.close();}
});
await test('two independent Chats overlap; same-chat, third and Agent admissions refuse without dispatch',async()=>{
 const f=await fixture();try{
  const first=f.input(),second=f.input();assert.equal((await f.request(first)).statusCode,200);await until(()=>f.streams.length===1,'first concurrent stream');
  assert.equal((await f.request(second)).statusCode,200,'A second text-only chat must start while the first stream stays open');await until(()=>f.streams.length===2,'second concurrent stream');
  assert.equal((await f.request(first)).statusCode,200);assert.equal(f.requests.length,2,'Same ID does not dispatch twice');
  assert.equal((await f.request({...f.input(),chatId:first.chatId})).statusCode,400);assert.equal((await f.request(f.input())).statusCode,400);
  assert.equal((await f.request({...f.input(),kind:'agent',sources:[]})).statusCode,400);assert.equal(f.requests.length,2);
  assert.equal((await f.request({}, {route:'/api/tools/depart',signed:true})).json.stopped,true);assert(f.signals.every(signal=>!signal.aborted),'Departure preserves both accepted runs');
  assert.equal((await f.request({action:'stop',runId:first.runId})).json.run.status,'stopped');assert.equal(f.signals[0].aborted,true);assert.equal(f.signals[1].aborted,false,'Selected Stop must leave the other Chat running');
  assert.equal((await f.request({...f.input(),chatId:second.chatId})).statusCode,400,'One live run per chat even with capacity free');
  assert.equal((await f.request({...f.input(),kind:'agent',sources:[]})).statusCode,400,'Agent remains exclusive with only one Chat live');
  f.streams[1].enqueue(new TextEncoder().encode(text('SECOND_SAVED','stop')));f.streams[1].close();
  let final;for(let i=0;i<500;i++){final=(await f.request({action:'read',runId:second.runId})).json;if(!final.live)break;await delay(5);}assert.equal(final.run.status,'complete');assert.equal(final.run.content,'SECOND_SAVED');assert.equal(final.persistence,'saved');
  await f.close();const next=createServer(f.options);assert.equal((await requestOn(next,{action:'read',runId:first.runId})).run.status,'stopped');assert.equal((await requestOn(next,{action:'read',runId:second.runId})).run.content,'SECOND_SAVED');await next.shutdownTools();assert.equal(f.requests.length,2,'Cold reads never replay');
 }finally{await f.close();}
});
for(const imagesFirst of [true,false])await test('image-bearing Chat is exclusive with images '+(imagesFirst?'first':'second'),async()=>{
 const f=await fixture();try{
  const image={...f.input(),messages:[{role:'user',content:[{type:'text',text:'Synthetic image context'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'}}]}]},plain=f.input(),first=imagesFirst?image:plain,second=imagesFirst?plain:image;
  assert.equal((await f.request(first)).statusCode,200);await until(()=>f.streams.length===1,'exclusive image control stream');assert.equal((await f.request(second)).statusCode,400,'Only text-only inference messages may overlap');assert.equal(f.requests.length,1);
 }finally{await f.close();}
});
await test('detach, idempotent reattach and cold saved final dispatch exactly once',async()=>{
 const f=await fixture();try{
  const input=f.input(),start=await f.request(input);assert.equal(start.statusCode,200,'Backend text-run admission route is required');assert.equal(start.json.run.runId,input.runId);
  await until(()=>f.streams.length===1,'upstream start');f.streams[0].enqueue(new TextEncoder().encode(text('kept partial ')));
  const attached=await f.request(undefined,{route:'/api/chat/runs/'+input.runId+'/events',method:'GET'});assert.equal(attached.statusCode,200);attached.destroy();
  const duplicate=await f.request(input);assert.equal(duplicate.statusCode,200);assert.equal(f.requests.length,1);
  assert.equal((await f.request({...input,messages:[{role:'user',content:'changed'}]})).statusCode,400);
  for(const key of ['chatId','userMessageId','assistantMessageId'])assert.equal((await f.request({...input,[key]:randomUUID()})).statusCode,400,'Changed '+key+' under one run ID rejects');
  assert.equal(f.signals[0].aborted,false,'Subscriber departure must not abort backend text');
  f.streams[0].enqueue(new TextEncoder().encode(text('finished','stop')));f.streams[0].close();
  let final;for(let i=0;i<500;i++){final=(await f.request({action:'read',runId:input.runId})).json;if(final.run.status==='complete')break;await delay(5);}
  assert.equal(final.run.status,'complete');assert.equal(final.run.content,'kept partial finished');assert.equal(final.durableRevision,final.run.revision);assert.equal(final.live,false);assert.equal(f.requests.length,1);
  await f.close();const next=createServer(f.options),saved=await requestOn(next,{action:'read',runId:input.runId});assert.equal(saved.run.status,'complete');assert.equal(saved.run.content,final.run.content);assert.equal(f.requests.length,1);await next.shutdownTools();
 }finally{await f.close();}
});
async function requestOn(server,input){if(input?.action==='start'&&!Object.hasOwn(input,'ticket')){const {generation}=await requestOn(server,{action:'list'}),prepared=await requestOn(server,{action:'prepare',runId:input.runId,inputDigest:chatRunDigest(input),generation});input={...input,ticket:prepared.ticket,generation};}const req=Readable.from([Buffer.from(JSON.stringify(input))]);Object.assign(req,{url:'/api/chat/runs',method:'POST',headers:{host:'127.0.0.1:8787','content-type':'application/json','x-qwen-chat':'1'},socket:{localPort:8787}});const res=new Reply();await server.listeners('request')[0](req,res);assert.equal(res.statusCode,200);return res.json;}
for(const operation of ['selected','all','shutdown'])await test(operation+' Stop during resolution cannot dispatch',async()=>{
 const pending=gate(),f=await fixture({resolveGate:pending});try{
  const input=f.input();assert.equal((await f.request(input)).statusCode,200);await until(()=>f.resolving===1,'resolution');
  let settled=false;const stopping=(operation==='selected'?f.request({action:'stop',runId:input.runId}):operation==='all'?f.request({}, {route:'/api/tools/stop',signed:true}):f.server.shutdownTools()).then(v=>{settled=true;return v;});
  await delay(25);assert.equal(settled,false);pending.resolve();await stopping;assert.equal(f.requests.length,0);
  const saved=(await f.request({action:'read',runId:input.runId})).json;assert.equal(saved.run.status,'stopped');assert.equal(saved.run.stopRequested,true);assert.equal(saved.live,false);
 }finally{await f.close();}
});
await test('navigation revokes tools but preserves accepted text; explicit Stop drains final save',async()=>{
 const pending=gate(),f=await fixture({finalGate:pending});try{
  const input=f.input();assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===1,'upstream');
  const departure=await f.request({}, {route:'/api/tools/depart',signed:true});assert.equal(departure.statusCode,200);assert.equal(departure.json.stopped,true);assert.equal(f.signals[0].aborted,false);
  let settled=false;const stopping=f.request({action:'stop',runId:input.runId}).then(v=>{settled=true;return v;});await until(()=>f.finalizing>0,'final save');await delay(25);assert.equal(settled,false,'Stop must join the final receipt');pending.resolve();const result=await stopping;assert.equal(result.json.run.status,'stopped');assert.equal(result.json.persistence,'saved');
 }finally{await f.close();}
});
await test('final-save rejection is separate from physical cancellation and makes shutdown unconfirmed',async()=>{
 const f=await fixture({failFinal:true});try{
  const input=f.input();assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===1,'upstream');const stopped=await f.request({action:'stop',runId:input.runId});assert.equal(stopped.json.live,false);assert.equal(stopped.json.persistence,'failed');assert.match(stopped.json.saveError,/sav|persist/i);assert.equal(f.signals[0].aborted,true);assert.equal((await f.server.shutdownTools()).stopped,false);
 }finally{await f.close();}
});
await test('cold unfinished receipt is unconfirmed and cannot replay; corruption is preserved',async()=>{
 const f=await fixture();try{
  const input=f.input();assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===1,'upstream');
  f.streams[0].enqueue(new TextEncoder().encode(text('durable partial 🧪')));let observed;for(let i=0;i<500;i++){observed=(await f.request({action:'read',runId:input.runId})).json;if(observed.run.content==='durable partial 🧪')break;await delay(5);}assert.equal(observed.run.content,'durable partial 🧪');
  const paths=(await readdir(f.directory)).filter(name=>name===input.runId+'.json');assert.equal(paths.length,1);const file=join(f.directory,paths[0]),partial=await readFile(file);
  await f.close();await writeFile(file,partial,{mode:0o600});const next=createServer(f.options);const saved=await requestOn(next,{action:'read',runId:input.runId});assert.equal(saved.run.status,'unconfirmed');assert.equal(saved.run.content,'durable partial 🧪');assert.equal(saved.live,false);assert.equal(f.requests.length,1);await requestOn(next,input);assert.equal(f.requests.length,1,'Same ID never restarts a cold intent');await next.shutdownTools();
  await writeFile(file,'broken',{mode:0o600});const broken=createServer(f.options);await assert.rejects(requestOn(broken,{action:'read',runId:input.runId}));assert.equal(await readFile(file,'utf8'),'broken');assert.equal(f.requests.length,1);await broken.shutdownTools();
 }finally{await f.close();}
});

for(const operation of ['selected','all','shutdown','departure'])await test(operation+' during durable admission cannot dispatch',async()=>{
 const pending=gate(),f=await fixture({intentGate:pending});try{
  const input=f.input(),starting=f.request(input);await until(()=>f.admitting===1,'intent before commit');let settled=false;
  const stopping=(operation==='selected'?f.request({action:'stop',runId:input.runId}):operation==='shutdown'?f.server.shutdownTools():f.request({}, {route:operation==='departure'?'/api/tools/depart':'/api/tools/stop',signed:true})).then(v=>{settled=true;return v;});
  await delay(25);assert.equal(settled,false);pending.resolve();await starting;await stopping;assert.equal(f.requests.length,0);const saved=(await f.request({action:'read',runId:input.runId})).json;assert.equal(saved.run.status,'stopped');assert.equal(saved.persistence,'saved');
 }finally{await f.close();}
});
for(const operation of ['all','shutdown'])await test(operation+' joins final receipt save',async()=>{
 const pending=gate(),f=await fixture({finalGate:pending});try{
  const input=f.input();await f.request(input);await until(()=>f.streams.length===1,'upstream');let settled=false;
  const stopping=(operation==='all'?f.request({}, {route:'/api/tools/stop',signed:true}):f.server.shutdownTools()).then(v=>{settled=true;return v;});await until(()=>f.finalizing===1,'held final save');await delay(25);assert.equal(settled,false);assert.equal(f.signals[0].aborted,true);pending.resolve();await stopping;assert.equal((await f.request({action:'read',runId:input.runId})).json.persistence,'saved');
 }finally{await f.close();}
});
await test('late fetch response is cancelled before parsing after Stop',async()=>{
 const pending=gate(),f=await fixture({fetchGate:pending});try{const input=f.input();await f.request(input);await until(()=>f.requests.length===1,'fetch awaiting response');let settled=false;const stopping=f.request({action:'stop',runId:input.runId}).then(value=>{settled=true;return value;});await delay(25);assert.equal(settled,false);pending.resolve();const result=await stopping;assert.equal(result.json.run.status,'stopped');assert.equal(result.json.run.content,'');assert.equal(f.bodyCancelled,1);assert.equal(result.json.persistence,'saved');}finally{await f.close();}
});
await test('read, subscribe and Stop of an unknown ID do not admit or write',async()=>{
 const f=await fixture();try{const runId=randomUUID();assert.equal((await f.request({action:'read',runId})).json.run,null);assert.equal((await f.request({action:'stop',runId})).json.run,null);assert.equal((await f.request(undefined,{route:'/api/chat/runs/'+runId+'/events',method:'GET'})).statusCode,400);assert.equal(f.requests.length,0);await assert.rejects(readdir(f.directory),{code:'ENOENT'});}finally{await f.close();}
});
for(const count of [128,260])await test('receipt history beyond 128 retains direct reads and accepts a new run: '+count,async()=>{
 const f=await fixture();let next;try{
  const input=f.input();await f.request(input);await until(()=>f.streams.length===1,'seed upstream');const final=(await f.request({action:'stop',runId:input.runId})).json.run;await f.close();
  for(let i=1;i<count;i++){const row={...final,runId:randomUUID(),updatedAt:final.updatedAt+100000+i};await writeFile(join(f.directory,row.runId+'.json'),JSON.stringify(row),{mode:0o600,flag:'wx'});}
  const before=new Map(await Promise.all((await readdir(f.directory)).map(async name=>[name,await readFile(join(f.directory,name))])));next=createServer(f.options);
  const inventory=await requestOn(next,{action:'list'});assert.equal(inventory.runs.length,128);
  assert.deepEqual((await requestOn(next,{action:'read',runId:input.runId})).run,final,'Oldest receipt remains directly readable even when omitted from recent inventory');
  const fresh=f.input(),started=await requestOn(next,fresh);assert.equal(started.run.runId,fresh.runId);assert.equal(inventory.truncated,count>128);await until(()=>f.streams.length===2,'new upstream after full legacy count');
  const live=await requestOn(next,{action:'list'});assert.equal(live.runs.length,128);assert(live.runs.some(value=>value.run.runId===fresh.runId&&value.live),'Active run must remain discoverable even when older than recent records');
  await requestOn(next,{action:'stop',runId:fresh.runId});assert.equal((await requestOn(next,{action:'read',runId:fresh.runId})).persistence,'saved');
  assert.equal((await readdir(f.directory)).length,count+1);for(const [name,bytes] of before)assert.deepEqual(await readFile(join(f.directory,name)),bytes,name+' preserved');assert.equal(f.requests.length,2);
 }finally{await next?.shutdownTools();await f.close();}
});
await test('escaped Unicode fits serialized receipt bound; total-byte capacity fails without pruning',async()=>{
 const f=await fixture();try{
  const input=f.input();await f.request(input);await until(()=>f.streams.length===1,'upstream');const final=(await f.request({action:'stop',runId:input.runId})).json.run;await f.close();
  // Ten valid 12 MiB escaped records exhaust reservation capacity, below the 128 MiB store ceiling.
  const content='\0'.repeat(2*1024*1024-4)+'🧪';assert.equal(Buffer.byteLength(content),2*1024*1024);
  for(let i=0;i<10;i++){const row={...final,runId:i?randomUUID():input.runId,content};const encoded=JSON.stringify(row);assert(Buffer.byteLength(encoded)<16*1024*1024);await writeFile(join(f.directory,row.runId+'.json'),encoded,{mode:0o600});}
  const names=(await readdir(f.directory)).sort(),next=createServer(f.options);const saved=await requestOn(next,{action:'read',runId:input.runId});assert.equal(saved.run.content,content);await assert.rejects(requestOn(next,f.input()));assert.deepEqual((await readdir(f.directory)).sort(),names);assert.equal(f.requests.length,1);await next.shutdownTools();
 }finally{await f.close();}
});
for(const operation of ['all','departure'])await test(operation+' invalidates stale preparation and delayed start without store creation',async()=>{
 const f=await fixture();try{
  const input=f.input(),generation=(await f.request({action:'list'})).json.generation,prepare={action:'prepare',runId:input.runId,inputDigest:chatRunDigest(input),generation};
  const ticket=(await f.request(prepare)).json.ticket;assert.equal(typeof ticket,'string');await assert.rejects(readdir(f.directory),{code:'ENOENT'});
  const stopped=await f.request({}, {route:operation==='all'?'/api/tools/stop':'/api/tools/depart',signed:true});assert.equal(stopped.json.stopped,true);
  assert.equal((await f.request(prepare)).statusCode,400);assert.equal((await f.request({...input,ticket,generation})).statusCode,400);assert.equal(f.requests.length,0);assert.equal(f.resolving,0);await assert.rejects(readdir(f.directory),{code:'ENOENT'});
 }finally{await f.close();}
});
await test('unused-ticket replacement and selected Stop invalidate old starts without tombstone files',async()=>{
 const f=await fixture();try{
  const first=f.input(),second=f.input(),third=f.input(),generation=(await f.request({action:'list'})).json.generation;
  const prepare=input=>f.request({action:'prepare',runId:input.runId,inputDigest:chatRunDigest(input),generation});
  const ticketA=(await prepare(first)).json.ticket;assert.equal((await prepare({...first,messages:[{role:'user',content:'different'}]})).statusCode,400);
  const ticketB=(await prepare(second)).json.ticket;assert.notEqual(ticketA,ticketB);await prepare(third);assert.equal((await f.request({...first,ticket:ticketA,generation})).statusCode,400,'Third unused preparation evicts the oldest only');
  assert.equal((await f.request({action:'stop',runId:second.runId})).json.run,null);assert.equal((await f.request({...second,ticket:ticketB,generation})).statusCode,400);assert.equal(f.requests.length,0);assert.equal(f.resolving,0);await assert.rejects(readdir(f.directory),{code:'ENOENT'});
  // A new explicit preparation remains usable after an unused/lost or cancelled ticket.
  const prepared=(await prepare(first)).json;assert.notEqual(prepared.ticket,ticketA);const result=await f.request({...first,ticket:prepared.ticket,generation});assert.equal(result.statusCode,200);await until(()=>f.requests.length===1,'fresh explicit admission');await f.request({action:'stop',runId:first.runId});
 }finally{await f.close();}
});
await test('two preparation tickets and concurrent starts are independent and deduplicate each ID',async()=>{
 const f=await fixture();try{
  const inputs=[f.input(),f.input()],generation=(await f.request({action:'list'})).json.generation;
  const tickets=await Promise.all(inputs.map(input=>f.request({action:'prepare',runId:input.runId,inputDigest:chatRunDigest(input),generation})));assert(tickets.every(reply=>reply.statusCode===200));
  const payloads=inputs.map((input,i)=>({...input,ticket:tickets[i].json.ticket,generation}));const starts=await Promise.all(payloads.flatMap(payload=>[f.request(payload),f.request(payload)]));assert(starts.every(reply=>reply.statusCode===200));await until(()=>f.requests.length===2,'two unique concurrent dispatches');
  assert.equal((await f.request({action:'list'})).json.runs.filter(value=>value.live).length,2);assert.equal(f.requests.length,2);
 }finally{await f.close();}
});
for(const operation of ['all','shutdown'])await test(operation+' Stop joins both final receipt saves',async()=>{
 const pending=gate(),f=await fixture({finalGate:pending});try{
  const inputs=[f.input(),f.input()];for(const input of inputs)assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===2,'two active streams');let settled=false;
  const stopping=(operation==='all'?f.request({}, {route:'/api/tools/stop',signed:true}):f.server.shutdownTools()).then(value=>{settled=true;return value;});await until(()=>f.finalizing===1,'first held final save');assert(f.signals.every(signal=>signal.aborted));await delay(25);assert.equal(settled,false,'Stop joins final saves for both runs');pending.resolve();await stopping;
  for(const input of inputs){const value=(await f.request({action:'read',runId:input.runId})).json;assert.equal(value.persistence,'saved');assert.equal(value.run.status,'stopped');assert.equal(value.live,false);}assert.equal(f.finalizing,2);
 }finally{await f.close();}
});
await test('Agent stays exclusive and two failed Chat finals remain independently inspectable',async()=>{
 const f=await fixture();try{
  const input={...f.input(),kind:'agent',sources:[]};assert.equal((await f.request(input)).statusCode,200);await until(()=>f.streams.length===1,'exclusive Agent upstream');assert.equal((await f.request(f.input())).statusCode,400);assert.equal((await f.request({...f.input(),kind:'agent',sources:[]})).statusCode,400);assert.equal(f.requests.length,1);
 }finally{await f.close();}
 const broken=await fixture({failFinal:true});try{
  const inputs=[broken.input(),broken.input()];for(const input of inputs)assert.equal((await broken.request(input)).statusCode,200);await until(()=>broken.streams.length===2,'two failing finals');await Promise.all(inputs.map(input=>broken.request({action:'stop',runId:input.runId})));
  for(const input of inputs){const value=(await broken.request({action:'read',runId:input.runId})).json;assert.equal(value.run.runId,input.runId);assert.equal(value.persistence,'failed');assert.equal(value.live,false);}assert.equal((await broken.server.shutdownTools()).stopped,false);
 }finally{await broken.close();}
});
await test('concurrent identical starts consume once; consumed ticket only reads the existing result',async()=>{
 const f=await fixture();try{
  const input=f.input(),generation=(await f.request({action:'list'})).json.generation,prepared=(await f.request({action:'prepare',runId:input.runId,inputDigest:chatRunDigest(input),generation})).json;
  const payload={...input,ticket:prepared.ticket,generation},results=await Promise.all([f.request(payload),f.request(payload)]);for(const result of results)assert.equal(result.statusCode,200);await until(()=>f.requests.length===1,'one concurrent dispatch');
  assert.equal((await f.request({...payload,messages:[{role:'user',content:'changed'}]})).statusCode,400);await f.request({action:'stop',runId:input.runId});await f.request({}, {route:'/api/tools/depart',signed:true});
  const recovered=await f.request(payload);assert.equal(recovered.statusCode,200);assert.equal(recovered.json.live,false);assert.equal(recovered.json.run.status,'stopped');assert.equal(f.requests.length,1);
 }finally{await f.close();}
});
console.log(JSON.stringify({passed:true,cases:passed,realModelCalls:0,installedAppTouched:false}));
