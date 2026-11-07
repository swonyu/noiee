import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {mkdir,mkdtemp,realpath,readFile,writeFile,copyFile,symlink,readlink,chmod,lstat,readdir,unlink,rename,open} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {GitRunner} from './git-runner.mjs';
import {GitWorkflow} from './git-workflow.mjs';
import {HandoffGit} from './handoff-git.mjs';
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-git-check-')));
const inspector=new GitWorkflow({dataDir:join(root,'inspection-data')});
const sha=b=>createHash('sha256').update(b).digest('hex');
const identity=s=>[String(s.dev),String(s.ino),String(s.mode),String(s.size),String(s.mtimeNs)];
// Read-only authoritative fixture stamp, including Git metadata and ignored files.
async function stamp(root){
  const rows=[];
  async function walk(path){
    const full=join(root,path),s=await lstat(full,{bigint:true});
    const data=s.isFile()?await readFile(full):s.isSymbolicLink()?await readlink(full,{encoding:'buffer'}):null;
    rows.push([path,identity(s),data?sha(data):null]);
    if(s.isDirectory())for(const name of(await readdir(full)).sort())await walk(path?path+'/'+name:name);
  }
  await walk('');return {hash:sha(JSON.stringify(rows)),rows};
}


const runner=new GitRunner({dataDir:root}),identityEnv={GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@localhost',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@localhost'};
async function git(cwd,args,options={}){return runner.run(['-C',cwd,...args],{scope:{dirs:[root]},env:identityEnv,...options});}
async function put(cwd,path,data){await mkdir(dirname(join(cwd,path)),{recursive:true});await writeFile(join(cwd,path),data);}
async function commit(cwd,message){await git(cwd,['add','-A']);await git(cwd,['-c','commit.gpgSign=false','commit','-m',message]);return (await git(cwd,['rev-parse','HEAD'])).stdout.trim();}
const baseText=Array.from({length:30},(_,i)=>`base line ${i+1}`).join('\n')+'\n';
const modify=(s,line,value)=>s.split('\n').map((v,i)=>i===line-1?value:v).join('\n');
async function fixture(name,files={}){
  const directory=join(root,name),source=join(directory,'source'),destination=join(directory,'destination');
  await mkdir(source,{recursive:true});await git(source,['init','-b','main']);
  for(const [p,v] of Object.entries({shared:baseText,sourceOnly:'base source\n',destinationOnly:'base destination\n',deletion:'delete me\n',binary:Buffer.from([0,1,2,3]),exec:'#!/bin/sh\nexit 0\n',...files}))await put(source,p,v);
  await chmod(join(source,'exec'),0o755);await symlink('sourceOnly',join(source,'link'));await commit(source,'base');
  await git(source,['worktree','add','--detach',destination,'HEAD']);return {directory,source,destination};
}
async function preview(f,name='preview',adjust=()=>{},check=()=>{},options={}){
  const before={source:await stamp(f.source),destination:await stamp(f.destination)};
  const directory=join(f.directory,name);await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'before.json'),JSON.stringify(before,null,2));
  const scopedRunner={run:(args,options)=>{assert.equal(options.check,check);const independent=args[0]==='--git-dir='+join(directory,'verified.git');assert.deepEqual(options.scope,args[0]==='--git-dir='+join(directory,'candidate.git')||independent||args[0]==='init'?{dirs:[directory]}:{});if(independent)assert.equal(options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,'');return runner.run(args,options);}};
  const p=new HandoffGit({directory,runner:scopedRunner,inspector,check});let plan,error;
  try{const source=await inspector.readState(await inspector.repository(f.source,0),0),destination=await inspector.readState(await inspector.repository(f.destination,0),0),peers=await inspector.peerInventory(source.r,0);adjust(source,destination,peers);plan=await p.prepare(source,destination,peers,options);}catch(e){error=e;await writeFile(join(directory,'conflict.json'),JSON.stringify({message:e.message,code:e.code,step:e.step,paths:e.paths,steps:p.steps},null,2));}
  assert.equal((await stamp(f.source)).hash,before.source.hash,'preview mutated source including metadata');
  assert.equal((await stamp(f.destination)).hash,before.destination.hash,'preview mutated destination including metadata');
  p.fixture=f;p.before=before;
  if(error)throw error;
  return {p,plan};
}
async function contents(p,tree,path){const entry=(await p.treeEntries(tree)).get(path);return entry?await p.git(['cat-file','blob',entry.oid],{raw:true}).then(r=>r.stdout):null;}
async function mode(p,tree,path){return (await p.treeEntries(tree)).get(path)?.mode;}
async function rows(p,tree){return [...(await p.treeEntries(tree))].sort(([a],[b])=>a.localeCompare(b));}
async function assertBlob(p,tree,path,value){assert.deepEqual(await contents(p,tree,path),Buffer.from(value),path+' blob mismatch');}
async function expectedTree(p,tree,values){for(const [path,value] of Object.entries(values))await assertBlob(p,tree,path,value);}
async function importObjects(p){
  const from=join(p.repo,'objects'),to=join(p.source.r.commonDir,'objects');
  for(const bucket of await readdir(from)){if(!/^[a-f0-9]{2}$/.test(bucket))continue;await mkdir(join(to,bucket),{recursive:true});for(const object of await readdir(join(from,bucket)))await copyFile(join(from,bucket,object),join(to,bucket,object),constants.COPYFILE_EXCL).catch(async e=>{if(e.code!=='EEXIST')throw e;assert.deepEqual(await readFile(join(from,bucket,object)),await readFile(join(to,bucket,object)));});}
}
async function verifyWorking(p,cwd,tree){
  const expected=await p.treeEntries(tree),actual=new Map(),names=new Set((await git(cwd,['ls-files','--cached','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean));
  for(const path of names){
    let s;try{s=await lstat(join(cwd,path));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    const data=s.isSymbolicLink()?await readlink(join(cwd,path),{encoding:'buffer'}):await readFile(join(cwd,path));
    const oid=(await git(cwd,['hash-object','--stdin','--no-filters'],{input:data})).stdout.trim();
    actual.set(path,{mode:s.isSymbolicLink()?'120000':s.mode&0o111?'100755':'100644',oid});
  }
  const sort=m=>[...m].sort(([a],[b])=>a.localeCompare(b));assert.deepEqual(sort(actual),sort(expected),'actual raw working files differ from candidate');
}
// Fixture-only publication proof. Production must supply its durable transaction, metadata copier,
// retained lease, identity checks, native review, cancellation and per-phase recovery.
async function publishFixture(p,plan){
  const f=p.fixture;
  assert.equal((await stamp(f.source)).hash,p.before.source.hash,'stale source');
  assert.equal((await stamp(f.destination)).hash,p.before.destination.hash,'stale destination');
  const rootIDs=await Promise.all([f.source,f.destination,join(f.source,'.git'),join(f.destination,'.git')].map(async path=>{const s=await lstat(path);return [s.dev,s.ino];}));
  const branchRefs=(await git(f.source,['for-each-ref','--format=%(refname) %(objectname)','refs/heads/'])).stdout;
  await importObjects(p);
  const id=dirname(p.repo).split('/').at(-1);
  await git(f.source,['update-ref','refs/saleh/handoff/'+id+'/source',p.source.head]);
  await git(f.source,['update-ref','refs/saleh/handoff/'+id+'/destination',p.destination.head]);
  const apply=async(cwd,state,targetTree,indexFile)=>{
    const before=new Map(state.indexEntries),untracked=(await git(cwd,['ls-files','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean);
    for(const path of untracked)before.set(path,null);
    const after=await p.treeEntries(targetTree);
    for(const path of [...before.keys()].sort((a,b)=>b.length-a.length))if(!after.has(path))await unlink(join(cwd,path)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    for(const [path,v] of after){
      const content=(await p.git(['cat-file','blob',v.oid],{raw:true})).stdout,full=join(cwd,path);
      let same=false;try{const s=await lstat(full);same=v.mode==='120000'?s.isSymbolicLink()&&Buffer.compare(await readlink(full,{encoding:'buffer'}),content)===0:s.isFile()&&Buffer.compare(await readFile(full),content)===0&&(s.mode&0o111?'100755':'100644')===v.mode;}catch(e){if(e.code!=='ENOENT')throw e;}
      if(same)continue;
      await unlink(full).catch(e=>{if(e.code!=='ENOENT')throw e;});await mkdir(dirname(full),{recursive:true});
      if(v.mode==='120000')await symlink(content.toString(),full);else{await writeFile(full,content);await chmod(full,v.mode==='100755'?0o755:0o644);}
    }
    await copyFile(indexFile,join(state.r.gitDir,'index'));
  };
  // Source branch ownership must be released before destination attachment.
  await git(f.source,['update-ref','--no-deref','HEAD',p.source.head,p.source.head]);
  await apply(f.destination,p.destination,plan.working,join(p.dir,'destination-candidate.index'));
  if(p.source.refBranch)await git(f.destination,['symbolic-ref','HEAD','refs/heads/'+p.source.refBranch]);
  else await git(f.destination,['update-ref','--no-deref','HEAD',p.source.head,p.destination.head]);
  await apply(f.source,p.source,plan.sourceCleanup.working,join(p.dir,'source-cleanup.index'));
  assert.deepEqual(await Promise.all([f.source,f.destination,join(f.source,'.git'),join(f.destination,'.git')].map(async path=>{const s=await lstat(path);return [s.dev,s.ino];})),rootIDs,'root or .git identity replaced');
  assert.equal((await git(f.source,['for-each-ref','--format=%(refname) %(objectname)','refs/heads/'])).stdout,branchRefs,'branch tip changed');
  await verifyWorking(p,f.source,plan.sourceCleanup.working);await verifyWorking(p,f.destination,plan.working);
  assert.equal(await readFile(join(p.source.r.gitDir,'HEAD'),'utf8'),plan.branch.sourceAfter);assert.equal(await readFile(join(p.destination.r.gitDir,'HEAD'),'utf8'),plan.branch.destinationAfter);
  assert.equal((await git(f.source,['status','--porcelain=v1'])).stdout,'');
  assert.equal((await git(f.destination,['rev-parse','HEAD'])).stdout.trim(),plan.head);
  assert.equal((await git(f.destination,['write-tree'])).stdout.trim(),plan.index);
  assert.equal((await git(f.source,['rev-parse','refs/saleh/handoff/'+id+'/destination'])).stdout.trim(),p.destination.head);
}
const results=[];
async function test(name,fn){await fn();results.push({name,passed:true});console.log('PASS '+name);}
await test('verified bundle reconstructs every state with original and candidate objects unavailable',async()=>{
  const f=await fixture('recovery-bundle');await git(f.source,['switch','-c','feature']);await put(f.source,'source-commit','committed source\n');await commit(f.source,'source commit');await git(f.destination,['switch','main']);await put(f.destination,'destination-commit','committed destination\n');await commit(f.destination,'destination commit');
  await put(f.source,'sourceOnly','source staged\n');await git(f.source,['add','sourceOnly']);await put(f.source,'sourceOnly','source working\n');await git(f.source,['rm','deletion']);await put(f.source,'deletion','recreated source untracked\n');await symlink('literal/source-target',join(f.source,'source-untracked'));
  await put(f.destination,'destinationOnly','destination staged\n');await git(f.destination,['add','destinationOnly']);await put(f.destination,'destinationOnly','destination working\n');await put(f.destination,'destination-untracked',Buffer.from([0,255,128,7]));
  const {p,plan}=await preview(f);assert(plan.recovery,'candidate must include verified independent Git recovery');
  assert.deepEqual(Object.keys(plan.recovery.refs).sort(),['sourceHead','sourceIndex','sourceWorking','sourceUntracked','destinationHead','destinationIndex','destinationWorking','destinationUntracked','candidateIndex','candidateTrackedWorking','candidateWorking','sourceCleanup'].sort());
  const expected=new Map();for(const [name,state] of Object.entries(plan.recovery.refs))expected.set(name,(await p.git(['ls-tree','-r','-z',state.tree])).stdout);
  for(const [key,path] of Object.entries({bundle:p.artifacts.bundle,sourceHead:p.artifacts.sourceOriginalHead,destinationHead:p.artifacts.destinationOriginalHead,sourceIndex:p.artifacts.sourceOriginalIndex,destinationIndex:p.artifacts.destinationOriginalIndex,index:p.artifacts.index,sourceCleanupIndex:p.artifacts.sourceCleanupIndex})){const s=await lstat(path,{bigint:true}),bytes=await readFile(path);assert.deepEqual(plan.recovery[key],{identity:{dev:String(s.dev),ino:String(s.ino)},hash:sha(bytes),bytes:bytes.length});}
  const verified=await lstat(p.artifacts.verifiedRepository,{bigint:true});assert.deepEqual(plan.recovery.verifiedRepository,{dev:String(verified.dev),ino:String(verified.ino)});
  assert.deepEqual(await readFile(p.artifacts.sourceOriginalHead),Buffer.from(p.source.headRaw));assert.deepEqual(await readFile(p.artifacts.destinationOriginalHead),Buffer.from(p.destination.headRaw));assert.deepEqual(await readFile(p.artifacts.sourceOriginalIndex),p.source.index);assert.deepEqual(await readFile(p.artifacts.destinationOriginalIndex),p.destination.index);
  const objects=join(p.source.r.commonDir,'objects'),parked=objects+'-unavailable',candidate=p.repo+'-unavailable',restored=join(f.directory,'restored.git');
  await rename(objects,parked);await rename(p.repo,candidate);
  try{
    await git(f.directory,['init','--bare',restored]);const restore=(args,options={})=>git(f.directory,['--git-dir='+restored,...args],options);
    await restore(['bundle','verify',p.artifacts.bundle]);await restore(['bundle','unbundle',p.artifacts.bundle]);await restore(['fsck','--full','--no-reflogs',...Object.values(plan.recovery.refs).map(s=>s.commit)]);
    for(const [name,state] of Object.entries(plan.recovery.refs)){assert.equal((await restore(['rev-parse',state.commit+'^{tree}'])).stdout.trim(),state.tree);assert.equal((await restore(['ls-tree','-r','-z',state.tree])).stdout,expected.get(name));}
    const show=(name,path)=>restore(['show',plan.recovery.refs[name].commit+':'+path],{raw:true}).then(r=>r.stdout);
    assert.deepEqual(await show('sourceIndex','sourceOnly'),Buffer.from('source staged\n'));assert.deepEqual(await show('sourceWorking','sourceOnly'),Buffer.from('source working\n'));assert.deepEqual(await show('sourceUntracked','deletion'),Buffer.from('recreated source untracked\n'));assert.deepEqual(await show('sourceUntracked','source-untracked'),Buffer.from('literal/source-target'));assert.deepEqual(await show('destinationUntracked','destination-untracked'),Buffer.from([0,255,128,7]));
    assert.deepEqual(await show('destinationHead','destination-commit'),Buffer.from('committed destination\n'));assert.deepEqual(await show('candidateWorking','destinationOnly'),Buffer.from('destination working\n'));assert.deepEqual(await show('sourceCleanup','sourceOnly'),Buffer.from('base source\n'));
    for(const [key,tree] of [['sourceOriginalIndex',plan.sourceLayers.index],['destinationOriginalIndex',plan.destinationLayers.before.index],['index',plan.index],['sourceCleanupIndex',plan.sourceCleanup.index]]){const index=join(f.directory,key+'.reconstructed.index');await copyFile(p.artifacts[key],index);assert.equal((await restore(['write-tree'],{env:{...identityEnv,GIT_INDEX_FILE:index}})).stdout.trim(),tree);}
  }finally{await rename(candidate,p.repo);await rename(parked,objects);}
});
async function temporary(cwd){const path=join(cwd,'.saleh-coding-tmp-owned'),nonce=randomUUID();await mkdir(path,{mode:0o700});await put(path,'.saleh-owner',nonce);await put(path,'payload','owned scratch\n');const project=await lstat(cwd,{bigint:true}),s=await lstat(path,{bigint:true});return {cwd,path,nonce,projectDev:String(project.dev),projectIno:String(project.ino),dev:String(s.dev),ino:String(s.ino)};}
await test('only explicitly verified temporary directories are excluded',async()=>{
  const f=await fixture('temporary-exclusion');await put(f.source,'.saleh-coding-tmp-pretend/payload','ordinary incoming file\n');const plain=await preview(f,'plain');await assertBlob(plain.p,plain.plan.working,'.saleh-coding-tmp-pretend/payload','ordinary incoming file\n');
  const entries=[await temporary(f.source),await temporary(f.destination)],checkPlan=async name=>{const {p,plan}=await preview(f,name,()=>{},()=>{},{temporary:entries});assert.deepEqual(plan.temporary,entries);for(const key of ['sourceUntracked','destinationUntracked','candidateWorking'])assert(![...(await p.treeEntries(plan.recovery.refs[key].tree)).keys()].some(path=>path.startsWith('.saleh-coding-tmp-owned/')));await assertBlob(p,plan.working,'.saleh-coding-tmp-pretend/payload','ordinary incoming file\n');};
  await checkPlan('untracked-owned');await put(f.source,'.git/info/exclude','.saleh-coding-tmp-owned/\n');await checkPlan('ignored-owned');
  await assert.rejects(preview(f,'wrong-owner',()=>{},()=>{},{temporary:[{...entries[0],ino:'0'}]}),/temporary/i);
});
await test('temporary exclusion rejects index, HEAD and incoming collisions',async()=>{
  const f=await fixture('temporary-tracked'),entry=await temporary(f.source);await git(f.source,['add','.saleh-coding-tmp-owned/payload']);await assert.rejects(preview(f,'index',()=>{},()=>{},{temporary:[entry]}),/temporary/i);
  await commit(f.source,'tracked scratch fixture');await git(f.source,['rm','--cached','-r','.saleh-coding-tmp-owned']);await assert.rejects(preview(f,'head',()=>{},()=>{},{temporary:[entry]}),/temporary/i);
  const other=await fixture('temporary-incoming'),target=await temporary(other.destination);await put(other.source,'.saleh-coding-tmp-owned/incoming','must not enter owned destination scratch\n');await assert.rejects(preview(other,'incoming',()=>{},()=>{},{temporary:[target]}),/temporary/i);
});
for(const kind of ['oversize','cancelled'])await test('bundle '+kind+' fails with original checkouts unchanged',async()=>{
  const f=await fixture('bundle-'+kind),run=runner.run.bind(runner);let cancelled=false;
  runner.run=async(args,options)=>{const result=await run(args,options);if(kind==='oversize'&&args.includes('bundle')&&args.includes('create')){const file=await open(args[args.indexOf('create')+1],'r+');try{await file.truncate(512*1024*1024+1);}finally{await file.close();}}if(kind==='cancelled'&&args[0].endsWith('/verified.git')&&args.includes('unbundle'))cancelled=true;return result;};
  try{await assert.rejects(preview(f,'preview',()=>{},()=>{if(cancelled)throw Object.assign(new Error('Cancelled during recovery verification.'),{code:'CANCELLED'});}),e=>kind==='cancelled'?e.code==='CANCELLED':/size/.test(e.message));if(kind==='oversize')await assert.rejects(lstat(join(f.directory,'preview','verified.git')),e=>e.code==='ENOENT');else assert(cancelled);}finally{runner.run=run;}
});
for(const kind of ['destination-file','destination-parent','source-cleanup'])await test('reject ignored alias '+kind+' without any original mutation',async()=>{
  const f=await fixture('ignored-alias-'+kind),cleanup=kind==='source-cleanup',path=cleanup?'sourceOnly':kind==='destination-parent'?'incoming/child':'incoming',ignored=cleanup?'SOURCEONLY':'INCOMING';
  await put(f.source,'.git/info/exclude',ignored+'\n');
  if(cleanup){await git(f.source,['rm',path]);await put(f.source,ignored,'ignored source must remain\n');}
  else{await put(f.source,path,'incoming staged content\n');await git(f.source,['add','-f',path]);await put(f.destination,ignored,'ignored destination must remain\n');}
  await assert.rejects(preview(f),e=>e.code==='CONFLICT'&&e.message.includes(cleanup?'source cleanup ignored obstruction':'destination ignored obstruction'));
});
await test('dirty layers, native Git modes, untracked and bidirectional round-trip',async()=>{
  const f=await fixture('round-trip');
  let s=modify(baseText,3,'source staged');await put(f.source,'shared',s);await put(f.source,'sourceOnly','source stage\n');await put(f.source,'binary',Buffer.from([0,9,8,7]));await git(f.source,['add','shared','sourceOnly','binary']);
  s=modify(s,9,'source working');await put(f.source,'shared',s);await put(f.source,'sourceOnly','source working\n');await put(f.source,'binary',Buffer.from([0,9,8,6]));await unlink(join(f.source,'deletion'));await git(f.source,['add','deletion']);await unlink(join(f.source,'link'));await symlink('destinationOnly',join(f.source,'link'));await git(f.source,['add','link']);await unlink(join(f.source,'link'));await symlink('absent-literal-target',join(f.source,'link'));await put(f.source,'new-file','staged add\n');await git(f.source,['add','new-file']);await put(f.source,'new-file','working add\n');await put(f.source,'untracked-source','source untracked\n');await put(f.source,'exec','#!/bin/sh\nexit 3\n');await git(f.source,['add','exec']);await chmod(join(f.source,'exec'),0o644);
  let d=modify(baseText,18,'destination staged');await put(f.destination,'shared',d);await put(f.destination,'destinationOnly','destination stage\n');await git(f.destination,['add','shared','destinationOnly']);d=modify(d,26,'destination working');await put(f.destination,'shared',d);await put(f.destination,'destinationOnly','destination working\n');await put(f.destination,'untracked-destination','destination untracked\n');
  const {p,plan}=await preview(f);
  const stagedShared=modify(modify(baseText,3,'source staged'),18,'destination staged'),workingShared=modify(modify(stagedShared,9,'source working'),26,'destination working');
  await expectedTree(p,plan.index,{shared:stagedShared,sourceOnly:'source stage\n',destinationOnly:'destination stage\n',binary:Buffer.from([0,9,8,7]),link:'destinationOnly','new-file':'staged add\n'});
  await expectedTree(p,plan.working,{shared:workingShared,sourceOnly:'source working\n',destinationOnly:'destination working\n',binary:Buffer.from([0,9,8,6]),link:'absent-literal-target','new-file':'working add\n','untracked-source':'source untracked\n','untracked-destination':'destination untracked\n'});
  assert.equal(await mode(p,plan.index,'exec'),'100755');assert.equal(await mode(p,plan.working,'exec'),'100644');assert.equal(await mode(p,plan.index,'link'),'120000');assert.equal(await mode(p,plan.working,'link'),'120000');assert.equal(await contents(p,plan.working,'deletion'),null);assert.equal(await contents(p,plan.index,'untracked-source'),null);
  const indexBefore=await rows(p,plan.index),workingBefore=await rows(p,plan.working);
  await publishFixture(p,plan);
  assert.equal(await readlink(join(f.destination,'link')),'absent-literal-target');assert.equal((await git(f.destination,['symbolic-ref','HEAD'])).stdout.trim(),'refs/heads/main');
  const back=await preview({directory:f.directory,source:f.destination,destination:f.source},'return-preview');
  assert.deepEqual(await rows(back.p,back.plan.index),indexBefore);assert.deepEqual(await rows(back.p,back.plan.working),workingBefore);await publishFixture(back.p,back.plan);
  assert.equal((await git(f.source,['symbolic-ref','HEAD'])).stdout.trim(),'refs/heads/main');
});
await test('staged deletion with recreated untracked file preserves both layers',async()=>{
  const f=await fixture('recreated-after-delete');await git(f.source,['rm','sourceOnly']);await put(f.source,'sourceOnly','recreated untracked content\n');
  const {p,plan}=await preview(f);assert.equal(await contents(p,plan.index,'sourceOnly'),null);await assertBlob(p,plan.working,'sourceOnly','recreated untracked content\n');await publishFixture(p,plan);
  const status=(await git(f.destination,['status','--porcelain=v1'])).stdout;assert(status.includes('D  sourceOnly'));assert(status.includes('?? sourceOnly'));
});
await test('untracked binary symlink and executable preserve literal Git bytes and modes',async()=>{
  const f=await fixture('untracked-modes');await put(f.source,'new-binary',Buffer.from([0,255,128,3]));await put(f.source,'new-exec','#!/bin/sh\necho hi\n');await chmod(join(f.source,'new-exec'),0o755);await symlink('/literal/nonexistent/target',join(f.source,'new-link'));
  const {p,plan}=await preview(f);await assertBlob(p,plan.working,'new-binary',Buffer.from([0,255,128,3]));assert.equal(await mode(p,plan.working,'new-exec'),'100755');assert.equal(await mode(p,plan.working,'new-link'),'120000');await publishFixture(p,plan);assert.equal(await readlink(join(f.destination,'new-link')),'/literal/nonexistent/target');
});
await test('source commits advance, old destination branch and unrelated dirty deltas survive',async()=>{
  const f=await fixture('committed-advance');await git(f.source,['switch','-c','feature']);await put(f.source,'feature-only','committed feature\n');const advanced=await commit(f.source,'feature change');
  await git(f.destination,['switch','main']);await put(f.destination,'destinationOnly','local stage\n');await git(f.destination,['add','destinationOnly']);await put(f.destination,'destinationOnly','local working\n');
  const oldMain=(await git(f.destination,['rev-parse','main'])).stdout.trim();const {p,plan}=await preview(f);assert.equal(plan.head,advanced);assert.equal(plan.branch.retainedDestinationBranch,'main');
  await expectedTree(p,plan.index,{'feature-only':'committed feature\n',destinationOnly:'local stage\n'});await expectedTree(p,plan.working,{destinationOnly:'local working\n'});await publishFixture(p,plan);assert.equal((await git(f.destination,['rev-parse','main'])).stdout.trim(),oldMain);
});
await test('diverged committed states preserved by refs without synthesizing merged commit',async()=>{
  const f=await fixture('divergent');await git(f.source,['switch','-c','feature']);await put(f.source,'feature-only','source commit\n');const sourceHead=await commit(f.source,'source branch');await git(f.destination,['switch','main']);await put(f.destination,'destination-committed-only','prior destination commit\n');const oldHead=await commit(f.destination,'destination branch');
  await put(f.destination,'destinationOnly','dirty destination stage\n');await git(f.destination,['add','destinationOnly']);await put(f.destination,'destinationOnly','dirty destination working\n');
  const {p,plan}=await preview(f);assert.equal(plan.head,sourceHead);assert.equal(await contents(p,plan.working,'destination-committed-only'),null);await assertBlob(p,plan.index,'destinationOnly','dirty destination stage\n');await publishFixture(p,plan);
  assert.equal((await git(f.destination,['rev-parse','main'])).stdout.trim(),oldHead);assert.equal((await git(f.destination,['show','main:destination-committed-only'])).stdout,'prior destination commit\n');
});
await test('detached source and destination commits remain reachable',async()=>{
  const f=await fixture('detached');await git(f.source,['switch','--detach']);await put(f.source,'feature-only','detached source\n');const sh=await commit(f.source,'detached source');await put(f.destination,'old-detached','detached destination\n');const dh=await commit(f.destination,'detached destination');
  const {p,plan}=await preview(f);assert.equal(plan.branch.destinationAfter,sh+'\n');await publishFixture(p,plan);assert.equal((await git(f.destination,['symbolic-ref','--quiet','HEAD'],{allowCodes:[0,1]})).code,1);assert.equal((await git(f.destination,['show','refs/saleh/handoff/preview/destination:old-detached'])).stdout,'detached destination\n');assert.notEqual(sh,dh);
});
await test('ignored bytes preserved across fixture publication',async()=>{
  const f=await fixture('ignored-preserved',{'.gitignore':'ignored-*\n'});await put(f.source,'ignored-source','private source\n');await put(f.destination,'ignored-destination','private destination\n');await put(f.source,'sourceOnly','incoming\n');
  const {p,plan}=await preview(f);await publishFixture(p,plan);assert.equal(await readFile(join(f.source,'ignored-source'),'utf8'),'private source\n');assert.equal(await readFile(join(f.destination,'ignored-destination'),'utf8'),'private destination\n');
});
for(const kind of ['staged-content','unstaged-content','binary','untracked','untracked-versus-tracked','file-directory','ignored-destination','ignored-source-cleanup'])await test('reject '+kind+' without any original mutation',async()=>{
  const f=await fixture('conflict-'+kind);
  if(kind==='staged-content'){await put(f.source,'shared','source conflicting\n');await git(f.source,['add','shared']);await put(f.destination,'shared','destination conflicting\n');await git(f.destination,['add','shared']);}
  if(kind==='unstaged-content'){await put(f.source,'shared','source conflicting\n');await put(f.destination,'shared','destination conflicting\n');}
  if(kind==='binary'){await put(f.source,'binary',Buffer.from([0,55]));await put(f.destination,'binary',Buffer.from([0,77]));}
  if(kind==='untracked'){await put(f.source,'new','source\n');await put(f.destination,'new','destination\n');}
  if(kind==='untracked-versus-tracked'){await put(f.source,'new','source\n');await put(f.destination,'new','destination staged\n');await git(f.destination,['add','new']);}
  if(kind==='file-directory'){await put(f.source,'new','source\n');await put(f.destination,'new/child','destination\n');}
  if(kind==='ignored-destination'){await put(f.source,'.git/info/exclude','obstruction\n');await put(f.source,'obstruction','source staged\n');await git(f.source,['add','-f','obstruction']);await put(f.destination,'obstruction','ignored destination\n');}
  if(kind==='ignored-source-cleanup'){await put(f.source,'.git/info/exclude','sourceOnly\n');await git(f.source,['rm','--cached','sourceOnly']);await put(f.source,'sourceOnly','ignored source must remain\n');}
  await assert.rejects(preview(f),e=>e.code==='CONFLICT');
});
await test('clean tracked blob larger than changed-file limit stays referenced through alternates',async()=>{
  const f=await fixture('large-clean-blob',{'large-clean':Buffer.alloc(9*1024*1024,65)});await put(f.source,'sourceOnly','small actual change\n');
  const {p,plan}=await preview(f),before=(await p.treeEntries(plan.sourceLayers.headTree)).get('large-clean');
  assert.deepEqual((await p.treeEntries(plan.index)).get('large-clean'),before);assert.deepEqual((await p.treeEntries(plan.working)).get('large-clean'),before);
  await assert.rejects(lstat(join(p.repo,'objects',before.oid.slice(0,2),before.oid.slice(2))),e=>e.code==='ENOENT');
});
await test('stale source rejects fixture publication before changing refs or destination',async()=>{
  const f=await fixture('stale-source');await put(f.source,'sourceOnly','reviewed content\n');const {p,plan}=await preview(f);await put(f.source,'sourceOnly','changed after review\n');const before={source:await stamp(f.source),destination:await stamp(f.destination)};
  await assert.rejects(publishFixture(p,plan),/stale source/);assert.equal((await stamp(f.source)).hash,before.source.hash);assert.equal((await stamp(f.destination)).hash,before.destination.hash);
});
await test('unsupported intent-to-add state rejects unchanged',async()=>{
  const f=await fixture('intent-to-add');await put(f.source,'ita','intent only\n');await git(f.source,['add','--intent-to-add','ita']);await assert.rejects(preview(f),/Unsupported index flags|Intent-to-add/);
});
await test('same checkout is rejected before any candidate Git mutation',async()=>{
  const f=await fixture('same-checkout');await assert.rejects(preview({...f,destination:f.source}),/distinct checkout/);
});
await test('different common repositories are rejected',async()=>{
  const f=await fixture('different-repo'),other=await fixture('other-repo');await assert.rejects(preview({...f,destination:other.destination}),/same common repository identity/);
});
await test('captured common identity mismatch is rejected',async()=>{
  const f=await fixture('common-identity');await assert.rejects(preview(f,'preview',(_s,d)=>{d.r.identities.common={...d.r.identities.common,ino:'0'};}),/same common repository identity/);
});
await test('noncanonical checkout path is rejected',async()=>{
  const f=await fixture('noncanonical');await assert.rejects(preview(f,'preview',s=>{s.r.cwd+='/.';}),/canonical/);
});
await test('missing peer participation is rejected',async()=>{
  const f=await fixture('missing-peer');await assert.rejects(preview(f,'preview',(_s,d,p)=>{p.records=p.records.filter(r=>r.path!==d.r.cwd);}),/captured peer registration/);
});
await test('third-party peer branch occupancy is rejected',async()=>{
  const f=await fixture('occupied-branch');await git(f.source,['worktree','add','--force',join(f.directory,'third-peer'),'main']);await assert.rejects(preview(f),/third-party peer/);
});
await test('cancellation during candidate preparation preserves original checkouts',async()=>{
  const f=await fixture('cancelled');await put(f.source,'sourceOnly','private candidate change\n');let checks=0;
  await assert.rejects(preview(f,'preview',()=>{},()=>{if(++checks>=80)throw Object.assign(new Error('Cancelled by fixture epoch.'),{code:'CANCELLED'});}),e=>e.code==='CANCELLED');assert(checks>=80);
});
await writeFile(join(root,'evidence.json'),JSON.stringify({root,results,passed:results.length,scope:'Disposable fixture candidate/semantics proof; no production integration, native metadata, cancellation or durability claims.'},null,2)+'\n');
console.log(JSON.stringify({passed:results.length,evidence:join(root,'evidence.json')},null,2));
