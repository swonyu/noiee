import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {GitWorkflow} from './git-workflow.mjs';

const exec=promisify(execFile),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git';
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-manager-'))),source=join(root,'source'),dataDir=join(root,'data');
const nativeHelper=process.env.HANDOFF_FILES_HELPER;
assert(nativeHelper,'Set HANDOFF_FILES_HELPER to the independently compiled native handoff fixture binary.');
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const raw=async args=>(await exec(git,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env})).stdout;
const hash=x=>createHash('sha256').update(x).digest('hex'),id=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
await mkdir(source);await raw(['init','-b','main',source]);await raw(['-C',source,'config','user.name','Fixture']);await raw(['-C',source,'config','user.email','fixture@localhost']);
await writeFile(join(source,'file'),'one\ntwo\nthree\n');await writeFile(join(source,'.gitignore'),'ignored/\n');await raw(['-C',source,'add','.']);await raw(['-C',source,'commit','-m','base']);
let released=0,leasePaths=[],temp=null;
const snapshot={rootThreadId:'test-root',cwd:source,model:'unchanged-model',modelProvider:'local',members:[{id:'test-root',parentThreadId:null,archived:false,cwd:source,model:'unchanged-model',modelProvider:'local',lastTurnId:'saved-turn'}],fingerprint:'fixture'};
const coding={projectMutationInventory:async()=>[snapshot.cwd],prepareHandoff:async thread=>{assert.equal(thread,'test-root');return structuredClone(snapshot);},handoffTemporary:async cwd=>temp?.cwd===cwd?structuredClone(temp):null};
const owner=new ManagedWorktrees({dataDir,coding,nativeHelper,reserveMutation:async resolve=>{leasePaths=await resolve();return {release(){released++;}};}});
const creation=(await owner.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan;
const record=(await owner.handle({action:'create',planId:creation.id})).worktree;assert.equal(record.state,'ready');released=0;
await writeFile(join(source,'file'),'ONE\ntwo\nthree\n');await raw(['-C',source,'add','file']);await writeFile(join(source,'file'),'ONE\ntwo\nTHREE\n');
await writeFile(join(source,'untracked'),'keep me');await mkdir(join(source,'empty'));await mkdir(join(source,'ignored'));await writeFile(join(source,'ignored','untouched'),'private ignored');
await writeFile(join(record.cwd,'destination-only'),'keep destination');
const immutable=async()=>({sourceHead:await readFile(join(source,'.git','HEAD'),'utf8'),sourceIndex:hash(await readFile(join(source,'.git','index'))),sourceFile:await readFile(join(source,'file'),'utf8'),destinationHead:await readFile(join(source,'.git','worktrees',record.id,'HEAD'),'utf8'),destinationIndex:hash(await readFile(join(source,'.git','worktrees',record.id,'index'))),destinationFile:await readFile(join(record.cwd,'file'),'utf8'),refs:await raw(['-C',source,'show-ref']),sourceID:await id(source),destinationID:await id(record.cwd)});
const before=await immutable(),tests=[];
async function check(name,fn){await fn();tests.push(name);console.log('PASS '+name);}
await check('malformed FIFO Git index rejects within the process bound',async()=>{
  const path=join(source,'.git','index'),parked=path+'.saved';await rename(path,parked);await exec('/usr/bin/mkfifo',[path]);let result;
  try{
    const script=`import {GitWorkflow} from ${JSON.stringify(new URL('./git-workflow.mjs',import.meta.url).href)}; const g=new GitWorkflow({dataDir:${JSON.stringify(dataDir)}}); try {const r=await g.repository(${JSON.stringify(source)},g.epoch);await g.readState(r,g.epoch);process.exitCode=2;}catch(e){console.error(e.message);process.exitCode=1;}`;
    await exec(process.execPath,['--input-type=module','-e',script],{timeout:1500,killSignal:'SIGKILL'}).then(x=>{result=x;},e=>{result=e;});
  }finally{await unlink(path);await rename(parked,path);}
  const observed={code:result.code,killed:result.killed,signal:result.signal,stderr:result.stderr};await writeFile(join(root,'fifo-index-evidence.json'),JSON.stringify(observed,null,2)+'\n');
  assert.equal(result.killed,false,JSON.stringify({root,...observed}));assert.equal(result.code,1);assert.match(result.stderr,/Git file is unsupported/);
});
await check('handoff prepare builds real recovery without touching checkouts or chat',async()=>{
  const result=await owner.exclusive(epoch=>owner.prepareHandoff(record.id,'test-root',epoch));
  assert.equal(result.plan.operation,'handoff');assert.equal(result.plan.rootThreadId,'test-root');assert.equal(result.plan.source,source);assert.equal(result.plan.destination,record.cwd);
  assert(leasePaths.includes(source)&&leasePaths.includes(record.cwd));assert.equal(released,0);assert.deepEqual(await immutable(),before);
  const p=owner.plans.get(result.plan.id);assert(p);assert.equal(owner.handoffAdmission,p.admission);assert.equal(p.admission.phase,'review');
  const peer=join(root,'review-peer'),admin=join(root,'review-peer-admin'),ordinary=join(root,'review-unrelated');await mkdir(peer);await mkdir(admin);await mkdir(ordinary);await writeFile(join(peer,'.git'),'gitdir: '+admin+'\n');await writeFile(join(admin,'commondir'),join(source,'.git')+'\n');
  for(const cwd of [source,record.cwd,peer])await assert.rejects(owner.assertProject(cwd),{code:'HANDOFF_PENDING'});await owner.assertProject(ordinary);assert(p.recovery?.manifest);assert(p.native.source.stamps.empty);assert(p.native.source.rootStamp?.mtime);assert(p.copies.source.rootStamp?.mtime);assert(!p.native.source.stamps['ignored']);
  assert.equal(await readFile(join(p.directory,'source-before','file'),'utf8'),'ONE\ntwo\nTHREE\n');assert.equal(await readFile(join(p.directory,'destination-before','destination-only'),'utf8'),'keep destination');
  assert.equal(p.candidate.recovery.bundle.hash.length,64);assert.equal(owner.handoffs.length,0);assert.equal(await readFile(join(p.directory,'manifest.json'),'utf8').then(x=>JSON.parse(x).family.rootThreadId),'test-root');
  assert(p.stages,'Preparation must materialize the reviewed native destination and source cleanup before intent.');
  assert(p.stages.destination.install.includes('file'));assert(p.stages.destination.install.includes('untracked'));assert(p.stages.destination.install.includes('empty'));
  assert(!p.stages.destination.install.includes('destination-only'));assert.deepEqual(p.stages.destination.remove,[]);
  assert.equal(await readFile(join(p.stages.destination.root.path,'file'),'utf8'),'ONE\ntwo\nTHREE\n');
  assert.equal(await readFile(join(p.stages.source.root.path,'file'),'utf8'),'one\ntwo\nthree\n');
  assert(p.stages.source.remove.includes('untracked'));assert(p.stages.source.remove.includes('empty'));assert(!p.stages.source.remove.includes('ignored'));
  await owner.releasePlan(p);assert.equal(released,1);assert.equal(owner.handoffAdmission,null);await owner.assertProject(peer);
});
await check('expired handoff review retires its exact lease before a new review and keeps admission fenced during release',async()=>{
  const reviewed=(await owner.handle({action:'prepareHandoff',id:record.id,threadId:'test-root'})).plan,previous=owner.plans.get(reviewed.id);previous.expiresAt=owner.now()-1;
  let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r),original=previous.lease.release;previous.lease={release:async()=>{entered();await wait;original();}};
  const next=owner.handle({action:'prepareHandoff',id:record.id,threadId:'test-root'});next.catch(()=>{});
  // A rejection must surface instead of leaving this fixture waiting for a release never attempted.
  await Promise.race([started,next]);assert.equal(owner.handoffAdmission,previous.admission);
  for(const cwd of [source,record.cwd,join(root,'review-peer')])await assert.rejects(owner.assertProject(cwd),{code:'HANDOFF_PENDING'});
  release();const result=await next,current=owner.plans.get(result.plan.id);assert.notEqual(current.id,previous.id);assert.equal(owner.handoffAdmission,current.admission);await owner.releasePlan(current);assert.equal(owner.handoffAdmission,null);
});
await check('reviewed scratch omits bytes only under verified ownership',async()=>{
  const path=join(source,'.saleh-coding-tmp-owned'),nonce=randomUUID();await mkdir(path,{mode:0o700});await writeFile(join(path,'.saleh-owner'),nonce);await writeFile(join(path,'large'),Buffer.alloc(9*1024*1024,1));
  temp={cwd:source,path,nonce,projectDev:(await id(source)).dev,projectIno:(await id(source)).ino,...await id(path)};
  const inspector=new GitWorkflow({dataDir});const r=await inspector.repository(source,inspector.epoch);
  await assert.rejects(inspector.readState(r,inspector.epoch),/limit|exceeds/i);
  const state=await inspector.readState(r,inspector.epoch,{omitUntracked:['.saleh-coding-tmp-owned']});assert(![...state.files.keys()].some(x=>x.startsWith('.saleh-coding-tmp-owned/')));
  const p=(await owner.exclusive(epoch=>owner.prepareHandoff(record.id,'test-root',epoch))).plan,internal=owner.plans.get(p.id);
  assert(!Object.keys(internal.native.source.stamps).some(x=>x.startsWith('.saleh-coding-tmp-owned')));assert.equal(internal.candidate.temporary[0].path,path);await owner.releasePlan(internal);
  await inspector.close();
});
await check('immutable candidates reject changed bytes, replaced roots and unexpected entries before intent',async()=>{
  for(const [label,change] of [['source','bytes'],['destination','bytes'],['source','root'],['destination','extra']]){
    const result=(await owner.exclusive(epoch=>owner.prepareHandoff(record.id,'test-root',epoch))).plan,p=owner.plans.get(result.id),saved=p.stages[label].immutable;
    if(change==='bytes')await writeFile(join(saved.root.path,'file'),'corrupted candidate');
    else if(change==='root'){await rename(saved.root.path,saved.root.path+'.retained');await mkdir(saved.root.path,{mode:0o700});}
    else await writeFile(join(saved.root.path,'unexpected'),'unreviewed');
    await assert.rejects(owner.exclusive(epoch=>owner.verifyHandoffRecovery(p,epoch)),/recovery changed|identity changed/i);
    await assert.rejects(owner.exclusive(epoch=>owner.beginHandoff(result.id,epoch)),/recovery changed|identity changed/i);
    assert.equal(owner.handoffs.length,0);assert.deepEqual(await immutable(),before);
  }
});
await check('stale source and replaced recovery are refused before durable intent',async()=>{
  const p=(await owner.exclusive(epoch=>owner.prepareHandoff(record.id,'test-root',epoch))).plan;
  await writeFile(join(source,'untracked'),'changed after review');
  await assert.rejects(owner.exclusive(epoch=>owner.beginHandoff(p.id,epoch)),/changed after review/);assert.equal(owner.handoffs.length,0);assert(!owner.plans.has(p.id));
  await writeFile(join(source,'untracked'),'keep me');
  const result=(await owner.exclusive(epoch=>owner.prepareHandoff(record.id,'test-root',epoch))).plan,internal=owner.plans.get(result.id),path=join(internal.directory,'source-before','file');
  const bytes=await readFile(path);await rename(path,path+'.old');await writeFile(path,bytes);
  await assert.rejects(owner.exclusive(epoch=>owner.beginHandoff(result.id,epoch)),/recovery changed/);assert.equal(owner.handoffs.length,0);assert.deepEqual(await immutable(),before);
});
await check('Stop confirms native helper exit and retains unknown process outcomes',async()=>{
  for(const unknown of [false,true]){
    let started,pid;const launch=new Promise(resolve=>{started=resolve;});
    const manager=new ManagedWorktrees({dataDir:join(root,unknown?'unknown-native':'cancel-native'),nativeHelper,spawnProcess:()=>{
      const child=unknown?Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()}):spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['pipe','pipe','pipe']});pid=child.pid;started();return child;
    }});
    const work=manager.exclusive(epoch=>manager.handoffFiles('snapshot',{root:{path:source,...before.sourceID},paths:['file']},epoch));
    const failed=assert.rejects(work,unknown?/exit was not confirmed/:/cancelled|failed/);await launch;const stopped=await manager.stop();await failed;
    assert.equal(stopped.stopped,!unknown);assert.equal(manager.blocked,unknown);if(!unknown)assert.throws(()=>process.kill(-pid,0));await manager.close();
  }
  assert.deepEqual(await immutable(),before);
});
await check('candidate stages and payload namespaces are reverified before durable intent',async()=>{
  for(const mode of ['candidate','payload']){
    const result=(await owner.exclusive(epoch=>owner.prepareHandoff(record.id,'test-root',epoch))).plan,p=owner.plans.get(result.id);
    await writeFile(join(mode==='candidate'?p.stages.destination.root.path:p.stages.payload.root.path,mode==='candidate'?'file':'unexpected'),'late replacement');
    await assert.rejects(owner.exclusive(epoch=>owner.beginHandoff(result.id,epoch)),/native recovery changed/);assert.equal(owner.handoffs.length,0);assert(!owner.plans.has(result.id));assert.deepEqual(await immutable(),before);
  }
});
await check('actual verified recovery intent persists and fences both checkouts after restart',async()=>{
  const plan=(await owner.exclusive(epoch=>owner.prepareHandoff(record.id,'test-root',epoch))).plan;
  const active=await owner.exclusive(epoch=>owner.beginHandoff(plan.id,epoch));assert.equal(active.record.phase,'recovery-ready');
  const ledger=JSON.parse(await readFile(owner.ledger,'utf8'));assert.equal(ledger.version,2);assert.equal(ledger.handoffs[0].recovery.manifest.hash,active.plan.recovery.manifest.hash);
  for(const path of [source,record.cwd])await assert.rejects(owner.assertProject(path),{code:'HANDOFF_PENDING'});
  await assert.rejects(owner.exclusive(epoch=>owner.beginHandoff(plan.id,epoch)),/consumed|unknown|already requires/);
  await owner.exclusive(epoch=>owner.handoffCheckpoint(active,'family-archive-intent',epoch,'Test intent; no engine archival dispatched.'));
  await owner.close();const restarted=new ManagedWorktrees({dataDir});const list=await restarted.handle({action:'list'});assert.equal(list.handoffs[0].phase,'family-archive-intent');assert.equal(list.handoffs[0].recoveryDirectory,active.plan.directory);
  for(const path of [source,record.cwd])await assert.rejects(restarted.assertProject(path),{code:'HANDOFF_PENDING'});await restarted.close();assert.deepEqual(await immutable(),before);
});
await writeFile(join(root,'evidence.json'),JSON.stringify({root,tests,before,after:await immutable()},null,2)+'\n');
await owner.close();
console.log(JSON.stringify({root,tests:tests.length,passed:true}));
