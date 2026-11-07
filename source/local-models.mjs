// LM Studio inventory is a read-only local observation, never a download/load request.
// Capability metadata admits a transport; it is not a model-quality guarantee.
import {createLocalModelHTTPTransport,validateLocalModelOrigin} from './local-model-http.mjs';
import './model-policy.js';
export {validateLocalModelOrigin} from './local-model-http.mjs';
export const {DEFAULT_LOCAL_MODEL,MIN_CONTEXT,contextProfile,responseStyleInstructions}=globalThis.NoieeModelPolicy;
const LIMIT=1024*1024;
const REASONING_LEVELS=['xhigh','high','medium','low'];
const failure=(code,message,status)=>Object.assign(Error(message),{code,...(status?{inventoryStatus:status}:{})});
// One immutable loopback origin/transport is shared by discovery and inference.
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
  if(typeof value!=='string'||!value.trim()||value.length>200||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid local model identity.');
  return value;
}
// All response styles retain the deliberate no-fixed-response-cap policy.
export function outputPolicy(options={}) {
  const {mode='chat',effort='none'}=options;
  if(!['chat','agent','coding'].includes(mode))throw Error('Invalid model mode.');
  if(!['none','high'].includes(effort))throw Error('Invalid model effort.');
  if(Object.hasOwn(options,'longOutput')&&(options.longOutput!==true||effort!=='none'||mode==='coding'))throw Error('Detailed requires longOutput: true, reasoning off, and Chat or Agent mode.');
  return {max_tokens:-1,deadlineMs:1800000};
}
function row(entry,instance) {
  const id=validateModelID(instance===null?entry.key:instance.id),key=validateModelID(entry.key);
  const loaded=!!instance,llm=entry.type==='llm';
  const contextLength=Number.isSafeInteger(instance?.config?.context_length)&&instance.config.context_length>0?instance.config.context_length:null;
  const reasoning=entry.capabilities?.reasoning;
  const options=Array.isArray(reasoning?.allowed_options)?reasoning.allowed_options:[];
  const standard=reasoning==null||options.includes('off');
  const canReason=options.includes('on')||REASONING_LEVELS.some(value=>options.includes(value));
  const deep=llm&&loaded&&canReason&&contextLength>=MIN_CONTEXT.deep;
  const vision=llm&&entry.capabilities?.vision===true,tools=llm&&entry.capabilities?.trained_for_tool_use===true;
  const reasons={};
  for(const mode of ['chat','agent','coding']) {
    const label=mode==='coding'?'Tasks':mode==='agent'?'Agent':'Chat';
    reasons[mode]=!llm?'This is not a language model.':!loaded?'Installed, not loaded. Load this exact model in LM Studio, then refresh.':mode!=='chat'&&!tools?'Tool calling is not confirmed for this model.':mode==='coding'&&!standard?'Tasks require a model that supports reasoning off.':!(contextLength>=MIN_CONTEXT[mode])?label+' needs a loaded context of at least '+MIN_CONTEXT[mode].toLocaleString('en-US')+' tokens.':'';
  }
  reasons.deep=!canReason?'Deep reasoning is not supported by this model.':!loaded?'Load this exact model in LM Studio, then refresh.':!deep?'Deep reasoning needs at least '+MIN_CONTEXT.deep.toLocaleString('en-US')+' loaded tokens to reserve reasoning context.':'';
  reasons.standard=standard?'':'Concise and Detailed require a model that can turn reasoning off. Choose Deep reasoning.';
  return {id,key,label:typeof entry.display_name==='string'&&entry.display_name.length<=200?entry.display_name:key,loaded,available:true,state:!llm?'unsupported':loaded?'loaded':'installed',contextLength,
    capabilities:{chat:!reasons.chat,agent:!reasons.agent,coding:!reasons.coding,standard,deep,vision,tools},reasons,
    profiles:!reasons.coding?{coding:contextProfile(contextLength,{mode:'coding'})}:{},
    reasoning:reasoning==null?null:{allowed_options:options.filter(value=>['off','on',...REASONING_LEVELS].includes(value))}};
}
export class LocalModelCatalog {
  constructor({upstream='http://127.0.0.1:1234',fetchImpl}={}) {
    const origin=validateLocalModelOrigin(upstream);
    if(fetchImpl===undefined)fetchImpl=createLocalModelHTTPTransport(origin);
    if(typeof fetchImpl!=='function')throw Error('Invalid model transport.');
    Object.defineProperties(this,{upstream:{value:origin,enumerable:true},fetchImpl:{value:fetchImpl}});
  }
  // Request-scoped cancellation adapted from Jan createModelOrAbort:
  // janhq/jan 2ff2c4f4f982740dd1cc3adbc33d292fe44b2339,
  // web-app/src/lib/custom-chat-transport.ts. Apache-2.0; see THIRD-PARTY-NOTICES.
  // Inventory never loads or unloads a model.
  async catalog({signal}={}) {
    signal?.throwIfAborted();
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000);
    let connected=false;
    try {
      const response=await this.fetchImpl(this.upstream+'/api/v1/models',{method:'GET',redirect:'error',signal:requestSignal,headers:{Accept:'application/json'}});
      connected=true;
      if(requestSignal.aborted){await response.body?.cancel().catch(()=>{});requestSignal.throwIfAborted();}
      if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel();throw failure('LOCAL_MODEL_REDIRECT','LM Studio redirected its inventory response. The configured local endpoint was kept.','invalid');}
      if(!response.ok) {
        await response.body?.cancel();
        if([401,403].includes(response.status))throw failure('LOCAL_MODEL_AUTH_REQUIRED','LM Studio requires authentication for model inventory. Check its API access settings; no credentials or model were changed.','authentication');
        throw failure('LOCAL_MODEL_HTTP_ERROR','LM Studio model inventory returned HTTP '+response.status+'. Check the local server, then refresh.','server-error');
      }
      if(Number(response.headers.get('content-length'))>LIMIT){await response.body?.cancel();throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio model inventory exceeds its size limit.','invalid');}
      const reader=response.body?.getReader();if(!reader)throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio returned an empty model inventory response.','invalid');
      let size=0;const chunks=[];
      try {while(true){const {done,value}=await reader.read();requestSignal.throwIfAborted();if(done)break;size+=value.byteLength;if(size>LIMIT)throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio model inventory exceeds its size limit.','invalid');chunks.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
      let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio model inventory is not valid UTF-8 JSON.','invalid');}
      if(!Array.isArray(data.models)||data.models.length>256)throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio model inventory has an unsupported schema or size.','invalid');
      const models=[],loadedIDs=new Set(),keys=new Set();
      for(const entry of data.models) {
        if(!entry||typeof entry!=='object'||Array.isArray(entry))throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio returned an invalid model entry.','invalid');
        let key;try{key=validateModelID(entry.key);}catch{throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio returned an invalid model identity.','invalid');}
        if(keys.has(key))throw failure('LOCAL_MODEL_AMBIGUOUS','LM Studio returned duplicate model identities. Model selection is paused until the inventory is unambiguous.','ambiguous');keys.add(key);
        if(!Array.isArray(entry.loaded_instances)||entry.loaded_instances.length>16)throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio returned an invalid loaded-instance list.','invalid');
        for(const instance of entry.loaded_instances.length?entry.loaded_instances:[null]) {
          if(instance!==null&&(!instance||typeof instance!=='object'||Array.isArray(instance)))throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio returned an invalid loaded model instance.','invalid');
          let result;try{result=row(entry,instance);}catch{throw failure('LOCAL_MODEL_INVENTORY_INVALID','LM Studio returned invalid model metadata.','invalid');}
          if(result.loaded){if(loadedIDs.has(result.id))throw failure('LOCAL_MODEL_AMBIGUOUS','LM Studio returned duplicate loaded model identities. Model selection is paused until the inventory is unambiguous.','ambiguous');loadedIDs.add(result.id);}
          models.push(result);
        }
      }
      const visible=models.filter(value=>value.loaded||!loadedIDs.has(value.id));
      requestSignal.throwIfAborted();
      return {online:true,connected:true,status:'ready',defaultModel:visible.some(value=>value.id===DEFAULT_LOCAL_MODEL)?DEFAULT_LOCAL_MODEL:null,models:visible};
    } catch(error) {
      signal?.throwIfAborted();
      const timeout=requestSignal.aborted;
      const code=timeout?'LOCAL_MODEL_TIMEOUT':error.inventoryStatus?error.code:(connected?'LOCAL_MODEL_INVENTORY_INVALID':'LOCAL_MODEL_UNREACHABLE');
      const status=timeout?'timeout':error.inventoryStatus??(connected?'invalid':'offline');
      const message=timeout?'LM Studio model inventory timed out. The selected model was kept; refresh to retry.':error.inventoryStatus?error.message:connected?'LM Studio returned an invalid model inventory. Check compatibility, then refresh.':'LM Studio is not reachable at the configured local endpoint. Open its local server, then refresh.';
      return {online:false,connected,status,models:[],error:{code,message},message};
    }
  }
  async resolve(id,options={}) {
    const {mode='chat',effort='none',vision=false,signal}=options;
    validateModelID(id);const policy=outputPolicy(options);
    if(typeof vision!=='boolean')throw Error('Invalid vision requirement.');
    const inventory=await this.catalog({signal});signal?.throwIfAborted();
    if(!inventory.online)throw failure(inventory.error?.code??'LOCAL_MODEL_INVENTORY_UNAVAILABLE',inventory.message);
    const selected=inventory.models.find(entry=>entry.id===id);
    if(!selected)throw failure('MODEL_SELECTION_MISSING','The selected local model is missing. Choose an installed model explicitly; no substitute will be used.');
    if(!selected.loaded)throw failure('MODEL_NOT_LOADED','The selected local model is installed but not loaded. Load this exact model in LM Studio, then refresh.');
    if(!selected.capabilities[mode])throw failure('MODEL_MODE_UNAVAILABLE',selected.reasons[mode]);
    if(vision&&!selected.capabilities.vision)throw failure('MODEL_VISION_UNAVAILABLE','Vision input is unsupported by the selected model.');
    if(effort==='high'&&!selected.capabilities.deep)throw failure('MODEL_STYLE_UNAVAILABLE',selected.reasons.deep);
    if(effort==='none'&&!selected.capabilities.standard)throw failure('MODEL_STYLE_UNAVAILABLE',selected.reasons.standard);
    const reasoningEffort=effort==='high'?REASONING_LEVELS.find(value=>selected.reasoning?.allowed_options.includes(value))??'high':'none';
    return {...selected,contextProfile:contextProfile(selected.contextLength,{mode,effort,longOutput:options.longOutput===true}),generation:{max_tokens:policy.max_tokens,...(selected.reasoning!==null?{reasoning_effort:reasoningEffort}:{})}};
  }
}
// Conservative text accounting, with explicit headroom even for uncapped output.
// This is not an exact tokenizer; the provider still enforces its actual context.
export function assertModelContext(selected,payload) {
  const context=selected?.contextLength,output=payload?.max_tokens;
  if(!Number.isSafeInteger(context)||context<=0||!Number.isSafeInteger(output)||(output!==-1&&output<=0))throw Error('Selected model context budget is unavailable.');
  const textPayload={...payload,messages:payload.messages.map(message=>Array.isArray(message.content)?{...message,content:message.content.map(part=>part.type==='image_url'?{type:'image_url'}:part)}:message)};
  const bytes=new TextEncoder().encode(JSON.stringify(textPayload)).byteLength;
  const reserve=output===-1?(selected.contextProfile?.responseReserve??4096):output;
  const safety=selected.contextProfile?.safetyReserve??1024;
  const remaining=context-bytes-reserve-safety;
  if(remaining<0)throw failure('CONTEXT_BUDGET_EXCEEDED','This request exceeds the context budget reserved for the answer. Compact earlier messages, shorten the attachment, or choose a larger loaded context. Saved history and the selected model were kept.');
  return remaining;
}
