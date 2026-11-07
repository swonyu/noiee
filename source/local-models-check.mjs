import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./local-models.mjs').catch(() => null);
const MODEL = 'fixture/tool-model';
const llm = (key=MODEL, extra={}) => ({type:'llm',key,display_name:'Fixture model',loaded_instances:[{id:key,config:{context_length:65536}}],capabilities:{trained_for_tool_use:true,vision:true,reasoning:{allowed_options:['off','on']}},...extra});
function catalog(data, options={}) {
  assert.equal(typeof module?.LocalModelCatalog, 'function', 'shared local model catalog is implemented');
  const requests=[];
  const value = new module.LocalModelCatalog({upstream:'http://127.0.0.1:1234',fetchImpl:async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify(data),{status:200});},...options});
  return {value,requests};
}
test('loaded identity routes exact instance, using read-only loopback discovery',async()=>{
 const {value,requests}=catalog({models:[llm('disk-key',{loaded_instances:[{id:MODEL,config:{context_length:65536}}]})]});
 const found=await value.resolve(MODEL,{mode:'coding',effort:'high'});
 assert.equal(found.id,MODEL);assert.equal(found.key,'disk-key');assert.equal(found.state,'loaded');assert.equal(found.capabilities.coding,true);
 assert.deepEqual(found.generation,{max_tokens:-1,reasoning_effort:'high'});
 assert.equal(requests.length,1);assert.equal(requests[0].url,'http://127.0.0.1:1234/api/v1/models');assert.equal(requests[0].init.method,'GET');assert.equal(requests[0].init.redirect,'error');
 await assert.rejects(value.resolve('disk-key',{mode:'coding'}),error=>error.code==='MODEL_SELECTION_MISSING');
});
test('inventory distinguishes installed unloaded and unsupported, never loads them',async()=>{
 const {value,requests}=catalog({models:[llm('unloaded',{loaded_instances:[]}),llm('embedding',{type:'embedding',capabilities:{}})]});
 const result=await value.catalog();assert.equal(result.online,true);
 assert.equal(result.models.find(m=>m.id==='unloaded').state,'installed');assert.equal(result.models.find(m=>m.id==='embedding').state,'unsupported');
 await assert.rejects(value.resolve('unloaded',{mode:'chat'}),/not loaded/i);
 await assert.rejects(value.resolve('embedding',{mode:'chat'}),/unsupported|language model/i);
 assert.ok(requests.every(r=>r.init.method==='GET'));
});
test('missing saved model is rejected without substituting default or cloud',async()=>{
 const {value}=catalog({models:[llm()]});
 await assert.rejects(value.resolve('missing',{mode:'chat'}),error=>error.code==='MODEL_SELECTION_MISSING');
 await assert.rejects(value.resolve('https://paid.example/model',{mode:'chat'}),error=>error.code==='MODEL_SELECTION_MISSING');
});
test('chat-only text model cannot run tools or vision, and standard omits reasoning',async()=>{
 const {value}=catalog({models:[llm('text',{capabilities:{trained_for_tool_use:false,vision:false}})]});
 const row=await value.resolve('text',{mode:'chat'});assert.deepEqual(row.generation,{max_tokens:-1});
 await assert.rejects(value.resolve('text',{mode:'agent'}),/tool/i);
 await assert.rejects(value.resolve('text',{mode:'coding'}),/tool/i);
 await assert.rejects(value.resolve('text',{mode:'chat',vision:true}),/vision/i);
 await assert.rejects(value.resolve('text',{mode:'chat',effort:'high'}),/deep|reasoning/i);
});
test('unknown capability metadata never authorizes tool use',async()=>{
 const {value}=catalog({models:[llm('unknown',{capabilities:{}})]});
 await assert.rejects(value.resolve('unknown',{mode:'agent'}),/tool/i);
 await assert.rejects(value.resolve('unknown',{mode:'coding'}),/tool/i);
});
test('context and supported reasoning settings fail closed',async()=>{
 const {value}=catalog({models:[llm('small',{loaded_instances:[{id:'small',config:{context_length:8192}}]}),llm('always-on',{capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:['on']}}})]});
 await value.resolve('small',{mode:'chat'});
 await assert.rejects(value.resolve('small',{mode:'agent'}),/context/i);
 await assert.rejects(value.resolve('small',{mode:'coding'}),/context/i);
 await assert.rejects(value.resolve('small',{mode:'chat',effort:'high'}),/context|deep/i);
 await assert.rejects(value.resolve('always-on',{mode:'chat'}),error=>error.code==='MODEL_STYLE_UNAVAILABLE');
 await value.resolve('always-on',{mode:'chat',effort:'high'});
});
test('stale inventory is rechecked before every request',async()=>{
 let loaded=true;const {value}=catalog(null,{fetchImpl:async()=>new Response(JSON.stringify({models:[llm(MODEL,{loaded_instances:loaded?[{id:MODEL,config:{context_length:65536}}]:[]})]}))});
 await value.resolve(MODEL,{mode:'chat'});loaded=false;
 await assert.rejects(value.resolve(MODEL,{mode:'chat'}),/not loaded/i);
});
test('offline discovery is visible and never authorizes inference',async()=>{
 const {value}=catalog(null,{fetchImpl:async()=>{throw Error('offline');}});
 const result=await value.catalog();assert.equal(result.online,false);assert.deepEqual(result.models,[]);
 await assert.rejects(value.resolve(MODEL,{mode:'chat'}),error=>error.code==='LOCAL_MODEL_UNREACHABLE');
});
test('ambiguous instance identity and malformed inventory are rejected',async()=>{
 for(const models of [[llm(),llm('other',{loaded_instances:[{id:MODEL,config:{context_length:65536}}]})],[llm('',{})],Array.from({length:257},(_,i)=>llm(String(i)))]) {
  const {value}=catalog({models});assert.equal((await value.catalog()).online,false);
  await assert.rejects(value.resolve(MODEL,{mode:'chat'}),error=>['LOCAL_MODEL_AMBIGUOUS','LOCAL_MODEL_INVENTORY_INVALID'].includes(error.code));
 }
});
test('remote endpoints, redirects, credentials and oversized discovery cannot be used',async()=>{
 assert.equal(typeof module?.LocalModelCatalog,'function');
 for(const upstream of ['https://paid.example','http://localhost:1234','http://127.0.0.1:1234@paid.example','http://user:secret@127.0.0.1:1234','http://127.0.0.1:1234/v1','http://127.0.0.1:1234?x=1'])assert.throws(()=>new module.LocalModelCatalog({upstream}),/loopback/i);
 const {value}=catalog(null,{fetchImpl:async()=>new Response('x'.repeat(1024*1024+1))});assert.equal((await value.catalog()).online,false);
});
test('hostile labels remain data, invalid requested identities are rejected',async()=>{
 const {value}=catalog({models:[llm('safe',{display_name:'<img src=x onerror=alert(1)>'})]});
 assert.equal((await value.catalog()).models[0].label,'<img src=x onerror=alert(1)>');
 for(const id of ['',null,{},'x\nInjected','x'.repeat(201)])await assert.rejects(value.resolve(id,{mode:'chat'}),/invalid/i);
 await assert.rejects(value.resolve('safe',{mode:'unknown'}),/mode/i);
 await assert.rejects(value.resolve('safe',{mode:'chat',effort:'ultra'}),/effort/i);
});
test('a loaded instance without its own exact ID cannot borrow the disk key',async()=>{
 for(const id of [undefined,null,'']) {
  const {value}=catalog({models:[llm(MODEL,{loaded_instances:[{id,config:{context_length:65536}}]})]});
  assert.equal((await value.catalog()).online,false);
  await assert.rejects(value.resolve(MODEL,{mode:'coding'}),error=>error.code==='LOCAL_MODEL_INVENTORY_INVALID');
 }
});
test('conservative context budget reserves output and counts UTF-8 payload bytes',()=>{
 assert.equal(typeof module?.assertModelContext,'function','selected context budget is enforced');
 const selected={contextLength:8192};
 module.assertModelContext(selected,{messages:[{role:'user',content:'small'}],max_tokens:2048});
 assert.throws(()=>module.assertModelContext(selected,{messages:[{role:'user',content:'😀'.repeat(2000)}],max_tokens:2048}),/context budget/i);
 assert.throws(()=>module.assertModelContext(selected,{messages:[],max_tokens:8192}),/context budget/i);
 assert.throws(()=>module.assertModelContext({contextLength:null},{messages:[],max_tokens:2048}),/context/i);
});
test('Coding availability does not advertise unsupported always-on creation',async()=>{
 const {value}=catalog({models:[llm('always-on',{capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:['on']}}})]});
 const row=(await value.catalog()).models[0];
 assert.equal(row.capabilities.coding,false);assert.match(row.reasons.coding,/reasoning off/i);
 await assert.rejects(value.resolve('always-on',{mode:'coding',effort:'high'}),/reasoning off/i);
 await value.resolve('always-on',{mode:'agent',effort:'high'});
});
test('redirected inventory or redirect refusal never authorizes a selected model',async()=>{
 for(const kind of ['redirected-response','redirect-rejected','redirect-302']){
  const requests=[];
  const value=new module.LocalModelCatalog({upstream:'http://127.0.0.1:2345',fetchImpl:async(url,init)=>{
   requests.push(url);assert.equal(init.redirect,'error');
   if(kind==='redirect-rejected')throw Error('Redirect refused by transport.');
   if(kind==='redirect-302')return new Response(null,{status:302,headers:{Location:'https://paid.invalid'}});
   const response=Response.json({models:[llm()]});Object.defineProperty(response,'redirected',{value:true});return response;
  }});
  assert.equal((await value.catalog()).online,false);
  await assert.rejects(value.resolve(MODEL,{mode:'coding'}),error=>['LOCAL_MODEL_REDIRECT','LOCAL_MODEL_UNREACHABLE'].includes(error.code));
  assert.deepEqual(requests,['http://127.0.0.1:2345/api/v1/models','http://127.0.0.1:2345/api/v1/models']);
 }
});
for(const [options,expected] of [
 [['off','low','medium','xhigh','on'],'xhigh'],[['off','xhigh'],'xhigh'],
 [['off','medium','high'],'high'],[['off','low','medium'],'medium'],
 [['off','low'],'low'],[['off','on'],'high'],
])test('Deep uses the highest advertised reasoning setting: '+options.join(','),async()=>{
 const {value}=catalog({models:[llm(MODEL,{capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:options}}})]});
 const selected=await value.resolve(MODEL,{mode:'coding',effort:'high'});
 assert.equal(selected.id,MODEL);assert.equal(selected.capabilities.deep,true);
 assert.deepEqual(selected.reasoning.allowed_options,options);
 assert.equal(selected.generation.reasoning_effort,expected);
 assert.equal((await value.resolve(MODEL,{mode:'coding',effort:'none'})).generation.reasoning_effort,'none');
});
test('unknown reasoning grades cannot enable Deep or borrow a default grade',async()=>{
 const {value}=catalog({models:[llm(MODEL,{capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:['off','future-effort']}}})]});
 assert.equal((await value.catalog()).models[0].capabilities.deep,false);
 await assert.rejects(value.resolve(MODEL,{mode:'chat',effort:'high'}),/reasoning|deep/i);
 assert.equal((await value.resolve(MODEL,{mode:'chat'})).generation.reasoning_effort,'none');
});
test('Coding relay carries the selected Extra High grade and preserves input whitespace',async()=>{
 const {prepareLocalModelRequest}=await import('./coding-local.mjs');
 const {value}=catalog({models:[llm(MODEL,{capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:['off','xhigh','on']}}})]});
 const request={model:MODEL,reasoning:{effort:'high'},input:[{role:'user',content:'\n\n    Preserve these bytes.\n'}]};
 const prepared=await prepareLocalModelRequest(request,value);
 assert.equal(prepared.model,MODEL);assert.equal(prepared.reasoning.effort,'xhigh');
 assert.deepEqual(prepared.input,request.input);assert.equal(request.reasoning.effort,'high');
});
for(const profileFirst of [true,false])test('loaded profile ID may shadow an unloaded disk key, order '+profileFirst,async()=>{
 const raw=llm(MODEL,{loaded_instances:[]});
 const profile=llm('fixture/profile',{loaded_instances:[{id:MODEL,config:{context_length:131072}}],capabilities:{trained_for_tool_use:true,reasoning:{allowed_options:['off','xhigh','on']}}});
 const {value,requests}=catalog({models:profileFirst?[profile,raw]:[raw,profile]});
 const inventory=await value.catalog();assert.equal(inventory.online,true);
 assert.equal(inventory.models.filter(row=>row.id===MODEL).length,1);
 const selected=await value.resolve(MODEL,{mode:'coding',effort:'high'});
 assert.equal(selected.id,MODEL);assert.equal(selected.key,'fixture/profile');assert.equal(selected.loaded,true);
 assert.equal(selected.generation.reasoning_effort,'xhigh');assert(requests.every(r=>r.init.method==='GET'));
});
test('an unloaded name does not hide two conflicting loaded instances',async()=>{
 const raw=llm(MODEL,{loaded_instances:[]});
 const loaded=key=>llm(key,{loaded_instances:[{id:MODEL,config:{context_length:65536}}]});
 const {value}=catalog({models:[raw,loaded('fixture/a'),loaded('fixture/b')]});
 assert.equal((await value.catalog()).online,false);
 await assert.rejects(value.resolve(MODEL,{mode:'coding'}),/inventory|unavailable/i);
});
