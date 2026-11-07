import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,unlink,rmdir,link,chmod,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {CodingOwners} from './coding-owners.mjs';
import {CodingEngine} from './coding-engine.mjs';
import {GitWorkflow} from './git-workflow.mjs';
import {createServer} from './server.mjs';
import {nativeSignature} from './agent.mjs';

// Real filesystem, Git, owner lease and signed route. No model or original data.
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-recovery-lifecycle-'))),source=join(root,'source'),coldSource=join(root,'Cold-é'),dataDir=join(root,'Coding'),runtime=join(root,'runtime'),exec=promisify(execFile);
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const git=async(cwd,...args)=>(await exec('/usr/bin/git',['-C',cwd,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env,encoding:'buffer'})).stdout;
const identity=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode&0o777n)};};
let clock=Date.now(),owner,leases=0,allocations=0,engines=0;
const manager=new ManagedWorktrees({dataDir,nativeHelper:process.env.HANDOFF_FILES_HELPER,now:()=>clock,reserveMutation:async(resolve,policy)=>{const lease=await owner.reserveProjectMutation(resolve,policy);leases++;return {...lease,release:async()=>{try{return await lease.release();}finally{leases--;}}};}});
// The real cold owner lease needs an actual persisted allocation receipt; no VM starts.
// Use device identities here and exercise native durable identities in the unchanged helper groups.
const resources={cpu:1,memoryBytes:1048576,diskBytes:1048576};
const settings={dataDir,executorPolicy:{runtimeDir:runtime,resources,limits:{cpu:2,memoryBytes:2097152,diskBytes:2097152,concurrent:2}},engineFactory:()=>{engines++;throw Error('Recovery must not start an engine');},engineOptions:{fullAccess:false,localModels:{resolve:async id=>({id,generation:{max_tokens:32}})},assertProject:path=>manager.assertProject(path)},openExecutor:async context=>{
  allocations++;const path=join(runtime,context.ownerId+'-'+context.generation);await mkdir(path,{mode:0o700});const s=await lstat(context.cwd,{bigint:true});
  await writeFile(join(path,'allocation.json'),JSON.stringify({version:1,ownerId:context.ownerId,generation:context.generation,cwd:context.cwd,hostIdentity:{dev:String(s.dev),ino:String(s.ino),mode:Number(s.mode),uid:Number(s.uid)},root:null,resources:context.resources,account:null,bundle:null,restartAllowed:false}),{mode:0o600});
  const st=await lstat(path,{bigint:true});await context.recordAllocation({path,identity:{dev:String(st.dev),ino:String(st.ino)}});
  const ready=Promise.reject(Error('SYNTHETIC_CLOSED_START_FAILURE'));ready.catch(()=>{});
  return {ready,retire:async()=>({ownerId:context.ownerId,generation:context.generation,closed:true,revoked:false})};
}};
owner=new CodingOwners(settings);
await mkdir(source);await git(source,'init','-b','main');await writeFile(join(source,'file'),'BASE\n');await writeFile(join(source,'keep'),'KEEP\n');await git(source,'add','.');await git(source,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base');
const sourceIndex=await readFile(join(source,'.git/index')),sourceHead=await readFile(join(source,'.git/HEAD'));
const create=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan;
const record=(await manager.handle({action:'create',planId:create.id})).worktree;assert.equal(record.state,'ready',record.message);assert.equal(leases,0);
await mkdir(runtime,{mode:0o700});await mkdir(coldSource,{mode:0o700});await git(coldSource,'init','-b','main');await writeFile(join(coldSource,'file'),'COLD OWNER\n');await git(coldSource,'add','file');await git(coldSource,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','cold');
await assert.rejects(owner.handle({action:'start',cwd:coldSource}),/SYNTHETIC_CLOSED_START_FAILURE/);assert.equal((await owner.close()).stopped,true);
owner=new CodingOwners(settings);await owner.handle({action:'status'});
const coldCatalog=await readFile(join(dataDir,'coding-owners.json')),cold=JSON.parse(coldCatalog),allocationPath=join(runtime,cold.owners[0].id+'-'+cold.owners[0].generation.id,'allocation.json'),allocationBytes=await readFile(allocationPath);
assert.equal(cold.owners[0].state,'creating');assert.equal(cold.owners[0].rootThreadId,null);assert.equal(cold.owners[0].generation.nativeOpen,false);assert.equal(cold.owners[0].generation.executorClosed,true);assert.equal(cold.executor.allocations[0].closed,true);
await writeFile(join(record.cwd,'file'),'STAGED\n');await git(record.cwd,'add','file');await writeFile(join(record.cwd,'file'),'WORKING\n');await writeFile(join(record.cwd,'untracked'),'KEEP UNTRACKED\n');await chmod(join(record.cwd,'untracked'),0o755);await link(join(record.cwd,'untracked'),join(record.cwd,'hardlink'));
await writeFile(join(record.cwd,'.gitignore'),'ignored\n');await writeFile(join(record.cwd,'ignored'),'KEEP IGNORED\n');
const admin=(await git(record.cwd,'rev-parse','--absolute-git-dir')).toString().trim(),savedIdentity=await identity(record.cwd),savedFile=await identity(join(record.cwd,'file')),savedUntracked=await identity(join(record.cwd,'untracked')),savedIgnored=await identity(join(record.cwd,'ignored')),index=await readFile(join(admin,'index')),head=await git(record.cwd,'rev-parse','HEAD');
const token=randomUUID(),server=createServer({instanceToken:token,fullAccess:true,unconfinedBoot:false,recoveryStartup:true,coding:owner,worktrees:manager,hub:{stop:async()=>{},close:async()=>{}}});
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,route='/api/tools/worktrees';
const post=async(input,{signed=true,status=200,instance=base}={})=>{const body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now()),response=await fetch(instance+route,{method:'POST',headers:{'Content-Type':'application/json',...(signed?{'X-Qwen-Nonce':nonce,'X-Qwen-Time':time,'X-Qwen-Permit':nativeSignature(token,route,nonce,time,body)}:{})},body});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
const prepare=async operation=>(await post({action:operation==='archive'?'prepareArchive':'prepareRestore',id:record.id})).plan;
const unchangedSource=async()=>{assert.deepEqual(await readFile(join(source,'.git/index')),sourceIndex);assert.deepEqual(await readFile(join(source,'.git/HEAD')),sourceHead);assert.equal(await readFile(join(source,'file'),'utf8'),'BASE\n');assert.equal(await readFile(join(source,'keep'),'utf8'),'KEEP\n');};
async function boundaryChecks(){
  const paths=[manager.root,source,record.cwd],policy={kind:'archiveWorktree',target:()=>source},reserve=(paths=[])=>owner.reserveProjectMutation(async()=>paths,policy);
  await assert.rejects(reserve(paths.slice(1)),/pending/);
  await assert.rejects(owner.reserveProjectMutation(async()=>paths,{kind:'archiveWorktree',target:()=>manager.root}),/target differs/);
  const plain=join(root,'plain');await mkdir(plain,{mode:0o700});await assert.rejects(reserve([...paths,plain]),/pending/);
  for(const alias of [coldSource,join(root,'COLD-É'),join(root,'cold-e\u0301')])await assert.rejects(reserve([...paths,alias]));
  const sharedCold=join(root,'cold-linked');await git(coldSource,'worktree','add','--detach',sharedCold,'HEAD');await assert.rejects(reserve([...paths,sharedCold]),/pending/);
  await chmod(manager.root,0o755);try{await assert.rejects(reserve(paths),/directory|permissions/);}finally{await chmod(manager.root,0o700);}
  await mkdir(join(manager.root,'.git'));try{await assert.rejects(reserve(paths),/pending/);}finally{await rmdir(join(manager.root,'.git'));}
  await writeFile(join(manager.root,'.git'),'gitdir: '+join(source,'.git')+'\n');try{await assert.rejects(reserve(paths),/pending/);}finally{await unlink(join(manager.root,'.git'));}
  await writeFile(join(dataDir,'.git'),'gitdir: '+join(source,'.git')+'\n');try{await assert.rejects(reserve(paths),/pending/);}finally{await unlink(join(dataDir,'.git'));}
  const moved=manager.root+'-held';await rename(manager.root,moved);await symlink(moved,manager.root);
  try{await assert.rejects(reserve(paths),/directory|identity|canonical/);}finally{await unlink(manager.root);await rename(moved,manager.root);}
  const held=await reserve(paths);
  try{
    await writeFile(join(manager.root,'.git'),'gitdir: '+join(source,'.git')+'\n');try{await assert.rejects(held.revalidateScope(),/metadata appeared/);}finally{await unlink(join(manager.root,'.git'));}
    await rename(manager.root,moved);await mkdir(manager.root,{mode:0o700});try{await assert.rejects(held.revalidateScope(),/identity|directory/);}finally{await rmdir(manager.root);await rename(moved,manager.root);}
  }finally{await held.release();}
  const gated=new CodingOwners({...settings,dataDir:join(root,'blocked'),managedMutationBlocked:true});
  try{for(const kind of ['archiveWorktree','restoreWorktree'])await assert.rejects(gated.reserveProjectMutation(async()=>paths,{kind,target:()=>source}),/Full Access boot/);}finally{await gated.close();}
}
// The existing owner-fixture pattern supplies only a tracked idle engine and
// executor contract. Real CodingOwners/CodingProjects and Git metadata still run.
class IdleEngine extends CodingEngine{
  async ensure(){if(this.closed)throw Error('closed');if(!this.processLife){this.child={killed:false};this.processLife={child:this.child,exited:false};}}
  fail(error){if(this.processLife)this.processLife.exited=true;this.processLife=null;this.child=null;super.fail(error);}
  async close(){if(!this.closed){this.closed=true;this.fail(Error('fixture close'));}return super.close();}
  async projectHasBackground(){return false;}
  async handle(input){assert.equal(input.action,'start');await this.ensure();const thread={id:randomUUID(),cwd:input.cwd,model:input.model,modelProvider:'saleh_local',parentThreadId:null,turns:[]};this.rememberThread(thread);this.verifiedThreads.add(thread.id);return {thread};}
}
async function liveWorkspaceChecks(){
  for(const shared of [false,true]){
    const home=join(root,'live-'+shared),project=join(root,'live-project-'+shared),storage=join(home,'Worktrees');await mkdir(home,{mode:0o700});await mkdir(storage,{mode:0o700});
    if(shared)await git(source,'worktree','add','--detach',project,'HEAD');else{await mkdir(project);await git(project,'init','-b','main');await writeFile(join(project,'file'),'LIVE\n');await git(project,'add','file');await git(project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','live');}
    const workflow=new GitWorkflow({dataDir:home}),repository=await workflow.repository(project,workflow.epoch);let engine;
    const live=new CodingOwners({dataDir:home,engineOptions:{localModels:settings.engineOptions.localModels},engineFactory:options=>engine=new IdleEngine(options),openExecutor:async context=>({hasWorkspace:true,workspaceRepository:repository,binding:{url:'ws://127.0.0.1:19999',authToken:'inert-fixture',launch:{argv:['/fixture/codex'],cwd:'file:///private/var/empty',env:{HOME:context.dataDir}}},retire:async()=>({ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true})})});
    try{
      await live.handle({action:'start',cwd:project,model:'fixture-local'});
      const reserve=()=>live.reserveProjectMutation(async()=>[storage,source,record.cwd],{kind:'archiveWorktree',target:()=>source});
      if(shared)await assert.rejects(reserve(),/active isolated workspace/);
      else{
        const lease=await reserve();try{assert.equal(engine.mutationBlocks(storage),true);assert.equal(engine.mutationBlocks(join(storage,'new-child')),true);assert.equal(engine.mutationBlocks(project),false);await writeFile(join(storage,'.git'),'gitdir: '+repository.commonDir+'\n');try{await assert.rejects(lease.revalidateScope(),/metadata appeared/);}finally{await unlink(join(storage,'.git'));}}finally{await lease.release();}
        // With no cold rows, a pointer from the control root to the live common
        // repository must still refuse rather than hide an active workspace.
        for(const path of [join(storage,'.git'),join(home,'.git')]){await writeFile(path,'gitdir: '+repository.commonDir+'\n');try{await assert.rejects(reserve(),/pending/);}finally{await unlink(path);}}
      }
    }finally{assert.equal((await live.close()).stopped,true);}
  }
}
try{
  await post({action:'prepareArchive',id:record.id},{signed:false,status:403});
  await post({action:'prepareArchive',id:record.id,extra:true},{status:400});
  await post({action:'unknown',id:record.id},{status:409});
  assert.equal(manager.plans.size,0);assert.equal(leases,0);
  const stale=await prepare('archive');await writeFile(join(record.cwd,'file'),'NEWER WORKING\n');await post({action:'archive',planId:stale.id},{status:400});assert.equal(await readFile(join(record.cwd,'file'),'utf8'),'NEWER WORKING\n');await writeFile(join(record.cwd,'file'),'WORKING\n');assert.equal(leases,0);
  const expired=await prepare('archive');clock+=120001;await post({action:'archive',planId:expired.id},{status:400});assert.equal(leases,0);
  const stopped=await prepare('archive');await post({action:'stop'});await post({action:'archive',planId:stopped.id},{status:400});assert.equal(leases,0);
  const held=await owner.reserveProjectMutation(async()=>[record.cwd]);
  try{await post({action:'prepareArchive',id:record.id},{status:400});assert.equal(manager.plans.size,0);}finally{await held.release();}
  const reviewed=await prepare('archive');assert.equal(reviewed.operation,'archive');assert.equal(reviewed.worktreeId,record.id);assert.equal(leases,1);
  const archived=await post({action:'archive',planId:reviewed.id});assert.equal(archived.worktree.state,'archived',archived.worktree.message);assert.equal(leases,0);
  await assert.rejects(lstat(record.cwd),{code:'ENOENT'});await assert.rejects(lstat(admin),{code:'ENOENT'});await unchangedSource();
  await post({action:'archive',planId:reviewed.id},{status:400});
  const stored=manager.records.find(r=>r.id===record.id),paths=manager.recoveryPaths(stored);
  assert.deepEqual(await identity(paths.raw),savedIdentity);assert.deepEqual(await identity(join(paths.raw,'untracked')),savedUntracked);assert.equal((await identity(join(paths.raw,'hardlink'))).ino,savedUntracked.ino);assert.deepEqual(await readFile(paths.index),index);assert((await lstat(paths.bundle)).size>0);
  await mkdir(record.cwd);await writeFile(join(record.cwd,'occupied'),'DO NOT OVERWRITE');await post({action:'prepareRestore',id:record.id},{status:400});assert.equal(await readFile(join(record.cwd,'occupied'),'utf8'),'DO NOT OVERWRITE');await unlink(join(record.cwd,'occupied'));await rmdir(record.cwd);
  const restore=await prepare('restore');assert.equal(restore.operation,'restore');const restored=await post({action:'restore',planId:restore.id});assert.equal(restored.worktree.state,'ready',restored.worktree.message);assert.equal(leases,0);
  assert.deepEqual(await identity(record.cwd),savedIdentity);assert.deepEqual(await identity(join(record.cwd,'file')),savedFile);assert.deepEqual(await identity(join(record.cwd,'untracked')),savedUntracked);assert.equal((await identity(join(record.cwd,'hardlink'))).ino,savedUntracked.ino);
  assert.equal(await readFile(join(record.cwd,'file'),'utf8'),'WORKING\n');assert.equal(await readFile(join(record.cwd,'untracked'),'utf8'),'KEEP UNTRACKED\n');assert.deepEqual(await readFile(join(admin,'index')),index);assert.deepEqual(await git(record.cwd,'rev-parse','HEAD'),head);await unchangedSource();await post({action:'restore',planId:restore.id},{status:400});
  assert.equal(await readFile(join(record.cwd,'ignored'),'utf8'),'KEEP IGNORED\n');assert.deepEqual(await identity(join(record.cwd,'ignored')),savedIgnored);await boundaryChecks();await liveWorkspaceChecks();
  const listed=await post({action:'list'});assert.equal(listed.readOnly,false);for(const key of ['createAvailable','openAvailable','handoffAvailable'])assert.equal(listed[key],false);assert.equal(listed.worktrees.find(r=>r.id===record.id).state,'ready');
  // Same operations must remain refused on an unrestricted Full Access boot.
  const normal=createServer({instanceToken:token,fullAccess:true,unconfinedBoot:true,coding:owner,worktrees:manager,hub:{stop:async()=>{},close:async()=>{}}});normal.listen(0,'127.0.0.1');await once(normal,'listening');
  try{const instance=`http://127.0.0.1:${normal.address().port}`;for(const action of ['prepareArchive','archive','prepareRestore','restore'])await post(action.startsWith('prepare')?{action,id:record.id}:{action,planId:randomUUID()},{instance,status:409});}
  finally{normal.closeAllConnections();await new Promise(resolve=>normal.close(resolve));}
  assert.equal(manager.plans.size,0);assert.equal(leases,0);await unchangedSource();
  assert.deepEqual(await readFile(join(dataDir,'coding-owners.json')),coldCatalog);assert.deepEqual(await readFile(allocationPath),allocationBytes);assert.equal(allocations,1);assert.equal(engines,0);
  console.log(JSON.stringify({passed:true,root,signedArchiveRestore:true,realOwnerLease:true,coldOwnerAndAllocationExact:true,coldOwnerNotReallocatedOrExecuted:true,controlRootRemainsInRealLease:true,invalidReplacedLinkedNonPrivateGitAndAliasScopesRefused:true,unrelatedLiveWorkspaceAllowedAndSharedRepositoryRefused:true,rootGitPointerAndAncestryWithNoColdRowsRefused:true,sourceUnchanged:true,originalDirectoryAndFileIdentitiesRestored:true,indexHeadWorkingIgnoredAndUntrackedExact:true,hardlinksAndModeExact:true,staleExpiredConsumedStopAndOccupiedRefused:true,unrestrictedBootStillDenied:true,modelOrOriginalDataAccessed:false}));
}finally{await server.shutdownTools();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
