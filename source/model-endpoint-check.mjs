// Exercise the real relay request handler in memory: no sockets or model inference.
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {LocalModelCatalog} from './local-models.mjs';
import {createQwenRelay} from './coding-local.mjs';
import {createServer} from './server.mjs';
import {CodingEngine} from './coding-engine.mjs';

const origin='http://127.0.0.1:2345',model='fixture/selected-model';
const inventory={models:[{type:'llm',key:'disk-model',loaded_instances:[{id:model,config:{context_length:65536}}],capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:['off','on']}}}]};
const calls=[];
const transport=async(url,init)=>{
  calls.push({url,init});assert.equal(init.redirect,'error');
  if(new URL(url).pathname==='/api/v1/models')return Response.json(inventory);
  assert(['/v1/responses','/v1/chat/completions'].includes(new URL(url).pathname));
  assert.equal(JSON.parse(init.body).model,model);
  if(new URL(url).pathname==='/v1/chat/completions')return JSON.parse(init.body).stream?new Response('data: {"choices":[{"delta":{"content":"Synthetic"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}):Response.json({choices:[{message:{role:'assistant',content:'Synthetic'},finish_reason:'stop'}]});
  return Response.json({id:'synthetic',status:'completed',output:[]});
};
class MemoryServer extends EventEmitter {
  constructor(handler){super();this.handler=handler;}
  listen(port,host){assert.equal(port,0);assert.equal(host,'127.0.0.1');queueMicrotask(()=>this.emit('listening'));return this;}
  address(){return {port:34567};}
  closeAllConnections(){}
  close(callback){callback();}
}
class MemoryResponse extends EventEmitter {
  headersSent=false;destroyed=false;chunks=[];headers={};
  setHeader(name,value){this.headers[name.toLowerCase()]=value;}
  flushHeaders(){this.headersSent=true;}
  writeHead(status,headers){this.statusCode=status;for(const [name,value]of Object.entries(headers??{}))this.setHeader(name,value);this.headersSent=true;return this;}
  write(value){this.chunks.push(Buffer.from(value));return true;}
  end(value){if(value!==undefined)this.write(value);this.finished=true;return this;}
  destroy(error){this.destroyed=true;this.error=error;}
}
const originalCreate=http.createServer,originalFetch=globalThis.fetch;
let server;
http.createServer=handler=>(server=new MemoryServer(handler));
globalThis.fetch=transport;
async function post(relay,body={model,input:[{role:'user',content:'Synthetic only'}]}){
  const url=new URL(relay.baseURL+'/responses'),req=Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req,{url:url.pathname,method:'POST',headers:{host:url.host,authorization:'Bearer '+relay.authToken}});
  const res=new MemoryResponse();await server.handler(req,res);assert.equal(res.finished,true);return res;
}
const inert={close:async()=>({stopped:true}),stop:async()=>({stopped:true})};
const appOptions={hub:{...inert},coding:{...inert},worktrees:{...inert},gitWorkflow:{...inert}};
async function appPost(app,route){
  const req=Readable.from([Buffer.from(JSON.stringify({model,messages:[{role:'user',content:'Synthetic only'}],thinking:'standard'}))]);
  Object.assign(req,{url:route,method:'POST',headers:{host:'127.0.0.1:34567','content-type':'application/json','x-qwen-chat':'1'},socket:{localPort:34567}});
  const res=new MemoryResponse();await app.handler(req,res);assert.equal(res.finished,true);return res;
}
try{
  const catalog=new LocalModelCatalog({upstream:origin,fetchImpl:transport});
  const relay=await createQwenRelay({localModels:catalog});
  try{
    const res=await post(relay);assert.equal(res.statusCode,200);
    assert.deepEqual(calls.map(call=>call.url),[origin+'/api/v1/models',origin+'/v1/responses'],'Inventory and Coding inference must use the same selected origin');
    assert.equal(JSON.parse(calls[1].init.body).model,model);
    console.log('PASS custom catalog origin binds the actual Coding inference destination and exact model');
  }finally{await relay.close();}
  calls.length=0;
  let launchArgs,launchEnv;const stopBeforeSpawn=new Error('Synthetic fixture stops before any process is created.');
  const engine=new CodingEngine({dataDir:'/tmp/saleh-endpoint-fixture-no-writes',localModels:catalog,binary:'/synthetic/codex',spawnProcess:(_binary,args,options)=>{launchArgs=args;launchEnv=options.env;throw stopBeforeSpawn;}});
  engine.loadPartialHistory=async()=>{};engine.configFile=async()=>{};engine.providerMetadata=async()=>null;
  try{
    // Execute the current real launch composition through relay creation. Only
    // unrelated persistence/provider reads and the process spawn are fixtures.
    await assert.rejects(engine.launch(),error=>error===stopBeforeSpawn);
    assert(engine.relay,'Actual CodingEngine.launch must create the relay');
    assert(launchArgs.includes('model_providers.saleh_local.base_url='+JSON.stringify(engine.relay.baseURL)));
    assert(launchEnv.SALEH_CODING_LOCAL_KEY===engine.relay.authToken);assert(!JSON.stringify(launchArgs).includes(engine.relay.authToken));
    assert(launchArgs.includes('model_providers.saleh_local.env_key="SALEH_CODING_LOCAL_KEY"'));
    assert(launchArgs.includes('shell_environment_policy.exclude=["SALEH_CODING_LOCAL_KEY","SALEH_CODING_CLOUD_KEY"]'));
    assert.equal((await post(engine.relay)).statusCode,200);
    assert.deepEqual(calls.map(call=>call.url),[origin+'/api/v1/models',origin+'/v1/responses']);
    console.log('PASS actual CodingEngine launch composition binds catalog and inference to the custom origin before synthetic spawn');
  }finally{await engine.relay?.close();}
  assert.throws(()=>{catalog.upstream='http://127.0.0.1:1234';},TypeError);
  assert.throws(()=>{catalog.fetchImpl=globalThis.fetch;},TypeError);
  console.log('PASS catalog origin and transport cannot be reassigned');
  calls.length=0;
  const app=createServer({...appOptions,localModels:catalog});
  try{
    for(const route of ['/api/chat','/api/agent'])assert.equal((await appPost(app,route)).statusCode,200);
    assert.deepEqual(calls.map(call=>call.url),[origin+'/api/v1/models',origin+'/v1/chat/completions',origin+'/api/v1/models',origin+'/v1/chat/completions']);
    console.log('PASS Chat and Agent derive the same custom catalog origin and exact model');
  }finally{await app.shutdownTools();}
  const before=calls.length;
  await assert.rejects(createQwenRelay({upstream:'http://127.0.0.1:1234/v1/responses',localModels:catalog}),/origins must match/);
  assert.throws(()=>createServer({...appOptions,upstream:'http://127.0.0.1:1234',localModels:catalog}),/origins must match/);
  await assert.rejects(createQwenRelay({localModels:catalog,fetchImpl:async()=>{throw Error('wrong transport');}}),/transport must match/);
  for(const value of ['https://paid.invalid','http://remote.invalid','http://user:secret@127.0.0.1:2345','http://127.0.0.1:2345/?redirect=1']){
    assert.throws(()=>createServer({...appOptions,upstream:value,localModels:catalog}),/loopback|origins/);
    await assert.rejects(createQwenRelay({upstream:value+'/v1/responses',localModels:catalog}),/loopback|endpoint/);
  }
  assert.equal(calls.length,before);
  console.log('PASS mismatched, credential-bearing, remote and separate transport bindings reject before discovery or inference');
  for(const redirectedFlag of [false,true]){
    const seen=[],redirectTransport=async(url,init)=>{
      seen.push(url);assert.equal(init.redirect,'error');
      if(url.endsWith('/api/v1/models'))return Response.json(inventory);
      const response=redirectedFlag?Response.json({}):new Response(null,{status:302,headers:{Location:'https://paid.invalid'}});
      if(redirectedFlag)Object.defineProperty(response,'redirected',{value:true});return response;
    };
    const redirectCatalog=new LocalModelCatalog({upstream:origin,fetchImpl:redirectTransport});
    const redirectRelay=await createQwenRelay({localModels:redirectCatalog});
    try{assert.equal((await post(redirectRelay)).statusCode,502);}finally{await redirectRelay.close();}
    const redirectApp=createServer({...appOptions,localModels:redirectCatalog});
    try{assert.equal((await appPost(redirectApp,'/api/chat')).statusCode,502);assert.equal((await appPost(redirectApp,'/api/agent')).statusCode,400);}finally{await redirectApp.shutdownTools();}
    assert(seen.every(url=>new URL(url).origin===origin));assert.equal(seen.length,6);
  }
  console.log('PASS relay, Chat and Agent reject redirect responses without following any alternate origin');
  console.log('PASS 6 endpoint binding checks using actual engine composition and request handlers, synthetic inventory/inference only.');
}finally{http.createServer=originalCreate;globalThis.fetch=originalFetch;}
