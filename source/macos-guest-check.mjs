import assert from 'node:assert/strict';
import {existsSync,constants} from 'node:fs';
import {mkdtemp,writeFile,appendFile,open,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const target=new URL('./macos-guest.mjs',import.meta.url);
assert(existsSync(target),'Production Node VM lifecycle module is missing');
const {startMacGuest}=await import(target);
const helper=resolve(process.argv[2]);
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const groups=[];
async function fixture(){
 const root=await mkdtemp('/private/tmp/saleh-node-vm-'),guestId=randomUUID().toUpperCase();
 const data={version:1,guestId,controller:'fixture',build:'test',macAddress:'02:00:00:00:00:01',cpu:4,memoryBytes:4*1024**3,diskBytes:64*1024**3,directoryShares:0};
 await writeFile(join(root,'fixture.json'),JSON.stringify(data),{mode:0o600});
 await writeFile(join(root,'installed.json'),JSON.stringify({build:'test',controller:'fixture',installed:true,state:'stopped'}),{mode:0o600});
 for(const name of ['hardware-model.bin','machine-id.bin','auxiliary.bin'])await writeFile(join(root,name),'stub',{mode:0o600});
 const file=await open(join(root,'disk.img'),'wx',0o600);await file.truncate(64*1024**3);await file.close();return root;
}
for(const mode of ['already-stopped','held-record','record-failure','changed-claim']){
 const root=await fixture(),signal=new AbortController(),entered=defer(),release=defer();let calls=0,resource;
 try{
  if(mode==='already-stopped')signal.abort();
  resource=startMacGuest({root,helper,ownerId:randomUUID(),generation:randomUUID(),credential:'A'.repeat(48),signal:signal.signal,recordClaim:async value=>{
   calls++;assert.equal(value.claim.parent.pid,process.pid);assert.equal(value.claim.process.pid,value.claim.process.pgid);entered.resolve(value);
   if(mode==='held-record')await release.promise;
   if(mode==='record-failure')throw Error('Injected durable record failure');
   if(mode==='changed-claim')await writeFile(join(root,'boot-claim.json'),'{}');
  }});
  const ready=resource.ready.then(()=>({ready:true}),error=>({error:error.message}));
  if(mode==='held-record'){
   await entered.promise;signal.abort();let stopped=false;
   const stop=resource.stop().then(value=>{stopped=true;return value;});
   const closed=await resource.closed;assert(closed.terminal.cancelledBeforeBoot);assert.equal(stopped,false,'Stop must retain pending durable callback ownership');
   release.resolve();assert((await stop).closureConfirmed);assert((await ready).error);
  }else if(mode==='already-stopped'){
   assert((await ready).error);const closed=await resource.stop();assert.equal(closed.launched,false);assert.equal(calls,0);assert(!existsSync(join(root,'boot-claim.json')));
  }else{
   assert((await ready).error);await assert.rejects(resource.stop());const closed=await resource.closed;assert(closed.terminal.cancelledBeforeBoot);
  }
  if(mode!=='already-stopped'){
   const events=(await readFile(join(root,'boot-events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
   assert(!events.some(row=>['boot-start','running'].includes(row.event)));
  }
  groups.push(mode);
 }finally{release.resolve();if(resource)await resource.stop().catch(()=>{});await rm(root,{recursive:true,force:true});}
}
{
 const root=await fixture(),script=join(root,'pipe-holder'),timer=globalThis.setTimeout;
 await writeFile(script,'#!/bin/sh\n/bin/sleep 0.5 &\nexit 1\n',{mode:0o700});
 // Accelerate only the production shutdown budget; the inherited pipe stays real.
 let deadlineStarted;
 globalThis.setTimeout=(fn,ms,...args)=>{if(ms===75000)deadlineStarted=Date.now();return timer(fn,ms===75000?50:ms,...args);};
 const resource=startMacGuest({root,helper:script,ownerId:randomUUID(),generation:randomUUID(),credential:'A'.repeat(48),signal:new AbortController().signal,recordClaim:()=>assert.fail('No native claim expected')});
 try{
  let observed=false;const closed=resource.closed.catch(()=>{observed=true;});
  await assert.rejects(resource.ready);await assert.rejects(resource.stop());
  assert(Number.isFinite(deadlineStarted)&&Date.now()-deadlineStarted<300,'Native shutdown deadline must return unknown before inherited output EOF');
  assert.equal(observed,false,'Timeout must not fabricate observed pipe closure');
  await closed;groups.push('shutdown-deadline-retains-observer');
 }finally{globalThis.setTimeout=timer;await resource.closed.catch(()=>{});await rm(root,{recursive:true,force:true});}
}
{
 const root=await fixture(),handle=await open(join(root,'fixture.json'),'r'),proto=Object.getPrototypeOf(handle),read=proto.read;
 await handle.close();let injected=false,extent;
 proto.read=async function(buffer,...args){
  if(!injected&&buffer?.length===65537){injected=true;await appendFile(join(root,'boot-claim.json'),Buffer.alloc(70000,32));}
  const result=await read.call(this,buffer,...args);if(injected)extent=result.bytesRead;return result;
 };
 const resource=startMacGuest({root,helper,ownerId:randomUUID(),generation:randomUUID(),credential:'A'.repeat(48),signal:new AbortController().signal,recordClaim:()=>assert.fail('Growing receipt must not be admitted')});
 try{
  await assert.rejects(resource.ready,/receipt changed while reading/);await assert.rejects(resource.stop());await assert.rejects(resource.closed);
  assert(injected);assert.equal(extent,65537);groups.push('receipt-growth-bounded');
 }finally{proto.read=read;await resource.stop().catch(()=>{});await rm(root,{recursive:true,force:true});}
}
{
 const root=await fixture(),signal=new AbortController(),entered=defer(),release=defer(),timer=globalThis.setTimeout;
 const resource=startMacGuest({root,helper,ownerId:randomUUID(),generation:randomUUID(),credential:'A'.repeat(48),signal:signal.signal,recordClaim:async()=>{entered.resolve();await release.promise;}});
 try{
  await entered.promise;
  globalThis.setTimeout=(fn,ms,...args)=>timer(fn,ms===75000?100:ms,...args);
  signal.abort();const stopping=resource.stop();await assert.rejects(stopping,/shutdown deadline exceeded/);
  release.resolve();await assert.rejects(resource.stop(),/shutdown deadline exceeded/);
  await resource.closed.catch(()=>{});await assert.rejects(resource.ready);groups.push('record-drain-deadline-sticky');
 }finally{globalThis.setTimeout=timer;release.resolve();await resource.stop().catch(()=>{});await resource.closed.catch(()=>{});await rm(root,{recursive:true,force:true});}
}
{
 const root=await fixture(),file=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),signal=new AbortController();let snapshot;
 const resource=startMacGuest({root,rootFD:file.fd,phase:'provision',helper,ownerId:randomUUID(),generation:randomUUID(),credential:'A'.repeat(48),signal:signal.signal,recordClaim:async value=>{
  snapshot=value;assert.equal(value.claim.trustedProvisioningOnly,true);assert.equal(value.claim.executionAdmitted,false);signal.abort();
 }});
 try{
  await assert.rejects(resource.ready);const closed=await resource.stop();assert(closed.closureConfirmed&&closed.terminal.cancelledBeforeBoot);
  assert(snapshot);assert(existsSync(join(root,'provision-claim.json')));assert(!existsSync(join(root,'boot-claim.json')));assert((await file.stat()).isDirectory());
  // A cancelled allocator cannot launch the execution phase after extraction.
  const execution=startMacGuest({root,rootFD:file.fd,phase:'execute',helper,ownerId:snapshot.ownerId,generation:snapshot.generation,credential:'A'.repeat(48),signal:signal.signal,recordClaim:()=>assert.fail('Cancelled phase must not be claimed')});
  await assert.rejects(execution.ready);assert.equal((await execution.stop()).launched,false);assert(!existsSync(join(root,'boot-claim.json')));assert((await file.stat()).isDirectory());groups.push('borrowed-provision-descriptor-and-cancelled-execution');
  // Synthetic completed provisioning checks the execution receipt without booting.
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),{cancelledBeforeBoot,...terminal}=closed.terminal;
  const terminalBytes=JSON.stringify({...terminal,started:true,errorCode:0,errorDomain:''});await writeFile(join(root,'provision-terminal.json'),terminalBytes);
  const st=await stat(join(root,'disk.img'),{bigint:true});
  const pin={passed:true,detached:true,diskUnchanged:true,guestId:snapshot.claim.guestId,provisioningClaimSHA256:snapshot.claimSHA256,provisioningTerminalSHA256:digest(terminalBytes),disk:{dev:String(st.dev),ino:String(st.ino),size:String(st.size),mode:Number(st.mode),uid:Number(st.uid),nlink:Number(st.nlink),mtimeNS:String(st.mtimeNs),ctimeNS:String(st.ctimeNs)}};
  await writeFile(join(root,'host-key.json'),JSON.stringify(pin),{mode:0o600});
  const nextSignal=new AbortController();let recorded=false;
  const next=startMacGuest({root,rootFD:file.fd,phase:'execute',helper,ownerId:snapshot.ownerId,generation:snapshot.generation,credential:'A'.repeat(48),signal:nextSignal.signal,recordClaim:value=>{recorded=true;assert.equal(value.claim.executionAdmitted,true);assert.equal(value.claim.provisioning,false);assert.equal(value.claim.provisioningClaimSHA256,snapshot.claimSHA256);nextSignal.abort();}});
  try{await assert.rejects(next.ready);assert((await next.stop()).terminal.cancelledBeforeBoot);assert(recorded);assert((await file.stat()).isDirectory());groups.push('execute-evidence-receipt-and-cancellation');}
  finally{await next.stop().catch(()=>{});}
 }finally{await resource.stop().catch(()=>{});await file.close();await rm(root,{recursive:true,force:true});}
}
{
 const root=await fixture(),file=await open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 await writeFile(join(root,'provision-claim.json'),JSON.stringify({policy:null}),{mode:0o600});
 const resource=startMacGuest({root,rootFD:file.fd,phase:'execute',helper,ownerId:randomUUID(),generation:randomUUID(),credential:'A'.repeat(48),signal:new AbortController().signal,recordClaim:()=>assert.fail('Downgrade must not be recorded')});
 try{await assert.rejects(resource.ready,/installation admission/);await assert.rejects(resource.stop());assert.equal((await resource.closed).launched,false);groups.push('legacy-transitive-installation-downgrade-before-spawn');}
 finally{await resource.stop().catch(()=>{});await resource.closed.catch(()=>{});await file.close();await rm(root,{recursive:true,force:true});}
}
{
 const root=await fixture();
 const resource=startMacGuest({root,helper,ownerId:randomUUID(),generation:randomUUID(),credential:'A'.repeat(48),signal:new AbortController().signal,recordClaim:()=>writeFile(join(root,'install-claim.json'),'{}',{mode:0o600})});
 try{await assert.rejects(resource.ready,/installation admission/);await assert.rejects(resource.stop());assert((await resource.closed).terminal.cancelledBeforeBoot);groups.push('legacy-installation-appearance-before-release');}
 finally{await resource.stop().catch(()=>{});await resource.closed.catch(()=>{});await rm(root,{recursive:true,force:true});}
}
console.log(JSON.stringify({passed:true,groups,actualVMStarted:false,syntheticProvisioningRecords:true}));
