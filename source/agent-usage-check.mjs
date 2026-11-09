import assert from 'node:assert/strict';
import {readCompletion} from './agent-stream.mjs';
const event=value=>'data: '+JSON.stringify(value)+'\n\n';
const choice=(delta,finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
function stream(parts){
  const bytes=new TextEncoder().encode(parts.join(''));let position=0;
  return new Response(new ReadableStream({pull(controller){
    if(position===bytes.length)return controller.close();
    controller.enqueue(bytes.slice(position,position+3));position=Math.min(bytes.length,position+3);
  }}),{headers:{'Content-Type':'text/event-stream'}});
}
const finish=event(choice({},'stop'));
const stats={prompt_tokens:71,completion_tokens:19,total_tokens:90,prompt_tokens_details:{cached_tokens:12},completion_tokens_details:{reasoning_tokens:7}};
const result=await readCompletion(stream([event(choice({role:'assistant',content:'Verified reply'})),finish,event({choices:[],usage:stats}),'data: [DONE]\n\n']));
assert.equal(result.choices[0].message.content,'Verified reply');assert.deepEqual(result.usage,stats);
const missing=await readCompletion(stream([event(choice({content:'No counts'})),finish]));
assert.equal(Object.hasOwn(missing,'usage'),false,'Missing counts must not become fabricated zero usage');
const zero=await readCompletion(stream([event({...choice({content:'Zero'}),usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}),finish]));
assert.deepEqual(zero.usage,{prompt_tokens:0,completion_tokens:0,total_tokens:0});
const bad=await readCompletion(stream([event(choice({content:'Still valid'})),finish,event({choices:[],usage:{prompt_tokens:-1,completion_tokens:'3',total_tokens:1e40,untrusted_payload:'discard',completion_tokens_details:{reasoning_tokens:-4}}})]));
assert.equal(Object.hasOwn(bad,'usage'),false,'Malformed optional telemetry does not contaminate output or invalidate text');
const snapshots=await readCompletion(stream([event({...choice({content:'Final counters'}),usage:{total_tokens:3}}),finish,event({choices:[],usage:stats})]));
assert.deepEqual(snapshots.usage,stats,'Counters are snapshots, not summed duplicate charges');
await assert.rejects(readCompletion(stream([event({choices:[],usage:stats}),'data: [DONE]\n\n'])),/missing finish reason/i,'Usage does not establish completed generation');
await assert.rejects(readCompletion(stream([event(choice({tool_calls:[{index:0,id:'a',type:'function',function:{name:'read',arguments:'{}'}}]},'tool_calls')),event({choices:[],usage:stats}),event(choice({content:'late'}))])),/after terminal/i,'Usage must not relax tool EOF/terminal rules');
console.log('PASS: seven streamed-usage checks: complete/zero/absent/invalid counts, cumulative snapshots, missing finish and late tool-content rejection.');
