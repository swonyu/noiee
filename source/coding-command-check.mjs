import assert from 'node:assert/strict';
let module;try{module=await import('./coding-commands.mjs');}catch{}
assert.equal(typeof module?.ExecutorCommands,'function','ExecutorCommands must exist');
const {ExecutorCommands}=module,tick=()=>new Promise(r=>setImmediate(r));
class Socket extends EventTarget {
  static peers=[];
  constructor(url,options){super();Object.assign(this,{url,options,readyState:0,bufferedAmount:0,seq:0,sent:[],commands:new Map()});Socket.peers.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  emit(m){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(m)}));}
  reply(id,result){this.emit({id,result});}
  inner(m,split=false){const bytes=Buffer.from(JSON.stringify(m)+'\n');const parts=split?[bytes.subarray(0,bytes.indexOf(Buffer.from('سلام'))+1),bytes.subarray(bytes.indexOf(Buffer.from('سلام'))+1)]:[bytes];for(const b of parts)this.emit({method:'process/output',params:{processId:this.processId,seq:++this.seq,stream:'stdout',chunk:b.toString('base64')}});}
  finish(processId,exitCode=0){const q=this.commands.get(processId);assert(q);this.commands.delete(processId);this.inner({id:q.id,result:{exitCode,stdout:'',stderr:''}});}
  send(text){const q=JSON.parse(text);this.sent.push(q);queueMicrotask(()=>{
    if(q.method==='initialize')this.reply(q.id,{sessionId:'fixture'});
    if(q.method==='process/start'){this.processId=q.params.processId;this.env=q.params.env;this.reply(q.id,{processId:this.processId,sandboxType:'none'});}
    if(q.method==='process/write'){
      this.reply(q.id,{status:'accepted'});const inner=JSON.parse(Buffer.from(q.params.chunk,'base64').toString());
      if(inner.method==='initialize')this.inner({id:inner.id,result:{codexHome:this.env.CODEX_HOME}});
      if(inner.method==='account/read')this.inner({id:inner.id,result:{account:null}});
      if(inner.method==='mcpServerStatus/list')this.inner({id:inner.id,result:{data:[],nextCursor:null}});
      if(inner.method==='command/exec')this.commands.set(inner.params.processId,inner);
      if(inner.method==='command/exec/terminate'&&this.finishOnTerminate){this.finish(inner.params.processId);this.inner({id:inner.id,error:{code:-32000,message:'Command already ended'}});return;}
      if(['command/exec/write','command/exec/resize','command/exec/terminate'].includes(inner.method)&&!this.holdControls)this.inner({id:inner.id,result:{}});
    }
    if(q.method==='process/terminate'){
      this.reply(q.id,{running:true});this.emit({method:'process/exited',params:{processId:this.processId,seq:++this.seq,exitCode:137}});this.emit({method:'process/closed',params:{processId:this.processId,seq:++this.seq}});
    }
  });}
  close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
function create(extra={}){const outputs=[],errors=[],transport=new ExecutorCommands({url:'ws://127.0.0.1:9999',authToken:'fixture-secret',launch:{argv:['/fixture/codex','app-server','--listen','stdio://'],cwd:'file:///private/var/empty',env:{HOME:'/fixture/home',CODEX_HOME:'/fixture/home'}},WebSocketImpl:Socket,onOutput:p=>outputs.push(p),onFailure:e=>errors.push(e),...extra});return {transport,outputs,errors};}
{
 const {transport:t,outputs,errors}=create();await t.ready;const peer=Socket.peers.at(-1);assert.equal(peer.options.headers.Authorization,'Bearer fixture-secret');
 let ended=false;const exec=t.request('command/exec',{command:['cat'],processId:'terminal',tty:true},null).then(r=>{ended=true;return r;});await tick();
 peer.inner({method:'command/exec/outputDelta',params:{processId:'terminal',stream:'stdout',deltaBase64:Buffer.from('سلام').toString('base64'),capReached:false,label:'سلام'}},true);assert.equal(outputs[0].label,'سلام');
 await t.request('command/exec/write',{processId:'terminal',deltaBase64:Buffer.from('literal\n').toString('base64')});await t.request('command/exec/resize',{processId:'terminal',size:{rows:31,cols:97}});
 await t.request('command/exec/terminate',{processId:'terminal'});assert.equal(ended,false,'Terminate ACK is not command completion');peer.finish('terminal',130);assert.equal((await exec).exitCode,130);
 assert.equal(await t.close(),true);assert.equal(errors.length,0);assert.equal(await t.close(),true);
}
{
 const {transport:t,errors,outputs}=create();await t.ready;const peer=Socket.peers.at(-1);const exec=t.request('command/exec',{command:['cat'],processId:'lost'},null);await tick();
 peer.close();await assert.rejects(exec,/unconfirmed|connection|closed/i);assert.equal(await t.close(),false,'Socket closure cannot certify process exit');
 const calls=peer.sent.length;await assert.rejects(t.request('command/exec/write',{processId:'lost',deltaBase64:'eA=='}),/closed|unconfirmed|failed/i);assert.equal(peer.sent.length,calls,'Do not replay or reconnect');
 peer.inner({method:'command/exec/outputDelta',params:{processId:'lost',stream:'stdout',deltaBase64:'eA==',capReached:false}});assert.equal(outputs.length,0);assert.equal(errors.length,1);
}
{
 const {transport:t}=create();await t.ready;const peer=Socket.peers.at(-1);const exec=t.request('command/exec',{command:['sleep','10'],processId:'timeout'},10);
 await assert.rejects(exec,/timed out/i);assert.equal(await t.close(),false,'Timeout retains uncertain command ownership');assert.equal(peer.sent.filter(q=>q.method==='process/start').length,1);
}
{
 const {transport:t,errors}=create();await t.ready;const peer=Socket.peers.at(-1);peer.emit({method:'process/output',params:{processId:'wrong',seq:1,stream:'stdout',chunk:'eA=='}});await tick();assert.equal(errors.length,1);assert.equal(await t.close(),false);
}
{
 const {transport:t,errors}=create();await t.ready;const peer=Socket.peers.at(-1);
 const exec=t.request('command/exec',{command:['cat'],processId:'control-race'},null);await tick();peer.holdControls=true;
 let settled=false;const control=t.request('command/exec/resize',{processId:'control-race',size:{rows:31,cols:97}}).catch(error=>{settled=true;return error;});await tick();
 peer.finish('control-race');await exec;assert.equal(await t.close(),true);await tick();assert(settled,'Confirmed closure must settle outstanding controls and retire their timers');assert.match((await control).message,/closed/);assert.equal(errors.length,0);
}
{
 const {transport:t}=create();await t.ready;const peer=Socket.peers.at(-1);const start=peer.sent.find(q=>q.method==='process/start');
 assert.deepEqual(start.params.argv.slice(0,2),['/usr/bin/env','-i'],'Sidecar must not inherit remote-bootstrap variables from executor environment');await t.close();
}
{
 class WrongHome extends Socket {inner(m,...rest){if(m.result?.codexHome)m.result.codexHome='/wrong-home';super.inner(m,...rest);}}
 const {transport:t}=create({WebSocketImpl:WrongHome});await assert.rejects(t.ready,/home/i);assert.equal(await t.close(),false);
}
{
 const {transport:t}=create();await t.ready;const peer=Socket.peers.at(-1);const exec=t.request('command/exec',{command:['git'],processId:'invalid-receipt'},null);await tick();
 const q=peer.commands.get('invalid-receipt');peer.inner({id:q.id,result:{exitCode:0,stdout:{},stderr:''}});await assert.rejects(exec,/receipt|result|exit/i);assert.equal(await t.close(),false);
}
{
 const {transport:t,errors}=create();await t.ready;const peer=Socket.peers.at(-1),exec=t.request('command/exec',{command:['cat'],processId:'closing-race'},null);await tick();peer.finishOnTerminate=true;
 assert.equal(await t.close(),true,'Original exec receipt must win a racing terminate rejection during close');assert.equal((await exec).exitCode,0);assert.equal(errors.length,0);
}
assert.throws(()=>create({url:'ws://example.com:9999'}),/secure|loopback/i);
{
 const {transport:t,outputs}=create();await t.ready;const peer=Socket.peers.at(-1),collected=[];
 const collector=t.request('command/exec',{command:['cat'],processId:'collector',streamStdoutStderr:true},null,p=>collected.push(p));
 const terminal=t.request('command/exec',{command:['cat'],processId:'parallel-terminal'},null);await tick();
 for(const processId of ['collector','parallel-terminal'])peer.inner({method:'command/exec/outputDelta',params:{processId,stream:'stdout',deltaBase64:'eA==',capReached:false}});
 peer.finish('collector');peer.finish('parallel-terminal');await Promise.all([collector,terminal]);await t.close();
 assert.deepEqual(collected.map(p=>p.processId),['collector'],'Trusted command collector must receive its own output');
 assert.deepEqual(outputs.map(p=>p.processId),['parallel-terminal'],'Collected bytes must not leak into unrelated terminal output');
 assert.equal(t.commandOutputs.size,0,'Original completion must remove collector ownership');
}
assert.throws(()=>create({launch:{argv:['/fixture/codex'],cwd:'file:///private/var/empty',env:{CODEX_EXEC_SERVER_URL:'ws://127.0.0.1:9'}}}),/bootstrap|CODEX_EXEC_SERVER/);
console.log('executor command checks passed: output framing, authenticated startup, controls, completion, timeout and disconnect uncertainty');
