import assert from 'node:assert/strict';
import { CodingEngine } from './coding-engine.mjs';

// Actual engine methods; only the two command transports are inert. No ensure,
// launch, filesystem, native helper, model, or network operation is invoked.
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(remote = false) {
  const engine = new CodingEngine({dataDir:'/inert/coding-home',localModels:{resolve(){throw Error('Forbidden model call');}},spawnProcess(){throw Error('Forbidden process spawn');},temporaryOperation(){throw Error('Forbidden native call');}});
  const calls=[],pending=new Map(),failures=[];
  const request=(method,params,timeout,onOutput)=>{
    calls.push({method,params,timeout,onOutput});
    if(method==='command/exec')return new Promise((resolve,reject)=>pending.set(params.processId,{resolve,reject}));
    if(method==='command/exec/terminate')return Promise.resolve({});
    if(method==='thread/loaded/list')return Promise.resolve({data:[],nextCursor:null});
    throw Error('Unexpected inert RPC: '+method);
  };
  const child={},life={child,exited:false};engine.child=child;engine.processLife=life;
  engine.rpc=remote?(method,params,timeout)=>{assert.equal(method,'thread/loaded/list','Remote commands must not fall back to native RPC');return request(method,params,timeout);}:request;
  if(remote)life.commands={request};
  engine.fail=error=>failures.push(error); // Observe failure admission without running disposal.
  return {engine,life,calls,pending,failures};
}
let checks=0;
for(const remote of [false,true]){
  const kind=remote?'transport':'native';
  {
    const f=fixture(remote),output=()=>{},result={exitCode:130,stdout:'retained',stderr:''};
    const command=f.engine.commandRPC(f.life,'command/exec',{cwd:'/inert/project',command:['/bin/false']},12345,output);
    assert.equal(f.engine.commandRequests.size,1,`${kind}: original command must be tracked before dispatch settles`);
    const call=f.calls[0],id=call.params.processId;
    assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(call.timeout,12345);
    if(remote)assert.equal(call.onOutput,output);
    assert(f.engine.projectOccupied('/inert/project'));
    let stopped=false;const stop=f.engine.stop().then(value=>{stopped=true;return value;});
    await tick();assert(f.calls.some(c=>c.method==='command/exec/terminate'&&c.params.processId===id));
    assert.equal(stopped,false,`${kind}: terminate ACK is not original command completion`);
    assert.equal(f.engine.commandRequests.size,1);assert(f.engine.projectOccupied('/inert/project'));
    f.pending.get(id).resolve(result);assert.equal(await command,result);await stop;
    assert.equal(f.engine.commandRequests.size,0);assert(!f.engine.projectOccupied('/inert/project'));assert.equal(f.failures.length,0);checks++;
  }
  {
    const f=fixture(remote),id='preserved-process-id';
    const command=f.engine.commandRPC(f.life,'command/exec',{processId:id,cwd:'/inert/project'});
    f.pending.get(id).resolve({exitCode:0});assert.deepEqual(await command,{exitCode:0});assert.equal(f.engine.commandRequests.size,0);checks++;
  }
  for(const outcome of ['missing-exit','rejected']){
    const f=fixture(remote),id='uncertain-'+outcome;
    const command=f.engine.commandRPC(f.life,'command/exec',{processId:id,cwd:'/inert/project'});
    const rejected=assert.rejects(command,outcome==='missing-exit'?/exit unconfirmed/:/inert transport failure/);
    if(outcome==='missing-exit')f.pending.get(id).resolve({stdout:'no completion'});else f.pending.get(id).reject(Error('inert transport failure'));
    await rejected;assert.equal(f.failures.length,1);assert.equal(f.engine.commandRequests.size,1,`${kind}: unknown completion must retain the original request`);assert(f.engine.projectOccupied('/inert/project'));
    await assert.rejects(f.engine.stopCommandRequests(f.life),outcome==='missing-exit'?/exit unconfirmed/:/inert transport failure/);checks++;
  }
  {
    const f=fixture(remote),other={child:{},exited:false};
    await assert.rejects(f.engine.commandRPC(other,'command/exec',{cwd:'/inert/project'}),/process changed/);
    assert.equal(f.calls.length,0);assert.equal(f.engine.commandRequests.size,0);checks++;
  }
  {
    const f=fixture(remote),id='direct-terminal';
    const command=f.engine.commandRPC(f.life,'command/exec',{processId:id,cwd:'/inert/project'});
    f.engine.terminals.set(id,{threadId:'root'});
    await f.engine.stopCommandRequests(f.life);assert(!f.calls.some(c=>c.method==='command/exec/terminate'),'Direct terminals retain their separate termination barrier');
    f.pending.get(id).resolve({exitCode:0});await command;checks++;
  }
}
console.log(JSON.stringify({passed:true,checks,scope:'inert native and transport command tracking, real global Stop/standalone drain; no native descendant-closure claim'}));
