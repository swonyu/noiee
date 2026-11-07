import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,symlink,lstat,readdir,realpath,unlink,utimes,link,open,readlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync as requireWrite} from 'node:fs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
const imported=await import('./managed-worktrees.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
assert.equal(typeof imported.ManagedWorktrees,'function','ManagedWorktrees backend must exist');
const {ManagedWorktrees}=imported,exec=promisify(execFile),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git';
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-worktree-check-'))),source=join(root,'source');
const gitEnv={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const raw=async(args)=> (await exec(git,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env:gitEnv})).stdout.trim();
const tests=[];const check=async(name,fn)=>{if(process.env.WORKTREE_CHECK_MATCH&&!name.includes(process.env.WORKTREE_CHECK_MATCH))return;await fn();tests.push(name);console.log('PASS '+name);};
await mkdir(source);await raw(['init','-b','main',source]);await raw(['-C',source,'config','user.name','Fixture']);await raw(['-C',source,'config','user.email','fixture@example.invalid']);
await writeFile(join(source,'file.txt'),'BASE\n');await raw(['-C',source,'add','file.txt']);await raw(['-C',source,'commit','-m','base']);const commit=await raw(['-C',source,'rev-parse','HEAD']);
await writeFile(join(source,'file.txt'),'DIRTY\n');await writeFile(join(source,'untracked'),'PRESERVE\n');const sourceIndex=await readFile(join(source,'.git/index')),sourceConfig=await readFile(join(source,'.git/config')),sourceHead=await readFile(join(source,'.git/HEAD'));
let clock=Date.now();const requests=[],dataDir=join(root,'coding');
const owner=new ManagedWorktrees({dataDir,now:()=>clock,spawnProcess:(file,args,options)=>{requests.push({file,args,options});return spawn(file,args,options);}});
let plan,record;
await check('copy local changes preserves staged and working layers in a fresh checkout without source mutation',async()=>{
  const s=join(root,'local-changes-source'),dir=join(root,'local-changes-data');await mkdir(s);await raw(['init','--initial-branch=main',s]);
  for(const [name,data] of Object.entries({'both.txt':'BASE\n','remove.txt':'REMOVE\n','staged-delete.txt':'STAGED DELETE\n','run.sh':'#!/bin/sh\nexit 0\n','.gitignore':'.env*\nAGENTS.override.md\nconfig/*.local\n'}))await writeFile(join(s,name),data);
  await mkdir(join(s,'cache'));await writeFile(join(s,'cache/was-tracked'),'KEEP IGNORED WORKING REMAINDER\n');await mkdir(join(s,'config'));await writeFile(join(s,'config/tracked.txt'),'TRACKED NESTED\n');
  await writeFile(join(s,'binary.bin'),Buffer.from([0,1,2,255]));await raw(['-C',s,'add','.']);await raw(['-C',s,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);await raw(['-C',s,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','current']);
  await writeFile(join(s,'both.txt'),'STAGED\n');await writeFile(join(s,'added.txt'),'INDEX ADDITION\n');await raw(['-C',s,'add','both.txt','added.txt']);await raw(['-C',s,'rm','staged-delete.txt']);await writeFile(join(s,'both.txt'),'WORKING\n');await writeFile(join(s,'added.txt'),'WORKING ADDITION\n');await unlink(join(s,'remove.txt'));await writeFile(join(s,'binary.bin'),Buffer.from([0,255,3,4,0]));await chmod(join(s,'run.sh'),0o755);
  await writeFile(join(s,'.gitignore'),'.env*\nAGENTS.override.md\nconfig/*.local\ncache/\n');await raw(['-C',s,'rm','--cached','cache/was-tracked']);await writeFile(join(s,'cache/private'),'EXCLUDED IGNORED PEER\n');
  await writeFile(join(s,'shared-a'),'HARDLINK\n');await link(join(s,'shared-a'),join(s,'shared-b'));await symlink('../outside-literal',join(s,'literal'));await mkdir(join(s,'empty'));
  await writeFile(join(s,'.worktreeinclude'),'.env\nconfig/*.local\n');await writeFile(join(s,'config/runtime.local'),'NESTED SETUP\n');await writeFile(join(s,'.env'),'SETUP\n');await writeFile(join(s,'.env.private'),'EXCLUDED\n');await writeFile(join(s,'AGENTS.override.md'),'LOCAL INSTRUCTIONS\n');await mkdir(join(s,'.saleh-coding-tmp-FIXTURE'));await writeFile(join(s,'.saleh-coding-tmp-FIXTURE','keep'),'SOURCE SCRATCH\n');
  const index=await readFile(join(s,'.git/index')),head=await readFile(join(s,'.git/HEAD')),config=await readFile(join(s,'.git/config')),indexInfo=await raw(['--no-optional-locks','-C',s,'ls-files','--stage','-z']),patch=await raw(['--no-optional-locks','-C',s,'diff','--binary']),staged=await raw(['--no-optional-locks','-C',s,'diff','--cached','--binary']);
  const o=new ManagedWorktrees({dataDir:dir,managedMutationBlocked:true,nativeHelper:process.env.HANDOFF_FILES_HELPER});
  try{
    const p=(await o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges:true})).plan;assert.equal(p.copyChanges,true);assert(p.localChanges.files>=9);assert(p.localChanges.bytes>0);assert.deepEqual(p.localChanges.excludedScratch,['.saleh-coding-tmp-FIXTURE']);assert.deepEqual(p.localChanges.ignoredRemainders,['cache/was-tracked']);
    const r=(await o.handle({action:'create',planId:p.id})).worktree;assert.equal(r.state,'ready',r.message);assert.equal(r.dirty,true);assert.match(r.message,/local changes/i);
    assert.equal(await raw(['--no-optional-locks','-C',r.cwd,'ls-files','--stage','-z']),indexInfo);assert.equal(await raw(['--no-optional-locks','-C',r.cwd,'diff','--binary']),patch);assert.equal(await raw(['--no-optional-locks','-C',r.cwd,'diff','--cached','--binary']),staged);assert.equal(await raw(['-C',r.cwd,'symbolic-ref','-q','HEAD']).catch(()=>''),'');
    for(const name of ['both.txt','added.txt','binary.bin','run.sh','shared-a','shared-b','cache/was-tracked','config/tracked.txt','config/runtime.local','.worktreeinclude','.env','AGENTS.override.md'])assert.deepEqual(await readFile(join(r.cwd,name)),await readFile(join(s,name)),name);
    for(const name of ['remove.txt','staged-delete.txt','.env.private','cache/private','.saleh-coding-tmp-FIXTURE'])await assert.rejects(lstat(join(r.cwd,name)),{code:'ENOENT'});
    assert.equal(await readlink(join(r.cwd,'literal')),'../outside-literal');assert((await lstat(join(r.cwd,'empty'))).isDirectory());assert.equal((await lstat(join(r.cwd,'run.sh'))).mode&0o777,0o755);assert.equal((await lstat(join(r.cwd,'shared-a'))).ino,(await lstat(join(r.cwd,'shared-b'))).ino);assert.notEqual((await lstat(join(r.cwd,'shared-a'))).ino,(await lstat(join(s,'shared-a'))).ino);
    assert.deepEqual(await readFile(join(s,'.git/index')),index);assert.deepEqual(await readFile(join(s,'.git/HEAD')),head);assert.deepEqual(await readFile(join(s,'.git/config')),config);assert.equal(await readFile(join(s,'.saleh-coding-tmp-FIXTURE','keep'),'utf8'),'SOURCE SCRATCH\n');
    await assert.rejects(o.handle({action:'prepareArchive',id:r.id}),/Full Access boot/i);
    await assert.rejects(o.handle({action:'prepare',cwd:s,ref:'HEAD~1',copyChanges:true}),/source HEAD/i);
    for(const copyChanges of [null,'true',1])await assert.rejects(o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges}));
    const stale=(await o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges:true})).plan;await writeFile(join(s,'both.txt'),'CHANGED AFTER REVIEW\n');await assert.rejects(o.handle({action:'create',planId:stale.id}),/local changes.*changed/i);await assert.rejects(lstat(stale.cwd),{code:'ENOENT'});await writeFile(join(s,'both.txt'),'WORKING\n');
    const occupied=(await o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges:true})).plan,spawnPrior=o.spawnProcess;let inserted=false;
    o.spawnProcess=(file,args,options)=>{if(args.includes('copyCheckout')&&!inserted){inserted=true;requireWrite(join(occupied.cwd,'both.txt'),'ARRIVED TARGET\n');}return (spawnPrior??spawn)(file,args,options);};
    try{const kept=(await o.handle({action:'create',planId:occupied.id})).worktree;assert.equal(kept.state,'needs-inspection');assert.equal(await readFile(join(kept.cwd,'both.txt'),'utf8'),'ARRIVED TARGET\n');assert.equal(await readFile(join(s,'both.txt'),'utf8'),'WORKING\n');}finally{o.spawnProcess=spawnPrior;}
    for(const mutation of ['head','ignored','headSetup','headSetupCommit','setup','setupCommit','ignoredSetup','ignoredSetupCommit']){
      const copyChanges=!mutation.endsWith('Commit'),reviewed=(await o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges})).plan,previous=o.spawnProcess;let changed=false;
      o.spawnProcess=(file,args,options)=>{const child=(previous??spawn)(file,args,options);if(args.includes(mutation==='head'||mutation==='ignored'?'copyCheckout':'copyLocal')&&!changed){changed=true;child.once('close',code=>{if(code===0)requireWrite(mutation.startsWith('head')?join(reviewed.commonDir,'worktrees',reviewed.id,'HEAD'):join(reviewed.cwd,mutation.startsWith('setup')?'.env':'.env.arrived'),mutation.startsWith('head')?'ref: refs/heads/main\n':mutation.startsWith('setup')?'CHANGED AFTER SETUP\n':'ARRIVED IGNORED\n');});}return child;};
      try{const retained=(await o.handle({action:'create',planId:reviewed.id})).worktree;assert.equal(retained.state,'needs-inspection',mutation+' drift must be retained rather than called a detached exact copy');if(mutation==='ignored')assert.equal(await readFile(join(reviewed.cwd,'.env.arrived'),'utf8'),'ARRIVED IGNORED\n');assert.deepEqual(await readFile(join(s,'.git/index')),index);}finally{o.spawnProcess=previous;}
    }
    await writeFile(join(s,'intent'),'INTENT\n');await raw(['-C',s,'add','--intent-to-add','intent']);const intentIndex=await readFile(join(s,'.git/index'));await assert.rejects(o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges:true}),/index flags|intent.to.add/i);assert.deepEqual(await readFile(join(s,'.git/index')),intentIndex);
  }finally{await o.close();}
});
await check('copy local changes refuses nested bare metadata and excessive scratch before allocation',async()=>{
  const s=join(root,'copy-refusal-source'),dir=join(root,'copy-refusal-data');await mkdir(s);await raw(['init','--initial-branch=main',s]);await writeFile(join(s,'base'),'BASE\n');await raw(['-C',s,'add','base']);await raw(['-C',s,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);const index=await readFile(join(s,'.git/index'));
  const o=new ManagedWorktrees({dataDir:dir,managedMutationBlocked:true,nativeHelper:process.env.HANDOFF_FILES_HELPER});
  try{
    await raw(['init','--bare',join(s,'nested.git')]);await assert.rejects(o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges:true}),/nested bare Git metadata/i);assert.equal(o.records.length,0);assert.equal(o.plans.size,0);assert.deepEqual(await readFile(join(s,'.git/index')),index);
    await writeFile(join(s,'.gitignore'),'nested.git/\n');await exec('/usr/bin/mkfifo',[join(s,'special')]);const began=Date.now();await assert.rejects(o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges:true}),/special/i);assert(Date.now()-began<3000,'Special files must fail without blocking');await unlink(join(s,'special'));
    for(const name of ['one','two','three'])await mkdir(join(s,'.saleh-coding-tmp-'+name));await assert.rejects(o.handle({action:'prepare',cwd:s,ref:'HEAD',copyChanges:true}),/more than two reserved/i);assert.equal(o.records.length,0);assert.equal(o.plans.size,0);assert.deepEqual(await readFile(join(s,'.git/index')),index);
  }finally{await o.close();}
});
await check('local setup files follow ignored include patterns without changing source or overwriting target commits',async()=>{
  const s=join(root,'local-setup-source'),dir=join(root,'local-setup-data');await mkdir(s);await raw(['init','--initial-branch=main',s]);
  await mkdir(join(s,'config'));await writeFile(join(s,'.gitignore'),'.env*\nconfig/*.local\nAGENTS.override.md\nlinked\ncollision\n');
  await writeFile(join(s,'tracked'),'BASE\n');await writeFile(join(s,'collision'),'TARGET COMMIT\n');await raw(['-C',s,'add','-f','.gitignore','tracked','collision']);await raw(['-C',s,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','local setup base']);const ref=await raw(['-C',s,'rev-parse','HEAD']);
  await raw(['-C',s,'rm','--cached','collision']);await writeFile(join(s,'collision'),'SOURCE IGNORED\n');
  await writeFile(join(s,'.worktreeinclude'),'.env*\n!.env.private\nconfig/*.local\nprivate.local\nlinked\ncollision\n');
  for(const [name,body] of Object.entries({'.env':'LOCAL_SETUP_VALUE\n','.env.private':'DO NOT COPY\n','config/dev.local':'NESTED_SETUP\n','AGENTS.override.md':'LOCAL INSTRUCTIONS\n','untracked':'LEAVE UNTRACKED\n'}))await writeFile(join(s,name),body);
  await writeFile(join(s,'.gitignore'),'.env*\nconfig/*.local\nAGENTS.override.md\nlinked\ncollision\nprivate.local\n');await writeFile(join(s,'private.local'),'SOURCE_ONLY_IGNORED\n');
  await symlink(join(s,'.env'),join(s,'linked'));await writeFile(join(s,'tracked'),'SOURCE EDIT\n');
  const index=await readFile(join(s,'.git/index')),before=await readFile(join(s,'.git/HEAD')),o=new ManagedWorktrees({dataDir:dir,managedMutationBlocked:true,nativeHelper:process.env.HANDOFF_FILES_HELPER});
  try{
    const p=(await o.handle({action:'prepare',cwd:s,ref})).plan;assert.deepEqual(p.localSetup?.paths,['.env','AGENTS.override.md','config/dev.local','private.local']);assert.equal(p.localSetup.files,4);
    const r=(await o.handle({action:'create',planId:p.id})).worktree;assert.equal(r.state,'ready',r.message);
    assert.equal(r.dirty,true,'A source-only ignored setup file must be reported as untracked in the target');assert.equal(await raw(['-C',r.cwd,'ls-files','--others','--exclude-standard']),'private.local');
    for(const name of p.localSetup.paths)assert.deepEqual(await readFile(join(r.cwd,name)),await readFile(join(s,name)));
    for(const name of ['.env.private','linked','untracked'])await assert.rejects(lstat(join(r.cwd,name)),{code:'ENOENT'});
    assert.equal(await readFile(join(r.cwd,'collision'),'utf8'),'TARGET COMMIT\n');assert.equal(await readFile(join(r.cwd,'tracked'),'utf8'),'BASE\n');assert.equal(await readFile(join(s,'tracked'),'utf8'),'SOURCE EDIT\n');
    assert.deepEqual(await readFile(join(s,'.git/index')),index);assert.deepEqual(await readFile(join(s,'.git/HEAD')),before);
    const occupied=(await o.handle({action:'prepare',cwd:s,ref})).plan,spawnPrior=o.runner.spawnProcess;let inserted=false;
    o.runner.spawnProcess=(file,args,options)=>{if(args.includes('checkout-index')&&!inserted){inserted=true;requireWrite(join(occupied.cwd,'.env'),'ARRIVED TARGET FILE\n');}return spawnPrior(file,args,options);};
    try{const kept=(await o.handle({action:'create',planId:occupied.id})).worktree;assert.equal(kept.state,'ready',kept.message);assert.equal(await readFile(join(kept.cwd,'.env'),'utf8'),'ARRIVED TARGET FILE\n');assert.match(kept.message,/Copied 3 local setup files/);assert.equal(await readFile(join(s,'.env'),'utf8'),'LOCAL_SETUP_VALUE\n');}finally{o.runner.spawnProcess=spawnPrior;}
    const stale=(await o.handle({action:'prepare',cwd:s,ref})).plan;await writeFile(join(s,'.env'),'CHANGED AFTER REVIEW\n');await assert.rejects(o.handle({action:'create',planId:stale.id}),/local setup.*changed/i);await assert.rejects(lstat(stale.cwd),{code:'ENOENT'});
    const control=(await o.handle({action:'prepare',cwd:s,ref})).plan;await writeFile(join(s,'.worktreeinclude'),'.env.private\n');await assert.rejects(o.handle({action:'create',planId:control.id}),/local setup.*changed/i);await assert.rejects(lstat(control.cwd),{code:'ENOENT'});
    const ignore=(await o.handle({action:'prepare',cwd:s,ref})).plan;await writeFile(join(s,'.git/info/exclude'),'private.local\n');await writeFile(join(s,'.gitignore'),'config/*.local\nAGENTS.override.md\nlinked\ncollision\n');await assert.rejects(o.handle({action:'create',planId:ignore.id}),/local setup.*changed/i);await assert.rejects(lstat(ignore.cwd),{code:'ENOENT'});
    await unlink(join(s,'.worktreeinclude'));await symlink(join(s,'.env'),join(s,'.worktreeinclude'));await assert.rejects(o.handle({action:'prepare',cwd:s,ref}),/worktreeinclude.*regular/i);
    await unlink(join(s,'.worktreeinclude'));await exec('/usr/bin/mkfifo',[join(s,'.worktreeinclude')]);const started=Date.now();await assert.rejects(o.handle({action:'prepare',cwd:s,ref}),/worktreeinclude.*regular/i);assert(Date.now()-started<3000,'A FIFO policy must fail without opening/blocking');
  }finally{await o.close();}
});
await check('strict shapes and ordinary projects do not execute Git',async()=>{
  await owner.assertProject(source);assert.equal(requests.length,0);
  for(const input of [{action:'list',extra:true},{action:'prepare',cwd:source,ref:'HEAD',cwd2:source},{action:'prepare',cwd:source,ref:'--help'},{action:'prepare',cwd:source,ref:'x'.repeat(513)},{action:'create',planId:'../escape'},{action:'stop',extra:false},null])await assert.rejects(owner.handle(input));
});
await check('project roots cannot include app control data through direct paths or aliases',async()=>{
  const nested=join(dataDir,'sessions','nested'),alias=join(root,'control-alias'),ancestorAlias=join(root,'ancestor-alias'),peer=join(root,'coding-peer');
  await mkdir(nested,{recursive:true});await mkdir(peer);await symlink(dataDir,alias);await symlink(root,ancestorAlias);
  const canary=join(dataDir,'control-canary');await writeFile(canary,'APP-OWNED');
  for(const cwd of [dataDir,root,'/',nested,alias,ancestorAlias]){
    await assert.rejects(owner.assertProject(cwd),/Protected app data/i);
    await assert.rejects(owner.assertOwned(cwd,owner.epoch),/Protected app data/i);
  }
  await assert.rejects(owner.handle({action:'prepare',cwd:dataDir,ref:commit}),/Protected app data/i);
  await owner.assertProject(peer);await owner.assertProject(source);
  assert.equal(await readFile(canary,'utf8'),'APP-OWNED');assert.equal(requests.length,0,'Protected-root rejection must precede Git execution');
});
await check('worktree preparation rejects a promoted Git root containing app data',async()=>{
  const repo=join(root,'broad-source'),child=join(repo,'child'),home=join(repo,'control');await mkdir(child,{recursive:true});
  await raw(['init','-b','main',repo]);await writeFile(join(child,'file'),'BASE');await writeFile(join(repo,'.gitignore'),'control/\n');await raw(['-C',repo,'add','.']);await raw(['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
  const o=new ManagedWorktrees({dataDir:home});
  try{await o.assertProject(child);const index=await readFile(join(repo,'.git/index'));await assert.rejects(o.handle({action:'prepare',cwd:child,ref:'HEAD'}),/Protected app data/i);assert.equal(o.plans.size,0);assert.equal(o.records.length,0);assert.deepEqual(await readFile(join(repo,'.git/index')),index);}finally{await o.close();}
});
await check('worktree preparation rejects separate Git metadata in app control storage',async()=>{
  for(const [name,relative] of [['control','private.git'],['recovery','Worktrees/.archives/private.git']]){
    const repo=join(root,'separate-'+name),home=join(root,'separate-'+name+'-data'),gitDir=join(home,relative);await mkdir(repo);await mkdir(gitDir,{recursive:true,mode:0o700});
    await raw(['init','-b','main','--separate-git-dir='+gitDir,repo]);await raw(['-C',repo,'config','core.worktree',repo]);await writeFile(join(repo,'file'),'BASE');await raw(['-C',repo,'add','.']);await raw(['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
    const linked=repo+'-linked';await raw(['-C',repo,'worktree','add','--detach',linked,'HEAD']);
    const o=new ManagedWorktrees({dataDir:home});try{await o.assertProject(linked);const index=await readFile(join(gitDir,'index'));await assert.rejects(o.handle({action:'prepare',cwd:linked,ref:'HEAD'}),/Protected app data/i);assert.equal(o.plans.size,0);assert.equal(o.records.length,0);assert.deepEqual(await readFile(join(gitDir,'index')),index);}finally{await o.close();}
  }
});
await check('read-only prepare resolves exact commit and dirty source',async()=>{
  const result=await owner.handle({action:'prepare',cwd:source,ref:'HEAD'});plan=result.plan;assert.equal(plan.commit,commit);assert.equal(plan.source,source);assert.equal(plan.commonDir,join(source,'.git'));assert.equal(plan.dirty,true);assert.equal(plan.expiresAt,clock+120000);assert(plan.cwd.startsWith(join(dataDir,'Worktrees')+'/'));
  assert(!requests.some(r=>r.args.includes('add')));
});
await check('single-use creation is locked detached and source remains intact',async()=>{
  record=(await owner.handle({action:'create',planId:plan.id})).worktree;assert.equal(record.state,'ready',record.message);assert.equal(await readFile(join(record.cwd,'file.txt'),'utf8'),'BASE\n');assert.equal(await raw(['-C',record.cwd,'rev-parse','HEAD']),commit);
  assert.match(await raw(['-C',source,'worktree','list','--porcelain']),/detached\nlocked/);
  assert.deepEqual(await readFile(join(source,'.git/index')),sourceIndex);assert.deepEqual(await readFile(join(source,'.git/config')),sourceConfig);assert.deepEqual(await readFile(join(source,'.git/HEAD')),sourceHead);assert.equal(await readFile(join(source,'file.txt'),'utf8'),'DIRTY\n');assert.equal(await readFile(join(source,'untracked'),'utf8'),'PRESERVE\n');
  await assert.rejects(owner.handle({action:'create',planId:plan.id}),/plan|expired|consumed/i);
});
await check('resolve/restart permit owned edits and changed HEAD without resetting',async()=>{
  await writeFile(join(record.cwd,'file.txt'),'MANAGED EDIT\n');await owner.assertProject(record.cwd);const resolved=(await owner.handle({action:'resolve',id:record.id})).worktree;assert.equal(resolved.dirty,true);
  await raw(['-C',record.cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-am','managed edit']);const changed=await raw(['-C',record.cwd,'rev-parse','HEAD']);assert.notEqual(changed,commit);
  await owner.close();const restarted=new ManagedWorktrees({dataDir});const current=(await restarted.handle({action:'resolve',id:record.id})).worktree;assert.equal(current.head,changed);assert.equal(await readFile(join(record.cwd,'file.txt'),'utf8'),'MANAGED EDIT\n');await restarted.close();
});
await check('creation reservation reenters recovery inspection only in its own async task',async()=>{
 for(const cancel of [false,true]){
  let manager,entered,release,checked=0,released=0;const started=new Promise(r=>entered=r),held=new Promise(r=>release=r);
  manager=new ManagedWorktrees({dataDir:join(root,'reentrant-'+cancel),managedMutationBlocked:true,reserveMutation:async resolve=>{
   await resolve();const status=await manager.inspectUnconfinedAccess();await status.recheck();checked++;entered();await held;await status.recheck();checked++;return {release(){released++;}};
  }});
  const boot=randomUUID().toUpperCase();manager.handoffProcess=async operation=>{assert.equal(operation,'boot');return {version:1,bootSession:boot};};
  const preparing=manager.handle({action:'prepare',cwd:source,ref:commit});
  try{
   await Promise.race([started,preparing.then(()=>{throw Error('Preparation completed without its held owner inspection');})]);
   assert.throws(()=>manager.checkUnconfinedAccess(manager.epoch),/busy/,'A concurrent caller must not borrow creation admission');
   await assert.rejects(manager.inspectUnconfinedAccess(),/busy/,'A concurrent Full Access request must remain fenced');
   if(cancel){const failed=assert.rejects(preparing,/cancel|stopped/i),stopping=manager.stop();release();await failed;await stopping;assert.equal(manager.plans.size,0);assert.equal(manager.records.length,0);}
   else{release();const p=await preparing;assert(p.plan);assert.equal(checked,2);const r=(await manager.handle({action:'create',planId:p.plan.id})).worktree;assert.equal(r.state,'ready',r.message);assert.equal(await readFile(join(r.cwd,'file.txt'),'utf8'),'BASE\n');assert.equal(await readFile(join(source,'file.txt'),'utf8'),'DIRTY\n');assert.deepEqual(await readFile(join(source,'.git/index')),sourceIndex);assert.equal(released,1);}
  }finally{release();await preparing.catch(()=>{});await manager.close();}
 }
});
await check('Full Access resolves a verified ready checkout without changing its ledger or Git state',async()=>{
  const f=await lifecycleFixture('full-access-open');await f.o.close();const o=new ManagedWorktrees({dataDir:f.dataDir,managedMutationBlocked:true});
  const admin=await raw(['-C',f.r.cwd,'rev-parse','--absolute-git-dir']),ledger=await readFile(join(f.dataDir,'managed-worktrees.json')),index=await readFile(join(admin,'index')),head=await readFile(join(admin,'HEAD')),sourceIndex=await readFile(join(f.source,'.git/index'));
  try{
    const list=await o.handle({action:'list'});assert.equal(list.readOnly,true);assert.equal(list.openAvailable,true,'Ready checkout opening must be distinguished from retained lifecycle mutation');assert.equal(list.createAvailable,true);
    const result=await o.handle({action:'resolve',id:f.r.id});assert.equal(result.worktree.state,'ready');assert.equal(result.worktree.cwd,f.r.cwd);assert.equal(await readFile(join(f.r.cwd,'file'),'utf8'),'base\n');
    for(const input of [{action:'prepareArchive',id:f.r.id},{action:'prepareRestore',id:f.r.id},{action:'prepareReconnect'},{action:'prepareHandoff',id:f.r.id,threadId:'fixture-root'},{action:'prepareHandoffRecovery',id:f.r.id,mode:'restore'}])await assert.rejects(o.handle(input),/Full Access boot/);
    const parked=f.r.cwd+'-parked';await rename(f.r.cwd,parked);await symlink(parked,f.r.cwd);try{await assert.rejects(o.handle({action:'resolve',id:f.r.id}),/replaced|identity|symbolic/i);}finally{await unlink(f.r.cwd);await rename(parked,f.r.cwd);}
    assert.deepEqual(await readFile(join(f.dataDir,'managed-worktrees.json')),ledger);assert.deepEqual(await readFile(join(admin,'index')),index);assert.deepEqual(await readFile(join(admin,'HEAD')),head);assert.deepEqual(await readFile(join(f.source,'.git/index')),sourceIndex);
  }finally{await o.close();}
});
await check('linked source is supported and expired plans dispatch nothing',async()=>{
  const o=new ManagedWorktrees({dataDir,now:()=>clock});const p=(await o.handle({action:'prepare',cwd:record.cwd,ref:commit})).plan;clock+=120001;await assert.rejects(o.handle({action:'create',planId:p.id}),/expired/i);const p2=(await o.handle({action:'prepare',cwd:record.cwd,ref:commit})).plan;const child=(await o.handle({action:'create',planId:p2.id})).worktree;assert.equal(child.state,'ready',child.message);assert.equal(await readFile(join(child.cwd,'file.txt'),'utf8'),'BASE\n');await o.close();
});
await check('active attributes block filters before creation',async()=>{
  const attrs=join(source,'.git/info/attributes');await writeFile(attrs,'file.txt filter=fixture\n');const o=new ManagedWorktrees({dataDir});await assert.rejects(o.handle({action:'prepare',cwd:source,ref:commit}),/filter/i);await writeFile(attrs,'');await o.close();
});
await check('config change after approval consumes plan without creating',async()=>{
  const o=new ManagedWorktrees({dataDir});const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;await raw(['-C',source,'config','fixture.changed','true']);await assert.rejects(o.handle({action:'create',planId:p.id}),/changed/i);await assert.rejects(o.handle({action:'create',planId:p.id}));await raw(['-C',source,'config','--unset','fixture.changed']);await o.close();
});
await check('missing/replaced checkout cannot open or execute',async()=>{
  const o=new ManagedWorktrees({dataDir});const parked=record.cwd+'-parked';await rename(record.cwd,parked);await symlink(parked,record.cwd);await assert.rejects(o.handle({action:'resolve',id:record.id}),/replaced|identity|symbolic/i);await assert.rejects(o.assertProject(record.cwd),/replaced|identity|symbolic|managed/i);const listed=await o.handle({action:'list'});assert.equal(listed.worktrees.find(r=>r.id===record.id).state,'needs-inspection');await o.close();await unlink(record.cwd);await rename(parked,record.cwd);
});
await check('corrupt or externally changed ledger is preserved',async()=>{
  const dir=join(root,'corrupt');const o=new ManagedWorktrees({dataDir:dir});await o.handle({action:'list'});await writeFile(join(dir,'managed-worktrees.json'),'{broken');await assert.rejects(o.handle({action:'prepare',cwd:source,ref:commit}),/ledger|changed|corrupt/i);assert.equal(await readFile(join(dir,'managed-worktrees.json'),'utf8'),'{broken');await o.close();
  const fresh=new ManagedWorktrees({dataDir:dir});await assert.rejects(fresh.handle({action:'list'}),/ledger|corrupt/i);await fresh.close();
});
await check('stop during real child lifetime preserves intent, confirms exit, cannot reopen',async()=>{
  const dir=join(root,'cancel');let processId,started;const start=new Promise(r=>started=r);let o;
  o=new ManagedWorktrees({dataDir:dir,spawnProcess:(file,args,options)=>{
    if(args.includes('worktree')&&args.includes('add')){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options);processId=child.pid;started();return child;}return spawn(file,args,options);
  }});
  const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;const creation=o.handle({action:'create',planId:p.id});await start;await o.stop();const result=await creation;assert.equal(result.worktree.state,'needs-inspection');assert.throws(()=>process.kill(-processId,0));await assert.rejects(o.handle({action:'resolve',id:p.id}));await o.close();
  const fresh=new ManagedWorktrees({dataDir:dir});const list=await fresh.handle({action:'list'});assert.equal(list.worktrees.length,1);assert.notEqual(list.worktrees[0].state,'ready');await fresh.close();
});
await check('destination-only unsupported config remains retained and cannot open',async()=>{
  const dir=join(root,'include'),o=new ManagedWorktrees({dataDir:dir}),include=join(root,'included-destination');await writeFile(include,'[core]\n sparseCheckout = true\n');
  const key='includeIf.gitdir:'+join(source,'.git/worktrees')+'/**.path';await raw(['-C',source,'config','--add',key,include]);
  const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;const result=await o.handle({action:'create',planId:p.id});assert.equal(result.worktree.state,'needs-inspection',result.worktree.message);assert.match(result.worktree.message,/sparse/i);assert.deepEqual(await readdir(p.cwd),['.git']);await assert.rejects(o.handle({action:'resolve',id:p.id}));await raw(['-C',source,'config','--unset-all',key]);await o.close();
});
await check('file appearing before materialization is preserved and never ready',async()=>{
  const dir=join(root,'appeared');let inserted=false,p;
  const o=new ManagedWorktrees({dataDir:dir,spawnProcess:(file,args,options)=>{
    if(args.includes('checkout-index')&&!inserted){inserted=true;requireWrite(join(p.cwd,'file.txt'),'ARRIVED\n');}
    return spawn(file,args,options);
  }});
  p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;const result=await o.handle({action:'create',planId:p.id});assert.equal(result.worktree.state,'needs-inspection');assert.equal(await readFile(join(p.cwd,'file.txt'),'utf8'),'ARRIVED\n');await o.close();
});
await check('stop at dispatch boundary cancels without a late mutation result',async()=>{
  const dir=join(root,'late-stop');let o,stopping;
  o=new ManagedWorktrees({dataDir:dir,spawnProcess:(file,args,options)=>{const child=spawn(file,args,options);if(args.includes('worktree')&&args.includes('add'))stopping=o.stop();return child;}});
  const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;const result=await o.handle({action:'create',planId:p.id});await stopping;assert.equal(result.worktree.state,'needs-inspection');await o.close();
});
await check('oversize and invalid UTF8 ledgers are preserved',async()=>{
  for(const [name,bytes] of [['large',Buffer.alloc(1048577,32)],['bad-utf8',Buffer.from([123,34,120,34,58,34,255,34,125])]]){
    const dir=join(root,name);await mkdir(dir);await writeFile(join(dir,'managed-worktrees.json'),bytes,{mode:0o600});const o=new ManagedWorktrees({dataDir:dir});await assert.rejects(o.handle({action:'list'}),/ledger/i);assert.deepEqual(await readFile(join(dir,'managed-worktrees.json')),bytes);await o.close();
  }
});
await check('same-byte ledger replacement is external mutation',async()=>{
  const dir=join(root,'ledger-replaced'),o=new ManagedWorktrees({dataDir:dir});const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;await o.handle({action:'create',planId:p.id});const ledger=join(dir,'managed-worktrees.json');await rename(ledger,ledger+'.parked');await writeFile(ledger,await readFile(ledger+'.parked'),{mode:0o600});await assert.rejects(o.handle({action:'list'}),/changed|identity/i);await o.close();
});
await check('Stop during final persistence never returns ready',async()=>{
  const o=new ManagedWorktrees({dataDir:join(root,'final-stop')});const save=o.save.bind(o);let stopping;
  o.save=async()=>{if(o.records.some(r=>r.state==='ready')&&!stopping)stopping=o.stop();return save();};
  const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;const result=await o.handle({action:'create',planId:p.id});await stopping;assert.equal(result.worktree.state,'needs-inspection');await o.close();
});
await check('unconfirmed child exit returns bounded uncertainty and blocks new work',async()=>{
  let held=0;let started;const start=new Promise(r=>started=r);const o=new ManagedWorktrees({dataDir:join(root,'unconfirmed'),reserveMutation:async resolve=>{await resolve();held++;return {release(){held--;}};},spawnProcess:(file,args,options)=>{
    if(!args.includes('worktree')||!args.includes('add'))return spawn(file,args,options);
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});setTimeout(()=>child.emit('close',null,'SIGKILL'),3500).unref();started();return child;
  }});
  const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;const creation=o.handle({action:'create',planId:p.id});await start;const time=Date.now();await o.stop();assert(Date.now()-time<3000,'Stop must finish its uncertain-exit bound before external shutdown');const result=await creation;assert.equal(result.worktree.state,'needs-inspection');assert.match(result.worktree.message,/exit.*not confirmed/i);assert.equal(held,1,'unconfirmed child must retain mutation reservation');await assert.rejects(o.handle({action:'prepare',cwd:source,ref:commit}),/exit.*not confirmed/i);await o.close();
});
await check('preapproved plans cannot exceed the retained record capacity',async()=>{
  const o=new ManagedWorktrees({dataDir:join(root,'capacity')});const p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;
  // Represents other already-approved creations consuming capacity before this plan is used.
  o.records=Array.from({length:128},()=>({id:randomUUID(),state:'needs-inspection'}));await assert.rejects(o.handle({action:'create',planId:p.id}),/128|record limit/i);await o.close();
});
await check('unsupported booleans use Git valueless and numeric semantics',async()=>{
  const config=join(source,'.git/config'),before=await readFile(config);
  for(const [name,value] of [['valueless','sparseCheckout'],['number','sparseCheckout = 2']]){
    await writeFile(config,Buffer.concat([before,Buffer.from('\n[core]\n '+value+'\n')]));assert.equal(await raw(['-C',source,'config','--type=bool','--get','core.sparseCheckout']),'true');
    const o=new ManagedWorktrees({dataDir:join(root,'bool-'+name)});await assert.rejects(o.handle({action:'prepare',cwd:source,ref:commit}),/sparse/i);await o.close();
  }
  await writeFile(config,before);
});
await check('trailing-space repository never redirects to its sibling',async()=>{
  const base=join(root,'path-repo'),spaced=base+' ';let expected;
  for(const cwd of [base,spaced]){await mkdir(cwd);await raw(['init','-b','main',cwd]);await writeFile(join(cwd,'identity.txt'),cwd+'\n');await raw(['-C',cwd,'add','identity.txt']);await raw(['-C',cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','distinct path']);if(cwd===spaced)expected=await raw(['-C',cwd,'rev-parse','HEAD']);}
  assert.notEqual(await raw(['-C',base,'rev-parse','HEAD']),expected);
  const o=new ManagedWorktrees({dataDir:join(root,'space-manager')}),p=(await o.handle({action:'prepare',cwd:spaced,ref:'HEAD'})).plan;assert.equal(p.source,spaced);assert.equal(p.commonDir,join(spaced,'.git'));assert.equal(p.commit,expected);const result=await o.handle({action:'create',planId:p.id});assert.equal(result.worktree.state,'ready',result.worktree.message);assert.equal(await readFile(join(result.worktree.cwd,'identity.txt'),'utf8'),spaced+'\n');await o.close();
});
await check('mutation reservation spans review and create, expiry and Stop release it',async()=>{
  const source=join(root,'lease-source');await mkdir(source);await raw(['init','-b','main',source]);await writeFile(join(source,'file'),'base');await raw(['-C',source,'add','.']);await raw(['-C',source,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','base']);const commit=await raw(['-C',source,'rev-parse','HEAD']);
  let held=0,releases=0,clock=Date.now();const reserveMutation=async resolvePaths=>{assert.equal(held,0);held++;try{const paths=await resolvePaths();assert(paths.includes(source));assert(paths.length<=128);}catch(e){held--;throw e;}return {release(){assert.equal(held,1);held--;releases++;}};};
  const o=new ManagedWorktrees({dataDir:join(root,'leases'),reserveMutation,now:()=>clock});
  let p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;assert.equal(held,1,'reservation must stay held through review');await o.stop();assert.equal(held,0);
  p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;clock+=120001;await assert.rejects(o.handle({action:'create',planId:p.id}),/expired/);assert.equal(held,0);
  p=(await o.handle({action:'prepare',cwd:source,ref:commit})).plan;assert.equal(held,1);const r=await o.handle({action:'create',planId:p.id});assert.equal(r.worktree.state,'ready',r.worktree.message);assert.equal(held,0);assert.equal(releases,3);await o.close();
});
await check('Stop during pending reservation prevents late plan and releases confirmed idle lease',async()=>{
  let entered,allow,held=0;const started=new Promise(r=>entered=r),gate=new Promise(r=>allow=r);
  const o=new ManagedWorktrees({dataDir:join(root,'pending-lease'),reserveMutation:async resolve=>{await resolve();entered();await gate;held++;return {release(){held--;}};}});
  const pending=o.handle({action:'prepare',cwd:source,ref:commit});await started;const stopped=o.stop();allow();await assert.rejects(pending,/cancelled/);await stopped;assert.equal(held,0);assert.equal(o.plans.size,0);await o.close();
});
async function lifecycleFixture(name,options={}){
  const source=join(root,name+'-source'),dataDir=join(root,name+'-data');await mkdir(source);await raw(['init','-b','main',source]);await writeFile(join(source,'file'),'base\n');await writeFile(join(source,'.gitignore'),'ignored/\n');await raw(['-C',source,'add','.']);await raw(['-C',source,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','base']);
  const o=new ManagedWorktrees({dataDir,...options}),p=(await o.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,r=(await o.handle({action:'create',planId:p.id})).worktree;assert.equal(r.state,'ready',r.message);return {o,r,source,dataDir};
}
await check('interrupted handoff fences ordinary and managed roots, peers and aliases after restart',async()=>{
  const {o,r,source,dataDir}=await lifecycleFixture('handoff-fence'),peer=join(root,'handoff-peer'),unrelated=join(root,'handoff-unrelated');
  await raw(['-C',source,'worktree','add','--detach',peer,'HEAD']);await mkdir(unrelated);await mkdir(join(source,'nested'));
  const paths=[];for(const path of [source,r.cwd,peer]){const s=await lstat(path,{bigint:true});paths.push({path,identity:{dev:String(s.dev),ino:String(s.ino)}});}
  const h={id:randomUUID(),worktreeId:r.id,rootThreadId:'handoff-root',source,destination:r.cwd,paths,phase:'preparing',state:'pending',message:'Recovery preparation interrupted.',createdAt:Date.now(),updatedAt:Date.now(),recovery:null};
  o.handoffs=[h];await o.save();await o.close();
  let calls=0;const next=new ManagedWorktrees({dataDir,spawnProcess:(...args)=>{calls++;return spawn(...args);}});
  await assert.rejects(next.assertProject(source),/handoff/i);
  const alias=join(root,'handoff-alias');await symlink(source,alias);
  for(const cwd of [r.cwd,peer,alias,join(source,'nested'),root,'/'])await assert.rejects(next.assertProject(cwd),/handoff/i);
  await next.assertProject(unrelated);assert.equal(calls,0,'fencing and unrelated ordinary projects do not run Git');
  await assert.rejects(next.handle({action:'prepareArchive',id:r.id}),/handoff/i);await assert.rejects(next.handle({action:'resolve',id:r.id}),/handoff/i);
  const listed=await next.handle({action:'list'});assert.equal(listed.handoffs[0].id,h.id);assert.equal(listed.handoffs[0].phase,'preparing');assert.equal(listed.handoffs[0].state,'needs-inspection');assert.equal(listed.worktrees[0].state,'needs-inspection');
  let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),operation=next.exclusive(async()=>{entered();await gate;});await started;
  try{await next.assertProject(unrelated);await assert.rejects(next.assertProject(source),{code:'HANDOFF_PENDING'});const busy=await next.handle({action:'list'});assert.equal(busy.busy,true);assert.equal(busy.handoffs[0].id,h.id);}finally{release();await operation;}
  const bytes=await readFile(next.ledger),valid=JSON.parse(bytes);for(const mutate of [d=>d.handoffs[0].paths.splice(1,1),d=>d.handoffs[0].destination=unrelated,d=>d.handoffs[0].paths[0].identity.ino='0',d=>d.handoffs[0].state='unknown',d=>{d.handoffs[0].state='complete';d.handoffs[0].recovery={directory:{dev:'1',ino:'1'},manifest:{identity:{dev:'1',ino:'2'},hash:'a'.repeat(64),bytes:1}};},d=>d.handoffs[0].rootThreadId='../invalid/id',d=>d.version=1]){
    const d=structuredClone(valid);mutate(d);assert.throws(()=>next.validateLedger(d),/handoff|ledger/i);
  }
  const moved=source+'-moved';await rename(source,moved);await assert.rejects(next.assertProject(join(moved,'nested')),/handoff/i);await mkdir(source);await assert.rejects(next.assertProject(source),/handoff/i);
  await next.stop();await assert.rejects(next.assertProject(moved),/handoff/i);await next.close();
  assert.equal(JSON.parse(await readFile(join(dataDir,'managed-worktrees.json'),'utf8')).version,2,'v1 ledger consumers must reject handoff descriptors rather than discard them');
});
await check('ordinary admission serializes with own ledger saves and detects external replacement',async()=>{
  const dataDir=join(root,'handoff-ledger-queue'),o=new ManagedWorktrees({dataDir});await Promise.all(Array.from({length:8},()=>o.assertProject(source)));await o.save();
  let entered,release,armed=true;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),check=o.checkLedger.bind(o);
  o.checkLedger=async()=>{await check();if(armed){armed=false;entered();await gate;}};
  const saving=o.save();await started;let settled=false;const admission=o.assertProject(source).then(()=>{settled=true;});await new Promise(r=>setTimeout(r,20));assert.equal(settled,false);release();await Promise.all([saving,admission]);
  const ledger=await readFile(o.ledger);await rename(o.ledger,o.ledger+'.retained');await writeFile(o.ledger,ledger,{mode:0o600});await assert.rejects(o.assertProject(source),/identity|changed/i);await o.close();
});
await check('a FIFO ledger rejects without blocking ordinary project admission',async()=>{
  const dir=join(root,'fifo-ledger');await mkdir(dir,{mode:0o700});await exec('/usr/bin/mkfifo',['-m','600',join(dir,'managed-worktrees.json')]);
  await assert.rejects(exec(process.execPath,['--input-type=module','-e','const {ManagedWorktrees}=await import(process.argv[1]);await new ManagedWorktrees({dataDir:process.argv[2]}).assertProject(process.argv[3]);',new URL('./managed-worktrees.mjs',import.meta.url).href,dir,source],{timeout:1500,killSignal:'SIGKILL'}),e=>{assert.equal(e.code,1);assert.equal(e.killed,false);assert.match(e.stderr,/not regular/);return true;});
});
await check('archive actually unregisters and restore returns original inode with staged/unstaged and ignored bytes',async()=>{
  const {o,r,source,dataDir}=await lifecycleFixture('lifecycle');await writeFile(join(r.cwd,'file'),'committed locally\n');await raw(['-C',r.cwd,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-am','local']);const head=await raw(['-C',r.cwd,'rev-parse','HEAD']);await writeFile(join(r.cwd,'file'),'staged\n');await raw(['-C',r.cwd,'add','file']);await writeFile(join(r.cwd,'file'),'unstaged\n');await mkdir(join(r.cwd,'ignored','empty'),{recursive:true});await writeFile(join(r.cwd,'ignored','binary'),Buffer.from([0,255,1]));await symlink('/literal/outside',join(r.cwd,'link'));const inode=(await lstat(r.cwd)).ino,admin=join(source,'.git/worktrees',r.id),index=await readFile(join(admin,'index')),mainIndex=await readFile(join(source,'.git/index'));
  const p=(await o.handle({action:'prepareArchive',id:r.id})).plan;assert.equal(p.operation,'archive');assert.equal(p.worktreeId,r.id);assert.equal(p.commit,head);const archived=(await o.handle({action:'archive',planId:p.id})).worktree;assert.equal(archived.state,'archived',archived.message);await assert.rejects(lstat(r.cwd),{code:'ENOENT'});assert(!(await raw(['-C',source,'worktree','list','--porcelain'])).includes(r.cwd));await assert.rejects(o.handle({action:'archive',planId:p.id}),/plan/);await assert.rejects(o.handle({action:'resolve',id:r.id}),/archiv|restore/i);await o.close();
  await raw(['-C',source,'prune','--expire=now']);await assert.rejects(raw(['-C',source,'cat-file','-e',head]));const next=new ManagedWorktrees({dataDir}),restore=(await next.handle({action:'prepareRestore',id:r.id})).plan;assert.equal(restore.operation,'restore');const restored=(await next.handle({action:'restore',planId:restore.id})).worktree;assert.equal(restored.state,'ready',restored.message);assert.equal((await lstat(r.cwd)).ino,inode);assert.deepEqual(await readFile(join(admin,'index')),index);assert.equal(await raw(['-C',r.cwd,'show',':file']),'staged');assert.equal(await readFile(join(r.cwd,'file'),'utf8'),'unstaged\n');assert.deepEqual(await readFile(join(r.cwd,'ignored','binary')),Buffer.from([0,255,1]));assert.equal(await raw(['-C',r.cwd,'rev-parse','HEAD']),head);assert.deepEqual(await readFile(join(source,'.git/index')),mainIndex);await next.close();
});
await check('archive review refuses index forms without changing checkout or index',async()=>{
  const {o,r}=await lifecycleFixture('index-forms');await writeFile(join(r.cwd,'intent'),'intent');
  for(const [enable,disable] of [[['add','-N','intent'],['reset','--','intent']],[['update-index','--assume-unchanged','file'],['update-index','--no-assume-unchanged','file']],[['update-index','--skip-worktree','file'],['update-index','--no-skip-worktree','file']],[['update-index','--split-index'],['update-index','--no-split-index']]]){
    await raw(['-C',r.cwd,...enable]);const admin=(await raw(['-C',r.cwd,'rev-parse','--absolute-git-dir'])),before=await readFile(join(admin,'index'));await assert.rejects(o.handle({action:'prepareArchive',id:r.id}),/index|flags|split/i);assert.deepEqual(await readFile(join(admin,'index')),before);assert.equal(await readFile(join(r.cwd,'file'),'utf8'),'base\n');await raw(['-C',r.cwd,...disable]);
  }await o.close();
});
await check('same-size changed bytes invalidate archive review even with old timestamps and consume plan',async()=>{
  const {o,r}=await lifecycleFixture('stale-archive'),p=(await o.handle({action:'prepareArchive',id:r.id})).plan,st=await lstat(join(r.cwd,'file'));await writeFile(join(r.cwd,'file'),'evil\n');await utimes(join(r.cwd,'file'),st.atime,st.mtime);await assert.rejects(o.handle({action:'archive',planId:p.id}),/changed/i);await assert.rejects(o.handle({action:'archive',planId:p.id}),/plan/i);assert.equal(await readFile(join(r.cwd,'file'),'utf8'),'evil\n');await o.close();
});
await check('archive and restore plans are exact-operation, expiring and single-use',async()=>{
  let clock=Date.now();const {o,r}=await lifecycleFixture('plan-operation',{now:()=>clock});let p=(await o.handle({action:'prepareArchive',id:r.id})).plan;await assert.rejects(o.handle({action:'create',planId:p.id}),/operation/);await assert.rejects(o.handle({action:'archive',planId:p.id}),/plan/);p=(await o.handle({action:'prepareArchive',id:r.id})).plan;clock+=120001;await assert.rejects(o.handle({action:'archive',planId:p.id}),/expired/);assert.equal((await o.handle({action:'resolve',id:r.id})).worktree.state,'ready');await o.close();
});
await check('archived execution aliases, occupied restore paths and corrupt bundles are refused without deleting data',async()=>{
  const {o,r,dataDir}=await lifecycleFixture('protected-archive'),p=(await o.handle({action:'prepareArchive',id:r.id})).plan;assert.equal((await o.handle({action:'archive',planId:p.id})).worktree.state,'archived');const saved=o.records.find(x=>x.id===r.id),paths=o.recoveryPaths(saved),alias=join(root,'archive-alias');await symlink(paths.raw,alias);for(const path of [paths.raw,join(paths.raw,'file'),alias])await assert.rejects(o.assertProject(path),/unknown managed/i);
  let restore=(await o.handle({action:'prepareRestore',id:r.id})).plan;await mkdir(r.cwd);await writeFile(join(r.cwd,'occupied'),'keep');await assert.rejects(o.handle({action:'restore',planId:restore.id}),/occupied/);assert.equal(await readFile(join(r.cwd,'occupied'),'utf8'),'keep');await rename(r.cwd,r.cwd+'-occupied');
  restore=(await o.handle({action:'prepareRestore',id:r.id})).plan;const before=await readFile(paths.bundle);await writeFile(paths.bundle,Buffer.concat([before,Buffer.from('corrupt')]));await assert.rejects(o.handle({action:'restore',planId:restore.id}),/recovery|changed/i);assert.equal(await readFile(join(paths.raw,'file'),'utf8'),'base\n');await o.close();const next=new ManagedWorktrees({dataDir});assert.equal((await next.handle({action:'list'})).worktrees[0].state,'needs-inspection');await next.close();
});
await check('archive rejects nested repositories and preserves replaced project',async()=>{
  const {o,r}=await lifecycleFixture('invalid-files');await mkdir(join(r.cwd,'nested'));await writeFile(join(r.cwd,'nested','.git'),'gitdir: /outside');await assert.rejects(o.handle({action:'prepareArchive',id:r.id}),/nested Git/i);await unlink(join(r.cwd,'nested','.git'));const p=(await o.handle({action:'prepareArchive',id:r.id})).plan,parked=r.cwd+'-parked';await rename(r.cwd,parked);await symlink(parked,r.cwd);await assert.rejects(o.handle({action:'archive',planId:p.id}),/replaced|symbolic|identity/i);assert.equal(await readFile(join(parked,'file'),'utf8'),'base\n');await unlink(r.cwd);await rename(parked,r.cwd);await o.close();
});
await check('Stop at real unregister holds lease through exit and keeps archived raw recoverable',async()=>{
  let o,stop,held=0,arm=false,closed=false;const fixture=await lifecycleFixture('stop-unregister',{reserveMutation:async resolve=>{await resolve();held++;return {release(){held--;}};},spawnProcess:(file,args,options)=>{const child=spawn(file,args,options);if(arm&&args.includes('worktree')&&args.includes('remove')){child.once('exit',()=>{stop=o.stop();assert.equal(held,1);});child.once('close',()=>{closed=true;});}return child;}});o=fixture.o;const p=(await o.handle({action:'prepareArchive',id:fixture.r.id})).plan;arm=true;const result=await o.handle({action:'archive',planId:p.id});await stop;assert.equal(result.worktree.state,'needs-inspection');assert.equal(closed,true);assert.equal(held,0);const paths=o.recoveryPaths(o.records[0]);assert.equal(await readFile(join(paths.raw,'file'),'utf8'),'base\n');await o.close();const next=new ManagedWorktrees({dataDir:fixture.dataDir});assert.equal((await next.handle({action:'list'})).worktrees[0].state,'needs-inspection');await assert.rejects(next.handle({action:'prepareRestore',id:fixture.r.id}),/available/);await next.close();
});
await check('Stop after restore placeholder registration preserves raw and never publishes ready',async()=>{
  let o,arm=false,stopping;const fixture=await lifecycleFixture('stop-restore',{spawnProcess:(file,args,options)=>{const child=spawn(file,args,options);if(arm&&args.includes('worktree')&&args.includes('add'))child.once('exit',()=>{stopping=o.stop();});return child;}});o=fixture.o;const archive=(await o.handle({action:'prepareArchive',id:fixture.r.id})).plan;await o.handle({action:'archive',planId:archive.id});const restore=(await o.handle({action:'prepareRestore',id:fixture.r.id})).plan;arm=true;const result=await o.handle({action:'restore',planId:restore.id});await stopping;assert.equal(result.worktree.state,'needs-inspection');assert.equal(await readFile(join(o.recoveryPaths(o.records[0]).raw,'file'),'utf8'),'base\n');await o.close();
});
await check('crashed lifecycle states are displayed for inspection without mutation or replay',async()=>{
  const {o,r,dataDir}=await lifecycleFixture('crashed-lifecycle');o.records[0].state='archiving';o.records[0].archive={id:randomUUID(),head:await raw(['-C',r.cwd,'rev-parse','HEAD']),phase:'intent'};await o.save();await o.close();let calls=0;const next=new ManagedWorktrees({dataDir,spawnProcess:(...args)=>{calls++;return spawn(...args);}});const list=await next.handle({action:'list'});assert.equal(list.worktrees[0].state,'needs-inspection');assert.equal(calls,0);assert.equal(await readFile(join(r.cwd,'file'),'utf8'),'base\n');await next.close();
});
await check('raw rename preserves scratch inode, hardlinks, xattrs, resource fork and ACL',async()=>{
  const {o,r}=await lifecycleFixture('metadata'),scratch=join(r.cwd,'.saleh-coding-tmp-fixture');await mkdir(scratch,{mode:0o700});await writeFile(join(scratch,'.saleh-owner'),'owner');await link(join(r.cwd,'file'),join(r.cwd,'hardlink'));await exec('/usr/bin/xattr',['-w','com.saleh.archive.test','value',join(r.cwd,'file')]);await exec('/usr/bin/xattr',['-w','com.apple.ResourceFork','resource',join(r.cwd,'file')]);await exec('/bin/chmod',['+a','everyone allow read,readattr,readextattr,readsecurity',join(r.cwd,'file')]);const before=await lstat(join(r.cwd,'file')),scratchBefore=await lstat(scratch),attrs=(await exec('/usr/bin/xattr',['-lx',join(r.cwd,'file')])).stdout,acl=(await exec('/bin/ls',['-lde',join(r.cwd,'file')])).stdout.split('\n').slice(1).join('\n');const a=(await o.handle({action:'prepareArchive',id:r.id})).plan;assert.equal((await o.handle({action:'archive',planId:a.id})).worktree.state,'archived');const p=(await o.handle({action:'prepareRestore',id:r.id})).plan;assert.equal((await o.handle({action:'restore',planId:p.id})).worktree.state,'ready');assert.equal((await lstat(join(r.cwd,'file'))).ino,before.ino);assert.equal((await lstat(join(r.cwd,'hardlink'))).ino,before.ino);assert.equal((await lstat(scratch)).ino,scratchBefore.ino);assert.equal((await exec('/usr/bin/xattr',['-lx',join(r.cwd,'file')])).stdout,attrs);assert.equal((await exec('/bin/ls',['-lde',join(r.cwd,'file')])).stdout.split('\n').slice(1).join('\n'),acl);await o.close();
});
await check('binary archive verification can exceed default output cap while runner ceilings stay strict',async()=>{
  const {GitRunner}=await import('./git-runner.mjs'),runner=new GitRunner({dataDir:root});for(const maxOutputBytes of [0,-1,1.5,41943041,NaN,'123'])await assert.rejects(runner.run(['--version'],{maxOutputBytes}),/limit/);
  const {o,r}=await lifecycleFixture('larger-blob');await writeFile(join(r.cwd,'binary'),Buffer.alloc(3*1048576,255));const p=(await o.handle({action:'prepareArchive',id:r.id})).plan;assert.equal((await o.handle({action:'archive',planId:p.id})).worktree.state,'archived');await o.close();
});
await check('invalid UTF8 filename is refused by filesystem or fatal archive decoding',async()=>{
  const {o,r}=await lifecycleFixture('invalid-filename');try{await writeFile(Buffer.concat([Buffer.from(r.cwd+'/'),Buffer.from([255])]),'invalid');}catch(e){assert.equal(e.code,'EILSEQ');console.log('NOTE filesystem rejected invalid UTF8 filename before backend inspection');await o.close();return;}await writeFile(join(r.cwd,'�'),'valid');await assert.rejects(o.handle({action:'prepareArchive',id:r.id}),/UTF|encoded|encoding/i);assert.equal(await readFile(Buffer.concat([Buffer.from(r.cwd+'/'),Buffer.from([255])]),'utf8'),'invalid');await o.close();
});
await check('linked-source child stays manageable after source parent is archived and restored',async()=>{
  const {o,r}=await lifecycleFixture('linked-lifecycle'),childPlan=(await o.handle({action:'prepare',cwd:r.cwd,ref:'HEAD'})).plan,child=(await o.handle({action:'create',planId:childPlan.id})).worktree;assert.equal(child.state,'ready');const p=(await o.handle({action:'prepareArchive',id:r.id})).plan;await o.handle({action:'archive',planId:p.id});const restore=(await o.handle({action:'prepareRestore',id:r.id})).plan;assert.equal((await o.handle({action:'restore',planId:restore.id})).worktree.state,'ready');const childArchive=(await o.handle({action:'prepareArchive',id:child.id})).plan;assert.equal(childArchive.operation,'archive');assert.equal((await o.handle({action:'archive',planId:childArchive.id})).worktree.state,'archived');const parentAgain=(await o.handle({action:'prepareArchive',id:r.id})).plan;await o.handle({action:'archive',planId:parentAgain.id});const parentRestore=(await o.handle({action:'prepareRestore',id:r.id})).plan;assert.equal((await o.handle({action:'restore',planId:parentRestore.id})).worktree.state,'ready');const childRestore=(await o.handle({action:'prepareRestore',id:child.id})).plan;assert.equal((await o.handle({action:'restore',planId:childRestore.id})).worktree.state,'ready');await o.close();
});
await check('oversize working files and nested bare repositories refuse before capture',async()=>{
  const {o,r}=await lifecycleFixture('archive-limits'),large=join(r.cwd,'large'),f=await open(large,'wx');await f.truncate(32*1048576+1);await f.close();await assert.rejects(o.handle({action:'prepareArchive',id:r.id}),/size limit/);await unlink(large);await raw(['init','--bare',join(r.cwd,'nested-bare')]);await assert.rejects(o.handle({action:'prepareArchive',id:r.id}),/nested|bare/i);assert.equal(await readFile(join(r.cwd,'file'),'utf8'),'base\n');await o.close();
});
await check('archived listing reads metadata only; restore still detects same-size artifact corruption',async()=>{
  const {o,r}=await lifecycleFixture('fast-list'),p=(await o.handle({action:'prepareArchive',id:r.id})).plan;await o.handle({action:'archive',planId:p.id});const inventory=o.inventory;o.inventory=async()=>{throw new Error('Listing must not hash working contents.');};const verify=o.verifyRecovery.bind(o);let quick=false;o.verifyRecovery=(record,epoch,raw,metadataOnly)=>{quick=metadataOnly===true;return verify(record,epoch,raw,metadataOnly);};assert.equal((await o.handle({action:'list'})).worktrees[0].state,'archived');assert.equal(quick,true);o.inventory=inventory;const path=o.recoveryPaths(o.records[0]).bundle,bytes=await readFile(path);bytes[bytes.length-1]^=1;await writeFile(path,bytes);assert.equal((await o.handle({action:'list'})).worktrees[0].state,'archived');await assert.rejects(o.handle({action:'prepareRestore',id:r.id}),/recovery.*changed/i);await o.close();
});
console.log(JSON.stringify({passed:true,checks:tests.length,root}));
