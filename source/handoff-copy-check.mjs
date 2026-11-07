import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,lstat,readdir,readlink,chmod,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {GitRunner} from './git-runner.mjs';

const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-recovery-copy-'))),source=join(root,'source'),dataDir=join(root,'data'),nativeHelper=process.env.HANDOFF_FILES_HELPER;
assert(nativeHelper,'HANDOFF_FILES_HELPER must name the private verified fixture binary');
const runner=new GitRunner({dataDir:root}),env={GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'};
const git=(cwd,args,options={})=>runner.run(['-C',cwd,...args],{scope:{dirs:[root]},env,...options});
await mkdir(source,{mode:0o700});await git(source,['init','-b','main']);
await writeFile(join(source,'group-exec'),'owner-not-executable\n');await chmod(join(source,'group-exec'),0o650);
await writeFile(join(source,'binary'),Buffer.from([0,255,1]));await writeFile(join(source,'deleted'),'base\n');await writeFile(join(source,'exec'),'#!/bin/sh\nexit 0\n');await chmod(join(source,'exec'),0o755);
await git(source,['add','.']);await git(source,['-c','commit.gpgSign=false','commit','-m','base']);
const head=(await git(source,['rev-parse','HEAD'])).stdout.trim();
const family={rootThreadId:'copy-fixture-root',cwd:source,model:'local-fixture',modelProvider:'saleh_local',fingerprint:createHash('sha256').update('copy-fixture').digest('hex'),members:[{id:'copy-fixture-root',parentThreadId:null,cwd:source,model:'local-fixture',modelProvider:'saleh_local',archived:false,lastTurnId:'saved-turn'}]};
const coding={prepareHandoff:async()=>structuredClone(family),projectMutationInventory:async()=>[source],handoffTemporary:async()=>null};
const ownerHome=join(root,'owner-home');await mkdir(ownerHome,{mode:0o700});const ownerStat=await lstat(ownerHome,{bigint:true}),binding={ownerId:randomUUID(),home:{dev:String(ownerStat.dev),ino:String(ownerStat.ino)},rootThreadId:family.rootThreadId,generation:randomUUID(),executionMode:'native',model:family.model,provider:'local'};coding.handoffOwner=()=>structuredClone(binding);
const writer=new ManagedWorktrees({dataDir,nativeHelper,coding});
const planned=(await writer.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan;
const worktree=(await writer.handle({action:'create',planId:planned.id})).worktree;await chmod(join(worktree.cwd,'group-exec'),0o650);
await writeFile(join(source,'binary'),Buffer.from([0,254,2]));await git(source,['add','binary']);await writeFile(join(source,'binary'),Buffer.from([0,253,3]));
await git(source,['rm','deleted']);await writeFile(join(source,'deleted'),'recreated untracked\n');
await mkdir(join(source,'empty'));await writeFile(join(source,'hard-a'),'linked\n');await link(join(source,'hard-a'),join(source,'hard-b'));await symlink('binary',join(source,'symbolic'));
await writeFile(join(source,'native-only'),'metadata witness\n');
await exec('/usr/bin/xattr',['-wx','com.saleh.copy132','00ff01',join(source,'native-only')]);await exec('/usr/bin/xattr',['-wx','com.apple.ResourceFork','00ff02',join(source,'native-only')]);await exec('/bin/chmod',['+a','everyone allow read,readattr,readextattr,readsecurity',join(source,'native-only')]);
const metadata=async path=>({attrs:(await exec('/usr/bin/xattr',['-lx',path])).stdout,acl:(await exec('/bin/ls',['-lde',path])).stdout.split('\n').slice(1).join('\n')});const originalMetadata=await metadata(join(source,'native-only'));
const indexTree=(await git(source,['write-tree'])).stdout.trim();
const prepared=(await writer.handle({action:'prepareHandoff',id:worktree.id,threadId:family.rootThreadId})).plan;
await writer.exclusive(epoch=>writer.beginHandoff(prepared.id,epoch));await writer.close();

if(process.argv.includes('--reboot-copy')){
 const {rebootFixture}=await import('../checks/reboot-adoption-fixture.mjs');
 try{await rebootFixture({dataDir,directory:join(dataDir,'Worktrees/.handoffs',prepared.id),source:dirname(fileURLToPath(import.meta.url)),nativeHelper,check:async(name,fn)=>{await fn();console.log('PASS '+name);},onReadOnlyReady:async manager=>{
  const plan=(await manager.handle({action:'prepareRecoveryCopy',id:prepared.id})).plan,copy=(await manager.handle({action:'createRecoveryCopy',planId:plan.id})).copy;
  assert.equal(manager.loaded,false);assert.equal(copy.originalRecoveryComplete,false);assert.deepEqual(await readFile(join(copy.target,'binary')),Buffer.from([0,253,3]));assert.equal((await git(copy.target,['write-tree'])).stdout.trim(),indexTree);assert.deepEqual(await metadata(join(copy.target,'native-only')),originalMetadata);console.log('PASS signed current-volume read admission creates independent original copy without adopting mutable ledger');
 }});}finally{await runner.cancel();}process.exit(0);
}

const hash=b=>createHash('sha256').update(b).digest('hex');
async function tree(path){const rows=[];async function visit(p,name){const s=await lstat(p,{bigint:true}),bytes=s.isFile()?await readFile(p):s.isSymbolicLink()?await readlink(p,{encoding:'buffer'}):null;rows.push([name,String(s.dev),String(s.ino),String(s.mode),String(s.mtimeNs),String(s.ctimeNs),bytes&&hash(bytes)]);if(s.isDirectory())for(const n of(await readdir(p)).sort())await visit(join(p,n),name+'/'+n);}await visit(path,'');return hash(JSON.stringify(rows));}
const manager=new ManagedWorktrees({dataDir,nativeHelper,coding,managedMutationBlocked:true});
const original=await Promise.all([source,worktree.cwd,join(dataDir,'Worktrees'),join(dataDir,'managed-worktrees.json')].map(tree));
try{
 const result=await manager.handle({action:'prepareRecoveryCopy',id:prepared.id});
 assert.equal(result.plan.operation,'handoff-original-copy');assert.equal(result.plan.head,head);assert.equal(result.plan.indexTree,indexTree);
 const copied=await manager.handle({action:'createRecoveryCopy',planId:result.plan.id});
 assert.equal(copied.copy.independent,true);assert.equal(copied.copy.originalRecoveryComplete,false);
 assert.deepEqual(await readFile(join(copied.copy.target,'binary')),Buffer.from([0,253,3]));
 assert.deepEqual((await git(copied.copy.target,['show',':binary'],{raw:true})).stdout,Buffer.from([0,254,2]));
 assert.equal((await git(copied.copy.target,['rev-parse','HEAD'])).stdout.trim(),head);
 assert.equal((await git(copied.copy.target,['write-tree'])).stdout.trim(),indexTree);
 assert.equal((await lstat(join(copied.copy.target,'group-exec'))).mode&0o777,0o650);assert.equal((await git(copied.copy.target,['ls-files','--stage','group-exec'])).stdout.split(' ')[0],'100644');assert.deepEqual(await metadata(join(copied.copy.target,'native-only')),originalMetadata);
 assert.equal(await readlink(join(copied.copy.target,'symbolic')),'binary');
 const a=await lstat(join(copied.copy.target,'hard-a')),b=await lstat(join(copied.copy.target,'hard-b')),old=await lstat(join(source,'hard-a'));assert.equal(a.ino,b.ino);assert.notEqual(a.ino,old.ino);
 assert((await lstat(join(copied.copy.target,'empty'))).isDirectory());assert.equal((await lstat(join(copied.copy.target,'exec'))).mode&0o777,0o755);
 assert((await git(copied.copy.target,['ls-files','--others','--exclude-standard','-z'])).stdout.split('\0').includes('deleted'));
 assert.deepEqual(await Promise.all([source,worktree.cwd,join(dataDir,'Worktrees'),join(dataDir,'managed-worktrees.json')].map(tree)),original);
 await assert.rejects(manager.handle({action:'createRecoveryCopy',planId:result.plan.id}),/expired|consumed|unknown/i);
 for(const action of ['prepareHandoffRecovery','prepareReconnect','prepare'])await assert.rejects(manager.handle(action==='prepareHandoffRecovery'?{action,id:prepared.id,mode:'restore'}:action==='prepare'?{action,cwd:source,ref:'HEAD'}:{action}),action==='prepare'?error=>error.code==='HANDOFF_PENDING':/Full Access/);
 const failures=[];
 for(const kind of ['bytes','mode','xattr','head','index','ref','alternates','namespace','receipt-collision','bundle','object','root-acl']){
  const plan=(await manager.handle({action:'prepareRecoveryCopy',id:prepared.id})).plan,p=manager.plans.get(plan.id).copy,oldCheck=p.recheck;let injected=false;
  p.recheck=async()=>{await oldCheck();if(!(await lstat(join(plan.target,'.git')).catch(()=>null)))return;injected=true;
   if(kind==='root-acl')await exec('/bin/chmod',['+a','everyone allow read,readattr,readextattr,readsecurity',plan.target]);
   if(kind==='bytes')await writeFile(join(plan.target,'binary'),'late bytes');
   if(kind==='mode')await chmod(join(plan.target,'exec'),0o644);
   if(kind==='xattr')await exec('/usr/bin/xattr',['-w','com.saleh.late','late',join(plan.target,'exec')]);
   if(kind==='head')await git(plan.target,['update-ref','--no-deref','HEAD',p.recipe.witnesses.working.oid]);
   if(kind==='index')await git(plan.target,['read-tree',p.recipe.trees.head]);
   if(kind==='ref')await git(plan.target,['update-ref','refs/heads/unreviewed',head]);
   if(kind==='alternates')await writeFile(join(plan.target,'.git/objects/info/alternates'),join(source,'.git/objects')+'\n');
   if(kind==='namespace')await writeFile(join(plan.target,'late-extra'),'extra');
   if(kind==='object'){const oid=p.recipe.bundleRefs.find(([ref])=>ref.endsWith('/destinationWorking'))[1],folder=join(plan.target,'.git/objects',oid.slice(0,2));await mkdir(folder,{recursive:true});await writeFile(join(folder,oid.slice(2)),'corrupt object');}
   if(kind==='receipt-collision')await writeFile(join(p.entry,'receipt.json'),'KEEP_COLLISION',{flag:'wx'});
  };
  if(kind==='bundle'){await writeFile(join(p.entry,'recovery.bundle'),'tampered');injected=true;}
  await assert.rejects(manager.handle({action:'createRecoveryCopy',planId:plan.id}));assert(injected,kind+' fault did not reach final admission seam');
  const receipt=await readFile(join(p.entry,'receipt.json'),'utf8').catch(e=>{assert.equal(e.code,'ENOENT');return null;});assert.equal(receipt,kind==='receipt-collision'?'KEEP_COLLISION':null);failures.push(kind);
 }
 const stopPlan=(await manager.handle({action:'prepareRecoveryCopy',id:prepared.id})).plan,stopCopy=manager.plans.get(stopPlan.id).copy,native=stopCopy.native;let entered,release;
 const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 stopCopy.native=async(action,input)=>{if(action==='copy'){entered();await gate;}return native(action,input);};
 const pending=manager.handle({action:'createRecoveryCopy',planId:stopPlan.id});pending.catch(()=>{});await ready;const stopping=manager.handle({action:'stop'});release();await assert.rejects(pending);await stopping;assert.equal(await readFile(join(stopCopy.entry,'receipt.json')).then(()=>true,e=>{assert.equal(e.code,'ENOENT');return false;}),false);failures.push('stop-drains-copy');
 assert.deepEqual(await Promise.all([source,worktree.cwd,join(dataDir,'Worktrees'),join(dataDir,'managed-worktrees.json')].map(tree)),original);
 await writeFile(join(root,'evidence.json'),JSON.stringify({root,target:copied.copy.target,actualNativeAndGitCopy:true,scriptedCodingFamily:true,originalsUnchanged:true,fullAccessFenceRetained:true,failures,metadataPreserved:true,head,indexTree},null,2)+'\n');
 console.log(JSON.stringify({root,target:copied.copy.target,passed:true}));
}finally{await manager.close();await runner.cancel();}
