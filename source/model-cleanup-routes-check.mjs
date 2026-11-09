// In-memory HTTP handlers only. No app, sockets, models or original stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createServer} from './server.mjs';
import {createQwenRelay} from './coding-local.mjs';
class Reply extends EventEmitter{
 headers={};headersSent=false;destroyed=false;parts=[];
 setHeader(k,v){this.headers[k.toLowerCase()]=v;}
 writeHead(code,headers={}){this.statusCode=code;for(const [k,v]of Object.entries(headers))this.setHeader(k,v);this.headersSent=true;return this;}
 flushHeaders(){this.headersSent=true;}
 write(x){this.parts.push(Buffer.from(x));return true;}
 end(x){if(x!==undefined)this.write(x);this.finished=true;this.writableEnded=true;return this;}
 get json(){return JSON.parse(Buffer.concat(this.parts).toString());}
}
const models={upstream:'http://127.0.0.1:1234',async resolve(id){return {id,contextLength:262144,generation:{max_tokens:-1}};}};
function fixture(status){let release,count=0;const p=new Promise(r=>release=r);return {release,count:()=>count,response:new Response(new ReadableStream({cancel(){count++;return p;}}),{status})};}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('route blocked by cleanup')),500))]);}finally{clearTimeout(timer);}}
const inert={stop:async()=>({stopped:true}),close:async()=>({stopped:true})};
for(const status of [302,503])test('legacy Chat rejects HTTP'+status+' promptly without body output',async()=>{
 const f=fixture(status),server=createServer({instanceToken:'fixture',localModels:models,fetchImpl:async()=>f.response,hub:{...inert},coding:{...inert,dataDir:'/tmp/noiee-cleanup-unused'},worktrees:{...inert},gitWorkflow:{...inert}});
 const req=Readable.from([Buffer.from(JSON.stringify({model:'fixture',messages:[{role:'user',content:'Synthetic only'}]}))]);
 Object.assign(req,{url:'/api/chat',method:'POST',headers:{host:'127.0.0.1:8787','content-type':'application/json','x-qwen-chat':'1'},socket:{localPort:8787}});const res=new Reply();
 try{await bounded(server.listeners('request')[0](req,res));assert(res.finished);assert.equal(res.statusCode,502);assert.match(res.json.error,status===302?/redirect/:/HTTP 503/);assert.equal(f.count(),1);}finally{f.release();}
});
test('Tasks relay rejects redirect before response bytes even with pending cleanup',async()=>{
 const f=fixture(302),original=http.createServer;let handler;
 class MemoryServer extends EventEmitter{listen(){queueMicrotask(()=>this.emit('listening'));}address(){return {port:34567};}closeAllConnections(){}close(cb){cb();}}
 http.createServer=callback=>{handler=callback;return new MemoryServer();};let relay;
 try{
  relay=await createQwenRelay({upstream:'http://127.0.0.1:1234/v1/responses',localModels:models,fetchImpl:async()=>f.response});
  const url=new URL(relay.baseURL+'/responses'),req=Readable.from([Buffer.from(JSON.stringify({model:'fixture',input:[{role:'user',content:'Synthetic only'}]}))]);
  Object.assign(req,{url:url.pathname,method:'POST',headers:{host:url.host,authorization:'Bearer '+relay.authToken}});const res=new Reply();
  await bounded(handler(req,res));assert(res.finished);assert.equal(res.statusCode,502);assert.match(res.json.error.message,/redirect/);assert.equal(f.count(),1);
 }finally{f.release();http.createServer=original;await relay?.close();}
});
