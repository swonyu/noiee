import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,rm,symlink,chmod} from 'node:fs/promises';
import {once} from 'node:events';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

const moduleURL=new URL('./guest-ssh.mjs',import.meta.url);
assert(existsSync(moduleURL),'Production SSH ownership is missing');
const {startGuestSSH}=await import(moduleURL);
const root=await mkdtemp('/private/tmp/saleh-ssh-owner-'),knownHosts=join(root,'known hosts'),helper=new URL('./guest-ssh.exp',import.meta.url);
const spawn=childProcess.spawn,groups=[];
const credential='X'.repeat(48),guestId=randomUUID().toUpperCase();
const controller=new AbortController();
const pin='# trusted provisioning pin\n';
const config={address:'192.168.64.2',user:'salehguest',guestId,knownHosts,knownHostsSHA256:createHash('sha256').update(pin).digest('hex'),credential,signal:controller.signal};
const quote=s=>'{'+s.replaceAll('\\','\\\\').replaceAll('}','\\}')+'}';
let mode='success',lastChild,handles=[];
try{
 await writeFile(knownHosts,pin,{mode:0o600});
 // Execute the production Tcl control flow against a disposable direct child.
 // Only spawn's argv is intercepted; authentication, receipts, traps and EOF are real.
 const child=join(root,'child.py'),harness=join(root,'harness.exp');
 await writeFile(child,`import sys,time\nmode=sys.argv[1]\nprint('Password: ',end='',flush=True)\npassword=sys.stdin.readline().strip()\nif mode in ('success','reap-race'):print('REMOTE_OK',flush=True)\nelif mode=='unicode':print('م🌊',flush=True)\nelif mode=='unicode-argument':print(sys.argv[2],flush=True)\nelif mode=='secret':print(password,flush=True)\nelif mode=='large':print('A'*1100000,flush=True)\nelse:time.sleep(30)\n`);
 await writeFile(harness,`set test_mode [lindex $argv 0]\nrename spawn actual_spawn\nproc spawn {args} {\n global spawn_id\n set f [open ${quote(join(root,'argv.txt'))} w]; puts $f $args; close $f\n return [uplevel 1 [list actual_spawn -noecho /usr/bin/python3 ${quote(child)} $::test_mode [lindex $args end]]]\n}\nrename wait actual_wait\nproc wait {args} { set row [uplevel 1 [linsert $args 0 actual_wait]]; if {$::test_mode eq "reap-race"} { set ::test_reaped 1; stop_session SIGTERM }; return $row }\nrename exec actual_exec\nproc exec {args} { if {[info exists ::test_reaped] && [lindex $args 0] eq "/bin/kill"} { set f [open ${quote(join(root,'post-reap-signal'))} w]; puts $f rejected; close $f; error "Test blocked stale PID signal" }; uplevel 1 [linsert $args 0 actual_exec] }\nset argv [lrange $argv 1 end]; incr argc -1\nsource ${quote(helper.pathname)}\n`);
 childProcess.spawn=(file,args,options)=>{
  assert.equal(file,'/usr/bin/expect');assert(!JSON.stringify([args,options]).includes(credential),'Credential must stay out of argv/environment');
  lastChild=mode==='unknown'?spawn('/bin/sh',['-c','/bin/sleep 0.6 & exit 0'],options):spawn(file,['-N','-n',harness,mode,...args.slice(3)],options);return lastChild;
 };syncBuiltinESMExports();
 const start=options=>{const value=startGuestSSH({...config,...options});handles.push(value);return value;};
 let resource=start({mode:'command',command:'printf REMOTE_OK',timeoutMs:2500});
 assert.deepEqual(await resource.result,{exitCode:0,stdout:'REMOTE_OK\n'});
 assert.equal((await resource.closed).closed,true);assert.equal(await resource.stop(),await resource.closed);
 const args=await readFile(join(root,'argv.txt'),'utf8');assert(args.includes('salehguest@192.168.64.2'));assert(args.includes('known hosts'));assert(args.includes('IdentityFile=none'));assert(args.includes('StrictHostKeyChecking=yes'));assert(!args.includes('accept-new'));
 groups.push('command-and-space-path');
 mode='reap-race';resource=start({mode:'command',command:'true'});
 await resource.result;assert(!existsSync(join(root,'post-reap-signal')),'Reaped SSH PID must never be signalled');groups.push('no-post-reap-signal');
 mode='unicode';resource=start({mode:'command',command:'unicode'});assert.equal((await resource.result).stdout,'م🌊\n');groups.push('unicode-command-output');
 mode='unicode-argument';resource=start({mode:'command',command:'م🌊'});assert.equal((await resource.result).stdout,'م🌊\n');groups.push('unicode-command-argument');
 mode='secret';resource=start({mode:'command',command:'printf private'});
 await assert.rejects(resource.result,/rejected/i);assert((await resource.closed).closed);groups.push('credential-output-rejected');
 mode='hold';resource=start({mode:'forward',hostPort:19001,guestPort:19002});
 await new Promise(r=>setTimeout(r,200));assert.equal(lastChild.exitCode,null);
 const stop=resource.stop();assert.equal(stop,resource.stop());await stop;await assert.rejects(resource.result,/stopped/i);groups.push('tunnel-stop-drains');
 const a=start({mode:'forward',hostPort:19003,guestPort:19004});await new Promise(r=>setTimeout(r,100));
 const other=new AbortController(),b=start({mode:'forward',hostPort:19005,guestPort:19006,signal:other.signal});await new Promise(r=>setTimeout(r,100));const sibling=lastChild;
 await a.stop();assert.equal(sibling.exitCode,null,'One transport Stop must preserve its sibling');other.abort();assert((await b.stop()).closed);await assert.rejects(b.result,/stopped/i);groups.push('independent-transport-cancellation');
 resource=start({mode:'command',command:'sleep 30',timeoutMs:150});await assert.rejects(resource.result,/deadline/i);assert((await resource.stop()).closed);groups.push('command-timeout-drains');
 resource=start({mode:'forward',hostPort:19001,guestPort:19002});await new Promise(r=>setTimeout(r,200));lastChild.stdin.end();
 await assert.rejects(resource.result,/parent|input/i);assert((await resource.closed).closed);groups.push('parent-input-loss-drains');
 mode='large';resource=start({mode:'command',command:'large'});await assert.rejects(resource.result,/limit|rejected/i);assert((await resource.closed).closed);groups.push('output-limit-drains');
 const aborted=new AbortController();aborted.abort();const previous=lastChild;
 resource=start({mode:'command',command:'never',signal:aborted.signal});await assert.rejects(resource.result,/stopped/i);assert((await resource.closed).closed);assert.equal(previous,lastChild);groups.push('preabort-no-child');
 for(const patch of [{knownHosts:join(root,'known-%h')},{knownHosts:join(root,'known-${HOME}')},{user:'-option'},{address:'8.8.8.8'},{guestId:'bad'},{knownHosts:'/tmp/../tmp/host'},{mode:'forward',hostPort:0,guestPort:1},{command:'bad\0'}])assert.throws(()=>startGuestSSH({...config,mode:'command',command:'true',...patch}));
 groups.push('input-refusals');
 mode='success';
 for(const mutation of ['changed','missing','symlink','shared']){
  if(mutation==='changed')await writeFile(knownHosts,'changed');
  if(mutation==='missing')await rm(knownHosts);
  if(mutation==='symlink')await symlink(join(root,'child.py'),knownHosts);
  if(mutation==='shared'){await rm(knownHosts);await writeFile(knownHosts,pin,{mode:0o644});}
  const previous=lastChild;resource=start({mode:'command',command:'never'});await assert.rejects(resource.result);assert((await resource.closed).closed);assert.equal(lastChild,previous,'Invalid pin must not start an authentication process');
 }
 await chmod(knownHosts,0o600);groups.push('pin-failures-before-authentication');
 // Use the installed OpenSSH parser, without connecting, for literal path fidelity.
 const parsed=spawn('/usr/bin/ssh',['-G','-F','none','-o',`UserKnownHostsFile="${knownHosts}"`,'--','salehguest@192.168.64.2'],{stdio:['ignore','pipe','ignore']});
 let configuration='';parsed.stdout.on('data',chunk=>configuration+=chunk);assert.equal((await once(parsed,'close'))[0],0);assert(configuration.split('\n').includes('userknownhostsfile '+knownHosts));groups.push('installed-ssh-space-path');
 mode='unknown';const timer=globalThis.setTimeout;
 try{
  globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===5000?40:ms,...args);
  resource=start({mode:'forward',hostPort:19001,guestPort:19002});
  while(lastChild===previous)await new Promise(r=>timer(r,5));
  if(lastChild.exitCode===null)await once(lastChild,'exit');
  let observed=false;const observation=resource.closed.catch(()=>{observed=true;});
  const stop=resource.stop();await assert.rejects(stop,/closure deadline/);assert.equal(observed,false,'Deadline must not invent pipe EOF');
  assert.equal(stop,resource.stop());await observation;await assert.rejects(resource.stop(),/closure deadline/);groups.push('unknown-closure-retains-observer');
 }finally{globalThis.setTimeout=timer;await resource.closed.catch(()=>{});}
 console.log(JSON.stringify({passed:true,groups,actualVMStarted:false,installedAppTouched:false}));
}finally{
 await Promise.allSettled(handles.map(h=>h.stop()));childProcess.spawn=spawn;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});
}
