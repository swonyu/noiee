import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,unlink,rm,symlink,link,chmod,readlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {ManagedWorktrees} from './managed-worktrees.mjs';

const exec=promisify(execFile),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git',nativeHelper=process.env.HANDOFF_FILES_HELPER;
assert(nativeHelper,'HANDOFF_FILES_HELPER must name the independently compiled native fixture binary.');
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-stage-'))),tests=[];
console.log('Fixture '+root);
const env={HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
const raw=async args=>(await exec(git,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env})).stdout;
const sha=b=>createHash('sha256').update(b).digest('hex');
const content=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['identity','ctime',...(row.kind==='directory'?['nlink']:[])].includes(key)));
const attrs=(path,value)=>exec('/usr/bin/xattr',['-w','user.handoff',value,path]);
const lines=Array.from({length:20},(_,i)=>'line '+i+'\n'),large=Buffer.alloc(9*1024*1024,37);
large[0]=0;
async function fixture(name,base=async()=>{}){
  const dir=join(root,name),source=join(dir,'source');await mkdir(source,{recursive:true});await raw(['init','-b','main',source]);
  await raw(['-C',source,'config','user.name','Fixture']);await raw(['-C',source,'config','user.email','fixture@localhost']);
  await writeFile(join(source,'text'),lines.join(''));await writeFile(join(source,'.gitignore'),'ignored/\nmixed/ignored\n');await base(source);
  await raw(['-C',source,'add','.']);await raw(['-C',source,'commit','-m','base']);
  const family={rootThreadId:'fixture-root',cwd:source,members:[{id:'fixture-root',archived:false,cwd:source}],fingerprint:'fixture'},coding={prepareHandoff:async()=>structuredClone(family),handoffTemporary:async()=>null,projectMutationInventory:async()=>[]};
  const manager=new ManagedWorktrees({dataDir:join(dir,'data'),coding,nativeHelper}),creation=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,record=(await manager.handle({action:'create',planId:creation.id})).worktree;
  const prepare=()=>manager.exclusive(async epoch=>{const result=await manager.prepareHandoff(record.id,'fixture-root',epoch);return manager.plans.get(result.plan.id);});
  return {dir,source,destination:record.cwd,manager,prepare};
}
async function check(name,fn){await fn();tests.push(name);console.log('PASS '+name);}
await check('mixed candidate materializes privately and publishes correctly within disposable checkouts',async()=>{
  const f=await fixture('mixed',async s=>{
    await writeFile(join(s,'deleted-large'),large);await writeFile(join(s,'deleted-exec'),'#!/bin/sh\ntrue\n');await chmod(join(s,'deleted-exec'),0o755);
    await symlink('original-target',join(s,'changed-link'));await symlink('deleted-target',join(s,'deleted-link'));
    await writeFile(join(s,'file-to-dir'),'original file');await mkdir(join(s,'dir-to-file'));await writeFile(join(s,'dir-to-file','child'),'original child');
    await writeFile(join(s,'binary'),Buffer.from([0,1,2,0,255]));await writeFile(join(s,'constructor'),'ordinary constructor');await writeFile(join(s,'__proto__'),'ordinary prototype');
    for(const name of ['other-exec','group-exec'])await writeFile(join(s,name),'original bytes');
  });
  const s=f.source,d=f.destination,staged=[...lines];staged[1]='SOURCE STAGED\n';await writeFile(join(s,'text'),staged.join(''));await raw(['-C',s,'add','text']);
  const sourceWorking=[...staged];sourceWorking[18]='SOURCE WORKING\n';await writeFile(join(s,'text'),sourceWorking.join(''));
  const destinationWorking=[...lines];destinationWorking[9]='DESTINATION WORKING\n';await writeFile(join(d,'text'),destinationWorking.join(''));
  await attrs(join(s,'text'),'retained-metadata');await attrs(join(d,'text'),'retained-metadata');
  for(const [name,mode] of [['other-exec',0o641],['group-exec',0o650]]){await writeFile(join(s,name),'new bytes');await chmod(join(s,name),mode);await chmod(join(d,name),mode);}
  for(const p of ['deleted-large','deleted-exec','deleted-link'])await unlink(join(s,p));
  await unlink(join(s,'changed-link'));await symlink('new-target',join(s,'changed-link'));
  await unlink(join(s,'file-to-dir'));await mkdir(join(s,'file-to-dir'));await writeFile(join(s,'file-to-dir','leaf'),'new leaf');
  await rm(join(s,'dir-to-file'),{recursive:true});await writeFile(join(s,'dir-to-file'),'new regular file');await writeFile(join(s,'binary'),Buffer.from([7,0,8,255,0]));
  await raw(['-C',s,'add','deleted-large','deleted-exec','deleted-link','changed-link','file-to-dir','dir-to-file','binary']);
  await mkdir(join(s,'empty'));await mkdir(join(s,'mixed'));await writeFile(join(s,'mixed','ignored'),'stay here');
  await writeFile(join(s,'linked-a'),'linked bytes');await link(join(s,'linked-a'),join(s,'linked-b'));
  await mkdir(join(d,'destination-empty'));await writeFile(join(d,'destination-only'),'stay there');
  const before={sourceStatus:await raw(['-C',s,'status','--porcelain=v1','-z']),destinationStatus:await raw(['-C',d,'status','--porcelain=v1','-z']),sourceText:await readFile(join(s,'text'),'utf8'),destinationText:await readFile(join(d,'text'),'utf8'),refs:await raw(['-C',s,'show-ref'])};
  const p=await f.prepare(),a=p.stages.source,b=p.stages.destination,merged=[...sourceWorking];merged[9]='DESTINATION WORKING\n';
  assert.equal(await readFile(join(b.root.path,'text'),'utf8'),merged.join(''));assert.equal(await readFile(join(a.root.path,'text'),'utf8'),lines.join(''));
  assert.equal(b.stamps.text.birthtime,p.copies.source.stamps.text.birthtime);assert.equal(b.stamps.text.mtime,p.stages.timestamp);assert.deepEqual(b.stamps.text.xattrs,p.copies.source.stamps.text.xattrs);
  assert.equal(sha(await readFile(join(a.root.path,'deleted-large'))),sha(large));assert.equal(a.stamps['deleted-exec'].mode,0o755);
  assert.equal(await readlink(join(a.root.path,'deleted-link')),'deleted-target');assert.equal(await readlink(join(a.root.path,'changed-link')),'original-target');assert.equal(await readlink(join(b.root.path,'changed-link')),'new-target');
  assert.equal(await readFile(join(a.root.path,'file-to-dir'),'utf8'),'original file');assert.equal(await readFile(join(a.root.path,'dir-to-file','child'),'utf8'),'original child');
  assert.equal(await readFile(join(b.root.path,'file-to-dir','leaf'),'utf8'),'new leaf');assert.equal(await readFile(join(b.root.path,'dir-to-file'),'utf8'),'new regular file');
  assert.equal(b.stamps['linked-a'].identity.ino,b.stamps['linked-b'].identity.ino);assert.equal(b.stamps['linked-a'].nlink,2);
  assert.equal(b.stamps['other-exec'].mode,0o641);assert.equal(b.stamps['group-exec'].mode,0o650);
  assert(b.install.includes('empty'));assert(a.remove.includes('empty'));assert(!a.remove.includes('mixed'));assert(!b.install.includes('mixed'));assert(!b.install.includes('destination-empty'));assert(!b.install.includes('destination-only'));
  assert(!b.install.includes('__proto__'));assert(!b.install.includes('constructor'));assert.equal(Object.hasOwn(p.native.source.stamps,'__proto__'),true);
  const immutable={};for(const label of ['source','destination']){
    const stage=p.stages[label],saved=stage.immutable;assert(saved,'Candidate must have an immutable native copy before publication.');
    assert.equal(saved.root.path,join(p.directory,label+'-candidate-before'));assert.notDeepEqual(saved.root,stage.root);assert.equal(saved.bytes,stage.bytes);assert.deepEqual(Object.keys(saved.stamps).sort(),Object.keys(stage.stamps).sort());
    const identities=new Map(),originalIds=new Set(Object.values(stage.stamps).map(row=>row.identity.dev+':'+row.identity.ino));
    for(const [path,row] of Object.entries(saved.stamps)){const original=stage.stamps[path],from=original.identity.dev+':'+original.identity.ino,to=row.identity.dev+':'+row.identity.ino;assert.deepEqual(content(row),content(original),'immutable metadata '+label+'/'+path);assert(!originalIds.has(to),'immutable inode must be independent');if(identities.has(from))assert.equal(identities.get(from),to,'immutable hardlink aliases must stay linked');else{assert(![...identities.values()].includes(to),'immutable independent entries must stay independent');identities.set(from,to);}}
    immutable[label]=structuredClone(saved);await f.manager.exclusive(epoch=>f.manager.verifyHandoffNativeCopy(saved,epoch));
  }
  await f.manager.exclusive(epoch=>f.manager.verifyHandoffRecovery(p,epoch));
  assert.deepEqual({sourceStatus:await raw(['-C',s,'status','--porcelain=v1','-z']),destinationStatus:await raw(['-C',d,'status','--porcelain=v1','-z']),sourceText:await readFile(join(s,'text'),'utf8'),destinationText:await readFile(join(d,'text'),'utf8'),refs:await raw(['-C',s,'show-ref'])},before);
  const candidateIndexText=(await exec(git,['--git-dir='+p.candidate.artifacts.verifiedRepository,'show',p.candidate.recovery.refs.candidateIndex.commit+':text'],{env})).stdout;
  assert.equal(candidateIndexText,staged.join(''),'Staged content must remain separate from merged working content.');
  const published={};for(const label of ['destination','source']){
    const stage=p.stages[label];published[label]=await f.manager.exclusive(epoch=>f.manager.handoffFiles('publish',{root:p.native[label].root,stage:stage.root,capture:stage.capture.root,before:stage.before,staged:stage.stamps,beforeRootStamp:stage.beforeRootStamp,stagedRootStamp:stage.rootStamp,captureRootStamp:stage.capture.rootStamp,install:stage.install,remove:stage.remove},epoch));
  }
  assert.equal(await readFile(join(d,'text'),'utf8'),merged.join(''));assert.equal(await readFile(join(s,'text'),'utf8'),lines.join(''));
  assert.equal(sha(await readFile(join(s,'deleted-large'))),sha(large));assert.equal(await readFile(join(s,'mixed','ignored'),'utf8'),'stay here');assert.equal(await readFile(join(d,'destination-only'),'utf8'),'stay there');
  assert.equal((await lstat(join(d,'linked-a'))).ino,(await lstat(join(d,'linked-b'))).ino);await assert.rejects(lstat(join(s,'linked-a')),{code:'ENOENT'});
  assert.equal(await readFile(join(p.copies.source.root.path,'text'),'utf8'),sourceWorking.join(''));assert.equal(await readFile(join(p.copies.destination.root.path,'text'),'utf8'),destinationWorking.join(''));
  for(const label of ['source','destination']){assert.deepEqual(p.stages[label].immutable,immutable[label]);await f.manager.exclusive(epoch=>f.manager.verifyHandoffNativeCopy(immutable[label],epoch));assert(!Object.values(published[label].remainingStage).some(row=>row.kind!=='directory'),'publication must consume mutable staged leaves');}
  assert.equal(await raw(['-C',s,'show-ref']),before.refs);
  await writeFile(join(f.dir,'stage-evidence.json'),JSON.stringify({before,stages:p.stages,published,nativePublicationOnly:true,gitIndicesAndHEADsNotPublished:true},null,2));await f.manager.close();
});
await check('source cleanup restores an index-deleted path recreated untracked and projects a hardlink group',async()=>{
  const f=await fixture('projected',async s=>{await writeFile(join(s,'tracked'),'HEAD bytes');});
  await raw(['-C',f.source,'rm','tracked']);await writeFile(join(f.source,'tracked'),'new bytes');await link(join(f.source,'tracked'),join(f.source,'untracked-link'));
  const p=await f.prepare(),stage=p.stages.source;
  assert(stage.install.includes('tracked'));assert(!stage.remove.includes('tracked'));assert(stage.remove.includes('untracked-link'));
  assert.equal(await readFile(join(stage.root.path,'tracked'),'utf8'),'HEAD bytes');assert.equal(stage.stamps.tracked.nlink,1);assert.equal(p.copies.source.stamps.tracked.nlink,2);
  assert.equal(await readFile(join(f.source,'tracked'),'utf8'),'new bytes');assert.equal((await lstat(join(f.source,'tracked'))).nlink,2);await f.manager.close();
});
for(const test of ['metadata','directory-metadata','empty-metadata','empty-parent-metadata','empty-alias','ignored-directory','ignored-cleanup','mode-disagreement','hardlink-payload','hardlink-topology','tracked-directory'])await check('preparation refuses '+test+' conflict before durable intent',async()=>{
  const f=await fixture(test,async s=>{if(test==='hardlink-payload'){await writeFile(join(s,'a'),'HEAD a');await writeFile(join(s,'b'),'HEAD b');}if(test==='hardlink-topology')for(const name of ['a','b','c'])await writeFile(join(s,name),'same HEAD');if(test==='ignored-cleanup')await writeFile(join(s,'restore'),'HEAD bytes');if(test==='tracked-directory'||test==='directory-metadata'){await mkdir(join(s,'tracked'));await writeFile(join(s,'tracked','item'),'HEAD bytes');}});
  if(test==='metadata')await attrs(join(f.source,'text'),'source-only metadata');
  if(test==='directory-metadata')await attrs(join(f.source,'tracked'),'source-only metadata');
  if(test==='empty-metadata'){await mkdir(join(f.source,'empty'));await mkdir(join(f.destination,'empty'));await attrs(join(f.source,'empty'),'source-only metadata');}
  if(test==='empty-parent-metadata'){for(const path of [f.source,f.destination])await mkdir(join(path,'outer','inner'),{recursive:true});await attrs(join(f.source,'outer'),'source-only metadata');}
  if(test==='empty-alias'){await mkdir(join(f.source,'Folder'));await mkdir(join(f.destination,'folder'));}
  if(test==='ignored-directory'){await writeFile(join(f.source,'incoming'),'incoming file');await mkdir(join(f.destination,'incoming'));await writeFile(join(f.source,'.git','info','exclude'),'incoming/\n');}
  if(test==='ignored-cleanup'){await raw(['-C',f.source,'rm','--cached','restore']);await unlink(join(f.source,'restore'));await mkdir(join(f.source,'restore'));await writeFile(join(f.source,'.git','info','exclude'),'restore/\n');}
  if(test==='mode-disagreement'){await raw(['-C',f.source,'config','core.fileMode','false']);await chmod(join(f.source,'text'),0o755);}
  if(test==='hardlink-payload'){await unlink(join(f.source,'b'));await link(join(f.source,'a'),join(f.source,'b'));}
  if(test==='hardlink-topology'){await unlink(join(f.source,'b'));await link(join(f.source,'a'),join(f.source,'b'));await unlink(join(f.destination,'c'));await link(join(f.destination,'b'),join(f.destination,'c'));}
  if(test==='tracked-directory'){await rm(join(f.source,'tracked'),{recursive:true});await writeFile(join(f.source,'tracked'),'tracked replacement');await raw(['-C',f.source,'add','tracked']);await exec('/usr/bin/chflags',['0100',join(f.source,'tracked')]);}
  await assert.rejects(f.prepare(),/conflict|incompatible|disagrees/i);
  assert.equal(f.manager.handoffs.length,0);await f.manager.close();
});
await writeFile(join(root,'evidence.json'),JSON.stringify({root,tests,passed:true},null,2)+'\n');console.log(JSON.stringify({root,checks:tests.length,passed:true}));
