import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setImmediate as tick } from 'node:timers/promises';

const moduleURL=new URL('./agent-stream.mjs',import.meta.url);
assert(existsSync(moduleURL),'The bounded completion parser must exist.');
const {readCompletion}=await import(moduleURL);
const encode=new TextEncoder();
const event=packet=>`data: ${typeof packet==='string'?packet:JSON.stringify(packet)}\r\n\r\n`;
const part=(delta={},finish_reason=null,index=0)=>({choices:[{index,delta,finish_reason}]});
const finish=event(part({},'stop'));
function response(text,{fragment=1,type='text/event-stream'}={}){
  const bytes=typeof text==='string'?encode.encode(text):text;let offset=0;
  return new Response(new ReadableStream({pull(c){if(offset===bytes.length)c.close();else{c.enqueue(bytes.slice(offset,offset+fragment));offset=Math.min(bytes.length,offset+fragment);}}}),{headers:{'Content-Type':type}});
}
async function rejects(text,pattern=/./,options={}){await assert.rejects(readCompletion(response(text,{fragment:37,...options})),pattern);}

const thoughts=[];
const wire=': heartbeat\r\n\r\n'+event(part({role:'assistant',reasoning_content:'أفكر 🌊'}))+event(part({content:'hé'}))+event(part({content:'llo'}))+finish+event({choices:[],usage:{total_tokens:7}})+event('[DONE]');
const basic=await readCompletion(response(wire),{onReasoning:async text=>{thoughts.push(text);await tick();}});
assert.deepEqual(thoughts,['أفكر 🌊']);assert.equal(basic.choices[0].message.content,'héllo');assert.equal(basic.choices[0].finish_reason,'stop');

// Escaped lone surrogates are valid UTF8 JSON but cannot enter durable text or tools.
for(const key of ['content','reasoning_content'])for(const text of ['\ud800','\udfff']){
 let emitted=0;
 await assert.rejects(readCompletion(response(event(part({[key]:text}))+finish),{onContent:()=>emitted++,onReasoning:()=>emitted++}),/encoding|formed|invalid/i);
 await assert.rejects(readCompletion(response(JSON.stringify({choices:[{message:{role:'assistant',[key]:text},finish_reason:'stop'}]}),{type:'application/json'}),{onContent:()=>emitted++,onReasoning:()=>emitted++}),/encoding|formed|invalid/i);
 assert.equal(emitted,0,'Malformed provider text must fail before callbacks');
}
for(const key of ['id','name','arguments']){
 const call={index:0,id:'call_safe',type:'function',function:{name:'safe',arguments:'{}'}};
 if(key==='id')call.id='\ud800';else call.function[key]='\ud800';
 await rejects(event(part({tool_calls:[call]},'tool_calls')),/encoding|formed|invalid/i);
}

// All SSE line endings must survive byte-sized UTF8 and CRLF chunk splits.
for(const ending of ['\n','\r','\r\n'])for(const fragment of [1,2,7,64]){
 const value=await readCompletion(response(wire.replace(/\r\n/g,ending),{fragment}));
 assert.deepEqual(value,basic,'Equivalent CR, LF and CRLF completion records');
}
assert.equal((await readCompletion(response((event(part({content:'Final CR'}))+finish).replace(/\r\n/g,'\r'),{fragment:1}))).choices[0].message.content,'Final CR');

// Tool fragments are returned only after actual stream EOF, even after [DONE].
let controller,settled=false;
const controlled=new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'Content-Type':'text/event-stream'}});
const pending=readCompletion(controlled).then(value=>{settled=true;return value;});
controller.enqueue(encode.encode(event(part({tool_calls:[{index:1,id:'call_b',type:'function',function:{name:'second',arguments:'{"b":'}},{index:0,id:'call_a',type:'function',function:{name:'first',arguments:'{"a":'}}]}))));
await tick();assert.equal(settled,false);
controller.enqueue(encode.encode(event(part({tool_calls:[{index:0,function:{arguments:'1}'}},{index:1,function:{arguments:'2}'}}]},'tool_calls'))+event('[DONE]')));
await tick();assert.equal(settled,false,'A finish marker must not release tool calls before EOF');controller.close();
const assembled=(await pending).choices[0];
assert.equal(assembled.finish_reason,'tool_calls');assert.deepEqual(assembled.message.tool_calls,[{id:'call_a',type:'function',function:{name:'first',arguments:'{"a":1}'}},{id:'call_b',type:'function',function:{name:'second',arguments:'{"b":2}'}}]);
const sixteen=Array.from({length:16},(_,index)=>({index,id:'call_'+index,type:'function',function:{name:'tool_'+index,arguments:'{}'}}));
assert.equal((await readCompletion(response(event(part({tool_calls:sixteen},'tool_calls'))))).choices[0].message.tool_calls.length,16);
const framed=Array.from({length:8000},()=>event({...part({reasoning_content:'x'}),id:'c'.repeat(100),model:'m'.repeat(100),object:'chat.completion.chunk',created:100})).join('')+finish;
assert.equal((await readCompletion(response(framed,{fragment:65536}))).choices[0].message.reasoning_content.length,8000,'Valid Deep SSE framing must not exhaust the semantic output budget');

// One framed event per generated token must fit the requested 32k output cap.
const longFramed=Array.from({length:32768},()=>event({...part({reasoning_content:'x'}),id:'c'.repeat(100),model:'m'.repeat(100),object:'chat.completion.chunk',created:100})).join('')+finish;
assert.equal((await readCompletion(response(longFramed,{fragment:65536}))).choices[0].message.reasoning_content.length,32768);
await rejects(':'+ 'x'.repeat(16*1024*1024),/wire limit/i,{fragment:65536});

const json={choices:[{message:{role:'assistant',content:'JSON answer',reasoning_content:'JSON thought'},finish_reason:'stop'}]};
const jsonThoughts=[];assert.deepEqual(await readCompletion(response(JSON.stringify(json),{type:'application/json',fragment:2}),{onReasoning:text=>jsonThoughts.push(text)}),json);assert.deepEqual(jsonThoughts,['JSON thought']);
assert.equal((await readCompletion(response(event(part({content:'EOF record'}))+`data: ${JSON.stringify(part({},'stop'))}`))).choices[0].message.content,'EOF record');
assert.equal((await readCompletion(response('data: {"choices":\n'+'data: [{"index":0,"delta":{"content":"multiline"},"finish_reason":"stop"}]}\n\n'))).choices[0].message.content,'multiline');

for(const reason of ['content_filter','error','unknown','function_call','',7]){
 await rejects(event(part({tool_calls:[{index:0,id:'bad',type:'function',function:{name:'run_command',arguments:'{}'}}]},reason)),/finish|unsupported/i);
 await rejects(JSON.stringify({choices:[{message:{content:'Partial answer'},finish_reason:reason}]}),/finish|unsupported/i,{type:'application/json'});
}
assert.equal((await readCompletion(response(event(part({content:'Partial'},'length'))))).choices[0].finish_reason,'length');
await rejects(event({error:{message:'upstream denied'}}),/upstream denied/);
await rejects('data: {broken}\n\n',/JSON|packet|stream/i);
await rejects(event(part({content:'partial'}))+event('[DONE]'),/incomplete|finish/i);
await rejects(event(part({content:'partial'})),/incomplete|finish/i);
await rejects(finish+event(part({content:'late'})),/after|terminal|finished/i);
await rejects(event('[DONE]')+event(part({content:'late'},'stop')),/after|terminal|finished/i);
await rejects(event({choices:'bad'}),/invalid|malformed/i);
await rejects(event(part({content:4}))+finish,/invalid|malformed/i);
await rejects(event(part({reasoning_content:{text:'bad'}}))+finish,/invalid|malformed/i);
await rejects(event(part({},7)),/invalid|malformed/i);
for(const index of [-1,16,0.5,'0',null])await rejects(event(part({tool_calls:[{index,function:{arguments:'{}'}}]}))+finish,/index/i);
await rejects(event(part({tool_calls:[{index:0,function:{arguments:{bad:true}}}]}))+finish,/invalid|malformed/i);
await rejects(event(part({tool_calls:[{index:0,id:'call',type:'other',function:{name:'x',arguments:'{}'}}]}))+finish,/invalid|malformed/i);
await rejects(event(part({tool_calls:[{index:0,function:{arguments:'{}'}}]},'tool_calls')),/incomplete|invalid/i);
await rejects(new Uint8Array([0x64,0x61,0x74,0x61,0x3a,0x20,0xff,0x0a,0x0a]),/encoded|encoding|UTF|valid/i);
await rejects(event(part({content:'x'.repeat(2*1024*1024+1)}))+finish,/large|limit/i,{fragment:65536});
await rejects(JSON.stringify({choices:[{message:{role:'assistant',content:'missing finish'}}]}),/incomplete|finish/i,{type:'application/json'});
await rejects(JSON.stringify({error:{message:'json denied'}}),/json denied/,{type:'application/json'});
await rejects(JSON.stringify({choices:[{message:{content:'x'.repeat(2*1024*1024+1)},finish_reason:'stop'}]}),/large|limit/i,{type:'application/json',fragment:65536});
await rejects(JSON.stringify({choices:[{message:{tool_calls:Array.from({length:17},()=>({id:'call',type:'function',function:{name:'tool',arguments:'{}'}}))},finish_reason:'tool_calls'}]}),/invalid/i,{type:'application/json'});

// Legacy calls are unsupported in both transports, before any callback.
for(const stream of [false,true]){
 const message={role:'assistant',content:'An unissued action completed.',reasoning_content:'Still working',function_call:{name:'tool',arguments:'{}'}};
 let callbacks=0;
 const raw=stream?event(part(message,'stop')):JSON.stringify({choices:[{message,finish_reason:'stop'}]});
 await assert.rejects(readCompletion(response(raw,{fragment:1,type:stream?'text/event-stream':'application/json'}),{onContent:()=>callbacks++,onReasoning:()=>callbacks++}),/invalid|unsupported/i);
 assert.equal(callbacks,0,'Legacy calls must be rejected before callbacks');
}

// A tool-call finish without a call cannot become a successful text answer.
for(const stream of [false,true])for(const tool_calls of [undefined,[]]){
 const message={role:'assistant',content:'\n\nUnverified completion claim',reasoning_content:'Still working',...(tool_calls?{tool_calls}:{})};
 let callbacks=0;
 const raw=stream?event(part(message,'tool_calls')):JSON.stringify({choices:[{message,finish_reason:'tool_calls'}]});
 await assert.rejects(readCompletion(response(raw,{fragment:1,type:stream?'text/event-stream':'application/json'}),{onContent:()=>callbacks++,onReasoning:()=>callbacks++}),/incomplete|invalid|tool call/i);
 if(!stream)assert.equal(callbacks,0,'Invalid JSON completion must be rejected before callbacks');
}

// Keep provider stop-with-tools compatibility and every reasoning/content byte.
const rawText='\n\n    KEEP 🌊\n',rawThought='  Thinking\n',validCall={id:'valid_call',type:'function',function:{name:'tool',arguments:'{}'}};
for(const stream of [false,true])for(const finish_reason of ['stop','tool_calls','length']){
 const message={role:'assistant',content:rawText,reasoning_content:rawThought,tool_calls:[validCall]},seen={content:'',reasoning:''};
 const raw=stream?event(part({...message,tool_calls:[{index:0,...validCall}]},finish_reason)):JSON.stringify({choices:[{message,finish_reason}]});
 const value=await readCompletion(response(raw,{fragment:1,type:stream?'text/event-stream':'application/json'}),{onContent:text=>seen.content+=text,onReasoning:text=>seen.reasoning+=text});
 assert.deepEqual(value.choices[0],{message,finish_reason});assert.deepEqual(seen,{content:rawText,reasoning:rawThought});
}

const cancelled=new AbortController();cancelled.abort();let emitted=0;
await assert.rejects(readCompletion(response(wire),{signal:cancelled.signal,onReasoning:()=>emitted++}),{name:'AbortError'});assert.equal(emitted,0);
const late=new AbortController();let waitingController,cancelledBody=false;
const waiting=new Response(new ReadableStream({start(c){waitingController=c;},cancel(){cancelledBody=true;}}),{headers:{'Content-Type':'text/event-stream'}});
const stopped=readCompletion(waiting,{signal:late.signal,onReasoning:()=>emitted++});
waitingController.enqueue(encode.encode(event(part({content:'before stop'}))));await tick();late.abort();await assert.rejects(stopped,{name:'AbortError'});assert.equal(cancelledBody,true);assert.equal(emitted,0);
const during=new AbortController();let callbackEntered=false,release;
const callbackGate=new Promise(resolve=>release=resolve);
const duringResult=readCompletion(response(event(part({reasoning_content:'first'}))+event(part({reasoning_content:'late'}))+finish,{fragment:65536}),{signal:during.signal,onReasoning:async()=>{emitted++;callbackEntered=true;await callbackGate;}});
await tick();assert(callbackEntered);during.abort();await assert.rejects(duringResult,{name:'AbortError'});release();assert.equal(emitted,1,'No later reasoning callback may run after Stop');
const jsonStop=new AbortController();await assert.rejects(readCompletion(response(JSON.stringify(json),{type:'application/json'}),{signal:jsonStop.signal,onReasoning:()=>jsonStop.abort()}),{name:'AbortError'});
console.log('PASS: fragmented UTF-8/CRLF and multiline SSE, awaited reasoning, indexed tool assembly only at EOF, JSON fallback, malformed/error/incomplete/late packet rejection, byte bounds and cancellation.');
