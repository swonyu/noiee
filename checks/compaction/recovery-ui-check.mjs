// Actual recovery button gate and handler with capability-free fake native transport.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const SOURCE=fileURLToPath(new URL('../../source/coding.js',import.meta.url)),raw=fs.readFileSync(SOURCE,'utf8');
const gate=raw.split('\n').find(line=>line.includes("$('failed-startups').disabled ="));
const a=raw.indexOf("  $('failed-startups').onclick ="),b=raw.indexOf("  $('fork-chat').onclick",a);assert(gate&&a>=0&&b>a);
const rows=[];async function test(name,fn){await fn();rows.push(name);console.log('PASS '+name);}
function fixture(overrides={}){
 const nodes=new Map(),calls=[],messages=[],selections=[],node=id=>{if(!nodes.has(id))nodes.set(id,{disabled:false,textContent:''});return nodes.get(id);};
 const c=vm.createContext({$:node,bridge:true,acting:false,setupBlocking:()=>false,storageBlocked:false,attachmentReads:new Map(),attachmentStorage:{busy:false},selectedId:'old-chat',selectionEpoch:3,newModel:'fixture-model',localModels:{},disposed:false,window:{salehSaveBeforeLeave:()=>true},act:fn=>fn(),banner:(_id,text)=>messages.push(text),native:async input=>{calls.push(structuredClone(input));return {message:'Reviewed safely'};},select:async id=>selections.push(id),modelEligibility:()=>({ready:false}),...overrides},{codeGeneration:{strings:false,wasm:false}});
 vm.runInContext(gate+'\n'+raw.slice(a,b),c,{timeout:1000});
 return {nodes,calls,messages,selections,context:c,run:()=>node('failed-startups').onclick()};
}
await test('model-unready startup inspection is enabled without evaluating execution eligibility',()=>{const f=fixture({modelEligibility:()=>{throw Error('Inspection must not query model eligibility');}});assert.equal(f.nodes.get('failed-startups').disabled,false);});
for(const [name,overrides] of [['missing native bridge',{bridge:false}],['busy native action',{acting:true}],['tool setup in progress',{setupBlocking:()=>true}],['blocked chat storage',{storageBlocked:true}],['attachment read',{attachmentReads:new Map([['x',{}]])}],['attachment save',{attachmentStorage:{busy:true}}]])await test(name+' still disables inspection',()=>{assert.equal(fixture(overrides).nodes.get('failed-startups').disabled,true);});
await test('model-unready review sends no model and no task-start request',async()=>{const f=fixture();await f.run();assert.deepEqual(f.calls,[{op:'codingRecovery',input:{}}]);});
await test('ready continuation supplies only the explicitly selected model to native review',async()=>{const f=fixture({modelEligibility:()=>({ready:true})});await f.run();assert.deepEqual(f.calls,[{op:'codingRecovery',input:{model:'fixture-model'}}]);});
await test('unsaved current draft refuses review before calling native',async()=>{const f=fixture({window:{salehSaveBeforeLeave:()=>false}});await f.run();assert.equal(f.calls.length,0);});
await test('saved continuation can be selected without a ready model or creating another task',async()=>{const calls=[],f=fixture({native:async input=>{calls.push(structuredClone(input));return {existingThreadId:'saved-copy-chat',message:'Showing saved chat'};}});await f.run();assert.deepEqual(calls,[{op:'codingRecovery',input:{}}]);assert.deepEqual(f.selections,['saved-copy-chat']);});
console.log(JSON.stringify({passed:rows.length,failed:0,tests:rows,source:SOURCE,sourceSHA256:createHash('sha256').update(raw).digest('hex'),modelCalls:0,nativeUI:0,productImports:0,originalStore:0}));
