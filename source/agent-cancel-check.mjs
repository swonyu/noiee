import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompletion} from './agent-stream.mjs';
const encode=new TextEncoder(),pending=()=>new Promise(()=>{});
const packet=value=>'data: '+JSON.stringify(value)+'\n\n';
const choice=(delta={},finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
function fixture({wire='',cancel=pending,close=false}={}){
 let cancellations=0;
 const body=new ReadableStream({start(controller){if(wire)controller.enqueue(encode.encode(wire));if(close)controller.close();},cancel(){cancellations++;return cancel();}});
 return {response:new Response(body,{headers:{'content-type':'text/event-stream'}}),cancelled:()=>cancellations};
}
async function settles(operation){
 let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Completion remained blocked by cleanup')),500);})]);}finally{clearTimeout(timer);}
}
test('Stop rejects promptly and releases its reader while source cancellation remains pending',async()=>{
 const f=fixture(),controller=new AbortController(),reason=Error('Explicit Stop');
 const operation=readCompletion(f.response,{signal:controller.signal});controller.abort(reason);
 await assert.rejects(settles(operation),error=>error===reason);
 assert.equal(f.cancelled(),1);assert.equal(f.response.body.locked,false);
});
test('a model deadline is not extended by stuck source cleanup',async()=>{
 const f=fixture(),controller=new AbortController(),reason=Error('Model deadline');
 const operation=readCompletion(f.response,{signal:controller.signal});queueMicrotask(()=>controller.abort(reason));
 await assert.rejects(settles(operation),error=>error===reason);assert.equal(f.cancelled(),1);
});
test('malformed packets fail promptly even when cancellation cleanup stalls',async()=>{
 const f=fixture({wire:'data: {invalid}\n\n'});
 await assert.rejects(settles(readCompletion(f.response)),SyntaxError);
 assert.equal(f.cancelled(),1);assert.equal(f.response.body.locked,false);
});
test('callback failure is preserved rather than waiting for transport cleanup',async()=>{
 const reason=Error('Persistence callback failed'),f=fixture({wire:packet(choice({content:'answer'}))});
 await assert.rejects(settles(readCompletion(f.response,{onContent:()=>{throw reason;}})),error=>error===reason);
 assert.equal(f.cancelled(),1);assert.equal(f.response.body.locked,false);
});
test('Stop during a pending callback never emits later chunks or returns tool calls',async()=>{
 const controller=new AbortController();let entered,callbacks=0;const ready=new Promise(r=>entered=r);
 const f=fixture({wire:packet(choice({reasoning_content:'first'}))+packet(choice({content:'late',tool_calls:[{index:0,id:'call',type:'function',function:{name:'tool',arguments:'{}'}}]},'tool_calls'))});
 const operation=readCompletion(f.response,{signal:controller.signal,onReasoning:()=>{callbacks++;entered();return pending();},onContent:()=>callbacks++});
 await ready;controller.abort();await assert.rejects(settles(operation),{name:'AbortError'});
 assert.equal(callbacks,1);assert.equal(f.cancelled(),1);assert.equal(f.response.body.locked,false);
});
test('rejected cleanup cannot replace the parser error or become an unhandled rejection',async()=>{
 const f=fixture({wire:'data: {invalid}\n\n',cancel:()=>Promise.reject(Error('cleanup rejected'))});
 await assert.rejects(settles(readCompletion(f.response)),SyntaxError);
 await new Promise(r=>setImmediate(r));assert.equal(f.cancelled(),1);
});
test('normal EOF returns verified content without cancelling the completed body',async()=>{
 const f=fixture({wire:packet(choice({content:'complete'},'stop')),close:true});
 assert.equal((await settles(readCompletion(f.response))).choices[0].message.content,'complete');
 assert.equal(f.cancelled(),0);assert.equal(f.response.body.locked,false);
});
