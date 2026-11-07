// Disposable shell and fake native-route fixtures only; no engine, model, app, or user data.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable,PassThrough} from 'node:stream';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {runCommand,stopCommands,toolRoutes,nativeSignature} from './agent.mjs';
import {GitWorkflow} from './git-workflow.mjs';

const dir=await mkdtemp(tmpdir()+'/handoff-command-'),quote=s=>"'"+s.replaceAll("'","'\\''")+"'",token='disposable-command-route-token';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const until=async check=>{for(let n=0;n<100;n++){if(await check())return;await delay(10);}throw Error('Fixture condition did not arrive.');};
let checks=0;
function fixture(commandRunner,gitWorkflow){
  const manager={phase:'idle',held:null,reserves:0,releases:0,stops:0,wait:null,routeWait:null,stopResult:{stopped:true,busy:false},
    async reserveCommand(){
      this.reserves++;if(this.held||this.phase!=='idle')throw Error('Handoff blocks generic commands.');
      const held={};this.held=held;
      try{if(this.wait)await this.wait.promise;if(this.phase!=='idle')throw Error('Handoff blocks generic commands.');return {release:()=>{assert.equal(this.held,held);this.held=null;this.releases++;}};}catch(e){this.held=null;throw e;}
    },
    async handle(input){this.handles=(this.handles??0)+1;if(['prepareHandoff','handoff'].includes(input.action)){if(this.held)throw Error('Command is still occupied.');this.phase=input.action==='handoff'?'executing':'preparing';if(this.routeWait)await this.routeWait.promise;return {plan:{id:randomUUID()}};}return {};},
    async stop(){this.stops++;this.routeWait?.resolve();return this.stopResult;},async close(){return this.stop();}};
  const coding={stops:0,exitUnconfirmed:false,disposal:Promise.resolve(),async stop(){this.stops++;return {message:'Coding idle.'};},async close(){},async handle(){return {};}};
  const git=gitWorkflow??{stops:0,handles:0,async handle(){this.handles++;return {};},result:{state:'cancelled'},async stop(){this.stops++;return this.result;},async close(){return this.stop();}};
  const hub={async stop(){return {stopped:true};},async close(){return {stopped:true};}};
  const schedules={stops:0,async stop(){this.stops++;return {};},async close(){return {};}};
  const handler=toolRoutes({instanceToken:token,worktrees:manager,coding,gitWorkflow:git,hub,schedules,...(commandRunner?{commandRunner}:{})});
  function start(route,input,{disconnectAt}={}){
    const body=Buffer.from(JSON.stringify(input)),nonce=randomUUID(),time=String(Date.now());
    const res=new EventEmitter();Object.assign(res,{writableEnded:false,destroyed:false,headersSent:false});let answer;
    const disconnect=()=>{res.destroyed=true;res.emit('close');};
    const req=Readable.from((async function*(){yield body;if(disconnectAt==='body')disconnect();})());req.method='POST';req.headers={'content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)};
    if(disconnectAt==='attachment'){const once=res.once;res.once=function(event,listener){const value=once.call(this,event,listener);if(event==='close')disconnect();return value;};}
    const task=handler(req,res,route,(status,body)=>{answer={status,body};res.writableEnded=true;}).then(()=>answer);
    return {res,task};
  }
  return {manager,coding,git,hub,schedules,handler,start,post:(route,input)=>start('/api/tools/'+route,input).task};
}
try{
  for(const disconnectAt of ['body','attachment'])for(const [route,input] of [
    ['worktrees',{action:'prepareHandoff'}],['worktrees',{action:'handoff'}],
    ['git',{action:'prepare',requestId:randomUUID()}],['git',{action:'execute',requestId:randomUUID()}],
    ['command',{command:'fake-must-not-dispatch',cwd:dir}]
  ]){
    let dispatched=0;const f=fixture(async()=>{dispatched++;return {output:'',exitCode:0};});
    const request=f.start('/api/tools/'+route,input,{disconnectAt});await request.task;
    assert.equal(f.manager.handles??0,0,disconnectAt+' disconnect must not dispatch '+input.action);
    assert.equal(f.manager.reserves,0,disconnectAt+' disconnect must not admit a command');assert.equal(dispatched,0);
    assert.equal(f.git.handles,0,disconnectAt+' disconnect must not dispatch Git');
    assert.equal(f.manager.stops,0,'A never-dispatched request must not stop unrelated manager work');assert.equal(f.git.stops,0);assert.equal(f.coding.stops,0);
    assert.equal(request.res.listenerCount('close'),0,'Early-disconnect listeners are removed');
    assert.equal((await f.post('command',{command:'fake-fresh-request',cwd:dir})).status,200,'Early disconnect releases its command owner');checks++;
  }
  for(const [route,input] of [['stop',{coding:false}],['shutdown',{}]]){
    const f=fixture();await f.start('/api/tools/'+route,input,{disconnectAt:'body'}).task;
    assert.equal(f.manager.stops,1,'Closing the Stop response must not revoke cancellation');assert.equal(f.git.stops,1);checks++;
  }
  {
    const f=fixture();await f.start('/api/tools/worktrees',{action:'list'},{disconnectAt:'body'}).task;
    assert.equal(f.manager.handles,1,'Existing read-only route semantics are preserved');assert.equal(f.manager.stops,0);checks++;
  }
  for(const runner of ['runner','checkoutRunner']){
    let released=false,dispatched=0;const workflow=new GitWorkflow({dataDir:dir+'/uncertain-'+runner});
    const plan={lease:{release(){released=true;}}};workflow.plan=plan;workflow[runner].blocked=true;await workflow.retire(plan);
    assert.equal(workflow.plan,null);assert.equal(workflow.operation,null);assert.equal(released,false,'Unconfirmed Git exit must retain its shared mutation lease');
    const f=fixture(async()=>{dispatched++;return {output:'',exitCode:0};},workflow),result=await f.post('command',{command:'must-not-overlap-uncertain-git',cwd:dir});assert.equal(result.status,400,runner+' unconfirmed exit must fence commands after plan retirement');assert.equal(dispatched,0);assert.equal(f.manager.reserves,0);checks++;
  }
  for(const [object,key,value] of [['git','operation',{}],['git','plan',{}],['manager','operation',{}],['manager','plans',new Map([['held',{}]])],['manager','retainedLeases',new Set([{}])]]){
    let dispatched=0;const f=fixture(async()=>{dispatched++;return {output:'',exitCode:0};});f[object][key]=value;
    const result=await f.post('command',{command:'must-not-run-during-review',cwd:dir});assert.equal(result.status,400,`${object}.${key} must fence generic commands`);assert.equal(dispatched,0);assert.equal(f.manager.reserves,0);checks++;
  }
  {
    const entered=deferred(),finished=deferred();const f=fixture(async()=>{entered.resolve();await finished.promise;return {output:'',exitCode:0};});
    const task=f.post('command',{command:'held-command',cwd:dir});await entered.promise;
    try{for(const [route,input] of [['git',{action:'prepare'}],['git',{action:'execute'}],['worktrees',{action:'prepare'}],['worktrees',{action:'create'}]])assert.equal((await f.post(route,input)).status,409,'A tracked command must fence checkout mutations');assert.equal(f.git.handles,0);assert.equal(f.manager.handles??0,0);}finally{finished.resolve();await task;}
    assert.equal((await f.post('git',{action:'prepare'})).status,200,'Confirmed command exit releases mutation admission');checks++;
  }
  for(const phase of ['preparing','review','executing','retained']){
    const f=fixture();f.manager.phase=phase;
    const result=await f.post('command',{command:'printf forbidden',cwd:dir});
    assert.equal(result.status,400,phase+' handoff must block command before dispatch');assert.equal(f.manager.reserves,1);checks++;
  }
  {
    const f=fixture();f.manager.wait=deferred();
    const command=f.post('command',{command:'printf permitted',cwd:dir});await until(()=>f.manager.held);
    const inverse=await f.post('worktrees',{action:'prepareHandoff'});assert.equal(inverse.status,409);assert.match(inverse.body.error,/command/i);
    f.manager.wait.resolve();assert.equal((await command).body.output,'permitted');assert.equal(f.manager.held,null);assert.equal(f.manager.releases,1);checks++;
  }
  for(const action of ['prepareHandoff','handoff']){
    const f=fixture();f.manager.routeWait=deferred();const work=f.start('/api/tools/worktrees',{action});await until(()=>f.manager.phase!=='idle');
    assert.equal((await f.post('command',{command:'printf forbidden',cwd:dir})).status,400);
    work.res.emit('close');await work.task;assert.equal(f.manager.stops,1,'response disconnect must cancel '+action);assert.equal(f.coding.stops,0);checks++;
  }
  {
    const f=fixture();f.manager.wait=deferred();const command=f.post('command',{command:'printf must-not-launch',cwd:dir});await until(()=>f.manager.held);
    let stopped=false;const stop=f.post('stop',{coding:false}).then(r=>{stopped=true;return r;});await delay(25);assert.equal(stopped,false,'Stop must await pending command admission');
    f.manager.wait.resolve();assert.equal((await command).status,400);assert.equal((await stop).body.stopped,true);assert.equal(f.manager.held,null);assert.equal(f.coding.stops,0);assert.equal(f.schedules.stops,0);checks++;
  }
  {
    const finished=deferred();let signal;
    const f=fixture(async(_input,s)=>{signal=s;await finished.promise;return {output:'',exitCode:0};});
    const command=f.post('command',{command:'fake-delayed-exit',cwd:dir});await until(()=>signal);
    let stopped=false;const stop=f.post('stop',{coding:false}).then(r=>{stopped=true;return r;});await until(()=>signal.aborted);await delay(25);
    assert.equal(stopped,false,'Abort is not process-exit confirmation');assert(f.manager.held);
    const blocked=await f.post('command',{command:'printf second',cwd:dir});assert.equal(blocked.status,409);assert.match(blocked.body.error,/busy stopping/);
    finished.resolve();await command;assert.equal((await stop).body.stopped,true);assert.equal(f.manager.held,null);checks++;
  }
  {
    const f=fixture(async()=>{throw Object.assign(Error('Fixture command group exit was not confirmed.'),{code:'COMMAND_EXIT_UNCONFIRMED'});});
    const command=await f.post('command',{command:'fake-unknown-exit',cwd:dir});assert.equal(command.status,400);assert.equal(command.body.code,'COMMAND_EXIT_UNCONFIRMED');assert(f.manager.held);assert.equal(f.manager.releases,0);
    const stop=await f.post('stop',{coding:false});assert.equal(stop.body.stopped,false);assert.equal(stop.body.results.command.code,'COMMAND_EXIT_UNCONFIRMED');assert(f.manager.held);
    assert.equal((await f.post('worktrees',{action:'prepareHandoff'})).status,409);assert.equal((await f.post('command',{command:'printf no-retry',cwd:dir})).status,400);checks++;
  }
  {
    const f=fixture();f.manager.stopResult={stopped:false,busy:false,message:'Handoff exit is unconfirmed.'};f.git.result={state:'unknown',message:'Git exit is unconfirmed.'};
    const stop=await f.post('stop',{});assert.equal(stop.body.stopped,false);assert.deepEqual(stop.body.results.worktrees,f.manager.stopResult);assert.equal(stop.body.results.git.state,'unknown');assert.equal(f.coding.stops,1);assert.equal(f.schedules.stops,1);checks++;
  }
  {
    const f=fixture();const disposal=deferred();f.coding.disposal=disposal.promise;let replied=false;
    const stop=f.post('stop',{}).then(r=>{replied=true;return r;});await until(()=>f.coding.stops===1);await delay(25);assert.equal(replied,false);
    f.coding.exitUnconfirmed=true;disposal.resolve();assert.equal((await stop).body.results.coding.stopped,false);checks++;
  }
  {
    const f=fixture();f.coding.terminals=new Map([['unconfirmed-terminal',{}]]);
    assert.equal((await f.post('stop',{})).body.results.coding.stopped,false,'Remaining commands are not a confirmed Coding Stop');checks++;
  }
  {
    const f=fixture();f.hub.stop=async()=>{throw Error('Fixture disconnect unconfirmed.');};
    const stop=await f.post('stop',{});assert.equal(stop.status,200);assert.equal(stop.body.stopped,false);assert.equal(stop.body.results.tools.stopped,false);assert.equal(f.manager.stops,1);assert.equal(f.coding.stops,1);checks++;
  }
  // Real shell tests establish that stdout close and SIGKILL dispatch alone are insufficient.
  {
    const r=await runCommand({command:'nohup /bin/sleep 60 </dev/null >/dev/null 2>&1 & echo $!',cwd:dir},new AbortController().signal);
    const pid=Number(r.output.trim());assert(pid>1);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(r.isError,true);assert.match(r.message,/background processes were stopped/);checks++;
  }
  {
    const file=dir+'/resistant-pid',controller=new AbortController();
    const script="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    const task=runCommand({command:`${quote(process.execPath)} -e ${quote(script)} >/dev/null 2>&1 & echo $! > ${quote(file)}; wait`,cwd:dir},controller.signal);
    await until(async()=>{try{return Number(await readFile(file,'utf8'))>1;}catch{return false;}});await delay(100);const pid=Number(await readFile(file,'utf8'));controller.abort();
    assert.match((await task).message,/cancelled/);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});checks++;
  }
  {
    const child=new EventEmitter();Object.assign(child,{pid:900000001,stdout:new PassThrough(),stderr:new PassThrough()});
    const task=runCommand({command:'fake-live-group',cwd:dir},new AbortController().signal,{spawnProcess:()=>{setImmediate(()=>child.emit('close',0,null));return child;},signalProcess:()=>{}});
    await assert.rejects(task,{code:'COMMAND_EXIT_UNCONFIRMED'});checks++;
  }
  {
    const child=new EventEmitter();Object.assign(child,{pid:900000003,stdout:new PassThrough(),stderr:new PassThrough()});let alive=true,kills=0;
    const signalProcess=(_pid,signal)=>{if(!alive)throw Object.assign(Error('Gone'),{code:'ESRCH'});if(signal==='SIGKILL')kills++;};
    await assert.rejects(runCommand({command:'fake-retained-group',cwd:dir},new AbortController().signal,{spawnProcess:()=>{setImmediate(()=>child.emit('close',0,null));return child;},signalProcess}),{code:'COMMAND_EXIT_UNCONFIRMED'});
    const before=kills;stopCommands();assert.equal(kills,before,'An exited leader must not authorize signalling a historical group');
    alive=false;stopCommands();alive=true;stopCommands();assert.equal(kills,before,'Confirmed disappearance retires the exact handle without reusing its pid');checks++;
  }
  {
    const child=new EventEmitter();Object.assign(child,{pid:900000002,stdout:new PassThrough(),stderr:new PassThrough()});const controller=new AbortController();let alive=true,kills=0;
    const signalProcess=(_pid,signal)=>{if(!alive)throw Object.assign(Error('Gone'),{code:'ESRCH'});if(signal==='SIGKILL')kills++;};
    const task=runCommand({command:'fake-no-close',cwd:dir},controller.signal,{spawnProcess:()=>child,signalProcess});setTimeout(()=>controller.abort(),10);
    await assert.rejects(task,{code:'COMMAND_EXIT_UNCONFIRMED'});const before=kills;stopCommands();assert.equal(kills,before+1,'Still-live owned child keeps its cancellation handle');
    child.emit('exit',null,'SIGKILL');stopCommands();assert.equal(kills,before+1,'Leader exit revokes authority to re-signal the old group');alive=false;stopCommands();alive=true;stopCommands();assert.equal(kills,before+1);checks++;
  }
  console.log(`PASS: ${checks} handoff command admission, race, Stop, disconnect and process-group checks.`);
}finally{await rm(dir,{recursive:true,force:true});}
