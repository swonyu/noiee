import {cancelModelBody} from './model-response-cleanup.mjs';
import {assertCodingContext} from './coding-context.mjs';
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {bindLocalModelTransport,validateModelID} from './local-models.mjs';

// Local engine agent messages use input_text plus literal delegated bytes in
// encrypted_content. Lower only that typed envelope, never decode its strings
// or promote agent content into authoritative instructions.
function normalizeAgentMessage(item) {
  if(item?.type!=='agent_message')return item;
  const fail=()=>{throw Object.assign(Error('Unsupported local agent message envelope.'),{statusCode:400});};
  const fields=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
  const identity=value=>typeof value==='string'&&value.length>0&&!/[\x00-\x1f\x7f]/.test(value);
  if(!fields(item,['type','id','author','recipient','content','internal_chat_message_metadata_passthrough'])||!identity(item.author)||!identity(item.recipient))fail();
  if(item.id!==undefined&&item.id!==null&&!identity(item.id))fail();
  // This is the one installed-schema transport field; it has no model authority.
  const metadata=item.internal_chat_message_metadata_passthrough;
  if(metadata!==undefined&&metadata!==null&&(!fields(metadata,['turn_id'])||(metadata.turn_id!==undefined&&metadata.turn_id!==null&&!identity(metadata.turn_id))))fail();
  if(!Array.isArray(item.content)||item.content.length===0)fail();
  const content=item.content.map(part=>{
    if(part?.type==='input_text'&&fields(part,['type','text'])&&typeof part.text==='string')return {type:'input_text',text:part.text};
    if(part?.type==='encrypted_content'&&fields(part,['type','encrypted_content'])&&typeof part.encrypted_content==='string')return {type:'input_text',text:part.encrypted_content};
    fail();
  });
  return {type:'message',...(item.id!==undefined?{id:item.id}:{}),role:'user',content:[{type:'input_text',text:'Delegated agent message from '+JSON.stringify(item.author)+' to '+JSON.stringify(item.recipient)+'.'},...content]};
}

// Qwen's template accepts authority only at the beginning. Never promote user/tool text.
export function normalizeRoles(request) {
  const result=structuredClone(request),instructions=[result.instructions||''];
  if(!Array.isArray(result.input))return result;
  result.input=result.input.map(normalizeAgentMessage).filter(item=>{
    if(!['system','developer'].includes(item?.role))return true;
    const content=typeof item.content==='string'?[{type:'input_text',text:item.content}]:item.content;
    if(!Array.isArray(content)||content.some(part=>part?.type!=='input_text'||typeof part.text!=='string'))throw Error('Authoritative messages must contain text only.');
    instructions.push(...content.map(part=>part.text));return false;
  });
  result.instructions=instructions.filter(Boolean).join('\n\n');return result;
}

// Names are reversible only within this request. Never infer a call from model text.
function namespaceAdapter(body) {
  const tools=Array.isArray(body.tools)?body.tools:[],input=Array.isArray(body.input)?body.input:[];
  const namespaced=item=>item?.namespace!==undefined&&item.namespace!==null;
  if(!tools.some(tool=>tool?.type==='namespace')&&!input.some(item=>item?.type==='function_call'&&namespaced(item)))return null;
  const fail=message=>{throw Object.assign(Error(message),{statusCode:400});};
  // Only string choices are established by the engine's captured protocol.
  if(body.tool_choice&&typeof body.tool_choice!=='string')fail('Namespace adaptation supports string tool_choice only.');
  const valid=name=>typeof name==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(name);
  const plain=new Set(),declared=new Set(),namespaces=new Set(),mapping=new Map();
  for(const tool of tools)if(tool?.type!=='namespace'&&typeof tool?.name==='string'){
    if(declared.has(tool.name))fail('Duplicate tool name: '+tool.name);
    declared.add(tool.name);plain.add(tool.name);
  }
  for(const item of input)if(item?.type==='function_call'&&!namespaced(item))plain.add(item.name);
  const register=(namespace,name,duplicateOK=false)=>{
    if(!valid(namespace)||!valid(name))fail('Invalid namespace function name.');
    const flat=namespace+'__'+name,prior=mapping.get(flat);
    if(!valid(flat))fail('Flattened namespace function name exceeds 64 characters.');
    if(plain.has(flat)||(prior&&(!duplicateOK||prior.namespace!==namespace||prior.name!==name)))fail('Ambiguous namespace function name: '+flat);
    mapping.set(flat,{namespace,name});return flat;
  };
  body.tools=tools.flatMap(tool=>{
    if(tool?.type!=='namespace')return [tool];
    if(!valid(tool.name)||!Array.isArray(tool.tools))fail('Invalid namespace declaration.');
    if(namespaces.has(tool.name))fail('Duplicate namespace: '+tool.name);
    namespaces.add(tool.name);
    return tool.tools.map(child=>{
      if(child?.type!=='function'||namespaced(child))fail('Namespace members must be plain functions.');
      return {...child,name:register(tool.name,child.name)};
    });
  });
  const callable=new Map(mapping);
  const flatten=item=>{
    if(!namespaced(item))return item;
    const name=register(item.namespace,item.name,true),result={...item,name};delete result.namespace;return result;
  };
  if(Array.isArray(body.input))body.input=input.map(item=>item?.type==='function_call'?flatten(item):item);
  const restore=item=>{
    if(item?.type!=='function_call')return item;
    if(namespaced(item))throw Error('Unexpected namespace in local function call.');
    // Nameless partial items are not actions. A nonempty name must be declared.
    if(item.name===undefined||item.name===null||item.name==='')return item;
    const original=callable.get(item.name);
    if(!original&&!declared.has(item.name))throw Error('Undeclared local function call: '+item.name);
    return original?{...item,...original}:item;
  };
  const restoreResponse=response=>response&&Array.isArray(response.output)?{...response,output:response.output.map(restore)}:response;
  return value=>{
    if(!value||typeof value!=='object')return value;
    if(['response.output_item.added','response.output_item.done'].includes(value.type))return {...value,item:restore(value.item)};
    if(value.response)return {...value,response:restoreResponse(value.response)};
    return restoreResponse(value);
  };
}

// SSE records may cross UTF-8 and network chunk boundaries. The relay's existing
// 32 MiB response cap also bounds an unfinished record or final aggregate.
async function* restoreSSE(source,restore) {
  const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',scan=0,lines=[];
  const frame=()=>{
    const data=lines.filter(line=>line==='data'||line.startsWith('data:')).map(line=>line==='data'?'':line.slice(5).replace(/^ /,'')).join('\n');
    let output=lines;
    if(data&&data!=='[DONE]'){
      const encoded='data: '+JSON.stringify(restore(JSON.parse(data)));let inserted=false;
      output=lines.flatMap(line=>{
        if(line!=='data'&&!line.startsWith('data:'))return [line];
        if(inserted)return [];inserted=true;return [encoded];
      });
    }
    lines=[];return output.join('\n')+'\n\n';
  };
  for await(const chunk of source){
    pending+=decoder.decode(chunk,{stream:true});
    let start=0,i=scan;
    for(;i<pending.length;i++)if(pending[i]==='\n'||pending[i]==='\r'){
      if(pending[i]==='\r'&&i===pending.length-1)break;
      const line=pending.slice(start,i);
      if(pending[i]==='\r'&&pending[i+1]==='\n')i++;
      start=i+1;
      if(line==='')yield frame();else lines.push(line);
    }
    scan=i-start;pending=pending.slice(start);
  }
  pending+=decoder.decode();
  // A final lone CR is a complete newline; otherwise incomplete data is unsafe.
  if(pending.endsWith('\r')){const line=pending.slice(0,-1);if(line==='')yield frame();else lines.push(line);pending='';}
  if(pending||lines.length)throw Error('Coding SSE ended in an incomplete record.');
}

// Recheck the actual native request immediately before local dispatch. A saved
// selection is identity, not evidence that its loaded model is still available.
export async function prepareLocalModelRequest(request,localModels,{signal,expectedContextProfile}={}) {
  const model=validateModelID(request?.model),effort=request.reasoning?.effort??'none';
  if(!['none','high'].includes(effort))throw Object.assign(Error('Unsupported local reasoning effort.'),{statusCode:400});
  const vision=Array.isArray(request.input)&&request.input.some(item=>[item.content,item.output].some(parts=>Array.isArray(parts)&&parts.some(part=>part?.type==='input_image')));
  const selected=await localModels.resolve(model,{mode:'coding',effort,...(vision?{vision:true}:{}),...(signal?{signal}:{})});
  signal?.throwIfAborted();
  if(selected?.id!==model)throw Error('Local model inventory returned a different model identity.');
  if(expectedContextProfile!==undefined)assertCodingContext(selected,expectedContextProfile);
  const body=normalizeRoles(request),generation=selected.generation;
  if(body.temperature===undefined&&effort==='none')body.temperature=0;
  if(!generation||!Number.isSafeInteger(generation.max_tokens)||(generation.max_tokens!==-1&&generation.max_tokens<1))throw Error('Invalid local model generation policy.');
  if(body.max_output_tokens!==undefined&&(!Number.isSafeInteger(body.max_output_tokens)||body.max_output_tokens<1))throw Object.assign(Error('Invalid local output token limit.'),{statusCode:400});
  // Responses rejects -1. Omit Saleh's cap; retain an explicit caller limit.
  if(generation.max_tokens!==-1)body.max_output_tokens=Math.min(body.max_output_tokens??generation.max_tokens,generation.max_tokens);
  if(generation.reasoning_effort===undefined)delete body.reasoning;
  else body.reasoning={...body.reasoning,effort:generation.reasoning_effort};
  return body;
}

export async function createQwenRelay({upstream,localModels,fetchImpl,contextProfileForModel}={}) {
  if(contextProfileForModel!==undefined&&typeof contextProfileForModel!=='function')throw Error('Invalid trusted context profile binding.');
  let endpoint;
  if(upstream!==undefined){
    try{endpoint=new URL(upstream);}catch{throw Error('Local relay requires an HTTP loopback Responses endpoint.');}
    if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||endpoint.username||endpoint.password||endpoint.pathname!=='/v1/responses'||endpoint.search||endpoint.hash)throw Error('Local relay requires an HTTP loopback Responses endpoint without credentials, query, or fragment.');
  }
  const binding=bindLocalModelTransport({upstream:endpoint?.origin,localModels,fetchImpl});
  localModels=binding.localModels;fetchImpl=binding.fetchImpl;upstream=binding.upstream+'/v1/responses';
  const authToken=randomBytes(32).toString('hex'),authorization=Buffer.from('Bearer '+authToken),route='/v1/responses',active=new Set();
  const server=http.createServer(async(req,res)=>{
    if(req.headers.origin||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403).end();return;}
    if(req.method!=='POST'||req.url!==route||req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(404).end();return;}
    const supplied=Buffer.from(req.headers.authorization??'');
    if(supplied.length!==authorization.length||!timingSafeEqual(supplied,authorization)){res.writeHead(401).end();return;}
    const controller=new AbortController();active.add(controller);
    const timer=setTimeout(()=>controller.abort(),1800000);res.on('close',()=>controller.abort());
    try {
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw Error('Coding context exceeded 8 MiB.');chunks.push(chunk);}
      let request;try{request=JSON.parse(Buffer.concat(chunks));}catch(error){error.statusCode=400;throw error;}
      const body=await prepareLocalModelRequest(request,localModels,{signal:controller.signal,...(contextProfileForModel?{expectedContextProfile:contextProfileForModel(validateModelID(request?.model))}:{})});
      controller.signal.throwIfAborted();
      const restore=namespaceAdapter(body);
      const response=await fetchImpl(upstream,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
      if(response.redirected||response.status>=300&&response.status<400){cancelModelBody(response.body);throw Error('Local model redirects are not allowed.');}
      const headers={'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'};
      const write=async chunk=>{if(!res.headersSent)res.writeHead(response.status,headers);if(!res.write(chunk))await once(res,'drain',{signal:controller.signal});};
      if(response.body){
        async function* bounded(){let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;if(bytes>32*1024*1024)throw Error('Coding response exceeded 32 MiB.');yield chunk;}}
        const contentType=(response.headers.get('content-type')||'').split(';',1)[0].trim().toLowerCase();
        if(restore&&response.ok&&!['application/json','text/event-stream'].includes(contentType))throw Error('Unsupported local response content type for namespace adaptation.');
        if(restore&&response.ok&&contentType==='application/json'){
          const chunks=[];for await(const chunk of bounded())chunks.push(chunk);
          const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
          await write(JSON.stringify(restore(value)));
        }else{
          const source=restore&&response.ok&&contentType==='text/event-stream'?restoreSSE(bounded(),restore):bounded();
          for await(const chunk of source)await write(chunk);
        }
      }
      if(!res.headersSent)res.writeHead(response.status,headers);res.end();
    }catch(error){
      controller.abort();
      if(!res.destroyed){if(!res.headersSent){res.writeHead(error.statusCode||502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:error.message}}));}else res.destroy(error);}
    }finally{clearTimeout(timer);active.delete(controller);}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {baseURL:`http://127.0.0.1:${server.address().port}/v1`,authToken,close:async()=>{for(const c of active)c.abort();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
