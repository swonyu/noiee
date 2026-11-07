import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,chmod,symlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {GitRunner,GIT_FLAGS} from './git-runner.mjs';
import {verifyHandoffProcessReceipt,verifyHandoffHelper,releaseHandoffProcess} from './handoff-process.mjs';

const fixture=await realpath(await mkdtemp(join(tmpdir(),'saleh-handoff-process-'))),checks=[];
const tick=()=>new Promise(resolve=>setImmediate(resolve)),deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const receipt=(nonce,pid=12345)=>({version:1,nonce,pid,pgid:pid,uid:process.getuid(),startSec:'1791854000',startUsec:123456,bootSession:'12345678-ABCD-1234-ABCD-123456789ABC'});
function fake(){const child=new EventEmitter();Object.assign(child,{pid:12345,exitCode:null,signalCode:null,killed:false,stdio:[null,null,null,new PassThrough(),new PassThrough()]});let released='';child.stdio[4].on('data',chunk=>released+=chunk);return {child,output:()=>released};}
const unhandled=[],onUnhandled=error=>unhandled.push(error);process.on('unhandledRejection',onUnhandled);
try{
  const nonce=randomUUID(),valid=receipt(nonce);assert(Object.isFrozen(verifyHandoffProcessReceipt(valid,{nonce,pid:valid.pid})));
  for(const [key,value] of [['extra',true],['nonce',randomUUID()],['pid',valid.pid+1],['pgid',1],['uid',-1],['startSec','01'],['startSec',valid.startSec+'\n'],['startSec','18446744073709551616'],['startUsec',1000000],['bootSession',valid.bootSession.toLowerCase()],['bootSession',valid.bootSession+'\n']])assert.throws(()=>verifyHandoffProcessReceipt({...valid,[key]:value},{nonce,pid:valid.pid}),/identity/);
  assert.throws(()=>verifyHandoffProcessReceipt({...valid,nonce:nonce+'\n'},{nonce:nonce+'\n',pid:valid.pid}),/identity/);
  assert.throws(()=>verifyHandoffProcessReceipt({...valid,pid:2147483648,pgid:2147483648},{nonce,pid:2147483648}),/identity/);
  assert.equal(verifyHandoffProcessReceipt({...valid,startSec:'18446744073709551615'},{nonce,pid:valid.pid}).startSec,'18446744073709551615');
  checks.push('Receipt binds exact fields, nonce, spawned PID/group, uid, boot and start-time format');
  {
    const {child,output}=fake(),record=deferred(),entered=deferred();let recorded;
    const gate=releaseHandoffProcess(child,nonce,{record:async value=>{recorded=value;entered.resolve();await record.promise;}});
    child.stdio[3].write(JSON.stringify(valid)+'\n');await tick();assert.equal(recorded,undefined,'EOF must precede recording');assert.equal(output(),'');
    child.stdio[3].end();await entered.promise;assert.deepEqual(recorded,valid);assert.equal(output(),'','No release before durable recording');record.resolve();assert.deepEqual(await gate,valid);assert.equal(output(),nonce+'\n');
    checks.push('Receipt EOF then durable record then exact nonce release, in that order');
  }
  for(const input of ['',JSON.stringify({...valid,pid:12346})+'\n',JSON.stringify(valid)+'\nextra',JSON.stringify(valid).replace('{','{"version":1,')+'\n','x'.repeat(4097)]){
    const {child,output}=fake();let called=false;const rejected=assert.rejects(releaseHandoffProcess(child,nonce,{record:()=>{called=true;}}));child.stdio[3].end(input);await rejected;assert.equal(called,false);assert.equal(output(),'');
  }
  checks.push('Early EOF, forged identity, trailing data and oversized receipt never record or release');
  {
    const {child,output}=fake(),held=deferred(),entered=deferred(),abort=deferred();
    const gate=releaseHandoffProcess(child,nonce,{abort:abort.promise,record:async()=>{entered.resolve();await held.promise;}});
    const outcome=gate.then(()=>({ok:true}),error=>({ok:false,error}));
    child.stdio[3].end(JSON.stringify(valid)+'\n');await entered.promise;abort.resolve(false);
    let timer;try{const result=await Promise.race([outcome,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Gate remained pending after abort with no child exit')),500);})]);assert.equal(result.ok,false);assert.match(result.error.message,/aborted/);assert.equal(child.stdio[4].destroyed,true);assert.equal(output(),'');}
    finally{clearTimeout(timer);held.reject(new Error('late aborted record rejection'));await tick();}
    checks.push('Cancellation deadline closes release and rejects pending record even without child exit');
  }
  for(const mode of ['record-reject','early-exit','stop-during-record','close-during-record','error-during-record','check-after-record']){
    const {child,output}=fake(),held=deferred(),entered=deferred();let stopped=false;
    const gate=releaseHandoffProcess(child,nonce,{check:()=>{if(stopped)throw new Error('fixture stopped');},record:async()=>{entered.resolve();if(mode==='record-reject')throw new Error('fixture record rejected');if(mode==='check-after-record'){stopped=true;return;}await held.promise;}}),rejected=assert.rejects(gate,/fixture|exited/);
    if(mode==='early-exit')child.emit('exit',1,null);else{child.stdio[3].end(JSON.stringify(valid)+'\n');await entered.promise;if(mode==='stop-during-record'){stopped=true;child.killed=true;child.emit('exit',null,'SIGTERM');}if(mode==='close-during-record')child.emit('close',1,null);if(mode==='error-during-record')child.emit('error',new Error('fixture child failed'));}
    await Promise.race([rejected,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Gate waited for pending record after exit')),1000);timer.unref();})]);assert.equal(output(),'');if(['stop-during-record','close-during-record','error-during-record'].includes(mode))held.reject(new Error('late record rejection'));else held.resolve();await tick();
  }
  assert.deepEqual(unhandled,[]);checks.push('Record failure, Stop, early exit and close reject promptly; late record failures stay observed');
  const helper=join(fixture,'helper.mjs');await writeFile(helper,'#!/opt/homebrew/bin/node\n',{mode:0o700});const identity=await verifyHandoffHelper(helper);assert.deepEqual(await verifyHandoffHelper(helper,identity),identity);await assert.rejects(verifyHandoffHelper(helper,{...identity,ino:'1'}),/changed/);await chmod(helper,0o722);await assert.rejects(verifyHandoffHelper(helper),/unsafe/);await chmod(helper,0o700);await symlink(helper,helper+'.link');await assert.rejects(verifyHandoffHelper(helper+'.link'),/canonical/);checks.push('Helper identity is canonical, executable, safely owned and pinned');
  await writeFile(helper,`#!/opt/homebrew/bin/node
import fs from 'node:fs';
const args=process.argv.slice(2),nonce=args[2],expected=JSON.stringify({version:1,nonce,pid:process.pid,pgid:process.pid,uid:process.getuid(),startSec:'1791854000',startUsec:1,bootSession:'12345678-ABCD-1234-ABCD-123456789ABC'});
fs.writeSync(3,expected+'\\n');fs.closeSync(3);const release=fs.readFileSync(4,'utf8');if(release!==nonce+'\\n')process.exit(12);
fs.writeFileSync(${JSON.stringify(join(fixture,'released'))},nonce);let input='';process.stdin.on('data',chunk=>{input+=chunk;if(args.includes('prepared-fixture')&&input.endsWith('prepare\\n'))process.stdout.write('prepare: ok\\n');if(input.endsWith('commit\\n'))process.stdin.destroy();});process.stdin.on('end',()=>process.stdout.write(input));process.stdin.on('close',()=>process.exit(0));
`);
  for(const mode of ['success','record-reject','stop-pending','stop-unknown-exit','prepared']){
    const entered=deferred(),held=deferred(),launches=[];let stopped=false,releasedAtStart;
    try{releasedAtStart=await readFile(join(fixture,'released'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    const runner=new GitRunner({dataDir:fixture,nativeHelper:helper,processGuard:({args,scope})=>{assert.equal(scope.files[0],join(fixture,'released'));assert.equal(args[0],mode==='prepared'?'prepared-fixture':'fixture');return async value=>{entered.resolve(value);if(mode==='record-reject')throw new Error('record refused');await held.promise;};},spawnProcess:(file,args,options)=>{
      assert.equal(file,helper);assert.deepEqual(args.slice(0,2),['--handoff-process','git']);assert.deepEqual(args.slice(4,4+GIT_FLAGS.length),GIT_FLAGS);assert.deepEqual(options.stdio,['pipe','pipe','pipe','pipe','pipe']);const child=spawn(process.execPath,[file,...args],options);launches.push(child);
      if(mode==='stop-unknown-exit'){const unknown=new EventEmitter();Object.assign(unknown,{pid:child.pid,exitCode:null,signalCode:null,stdio:child.stdio,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr});child.on('error',error=>unknown.emit('error',error));return unknown;}return child;
    }});
    const work=runner.run([mode==='prepared'?'prepared-fixture':'fixture'],{scope:{files:[join(fixture,'released')]},input:mode==='prepared'?'start\nprepare\n':'EXPECTED INPUT\n',check:()=>{if(stopped)throw new Error('fixture stopped');},...(mode==='prepared'?{prepared:async()=>{assert.equal(await readFile(join(fixture,'released'),'utf8'),value.nonce);}}:{})});
    const result=mode==='record-reject'||mode.startsWith('stop-')?assert.rejects(work,/record refused|cancelled|stopped|exited|exit was not confirmed/):work;
    const value=await entered.promise;await tick();if(mode!=='record-reject'){let current;try{current=await readFile(join(fixture,'released'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}assert.equal(current,releasedAtStart,'No effect before durable record');}
    if(mode.startsWith('stop-')){stopped=true;runner.cancel();let timer;try{await Promise.race([result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Git cancellation waited for an unreported exit')),4000);})]);}finally{clearTimeout(timer);held.reject(new Error('late durable record rejection'));}}else{held.resolve();const completed=await result;if(mode==='success')assert.equal(completed.stdout,'EXPECTED INPUT\n');}
    assert.equal(runner.child,null);assert.equal(runner.blocked,mode==='stop-unknown-exit');for(const child of launches)assert.throws(()=>process.kill(-child.pid,0),{code:'ESRCH'});await tick();
  }
  assert.deepEqual(unhandled,[]);checks.push('Guarded GitRunner waits for record before stdin/effects, preserves prepared callback, cancels pending record, observes actual exits, and never falls back');
  const result={passed:true,fixture,checks};await writeFile(join(fixture,'evidence.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{process.off('unhandledRejection',onUnhandled);}
