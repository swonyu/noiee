import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,lstat,rename,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {ManagedWorktrees} from './managed-worktrees.mjs';

const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-admission-'))),source=join(root,'source'),dataDir=join(root,'data'),exec=promisify(execFile),tests=[];
const git=async(...args)=>exec('/Applications/Xcode.app/Contents/Developer/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{env:{HOME:root,PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}});
const check=async(name,fn)=>{await fn();tests.push(name);console.log('PASS '+name);};
await mkdir(source);await git('init','-b','main',source);await writeFile(join(source,'file'),'base\n');await git('-C',source,'add','.');await git('-C',source,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','base');
let manager=new ManagedWorktrees({dataDir});
try{
  const plan=(await manager.handle({action:'prepare',cwd:source,ref:'HEAD'})).plan,record=(await manager.handle({action:'create',planId:plan.id})).worktree;
  const paths=await Promise.all([source,record.cwd].map(async path=>{const s=await lstat(path,{bigint:true});return {path,identity:{dev:String(s.dev),ino:String(s.ino)}};}));
  manager.handoffs=[{id:randomUUID(),worktreeId:record.id,rootThreadId:'root',source,destination:record.cwd,paths,phase:'preparing',state:'pending',message:'Disposable retained handoff.',createdAt:1,updatedAt:1,recovery:null}];await manager.save();await manager.close();manager=new ManagedWorktrees({dataDir});
  await check('new registered peer and its subdirectory stay fenced after restart',async()=>{
    const peer=join(root,'late-peer');await git('-C',source,'worktree','add','--detach',peer,'HEAD');await mkdir(join(peer,'nested'));
    for(const cwd of [peer,join(peer,'nested')])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});
  });
  await check('unregistered copied Git pointer and relative commondir stay fenced',async()=>{
    const peer=join(root,'unregistered'),admin=join(root,'unregistered-admin');await mkdir(peer);await mkdir(admin);await mkdir(join(peer,'nested'));await writeFile(join(peer,'.git'),'gitdir: ../unregistered-admin\n');await writeFile(join(admin,'commondir'),'../source/.git\n');
    for(const cwd of [peer,join(peer,'nested')])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});
    await rename(source,source+'-moved');await writeFile(join(admin,'commondir'),'../source-moved/.git\n');await assert.rejects(manager.assertProject(peer),{code:'HANDOFF_PENDING'});await rename(source+'-moved',source);
  });
  await check('unrelated projects pass; malformed, symbolic and FIFO Git pointers reject',async()=>{
    const ordinary=join(root,'ordinary');await mkdir(ordinary);await manager.assertProject(ordinary);
    for(const kind of ['malformed','symbolic','fifo','oversize']){
      const cwd=join(root,kind);await mkdir(cwd);const path=join(cwd,'.git');
      if(kind==='symbolic')await symlink(join(source,'.git'),path);else if(kind==='fifo')await exec('/usr/bin/mkfifo',[path]);else await writeFile(path,kind==='oversize'?'x'.repeat(8193):'not a git pointer\n');
      await assert.rejects(manager.assertProject(cwd));
    }
  });
  await check('generic command admission loads and rejects durable recovery',async()=>{await assert.rejects(manager.reserveCommand(),/handoff/i);});
  await check('unrelated Git repositories pass and changing pointers reject before admission',async()=>{
    const repo=join(root,'other-repo'),peer=join(root,'other-peer');await mkdir(repo);await git('init','-b','main',repo);await writeFile(join(repo,'file'),'other');await git('-C',repo,'add','.');await git('-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','other');await git('-C',repo,'worktree','add','--detach',peer,'HEAD');await mkdir(join(peer,'nested'));await manager.assertProject(join(peer,'nested'));
    const pointer=join(peer,'.git'),before=await readFile(pointer),original=manager.assertNoHandoff.bind(manager);let changed=false;
    manager.assertNoHandoff=async paths=>{await original(paths);if(paths.length>1&&!changed){changed=true;await rename(pointer,pointer+'.old');await writeFile(pointer,before);}};
    try{await assert.rejects(manager.assertProject(peer),/changed/i);assert(changed);}finally{manager.assertNoHandoff=original;}
  });
  // Clearing only our synthetic, never-executed descriptor isolates occupancy checks.
  manager.handoffs=[];await manager.save();
  await check('preparation fences new and unregistered peers before its first wait, while unrelated activity passes',async()=>{
    const peer=join(root,'preparation-peer'),admin=join(root,'preparation-admin'),ordinary=join(root,'preparation-other');await mkdir(peer);await mkdir(admin);await mkdir(ordinary);await writeFile(join(peer,'.git'),'gitdir: ../preparation-admin\n');await writeFile(join(admin,'commondir'),'../source/.git\n');
    let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),expire=manager.expirePlans.bind(manager),original=manager.assertNoHandoff.bind(manager);
    manager.coding={prepareHandoff:async()=>{throw new Error('fixture preparation ended');}};manager.expirePlans=async()=>{entered();await gate;return expire();};
    const pending=manager.handle({action:'prepareHandoff',id:record.id,threadId:'root'}),rejected=assert.rejects(pending,/fixture preparation ended/);await started;
    try{for(const cwd of [source,record.cwd,peer,join(root,'late-peer')])await assert.rejects(manager.assertProject(cwd),{code:'HANDOFF_PENDING'});
      let changed=false;manager.assertNoHandoff=async(...args)=>{await original(...args);if(args[0].length!==1&&!changed){changed=true;await mkdir(join(root,'unrelated-sibling'));}};
      await manager.assertProject(ordinary);assert(changed,'Exercise ancestor directory mutation during an unrelated admission');
    }finally{manager.assertNoHandoff=original;release();await rejected;manager.expirePlans=expire;}
    await manager.assertProject(peer);await manager.assertProject(source);assert.equal(manager.handoffAdmission,null);
  });
  await check('acquisition includes engine-owned unregistered peers and excludes unrelated repositories',async()=>{
    const peer=join(root,'preparation-peer'),other=join(root,'other-peer'),original=manager.reserveMutation;let paths;
    manager.coding={prepareHandoff:async()=>({cwd:source}),projectMutationInventory:async()=>[peer,other]};
    manager.reserveMutation=async resolve=>{paths=await resolve();throw Object.assign(new Error('fixture selected owner busy'),{code:'PROJECT_BUSY'});};
    try{await assert.rejects(manager.handle({action:'prepareHandoff',id:record.id,threadId:'root'}),{code:'PROJECT_BUSY'});assert(paths.includes(peer),'Unregistered owned repository must join the lease');assert(!paths.includes(other),'Unrelated owned Coding must stay outside the selected lease');assert.equal(manager.handoffAdmission,null);await manager.assertProject(peer);}finally{manager.reserveMutation=original;}
  });
  await check('command occupancy excludes handoff and survives manager Stop',async()=>{
    const lease=await manager.reserveCommand();await assert.rejects(manager.reserveCommand(),/command|busy/i);await assert.rejects(manager.exclusive(epoch=>manager.prepareHandoff(record.id,'root',epoch)),/command/i);
    await manager.stop();await assert.rejects(manager.reserveCommand(),/command|busy/i);lease.release();lease.release();const next=await manager.reserveCommand();next.release();
  });
  await check('command reservation and preparing operation exclude each other without an await gap',async()=>{
    const command=manager.reserveCommand();await assert.rejects(manager.handle({action:'prepareHandoff',id:record.id,threadId:'root'}),/command/i);(await command).release();
    let entered,release;const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r),operation=manager.exclusive(async()=>{entered();await gate;});await start;await assert.rejects(manager.reserveCommand(),/busy|operation/i);release();await operation;
    manager.plans.set('review',{operation:'handoff'});await assert.rejects(manager.reserveCommand(),/handoff/i);manager.plans.delete('review');
    const load=manager.load.bind(manager);let enteredLoad,allowLoad;const loading=new Promise(r=>enteredLoad=r),wait=new Promise(r=>allowLoad=r);
    manager.load=async()=>{await load();enteredLoad();await wait;};const pending=manager.reserveCommand();await loading;await manager.stop();allowLoad();await assert.rejects(pending,/cancelled/i);manager.load=load;const recovered=await manager.reserveCommand();recovered.release();
  });
  await check('public handoff routes accept only owned identifiers and exact shapes',async()=>{
    for(const input of [{action:'prepareHandoff',id:record.id,threadId:'../bad'},{action:'prepareHandoff',id:record.id,threadId:'root',destination:source},{action:'handoff',planId:'bad'}])await assert.rejects(manager.handle(input));
    const prepare=manager.prepareHandoff,execute=manager.executeHandoff;
    manager.prepareHandoff=async(id,threadId,epoch)=>({plan:{id,threadId,epoch}});manager.executeHandoff=async(planId,epoch)=>({planId,epoch});
    try{assert.equal((await manager.handle({action:'prepareHandoff',id:record.id,threadId:'root'})).plan.threadId,'root');assert.equal((await manager.handle({action:'handoff',planId:record.id})).planId,record.id);}finally{manager.prepareHandoff=prepare;manager.executeHandoff=execute;}
  });
  await writeFile(join(root,'evidence.json'),JSON.stringify({passed:tests.length,tests,ledger:JSON.parse(await readFile(manager.ledger,'utf8'))},null,2));console.log(JSON.stringify({passed:tests.length,root}));
}finally{await manager.close();}
