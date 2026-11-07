import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,writeFile,readFile,lstat,readdir,readlink,chmod,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
import {readFilesystemIdentity} from './filesystem-identity.mjs';
import {isDeepStrictEqual as equal} from 'node:util';
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
const ownerHome=join(root,'owner-home');await mkdir(ownerHome,{mode:0o700});const ownerStat=await lstat(ownerHome,{bigint:true}),binding={ownerId:randomUUID(),home:await readFilesystemIdentity({path:ownerHome,nativeHelper}),rootThreadId:family.rootThreadId,generation:randomUUID(),executionMode:'native',model:family.model,provider:'local'};coding.handoffOwner=()=>structuredClone(binding);
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
// Same retained-tree witness as handoff-copy-check: bytes, identities, modes and times.
const hash=b=>createHash('sha256').update(b).digest('hex');
async function tree(path,ignoreTimesAt=null){const rows=[];async function visit(p,name){const s=await lstat(p,{bigint:true}),bytes=s.isFile()?await readFile(p):s.isSymbolicLink()?await readlink(p,{encoding:'buffer'}):null;rows.push([name,String(s.dev),String(s.ino),String(s.mode),p===ignoreTimesAt?null:String(s.mtimeNs),p===ignoreTimesAt?null:String(s.ctimeNs),bytes&&hash(bytes)]);if(s.isDirectory())for(const n of(await readdir(p)).sort())await visit(join(p,n),name+'/'+n);}await visit(path,'');return hash(JSON.stringify(rows));}
let ordinaryPeer=null;
if(['--attached-peer','--unlocked-peer','--changed-peer-branch'].some(flag=>process.argv.includes(flag))){
 const peerSource=join(root,'completed-source');await mkdir(peerSource,{mode:0o700});await git(peerSource,['init','-b','main']);await writeFile(join(peerSource,'kept.txt'),'completed handoff peer\n');await git(peerSource,['add','.']);await git(peerSource,['-c','commit.gpgSign=false','commit','-m','peer']);
 const peerPlan=(await writer.handle({action:'prepare',cwd:peerSource,ref:'HEAD'})).plan;ordinaryPeer=(await writer.handle({action:'create',planId:peerPlan.id})).worktree;
 await git(peerSource,['switch','--detach']);await git(ordinaryPeer.cwd,['switch','main']);
 assert.equal((await git(ordinaryPeer.cwd,['symbolic-ref','HEAD'])).stdout.trim(),'refs/heads/main');
 if(process.argv.includes('--unlocked-peer'))await git(peerSource,['worktree','unlock',ordinaryPeer.cwd]);
}
const prepared=(await writer.handle({action:'prepareHandoff',id:worktree.id,threadId:family.rootThreadId})).plan;
await writer.exclusive(epoch=>writer.beginHandoff(prepared.id,epoch));await writer.close();


let reboundContext=null;
coding.reserveHandoffReconnect=async(resolvePaths,context,snapshot)=>{assert.deepEqual(context.owner,binding);assert.deepEqual(snapshot,family);await resolvePaths();return {release(){},async revalidateScope(){},async rebind(next,publish){assert.deepEqual(next.owner,context.owner);await publish();if(process.argv.includes('--fail-owner-publication'))throw Error('Injected uncertain owner publication');reboundContext=structuredClone(next);return true;}};};
const {rebootFixture}=await import('../checks/reboot-adoption-fixture.mjs');
try{await rebootFixture({dataDir,directory:join(dataDir,'Worktrees/.handoffs',prepared.id),source:dirname(fileURLToPath(import.meta.url)),nativeHelper,coding,check:async(name,fn)=>{await fn();console.log('PASS '+name);},onReconnectReady:async manager=>{
 const before=await readFile(join(dataDir,'managed-worktrees.json'));
 if(process.argv.includes('--unlocked-peer')){await assert.rejects(manager.handle({action:'prepareReconnect'}),/registration is no longer locked|locked worktree/);assert.deepEqual(await readFile(manager.ledger),before);console.log('PASS unlocked branch peer is refused without publication');return;}
 const {plan}=await manager.handle({action:'prepareReconnect'});
 if(process.argv.includes('--changed-peer-branch')){await git(ordinaryPeer.cwd,['switch','-c','after-review']);await assert.rejects(manager.handle({action:'commitReconnect',planId:plan.id}),/reviewed content changed/);assert.deepEqual(await readFile(manager.ledger),before);assert.equal((await readdir(dataDir)).some(name=>name.endsWith('.reconnect')),false);console.log('PASS branch change after review is refused without publication');return;}
 assert.equal(plan.operation,'reconnect');assert.equal(plan.handoffs.length,1);
 assert.equal(plan.handoffs[0].id,prepared.id);assert.equal(plan.historicalContinuity,false);
 assert.deepEqual(await readFile(join(dataDir,'managed-worktrees.json')),before);
 console.log('PASS actual Native/Git v2 retained handoff prepares audited reconnect without mutation');

 if(process.argv.includes('--stop-before-publication')){const stage=manager.stageHandoffReconnect.bind(manager);manager.stageHandoffReconnect=async(...args)=>{const result=await stage(...args);void manager.stop();return result;};}
 if(process.argv.includes('--fail-owner-publication')||process.argv.includes('--stop-before-publication')){
  await assert.rejects(manager.handle({action:'commitReconnect',planId:plan.id}),/unconfirmed/);assert.equal(manager.reconnectUnconfirmed,true);
  const marker=JSON.parse(await readFile(manager.ledger+'.reconnect'));assert.equal(marker.ledgerSHA256,createHash('sha256').update(before).digest('hex'));assert.deepEqual(await readFile(marker.backupPath),before);
  const cold=new manager.constructor({dataDir,nativeHelper,coding});await assert.rejects(cold.load(),/Unresolved/);await cold.close();
  console.log('PASS uncertain publication or Stop retains durable fence, original ledger backup and cold-load refusal');return;
 }
 const result=await manager.handle({action:'commitReconnect',planId:plan.id});assert.equal(result.reconnected,true);assert.equal(manager.handoffs.length,1);
 const h=manager.handoffs[0],read=()=>manager.readHandoffRecovery(h.id,manager.epoch),adopted=await read();
 assert.equal(adopted.manifest.version,6);assert.equal(adopted.progress.sequence,1);assert.equal(adopted.head.sequence,2);assert.equal(adopted.uncommitted.length,1);assert.deepEqual(adopted.manifest.owner,binding);
 assert.deepEqual(adopted.manifest.processProtocol,JSON.parse(await readFile(join(adopted.manifest.reconnect.backupDirectory.path,'manifest.json'))).processProtocol);
 assert.deepEqual(JSON.parse(await readFile(result.backupPath)),JSON.parse(before));
 for(const row of adopted.manifest.reconnect.backups){const raw=await readFile(join(adopted.manifest.reconnect.backupDirectory.path,row.name));assert.equal(createHash('sha256').update(raw).digest('hex'),row.stamp.hash);}
 const evidence=join(adopted.manifest.reconnect.backupDirectory.path,'manifest.json'),rawEvidence=await readFile(evidence);await writeFile(evidence,Buffer.concat([rawEvidence,Buffer.from(' ')]));await assert.rejects(read,/changed|replaced/);await writeFile(evidence,rawEvidence);await read();
 const cold=new manager.constructor({dataDir,nativeHelper,coding});await cold.load();const fresh=await cold.readHandoffRecovery(h.id,cold.epoch);assert.deepEqual(fresh.manifest,adopted.manifest);await cold.close();
 console.log('PASS current-device metadata retains original bytes, original owner, committed pointer and uncommitted tail across cold read; tampering is refused');

 const originals=[source,worktree.cwd,join(dataDir,'Worktrees'),manager.ledger,adopted.manifest.reconnect.backupDirectory.path],retainedHandoff=structuredClone(h);
 await writeFile(evidence,Buffer.concat([rawEvidence,Buffer.from(' ')]));
 try{
  const faulted=await Promise.all(originals.map(path=>tree(path))),plans=[...manager.plans.keys()];
  await assert.rejects(manager.handle({action:'prepareRecoveryCopy',id:h.id}),/backup|changed|replaced|reconnect/i);
  assert.deepEqual([...manager.plans.keys()],plans);assert.deepEqual(await Promise.all(originals.map(path=>tree(path))),faulted);
 }finally{await writeFile(evidence,rawEvidence);}
 assert.deepEqual(await readFile(evidence),rawEvidence);const afterBadPrepare=await read();assert.deepEqual(afterBadPrepare.manifest,adopted.manifest);assert.equal(afterBadPrepare.fingerprint,adopted.fingerprint);
 // The successful copy's strict tree baseline follows restoration of the fault.
 const originalTrees=await Promise.all(originals.map(path=>tree(path)));
 const copyPlan=(await manager.handle({action:'prepareRecoveryCopy',id:h.id})).plan;
 assert.equal(copyPlan.operation,'handoff-original-copy');assert.equal(copyPlan.handoffId,h.id);assert.equal(copyPlan.rootThreadId,family.rootThreadId);assert.equal(copyPlan.source,source);assert.equal(copyPlan.head,head);assert.equal(copyPlan.indexTree,indexTree);
 const reviewedCopy=manager.plans.get(copyPlan.id).copy;
 assert.equal(reviewedCopy.review.manifest.version,6);assert.deepEqual(reviewedCopy.review.manifest,adopted.manifest);assert.deepEqual(reviewedCopy.review.manifest.owner,binding);assert.equal(reviewedCopy.review.fingerprint,adopted.fingerprint);
 const copied=(await manager.handle({action:'createRecoveryCopy',planId:copyPlan.id})).copy;
 assert.equal(copied.independent,true);assert.equal(copied.originalRecoveryComplete,false);
 assert.deepEqual(await readFile(join(copied.target,'binary')),Buffer.from([0,253,3]));
 assert.deepEqual((await git(copied.target,['show',':binary'],{raw:true})).stdout,Buffer.from([0,254,2]));
 assert.equal((await git(copied.target,['rev-parse','HEAD'])).stdout.trim(),head);assert.equal((await git(copied.target,['write-tree'])).stdout.trim(),indexTree);
 assert.equal((await lstat(join(copied.target,'group-exec'))).mode&0o777,0o650);assert.equal((await git(copied.target,['ls-files','--stage','group-exec'])).stdout.split(' ')[0],'100644');assert.deepEqual(await metadata(join(copied.target,'native-only')),originalMetadata);
 assert.equal(await readlink(join(copied.target,'symbolic')),'binary');
 const copyA=await lstat(join(copied.target,'hard-a')),copyB=await lstat(join(copied.target,'hard-b')),oldA=await lstat(join(source,'hard-a'));assert.equal(copyA.ino,copyB.ino);assert.notEqual(copyA.ino,oldA.ino);
 assert((await lstat(join(copied.target,'empty'))).isDirectory());assert.equal((await lstat(join(copied.target,'exec'))).mode&0o777,0o755);
 assert((await git(copied.target,['ls-files','--others','--exclude-standard','-z'])).stdout.split('\0').includes('deleted'));
 const copyIntent=JSON.parse(await readFile(join(dirname(copied.target),'intent.json'))),copyReceipt=JSON.parse(await readFile(copied.receiptPath));
 assert.deepEqual(copyIntent.owner,binding);assert.equal(copyIntent.reviewFingerprint,adopted.fingerprint);
 assert.equal(copyReceipt.state,'complete');assert.deepEqual(copyReceipt.copy,copied);assert.equal(copyReceipt.reviewFingerprint,adopted.fingerprint);assert.equal(copyReceipt.originalsMutatedByCopy,false);
 assert.deepEqual(copyReceipt.donor.root,adopted.manifest.copies.source.root);assert.equal(copyReceipt.finalGit.head,head);assert.equal(copyReceipt.finalGit.indexTree,indexTree);assert.equal(copyReceipt.finalGit.symbolicHead,'');
 assert((await lstat(join(copied.target,'.git'))).isDirectory());await assert.rejects(lstat(join(copied.target,'.git/objects/info/alternates')),{code:'ENOENT'});
 assert.deepEqual(await Promise.all(originals.map(path=>tree(path))),originalTrees);
 await assert.rejects(manager.handle({action:'createRecoveryCopy',planId:copyPlan.id}),/expired|consumed|unknown/i);
 const afterCopy=await read();assert.deepEqual(afterCopy.manifest,adopted.manifest);assert.deepEqual(afterCopy.manifest.owner,binding);assert.equal(afterCopy.fingerprint,adopted.fingerprint);assert.deepEqual(manager.handoffs,[retainedHandoff]);assert.deepEqual(await Promise.all(originals.map(path=>tree(path))),originalTrees);
 console.log('PASS reconnected v6 creates a verified independent Native/Git original copy; original bytes, metadata, identities, owner and manifest fingerprint stay exact, plan reuse is refused, and original recovery remains incomplete');

 const driftPlan=(await manager.handle({action:'prepareRecoveryCopy',id:h.id})).plan,driftEntry=manager.plans.get(driftPlan.id).copy.entry;
 // Only this fixture-written backup's mtime/ctime are omitted from the restoration
 // comparison. Its bytes, mode and inode, and every other path's times, stay checked.
 const beforeDrift=await Promise.all(originals.map(path=>tree(path,evidence)));
 await writeFile(evidence,Buffer.concat([rawEvidence,Buffer.from(' ')]));
 try{
  const faulted=await Promise.all(originals.map(path=>tree(path)));
  await assert.rejects(manager.handle({action:'createRecoveryCopy',planId:driftPlan.id}),/backup|changed|replaced|reconnect/i);
  assert.equal(manager.plans.has(driftPlan.id),false);await assert.rejects(readFile(join(driftEntry,'receipt.json')),{code:'ENOENT'});assert.deepEqual(await Promise.all(originals.map(path=>tree(path))),faulted);
 }finally{await writeFile(evidence,rawEvidence);}
 assert.deepEqual(await Promise.all(originals.map(path=>tree(path,evidence))),beforeDrift);
 assert.deepEqual(await readFile(evidence),rawEvidence);const afterDrift=await read();assert.deepEqual(afterDrift.manifest,adopted.manifest);assert.deepEqual(afterDrift.manifest.owner,binding);assert.equal(afterDrift.fingerprint,adopted.fingerprint);assert.deepEqual(manager.handoffs,[retainedHandoff]);
 console.log('PASS v6 copy preparation refuses a corrupted retained backup; post-plan backup drift refuses creation with no final receipt, and restored evidence remains readable');

 coding.loadHandoffRecovery=async context=>assert.deepEqual(context,reboundContext);
 coding.reserveHandoffRecovery=async(resolvePaths,context)=>{assert.deepEqual(context,reboundContext);await resolvePaths();return {release(){},async revalidateScope(){}};};
 coding.prepareHandoffRecovery=async(snapshot,destination,journal,filesystem)=>{assert.deepEqual(filesystem,Object.fromEntries(['fromDevice','toDevice','volumeUUID'].map(key=>[key,adopted.manifest.reconnect[key]])));return {snapshot,destination,journal};};
 coding.checkHandoffAuthority=(target,fence,context)=>{assert(fence.running);assert.deepEqual(context.snapshot,family);assert([source,worktree.cwd].includes(target));};
 coding.recoverHandoffFamily=async(review,target,callbacks)=>{const fence={running:true,originalDestination:review.destination,recovery:{review,consumed:true,journal:review.journal}};await callbacks.bind(fence);await callbacks.transfer();const moved={...family,cwd:target,members:family.members.map(row=>({...row,cwd:target}))};await callbacks.complete(moved,async commit=>{assert.equal(commit.target,target);});return moved;};
 coding.verifyTemporary=async()=>{throw Error('No disposable scratch');};
 const restore=(await manager.handle({action:'prepareHandoffRecovery',id:h.id,mode:'restore'})).plan;
 const restored=await manager.handle({action:'recoverHandoff',planId:restore.id});assert.equal(restored.handoff.state,'complete');assert.equal(manager.handoffs.length,0);
 assert.deepEqual(await readFile(join(source,'binary')),Buffer.from([0,253,3]));assert.equal((await git(source,['write-tree'])).stdout.trim(),indexTree);assert.deepEqual(await metadata(join(source,'native-only')),originalMetadata);
 console.log('PASS actual Native/Git Restore follows reconnect; fixture Coding family authority is simulated and original model/owner are retained');
 if(ordinaryPeer){assert.equal((await git(ordinaryPeer.cwd,['symbolic-ref','HEAD'])).stdout.trim(),'refs/heads/main');assert((await readFile(join((await writer.records.find(r=>r.id===ordinaryPeer.id)).admin,'locked'),'utf8')).startsWith('Saleh managed worktree '));assert.equal(await readFile(join(ordinaryPeer.cwd,'kept.txt'),'utf8'),'completed handoff peer\n');console.log('PASS completed branch-attached peer is reconnected with its branch, lock and content retained');}
 console.log(JSON.stringify({root,source,dataDir,passed:true}));

}});}finally{await runner.cancel();}
