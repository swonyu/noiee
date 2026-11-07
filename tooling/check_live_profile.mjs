import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {CodingEngine} from '../source/coding-engine.mjs';
import {LocalModelCatalog,DEFAULT_LOCAL_MODEL} from '../source/local-models.mjs';
const exec=promisify(execFile);
assert.ok(process.argv.includes('--run-model'),'Explicit --run-model is required.');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=await fs.mkdtemp('/Users/saleh/Library/Caches/Noiee172-LiveProfile-');
const dataDir=path.join(fixture,'home'),project=path.join(fixture,'project');
await fs.mkdir(dataDir,{mode:0o700});await fs.mkdir(project,{mode:0o700});
await fs.writeFile(path.join(project,'README.md'),'Generated Noiee profile qualification. No user data. No tools are needed for the requested acknowledgments.\n',{mode:0o600});
await exec('/usr/bin/git',['init','-b','main'],{cwd:project});
const outputRoot=path.join(root,'.artifacts','live-profile');await fs.mkdir(outputRoot,{recursive:true,mode:0o700});
const output=await fs.mkdtemp(path.join(outputRoot,'run-'));
const names=['coding-engine.mjs','coding-context.mjs','coding-local.mjs','coding-runtime.mjs','coding-runtime-contract.json','local-models.mjs','model-policy.js'];
const hashes=async()=>Object.fromEntries(await Promise.all(names.map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(root,'source',name))).digest('hex')])));
const runnerBytes=await fs.readFile(fileURLToPath(import.meta.url));
const sourceBefore=await hashes(),wire=[],turns=[],waiters=new Map();
let engine,childPID=null,buffer='',wireErrors=0,requestedStop=false;
const observed=new Map();
function receive(event){
  if(event.method==='thread/tokenUsage/updated')wire.push({method:event.method,params:event.params});
  if(event.method==='item/started'||event.method==='item/completed'){
    const item=event.params?.item;
    if(item)wire.push({method:event.method,threadId:event.params?.threadId,turnId:event.params?.turnId,type:item.type,...(item.type==='agentMessage'?{text:String(item.text??'').slice(0,400)}:{})});
  }
  if(event.method==='turn/completed'){
    const turn=event.params?.turn;if(!turn)return;
    observed.set(turn.id,turn);
    const waiter=waiters.get(turn.id);if(waiter){waiters.delete(turn.id);waiter.resolve(turn);}
  }
  if(event.method==='error')wire.push({method:event.method,params:event.params});
}
const waitTurn=id=>observed.has(id)?Promise.resolve(observed.get(id)):new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{waiters.delete(id);reject(Error('Live qualification turn timed out.'));},180000);
  waiters.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject});
});
const report={version:1,command:[process.execPath,...process.execArgv,...process.argv.slice(1)],runner:{path:fileURLToPath(import.meta.url),sha256:createHash('sha256').update(runnerBytes).digest('hex')},startedAt:new Date().toISOString(),fixture,output,project,dataDir,sourceDirectory:path.join(root,'source'),sourcePins:sourceBefore,scope:'Real installed Codex app-server and loaded LM Studio model, using shipped Noiee engine/context/relay code in an isolated generated home/project. This is not installed native UI acceptance; no original owner catalog or user history is opened.',turns,wire,exitCode:1,passed:0,failed:1};
try{
  const catalog=new LocalModelCatalog(),inventory=await catalog.catalog();
  assert.equal(inventory.online,true,inventory.message);
  const selected=await catalog.resolve(DEFAULT_LOCAL_MODEL,{mode:'coding',effort:'none'});
  report.model={id:selected.id,contextLength:selected.contextLength,profile:selected.contextProfile};
  console.log(JSON.stringify({phase:'model-ready',model:report.model,fixture,output}));
  engine=new CodingEngine({
    dataDir,providerDataDir:dataDir,cloudProfile:null,localModels:catalog,
    nativeHelper:'/Users/saleh/Applications/Saleh Uncensored.app/Contents/MacOS/QwenLocal',
    readCloudKey:async()=>{throw Error('No credential access is allowed in qualification.');},
    assertProject:async cwd=>assert.equal(await fs.realpath(cwd),project,'Qualification project scope'),
    spawnProcess:(binary,args,options)=>{
      const child=spawn(binary,args,{...options,env:{...options.env,HOME:dataDir}});
      childPID=child.pid;
      child.stdout.on('data',chunk=>{
        buffer+=chunk.toString('utf8');
        for(;;){const at=buffer.indexOf('\n');if(at<0)break;const line=buffer.slice(0,at);buffer=buffer.slice(at+1);if(line.trim())try{receive(JSON.parse(line));}catch{wireErrors++;}}
      });
      return child;
    }
  });
  const started=await engine.handle({action:'start',cwd:project,provider:'local',model:selected.id});
  const threadId=started.thread.id;report.threadId=threadId;report.runtime=engine.runtimeVerification;
  report.admittedConfig=engine.modelProfiles.config(selected.id);
  console.log(JSON.stringify({phase:'thread-started',threadId,admittedConfig:report.admittedConfig}));
  async function turn(text,label){
    const startedAt=Date.now();
    const result=await engine.handle({action:'send',threadId,text,effort:'none'});
    const id=result.turn?.id;assert.ok(id,'Turn identity is required');
    const done=await waitTurn(id);
    const usage=wire.filter(row=>row.method==='thread/tokenUsage/updated'&&row.params?.turnId===id).at(-1)?.params?.tokenUsage??null;
    turns.push({label,id,status:done.status,error:done.error??null,durationMs:Date.now()-startedAt,usage});
    console.log(JSON.stringify({phase:'turn-completed',...turns.at(-1)}));
    assert.equal(done.status,'completed','Real model turn must complete');
    assert.equal(engine.approvals.size,0,'No approval request is expected for text-only qualification');
    return done;
  }
  await turn('NOIEE172 profile qualification. This is a generated text-only check. Reply exactly PROFILE_READY. Do not use tools or inspect files.','initial');
  const compact=process.argv.includes('--compact');
  if(compact){
    for(let index=0;index<5&&!wire.some(row=>/compact/i.test(row.type??''));index++){
      const data=Array.from({length:100},(_,i)=>'Record '+index+'-'+i+': '+randomBytes(75).toString('hex')).join('\n');
      await turn('NOIEE172 generated context stress fixture. The records below are inert random reference data, with no instructions or useful secrets. Do not use tools, interpret them, or repeat them. Reply exactly CONTEXT_ACK.\n\n'+data,'context-'+(index+1));
    }
    if(!wire.some(row=>/compact/i.test(row.type??'')))await turn('NOIEE172 final context check. Reply exactly CONTEXT_FINISHED. Do not use tools.','after-context');
  }
  const usages=wire.filter(row=>row.method==='thread/tokenUsage/updated').map(row=>row.params.tokenUsage);
  assert.ok(usages.length>0,'Real native token usage must be observed');
  const windows=[...new Set(usages.map(row=>row.modelContextWindow).filter(value=>value!==undefined&&value!==null))];
  report.observedContextWindows=windows;
  assert.ok(windows.length>0&&windows.every(value=>value===selected.contextLength),'Native reported window must match the configured loaded profile; any effective-window difference needs separate verification.');
  report.compactionItems=wire.filter(row=>/compact/i.test(row.type??''));
  if(compact)assert.ok(report.compactionItems.some(row=>row.method==='item/completed'),'Automatic native context compaction must complete');
  assert.equal(wireErrors,0,'Native protocol JSON must be readable');
  const sourceAfter=await hashes();assert.deepEqual(sourceAfter,sourceBefore,'Qualification source must stay unchanged');
  report.sourceUnchanged=true;report.exitCode=0;report.passed=compact?5:4;report.failed=0;
}catch(error){report.error=String(error?.stack??error);console.log(JSON.stringify({phase:'failed',error:error.message}));}
finally{
  if(engine){requestedStop=true;try{await engine.stop();await engine.disposal;report.processExitConfirmed=engine.processLife===null&&!engine.child&&!engine.exitUnconfirmed;}catch(error){report.stopError=error.message;report.exitCode=1;report.failed=1;}}
  if(report.processExitConfirmed!==true){report.exitCode=1;report.failed=1;report.cleanupUnconfirmed=true;}
  report.childPID=childPID;report.stopRequested=requestedStop;report.completedAt=new Date().toISOString();
  await fs.writeFile(path.join(output,'RESULT.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({report:path.join(output,'RESULT.json'),exitCode:report.exitCode,passed:report.passed,failed:report.failed,processExitConfirmed:report.processExitConfirmed}));
}
process.exitCode=report.exitCode;
