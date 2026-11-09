// Isolated Git fixtures only. No model, network, installed app, or live user state.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {GitWorkflow} from './git-workflow.mjs';

const root=await realpath(await mkdtemp(join(tmpdir(),'noiee-workspace-git-regression-')));
const exec=promisify(execFile),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git';
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const raw=async(cwd,args)=>(await exec(git,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',cwd,...args],{env,timeout:20000})).stdout.trim();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const tests=[];
async function check(name,run){await run();tests.push(name);console.log('PASS '+name);}
async function init(name){
  const source=join(root,name);await mkdir(source);await raw(source,['init','-b','main']);
  await raw(source,['config','user.name','Fixture']);await raw(source,['config','user.email','fixture@example.invalid']);
  await writeFile(join(source,'a'),'A\n');await writeFile(join(source,'b'),'B\n');await raw(source,['add','.']);await raw(source,['commit','-m','base']);return source;
}
async function fixture(name,branch=null){
  const source=await init(name),manager=new ManagedWorktrees({dataDir:join(root,name+'-data')});
  const plan=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan;
  const record=(await manager.handle({action:'create',planId:plan.id})).worktree;assert.equal(record.state,'ready',record.message);
  if(branch){await raw(record.cwd,['update-ref','refs/heads/'+branch,'HEAD']);await raw(record.cwd,['symbolic-ref','HEAD','refs/heads/'+branch]);}
  const archive=async()=>{const plan=(await manager.handle({action:'prepareArchive',id:record.id})).plan;const out=(await manager.handle({action:'archive',planId:plan.id})).worktree;assert.equal(out.state,'archived',out.message);return manager.recoveryPaths(manager.records[0]);};
  const prepare=async()=>(await manager.handle({action:'prepareRestore',id:record.id})).plan;
  const restore=async(plan=undefined)=>{plan??=await prepare();return (await manager.handle({action:'restore',planId:plan.id})).worktree;};
  return {source,manager,record,archive,prepare,restore};
}
for(const branch of [null,'work/مرحبا','--force','HEAD'])await check('archive preserves '+(branch?'attached branch '+branch:'detached HEAD'),async()=>{
  const f=await fixture(branch?'attached-'+hash(branch).slice(0,12):'detached',branch);
  try{
    const admin=await raw(f.record.cwd,['rev-parse','--absolute-git-dir']),head=await readFile(join(admin,'HEAD')),sourceIndex=await readFile(join(f.source,'.git/index'));
    await writeFile(join(f.record.cwd,'a'),'STAGED\n');await raw(f.record.cwd,['add','a']);await writeFile(join(f.record.cwd,'a'),'WORKING\n');
    const index=await readFile(join(admin,'index')),inode=(await lstat(f.record.cwd)).ino,paths=await f.archive(),manifest=JSON.parse(await readFile(paths.manifest));
    assert.equal(manifest.version,2);assert.equal(manifest.headRef,branch?'refs/heads/'+branch:null);
    const p=await f.prepare();assert.equal(p.headRef,manifest.headRef);assert.equal(p.warning,null);
    const restored=await f.restore(p);assert.equal(restored.state,'ready',restored.message);assert.deepEqual(await readFile(join(admin,'HEAD')),head);
    assert.deepEqual(await readFile(join(admin,'index')),index);assert.equal((await lstat(f.record.cwd)).ino,inode);assert.equal(await readFile(join(f.record.cwd,'a'),'utf8'),'WORKING\n');assert.deepEqual(await readFile(join(f.source,'.git/index')),sourceIndex);
    if(branch){const before=await raw(f.record.cwd,['rev-parse','--verify','--end-of-options','refs/heads/'+branch]);await raw(f.record.cwd,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','restored branch']);assert.notEqual(await raw(f.record.cwd,['rev-parse','--verify','--end-of-options','refs/heads/'+branch]),before);assert.equal(await raw(f.record.cwd,['rev-parse','--verify','--end-of-options','refs/heads/'+branch]),await raw(f.record.cwd,['rev-parse','HEAD']));}
  }finally{await f.manager.close();}
});
for(const fault of ['moved','deleted','occupied','symbolic','late-move'])await check('restore refuses '+fault+' branch without changing archived bytes',async()=>{
  const f=await fixture('branch-'+fault,'work');
  try{
    const paths=await f.archive(),saved=await readFile(join(paths.raw,'a')),plan=fault==='late-move'?await f.prepare():null;
    const original=await raw(f.source,['rev-parse','work']);
    if(fault==='moved'||fault==='late-move'){await raw(f.source,['commit','--allow-empty','-m','new tip']);await raw(f.source,['update-ref','refs/heads/work',await raw(f.source,['rev-parse','HEAD']),original]);}
    if(fault==='deleted')await raw(f.source,['update-ref','-d','refs/heads/work',original]);
    if(fault==='occupied')await raw(f.source,['worktree','add',join(root,'occupied-peer'),'work']);
    if(fault==='symbolic')await raw(f.source,['symbolic-ref','refs/heads/work','refs/heads/main']);
    const refs=await raw(f.source,['for-each-ref','--format=%(refname) %(objectname)']);
    await assert.rejects(plan?f.restore(plan):f.prepare());assert.equal(f.manager.records[0].state,'archived');
    assert.deepEqual(await readFile(join(paths.raw,'a')),saved);assert.equal(await raw(f.source,['for-each-ref','--format=%(refname) %(objectname)']),refs);
    await assert.rejects(lstat(f.record.cwd),{code:'ENOENT'});
  }finally{await f.manager.close();}
});
await check('legacy archive declares its unknown original branch attachment',async()=>{
  const f=await fixture('legacy','work');
  try{
    const paths=await f.archive(),m=JSON.parse(await readFile(paths.manifest));m.version=1;delete m.headRef;
    await writeFile(paths.manifest,JSON.stringify(m));const bytes=await readFile(paths.manifest),st=await lstat(paths.manifest,{bigint:true});
    f.manager.records[0].archive.manifest={identity:{dev:String(st.dev),ino:String(st.ino)},hash:hash(bytes),bytes:bytes.length};await f.manager.save();
    const p=await f.prepare();assert.match(p.warning,/did not record.*detached/);const restored=await f.restore(p);assert.equal(restored.state,'ready',restored.message);assert.match(restored.message,/detached.*not recorded/);await assert.rejects(raw(f.record.cwd,['symbolic-ref','HEAD']));
  }finally{await f.manager.close();}
});
for(const name of ['colon:repo','quote"back\\slash:مرحبا😀'])await check('alternate path supports '+JSON.stringify(name),async()=>{
  const source=await init(name),workflow=new GitWorkflow({dataDir:join(root,randomUUID())});
  const act=async request=>{const snapshot=(await workflow.handle({action:'inspect',cwd:source})).snapshot;assert(!snapshot.warning,snapshot.warning);const prepared=await workflow.handle({action:'prepare',cwd:source,snapshotId:snapshot.id,requestId:randomUUID(),request:typeof request==='function'?request(snapshot):request});assert(prepared.plan,JSON.stringify(prepared));const result=await workflow.handle({action:'execute',planId:prepared.plan.id,requestId:prepared.plan.requestId});assert.equal(result.state,'completed',JSON.stringify(result));return result;};
  try{
    await writeFile(join(source,'a'),'CHANGED\n');const selected=kind=>snapshot=>({kind,entryIds:snapshot.entries.filter(e=>e.path==='a').map(e=>e.id)});
    await act(selected('stage'));assert.equal(await raw(source,['show',':a']),'CHANGED');assert.equal(await raw(source,['show',':b']),'B');
    await act(selected('unstage'));assert.equal(await raw(source,['show',':a']),'A');await act(selected('stage'));await act({kind:'commit',message:'Quoted path',authorName:'Fixture',authorEmail:'fixture@example.invalid'});assert.equal(await raw(source,['show','HEAD:a']),'CHANGED');
    const manager=new ManagedWorktrees({dataDir:join(root,randomUUID())});
    try{const p=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,r=(await manager.handle({action:'create',planId:p.id})).worktree;assert.equal(r.state,'ready',r.message);await writeFile(join(r.cwd,'a'),'RETAINED\n');const a=(await manager.handle({action:'prepareArchive',id:r.id})).plan;assert.equal((await manager.handle({action:'archive',planId:a.id})).worktree.state,'archived');const q=(await manager.handle({action:'prepareRestore',id:r.id})).plan,out=(await manager.handle({action:'restore',planId:q.id})).worktree;assert.equal(out.state,'ready',out.message);assert.equal(await readFile(join(r.cwd,'a'),'utf8'),'RETAINED\n');}finally{await manager.close();}
  }finally{await workflow.close();}
});
await writeFile(join(root,'evidence.json'),JSON.stringify({root,tests,passed:true},null,2)+'\n');console.log(JSON.stringify({root,checks:tests.length,passed:true}));
