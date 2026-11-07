import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RUNTIME,LEGACY_RUNNER_SHA256,expectedWindow,assertReply,assertToolFree,assertWindows,rootCompactions,validateLegacyEvidence,loadResumeReceipt,assertReceiptUnchanged} from './live-profile-helpers.mjs';

const runtime={cliVersion:RUNTIME.cliVersion,sha256:RUNTIME.sha256};
function example(){
  const threadId='root-1',wire=[
    {method:'item/completed',threadId,turnId:'turn-1',type:'agentMessage',text:'PROFILE_READY'},
    {method:'thread/tokenUsage/updated',params:{threadId,turnId:'turn-1',tokenUsage:{modelContextWindow:37452}}},
    {method:'item/completed',threadId,turnId:'turn-2',type:'contextCompaction'},
    {method:'item/completed',threadId,turnId:'turn-2',type:'agentMessage',text:'CONTEXT_ACK'},
    {method:'thread/tokenUsage/updated',params:{threadId,turnId:'turn-2',tokenUsage:{modelContextWindow:37452}}}
  ];
  const sourcePins={'coding-engine.mjs':'a'.repeat(64)};
  const prior={version:1,runner:{sha256:LEGACY_RUNNER_SHA256},sourcePins,runtime,exitCode:1,failed:1,error:'Native reported window must match the configured loaded profile',threadId,childPID:90001,turns:[{id:'turn-1',label:'initial',status:'completed',error:null},{id:'turn-2',label:'context-1',status:'completed',error:null}],fixture:'/generated/Noiee172-LiveProfile-test',wire,model:{contextLength:39424},admittedConfig:{model_context_window:39424},completedAt:'2026-11-07T00:50:15Z'};
  const shutdown={fixture:prior.fixture,rootThread:threadId,childPID:90001,runnerPID:90000,completedTurns:2,childExitConfirmed:true,runnerExitConfirmed:true,originalAppOrModelStopped:false,recordedAt:'2026-11-07T00:52:08Z'};
  return {prior,shutdown,sourcePins};
}
test('pinned runtime reports effective input context with integer truncation',()=>{
  assert.equal(expectedWindow(39424,runtime),37452);
  assert.equal(expectedWindow(32768,runtime),31129);
  assert.equal(expectedWindow(65536,runtime),62259);
});
test('effective-window rule rejects another binary or version',()=>{
  assert.throws(()=>expectedWindow(39424,{...runtime,sha256:'0'.repeat(64)}));
  assert.throws(()=>expectedWindow(39424,{...runtime,cliVersion:'codex-cli future'}));
});
test('raw configured value cannot pass the effective-window assertion',()=>{
  const {prior}=example();prior.wire[1].params.tokenUsage.modelContextWindow=39424;
  assert.throws(()=>assertWindows(prior.wire,prior.threadId,39424,runtime));
});
test('missing or child-only usage does not qualify root context',()=>{
  const {prior}=example();
  assert.throws(()=>assertWindows([],prior.threadId,39424,runtime));
  assert.throws(()=>assertWindows(prior.wire,'other-root',39424,runtime));
  prior.wire[1].params.tokenUsage.modelContextWindow=null;
  assert.throws(()=>assertWindows(prior.wire,prior.threadId,39424,runtime));
});
test('reply qualification rejects wrong text, another turn, or extra commentary',()=>{
  const {prior}=example();assertReply(prior.wire,prior.threadId,'turn-1','PROFILE_READY');
  assert.throws(()=>assertReply(prior.wire,prior.threadId,'turn-1','WRONG'));
  assert.throws(()=>assertReply(prior.wire,prior.threadId,'other-turn','PROFILE_READY'));
  prior.wire.push({...prior.wire[0],text:'additional prose'});
  assert.throws(()=>assertReply(prior.wire,prior.threadId,'turn-1','PROFILE_READY'));
});
test('tool-free evidence rejects tools even without pending approval',()=>{
  for(const type of ['commandExecution','fileChange','mcpToolCall','collabAgentToolCall','dynamicToolCall','plan','unknownFutureType']) {
    const {prior}=example();prior.wire.push({method:'item/started',threadId:prior.threadId,type});
    assert.throws(()=>assertToolFree(prior.wire,prior.threadId),type);
  }
});
test('tool-free evidence rejects child output and approval requests',()=>{
  const {prior}=example();assertToolFree(prior.wire,prior.threadId);
  assert.throws(()=>assertToolFree([...prior.wire,{...prior.wire[0],threadId:'child'}],prior.threadId));
  assert.throws(()=>assertToolFree([...prior.wire,{kind:'server-request',method:'item/commandExecution/requestApproval'}],prior.threadId));
});
test('compaction must be completed, exact type, and owned by the root',()=>{
  const {prior}=example();assert.equal(rootCompactions(prior.wire,prior.threadId).length,1);
  for(const change of [{threadId:'child'},{method:'item/started'},{type:'compactionError'}]) {
    const next=structuredClone(prior.wire);Object.assign(next[2],change);
    assert.equal(rootCompactions(next,prior.threadId).length,0);
  }
});
test('known original failure plus verified shutdown remains a valid resume precursor',()=>{
  const {prior,shutdown,sourcePins}=example();validateLegacyEvidence(prior,shutdown,sourcePins);
  assert.equal(prior.exitCode,1);assert.equal(prior.failed,1);
});
for(const [name,mutate]of [
  ['changed source pins',x=>{x.prior.sourcePins={};}],
  ['unreviewed runner',x=>{x.prior.runner.sha256='b'.repeat(64);}],
  ['relabeled green original',x=>{x.prior.exitCode=0;}],
  ['unconfirmed child exit',x=>{x.shutdown.childExitConfirmed=false;}],
  ['unconfirmed runner exit',x=>{x.shutdown.runnerExitConfirmed=false;}],
  ['different root identity',x=>{x.shutdown.rootThread='other';}],
  ['different fixture identity',x=>{x.shutdown.fixture='/elsewhere';}],
  ['shutdown before completed turn',x=>{x.shutdown.recordedAt='2026-11-07T00:01:00Z';}],
  ['failed earlier turn',x=>{x.prior.turns[1].status='failed';}],
  ['missing root compaction',x=>{x.prior.wire=x.prior.wire.filter(row=>row.type!=='contextCompaction');}],
  ['different first acknowledgment',x=>{x.prior.wire[0].text='OTHER';}]
])test('resume rejects '+name,()=>{
  const value=example();mutate(value);
  assert.throws(()=>validateLegacyEvidence(value.prior,value.shutdown,value.sourcePins));
});
async function fixture(t) {
  const temporary=await fs.mkdtemp(path.join(os.homedir(),'Library','Caches','NoieeLiveHarnessChecks-'));
  t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
  const root=path.join(temporary,'checkout'),cachesRoot=path.join(temporary,'caches');
  const output=path.join(root,'.artifacts','live-profile','run-generated'),live=path.join(cachesRoot,'Noiee172-LiveProfile-generated');
  await fs.mkdir(output,{recursive:true,mode:0o700});await fs.mkdir(live,{recursive:true,mode:0o700});
  await fs.mkdir(path.join(live,'home'),{mode:0o700});await fs.mkdir(path.join(live,'project'),{mode:0o700});
  const value=example();Object.assign(value.prior,{fixture:live,output,sourceDirectory:path.join(root,'source'),dataDir:path.join(live,'home'),project:path.join(live,'project')});value.shutdown.fixture=live;
  const reportPath=path.join(output,'RESULT.json'),shutdownPath=path.join(output,'fixture-shutdown.json');
  const save=async()=>{await fs.writeFile(reportPath,JSON.stringify(value.prior),{mode:0o600});await fs.writeFile(shutdownPath,JSON.stringify(value.shutdown),{mode:0o600});};
  await save();return {...value,root,cachesRoot,reportPath,shutdownPath,live,save};
}
test('canonical private generated fixture is readable without rewriting its receipts',async t=>{
  const x=await fixture(t),before=await fs.readFile(x.reportPath),loaded=await loadResumeReceipt(x);
  assert.equal(loaded.prior.threadId,x.prior.threadId);await assertReceiptUnchanged(loaded.receipt);
  assert.deepEqual(await fs.readFile(x.reportPath),before);
});
test('resume rejects a non-private generated home',async t=>{
  const x=await fixture(t);await fs.chmod(x.prior.dataDir,0o755);
  await assert.rejects(loadResumeReceipt(x),/private/);
});
test('resume rejects a symlinked fixture home',async t=>{
  const x=await fixture(t),moved=x.prior.dataDir+'-moved';
  await fs.rename(x.prior.dataDir,moved);await fs.symlink(moved,x.prior.dataDir);
  await assert.rejects(loadResumeReceipt(x),/real directory/);
});
test('resume rejects an external report location and another checkout source',async t=>{
  const x=await fixture(t);
  await assert.rejects(loadResumeReceipt({...x,reportPath:path.join(x.root,'RESULT.json')}),/live-profile archive/);
  x.prior.sourceDirectory='/another/source';await x.save();await assert.rejects(loadResumeReceipt(x),/current checkout source/);
});
test('resume rejects a writable receipt and a forged fixture prefix',async t=>{
  const x=await fixture(t);await fs.chmod(x.reportPath,0o666);
  await assert.rejects(loadResumeReceipt(x),/writable/);await fs.chmod(x.reportPath,0o600);
  x.prior.fixture=path.join(x.cachesRoot,'OriginalUserData');await x.save();
  await assert.rejects(loadResumeReceipt(x),/prefix/);
});
test('a changed retained receipt cannot be reported unchanged',async t=>{
  const x=await fixture(t),loaded=await loadResumeReceipt(x);
  await fs.appendFile(x.reportPath,'\n');await assert.rejects(assertReceiptUnchanged(loaded.receipt),/stay unchanged/);
});
