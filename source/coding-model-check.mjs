import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CodingEngine,validateCodingRequest} from './coding-engine.mjs';
import * as relay from './coding-local.mjs';

const legacy='qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp',chosen='local/alternate-65k';
function catalog({reject=false,reasoning=true,mismatch=false}={}) {
  return {calls:[],async resolve(id,options){const {signal,...policy}=options;if(signal!==undefined)assert(signal instanceof AbortSignal);this.calls.push({id,...policy});if(reject)throw Error('Selected local model is unavailable.');return {id:mismatch?'substitute':id,generation:{max_tokens:options.effort==='high'?32768:2048,...(reasoning?{reasoning_effort:options.effort}:{})}};}};
}
class Fixture extends CodingEngine {
  constructor(localModels=catalog()){super({dataDir:'/tmp/coding-model-fixture-unused',localModels});this.calls=[];this.saved={id:'root',cwd:'/tmp',model:chosen,modelProvider:'saleh_local',turns:[]};this.familyModes.set(this.saved.id,'build'); /* Existing model tests represent a known admitted Build root. */}
  async ensure(){this.ensures=(this.ensures??0)+1;}
  async cwd(value){return value;}
  async prepare(){}
  async temporaryEnvironment(){return {};}
  async thread(){return this.saved;}
  rememberThread(value){this.saved=value;}
  async rpc(method,params){this.calls.push({method,params});if(['thread/start','thread/resume','thread/fork'].includes(method))return {thread:{id:method==='thread/resume'?params.threadId:'root',cwd:params.cwd,model:params.model,modelProvider:params.modelProvider,turns:[]}};return {turn:{id:'turn',status:'completed'}};}
}
test('start accepts an exact local model, rejects cloud overrides and existing-chat mutation',()=>{
  assert.equal(validateCodingRequest({action:'start',cwd:'/tmp',model:chosen}).model,chosen);
  assert.throws(()=>validateCodingRequest({action:'start',cwd:'/tmp',provider:'cloud',model:chosen}),/model|local/i);
  for(const model of ['',null,'bad\nmodel','a'.repeat(201)])assert.throws(()=>validateCodingRequest({action:'start',cwd:'/tmp',model}),/model/i);
  for(const action of ['send','review','fork'])assert.throws(()=>validateCodingRequest({action,threadId:'root',text:'x',model:chosen}),/field/i);
});
test('saved local profile remains readable without inventory and uses legacy default only when absent',()=>{
  const models=catalog({reject:true}),engine=new Fixture(models);
  assert.equal(engine.profile('local',chosen).model,chosen);
  assert.equal(engine.profile('saleh_local',chosen).model,chosen);
  assert.equal(engine.profile().model,legacy);assert.deepEqual(models.calls,[]);
});
test('new root resolves and dispatches selected local model without provider fallback',async()=>{
  const models=catalog(),engine=new Fixture(models);
  const result=await engine.handle({action:'start',cwd:'/tmp',model:chosen});
  assert.equal(result.thread.model,chosen);assert.deepEqual(models.calls,[{id:chosen,mode:'coding',effort:'none'}]);
  const request=engine.calls.find(c=>c.method==='thread/start').params;
  assert.equal(request.model,chosen);assert.equal(request.allowProviderModelFallback,false);assert.equal(request.config.review_model,chosen);
});
test('unavailable model and resolver identity substitution block root dispatch',async()=>{
  for(const options of [{reject:true},{mismatch:true}]){
    const engine=new Fixture(catalog(options));await assert.rejects(engine.handle({action:'start',cwd:'/tmp',model:chosen}),/unavailable|identity|model/i);
    assert.equal(engine.calls.length,0);assert.equal(engine.ensures,undefined,'Preflight must fail before launching the engine');
  }
});
test('returned root model substitution is rejected instead of adopted',async()=>{
  const engine=new Fixture();engine.rpc=async()=>({thread:{id:'root',cwd:'/tmp',model:legacy,modelProvider:'saleh_local',turns:[]}});
  await assert.rejects(engine.handle({action:'start',cwd:'/tmp',model:chosen}),/model|identity/i);assert.equal(engine.loaded.size,0);
});
test('send and resume preserve the saved model and resolve requested effort',async()=>{
  const models=catalog(),engine=new Fixture(models);
  await engine.handle({action:'send',threadId:'root',text:'check',effort:'high'});
  assert.deepEqual(models.calls,[{id:chosen,mode:'coding',effort:'high'}]);
  assert.equal(engine.calls.find(c=>c.method==='thread/resume').params.model,chosen);
  assert.equal(engine.calls.find(c=>c.method==='turn/start').params.model,chosen);
});
test('review resolves the saved model before resume; failed availability sends no RPC',async()=>{
  const models=catalog(),engine=new Fixture(models);
  await engine.handle({action:'review',threadId:'root'});assert.deepEqual(models.calls,[{id:chosen,mode:'coding',effort:'none'}]);
  assert.equal(engine.calls.find(c=>c.method==='thread/resume').params.config.review_model,chosen);
  for(const action of ['send','review']){const blocked=new Fixture(catalog({reject:true}));await assert.rejects(blocked.handle({action,threadId:'root',...(action==='send'?{text:'check'}:{})}),/unavailable/);assert.equal(blocked.calls.length,0);}
});
test('fork preserves saved identity without requiring a loaded model',async()=>{
  const models=catalog({reject:true}),engine=new Fixture(models);
  const result=await engine.handle({action:'fork',threadId:'root'});assert.equal(result.thread.model,chosen);assert.deepEqual(models.calls,[]);
});
test('resume and fork reject substituted native model replies',async()=>{
  for(const action of ['send','review','fork']){
    const engine=new Fixture();engine.rpc=async(method,params)=>{engine.calls.push({method,params});return {thread:{...engine.saved,model:legacy}};};
    await assert.rejects(engine.handle({action,threadId:'root',...(action==='send'?{text:'check'}:{})}),/model|identity/i);
    assert.equal(engine.loaded.size,0);assert(!engine.calls.some(c=>c.method==='turn/start'||c.method==='review/start'));
  }
});
test('saved chats without a model cannot silently adopt the legacy default',async()=>{
  for(const action of ['send','review','fork'])for(const model of [undefined,null,'','invalid\nmodel']){
    const models=catalog(),engine=new Fixture(models);engine.saved.model=model;
    await assert.rejects(engine.handle({action,threadId:'root',...(action==='send'?{text:'check'}:{})}),/model/i);
    assert.deepEqual(engine.calls,[]);assert.deepEqual(models.calls,[]);
  }
});
test('model inventory delay cannot dispatch after engine cancellation',async()=>{
  let release;const models=catalog(),resolve=models.resolve.bind(models);models.resolve=async(...args)=>{await new Promise(r=>release=r);return resolve(...args);};
  const engine=new Fixture(models),pending=engine.handle({action:'send',threadId:'root',text:'check'});pending.catch(()=>{});
  for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');await engine.stop();release();await assert.rejects(pending,/cancelled/i);assert.equal(engine.calls.length,0);
});
test('selected family Stop cancels a catalog-waiting send or review without cancelling a sibling',async()=>{
  for(const action of ['send','review']){
    let release;const models=catalog(),resolve=models.resolve.bind(models);models.resolve=async(...args)=>{await new Promise(r=>release=r);return resolve(...args);};
    const engine=new Fixture(models);engine.resolveFamily=async()=>({thread:engine.saved,root:engine.saved});engine.familyPage=async()=>({data:[],nextCursor:null});engine.findActiveTurn=async()=>{};engine.finishFamilyStop=async()=>{};
    const pending=engine.handle({action,threadId:'root',...(action==='send'?{text:'check'}:{})});pending.catch(()=>{});
    for(let i=0;i<20&&!release;i++)await new Promise(r=>setImmediate(r));assert.equal(typeof release,'function');
    await engine.interruptFamily('root');await Promise.all(engine.familyStops.values());release();
    await assert.rejects(pending,/cancelled|Stop/i);assert.deepEqual(engine.calls,[]);
    models.resolve=resolve;engine.saved={...engine.saved,id:'sibling'};await engine.handle({action:'send',threadId:'sibling',text:'allowed'});
    assert.equal(engine.calls.at(-1).params.threadId,'sibling');
  }
});
test('relay validates the actual requested ID and effort without fallback',async()=>{
  assert.equal(typeof relay.prepareLocalModelRequest,'function');
  const models=catalog(),request={model:chosen,input:[],reasoning:{effort:'high'}};
  const body=await relay.prepareLocalModelRequest(request,models);
  assert.deepEqual(models.calls,[{id:chosen,mode:'coding',effort:'high'}]);assert.equal(body.model,chosen);assert.equal(body.max_output_tokens,32768);assert.equal(request.max_output_tokens,undefined);
  await assert.rejects(relay.prepareLocalModelRequest({...request,reasoning:{effort:'medium'}},models),/effort/i);
  await assert.rejects(relay.prepareLocalModelRequest(request,catalog({mismatch:true})),/identity|model/i);
  await assert.rejects(relay.prepareLocalModelRequest(request,catalog({reject:true})),/unavailable/i);
});
test('relay removes unsupported reasoning for standard nonreasoning models and caps tokens',async()=>{
  assert.equal(typeof relay.prepareLocalModelRequest,'function');
  const body=await relay.prepareLocalModelRequest({model:chosen,input:[],reasoning:{effort:'none'},max_output_tokens:99999},catalog({reasoning:false}));
  assert.equal(body.reasoning,undefined);assert.equal(body.max_output_tokens,2048);
  await assert.rejects(relay.prepareLocalModelRequest({input:[]},catalog()),/model/i);
});
test('relay rejects remote or ambiguous endpoints before opening a listener',async()=>{
  for(const upstream of ['https://api.example.com/v1/responses','http://localhost:1234/v1/responses','http://127.0.0.1:1234/other','http://user:secret@127.0.0.1:1234/v1/responses','http://127.0.0.1:1234/v1/responses?key=x','http://127.0.0.1:1234/v1/responses#x']){
    await assert.rejects(relay.createQwenRelay({upstream,localModels:catalog()}),/loopback|endpoint/i);
  }
});
