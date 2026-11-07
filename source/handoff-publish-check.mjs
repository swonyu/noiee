import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,readFile,writeFile,lstat,readdir,unlink,chmod,rename,symlink,link} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {GitRunner} from './git-runner.mjs';
import {GitWorkflow} from './git-workflow.mjs';
import {HandoffGit} from './handoff-git.mjs';

const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-publish-check-'))),runner=new GitRunner({dataDir:root}),inspector=new GitWorkflow({dataDir:join(root,'inspection')});
const env={GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'},sha=b=>createHash('sha256').update(b).digest('hex');
const git=(cwd,args,options={})=>runner.run(['-C',cwd,...args],{scope:{dirs:[root]},env,...options});
const put=async(cwd,path,data)=>{await mkdir(dirname(join(cwd,path)),{recursive:true});await writeFile(join(cwd,path),data);};
async function commit(cwd,message){await git(cwd,['add','-A']);await git(cwd,['-c','commit.gpgSign=false','commit','-m',message]);}
async function fixture(name,{detached=false,reverse=false,sameHead=false}={}){
  const directory=join(root,name),source=join(directory,'source'),destination=join(directory,'destination'),peer=join(directory,'peer');await mkdir(source,{recursive:true});await git(source,['init','-b','main']);
  for(const [name,data] of Object.entries({a:'base a\n',b:'base b\n',gone:'original\n'}))await put(source,name,data);await commit(source,'base');await git(source,['worktree','add','--detach',destination,'HEAD']);await git(source,['worktree','add','--detach',peer,'HEAD']);
  await git(source,detached?['switch','--detach']:['switch','-c','feature']);await put(source,'source-commit','source history\n');await commit(source,'source commit');await git(destination,['switch','main']);await put(destination,'destination-commit','destination history\n');await commit(destination,'destination commit');
  await put(source,'a','source stage\n');await git(source,['add','a']);await put(source,'a','source working\n');await git(source,['rm','gone']);await put(source,'gone','recreated untracked\n');await put(source,'incoming','source untracked\n');
  await put(destination,'b','destination stage\n');await git(destination,['add','b']);await put(destination,'b','destination working\n');await put(destination,'local','destination untracked\n');
  if(sameHead)await git(destination,['update-ref','--no-deref','HEAD',(await git(source,['rev-parse','HEAD'])).stdout.trim()]);
  const pair=reverse?{source:destination,destination:source}:{source,destination},states={};for(const [label,cwd] of Object.entries(pair))states[label]=await inspector.readState(await inspector.repository(cwd,0),0);
  const peers=await inspector.peerInventory(states.source.r,0),privateDir=join(directory,'recovery');await mkdir(privateDir,{mode:0o700});
  const builder=new HandoffGit({directory:join(privateDir,'git'),runner,inspector,check:()=>{}}),candidate=await builder.prepare(states.source,states.destination,peers);
  const plan={id:randomUUID(),directory:privateDir,...pair,states,peers,candidate,temporary:[]};
  return {plan,builder,peer};
}
const initial=await fixture('missing-api');
const module=await import('./handoff-publish.mjs').catch(e=>({error:e}));
assert.equal(typeof module.publishHandoffGit,'function','missing native Git publication API');
for(const name of ['captureHandoffGitBaseline','rehydrateHandoffGitStates','reviewHandoffGitRecovery','restoreHandoffGit','finishHandoffGit','verifyHandoffGitRecovery'])assert.equal(typeof module[name],'function','missing restart recovery API: '+name);
const {publishHandoffGit,verifyHandoffGitPublication,captureHandoffGitBaseline,rehydrateHandoffGitStates,reviewHandoffGitRecovery,restoreHandoffGit,finishHandoffGit,verifyHandoffGitRecovery}=module,results=[];
const focus=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7),test=async(name,fn)=>{if(focus&&!name.includes(focus))return;await fn();results.push(name);console.log('PASS '+name);};
async function files(f){
  assert.equal(await readFile(join(f.plan.states.source.r.gitDir,'HEAD'),'utf8'),f.plan.candidate.branch.sourceAfter,'native publication must follow source detach');
  for(const [label,tree] of [['destination',f.plan.candidate.working],['source',f.plan.candidate.sourceCleanup.working]]){
    const cwd=f.plan[label],entries=await f.builder.treeEntries(tree),old=(await git(cwd,['ls-files','--cached','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean);
    for(const path of new Set(old))if(!entries.has(path))await unlink(join(cwd,path)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    for(const [path,row] of entries){await put(cwd,path,(await f.builder.verifiedGit(['cat-file','blob',row.oid],{raw:true})).stdout);await chmod(join(cwd,path),row.mode==='100755'?0o755:0o644);}
  }
  return {fixtureNative:true};
}
const journalFor=(f,callback=async()=>{})=>async(phase,details)=>{(f.journal??=[]).push({phase,details:structuredClone(details)});await callback(phase,details);};
const lockRows=f=>[...new Map((f.journal??[]).flatMap(row=>[...(row.details?.lock?[row.details.lock]:[]),...(row.details?.locks??[])]).map(lock=>[lock.path,lock])).values()];
async function run(f,overrides={}){f.plan.gitBaseline??=await captureHandoffGitBaseline(f.plan,{runner,inspector,check:()=>{}});return publishHandoffGit(f.plan,{runner,inspector,check:()=>{},publishFiles:()=>files(f),...overrides,checkpoint:journalFor(f,overrides.checkpoint)});}
async function rehydrated(f){
  const p=f.plan,manifest=JSON.parse(JSON.stringify({gitBaseline:p.gitBaseline,repositories:{source:p.states.source.r,destination:p.states.destination.r},candidate:p.candidate,peers:p.peers}));
  return {...p,...manifest,states:await rehydrateHandoffGitStates({baseline:manifest.gitBaseline,repositories:manifest.repositories,candidate:manifest.candidate},{check:()=>{}})};
}
async function originalFiles(f){
  for(const label of ['source','destination']){
    const refs=f.plan.candidate.recovery.refs,entries=new Map([...await f.builder.treeEntries(refs[label+'Working'].tree),...await f.builder.treeEntries(refs[label+'Untracked'].tree)]),cwd=f.plan[label],old=(await git(cwd,['ls-files','--cached','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean);
    for(const path of new Set(old))if(!entries.has(path))await unlink(join(cwd,path)).catch(error=>{if(error.code!=='ENOENT')throw error;});
    for(const [path,row] of entries){await put(cwd,path,(await f.builder.verifiedGit(['cat-file','blob',row.oid],{raw:true})).stdout);await chmod(join(cwd,path),row.mode==='100755'?0o755:0o644);}
  }
  return {fixtureOriginalFiles:true};
}
async function recover(f,options={}){
  const plan=await rehydrated(f),review=options.review??await reviewHandoffGitRecovery(plan,{runner,inspector,check:()=>{},locks:lockRows(f)});
  return restoreHandoffGit(plan,review,{runner,inspector,check:()=>{},restoreFiles:()=>originalFiles(f),...options,checkpoint:journalFor(f,options.checkpoint)});
}
async function verifiedOriginal(f,receipt){
  for(const state of Object.values(f.plan.states)){assert.equal(await readFile(join(state.r.gitDir,'HEAD'),'utf8'),state.headRaw);assert.deepEqual(await readFile(join(state.r.gitDir,'index')),state.index);assert.equal((await inspector.readState(state.r,inspector.epoch)).fingerprint,state.fingerprint);}
  const plan=await rehydrated(f);assert.equal((await verifyHandoffGitRecovery(plan,receipt,{runner,inspector,check:()=>{}})).verified,true);assert.deepEqual(receipt.native,{fixtureOriginalFiles:true});
}
await test('compact persisted baseline rehydrates original states without live state reads',async()=>{
  initial.plan.gitBaseline=await captureHandoffGitBaseline(initial.plan,{runner,inspector,check:()=>{}});const p=await rehydrated(initial);
  for(const label of ['source','destination'])for(const key of ['head','refBranch','headRaw','index','config','configFiles','fingerprint'])assert.deepEqual(p.states[label][key],initial.plan.states[label][key]);
  assert(!JSON.stringify(initial.plan.gitBaseline).includes('"index":'),'Raw index bytes remain exclusively in stamped artifacts');
  const path=p.candidate.artifacts.sourceOriginalIndex,old=await readFile(path);try{await writeFile(path,'changed artifact');await assert.rejects(rehydrated(initial),/artifact changed/);}finally{await writeFile(path,old);}
});
await test('noncanonical original HEAD is refused before a recoverable baseline is produced',async()=>{
  const f=await fixture('baseline-head-format'),state=f.plan.states.source;await writeFile(join(state.r.gitDir,'HEAD'),state.headRaw.trim());f.plan.states.source=await inspector.readState(state.r,inspector.epoch);await assert.rejects(captureHandoffGitBaseline(f.plan,{runner,inspector,check:()=>{}}),/noncanonical original HEAD/);
});
async function verified(f,out){
  const p=f.plan;assert.equal(await readFile(join(p.states.source.r.gitDir,'HEAD'),'utf8'),p.candidate.branch.sourceAfter);assert.equal(await readFile(join(p.states.destination.r.gitDir,'HEAD'),'utf8'),p.candidate.branch.destinationAfter);
  assert.equal(sha(await readFile(join(p.states.source.r.gitDir,'index'))),p.candidate.recovery.sourceCleanupIndex.hash);assert.equal(sha(await readFile(join(p.states.destination.r.gitDir,'index'))),p.candidate.recovery.index.hash);
  assert.equal((await git(p.source,['status','--porcelain=v1'])).stdout,'');assert.equal(await readFile(join(p.destination,'a'),'utf8'),'source working\n');assert.equal(await readFile(join(p.destination,'b'),'utf8'),'destination working\n');
  assert.equal((await git(p.destination,['show',':a'])).stdout,'source stage\n');assert.equal((await git(p.destination,['show',':b'])).stdout,'destination stage\n');
  for(const [name,ref] of Object.entries(out.recoveryRefs))assert.equal((await git(p.source,['rev-parse',ref])).stdout.trim(),p.candidate.recovery.refs[name].commit);
  assert.equal(Object.keys(out.recoveryRefs).length,12);assert((await lstat(out.pack.keepPath)).isFile());assert.deepEqual(out.native,{fixtureNative:true});
  for(const state of Object.values(p.states))await assert.rejects(lstat(join(state.r.gitDir,'index.lock')),e=>e.code==='ENOENT');
}
await test('attached dirty handoff preserves layers, branch tips, peers and recovery',async()=>verified(initial,await run(initial)));
await test('detached source publishes detached destination',async()=>{const f=await fixture('detached',{detached:true});await verified(f,await run(f));});
await test('unchanged detached HEADs require no prepared HEAD transaction',async()=>{const f=await fixture('unchanged-heads',{detached:true,sameHead:true});await verified(f,await run(f));assert(!f.journal.some(row=>row.phase==='git-ref-lock-prepared'&&row.details.lock.kind==='head'));});
const liveMetadata=async p=>Object.fromEntries(await Promise.all(Object.entries(p.states).map(async([label,s])=>[label,{head:await readFile(join(s.r.gitDir,'HEAD'),'utf8'),index:sha(await readFile(join(s.r.gitDir,'index')))}])));
for(const fault of ['HEAD','index','branch','peer','configuration','pack replacement','ref collision'])await test('reject stale '+fault+' without publishing files',async()=>{
  const f=await fixture('stale-'+fault.replaceAll(' ','-')),p=f.plan,before=await liveMetadata(p);let called=false,mutated;
  const phaseWanted=fault==='pack replacement'?'git-objects-importing':fault==='ref collision'?'git-recovery-refs-creating':'git-source-head-publishing';
  await assert.rejects(run(f,{publishFiles:async()=>{called=true;throw new Error('must not publish');},checkpoint:async(phase,details)=>{if(phase!==phaseWanted)return;
    if(fault==='HEAD'){mutated=p.states.source.head+'\n';await writeFile(join(p.states.source.r.gitDir,'HEAD'),mutated);}
    if(fault==='index'){mutated=Buffer.concat([p.states.source.index,Buffer.from([1])]);await writeFile(join(p.states.source.r.gitDir,'index'),mutated);}
    if(fault==='branch'){mutated=p.states.destination.head+'\n';await writeFile(join(p.states.source.r.commonDir,'refs/heads/feature'),mutated);}
    if(fault==='peer'){const path=join(dirname(p.directory),'late-peer');await git(p.source,['worktree','add','--detach',path,p.states.source.head]);}
    if(fault==='configuration'){const path=join(p.states.source.r.commonDir,'config');await writeFile(path,(await readFile(path,'utf8'))+'\n[handoff]\n\tlate = true\n');}
    if(fault==='pack replacement')await writeFile(details.path,'replaced independent pack');
    if(fault==='ref collision'){const path=join(p.states.source.r.commonDir,'refs/saleh/handoff',p.id,'sourceHead');await mkdir(dirname(path),{recursive:true});await writeFile(path,p.states.destination.head+'\n');}
  }}),/changed|stale|differs/);
  assert.equal(called,false);const after=await liveMetadata(p);assert.deepEqual(after.destination,before.destination);
  if(fault==='HEAD')assert.equal(after.source.head,mutated);else assert.equal(after.source.head,before.source.head);
  if(fault==='index')assert.equal(after.source.index,sha(mutated));else assert.equal(after.source.index,before.source.index);
  if(fault==='branch')assert.equal(await readFile(join(p.states.source.r.commonDir,'refs/heads/feature'),'utf8'),mutated);
  if(fault==='ref collision')assert.equal((await git(p.source,['rev-parse','refs/saleh/handoff/'+p.id+'/sourceHead'])).stdout.trim(),p.states.destination.head);
  for(const state of Object.values(p.states))await assert.rejects(lstat(join(state.r.gitDir,'index.lock')),e=>e.code==='ENOENT');
});
for(const phase of ['git-objects-imported','git-recovery-refs-created','git-locked','git-source-head-published','git-files-published','git-destination-index-published','git-source-index-published','git-destination-head-published'])await test('phase failure retains recovery at '+phase,async()=>{
  const f=await fixture('failure-'+phase);let nativeCalled=false,error;
  try{await run(f,{checkpoint:async name=>{if(name===phase)throw new Error('Injected phase failure');},publishFiles:async()=>{nativeCalled=true;return files(f);}});}catch(e){error=e;}
  assert.match(error?.message??'',/Injected phase failure/);assert.equal(error.handoffGit.phase,phase);
  const p=f.plan;assert.deepEqual(await readFile(p.candidate.artifacts.sourceOriginalIndex),p.states.source.index);assert.deepEqual(await readFile(p.candidate.artifacts.destinationOriginalIndex),p.states.destination.index);
  assert.equal(await readFile(p.candidate.artifacts.sourceOriginalHead,'utf8'),p.states.source.headRaw);assert.equal(await readFile(p.candidate.artifacts.destinationOriginalHead,'utf8'),p.states.destination.headRaw);
  assert((await lstat(error.handoffGit.pack.keepPath)).isFile());if(phase!=='git-objects-imported')for(const name of Object.keys(p.candidate.recovery.refs))assert.equal((await git(p.source,['rev-parse','refs/saleh/handoff/'+p.id+'/'+name])).stdout.trim(),p.candidate.recovery.refs[name].commit);
  for(const state of Object.values(p.states))await assert.rejects(lstat(join(state.r.gitDir,'index.lock')),e=>e.code==='ENOENT');
  assert.equal(nativeCalled,['git-files-published','git-destination-index-published','git-source-index-published','git-destination-head-published'].includes(phase));
  await verifiedOriginal(f,await recover(f));
});
await test('Stop after detach retains owned locks and never starts file publication',async()=>{
  const f=await fixture('stop');let stopped=false,called=false,error;try{await run(f,{check:()=>{if(stopped)throw Object.assign(new Error('Stopped'),{code:'CANCELLED'});},checkpoint:async phase=>{if(phase==='git-source-head-published')stopped=true;},publishFiles:async()=>{called=true;}});}catch(e){error=e;}
  assert.equal(error?.code,'CANCELLED');assert.equal(called,false);assert.equal(error.handoffGit.retainedLocks.length,4);for(const row of error.handoffGit.retainedLocks){const s=await lstat(row.path,{bigint:true});assert.deepEqual(row.identity,{dev:String(s.dev),ino:String(s.ino)});}
  assert.equal(await readFile(join(f.plan.states.source.r.gitDir,'HEAD'),'utf8'),f.plan.candidate.branch.sourceAfter);assert.equal(await readFile(join(f.plan.states.destination.r.gitDir,'HEAD'),'utf8'),f.plan.states.destination.headRaw);
  const receipt=await recover(f);assert.equal(receipt.retiredLocks.length,4);for(const lock of receipt.retiredLocks){assert.equal(sha(await readFile(lock.retainedPath)),lock.hash);assert.deepEqual({dev:String((await lstat(lock.retainedPath,{bigint:true})).dev),ino:String((await lstat(lock.retainedPath,{bigint:true})).ino)},lock.identity);}await verifiedOriginal(f,receipt);
});
await test('unconfirmed process exit retains exact lock files',async()=>{
  const f=await fixture('unknown-exit');let error;try{await run(f,{checkpoint:async phase=>{if(phase==='git-locked'){runner.blocked=true;throw new Error('Simulated unconfirmed child exit');}}});}catch(e){error=e;}finally{runner.blocked=false;}
  assert.match(error?.message??'',/unconfirmed/);assert.equal(error.handoffGit.retainedLocks.length,4);for(const row of error.handoffGit.retainedLocks)assert((await lstat(row.path)).isFile());
});
await test('replaced owned lock is never unlinked during failure cleanup',async()=>{
  const f=await fixture('replaced-lock');let replacement,error;try{await run(f,{checkpoint:async phase=>{if(phase==='git-locked'){replacement=join(f.plan.states.source.r.gitDir,'index.lock');await unlink(replacement);await writeFile(replacement,'FOREIGN LOCK');throw new Error('Injected after lock substitution');}}});}catch(e){error=e;}
  assert.match(error?.message??'',/Injected/);assert.equal(await readFile(replacement,'utf8'),'FOREIGN LOCK');assert(error.handoffGit.retainedLocks.some(row=>row.path===replacement));
});
for(const fault of ['same-oid HEAD substitution','prepared process cancellation'])await test(fault+' revokes prepared source transaction',async()=>{
  const f=await fixture('prepared-'+fault.replaceAll(' ','-')),original=runner.run.bind(runner);let called=false,injected=false,error;
  runner.run=async(args,options)=>{if(options.prepared&&options.input.includes('update HEAD ')){const prepared=options.prepared;options={...options,prepared:async()=>{injected=true;if(fault==='same-oid HEAD substitution')await writeFile(join(f.plan.states.source.r.gitDir,'HEAD'),f.plan.states.source.head+'\n');else runner.cancel();return prepared();}};}return original(args,options);};
  try{await run(f,{publishFiles:async()=>{called=true;}});}catch(e){error=e;}finally{runner.run=original;}
  assert(injected);assert(error);assert.equal(called,false);assert.equal(await readFile(join(f.plan.states.destination.r.gitDir,'HEAD'),'utf8'),f.plan.states.destination.headRaw);
  assert.equal(error.handoffGit.retainedLocks.length,fault==='prepared process cancellation'?4:0);
});
await test('fresh final verifier detects post-publication Git drift',async()=>{
  assert.equal(typeof verifyHandoffGitPublication,'function');const f=await fixture('fresh-verifier'),receipt=await run(f),p=f.plan,verify=()=>verifyHandoffGitPublication(p,receipt,{runner,inspector,check:()=>{}});assert.equal((await verify()).verified,true);
  const cases=[['HEAD',join(p.states.destination.r.gitDir,'HEAD'),p.states.source.head+'\n'],['index',join(p.states.source.r.gitDir,'index'),Buffer.from('replaced index')],['configuration',join(p.states.source.r.commonDir,'config'),'[handoff]\n late = true\n'],['GC keep',receipt.pack.keepPath,'changed keep'],['recovery ref',join(p.states.source.r.commonDir,receipt.recoveryRefs.sourceHead),p.states.destination.head+'\n']];
  for(const [name,path,data] of cases){const prior=await readFile(path);try{await writeFile(path,data);await assert.rejects(verify(),/changed|artifact/,name);}finally{await writeFile(path,prior);}}
  const peerRecord=p.peers.records.find(r=>r.path===f.peer),peerRepo=await inspector.repository(peerRecord.path,0),locked=join(peerRepo.gitDir,'locked');await writeFile(locked,'late lock reason\n');try{await assert.rejects(verify(),/peer inventory changed/);}finally{await unlink(locked);}
  const unrelated=join(p.states.source.r.commonDir,'refs/heads/late');await writeFile(unrelated,p.states.source.head+'\n');try{await assert.rejects(verify(),/ref inventory changed/);}finally{await unlink(unrelated);}
  assert.equal((await verify()).verified,true);
});
await test('full published recovery preserves added refs and every imported recovery ref',async()=>{
  const f=await fixture('recovery-complete');await run(f);await git(f.plan.source,['update-ref','refs/tags/later',f.plan.states.destination.head]);
  const plan=await rehydrated(f),review=await reviewHandoffGitRecovery(plan,{runner,inspector,check:()=>{},locks:lockRows(f)}),receipt=await recover(f,{review});assert.deepEqual(receipt.refs,review.refs);assert.equal(receipt.refs.filter(([name])=>name.startsWith('refs/saleh/handoff/'+plan.id+'/')).length,12);await verifiedOriginal(f,receipt);
  const prepared=f.journal.filter(row=>row.phase==='git-ref-lock-prepared');assert(prepared.some(row=>row.details.lock.kind==='head'));assert.equal(prepared.filter(row=>row.details.lock.kind==='ref').length,12);assert(f.journal.some(row=>row.phase==='git-recovery-ref-lock-prepared'));
});
await test('detached source recovery restores exact original HEAD bytes and branch occupancy',async()=>{const f=await fixture('recovery-detached',{detached:true});await run(f);await verifiedOriginal(f,await recover(f));});
await test('before-import recovery independently restores original states without creating refs',async()=>{
  const f=await fixture('recovery-before-import');f.plan.gitBaseline=await captureHandoffGitBaseline(f.plan,{runner,inspector,check:()=>{}});const receipt=await recover(f);assert.deepEqual(receipt.refs,f.plan.gitBaseline.originalRefs);await verifiedOriginal(f,receipt);
  const pack=receipt.pack.keepPath.replace(/\.keep$/,'.pack');await rename(pack,pack+'.retained');try{await assert.rejects(verifyHandoffGitRecovery(await rehydrated(f),receipt,{runner,inspector,check:()=>{}}),/object|invalid|pack|missing/i,'Fresh restoration proof must traverse retained object states even when no recovery refs were created');}finally{await rename(pack+'.retained',pack);}
});
for(const fault of ['HEAD identity','index','ref','configuration','peer','unknown lock','journal identity','journal content'])await test('reviewed recovery rejects '+fault+' before native restore',async()=>{
  const f=await fixture('recovery-stale-'+fault.replaceAll(' ','-'));await run(f);const plan=await rehydrated(f),review=await reviewHandoffGitRecovery(plan,{runner,inspector,check:()=>{},locks:lockRows(f)});let called=false,path,prior;
  if(fault==='HEAD identity'){path=join(plan.states.source.r.gitDir,'HEAD');prior=await readFile(path);await unlink(path);await writeFile(path,prior);}
  if(fault==='index'){path=join(plan.states.source.r.gitDir,'index');await writeFile(path,'foreign index');}
  if(fault==='ref')await git(plan.source,['update-ref','refs/tags/raced',plan.states.source.head]);
  if(fault==='configuration'){path=join(plan.states.source.r.commonDir,'config');await writeFile(path,(await readFile(path))+'\n[recovery]\n changed = true\n');}
  if(fault==='peer')await git(plan.source,['worktree','add','--detach',join(dirname(plan.directory),'late-recovery-peer'),'HEAD']);
  if(fault.includes('lock')||fault.startsWith('journal')){path=join(plan.states.source.r.gitDir,'index.lock');await writeFile(path,fault==='journal content'?'foreign lock':'');if(fault.startsWith('journal')){const stat=await lstat(path,{bigint:true});review.locks.push({path,identity:{dev:String(stat.dev),ino:fault==='journal identity'?'0':String(stat.ino)},hash:sha(Buffer.alloc(0)),bytes:0,owner:'application',kind:'index'});const {fingerprint,...value}=review;review.fingerprint=sha(JSON.stringify(value));}}
  await assert.rejects(recover(f,{review,restoreFiles:async()=>{called=true;}}),/changed|outside|unowned|replaced|contents|differs/);assert.equal(called,false);if(fault.includes('lock')||fault.startsWith('journal'))assert((await lstat(path)).isFile());
});
await test('recovery requires current caller authority and confirmed runner exit',async()=>{
  const f=await fixture('recovery-authority');await run(f);const plan=await rehydrated(f),before=await liveMetadata(plan);runner.blocked=true;try{await assert.rejects(reviewHandoffGitRecovery(plan,{runner,inspector,check:()=>{},locks:lockRows(f)}),/unconfirmed/);}finally{runner.blocked=false;}
  const review=await reviewHandoffGitRecovery(plan,{runner,inspector,check:()=>{},locks:lockRows(f)});await assert.rejects(recover(f,{review,check:()=>{throw new Error('Caller has no durable exit authority');}}),/durable exit authority/);assert.deepEqual(await liveMetadata(plan),before);
});
await test('recovery Stop retains newly journaled lock identities and permits exact later review',async()=>{
  const f=await fixture('recovery-stop');await run(f);let stopped=false,error;try{await recover(f,{check:()=>{if(stopped)throw Object.assign(new Error('Stopped recovery'),{code:'CANCELLED'});},checkpoint:async phase=>{if(phase==='git-recovery-files-restored')stopped=true;}});}catch(e){error=e;}
  assert.equal(error?.code,'CANCELLED');assert.equal(error.handoffGitRecovery.retainedLocks.length,4);for(const lock of error.handoffGitRecovery.retainedLocks)assert((await lstat(lock.path)).isFile());await verifiedOriginal(f,await recover(f));
});
await test('recovery lock substitution is preserved and never considered owned',async()=>{
  const f=await fixture('recovery-lock-substitution');await run(f);let path,error;try{await recover(f,{checkpoint:async(phase,details)=>{if(phase==='git-recovery-lock-acquired'&&!path){path=details.lock.path;await unlink(path);await writeFile(path,'FOREIGN');throw new Error('Injected recovery lock substitution');}}});}catch(e){error=e;}
  assert.match(error?.message??'',/Injected/);assert.equal(await readFile(path,'utf8'),'FOREIGN');await assert.rejects(reviewHandoffGitRecovery(await rehydrated(f),{runner,inspector,check:()=>{},locks:lockRows(f)}),/replaced|contents/);
});
async function finish(f,options={}){
  f.plan.gitBaseline??=await captureHandoffGitBaseline(f.plan,{runner,inspector,check:()=>{}});
  const plan=await rehydrated(f),review=options.review??await reviewHandoffGitRecovery(plan,{runner,inspector,check:()=>{},locks:lockRows(f)});
  return finishHandoffGit(plan,review,{runner,inspector,check:()=>{},finishFiles:()=>files(f),...options,checkpoint:journalFor(f,options.checkpoint)});
}
async function verifiedFinished(f,receipt){
  const plan=await rehydrated(f);assert.equal(receipt.state,'finished');assert.deepEqual(receipt.locks,[]);assert.equal((await verifyHandoffGitRecovery(plan,receipt,{runner,inspector,check:()=>{}})).verified,true);
  for(const [label,key,tree] of [['source','sourceCleanupIndex',plan.candidate.sourceCleanup.working],['destination','index',plan.candidate.working]]){
    assert.equal(await readFile(join(plan.states[label].r.gitDir,'HEAD'),'utf8'),plan.candidate.branch[label+'After']);assert.equal(sha(await readFile(join(plan.states[label].r.gitDir,'index'))),plan.candidate.recovery[key].hash);
    for(const [path,row] of await f.builder.treeEntries(tree))assert.deepEqual(await readFile(join(plan[label],path)),(await f.builder.verifiedGit(['cat-file','blob',row.oid],{raw:true})).stdout);
  }
  assert.equal((await git(plan.source,['status','--porcelain=v1'])).stdout,'');assert.deepEqual(receipt.native,{fixtureNative:true});
}
for(const reverse of [false,true])for(const detached of [false,true])await test('Finish before publication '+(reverse?'reverse':'forward')+' '+(detached?'detached':'attached'),async()=>{
  const f=await fixture('finish-initial-'+reverse+'-'+detached,{reverse,detached});await verifiedFinished(f,await finish(f));if(!reverse&&!detached)await verifiedFinished(f,await finish(f));
});
for(const phase of ['git-objects-imported','git-recovery-refs-created','git-source-head-published','git-files-published','git-destination-index-published','git-source-index-published','git-destination-head-published'])await test('Finish after partial publication '+phase,async()=>{
  const f=await fixture('finish-partial-'+phase);await assert.rejects(run(f,{checkpoint:async name=>{if(name===phase)throw new Error('Injected partial publication');}}),/Injected/);await verifiedFinished(f,await finish(f));
});
await test('Finish preserves added refs and creates only missing retained refs',async()=>{
  const f=await fixture('finish-missing-refs');f.plan.gitBaseline=await captureHandoffGitBaseline(f.plan,{runner,inspector,check:()=>{}});
  const prefix='refs/saleh/handoff/'+f.plan.id+'/',refs=f.plan.candidate.recovery.refs;
  await git(f.plan.source,['bundle','unbundle',f.plan.candidate.artifacts.bundle]);for(const name of ['sourceHead','destinationHead'])await git(f.plan.source,['update-ref',prefix+name,refs[name].commit]);await git(f.plan.source,['update-ref','refs/tags/later',f.plan.states.destination.head]);
  const receipt=await finish(f);await verifiedFinished(f,receipt);assert(receipt.originalRefs.some(([ref])=>ref==='refs/tags/later'));assert.equal(Object.keys(receipt.recoveryRefs).length,12);
  const prepared=f.journal.filter(row=>row.phase==='git-recovery-ref-lock-prepared'&&row.details.lock.kind==='ref');assert.equal(prepared.length,10);assert(!prepared.some(row=>[prefix+'sourceHead.lock',prefix+'destinationHead.lock'].some(ref=>row.details.lock.path.endsWith(ref))));
  const changed=structuredClone(receipt);changed.originalRefs=changed.originalRefs.filter(([ref])=>ref!=='refs/heads/feature');await assert.rejects(verifyHandoffGitRecovery(await rehydrated(f),changed,{runner,inspector,check:()=>{}}),/baseline|original ref/);
});
for(const reverse of [false,true])await test('Finish can follow Restore and Restore can follow Finish '+reverse,async()=>{
  const f=await fixture('finish-restored-'+reverse,{reverse});await run(f);await verifiedOriginal(f,await recover(f));await verifiedFinished(f,await finish(f));await verifiedOriginal(f,await recover(f));await verifiedFinished(f,await finish(f));
});
for(const fault of ['stale review','candidate index','source cleanup index','unknown lock'])await test('Finish refuses '+fault+' before native publication',async()=>{
  const f=await fixture('finish-refusal-'+fault.replaceAll(' ','-'));f.plan.gitBaseline=await captureHandoffGitBaseline(f.plan,{runner,inspector,check:()=>{}});const plan=await rehydrated(f),review=await reviewHandoffGitRecovery(plan,{runner,inspector,check:()=>{}});let called=false;
  const path=fault==='stale review'?join(plan.states.source.r.gitDir,'HEAD'):fault==='unknown lock'?join(plan.states.source.r.gitDir,'index.lock'):plan.candidate.artifacts[fault==='candidate index'?'index':'sourceCleanupIndex'];
  if(fault==='stale review'){await unlink(path);await writeFile(path,plan.states.source.headRaw);}else await writeFile(path,'FOREIGN');
  await assert.rejects(finish(f,{review,finishFiles:async()=>{called=true;}}),/changed|unowned|replaced|differs/);assert.equal(called,false);if(fault==='unknown lock')assert.equal(await readFile(path,'utf8'),'FOREIGN');
});
for(const target of ['restore','finish'])await test('Finish Stop retains exact locks and allows '+target,async()=>{
  const f=await fixture('finish-stop-'+target);let stopped=false,error;try{await finish(f,{check:()=>{if(stopped)throw Object.assign(new Error('Stopped Finish'),{code:'CANCELLED'});},checkpoint:async phase=>{if(phase==='git-recovery-files-finished')stopped=true;}});}catch(e){error=e;}
  assert.equal(error?.code,'CANCELLED');assert.equal(error.handoffGitRecovery.retainedLocks.length,4);for(const lock of error.handoffGitRecovery.retainedLocks)assert((await lstat(lock.path)).isFile());
  const receipt=target==='restore'?await recover(f):await finish(f);assert.equal(receipt.retiredLocks.length,4);await (target==='restore'?verifiedOriginal:verifiedFinished)(f,receipt);
});
await test('Finish continues after interrupted Restore source reattachment',async()=>{
  const f=await fixture('finish-interrupted-restore');await run(f);await assert.rejects(recover(f,{checkpoint:async phase=>{if(phase==='git-recovery-source-head-published')throw new Error('Injected reverse recovery');}}),/Injected/);await verifiedFinished(f,await finish(f));
});
await test('Finish cancellation of prepared recovery refs never reaches native publication',async()=>{
  const f=await fixture('finish-ref-stop'),before=await liveMetadata(f.plan);let stopped=false,called=false;
  await assert.rejects(finish(f,{check:()=>{if(stopped)throw Object.assign(new Error('Stopped prepared refs'),{code:'CANCELLED'});},checkpoint:async(phase,details)=>{if(phase==='git-recovery-ref-lock-prepared'&&details.lock.kind==='ref')stopped=true;},finishFiles:async()=>{called=true;}}),{code:'CANCELLED'});
  assert(stopped);assert.equal(called,false);assert.deepEqual(await liveMetadata(f.plan),before);assert.equal((await git(f.plan.source,['for-each-ref','--format=%(refname)','refs/saleh/handoff/'+f.plan.id+'/'])).stdout,'');
});
await test('Finish verification refuses a surviving authenticated live lock',async()=>{
  const f=await fixture('finish-live-lock'),receipt=await finish(f),path=join(f.plan.states.source.r.gitDir,'index.lock');await writeFile(path,'',{flag:'wx'});const s=await lstat(path,{bigint:true});receipt.locks=[{path,identity:{dev:String(s.dev),ino:String(s.ino)},hash:sha(Buffer.alloc(0)),bytes:0,owner:'application',kind:'index'}];
  try{await assert.rejects(verifyHandoffGitRecovery(await rehydrated(f),receipt,{runner,inspector,check:()=>{}}),/live Git locks/);}finally{await unlink(path);}
});
await test('Finish refuses a symbolic recovery-ref parent without external writes',async()=>{
  const f=await fixture('finish-ref-parent');f.plan.gitBaseline=await captureHandoffGitBaseline(f.plan,{runner,inspector,check:()=>{}});const outside=join(root,'ref-parent-outside');await mkdir(outside);await symlink(outside,join(f.plan.states.source.r.commonDir,'refs/saleh'));let called=false;
  await assert.rejects(finish(f,{finishFiles:async()=>{called=true;}}));assert.equal(called,false);assert.deepEqual(await readdir(outside),[],'Recovery refs must not be created through a symbolic parent.');
});
for(const [operation,kind] of [['forward','ref'],['forward','head'],['finish','ref'],['restore','head']])for(const fault of ['contents','identity','hardlink'])await test('prepared Git lock mutation is refused before commit '+operation+' '+kind+' '+fault,async()=>{
  const f=await fixture('prepared-lock-'+operation+'-'+kind+'-'+fault);if(operation==='restore')await run(f);const before=await liveMetadata(f.plan),refList=async()=>(await git(f.plan.source,['for-each-ref','--format=%(refname)%00%(objectname)'])).stdout,refs=await refList();let injected=false,called=false;
  const checkpoint=async(phase,details)=>{if(!injected&&['git-ref-lock-prepared','git-recovery-ref-lock-prepared'].includes(phase)&&details.lock.kind===kind){injected=true;if(fault==='contents')await writeFile(details.lock.path,f.plan.states.destination.head+'\n');else if(fault==='hardlink')await link(details.lock.path,join(f.plan.directory,'shared-lock'));else{const original=await readFile(details.lock.path);await rename(details.lock.path,join(f.plan.directory,'substituted-lock'));await writeFile(details.lock.path,original,{flag:'wx'});}}};
  await assert.rejects(operation==='forward'?run(f,{checkpoint,publishFiles:async()=>{called=true;}}):operation==='finish'?finish(f,{checkpoint,finishFiles:async()=>{called=true;}}):recover(f,{checkpoint,restoreFiles:async()=>{called=true;}}));
  assert(injected);assert.equal(called,false);assert.deepEqual(await liveMetadata(f.plan),before,'Prepared HEAD mutation must not reach live metadata.');
  if(kind==='ref'||operation==='restore')assert.equal(await refList(),refs,'Prepared ref mutation must not publish a changed ref inventory.');
});
for(const operation of ['forward','finish'])for(const fault of ['contents','identity'])await test('prepared sibling lock mutation is refused before commit '+operation+' '+fault,async()=>{
  const f=await fixture('prepared-sibling-'+operation+'-'+fault),before=await liveMetadata(f.plan),refList=async()=>(await git(f.plan.source,['for-each-ref','--format=%(refname)%00%(objectname)'])).stdout,refs=await refList();let injected=false,called=false;
  const checkpoint=async(phase,details)=>{if(!injected&&['git-ref-lock-prepared','git-recovery-ref-lock-prepared'].includes(phase)&&details.lock.kind==='ref'){injected=true;const path=join(dirname(details.lock.path),'sourceCleanup.lock');assert.notEqual(path,details.lock.path);if(fault==='contents')await writeFile(path,f.plan.states.destination.head+'\n');else{const bytes=await readFile(path);await rename(path,join(f.plan.directory,'substituted-sibling'));await writeFile(path,bytes,{flag:'wx'});}}};
  await assert.rejects(operation==='forward'?run(f,{checkpoint,publishFiles:async()=>{called=true;}}):finish(f,{checkpoint,finishFiles:async()=>{called=true;}}));assert(injected);assert.equal(called,false);assert.deepEqual(await liveMetadata(f.plan),before);assert.equal(await refList(),refs);
});
await test('forward index hardlink is refused before publication',async()=>{
  const f=await fixture('forward-index-hardlink'),before=await liveMetadata(f.plan);let injected=false,called=false;
  await assert.rejects(run(f,{checkpoint:async phase=>{if(phase==='git-locked'){injected=true;await link(join(f.plan.states.source.r.gitDir,'index.lock'),join(f.plan.directory,'index-alias'));}},publishFiles:async()=>{called=true;return files(f);}}));assert(injected);assert.equal(called,false);assert.deepEqual(await liveMetadata(f.plan),before);
});
await writeFile(join(root,'evidence.json'),JSON.stringify({root,focus:focus??null,passed:results.length,results},null,2));console.log(JSON.stringify({passed:results.length,evidence:join(root,'evidence.json')},null,2));
