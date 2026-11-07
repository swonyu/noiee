// Generated inventories, in-memory engine protocol and temporary files only.
// This suite never starts Codex, loads a model or contacts LM Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {LocalModelCatalog,contextProfile,outputPolicy,responseStyleInstructions,assertModelContext} from './local-models.mjs';
import {CodingContextProfiles,assertCodingContext} from './coding-context.mjs';
import {CodingEngine} from './coding-engine.mjs';
import {createQwenRelay,prepareLocalModelRequest} from './coding-local.mjs';
import {verifyCodingRuntime,verifyCodingInitialization} from './coding-runtime.mjs';

const id='fixture/exact-model', sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const row=(window=39424,extra={})=>({key:id,type:'llm',display_name:'Fixture',loaded_instances:[{id,config:{context_length:window}}],capabilities:{trained_for_tool_use:true,vision:false,reasoning:{allowed_options:['off','on']}},...extra});
const inventory=(models=[row()],fetchImpl=async()=>Response.json({models}))=>new LocalModelCatalog({fetchImpl});
const selected=(window=39424)=>({id,contextLength:window,generation:{max_tokens:-1,reasoning_effort:'none'}});
const profile={model:id,modelProvider:'saleh_local'};

test('39,424 loaded tokens derive a conservative 24,576 total-context compaction budget',async()=>{
  const models=inventory(),value=await models.resolve(id,{mode:'coding',effort:'high'});
  assert.deepEqual(value.contextProfile,{version:1,contextWindow:39424,responseReserve:8192,toolReserve:4096,safetyReserve:2048,inputBudget:25088,autoCompactTokenLimit:24576,toolOutputTokenLimit:4096});
  assert.equal(value.generation.max_tokens,-1);
  const catalog=await models.catalog(),cap=catalog.models[0].capabilities;
  for(const mode of ['chat','agent','coding','standard','deep'])assert.equal(cap[mode],true,mode);
});
test('Tasks minimum is a complete reserve profile, with unknown and smaller windows rejected',async()=>{
  const minimum=contextProfile(32768,{mode:'coding'});
  assert.equal(minimum.autoCompactTokenLimit,18432);
  for(const window of [undefined,null,0,32767,1.5,NaN])assert.throws(()=>contextProfile(window,{mode:'coding'}));
  await assert.rejects(inventory([row(32767)]).resolve(id,{mode:'coding'}),/context|32768/i);
});
test('Detailed requires the selected model capability, with no artificial 65k floor',async()=>{
  const models=inventory([row(8192)]);
  const value=await models.resolve(id,{mode:'chat',longOutput:true});
  assert.equal(value.generation.max_tokens,-1);assert.equal(value.contextProfile.responseReserve,4096);
  await assert.rejects(models.resolve(id,{mode:'chat',effort:'high'}),/context|deep/i);
  await assert.rejects(models.resolve(id,{mode:'chat',effort:'high',longOutput:true}),/Detailed|reasoning/i);
});
test('Concise and Detailed change instructions while preserving uncapped output and deadline',()=>{
  for(const mode of ['chat','agent']) {
    const concise={mode,effort:'none'},detailed={...concise,longOutput:true};
    assert.deepEqual(outputPolicy(concise),{max_tokens:-1,deadlineMs:1800000});
    assert.deepEqual(outputPolicy(detailed),outputPolicy(concise));
    assert.notEqual(responseStyleInstructions(concise),responseStyleInstructions(detailed));
    assert.match(responseStyleInstructions(detailed),/Detailed.*thorough/);
    assert.match(responseStyleInstructions(concise),/Concise.*direct answer/);
  }
});
test('Deep reserves answer/reasoning space rather than advertising the full window as input',async()=>{
  const value=await inventory().resolve(id,{mode:'chat',effort:'high'});
  assert.equal(value.contextProfile.responseReserve,8192);
  assert.throws(()=>assertModelContext(value,{messages:[{role:'user',content:'x'.repeat(31000)}],max_tokens:-1}),error=>error.code==='CONTEXT_BUDGET_EXCEEDED');
  assert.doesNotThrow(()=>assertModelContext(value,{messages:[{role:'user',content:'short'}],max_tokens:-1}));
});
test('Connectivity, authentication, malformed inventory and ambiguous identity stay distinct',async()=>{
  const cases=[
    [async()=>{throw Object.assign(Error('fixture'),{code:'ECONNREFUSED'});},false,'offline','LOCAL_MODEL_UNREACHABLE'],
    [async()=>new Response('',{status:401}),true,'authentication','LOCAL_MODEL_AUTH_REQUIRED'],
    [async()=>new Response('',{status:503}),true,'server-error','LOCAL_MODEL_HTTP_ERROR'],
    [async()=>new Response('{broken secret fixture'),true,'invalid','LOCAL_MODEL_INVENTORY_INVALID'],
    [async()=>Response.json({models:[row(),row(39424,{key:'duplicate-disk'})]}),true,'ambiguous','LOCAL_MODEL_AMBIGUOUS']
  ];
  for(const [fetchImpl,connected,status,code] of cases) {
    const value=await inventory([],fetchImpl).catalog();
    assert.equal(value.online,false);assert.equal(value.connected,connected);assert.equal(value.status,status);assert.equal(value.error.code,code);
    assert.deepEqual(value.models,[]);assert.doesNotMatch(value.message,/secret fixture/);
  }
});
test('Unloaded, missing and selected-mode errors never authorize a substitute model',async()=>{
  const unloaded=inventory([row(39424,{loaded_instances:[]})]);
  await assert.rejects(unloaded.resolve(id,{mode:'chat'}),error=>error.code==='MODEL_NOT_LOADED');
  await assert.rejects(inventory().resolve('removed',{mode:'chat'}),error=>error.code==='MODEL_SELECTION_MISSING');
  await assert.rejects(inventory([row(8192)]).resolve(id,{mode:'coding'}),error=>error.code==='MODEL_MODE_UNAVAILABLE');
});
test('A malformed unrelated row remains fail-closed without falsely claiming a disconnected server',async()=>{
  const value=await inventory([row(),{key:'broken',type:'llm',loaded_instances:'not-an-array'}]).catalog();
  assert.equal(value.online,false);assert.equal(value.connected,true);assert.equal(value.status,'invalid');assert.deepEqual(value.models,[]);
});
test('Admitted windows are immutable, exact-model-specific and cannot borrow a fallback',()=>{
  const profiles=new CodingContextProfiles(),value=profiles.admit(id,selected());
  assert.equal(profiles.admit(id,selected()),value);
  assert.throws(()=>profiles.admit(id,selected(65536)),error=>error.code==='MODEL_CONTEXT_CHANGED');
  assert.throws(()=>profiles.require('another'),error=>error.code==='MODEL_CONTEXT_UNCONFIRMED');
  assert.deepEqual(profiles.config(id),{model_context_window:39424,model_auto_compact_token_limit:24576,model_auto_compact_token_limit_scope:'total',tool_output_token_limit:4096});
  assert.throws(()=>profiles.admit(id,{...selected(),id:'another'}),/identity/);
});
test('Relay request recheck rejects a changed or unconfirmed window and preserves uncapped generation',async()=>{
  const models={resolve:async()=>selected()},expected=contextProfile(39424,{mode:'coding'});
  const input={model:id,input:[{role:'user',content:'fixture'}]};
  const body=await prepareLocalModelRequest(input,models,{expectedContextProfile:expected});
  assert.equal(body.model,id);assert.equal(Object.hasOwn(body,'max_output_tokens'),false);assert.deepEqual(input,{model:id,input:[{role:'user',content:'fixture'}]});
  models.resolve=async()=>selected(65536);
  await assert.rejects(prepareLocalModelRequest(input,models,{expectedContextProfile:expected}),error=>error.code==='MODEL_CONTEXT_CHANGED');
  assert.throws(()=>assertCodingContext(selected(),null),error=>error.code==='MODEL_CONTEXT_UNCONFIRMED');
});
test('Authenticated isolated relay never forwards or replays after a loaded-window change',async()=>{
  let upstreamCalls=0,window=39424;
  const models={upstream:'http://127.0.0.1:1234',resolve:async()=>selected(window)};
  const profiles=new CodingContextProfiles();profiles.admit(id,selected());
  const relay=await createQwenRelay({localModels:models,contextProfileForModel:model=>profiles.require(model),fetchImpl:async()=>{upstreamCalls++;return Response.json({id:'fixture',output:[]});}});
  try {
    const send=()=>fetch(relay.baseURL+'/responses',{method:'POST',headers:{Authorization:'Bearer '+relay.authToken,'Content-Type':'application/json'},body:JSON.stringify({model:id,input:[{role:'user',content:'fixture'}]})});
    const first=await send();assert.equal(first.status,200);await first.text();assert.equal(upstreamCalls,1);
    window=65536;const blocked=await send();assert.equal(blocked.status,409);assert.match(await blocked.text(),/context changed/);assert.equal(upstreamCalls,1);
  } finally {await relay.close();}
});

class EngineFixture extends CodingEngine {
  constructor(models={resolve:async()=>selected()}) {super({dataDir:'/tmp/noiee-model-fixture-unused',localModels:models});this.calls=[];this.saved={id:'root',cwd:'/tmp',model:id,modelProvider:'saleh_local',turns:[]};this.familyModes.set('root','build');}
  async ensure() {this.ensured=true;}
  async cwd(value) {return value;}
  async prepare() {}
  async temporaryEnvironment() {return {};}
  async thread() {return this.saved;}
  rememberThread(value) {this.saved=value;}
  async rpc(method,params) {this.calls.push({method,params});if(['thread/start','thread/resume','thread/fork'].includes(method))return {thread:{id:'root',cwd:params.cwd,model:params.model,modelProvider:params.modelProvider,turns:[]}};return {turn:{id:'turn',status:'completed'}};}
}
test('Start applies the exact loaded window and reserves before the first Tasks turn',async()=>{
  const engine=new EngineFixture();await engine.handle({action:'start',cwd:'/tmp',model:id});
  const call=engine.calls.find(value=>value.method==='thread/start');
  assert.equal(call.params.config.model_context_window,39424);assert.equal(call.params.config.model_auto_compact_token_limit,24576);
  assert.equal(call.params.allowProviderModelFallback,false);assert.equal(call.params.model,id);
  assert.equal(call.params.config['sandbox_workspace_write.network_access'],false);
});
test('A retained loaded history is resumed with actual context before sending and keeps its exact identity',async()=>{
  const engine=new EngineFixture();engine.loaded.add('root');
  await engine.handle({action:'send',threadId:'root',text:'fixture',effort:'high'});
  assert.deepEqual(engine.calls.map(value=>value.method),['thread/resume','turn/start']);
  assert.equal(engine.calls[0].params.config.model_context_window,39424);assert.equal(engine.calls[1].params.model,id);
  engine.calls=[];await engine.handle({action:'send',threadId:'root',text:'second'});
  assert.deepEqual(engine.calls.map(value=>value.method),['turn/start']);
});
test('A changed loaded window rejects the next turn before native resume or inference',async()=>{
  let window=39424;const engine=new EngineFixture({resolve:async()=>selected(window)});
  await engine.handle({action:'start',cwd:'/tmp',model:id});engine.calls=[];window=65536;
  await assert.rejects(engine.handle({action:'send',threadId:'root',text:'fixture'}),error=>error.code==='MODEL_CONTEXT_CHANGED');
  assert.deepEqual(engine.calls,[]);
});
test('Missing context fails before a new execution process is launched',async()=>{
  const engine=new EngineFixture({resolve:async()=>({id,generation:{max_tokens:-1}})});
  await assert.rejects(engine.handle({action:'start',cwd:'/tmp',model:id}),/context/i);
  assert.equal(engine.ensured,undefined);assert.deepEqual(engine.calls,[]);
});
test('History/fork preservation does not require inventory or authorize inference',async()=>{
  let calls=0;const engine=new EngineFixture({resolve:async()=>{calls++;throw Error('offline');}});
  const result=await engine.handle({action:'fork',threadId:'root'});
  assert.equal(result.thread.model,id);assert.equal(calls,0);assert.equal(engine.modelProfiles.get(id),undefined);
  assert.equal(Object.hasOwn(engine.calls[0].params.config,'model_context_window'),false);
});
test('Runtime context overrides leave owned config and hash bytes intact',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'noiee-context-config-'));
  try {
    const engine=new CodingEngine({dataDir:dir,localModels:{resolve:async()=>selected()}});
    await engine.configFile();const before=await Promise.all(['config.toml','.saleh-config.sha256'].map(name=>readFile(join(dir,name))));
    await engine.resolveModel(profile);const config=engine.threadOverrides(dir,profile,{}).config;
    assert.equal(config.model_context_window,39424);
    assert.match(before[0].toString(),/model_context_window = 65536/);
    const after=await Promise.all(['config.toml','.saleh-config.sha256'].map(name=>readFile(join(dir,name))));
    assert.deepEqual(after,before);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('Runtime compatibility validates bytes before any version execution',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'noiee-runtime-'));let versions=0;
  try {
    const file=join(dir,'fixture'),bytes=Buffer.from('generated executable fixture');await writeFile(file,bytes);
    const expected={version:1,cliVersion:'fixture 1',binary:{size:bytes.length,sha256:sha(bytes)},protocol:{revision:'fixture'}};
    const readVersion=async()=>{versions++;return 'fixture 1\n';};
    const verified=await verifyCodingRuntime(file,{expected,readVersion});assert.equal(verified.protocolRevision,'fixture');assert.equal(versions,1);
    await writeFile(file,Buffer.from('wrong executable fixture!!!'));
    await assert.rejects(verifyCodingRuntime(file,{expected,readVersion}),error=>error.code==='CODING_RUNTIME_UNSUPPORTED');
    assert.equal(versions,1,'Unknown executable bytes must never be executed for a version probe');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('Runtime version and initialization mismatch produce readable errors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'noiee-runtime-version-'));
  try {
    const file=join(dir,'fixture'),bytes=Buffer.from('fixture');await writeFile(file,bytes);
    const expected={version:1,cliVersion:'fixture 1',binary:{size:bytes.length,sha256:sha(bytes)}};
    await assert.rejects(verifyCodingRuntime(file,{expected,readVersion:async()=>'fixture 2'}),error=>error.code==='CODING_RUNTIME_UNSUPPORTED'&&/Saved projects/.test(error.message));
    const response={codexHome:dir,platformFamily:'unix',platformOs:'macos',userAgent:'fixture'};
    assert.doesNotThrow(()=>verifyCodingInitialization(response,dir));
    for(const change of [{codexHome:'/different'},{platformOs:'unknown'},{userAgent:''}])assert.throws(()=>verifyCodingInitialization({...response,...change},dir),error=>error.code==='CODING_PROTOCOL_UNSUPPORTED');
  } finally {await rm(dir,{recursive:true,force:true});}
});
