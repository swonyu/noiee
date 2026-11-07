import assert from 'node:assert/strict';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,readdir,unlink,symlink,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

assert.equal(typeof ManagedWorktrees.prototype.inspectHandoffProcesses,'function','Restart inspection must verify journaled helper incarnations without claiming engine quiescence.');
const nativeHelper=process.env.HANDOFF_FILES_HELPER;
assert(nativeHelper,'Set HANDOFF_FILES_HELPER to the independently compiled process-gate fixture binary.');
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-process-manager-'))),tests=[],workers=[],exec=promisify(execFile),onlyUnconfirmed=process.argv.includes('--only-unconfirmed-native'),onlyOwner=process.argv.includes('--only-owner'),onlyAttempts=process.argv.includes('--only-attempts'),onlyAdmission=process.argv.includes('--only-admission');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=['handoff-process-manager-check.mjs','managed-worktrees.mjs','git-runner.mjs','handoff-process.mjs','legacy-admission.mjs','filesystem-identity.mjs',...(process.argv.includes('--reboot-root-repro')?['../checks/reboot-adoption-fixture.mjs']:[])].map(name=>fileURLToPath(new URL(name,import.meta.url)));
const sourceHashes=async()=>Object.fromEntries(await Promise.all([...sourcePaths,nativeHelper].map(async path=>[path,hash(await readFile(path))]))),sources=await sourceHashes();
const identity=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
const descriptor=async path=>({path,...await identity(path)});
const stamp=async path=>({identity:await identity(path),hash:hash(await readFile(path)),bytes:(await lstat(path)).size});
const exists=async path=>lstat(path).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const git=async args=>(await exec('/Applications/Xcode.app/Contents/Developer/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env})).stdout;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(name,fn){await fn();tests.push(name);console.log('PASS '+name);}
async function fixture(name,{beforePrepare,beforeBegin}={}){
  const directory=join(root,name),source=join(directory,'source'),dataDir=join(directory,'data');await mkdir(source,{recursive:true});
  await git(['init','-b','main',source]);await git(['-C',source,'config','user.name','Fixture']);await git(['-C',source,'config','user.email','fixture@localhost']);
  await writeFile(join(source,'file'),'ORIGINAL\n');await git(['-C',source,'add','.']);await git(['-C',source,'commit','-m','base']);
  const family={rootThreadId:'saved-root',cwd:source,model:'unchanged-local',modelProvider:'local',fingerprint:'fixture',members:[{id:'saved-root',parentThreadId:null,cwd:source,model:'unchanged-local',modelProvider:'local',archived:false,lastTurnId:'original-turn'}]};
  const coding={prepareHandoff:async()=>structuredClone(family),projectMutationInventory:async()=>[source],handoffTemporary:async()=>null};
  if(onlyAdmission){
    family.modelProvider='saleh_local';family.members[0].modelProvider='saleh_local';family.fingerprint=hash('disposable bound family');
    const home=join(directory,'owner-home');await mkdir(home,{mode:0o700});
    const binding={ownerId:randomUUID(),home:await identity(home),rootThreadId:family.rootThreadId,generation:randomUUID(),executionMode:'native',model:family.model,provider:'local'};
    coding.handoffOwner=()=>structuredClone(binding);
  }
  const manager=new ManagedWorktrees({dataDir,nativeHelper,coding});
  const create=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,record=(await manager.handle({action:'create',planId:create.id})).worktree;
  await writeFile(join(source,'file'),'REVIEWED DIRTY\n');
  await beforePrepare?.(manager);
  const reviewed=(await manager.handle({action:'prepareHandoff',id:record.id,threadId:family.rootThreadId})).plan;
  const plan=manager.plans.get(reviewed.id);
  const manifest=JSON.parse(await readFile(join(plan.directory,'manifest.json'),'utf8'));
  assert.equal(manifest.version,onlyAdmission?5:4);assert.equal(manifest.processProtocol.version,2,'New preparations must persist the actual manager incarnation before begin.');assert.deepEqual(Object.keys(manifest.processProtocol).sort(),['bootSession','manager','version']);assert.match(manifest.processProtocol.bootSession,/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);assert.equal(manifest.processProtocol.manager.pid,process.pid);assert.equal(manifest.processProtocol.manager.uid,process.getuid());assert.equal(manifest.processProtocol.manager.bootSession,manifest.processProtocol.bootSession);assert(manifest.gitBaseline.originalRefs.length);
  assert.deepEqual(Object.keys(manifest.processProtocol.manager).sort(),['bootSession','pgid','pid','startSec','startUsec','uid','version']);assert.equal(manifest.processProtocol.manager.version,1);assert.deepEqual(plan.processProtocol,manifest.processProtocol);
  await beforeBegin?.(manager);
  const active=await manager.exclusive(epoch=>manager.beginHandoff(reviewed.id,epoch));
  return {manager,active,plan,source,destination:record.cwd,dataDir,record};
}
async function snapshot(f,path,names){const root=await descriptor(path);return {root,...await f.manager.exclusive(epoch=>f.manager.handoffFiles('snapshot',{root,paths:names},epoch))};}
const clean=({root,stamps,rootStamp})=>({root,stamps,rootStamp});
async function nativeOperation(f,action,label){
  const directory=join(f.plan.directory,label);await mkdir(directory,{mode:0o700});
  const paths={};for(const name of ['live','stage','capture']){paths[name]=join(directory,name);await mkdir(paths[name],{mode:0o700});}
  await writeFile(join(paths.stage,'file'),'AFTER\n');
  const stage=await snapshot(f,paths.stage,['file']);let input;
  if(action==='copy')input={source:stage.root,destination:await descriptor(paths.live),stamps:stage.stamps};
  else if(action==='materialize')input={destination:await descriptor(paths.live),donors:[],payload:clean(stage),entries:{file:{kind:'file',payload:'file',mode:0o644}},timestamp:'1700000000:0'};
  else {
    await writeFile(join(paths.live,'file'),'BEFORE\n');const before=await snapshot(f,paths.live,['file']),capture=await snapshot(f,paths.capture,[]);
    input={root:before.root,stage:stage.root,capture:capture.root,before:before.stamps,staged:stage.stamps,beforeRootStamp:before.rootStamp,stagedRootStamp:stage.rootStamp,captureRootStamp:capture.rootStamp,install:['file'],remove:[],...(action==='recoverPublish'?{retained:[],directoryTimes:{}}:{})};
  }
  const before=async()=>({live:await exists(join(paths.live,'file'))?await readFile(join(paths.live,'file'),'utf8'):null,stage:await exists(join(paths.stage,'file'))?await readFile(join(paths.stage,'file'),'utf8'):null,capture:await readdir(paths.capture)});
  return {kind:'native',action,observe:before,run:()=>f.manager.exclusive(epoch=>f.manager.handoffFiles(action,input,epoch)),verify:async()=>assert.equal(await readFile(join(paths.live,'file'),'utf8'),'AFTER\n')};
}
async function gitOperation(f,label,{direct=false}={}){
  const input='process gate '+label+' '+randomUUID()+'\n',oid=createHash('sha1').update('blob '+Buffer.byteLength(input)+'\0').update(input).digest('hex'),object=join(f.plan.states.source.r.commonDir,'objects',oid.slice(0,2),oid.slice(2));
  const args=['--git-dir='+f.plan.states.source.r.gitDir,'hash-object','-w','--stdin'],scope={dirs:[join(f.plan.states.source.r.commonDir,'objects')]};
  assert.equal(await exists(object),false);
  return {kind:'git',observe:()=>exists(object),run:()=>f.manager.exclusive(epoch=>direct?f.manager.runner.run(args,{scope,input,check:()=>f.manager.assertEpoch(epoch)}):f.manager.run(args,{scope,input,epoch})),verify:async result=>{assert.equal(result.stdout,oid+'\n');assert.equal(await exists(object),true);}};
}
function validWorker(details,boot){
  assert.deepEqual(Object.keys(details).sort(),details.kind==='native'?['action','kind','process']:['commandHash','kind','process']);
  if(details.kind==='native')assert(['copy','materialize','publish','recoverPublish'].includes(details.action));else{assert.equal(details.kind,'git');assert.match(details.commandHash,/^[a-f0-9]{64}$/);}
  const p=details.process;assert.deepEqual(Object.keys(p).sort(),['bootSession','nonce','pgid','pid','startSec','startUsec','uid','version']);
  assert.equal(p.version,1);assert.match(p.nonce,/^[a-f0-9]{8}-[a-f0-9]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert(Number.isSafeInteger(p.pid)&&p.pid>1);assert.equal(p.pgid,p.pid);assert.equal(p.uid,process.getuid());assert.match(p.startSec,/^[1-9][0-9]*$/);assert(Number.isSafeInteger(p.startUsec)&&p.startUsec>=0&&p.startUsec<1000000);assert.equal(p.bootSession,boot);
}
async function gate(f,operation,mode='release',{inspectLive=false}={}){
  const checkpoint=f.manager.handoffCheckpoint,unchanged=await operation.observe();let enter,release,entered=false,callbackDone;
  const arrival=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;}),completed=new Promise(resolve=>{callbackDone=resolve;});
  f.manager.handoffCheckpoint=async function(...args){
    await checkpoint.apply(this,args);
    if(args[1]!=='worker-started')return;
    assert.equal(entered,false,'One worker receipt per invocation');entered=true;const details=args[3];validWorker(details,f.plan.processProtocol.bootSession);assert.equal(details.kind,operation.kind);if(operation.action)assert.equal(details.action,operation.action);
    const progress=structuredClone(args[0].record.progress),path=join(f.plan.directory,'progress-'+String(progress.sequence).padStart(8,'0')+'.json'),saved=JSON.parse(await readFile(path,'utf8'));
    assert.equal(saved.phase,'worker-started');assert.deepEqual(saved.details,details);assert.deepEqual({sequence:progress.sequence,...await stamp(path)},progress);
    const ledger=JSON.parse(await readFile(f.manager.ledger,'utf8'));assert.deepEqual(ledger.handoffs.find(h=>h.id===f.plan.id).progress,progress);
    workers.push({fixture:f.plan.id,sequence:progress.sequence,...details});enter(details);
    try{await held;if(mode==='reject')throw new Error('Fixture rejected durable worker callback');}finally{callbackDone();}
  };
  const pending=operation.run(),settled=pending.then(value=>({value}),error=>({error}));let timeout;
  try{
    await Promise.race([arrival,settled.then(result=>{throw result.error??new Error('Worker affected the target without waiting for a durable receipt');}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Timed out awaiting worker receipt')),10000);})]);clearTimeout(timeout);
    assert.deepEqual(await operation.observe(),unchanged);await sleep(75);assert.deepEqual(await operation.observe(),unchanged,'Effect must remain blocked after durable save until the callback returns');
    if(inspectLive){
      const reader=new ManagedWorktrees({dataDir:f.dataDir,nativeHelper});try{
        await reader.load();const ledger=await stamp(reader.ledger),review=await reader.exclusive(epoch=>reader.readHandoffRecovery(f.plan.id,epoch)),proof=await reader.exclusive(epoch=>reader.inspectHandoffProcesses(review,epoch));
        assert.equal(proof.helpersQuiescent,false);assert.equal(proof.engineQuiescence,'unverified');assert.equal(proof.managerQuiescence,'live');assert.equal(proof.manager.quiescent,false);assert.deepEqual(proof.manager.process,f.plan.processProtocol.manager);assert.equal(proof.workers.at(-1).quiescent,false);assert.equal(proof.workers.at(-1).process.nonce,workers.at(-1).process.nonce);
        for(const cwd of [f.source,f.destination])await assert.rejects(reader.assertProject(cwd),{code:'HANDOFF_PENDING'});assert.deepEqual(await stamp(reader.ledger),ledger);
      }finally{await reader.close();}
      assert.deepEqual(await operation.observe(),unchanged);
    }
    if(mode==='stop'){
      const stopping=f.manager.stop();const result=await settled;assert(result.error,'Stopped gate must not complete');assert.equal((await stopping).stopped,true);assert.deepEqual(await operation.observe(),unchanged);release();await completed;await sleep(25);assert.deepEqual(await operation.observe(),unchanged,'A late callback must not release a cancelled worker');
    }else{
      release();const result=await settled;if(mode==='reject'){assert.match(result.error?.message??'',/Fixture rejected durable worker callback/);assert.deepEqual(await operation.observe(),unchanged);}else{if(result.error)throw result.error;await operation.verify(result.value);}
    }
  }finally{clearTimeout(timeout);release();f.manager.handoffCheckpoint=checkpoint;if(!entered||f.manager.runner.child||f.manager.nativeChild)await f.manager.stop();await settled;}
}

async function unconfirmedNative(){
  const f=await fixture('unconfirmed-native'),operation=await nativeOperation(f,'copy','unconfirmed-copy'),before=await operation.observe(),checkpoint=f.manager.handoffCheckpoint,spawn=f.manager.spawnProcess,kill=process.kill;
  const child=new EventEmitter(),streams=Array.from({length:5},()=>new PassThrough());Object.assign(child,{pid:900000011,exitCode:null,signalCode:null,killed:false,stdio:streams,stdin:streams[0],stdout:streams[1],stderr:streams[2]});
  let released='',input='',enter,release,callbackDone,watchdog,arrivalTimer,pending,stopping;const signals=[];
  streams[4].on('data',chunk=>released+=chunk);streams[0].on('data',chunk=>input+=chunk);
  const arrival=new Promise(resolve=>{enter=resolve;}),held=new Promise(resolve=>{release=resolve;}),callback=new Promise(resolve=>{callbackDone=resolve;});
  // This child exists only in memory. Never send its synthetic PID to the kernel.
  process.kill=(pid,signal)=>{if(pid===-child.pid){signals.push(signal);return true;}return kill(pid,signal);};
  f.manager.spawnProcess=(_path,args)=>{assert.deepEqual(args.slice(0,2),['--handoff-process','files']);assert.equal(args[3],'copy');queueMicrotask(()=>streams[3].end(JSON.stringify({version:1,nonce:args[2],pid:child.pid,pgid:child.pid,uid:process.getuid(),startSec:'1700000000',startUsec:1,bootSession:f.plan.processProtocol.bootSession})+'\n'));return child;};
  f.manager.handoffCheckpoint=async function(...args){await checkpoint.apply(this,args);if(args[1]==='worker-started'){enter();try{await held;}finally{callbackDone();}}};
  try{
    pending=operation.run().then(value=>({value}),error=>({error}));
    await Promise.race([arrival,pending.then(result=>{throw result.error??new Error('Fake native gate completed without a held receipt');}),new Promise((_,reject)=>{arrivalTimer=setTimeout(()=>reject(new Error('Fake native receipt did not reach its durable callback')),4000);})]);clearTimeout(arrivalTimer);
    const progress=f.active.record.progress,path=join(f.plan.directory,'progress-'+String(progress.sequence).padStart(8,'0')+'.json'),saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.phase,'worker-started');assert.equal(saved.details.process.pid,child.pid);assert.deepEqual({sequence:progress.sequence,...await stamp(path)},progress);assert.deepEqual(await operation.observe(),before);
    const started=Date.now();stopping=f.manager.stop();const result=await Promise.race([Promise.all([pending,stopping]),new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(new Error('Native Stop exceeded 4200 ms while a durable callback was held and child exit was unconfirmed')),4200);})]);clearTimeout(watchdog);
    assert.match(result[0].error?.message??'',/exit was not confirmed/);assert.equal(result[1].stopped,false);assert.equal(f.manager.nativeBlocked,true);assert.equal(f.manager.blocked,true);assert(signals.includes('SIGKILL'));assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
    assert.deepEqual(await operation.observe(),before);assert.equal(released,'');assert.equal(input,'');release();await callback;await sleep(25);assert.equal(released,'','Late durable callback must not release an unconfirmed child');assert.equal(input,'','Late durable callback must not supply mutation input');
    for(const cwd of [f.source,f.destination])await assert.rejects(f.manager.assertProject(cwd));
    await writeFile(join(f.plan.directory,'unconfirmed-gate-evidence.json'),JSON.stringify({elapsedMs:Date.now()-started,stopped:result[1],nativeBlocked:f.manager.nativeBlocked,receipt:saved,releaseBytes:released.length,inputBytes:input.length,signals},null,2)+'\n');
  }catch(error){await writeFile(join(f.plan.directory,'unconfirmed-gate-failure.json'),JSON.stringify({message:error.message,nativeBlocked:f.manager.nativeBlocked,releaseBytes:released.length,inputBytes:input.length,signals},null,2)+'\n');throw error;}
  finally{
    clearTimeout(arrivalTimer);clearTimeout(watchdog);release();child.signalCode='SIGKILL';child.emit('exit',null,'SIGKILL');child.emit('close',null,'SIGKILL');await pending;await stopping;
    f.manager.handoffCheckpoint=checkpoint;f.manager.spawnProcess=spawn;process.kill=kill;for(const stream of streams)stream.destroy();await f.manager.close();
  }
}
async function evidence(){assert.deepEqual(await sourceHashes(),sources,'Sources and helper must stay frozen throughout the gate.');await writeFile(join(root,'evidence.json'),JSON.stringify({root,nativeHelper,sources,tests,workers,onlyUnconfirmed,onlyOwner,onlyAttempts,passed:true,scope:'Disposable Git, actual native gated helpers, fake Coding family, separate exited manager fixture, one synthetic non-exiting child and restamped attempt journals; no engine inference or historical process signaling.'},null,2)+'\n');console.log(JSON.stringify({root,checks:tests.length,passed:true}));}
if(process.argv.includes('--owner-fixture')){const child=await fixture('exited-owner');process.stdout.write(JSON.stringify({dataDir:child.dataDir,id:child.plan.id,source:child.source,destination:child.destination,owner:child.plan.processProtocol.manager})+'\n');process.exit(0);}
async function attemptChecks(){
  const f=await fixture('attempts');
  await check('initial process journal explicitly binds the original attempt',async()=>{
    const review=await f.manager.exclusive(epoch=>f.manager.readHandoffRecovery(f.plan.id,epoch));assert.equal(review.processJournal.version,2,'Process recovery inspection must distinguish each reviewed attempt.');assert.deepEqual(review.processJournal.attempts,[{id:f.plan.id,sequence:0,target:f.destination,processProtocol:f.plan.processProtocol}]);
  });
  for(const operation of [await gitOperation(f,'attempt-origin'),await nativeOperation(f,'copy','attempt-next')])await operation.verify(await operation.run());
  const saved=await f.manager.exclusive(epoch=>f.manager.readHandoffRecovery(f.plan.id,epoch)),actual=saved.processJournal.workers.map(({attemptId,sequence,...row})=>row);assert.equal(actual.length,2);await f.manager.close();
  const manager=new ManagedWorktrees({dataDir:f.dataDir,nativeHelper});await manager.load();const h=manager.handoffs.find(row=>row.id===f.plan.id),manifestPath=join(f.plan.directory,'manifest.json'),originalManifest=JSON.parse(await readFile(manifestPath,'utf8')),current=structuredClone(originalManifest.processProtocol);
  const read=()=>manager.exclusive(epoch=>manager.readHandoffRecovery(h.id,epoch)),inspect=review=>manager.exclusive(epoch=>manager.inspectHandoffProcesses(review,epoch));
  const prior=()=>{const value=structuredClone(current);value.bootSession=randomUUID().toUpperCase();value.manager.bootSession=value.bootSession;return value;},old=prior();
  let receipts=[],lastAttemptId=h.id;
  const fingerprint=progress=>hash(JSON.stringify({id:h.id,recovery:h.recovery,progress,receipts:receipts.map(row=>row.stamp)}));
  async function reset(protocol=current){
    const manifest=structuredClone(originalManifest);if(protocol===null){manifest.version=2;delete manifest.processProtocol;}else{manifest.processProtocol=protocol;if(protocol.version===1){manifest.version=3;for(const label of ['source','destination'])delete manifest.stages[label].immutable;}}
    await writeFile(manifestPath,JSON.stringify(manifest));h.recovery.manifest=await stamp(manifestPath);for(const name of (await readdir(f.plan.directory)).filter(name=>/^progress-\d{8}\.json$/.test(name)))await unlink(join(f.plan.directory,name));delete h.progress;receipts=[];lastAttemptId=h.id;await manager.save();
  }
  async function append(phase,details,{commit=true}={}){
    const sequence=receipts.length+1,path=join(f.plan.directory,'progress-'+String(sequence).padStart(8,'0')+'.json'),entry={version:1,id:h.id,manifestHash:h.recovery.manifest.hash,sequence,phase,previous:receipts.at(-1)?.stamp??null,details:structuredClone(details)};await writeFile(path,JSON.stringify(entry),{flag:'wx',mode:0o600,flush:true});const row={entry,stamp:{sequence,...await stamp(path)}};receipts.push(row);if(commit){h.progress=row.stamp;await manager.save();}return row;
  }
  async function start(overrides={},options){
    const details={id:randomUUID(),previousAttemptId:lastAttemptId,target:f.source,processProtocol:structuredClone(current),reviewProgress:structuredClone(h.progress??null),...overrides};if(!Object.hasOwn(overrides,'reviewFingerprint'))details.reviewFingerprint=fingerprint(details.reviewProgress);const row=await append('recovery-attempt-started',details,options);lastAttemptId=details.id;return row;
  }
  const worker=(index,boot)=>{const value=structuredClone(actual[index]);value.process.bootSession=boot;return value;};
  async function unchanged(fn){const ledger=await stamp(manager.ledger),source=await readFile(join(f.source,'file'),'utf8'),destination=await readFile(join(f.destination,'file'),'utf8'),result=await fn();assert.deepEqual(await stamp(manager.ledger),ledger);assert.equal(await readFile(join(f.source,'file'),'utf8'),source);assert.equal(await readFile(join(f.destination,'file'),'utf8'),destination);for(const cwd of [f.source,f.destination])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});return result;}
  try{
    if(onlyAdmission){
      const unrelated=join(root,'unrelated');await mkdir(unrelated);
      const durable=async()=>({ledger:await stamp(manager.ledger),manifest:await stamp(manifestPath),receipts:await Promise.all((await readdir(f.plan.directory)).filter(n=>n.startsWith('progress-')).sort().map(n=>stamp(join(f.plan.directory,n)))),source:hash(await readFile(join(f.source,'file'))),destination:hash(await readFile(join(f.destination,'file')))});
      await check('same-boot handoff refuses Full Access without changing evidence',async()=>{const before=await durable();await assert.rejects(manager.assertUnconfinedAccess(),/prior-boot/);assert.deepEqual(await durable(),before);});
      await reset(old);await append('worker-started',worker(0,old.bootSession));
      if(process.argv.includes('--reboot-root-repro')){
        const {rebootFixture}=await import('../checks/reboot-adoption-fixture.mjs');
        await rebootFixture({dataDir:f.dataDir,directory:f.plan.directory,source:fileURLToPath(new URL('.',import.meta.url)),nativeHelper,check});
        return;
      }
      let status;
      await check('exact prior-boot handoff grants a read-only proof and keeps target fences',async()=>{
        const before=await durable();status=await manager.inspectUnconfinedAccess();assert.equal(status.bootSession,current.bootSession);assert.deepEqual(status.handoffs,[manager.handoffOwnerContext({...originalManifest,recovery:h.recovery})]);await manager.assertUnconfinedAccess();
        manager.coding={assertUnconfinedAccess:async cwd=>assert.equal(cwd,unrelated)};
        const lease=await manager.reserveCommand({cwd:unrelated,fullAccess:true});assert(manager.commandReservation);lease.release();assert.equal(manager.commandReservation,null);
        for(const cwd of [f.source,f.destination])await assert.rejects(manager.reserveCommand({cwd,fullAccess:true}),{code:'HANDOFF_PENDING'});
        const alias=join(root,'source-alias');await symlink(f.source,alias);await assert.rejects(manager.reserveCommand({cwd:alias,fullAccess:true}),{code:'HANDOFF_PENDING'});await unlink(alias);
        assert.deepEqual(await durable(),before);
      });
      await check('target replacement during owner admission cannot dispatch',async()=>{
        const parked=unrelated+'-parked';manager.coding={assertUnconfinedAccess:async()=>{await rename(unrelated,parked);await symlink(f.source,unrelated);}};
        try{await assert.rejects(manager.reserveCommand({cwd:unrelated,fullAccess:true}),{code:'HANDOFF_PENDING'});assert.equal(manager.commandReservation,null);}finally{await unlink(unrelated);await rename(parked,unrelated);}
      });
      for(const commit of [false,true])await check('new '+(commit?'committed':'uncommitted')+' same-boot attempt invalidates earlier admission',async()=>{
        await reset(old);await append('worker-started',worker(0,old.bootSession));const proof=await manager.inspectUnconfinedAccess();await start({}, {commit});const before=await durable();await assert.rejects(proof.recheck(),/changed|prior-boot/);await assert.rejects(manager.assertUnconfinedAccess(),/prior-boot/);assert.deepEqual(await durable(),before);
      });
      await reset(old);await append('worker-started',worker(0,old.bootSession));
      await check('Stop drains a held inspection and rejects concurrent proof admission',async()=>{
        let release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r),original=manager.readHandoffRecovery.bind(manager);
        manager.readHandoffRecovery=async(...args)=>{entered();await gate;return original(...args);};
        const request=assert.rejects(manager.inspectUnconfinedAccess(),/cancelled/);await waiting;await assert.rejects(manager.inspectUnconfinedAccess(),/already/);
        let stopped=false;const stopping=manager.stop().then(r=>{stopped=true;return r;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);release();await request;assert.equal((await stopping).stopped,true);manager.readHandoffRecovery=original;
      });
      await check('Stop waits for unconfirmed inspection-helper exit and reports failure',async()=>{
        const m=new ManagedWorktrees({dataDir:f.dataDir,nativeHelper});await m.load();
        const child=new EventEmitter(),streams=Array.from({length:3},()=>new PassThrough());Object.assign(child,{pid:900000012,stdin:streams[0],stdout:streams[1],stderr:streams[2]});
        const kill=process.kill,signals=[];let entered;const arrived=new Promise(r=>entered=r);
        process.kill=(pid,signal)=>{assert.equal(pid,-child.pid,'Synthetic helper PID must never reach the kernel');signals.push(signal);return true;};
        m.spawnProcess=(_file,args)=>{assert.deepEqual(args,['--handoff-process','boot']);queueMicrotask(entered);return child;};
        let pending,stopping;
        try{
          pending=assert.rejects(m.inspectUnconfinedAccess(),/exit was not confirmed/);await arrived;
          let done=false;stopping=m.stop().then(r=>{done=true;return r;});await new Promise(r=>setImmediate(r));assert.equal(done,false);
          await pending;assert.equal((await stopping).stopped,false);assert.equal(m.nativeBlocked,true);assert(signals.includes('SIGKILL'));
        }finally{child.emit('exit',null,'SIGKILL');child.emit('close',null,'SIGKILL');await pending;await stopping;process.kill=kill;for(const stream of streams)stream.destroy();await m.close();}
      });
      return;
    }
    for(const commit of [false,true])await check((commit?'committed':'uncommitted')+' mixed-boot attempts bind workers to the reviewed prefix and retain the original owner projection',async()=>{
      await reset(old);const first=await append('worker-started',worker(0,old.bootSession));await append('inspection-note',{message:'reviewed but not committed tail'},{commit:false});const before=await read();assert.equal(before.fingerprint,fingerprint(first.stamp));
      const attempt=await start({reviewFingerprint:before.fingerprint,reviewProgress:first.stamp},{commit});await append('worker-started',worker(1,current.bootSession),{commit});
      const review=await unchanged(read);assert.equal(review.processJournal.version,2);assert.equal(review.processJournal.bootSession,old.bootSession);assert.deepEqual(review.processJournal.manager,old.manager);assert.equal(review.processJournal.legacy,false);
      assert.deepEqual(review.processJournal.attempts,[{id:h.id,sequence:0,target:f.destination,processProtocol:old},{sequence:3,...attempt.entry.details}]);
      assert.deepEqual(review.processJournal.workers,[{sequence:1,...worker(0,old.bootSession),attemptId:h.id},{sequence:4,...worker(1,current.bootSession),attemptId:attempt.entry.details.id}]);assert.deepEqual(review.uncommitted.map(row=>row.sequence),commit?[]:[2,3,4]);
      const proof=await unchanged(()=>inspect(review));assert.equal(proof.version,2);assert.equal(proof.priorBoot,false);assert.equal(proof.priorBootProcessesAbsent,false);assert.equal(proof.managerQuiescence,'live');assert.equal(proof.engineQuiescence,'unverified');assert.equal(proof.helpersQuiescent,true);assert.deepEqual(proof.manager,proof.attempts[0].manager);assert.deepEqual(proof.manager.process,old.manager);
      assert.deepEqual(proof.attempts.map(({manager,...row})=>row),[{id:h.id,sequence:0,target:f.destination,bootSession:old.bootSession,priorBoot:true,managerQuiescence:'prior-boot'},{id:attempt.entry.details.id,sequence:3,target:f.source,bootSession:current.bootSession,priorBoot:false,managerQuiescence:'live'}]);assert.deepEqual(proof.attempts[1].manager.process,current.manager);
      assert.deepEqual(proof.workers.map(row=>row.attemptId),[h.id,attempt.entry.details.id]);assert.equal(proof.workers[0].inspection.priorBoot,true);assert.equal(proof.workers[1].inspection.priorBoot,false);
      await writeFile(join(root,commit?'attempts-committed-evidence.json':'attempts-tail-evidence.json'),JSON.stringify({review,proof},null,2)+'\n');
    });
    for(const [name,change] of [
      ['initial attempt ID reuse',()=>({id:h.id})],['wrong predecessor',()=>({previousAttemptId:randomUUID()})],['unowned target',()=>({target:root})],['unknown attempt field',()=>({extra:true})],['legacy attempt protocol',()=>({processProtocol:{version:1,bootSession:current.bootSession}})],['foreign manager boot',()=>({processProtocol:{...current,manager:{...current.manager,bootSession:old.bootSession}}})],['wrong review fingerprint',()=>({reviewFingerprint:'0'.repeat(64)})],['changed reviewed stamp',()=>({reviewProgress:{...receipts[0].stamp,hash:'0'.repeat(64)}})],['future reviewed stamp',()=>({reviewProgress:{...receipts[0].stamp,sequence:3}})]
    ])await check('attempt reader rejects '+name,async()=>{await reset(old);await append('worker-started',worker(0,old.bootSession));await start(change());await unchanged(()=>assert.rejects(read,/attempt|review|progress|fingerprint|protocol|identity|boot|fields|target/i));});
    await check('attempt reader rejects a repeated recovery attempt ID',async()=>{await reset(old);const first=await start();await start({id:first.entry.details.id});await unchanged(()=>assert.rejects(read,/attempt|repeat|duplicate|identity/i));});
    await check('attempt review fingerprint must include the entire observed uncommitted prefix',async()=>{
      await reset(old);await append('worker-started',worker(0,old.bootSession));const incomplete=fingerprint(h.progress);await append('inspection-note',{message:'uncommitted prefix'},{commit:false});await start({reviewFingerprint:incomplete});await unchanged(()=>assert.rejects(read,/review|fingerprint|attempt/i));
    });
    await check('worker boot is checked against its own recovery attempt',async()=>{await reset(old);await start();await append('worker-started',worker(1,old.bootSession));await unchanged(()=>assert.rejects(read,/worker|process|boot/i));});
    await check('failure-only recovery attempt neither changes ownership nor invents an attempt',async()=>{
      await reset(current);await append('worker-started',actual[0]);await append('recovery-attempt-started',{outcome:'failed',message:'Review was not adopted'});await append('worker-started',actual[1]);const review=await unchanged(read);assert.deepEqual(review.processJournal.attempts,[{id:h.id,sequence:0,target:f.destination,processProtocol:current}]);assert.deepEqual(review.processJournal.workers.map(row=>row.attemptId),[h.id,h.id]);const proof=await unchanged(()=>inspect(review));assert.equal(proof.attempts.length,1);assert.equal(proof.managerQuiescence,'live');
    });
    const absent=structuredClone(current);absent.manager.startSec=String(BigInt(absent.manager.startSec)+1n);const legacy={version:1,bootSession:current.bootSession};
    for(const [name,initial,next,state,allPrior] of [
      ['live dominates unverified',legacy,current,'live',false],['unverified dominates absent',legacy,absent,'unverified',false],['all known prior boots',old,prior(),'prior-boot',true],['absent after prior boot',old,absent,'absent',false],['unknown original boot remains unverified',null,prior(),'unverified',false]
    ])await check('attempt inspection aggregate: '+name,async()=>{
      await reset(initial);await start({processProtocol:next,target:f.destination});const review=await unchanged(read),proof=await unchanged(()=>inspect(review));assert.equal(proof.managerQuiescence,state);assert.equal(proof.priorBoot,allPrior);assert.equal(proof.priorBootProcessesAbsent,allPrior);assert.equal(proof.engineQuiescence,'unverified');assert.deepEqual(proof.manager,proof.attempts[0].manager);assert.equal(proof.attempts.length,2);
    });
  }finally{await manager.close();}
}
if(onlyAttempts||onlyAdmission){await attemptChecks();await evidence();process.exit(0);}
async function ownerChecks(){
  await check('actual manager incarnation is live and inspection leaves the durable ledger and fences unchanged',async()=>{
    const f=await fixture('live-owner');try{const ledger=await stamp(f.manager.ledger),review=await f.manager.exclusive(epoch=>f.manager.readHandoffRecovery(f.plan.id,epoch)),proof=await f.manager.exclusive(epoch=>f.manager.inspectHandoffProcesses(review,epoch));assert.equal(proof.managerQuiescence,'live');assert.equal(proof.manager.quiescent,false);assert.deepEqual(proof.manager.process,f.plan.processProtocol.manager);assert.deepEqual(proof.manager.inspection.owner,f.plan.processProtocol.manager);assert.equal(proof.engineQuiescence,'unverified');for(const cwd of [f.source,f.destination])await assert.rejects(f.manager.assertProject(cwd),{code:'HANDOFF_PENDING'});assert.deepEqual(await stamp(f.manager.ledger),ledger);}finally{await f.manager.close();}
  });
  await check('normally exited separate manager is absent without clearing either project fence',async()=>{
    const result=await exec(process.execPath,[fileURLToPath(import.meta.url),'--owner-fixture'],{env:{...env,HANDOFF_FILES_HELPER:nativeHelper},timeout:30000,maxBuffer:1048576}),saved=JSON.parse(result.stdout);assert.notEqual(saved.owner.pid,process.pid);
    const manager=new ManagedWorktrees({dataDir:saved.dataDir,nativeHelper});try{await manager.load();const ledger=await stamp(manager.ledger),review=await manager.exclusive(epoch=>manager.readHandoffRecovery(saved.id,epoch)),proof=await manager.exclusive(epoch=>manager.inspectHandoffProcesses(review,epoch));assert.equal(proof.managerQuiescence,'absent');assert.equal(proof.manager.quiescent,true);assert.deepEqual(proof.manager.process,saved.owner);assert.equal(proof.manager.inspection.priorBoot,false);if(proof.manager.inspection.owner)assert(proof.manager.inspection.owner.startSec!==saved.owner.startSec||proof.manager.inspection.owner.startUsec!==saved.owner.startUsec);assert.equal(proof.engineQuiescence,'unverified');for(const cwd of [saved.source,saved.destination])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});assert.deepEqual(await stamp(manager.ledger),ledger);await writeFile(join(root,'exited-manager-evidence.json'),JSON.stringify({saved,proof,ledger},null,2)+'\n');}finally{await manager.close();}
  });
  for(const when of ['prepare','begin'])await check('manager incarnation mismatch rejects before '+(when==='prepare'?'manifest creation':'durable begin intent'),async()=>{
    let observed,injected=false;const install=manager=>{observed=manager;const original=manager.handoffProcess;manager.handoffProcess=async function(...args){const result=await original.apply(this,args);if(args[0]==='owner'||args[0]==='inspect-owner'){injected=true;return {...result,owner:{...result.owner,...(when==='prepare'?{pid:process.pid+1}:{startUsec:(result.owner.startUsec+1)%1000000})}};}return result;};};
    try{await assert.rejects(()=>fixture('wrong-owner-'+when,{[when==='prepare'?'beforePrepare':'beforeBegin']:install}),/manager|owner|incarnation|identity/i);assert.equal(injected,true);assert.equal(observed.handoffs.length,0);assert.equal(Boolean(observed.activeHandoff),false);const parent=join(observed.root,'.handoffs');for(const name of await exists(parent)?await readdir(parent):[]){const names=await readdir(join(parent,name));if(when==='prepare')assert(!names.includes('manifest.json'));assert(!names.some(name=>name.startsWith('progress-')));}}finally{await observed?.close();}
  });
}
if(!onlyUnconfirmed)await ownerChecks();
if(onlyOwner){await evidence();process.exit(0);}
if(!onlyUnconfirmed)await attemptChecks();
await check('native Stop remains bounded when a saved callback is held and child exit is unconfirmed',unconfirmedNative);
if(onlyUnconfirmed){await evidence();process.exit(0);}

const f=await fixture('recorded');
for(const action of ['copy','materialize','publish','recoverPublish'])await check('native '+action+' waits for its saved process receipt before changing bytes',async()=>gate(f,await nativeOperation(f,action,'native-'+action),'release',{inspectLive:action==='copy'}));
for(const direct of [false,true])await check((direct?'direct publisher runner':'manager Git runner')+' waits for its saved process receipt before object creation',async()=>gate(f,await gitOperation(f,direct?'direct':'manager',{direct}),'release',{inspectLive:!direct}));
for(const kind of ['native','git'])await check(kind+' durable callback rejection retains the receipt and prevents effects',async()=>gate(f,kind==='native'?await nativeOperation(f,'copy','native-reject'):await gitOperation(f,'git-reject'),'reject'));
await f.manager.close();
const manager=new ManagedWorktrees({dataDir:f.dataDir,nativeHelper});await manager.load();const h=manager.handoffs.find(h=>h.id===f.plan.id);
const read=()=>manager.exclusive(epoch=>manager.readHandoffRecovery(h.id,epoch));
const inspect=review=>manager.exclusive(epoch=>manager.inspectHandoffProcesses(review,epoch));
const stable=async()=>({ledger:await stamp(manager.ledger),source:await readFile(join(f.source,'file'),'utf8'),destination:await readFile(join(f.destination,'file'),'utf8')});
const baseline=await stable();
await check('restart inspects every recorded native and Git group without asserting engine quiescence or removing fences',async()=>{
  const review=await read();assert.deepEqual(review.processJournal,{version:2,bootSession:f.plan.processProtocol.bootSession,manager:f.plan.processProtocol.manager,legacy:false,attempts:[{id:f.plan.id,sequence:0,target:f.destination,processProtocol:f.plan.processProtocol}],workers:workers.filter(w=>w.fixture===f.plan.id).map(({fixture,...row})=>({...row,attemptId:f.plan.id}))});
  const proof=await inspect(review);assert.equal(proof.version,2);assert.equal(proof.fingerprint,review.fingerprint);assert.equal(proof.bootSession,review.processJournal.bootSession);assert.equal(proof.priorBoot,false);assert.equal(proof.priorBootProcessesAbsent,false);assert.equal(proof.legacy,false);assert.equal(proof.helpersQuiescent,true);assert.equal(proof.engineQuiescence,'unverified');assert.equal(proof.managerQuiescence,'live');assert.equal(proof.manager.quiescent,false);assert.equal(proof.workers.length,review.processJournal.workers.length);assert.equal(proof.attempts.length,1);assert.equal(proof.attempts[0].id,f.plan.id);
  for(let i=0;i<proof.workers.length;i++){assert.equal(proof.workers[i].sequence,review.processJournal.workers[i].sequence);assert.equal(proof.workers[i].attemptId,f.plan.id);assert.deepEqual(proof.workers[i].process,review.processJournal.workers[i].process);assert.equal(proof.workers[i].quiescent,true);assert(proof.workers[i].inspection);}
  for(const cwd of [f.source,f.destination])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});assert.equal(manager.handoffs.length,1);assert.deepEqual(await stable(),baseline);
});

// Re-stamp only disposable retained artifacts, so validation reaches the schema instead of stopping at an obsolete outer hash.
const manifestPath=join(f.plan.directory,'manifest.json'),originalManifest=await readFile(manifestPath);
const originalFiles=(await readdir(f.plan.directory)).filter(name=>/^progress-\d{8}\.json$/.test(name)).sort(),originalRows=await Promise.all(originalFiles.map(async name=>({name,bytes:await readFile(join(f.plan.directory,name))})));
const originalEntries=originalRows.map(row=>JSON.parse(row.bytes));
async function rewrite(manifest,entries){
  await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});h.recovery.manifest=await stamp(manifestPath);
  for(const name of (await readdir(f.plan.directory)).filter(name=>/^progress-\d{8}\.json$/.test(name)))await unlink(join(f.plan.directory,name));
  let previous=null;
  for(let i=0;i<entries.length;i++){const entry={...structuredClone(entries[i]),version:1,id:h.id,manifestHash:h.recovery.manifest.hash,sequence:i+1,previous},path=join(f.plan.directory,'progress-'+String(i+1).padStart(8,'0')+'.json');await writeFile(path,JSON.stringify(entry),{mode:0o600,flush:true});previous={sequence:i+1,...await stamp(path)};}
  if(previous)h.progress=previous;else delete h.progress;await manager.save();
}
async function restoreJournal(){await rewrite(JSON.parse(originalManifest),originalEntries);}
const workerEntry=originalEntries.find(row=>row.phase==='worker-started');assert(workerEntry);
for(const [name,alter] of [
  ['bootstrap version',(m)=>{m.processProtocol.version=3;}],['bootstrap boot',(m)=>{m.processProtocol.bootSession='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';}],['bootstrap extra key',(m)=>{m.processProtocol.extra=true;}],
  ['unknown worker kind',(_m,e)=>{e[0].details.kind='engine';}],['worker extra key',(_m,e)=>{e[0].details.extra=true;}],['wrong worker boot',(_m,e)=>{e[0].details.process.bootSession=randomUUID().toUpperCase();}],
  ['unknown native action',(_m,e)=>{e[0].details.action='snapshot';}],['invalid Git command hash',(_m,e)=>{delete e[0].details.action;e[0].details.kind='git';e[0].details.commandHash='not-a-hash';}],
  ['invalid nonce',(_m,e)=>{e[0].details.process.nonce='not-a-nonce';}],['wrong process group',(_m,e)=>{e[0].details.process.pgid++;}],['wrong uid',(_m,e)=>{e[0].details.process.uid++;}],['invalid start identity',(_m,e)=>{e[0].details.process.startSec='0';}],['process extra key',(_m,e)=>{e[0].details.process.extra=true;}],
  ['duplicate nonce',(_m,e)=>{const extra=structuredClone(e[0]);extra.details.process.startUsec=(extra.details.process.startUsec+1)%1000000;e.push(extra);}],['duplicate incarnation',(_m,e)=>{const extra=structuredClone(e[0]);extra.details.process.nonce=randomUUID();e.push(extra);}]
])await check('restart rejects '+name,async()=>{const manifest=JSON.parse(originalManifest),entries=[structuredClone(workerEntry)];alter(manifest,entries);try{await rewrite(manifest,entries);await assert.rejects(read,/process|worker|boot|receipt|fields|manifest/i);}finally{await restoreJournal();}});
await check('bootstrap boot UUID with final LF rejects even with no workers',async()=>{
  const manifest=JSON.parse(originalManifest);manifest.processProtocol.bootSession+='\n';try{await rewrite(manifest,[]);await assert.rejects(read,/process|boot|manifest/i);}finally{await restoreJournal();}
});
for(const [name,alter] of [
  ['owner boot',o=>{o.bootSession=randomUUID().toUpperCase();}],['owner uid',o=>{o.uid++;}],['owner pid',o=>{o.pid=0;}],['owner process group',o=>{o.pgid=0;}],['owner start identity',o=>{o.startSec='0';}],['owner start final LF',o=>{o.startSec+='\n';}],['owner microseconds',o=>{o.startUsec=1000000;}],['owner extra field',o=>{o.extra=true;}]
])await check('restart rejects malformed '+name+' without relying on worker validation',async()=>{const manifest=JSON.parse(originalManifest);alter(manifest.processProtocol.manager);try{await rewrite(manifest,[]);await assert.rejects(read,/manager|owner|process|boot|manifest|fields|identity/i);}finally{await restoreJournal();}});
await check('failure-only worker phase does not invent a worker',async()=>{
  try{await rewrite(JSON.parse(originalManifest),[workerEntry,{phase:'worker-started',details:{outcome:'failed',message:'Cancelled before release'}}]);const review=await read();assert.equal(review.processJournal.workers.length,1);assert.equal(review.processJournal.workers[0].process.nonce,workerEntry.details.process.nonce);}finally{await restoreJournal();}
});
await check('fresh inspection refuses an earlier journal fingerprint',async()=>{
  const old=await read();try{await rewrite(JSON.parse(originalManifest),[...originalEntries,{phase:'inspection-note',details:{message:'new retained receipt'}}]);await assert.rejects(()=>inspect(old),/changed|fingerprint|review|journal/i);}finally{await restoreJournal();}
});
await check('inspection rejects a journal changed after the native query',async()=>{
  const original=manager.handoffProcess;let changed=false;
  manager.handoffProcess=async function(...args){const result=await original.apply(this,args);if(args[0]==='inspect'&&!changed){changed=true;await rewrite(JSON.parse(originalManifest),[...originalEntries,{phase:'inspection-note',details:{message:'concurrent retained receipt'}}]);}return result;};
  try{const review=await read();await assert.rejects(()=>inspect(review),/changed|fingerprint|review|journal/i);assert.equal(changed,true);}finally{manager.handoffProcess=original;await restoreJournal();}
});
await check('native inspection rejects a process start identity with final LF',async()=>{
  const original=manager.handoffProcess;let injected=false;
  manager.handoffProcess=async function(...args){const result=await original.apply(this,args);if(args[0]==='inspect'&&!injected){injected=true;const {nonce,...identity}=args[1];return {...result,leader:{...identity,startSec:'1700000000\n'}};}return result;};
  try{await assert.rejects(()=>read().then(inspect),/process|incarnation|identity/i);assert.equal(injected,true);}finally{manager.handoffProcess=original;}
});
await check('simulated PID reuse proves only the saved manager incarnation absent and retains both fences',async()=>{
  const original=manager.handoffProcess;try{for(const field of ['startSec','startUsec']){
    let injected=false;manager.handoffProcess=async function(...args){const result=await original.apply(this,args);if(args[0]==='inspect-owner'){injected=true;return {...result,owner:{...result.owner,[field]:field==='startSec'?String(BigInt(result.owner.startSec)+1n):(result.owner.startUsec+1)%1000000}};}return result;};
    const ledger=await stamp(manager.ledger),proof=await inspect(await read());assert.equal(injected,true);assert.equal(proof.managerQuiescence,'absent');assert.equal(proof.manager.quiescent,true);assert.equal(proof.manager.inspection.owner.pid,proof.manager.process.pid);assert.notEqual(proof.manager.inspection.owner[field],proof.manager.process[field]);assert.equal(proof.engineQuiescence,'unverified');for(const cwd of [f.source,f.destination])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});assert.deepEqual(await stamp(manager.ledger),ledger);
  }}finally{manager.handoffProcess=original;}
});
await check('same manager PID and start remain live despite changed group or uid',async()=>{
  const original=manager.handoffProcess;try{for(const field of ['pgid','uid']){
    let injected=false;manager.handoffProcess=async function(...args){const result=await original.apply(this,args);if(args[0]==='inspect-owner'){injected=true;return {...result,owner:{...result.owner,[field]:result.owner[field]+1}};}return result;};
    const ledger=await stamp(manager.ledger),proof=await inspect(await read());assert.equal(injected,true);assert.equal(proof.managerQuiescence,'live');assert.equal(proof.manager.quiescent,false);assert.equal(proof.engineQuiescence,'unverified');assert.deepEqual(await stamp(manager.ledger),ledger);
  }}finally{manager.handoffProcess=original;}
});
await check('prior-boot manager and helpers remain distinct from unverified engine authority',async()=>{
  const manifest=JSON.parse(originalManifest),entry=structuredClone(workerEntry);manifest.processProtocol.bootSession=randomUUID().toUpperCase();manifest.processProtocol.manager.bootSession=manifest.processProtocol.bootSession;entry.details.process.bootSession=manifest.processProtocol.bootSession;
  try{await rewrite(manifest,[entry]);const proof=await inspect(await read());assert.equal(proof.priorBoot,true);assert.equal(proof.helpersQuiescent,true);assert.equal(proof.managerQuiescence,'prior-boot');assert.equal(proof.manager.quiescent,true);assert.equal(proof.manager.inspection.priorBoot,true);assert.equal(proof.manager.inspection.owner,null);assert.equal(proof.engineQuiescence,'unverified');assert.equal(proof.workers[0].inspection.priorBoot,true);assert.equal(proof.workers[0].inspection.leader,null);assert.deepEqual(proof.workers[0].inspection.group,[]);assert.equal(proof.workers[0].inspection.groupQuery.bytes,0);}finally{await restoreJournal();}
});
await check('legacy v3 protocol1 can inspect workers but cannot claim manager quiescence',async()=>{
  const manifest=JSON.parse(originalManifest);manifest.version=3;for(const label of ['source','destination'])delete manifest.stages[label].immutable;manifest.processProtocol={version:1,bootSession:manifest.processProtocol.bootSession};try{await rewrite(manifest,originalEntries);const ledger=await stamp(manager.ledger),review=await read();assert.equal(review.processJournal.legacy,false);assert.equal(review.processJournal.manager,null);assert.equal(review.processJournal.workers.length,workers.filter(w=>w.fixture===f.plan.id).length);const proof=await inspect(review);assert.equal(proof.helpersQuiescent,true);assert.equal(proof.manager,null);assert.equal(proof.managerQuiescence,'unverified');assert.equal(proof.engineQuiescence,'unverified');for(const cwd of [f.source,f.destination])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});assert.deepEqual(await stamp(manager.ledger),ledger);}finally{await restoreJournal();}
});
for(const version of [2,1])await check('legacy manifest v'+version+' cannot claim helper or engine quiescence',async()=>{
  const manifest=JSON.parse(originalManifest);manifest.version=version;for(const label of ['source','destination'])delete manifest.stages[label].immutable;delete manifest.processProtocol;if(version===1)delete manifest.gitBaseline;
  try{await rewrite(manifest,[]);const review=await read();assert.deepEqual(review.processJournal,{version:2,bootSession:null,manager:null,legacy:true,attempts:[{id:f.plan.id,sequence:0,target:f.destination,processProtocol:null}],workers:[]});const proof=await inspect(review);assert.equal(proof.legacy,true);assert.equal(proof.helpersQuiescent,false);assert.equal(proof.engineQuiescence,'unverified');assert.equal(proof.managerQuiescence,'unverified');assert.equal(proof.manager,null);assert.equal(proof.priorBoot,false);assert.equal(proof.priorBootProcessesAbsent,false);for(const cwd of [f.source,f.destination])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});}finally{await restoreJournal();}
});
assert.equal(await readFile(join(f.source,'file'),'utf8'),baseline.source);assert.equal(await readFile(join(f.destination,'file'),'utf8'),baseline.destination);await manager.close();
for(const kind of ['native','git'])await check(kind+' Stop keeps a delayed saved gate closed even after its callback returns',async()=>{
  const cancelled=await fixture('stop-'+kind);try{await gate(cancelled,kind==='native'?await nativeOperation(cancelled,'copy','native-stop'):await gitOperation(cancelled,'git-stop'),'stop');const restarted=new ManagedWorktrees({dataDir:cancelled.dataDir,nativeHelper});try{await restarted.load();const review=await restarted.exclusive(epoch=>restarted.readHandoffRecovery(cancelled.plan.id,epoch));assert.equal(review.processJournal.workers.length,1);for(const cwd of [cancelled.source,cancelled.destination])await assert.rejects(restarted.assertProject(cwd),{code:'HANDOFF_PENDING'});}finally{await restarted.close();}}finally{await cancelled.manager.close();}
});
await evidence();
