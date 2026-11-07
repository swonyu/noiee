// Disposable native/transport checks. No app install, model use or live-ledger access.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,realpath,writeFile,readFile,mkdir,lstat,link,symlink,rename,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const source=dirname(fileURLToPath(import.meta.url)),home=await realpath(await mkdtemp(join(tmpdir(),'guest-content-'))),helper=join(home,'native');
const sha=b=>createHash('sha256').update(b).digest('hex');
const evidence={home,passed:false,cases:[],workers:[]};
function run(file,args,input){
  const r=spawnSync(file,args,{input,encoding:'utf8',timeout:120000,maxBuffer:9*1024*1024,env:{PATH:'/usr/bin:/bin',HOME:home,LANG:'en_US.UTF-8'}});
  evidence.workers.push({file,args,code:r.status,signal:r.signal,error:r.error?.message,stderr:r.stderr});
  assert(!r.error,r.error?.message);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);return r.stdout;
}
const native=async(action,input)=>JSON.parse(run(helper,['--handoff-files',action],JSON.stringify(input)));
async function descriptor(path){const s=await lstat(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)};}
const chain=(inventory,path)=>Object.fromEntries(path.split('/').map((_,i,parts)=>{const p=parts.slice(0,i+1).join('/');return [p,inventory.stamps[p]];}));
try{
  await writeFile(join(home,'main.swift'),'import Foundation\nimport Darwin\nexit(HandoffFiles.command(CommandLine.arguments))\n');
  run('/usr/bin/xcrun',['swiftc','-O',join(source,'CodingTemporary.swift'),join(source,'HandoffFiles.swift'),join(home,'main.swift'),'-o',helper]);
  evidence.helperSHA256=sha(await readFile(helper));
  const tree=join(home,'tree');await mkdir(tree,{mode:0o700});await mkdir(join(tree,'dir'));
  const bytes=Buffer.alloc(600001);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  await writeFile(join(tree,'dir','file'),bytes);await link(join(tree,'dir','file'),join(tree,'alias'));await writeFile(join(tree,'empty'),'');
  const root=await descriptor(tree),inventory=await native('inventory',{root,exclude:[]});
  const request={root,rootStamp:inventory.rootStamp,path:'dir/file',stamps:chain(inventory,'dir/file'),offset:0,length:262144};
  const parts=[];
  for(let offset=0;offset<bytes.length;offset+=262144){
    const result=await native('readContent',{...request,offset});
    assert.deepEqual(Object.keys(result).sort(),['bytes','data','offset','path','sha256']);
    const chunk=Buffer.from(result.data,'base64');assert.equal(chunk.toString('base64'),result.data);
    assert.equal(result.path,request.path);assert.equal(result.offset,offset);assert.equal(result.bytes,chunk.length);assert.equal(result.sha256,sha(chunk));
    assert.deepEqual(chunk,bytes.subarray(offset,offset+262144));parts.push(chunk);
  }
  assert.equal(sha(Buffer.concat(parts)),inventory.stamps['dir/file'].sha256);
  const empty=await native('readContent',{...request,path:'empty',stamps:chain(inventory,'empty')});assert.equal(empty.bytes,0);assert.equal(empty.data,'');
  evidence.cases.push('binary chunk sequence, final partial chunk, empty file and reviewed hardlink alias');
  for(const extra of [{offset:true},{length:true},{offset:-1},{offset:bytes.length+1},{length:0},{length:262145},{offset:0.5},{length:1.5},{extra:1},{path:'../file'},{stamps:{...request.stamps,empty:inventory.stamps.empty}}]){
    await assert.rejects(native('readContent',{...request,...extra}));
  }
  evidence.cases.push('invalid integer types, ranges, paths and extra selection rejected');
  await chmod(join(tree,'dir','file'),0o755);await assert.rejects(native('readContent',request));
  const changed=await native('inventory',{root,exclude:[]}),fresh={...request,rootStamp:changed.rootStamp,stamps:chain(changed,'dir/file')};
  await rename(join(tree,'dir'),join(tree,'held'));await symlink('held',join(tree,'dir'));await assert.rejects(native('readContent',fresh));
  evidence.cases.push('changed mode and replaced ancestor rejected');
  const content=await import('./guest-content.mjs').catch(()=>({}));
  assert.equal(typeof content.captureGuestContent,'function','Complete guest baseline collector must exist');
  const guest=join(home,'guest');await mkdir(guest,{mode:0o700});await mkdir(join(guest,'src'));
  await writeFile(join(guest,'src','main.c'),'BEFORE\n');await writeFile(join(guest,'delete'),'remove me');await writeFile(join(guest,'run.sh'),'echo BEFORE\n');
  const guestRoot=await descriptor(guest),initial=await native('inventory',{root:guestRoot,exclude:[]});
  const baseline=await content.captureGuestContent({root:guestRoot,expected:initial,native,check:()=>{}});
  await writeFile(join(guest,'src','main.c'),bytes);await chmod(join(guest,'run.sh'),0o755);
  await rename(join(guest,'delete'),join(home,'retained-delete'));await mkdir(join(guest,'empty'));await symlink('src/main.c',join(guest,'literal'));
  const changes=await content.collectGuestChanges({baseline,native,check:()=>{}});
  assert.deepEqual(changes.map(x=>[x.path,x.kind]).sort(),[['delete','remove'],['empty','directory'],['literal','symlink'],['run.sh','file'],['src/main.c','file']]);
  assert.deepEqual(Buffer.from(changes.find(x=>x.path==='src/main.c').data,'base64'),bytes);
  assert.equal(changes.find(x=>x.path==='run.sh').mode,0o755);
  assert.equal(Buffer.from(changes.find(x=>x.path==='literal').data,'base64').toString(),'src/main.c');
  await assert.rejects(content.collectGuestChanges({baseline,native,check:()=>{}}),/used|consum/i);
  const unstable=await content.captureGuestContent({root:guestRoot,expected:await native('inventory',{root:guestRoot,exclude:[]}),native,check:()=>{}});
  await writeFile(join(guest,'src','main.c'),'changed');let reads=0;
  await assert.rejects(content.collectGuestChanges({baseline:unstable,native:async(action,input)=>{const result=await native(action,input);if(action==='readContent'&&++reads===1)await writeFile(join(guest,'new-concurrent-file'),'racing');return result;},check:()=>{}}),/changed|inventory/i);
  evidence.cases.push('complete guest change discovery, contiguous bytes, modes/directories/deletion/literal links, one-shot baseline and concurrent writer rejection');
  const large=Buffer.alloc(32*1024*1024,91);await writeFile(join(guest,'large'),large);
  const full=await native('inventory',{root:guestRoot,exclude:[]});
  assert.deepEqual(await content.readGuestContentFile({root:guestRoot,inventory:full,path:'large',native,check:()=>{}}),large);
  for(const corrupt of [r=>({...r,offset:r.offset+1}),r=>({...r,data:'',bytes:0,sha256:sha(Buffer.alloc(0))}),r=>{const b=Buffer.from(r.data,'base64');b[0]^=1;return {...r,data:b.toString('base64'),sha256:sha(b)};}]){
    await assert.rejects(content.readGuestContentFile({root:guestRoot,inventory:full,path:'src/main.c',native:async(a,v)=>corrupt(await native(a,v)),check:()=>{}}),/range|digest/i);
  }
  evidence.cases.push('full32MiB file reconstruction; wrong offsets, nonprogress and self-consistent wrong payload refused');
  assert.equal(typeof content.runGuestCommand,'function','Bounded guest command stream must exist');
  // Real child stdin/stdout with the command RPC shape; actual CLI/VM acceptance
  // is a separate gate, not implied by this local pipe check.
  const children=new Map(),life={commands:{}},streamReceipts=[];
  const engine={processLife:life,commandRPC:async(current,method,p,timeout,onOutput)=>{
    assert.equal(current,life);
    if(method==='command/exec'){
      assert.equal(p.streamStdin,true);assert.equal(p.streamStdoutStderr,true);assert.equal(p.tty,false);
      const child=spawn(p.command[0],p.command.slice(1),{cwd:p.cwd,env:{PATH:'/usr/bin:/bin',HOME:home},stdio:['pipe','pipe','pipe']});children.set(p.processId,child);child.stdin.on('error',()=>{});
      for(const stream of ['stdout','stderr'])child[stream].on('data',bytes=>onOutput({processId:p.processId,stream,deltaBase64:bytes.toString('base64'),capReached:false}));
      return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{children.delete(p.processId);streamReceipts.push({processId:p.processId,code,signal});resolve({exitCode:code??128,stdout:'',stderr:''});});});
    }
    const child=children.get(p.processId);assert(child,'Original exec must still be owned');
    if(method==='command/exec/terminate'){child.kill('SIGTERM');return {};}
    assert.equal(method,'command/exec/write');
    if(p.deltaBase64){const bytes=Buffer.from(p.deltaBase64,'base64');assert(bytes.length<=262144);await new Promise((resolve,reject)=>child.stdin.write(bytes,e=>e?reject(e):resolve()));}
    if(p.closeStdin)child.stdin.end();return {};
  }};
  const streamed=await content.runGuestCommand({engine,life,command:['/bin/cat'],cwd:home,input:Buffer.alloc(5*1024*1024,65),check:()=>{}});
  assert.deepEqual(streamed,Buffer.alloc(5*1024*1024,65));
  const manyExclusions=Array.from({length:3000},(_,i)=>String(i).padStart(6,'0')+'x'.repeat(90));
  const received=await content.guestNative({engine,life,helper,cwd:home,check:()=>{}},'inventory',{root:guestRoot,exclude:manyExclusions});
  assert.deepEqual(received,await native('inventory',{root:guestRoot,exclude:manyExclusions}));
  const cancelled=new AbortController();cancelled.abort(Error('Stopped before launch'));const previous=streamReceipts.length;
  await assert.rejects(content.runGuestCommand({engine,life,command:['/bin/cat'],cwd:home,input:Buffer.alloc(0),check:()=>{},signal:cancelled.signal}),/Stopped/i);
  assert.equal(streamReceipts.length,previous,'An already-stopped scope must never launch a guest command');
  const stopped=new AbortController();setTimeout(()=>stopped.abort(),100);
  await assert.rejects(content.runGuestCommand({engine,life,command:['/bin/sleep','10'],cwd:home,input:Buffer.alloc(0),check:()=>{if(stopped.signal.aborted)throw Error('Stopped');},signal:stopped.signal}),/Stopped|abort/i);
  assert.equal(children.size,0);assert.equal(streamReceipts.length,3);evidence.streamReceipts=streamReceipts;
  evidence.cases.push('real pipes: 5MiB output, chunked native JSON stdin, readiness and explicit EOF, Stop drains original completion');
  evidence.passed=true;
}catch(error){evidence.error=error.stack;process.exitCode=1;}
await writeFile(join(home,'evidence.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({home,passed:evidence.passed,cases:evidence.cases,workers:evidence.workers.length,error:evidence.error}));
