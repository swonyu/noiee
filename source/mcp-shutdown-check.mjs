// Actual disposable provider, transport and signed server; no user configuration.
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {MCPHub} from './mcp.mjs';
import {BoundedStdioTransport} from './mcp-transport.mjs';
import {createServer} from './server.mjs';
import {nativeSignature} from './agent.mjs';
import processes from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

if(process.argv[2]==='--stubborn'){
 process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/ready'})+'\n');
}else if(process.argv[2]==='--provider'){
 for await(const line of createInterface({input:process.stdin})){
  const r=JSON.parse(line);if(r.id===undefined)continue;
  const result=r.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'shutdown-fixture',version:'1'}}:
   r.method==='tools/list'?{tools:[{name:'echo',inputSchema:process.argv[3]==='bad-catalog'?{$ref:'https://example.invalid/invalid'}:{type:'object',properties:{},additionalProperties:false}}]}:
   {content:[{type:'text',text:process.argv[3]==='oversize'?'x'.repeat(9*1024*1024):'fixture'}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');
 }
}else{
 const root=await mkdtemp(join(tmpdir(),'mcp-shutdown-')),groups=[];
 async function until(check){for(let n=0;n<300;n++){if(check())return;await delay(10);}assert.fail('MCP shutdown checkpoint not reached');}
 try{
  for(const refuseSignal of process.argv.includes('--hub-only')?[]:[false,true]){
   const spawn=processes.spawn;let child,ready=false;
   processes.spawn=(...args)=>child=spawn(...args);syncBuiltinESMExports();
   const transport=new BoundedStdioTransport({command:process.execPath,args:[fileURLToPath(import.meta.url),'--stubborn'],cwd:root,env:{}},()=>{});
   transport.onmessage=()=>ready=true;
   let kill,ended;
   try{
    await transport.start();processes.spawn=spawn;syncBuiltinESMExports();kill=child.kill.bind(child);ended=once(child,'close');
    await until(()=>ready);if(refuseSignal)child.kill=()=>false;
    const closing=transport.close();assert.equal(closing,transport.close());
    if(refuseSignal){await assert.rejects(closing,/exit.*unconfirmed/i);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);await assert.rejects(transport.close());}
    else{await closing;assert.equal(child.signalCode,'SIGKILL','Transport close must await the owned child exit after SIGKILL');}
    groups.push(refuseSignal?'unconfirmed direct child retained':'forced direct child exit observed');
   }finally{processes.spawn=spawn;syncBuiltinESMExports();child?.ref();if(child&&child.exitCode===null&&child.signalCode===null)kill('SIGKILL');await ended;}
  }
  for(const action of ['disconnect','stop','close','bad-catalog','oversize'])for(const fail of [false,true]){
   const original=BoundedStdioTransport.prototype.close,send=BoundedStdioTransport.prototype.send;let release,calls=0,sent=0;
   const gate=new Promise((resolve,reject)=>release=()=>fail?reject(Error('SECRET_CLOSE_ERROR')):resolve());gate.catch(()=>{});
   BoundedStdioTransport.prototype.close=function(){calls++;return original.call(this).then(()=>gate);};
   BoundedStdioTransport.prototype.send=function(message){if(message.method==='tools/call')sent++;return send.call(this,message);};
   const config=join(root,randomUUID()+'.json');await writeFile(config,JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[fileURLToPath(import.meta.url),'--provider',action]}}}));
   const hub=new MCPHub(config),token=randomUUID(),inert={start(){},async close(){return{stopped:true};}};
   const server=createServer({instanceToken:token,hub,coding:{...inert,dataDir:join(root,randomUUID())},worktrees:{...inert},gitWorkflow:inert,schedules:inert});
   server.listen(0,'127.0.0.1');await once(server,'listening');let closing,request;
   try{
    const hash=(await hub.describe()).servers[0].configHash;
    if(action==='bad-catalog')request=hub.connect('fixture',hash).catch(e=>e);
    else{
     await hub.connect('fixture',hash);
     request=(action==='disconnect'?hub.disconnect('fixture'):action==='stop'?hub.stop():action==='close'?hub.close():hub.call('fixture','echo',{})).catch(e=>e);
     if(action!=='oversize'){
      const late=hub.call('fixture','echo',{}).catch(e=>e);
      assert.equal(sent,0,'Closure admission must synchronously fence new provider calls');await late;
     }
    }
    await until(()=>calls>0);let done=false;closing=server.shutdownTools().then(v=>{done=true;return v;});await delay(40);
    assert.equal(done,false,'Final shutdown must retain an earlier MCP close');
    const route='/api/tools/shutdownStatus',body='{}',nonce=randomUUID(),time=String(Date.now());
    const status=await(await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:{'content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)},body})).json();
    assert.equal(status.record.subsystems.tools,'pending');release();await request;
    assert.equal((await closing).stopped,!fail);assert.equal(calls,1,'All close callers share one transport-close attempt');
    if(fail){await assert.rejects(hub.close());await assert.rejects(hub.disconnect('fixture'));assert.equal(calls,1);}
    else assert.deepEqual(await hub.close(),{stopped:true});
    groups.push(action+' '+(fail?'failure retained':'drained'));
   }finally{
    release();await request?.catch(()=>{});await closing?.catch(()=>{});await hub.close().catch(()=>{});
    server.closeAllConnections();await new Promise(r=>server.close(r));BoundedStdioTransport.prototype.close=original;BoundedStdioTransport.prototype.send=send;
   }
  }
  console.log(JSON.stringify({passed:true,groups,installedAppTouched:false},null,2));
 }finally{await rm(root,{recursive:true,force:true});}
}
