import assert from 'node:assert/strict';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {mkdtemp,mkdir,writeFile,readFile,realpath,lstat,readdir,symlink,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

assert.equal(typeof ManagedWorktrees.prototype.prepareHandoffRecovery,'function','Manager must prepare one-use reviewed Restore/Finish recovery.');
assert.equal(typeof ManagedWorktrees.prototype.executeHandoffRecovery,'function','Manager must compose reviewed native, Git and family recovery.');

const nativeHelper=process.env.HANDOFF_FILES_HELPER;
assert(nativeHelper,'Set HANDOFF_FILES_HELPER to the independently compiled native fixture binary.');
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-recovery-transaction-'))),managers=[],exec=promisify(execFile);
const evidence={root,nativeHelper,tests:[],fixtures:[],children:[],passed:false,limits:['Coding lifecycle, family history and no-turn behavior are scripted fixture evidence, not actual engine integration.','Prior boot is simulated by restamping only disposable manifest, attempt/worker receipts and ledger after tracked children close. No actual reboot or historical signal.','Real Git and native helper execution; no installed app or UI acceptance.']};
const hash=value=>createHash('sha256').update(value).digest('hex'),copy=structuredClone;
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const git=async args=>(await exec('/Applications/Xcode.app/Contents/Developer/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env,timeout:20000,maxBuffer:2*1024*1024})).stdout;
const identity=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
const stamp=async path=>({identity:await identity(path),hash:hash(await readFile(path)),bytes:(await lstat(path)).size});
const names=async directory=>(await readdir(directory)).filter(name=>/^progress-\d{8}\.json$/.test(name)).sort();
const checkpointFiles=async f=>Promise.all((await names(f.directory)).map(async name=>({name,...await stamp(join(f.directory,name))})));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Bounded recovery transaction check timed out')),30000);})]);}finally{clearTimeout(timer);}};
const sourcePaths=['handoff-recovery-transaction-check.mjs','managed-worktrees.mjs','handoff-recovery-stage.mjs','handoff-stage.mjs','handoff-publish.mjs','handoff-native.mjs','handoff-process.mjs','git-runner.mjs'].map(name=>fileURLToPath(new URL(name,import.meta.url)));
const sourceHashes=async()=>Object.fromEntries(await Promise.all([...sourcePaths,nativeHelper].map(async path=>[path,hash(await readFile(path))])));
function spawned(file,args,options){const child=spawn(file,args,options),row={file,args:args.slice(0,4),pid:child.pid,releaseBytes:0};evidence.children.push(row);if(child.stdio[4]){const end=child.stdio[4].end;child.stdio[4].end=function(value,...rest){if(typeof value==='string'||Buffer.isBuffer(value))row.releaseBytes+=Buffer.byteLength(value);return end.call(this,value,...rest);};}child.once('close',(code,signal)=>Object.assign(row,{closed:true,code,signal}));return child;}
async function check(name,fn){if(process.env.HANDOFF_RECOVERY_CASE&&!name.includes(process.env.HANDOFF_RECOVERY_CASE))return;const data=await fn();evidence.tests.push({name,passed:true,data});console.log('PASS '+name);await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');}
const lines=Array.from({length:20},(_,i)=>'line '+i+'\n');

async function fixture(label,{priorBoot=true}={}){
  const dir=join(root,label),source=join(dir,'source'),dataDir=join(dir,'data');await mkdir(source,{recursive:true});await git(['init','-b','main',source]);await git(['-C',source,'config','user.name','Fixture']);await git(['-C',source,'config','user.email','fixture@localhost']);
  await writeFile(join(source,'text'),lines.join(''));await writeFile(join(source,'.gitignore'),'ignored/\n');await writeFile(join(source,'binary'),Buffer.from([0,1,255]));await symlink('old-target',join(source,'link'));await git(['-C',source,'add','.']);await git(['-C',source,'commit','-m','base']);
  let manager,lease=null,fence=null,clock=Date.now();const calls={prepareRecovery:0,recover:0,stops:0,releases:0,resumes:[],completeCallbacks:0,turnStarts:0,threadStarts:0};
  let family={rootThreadId:'test-root',cwd:source,model:'unchanged-local-model',modelProvider:'local',members:[{id:'test-root',parentThreadId:null,archived:false,cwd:source,lastTurnId:'root-turn',model:'unchanged-local-model',modelProvider:'local'},{id:'test-child',parentThreadId:'test-root',archived:true,cwd:source,lastTurnId:'child-turn',model:'unchanged-local-model',modelProvider:'local'}],fingerprint:'fixture-original'};
  for(const [i,member] of family.members.entries())member.compatibility={version:1,headerHash:hash(member.id),identity:{dev:'1',ino:String(i+1)}};
  const originalFamily=copy(family);
  const coding={
    projectMutationInventory:async()=>[family.cwd],prepareHandoff:async()=>copy(family),handoffTemporary:async()=>null,
    checkHandoffAuthority(target,authority,context){assert.equal(authority,fence,'Exact scripted Coding fence');assert(fence&&!fence.cancelled&&!fence.released,'Scripted fence is revoked or released');assert.equal(target,fence.destination);assert.equal(context.lease,lease);assert(lease&&!lease.pending);assert.deepEqual(context.snapshot,fence.snapshot);},
    async stopHandoff(authority,context){assert.equal(authority,fence);assert.equal(context.lease,lease);assert.deepEqual(context.snapshot,fence.snapshot);fence.cancelled=true;calls.stops++;return {state:'stopped'};},
    async relocateFamily(snapshot,destination,{bind,checkpoint,transfer}){
      fence={snapshot:copy(snapshot),destination,cancelled:false,running:true};let started=false;
      const guard=()=>coding.checkHandoffAuthority(destination,fence,{snapshot,lease});
      try{await bind(fence);guard();await checkpoint('family-archive-intent',{snapshot,destination});started=true;family={...family,members:family.members.map(t=>({...t,archived:true}))};await checkpoint('family-unloaded');guard();await checkpoint('family-transfer-intent');await transfer();throw new Error('Fixture must interrupt forward destination publication.');}
      catch(error){throw Object.assign(error,{handoffStarted:started});}finally{fence.running=false;}
    },
    async prepareHandoffRecovery(snapshot,destination,journal,filesystem){
      assert.equal(filesystem,null,'An ordinary unreconnected handoff carries no mount normalization admission');
      assert(lease?.pending);assert.equal(lease.paths,null,'Family recovery review is inside pending lease resolver');calls.prepareRecovery++;
      assert.deepEqual(snapshot,originalFamily);assert.equal(destination,record.cwd);assert(journal.intents.some(row=>row.phase==='family-archive-intent'));
      fence={snapshot:copy(snapshot),destination,originalDestination:destination,cancelled:false,running:false,lease,recovery:{journal:copy(journal),observed:copy(family),consumed:false}};
      const value={version:1,id:randomUUID(),snapshot:copy(snapshot),destination,observed:copy(family),journalFingerprint:hash(JSON.stringify(journal))};fence.recovery.review={...value,fingerprint:hash(JSON.stringify(value))};lease.recoveryFence=fence;return fence.recovery.review;
    },
    async recoverHandoffFamily(review,target,{bind,checkpoint,transfer,complete}){
      assert.equal(review,fence.recovery.review);assert.equal(fence.lease,lease);assert(!lease.pending);assert([source,record.cwd].every(path=>lease.paths.includes(path)));assert(!fence.recovery.consumed&&!fence.running);assert.deepEqual(family,review.observed);calls.recover++;
      fence.destination=target;fence.recovery.consumed=true;fence.running=true;let started=false;
      const snapshot=fence.snapshot,guard=()=>coding.checkHandoffAuthority(target,fence,{snapshot,lease});
      try{
        await bind(fence);guard();await checkpoint('family-archive-intent',{snapshot,destination:target,recoveryReview:review.fingerprint});guard();started=true;
        family={...family,members:family.members.map(t=>({...t,archived:true}))};await checkpoint('family-unloaded');guard();await checkpoint('family-transfer-intent');await transfer();guard();await checkpoint('family-transferred');
        await manager.assertProject(target,fence);guard();
        for(const member of snapshot.members){await checkpoint('family-resume-intent',{threadId:member.id,destination:target});calls.resumes.push(member.id);if(member.archived)await checkpoint('family-rearchive-intent',{threadId:member.id,destination:target});}
        family={...copy(snapshot),cwd:target,members:snapshot.members.map(t=>({...t,cwd:target})),fingerprint:hash(target)};await checkpoint('family-verified',copy(family));guard();assert.equal(typeof complete,'function','Manager final proof must run before the scripted engine releases its family fence');calls.completeCallbacks++;await complete(copy(family));fence.released=true;return copy(family);
      }catch(error){throw Object.assign(error,{handoffStarted:started});}finally{fence.running=false;}
    }
  };
  const reserveMutation=async resolve=>{assert.equal(lease,null);const handle={pending:true,paths:null,release(){assert.equal(lease,handle);if(handle.recoveryFence&&!handle.recoveryFence.running&&!handle.recoveryFence.recovery.consumed)handle.recoveryFence.recovery.review=null;lease=null;calls.releases++;}};lease=handle;try{handle.paths=await resolve();handle.pending=false;return handle;}catch(error){handle.release();throw error;}};
  const makeManager=()=>{manager=new ManagedWorktrees({dataDir,nativeHelper,coding,reserveMutation,spawnProcess:spawned,now:()=>clock});managers.push(manager);return manager;};
  makeManager();const creation=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,record=(await manager.handle({action:'create',planId:creation.id})).worktree;
  const staged=[...lines];staged[1]='STAGED\n';const working=[...staged];working[18]='WORKING\n';await writeFile(join(source,'text'),staged.join(''));await git(['-C',source,'add','text']);await writeFile(join(source,'text'),working.join(''));await writeFile(join(source,'untracked'),'move me');await mkdir(join(source,'empty'));await mkdir(join(source,'ignored'));await writeFile(join(source,'ignored','untouched'),'preserved ignored');await writeFile(join(record.cwd,'destination-only'),'keep me');
  const prepared=(await manager.handle({action:'prepareHandoff',id:record.id,threadId:family.rootThreadId})).plan,forward=manager.plans.get(prepared.id),checkpoint=manager.handoffCheckpoint.bind(manager);
  manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);if(args[1]==='native-destination-published')throw new Error('Fixture forward interruption after destination publication');};
  await assert.rejects(manager.exclusive(epoch=>manager.executeHandoff(forward.id,epoch)),/Fixture forward interruption/);assert(lease);assert.equal(await readFile(join(record.cwd,'text'),'utf8'),working.join(''));await manager.close();assert.equal(lease,null);fence=null;
  const restart=async({priorBoot=false}={})=>{
    await manager.close();assert.equal(lease,null);assert(evidence.children.every(row=>row.closed),'All tracked fixture helpers must close before restart or prior-boot simulation');fence=null;
    if(priorBoot){
      // Explicit simulation only: restamp this disposable authenticated chain after actual child close.
      const manifestPath=join(forward.directory,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8')),ledger=JSON.parse(await readFile(manager.ledger,'utf8')),h=ledger.handoffs.find(row=>row.id===forward.id),oldBoot=randomUUID().toUpperCase(),committed=h.progress.sequence,stamps=[];
      manifest.processProtocol.bootSession=oldBoot;manifest.processProtocol.manager.bootSession=oldBoot;await writeFile(manifestPath,JSON.stringify(manifest));h.recovery.manifest=await stamp(manifestPath);let previous=null;
      for(const name of await names(forward.directory)){
        const path=join(forward.directory,name),entry=JSON.parse(await readFile(path,'utf8')),d=entry.details;entry.manifestHash=h.recovery.manifest.hash;entry.previous=previous;
        if(d.outcome!=='failed'){
          if(entry.phase==='worker-started')d.process.bootSession=oldBoot;
          if(entry.phase==='recovery-attempt-started'){
            d.processProtocol.bootSession=oldBoot;d.processProtocol.manager.bootSession=oldBoot;d.reviewProgress=d.reviewProgress===null?null:stamps[d.reviewProgress.sequence-1];
            d.reviewFingerprint=hash(JSON.stringify({id:forward.id,recovery:h.recovery,progress:d.reviewProgress,receipts:stamps}));
          }
        }
        await writeFile(path,JSON.stringify(entry));previous={sequence:entry.sequence,...await stamp(path)};stamps.push(previous);if(entry.sequence===committed)h.progress=previous;
      }
      await writeFile(manager.ledger,JSON.stringify(ledger));
    }
    makeManager();await manager.load();
  };
  await restart({priorBoot});
  const f={label,dir,source,destination:record.cwd,dataDir,record,id:forward.id,directory:forward.directory,forward,originalFamily,coding,calls,staged:staged.join(''),working:working.join(''),get manager(){return manager;},get lease(){return lease;},get fence(){return fence;},advanceClock(ms){clock+=ms;},get family(){return copy(family);}};
  f.restart=restart;f.prepare=mode=>manager.handle({action:'prepareHandoffRecovery',id:f.id,mode});f.execute=p=>manager.handle({action:'recoverHandoff',planId:p.id});f.read=()=>manager.exclusive(epoch=>manager.readHandoffRecovery(f.id,epoch));
  evidence.fixtures.push({label,id:f.id,source,destination:f.destination,dataDir,directory:f.directory,priorBootSimulated:priorBoot});return f;
}

async function liveState(f){const rows={};for(const [label,cwd] of [['source',f.source],['destination',f.destination]]){const text=join(cwd,'text'),s=await lstat(text,{bigint:true}),gitDir=(await git(['-C',cwd,'rev-parse','--absolute-git-dir'])).trim();rows[label]={text:await stamp(text),textMetadata:{mode:String(s.mode),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),nlink:String(s.nlink)},index:await stamp(join(gitDir,'index')),head:await stamp(join(gitDir,'HEAD'))};}return rows;}
async function fenced(f,manager=f.manager){for(const cwd of [f.source,f.destination])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});}
async function unchanged(f,action){const before={live:await liveState(f),receipts:await checkpointFiles(f),ledger:await stamp(f.manager.ledger),directory:await readdir(f.directory)},start=evidence.children.length;await action();assert.deepEqual(await liveState(f),before.live);assert.deepEqual(await checkpointFiles(f),before.receipts);assert.deepEqual(await stamp(f.manager.ledger),before.ledger);assert.deepEqual(await readdir(f.directory),before.directory);assert.equal(evidence.children.slice(start).reduce((n,row)=>n+row.releaseBytes,0),0,'Refusal releases no writable worker');}
function durability(f,{afterCheckpoint,expectedPlans=1}={}){
  const checkpoint=f.manager.handoffCheckpoint.bind(f.manager),proof={plans:[],intents:[],publications:[],workers:[]};
  f.manager.handoffCheckpoint=async(active,phase,epoch,details,...rest)=>{
    await checkpoint(active,phase,epoch,details,...rest);
    if(active.attempt&&details?.outcome!=='failed'){
      if(phase==='native-recovery-plan'){
        const disk=await f.manager.readHandoffRecovery(f.id,epoch);assert.equal(disk.nativeJournal.plans.length,expectedPlans);const {sequence,uncommitted,...registered}=disk.nativeJournal.plans.at(-1);assert.deepEqual(registered,details);assert.equal(sequence,active.record.progress.sequence);assert.equal(uncommitted,false);
        for(const label of ['source','destination'])for(const kind of ['stage','capture']){const root=details.roots[label][kind];assert.deepEqual(await identity(root.path),{dev:root.dev,ino:root.ino});assert.deepEqual(await readdir(root.path),[]);assert.equal((await lstat(root.path)).mode&0o777,0o700);assert(disk.nativeJournal.roots[label].some(row=>row.path===root.path));}
        proof.plans.push(copy(details));
      }
      if(phase==='native-recovery-publishing')proof.intents.push(copy(details));
      if(phase==='native-recovery-published')proof.publications.push(copy(details));
      if(phase==='worker-started'&&details.kind==='native'){
        const child=evidence.children.findLast(row=>row.pid===details.process.pid);assert(child);assert.equal(child.releaseBytes,0,'Native worker is still gated after durable worker receipt');const disk=await f.manager.readHandoffRecovery(f.id,epoch);assert.equal(disk.nativeJournal.plans.length,expectedPlans,'All current and previous roots are journaled before materialization');
        for(const label of ['source','destination'])assert.equal(disk.nativeJournal.roots[label].length,2+2*expectedPlans);
        if(details.action==='recoverPublish'){const intent=proof.intents.at(-1);assert(intent);assert(disk.nativeJournal.intents.some(row=>row.label===intent.label&&row.input.root.path===intent.input.root.path));const entry=JSON.parse(await readFile(join(f.directory,'progress-'+String(active.record.progress.sequence).padStart(8,'0')+'.json'),'utf8'));assert.equal(entry.phase,'worker-started');}
        proof.workers.push({action:details.action,pid:details.process.pid,releaseBytesAtCheckpoint:child.releaseBytes,sequence:active.record.progress.sequence});
      }
    }
    await afterCheckpoint?.(active,phase,epoch,details);
  };return proof;
}

try{
  evidence.sources=await sourceHashes();
  await check('public recovery actions validate exact fields before exclusive dispatch',async()=>{
    const manager=Object.create(ManagedWorktrees.prototype),calls=[];let admissions=0;const id=randomUUID(),planId=randomUUID();
    manager.exclusive=async action=>{admissions++;return action(17);};
    manager.prepareHandoffRecovery=async(...args)=>{calls.push(args);return {prepared:true};};manager.executeHandoffRecovery=async(...args)=>{calls.push(args);return {executed:true};};
    for(const mode of ['restore','finish']){assert.deepEqual(await manager.handle({action:'prepareHandoffRecovery',id,mode}),{prepared:true});assert.deepEqual(calls.at(-1),[id,mode,17]);}
    assert.deepEqual(await manager.handle({action:'recoverHandoff',planId}),{executed:true});assert.deepEqual(calls.at(-1),[planId,17]);
    for(const input of [{action:'prepareHandoffRecovery',id,mode:'clear'},{action:'prepareHandoffRecovery',id},{action:'prepareHandoffRecovery',id,mode:true},{action:'prepareHandoffRecovery',id:'bad',mode:'restore'},{action:'prepareHandoffRecovery',id,mode:'finish',target:'/client/path'},{action:'recoverHandoff',planId:'bad'},{action:'recoverHandoff',planId,mode:'restore'}])await assert.rejects(manager.handle(input));
    assert.equal(admissions,3,'Invalid requests acquire no execution ownership');manager.commandReservation={};
    for(const input of [{action:'prepareHandoffRecovery',id,mode:'restore'},{action:'recoverHandoff',planId}])await assert.rejects(manager.handle(input),/generic command/);
    assert.equal(admissions,3,'Generic command reservation blocks review and execution');return {validActions:3,invalidRequests:7,reservedRequests:2};
  });
  for(const mode of ['restore','finish'])await check(mode+' composes real native and Git recovery with durable worker admission',async()=>{
    const f=await fixture(mode);try{
      await writeFile(join(f.source,'new-source'),'new source work');await writeFile(join(f.destination,'new-destination'),'new destination work');await writeFile(join(f.destination,'text'),'external destination edit');const displaced=await stamp(join(f.destination,'text')),ignored=await stamp(join(f.source,'ignored','untouched'));
      const {plan}=await f.prepare(mode);assert.equal(plan.operation,'handoff-recovery');assert.equal(plan.handoffId,f.id);assert.equal(plan.target,mode==='restore'?f.source:f.destination);assert.equal(f.calls.prepareRecovery,1);assert(f.lease&&!f.lease.pending);await fenced(f);
      const p=f.manager.plans.get(plan.id);
      assert.deepEqual(Object.keys(plan).sort(),['id','operation','handoffId','worktreeId','rootThreadId','mode','source','destination','target','phase','family','branch','files','bytes','retainedFiles','nativePolicy','recoveryDirectory','expiresAt'].sort());
      assert.equal(plan.worktreeId,f.record.id);assert.equal(plan.mode,mode);assert.equal(plan.source,f.source);assert.equal(plan.destination,f.destination);assert.equal(plan.phase,f.manager.handoffs[0].phase);assert.deepEqual(plan.branch,p.candidate.branch);assert.equal(plan.nativePolicy,p.stages.policy);
      assert(Number.isSafeInteger(plan.bytes)&&plan.bytes>=0);assert.equal(plan.bytes,Object.values(p.nativeReview).reduce((n,r)=>n+r.bytes,0));assert.equal(plan.files,Object.values(p.nativeReview).reduce((n,r)=>n+Object.keys(r.desired.stamps).length,0));assert.equal(plan.retainedFiles,Object.values(p.nativeReview).reduce((n,r)=>n+Object.keys(r.captured).length,0));
      const proof=durability(f),manifest=await stamp(join(f.directory,'manifest.json')),result=await f.execute(plan);
      assert.deepEqual(Object.keys(result).sort(),['family','handoff']);assert.deepEqual(result.handoff,{id:f.id,rootThreadId:f.originalFamily.rootThreadId,source:f.source,destination:f.destination,mode,target:plan.target,state:'complete',recoveryDirectory:f.directory});assert.equal(f.manager.handoffs.length,0);assert.equal(f.manager.activeHandoff,null);assert.equal(f.lease,null);
      assert.equal(await readFile(join(f.source,'text'),'utf8'),mode==='restore'?f.working:lines.join(''));assert.equal(await readFile(join(f.destination,'text'),'utf8'),mode==='restore'?lines.join(''):f.working);assert.equal(await git(['-C',f.source,'show',':text']),mode==='restore'?f.staged:lines.join(''));assert.equal(await git(['-C',f.destination,'show',':text']),mode==='restore'?lines.join(''):f.staged);
      assert.equal(await readFile(join(mode==='restore'?f.source:f.destination,'untracked'),'utf8'),'move me');assert.equal(await readFile(join(f.destination,'destination-only'),'utf8'),'keep me');assert.equal(await readlink(join(f.destination,'link')),'old-target');assert.deepEqual(await stamp(join(f.source,'ignored','untouched')),ignored);
      assert.deepEqual(result.family.members,f.originalFamily.members.map(t=>({...t,cwd:plan.target})));assert.equal(result.family.rootThreadId,f.originalFamily.rootThreadId);assert.equal(result.family.model,f.originalFamily.model);assert.equal(result.family.modelProvider,f.originalFamily.modelProvider);assert.deepEqual(f.calls.resumes,['test-root','test-child']);assert.equal(f.calls.turnStarts,0);assert.equal(f.calls.threadStarts,0);assert.equal(f.calls.recover,1);assert.equal(f.calls.completeCallbacks,1);assert(f.fence.released);
      assert.equal(proof.plans.length,1);assert.deepEqual(proof.intents.map(row=>row.label),['destination','source']);assert.deepEqual(proof.publications.map(row=>row.label),['destination','source']);assert.deepEqual(proof.workers.map(row=>row.action),['materialize','materialize','recoverPublish','recoverPublish']);
      for(const [label,name,text] of [['source','new-source','new source work'],['destination','new-destination','new destination work']]){const intent=proof.intents.find(row=>row.label===label);assert.equal(await readFile(join(intent.input.capture.path,intent.captured[name]),'utf8'),text);await assert.rejects(lstat(join(f[label],name)),{code:'ENOENT'});}
      const destination=proof.intents.find(row=>row.label==='destination'),retainedText=join(destination.input.capture.path,destination.captured.text);assert.equal(await readFile(retainedText,'utf8'),'external destination edit');assert.deepEqual(await identity(retainedText),displaced.identity);
      assert.deepEqual(await stamp(join(f.directory,'manifest.json')),manifest);await f.manager.exclusive(epoch=>f.manager.verifyHandoffArtifacts({...p,id:f.id},epoch));await f.manager.assertProject(f.source);await f.manager.assertProject(f.destination);await assert.rejects(f.execute(plan),/expired|consumed|unknown/);
      return {plan,result,handoff:result.handoff,proof,family:result.family,coding:callsForEvidence(f)};
    }finally{await f.manager.close();}
  });
  await check('same-boot writers remain unconfirmed without mutations',async()=>{const f=await fixture('same-boot',{priorBoot:false});try{await unchanged(f,()=>assert.rejects(f.prepare('restore'),{code:'HANDOFF_WRITERS_UNCONFIRMED'}));assert.equal(f.calls.prepareRecovery,0);assert.equal(f.lease,null);await fenced(f);return {priorBootSimulated:false};}finally{await f.manager.close();}});
  await check('changed native state after review refuses before a new attempt',async()=>{const f=await fixture('changed-native');try{const {plan}=await f.prepare('restore');await writeFile(join(f.destination,'text'),'late reviewed-state edit');await unchanged(f,()=>assert.rejects(f.execute(plan),/native state changed after review/));assert.equal(f.calls.recover,0);assert.equal(f.lease,null);await fenced(f);return {retained:await readFile(join(f.destination,'text'),'utf8')};}finally{await f.manager.close();}});
  await check('changed Git index after review refuses before a new attempt',async()=>{const f=await fixture('changed-git');try{const {plan}=await f.prepare('finish');await git(['-C',f.destination,'add','text']);await unchanged(f,()=>assert.rejects(f.execute(plan),/Git.*changed|live recovery HEAD or index is outside the retained states|review.*changed/i));assert.equal(f.calls.recover,0);assert.equal(f.lease,null);await fenced(f);return {coding:callsForEvidence(f)};}finally{await f.manager.close();}});
  await check('Cancel and expiry release one-use review leases while retaining durable fences',async()=>{const f=await fixture('cancel-expiry');try{let {plan}=await f.prepare('restore');await unchanged(f,()=>f.manager.handle({action:'stop'}));assert.equal(f.lease,null);assert.equal(f.fence.recovery.review,null);await assert.rejects(f.execute(plan),/expired|consumed|unknown/);await fenced(f);({plan}=await f.prepare('finish'));f.advanceClock(120001);await unchanged(f,()=>assert.rejects(f.execute(plan),/expired/));assert.equal(f.lease,null);assert.equal(f.fence.recovery.review,null);await fenced(f);assert.equal(f.calls.recover,0);return {coding:callsForEvidence(f)};}finally{await f.manager.close();}});
  await check('interruption after native recovery publication leaves reader-discoverable roots and fences',async()=>{const f=await fixture('recovery-interruption');try{
    const {plan}=await f.prepare('restore'),proof=durability(f,{afterCheckpoint:async(active,phase,epoch,details)=>{if(phase==='native-recovery-published'&&details.label==='destination')throw new Error('Fixture interruption after recovery destination publication');}});await assert.rejects(f.execute(plan),/Fixture interruption/);assert(f.lease);assert.equal(f.manager.handoffs[0].state,'needs-inspection');await fenced(f);await f.manager.close();assert.equal(f.lease,null);
    const reader=new ManagedWorktrees({dataDir:f.dataDir,nativeHelper,spawnProcess:spawned});managers.push(reader);await reader.load();const review=await reader.exclusive(epoch=>reader.readHandoffRecovery(f.id,epoch));assert.equal(review.nativeJournal.plans.length,1);assert.equal(review.nativeJournal.intents.length,1);assert.equal(review.nativeJournal.results.length,1);for(const label of ['source','destination']){assert.equal(review.nativeJournal.roots[label].length,4);for(const root of review.nativeJournal.roots[label])assert.deepEqual(await identity(root.path),{dev:root.dev,ino:root.ino});}assert.equal(await readFile(join(f.destination,'text'),'utf8'),lines.join(''));assert.equal(await readFile(join(f.source,'text'),'utf8'),f.working);assert((await readdir(proof.plans[0].roots.source.stage.path)).length>0);await fenced(f,reader);await reader.close();return {proof,nativeJournal:review.nativeJournal};
  }finally{await f.manager.close();}});
  for(const mode of ['restore','finish'])await check(mode+' retries public recovery across registered manager attempts',async()=>{const f=await fixture('retry-'+mode);try{
    await writeFile(join(f.source,'new-source'),'source work before retry');await writeFile(join(f.destination,'new-destination'),'destination work before retry');await writeFile(join(f.destination,'text'),'first displaced edit');const firstText=await stamp(join(f.destination,'text')),ignored=await stamp(join(f.source,'ignored','untouched'));
    const {plan:firstPlan}=await f.prepare(mode),firstProof=durability(f,{afterCheckpoint:async(active,phase,epoch,details)=>{if(phase==='native-recovery-published'&&details.label==='destination')throw new Error('Fixture retry interruption after native destination publication');}});
    await assert.rejects(f.execute(firstPlan),/Fixture retry interruption/);assert(f.lease);await fenced(f);assert.equal(f.calls.recover,1);assert.equal(f.calls.completeCallbacks,0);assert.deepEqual(f.calls.resumes,[]);
    const firstIntent=firstProof.intents[0],retainedText=join(firstIntent.input.capture.path,firstIntent.captured.text),retainedDestination=join(firstIntent.input.capture.path,firstIntent.captured['new-destination']);assert.equal(await readFile(retainedText,'utf8'),'first displaced edit');assert.deepEqual(await stamp(retainedText),firstText);assert.equal(await readFile(retainedDestination,'utf8'),'destination work before retry');
    const interrupted=await f.read();assert.equal(interrupted.processJournal.attempts.length,2);assert.equal(interrupted.nativeJournal.plans.length,1);assert.equal(interrupted.nativeJournal.intents.length,1);assert.equal(interrupted.nativeJournal.results.length,1);
    await f.restart();await fenced(f);await unchanged(f,()=>assert.rejects(f.prepare(mode),{code:'HANDOFF_WRITERS_UNCONFIRMED'}));assert.equal(f.calls.prepareRecovery,1,'A closed same-boot fixture is still not prior-boot proof');
    await f.restart({priorBoot:true});await fenced(f);const reviewed=await f.read();assert.equal(reviewed.processJournal.attempts.length,2);assert.deepEqual(reviewed.nativeJournal,interrupted.nativeJournal);assert(reviewed.processJournal.attempts.every(row=>row.processProtocol.bootSession===reviewed.processJournal.bootSession));
    await writeFile(join(f.destination,'text'),'second displaced edit');const secondText=await stamp(join(f.destination,'text')),manifest=await stamp(join(f.directory,'manifest.json')),prefix=await checkpointFiles(f),oldCaptures=[await stamp(retainedText),await stamp(retainedDestination)];
    const {plan}=await f.prepare(mode),p=f.manager.plans.get(plan.id);assert.notEqual(plan.id,firstPlan.id);assert.equal(plan.target,mode==='restore'?f.source:f.destination);await fenced(f);
    for(const label of ['source','destination'])assert.deepEqual(p.nativeReview[label].observed.roots.map(row=>row.root),[p.native[label].root,...reviewed.nativeJournal.roots[label]]);
    let finalReview;const fencedPhases=[],proof=durability(f,{expectedPlans:2,afterCheckpoint:async(active,phase,epoch,details)=>{
      if(!['native-recovery-published','family-verified','recovery-complete-verified'].includes(phase)||details?.outcome==='failed')return;
      await fenced(f);assert(f.lease);assert(!f.fence.released);assert((JSON.parse(await readFile(f.manager.ledger,'utf8'))).handoffs.some(row=>row.id===f.id));fencedPhases.push(phase);
      if(phase==='recovery-complete-verified')finalReview=await f.manager.readHandoffRecovery(f.id,epoch);
    }}),result=await f.execute(plan);
    assert(finalReview);assert.equal(finalReview.processJournal.attempts.length,3,'Exactly original, interrupted recovery and completed retry attempts');const attempts=finalReview.processJournal.attempts;assert.equal(attempts[1].previousAttemptId,attempts[0].id);assert.equal(attempts[2].previousAttemptId,attempts[1].id);assert.equal(attempts[2].target,plan.target);assert.equal(new Set(attempts.map(row=>row.id)).size,3);
    assert.equal(finalReview.nativeJournal.plans.length,2);assert.equal(finalReview.nativeJournal.intents.length,3);assert.equal(finalReview.nativeJournal.results.length,3);assert.deepEqual(finalReview.nativeJournal.plans.map(row=>row.attemptId),attempts.slice(1).map(row=>row.id));
    for(const label of ['source','destination']){assert.equal(finalReview.nativeJournal.roots[label].length,6);for(const root of finalReview.nativeJournal.roots[label])assert.deepEqual(await identity(root.path),{dev:root.dev,ino:root.ino});}
    assert.deepEqual((await checkpointFiles(f)).slice(0,prefix.length),prefix);assert.deepEqual(await stamp(join(f.directory,'manifest.json')),manifest);assert.deepEqual([await stamp(retainedText),await stamp(retainedDestination)],oldCaptures);assert.equal(await readFile(retainedText,'utf8'),'first displaced edit');assert.equal(await readFile(retainedDestination,'utf8'),'destination work before retry');
    const sourceIntent=proof.intents.find(row=>row.label==='source'),destinationIntent=proof.intents.find(row=>row.label==='destination'),secondCapture=join(destinationIntent.input.capture.path,destinationIntent.captured.text);assert.equal(await readFile(secondCapture,'utf8'),'second displaced edit');assert.deepEqual(await stamp(secondCapture),secondText);assert.equal(await readFile(join(sourceIntent.input.capture.path,sourceIntent.captured['new-source']),'utf8'),'source work before retry');
    assert.equal(await readFile(join(f.source,'text'),'utf8'),mode==='restore'?f.working:lines.join(''));assert.equal(await readFile(join(f.destination,'text'),'utf8'),mode==='restore'?lines.join(''):f.working);assert.equal(await git(['-C',f.source,'show',':text']),mode==='restore'?f.staged:lines.join(''));assert.equal(await git(['-C',f.destination,'show',':text']),mode==='restore'?lines.join(''):f.staged);
    assert.equal(await readFile(join(plan.target,'untracked'),'utf8'),'move me');assert.equal(await readFile(join(f.destination,'destination-only'),'utf8'),'keep me');assert.equal(await readlink(join(f.destination,'link')),'old-target');assert.deepEqual(await stamp(join(f.source,'ignored','untouched')),ignored);for(const [label,name] of [['source','new-source'],['destination','new-destination']])await assert.rejects(lstat(join(f[label],name)),{code:'ENOENT'});
    assert.deepEqual(result.family.members,f.originalFamily.members.map(t=>({...t,cwd:plan.target})));assert.equal(result.family.rootThreadId,f.originalFamily.rootThreadId);assert.equal(result.family.model,f.originalFamily.model);assert.equal(result.family.modelProvider,f.originalFamily.modelProvider);assert.deepEqual(f.calls.resumes,['test-root','test-child']);assert.equal(f.calls.turnStarts,0);assert.equal(f.calls.threadStarts,0);assert.equal(f.calls.prepareRecovery,2);assert.equal(f.calls.recover,2);assert.equal(f.calls.completeCallbacks,1);assert(f.fence.released);
    assert.deepEqual(fencedPhases,['native-recovery-published','native-recovery-published','family-verified','recovery-complete-verified']);assert.equal(result.handoff.state,'complete');assert.equal(f.manager.handoffs.length,0);assert.equal(f.manager.activeHandoff,null);assert.equal(f.manager.handoffAdmission,null);assert.equal(f.lease,null);await f.manager.assertProject(f.source);await f.manager.assertProject(f.destination);await assert.rejects(f.execute(firstPlan),/expired|consumed|unknown/);await assert.rejects(f.execute(plan),/expired|consumed|unknown/);
    return {mode,firstPlan,plan,result,firstProof,proof,attempts,nativeJournal:finalReview.nativeJournal,fencedPhases,retained:[retainedText,retainedDestination,secondCapture],coding:callsForEvidence(f),priorBootSimulated:true};
  }finally{await f.manager.close();}});
  await check('Stop before writable native release preserves live files and registered empty roots',async()=>{const f=await fixture('stop-before-release'),entered=deferred(),resume=deferred();try{
    const {plan}=await f.prepare('finish'),before=await liveState(f);let stoppedWorker;const proof=durability(f,{afterCheckpoint:async(active,phase,epoch,details)=>{if(active.attempt&&phase==='worker-started'&&details.kind==='native'&&details.action==='materialize'&&!stoppedWorker){stoppedWorker=evidence.children.findLast(row=>row.pid===details.process.pid);entered.resolve();await resume.promise;}}});
    const work=f.execute(plan),outcome=assert.rejects(work,/cancel|authority|revoked|stopped/i);await bounded(Promise.race([entered.promise,work]));assert(stoppedWorker);assert.equal(stoppedWorker.releaseBytes,0);const stopping=f.manager.stop();resume.resolve();const [,stopped]=await bounded(Promise.all([outcome,stopping]));assert.equal(stopped.stopped,true);assert.equal(stoppedWorker.releaseBytes,0);assert.equal(stoppedWorker.closed,true);assert.equal(f.lease,null);assert.deepEqual(await liveState(f),before);assert.equal(proof.intents.length,0);assert.equal(proof.publications.length,0);
    for(const roots of Object.values(proof.plans[0].roots))for(const root of Object.values(roots))assert.deepEqual(await readdir(root.path),[]);await fenced(f);const review=await f.read();assert.equal(review.nativeJournal.plans.length,1);assert.equal(review.nativeJournal.intents.length,0);return {proof,stoppedWorker,coding:callsForEvidence(f)};
  }finally{resume.resolve();await f.manager.close();}});
  await check('failed attempt ledger save preserves fence until Stop releases admission',async()=>{const f=await fixture('attempt-save-failure');try{
    const {plan}=await f.prepare('restore'),before=await liveState(f),save=f.manager.saveLedger.bind(f.manager);let failed=false;
    f.manager.saveLedger=async(...args)=>{if(!failed&&f.manager.activeHandoff?.recoveryReview){failed=true;throw new Error('Fixture recovery attempt ledger save failed');}return save(...args);};
    await assert.rejects(f.execute(plan),/Fixture recovery attempt ledger save failed/);assert(failed);assert(f.lease);assert(f.manager.activeHandoff?.recoveryReview);const reader=new ManagedWorktrees({dataDir:f.dataDir,nativeHelper});managers.push(reader);await reader.load();const review=await reader.exclusive(epoch=>reader.readHandoffRecovery(f.id,epoch));assert.equal(review.processJournal.attempts.length,2);assert.equal(review.nativeJournal.plans.length,0);await fenced(f,reader);await reader.close();assert.deepEqual(await liveState(f),before);
    const stopped=await f.manager.stop();assert.equal(stopped.stopped,true);assert.equal(f.lease,null);assert.equal(f.manager.handoffAdmission,null,'Stop must release the recovery admission even when binding failed before plan enrichment');await fenced(f);return {uncommitted:review.uncommitted,stopped,coding:callsForEvidence(f)};
  }finally{await f.manager.close();}});
  await check('Stop at the final ledger precommit check preserves the durable recovery fence',async()=>{const f=await fixture('stop-before-ledger-commit'),entered=deferred(),resume=deferred();try{
    const {plan}=await f.prepare('finish'),save=f.manager.saveLedger.bind(f.manager),checkLedger=f.manager.checkLedger.bind(f.manager);let finalSave=false,checks=0,gated=false;
    f.manager.saveLedger=async(handoffs,...rest)=>{if(Array.isArray(handoffs)&&!handoffs.some(row=>row.id===f.id)){assert(!finalSave);finalSave=true;checks=0;try{return await save(handoffs,...rest);}finally{finalSave=false;}}return save(handoffs,...rest);};
    f.manager.checkLedger=async()=>{await checkLedger();if(finalSave&&++checks===2&&!gated){gated=true;entered.resolve();await resume.promise;}};
    const work=f.execute(plan),outcome=work.then(value=>({value}),error=>({error}));await bounded(Promise.race([entered.promise,work.then(()=>{throw new Error('Recovery returned before the final ledger gate');})]));assert(gated);const before=JSON.parse(await readFile(f.manager.ledger,'utf8'));assert(before.handoffs.some(row=>row.id===f.id));const stopping=f.manager.stop();assert(f.fence.cancelled);resume.resolve();const [result,stopped]=await bounded(Promise.all([outcome,stopping]));
    const ledger=JSON.parse(await readFile(f.manager.ledger,'utf8'));assert(ledger.handoffs?.some(row=>row.id===f.id),'Stop before ledger rename must keep the durable recovery fence');assert(result.error,'Precommit Stop must reject recovery completion');assert.match(result.error.message,/cancel|authority|revoked|stopped/i);assert.equal(stopped.stopped,true);assert.equal(f.lease,null);assert.equal(f.manager.handoffAdmission,null);await fenced(f);const review=await f.read();assert.equal(review.nativeJournal.results.length,2);return {gated,checks,error:result.error.message,stopped,finalPhase:review.receipts.at(-1).entry.phase};
  }finally{resume.resolve();await f.manager.close();}});
  assert.deepEqual(await sourceHashes(),evidence.sources,'Production source/helper must remain frozen during this suite');evidence.passed=true;
}catch(error){evidence.error={message:error.message,stack:error.stack};throw error;}
finally{await Promise.allSettled(managers.map(manager=>manager.close()));await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({root,checks:evidence.tests.length,passed:evidence.passed,evidence:join(root,'evidence.json')}));}
function callsForEvidence(f){return copy(f.calls);}
