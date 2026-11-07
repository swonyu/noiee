// Actual parent pipe and signal checks. Only disposable child processes and ports.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from './server.mjs';
import {nativeSignature} from './agent.mjs';
import {randomUUID} from 'node:crypto';
import {LocalModelCatalog} from './local-models.mjs';
import {request as httpRequest} from 'node:http';

const groups=[],source=new URL('./server.mjs',import.meta.url).href;
async function childCase(mode,trigger){
 const code=`import {watchParent} from ${JSON.stringify(source)};
 let finish;const wait=new Promise(r=>finish=r);let count=0;
 process.on('message',()=>finish());process.channel.unref();
 watchParent(async()=>{count++;process.send({event:'closing',count});await wait;process.send({event:'settled',count});${mode==='throw'?'throw Error("Injected cleanup failure")':`return {stopped:${mode!=='unknown'}}`};});
 process.send({event:'ready'});`;
 const child=spawn(process.execPath,['--preserve-symlinks','--input-type=module','-e',code],{stdio:['pipe','pipe','pipe','ipc']});
 const events=[];let output='',diagnostics='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>diagnostics+=b);child.on('message',v=>events.push(v));
 const closed=once(child,'close');let done=false;void closed.then(()=>done=true);
 const until=async event=>{for(let i=0;i<200&&!events.some(x=>x.event===event)&&!done;i++)await delay(10);assert(events.some(x=>x.event===event),event+' not observed');};
 try{
  await until('ready');if(trigger==='EOF')child.stdin.end();else child.kill(trigger);await until('closing');
  child.kill('SIGTERM');child.kill('SIGINT');await delay(mode==='slow'?6500:100);
  assert.equal(done,false,'Shutdown must retain pending cleanup beyond the old six-second exit');
  child.send('release');await until('settled');
  if(mode==='slow'||mode==='fast'){
   const [exit,signal]=await Promise.race([closed,delay(2000).then(()=>{throw Error('Confirmed cleanup did not exit');})]);assert.equal(exit,0);assert.equal(signal,null);
  }else{
   await delay(150);assert.equal(done,false,'Unconfirmed cleanup must retain its process owner');child.kill('SIGTERM');await delay(100);assert.equal(done,false);assert.match(diagnostics,/unconfirmed/i);
  }
  assert.equal(events.filter(x=>x.event==='closing').length,1,'Repeated shutdown triggers must not repeat close');assert.equal(output,'');groups.push(mode+'-'+trigger);
 }finally{if(!done)child.kill('SIGKILL');await closed;}
}
await childCase('slow','EOF');await childCase('fast','SIGTERM');await childCase('unknown','SIGINT');await childCase('throw','EOF');

for(const mode of ['held','unknown','throw']){
 let release;const wait=new Promise(r=>release=r),token=randomUUID(),counts={coding:0,git:0,tools:0,worktrees:0,schedules:0};
 const inert=kind=>({start:()=>{},stop:async()=>({stopped:true}),close:async()=>{counts[kind]++;return {stopped:true};}});
 const coding={...inert('coding'),handle:async()=>assert.fail('Shutdown admitted coding work'),close:async()=>{counts.coding++;await wait;return {stopped:true};}};
 const git={...inert('git'),close:async()=>{counts.git++;if(mode==='throw')throw Error('Injected close failure');return {state:mode==='unknown'?'unknown':'cancelled'};}};
 const server=createServer({instanceToken:token,coding,hub:inert('tools'),worktrees:inert('worktrees'),gitWorkflow:git,schedules:inert('schedules')});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 const post=(route,input,sign=true)=>{const body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now());return fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-qwen-chat':'1',...(sign?{'x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)}:{})},body});};
 try{
  const shutdown=post('/api/tools/shutdown',{});await delay(100);assert.equal(counts.coding,1,'Native shutdown must enter final close');
  const again=server.shutdownTools();assert.equal(counts.coding,1);
  for(const [route,input] of [['/api/tools/coding',{action:'status'}],['/api/agent',{messages:[{role:'user',content:'No work while closing'}]}],['/api/chat',{messages:[{role:'user',content:'No inference while closing'}]}]])assert.equal((await post(route,input,route.startsWith('/api/tools/'))).status,503,route);
  release();const first=await (await shutdown).json(),second=await again,third=await (await post('/api/tools/shutdown',{})).json();
  assert.deepEqual(first,second);assert.deepEqual(first,third);assert.equal(first.stopped,mode==='held');assert.deepEqual(counts,{coding:1,git:1,tools:1,worktrees:1,schedules:1});groups.push('signed-latched-'+mode);
 }finally{release();await server.shutdownTools();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
for(const route of ['/api/chat','/api/agent'])for(const stage of ['resolution','resolution-error','inference','stream']){
 let release,entered,requests=0,aborted=false;
 const wait=new Promise(r=>release=r),admitted=new Promise(r=>entered=r);
 const fetchImpl=async(url,{signal}={})=>{
  if(url.endsWith('/api/v1/models')){
   if(stage.startsWith('resolution')){entered();await wait;if(stage==='resolution-error')throw Error('Injected inventory failure');}
   return Response.json({models:[{key:'fixture',type:'llm',capabilities:{trained_for_tool_use:true},loaded_instances:[{id:'fixture',config:{context_length:65536}}]}]});
  }
  requests++;entered();
  if(stage==='stream')return new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>{aborted=true;controller.error(signal.reason);},{once:true});}}),{headers:{'content-type':'text/event-stream'}});
  await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});wait.then(resolve);});
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'fixture'}}]});
 };
 const inert={start(){},async stop(){return{stopped:true};},async close(){return{stopped:true};}};
 const server=createServer({model:'fixture',localModels:new LocalModelCatalog({fetchImpl}),coding:inert,hub:inert,worktrees:{...inert},gitWorkflow:inert,schedules:inert});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const request=fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-qwen-chat':'1'},body:JSON.stringify({thinking:'standard',messages:[{role:'user',content:'fixture'}]})});
 try{
  await Promise.race([admitted,delay(2000).then(()=>{throw Error('Model request not admitted');})]);
  let settled=false;const closing=server.shutdownTools().then(result=>{settled=true;return result;});
  await delay(50);
  if(stage.startsWith('resolution'))assert.equal(settled,false,'Shutdown must await admitted model resolution');
  else assert.equal(aborted,true,'Shutdown must abort an admitted inference request');
  release();assert.equal((await closing).stopped,true);
  assert.equal(requests,stage.startsWith('resolution')?0:1,'No provider inference may start after shutdown');
  await Promise.race([request.then(r=>r.text()),delay(1500).then(()=>{throw Error('Cancelled inference left its HTTP response open');})]);groups.push(route.slice(5)+'-'+stage);
 }finally{release();server.closeAllConnections();await request.catch(()=>{});await server.shutdownTools();await new Promise(r=>server.close(r));}
}
{
 let requests=0;const inert={start(){},async close(){return{stopped:true};}},fetchImpl=async()=>{requests++;throw Error('Shutdown admitted new model work');};
 const server=createServer({localModels:new LocalModelCatalog({fetchImpl}),coding:inert,hub:inert,worktrees:{...inert},gitWorkflow:inert,schedules:inert});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 let complete;const response=new Promise(r=>complete=r),admitted=once(server,'request');
 const req=httpRequest({host:'127.0.0.1',port:server.address().port,path:'/api/chat',method:'POST',headers:{'content-type':'application/json','x-qwen-chat':'1'}},res=>{res.resume();res.once('end',()=>complete(res.statusCode));});
 try{
  req.write('{"messages":');await admitted;await delay(20);
  assert.equal((await server.shutdownTools()).stopped,true);
  req.end('[{"role":"user","content":"fixture"}]}');
  assert.equal(await response,503);assert.equal(requests,0);groups.push('chat-body-after-close');
 }finally{req.destroy();server.closeAllConnections();await server.shutdownTools();await new Promise(r=>server.close(r));}
}
console.log(JSON.stringify({passed:true,groups,installedAppTouched:false}));
