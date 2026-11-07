// Run with node; all compiled binaries, repositories and retained evidence live beneath task/work.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {mkdtemp, mkdir, open, readFile, writeFile, readdir, lstat, access} from 'node:fs/promises';
import {randomUUID, createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=dirname(fileURLToPath(import.meta.url)),git='/Applications/Xcode.app/Contents/Developer/usr/bin/git';
const taskWork='/Users/saleh/Documents/Codex/2026-10-12/i-want-the-app-to-work/work';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const clean=home=>({HOME:home,PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
const policy=dir=>`(version 1)(deny default)(allow file-read*)(allow process-fork)(allow process-exec (literal "${git}"))(allow sysctl-read)(allow mach-lookup)(allow signal (target self))(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(dir)}))(deny network*)`;
async function durable(path,value){const f=await open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(value)+'\n');await f.sync();}finally{await f.close();}const d=await open(dirname(path),'r');try{await d.sync();}finally{await d.close();}}
function mailbox(child){const messages=[];child.on('message',value=>messages.push(value));return async event=>{for(let i=0;i<500;i++){const found=messages.find(x=>x.event===event);if(found)return found;await delay(10);}throw new Error('Timed out waiting for '+event);};}
function receipt(child){return new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(new Error('No bounded identity receipt')),5000);child.stdio[3].on('data',b=>{data+=b;if(data.length>2048){clearTimeout(timer);reject(new Error('Receipt overflow'));}});child.stdio[3].on('end',()=>{clearTimeout(timer);try{resolve(JSON.parse(data));}catch(error){reject(error);}});child.once('error',error=>{clearTimeout(timer);reject(error);});});}

if(process.argv[2]==='owner-worker'){
  const [binary,dir]=process.argv.slice(3),child=spawn(binary,['--handoff-process','owner'],{cwd:dir,env:clean(dir),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const exit=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));assert.equal(exit.code,0,stderr);process.send({event:'owner',value:JSON.parse(stdout),captureExit:exit});process.on('message',message=>{if(message.action==='finish')process.disconnect();});
}else if(process.argv[2]==='worker'){
  const [binary,dir,nonce]=process.argv.slice(3),input=await open(join(dir,'input.fifo'),'r'),out=await open(join(dir,'git.stdout'),'a'),err=await open(join(dir,'git.stderr'),'a');
  const child=spawn(binary,['--handoff-process','git',nonce,policy(dir),'-C',dir,'hash-object','-w','--no-filters','--stdin'],{cwd:dir,env:{...clean(dir),GIT_TRACE2_EVENT:join(dir,'git-trace.json')},detached:true,stdio:[input.fd,out.fd,err.fd,'pipe','pipe']});
  for(const fd of [input,out,err])await fd.close();child.stdio[4].on('error',()=>{});
  const identity=await receipt(child);process.send({event:'ready',identity});
  process.on('message',async m=>{if(m.action==='persist'){await durable(join(dir,'receipt.json'),identity);process.send({event:'persisted'});}if(m.action==='release'){child.stdio[4].end(nonce+'\n');process.send({event:'released'});}if(m.action==='partial'){child.stdio[4].write(nonce.slice(0,12));process.send({event:'partial'});}});
}else{
  const fixture=await mkdtemp(join(taskWork,'handoff-process-native-')),binary=join(fixture,'handoff-process'),children=[];
  const evidence={version:1,fixture,cases:[],children,limitations:['No installed app, actual coding engine or model ran.','Only current owned worker ChildProcess handles receive SIGKILL. No historical PID or group is signaled.','Orphan exit is established by read-only leader and full-group absence, not waitpid by a non-parent.','Synthetic group-survival fixture is not proof of arbitrary subprocess containment.']};
  function launch(file,args,options={}){const child=spawn(file,args,{cwd:fixture,env:clean(fixture),stdio:['pipe','pipe','pipe'],timeout:file==='/usr/bin/swiftc'?60000:20000,killSignal:'SIGKILL',...options}),row={file,args,pid:child.pid};children.push(row);let stdout='',stderr='';child.stdout?.on('data',b=>{stdout+=b;});child.stderr?.on('data',b=>{stderr+=b;});child.stdin?.on('error',()=>{});child.stdio[4]?.on('error',()=>{});child.done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{Object.assign(row,{code,signal,closed:true});resolve({code,signal,stdout,stderr});});});return child;}
  async function run(file,args,input='',options={}){const child=launch(file,args,options);child.stdin?.end(input);const r=await child.done;assert.equal(r.code,0,JSON.stringify({file,args,...r}));return r.stdout;}
  const command=async(args,input='')=>{const child=launch(binary,['--handoff-process',...args]);child.stdin.end(input);return child.done;};
  const inspect=async id=>JSON.parse(await run(binary,['--handoff-process','inspect'],JSON.stringify(id)));
  const absent=async id=>{let state;for(let i=0;i<250;i++){state=await inspect(id);if(state.leader===null&&state.group.length===0&&state.groupQuery.positivePids===0)return state;await delay(20);}throw new Error('Owned process/group remains: '+JSON.stringify(state));};
  const objects=async dir=>{const rows=[];for(const prefix of await readdir(join(dir,'.git/objects')))if(/^[a-f0-9]{2}$/.test(prefix))for(const leaf of await readdir(join(dir,'.git/objects',prefix)))rows.push(prefix+'/'+leaf);return rows.sort();};
  const repo=async name=>{const dir=join(fixture,name);await mkdir(dir);await run(git,['init','-q',dir]);return dir;};
  const gate=(args,input='')=>{const child=launch(binary,['--handoff-process',...args],{detached:true,stdio:['pipe','pipe','pipe','pipe','pipe']});child.stdin.end(input);return {child,ready:receipt(child)};};
  const record=(name,data={})=>{evidence.cases.push({name,...data,passed:true});console.log('PASS '+name);};
  let fifo;
  try{
    const native=join(source,'HandoffProcess.swift');let available=true;try{await access(native);}catch{available=false;}
    await writeFile(join(fixture,'main.swift'),available?`import Foundation\nimport Darwin\n@_silgen_name("fork") func fixtureFork() -> Int32\nif CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--fixture-group" {\n do {\n let value = try HandoffProcess.selfReceipt(CommandLine.arguments[2])\n let child = fixtureFork(); guard child >= 0 else { exit(70) }\n if child == 0 {close(1);close(2);var b:UInt8=0;while Darwin.read(0,&b,1)>0{};_exit(0)}\n FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:value));exit(0)\n } catch {exit(71)}\n}\nif CommandLine.arguments.count > 1 && CommandLine.arguments[1] == "--handoff-files" {exit(HandoffFiles.command(CommandLine.arguments))}\nexit(HandoffProcess.command(CommandLine.arguments))\n`:'import Darwin\nfputs("HandoffProcess command is not implemented\\n",stderr)\nexit(64)\n');
    const sources=available?['CodingTemporary.swift','HandoffFiles.swift','HandoffProcess.swift','GuestDiskDisposal.swift'].map(p=>join(source,p)):[];
    await run('/usr/bin/swiftc',['-O',...sources,join(fixture,'main.swift'),'-o',binary]);
    const bootResult=await command(['boot']);assert.equal(bootResult.code,0,'native boot command must exist: '+bootResult.stderr);const boot=JSON.parse(bootResult.stdout);assert.deepEqual(Object.keys(boot).sort(),['bootSession','version']);assert.equal(boot.version,1);assert.match(boot.bootSession,/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);record('boot identity',boot);
    const ownerResult=await command(['owner']);assert.equal(ownerResult.code,0,'native owner command must exist: '+ownerResult.stderr);const captured=JSON.parse(ownerResult.stdout),owner=captured.owner;
    assert.deepEqual(Object.keys(captured).sort(),['bootSession','owner','version']);assert.equal(captured.version,1);assert.equal(captured.bootSession,boot.bootSession);assert.deepEqual(Object.keys(owner).sort(),['version','pid','pgid','uid','startSec','startUsec','bootSession'].sort());assert.equal(owner.pid,process.pid);assert.equal(owner.uid,process.getuid());assert.equal(owner.bootSession,boot.bootSession);
    const ownerInspection=JSON.parse((await command(['inspect-owner'],JSON.stringify(owner))).stdout);assert.deepEqual(ownerInspection,{version:1,bootSession:boot.bootSession,priorBoot:false,owner});record('captures exact live direct parent',ownerInspection);
    const priorOwner={...owner,bootSession:randomUUID().toUpperCase()},priorOwnerExpected={version:1,bootSession:boot.bootSession,priorBoot:true,owner:null};assert.deepEqual(JSON.parse((await command(['inspect-owner'],JSON.stringify(priorOwner))).stdout),priorOwnerExpected);
    for(const input of [JSON.stringify({...owner,nonce:randomUUID()}),JSON.stringify({...owner,uid:true}),JSON.stringify({...owner,uid:process.getuid()+1}),JSON.stringify({...owner,pid:1}),JSON.stringify({...owner,pgid:0}),JSON.stringify({...owner,startSec:'01'}),JSON.stringify({...owner,startSec:owner.startSec+'\n'}),JSON.stringify({...owner,startUsec:1000000}),JSON.stringify({...owner,bootSession:owner.bootSession+'\n'}),JSON.stringify(owner).replace('"version":1','"version":1,"version":1'),'x'.repeat(8193)])assert.notEqual((await command(['inspect-owner'],input)).code,0);
    for(const action of ['owner','inspect-owner'])assert.notEqual((await command([action,'extra'])).code,0);record('owner receipt malformed fields and prior boot');
    {
      const worker=launch(process.execPath,[fileURLToPath(import.meta.url),'owner-worker',binary,fixture],{stdio:['ignore','pipe','pipe','ipc']}),next=mailbox(worker),observed=await next('owner'),saved=observed.value.owner;
      try{assert.equal(saved.pid,worker.pid);assert.notEqual(saved.pgid,saved.pid,'non-detached owner fixture must not be its group leader');const live=JSON.parse((await command(['inspect-owner'],JSON.stringify(saved))).stdout);assert.deepEqual(live.owner,saved);
        const mismatch={...saved,startSec:String(BigInt(saved.startSec)+1n)},current=JSON.parse((await command(['inspect-owner'],JSON.stringify(mismatch))).stdout);assert.deepEqual(current.owner,saved,'inspection must report actual identity, not substitute the saved incarnation');
        worker.send({action:'finish'});const exit=await worker.done;assert.equal(exit.code,0);const gone=JSON.parse((await command(['inspect-owner'],JSON.stringify(saved))).stdout);assert.equal(gone.owner,null);assert.equal(gone.priorBoot,false);record('nonleader parent alive, simulated reuse mismatch, then actual exit',{saved,live,mismatch,current,exit,captureExit:observed.captureExit,gone});
      }finally{if(worker.exitCode===null&&worker.connected){worker.send({action:'finish'});await worker.done;}}
    }
    for(const args of [[],['unknown'],['boot','extra'],['files','bad','snapshot'],['files',randomUUID(),'unknown'],['git',randomUUID(),''],['git',randomUUID(),'x'.repeat(131073),'status']])assert.notEqual((await command(args)).code,0);record('invalid command and policy bounds');
    const dir=await repo('gate'),before=await objects(dir),payload='actual gated blob\n';
    let trusted;
    for(const kind of ['eof','partial','wrong','extra','exact']){
      const nonce=randomUUID(),{child,ready}=gate(['git',nonce,policy(dir),'-C',dir,'hash-object','-w','--no-filters','--stdin'],payload),id=await ready;trusted=id;
      assert.deepEqual(Object.keys(id).sort(),['version','nonce','pid','pgid','uid','startSec','startUsec','bootSession'].sort());assert.equal(id.pid,child.pid);assert.equal(id.pgid,id.pid);assert.equal(id.uid,process.getuid());assert.equal(id.nonce,nonce);assert.equal(id.bootSession,boot.bootSession);
      const waiting=await inspect(id);assert.deepEqual(waiting.leader,Object.fromEntries(Object.entries(id).filter(([k])=>k!=='nonce')));assert(waiting.group.some(x=>x.pid===id.pid));assert.equal(waiting.priorBoot,false);assert.deepEqual(await objects(dir),before);
      if(kind==='exact'){child.stdio[4].write(nonce+'\n');await delay(100);assert.deepEqual(await objects(dir),before,'token without EOF must not execute');child.stdio[4].end();}
      else child.stdio[4].end(kind==='eof'?'':kind==='partial'?nonce.slice(0,12):kind==='wrong'?randomUUID()+'\n':nonce+'\nextra');
      const result=await child.done;if(kind==='exact'){assert.equal(result.code,0,result.stderr);assert.equal(await run(git,['-C',dir,'cat-file','blob',result.stdout.trim()]),payload);}else{assert.notEqual(result.code,0);assert.deepEqual(await objects(dir),before);}
      const gone=await absent(id);record('release '+kind,{receipt:id,result,gone});
    }
    for(const input of [JSON.stringify({...trusted,extra:1}),JSON.stringify({...trusted,uid:true}),JSON.stringify({...trusted,pid:0}),JSON.stringify({...trusted,pgid:trusted.pgid+1}),JSON.stringify({...trusted,nonce:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'}),JSON.stringify({...trusted,bootSession:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}),JSON.stringify({...trusted,startSec:'01'}),JSON.stringify({...trusted,startUsec:1000000}),JSON.stringify(trusted).replace('"version":1','"version":1,"version":1'),'x'.repeat(8193)])assert.notEqual((await command(['inspect'],input)).code,0);
    const old={...trusted,bootSession:randomUUID().toUpperCase()},prior=await inspect(old);assert.deepEqual(prior,{version:1,bootSession:boot.bootSession,priorBoot:true,leader:null,group:[],groupQuery:{bytes:0,errno:0,positivePids:0}});record('strict receipt, duplicate keys, input overflow and prior boot',{prior});
    {
      const nonce=randomUUID(),{child,ready}=gate(['git',nonce,policy(dir),'-C',dir,'hash-object','-w','--no-filters','--stdin'],'must not write');const id=await ready,started=performance.now();child.stdio[4].write(nonce+'\n');const result=await child.done;assert.equal(result.code,1);assert.match(result.stderr,/release timed out/);assert(performance.now()-started<13000);await absent(id);assert.equal((await objects(dir)).length,1);record('release requires bounded EOF',{receipt:id,result});
    }
    const sourceDir=join(fixture,'copy-source'),target=join(fixture,'copy-target');await mkdir(sourceDir,{mode:0o700});await mkdir(target,{mode:0o700});await writeFile(join(sourceDir,'file'),'native copy body');
    const desc=async path=>{const s=await lstat(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)};};
    assert.equal(JSON.parse(await run(binary,['--handoff-files','snapshot'],JSON.stringify({root:await desc(sourceDir),paths:['file']}))).stamps.file.kind,'file');record('combined dispatcher supports ordinary native file preparation');
    async function files(action,input,release=true){const nonce=randomUUID(),{child,ready}=gate(['files',nonce,action],JSON.stringify(input)),id=await ready;assert.equal(await readFile(join(sourceDir,'file'),'utf8'),'native copy body');assert.deepEqual(await readdir(target),[]);child.stdio[4].end(release?nonce+'\n':'');const result=await child.done;await absent(id);return result;}
    const snapshot=JSON.parse((await files('snapshot',{root:await desc(sourceDir),paths:['file']})).stdout),copy={source:await desc(sourceDir),destination:await desc(target),stamps:snapshot.stamps};
    assert.notEqual((await files('copy',copy,false)).code,0);assert.deepEqual(await readdir(target),[]);const copied=await files('copy',copy);assert.equal(copied.code,0,copied.stderr);assert.equal(await readFile(join(target,'file'),'utf8'),'native copy body');record('native files stdin remains separate and copy has no pre-release effects');
    for(const mode of ['before-receipt','after-receipt','partial','after-release']){
      const dir=await repo(mode);await run('/usr/bin/mkfifo',[join(dir,'input.fifo')]);fifo=await open(join(dir,'input.fifo'),constants.O_RDWR|constants.O_NONBLOCK);
      const worker=launch(process.execPath,[fileURLToPath(import.meta.url),'worker',binary,dir,randomUUID()],{stdio:['ignore','pipe','pipe','ipc']}),next=mailbox(worker),id=(await next('ready')).identity;
      if(mode!=='before-receipt'){worker.send({action:'persist'});await next('persisted');assert.deepEqual(JSON.parse(await readFile(join(dir,'receipt.json'),'utf8')),id);}
      if(mode==='partial'){worker.send({action:'partial'});await next('partial');}
      if(mode==='after-release'){worker.send({action:'release'});await next('released');let started=false;for(let i=0;i<250;i++){try{started=(await readFile(join(dir,'git-trace.json'),'utf8')).includes('"event":"start"');}catch{}if(started)break;await delay(10);}assert(started,'fixed Git must actually exec before parent death');}
      assert(worker.kill('SIGKILL'));const exit=await worker.done;assert.equal(exit.signal,'SIGKILL');let live;
      if(mode==='after-release'){live=await inspect(id);assert.deepEqual(live.leader,Object.fromEntries(Object.entries(id).filter(([k])=>k!=='nonce')));assert(live.group.some(x=>x.pid===id.pid));await fifo.writeFile('post-parent fixture bytes\n');}
      await fifo.close();fifo=null;const gone=await absent(id),written=await objects(dir);
      if(mode==='after-release'){assert.equal(written.length,1);const oid=(await readFile(join(dir,'git.stdout'),'utf8')).trim();assert.equal(await run(git,['-C',dir,'cat-file','blob',oid]),'post-parent fixture bytes\n');}else{assert.deepEqual(written,[]);assert.match(await readFile(join(dir,'git.stderr'),'utf8'),/release/i);}
      record('parent death '+mode,{receipt:id,exit,live,gone,written});
    }
    {
      const pipe=join(fixture,'group.fifo');await run('/usr/bin/mkfifo',[pipe]);fifo=await open(pipe,constants.O_RDWR|constants.O_NONBLOCK);const input=await open(pipe,'r');const child=launch(binary,['--fixture-group',randomUUID()],{detached:true,stdio:[input.fd,'pipe','pipe']});await input.close();const exit=await child.done;assert.equal(exit.code,0);const id=JSON.parse(exit.stdout),live=await inspect(id);assert.equal(live.leader,null);assert.equal(live.group.length,1);assert.notEqual(live.group[0].pid,id.pid);assert.equal(live.group[0].pgid,id.pgid);await fifo.writeFile('done');await fifo.close();fifo=null;const gone=await absent(id);record('leader absent while full group remains',{receipt:id,live,gone});
    }
    // Link-time libproc fault fixture, with the unmodified production Swift implementation.
    // It makes otherwise nondeterministic disappearing-member and saturation outcomes reproducible.
    const faults=join(fixture,'faults.c'),faultObject=join(fixture,'faults.o'),faultBinary=join(fixture,'handoff-process-faults');
    await writeFile(faults,`#include <stdint.h>\n#include <stdlib.h>\n#include <string.h>\n#include <errno.h>\n#include <sys/types.h>\nint proc_pidinfo(int pid,int flavor,uint64_t arg,void *buffer,int size){(void)pid;(void)flavor;(void)arg;(void)buffer;(void)size;const char *mode=getenv("NATIVE_INSPECTION_FAULT");errno=mode&&!strcmp(mode,"owner-errno")?EACCES:mode&&!strcmp(mode,"owner-short")?0:ESRCH;return 0;}\nint proc_listpids(uint32_t type,uint32_t info,void *buffer,int size){(void)type;(void)info;const char *mode=getenv("NATIVE_INSPECTION_FAULT");if(mode&&!strcmp(mode,"overflow"))return size;if(mode&&!strcmp(mode,"errno")){errno=EIO;return 0;}((pid_t *)buffer)[0]=90001;return sizeof(pid_t);}\n`);
    await run('/usr/bin/clang',['-Wall','-Wextra','-Werror','-c',faults,'-o',faultObject]);await run('/usr/bin/swiftc',['-O',...sources,join(fixture,'main.swift'),faultObject,'-o',faultBinary]);
    const unknown=JSON.parse(await run(faultBinary,['--handoff-process','inspect'],JSON.stringify(trusted)));assert.equal(unknown.leader,null);assert.equal(unknown.groupQuery.positivePids,1);assert.deepEqual(unknown.group,[{pid:90001,unavailable:true,errno:3}]);
    for(const mode of ['overflow','errno']){const child=launch(faultBinary,['--handoff-process','inspect'],{env:{...clean(fixture),NATIVE_INSPECTION_FAULT:mode}});child.stdin.end(JSON.stringify(trusted));const result=await child.done;assert.equal(result.code,1);assert.match(result.stderr,/Process group inspection failed or exceeded/);}
    record('unknown positive members retained; kernel overflow and errno fail closed',{unknown,fixture:'link-time libproc faults, not actual OS failures'});
    for(const mode of ['owner-errno','owner-short']){for(const action of ['owner','inspect-owner']){const child=launch(faultBinary,['--handoff-process',action],{env:{...clean(fixture),NATIVE_INSPECTION_FAULT:mode}});child.stdin.end(action==='inspect-owner'?JSON.stringify(owner):'');const result=await child.done;assert.equal(result.code,1);assert.match(result.stderr,/owner.*unavailable|Owner.*inspection failed/i);}}
    assert.deepEqual(JSON.parse(await run(faultBinary,['--handoff-process','inspect-owner'],JSON.stringify(priorOwner),{env:{...clean(fixture),NATIVE_INSPECTION_FAULT:'owner-errno'}})),priorOwnerExpected);record('owner inspection errors refuse; prior boot avoids identity API',{fixture:'link-time libproc faults, not actual OS failures'});
    evidence.sources=Object.fromEntries(await Promise.all(['HandoffProcess.swift','handoff-process-native-check.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(join(source,name))).digest('hex')])));
    evidence.binaries=Object.fromEntries(await Promise.all([binary,git,'/usr/bin/sandbox-exec'].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));evidence.passed=true;
  }catch(error){evidence.passed=false;evidence.error={message:error.message,stack:error.stack};console.error(error.stack);process.exitCode=1;}
  finally{await fifo?.close();await writeFile(join(fixture,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log('Evidence '+join(fixture,'evidence.json'));}
}
