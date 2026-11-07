import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rename,lstat,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';

const source=process.env.RECONNECT_SOURCE;
assert(source&&source.startsWith('/'),'Set RECONNECT_SOURCE to the isolated source under review.');
const {ManagedWorktrees}=await import(pathToFileURL(join(source,'managed-worktrees.mjs')));
const exec=promisify(execFile),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git';
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-reconnect-check-')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const volumeUUID='DA5786BC-3563-4A7A-865E-A1E8A7805C94';
const identityPaths=data=>[data.root,...data.records.flatMap(r=>[...Object.values(r.identities),...(r.archive?[r.archive.parent,r.archive.directory,...['manifest','index','bundle'].map(k=>r.archive[k].identity)]:[])])];
const withoutDevice=data=>{const copy=structuredClone(data);for(const id of identityPaths(copy))delete id.dev;return copy;};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
let serial=0;
async function fixture({archive=false}={}){
 const dir=join(root,String(++serial)),project=join(dir,'source'),dataDir=join(dir,'Coding');await mkdir(project,{recursive:true});
 const env={HOME:dir,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
 const raw=async args=>(await exec(git,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env})).stdout.trim();
 await raw(['init','-b','main',project]);await writeFile(join(project,'file.txt'),'BASE\n');await raw(['-C',project,'add','.']);await raw(['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
 const initial=new ManagedWorktrees({dataDir});const p=(await initial.handle({action:'prepare',cwd:project,ref:'HEAD'})).plan;
 const record=(await initial.handle({action:'create',planId:p.id})).worktree;assert.equal(record.state,'ready',record.message);
 await writeFile(join(record.cwd,'file.txt'),'RETAINED DIRTY\n');await writeFile(join(record.cwd,'draft.txt'),'UNTRACKED\n');
 if(archive){const p=(await initial.handle({action:'prepareArchive',id:record.id})).plan;await initial.handle({action:'archive',planId:p.id});const q=(await initial.handle({action:'prepareRestore',id:record.id})).plan;await initial.handle({action:'restore',planId:q.id});}
 await initial.close();const ledger=join(dataDir,'managed-worktrees.json'),saved=JSON.parse(await readFile(ledger)),device=saved.root.dev;
 for(const id of identityPaths(saved))id.dev=String(BigInt(device)+100n);
 const bytes=Buffer.from(JSON.stringify(saved));await writeFile(ledger,bytes);
 const f={dir,project,dataDir,record,ledger,saved,bytes,device,raw,time:Date.now(),held:0,identityCalls:0};
 const readIdentities=async({paths,signal})=>{f.identityCalls++;await f.identityHook?.(paths,signal);signal?.throwIfAborted();return Promise.all(paths.map(async path=>({ino:String((await lstat(path,{bigint:true})).ino),volumeUUID:f.volume??volumeUUID})));};
 const reserveMutation=async resolvePaths=>{assert.equal(f.held,0);f.held++;try{const paths=await resolvePaths();assert(paths.includes(project));assert(paths.includes(record.cwd));await f.reservationHook?.(paths);}catch(e){f.held--;throw e;}return {release(){f.held--;},async revalidateScope(){await f.leaseHook?.();}};};
 f.make=()=>new ManagedWorktrees({dataDir,now:()=>f.time,readIdentities,reserveMutation});f.owner=f.make();f.prepare=()=>f.owner.handle({action:'prepareReconnect'});f.commit=id=>f.owner.handle({action:'commitReconnect',planId:id});f.close=()=>f.owner.close();
 return f;
}
const tests=[];const test=(name,run)=>tests.push({name,run});
test('prepare',async()=>{
 const f=await fixture();try{const inventory=await f.owner.handle({action:'list'});assert.equal(inventory.readOnly,true);assert.equal(inventory.reconnectAvailable,true);assert.equal(inventory.busy,false);const {plan}=await f.prepare();assert.equal(plan.operation,'reconnect');assert.equal(plan.ledgerSHA256,hash(f.bytes));assert.equal(plan.historicalContinuity,false);assert.equal(plan.records.length,1);assert.equal(plan.records[0].id,f.record.id);assert.equal(plan.expiresAt,f.time+120000);assert(plan.bindings.some(b=>b.path===join(f.dataDir,'Worktrees')&&b.before.dev!==b.after.dev&&b.after.volumeUUID===volumeUUID));assert.deepEqual(await readFile(f.ledger),f.bytes);assert.equal(f.owner.loaded,false);assert.equal(f.held,1);await assert.rejects(f.owner.handle({action:'resolve',id:f.record.id}));await f.owner.stop();assert.equal(f.held,0);assert.deepEqual(await readFile(f.ledger),f.bytes);}finally{await f.close();}
});
test('commit',async()=>{
 const f=await fixture({archive:true});try{const beforeFile=await readFile(join(f.record.cwd,'file.txt')),index=await readFile(join(f.saved.records[0].admin,'index')),gitConfig=await readFile(join(f.project,'.git/config'));const {plan}=await f.prepare();const result=await f.commit(plan.id);assert.equal(result.reconnected,true);assert.equal(f.held,0);assert.deepEqual(await readFile(result.backupPath),f.bytes);const saved=JSON.parse(await readFile(f.ledger));assert.deepEqual(withoutDevice(saved),withoutDevice(f.saved));assert(identityPaths(saved).every(id=>id.dev===f.device));assert.deepEqual(await readFile(join(f.record.cwd,'file.txt')),beforeFile);assert.deepEqual(await readFile(join(f.saved.records[0].admin,'index')),index);assert.deepEqual(await readFile(join(f.project,'.git/config')),gitConfig);assert.equal(await readFile(join(f.record.cwd,'draft.txt'),'utf8'),'UNTRACKED\n');const receipt=JSON.parse(await readFile(result.receiptPath));assert.equal(receipt.ledgerSHA256,hash(f.bytes));assert.equal(receipt.nextSHA256,hash(await readFile(f.ledger)));assert.equal(receipt.historicalContinuity,false);await assert.rejects(f.commit(plan.id),/plan|consumed|loaded/i);await f.close();f.owner=f.make();const listed=await f.owner.handle({action:'list'});assert.equal(listed.worktrees[0].state,'ready');const resolved=await f.owner.handle({action:'resolve',id:f.record.id});assert.equal(resolved.worktree.cwd,f.record.cwd);assert.equal(resolved.worktree.dirty,true);}finally{await f.close();}
});
test('changes-consume',async()=>{
 for(const change of ['content','index','source-index','ledger','volume','pointer']){const f=await fixture();try{const {plan}=await f.prepare();if(change==='content')await writeFile(join(f.record.cwd,'file.txt'),'CHANGED AFTER REVIEW\n');if(change==='index')await writeFile(join(f.saved.records[0].admin,'index'),Buffer.from('bad index'));if(change==='source-index'){await writeFile(join(f.project,'file.txt'),'STAGED BEFORE REVIEW\n');await f.raw(['-C',f.project,'add','file.txt']);await writeFile(join(f.project,'file.txt'),'BASE\n');}if(change==='ledger'){await rename(f.ledger,f.ledger+'.prior');await writeFile(f.ledger,f.bytes,{mode:0o600});}if(change==='volume')f.volume='BA5786BC-3563-4A7A-865E-A1E8A7805C94';if(change==='pointer')await writeFile(join(f.record.cwd,'.git'),'gitdir: /not-the-reviewed-admin\n');await assert.rejects(f.commit(plan.id),/changed|identity|index|link|ledger|review/i,change);assert.deepEqual(await readFile(f.ledger),f.bytes);assert.equal(f.held,0);await assert.rejects(f.commit(plan.id));}finally{await f.close();}}
});
test('ineligible',async()=>{
 for(const change of ['same-device','inode','nonready','v2','archive-incomplete']){const f=await fixture();try{const data=structuredClone(f.saved);if(change==='same-device')for(const id of identityPaths(data))id.dev=f.device;if(change==='inode')data.root.ino=String(BigInt(data.root.ino)+1n);if(change==='nonready')data.records[0].state='creating';if(change==='v2'){data.version=2;data.handoffs=[];}if(change==='archive-incomplete')data.records[0].archive={id:'847c7b18-80f4-48fa-ac6f-efa813baded7',head:data.records[0].commit,phase:'restored'};const bytes=Buffer.from(JSON.stringify(data));await writeFile(f.ledger,bytes);await assert.rejects(f.prepare(),/legacy|reconnect|changed|identity|archive|ready|record/i,change);assert.deepEqual(await readFile(f.ledger),bytes);assert.equal(f.held,0);}finally{await f.close();}}
});
test('expiry-stop',async()=>{
 for(const action of ['expiry','stop']){const f=await fixture();try{const {plan}=await f.prepare();if(action==='expiry')f.time+=120001;else await f.owner.stop();await assert.rejects(f.commit(plan.id),/expired|consumed|stopped|plan/i);assert.deepEqual(await readFile(f.ledger),f.bytes);assert.equal(f.held,0);}finally{await f.close();}}
});
test('stop-inspection',async()=>{
 const f=await fixture(),entered=deferred(),release=deferred();try{let aborted=false;f.identityHook=async(paths,signal)=>{signal.addEventListener('abort',()=>{aborted=true;},{once:true});entered.resolve();await release.promise;};const pending=f.prepare(),rejected=assert.rejects(pending,/abort|cancel|stop/i);await entered.promise;let stopped=false;const stopping=f.owner.stop().then(()=>{stopped=true;});await new Promise(r=>setImmediate(r));assert.equal(aborted,true);assert.equal(stopped,false);release.resolve();await rejected;await stopping;assert.equal(f.held,0);assert.deepEqual(await readFile(f.ledger),f.bytes);}finally{release.resolve();await f.close();}
});
test('reentrant-admission-stop',async()=>{
 const f=await fixture(),entered=deferred();let drained=false,timer;
 try{
  // CodingOwners.reserveProjectMutation resolves repository scope after resolvePaths.
  // With an observed isolated workspace, GitWorkflow.repository re-enters this admission.
  f.reservationHook=async paths=>{const admission=f.owner.assertProject(paths[0]);entered.resolve();await admission;};
  const preparing=f.prepare(),outcome=preparing.then(value=>({value}),error=>({error}));await entered.promise;
  const stopping=f.owner.stop();const done=Promise.all([outcome,stopping]);
  const result=await Promise.race([done,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);
  assert(result,'Reentrant project admission deadlocked behind reconnect ledger queue; Stop did not drain within 1500 ms.');drained=true;
  assert(result[0].error,'Reentrant admission must refuse instead of granting reconnect authority.');assert.match(result[0].error.message,/reconnect|busy|cancel|stop/i);assert.equal(result[1].stopped,true);assert.equal(f.held,0);assert.deepEqual(await readFile(f.ledger),f.bytes);assert.equal(f.owner.loaded,false);assert.equal(f.owner.plans.size,0);
 }finally{clearTimeout(timer);if(drained)await f.close();}
});
test('marker',async()=>{
 const f=await fixture();try{await writeFile(f.ledger+'.reconnect','unconfirmed publication',{mode:0o600});await assert.rejects(f.prepare(),/reconnect|unresolved|inspection/i);await assert.rejects(f.owner.handle({action:'list'}),/reconnect|unresolved|inspection/i);assert.deepEqual(await readFile(f.ledger),f.bytes);}finally{await f.close();}
});
test('publication-failure',async()=>{
 for(const afterRename of [false,true]){const f=await fixture(),original=fs.promises.rename;try{const {plan}=await f.prepare();fs.promises.rename=async(from,to)=>{if(to!==f.ledger)return original(from,to);if(afterRename)await original(from,to);throw Error('Injected reconnect rename reply failure');};syncBuiltinESMExports();await assert.rejects(f.commit(plan.id),/persistence.*unconfirmed/i);const saved=JSON.parse(await readFile(f.ledger));assert.deepEqual(withoutDevice(saved),withoutDevice(f.saved));assert.equal(saved.root.dev,afterRename?f.device:f.saved.root.dev);const marker=JSON.parse(await readFile(f.ledger+'.reconnect'));assert.deepEqual(await readFile(marker.backupPath),f.bytes);assert.equal(await readFile(join(f.record.cwd,'file.txt'),'utf8'),'RETAINED DIRTY\n');assert.equal((await f.owner.stop()).stopped,false);await f.close();f.owner=f.make();await assert.rejects(f.owner.handle({action:'list'}),/unresolved|reconnect/i);await assert.rejects(f.prepare(),/unresolved|reconnect/i);}finally{fs.promises.rename=original;syncBuiltinESMExports();await f.close();}}
});
test('stop-publication',async()=>{
 const f=await fixture(),original=fs.promises.rename,entered=deferred(),release=deferred();try{const {plan}=await f.prepare();fs.promises.rename=async(from,to)=>{const result=await original(from,to);if(to===f.ledger){entered.resolve();await release.promise;}return result;};syncBuiltinESMExports();const committing=f.commit(plan.id);await entered.promise;let stopped=false;const stopping=f.owner.stop().then(result=>{stopped=true;return result;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);release.resolve();const result=await committing;assert.equal(result.reconnected,true);assert.equal((await stopping).stopped,true);assert.deepEqual(await readFile(result.backupPath),f.bytes);assert.equal(JSON.parse(await readFile(result.receiptPath)).published,true);await assert.rejects(readFile(f.ledger+'.reconnect'),{code:'ENOENT'});assert.equal(f.held,0);await assert.rejects(f.commit(plan.id));}finally{release.resolve();fs.promises.rename=original;syncBuiltinESMExports();await f.close();}
});
const selected=process.env.RECONNECT_CASE;let failures=0;
for(const test of tests.filter(t=>!selected||t.name===selected)){try{await test.run();console.log('PASS '+test.name);}catch(error){failures++;console.error('FAIL '+test.name+'\n'+error.stack);}}
assert(!selected||tests.some(t=>t.name===selected),'Unknown RECONNECT_CASE');
console.log(JSON.stringify({root,checks:tests.filter(t=>!selected||t.name===selected).length,failures,passed:failures===0}));process.exitCode=failures?1:0;
