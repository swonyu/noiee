// Signed route fixtures only: no app, native helper, engine, model or production ledger.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {toolRoutes,nativeSignature} from './agent.mjs';

const token='isolated-schedule-recovery-route',deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  const entered=deferred(),release=deferred(),calls=[],cancelled=deferred();let scheduleStops=0,recoveryStops=0;
  const idle={async stop(){return {stopped:true};},async close(){return {stopped:true};}};
  const schedules={...idle,async handle(input,options){calls.push({input,options});entered.resolve();if(input.wait)await release.promise;return {recovered:true};},async stop(){scheduleStops++;return {stopped:true};},async cancelRecovery(){recoveryStops++;cancelled.resolve();if(calls.some(c=>c.input.wait))await release.promise;return {stopped:true};}};
  const handler=toolRoutes({instanceToken:token,schedules,coding:{...idle,disposal:Promise.resolve()},worktrees:{...idle},gitWorkflow:{...idle},hub:{...idle}});
  function start(input,{disconnect,invalidPermit=false,route='/api/tools/schedules'}={}){
    const body=Buffer.from(JSON.stringify(input)),nonce=randomUUID(),time=String(Date.now());
    const res=Object.assign(new EventEmitter(),{destroyed:false,writableEnded:false,headersSent:false});let answer;
    const close=()=>{res.destroyed=true;res.emit('close');};
    const req=Readable.from((async function*(){yield body;if(disconnect==='body')close();})());
    req.method='POST';req.headers={'content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':invalidPermit?'0'.repeat(64):nativeSignature(token,route,nonce,time,body)};
    if(disconnect==='attachment'){const on=res.on;res.on=function(name,fn){on.call(this,name,fn);if(name==='close')close();return this;};}
    const task=handler(req,res,route,(status,value)=>{answer={status,value};res.writableEnded=true;}).then(()=>answer);
    return {req,res,task,close};
  }
  return {start,calls,entered,release,cancelled,get scheduleStops(){return scheduleStops;},get recoveryStops(){return recoveryStops;}};
}

let checks=0;
for(const action of ['prepareRecovery','commitRecovery']){
  const f=fixture(),r=f.start({action},{disconnect:'body'});await r.task;
  assert.equal(f.calls.length,0,'A disconnected signed body must not dispatch '+action);checks++;
}
for(const action of ['prepareRecovery','commitRecovery']){
  const f=fixture(),r=f.start({action},{disconnect:'attachment'});await r.task;
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options?.signal?.aborted,true,'The attachment race must carry an aborted signal');
  assert.equal(r.res.listenerCount('close'),0);assert.equal(await r.task,undefined);checks++;
}
for(const action of ['prepareRecovery','commitRecovery']){
  const f=fixture(),r=f.start({action,wait:true});await f.entered.promise;
  assert.equal(f.calls[0].options?.signal?.aborted,false);r.close();assert.equal(f.calls[0].options.signal.aborted,true);
  let settled=false;r.task.then(()=>settled=true);await Promise.resolve();assert.equal(settled,false,'Request waits for backend to settle');
  f.release.resolve();assert.equal(await r.task,undefined);assert.equal(r.res.listenerCount('close'),0);checks++;
}
for(const action of ['list','stop','pause']){
  const f=fixture(),r=f.start({action},{disconnect:'body'});await r.task;
  assert.equal(f.calls.length,1,'Read and control dispatch remains independent of response loss');assert.equal(f.calls[0].options?.signal,undefined);checks++;
}
{
  const f=fixture(),r=f.start({action:'commitRecovery'},{invalidPermit:true});assert.equal((await r.task).status,403);assert.equal(f.calls.length,0);checks++;
}
{
  const f=fixture(),r=f.start({action:'prepareRecovery'});assert.equal((await r.task).status,200);assert.equal(f.calls[0].options.signal.aborted,false);assert.equal(r.res.listenerCount('close'),0);checks++;
}
{
  const f=fixture(),r=f.start({coding:false},{route:'/api/tools/stop'});assert.equal((await r.task).value.stopped,true);
  assert.equal(f.recoveryStops,1,'Tools-only Stop must cancel pending recovery');assert.equal(f.scheduleStops,0,'Tools-only Stop must not pause unrelated schedules');checks++;
}
{
  const f=fixture(),r=f.start({action:'commitRecovery',wait:true});await f.entered.promise;
  const stop=f.start({coding:false},{route:'/api/tools/stop'});await f.cancelled.promise;
  let settled=false;stop.task.then(()=>settled=true);await Promise.resolve();assert.equal(settled,false,'Navigation Stop waits for recovery settlement');
  f.release.resolve();await r.task;assert.equal((await stop.task).value.stopped,true);assert.equal(f.scheduleStops,0);checks++;
}
{
  const f=fixture(),r=f.start({},{route:'/api/tools/stop'});assert.equal((await r.task).value.stopped,true);
  assert.equal(f.scheduleStops,1);assert.equal(f.recoveryStops,0,'Full Stop uses the scheduler own abort/drain path');checks++;
}
console.log(JSON.stringify({passed:checks,process:0,network:0,nativeHelper:0,productionLedger:0}));
