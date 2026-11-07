import assert from 'node:assert/strict';
import {fstatSync,appendFileSync,truncateSync,writeFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import {mkdtemp,writeFile,readFile,rm,symlink,link,open} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {startGuestSSH} from './guest-ssh.mjs';
const root=await mkdtemp('/private/tmp/saleh-ssh-upload-check-'),source=join(root,'binary 🌊'),knownHosts=join(root,'known hosts');
const pin='# trusted pin\n',credential='X'.repeat(48),digest=b=>createHash('sha256').update(b).digest('hex');
const data=Buffer.from(Array.from({length:2097152},(_,i)=>i%256));
const config={address:'192.168.64.2',user:'fixture',guestId:randomUUID().toUpperCase(),credential,knownHosts,knownHostsSHA256:digest(pin),signal:new AbortController().signal,mode:'upload',source,sourceBytes:data.length,sourceSHA256:digest(data),timeoutMs:4000};
const spawn=childProcess.spawn,originalOpen=fs.open,handles=[],groups=[];let mode='success',lastChild,descriptor;
const quote=s=>'{'+s.replaceAll('\\','\\\\').replaceAll('}','\\}')+'}';
try {
 await writeFile(source,data,{mode:0o600});await writeFile(knownHosts,pin,{mode:0o600});
 const child=join(root,'child.py'),harness=join(root,'harness.exp');
 await writeFile(child,`import sys,time,os,subprocess\nwith open('/dev/tty','w') as out,open('/dev/tty','r') as inp:\n out.write('Password: ');out.flush();assert inp.readline().strip()=='${credential}'\nmode=sys.argv[1]\nif mode=='bad-exit':\n print('DISPOSABLE_PRIVATE_SENTINEL_42');print('${credential.slice(0,16)}');sys.exit(37)\nif mode=='hold':time.sleep(30)\nelse:\n result=subprocess.run(['/bin/sh','-c',sys.argv[2]])\n if mode=='mutate':\n  with open(sys.argv[3],'ab') as f:f.write(b'changed')\n if mode=='extra-output':print('unexpected')\n if mode=='secret-output':print('DISPOSABLE_PRIVATE_SENTINEL_42')\n if mode=='partial-credential':print('${credential.slice(0,16)}')\n if mode=='full-credential':print('${credential}')\n sys.exit(result.returncode)\n`);
 await writeFile(harness,`set test_mode [lindex $argv 0]\nset test_source [lindex $argv 1]\nrename spawn actual_spawn\nproc spawn {args} {\n global spawn_id\n if {[lindex $args 1] ne "/bin/sh" || [lindex $args 3] ne {exec /usr/bin/ssh "$@" <&4 4<&-}} {error "Upload must exec SSH using the inherited descriptor"}\n return [uplevel 1 [list actual_spawn -noecho /bin/sh -c {exec /usr/bin/python3 "$1" "$2" "$3" "$4" <&4 4<&-} fixture ${quote(child)} $::test_mode [lindex $args end]  $::test_source]]\n}\nset argv [lrange $argv 2 end];incr argc -2\nsource ${quote(new URL('./guest-ssh.exp',import.meta.url).pathname)}\n`);
 childProcess.spawn=(file,args,options)=>{
  assert.equal(file,'/usr/bin/expect');assert(!JSON.stringify([args,options]).includes(credential));
  descriptor=options.stdio[4];assert(Number.isInteger(descriptor));
  if(mode==='grow')appendFileSync(source,'extra');
  if(mode==='truncate')truncateSync(source,1);
  if(mode==='corrupt')writeFileSync(source,Buffer.alloc(data.length));
  lastChild=spawn(file,['-N','-n',harness,mode,source,...args.slice(3)],options);return lastChild;
 };syncBuiltinESMExports();
 const start=patch=>{const h=startGuestSSH({...config,...patch});handles.push(h);return h;};
 const closed=async h=>{const row=await h.closed;assert(row.closed);assert.equal(row.sshPid,null);if(row.launched)assert(row.launcherPid>1);assert.throws(()=>fstatSync(descriptor),{code:'EBADF'});return row;};
 let h=start(),result=await h.result;assert.deepEqual(await readFile(result.path),data);assert.equal(result.bytes,data.length);assert.equal(result.sha256,digest(data));await closed(h);groups.push('binary-upload-exact-hash-and-closed-fd');
 await writeFile(source,Buffer.alloc(0));h=start({sourceBytes:0,sourceSHA256:digest('')});result=await h.result;assert.equal((await readFile(result.path)).length,0);await closed(h);groups.push('empty-upload');
 await writeFile(source,data);mode='mutate';h=start();await assert.rejects(h.result,/source.*changed/i);await closed(h);groups.push('post-transfer-source-change-refused');
 await writeFile(source,data);mode='success';const previous=lastChild;
 h=start({sourceSHA256:'0'.repeat(64)});await assert.rejects(h.result,/source.*(changed|digest|hash)/i);assert.equal((await h.closed).launched,false);assert.equal(lastChild,previous);groups.push('wrong-hash-before-authentication');
 h=start({sourceBytes:1});await assert.rejects(h.result,/source/i);assert.equal((await h.closed).launched,false);groups.push('wrong-size-before-authentication');
 const target=join(root,'alias');await symlink(source,target);h=start({source:target});await assert.rejects(h.result,/source/i);assert.equal((await h.closed).launched,false);await rm(target);
 await link(source,target);h=start();await assert.rejects(h.result,/source/i);assert.equal((await h.closed).launched,false);await rm(target);groups.push('symlink-and-shared-source-refused');
 for(const patch of [{timeoutMs:undefined},{source:'relative'},{sourceSHA256:'bad'},{sourceBytes:-1}])assert.throws(()=>start(patch));groups.push('upload-contract-refusals');
 for(const mutation of ['grow','truncate','corrupt']){
  await writeFile(source,data);mode=mutation;h=start();await assert.rejects(h.result,/source.*changed/i);const row=await closed(h);
  await assert.rejects(readFile('/private/tmp/saleh-upload-'+row.nonce+'/payload'),{code:'ENOENT'});
 }
 await writeFile(source,data);groups.push('receiver-refuses-grown-truncated-corrupt-payload');
 for(const [testMode,secret] of [['secret-output','DISPOSABLE_PRIVATE_SENTINEL_42'],['partial-credential',credential.slice(0,16)],['full-credential',credential]]){
  mode=testMode;h=start();await assert.rejects(h.result,error=>{assert(!error.message.includes(secret),'Remote data must never enter an upload error');assert.match(error.message,/Guest SSH (upload verification failed|output rejected)/);return true;});await closed(h);
 }groups.push('arbitrary-and-partial-credential-output-never-disclosed');
 mode='extra-output';h=start();await assert.rejects(h.result,/verification failed \(receipt mismatch; [0-9]+ output bytes; SHA256 [a-f0-9]{64}\)/i);await closed(h);groups.push('extra-receipt-output-refused');
 mode='bad-exit';h=start();await assert.rejects(h.result,error=>{assert(!error.message.includes('DISPOSABLE_PRIVATE_SENTINEL_42'));assert(!error.message.includes(credential.slice(0,16)));assert.match(error.message,/verification failed \(remote exit 37; [0-9]+ output bytes; SHA256 [a-f0-9]{64}\)/i);return true;});await closed(h);groups.push('remote-exit-diagnostic-without-output');

 mode='success';
 // Hold real filesystem work at each side of the child lifetime. Stop must keep
 // its deadline and observer; a deadline cannot invent FD or callback closure.
 for(const phase of ['prehash','finalize','prehash-timeout']){
  let entered,release,held=false,drained=false;const gate=new Promise(r=>release=r),arrived=new Promise(r=>entered=r);
  const timer=globalThis.setTimeout;
  fs.open=async(...args)=>{
   const file=await originalOpen(...args);if(args[0]!==source)return file;
   descriptor=file.fd;const method=phase.startsWith('prehash')?'read':'stat',original=file[method].bind(file);let calls=0;
   file[method]=async(...a)=>{if(!held&&(phase.startsWith('prehash')||++calls===3)){held=true;entered();await gate;}return original(...a);};return file;
  };syncBuiltinESMExports();
  try{
   globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===5000?40:ms,...args);
   const before=lastChild;h=start(phase==='prehash-timeout'?{timeoutMs:20}:{});await arrived;
   if(phase==='prehash-timeout'){
    await new Promise(r=>timer(r,30));release();await assert.rejects(h.result,/upload deadline/i);assert.equal(lastChild,before,'Expired prehash must not authenticate');assert((await h.closed).closed);assert.throws(()=>fstatSync(descriptor),{code:'EBADF'});groups.push('upload-deadline-includes-prehash');continue;
   }
   const observation=h.closed.catch(()=>{drained=true;});
   const stop=h.stop();let watchdog;
   try{await assert.rejects(Promise.race([stop,new Promise((_,reject)=>watchdog=timer(()=>reject(Error('Missing bounded Stop during owned file work')),250))]),/closure deadline/i);}finally{clearTimeout(watchdog);}
   assert.equal(drained,false);fstatSync(descriptor);
   if(phase==='prehash')assert.equal(lastChild,before,'Stopped prehash must not authenticate');
   release();await observation;await assert.rejects(h.result,/closure deadline/i);assert.throws(()=>fstatSync(descriptor),{code:'EBADF'});groups.push(phase+'-stop-retains-deadline-and-observer');
  }finally{release();fs.open=originalOpen;syncBuiltinESMExports();globalThis.setTimeout=timer;await h.closed.catch(()=>{});}
 }
 mode='hold';h=start({timeoutMs:5000});while(lastChild===previous)await new Promise(r=>setTimeout(r,10));await new Promise(r=>setTimeout(r,100));
 const stop=h.stop();assert.equal(stop,h.stop());await stop;await assert.rejects(h.result,/stopped/i);await closed(h);groups.push('stalled-upload-stop-drains');
 h=start({timeoutMs:100});await assert.rejects(h.result,/deadline/i);await closed(h);groups.push('upload-explicit-deadline-drains');
 h=start();await new Promise(r=>setTimeout(r,100));lastChild.stdin.end();await assert.rejects(h.result,/parent|input/i);await closed(h);groups.push('upload-parent-eof-drains');
 const aborted=new AbortController();aborted.abort();h=start({signal:aborted.signal});await assert.rejects(h.result,/stopped/i);assert.equal((await h.closed).launched,false);groups.push('preabort-upload-no-child');
 console.log(JSON.stringify({passed:true,groups,actualSSH:false,actualVMStarted:false,installedAppTouched:false}));
} finally {
 await Promise.allSettled(handles.map(h=>h.stop()));
 for(const h of handles){const row=await h.closed.catch(()=>null);if(row)await rm('/private/tmp/saleh-upload-'+row.nonce,{recursive:true,force:true});}
 childProcess.spawn=spawn;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});
}
