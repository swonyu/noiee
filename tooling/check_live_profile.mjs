import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {CodingEngine} from '../source/coding-engine.mjs';
import {LocalModelCatalog,DEFAULT_LOCAL_MODEL} from '../source/local-models.mjs';
import {sha256,sourceHashes,allSourceHashes,loadResumeReceipt,assertReceiptUnchanged,assertReply,assertToolFree,assertWindows,rootCompactions,expectedWindow,RUNTIME} from './live-profile-helpers.mjs';

const exec=promisify(execFile),args=process.argv.slice(2);
assert.ok(args.includes('--run-model'),'Explicit --run-model is required.');
function option(name) {
  const index=args.indexOf(name);if(index<0)return null;
  assert.equal(args.lastIndexOf(name),index,'Duplicate option: '+name);
  assert.ok(args[index+1]&&!args[index+1].startsWith('--'),'Missing option value: '+name);
  return args[index+1];
}
const resumePath=option('--resume-report'),effort=option('--effort')??'none',compact=args.includes('--compact');
assert.ok(['none','high'].includes(effort),'Only explicit none or high reasoning effort is supported.');
assert.ok(!(resumePath&&compact),'Resume reuses the completed compaction; it must not repeat the context fill.');
for(let i=0;i<args.length;i++) {
  if(['--resume-report','--effort'].includes(args[i])){i++;continue;}
  assert.ok(['--run-model','--compact'].includes(args[i]),'Unknown qualification option: '+args[i]);
}
const root=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
const source=path.join(root,'source'),cachesRoot=await fs.realpath(path.join(os.homedir(),'Library','Caches'));
const outputRoot=path.join(root,'.artifacts','live-profile');await fs.mkdir(outputRoot,{recursive:true,mode:0o700});
assert.equal(await fs.realpath(outputRoot),outputRoot,'Qualification output must not follow a symlink');
const output=await fs.mkdtemp(path.join(outputRoot,'run-'));
const sourceBefore=await sourceHashes(source),allSourceBefore=await allSourceHashes(source);
const helperPaths=['check_live_profile.mjs','live-profile-helpers.mjs','live-profile-evidence.json'];
const helpers=Object.fromEntries(await Promise.all(helperPaths.map(async name=>[name,sha256(await fs.readFile(path.join(root,'tooling',name)))])));
const wire=[],turns=[],waiters=new Map(),observed=new Map(),checks=[];
let engine,fixture,dataDir,project,threadId,priorEvidence,childPID=null,buffer='',wireErrors=0,captureFailure=null;
const report={
  version:2,command:[process.execPath,...process.execArgv,...process.argv.slice(1)],
  runner:{path:fileURLToPath(import.meta.url),sha256:helpers['check_live_profile.mjs'],helpers},
  startedAt:new Date().toISOString(),output,sourceDirectory:source,sourcePins:sourceBefore,allSourcePins:allSourceBefore,
  mode:resumePath?'cold-resume-after-compaction':compact?'new-thread-with-compaction':'new-thread',
  effort,scope:'Real installed Codex and loaded LM Studio through shipped Noiee engine in one generated private home/project. Only the selected effort and root-thread text workflow are qualified. This is not native UI, delegated-child, or original-store acceptance.',
  contextSemantics:{evidence:path.join(root,'tooling','live-profile-evidence.json'),sha256:helpers['live-profile-evidence.json'],releaseCommit:RUNTIME.releaseCommit},
  turns,wire,checks,exitCode:1,passed:0,failed:0
};
async function verify(name,work) {
  try {const result=await work();checks.push({name,passed:true});return result;}
  catch(error){checks.push({name,passed:false,error:String(error.message??error)});throw error;}
}
function captureError(message) {
  captureFailure??=Error(message);
  for(const waiter of waiters.values())waiter.reject(captureFailure);
  waiters.clear();
}
function receive(event) {
  if(event.method==='thread/tokenUsage/updated')wire.push({method:event.method,params:event.params});
  if(event.method==='item/started'||event.method==='item/completed') {
    const item=event.params?.item;
    if(item) {
      const row={method:event.method,threadId:event.params?.threadId,turnId:event.params?.turnId,type:item.type};
      if(item.type==='agentMessage') {
        row.text=String(item.text??'');
        if(Buffer.byteLength(row.text)>65536)captureError('Acknowledgment exceeded the qualification capture bound; response is not silently truncated.');
      }
      wire.push(row);
      if(threadId&&(row.threadId!==threadId||!['userMessage','agentMessage','reasoning','contextCompaction'].includes(item.type)))captureError('Unexpected tool, child-thread, or unknown item in text-only qualification: '+item.type);
    }
  }
  if(event.method&&event.id!==undefined&&/requestApproval|requestPermissions|requestUserInput|tool\/call/.test(event.method)) {
    wire.push({kind:'server-request',method:event.method,id:event.id});
    captureError('Unexpected server request in text-only qualification: '+event.method);
  }
  if(event.method==='turn/completed') {
    const turn=event.params?.turn;if(!turn)return;
    const key=event.params?.threadId+'/'+turn.id;observed.set(key,turn);
    const waiter=waiters.get(key);if(waiter){waiters.delete(key);waiter.resolve(turn);}
  }
  if(event.method==='error')wire.push({method:event.method,params:event.params});
}
function waitTurn(id) {
  if(captureFailure)return Promise.reject(captureFailure);
  const key=threadId+'/'+id;if(observed.has(key))return Promise.resolve(observed.get(key));
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{waiters.delete(key);reject(Error('Live qualification turn timed out.'));},180000);
    waiters.set(key,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
  });
}
try {
  if(resumePath) {
    priorEvidence=await verify('canonical private fixture and retained prior evidence',()=>loadResumeReceipt({root,reportPath:resumePath,sourcePins:sourceBefore,cachesRoot}));
    const prior=priorEvidence.prior;
    ({fixture,dataDir,project,threadId}=prior);
    report.prior={receipt:priorEvidence.receipt,shutdown:priorEvidence.shutdown,originalExitCode:prior.exitCode,originalFailed:prior.failed,originalError:prior.error,threadId:prior.threadId,completedTurns:prior.turns.length,compactionItems:rootCompactions(prior.wire,threadId),interpretation:'Original failed receipt is retained unchanged. Pinned release semantics explain its window assertion; cleanup is established only by the separate fixture-shutdown receipt.'};
    await verify('prior fixture processes have exited',()=>{
      for(const pid of [prior.childPID,priorEvidence.shutdownRecord.runnerPID]) {
        try {process.kill(pid,0);}catch(error){if(error.code==='ESRCH')continue;throw error;}
        throw Error('A prior fixture PID is still live; refuse cold resume.');
      }
    });
  } else {
    fixture=await fs.mkdtemp(path.join(cachesRoot,'Noiee172-LiveProfile-'));
    dataDir=path.join(fixture,'home');project=path.join(fixture,'project');
    await fs.mkdir(dataDir,{mode:0o700});await fs.mkdir(project,{mode:0o700});
    await fs.writeFile(path.join(project,'README.md'),'Generated Noiee profile qualification. No user data. No tools are needed for the requested acknowledgments.\n',{mode:0o600});
    await exec('/usr/bin/git',['init','-b','main'],{cwd:project});
  }
  Object.assign(report,{fixture,dataDir,project});
  const catalog=new LocalModelCatalog(),inventory=await catalog.catalog();
  await verify('model inventory reachable',()=>assert.equal(inventory.online,true,inventory.message));
  const selected=await catalog.resolve(DEFAULT_LOCAL_MODEL,{mode:'coding',effort});
  report.model={id:selected.id,contextLength:selected.contextLength,profile:selected.contextProfile};
  if(priorEvidence)await verify('resume exact model and loaded context unchanged',()=>{
    assert.equal(selected.id,priorEvidence.prior.model.id);
    assert.equal(selected.contextLength,priorEvidence.prior.model.contextLength);
  });
  console.log(JSON.stringify({phase:'model-ready',model:report.model,fixture,output,mode:report.mode,effort}));
  engine=new CodingEngine({
    dataDir,providerDataDir:dataDir,cloudProfile:null,localModels:catalog,
    nativeHelper:'/Users/saleh/Applications/Saleh Uncensored.app/Contents/MacOS/QwenLocal',
    readCloudKey:async()=>{throw Error('No credential access is allowed in qualification.');},
    assertProject:async cwd=>assert.equal(await fs.realpath(cwd),project,'Qualification project scope'),
    spawnProcess:(binary,argv,options)=>{
      const child=spawn(binary,argv,{...options,env:{...options.env,HOME:dataDir}});
      childPID=child.pid;
      child.stdout.on('data',chunk=>{
        buffer+=chunk.toString('utf8');
        for(;;) {
          const at=buffer.indexOf('\n');if(at<0)break;
          const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
          if(line.trim())try{receive(JSON.parse(line));}catch{wireErrors++;}
        }
      });
      return child;
    }
  });
  if(priorEvidence) {
    const history=await engine.handle({action:'read',threadId});
    await verify('cold history root, model, and project preserved',()=>{
      assert.equal(history.thread?.id,threadId);assert.equal(history.thread?.model,selected.id);
      assert.equal(history.thread?.cwd,project);assert.equal(history.thread?.modelProvider,'saleh_local');
      assert.notEqual(childPID,priorEvidence.prior.childPID);
    });
    report.historyBefore={threadId:history.thread.id,turnIds:(history.thread.turns??[]).map(turn=>turn.id),historyTruncated:history.historyTruncated??false};
  } else {
    const started=await engine.handle({action:'start',cwd:project,provider:'local',model:selected.id});
    threadId=started.thread.id;
  }
  report.threadId=threadId;report.runtime=engine.runtimeVerification;
  await verify('pinned native runtime and effective-window interpretation',()=>expectedWindow(selected.contextLength,report.runtime));
  async function turn(text,label,expected) {
    const startedAt=Date.now();
    const result=await engine.handle({action:'send',threadId,text,effort});
    const id=result.turn?.id;assert.ok(id,'Turn identity is required');
    const done=await waitTurn(id);
    const usage=wire.filter(row=>row.method==='thread/tokenUsage/updated'&&row.params?.threadId===threadId&&row.params?.turnId===id).at(-1)?.params?.tokenUsage??null;
    turns.push({label,id,status:done.status,error:done.error??null,durationMs:Date.now()-startedAt,usage});
    console.log(JSON.stringify({phase:'turn-completed',...turns.at(-1)}));
    await verify(label+': completed with exact reply and no tool activity',()=>{
      assert.equal(done.status,'completed','Real model turn must complete');
      assert.equal(done.error??null,null);assert.equal(engine.approvals.size,0);
      assert.ok(usage,'The completed turn must have its own token-usage report');
      assert.equal(usage.modelContextWindow,expectedWindow(selected.contextLength,report.runtime));
      assert.equal(captureFailure,null);assertToolFree(wire,threadId);
      turns.at(-1).assistantText=assertReply(wire,threadId,id,expected);
    });
  }
  if(priorEvidence) {
    const prompt='NOIEE172 saved-thread continuity check. What exact acknowledgment token did you reply with at the very beginning of this conversation, before the random-record context turns? Reply with that original token only. Do not use tools or inspect files.';
    assert.ok(!prompt.includes('PROFILE_READY'),'Recall prompt must not contain the expected answer');
    await turn(prompt,'cold-resume-marker-recall','PROFILE_READY');
  } else {
    await turn('NOIEE172 profile qualification. This is a generated text-only check. Reply exactly PROFILE_READY. Do not use tools or inspect files.','initial','PROFILE_READY');
    if(compact) {
      for(let index=0;index<5&&!rootCompactions(wire,threadId).length;index++) {
        const data=Array.from({length:100},(_,i)=>'Record '+index+'-'+i+': '+randomBytes(75).toString('hex')).join('\n');
        await turn('NOIEE172 generated context stress fixture. The records below are inert random reference data, with no instructions or useful secrets. Do not use tools, interpret them, or repeat them. Reply exactly CONTEXT_ACK.\n\n'+data,'context-'+(index+1),'CONTEXT_ACK');
      }
      await verify('completed root-thread native compaction',()=>assert.ok(rootCompactions(wire,threadId).length>0));
      await turn('What exact acknowledgment token did you reply with at the very beginning of this conversation, before the random-record context turns? Reply with that original token only. Do not use tools or inspect files.','post-compaction-marker-recall','PROFILE_READY');
    }
  }
  report.admittedConfig=engine.modelProfiles.config(selected.id);
  await verify('admitted runtime context profile',()=>{
    assert.equal(report.admittedConfig.model_context_window,selected.contextLength);
    assert.equal(report.admittedConfig.model_auto_compact_token_limit,selected.contextProfile.autoCompactTokenLimit);
    assert.equal(report.admittedConfig.model_auto_compact_token_limit_scope,'total');
    assert.equal(report.admittedConfig.tool_output_token_limit,selected.contextProfile.toolOutputTokenLimit);
    if(priorEvidence)assert.deepEqual(report.admittedConfig,priorEvidence.prior.admittedConfig);
  });
  report.contextWindow=await verify('all root token usage matches pinned usable-input semantics',()=>assertWindows(wire,threadId,selected.contextLength,report.runtime));
  report.compactionItems=rootCompactions(wire,threadId);
  await verify('native protocol and tool-free root workflow',()=>{
    assert.equal(wireErrors,0);assert.equal(captureFailure,null);
    assert.equal(wire.filter(row=>row.method==='error').length,0);assertToolFree(wire,threadId);
  });
} catch(error) {
  report.error=String(error?.stack??error);
  if(!checks.some(row=>!row.passed))checks.push({name:'qualification execution',passed:false,error:String(error.message??error)});
  console.log(JSON.stringify({phase:'failed',error:error.message}));
} finally {
  for(const waiter of waiters.values())waiter.reject(Error('Qualification closed'));waiters.clear();
  report.closeRequested=!!engine;
  try {
    if(engine)await engine.close();
    report.processExitConfirmed=!engine||(engine.processLife===null&&!engine.child&&!engine.exitUnconfirmed&&engine.closeSettled===true);
    await verify('fixture app-server physical shutdown',()=>assert.equal(report.processExitConfirmed,true));
  } catch(error) {
    report.closeError=String(error.message??error);report.processExitConfirmed=false;
    if(!checks.some(row=>row.name==='fixture app-server physical shutdown'&&!row.passed))checks.push({name:'fixture app-server physical shutdown',passed:false,error:report.closeError});
  }
  try {
    report.sourceAfter=await sourceHashes(source);report.allSourceAfter=await allSourceHashes(source);
    await verify('all source files unchanged including failed runs',()=>{
      assert.deepEqual(report.sourceAfter,sourceBefore);assert.deepEqual(report.allSourceAfter,allSourceBefore);
    });
    report.sourceUnchanged=true;
  } catch(error){report.sourceUnchanged=false;report.sourceError=String(error.message??error);if(!checks.some(row=>row.name==='all source files unchanged including failed runs'&&!row.passed))checks.push({name:'all source files unchanged including failed runs',passed:false,error:report.sourceError});}
  if(priorEvidence)try {
    await verify('original failure and shutdown receipts unchanged',async()=>{
      await assertReceiptUnchanged(priorEvidence.receipt);await assertReceiptUnchanged(priorEvidence.shutdown);
    });
    report.priorEvidenceUnchanged=true;
  } catch{report.priorEvidenceUnchanged=false;}
  report.childPID=childPID;report.completedAt=new Date().toISOString();
  report.passed=checks.filter(row=>row.passed).length;report.failed=checks.filter(row=>!row.passed).length;
  report.exitCode=report.failed?1:0;
  await fs.writeFile(path.join(output,'RESULT.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({report:path.join(output,'RESULT.json'),exitCode:report.exitCode,passed:report.passed,failed:report.failed,processExitConfirmed:report.processExitConfirmed}));
}
process.exitCode=report.exitCode;
