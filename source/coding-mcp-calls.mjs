import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const MAX_BYTES=65536,MAX_NODES=8192,MAX_DEPTH=32,MAX_FENCES=4096;
const DEFAULTS=Object.freeze({maxPending:32,maxRequests:4096,approvalMs:300000});
const plain=v=>v!==null&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
function exact(value,keys){return plain(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function identifier(value,label,max=160){if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid '+label);return value;}
function freeze(value){if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value;}
function jsonCopy(value){
 let nodes=0;const seen=new Set();
 function visit(v,depth){
  if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw Error('JSON depth/node limit exceeded');
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
  if((!plain(v)&&!Array.isArray(v))||seen.has(v))throw Error('Invalid or cyclic JSON value');
  seen.add(v);for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))){if(Array.isArray(v)&&key==='length')continue;if(!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)throw Error('Invalid JSON accessor/property');visit(descriptor.value,depth+1);}seen.delete(v);
 }
 visit(value,0);const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>MAX_BYTES)throw Error('JSON size limit exceeded');return JSON.parse(encoded);
}
const failure=text=>freeze({contentItems:[{type:'inputText',text}],success:false});
const cancelled=attempted=>failure(attempted?'MCP call cancelled. Its action may still have happened; completion is unknown. Check the target before any new approval.':'MCP call cancelled before execution. No tool call was sent.');
function resultText(value){
 const unsupported=()=>failure('MCP result contains unsupported, truncated or over-limit content. The tool may have completed; this bridge cannot report its full result.');
 if(!plain(value)||!Array.isArray(value.content)||(!value.content.length&&value.structuredContent===undefined)||value.content.length>64||value.truncated||value.image!==undefined||value.images!==undefined||value.omittedBinaryContent)return unsupported();
 let bytes=0;const contentItems=[];
 for(const item of value.content){if(!plain(item)||item.type!=='text'||typeof item.text!=='string')return unsupported();bytes+=Buffer.byteLength(item.text);if(bytes>MAX_BYTES)return unsupported();contentItems.push({type:'inputText',text:item.text});}
 if(value.structuredContent!==undefined){
  if(!plain(value.structuredContent))return unsupported();
  let text;try{text='MCP structured content (JSON):\n'+JSON.stringify(jsonCopy(value.structuredContent));}catch{return unsupported();}
  bytes+=Buffer.byteLength(text);if(bytes>MAX_BYTES)return unsupported();contentItems.push({type:'inputText',text});
 }
 if(value.connectionWarning!==undefined){if(typeof value.connectionWarning!=='string')return unsupported();const text='MCP connection warning: '+value.connectionWarning;bytes+=Buffer.byteLength(text);if(bytes>MAX_BYTES)return unsupported();contentItems.push({type:'inputText',text});}
 if(value.isError!==undefined&&typeof value.isError!=='boolean')return unsupported();
 const result={contentItems,success:!value.isError};if(Buffer.byteLength(JSON.stringify(result))>MAX_BYTES)return unsupported();return freeze(result);
}

/** One instance per immutable engine process generation. Does not connect, execute
 * automatically, authorize native review, replay, or restore capabilities.
 * See checks/CODING-MCP-CALLS.md for the host callback and retirement contract. */
export class CodingMCPCalls {
 #generation;#hub;#reply;#onPending;#isCurrent;#isCallCurrent;#outcomes;#journalFailed=false;#limits;#closed=false;#disposing;
 #entries=new Map();#rpcIds=new Set();#callIds=new Set();#turns=new Set();#threads=new Set();#work=new Set();
 constructor({generation,hub,reply,onPending,isCurrent,isCallCurrent=()=>true,outcomes=null,limits={}}={}){
  this.#generation=identifier(generation,'process generation');
  if(!hub||typeof hub.prepareCall!=='function'||typeof hub.call!=='function'||typeof reply!=='function'||typeof onPending!=='function'||typeof isCurrent!=='function')throw Error('Invalid Coding MCP coordinator dependencies');
  if(typeof isCallCurrent!=='function'||outcomes!==null&&(!outcomes||!['beginAttempt','recordNotSent','recordProvider','recordDelivery','onFailure'].every(k=>typeof outcomes[k]==='function')))throw Error('Invalid Coding MCP outcome dependencies');
  if(!plain(limits)||Object.keys(limits).some(k=>!Object.hasOwn(DEFAULTS,k)))throw Error('Invalid Coding MCP limits');
  this.#limits=Object.freeze({...DEFAULTS,...limits});for(const [k,v] of Object.entries(this.#limits))if(!Number.isSafeInteger(v)||v<1||v>DEFAULTS[k])throw Error('Invalid Coding MCP limit '+k);
  this.#hub=hub;this.#reply=reply;this.#onPending=onPending;this.#isCurrent=isCurrent;this.#isCallCurrent=isCallCurrent;this.#outcomes=outcomes;
 }
 get generation(){return this.#generation;}
 #current(){try{return !this.#closed&&!this.#journalFailed&&this.#isCurrent()===true;}catch{return false;}}
 #fenced(e){try{return e.cancelled||!this.#current()||this.#isCallCurrent({threadId:e.threadId,turnId:e.turnId,callId:e.callId,rpcId:e.rpcId})!==true||this.#threads.has(e.threadId)||this.#turns.has(JSON.stringify([e.threadId,e.turnId]));}catch{return true;}}
 #track(promise){const work=Promise.resolve(promise).finally(()=>this.#work.delete(work));this.#work.add(work);void work.catch(()=>{});return work;}
 #envelope(e){return freeze({key:e.key,generation:this.#generation,threadId:e.threadId,turnId:e.turnId,callId:e.callId,rpcId:e.rpcId,descriptor:jsonCopy(e.prepared),expiresAt:e.expiresAt});}
 #metadata(e){return freeze({processGeneration:this.#generation,threadId:e.threadId,turnId:e.turnId,callId:e.callId,rpcId:e.rpcId,server:e.descriptor.server,name:e.descriptor.name});}
 #persistenceFailure(e,error){e.persistenceFailed=true;const first=!this.#journalFailed;this.#journalFailed=true;if(first)try{this.#outcomes.onFailure(error);}catch{};}
 async #provider(e,state){if(!this.#outcomes)return;try{await this.#outcomes.recordProvider(e.attemptToken,{state});}catch(error){this.#persistenceFailure(e,error);throw error;}}
 pending(){return freeze([...this.#entries.values()].filter(e=>e.state==='pending'&&!this.#fenced(e)).map(e=>this.#envelope(e)));}
 status(){return freeze({generation:this.#generation,closed:this.#closed,active:this.#entries.size,pending:this.pending().length,retained:this.#work.size,admitted:this.#rpcIds.size});}
 async admit(input){
  if(!this.#current()){this.cancelProcess();throw Error('Coding MCP process generation is closed or no longer owned');}
  if(!exact(input,['threadId','turnId','callId','rpcId','descriptor']))throw Error('Invalid dynamic MCP request');
  const {threadId,turnId,callId,rpcId}=input;for(const [name,value] of Object.entries({threadId,turnId,callId}))identifier(value,name);
  if(typeof rpcId==='string')identifier(rpcId,'RPC ID');else if(!Number.isSafeInteger(rpcId))throw Error('Invalid RPC ID');
  if(!exact(input.descriptor,['server','name','arguments']))throw Error('Invalid MCP descriptor');
  identifier(input.descriptor.server,'MCP server',100);identifier(input.descriptor.name,'MCP tool',256);if(!plain(input.descriptor.arguments))throw Error('Invalid MCP JSON arguments');
  const descriptor=freeze(jsonCopy(input.descriptor));
  const rpcKey=JSON.stringify([typeof rpcId,rpcId]),callKey=JSON.stringify([threadId,turnId,callId]);
  if(this.#rpcIds.has(rpcKey)||this.#callIds.has(callKey))throw Error('Duplicate dynamic MCP protocol request');
  if(this.#threads.has(threadId)||this.#turns.has(JSON.stringify([threadId,turnId])))throw Error('Coding MCP turn or thread is cancelled and fenced');
  if(this.#entries.size>=this.#limits.maxPending||this.#rpcIds.size>=this.#limits.maxRequests)throw Error('Coding MCP protocol overload limit reached');
  const e={key:randomUUID(),threadId,turnId,callId,rpcId,descriptor,state:'preparing',controller:new AbortController(),cancelled:false,attempted:false,replied:false,expiresAt:Date.now()+this.#limits.approvalMs};
  e.done=new Promise(resolve=>{e.resolve=resolve;});this.#rpcIds.add(rpcKey);this.#callIds.add(callKey);this.#entries.set(e.key,e);
  await this.#track(this.#prepare(e));return Object.freeze({key:e.key,done:e.done});
 }
 async #prepare(e){
  try{
   const prepared=await this.#hub.prepareCall(e.descriptor);
   if(this.#fenced(e)){e.cancelled=true;return this.#settle(e,cancelled(false),'cancelled',false);}
   if(!exact(prepared,['id','server','name','arguments'])||!Object.isFrozen(prepared)||typeof prepared.id!=='string'||!/^[a-f0-9]{48}$/.test(prepared.id)||!isDeepStrictEqual({server:prepared.server,name:prepared.name,arguments:prepared.arguments},e.descriptor))throw Error('Invalid prepared MCP identity');
   e.prepared=prepared;e.state='pending';const remaining=e.expiresAt-Date.now();
   if(remaining<=0)return this.#settle(e,failure('MCP approval expired. No tool call was sent.'),'expired');
   e.timer=setTimeout(()=>{if(e.state==='pending'){e.state='settling';void this.#track(this.#settle(e,failure('MCP approval expired. No tool call was sent.'),'expired'));}},remaining);e.timer.unref?.();
   const notified=this.#onPending(this.#envelope(e));
   if(notified!==undefined){if(notified&&typeof notified.then==='function')void this.#track(Promise.resolve(notified).catch(()=>{}));throw Error('Native pending notification must synchronously enqueue');}
  }catch{
   if(e.state==='running'||e.state==='settling'||e.state==='settled')return;
   if(this.#fenced(e)){e.cancelled=true;return this.#settle(e,cancelled(false),'cancelled',false);}
   return this.#settle(e,failure('MCP call could not be prepared for native review. No tool call was sent.'),'failed');
  }
 }
 approve(key,decision){
  if(!this.#current()){this.cancelProcess();throw Error('Coding MCP owner or process generation changed');}
  if(decision!=='accept'&&decision!=='decline')throw Error('Invalid MCP approval decision');
  const e=this.#entries.get(key);if(!e||e.state!=='pending'||this.#fenced(e))throw Error('Stale, used or non-pending MCP approval');
  clearTimeout(e.timer);
  if(Date.now()>=e.expiresAt){e.state='settling';void this.#track(this.#settle(e,failure('MCP approval expired. No tool call was sent.'),'expired'));throw Error('Stale expired MCP approval');}
  e.state=decision==='accept'?'running':'settling';
  if(decision==='decline')void this.#track(this.#settle(e,failure('MCP call declined. The tool request was not sent.'),'declined'));
  else void this.#track(this.#execute(e));
  return Object.freeze({key,state:decision==='accept'?'running':'declined'});
 }
 async #execute(e){
  let result,status;
  try{
   if(this.#fenced(e)){e.cancelled=true;return await this.#settle(e,cancelled(false),'cancelled',false);}
   if(this.#outcomes){
    // An uncertain intent write must never be replaced with a false not-sent receipt.
    e.intentStarted=true;
    try{e.attemptToken=await this.#outcomes.beginAttempt(this.#metadata(e));if(!e.attemptToken||typeof e.attemptToken!=='object'||!Object.isFrozen(e.attemptToken))throw Error('Invalid durable attempt token');}
    catch(error){this.#persistenceFailure(e,error);throw error;}
    if(this.#fenced(e)||e.controller.signal.aborted){e.cancelled=true;await this.#provider(e,'not_sent');return await this.#settle(e,cancelled(false),'cancelled',false);}
   }
   let provider;
   e.attempted=true;
   try{
    const value=await this.#hub.call(e.descriptor,{signal:e.controller.signal,prepared:e.prepared});
    result=resultText(value);status=result.success?'completed':'failed';provider=value?.isError===true?'returned_error':result.success?'returned_ok':'unsupported';
   }catch{result=failure('MCP call failed. Completion is unconfirmed; no retry was made.');status='failed';provider='unknown';}
   // Old-attempt evidence remains owned after Stop. Persist the observation
   // before deciding whether this process is still entitled to receive it.
   await this.#provider(e,provider);
   if(this.#fenced(e)||e.controller.signal.aborted){e.cancelled=true;return await this.#settle(e,cancelled(e.attempted),'cancelled',false);}
  }catch{
   return this.#settle(e,failure('MCP outcome persistence is unconfirmed. Dispatch or completion evidence may be unavailable; inspect the task before any retry.'),'failed',false);
  }
  return this.#settle(e,result,status);
 }
 async #settle(e,result,status,deliver=true){
  if(e.state==='settled')return;e.state='settling';clearTimeout(e.timer);let delivered=false,deliveryFailed=false;
  if(this.#outcomes&&!e.intentStarted&&!this.#journalFailed){
   try{e.attemptToken=await this.#outcomes.recordNotSent(this.#metadata(e),{reason:status==='declined'?'declined':status==='expired'?'expired':status==='cancelled'?'cancelled':'refused'});if(!e.attemptToken||typeof e.attemptToken!=='object'||!Object.isFrozen(e.attemptToken))throw Error('Invalid durable attempt token');}
   catch(error){this.#persistenceFailure(e,error);}
  }
  let delivery='withheld';
  if(deliver&&!e.replied&&!e.persistenceFailed&&!this.#fenced(e)){
   e.replied=true;
   try{await this.#reply(freeze({generation:this.#generation,threadId:e.threadId,turnId:e.turnId,callId:e.callId,rpcId:e.rpcId,result}),Object.freeze({signal:e.controller.signal}));delivered=true;delivery='written';}catch(error){deliveryFailed=true;delivery=error?.codingMCPDelivery==='written'?'written':error?.codingMCPDelivery==='withheld'?'withheld':'failed';}
  }
  if(this.#outcomes&&e.attemptToken&&!this.#journalFailed)try{await this.#outcomes.recordDelivery(e.attemptToken,{state:delivery});}catch(error){this.#persistenceFailure(e,error);}
  e.state='settled';this.#entries.delete(e.key);e.prepared=null;e.descriptor=null;
  e.resolve(freeze({key:e.key,status,result,delivered,deliveryFailed,...(e.persistenceFailed?{persistenceFailed:true}:{})}));
 }
 #cancel(e){
  if(e.state==='settled'||e.cancelled)return;e.cancelled=true;clearTimeout(e.timer);e.controller.abort();
  if(e.state==='pending'){e.state='settling';void this.#track(this.#settle(e,cancelled(false),'cancelled',false));}
 }
 cancelTurn(threadId,turnId){
  identifier(threadId,'threadId');identifier(turnId,'turnId');if(this.#turns.size+this.#threads.size>=MAX_FENCES)return this.cancelProcess();
  this.#turns.add(JSON.stringify([threadId,turnId]));for(const e of this.#entries.values())if(e.threadId===threadId&&e.turnId===turnId)this.#cancel(e);
 }
 cancelThread(threadId){
  identifier(threadId,'threadId');if(this.#turns.size+this.#threads.size>=MAX_FENCES)return this.cancelProcess();
  this.#threads.add(threadId);for(const e of this.#entries.values())if(e.threadId===threadId)this.#cancel(e);
 }
 cancelProcess(){this.#closed=true;for(const e of this.#entries.values())this.#cancel(e);}
 dispose(){
  this.cancelProcess();return this.#disposing??=(async()=>{while(this.#work.size)await Promise.allSettled([...this.#work]);if(this.#entries.size)throw Error('Coding MCP retained work did not settle');return Object.freeze({generation:this.#generation,settled:true});})();
 }
}
