// LM Studio inventory is a read-only local observation, never a download/load request.
// Capability metadata admits a transport; it is not a model-quality guarantee.
import {createLocalModelHTTPTransport,validateLocalModelOrigin} from './local-model-http.mjs';
export {validateLocalModelOrigin} from './local-model-http.mjs';
export const DEFAULT_LOCAL_MODEL = 'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp';
const LIMIT = 1024 * 1024;
const REASONING_LEVELS = ['xhigh','high','medium','low'];
// Capture one immutable origin/transport for discovery and inference. Bare test
// catalogs may be used only with an explicitly supplied trusted local origin.
export function bindLocalModelTransport({upstream,localModels,fetchImpl}={}) {
  if(localModels&&typeof localModels.resolve!=='function')throw Error('Invalid trusted local model catalog.');
  if(localModels&&upstream===undefined&&localModels.upstream===undefined)throw Error('Trusted local model catalog requires an explicit loopback origin.');
  const origin=validateLocalModelOrigin(upstream??localModels?.upstream??'http://127.0.0.1:1234');
  if(localModels?.upstream!==undefined&&validateLocalModelOrigin(localModels.upstream)!==origin)throw Error('Local model catalog and inference endpoint origins must match.');
  if(fetchImpl!==undefined&&localModels?.fetchImpl!==undefined&&fetchImpl!==localModels.fetchImpl)throw Error('Local model catalog and inference transport must match.');
  const transport=fetchImpl??localModels?.fetchImpl??createLocalModelHTTPTransport(origin);
  if(typeof transport!=='function')throw Error('Invalid local model transport.');
  return Object.freeze({upstream:origin,fetchImpl:transport,localModels:localModels??new LocalModelCatalog({upstream:origin,fetchImpl:transport})});
}
export function validateModelID(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw Error('Invalid local model identity.');
  return value;
}
// LM Studio Chat uses -1 for no prediction-token cap; context and Stop still apply.
export function outputPolicy(options={}) {
  const {mode='chat',effort='none'}=options;
  if(!['chat','agent','coding'].includes(mode))throw Error('Invalid model mode.');
  if(!['none','high'].includes(effort))throw Error('Invalid model effort.');
  const long=Object.hasOwn(options,'longOutput');
  if(long&&(options.longOutput!==true||effort!=='none'||mode==='coding'))throw Error('Long answer requires longOutput: true, Standard reasoning, and Chat or Agent mode.');
  return {max_tokens:-1,deadlineMs:1800000};
}
function row(entry, instance) {
  const id = validateModelID(instance === null ? entry.key : instance.id), key = validateModelID(entry.key);
  const loaded = !!instance, llm = entry.type === 'llm';
  const contextLength = Number.isSafeInteger(instance?.config?.context_length) && instance.config.context_length > 0 ? instance.config.context_length : null;
  const reasoning = entry.capabilities?.reasoning;
  const options = Array.isArray(reasoning?.allowed_options) ? reasoning.allowed_options : [];
  const standard = reasoning == null || options.includes('off');
  const canReason = options.includes('on') || REASONING_LEVELS.some(value=>options.includes(value));
  const deep = canReason && contextLength >= 65536;
  const vision = llm && entry.capabilities?.vision === true;
  const tools = llm && entry.capabilities?.trained_for_tool_use === true;
  const reasons = {};
  for (const [mode, minimum] of [['chat',8192],['agent',32768],['coding',65536]]) {
    reasons[mode] = !llm ? 'Unsupported: this is not a language model.' : !loaded ? 'Installed, not loaded. Load this model in LM Studio, then refresh.' : mode !== 'chat' && !tools ? 'Unsupported: tool calling is not confirmed for this model.' : mode === 'coding' && !standard ? 'Unsupported: new Coding chats require a model that supports Standard reasoning.' : !(contextLength >= minimum) ? `Unsupported: ${mode} needs a loaded context of at least ${minimum.toLocaleString('en-US')} tokens.` : '';
  }
  reasons.deep = !canReason ? 'Deep reasoning is not supported by this model.' : !deep ? 'Deep needs a loaded context of at least 65,536 tokens.' : '';
  reasons.standard = standard ? '' : 'Standard is unsupported: this model cannot turn reasoning off. Choose Deep.';
  return {id,key,label:typeof entry.display_name==='string' && entry.display_name.length <= 200 ? entry.display_name : key,
    loaded,available:true,state:!llm?'unsupported':loaded?'loaded':'installed',contextLength,
    capabilities:{chat:!reasons.chat,agent:!reasons.agent,coding:!reasons.coding,standard,deep,vision,tools},reasons,
    // Private resolution data is not an inference instruction from the webpage.
    reasoning:reasoning == null ? null : {allowed_options:options.filter(v=>['off','on',...REASONING_LEVELS].includes(v))}};
}
export class LocalModelCatalog {
  constructor({upstream='http://127.0.0.1:1234',fetchImpl}={}) {
    const origin=validateLocalModelOrigin(upstream);
    if(fetchImpl===undefined)fetchImpl=createLocalModelHTTPTransport(origin);
    if(typeof fetchImpl!=='function')throw Error('Invalid model inventory transport.');
    Object.defineProperties(this,{upstream:{value:origin,enumerable:true},fetchImpl:{value:fetchImpl}});
  }
  // Request-scoped preparation cancellation adapted from Jan createModelOrAbort:
  // janhq/jan 2ff2c4f4f982740dd1cc3adbc33d292fe44b2339,
  // web-app/src/lib/custom-chat-transport.ts. Apache-2.0; see THIRD-PARTY-NOTICES.
  // Use fetch cancellation here; inventory never loads or unloads a model.
  async catalog({signal}={}) {
    signal?.throwIfAborted();
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
    try {
      const response=await this.fetchImpl(this.upstream+'/api/v1/models',{method:'GET',redirect:'error',signal:requestSignal,headers:{Accept:'application/json'}});
      if(requestSignal.aborted){await response.body?.cancel().catch(()=>{});requestSignal.throwIfAborted();}
      if(!response.ok || response.redirected)throw Error('Local model inventory unavailable.');
      if(Number(response.headers.get('content-length'))>LIMIT){await response.body?.cancel();throw Error('Local model inventory too large.');}
      const reader=response.body?.getReader();if(!reader)throw Error('Missing local model inventory.');
      let size=0;const chunks=[];
      try {while(true){const {done,value}=await reader.read();requestSignal.throwIfAborted();if(done)break;size+=value.byteLength;if(size>LIMIT)throw Error('Local model inventory too large.');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(!Array.isArray(data.models)||data.models.length>256)throw Error('Invalid local model inventory.');
      const models=[],loadedIDs=new Set(),keys=new Set();
      for(const entry of data.models){
        if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid local model inventory.');
        const key=validateModelID(entry.key);if(keys.has(key))throw Error('Ambiguous local model inventory.');keys.add(key);
        if(!Array.isArray(entry.loaded_instances)||entry.loaded_instances.length>16)throw Error('Invalid local model instances.');
        for(const instance of entry.loaded_instances.length?entry.loaded_instances:[null]){
          if(instance!==null&&(!instance||typeof instance!=='object'||Array.isArray(instance)))throw Error('Invalid local model instance.');
          const result=row(entry,instance);
          if(result.loaded){if(loadedIDs.has(result.id))throw Error('Ambiguous local model inventory.');loadedIDs.add(result.id);}
          models.push(result);
        }
      }
      // Loaded API identifiers and unloaded disk keys are separate namespaces.
      requestSignal.throwIfAborted();return {online:true,models:models.filter(value=>value.loaded||!loadedIDs.has(value.id))};
    }catch {signal?.throwIfAborted();return {online:false,models:[],message:'Local model inventory is unavailable. Open LM Studio and refresh. No model was substituted.'};}
  }
  async resolve(id,options={}) {
    const {mode='chat',effort='none',vision=false,signal}=options;
    validateModelID(id);
    const policy=outputPolicy(options),long=Object.hasOwn(options,'longOutput');
    if(typeof vision!=='boolean')throw Error('Invalid vision requirement.');
    const inventory=await this.catalog({signal});signal?.throwIfAborted();if(!inventory.online)throw Error(inventory.message);
    const selected=inventory.models.find(entry=>entry.id===id);
    if(!selected)throw Error('Selected local model is unavailable or not loaded. Select an installed, loaded model explicitly.');
    if(!selected.capabilities[mode])throw Error(selected.reasons[mode]);
    if(vision&&!selected.capabilities.vision)throw Error('Vision input is unsupported by the selected model.');
    if(effort==='high'&&!selected.capabilities.deep)throw Error(selected.reasons.deep);
    if(effort==='none'&&!selected.capabilities.standard)throw Error(selected.reasons.standard);
    if(long&&!(selected.contextLength>=65536))throw Error('Long answer needs a loaded context of at least 65,536 tokens.');
    const reasoningEffort=effort==='high' ? REASONING_LEVELS.find(value=>selected.reasoning?.allowed_options.includes(value))??'high' : 'none';
    return {...selected,generation:{max_tokens:policy.max_tokens,...(selected.reasoning!==null?{reasoning_effort:reasoningEffort}:{})}};
  }
}

// ponytail: conservative text-byte estimate; use the model tokenizer if needed.
// Callers validate image limits and vision support first. Image transfer bytes
// are not text tokens; the provider accounts for their actual vision-token cost.
export function assertModelContext(selected, payload) {
  const context = selected?.contextLength, output = payload?.max_tokens;
  if (!Number.isSafeInteger(context) || context <= 0 || !Number.isSafeInteger(output) || (output !== -1 && output <= 0)) throw Error('Selected model context budget is unavailable.');
  const textPayload = {...payload, messages: payload.messages.map(message => Array.isArray(message.content)
    ? {...message, content: message.content.map(part => part.type === 'image_url' ? {type:'image_url'} : part)}
    : message)};
  const bytes = new TextEncoder().encode(JSON.stringify(textPayload)).byteLength;
  const remaining=context-bytes-(output===-1?0:output)-1024;
  if (remaining < 0) throw Object.assign(Error('Request exceeds the conservative context budget for the selected model. Shorten the conversation or attachment, or load a larger context. No model was substituted.'),{code:'CONTEXT_BUDGET_EXCEEDED'});
  return remaining; // Remaining conservative text budget also sizes Agent compaction.
}
