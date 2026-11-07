// Actual native workers, disposable projects only. No VM, model, install or live ledger access.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,open,lstat,readFile,writeFile,readdir,realpath,chmod,symlink,link} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {verifyHandoffHelper,releaseHandoffProcess} from './handoff-process.mjs';

const source=dirname(fileURLToPath(import.meta.url)),home=await realpath(await mkdtemp(join(tmpdir(),'guest-publication-')));
const helper=join(home,'native'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const evidence={home,passed:false,cases:[],workers:[],commands:[]};
let helperIdentity;
async function durable(path,value){
  const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function bounded(work,label,ms=10000){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timeout: '+label)),ms);})]);}finally{clearTimeout(timer);}}
function command(file,args){
  const r=spawnSync(file,args,{cwd:home,env:{PATH:'/usr/bin:/bin',LANG:'C',HOME:home},encoding:'utf8',timeout:120000,maxBuffer:65536});
  evidence.commands.push({file,args,code:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:r.error?.message});
  assert.equal(r.status,0,r.error?.message??r.stderr);assert.equal(r.signal,null);return r.stdout;
}
async function native(action,input,{signal,record=async()=>{}}={}){
  if(signal?.aborted)throw Error('Stopped before native admission.');
  helperIdentity=await verifyHandoffHelper(helper,helperIdentity);
  if(signal?.aborted)throw Error('Stopped before native launch.');
  const body=JSON.stringify(input),limit=8*1024*1024;assert(Buffer.byteLength(body)<=limit);
  const nonce=['copy','materialize','publish'].includes(action)?randomUUID():null;
  const child=spawn(helper,nonce?['--handoff-process','files',nonce,action]:['--handoff-files',action],{
    cwd:'/private/var/empty',env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',HOME:home},detached:true,
    stdio:nonce?['pipe','pipe','pipe','pipe','pipe']:['pipe','pipe','pipe']
  });
  const row={action,pid:child.pid,requestSHA256:sha(body),closed:false};evidence.workers.push(row);
  let failure,recordWork,cancelled=false,outBytes=0,errBytes=0;const out=[],err=[],aborted=deferred();
  const cancel=()=>{cancelled=true;aborted.resolve(Error('Stopped.'));child.stdin.destroy();child.stdio[4]?.destroy();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');};
  const closure=new Promise(resolve=>{
    child.once('error',error=>{failure??=error;cancel();});
    child.once('close',(code,signal)=>{Object.assign(row,{closed:true,code,signal});resolve();});
  });
  child.stdin.on('error',()=>{});child.stdio[4]?.on('error',()=>{});
  child.stdout.on('data',bytes=>{outBytes+=bytes.length;if(outBytes>limit){failure??=Error('Native output overflow.');cancel();}else out.push(bytes);});
  child.stderr.on('data',bytes=>{errBytes+=bytes.length;if(errBytes>65536){failure??=Error('Native diagnostics overflow.');cancel();}else err.push(bytes);});
  signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const timer=setTimeout(()=>{failure??=Error('Native helper timeout.');cancel();},20000);
  const active=()=>{if(cancelled||row.closed||child.exitCode!==null||child.signalCode!==null)throw Error('Native operation is no longer active.');};
  try{
    try{
      if(nonce)await releaseHandoffProcess(child,nonce,{check:active,abort:aborted.promise,record:receipt=>{
        row.process=receipt;recordWork=(async()=>{await durable(join(home,nonce+'-process.json'),receipt);await record(receipt);row.recordSettled=true;})();return recordWork;
      }});
      active();child.stdin.end(body);
    }catch(error){failure??=error;cancel();}
    await bounded(closure,'native closure',25000);
    try{await recordWork;}catch(error){failure??=error;}
    try{process.kill(-child.pid,0);throw Error('Native worker group remains present.');}catch(error){if(error.code!=='ESRCH')throw error;}
    row.groupAbsent=true;if(failure)throw failure;
    const diagnostics=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(err));
    if(diagnostics)row.diagnostics=diagnostics;
    if(cancelled||row.code!==0||row.signal)throw Error(diagnostics||'Native operation cancelled.');
    await verifyHandoffHelper(helper,helperIdentity);
    const receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(out)));row.receiptSHA256=sha(JSON.stringify(receipt));return receipt;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
async function descriptor(path){const s=await lstat(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)};}
async function folder(name){const path=join(home,name);await mkdir(path,{mode:0o700});return path;}
const payload=bytes=>{bytes=Buffer.from(bytes);return {data:bytes.toString('base64'),bytes:bytes.length,sha256:sha(bytes)};};
try{
  await writeFile(join(home,'main.swift'),'import Foundation\nimport Darwin\nif CommandLine.arguments[1] == "--handoff-process" { exit(HandoffProcess.command(CommandLine.arguments)) }\nexit(HandoffFiles.command(CommandLine.arguments))\n');
  command('/usr/bin/xcrun',['swiftc','-O',...['CodingTemporary.swift','HandoffFiles.swift','HandoffProcess.swift','GuestDiskDisposal.swift'].map(n=>join(source,n)),join(home,'main.swift'),'-o',helper]);
  evidence.helperSHA256=sha(await readFile(helper));
  const inventoryRoot=await folder('inventory');
  await mkdir(join(inventoryRoot,'folder'));await mkdir(join(inventoryRoot,'empty'));await mkdir(join(inventoryRoot,'.git'));
  await writeFile(join(inventoryRoot,'.git','secret'),'not selected');await writeFile(join(inventoryRoot,'folder','file'),'selected');
  await mkdir(join(inventoryRoot,'scratch'));await writeFile(join(inventoryRoot,'scratch','retained'),'excluded');
  await symlink('../outside',join(inventoryRoot,'literal'));await link(join(inventoryRoot,'folder','file'),join(inventoryRoot,'hardlink'));
  const request={root:await descriptor(inventoryRoot),exclude:['scratch']};
  const inventory=await native('inventory',request);
  assert.deepEqual(Object.keys(inventory.stamps).sort(),['empty','folder','folder/file','hardlink','literal']);
  assert.deepEqual(Object.keys(inventory.excluded).sort(),['.git','scratch']);
  assert.equal(inventory.stamps.literal.targetBase64,Buffer.from('../outside').toString('base64'));
  assert.deepEqual(inventory,await native('inventory',request));
  await assert.rejects(native('inventory',{...request,exclude:['../outside']}),/path|exclu/i);
  for(const exclude of [['a'.repeat(4097)], [Array(65).fill('a').join('/')], ['scratch','scratch/child'], ['scratch','SCRATCH']])await assert.rejects(native('inventory',{...request,exclude}),/path|exclu|alias/i);
  const fifo=join(inventoryRoot,'fifo');command('/usr/bin/mkfifo',[fifo]);
  await assert.rejects(native('inventory',request),/Special filesystem/);
  evidence.cases.push('descriptor inventory includes directories, complete hardlinks and literal links; excludes .git and explicit scratch; refuses traversal and special files');
  if(!process.argv.includes('--inventory-only')){
    const modulePath=join(source,'guest-publication.mjs');
    assert(await lstat(modulePath).catch(()=>null),'Guest publication implementation is missing.');
    const {captureGuestPublication,publishGuestChanges}=await import(pathToFileURL(modulePath));
    if(process.argv.includes('--metadata-only')){
      const live=await folder('metadata-bound-live'),directory=await folder('metadata-bound-work');
      const long='\u0001'.repeat(230),names=Array.from({length:4300},(_,i)=>String(i).padStart(5,'0')+'-'+long);
      for(let i=0;i<names.length;i+=100)await Promise.all(names.slice(i,i+100).map(name=>writeFile(join(live,name),'')));
      const checkpoint=async(name,value)=>durable(join(directory,name+'.json'),value);
      const baseline=await captureGuestPublication({root:await descriptor(live),directory,native,checkpoint,check:()=>{}}),start=evidence.workers.length;
      await assert.rejects(publishGuestChanges({baseline,changes:Array.from({length:2000},(_,i)=>({path:'new-'+i,kind:'file',...payload('')})),native,checkpoint,check:()=>{}}),/metadata|receipt|inventory/i);
      assert(!evidence.workers.slice(start).some(w=>w.action==='publish'),'complete inventory metadata overflow must be refused before publication');
      assert.equal((await readdir(live)).length,4300);evidence.cases.push('final complete inventory metadata overflow refused before publication');
    }else if(process.argv.includes('--bounds-only')){
      if(!process.argv.includes('--receipt-only')){
      const live=await folder('byte-bound-live'),directory=await folder('byte-bound-work');
      const block=Buffer.alloc(24*1024*1024,97);for(let i=0;i<4;i++)await writeFile(join(live,'old-'+i),block);
      const checkpoint=async(name,value)=>durable(join(directory,name+'.json'),value);
      const baseline=await captureGuestPublication({root:await descriptor(live),directory,native,checkpoint,check:()=>{}});
      const start=evidence.workers.length;
      await assert.rejects(publishGuestChanges({baseline,changes:[{path:'added32',kind:'file',...payload(Buffer.alloc(32*1024*1024,98))},{path:'added1',kind:'file',...payload(Buffer.alloc(1024*1024,99))}],native,checkpoint,check:()=>{}}),/byte|MiB/i);
      assert(!evidence.workers.slice(start).some(w=>w.action==='publish'),'final live byte overflow must be refused BEFORE native publication');
      assert.deepEqual((await readdir(live)).sort(),['old-0','old-1','old-2','old-3']);
      evidence.cases.push('129 MiB final live tree refused before publication, original namespace intact');

      const nativeWork=await folder('native-byte-bound-work'),nativeCheckpoint=async(name,value)=>durable(join(nativeWork,name+'.json'),value);
      const nativeBaseline=await captureGuestPublication({root:await descriptor(live),directory:nativeWork,native,checkpoint:nativeCheckpoint,check:()=>{}});
      const original=JSON.parse(await readFile(join(nativeWork,'baseline.json'),'utf8')).original;
      const remaining=128*1024*1024-original.bytes,nativeStart=evidence.workers.length;
      await assert.rejects(publishGuestChanges({baseline:nativeBaseline,changes:[{path:'fills-budget',kind:'file',...payload(Buffer.alloc(remaining,100))}],native,checkpoint:nativeCheckpoint,check:()=>{}}),/final native bytes/);
      assert(!evidence.workers.slice(nativeStart).some(w=>w.action==='publish'));assert.equal((await readdir(live)).length,4);
      evidence.cases.push('synthesized native provenance counts toward final live bytes before publication');

      const countLive=await folder('count-bound-live'),countWork=await folder('count-bound-work'),exclude=Array.from({length:19999},(_,i)=>'opaque-'+String(i).padStart(5,'0'));
      for(let i=0;i<exclude.length;i+=100)await Promise.all(exclude.slice(i,i+100).map(name=>writeFile(join(countLive,name),'')));
      await writeFile(join(countLive,'selected'),'before');
      const countCheckpoint=async(name,value)=>durable(join(countWork,name+'.json'),value);
      const countBaseline=await captureGuestPublication({root:await descriptor(countLive),exclude,directory:countWork,native,checkpoint:countCheckpoint,check:()=>{}}),countStart=evidence.workers.length;
      await assert.rejects(publishGuestChanges({baseline:countBaseline,changes:[{path:'new',kind:'file',...payload('after')}],native,checkpoint:countCheckpoint,check:()=>{}}),/entr|count/i);
      assert(!evidence.workers.slice(countStart).some(w=>w.action==='publish'));assert.equal((await readdir(countLive)).length,20000);
      evidence.cases.push('complete namespace count includes opaque exclusions and refuses entry 20001 before publication');
      }

      const receiptLive=await folder('receipt-bound-live'),receiptWork=await folder('receipt-bound-work');
      const receiptCheckpoint=async(name,value)=>durable(join(receiptWork,name+'.json'),value);
      const receiptBaseline=await captureGuestPublication({root:await descriptor(receiptLive),directory:receiptWork,native,checkpoint:receiptCheckpoint,check:()=>{}});
      // Control characters are valid filesystem names and expand sixfold in JSON.
      const long='\u0001'.repeat(230),directories=Array.from({length:2500},(_,i)=>({path:String(i).padStart(5,'0')+'-'+long,kind:'directory'}));
      await assert.rejects(publishGuestChanges({baseline:receiptBaseline,changes:directories,native,checkpoint:receiptCheckpoint,check:()=>{}}),/receipt.*(?:limit|bound|exceeds)/i);
      const liveCount=(await readdir(receiptLive)).length;evidence.receiptLiveCount=liveCount;
      assert.equal(liveCount,0,'oversized receipt refused before the first host effect');
      evidence.cases.push('large directory publication receipt refused before first host effect');
    }else{
    const live=await folder('live'),directory=await folder('publication');
    await mkdir(join(live,'src'));await mkdir(join(live,'.git'));
    await writeFile(join(live,'.git','retained'),'git stays');
    const old='#include <stdio.h>\nint main(void){puts("BEFORE");return 0;}\n',next=old.replace('BEFORE','GUEST_VISIBLE');
    await writeFile(join(live,'src','answer.c'),old);await writeFile(join(live,'run.sh'),'#!/bin/sh\nexec "$1"\n');await chmod(join(live,'run.sh'),0o644);
    await writeFile(join(live,'remove.txt'),'captured');await writeFile(join(live,'linked-a'),'before links');await link(join(live,'linked-a'),join(live,'linked-b'));
    await symlink('src/answer.c',join(live,'existing-link'));command('/bin/chmod',['-h','755',join(live,'existing-link')]);
    command('/usr/bin/xattr',['-w','com.saleh.publisher','retain native metadata',join(live,'src','answer.c')]);
    const checkpoint=async(name,data)=>durable(join(directory,name+'.json'),data);
    const baseline=await captureGuestPublication({root:await descriptor(live),directory,native,checkpoint,check:()=>{}});
    const changes=[{path:'src/answer.c',kind:'file',...payload(next)},{path:'run.sh',kind:'file',mode:0o755},{path:'remove.txt',kind:'remove'},
      {path:'new',kind:'directory',mode:0o755},{path:'new/hello.txt',kind:'file',mode:0o644,...payload('hello')},{path:'new/link',kind:'symlink',mode:0o755,...payload('../src/answer.c')},
      {path:'linked-a',kind:'file',...payload('after links')},{path:'linked-b',kind:'file',...payload('after links')},{path:'existing-link',kind:'symlink',mode:0o700}];
    const result=await publishGuestChanges({baseline,changes,native,checkpoint,check:()=>{}});
    assert.equal(await readFile(join(live,'src','answer.c'),'utf8'),next);assert.equal((await lstat(join(live,'run.sh'))).mode&0o777,0o755);
    assert.equal(await readFile(join(live,'new','hello.txt'),'utf8'),'hello');assert.equal(await readFile(join(live,'.git','retained'),'utf8'),'git stays');
    assert.equal((await lstat(join(live,'new','link'))).mode&0o777,0o755);
    assert.equal((await lstat(join(live,'existing-link'))).mode&0o777,0o700);
    assert.equal((await lstat(join(live,'linked-a'))).ino,(await lstat(join(live,'linked-b'))).ino);
    assert.equal(await readFile(join(result.capture.root.path,result.receipt.captured['remove.txt']),'utf8'),'captured');
    const before=JSON.parse(await readFile(join(directory,'baseline.json'),'utf8'));
    assert.deepEqual(result.live.stamps['src/answer.c'].xattrs,before.original.stamps['src/answer.c'].xattrs);
    const executable=join(home,'answer');command('/usr/bin/clang',[join(live,'src','answer.c'),'-o',executable]);assert.equal(command(join(live,'run.sh'),[executable]),'GUEST_VISIBLE\n');
    await assert.rejects(publishGuestChanges({baseline,changes,native,checkpoint,check:()=>{}}),/consum|used/i);
    evidence.cases.push('actual guest payloads publish; visible source builds/runs, native metadata and hardlinks survive, mode/deletion/new directory/file/literal link and originals verified; replay refused');

    let sequence=0;
    async function prepared(setup=async()=>{},options={}){
      const suffix=++sequence,live=await folder('case-live-'+suffix),directory=await folder('case-work-'+suffix);
      await writeFile(join(live,'file'),'before');await setup(live);
      const root=await descriptor(live),checkpoint=async(name,value)=>durable(join(directory,name+'.json'),value);
      const baseline=await captureGuestPublication({root,directory,native,checkpoint,check:()=>{},...options});
      return {baseline,root,directory,live,checkpoint};
    }
    async function publish(f,changes,overrides={}){return publishGuestChanges({baseline:f.baseline,changes,native,checkpoint:f.checkpoint,check:()=>{},...overrides});}
    const edit={path:'file',kind:'file',...payload('after')};
    const conflict=await prepared();await writeFile(join(conflict.live,'file'),'HOST EDIT');
    const count=evidence.workers.length;await assert.rejects(publish(conflict,[edit]),/host changed/);
    assert.equal(await readFile(join(conflict.live,'file'),'utf8'),'HOST EDIT');assert(!evidence.workers.slice(count).some(w=>w.action==='publish'));
    const newPath=await prepared();await writeFile(join(newPath.live,'unrelated'),'host addition');await assert.rejects(publish(newPath,[edit]),/host changed/);
    const duringCopy=await folder('copy-conflict-live'),duringWork=await folder('copy-conflict-work');await writeFile(join(duringCopy,'file'),'before');
    await assert.rejects(captureGuestPublication({root:await descriptor(duringCopy),directory:duringWork,checkpoint:async()=>{},check:()=>{},native:async(action,input,opts)=>{
      const result=await native(action,input,opts);if(action==='copy')await writeFile(join(duringCopy,'late'),'host added during copy');return result;
    }}),/host changed while copying/);
    evidence.cases.push('host edit, new path and change during baseline copy refused; no publish worker admitted');

    const invalid=[
      [{...edit,path:'../outside'}], [{...edit,path:'.git/config'}], [{...edit,uid:0}], [{...edit,sha256:'0'.repeat(64)}],
      [{...edit,bytes:1}], [{...edit,data:edit.data+'!'}], [edit,edit], [{...edit,path:'FILE'}],
      [{...edit,path:'absent/child'}], [{path:'file',kind:'file',mode:0o4755}], [{path:'file',kind:'remove',data:''}],
      [{path:'file',kind:'symlink',...payload('a\0b')}], [{path:'__proto__',kind:'file',...payload('literal property')} ,{...edit,path:'constructor',gid:0}]
    ];
    for(const changes of invalid){const f=await prepared(),beforeCount=evidence.workers.length;await assert.rejects(publish(f,changes),/Guest publication:/);assert.equal(await readFile(join(f.live,'file'),'utf8'),'before');assert.equal(evidence.workers.length,beforeCount,'untrusted input rejected before native work');}
    const excluded=await prepared(async live=>{await mkdir(join(live,'ignored'));await writeFile(join(live,'ignored','keep'),'keep');},{exclude:['ignored','future']});
    await assert.rejects(publish(excluded,[{path:'future',kind:'directory'}]),/excluded/);
    const linked=await prepared(async live=>{await link(join(live,'file'),join(live,'alias'));});
    await assert.rejects(publish(linked,[edit]),/hardlink aliases/);assert.equal(await readFile(join(linked.live,'alias'),'utf8'),'before');
    const incomplete=await prepared(async live=>{await mkdir(join(live,'dir'));await writeFile(join(live,'dir','child'),'keep');});
    await assert.rejects(publish(incomplete,[{path:'dir',kind:'remove'}]),/directory ancestor|unselected/);
    evidence.cases.push('guest path/alias/metadata/payload/mode/ancestor/exclusion and divergent hardlink requests refused before native mutation');

    const topology=await prepared(async live=>{await link(join(live,'file'),join(live,'alias'));await mkdir(join(live,'dir'));await writeFile(join(live,'dir','child'),'child');});
    const topologyResult=await publish(topology,[{path:'alias',kind:'remove'},{path:'dir',kind:'file',...payload('replacement')},{path:'dir/child',kind:'remove'},
      {path:'__proto__',kind:'file',...payload('own property')},{path:'constructor',kind:'file',...payload('own constructor')}]);
    assert.equal(topologyResult.live.stamps.file.nlink,1);assert.equal(await readFile(join(topology.live,'dir'),'utf8'),'replacement');
    assert.equal(await readFile(join(topology.live,'__proto__'),'utf8'),'own property');assert.equal(await readFile(join(topology.live,'constructor'),'utf8'),'own constructor');
    assert.equal(Object.keys(topologyResult.receipt.captured).length,4);
    const noOp=await prepared(),noOpBefore=await native('inventory',{root:noOp.root,exclude:[]}),noOpCount=evidence.workers.length;
    assert.deepEqual(await publish(noOp,[]),{published:false,unchanged:true,live:{root:noOp.root,...noOpBefore}});
    assert(!evidence.workers.slice(noOpCount).some(w=>w.action==='publish'));
    evidence.cases.push('hardlink deletion retains survivor, complete directory replacement and literal object-key filenames publish; no-op avoids mutation');

    const {CodingEngine,CodingProjects}=await import('./coding-engine.mjs');const projects=new CodingProjects();
    async function owner(f){
      const dataDir=join(f.directory,'owner');await mkdir(dataDir,{mode:0o700});
      const engine=new CodingEngine({dataDir,projects,executor:{url:'ws://127.0.0.1:19999',authToken:'fixture-only',launch:{argv:['/fixture/codex'],cwd:'file:///private/var/empty',env:{}}}});
      const threadId=randomUUID();engine.child={};engine.processLife={child:engine.child};
      engine.threadInfo.set(threadId,{id:threadId,cwd:f.live,parentThreadId:null,status:{type:'idle'}});engine.verifiedThreads.add(threadId);
      engine.disposeProcess=async()=>{};engine.savePartialHistory=()=>{};
      return {engine,run:operation=>engine.runPublication({threadId,cwd:f.live,signal:new AbortController().signal,operation})};
    }
    const stopped=await prepared(),peer=await prepared(),A=await owner(stopped),B=await owner(peer);
    const entered=deferred(),release=deferred();let closed=false;
    const admitted=A.run(({signal,check})=>publish(stopped,[edit],{check,native:(action,input,opts)=>native(action,input,{signal:opts?.settle?undefined:signal,record:action==='publish'?async()=>{entered.resolve();await release.promise;}:undefined})})).catch(error=>error);
    await bounded(entered.promise,'publication process release');
    const closing=A.engine.close().then(()=>{closed=true;return null;},error=>error);
    try{
      const other=await B.run(({signal,check})=>publish(peer,[edit],{check,native:(action,input,opts)=>native(action,input,{signal:opts?.settle?undefined:signal})}));assert(other.published);
      assert.equal(closed,false);assert.equal(await readFile(join(stopped.live,'file'),'utf8'),'before');assert(A.engine.projectOccupied(stopped.live));
    }finally{release.resolve();}
    assert(await bounded(admitted,'stopped worker drain') instanceof Error);assert(await bounded(closing,'uncertain publication drain') instanceof Error);
    assert(A.engine.projectOccupied(stopped.live),'unconfirmed cancellation retains fence');await B.engine.close();
    evidence.cases.push('production engine Stop awaits actual gated publication worker and late durable callback; sibling publishes; uncertain cancellation retains fence');

    const after=await prepared(),C=await owner(after),outcomeEntered=deferred(),outcomeRelease=deferred();let afterClosed=false;
    const afterWork=C.run(({signal,check})=>publish(after,[edit],{check,native:(action,input,opts)=>native(action,input,{signal:opts?.settle?undefined:signal}),checkpoint:async(name,value)=>{
      if(name==='outcome'){outcomeEntered.resolve();await outcomeRelease.promise;}await after.checkpoint(name,value);
    }})).catch(error=>error);
    await bounded(outcomeEntered.promise,'durable outcome');const afterClose=C.engine.close().then(()=>{afterClosed=true;});
    try{await new Promise(r=>setImmediate(r));assert.equal(afterClosed,false);assert.equal(await readFile(join(after.live,'file'),'utf8'),'after');assert(C.engine.projectOccupied(after.live));}
    finally{outcomeRelease.resolve();}
    assert(await bounded(afterWork,'stale publication reply') instanceof Error);await bounded(afterClose,'durable outcome drain');
    assert.equal(JSON.parse(await readFile(join(after.directory,'outcome.json'),'utf8')).published,true);assert.equal(C.engine.admissions.size,0);
    evidence.cases.push('Stop after verified publication waits saved outcome; stale reply rejected and cleanly drained fence released');
    }
  }
  evidence.passed=true;
}catch(error){evidence.failure={message:error.message,stack:error.stack};throw error;}
finally{
  await writeFile(join(home,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({passed:evidence.passed,home,cases:evidence.cases.length,workers:evidence.workers.length,closed:evidence.workers.every(w=>w.closed&&w.groupAbsent)}));
}
