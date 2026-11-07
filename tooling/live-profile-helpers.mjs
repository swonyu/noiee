import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const SOURCE_NAMES = ['coding-engine.mjs','coding-context.mjs','coding-local.mjs','coding-runtime.mjs','coding-runtime-contract.json','local-models.mjs','model-policy.js'];
export const LEGACY_RUNNER_SHA256 = '9cfaa2220eaf079fa9abc6e3e82bb44e992ed0926b8fa7ea83d86cfc0fc5d887';
export const RUNTIME = Object.freeze({
  cliVersion:'codex-cli 0.167.0-alpha.3.2',
  sha256:'a636331ed87605efc4cf84028ac2884a75363f9d10ead63cffb57ea0016d486e',
  effectiveContextWindowPercent:95,
  releaseCommit:'c40729ea5cf8e947481b130c59807273eda2f8e9'
});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function expectedWindow(contextLength, runtime) {
  assert.equal(runtime?.cliVersion,RUNTIME.cliVersion,'Effective-window semantics require the qualified Codex version');
  assert.equal(runtime?.sha256,RUNTIME.sha256,'Effective-window semantics require the qualified installed binary');
  assert.ok(Number.isSafeInteger(contextLength)&&contextLength>0,'Configured context must be a positive integer');
  return Number(BigInt(contextLength)*BigInt(RUNTIME.effectiveContextWindowPercent)/100n);
}
export function rootCompactions(wire,threadId) {
  return wire.filter(row=>row.method==='item/completed'&&row.threadId===threadId&&row.type==='contextCompaction');
}
export function assertToolFree(wire,threadId) {
  const allowed=new Set(['userMessage','agentMessage','reasoning','contextCompaction']);
  const items=wire.filter(row=>row.method==='item/started'||row.method==='item/completed');
  assert.ok(items.every(row=>row.threadId===threadId),'Text-only qualification must not create or exercise a child thread');
  assert.deepEqual(items.filter(row=>!allowed.has(row.type)).map(row=>row.type),[],'Text-only qualification must contain no tool or unknown item');
  assert.equal(wire.filter(row=>row.kind==='server-request').length,0,'Text-only qualification must not request approval, permissions, input, or tool execution');
}
export function assertReply(wire,threadId,turnId,expected) {
  const messages=wire.filter(row=>row.method==='item/completed'&&row.threadId===threadId&&row.turnId===turnId&&row.type==='agentMessage');
  assert.equal(messages.length,1,'Exactly one completed assistant message is required');
  assert.equal(messages[0].text?.trim(),expected,'Assistant acknowledgment/recall must match, ignoring outer whitespace only');
  return messages[0].text;
}
export function assertWindows(wire,threadId,contextLength,runtime) {
  const usages=wire.filter(row=>row.method==='thread/tokenUsage/updated'&&row.params?.threadId===threadId).map(row=>row.params.tokenUsage);
  assert.ok(usages.length>0,'Root-thread native token usage must be observed');
  const expected=expectedWindow(contextLength,runtime);
  assert.ok(usages.every(row=>Number.isSafeInteger(row?.modelContextWindow)&&row.modelContextWindow===expected),'Every root usage report must match the pinned runtime usable-input window');
  return {configuredModelWindow:contextLength,effectiveInputWindow:expected,observedWindows:[...new Set(usages.map(row=>row.modelContextWindow))]};
}
export async function sourceHashes(source,names=SOURCE_NAMES) {
  return Object.fromEntries(await Promise.all([...names].sort().map(async name=>{
    const file=path.join(source,name),info=await fs.lstat(file);
    assert.ok(info.isFile()&&!info.isSymbolicLink(),'Source pin must be a regular file: '+name);
    return [name,sha256(await fs.readFile(file))];
  })));
}
export async function allSourceHashes(source) {
  const entries=await fs.readdir(source,{withFileTypes:true});
  return sourceHashes(source,entries.filter(row=>row.isFile()).map(row=>row.name));
}
async function privateDirectory(directory) {
  const info=await fs.lstat(directory);
  assert.ok(info.isDirectory()&&!info.isSymbolicLink(),'Fixture directory must be a real directory');
  assert.equal(await fs.realpath(directory),directory,'Fixture directory must be canonical');
  assert.equal(info.uid,process.getuid(),'Fixture must belong to the current user');
  assert.equal(info.mode&0o077,0,'Fixture directory must remain private');
}
async function readReceipt(file) {
  assert.equal(await fs.realpath(file),file,'Receipt must not traverse a symlink');
  const info=await fs.lstat(file);
  assert.ok(info.isFile()&&!info.isSymbolicLink(),'Receipt must be a regular file');
  assert.equal(info.uid,process.getuid(),'Receipt must belong to the current user');
  assert.equal(info.mode&0o022,0,'Receipt must not be writable by other users');
  assert.ok(info.size>0&&info.size<=4*1024*1024,'Receipt size is outside the generated qualification bound');
  const bytes=await fs.readFile(file);
  return {path:file,sha256:sha256(bytes),value:JSON.parse(bytes.toString('utf8'))};
}
export function validateLegacyEvidence(prior,shutdown,sourcePins) {
  assert.equal(prior.version,1,'Only the retained, known v1 qualification receipt is supported');
  assert.equal(prior.runner?.sha256,LEGACY_RUNNER_SHA256,'Resume requires the reviewed original qualification runner');
  assert.deepEqual(prior.sourcePins,sourcePins,'Every original source pin must match the current qualification source');
  assert.equal(prior.runtime?.cliVersion,RUNTIME.cliVersion);
  assert.equal(prior.runtime?.sha256,RUNTIME.sha256);
  assert.equal(prior.exitCode,1,'Original failed receipt must remain failed');
  assert.equal(prior.failed,1);
  assert.match(prior.error??'',/Native reported window must match the configured loaded profile/,'Only the reviewed effective-window hypothesis failure is supported');
  assert.ok(/^[A-Za-z0-9_.-]{1,160}$/.test(prior.threadId??''),'Prior root identity is invalid');
  assert.ok(Number.isSafeInteger(prior.childPID)&&prior.childPID>1,'Prior child identity is invalid');
  assert.ok(Array.isArray(prior.turns)&&prior.turns.length>=2&&prior.turns.every(turn=>turn.status==='completed'&&turn.error===null),'Every prior turn must have completed successfully');
  assert.equal(shutdown.fixture,prior.fixture);
  assert.equal(shutdown.rootThread,prior.threadId);
  assert.equal(shutdown.childPID,prior.childPID);
  assert.equal(shutdown.completedTurns,prior.turns.length);
  assert.equal(shutdown.childExitConfirmed,true,'Prior child shutdown must be independently confirmed');
  assert.equal(shutdown.runnerExitConfirmed,true,'Prior runner shutdown must be independently confirmed');
  assert.equal(shutdown.originalAppOrModelStopped,false,'The shutdown must be scoped only to the generated fixture');
  assert.ok(Number.isSafeInteger(shutdown.runnerPID)&&shutdown.runnerPID>1);
  const completed=Date.parse(prior.completedAt),closed=Date.parse(shutdown.recordedAt);
  assert.ok(Number.isFinite(completed)&&Number.isFinite(closed)&&closed>=completed,'Shutdown must follow the prior run');
  assertToolFree(prior.wire,prior.threadId);
  const initial=prior.turns.find(turn=>turn.label==='initial');
  assert.ok(initial,'Prior first-turn identity is required');
  assertReply(prior.wire,prior.threadId,initial.id,'PROFILE_READY');
  for(const turn of prior.turns.filter(row=>row.label!=='initial')) {
    assert.match(turn.label,/^context-[1-5]$/,'Only the reviewed generated context turns may be resumed');
    assertReply(prior.wire,prior.threadId,turn.id,'CONTEXT_ACK');
  }
  assert.ok(rootCompactions(prior.wire,prior.threadId).length>0,'A completed root-thread compaction must be present');
  assert.equal(prior.wire.filter(row=>row.method==='error').length,0,'Prior run must have no native error events');
  assertWindows(prior.wire,prior.threadId,prior.model?.contextLength,prior.runtime);
  assert.equal(prior.admittedConfig?.model_context_window,prior.model.contextLength);
}
export async function loadResumeReceipt({root,reportPath,sourcePins,cachesRoot}) {
  const canonicalRoot=await fs.realpath(root),canonicalCaches=await fs.realpath(cachesRoot);
  const reportFile=path.resolve(reportPath),output=path.dirname(reportFile);
  assert.equal(path.basename(reportFile),'RESULT.json','Resume must name a retained RESULT.json');
  assert.equal(path.dirname(output),path.join(canonicalRoot,'.artifacts','live-profile'),'Resume receipt must belong to this checkout live-profile archive');
  assert.match(path.basename(output),/^run-[A-Za-z0-9]+$/,'Resume archive name is invalid');
  await privateDirectory(output);
  const receipt=await readReceipt(reportFile),prior=receipt.value;
  assert.equal(prior.output,output,'Receipt output identity differs from its location');
  assert.equal(prior.sourceDirectory,path.join(canonicalRoot,'source'),'Receipt must target the current checkout source');
  assert.equal(path.dirname(prior.fixture??''),canonicalCaches,'Only generated Caches fixtures may be resumed');
  assert.match(path.basename(prior.fixture??''),/^Noiee172-LiveProfile-[A-Za-z0-9]+$/,'Fixture prefix is not a live-profile fixture');
  await privateDirectory(prior.fixture);
  assert.equal(prior.dataDir,path.join(prior.fixture,'home'));
  assert.equal(prior.project,path.join(prior.fixture,'project'));
  await privateDirectory(prior.dataDir);
  await privateDirectory(prior.project);
  const shutdown=await readReceipt(path.join(output,'fixture-shutdown.json'));
  validateLegacyEvidence(prior,shutdown.value,sourcePins);
  return {prior,receipt:{path:receipt.path,sha256:receipt.sha256},shutdown:{path:shutdown.path,sha256:shutdown.sha256},shutdownRecord:shutdown.value};
}
export async function assertReceiptUnchanged(receipt) {
  assert.equal(sha256(await fs.readFile(receipt.path)),receipt.sha256,'Retained prior evidence must stay unchanged');
}
