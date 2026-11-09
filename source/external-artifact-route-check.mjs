import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {toolRoutes,nativeSignature,AGENT_TOOLS} from './agent.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'external-route-')),token=randomUUID(),route='/api/tools/externalArtifact';
const data=Buffer.from('throw Error("inert synthetic fixture")'),input={action:'install',url:'https://raw.githubusercontent.com/a/b/'+'a'.repeat(40)+'/x.mjs',sha256:createHash('sha256').update(data).digest('hex'),purpose:'Fixture'};
let calls=0,held=false,entered,enter,aborted=false;
const downloader=async(value,{signal})=>{calls++;assert.deepEqual(value,input);if(held){enter();await new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'))},{once:true}));}return {version:1,url:value.url,sha256:value.sha256,bytes:data.length,base64:data.toString('base64'),sourceTrust:'unreviewed-external'};};
function make(options={}){return toolRoutes({instanceToken:token,coding:{dataDir:directory,stop:async()=>({stopped:true})},hub:{stop:async()=>{}},worktrees:{stop:async()=>{}},gitWorkflow:{stop:async()=>{}},externalArtifactDownloader:downloader,...options});}
function headers(route,body){const nonce=randomUUID(),time=String(Date.now());return {'content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)};}
async function send(handler,input,{signed=true,provided,route:target=route,res=new EventEmitter()}={}){const body=JSON.stringify(input),req=Readable.from([Buffer.from(body)]);req.method='POST';req.headers=provided??(signed?headers(target,body):{'content-type':'application/json'});let answer;await handler(req,res,target,(status,value)=>{answer={status,value};res.writableEnded=true;});return answer;}
try{
 const handler=make();
 assert(AGENT_TOOLS.some(x=>x.function.name==='external_tool_artifact'));
 assert.equal((await send(handler,input,{signed:false})).status,403);assert.equal(calls,0);
 assert.equal((await send(handler,{...input,approved:true})).status,400);assert.equal(calls,0);
 const signed=headers(route,JSON.stringify(input));assert.equal((await send(handler,input,{provided:signed})).status,200);assert.equal(calls,1);
 assert.equal((await send(handler,input,{provided:signed})).status,403);assert.equal(calls,1);
 assert.equal((await send(handler,{action:'inspect'})).value.admitted,true);assert.equal(calls,1);
 assert.equal((await send(make({fullAccess:true,unconfinedBoot:false,recoveryStartup:true}),input)).status,409);assert.equal(calls,1);
 assert.equal((await send(make({fullAccess:false,unconfinedBoot:false}),input)).status,200,'clean reviewed boot may fetch inert data');assert.equal(calls,2);
 held=true;entered=new Promise(r=>enter=r);const pending=send(handler,input);await entered;
 const stop=send(handler,{coding:false},{route:'/api/tools/stop'});await pending;assert.equal((await stop).value.stopped,true);assert(aborted);
 held=false;
 const claims=[];handler.setDurableRuns({agentStep(){},agentDispatch(claim,operation,value){claims.push({claim,operation,value});return {check(){}};},revokeAgentClaims(){}});
 assert.equal((await send(handler,{...input,agentClaim:{test:'exact'}})).status,200);assert.equal(claims[0].operation,'externalArtifact');assert.deepEqual(claims[0].value,input);
 console.log('PASS: inert external artifact signed routes, replay/forgery, clean/recovery boot, Stop and exact Agent binding. No sockets, network or external execution.');
}finally{await rm(directory,{recursive:true,force:true});}
