import {createHash} from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const VERSION=1,NAMESPACE='saleh_mcp_v1';
const LIMITS=Object.freeze({tools:128,schemaBytes:16384,definitionBytes:65536,snapshotBytes:131072,argumentBytes:65536,descriptionBytes:4096,depth:32,nodes:8192});
const plain=value=>value!==null&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const hash=value=>createHash('sha256').update(value).digest('hex');
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(plain(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
const encoded=value=>JSON.stringify(canonical(value));
function copyJSON(value,maxBytes,label){
 let nodes=0;const active=new Set();
 function visit(v,depth){
  if(++nodes>LIMITS.nodes||depth>LIMITS.depth)throw Error(label+' JSON depth/node limit exceeded');
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
  if((!plain(v)&&!Array.isArray(v))||active.has(v))throw Error('Invalid or cyclic '+label+' JSON');
  const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
  if(keys.some(key=>typeof key!=='string'))throw Error('Invalid '+label+' JSON symbol key');
  if(Array.isArray(v)&&(keys.length!==v.length+1||keys.some(key=>key!=='length'&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=v.length))))throw Error('Invalid '+label+' JSON array');
  active.add(v);for(const key of keys){if(Array.isArray(v)&&key==='length')continue;const d=descriptors[key];if(!Object.hasOwn(d,'value')||!d.enumerable)throw Error('Invalid '+label+' JSON accessor/property');visit(d.value,depth+1);}active.delete(v);
 }
 visit(value,0);if(bytes(value)>maxBytes)throw Error(label+' JSON size limit exceeded');return JSON.parse(JSON.stringify(value));
}
function identity(value,label,max=160){if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw Error('Invalid '+label+' identity');return value;}
function compile(schema){
 if(!plain(schema)||schema.type!=='object')throw Error('Invalid MCP input schema: an explicit object type is required');
 if(bytes(schema)>LIMITS.schemaBytes)throw Error('MCP input schema size limit exceeded');
 // Match MCPHub's offline inline-schema policy. This does not resolve references,
 // access network/disk, coerce values, insert defaults, or remove properties.
 JSON.stringify(schema,(key,value)=>{if(['$ref','$dynamicRef','$recursiveRef','$async'].includes(key))throw Error('Unsupported schema reference or asynchronous schema');return value;});
 const dialect=typeof schema.$schema==='string'?schema.$schema.replace(/#$/,''):schema.$schema;
 const options={strict:true,strictRequired:false,allowUnionTypes:true,allErrors:false};
 let validator;if(dialect===undefined||dialect==='https://json-schema.org/draft/2020-12/schema')validator=new Ajv2020(options);else if(dialect==='http://json-schema.org/draft-07/schema')validator=new Ajv(options);else throw Error('Unsupported JSON Schema dialect');
 addFormats(validator);try{return validator.compile(schema);}catch{throw Error('Invalid or unsupported inline JSON Schema');}
}

/** Pure registry adapter. The host must supply a complete, verified catalog;
 * no listing, provider connection, execution, approval, or persistence occurs.
 * Persist snapshot() bound to the exact owner/thread before admitting work.
 * Require matches(savedSnapshot) before resume/fork dispatch. A fingerprint or
 * matching tool name alone is not sufficient. Raw RPC IDs stay with the caller.
 * APIs/bounds and validation receipts: checks/coding-mcp-registry-receipt.json. */
export function createCodingMCPRegistry(catalog){
 if(!Array.isArray(catalog))throw Error('Invalid MCP catalog: a complete array is required');
 if(catalog.length>LIMITS.tools)throw Error('MCP catalog tool limit exceeded (128)');
 const entries=copyJSON(catalog,LIMITS.snapshotBytes,'catalog');
 const logical=new Set(),routes=new Map();
 for(const row of entries){
  if(!exact(row,['server','name','description','inputSchema']))throw Error('Invalid or incomplete MCP catalog entry');
  if(typeof row.server!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(row.server))throw Error('Invalid MCP catalog server identity');
  identity(row.name,'MCP catalog tool',256);
  if(typeof row.description!=='string'||row.description.includes('\0')||Buffer.byteLength(row.description)>LIMITS.descriptionBytes)throw Error('Invalid MCP catalog description or description limit exceeded');
  const key=JSON.stringify([row.server,row.name]);if(logical.has(key))throw Error('Duplicate MCP catalog tool identity');logical.add(key);
 }
 // Code-unit order is deterministic and independent of machine locale.
 entries.sort((a,b)=>a.server<b.server?-1:a.server>b.server?1:a.name<b.name?-1:a.name>b.name?1:0);
 const tools=entries.map(row=>{
  const name='t_'+createHash('sha256').update(JSON.stringify([row.server,row.name])).digest('base64url');
  if(name.length>64||!/^[A-Za-z0-9_-]+$/.test(name)||routes.has(name))throw Error('MCP native tool name collision or invalid mapping');
  const validate=compile(row.inputSchema);routes.set(name,{row,validate});
  return {type:'function',name,description:'MCP server: '+row.server+'\nTool: '+row.name+'\n'+row.description,inputSchema:row.inputSchema};
 });
 const dynamicTools=tools.length?[{type:'namespace',name:NAMESPACE,description:'Explicitly registered Coding MCP tools; every call requires host review.',tools}]:[];
 if(bytes(dynamicTools)>LIMITS.definitionBytes)throw Error('MCP registration definition size limit exceeded (64 KiB)');
 const data=canonical({version:VERSION,namespace:NAMESPACE,catalog:entries,dynamicTools});
 const fingerprint=hash(JSON.stringify(data));
 // Validate the complete duplicated snapshot as well as its source catalog, so
 // every accepted registry can compare its own persisted snapshot after reload.
 const snapshot=freeze(copyJSON({...data,fingerprint},LIMITS.snapshotBytes,'snapshot'));
 const snapshotText=encoded(snapshot);
 // Freeze private routes' source data too; no caller can change later resolution.
 for(const {row} of routes.values())freeze(row);
 const registrations=freeze(dynamicTools);
 return Object.freeze({
  version:VERSION,fingerprint,dynamicTools:registrations,
  snapshot(){return snapshot;},
  matches(saved){
   try{const checked=copyJSON(saved,LIMITS.snapshotBytes,'snapshot');return exact(checked,['version','namespace','catalog','dynamicTools','fingerprint'])&&encoded(checked)===snapshotText;}catch{return false;}
  },
  resolve(request){
   if(!exact(request,['method','params'])||request.method!=='item/tool/call'||!exact(request.params,['threadId','turnId','callId','namespace','tool','arguments']))throw Error('Invalid dynamic MCP request method or shape');
   const p=request.params;for(const key of ['threadId','turnId','callId'])identity(p[key],key);
   if(p.namespace!==NAMESPACE)throw Error('Invalid dynamic MCP namespace');
   if(typeof p.tool!=='string'||!routes.has(p.tool))throw Error('Unknown dynamic MCP tool');
   if(!plain(p.arguments))throw Error('MCP arguments must be a JSON object');
   const args=copyJSON(p.arguments,LIMITS.argumentBytes,'arguments'),{row,validate}=routes.get(p.tool);
   if(!validate(args))throw Error('MCP arguments do not match the registered input schema');
   return freeze({threadId:p.threadId,turnId:p.turnId,callId:p.callId,descriptor:{server:row.server,name:row.name,arguments:args}});
  },
 });
}
