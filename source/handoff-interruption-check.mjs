// Disposable real Git/native/HTTP fixtures; the Coding family is fake. No model or GUI.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,lstat,readlink,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {GitWorkflow} from './git-workflow.mjs';
import {handoffPublishedState} from './handoff-native.mjs';
import {nativeSignature,toolRoutes} from './agent.mjs';

const exec=promisify(execFile),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git',nativeHelper=process.env.HANDOFF_FILES_HELPER;
assert(nativeHelper,'Set HANDOFF_FILES_HELPER to the approved existing native fixture helper.');
const phase='native-destination-published',base='one\ntwo\nthree\n',staged='ONE\ntwo\nthree\n',working='ONE\ntwo\nTHREE\n';
const hash=x=>createHash('sha256').update(x).digest('hex'),identity=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function bounded(promise,label,ms=90000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' exceeded '+ms+' ms')),ms);})]);}finally{clearTimeout(timer);}}
async function raw(home,args){return (await exec(git,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{timeout:20000,maxBuffer:2097152,env:{HOME:home,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}})).stdout;}
function spawnRecorder(processes){return (...args)=>{const child=spawn(...args),row={pid:child.pid,kind:args[0]===nativeHelper?'native':'git',exit:null,closed:false};processes.push(row);child.once('exit',(code,signal)=>row.exit={code,signal});child.once('close',()=>row.closed=true);child.once('error',e=>row.error=e.message);return child;};}
function exited(processes){for(const row of processes){assert(row.closed&&row.exit&&!row.error,JSON.stringify(row));assert.equal(row.exit.code,0,JSON.stringify(row));assert.throws(()=>process.kill(-row.pid,0),{code:'ESRCH'});}}
function quiet(manager,processes){assert.equal(manager.nativeChild,null);assert.equal(manager.runner.child,null);assert.equal(manager.handoffInspector?.runner.child??null,null);assert.equal(manager.blocked,false);exited(processes);}
async function fixture(dir){
  const source=join(dir,'source'),dataDir=join(dir,'data'),processes=[];await mkdir(source,{recursive:true});await raw(dir,['init','-b','main',source]);
  await raw(dir,['-C',source,'config','user.name','Fixture']);await raw(dir,['-C',source,'config','user.email','fixture@localhost']);
  await writeFile(join(source,'text'),base);await writeFile(join(source,'binary'),Buffer.from([0,1,255]));await symlink('fixture-target',join(source,'link'));await raw(dir,['-C',source,'add','.']);await raw(dir,['-C',source,'commit','-m','base']);
  const head=(await raw(dir,['-C',source,'rev-parse','HEAD'])).trim();let lease=null,fence=null,stops=0,releases=0;
  const family={rootThreadId:'fixture-root',cwd:source,model:'fixture-unchanged-local-model',modelProvider:'local',members:[{id:'fixture-root',parentThreadId:null,archived:false,cwd:source,model:'fixture-unchanged-local-model',modelProvider:'local',lastTurnId:'fixture-turn'}],fingerprint:'fixture-family'};
  const coding={dataDir,disposal:Promise.resolve(),projectMutationInventory:async()=>[source],prepareHandoff:async()=>structuredClone(family),handoffTemporary:async()=>null,
    checkHandoffAuthority(cwd,authority,context){assert.equal(authority,fence);assert(fence&&!fence.cancelled,'Selected relocation was cancelled');assert.equal(cwd,fence.destination);assert.equal(context.lease,lease);assert.deepEqual(context.snapshot,family);},
    async stopHandoff(authority,context){assert.equal(authority,fence);assert.equal(context.lease,lease);assert.deepEqual(context.snapshot,family);stops++;fence.cancelled=true;return {state:'stopped'};},
    async relocateFamily(snapshot,destination,{bind,checkpoint,transfer}){fence={snapshot,destination,cancelled:false};let started=false;
      try{await bind(fence);await checkpoint('family-archive-intent',{snapshot,destination});started=true;await checkpoint('family-unloaded');await checkpoint('family-transfer-intent');await transfer();assert.fail('Interrupted fixture must not finish transfer or resume a family');}catch(e){throw Object.assign(e,{handoffStarted:started});}},
    async stop(){assert.fail('A routed worktree disconnect must use selected Stop, never global Coding Stop');},async close(){return {stopped:true};}};
  const manager=new ManagedWorktrees({dataDir,coding,nativeHelper,spawnProcess:spawnRecorder(processes),reserveMutation:async resolve=>{assert.equal(lease,null);await resolve();const handle={release(){assert.equal(lease,handle);lease=null;releases++;}};lease=handle;return handle;}});
  const prepared=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,record=(await manager.handle({action:'create',planId:prepared.id})).worktree;
  await writeFile(join(source,'text'),staged);await raw(dir,['-C',source,'add','text']);await writeFile(join(source,'text'),working);await writeFile(join(source,'untracked'),'move exactly these bytes\n');await mkdir(join(source,'empty'));await writeFile(join(record.cwd,'destination-only'),'preserve destination\n');
  return {dir,source,destination:record.cwd,dataDir,record,head,manager,coding,processes,get lease(){return lease;},get stops(){return stops;},get releases(){return releases;}};
}
async function baseline(f,p){return {dir:f.dir,source:f.source,destination:f.destination,dataDir:f.dataDir,worktreeId:f.record.id,head:f.head,id:p.id,directory:p.directory,recovery:structuredClone(p.recovery),manifestHash:hash(await readFile(join(p.directory,'manifest.json'))),sourceIndexHash:hash(await readFile(join(f.source,'.git','index'))),destinationIndexHash:hash(await readFile(join(f.source,'.git','worktrees',f.record.id,'index'))),destinationHead:await readFile(join(f.source,'.git','worktrees',f.record.id,'HEAD'),'utf8')};}
async function verifyRestart(saved){
  const processes=[],fresh=new ManagedWorktrees({dataDir:saved.dataDir,nativeHelper,spawnProcess:spawnRecorder(processes)});
  try{
    const listed=await fresh.handle({action:'list'});assert.equal(listed.handoffs.length,1);const descriptor=fresh.handoffs[0];assert.equal(descriptor.id,saved.id);assert.equal(descriptor.phase,phase);assert.deepEqual(descriptor.recovery,saved.recovery);
    const bytes=await readFile(join(saved.directory,'manifest.json'));assert.equal(hash(bytes),saved.manifestHash);const manifest=JSON.parse(bytes),p={...manifest,directory:saved.directory,recovery:descriptor.recovery,states:Object.fromEntries(Object.entries(manifest.repositories).map(([label,r])=>[label,{r}]))},active={plan:p,record:descriptor};
    const progress=[];for(let stamp=descriptor.progress;stamp;){const entry=await fresh.readHandoffProgress(active,stamp);progress.push(entry);stamp=entry.previous;assert(progress.length<=8192);}
    const published=progress.find(x=>x.phase===phase&&x.details.receipt);assert(published,'Durable publication receipt must survive interruption');const publication=handoffPublishedState(p,'destination',published.details.receipt);
    await fresh.verifyHandoffRecovery(p,fresh.epoch,{destination:publication});
    // Native verification reads bytes, metadata, inode/link ownership and exact private namespaces.
    fresh.handoffInspector=new GitWorkflow({dataDir:saved.dataDir,spawnProcess:spawnRecorder(processes)});
    await fresh.verifyHandoffPublishedLive(p,'destination',publication,[],fresh.epoch);await fresh.verifyHandoffPublishedLive(p,'source',{live:p.native.source},[],fresh.epoch);
    for(const path of [join(saved.source,'text'),join(saved.destination,'text'),join(saved.directory,'source-before','text')])assert.equal(await readFile(path,'utf8'),working);
    assert.equal(await readFile(join(saved.directory,'destination-before','text'),'utf8'),base);
    for(const path of [saved.source,saved.destination]){assert.deepEqual(await readFile(join(path,'binary')),Buffer.from([0,1,255]));assert.equal(await readlink(join(path,'link')),'fixture-target');assert.equal(await readFile(join(path,'untracked'),'utf8'),'move exactly these bytes\n');assert((await lstat(join(path,'empty'))).isDirectory());await assert.rejects(fresh.assertProject(path),{code:'HANDOFF_PENDING'});}
    assert.equal(await readFile(join(saved.destination,'destination-only'),'utf8'),'preserve destination\n');
    assert.equal(hash(await readFile(join(saved.source,'.git','index'))),saved.sourceIndexHash);assert.equal(hash(await readFile(join(saved.source,'.git','worktrees',saved.worktreeId,'index'))),saved.destinationIndexHash);
    assert.equal(await raw(saved.dir,['-C',saved.source,'show',':text']),staged);assert.equal(await raw(saved.dir,['-C',saved.destination,'show',':text']),base);
    assert.equal(await readFile(join(saved.source,'.git','HEAD'),'utf8'),saved.head+'\n');assert.equal(await readFile(join(saved.source,'.git','worktrees',saved.worktreeId,'HEAD'),'utf8'),saved.destinationHead);
    const peer=join(saved.dir,'new-peer');await raw(saved.dir,['-C',saved.source,'worktree','add','--detach',peer,saved.head]);await assert.rejects(fresh.assertProject(peer),{code:'HANDOFF_PENDING'});await mkdir(join(peer,'nested'));await assert.rejects(fresh.assertProject(join(peer,'nested')),{code:'HANDOFF_PENDING'});
    const unrelated=join(saved.dir,'unrelated');await mkdir(unrelated);await fresh.assertProject(unrelated);quiet(fresh,processes);
    return {descriptor,progress:progress.map(x=>({sequence:x.sequence,phase:x.phase,outcome:x.details.outcome??null})),manifestHash:hash(bytes),verifiedRecovery:true,verifiedExpectedFiles:true,fencedPaths:[saved.source,saved.destination,peer,join(peer,'nested')],unrelatedAdmitted:unrelated,processes};
  }finally{await fresh.close();}
}
async function httpDisconnect(dir){
  const f=await fixture(dir),token=randomUUID(),atPhase=deferred(),resume=deferred(),routedStop=deferred(),jobs=[],phases=[];
  const handler=toolRoutes({instanceToken:token,coding:f.coding,worktrees:f.manager,hub:{async stop(){return {stopped:true};},async close(){return {stopped:true};}},gitWorkflow:{async stop(){return {state:'cancelled'};},async close(){return {state:'cancelled'};}}});
  const server=createServer((req,res)=>{const job=handler(req,res,req.url,(status,value)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}});jobs.push(job);job.catch(e=>res.destroy(e));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();let stopWork,stopCalls=0,held=false,saved;
  const checkpoint=f.manager.handoffCheckpoint.bind(f.manager),stop=f.manager.stop.bind(f.manager);
  f.manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);phases.push(args[1]);if(args[1]===phase&&!held){held=true;quiet(f.manager,f.processes);atPhase.resolve();await resume.promise;}};
  f.manager.stop=()=>{stopCalls++;const work=stop();stopWork=work;routedStop.resolve();resume.resolve();return work;};
  function post(input){const route='/api/tools/worktrees',body=Buffer.from(JSON.stringify(input)),nonce=randomUUID(),time=String(Date.now());let req;const result=new Promise(resolve=>{req=request({host:'127.0.0.1',port:address.port,path:route,method:'POST',headers:{'content-type':'application/json','content-length':body.length,'x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)}},res=>{const parts=[];res.on('data',x=>parts.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(parts))}));});req.once('error',e=>resolve({error:e.code??e.message}));req.end(body);});return {request:req,result};}
  try{
    const prepared=await post({action:'prepareHandoff',id:f.record.id,threadId:'fixture-root'}).result;assert.equal(prepared.status,200,JSON.stringify(prepared));const p=f.manager.plans.get(prepared.body.plan.id);saved=await baseline(f,p);await writeFile(join(dir,'before.json'),JSON.stringify(saved,null,2)+'\n');
    const call=post({action:'handoff',planId:p.id});await bounded(Promise.race([atPhase.promise,call.result.then(x=>{throw new Error('Handoff returned before selected checkpoint: '+JSON.stringify(x));})]),'HTTP publication checkpoint');
    call.request.destroy();const response=await bounded(call.result,'HTTP socket close',5000);assert(response.error,'Disconnected request must not report a completed handoff');
    await bounded(routedStop.promise,'Response-close routed Stop',5000);const stopped=await bounded(stopWork,'Routed Stop completion');await bounded(Promise.all(jobs),'HTTP handlers settle');
    assert.equal(stopCalls,1);assert.equal(f.stops,1);assert.equal(stopped.stopped,true);assert.equal(f.manager.operation,null);assert.equal(f.manager.stopping,null);assert.equal(f.manager.activeHandoff,null);assert.equal(f.lease,null);quiet(f.manager,f.processes);
    const recovery=await verifyRestart(saved),evidence={case:'signed-http-disconnect',response,stopCalls,selectedStops:f.stops,stopped,settled:true,phases,recovery,processes:f.processes};await writeFile(join(dir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
  }finally{resume.resolve();await f.manager.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
async function worker(dir){
  const f=await fixture(dir),prepared=(await f.manager.handle({action:'prepareHandoff',id:f.record.id,threadId:'fixture-root'})).plan,p=f.manager.plans.get(prepared.id),saved=await baseline(f,p),phases=[];await writeFile(join(dir,'before.json'),JSON.stringify(saved,null,2)+'\n');
  const checkpoint=f.manager.handoffCheckpoint.bind(f.manager);f.manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);phases.push(args[1]);if(args[1]===phase){quiet(f.manager,f.processes);const ready={saved,phases,processes:f.processes,pid:process.pid};await writeFile(join(dir,'kill-ready.json'),JSON.stringify(ready,null,2)+'\n');process.send({type:'checkpoint',...ready});await new Promise(()=>{setInterval(()=>{},1000);});}};
  await f.manager.handle({action:'handoff',planId:p.id});assert.fail('Worker should be killed at its durable publication barrier');
}
async function killedManager(dir){
  await mkdir(dir,{recursive:true});const child=fork(fileURLToPath(import.meta.url),['--worker',dir],{detached:true,stdio:['ignore','pipe','pipe','ipc'],env:{HOME:dir,PATH:'/usr/bin:/bin',HANDOFF_FILES_HELPER:nativeHelper}}),ready=deferred(),closed=deferred();let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1048576)child.kill('SIGKILL');});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>1048576)child.kill('SIGKILL');});child.on('message',m=>{if(m.type==='checkpoint')ready.resolve(m);});child.once('error',e=>closed.resolve({error:e.message}));child.once('close',(code,signal)=>closed.resolve({code,signal}));
  let exit;
  try{
    const received=await bounded(Promise.race([ready.promise,closed.promise.then(e=>{throw new Error('Worker ended before checkpoint: '+JSON.stringify(e)+' '+stderr);})]),'Kill checkpoint');assert.equal(received.pid,child.pid);exited(received.processes);
    assert(child.kill('SIGKILL'),'Signal the exact owned manager child');exit=await bounded(closed.promise,'SIGKILL process close',5000);assert.deepEqual(exit,{code:null,signal:'SIGKILL'});assert.throws(()=>process.kill(-child.pid,0),{code:'ESRCH'});
    const recovery=await verifyRestart(received.saved),evidence={case:'manager-sigkill-after-durable-native-publication',pid:child.pid,signalSent:'SIGKILL',exit,managerGroupGone:true,phases:received.phases,recovery,processes:received.processes};await writeFile(join(dir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
  }finally{if(!exit){child.kill('SIGKILL');await bounded(closed.promise,'Worker cleanup',5000);}await writeFile(join(dir,'worker.stdout.log'),stdout);await writeFile(join(dir,'worker.stderr.log'),stderr);}
}
if(process.argv[2]==='--worker')await worker(process.argv[3]);
else{
  const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-interruption-'))),results=[];console.log('Fixture root '+root);
  try{for(const [name,fn] of [['http-disconnect',httpDisconnect],['manager-sigkill',killedManager]]){const result=await bounded(fn(join(root,name)),name,180000);results.push({name,passed:true,evidence:join(root,name,'evidence.json'),processes:result.processes.length});console.log('PASS '+name);}await writeFile(join(root,'evidence.json'),JSON.stringify({root,results,passed:true,scope:'Fake Coding family; actual signed loopback HTTP, manager, Git and native publication; SIGKILL occurs after completed native publication, not within native rename or a real engine.'},null,2)+'\n');console.log(JSON.stringify({root,passed:results.length,evidence:join(root,'evidence.json')}));}
  catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({root,results,error:error.stack},null,2)+'\n');throw error;}
}
