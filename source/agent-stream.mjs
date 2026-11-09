const LIMIT=2*1024*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Usage is optional provider telemetry, never evidence that a tool ran. Keep
// only bounded nonnegative counters; absent/invalid values remain unknown.
function usageCounters(value){
  if(!object(value))return null;
  const result={},counter=value=>Number.isSafeInteger(value)&&value>=0;
  for(const key of ['prompt_tokens','completion_tokens','total_tokens'])if(counter(value[key]))result[key]=value[key];
  for(const [key,fields] of [['prompt_tokens_details',['cached_tokens','audio_tokens']],['completion_tokens_details',['reasoning_tokens','audio_tokens','accepted_prediction_tokens','rejected_prediction_tokens']]]){
    if(!object(value[key]))continue;const details={};
    for(const field of fields)if(counter(value[key][field]))details[field]=value[key][field];
    if(Object.keys(details).length)result[key]=details;
  }
  return Object.keys(result).length?result:null;
}
function validateFinish(reason){if(!['stop','tool_calls','length'].includes(reason))throw new Error('Unsupported or invalid completion finish reason.');}
function validateMessage(message,finishReason){
  if(!object(message)||(message.role!=null&&message.role!=='assistant')||['content','reasoning_content'].some(k=>message[k]!=null&&typeof message[k]!=='string'))throw new Error('Invalid completion message.');
  if(message.function_call!=null)throw new Error('Invalid completion tool calls: legacy function_call is unsupported.');
  if(message.tool_calls!=null){
    if(!Array.isArray(message.tool_calls)||message.tool_calls.length>16)throw new Error('Invalid completion tool calls.');
    for(const call of message.tool_calls)if(!object(call)||typeof call.id!=='string'||!call.id||call.type!=='function'||!object(call.function)||typeof call.function.name!=='string'||!call.function.name||typeof call.function.arguments!=='string')throw new Error('Incomplete or invalid tool call.');
  }
  if(finishReason==='tool_calls'&&!message.tool_calls?.length)throw new Error('Incomplete completion: tool-call finish without a tool call.');
}
export async function readCompletion(response,{signal,onReasoning=()=>{},onContent=()=>{}}={}){
  signal?.throwIfAborted();
  const reader=response.body?.getReader();if(!reader)throw new Error('Incomplete completion: missing response body.');
  let rejectAbort;const aborted=new Promise((_,reject)=>{rejectAbort=reject;});aborted.catch(()=>{});
  let cancelled;const abort=()=>{cancelled??=reader.cancel().catch(()=>{});rejectAbort(signal.reason);};
  signal?.addEventListener('abort',abort,{once:true});
  const wait=async promise=>{const value=await Promise.race([promise,aborted]);signal?.throwIfAborted();return value;};
  const reasoning=async value=>{signal?.throwIfAborted();if(value)await wait(onReasoning(value));};
  const decoder=new TextDecoder('utf-8',{fatal:true}),stream=/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type')||'');
  let size=0,semantic=0,buffer='',scan=0,data=[],ended=false,terminal=false,done=false,finish_reason=null,content='',thought='',usage=null;const calls=new Map();
  const account=value=>{if(!(value??'').isWellFormed())throw new Error('Invalid completion text encoding: malformed Unicode.');semantic+=Buffer.byteLength(value||'','utf8');if(semantic>LIMIT)throw new Error('Completion text exceeds the 2 MiB limit.');};
  async function packet(){
    if(!data.length)return;const text=data.join('\n').trim();data=[];
    if(text==='[DONE]'){done=true;return;}
    const value=JSON.parse(text);
    if(!object(value))throw new Error('Malformed completion packet.');
    if(value.error)throw new Error(typeof value.error==='string'?value.error:value.error.message||'Upstream completion error.');
    if(!Array.isArray(value.choices)||value.choices.some(c=>!object(c)))throw new Error('Malformed completion choices.');
    if(value.usage!=null)usage=usageCounters(value.usage)??usage;
    if(!value.choices.length){if(object(value.usage))return;throw new Error('Malformed completion usage packet.');}
    if(terminal||done)throw new Error('Completion delta arrived after terminal finish.');
    const choice=value.choices.find(c=>c.index===0||c.index===undefined);if(!choice)return;
    const delta=choice.delta;
    if(!object(delta)||(delta.role!=null&&delta.role!=='assistant')||delta.function_call!=null||['content','reasoning_content'].some(k=>delta[k]!=null&&typeof delta[k]!=='string'))throw new Error('Invalid completion delta.');
    if(choice.finish_reason!=null)validateFinish(choice.finish_reason);
    if(delta.tool_calls!=null){
      if(!Array.isArray(delta.tool_calls))throw new Error('Invalid tool call fragments.');
      for(const fragment of delta.tool_calls){
        if(!object(fragment)||!Number.isInteger(fragment.index)||fragment.index<0||fragment.index>=16)throw new Error('Invalid tool call index.');
        if((fragment.type!=null&&fragment.type!=='function')||(fragment.id!=null&&typeof fragment.id!=='string')||(fragment.function!=null&&!object(fragment.function)))throw new Error('Invalid tool call fragment.');
        const f=fragment.function||{};if(['name','arguments'].some(k=>f[k]!=null&&typeof f[k]!=='string'))throw new Error('Invalid tool function fragment.');
        account(fragment.id);account(f.name);account(f.arguments);
        const call=calls.get(fragment.index)||{id:'',type:'function',function:{name:'',arguments:''}};
        call.id+=fragment.id||'';call.function.name+=f.name||'';call.function.arguments+=f.arguments||'';calls.set(fragment.index,call);
      }
    }
    account(delta.content);account(delta.reasoning_content);content+=delta.content||'';thought+=delta.reasoning_content||'';
    if(choice.finish_reason!=null){finish_reason=choice.finish_reason;terminal=true;}
    await reasoning(delta.reasoning_content);if(delta.content)await wait(onContent(delta.content));
  }
  async function line(value){
    if(value==='')await packet();
    else if(value.startsWith('data:'))data.push(value.slice(5).replace(/^ /,''));
  }
  async function lines(eof=false){
    let start=0,i=scan;
    for(;i<buffer.length;i++)if(buffer[i]==='\n'||buffer[i]==='\r'){
      if(buffer[i]==='\r'&&i===buffer.length-1&&!eof)break;
      const text=buffer.slice(start,i);
      if(buffer[i]==='\r'&&buffer[i+1]==='\n')i++;
      start=i+1;await line(text);
    }
    scan=i-start;buffer=buffer.slice(start);
  }
  try{
    while(true){
      const {value,done:atEnd}=await wait(reader.read());
      if(atEnd){ended=true;buffer+=decoder.decode();break;}
      size+=value.byteLength;if(size>8*LIMIT)throw new Error('Completion stream exceeds the 16 MiB wire limit.');
      buffer+=decoder.decode(value,{stream:true});
      if(stream)await lines();
    }
    if(!stream){
      const value=JSON.parse(buffer);if(value?.error)throw new Error(typeof value.error==='string'?value.error:value.error.message||'Upstream completion error.');
      const choice=value?.choices?.[0];if(!object(value)||!Array.isArray(value.choices)||!choice||typeof choice.finish_reason!=='string'||!choice.finish_reason)throw new Error('Incomplete completion: missing finish reason.');
      validateFinish(choice.finish_reason);validateMessage(choice.message,choice.finish_reason);account(choice.message.content);account(choice.message.reasoning_content);for(const c of choice.message.tool_calls||[]){account(c.id);account(c.function.name);account(c.function.arguments);}await reasoning(choice.message.reasoning_content);if(choice.message.content)await wait(onContent(choice.message.content));signal?.throwIfAborted();return value;
    }
    await lines(true);if(buffer)await line(buffer);await packet();
    if(!finish_reason)throw new Error('Incomplete completion stream: missing finish reason.');
    const ordered=[...calls].sort((a,b)=>a[0]-b[0]);if(ordered.some(([index],i)=>index!==i))throw new Error('Incomplete tool call indices.');
    const message={role:'assistant',content:content||null,...(thought?{reasoning_content:thought}:{}),...(ordered.length?{tool_calls:ordered.map(([,call])=>call)}:{})};
    validateMessage(message,finish_reason);signal?.throwIfAborted();return {choices:[{message,finish_reason}],...(usage?{usage}:{})};
  }finally{
    signal?.removeEventListener('abort',abort);
    // Cancellation requests close the reader synchronously, but an underlying
    // source's cleanup promise can remain pending. Never let cleanup hold Stop
    // or a parsing failure hostage; no successful tool result escapes this path.
    if(!ended)void (cancelled??reader.cancel().catch(()=>{}));
    reader.releaseLock();
  }
}
