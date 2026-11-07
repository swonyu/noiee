import assert from 'node:assert/strict';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {mkdtemp,mkdir,writeFile,readFile,realpath,lstat,readdir,symlink,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';

assert.equal(typeof ManagedWorktrees.prototype.executeHandoff,'function','The manager must compose native, Git and same-family relocation under one durable transaction.');
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-transaction-'))),tests=[],exec=promisify(execFile),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git',nativeHelper=process.env.HANDOFF_FILES_HELPER;
assert(nativeHelper,'Set HANDOFF_FILES_HELPER to the independently compiled fixture binary.');
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const raw=async args=>(await exec(git,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env})).stdout;
const id=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
const lines=Array.from({length:20},(_,i)=>'line '+i+'\n'),hash=x=>createHash('sha256').update(x).digest('hex');
async function fixture(name,{newTemporary=false,unknownStop=false,clean=false}={}){
  const dir=join(root,name),source=join(dir,'source'),dataDir=join(dir,'data');await mkdir(source,{recursive:true});await raw(['init','-b','main',source]);
  await raw(['-C',source,'config','user.name','Fixture']);await raw(['-C',source,'config','user.email','fixture@localhost']);
  await writeFile(join(source,'text'),lines.join(''));await writeFile(join(source,'.gitignore'),'ignored/\n');await writeFile(join(source,'binary'),Buffer.from([0,1,255]));await symlink('old-target',join(source,'link'));
  await raw(['-C',source,'add','.']);await raw(['-C',source,'commit','-m','base']);
  let lease=null,fence=null,releases=0,stops=0;const temporary=new Map();
  let family={rootThreadId:'test-root',cwd:source,model:'unchanged-local-model',modelProvider:'local',members:[{id:'test-root',parentThreadId:null,archived:false,cwd:source,lastTurnId:'root-turn',model:'unchanged-local-model',modelProvider:'local'},{id:'test-child',parentThreadId:'test-root',archived:true,cwd:source,lastTurnId:'child-turn',model:'unchanged-local-model',modelProvider:'local'}],fingerprint:'fixture-before'};
  const coding={
    projectMutationInventory:async()=>[family.cwd],
    prepareHandoff:async()=>structuredClone(family),handoffTemporary:async cwd=>structuredClone(temporary.get(cwd)??null),
    checkHandoffAuthority(cwd,authority,context){assert.equal(authority,fence);assert(fence&&!fence.cancelled);assert.equal(cwd,fence.destination);assert.equal(context.lease,lease);assert.deepEqual(context.snapshot,fence.snapshot);},
    async stopHandoff(authority,context){assert.equal(authority,fence);assert.equal(context.lease,lease);assert.deepEqual(context.snapshot,fence.snapshot);fence.cancelled=true;stops++;if(unknownStop){fence.exitUnconfirmed=true;throw Object.assign(new Error('Fixture selected exit unconfirmed'),{code:'HANDOFF_EXIT_UNCONFIRMED'});}return {state:'stopped'};},
    async relocateFamily(snapshot,destination,{bind,checkpoint,transfer,complete}){
      fence={snapshot:structuredClone(snapshot),destination,cancelled:false};let started=false;
      const check=()=>coding.checkHandoffAuthority(destination,fence,{snapshot,lease});
      try{
        await bind(fence);check();await checkpoint('family-archive-intent',{snapshot,destination});check();started=true;
        await checkpoint('family-unloaded');check();await checkpoint('family-transfer-intent');await transfer();check();await checkpoint('family-transferred');
        await manager.assertProject(destination,fence);check();
        if(newTemporary&&!temporary.has(destination)){const path=join(destination,'.saleh-coding-tmp-'+randomUUID());await mkdir(path,{mode:0o700});await writeFile(join(path,'.saleh-owner'),'fixture');const project=await id(destination);temporary.set(destination,{cwd:destination,path,nonce:'fixture',projectDev:project.dev,projectIno:project.ino,...await id(path)});}
        for(const member of snapshot.members)await checkpoint('family-resume-intent',{threadId:member.id,destination});
        family={...structuredClone(snapshot),cwd:destination,members:snapshot.members.map(t=>({...t,cwd:destination})),fingerprint:hash(destination)};
        await checkpoint('family-verified',family);check();assert.equal(typeof complete,'function');await complete(structuredClone(family));fence=null;return structuredClone(family);
      }catch(e){throw Object.assign(e,{handoffStarted:started});}
    }
  };
  const manager=new ManagedWorktrees({dataDir,nativeHelper,coding,reserveMutation:async resolve=>{assert.equal(lease,null);await resolve();const handle={release(){assert.equal(lease,handle);lease=null;releases++;}};lease=handle;return handle;}});
  const creation=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,record=(await manager.handle({action:'create',planId:creation.id})).worktree;
  const staged=[...lines];staged[1]='STAGED\n';const working=[...staged];working[18]='WORKING\n';
  if(!clean){await writeFile(join(source,'text'),staged.join(''));await raw(['-C',source,'add','text']);await writeFile(join(source,'text'),working.join(''));await writeFile(join(source,'untracked'),'move me');await mkdir(join(source,'empty'));}await mkdir(join(source,'ignored'));await writeFile(join(source,'ignored','untouched'),'preserved ignored');
  await writeFile(join(record.cwd,'destination-only'),'keep me');
  const prepare=()=>manager.exclusive(async epoch=>{const result=await manager.prepareHandoff(record.id,'test-root',epoch);return manager.plans.get(result.plan.id);});
  const execute=p=>manager.exclusive(epoch=>manager.executeHandoff(p.id,epoch));
  return {dir,source,destination:record.cwd,dataDir,manager,coding,record,prepare,execute,staged:staged.join(''),working:working.join(''),get lease(){return lease;},get releases(){return releases;},get stops(){return stops;}};
}
async function check(name,fn){await fn();tests.push(name);console.log('PASS '+name);}
async function restartFenced(f){const restarted=new ManagedWorktrees({dataDir:f.dataDir});try{const result=await restarted.handle({action:'list'});assert.equal(result.handoffs.length,1);for(const cwd of [f.source,f.destination])await assert.rejects(restarted.assertProject(cwd),{code:'HANDOFF_PENDING'});return result.handoffs[0];}finally{await restarted.close();}}
await check('complete dirty handoff and return preserve staged versus working content and same family',async()=>{
  const f=await fixture('round-trip'),beforeFamily=await f.coding.prepareHandoff(),p=await f.prepare(),phases=[];
  const checkpoint=f.manager.handoffCheckpoint.bind(f.manager);f.manager.handoffCheckpoint=async(a,phase,epoch,details)=>{await checkpoint(a,phase,epoch,details);phases.push(phase);for(const cwd of [f.source,f.destination])await assert.rejects(f.manager.assertProject(cwd),{code:'HANDOFF_PENDING'});};
  const result=await f.execute(p);assert.equal(result.handoff.state,'complete');assert.equal(f.lease,null);assert.equal(f.manager.handoffs.length,0);assert.equal(f.manager.activeHandoff,null);
  assert.equal(await readFile(join(f.source,'text'),'utf8'),lines.join(''));assert.equal(await readFile(join(f.destination,'text'),'utf8'),f.working);assert.equal(await raw(['-C',f.destination,'show',':text']),f.staged);
  assert.equal(await readFile(join(f.destination,'untracked'),'utf8'),'move me');assert.equal(await readFile(join(f.destination,'destination-only'),'utf8'),'keep me');assert.equal(await readFile(join(f.source,'ignored','untouched'),'utf8'),'preserved ignored');assert.equal(await readlink(join(f.destination,'link')),'old-target');
  assert.equal(await raw(['-C',f.destination,'symbolic-ref','HEAD']),'refs/heads/main\n');assert.match(await raw(['-C',f.source,'rev-parse','HEAD']),/^[a-f0-9]{40}\n$/);
  assert.deepEqual(result.family.members,beforeFamily.members.map(t=>({...t,cwd:f.destination})));assert(phases.indexOf('native-destination-published')<phases.indexOf('native-source-publishing'));assert.equal(phases.at(-1),'complete-verified');
  const progress=(await readdir(p.directory)).filter(x=>/^progress-/.test(x));assert.equal(progress.length,phases.length);const final=JSON.parse(await readFile(join(p.directory,progress.sort().at(-1)),'utf8'));assert.equal(final.phase,'complete-verified');assert.equal(final.manifestHash,p.recovery.manifest.hash);
  await f.manager.assertProject(f.source);await f.manager.assertProject(f.destination);const back=await f.prepare();await f.execute(back);assert.equal(await readFile(join(f.source,'text'),'utf8'),f.working);assert.equal(await raw(['-C',f.source,'show',':text']),f.staged);assert.equal(await readFile(join(f.destination,'text'),'utf8'),lines.join(''));assert.equal((await f.coding.prepareHandoff()).rootThreadId,beforeFamily.rootThreadId);
  await writeFile(join(f.dir,'evidence.json'),JSON.stringify({phases,first:result,returnFamily:await f.coding.prepareHandoff(),progress},null,2));await f.manager.close();
});
await check('destination scratch creation is owned and independently excluded from final verification',async()=>{
  const f=await fixture('new-scratch',{newTemporary:true}),p=await f.prepare();await f.execute(p);assert((await f.coding.handoffTemporary(f.destination))?.path);assert.equal(f.manager.handoffs.length,0);await f.manager.close();
});
await check('clean handoff verifies unchanged native states without an empty publication',async()=>{
  const f=await fixture('clean',{clean:true}),p=await f.prepare(),native=f.manager.handoffFiles.bind(f.manager);let publishes=0;f.manager.handoffFiles=(action,...args)=>{if(action==='publish')publishes++;return native(action,...args);};
  await f.execute(p);assert.equal(publishes,0);assert.equal(await readFile(join(f.destination,'destination-only'),'utf8'),'keep me');assert.equal(f.manager.handoffs.length,0);await f.manager.close();
});
await check('changed ignore rules cannot hide a reviewed entry from final verification',async()=>{
  const f=await fixture('ignore-rules');await writeFile(join(f.source,'.gitignore'),'ignored/\ndestination-only\n');const p=await f.prepare();await f.execute(p);assert.equal(await readFile(join(f.destination,'untracked'),'utf8'),'move me');assert.equal(await readFile(join(f.destination,'destination-only'),'utf8'),'keep me');assert.equal(await raw(['-C',f.destination,'check-ignore','destination-only']),'destination-only\n');await f.manager.close();
});
await check('copied capability cannot bypass the pending project fence',async()=>{
  const f=await fixture('capability'),p=await f.prepare(),relocate=f.coding.relocateFamily;
  f.coding.relocateFamily=(snapshot,destination,callbacks)=>relocate(snapshot,destination,{...callbacks,bind:async fence=>{await callbacks.bind(fence);await assert.rejects(f.manager.assertProject(destination,{...fence}),/authority/);await assert.rejects(f.manager.assertProject(f.source,fence),/authority/);}});
  await f.execute(p);await f.manager.close();
});
for(const phase of ['family-archive-intent','native-destination-published','git-source-index-published','family-verified'])await check('failure at '+phase+' retains durable recovery and restart fences',async()=>{
  const f=await fixture('failure-'+phase),p=await f.prepare(),checkpoint=f.manager.handoffCheckpoint.bind(f.manager);f.manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);if(args[1]===phase)throw new Error('Injected failure at '+phase);};
  await assert.rejects(f.execute(p),/Injected failure/);assert.equal(f.manager.handoffs[0].state,'needs-inspection');assert(f.lease);assert.equal((await restartFenced(f)).phase,phase);await f.manager.close();assert.equal(f.lease,null);
});
for(const unknownStop of [false,true])await check('Stop '+(unknownStop?'retains an uncertain selected engine lease':'awaits selected engine and manager publication'),async()=>{
  const f=await fixture(unknownStop?'stop-unknown':'stop-known',{unknownStop}),p=await f.prepare(),checkpoint=f.manager.handoffCheckpoint.bind(f.manager);let reached,continueCheckpoint;const atPhase=new Promise(r=>{reached=r;}),resume=new Promise(r=>{continueCheckpoint=r;});
  f.manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);if(args[1]==='native-destination-published'){reached();await resume;}};
  const work=f.execute(p),failed=assert.rejects(work,/cancel|authority|unconfirmed/i);await atPhase;const stopping=f.manager.stop(),concurrent=f.manager.stop();assert.equal(stopping,concurrent);assert.equal(f.stops,1);await assert.rejects(f.manager.exclusive(()=>{}),/busy/);continueCheckpoint();const stopped=await stopping;assert.deepEqual(await concurrent,stopped);await failed;
  assert.equal(stopped.stopped,!unknownStop);assert.equal(f.manager.blocked,unknownStop);assert.equal(Boolean(f.lease),unknownStop);await restartFenced(f);
  const unrelated=join(f.dir,'unrelated');await mkdir(unrelated);await f.manager.assertProject(unrelated);for(const cwd of [f.source,f.destination])await assert.rejects(f.manager.assertProject(cwd),{code:'HANDOFF_PENDING'});await f.manager.close();
});
await check('a late edit to an unaffected destination file prevents completion',async()=>{
  const f=await fixture('late-native-edit');await writeFile(join(f.source,'.gitignore'),'ignored/\ndestination-only\n');const p=await f.prepare(),checkpoint=f.manager.handoffCheckpoint.bind(f.manager);f.manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);if(args[1]==='family-verified')await writeFile(join(f.destination,'destination-only'),'external edit');};
  await assert.rejects(f.execute(p),/full published namespace or native metadata changed/);await restartFenced(f);await f.manager.close();
});
await check('a late immutable candidate edit keeps recovery fenced after publication',async()=>{
  const f=await fixture('late-candidate-edit'),p=await f.prepare(),checkpoint=f.manager.handoffCheckpoint.bind(f.manager);
  f.manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);if(args[1]==='family-verified')await writeFile(join(p.stages.destination.immutable.root.path,'text'),'corrupted recovery candidate');};
  await assert.rejects(f.execute(p),/native recovery changed/);assert.equal(f.manager.handoffs[0].state,'needs-inspection');assert(f.lease);await restartFenced(f);await f.manager.close();
});
await check('progress receipt tampering is rejected before the next mutation',async()=>{
  const f=await fixture('progress-tamper'),p=await f.prepare(),checkpoint=f.manager.handoffCheckpoint.bind(f.manager);f.manager.handoffCheckpoint=async(...args)=>{await checkpoint(...args);if(args[1]==='family-archive-intent'){const n=args[0].record.progress.sequence;await writeFile(join(p.directory,'progress-'+String(n).padStart(8,'0')+'.json'),'{}');}};
  await assert.rejects(f.execute(p),/receipt changed/);assert.equal(await readFile(join(f.source,'text'),'utf8'),f.working);await restartFenced(f);await f.manager.close();
});
await check('Stop immediately before forward completion ledger rename retains the durable fence',async()=>{
  const f=await fixture('stop-final-commit'),p=await f.prepare(),save=f.manager.saveLedger.bind(f.manager),checkLedger=f.manager.checkLedger.bind(f.manager);let enter,resume,finalSave=false,checks=0,gated=false;
  const entered=new Promise(r=>{enter=r;}),held=new Promise(r=>{resume=r;});
  f.manager.saveLedger=async(handoffs,...rest)=>{if(Array.isArray(handoffs)&&!handoffs.some(row=>row.id===p.id)){finalSave=true;checks=0;try{return await save(handoffs,...rest);}finally{finalSave=false;}}return save(handoffs,...rest);};
  f.manager.checkLedger=async()=>{await checkLedger();if(finalSave&&++checks===2&&!gated){gated=true;enter();await held;}};
  try{const work=f.execute(p),outcome=work.then(value=>({value}),error=>({error}));await Promise.race([entered,work.then(()=>{throw new Error('Forward handoff skipped completion gate');})]);const stopping=f.manager.stop();resume();const [result,stopped]=await Promise.all([outcome,stopping]);assert(result.error);assert.match(result.error.message,/cancel|authority/i);assert.equal(stopped.stopped,true);assert.equal(f.lease,null);assert.equal(f.stops,1);assert(JSON.parse(await readFile(f.manager.ledger,'utf8')).handoffs.some(row=>row.id===p.id));await restartFenced(f);}finally{resume();await f.manager.close();}
});
await writeFile(join(root,'evidence.json'),JSON.stringify({root,tests,passed:true},null,2)+'\n');console.log(JSON.stringify({root,checks:tests.length,passed:true}));
