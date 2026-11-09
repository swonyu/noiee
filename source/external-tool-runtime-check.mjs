// Offline only: fixture artifact is never executed, imported or probed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ExternalToolRuntime,EXTERNAL_JS_LOADER} from './external-tool-runtime.mjs';
import {MCPHub} from './mcp.mjs';
import {BoundedStdioTransport} from './mcp-transport.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const cache=path.join(os.homedir(),'Library','Caches');
const base=fs.realpathSync(fs.mkdtempSync(path.join(cache,'noiee-external-runtime-check-')));
const authority={};let manager,spawns=0,hold,mutate,failAfterAdmission=false,hashOverride,disconnectFails=false,afterAdmission,disconnectCalls=[];
const hub={describe:async()=>({servers:manager.managedExternal().map(e=>({id:e.id,configHash:hashOverride??hash(JSON.stringify(e.config))}))}),
  connectExternal:async(id,configHash,token,pre)=>{assert.equal(token,authority);const consume=await pre();if(hold)await hold;if(mutate)mutate();const snapshot=consume();assert(Buffer.isBuffer(snapshot));assert.equal(hash(snapshot),revision);assert.throws(consume,/already consumed/);spawns++;if(afterAdmission)await afterAdmission();if(failAfterAdmission)throw Error('Injected failed handshake');return{connected:true};},disconnect:async(id)=>{disconnectCalls.push(id);if(disconnectFails)throw Error('Injected unconfirmed owned exit');return{connected:false};}};
const setup=(opts={})=>new ExternalToolRuntime({parent:base,hub,authority,unconfinedBoot:true,recoveryStartup:false,assertUnconfinedAccess:async()=>{},runtimeIdentity:()=>({executable:'/offline/never-spawn',sha256:'a'.repeat(64),version:'offline-fixture',identity:'b'.repeat(64),contractSHA256:'c'.repeat(64)}),...opts});
const revision=hash('/* inert fixture, NEVER execute */');
const root=path.join(base,'external-tools-v1'),dest=path.join(root,'revisions',revision);
fs.mkdirSync(dest,{recursive:true,mode:0o700});
for(const p of [root,path.join(root,'revisions'),dest])fs.chmodSync(p,0o700);
fs.writeFileSync(path.join(dest,'artifact.mjs'),'/* inert fixture, NEVER execute */',{mode:0o400});
fs.writeFileSync(path.join(dest,'receipt.json'),JSON.stringify({version:1,kind:'inert-external-js-install',operationId:randomUUID(),generation:randomUUID(),url:'https://raw.githubusercontent.com/example/example/'+'a'.repeat(40)+'/tool.mjs',sha256:revision,bytes:33,purpose:'Offline fixture',sourceTrust:'unreviewed-external',launch:'never-started'}),{mode:0o400});
// Keep fixture byte count derived, not manually trusted.
let receipt=JSON.parse(fs.readFileSync(path.join(dest,'receipt.json')));receipt.bytes=fs.statSync(path.join(dest,'artifact.mjs')).size;fs.chmodSync(path.join(dest,'receipt.json'),0o600);fs.writeFileSync(path.join(dest,'receipt.json'),JSON.stringify(receipt));fs.chmodSync(path.join(dest,'receipt.json'),0o400);
const publish=r=>{const run=path.join(root,'runs',r.launchID);fs.mkdirSync(run,{recursive:true,mode:0o700});for(const name of ['home','tmp','work'])fs.mkdirSync(path.join(run,name),{mode:0o700});fs.writeFileSync(path.join(run,'pending.json'),JSON.stringify({version:1,kind:'external-js-launch-pending',review:r}),{mode:0o400});return run;};
const persist=(launchID,name,value)=>fs.writeFileSync(path.join(root,'runs',launchID,name),JSON.stringify(value),{mode:0o400,flag:'wx'});
const persistClosure=closure=>{if(closure)persist(closure.launchID,'closure.json',closure);};
const persistOutcome=(review,state)=>persist(review.launchID,'outcome.json',{version:1,kind:'external-js-launch-outcome',launchID:review.launchID,fingerprint:review.fingerprint,state});
const acknowledge=review=>{fs.mkdirSync(path.join(root,'rearms'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(root,'rearms',review.rearmID+'.json'),JSON.stringify({version:1,kind:'external-js-rearm-acknowledgment',review,decision:'acknowledge-uncertain-prior-effects'}),{mode:0o400,flag:'wx'});};
const approve=r=>({prepareId:r.prepareId,nonce:r.nonce,fingerprint:r.fingerprint});
try{
 for(const options of [{unconfinedBoot:false},{recoveryStartup:true}])await assert.rejects(setup(options).prepare({revision}),/boot/);
 manager=setup();let r=await manager.prepare({revision});assert.equal(spawns,0);assert.deepEqual(r.config.args,['--input-type=module','--eval',EXTERNAL_JS_LOADER,'--',revision]);assert.deepEqual(Object.keys(r.config.env).sort(),['HOME','LANG','LC_ALL','PATH','TMPDIR']);
 await assert.rejects(manager.commit({...approve(r),nonce:'forged'}),/approval/);await assert.rejects(manager.commit(approve(r)),/approval/);assert.equal(spawns,0);
 r=await manager.prepare({revision});let result=await manager.commit(approve(r));assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,0);
 r=await manager.prepare({revision});publish(r);result=await manager.commit(approve(r));assert.equal(result.launchState,'connected',JSON.stringify(result));assert.equal(spawns,1);await assert.rejects(manager.commit(approve(r)),/approval/);
 persistClosure((await manager.disconnect(revision)).closure);r=await manager.prepare({revision});publish(r);
 let release;hold=new Promise(resolve=>release=resolve);const commit=manager.commit(approve(r));await new Promise(resolve=>setTimeout(resolve,100));await manager.stop();release();result=await commit;assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,1);hold=null;
 manager=setup();assert.equal((await manager.prepare({revision})).needsRearm,true);
 // Independent fresh fixtures exercise mutations and uncertain handshake outcomes.
 const reset=()=>{fs.rmSync(path.join(root,'runs'),{recursive:true,force:true});fs.rmSync(path.join(root,'rearms'),{recursive:true,force:true});manager=setup();};
 reset();r=await manager.prepare({revision});publish(r);assert.throws(()=>{r.config.env.PATH='/tampered';},TypeError);
 hashOverride='d'.repeat(64);result=await manager.commit(approve(r));assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,1);hashOverride=undefined;
 reset();r=await manager.prepare({revision});publish(r);
 const artifactPath=path.join(dest,'artifact.mjs'),original=fs.readFileSync(artifactPath);fs.chmodSync(artifactPath,0o600);fs.writeFileSync(artifactPath,'/* changed */');fs.chmodSync(artifactPath,0o400);
 result=await manager.commit(approve(r));assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,1);
 fs.chmodSync(artifactPath,0o600);fs.writeFileSync(artifactPath,original);fs.chmodSync(artifactPath,0o400);
 reset();r=await manager.prepare({revision});let run=publish(r);fs.chmodSync(path.join(run,'pending.json'),0o600);fs.writeFileSync(path.join(run,'pending.json'),JSON.stringify({version:1,kind:'external-js-launch-pending',review:{...r,fingerprint:'forged'}}));fs.chmodSync(path.join(run,'pending.json'),0o400);
 result=await manager.commit(approve(r));assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,1);
 reset();r=await manager.prepare({revision});publish(r);failAfterAdmission=true;result=await manager.commit(approve(r));failAfterAdmission=false;assert.equal(result.launchState,'launch-uncertain',JSON.stringify(result));assert.equal(spawns,2);await assert.rejects(manager.prepare({revision}),/Owned external/);persistClosure((await manager.disconnect(revision)).closure);assert.equal((await manager.status()).entries[0].state,'installed-disconnected');assert.equal((await manager.prepare({revision})).needsRearm,undefined);
 reset();r=await manager.prepare({revision});publish(r);let calls=0;mutate=()=>{calls++;fs.chmodSync(path.join(dest,'receipt.json'),0o600);};result=await manager.commit(approve(r));mutate=null;assert.equal(calls,1);assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,2);fs.chmodSync(path.join(dest,'receipt.json'),0o400);
 // Hard links, symlink leaves, and stale newer reviews are rejected without spawn.
 reset();const extra=path.join(base,'hardlink');fs.linkSync(artifactPath,extra);await assert.rejects(manager.prepare({revision}),/links|bounds/);fs.unlinkSync(extra);
 r=await manager.prepare({revision});const newer=await manager.prepare({revision});await assert.rejects(manager.commit(approve(r)),/approval/);assert.notEqual(newer.fingerprint,r.fingerprint);
 reset();manager=setup({runtimeIdentity:undefined});r=await manager.prepare({revision});assert.equal(r.runtime.version,process.version);assert.equal(spawns,2);
 // Restart paths retain receipts: safe outcomes/owned closures allow a NEW review only.
 reset();r=await manager.prepare({revision});publish(r);persistOutcome(r,'not-started');manager=setup();assert.equal((await manager.prepare({revision})).needsRearm,undefined);assert.equal(spawns,2);
 reset();r=await manager.prepare({revision});publish(r);result=await manager.commit(approve(r));assert.equal(result.launchState,'connected',JSON.stringify(result));persistOutcome(r,'connected');const closed=await manager.disconnect(revision);assert.equal(closed.closure.ownedExitConfirmed,true);assert.equal(closed.closure.descendants,'not-proven-terminated');persistClosure(closed.closure);manager=setup();assert.equal((await manager.prepare({revision})).needsRearm,undefined);assert.equal(spawns,3);
 // A retained uncertain record needs its own explicit acknowledgment, then a separate launch review.
 reset();r=await manager.prepare({revision});publish(r);persistOutcome(r,'launch-uncertain');manager=setup();let needed=await manager.prepare({revision});assert.equal(needed.needsRearm,true);assert.equal(needed.review.history[0].classification,'unresolved');assert.equal(spawns,3);
 await assert.rejects(manager.rearm({rearmID:needed.review.rearmID,fingerprint:'forged'}),/acknowledgment/);await assert.rejects(manager.rearm({rearmID:needed.review.rearmID,fingerprint:needed.review.fingerprint}),/acknowledgment/);
 needed=await manager.prepare({revision});acknowledge(needed.review);assert.equal((await manager.rearm({rearmID:needed.review.rearmID,fingerprint:needed.review.fingerprint})).rearmed,true);await assert.rejects(manager.rearm({rearmID:needed.review.rearmID,fingerprint:needed.review.fingerprint}),/acknowledgment/);assert.equal((await manager.prepare({revision})).needsRearm,undefined);manager=setup();assert.equal((await manager.prepare({revision})).needsRearm,undefined);assert.equal(spawns,3);
 // New history invalidates an earlier acknowledgment, even across process restart.
 r=await manager.prepare({revision});publish(r);manager=setup();needed=await manager.prepare({revision});assert.equal(needed.needsRearm,true);assert.equal(needed.review.history.length,2);
 acknowledge(needed.review);persistOutcome(r,'not-started');await assert.rejects(manager.rearm({rearmID:needed.review.rearmID,fingerprint:needed.review.fingerprint}),/history changed/);assert.equal((await manager.prepare({revision})).needsRearm,true);
 // Stop revokes prepared re-arm capabilities, without removing any receipt.
 needed=await manager.prepare({revision});await manager.stop();await assert.rejects(manager.rearm({rearmID:needed.review.rearmID,fingerprint:needed.review.fingerprint}),/acknowledgment/);
 // Expired reviews cannot be acknowledged; an owned unconfirmed exit cannot be re-armed.
 needed=await manager.prepare({revision});const originalNow=Date.now;Date.now=()=>needed.review.expiresAt;try{await assert.rejects(manager.rearm({rearmID:needed.review.rearmID,fingerprint:needed.review.fingerprint}),/expired/);}finally{Date.now=originalNow;}
 reset();r=await manager.prepare({revision});publish(r);result=await manager.commit(approve(r));assert.equal(result.launchState,'connected',JSON.stringify(result));disconnectFails=true;await assert.rejects(manager.disconnect(revision),/unconfirmed/);let stopped=await manager.stop();assert.equal(stopped.stopped,false);assert.deepEqual(stopped.closures,[]);await assert.rejects(manager.prepare({revision}),/Owned external/);disconnectFails=false;stopped=await manager.stop();assert.equal(stopped.stopped,true);assert.equal(stopped.closures.length,1);persistClosure(stopped.closures[0]);manager=setup();assert.equal((await manager.prepare({revision})).needsRearm,undefined);
 // Normal launch review is invalidated if prior retained history changes before grant consumption.
 reset();r=await manager.prepare({revision});publish(r);persistOutcome(r,'not-started');manager=setup();const priorRun=r;r=await manager.prepare({revision});publish(r);const priorOutcome=path.join(root,'runs',priorRun.launchID,'outcome.json');fs.chmodSync(priorOutcome,0o600);fs.writeFileSync(priorOutcome,JSON.stringify({version:1,kind:'external-js-launch-outcome',launchID:priorRun.launchID,fingerprint:priorRun.fingerprint,state:'launch-uncertain'}));fs.chmodSync(priorOutcome,0o400);result=await manager.commit(approve(r));assert.equal(result.launchState,'not-started',JSON.stringify(result));
 // Socket cancellation consumes approval and fences every pre-spawn grant; dispatched loss stays uncertain.
 reset();r=await manager.prepare({revision});publish(r);let aborter=new AbortController();aborter.abort();let countBefore=spawns;result=await manager.commit(approve(r),{signal:aborter.signal});assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,countBefore);await assert.rejects(manager.commit(approve(r)),/approval/);
 reset();r=await manager.prepare({revision});publish(r);aborter=new AbortController();mutate=()=>aborter.abort();result=await manager.commit(approve(r),{signal:aborter.signal});mutate=null;assert.equal(result.launchState,'not-started',JSON.stringify(result));assert.equal(spawns,countBefore);
 reset();r=await manager.prepare({revision});publish(r);aborter=new AbortController();disconnectCalls=[];afterAdmission=async()=>aborter.abort();result=await manager.commit(approve(r),{signal:aborter.signal});afterAdmission=null;assert.equal(result.launchState,'launch-uncertain',JSON.stringify(result));assert.equal(spawns,countBefore+1);assert(disconnectCalls.length>0);assert(disconnectCalls.every(id=>id==='external-js-'+revision));await assert.rejects(manager.prepare({revision}),/Owned external/);
 reset();r=await manager.prepare({revision});publish(r);afterAdmission=async()=>{const stopped=await manager.stop();assert.equal(stopped.stopped,true);assert.equal(stopped.closures.length,1);};result=await manager.commit(approve(r));afterAdmission=null;assert.equal(result.launchState,'launch-uncertain',JSON.stringify(result));
 // Ordinary connect, identity forgery and reserved user IDs never enter spawn.
 const realHub=new MCPHub(path.join(base,'absent.json'),{managedExternal:()=>[],externalAuthority:authority});
 await assert.rejects(realHub.connect('external-js-'+revision,'a'.repeat(64)),/native review/);
 await assert.rejects(realHub.connectExternal('external-js-'+revision,'a'.repeat(64),{},()=>{}),/authority/);
 await realHub.close();
 const config=path.join(base,'mcp.json');fs.writeFileSync(config,JSON.stringify({mcpServers:{['external-js-'+revision]:{command:'/bin/false'}}}));
 const collisionHub=new MCPHub(config);await assert.rejects(collisionHub.describe(),/reserved/);await collisionHub.close();
 // Close while an asynchronous pre-start check is pending: no command runs.
 let releaseTransport;const transport=new BoundedStdioTransport({command:'/DO-NOT-EXECUTE',args:[],env:{},cwd:base},()=>{},{cleanEnvironment:true,beforeStart:()=>new Promise(resolve=>releaseTransport=()=>resolve(()=>{throw Error('must not consume');}))});
 const start=transport.start();await transport.close();releaseTransport();await assert.rejects(start,/closed before spawn/);await assert.rejects(transport.start(),/already started/);
 // Execute ONLY fixed, locally generated inert fixtures, never installed artifact bytes.
 const inert=Buffer.from('process.stdout.write("trusted-offline-fixture")');
 const fixtureFile=path.join(base,'loader-input');
 const runLoader=(bytes,expected)=>{fs.writeFileSync(fixtureFile,bytes);const fd=fs.openSync(fixtureFile,'r');try{return spawnSync(process.execPath,['--input-type=module','--eval',EXTERNAL_JS_LOADER,'--',expected],{stdio:['ignore','pipe','pipe',fd],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},timeout:5000,encoding:'utf8'});}finally{fs.closeSync(fd);}};
 let loaded=runLoader(inert,hash(inert));assert.equal(loaded.status,0,loaded.stderr);assert.equal(loaded.stdout,'trusted-offline-fixture');
 loaded=runLoader(inert,'f'.repeat(64));assert.notEqual(loaded.status,0);assert.equal(loaded.stdout,'');assert.match(loaded.stderr,/digest mismatch/);
 loaded=runLoader(Buffer.alloc(1048577,32),'f'.repeat(64));assert.notEqual(loaded.status,0);assert.equal(loaded.stdout,'');assert.match(loaded.stderr,/exceeds bound/);
 const generated=Buffer.from('process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"fixture",params:{marker:"snapshot",ambient:process.env.NOIEE_EXTERNAL_AMBIENT??null}})+"\\n")');
 const prior=process.env.NOIEE_EXTERNAL_AMBIENT;process.env.NOIEE_EXTERNAL_AMBIENT='must-not-inherit';
 let timer;const received=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Offline snapshot transport timed out')),5000);const t=new BoundedStdioTransport({command:process.execPath,args:['--input-type=module','--eval',EXTERNAL_JS_LOADER,'--',hash(generated)],env:{HOME:base,TMPDIR:base,PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},cwd:base},reject,{cleanEnvironment:true,sourceSnapshot:true,beforeStart:async()=>()=>Buffer.from(generated)});t.onmessage=message=>{resolve(message);void t.close();};t.onerror=reject;void t.start().catch(reject);});
 try{const message=await received;assert.equal(message.params.marker,'snapshot');assert.equal(message.params.ambient,null);}finally{clearTimeout(timer);if(prior===undefined)delete process.env.NOIEE_EXTERNAL_AMBIENT;else process.env.NOIEE_EXTERNAL_AMBIENT=prior;}
 console.log('PASS external runtime offline review, replay, boot, stop, uncertain, collision and grant checks; fd3 snapshot/hash/bounds and clean-environment checks; no unknown artifact execution.');
}finally{fs.rmSync(base,{recursive:true,force:true});}
