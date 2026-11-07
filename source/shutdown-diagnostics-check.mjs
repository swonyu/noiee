// Disposable servers and files only; no user state, model, or app access.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,chmod,rm,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from './server.mjs';
import {nativeSignature} from './agent.mjs';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {ShutdownDiagnostics} from './shutdown-diagnostics.mjs';

const groups=[],root=await mkdtemp(join(tmpdir(),'shutdown-diagnostics-'));
async function until(check){for(let n=0;n<300;n++){if(await check())return;await delay(10);}assert.fail('Diagnostic checkpoint not reached');}
async function fixture(name,{failedPeer=false,unknown=false}={}){
 const dataDir=join(root,name),token=randomUUID(),counts={};let release;
 const gate=new Promise(r=>release=r),inert=key=>({start(){},async close(){counts[key]=(counts[key]??0)+1;return {stopped:true};}});
 const coding={...inert('coding'),dataDir,async close(){counts.coding=(counts.coding??0)+1;await gate;return {stopped:!unknown,executionRevoked:false};}};
 const git={...inert('git'),async close(){counts.git=(counts.git??0)+1;if(failedPeer)throw Error('SECRET_COMMAND_PASSWORD');return {stopped:true};}};
 const server=createServer({instanceToken:token,coding,hub:inert('tools'),worktrees:inert('worktrees'),gitWorkflow:git,schedules:inert('schedules')});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 async function post(op,input={},signed=true){const route='/api/tools/'+op,body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now());return fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',headers:{'content-type':'application/json',...(signed?{'x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,body)}:{})},body});}
 return {dataDir,server,counts,release,post,status:async()=>{const r=await post('shutdownStatus');assert.equal(r.status,200,'Signed inspection must remain available');return r.json();},async close(){release();await server.shutdownTools();server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
try{
 for(const mode of ['closed','failed','unknown']){
  const f=await fixture(mode,{failedPeer:mode==='failed',unknown:mode==='unknown'});
  try{
   assert.deepEqual(await f.status(),{record:null,persistence:'idle',savedRevision:0});
   assert.equal((await f.post('shutdownStatus',{},false)).status,403);
   for(const bad of [null,[],{retry:true}])assert.equal((await f.post('shutdownStatus',bad)).status,400);
   const closing=f.server.shutdownTools('parent-eof');assert.equal(closing,f.server.shutdownTools('sigterm'));
   await until(()=>f.counts.coding===1);
   const pending=await f.status();assert.equal(pending.record.state,'pending');assert.equal(pending.record.trigger,'parent-eof');
   assert.equal(pending.record.subsystems.coding,'pending');assert.equal(pending.record.subsystems.git,mode==='failed'?'failed':'closed');
   assert.equal((await f.post('coding',{action:'status'})).status,503);
   await until(async()=>{const s=await f.status();return s.persistence==='saved'&&s.savedRevision===s.record.revision;});
   const files=await readdir(join(f.dataDir,'shutdown'));assert.equal(files.length,1);
   const path=join(f.dataDir,'shutdown',files[0]),before=JSON.parse(await readFile(path));assert.equal(before.state,'pending');
   f.release();const result=await closing;assert.equal(result.stopped,mode==='closed');
   const status=await f.status(),disk=JSON.parse(await readFile(path));assert.deepEqual(disk,status.record);
   assert.equal(status.persistence,'saved');assert.equal(disk.state,mode==='closed'?'closed':'unconfirmed');assert.equal(disk.executionRevoked,false);
   assert(!JSON.stringify(status).includes('SECRET'));assert(!JSON.stringify(disk).includes('SECRET'));
   assert.deepEqual(await (await f.post('stop')).json(),result);assert.deepEqual(f.counts,{tools:1,worktrees:1,git:1,schedules:1,coding:1});
   groups.push('signed pending progress, final durable '+mode);
  }finally{await f.close();}
 }
 for(const mode of ['initial','final']){
  const f=await fixture('persistence-'+mode);
  try{
   if(mode==='initial'){await mkdir(f.dataDir,{mode:0o700});await symlink(root,join(f.dataDir,'shutdown'));}
   const closing=f.server.shutdownTools();await until(()=>f.counts.coding===1);
   if(mode==='final'){
    await until(async()=>(await f.status()).persistence==='saved');
    const [file]=await readdir(join(f.dataDir,'shutdown'));await chmod(join(f.dataDir,'shutdown',file),0o644);
   }
   f.release();const result=await closing;assert.equal(result.stopped,false,'Failed persistence must prevent successful shutdown');
   const status=await f.status();assert.equal(status.persistence,'failed');assert.equal(status.record.state,'closed','Cleanup still settles independently');
   assert.equal(status.record.subsystems.coding,'closed');assert.equal(f.counts.coding,1);
   assert.deepEqual(await f.server.shutdownTools(),result);groups.push(mode+' persistence failure retains outcome without retry');
  }finally{await f.close();}
 }
 {
  const f=await fixture('new-ancestors/child'),original=fs.open,synced=[];
  fs.open=async(...args)=>{const file=await original(...args),sync=file.sync.bind(file);file.sync=async()=>{synced.push(String(args[0]));return sync();};return file;};syncBuiltinESMExports();
  try{
   f.release();assert.equal((await f.server.shutdownTools()).stopped,true);
   for(const path of [root,join(root,'new-ancestors'),f.dataDir,join(f.dataDir,'shutdown')])assert(synced.includes(await fs.realpath(path)),'New record directory entries must be synced in each parent');
   groups.push('new directory ancestry synced before saved');
  }finally{fs.open=original;syncBuiltinESMExports();await f.close();}
 }
 {
  for(const path of [root+'/new/../coding',root+'//coding']){
   const record=new ShutdownDiagnostics(path);record.begin();assert.equal(await record.finish({stopped:true}),false);assert.equal(record.view().persistence,'failed');
  }
  groups.push('non-normalized directory refused without ancestry loop');
 }
 for(const trigger of ['parent-eof','sigterm','sigint']){
  const dataDir=join(root,trigger),source=new URL('./server.mjs',import.meta.url).href;
  const code=`import {createServer,watchParent} from ${JSON.stringify(source)};
   let release;const gate=new Promise(r=>release=r);process.on('message',()=>release());process.channel.unref();
   const inert={start(){},async close(){return {stopped:true}}};
   const coding={...inert,dataDir:${JSON.stringify(dataDir)},async close(){process.send('closing');await gate;return {stopped:true,executionRevoked:false}}};
   const server=createServer({coding,hub:inert,worktrees:{...inert},gitWorkflow:inert,schedules:inert});
   watchParent(trigger=>server.shutdownTools(trigger));process.send('ready');`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe','ipc']}),events=[];let done=false,stderr='';
  child.on('message',m=>events.push(m));child.stderr.on('data',b=>stderr+=b);child.stdout.resume();const ended=once(child,'close');void ended.then(()=>done=true);
  try{
   await until(()=>events.includes('ready'));if(trigger==='parent-eof')child.stdin.end();else child.kill(trigger.toUpperCase());
   await until(()=>events.includes('closing'));assert.equal(done,false);child.send('release');
   const [exit,signal]=await Promise.race([ended,delay(4000).then(()=>assert.fail('Parent loss failed to settle: '+stderr))]);assert.equal(exit,0);assert.equal(signal,null);
   const [file]=await readdir(join(dataDir,'shutdown'));const record=JSON.parse(await readFile(join(dataDir,'shutdown',file)));assert.equal(record.state,'closed');assert.equal(record.trigger,trigger);
   groups.push('actual '+trigger+' persists before exit');
  }finally{if(!done)child.kill('SIGKILL');await ended;}
 }
 console.log(JSON.stringify({passed:true,groups,installedAppTouched:false},null,2));
}finally{await rm(root,{recursive:true,force:true});}
