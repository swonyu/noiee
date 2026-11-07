// In-memory HTTP and inventory fixtures only: no sockets, model processes or real project data.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createServer, MODEL } from './server.mjs';
import {nativeSignature} from './agent.mjs';
import {randomUUID} from 'node:crypto';

const DEFAULT = 'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');
function imageURL(padding=0){
  const data=Buffer.concat([Buffer.from('tEXtfixture\0'),Buffer.alloc(padding,120)]),chunk=Buffer.alloc(data.length+8);chunk.writeUInt32BE(data.length-4);data.copy(chunk,4);
  let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1;}chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return 'data:image/png;base64,'+Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]).toString('base64');
}

const plain = { id:'local/plain',key:'plain-key',label:'Plain local',loaded:true,available:true,state:'loaded',contextLength:65536,capabilities:{chat:true,agent:false,coding:false,standard:true,deep:false,vision:false},reasons:{} };
const capable = { id:'local/reasoner',key:'reasoner-key',label:'Reasoning local',loaded:true,available:true,state:'loaded',contextLength:65536,capabilities:{chat:true,agent:true,coding:true,standard:true,deep:true,vision:true},reasons:{} };
const legacy = {...capable,id:DEFAULT,key:DEFAULT};
let catalogState = { online:true,models:[plain,capable,legacy] };
const resolved=[],inference=[],token=randomUUID();let proposalCalls,proposalFinish='stop',proposalContent='{"action":"done","target":"","text":"Synthetic observation"}';
const catalog={
  upstream:'http://127.0.0.1:1234',
  async catalog(){return structuredClone(catalogState);},
  async resolve(id,{mode,effort,vision=false}){
    resolved.push({id,mode,effort,vision});
    const row=catalogState.models.find(row=>row.id===id);
    if(!catalogState.online||!row?.loaded)throw new Error('Selected local model is not loaded.');
    if(!row.capabilities[mode]||effort==='high'&&!row.capabilities.deep||effort==='none'&&!row.capabilities.standard||vision&&!row.capabilities.vision)throw new Error('Selected local model is incompatible.');
    return {...structuredClone(row),generation:{max_tokens:effort==='high'?32768:2048,...(row.capabilities.deep?{reasoning_effort:effort}: {})}};
  }
};
const originalFetch=globalThis.fetch;
const fetchImpl=async(url,options={})=>{
  assert.equal(url,'http://127.0.0.1:1234/v1/chat/completions','Only synthetic local inference endpoint may be called');
  assert.equal(options.redirect,'error');
  const body=JSON.parse(options.body);inference.push(body);
  if(body.response_format?.json_schema?.name==='next_action')return Response.json({choices:[{message:{role:'assistant',content:proposalContent,...(proposalCalls===undefined?{}:{tool_calls:proposalCalls})},finish_reason:proposalFinish}]});
  return body.stream ? new Response('data: '+JSON.stringify({choices:[{delta:{content:'Synthetic answer'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}) : Response.json({choices:[{message:{role:'assistant',content:'Synthetic answer'},finish_reason:'stop'}]});
};
globalThis.fetch=fetchImpl; // Guard even pre-implementation requests: never reach the network.
const inert={close:async()=>({stopped:true}),stop:async()=>({stopped:true})};
const server=createServer({instanceToken:token,localModels:catalog,fetchImpl,hub:{...inert},coding:{...inert,dataDir:'/tmp/saleh-model-routing-no-writes'},worktrees:{...inert},gitWorkflow:{...inert}});
class ResponseFixture extends EventEmitter {
  headers={};statusCode=200;headersSent=false;destroyed=false;parts=[];
  setHeader(name,value){this.headers[name.toLowerCase()]=value;}
  writeHead(status,headers={}){this.statusCode=status;for(const [name,value] of Object.entries(headers))this.setHeader(name,value);this.headersSent=true;}
  flushHeaders(){this.headersSent=true;}
  write(chunk){this.parts.push(Buffer.from(chunk));return true;}
  end(chunk){if(chunk!==undefined)this.write(chunk);this.finished=true;this.writableEnded=true;}
}
async function request(route,input,extraHeaders={},target=server){
  const req=Readable.from(input===undefined?[]:[Buffer.from(JSON.stringify(input))]);
  Object.assign(req,{url:route,method:input===undefined?'GET':'POST',headers:{host:'127.0.0.1:8787','content-type':'application/json','x-qwen-chat':'1',...extraHeaders},socket:{localPort:8787}});
  const res=new ResponseFixture();await target.listeners('request')[0](req,res);
  assert(res.finished,'Every request must finish');
  const text=Buffer.concat(res.parts).toString();
  return {status:res.statusCode,headers:res.headers,text,body:res.headers['content-type']?.startsWith('application/json')?JSON.parse(text):null};
}
const proposal=async(input,target=server)=>{const route='/api/tools/computerProposal',body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now());return request(route,input,{'x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)},target);};
const jpeg=padding=>{const chunks=[Buffer.from('ffd8','hex')];for(let n=padding;n>0;n-=65530){const size=Math.min(n,65530),header=Buffer.from([255,225,0,0]);header.writeUInt16BE(size+2,2);chunks.push(header,Buffer.alloc(size));}chunks.push(Buffer.from('ffc0000b080001000101011100ffda0008010100003f0000ffd9','hex'));return 'data:image/jpeg;base64,'+Buffer.concat(chunks).toString('base64');};
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const messages=[{role:'user',content:'Use only this synthetic prompt.'}];
try{
  await test('Chat sends the explicit selected model and capability-aware generation',async()=>{
    const result=await request('/api/chat',{messages,model:plain.id,thinking:'standard'});
    assert.equal(result.status,200);assert.equal(inference.at(-1).model,plain.id);
    assert.equal(inference.at(-1).max_tokens,2048);assert(!Object.hasOwn(inference.at(-1),'reasoning_effort'));
    assert.match(inference.at(-1).messages[0].content,/local\/plain/);assert(!inference.at(-1).messages[0].content.includes('You are Qwen'));
    assert.deepEqual(resolved.at(-1),{id:plain.id,mode:'chat',effort:'none',vision:false});
  });
  await test('Agent sends exact selected model and supported deep generation',async()=>{
    assert.equal((await request('/api/agent',{messages,model:capable.id,thinking:'deep'})).status,200);
    const sent=inference.at(-1);assert.equal(sent.model,capable.id);assert.equal(sent.reasoning_effort,'high');assert.equal(sent.max_tokens,32768);assert.equal(sent.tool_choice,'auto');assert(sent.tools.length);
    assert.match(sent.messages[0].content,/local\/reasoner/);assert(!sent.messages[0].content.includes('You are Qwen'));
    assert.deepEqual(resolved.at(-1),{id:capable.id,mode:'agent',effort:'high',vision:false});
  });
  await test('Omitted selections preserve explicit legacy default after validation',async()=>{
    assert.equal(MODEL,DEFAULT);
    for(const route of ['/api/chat','/api/agent']){assert.equal((await request(route,{messages,thinking:'standard'})).status,200);assert.equal(inference.at(-1).model,DEFAULT);assert.equal(resolved.at(-1).id,DEFAULT);}
  });
  await test('Interleaved Chat and Agent selections do not mutate the default',async()=>{
    const replies=await Promise.all([request('/api/chat',{messages,model:plain.id,thinking:'standard'}),request('/api/agent',{messages,model:capable.id,thinking:'standard'})]);
    assert(replies.every(reply=>reply.status===200));assert.deepEqual(inference.slice(-2).map(row=>row.model).sort(),[plain.id,capable.id].sort());
    assert.equal((await request('/api/chat',{messages,thinking:'standard'})).status,200);assert.equal(inference.at(-1).model,DEFAULT);
  });
  await test('Catalog and exact selection status expose loaded and missing states',async()=>{
    assert.deepEqual((await request('/api/models')).body,catalogState);
    const selected=(await request('/api/status?model='+encodeURIComponent(plain.id))).body;
    assert.equal(selected.model,plain.id);assert.equal(selected.loaded,true);assert.equal(selected.available,true);assert.equal(selected.contextLength,65536);
    const missing=(await request('/api/status?model=missing-local')).body;assert.equal(missing.model,'missing-local');assert.equal(missing.loaded,false);assert.equal(missing.available,false);
    assert.equal((await request('/api/status')).body.model,DEFAULT);
  });
  await test('Offline or unloaded selection never falls back to another model',async()=>{
    const before=inference.length;
    catalogState={online:false,models:[]};
    const status=(await request('/api/status?model='+encodeURIComponent(plain.id))).body;assert.equal(status.online,false);assert.equal(status.model,plain.id);assert.equal(status.loaded,false);
    for(const route of ['/api/chat','/api/agent'])assert.equal((await request(route,{messages,model:plain.id,thinking:'standard'})).status,400);
    catalogState={online:true,models:[{...plain,loaded:false},capable,legacy]};
    assert.equal((await request('/api/chat',{messages,model:plain.id,thinking:'standard'})).status,400);assert.equal(inference.length,before);
    catalogState={online:true,models:[plain,capable,legacy]};
  });
  await test('Unknown and invalid model IDs are rejected before inference',async()=>{
    const before=inference.length;
    for(const model of ['missing-local','https://paid.invalid/model',' x ', '',null,123,{},'bad\nidentity'])for(const route of ['/api/chat','/api/agent'])assert.equal((await request(route,{messages,model,thinking:'standard'})).status,400,String(model));
    assert.equal((await request('/api/status?model=')).status,400);
    assert.equal(inference.length,before);
  });
  await test('Unsupported Deep and Agent modes fail before inference',async()=>{
    const before=inference.length;
    assert.equal((await request('/api/chat',{messages,model:plain.id,thinking:'deep'})).status,400);
    assert.equal((await request('/api/agent',{messages,model:plain.id,thinking:'standard'})).status,400);assert.equal(inference.length,before);
  });
  await test('Actual image context requires vision compatibility',async()=>{
    const textOnly={...capable,id:'text-agent',capabilities:{...capable.capabilities,vision:false}};catalogState.models.push(textOnly);
    const images=[{role:'user',content:[{type:'text',text:'Synthetic image.'},{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'}}]}];
    const before=inference.length;assert.equal((await request('/api/agent',{messages:images,model:textOnly.id,thinking:'standard'})).status,400);assert.equal(inference.length,before);assert.equal(resolved.at(-1).vision,true);
    assert.equal((await request('/api/agent',{messages:images,model:capable.id,thinking:'standard'})).status,200);assert.equal(resolved.at(-1).vision,true);
  });
  await test('Final synthesis preserves selected identity and suppresses tools',async()=>{
    assert.equal((await request('/api/agent',{messages,model:capable.id,thinking:'standard',finalize:true})).status,200);
    const sent=inference.at(-1);assert.equal(sent.model,capable.id);assert.equal(sent.tool_choice,'none');assert(!Object.hasOwn(sent,'tools'));assert.match(sent.messages[0].content,/final evidence review/i);
  });
  await test('Existing origin boundary and request validation precede inference',async()=>{
    const before=inference.length;
    assert.equal((await request('/api/models',undefined,{origin:'https://other.invalid'})).status,403);
    assert.equal((await request('/api/chat',{messages,model:capable.id,thinking:'invented'})).status,400);
    assert.equal((await request('/api/agent',{messages,model:capable.id,finalize:'true'})).status,400);
    assert.equal(inference.length,before);
  });
  await test('Real catalog inventory and Chat/Agent transport share the same local endpoint',async()=>{
    let loaded=true;const calls=[];
    const localFetch=async(url,options={})=>{
      calls.push({url,method:options.method});assert.equal(options.redirect,'error');
      if(url==='http://127.0.0.1:1234/api/v1/models')return Response.json({models:[{key:'installed-reasoner',display_name:'Fixture local model',type:'llm',loaded_instances:loaded?[{id:capable.id,config:{context_length:65536}}]:[],capabilities:{trained_for_tool_use:true,vision:true,reasoning:{allowed_options:['off','on']}}}]});
      return fetchImpl(url,options);
    };
    const integrated=createServer({fetchImpl:localFetch,hub:{...inert},coding:{...inert},worktrees:{...inert},gitWorkflow:{...inert}});
    try{
      const listing=(await request('/api/models',undefined,{},integrated)).body;assert.equal(listing.online,true);assert.equal(listing.models[0].id,capable.id);
      for(const route of ['/api/chat','/api/agent'])assert.equal((await request(route,{messages,model:capable.id,thinking:'deep'},{},integrated)).status,200);
      assert.equal(inference.at(-1).model,capable.id);assert.equal(inference.at(-1).reasoning_effort,'high');
      loaded=false;const before=inference.length;
      assert.equal((await request('/api/chat',{messages,model:capable.id,thinking:'standard'},{},integrated)).status,400);assert.equal(inference.length,before,'Unloaded exact instance is never substituted with its installed key');
      assert(calls.every(call=>call.url.startsWith('http://127.0.0.1:1234/')&&['GET','POST'].includes(call.method)));
      assert.deepEqual([...new Set(calls.map(call=>new URL(call.url).pathname))].sort(),['/api/v1/models','/v1/chat/completions']);
    }finally{await integrated.shutdownTools();}
  });
  await test('Remote or credential-bearing upstreams fail even with a trusted catalog injection',async()=>{
    for(const upstream of ['https://paid.invalid','http://remote.invalid','http://user:pass@127.0.0.1:1234','http://127.0.0.1:1234/path'])assert.throws(()=>createServer({upstream,localModels:catalog,fetchImpl}),/loopback/i);
  });
  await test('Chat and Agent disconnect during deferred inventory never dispatch inference',async()=>{
    for(const route of ['/api/chat','/api/agent']){
      let begin,complete;const started=new Promise(resolve=>{begin=resolve;});
      const deferred={...catalog,resolve:async()=>{begin();return new Promise(resolve=>{complete=()=>resolve({...capable,generation:{max_tokens:2048,reasoning_effort:'none'}});});}};
      const fixture=createServer({localModels:deferred,fetchImpl,hub:{...inert},coding:{...inert},worktrees:{...inert},gitWorkflow:{...inert}});
      try{
        const req=Readable.from([Buffer.from(JSON.stringify({messages,model:capable.id,thinking:'standard'}))]);
        Object.assign(req,{url:route,method:'POST',headers:{host:'127.0.0.1:8787','content-type':'application/json','x-qwen-chat':'1'},socket:{localPort:8787}});
        const res=new ResponseFixture(),before=inference.length,pending=fixture.listeners('request')[0](req,res);
        await started;res.destroyed=true;res.emit('close');complete();await pending;
        assert.equal(inference.length,before,route+' must not infer after inventory cancellation');assert.equal(res.finished,undefined);assert.equal(res.listenerCount('close'),0);
      }finally{await fixture.shutdownTools();}
    }
  });
  await test('Manual Computer proposal resolves exact selected vision model and bounded signed screenshot',async()=>{
    const input={model:capable.id,task:'Describe this synthetic window.',controls:[{id:'fixture_control',label:'Note',action:'fill'}],image:jpeg(120000)},before=inference.length;
    const value=await proposal(input);assert.equal(value.status,200,value.body?.error);assert.equal(value.body.model,capable.id);assert.equal(value.body.content,proposalContent);assert.equal(inference.length,before+1);assert.equal(inference.at(-1).model,capable.id);assert.deepEqual(resolved.at(-1),{id:capable.id,mode:'chat',effort:'none',vision:true});assert.equal(inference.at(-1).stream,false);assert(!Object.hasOwn(inference.at(-1),'tools'));
    assert.equal((await request('/api/tools/computerProposal',input)).status,403,'Web callers cannot sign inference');
    const nonstandard={...capable,id:'vision-nonstandard',capabilities:{...capable.capabilities,standard:false}},unloaded={...capable,id:'vision-unloaded',loaded:false},small={...capable,id:'vision-no-context',contextLength:2048};catalogState.models.push(nonstandard,unloaded,small);
    const sent=inference.length;
    for(const id of ['missing-model',plain.id,nonstandard.id,unloaded.id,small.id])assert.equal((await proposal({...input,model:id})).status,400,id);
    for(const change of [{image:'data:image/png;base64,AAAA'},{image:jpeg(2500001)},{controls:[...input.controls,...input.controls]},{controls:[{id:'bad',label:'x'.repeat(401),action:'fill'}]},{task:'\ud800'},{extra:true}])assert.equal((await proposal({...input,...change})).status,400);
    assert.equal(inference.length,sent,'Ineligible/invalid proposals must not send inference');
    proposalCalls=[];assert.equal((await proposal(input)).status,200,'A completed proposal may contain an empty tool_calls array');proposalCalls=[{id:'unexpected_call',type:'function',function:{name:'unsafe',arguments:'{}'}}];assert.equal((await proposal(input)).status,400,'A real tool request cannot be a proposal');proposalCalls=undefined;
    for(const finish of ['length','tool_calls',null]){proposalFinish=finish;assert.equal((await proposal(input)).status,400);}proposalFinish='stop';proposalContent='x'.repeat(16001);assert.equal((await proposal(input)).status,400);proposalContent='{"action":"done","target":"","text":"Synthetic observation"}';
  });
  await test('Manual proposal Stop, departure, shutdown and response close abort deferred work and drain ownership',async()=>{
    for(const control of ['stop','depart','shutdown','disconnect'])for(const phase of ['inventory','inference']){
      let arrived,observed;const started=new Promise(r=>arrived=r);let posts=0;
      const wait=signal=>new Promise((_,reject)=>{observed=signal;arrived();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});
      const fixture=createServer({instanceToken:token,localModels:{...catalog,async resolve(id,options){if(phase==='inventory')await wait(options.signal);return catalog.resolve(id,options);}},fetchImpl:async(_url,options)=>{posts++;return wait(options.signal);},hub:{...inert},coding:{...inert,dataDir:'/tmp/saleh-model-routing-no-writes'},worktrees:{...inert},gitWorkflow:{...inert}});
      try{const route='/api/tools/computerProposal',input={model:capable.id,task:'Inspect synthetic window',controls:[],image:jpeg(0)},body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now()),req=Readable.from([Buffer.from(body)]),res=new ResponseFixture();
        Object.assign(req,{url:route,method:'POST',headers:{host:'127.0.0.1:8787','content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)},socket:{localPort:8787}});
        const pending=fixture.listeners('request')[0](req,res);await started;
        if(control==='disconnect'){res.destroyed=true;res.emit('close');await pending;assert.equal(res.finished,undefined);}
        else if(control==='shutdown'){assert.equal((await fixture.shutdownTools()).stopped,true);await pending;assert.equal(res.statusCode,400);}
        else{const stopRoute='/api/tools/'+control,stopNonce=randomUUID(),stopTime=String(Date.now()),stopResult=await request(stopRoute,{}, {'x-qwen-nonce':stopNonce,'x-qwen-time':stopTime,'x-qwen-permit':nativeSignature(token,stopRoute,stopNonce,stopTime,'{}')},fixture);assert.equal(stopResult.status,200);assert.equal(stopResult.body.stopped,true);await pending;assert.equal(res.statusCode,400);}
        assert(observed.aborted);assert.equal(posts,phase==='inventory'?0:1);}finally{await fixture.shutdownTools();}
    }
  });
  await test('Agent compacts removable UTF8 history against loaded32k context and actual tool envelope',async()=>{
    const selected={...capable,id:'compact-agent',contextLength:32768};catalogState.models.push(selected);
    for(const old of ['x'.repeat(40000),'ع'.repeat(21000)]){
      const history=[{role:'user',content:'Retain the original short request.'},{role:'assistant',content:'Acknowledged.'},{role:'user',content:old},{role:'assistant',content:'Old completed exchange.'},{role:'user',content:'Recent short request.'},{role:'assistant',content:'Recent answer.'},{role:'user',content:'Answer this latest request.'}],saved=structuredClone(history),before=inference.length;
      const reply=await request('/api/agent',{messages:history,model:selected.id,thinking:'standard'});
      assert.equal(reply.status,200,reply.body?.error);assert.equal(inference.length,before+1);
      const sent=inference.at(-1);assert(!sent.messages.some(m=>m.content===old));assert.equal(sent.messages.at(-1).content,history.at(-1).content);assert(sent.messages.some(m=>m.content?.startsWith('Context notice:')));assert.deepEqual(history,saved,'Compaction never rewrites saved history');
      assert(Buffer.byteLength(JSON.stringify(sent))+sent.max_tokens+1024<=selected.contextLength,'Actual system and tool envelope fits');
    }
  });
  await test('Chat and Agent reject conservative context overflow before inference',async()=>{
    const smallChat={...plain,id:'small-chat',contextLength:8192};
    const smallAgent={...capable,id:'small-agent',contextLength:32768};
    catalogState.models.push(smallChat,smallAgent);
    const before=inference.length;
    for(const [route,model,content,thinking] of [
      ['/api/chat',smallChat.id,'🤖'.repeat(2500),'standard'],
      ['/api/agent',smallAgent.id,'🤖'.repeat(8000),'standard'],
      ['/api/chat',smallAgent.id,'Tiny prompt but no output capacity.','deep'],
    ]){
      const result=await request(route,{messages:[{role:'user',content}],model,thinking});
      assert.equal(result.status,400,route+' must reject context overflow');assert.match(result.body.error,/context budget|too large to preserve safely/i);
    }
    assert.equal(inference.length,before);
    assert.equal((await request('/api/chat',{messages,model:smallChat.id,thinking:'standard'})).status,200,'A short prompt still fits the small model');
  });
  await test('Bounded screenshots retain their bytes without treating base64 as text tokens',async()=>{
    const before=inference.length;
    const images=[{role:'user',content:[{type:'text',text:'Synthetic image.'},{type:'image_url',image_url:{url:imageURL(65536)}}]}];
    const result=await request('/api/agent',{messages:images,model:capable.id,thinking:'deep'});
    assert.equal(result.status,200);assert.equal(inference.length,before+1);
    assert.deepEqual(inference.at(-1).messages.slice(1),images);assert.equal(inference.at(-1).max_tokens,32768);
    const oversized=[{role:'user',content:[{type:'image_url',image_url:{url:imageURL(3*1024*1024)}}]}];
    const repeated=[{role:'user',content:[images[0].content[0],...Array(10).fill(images[0].content[1])]}];
    const tooMuchText=[{role:'user',content:[{type:'text',text:'🤖'.repeat(16000)},images[0].content[1]]}];
    for(const messages of [oversized,repeated,tooMuchText])assert.equal((await request('/api/agent',{messages,model:capable.id,thinking:'deep'})).status,400);
    assert.equal(inference.length,before+1,'Image limits and text/output budget must still reject before dispatch');
  });
  console.log(`PASS ${passed} in-memory model-routing checks; no sockets or real inference.`);
}finally{globalThis.fetch=originalFetch;await server.shutdownTools();}
