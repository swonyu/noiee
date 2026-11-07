import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, realpath, writeFile, mkdir, readFile, symlink, stat, rename, lstat, readdir } from 'node:fs/promises';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFilesystemIdentity} from './filesystem-identity.mjs';

let module;
try { module = await import('./coding-engine.mjs'); } catch {}
assert.equal(typeof module?.CodingEngine, 'function', 'CodingEngine must exist');
const { CodingEngine:NativeCodingEngine } = module;
// Filesystem work below simulates the native helper contract; Swift owns race-safe syscalls.
async function fakeTemporaryOperation(action,input) {
  if(action==='create'){
    const path=await mkdtemp(join(input.cwd,'.saleh-coding-tmp-'));await writeFile(join(path,'.saleh-owner'),input.nonce,{flag:'wx',mode:0o600});
    const project=await lstat(input.cwd),info=await lstat(path);
    return {...input,path,projectDev:String(project.dev),projectIno:String(project.ino),dev:String(info.dev),ino:String(info.ino)};
  }
  const project=await lstat(input.cwd),info=await lstat(input.path);
  if(!info.isDirectory()||await realpath(input.path)!==input.path||String(info.dev)!==input.dev||String(info.ino)!==input.ino||String(project.dev)!==input.projectDev||String(project.ino)!==input.projectIno||await readFile(join(input.path,'.saleh-owner'),'utf8')!==input.nonce)throw new Error('Temporary directory identity changed.');
  if(action==='verify')return {verified:true};
  assert.equal(action,'remove');await rm(input.path,{recursive:true});return {removed:true};
}
const localModels={async resolve(id,{effort}){return {id,generation:{max_tokens:effort==='high'?32768:2048,reasoning_effort:effort}};}};
class CodingEngine extends NativeCodingEngine {constructor(options){super({temporaryOperation:fakeTemporaryOperation,localModels,...options});}}
const root = await realpath(await mkdtemp(join(tmpdir(), 'coding-check-')));
const children = [], calls = [];
const projectLayers = new Map();
const tick = () => new Promise(resolve => setImmediate(resolve));
const waitFor=async(predicate)=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,5));};
const localConfig = {model:'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp',model_provider:'saleh_local',approval_policy:'on-request',approvals_reviewer:'user',sandbox_mode:'workspace-write',web_search:'disabled',features:{hooks:false,apps:false,remote_plugin:false,shell_snapshot:false,memories:false,default_mode_request_user_input:true,multi_agent:true,multi_agent_v2:{enabled:true,max_concurrent_threads_per_session:3,expose_spawn_agent_model_overrides:false}},sandbox_workspace_write:{network_access:false},shell_environment_policy:{exclude:['SALEH_CODING_CLOUD_KEY']}};
const handoffInstructions='You are a coding assistant in Saleh Uncensored. Work in the selected project. Read applicable project instructions. Preserve user work. Use the available tools to inspect, edit, and verify requested changes. Request approval when required. Report actual results and unresolved failures accurately. Never claim tests or actions ran without tool evidence. The current TMPDIR environment variable identifies app-owned scratch space; use it for temporary files and do not commit that directory.';
function spawnFake(binary, args, options) {
  const child = new EventEmitter();
  Object.assign(child, { stdout:new PassThrough(), stderr:new PassThrough(), killed:false, calls:[], options, args });
  child.emitMessage = m => child.stdout.write(JSON.stringify(m)+'\n');
  child.once('exit',()=>{child.exited=true;});
  child.kill = () => { child.killed=true; queueMicrotask(()=>child.emit('exit',0,null)); return true; };
  child.stdin = new Writable({write(chunk, _, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const q=JSON.parse(line); calls.push(q); child.calls.push(q);
      if (!q.method || !Object.hasOwn(q,'id')) continue;
      if(q.method==='environment/add'&&child.bindingError){queueMicrotask(()=>child.emitMessage({id:q.id,error:{code:-32000,message:child.bindingError}}));continue;}
      if(q.method==='environment/add'&&child.deferredBinding){child.deferredBinding.push(q);continue;}
      if(q.method==='environment/info'&&child.deferredEnvironmentInfo){child.deferredEnvironmentInfo.push(q);continue;}
      if(q.method==='thread/loaded/list'&&child.deferredLoaded){child.deferredLoaded.push(q);continue;}
      if(q.method==='thread/backgroundTerminals/terminate'&&child.deferredBackgroundTerminations){child.deferredBackgroundTerminations.push(q);continue;}
      if(q.method==='command/exec/terminate'&&child.failDirectTermination){queueMicrotask(()=>child.emitMessage({id:q.id,error:{code:-32000,message:'Direct terminal termination failed'}}));continue;}
      if(q.method==='thread/list'&&q.params.ancestorThreadId&&child.deferredFamilyPages){child.deferredFamilyPages.push(q);continue;}
      if(q.method==='thread/start'&&child.deferredStarts){child.deferredStarts.push(q);continue;}
      if(q.method==='turn/start'&&child.deferredTurns){child.deferredTurns.push(q);continue;}
      if(q.method==='review/start'&&child.deferredReviews){child.deferredReviews.push(q);continue;}
      if(q.method==='turn/interrupt'&&child.deferredInterrupts){child.deferredInterrupts.push(q);continue;}
      if(q.method==='thread/read'&&child.deferredReads?.has(q.params.threadId)){child.deferredReads.get(q.params.threadId).push(q);continue;}
      if(q.method==='thread/read'&&child.metadataReadErrors?.get(q.params.threadId)?.length){const message=child.metadataReadErrors.get(q.params.threadId).shift();queueMicrotask(()=>child.emitMessage({id:q.id,error:{code:-32000,message}}));continue;}
      let result = {};
      if(q.method==='environment/status')result={status:child.environmentStatuses?.[q.params.environmentId]??(q.params.environmentId==='remote'?'ready':'unknown')};
      if(q.method==='environment/info')result={shell:{name:'zsh',path:child.executorShell??'/bin/zsh'},cwd:'file:///private/var/empty'};
      if(q.method==='config/read') result={config:args.includes('sandbox_mode="read-only"')?{...localConfig,approval_policy:'never',sandbox_mode:'read-only',features:{...localConfig.features,default_mode_request_user_input:false,multi_agent:false,multi_agent_v2:{...localConfig.features.multi_agent_v2,enabled:false}}}:localConfig, layers:projectLayers.get(q.params.cwd)==='missing'?undefined:projectLayers.get(q.params.cwd)??[]};
      if(q.method==='config/read')result.config={...result.config,features:{...result.config.features,plugins:child.pluginConfigFault==='missing'?undefined:child.pluginConfigFault==='enabled'||!args.includes('features.plugins=false')}};
      if(q.method==='config/read'&&options.env.SALEH_CODING_LOCAL_KEY)result.config={...result.config,model_providers:{saleh_local:{env_key:child.relayConfigFault==='provider'?'WRONG_KEY':'SALEH_CODING_LOCAL_KEY'}},shell_environment_policy:{exclude:child.relayConfigFault==='exclusion'?['SALEH_CODING_CLOUD_KEY']:['SALEH_CODING_LOCAL_KEY','SALEH_CODING_CLOUD_KEY']}};
      if(q.method==='configRequirements/read') result={requirements:null};
      if(q.method==='account/read') result={account:null};
      if(q.method==='mcpServerStatus/list') result={data:[]};
      if(q.method==='mcpServerStatus/list'&&child.exitAfterMCP){queueMicrotask(()=>{child.emitMessage({id:q.id,result});child.emit('exit',1,null);});continue;}
      if(q.method==='skills/list') result={data:[{cwd:root,skills:[{path:'/test/skill/SKILL.md',enabled:!child.skillDisabled}]}]};
      if(q.method==='skills/config/write') child.skillDisabled=true;
      if(q.method==='thread/start'||q.method==='thread/resume'||q.method==='thread/fork') child.thread={id:q.method==='thread/resume'?q.params.threadId:child.nextThreadId??'thread-1',cwd:q.params.cwd,model:q.params.model,modelProvider:q.params.modelProvider,historyMode:'legacy',turns:[]};
      if(['thread/start','thread/resume','thread/fork'].includes(q.method)){
        const configPath=join(options.env.CODEX_HOME,'config.toml');
        const block=`[projects.${JSON.stringify(q.params.cwd)}]\ntrust_level = "trusted"\n`;
        if(!readFileSync(configPath,'utf8').includes(block))appendFileSync(configPath,'\n'+block);
      }
      if(q.method==='thread/start'||q.method==='thread/resume'||q.method==='thread/fork'||q.method==='thread/read') result={thread:child.thread??{id:'thread-1',cwd:root,modelProvider:'saleh_local',historyMode:'legacy',turns:[]}};
      if(q.method==='thread/read')result={thread:{...result.thread,id:q.params.threadId}};
      if(q.method==='thread/read'&&child.threads?.has(q.params.threadId))result={thread:child.threads.get(q.params.threadId)};
      if(q.method==='thread/fork'&&q.params.path){
        const records=readFileSync(q.params.path,'utf8').trimEnd().split('\n').map(JSON.parse),sourceID=records[0].payload.id;
        const path=join(options.env.CODEX_HOME,'sessions','fork.jsonl');mkdirSync(join(options.env.CODEX_HOME,'sessions'),{recursive:true,mode:0o700});
        records[0].payload.id=child.thread.id;writeFileSync(path,records.map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600});
        Object.assign(child.thread,{path,forkedFromId:sourceID,parentThreadId:null,ephemeral:false});
        result={thread:child.thread,model:q.params.model,modelProvider:q.params.modelProvider,cwd:q.params.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',runtimeWorkspaceRoots:[q.params.cwd],sandbox:{type:'workspaceWrite',writableRoots:[],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}};
        if(child.forkReply)result=child.forkReply(result);
        if(child.deferredForks){child.deferredForks.push({q,result});continue;}
      }
      if(q.method==='thread/loaded/list')result=child.loadedPages?.get(q.params.cursor??'')??{data:[...(child.loadedIds??child.background?.keys()??[])],nextCursor:null};
      if(q.method==='thread/backgroundTerminals/list')result=child.backgroundPages?.get(`${q.params.threadId}:${q.params.cursor??''}`)??{data:[...(child.background?.get(q.params.threadId)??[])].map(processId=>({processId,itemId:`item-${processId}`,command:'fixture',cwd:root})),nextCursor:null};
      if(q.method==='thread/backgroundTerminals/terminate'){const set=child.background?.get(q.params.threadId);result={terminated:set?.delete(q.params.processId)??false};}
      if(q.method==='thread/turns/list'){const all=[...(child.threads?.get(q.params.threadId)?.turns??child.thread?.turns??[])].reverse(),offset=Number(q.params.cursor??0),limit=q.params.limit??50;result={data:all.slice(offset,offset+limit),nextCursor:offset+limit<all.length?String(offset+limit):null};}
      if(q.method==='thread/list') result=q.params.ancestorThreadId?(child.familyPages?.get(`${q.params.ancestorThreadId}:${q.params.cursor??''}`)??child.familyPages?.get(q.params.cursor??'')??{data:[],nextCursor:null}):{data:[{id:'thread-1',cwd:root}],nextCursor:null};
      if(q.method==='turn/start') result={turn:{id:child.nextTurnId??(child.threads?`turn-${q.params.threadId}`:'turn-1'),status:'inProgress'}};
      if(q.method==='turn/interrupt'&&(child.rejectInterruptOnce||child.interruptError)){
        const message=child.interruptError??'no active turn to interrupt';child.rejectInterruptOnce=false;
        queueMicrotask(()=>child.emitMessage({id:q.id,error:{code:-32000,message}}));continue;
      }
      if(q.method==='turn/start'&&child.completeBeforeResponse){
        queueMicrotask(()=>{
          child.emitMessage({method:'turn/started',params:{threadId:q.params.threadId,turn:{id:result.turn.id}}});
          child.emitMessage({method:'turn/completed',params:{threadId:q.params.threadId,turn:{id:result.turn.id,status:'completed'}}});
          child.emitMessage({id:q.id,result});
        });continue;
      }
      if(q.method==='command/exec') {
        if(q.params.streamStdin){child.commandRequest=q;(child.commandRequests??=new Map()).set(q.params.processId,q);continue;}
        result={exitCode:0,stdout:q.params.command.includes('symbolic-ref')?'main\n':q.params.command.includes('status')?'?? new.txt\n':'diff --git a/x b/x\n+new\n',stderr:''};
      }
      if(q.method==='command/exec/terminate'){const command=child.commandRequests?.get(q.params.processId);if(command){child.commandRequests.delete(q.params.processId);queueMicrotask(()=>child.emitMessage({id:command.id,result:{exitCode:130,stdout:'',stderr:''}}));}}
      if((q.method==='thread/read'&&q.params.includeTurns||q.method==='thread/turns/list')&&child.unmaterialized){queueMicrotask(()=>child.emitMessage({id:q.id,error:{code:-32000,message:'thread thread-1 is not materialized yet; includeTurns is unavailable before first user message'}}));continue;}
      if((q.method==='thread/read'&&q.params.includeTurns||q.method==='thread/turns/list')&&child.cursorRace){
        queueMicrotask(()=>child.stdout.write(JSON.stringify({id:q.id,result})+'\n'+JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'race-turn',itemId:'race-item',delta:'after-snapshot'}})+'\n'));continue;
      }
      if((q.method==='thread/read'&&q.params.includeTurns||q.method==='thread/turns/list')&&child.historyBatch){
        const batch=child.historyBatch;child.historyBatch=null;
        queueMicrotask(()=>child.stdout.write([...batch.before??[],{id:q.id,result},...batch.after??[]].map(m=>JSON.stringify(m)+'\n').join('')));continue;
      }
      if(child.handoff){
        if(q.method==='thread/turns/list'){if(child.handoffSyntheticTurns&&child.threads.get(q.params.threadId)?.historyMode==='legacy')result.data.unshift({id:`synthetic-${q.params.threadId}-${child.loadedIds.includes(q.params.threadId)?'loaded':'unloaded'}`,status:'completed',items:[{type:'subAgentActivity',id:'activity'}]});result.data=result.data.slice(0,q.params.limit);}
        const within=(id,target)=>{for(let n=0;id&&n<32;n++){if(id===target)return true;id=child.threads.get(id)?.parentThreadId;}return false;};
        if(q.method==='thread/list'){
          const rows=[...child.threads.values()].map(t=>({...t,cwd:child.handoffCatalogCwds?.get(t.id)??t.cwd})).filter(t=>!!t.archived===!!q.params.archived&&(!q.params.cwd||(Array.isArray(q.params.cwd)?q.params.cwd.includes(t.cwd):t.cwd===q.params.cwd))&&(!q.params.ancestorThreadId||t.id!==q.params.ancestorThreadId&&within(t.id,q.params.ancestorThreadId)));
          const offset=Number(q.params.cursor??0),limit=child.handoffPageSize??50;
          result={data:rows.slice(offset,offset+limit),nextCursor:offset+limit<rows.length?String(offset+limit):null};
          if(child.handoffRepeatedCursor)result={data:[],nextCursor:'0'};
          if(child.handoffEndless)result={data:[],nextCursor:String(offset+1)};
        }
        if(q.method==='thread/archive'&&child.threads.get(q.params.threadId)?.archived){queueMicrotask(()=>child.emitMessage({id:q.id,error:{code:-32000,message:`no rollout found for thread id ${q.params.threadId}`}}));continue;}
        if(q.method==='thread/archive'&&child.handoffArchiveExtra){const t=child.handoffArchiveExtra;child.threads.set(t.id,t);child.handoffArchiveExtra=null;}
        const moveRollout=(t,archived)=>{const path=join(options.env.CODEX_HOME,archived?'archived_sessions':'sessions',`${t.id}.jsonl`);if(t.path!==path){renameSync(t.path,path);t.path=path;}t.archived=archived;};
        const mutate=()=>{
        if(q.method==='thread/archive')for(const t of child.threads.values())if(within(t.id,q.params.threadId)){moveRollout(t,true);t.status={type:'notLoaded'};child.loadedIds=child.loadedIds.filter(id=>id!==t.id);}
        if(q.method==='thread/unarchive')moveRollout(child.threads.get(q.params.threadId),false);
        if(q.method==='thread/resume'){
          const t=child.threads.get(q.params.threadId);Object.assign(t,{cwd:q.params.cwd,model:q.params.model,modelProvider:q.params.modelProvider,status:{type:'idle'}});
          child.loadedIds.push(t.id);result={thread:t};
          queueMicrotask(()=>child.emitMessage({method:'thread/started',params:{thread:t}}));
        }
        };
        const delayed=child.handoffDelay;
        if(delayed&&q.method===delayed.method&&q.params.threadId===delayed.threadId){
          delayed.request=q;delayed.timer=setTimeout(()=>{if(child.exited)return;mutate();delayed.effects++;child.emitMessage({id:q.id,result});},250);continue;
        }
        mutate();
      }
      queueMicrotask(()=>child.emitMessage({id:q.id,result}));
    }
    done();
  }});
  children.push(child); return child;
}
const engine = new CodingEngine({dataDir:join(root,'state'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
for(const mode of ['valid','provider','exclusion']){
  const e=new CodingEngine({dataDir:join(root,'relay-auth-'+mode),binary:'/fake/codex',localModels:{...localModels,upstream:'http://127.0.0.1:9',fetchImpl:async()=>{throw Error('Relay startup check must not request inference');}},spawnProcess:(...args)=>{const child=spawnFake(...args);child.relayConfigFault=mode;return child;}});
  try{
    if(mode==='valid'){await e.ensure();assert(e.child.options.env.SALEH_CODING_LOCAL_KEY===e.relay.authToken);assert(!JSON.stringify(e.child.args).includes(e.relay.authToken));assert.equal(new URL(e.relay.baseURL).pathname,'/v1');}
    else await assert.rejects(e.ensure(),/Local relay credential isolation/);
  }finally{await e.close();}
}
console.log('PASS relay auth uses an environment key, excludes command access, and rejects unverifiable provider/exclusion config');
checks: {
try {
  // Stop must revoke a submission already past model lookup, even after the
  // family has drained. A later, explicit submission gets a new admission.
  for (const action of ['send','review','fork']) for (const phase of ['prepare','temporary','resume']) for (const stop of ['selected','all']) {
    if (action==='fork'&&phase==='resume') continue;
    const e=new CodingEngine({dataDir:join(root,`admission-${action}-${phase}-${stop}`),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    let release;
    try {
      await e.handle({action:'start',cwd:root});const child=e.child;
      const meta=id=>({id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[],status:{type:'idle'}});
      child.threads=new Map(['thread-1','peer'].map(id=>[id,meta(id)]));
      for(const thread of child.threads.values())e.rememberThread(thread);
      e.loaded.delete('thread-1');
      const gate=new Promise(resolve=>release=resolve);let entered=false;
      const method=phase==='prepare'?'prepare':phase==='temporary'?'temporaryEnvironment':'rpc',original=e[method].bind(e);
      e[method]=async(...args)=>{
        const result=await original(...args);
        if(!entered&&(phase!=='resume'||args[0]==='thread/resume'&&args[1].threadId==='thread-1')){entered=true;await gate;}
        return result;
      };
      const work=e.handle({action,threadId:'thread-1',...(action==='send'?{text:'Must not dispatch after Stop'}:{})}).then(value=>({value}),error=>({error}));
      await waitFor(()=>entered);assert(entered,`${action}/${phase} reached held preparation`);
      if(stop==='selected'){await e.handle({action:'interruptFamily',threadId:'thread-1'});await Promise.all(e.familyStops.values());await tick();}
      else await e.stop();
      assert.equal(child.killed,false,'Idle Stop preserves the live engine');
      const before=child.calls.length;release();const result=await work;
      assert(!child.calls.slice(before).some(q=>['turn/start','review/start','thread/fork'].includes(q.method)),`${stop} Stop must prevent the held ${action}/${phase} from dispatching`);
      assert.match(result.error?.message||'',/cancelled|Stop/i,'The pre-Stop operation rejects explicitly');
      e[method]=original;
      child.completeBeforeResponse=true;
      await e.handle({action:'send',threadId:'peer',text:'Unrelated peer remains usable'});
      await e.handle({action:'send',threadId:'thread-1',text:'Explicit fresh request after Stop'});
      assert.equal(e.runs.size,0);assert.equal(e.admissions.size,0);
    } finally {release?.();await e.close();}
  }
  // Hold the last asynchronous authority check, then revoke before the wire call.
  for(const action of ['terminalWrite','terminalResize'])for(const scope of ['selected','all']){
    const e=new CodingEngine({dataDir:join(root,`admission-${action}-${scope}`),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});let release;
    try{
      await e.handle({action:'start',cwd:root});const child=e.child;
      const pty=action==='terminalResize',terminal=await e.handle({action:'terminalStart',threadId:'thread-1',command:pty?'':'cat',...(pty?{mode:'pty',cols:80,rows:24}:{})});
      const original=e.terminalAuthority.bind(e),gate=new Promise(resolve=>release=resolve);let checked=0,entered=false;
      e.terminalAuthority=async(...args)=>{await original(...args);if(++checked===(pty?2:1)){entered=true;await gate;}};
      const work=e.handle({action,processId:terminal.processId,...(pty?{cols:90,rows:30}:{text:'cancelled input'})}).then(value=>({value}),error=>({error}));
      await waitFor(()=>entered);assert(entered,`${action} reached its final authority check`);
      e.cancelAdmissions(scope==='selected'?'thread-1':null);const before=child.calls.length;release();const result=await work;
      assert.match(result.error?.message||'',/cancelled|Stop/i);
      assert(!child.calls.slice(before).some(q=>['command/exec/write','command/exec/resize'].includes(q.method)),'Revoked terminal input cannot reach the wire');
      assert.equal(e.admissions.size,0);assert.equal(child.killed,false);
    }finally{release?.();await e.close();}
  }
  console.log('PASS admission Stop: 16 held send/review/fork cases plus 4 terminal dispatch fences; selected/global cancellation; fresh requests and peers');
  if(process.argv.includes('--admission-stop-only'))break checks;
  // Follow-up readiness must agree with send admission, even when saved history
  // becomes terminal before its live completion event. Native frequency is unproven.
  {
    const e=new CodingEngine({dataDir:join(root,'followup-idle-admission'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});let pending;
    try{
      const {thread}=await e.handle({action:'start',cwd:root}),c=e.child,id=thread.id;
      c.threads=new Map([[id,{...thread,status:{type:'idle'},turns:[]}]]);c.loadedIds=[id];
      const binding={threadId:id,cwd:root,model:thread.model,modelProvider:thread.modelProvider};
      const started=(threadId,turnId)=>{const t=c.threads.get(threadId);t.status={type:'active'};t.turns.push({id:turnId,status:'inProgress',items:[]});c.emitMessage({method:'turn/started',params:{threadId,turn:{id:turnId,status:'inProgress',items:[]}}});};
      const completed=(threadId,turnId)=>{const t=c.threads.get(threadId);t.status={type:'idle'};const turn=t.turns.find(t=>t.id===turnId)??{id:turnId,items:[]};turn.status='completed';c.emitMessage({method:'turn/completed',params:{threadId,turn}});};
      c.nextTurnId='followup-first';const first=await e.handle({action:'send',threadId:id,text:'First synthetic turn'});
      assert.equal(e.runs.get(id),first.turn.id);assert(!e.startedTurns.has(id),'send admission creates runs before the started event');
      started(id,first.turn.id);await tick();assert.equal(e.startedTurns.get(id),first.turn.id);
      c.threads.get(id).status={type:'idle'};c.threads.get(id).turns[0].status='completed';
      const state={...binding,life:e.processLife,active:new Map([[id,first.turn.id]]),revision:0,finished:false};
      assert.equal(await e.scheduledFamilyIdle(state),true,'scheduled terminal-history fallback remains available');assert.equal(state.active.size,0);
      assert.equal(await e.followupIdle(binding),null,'follow-up must wait for active root records despite exact terminal history');
      assert.equal(e.runs.get(id),first.turn.id);assert.equal(e.startedTurns.get(id),first.turn.id,'readiness must not clear active records');
      c.emitMessage({method:'turn/completed',params:{threadId:id,turn:{id:'wrong-completion',status:'completed',items:[]}}});await tick();
      assert.equal(await e.followupIdle(binding),null,'a different completion cannot release the active root');
      completed(id,first.turn.id);await tick();assert(!e.runs.has(id)&&!e.startedTurns.has(id));
      // Explicit trusted negative-control seam: this is not claimed as a native event sequence.
      e.startedTurns.set(id,'isolated-started-record');
      c.threads.get(id).turns.push({id:'isolated-started-record',status:'completed',items:[]});
      assert.equal(await e.followupIdle(binding),null,'a started-only root record also blocks readiness');
      completed(id,'isolated-started-record');await tick();assert(!e.startedTurns.has(id));
      c.nextThreadId='followup-peer';const peer=(await e.handle({action:'start',cwd:root})).thread;
      c.threads.set(peer.id,{...peer,status:{type:'idle'},turns:[]});c.loadedIds.push(peer.id);
      c.nextTurnId='peer-active';const peerTurn=await e.handle({action:'send',threadId:peer.id,text:'Unrelated synthetic root'});started(peer.id,peerTurn.turn.id);await tick();
      const proof=await e.followupIdle(binding);assert(proof,'unrelated root active records do not block this root');proof.check();
      const before=c.calls.filter(q=>q.method==='turn/start'&&q.params.threadId===id).length,hooks=[];
      c.nextTurnId='followup-control';
      const control=await e.handle({action:'send',threadId:id,text:'Trusted queued continuation'},undefined,{
        beforeStart:async()=>{proof.check();hooks.push('claim');},
        check:()=>{proof.check();hooks.push('dispatch');},
        onTurn:async turnId=>{hooks.push(`ack:${turnId}`);},
      });
      assert.deepEqual(hooks,['claim','dispatch',`ack:${control.turn.id}`]);
      assert.equal(c.calls.filter(q=>q.method==='turn/start'&&q.params.threadId===id).length,before+1,'trusted follow-up dispatches once after exact completion');
      started(id,control.turn.id);completed(id,control.turn.id);await tick();
      const beforeReservation=await e.followupIdle(binding);assert(beforeReservation);beforeReservation.check();
      c.deferredTurns=[];pending=e.handle({action:'send',threadId:id,text:'Held real turn/start reservation'}).then(value=>({value}),error=>({error}));
      await waitFor(()=>c.deferredTurns.length===1);assert.equal(c.deferredTurns.length,1,'real send reaches deferred turn/start');
      assert(e.runs.has(id));assert.equal(e.runs.get(id),null);assert(!e.startedTurns.has(id));
      const operations=[...e.familyOperations];assert.equal(operations.length,1);assert.equal(operations[0].threadId,id);
      assert.equal(await e.followupIdle(binding,null,operations[0]),null,'null root reservation blocks even its current trusted operation');
      const [request]=c.deferredTurns;c.deferredTurns=null;const reservedId='reserved-followup-turn';
      started(id,reservedId);await tick();
      assert.throws(()=>beforeReservation.check(),error=>error.code==='PROJECT_BUSY','a new root started event invalidates the earlier proof');
      c.emitMessage({id:request.id,result:{turn:{id:reservedId,status:'inProgress'}}});
      const admitted=await pending;assert.ifError(admitted.error);assert.equal(admitted.value.turn.id,reservedId);
      completed(id,reservedId);completed(peer.id,peerTurn.turn.id);await tick();
      assert.equal(e.runs.size,0);assert.equal(e.startedTurns.size,0);
    }finally{await e.close();await pending;}
  }
  console.log('PASS follow-up readiness: terminal history, exact completion, trusted dispatch, unrelated root, reservation, and proof invalidation');
  // Synthetic child history can lead its live completion event. Every recorded
  // descendant, including an unacknowledged reservation, must still block a follow-up.
  for(const scenario of ['idle','run','reservation','started','grandchild','unrelated','completed','wrong-completion','proof-invalidated']){
    const e=new CodingEngine({dataDir:join(root,'followup-family-'+scenario),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try{
      const {thread}=await e.handle({action:'start',cwd:root}),c=e.child,parent={...thread,status:{type:'idle'},turns:[]};
      const child={...parent,id:'followup-child',parentThreadId:parent.id,source:{subAgent:{thread_spawn:{parent_thread_id:parent.id}}},turns:[{id:'child-turn',status:'completed',items:[]}]};
      const grandchild={...child,id:'followup-grandchild',parentThreadId:child.id,source:{subAgent:{thread_spawn:{parent_thread_id:child.id}}}};
      const peer={...parent,id:'followup-unrelated',turns:[{id:'peer-turn',status:'completed',items:[]}]};
      const members=[parent,child,grandchild,peer];c.threads=new Map(members.map(t=>[t.id,t]));c.loadedIds=members.map(t=>t.id);members.forEach(t=>e.rememberThread(t));
      const binding={threadId:parent.id,cwd:root,model:parent.model,modelProvider:parent.modelProvider};
      if(['run','completed','wrong-completion'].includes(scenario)){e.runs.set(child.id,'child-turn');e.startedTurns.set(child.id,'child-turn');}
      if(scenario==='reservation')e.runs.set(child.id,null);
      if(scenario==='started')e.startedTurns.set(child.id,'child-turn');
      if(scenario==='grandchild')e.runs.set(grandchild.id,'child-turn');
      if(scenario==='unrelated')e.runs.set(peer.id,'peer-turn');
      if(['completed','wrong-completion'].includes(scenario)){
        c.emitMessage({method:'turn/completed',params:{threadId:child.id,turn:{id:scenario==='completed'?'child-turn':'wrong-turn',status:'completed',items:[]}}});await tick();
      }
      const proof=await e.followupIdle(binding),ready=['idle','unrelated','completed','proof-invalidated'].includes(scenario);
      assert.equal(!!proof,ready,'follow-up family readiness: '+scenario);
      if(!ready){assert(e.runs.has(child.id)||e.startedTurns.has(child.id)||e.runs.has(grandchild.id),'readiness must preserve live records');continue;}
      proof.check();
      if(scenario==='proof-invalidated'){
        e.runs.set(child.id,null);
        assert.throws(()=>proof.check(),error=>error.code==='PROJECT_BUSY','a new child reservation invalidates the proof without needing a completion event');
        continue;
      }
      const before=c.calls.filter(q=>q.method==='turn/start'&&q.params.threadId===parent.id).length;
      c.nextTurnId='followup-family-control';
      const result=await e.handle({action:'send',threadId:parent.id,text:'Synthetic family follow-up'},undefined,{beforeStart:async()=>proof.check(),check:()=>proof.check(),onTurn:async()=>{}});
      assert.equal(c.calls.filter(q=>q.method==='turn/start'&&q.params.threadId===parent.id).length,before+1,'verified family idle dispatches exactly once');
      assert.equal(result.turn.id,'followup-family-control');
    }finally{await e.close();}
  }
  console.log('PASS follow-up descendant readiness: live run, null reservation, started-only, grandchild, exact and wrong completion, unrelated root, and final proof invalidation');
  // Trusted fork input is private, complete and pinned; public requests still expose only an ID.
  {
    assert.equal(typeof engine.forkFromSnapshot,'function','Trusted fork-from-snapshot operation must exist');
    const home=join(root,'snapshot-fork'),stage=join(home,'fork-source'),path=join(stage,'source.jsonl');await mkdir(stage,{recursive:true,mode:0o700});
    const source={id:'source-root',cwd:root,model:'fixture/saved-snapshot-65k',modelProvider:'saleh_local'};
    const header={type:'session_meta',payload:{id:source.id,cwd:root,model_provider:source.modelProvider,multi_agent_version:'v2',base_instructions:{provenance:{type:'custom'},text:handoffInstructions}}};
    const bytes=Buffer.from(JSON.stringify(header)+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'source-turn'}})+'\n');
    await writeFile(path,bytes,{mode:0o600});const info=await lstat(path,{bigint:true});
    const input={source,path,identity:{dev:String(info.dev),ino:String(info.ino)},sha256:createHash('sha256').update(bytes).digest('hex')};
    const e=new CodingEngine({dataDir:home,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',localModels:{async resolve(){throw Error('Saved snapshot fork must not require a loaded model.');}}});let committed;
    try{
      await e.ensure();const child=e.child;child.nextThreadId='independent-fork';
      const result=await e.forkFromSnapshot({...input,onCreated:async t=>{committed=t.id;assert(e.admissions.size);}});
      assert.equal(committed,'independent-fork');assert.equal(result.thread.forkedFromId,source.id);assert(e.verifiedThreads.has(committed));assert.equal(e.admissions.size,0);
      const call=child.calls.find(q=>q.method==='thread/fork');assert(call);assert.equal(call.params.path,path);assert.equal(call.params.deferGoalContinuation,true);assert.equal(call.params.ephemeral,false);assert.equal(call.params.excludeTurns,true);assert.equal(call.params.baseInstructions,handoffInstructions);assert.deepEqual(call.params.runtimeWorkspaceRoots,[root]);assert.equal(call.params.config['web_search'],'disabled');assert.equal(call.params.config['features.hooks'],false);assert.equal(call.params.config['features.plugins'],false);assert.equal(child.calls.filter(q=>['turn/start','review/start','command/exec'].includes(q.method)).length,0);
      const before=child.calls.filter(q=>q.method==='thread/fork').length;
      for(const bad of [{source:{...source,id:'wrong-source'}},{sha256:'0'.repeat(64)},{identity:{dev:input.identity.dev,ino:'0'}},{path:join(home,'sessions','fork.jsonl')},{source:{...source,model:null}},{source:{...source,model:'invalid\nmodel'}},{onCreated:null}])await assert.rejects(e.forkFromSnapshot({...input,onCreated:async()=>{},...bad}),/fork|snapshot|profile|callback|model|session header/i);
      assert.equal(child.calls.filter(q=>q.method==='thread/fork').length,before);
      for(const content of [bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from('not-json\n')]),Buffer.concat([bytes,Buffer.from(JSON.stringify(header)+'\n')])]){
        await writeFile(path,content);const bad={...input,sha256:createHash('sha256').update(content).digest('hex')};await assert.rejects(e.forkFromSnapshot({...bad,onCreated:async()=>{}}),/incomplete|malformed|invalid/);
      }await writeFile(path,bytes);
      const link=join(stage,'link.jsonl');await symlink(path,link);await assert.rejects(e.forkFromSnapshot({...input,path:link,onCreated:async()=>{}}),/staging/);
      const fifo=join(stage,'fifo.jsonl');await promisify(execFile)('/usr/bin/mkfifo',[fifo]);const fifoInfo=await lstat(fifo,{bigint:true});await assert.rejects(e.forkFromSnapshot({...input,path:fifo,identity:{dev:String(fifoInfo.dev),ino:String(fifoInfo.ino)},onCreated:async()=>{}}),/type/);
      const large=await fsPromises.open(join(stage,'large.jsonl'),'wx',0o600);await large.truncate(32*1024*1024+1);const bigInfo=await large.stat({bigint:true});await large.close();await assert.rejects(e.forkFromSnapshot({...input,path:join(stage,'large.jsonl'),identity:{dev:String(bigInfo.dev),ino:String(bigInfo.ino)},onCreated:async()=>{}}),/size/);
      assert.equal(child.calls.filter(q=>q.method==='thread/fork').length,before);
      await assert.rejects(e.handle({action:'fork',threadId:source.id,path}),/field/);
      child.nextThreadId='invalid-fork';child.forkReply=r=>({...r,thread:{...r.thread,forkedFromId:'wrong-root'}});let invalidCommitted=false;
      await assert.rejects(e.forkFromSnapshot({...input,onCreated:async()=>{invalidCommitted=true;}}),/fork|source|identity/i);assert.equal(invalidCommitted,false);child.forkReply=null;
      child.nextThreadId='wrong-model-fork';child.forkReply=r=>({...r,thread:{...r.thread,model:localConfig.model},model:localConfig.model});
      await assert.rejects(e.forkFromSnapshot({...input,onCreated:async()=>{invalidCommitted=true;}}),/fork|source|identity/i);assert.equal(invalidCommitted,false);child.forkReply=null;
      child.nextThreadId='policy-fork';child.forkReply=r=>({...r,sandbox:{type:'dangerFullAccess'}});
      await assert.rejects(e.forkFromSnapshot({...input,onCreated:async()=>{invalidCommitted=true;}}),/policy|sandbox/i);assert.equal(invalidCommitted,false);child.forkReply=null;
      child.nextThreadId='ephemeral-fork';child.forkReply=r=>({...r,thread:{...r.thread,ephemeral:true}});
      await assert.rejects(e.forkFromSnapshot({...input,onCreated:async()=>{invalidCommitted=true;}}),/fork|identity|durable/i);assert.equal(invalidCommitted,false);child.forkReply=null;
      for(const override of [{writableRoots:['/']},{networkAccess:true},{excludeSlashTmp:false},{excludeTmpdirEnvVar:false}]){
        child.nextThreadId='unsafe-policy-fork';child.forkReply=r=>({...r,sandbox:{...r.sandbox,...override}});await assert.rejects(e.forkFromSnapshot({...input,onCreated:async()=>{invalidCommitted=true;}}),/policy/);assert.equal(invalidCommitted,false);
      }child.forkReply=null;
      const mutable=structuredClone(input),prepare=e.prepare.bind(e);e.prepare=async(...args)=>{mutable.source.id='mutated';mutable.path='/changed';mutable.identity.ino='0';return prepare(...args);};child.nextThreadId='frozen-input';
      assert.equal((await e.forkFromSnapshot({...mutable,onCreated:async()=>{}})).thread.forkedFromId,source.id);e.prepare=prepare;
      child.nextThreadId='late-fork';child.deferredForks=[];let lateCommitted;
      const pending=e.forkFromSnapshot({...input,onCreated:async t=>{lateCommitted=t.id;}}),rejected=assert.rejects(pending,/Stop|cancelled/i);
      await waitFor(()=>child.deferredForks.length);assert.equal(child.deferredForks.length,1);await e.stop();const late=child.deferredForks[0];child.emitMessage({id:late.q.id,result:late.result});await rejected;assert.equal(lateCommitted,'late-fork');assert.equal(e.admissions.size,0);
      child.deferredForks=null;child.nextThreadId='held-commit';let releaseCommit,entered=false;const commitGate=new Promise(r=>releaseCommit=r);
      const held=e.forkFromSnapshot({...input,onCreated:async()=>{entered=true;await commitGate;}}),heldRejected=assert.rejects(held,/Stop|cancelled/i);await waitFor(()=>entered);assert(entered);await e.stop();assert.equal(e.admissions.size,1,'Retain admission until durable callback settles');await assert.rejects(e.reserveProjectMutation(async()=>[root]),e=>e.code==='PROJECT_BUSY');releaseCommit();await heldRejected;assert.equal(e.admissions.size,0);

    }finally{await e.close();}
    const reader=new CodingEngine({dataDir:home,historyOnly:true});try{await assert.rejects(reader.forkFromSnapshot({...input,onCreated:async()=>{}}),/History-only/);}finally{await reader.close();}
    console.log('coding-engine snapshot fork checks passed');
  }
  if(process.argv.includes('--fork-only'))break checks;
  function commandPeer(callbacks,{waitReady=false}={}) {
    const peer={calls:[],pending:new Map(),ready:Promise.resolve(),confirmed:true,holdGit:false,...callbacks};
    if(waitReady)peer.ready=new Promise(resolve=>peer.releaseReady=resolve);
    peer.finish=(id,exitCode=0)=>{const task=peer.pending.get(id);assert(task);peer.pending.delete(id);task.resolve({exitCode,stdout:'remote output',stderr:''});};
    peer.request=async(method,params)=>{
      peer.calls.push({method,params});
      if(method==='command/exec/terminate'&&peer.finishBeforeTerminateResponse){peer.finish(params.processId,130);throw new Error('Executor command is no longer active.');}
      if(method!=='command/exec')return {};
      if(!params.tty&&!params.streamStdin&&!peer.holdGit)return {exitCode:0,stdout:params.command.includes('symbolic-ref')?'remote-branch\n':'remote diff',stderr:''};
      return new Promise((resolve,reject)=>peer.pending.set(params.processId,{resolve,reject}));
    };
    peer.close=async()=>{if(peer.confirmed)for(const id of [...peer.pending.keys()])peer.finish(id,130);return peer.confirmed;};
    return peer;
  }
  {
    let remote;
    const e=new CodingEngine({dataDir:join(root,'remote-commands'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:callbacks=>(remote=commandPeer(callbacks))});
    try{
      await e.handle({action:'start',cwd:root});const c=children.at(-1);
      assert(remote,'Trusted command transport must be created during startup');
      const git=await e.handle({action:'git',threadId:'thread-1'});assert.equal(git.branch,'remote-branch');assert.equal(remote.calls.filter(q=>q.method==='command/exec').length,4);
      const terminal=await e.handle({action:'terminalStart',threadId:'thread-1',mode:'pty',command:'',cols:120,rows:40});
      const output={processId:terminal.processId,stream:'stdout',deltaBase64:Buffer.from('REMOTE').toString('base64'),capReached:false};
      c.emitMessage({method:'command/exec/outputDelta',params:{...output,deltaBase64:Buffer.from('HOST_SPOOF').toString('base64')}});
      remote.onOutput(output);const snapshot=JSON.stringify(await e.handle({action:'terminalSnapshot',processId:terminal.processId}));assert(snapshot.includes('REMOTE'));assert(!snapshot.includes('HOST_SPOOF'));
      await e.handle({action:'terminalInput',processId:terminal.processId,dataBase64:Buffer.from('سلام\n').toString('base64')});
      await e.handle({action:'terminalResize',processId:terminal.processId,cols:97,rows:31});
      let finished=false;const stop=e.handle({action:'terminalStop',processId:terminal.processId}).then(r=>{finished=true;return r;});
      await waitFor(()=>remote.calls.some(q=>q.method==='command/exec/terminate'));assert(!finished,'Terminate ACK cannot retire the terminal');assert(e.terminals.has(terminal.processId));
      remote.finish(terminal.processId,130);await stop;assert(!e.terminals.has(terminal.processId));
      assert.deepEqual(remote.calls.filter(q=>q.method!=='command/exec').map(q=>q.method),['command/exec/write','command/exec/resize','command/exec/terminate']);
      const raced=await e.handle({action:'terminalStart',threadId:'thread-1',command:'cat'});remote.finishBeforeTerminateResponse=true;
      await e.handle({action:'terminalStop',processId:raced.processId});assert.equal(e.child,c,'An authoritative command result wins a racing termination rejection');
      assert(!c.calls.some(q=>q.method?.startsWith('command/exec')),'Remote commands must never fall back to host RPC');
    }finally{await e.close();}
  }
  {
    let remote;
    const e=new CodingEngine({dataDir:join(root,'remote-uncertain'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:callbacks=>(remote=commandPeer(callbacks))});
    try{
      await e.handle({action:'start',cwd:root});const c=children.at(-1),terminal=await e.handle({action:'terminalStart',threadId:'thread-1',command:'cat'});remote.confirmed=false;
      c.emit('exit',1,null);await e.disposal;
      assert(e.exitUnconfirmed);assert(e.terminals.has(terminal.processId),'Host exit cannot retire a remote terminal without its original command result');
      const cursor=e.sequence;remote.onOutput({processId:terminal.processId,stream:'stdout',deltaBase64:'TEFURQ==',capReached:false});assert.equal(e.sequence,cursor,'Retired transport output must be ignored');
      await assert.rejects(e.reserveProjectMutation(async()=>[root]),/lifecycle/);await assert.rejects(e.ensure(),/unconfirmed/);
      assert((await e.handle({action:'status'})).busy);
    }finally{await e.close();}
  }
  {
    let remote;
    const e=new CodingEngine({dataDir:join(root,'remote-git-stop'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:callbacks=>(remote=commandPeer(callbacks))});
    try{
      await e.handle({action:'start',cwd:root});remote.holdGit=true;
      const git=e.handle({action:'git',threadId:'thread-1'}),rejected=assert.rejects(git,/Git inspection|cancelled|Stop/);
      await waitFor(()=>remote.pending.size===4);assert.equal(remote.pending.size,4);assert(e.projectOccupied(root));
      let stopped=false;const stopping=e.stop().then(r=>{stopped=true;return r;});await waitFor(()=>remote.calls.filter(q=>q.method==='command/exec/terminate').length===4);assert(!stopped);
      for(const id of [...remote.pending.keys()])remote.finish(id,130);
      await rejected;await stopping;assert.equal(remote.calls.filter(q=>q.method==='command/exec').length,4,'Stop must cancel Git fallback too');
    }finally{await e.close();}
  }
  {
    let remote;
    const e=new CodingEngine({dataDir:join(root,'remote-startup-stop'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:callbacks=>(remote=commandPeer(callbacks,{waitReady:true}))});
    try{
      const work=e.handle({action:'terminalStart',threadId:'thread-1',command:'echo must-not-run'}),rejected=assert.rejects(work,/cancelled|Stop/);
      await waitFor(()=>!!remote);assert(remote);await e.stop();remote.releaseReady();await rejected;assert.equal(remote.calls.length,0);
    }finally{await e.close();}
  }
  {
    let created=0;
    const e=new CodingEngine({dataDir:join(root,'remote-retired-startup'),binary:'/fake/codex',spawnProcess:(...args)=>{const child=spawnFake(...args);child.exitAfterMCP=true;return child;},localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:callbacks=>{created++;return commandPeer(callbacks);}});
    try{await assert.rejects(e.ensure(),/process/i);assert.equal(created,0,'Retired startup must not create an unowned sidecar');}finally{await e.close();}
  }
  const executorBinding=()=>({url:'ws://127.0.0.1:19999',authToken:'owner-fixture-secret',launch:{argv:['/fixture/codex','app-server','--listen','stdio://'],cwd:'file:///private/var/empty',env:{HOME:'/fixture/private',CODEX_HOME:'/fixture/private'}}});
  {
    const binding=executorBinding();let remote,created=0;
    const e=new CodingEngine({dataDir:join(root,'owner-atomic-startup'),binary:'/fake/codex',executor:binding,spawnProcess:(...args)=>{const c=spawnFake(...args);c.deferredBinding=[];c.deferredEnvironmentInfo=[];return c;},localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:options=>{created++;return remote=commandPeer(options,{waitReady:true});}});
    try{
      binding.url='ws://127.0.0.1:20000';binding.authToken='mutated-secret';binding.launch.env.CODEX_HOME='/mutated';
      const starting=e.handle({action:'start',cwd:root});void starting.catch(()=>{});await waitFor(()=>children.at(-1)?.deferredBinding?.length);const c=children.at(-1);
      const inspecting=e.handle({action:'git',threadId:'thread-1'});void inspecting.catch(()=>{});
      assert.equal(c.options.env.CODEX_EXEC_SERVER_URL,'ws://127.0.0.1:19999/','Remote default must be set at process creation');
      assert.equal(c.options.env.HOME,e.dataDir,'Bound model home must be private before process creation');
      const add=c.deferredBinding[0];assert(add);assert.equal(add.params.environmentId,'remote');assert.equal(add.params.authBearerToken,'owner-fixture-secret');assert(!remote);assert(!c.calls.some(q=>q.method==='thread/start'));
      c.emitMessage({id:add.id,result:{}});await waitFor(()=>c.deferredEnvironmentInfo.length);assert(!remote);assert(!c.calls.some(q=>q.method==='thread/start'));
      c.emitMessage({id:c.deferredEnvironmentInfo[0].id,result:{shell:{name:'zsh',path:'/bin/zsh'},cwd:'file:///private/var/empty'}});await waitFor(()=>!!remote);
      assert(remote);assert.equal(created,1);assert(!c.calls.some(q=>q.method==='thread/start'));assert.equal(remote.calls.length,0,'Concurrent command caller must wait for sidecar readiness');
      remote.releaseReady();await starting;await inspecting;assert.equal(created,1);assert.equal(remote.calls.length,4);
      assert(remote);assert.equal(remote.url,'ws://127.0.0.1:19999/');assert.equal(remote.authToken,'owner-fixture-secret');assert.equal(remote.launch.env.CODEX_HOME,'/fixture/private');
      assert(!JSON.stringify(await e.handle({action:'status'})).includes('owner-fixture-secret'));assert(!(await readFile(join(e.dataDir,'config.toml'),'utf8')).includes('owner-fixture-secret'));
      await assert.rejects(e.handle({action:'start',cwd:root,executor:executorBinding()}),/Unsupported coding action field/);
    }finally{await e.close();}
  }
  for(const mode of ['local-ready','remote-pending','relative-shell','sidecar-failed']){
    let remote;const e=new CodingEngine({dataDir:join(root,'owner-reject-'+mode),binary:'/fake/codex',executor:executorBinding(),spawnProcess:(...args)=>{const c=spawnFake(...args);c.environmentStatuses=mode==='local-ready'?{local:'ready'}:mode==='remote-pending'?{remote:'pending'}:{};if(mode==='relative-shell')c.executorShell='bin/zsh';return c;},localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:options=>{remote=commandPeer(options);remote.ready=Promise.reject(new Error('Fixture sidecar startup failed.'));void remote.ready.catch(()=>{});remote.confirmed=false;return remote;}});
    try{
      await assert.rejects(e.handle({action:'start',cwd:root}),/binding failed|sidecar startup failed/);await e.disposal;
      assert(!children.at(-1).calls.some(q=>q.method==='thread/start'));
      if(mode==='sidecar-failed'){assert(remote);assert.equal(remote.calls.length,0);assert(e.exitUnconfirmed);await assert.rejects(e.ensure(),/unconfirmed/);}else assert(!remote);
    }finally{await e.close();}
  }
  for(const retire of [false,true]){
    let created=0;const binding=executorBinding();
    const e=new CodingEngine({dataDir:join(root,'owner-binding-failure-'+retire),binary:'/fake/codex',executor:binding,spawnProcess:(...args)=>{const c=spawnFake(...args);if(retire)c.deferredEnvironmentInfo=[];else c.bindingError='Authentication failed: '+binding.authToken;return c;},localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:options=>{created++;return commandPeer(options);}});
    try{
      const pending=e.handle({action:'start',cwd:root}),rejected=assert.rejects(pending,/executor|binding|process/i);
      if(retire){await waitFor(()=>children.at(-1)?.deferredEnvironmentInfo?.length);const c=children.at(-1),q=c.deferredEnvironmentInfo[0];assert(q);c.emitMessage({id:q.id,result:{shell:{name:'zsh',path:'/bin/zsh'}}});c.emit('exit',1,null);}
      await rejected;await e.disposal;assert.equal(created,0);assert(!children.at(-1).calls.some(q=>q.method==='thread/start'));assert(!JSON.stringify(await e.handle({action:'status'})).includes(binding.authToken));
    }finally{await e.close();}
  }
  {
    let remote;const e=new CodingEngine({dataDir:join(root,'owner-stop-binding'),binary:'/fake/codex',executor:executorBinding(),spawnProcess:(...args)=>{const c=spawnFake(...args);c.deferredBinding=[];return c;},localBaseURL:'http://127.0.0.1:1234/v1',createCommandTransport:options=>(remote=commandPeer(options))});
    try{
      const pending=e.handle({action:'start',cwd:root}),rejected=assert.rejects(pending,/cancelled|Stop/);await waitFor(()=>children.at(-1)?.deferredBinding?.length);const c=children.at(-1);assert(c.deferredBinding[0]);await e.stop();c.emitMessage({id:c.deferredBinding[0].id,result:{}});await rejected;assert(!c.calls.some(q=>q.method==='thread/start'));
    }finally{await e.close();}
  }
  assert.throws(()=>new CodingEngine({executor:{...executorBinding(),url:'ws://example.com'}}),/secure|loopback/i);
  console.log('executor owner atomic startup checks passed');
  console.log('executor command engine checks passed');
  if(process.argv.includes('--commands-only'))break checks;

  assert.equal(typeof module.CodingEvents,'function','Shared event journal must exist');
  {
    const {CodingEvents}=module,journal=new CodingEvents(),owners=[];
    const make=name=>{
      const e=new CodingEngine({journal,dataDir:join(root,'shared-events-'+name),binary:'/fake/codex',localBaseURL:'http://127.0.0.1:1234/v1',spawnProcess:(...args)=>{const c=spawnFake(...args);c.nextThreadId='events-'+name;return c;}});
      owners.push(e);return e;
    };
    const a=make('a'),b=make('b');
    assert.throws(()=>new CodingEngine({dataDir:join(root,'bad-events'),journal:{}}),/journal/i);
    try {
      const ar=await a.handle({action:'start',cwd:root}),br=await b.handle({action:'start',cwd:root}),aid=ar.thread.id,bid=br.thread.id,ac=a.child,bc=b.child;
      const delta=(id,suffix)=>({method:'item/agentMessage/delta',params:{threadId:id,turnId:'turn-'+id,itemId:'message',delta:suffix}});
      const metadata=(id,mode)=>({id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:mode,turns:[{id:'turn-'+id,status:'inProgress',items:[]}]});
      ac.threads=new Map();bc.threads=new Map([[bid,metadata(bid,'legacy')]]);
      for(const mode of ['legacy','paginated','empty']){
        a.liveHistory.clear();ac.threads.set(aid,metadata(aid,mode==='paginated'?'paginated':'legacy'));ac.unmaterialized=mode==='empty';
        bc.emitMessage(delta(bid,'peer-before-'+mode));ac.emitMessage(delta(aid,'before-'+mode));
        const receive=a.receive.bind(a),merge=a.mergeLive.bind(a);let boundary;
        a.mergeLive=thread=>{const result=merge(thread);boundary=journal.sequence;queueMicrotask(()=>{bc.emitMessage(delta(bid,'peer-after-merge-'+mode));ac.emitMessage(delta(aid,'after-merge-'+mode));});return result;};
        a.receive=message=>{
          const pending=a.pending.get(message.id),history=pending?.method==='thread/turns/list'||pending?.method==='thread/read'&&pending.params.includeTurns;
          receive(message);
          if(history){bc.emitMessage(delta(bid,'peer-after-'+mode));ac.emitMessage(delta(aid,'after-'+mode));}
        };
        const result=await a.handle({action:'read',threadId:aid});a.receive=receive;a.mergeLive=merge;
        assert.equal(result.cursor,boundary,'Capture the shared clock at the final synchronous history merge, before later async reads finish');
        const snapshot=JSON.stringify(result.thread.turns);assert(snapshot.includes('before-'+mode));assert(snapshot.includes('after-'+mode));assert(!snapshot.includes('after-merge-'+mode));
        const poll=await b.handle({action:'events',after:result.cursor});
        assert.deepEqual(poll.events.filter(e=>e.method==='item/agentMessage/delta').map(e=>e.params.delta),['peer-after-merge-'+mode,'after-merge-'+mode]);
        assert.equal(poll.cursor,journal.sequence);assert.equal(a.sequence,b.sequence);assert.equal(result.pendingMaterialization,mode==='empty'?true:undefined);
      }
      ac.unmaterialized=false;
      for(const [method,includeTurns,message,tagged] of [
        ['thread/read',false,'thread not loaded: '+aid,true],
        ['thread/read',false,'thread not loaded: other-id',false],
        ['thread/read',true,'thread not loaded: '+aid,false],
        ['thread/list',false,'thread not loaded: '+aid,false],
        ['thread/read',false,'empty rollout: '+aid,false]
      ]){
        let failure;const responseId=987654,boundary=journal.sequence;
        a.pending.set(responseId,{method,params:{threadId:aid,includeTurns},reject:error=>{failure=error;}});
        a.receive({id:responseId,error:{message}});bc.emitMessage(delta(bid,'after-missing-response'));
        assert.equal(failure.code,tagged?'CODING_THREAD_NOT_LOADED':undefined);
        assert.equal(failure.cursor,tagged?boundary:undefined);assert.equal(failure.threadId,tagged?aid:undefined);
        assert(journal.sequence>boundary,'A later event must not move the captured response boundary');
      }
      const methods=['item/commandExecution/requestApproval'];
      for(const [e,id] of [[a,aid],[b,bid]]){e.runs.set(id,'turn-'+id);e.requestApproval({id:8800,method:methods[0],params:{threadId:id,turnId:'turn-'+id,itemId:'command',command:'pwd'}},true);}
      const approvalA=[...a.approvals.keys()][0],approvalB=[...b.approvals.keys()][0];assert(approvalA&&approvalB&&approvalA!==approvalB);
      const approvals=(await a.handle({action:'events',after:journal.sequence})).approvals;
      assert.deepEqual(new Set(approvals.map(a=>a.id)),new Set([approvalA,approvalB]));
      const readerHome=join(root,'shared-events-reader'),seed=new CodingEngine({dataDir:readerHome});await seed.configFile();await seed.close();
      const reader=new CodingEngine({dataDir:readerHome,historyOnly:true,journal,binary:'/fake/codex',spawnProcess:spawnFake});owners.push(reader);
      await reader.ensure();const readerChild=reader.child;readerChild.deferredReads=new Map([['saved-reader-root',[]]]);
      const pendingRead=reader.rpc('thread/read',{threadId:'saved-reader-root',includeTurns:false}),readRejected=assert.rejects(pendingRead,/Coding engine closed\./);
      assert.equal(readerChild.deferredReads.get('saved-reader-root').length,1);assert.equal(reader.runs.size,0);
      const beforeReaderClose=journal.sequence;await reader.close();await readRejected;
      assert(reader.closed&&reader.closeSettled&&readerChild.killed);assert.equal(reader.pending.size,0);
      const afterReaderClose=journal.read(beforeReaderClose);
      assert(!afterReaderClose.events.some(e=>e.method==='coding/error'),'Intentional reader retirement must not report a shared coding error');
      assert.deepEqual(new Set(afterReaderClose.approvals.map(a=>a.id)),new Set([approvalA,approvalB]));assert.equal(a.runs.get(aid),'turn-'+aid);assert.equal(b.runs.get(bid),'turn-'+bid);
      const afterReaderCloseCursor=journal.sequence;await reader.close();assert.equal(journal.sequence,afterReaderCloseCursor,'Repeated close must not emit another notification');
      const savedA=a.approvals.get(approvalA);b.approvals.set(approvalA,savedA);assert.throws(()=>journal.read(),/Ambiguous.*approval/);b.approvals.delete(approvalA);
      await assert.rejects(a.handle({action:'approvalInfo',id:approvalB}),/expired/);
      await b.handle({action:'approval',id:approvalB,decision:'decline'});assert(a.approvals.has(approvalA));assert(!b.approvals.size);
      let refreshA=0,refreshB=0;a.refreshReceipts=()=>{refreshA++;};b.refreshReceipts=()=>{refreshB++;};
      await a.handle({action:'events',after:journal.sequence});assert.equal(refreshA,1);assert.equal(refreshB,1);
      const beforeClose=journal.sequence;await a.close();const closedCursor=journal.sequence;
      assert(closedCursor>beforeClose);assert(!journal.read(beforeClose).approvals.length);assert(journal.read(beforeClose).events.some(e=>e.method==='coding/approvalExpired'));
      const exposed=journal.read(0).events;exposed.at(-1).params.message='mutated';journal.events.splice(0);assert.notEqual(journal.read(0).events.at(-1).params.message,'mutated');
      const retained=journal.read(0).events;await b.handle({action:'events',after:closedCursor});assert.equal(refreshA,1,'Closed owners must stop receiving receipt polls');
      const c=make('c');await assert.rejects(c.handle({action:'events',journal:{}}),/Unsupported.*field/);c.push('coding/test',{threadId:'events-c'});assert.equal(c.sequence,closedCursor+1);assert.deepEqual(journal.read(0).events.slice(0,-1),retained);
      const isolated=new CodingEngine({dataDir:join(root,'isolated-events')});assert.equal(isolated.sequence,0);
      isolated.fail(new Error('Coding engine closed.'));assert.deepEqual(isolated.events.map(e=>({method:e.method,params:e.params})),[{method:'coding/error',params:{message:'Coding engine closed.',turns:[]}}],'An actual failure must still report an error, even if its text matches normal closure');
      await isolated.close();assert.equal(isolated.events.length,1,'Normal close must not duplicate the failure notification');assert.equal(journal.sequence,closedCursor+1);
      b.fail(new Error('Restartable fixture failure'));const failedCursor=journal.sequence;let refreshedAfterFailure=0;b.refreshReceipts=()=>{refreshedAfterFailure++;return new Promise(()=>{});};await c.handle({action:'events',after:failedCursor});assert.equal(refreshedAfterFailure,1,'An unclosed failed engine remains registered; a pending refresh cannot block polling');
      for(let i=0;i<1100;i++)b.push('item/agentMessage/delta',{threadId:bid,delta:'x'.repeat(24000),encrypted_content:'secret-never-display'});
      let cursor=0,count=0,pages=0,previous=0;
      do{const page=journal.read(cursor);assert.equal(page.gap,pages===0);assert(page.events.length>0);assert(JSON.stringify(page.events).length<257000);assert(!JSON.stringify(page).includes('secret-never-display'));for(const event of page.events){assert(event.sequence>previous);previous=event.sequence;}count+=page.events.length;pages++;cursor=page.cursor;}while(cursor<journal.sequence);
      assert.equal(count,1000);assert(pages>1);assert.equal(journal.read(cursor).events.length,0);
      for(const invalid of [-1,1.5,journal.sequence+1,'0'])assert.throws(()=>journal.read(invalid),/cursor/);
    } finally {for(const owner of owners)await owner.close();}
  }
  console.log('shared coding event and history cursor checks passed');
  if(process.argv.includes('--events-only'))break checks;

  {
    const home=join(root,'reader-home'),seed=new CodingEngine({dataDir:home});await seed.configFile();await seed.close();
    const partial=JSON.stringify({version:1,truncated:false,threads:[{id:'saved-root',turns:[{id:'interrupted',status:'interrupted',items:[{id:'fragment',type:'agentMessage',text:'saved partial reply'}]}]}]});
    await writeFile(join(home,'interrupted-history.json'),partial);await writeFile(join(home,'providers.json'),JSON.stringify({cloud:{name:'Fixture cloud',model:'fixture-cloud-model',baseURL:'https://example.invalid/v1'}}));
    const configBefore=await readFile(join(home,'config.toml'),'utf8'),markerBefore=await readFile(join(home,'.saleh-config.sha256'),'utf8');let credentials=0,spawned=0;
    const reader=new CodingEngine({dataDir:home,historyOnly:true,binary:'/fake/codex',readCloudKey:async()=>{credentials++;throw Error('Reader accessed credential');},spawnProcess:(...args)=>{spawned++;return spawnFake(...args);}});
    assert.equal(reader.historyOnly,true,'History capability must be explicit and immutable');assert.throws(()=>{reader.historyOnly=false;},TypeError);
    assert.throws(()=>new CodingEngine({dataDir:home,historyOnly:'true'}),/history/i);
    assert.throws(()=>new CodingEngine({dataDir:home,historyOnly:true,executor:{}}),/history/i);
    assert.throws(()=>new CodingEngine({dataDir:home,historyOnly:true,createCommandTransport:()=>{}}),/history/i);
    try{
      for(const action of ['start','send','steer','review','fork','rename','archive','unarchive','git','terminalStart','terminalWrite','terminalInput','terminalResize','terminalStop','terminalSnapshot','approvalInfo','approval','interrupt','interruptFamily','reloadProviders'])await assert.rejects(reader.handle({action,threadId:'saved-root'}),/history.only/i);
      let claimed=false;await assert.rejects(reader.runScheduled({cwd:root,prompt:'must not run',onClaim:()=>{claimed=true;}}),/history.only/i);
      let resolved=false;await assert.rejects(reader.reserveProjectMutation(async()=>{resolved=true;return [root];}),/history.only/i);
      assert(!claimed&&!resolved);assert.equal(spawned,0);assert.equal(reader.admissions.size,0);assert.equal(reader.terminalStarts.size,0);
      await reader.ensure();const c=reader.child;assert(c);assert.equal(credentials,0);assert.equal(reader.relay,null);assert(!reader.processLife.commands);
      for(const key of ['HOME','CODEX_HOME','ZDOTDIR'])assert.equal(c.options.env[key],home);assert(!c.options.env.CODEX_EXEC_SERVER_URL);assert(!c.options.env.SALEH_CODING_CLOUD_KEY);
      assert(c.args.includes('features.plugins=false'),'History reader must disable plugin startup before launch');
      assert(c.args.includes('sandbox_mode="read-only"'));assert(c.args.includes('approval_policy="never"'));assert(c.args.includes('model_providers.saleh_local.base_url="http://127.0.0.1:9/v1"'));
      c.threads=new Map([['saved-root',{id:'saved-root',cwd:root,model:'fixture-cloud-model',modelProvider:'saleh_cloud',historyMode:'legacy',status:{type:'active'},turns:[]}],['saved-child',{id:'saved-child',parentThreadId:'saved-root',cwd:root,model:'fixture-cloud-model',modelProvider:'saleh_cloud',historyMode:'legacy',turns:[]}]]);
      const saved=await reader.handle({action:'read',threadId:'saved-root'});assert(JSON.stringify(saved.thread).includes('saved partial reply'));
      assert.equal((await reader.handle({action:'family',threadId:'saved-child'})).rootThreadId,'saved-root');await reader.handle({action:'list'});
      assert.equal(reader.localProjectOccupied(root),false,'Saved active status is not a live reader run');
      assert.equal(await reader.projectHasBackground(root,reader.processLife),false);
      const before=c.calls.length;
      for(const method of ['thread/start','thread/resume','thread/fork','review/start','turn/start','turn/interrupt','command/exec','thread/archive','config/value/write','skills/config/write','environment/add','thread/backgroundTerminals/terminate'])await assert.rejects(reader.rpc(method,{}),/history.only/i);
      await assert.rejects(reader.rpc('account/read',{refreshToken:true}),/history.only/i);await assert.rejects(reader.rpc('config/read',{cwd:root}),/history.only/i);
      assert.throws(()=>reader.write({id:5,result:{decision:'accept'}}),/history.only/i);assert.equal(c.calls.length,before);
      c.emitMessage({id:9876,method:'item/commandExecution/requestApproval',params:{threadId:'saved-root',turnId:'bad',command:'pwd'}});assert.equal(reader.approvals.size,0);assert(c.calls.some(q=>q.id===9876&&q.error?.code===-32601));
      for(const work of [()=>reader.trustProject(root),()=>reader.temporaryEnvironment(root,reader.epoch),()=>reader.prepareHandoff('saved-root'),()=>reader.relocateFamily({},root),()=>reader.prepareHandoffRecovery({},root,{}),()=>reader.recoverHandoffFamily({},root)])await assert.rejects(work(),/history.only/i);
      assert.equal(await readFile(join(home,'interrupted-history.json'),'utf8'),partial);assert.equal(await readFile(join(home,'config.toml'),'utf8'),configBefore);assert.equal(await readFile(join(home,'.saleh-config.sha256'),'utf8'),markerBefore);
      const status=await reader.handle({action:'status'});assert.equal(status.historyOnly,true);assert.equal(status.running,false);assert.equal(status.providers.find(p=>p.id==='cloud').available,null);assert.equal(status.providers.find(p=>p.id==='cloud').message,'Saved history only.');
      const beforeReaderStop=reader.sequence;await reader.stop();assert(reader.closed&&reader.closeSettled);assert(c.killed);assert(!c.calls.some(q=>q.method?.includes('terminate')||q.method==='turn/interrupt'));assert.equal(await readFile(join(home,'interrupted-history.json'),'utf8'),partial);
      assert(!reader.events.some(e=>e.sequence>beforeReaderStop&&e.method==='coding/error'),'Stopping an idle history reader is normal closure');
    }finally{await reader.close();}
    for(const pluginConfigFault of ['enabled','missing']){
      const e=new CodingEngine({dataDir:home,historyOnly:true,binary:'/fake/codex',spawnProcess:(...args)=>{const c=spawnFake(...args);c.pluginConfigFault=pluginConfigFault;return c;}});
      try{await assert.rejects(e.ensure(),/configuration or integration/i);assert(!e.child);}finally{await e.close();}
    }
    for(const unexpected of ['turn/started','item/started','command/exec/outputDelta','thread/started']){
      const e=new CodingEngine({dataDir:home,historyOnly:true,binary:'/fake/codex',spawnProcess:spawnFake});try{await e.ensure();const c=e.child;c.emitMessage({method:unexpected,params:{threadId:'saved-root',turn:{id:'unexpected'}}});assert(!e.child);assert.match(e.message,/history.only/i);assert(!e.runs.size);await e.disposal;}finally{await e.close();}
    }
    const loaded=new CodingEngine({dataDir:home,historyOnly:true,binary:'/fake/codex',spawnProcess:(...args)=>{const c=spawnFake(...args);c.loadedIds=['unexpected'];return c;}});try{await assert.rejects(loaded.ensure(),/history.only.*loaded/i);assert(!loaded.child);}finally{await loaded.close();}
    for(const localBaseURL of ['',false,0]){const invalid=new CodingEngine({dataDir:home,historyOnly:true,localBaseURL,binary:'/fake/codex',spawnProcess:()=>{throw Error('Unexpected reader spawn');}});try{await assert.rejects(invalid.ensure(),/history.only/i);assert.equal(invalid.relay,null);}finally{await invalid.close();}}
    const missing=join(root,'reader-missing'),absent=new CodingEngine({dataDir:missing,historyOnly:true,binary:'/fake/codex',spawnProcess:spawnFake});try{await assert.rejects(absent.ensure());await assert.rejects(stat(missing),{code:'ENOENT'});}finally{await absent.close();}
    assert.equal(await readFile(join(home,'interrupted-history.json'),'utf8'),partial);assert.equal(await readFile(join(home,'config.toml'),'utf8'),configBefore);
    const waiting=new CodingEngine({dataDir:home,historyOnly:true,binary:'/fake/codex',spawnProcess:spawnFake});await waiting.ensure();let releaseClose;const pendingDisposal=new Promise(resolve=>{releaseClose=resolve;});waiting.disposal=pendingDisposal;
    const first=waiting.close();let secondDone=false;const second=waiting.close().then(()=>{secondDone=true;});await tick();assert.equal(secondDone,false,'Repeated close must wait for the same owner disposal');releaseClose();await Promise.all([first,second]);
    const fifoHome=join(root,'reader-fifo');await mkdir(fifoHome);const fifoPath=join(fifoHome,'interrupted-history.json');await promisify(execFile)('/usr/bin/mkfifo',[fifoPath]);
    const script=`import {CodingEngine} from ${JSON.stringify(new URL('./coding-engine.mjs',import.meta.url).href)};const e=new CodingEngine({dataDir:${JSON.stringify(fifoHome)},historyOnly:true});await e.loadPartialHistory();if(!e.historyBlocked)process.exitCode=2;await e.close();`;
    const fifoResult=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{timeout:1500,killSignal:'SIGKILL'}).then(()=>({passed:true}),error=>({passed:false,killed:error.killed,error:error.message}));assert.equal(fifoResult.passed,true,JSON.stringify(fifoResult));assert((await lstat(fifoPath)).isFIFO());
  }
  console.log('native history-only reader checks passed');
  if(process.argv.includes('--history-only'))break checks;
  assert.equal(typeof module.CodingProjects,'function','Coding owners require one shared project admission authority');
  {
    const projects=new module.CodingProjects(),project=join(root,'shared-project'),other=join(root,'shared-other');await mkdir(project);await mkdir(other);
    const make=name=>new CodingEngine({projects,dataDir:join(root,'shared-home-'+name),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'}),a=make('a'),b=make('b');let lease;
    try{
      let resolvePaths;const pending=a.reserveProjectMutation(()=>new Promise(resolve=>{resolvePaths=resolve;}));assert(resolvePaths);
      assert(b.projectMutation?.pending,'All peer barriers must precede the resolver await');
      await assert.rejects(b.handle({action:'start',cwd:other}),error=>error.code==='PROJECT_BUSY');
      await assert.rejects(b.reserveProjectMutation(async()=>[other]),error=>error.code==='PROJECT_BUSY');
      assert.throws(()=>make('late'),/busy|reservation/i);resolvePaths([project]);lease=await pending;
      assert.equal(a.projectMutation.handle,lease);assert.equal(b.projectMutation.handle,lease);
      await assert.rejects(b.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');await b.handle({action:'start',cwd:other});
      await b.stop();assert.equal(b.projectMutation.handle,lease,'Peer Stop cannot release the shared Git lease');lease.release();
      const next=await b.reserveProjectMutation(async()=>[project]);lease.release();assert.equal(a.projectMutation.handle,next);next.release();lease=null;
      const c=children.at(-1),meta={id:'shared-owned',cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'},turns:[]};c.threads=new Map([[meta.id,meta]]);c.loadedIds=[meta.id];b.rememberThread(meta);
      b.runs.set(meta.id,'peer-active');await assert.rejects(a.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY');b.runs.clear();
      c.background=new Map([[meta.id,new Set(['idle-peer-command'])]]);await assert.rejects(a.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY');c.background.clear();
      let inventory;lease=await a.reserveProjectMutation(async()=>{inventory=await a.projectMutationInventory();return [other];});assert(inventory.includes(project));lease.release();lease=null;
      b.scheduled={cwd:project};await assert.rejects(a.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');await assert.rejects(a.runScheduled({cwd:other,prompt:'blocked by peer schedule',onClaim:async()=>assert.fail('must not claim')}),error=>error.code==='PROJECT_BUSY');b.scheduled=null;
      b.handoffs.set('retained-peer',{paths:[project],snapshot:{rootThreadId:meta.id,cwd:project,members:[meta]},destination:other,ids:new Set([meta.id])});await assert.rejects(a.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');await assert.rejects(a.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY','A retained peer handoff must fence Git acquisition too');b.handoffs.clear();
      b.exitUnconfirmed=true;await assert.rejects(a.reserveProjectMutation(async()=>[other]),/lifecycle|unconfirmed/);b.exitUnconfirmed=false;
    }finally{lease?.release();b.scheduled=null;b.handoffs.clear();b.exitUnconfirmed=false;await a.close();await b.close();}
  }
  {
    const projects=new module.CodingProjects(),project=join(root,'shared-race-project'),other=join(root,'shared-race-other');await mkdir(project);await mkdir(other);
    const make=name=>new CodingEngine({projects,dataDir:join(root,'shared-race-'+name),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'}),a=make('a'),b=make('b');let lease;
    try{
      await a.ensure();const ca=children.at(-1);await b.ensure();const cb=children.at(-1);
      const meta={id:'cycle-owner',cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'},turns:[]};ca.threads=new Map([[meta.id,meta]]);ca.loadedIds=[meta.id];a.rememberThread(meta);
      cb.deferredLoaded=[];const acquiring=a.reserveProjectMutation(async()=>[project]),rejected=assert.rejects(acquiring,error=>error.code==='PROJECT_BUSY');await waitFor(()=>cb.deferredLoaded.length);assert(cb.deferredLoaded.length);
      ca.emitMessage({method:'turn/started',params:{threadId:meta.id,turn:{id:'cycle-turn',status:'inProgress'}}});ca.emitMessage({method:'turn/completed',params:{threadId:meta.id,turn:{id:'cycle-turn',status:'completed'}}});ca.background=new Map([[meta.id,new Set(['late-idle-command'])]]);assert(!a.runs.size);
      const held=cb.deferredLoaded;delete cb.deferredLoaded;for(const q of held)cb.emitMessage({id:q.id,result:{data:[],nextCursor:null}});await rejected;assert.equal(a.projectMutation,null);assert.equal(b.projectMutation,null);ca.background.clear();
      const background=b.projectHasBackground.bind(b);
      for(const operation of ['mutation','schedule']){
        b.projectHasBackground=async(...args)=>{const result=await background(...args);queueMicrotask(()=>queueMicrotask(()=>{ca.emitMessage({method:'turn/started',params:{threadId:meta.id,turn:{id:'last-gap-'+operation,status:'inProgress'}}});ca.emitMessage({method:'turn/completed',params:{threadId:meta.id,turn:{id:'last-gap-'+operation,status:'completed'}}});ca.background=new Map([[meta.id,new Set(['last-gap-command'])]]);}));return result;};
        let claimed=false;await assert.rejects(operation==='mutation'?a.reserveProjectMutation(async()=>[project]):a.runScheduled({cwd:project,prompt:'race before claim',onClaim:async()=>{claimed=true;throw new Error('must not claim');}}),error=>error.code==='PROJECT_BUSY','The final synchronous commit must revalidate after the last scan await');assert(!claimed);ca.background.clear();
      }
      b.projectHasBackground=background;
      // A prior foreground admission may finish while the unknown-scope resolver waits.
      const cwd=b.cwd.bind(b);let resume,resolvePaths;b.cwd=async value=>{await new Promise(r=>{resume=r;});return cwd(value);};
      const prior=b.handle({action:'start',cwd:other});await waitFor(()=>!!resume);b.cwd=cwd;
      const pending=a.reserveProjectMutation(()=>new Promise(r=>{resolvePaths=r;}));resume();await prior;resolvePaths([project]);lease=await pending;lease.release();lease=null;
      // Closing a peer cancels pending acquisition but cannot release a held lease.
      let resolve;const cancelled=a.reserveProjectMutation(()=>new Promise(r=>{resolve=r;})),cancelCheck=assert.rejects(cancelled,/cancelled|lifecycle/);await b.close();resolve([project]);await cancelCheck;
      const c=make('c');lease=await a.reserveProjectMutation(async()=>[project]);await c.close();assert.equal(a.projectMutation.handle,lease);assert.equal(c.projectMutation.handle,lease);lease.release();lease=null;
      lease=await a.reserveProjectMutation(async()=>[project]);lease.release();lease=null;
      const uncertain=make('uncertain');uncertain.exitUnconfirmed=true;await uncertain.close();await assert.rejects(a.reserveProjectMutation(async()=>[project]),/lifecycle|unconfirmed/);uncertain.exitUnconfirmed=false;await uncertain.close();
      const retired=make('delayed-close'),realCwd=retired.cwd.bind(retired);let resumeClosed;
      retired.cwd=async value=>{await new Promise(r=>{resumeClosed=r;});return realCwd(value);};const late=retired.handle({action:'start',cwd:other}),lateCheck=assert.rejects(late,/closed|cancelled/);await waitFor(()=>!!resumeClosed);await retired.close();resumeClosed();await lateCheck;
      let claimed=false;await a.runScheduled({cwd:other,prompt:'checked retirement before schedule',onClaim:async()=>{claimed=true;throw new Error('Bounded fixture stops at claim');}});assert(claimed,'A closed, settled peer must retire after its final admission unwinds, without needing an unrelated Git reservation');
    }finally{lease?.release();await a.close();await b.close();}
  }
  console.log('shared coding project admission checks passed');
  if(process.argv.includes('--projects-only'))break checks;
  for(const beforeReply of [true,false]){
    const e=new CodingEngine({dataDir:join(root,'review-'+beforeReply),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try{
      await e.handle({action:'start',cwd:root});const c=children.at(-1);c.deferredReviews=[];
      const work=e.handle({action:'review',threadId:'thread-1'});await waitFor(()=>c.deferredReviews.length);const q=c.deferredReviews[0];assert(q);
      const event=(method,id,extra={})=>c.emitMessage({method,params:{threadId:'thread-1',...(['turn/started','turn/completed'].includes(method)?{turn:{id,status:method==='turn/started'?'inProgress':'completed',items:[]}}:{turnId:id}),...extra}});
      const reply=()=>c.emitMessage({id:q.id,result:{reviewThreadId:'thread-1',turn:{id:'review-root',status:'inProgress',items:[]}}});
      if(!beforeReply)reply();
      event('turn/started','review-inner');event('item/agentMessage/delta','review-inner',{itemId:'review-text',delta:'Review output'});
      if(!beforeReply){
        c.emitMessage({id:9000,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'review-inner',itemId:'review-command',command:'pwd',cwd:root}});
        assert(c.calls.some(call=>call.id===9000&&call.result?.decision==='decline'),'Worker-ID approval must remain an exact-ID decline');
      }
      if(!beforeReply)event('turn/completed','review-inner');
      if(!beforeReply){assert.equal(e.runs.get('thread-1'),'review-root','Inner completion cannot finish the review');assert.equal(e.startedTurns.get('thread-1'),'review-root');}
      event('turn/completed','review-root');if(beforeReply)reply();await work;
      assert(!e.runs.has('thread-1'),'Completed review must release the active turn');assert(!e.startedTurns.has('thread-1'));assert.equal(e.completedTurns.get('thread-1'),'review-root');
      assert(!e.liveHistory.get('thread-1').turns.some(t=>t.status==='inProgress'),'Review must not leave a phantom active history turn');
      assert(e.liveHistory.get('thread-1').turns.some(t=>t.id==='review-root'&&t.items.some(i=>i.text==='Review output')));
      const next=await e.handle({action:'send',threadId:'thread-1',text:'Continue after review'});event('turn/started',next.turn.id);
      event('turn/started','review-inner');event('turn/completed','review-root');event('item/agentMessage/delta','review-inner',{itemId:'late-review-text',delta:'stale'});
      assert.equal(e.runs.get('thread-1'),next.turn.id,'Late review events cannot replace a newer turn');assert.equal(e.lastTurns.get('thread-1'),next.turn.id);
      assert.deepEqual(e.liveHistory.get('thread-1').turns.filter(t=>t.status==='inProgress').map(t=>t.id),[next.turn.id],'Late review content cannot recreate a phantom active turn');
      event('turn/completed',next.turn.id);
    }finally{await e.close();}
  }
  for(const stopBeforeReply of [true,false]){
    const e=new CodingEngine({dataDir:join(root,'review-stop-'+stopBeforeReply),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try{
      await e.handle({action:'start',cwd:root});const c=children.at(-1);c.deferredReviews=[];
      const work=e.handle({action:'review',threadId:'thread-1'});await waitFor(()=>c.deferredReviews.length);const q=c.deferredReviews[0];assert(q);
      let stop;if(stopBeforeReply){stop=e.handle({action:'interruptFamily',threadId:'thread-1'});void stop.catch(()=>{});await tick();}
      c.emitMessage({id:q.id,result:{reviewThreadId:'thread-1',turn:{id:'review-root',status:'inProgress',items:[]}}});
      c.emitMessage({method:'turn/started',params:{threadId:'thread-1',turn:{id:'review-inner',status:'inProgress',items:[]}}});await work;
      if(!stopBeforeReply){stop=e.handle({action:'interrupt',threadId:'thread-1',turnId:'review-root'});void stop.catch(()=>{});}
      await waitFor(()=>c.calls.some(call=>call.method==='turn/interrupt'));
      const interrupts=c.calls.filter(call=>call.method==='turn/interrupt');assert(interrupts.length);assert(interrupts.every(call=>call.params.turnId==='review-root'),'Stop must target the authoritative parent review');
      c.emitMessage({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'review-root',status:'interrupted',items:[]}}});await stop;await Promise.all([...e.familyStops.values()]);
      assert(!e.runs.has('thread-1'));assert(!e.reviewScopes.has('thread-1'));assert.equal(c.killed,false,'Confirmed review Stop must not retire the whole engine');
    }finally{await e.close();}
  }
  for(const queuedStart of [false,true]){
    const e=new CodingEngine({dataDir:join(root,'review-timeout-'+queuedStart),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'}),keepAlive=setInterval(()=>{},1000);
    try{
      await e.handle({action:'start',cwd:root});const c=children.at(-1);c.deferredReviews=[];
      const rpc=e.rpc.bind(e);e.rpc=(method,params,...rest)=>rpc(method,params,...(method==='review/start'?[40]:rest));
      const work=e.handle({action:'review',threadId:'thread-1'});void work.catch(()=>{});await waitFor(()=>c.deferredReviews.length);const q=c.deferredReviews[0];assert(q);
      if(queuedStart)c.emitMessage({method:'turn/started',params:{threadId:'thread-1',turn:{id:'review-inner',status:'inProgress',items:[]}}});
      await assert.rejects(work,/timed out: review\/start/);await e.disposal;assert.equal(c.killed,true,'Lost review-start reply must retire the uncertain engine');
      assert.equal(e.child,null);assert.equal(e.reviewScopes.size,0);
      c.emitMessage({id:q.id,result:{reviewThreadId:'thread-1',turn:{id:'review-root',status:'inProgress',items:[]}}});assert.equal(e.runs.size,0);
    }finally{clearInterval(keepAlive);await e.close();}
  }
  for(const status of ['completed','failed','interrupted']){
    const e=new CodingEngine({dataDir:join(root,'review-final-'+status),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try{
      await e.handle({action:'start',cwd:root});const c=children.at(-1);c.deferredReviews=[];
      const work=e.handle({action:'review',threadId:'thread-1'});await waitFor(()=>c.deferredReviews.length);const q=c.deferredReviews[0];assert(q);
      c.emitMessage({id:q.id,result:{reviewThreadId:'thread-1',turn:{id:'review-root',status,items:[]}}});await work;
      assert(!e.reviewScopes.has('thread-1'),'Terminal review reply must retire its scope without a separate event');
      const next=await e.handle({action:'send',threadId:'thread-1',text:'Continue after final review reply'});
      c.emitMessage({method:'turn/started',params:{threadId:'thread-1',turn:{id:next.turn.id,status:'inProgress',items:[]}}});assert.equal(e.runs.get('thread-1'),next.turn.id);
      c.emitMessage({method:'turn/completed',params:{threadId:'thread-1',turn:{id:next.turn.id,status:'completed',items:[]}}});
    }finally{await e.close();}
  }
  console.log('coding-engine review identity checks passed (9 ordering, Stop, timeout and terminal-reply cases, exact approval decline, late-event protection)');
  if(process.argv.includes('--review-only'))break checks;
  {
    const cwd=join(root,'retained-scratch-project');await mkdir(cwd);
    const operations=[],e=new CodingEngine({dataDir:join(root,'retained-scratch-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',temporaryOperation:async(action,input)=>{operations.push(action);return fakeTemporaryOperation(action,input);}});
    await e.handle({action:'start',cwd});const life=e.processLife,entry=await e.handoffTemporary(cwd);
    await writeFile(join(entry.path,'work-in-progress'),'preserve me');e.fail(new Error('Fixture idle engine failure.'));await e.disposal;
    assert.equal(life.exited,true);
    assert(!operations.includes('remove'),'Engine exit is not authority to delete scratch that detached descendants can still use');
    assert.equal(await readFile(join(entry.path,'work-in-progress'),'utf8'),'preserve me');
    assert(e.events.some(event=>event.method==='coding/error'&&event.params.message.includes(entry.path)&&/descendant.*unconfirmed/i.test(event.params.message)));
    assert.match(e.message,/Fixture idle engine failure\./,'Scratch retention must not replace the original engine failure');
    assert.match(e.events.at(-1).params.message,/Fixture idle engine failure\./,'The latest UI error must retain the original cause');await e.close();
    console.log('coding-engine scratch retention after engine exit passed');
    if(process.argv.includes('--temporary-retention-only'))break checks;
  }
  {
    assert.equal(typeof engine.prepareHandoff,'function','Engine must prepare a complete immutable handoff family');
    const source=join(root,'handoff-source'),destination=join(root,'handoff-destination'),peer=join(root,'handoff-peer');
    for(const path of [source,destination,peer])await mkdir(path);
    let fixture=0;const handoffModel='fixture/saved-alternate-65k';
    const make=async()=>{
      const e=new CodingEngine({dataDir:join(root,`handoff-home-${fixture++}`),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',nativeHelper:process.env.HANDOFF_FILES_HELPER});await e.ensure();const child=children.at(-1);
      for(const dir of ['sessions','archived_sessions'])mkdirSync(join(e.dataDir,dir));
      const meta=(id,parentThreadId=null,archived=false,cwd=source)=>{
        const path=join(e.dataDir,archived?'archived_sessions':'sessions',`${id}.jsonl`),source=parentThreadId?{subagent:{thread_spawn:{parent_thread_id:parentThreadId,depth:1}}}:'vscode';
        writeFileSync(path,JSON.stringify({type:'session_meta',payload:{id,...(parentThreadId?{parent_thread_id:parentThreadId}:{}),cwd,source,model_provider:'saleh_local',multi_agent_version:'v2',base_instructions:{text:handoffInstructions,provenance:{type:'custom'}}}})+'\n',{mode:0o644});
        return {id,path,parentThreadId,canAcceptDirectInput:!parentThreadId,model:handoffModel,modelProvider:'saleh_local',cwd,status:{type:archived?'notLoaded':'idle'},archived,historyMode:parentThreadId?'paginated':'legacy',turns:[{id:`saved-${id}`,status:'completed',items:[]}]};
      };
      child.handoff=true;child.handoffSyntheticTurns=true;child.handoffPageSize=1;child.threads=new Map([meta('move-root'),meta('move-child','move-root'),meta('move-archived','move-child',true),meta('move-peer',null,false,peer)].map(t=>[t.id,t]));child.loadedIds=['move-root','move-child','move-peer'];child.handoffCatalogCwds=new Map([...child.threads].map(([id,t])=>[id,t.cwd]));
      return {e,child,meta};
    };
    assert.equal(typeof engine.prepareHandoffRecovery,'function','Recovery must review an archived or mixed family without weakening ordinary handoff');
    assert.equal(typeof engine.recoverHandoffFamily,'function','Recovery must consume its exact pending-lease review');
    const journalFor=(snapshot,intents)=>({version:1,snapshotFingerprint:snapshot.fingerprint,destination,intents});
    if(process.argv.includes('--postboot-recovery-only')){
      for(const mode of ['restore','finish','repeat','changed-admission','missing','wrong-from','wrong-to','wrong-volume','replaced','header','extra-field','checkpoint-replaced']){
        const {e,child}=await make();let lease;
        try{
          const original=await e.prepareHandoff('move-root'),members=structuredClone(original.members),current=members[0].compatibility.identity.dev;
          for(const member of members)member.compatibility.identity.dev='1';
          const snapshot=e.handoffSnapshot(members.find(t=>t.id==='move-root'),members);let file=child.threads.get('move-root').path;
          const persistent=await readFilesystemIdentity({path:file,nativeHelper:process.env.HANDOFF_FILES_HELPER});
          let filesystem={fromDevice:'1',toDevice:current,volumeUUID:persistent.volumeUUID};
          if(mode==='missing')filesystem=null;
          if(mode==='wrong-from')filesystem.fromDevice='2';
          if(mode==='wrong-to')filesystem.toDevice='2';
          if(mode==='wrong-volume')filesystem.volumeUUID='AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
          if(mode==='extra-field')filesystem.unreviewed=true;
          if(mode==='restore'){
            lease=await e.reserveProjectMutation(async()=>[source,destination]);const before=child.calls.length;
            await assert.rejects(e.relocateFamily(snapshot,destination,{checkpoint:async()=>{},transfer:async()=>{}}),/changed|review/i);
            assert(!child.calls.slice(before).some(q=>['thread/archive','thread/unarchive','thread/resume'].includes(q.method)));lease.release();
          }
          await e.rpc('thread/archive',{threadId:'move-root'});
          file=child.threads.get('move-root').path;
          if(mode==='replaced'){await rename(file,file+'.old');await writeFile(file,await readFile(file+'.old'));}
          if(mode==='header'){const header=JSON.parse(await readFile(file));header.timestamp='unreviewed';await writeFile(file,JSON.stringify(header)+'\n');}
          const journal=journalFor(snapshot,[{phase:'family-archive-intent',destination}]),before=child.calls.length;let review;
          const prepare=()=>e.reserveProjectMutation(async()=>{review=await e.prepareHandoffRecovery(snapshot,destination,journal,filesystem);return [source,destination];});
          if(!['restore','finish','repeat','changed-admission','checkpoint-replaced'].includes(mode)){
            await assert.rejects(prepare(),/Recovery|recovery|header|identity|filesystem|admission/i,mode);
            assert(!child.calls.slice(before).some(q=>['thread/archive','thread/unarchive','thread/resume'].includes(q.method)));continue;
          }
          lease=await prepare();assert.deepEqual(review.snapshot,snapshot);assert.deepEqual(review.observed.members.map(t=>t.compatibility),snapshot.members.map(t=>t.compatibility));
          await assert.rejects(e.handoffCompatibility(child.threads.get('move-root'),{...e.handoffFor('move-root')}),/authority/);
          if(['repeat','changed-admission'].includes(mode)){
            const retained=e.handoffFor('move-root');lease.release();assert.equal(e.handoffFor('move-root'),retained);
            await assert.rejects(e.handoffCompatibility(child.threads.get('move-root'),retained),/authority/);
            if(mode==='changed-admission'){filesystem.volumeUUID='AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';await assert.rejects(prepare(),/Prior recovery filesystem admission changed/);assert.equal(e.handoffFor('move-root'),retained);continue;}
            lease=await prepare();assert.notEqual(e.handoffFor('move-root'),retained);
          }
          const after=e.recoverHandoffFamily(review,mode==='finish'?destination:source,{checkpoint:async phase=>{if(mode==='checkpoint-replaced'&&phase==='family-archive-intent'){await rename(file,file+'.old');await writeFile(file,await readFile(file+'.old'));}},transfer:async()=>{}});
          if(mode==='checkpoint-replaced'){await assert.rejects(after,/header|identity|compatibility/i);assert(!child.calls.slice(before).some(q=>['thread/archive','thread/unarchive','thread/resume'].includes(q.method)));}
          else{const result=await after;assert.deepEqual(result.members,snapshot.members.map(t=>({...t,cwd:mode==='finish'?destination:source})));assert.equal(e.handoffFor('move-root'),undefined);assert(!child.calls.slice(before).some(q=>q.method==='turn/start'));}
        }finally{lease?.release();await e.close();}
      }
      console.log('PASS: native filesystem proof admits only the exact retained header across mount epochs; original family fingerprints, final Restore/Finish, and no-turn behavior stay exact');break checks;
    }
    // Let the real RPC timer expire while the subprocess can still change metadata.
    const timeoutCases=[...['relocate','recover'].flatMap(route=>[
      ['thread/archive','move-root'],['thread/unarchive','move-root'],['thread/resume','move-root'],['thread/archive','move-archived']
    ].map(([method,threadId])=>({route,method,threadId}))),{route:'recover',method:'thread/resume',threadId:'move-child',unknownExit:true}];
    const timerKeepAlive=setInterval(()=>{},1000);
    try{
      for(const {route,method,threadId,unknownExit=false} of timeoutCases){
        const {e,child}=await make();let lease,releaseStop;
        try{
          const snapshot=await e.prepareHandoff('move-root');let review,fence,transfers=0,completions=0;
          lease=await e.reserveProjectMutation(async()=>{if(route==='recover')review=await e.prepareHandoffRecovery(snapshot,destination,journalFor(snapshot,[]));return [source,destination];});
          const life=e.processLife,epoch=e.epoch,env=await e.temporaryEnvironment(source,epoch),signals=[];
          if(unknownExit)child.kill=signal=>{signals.push(signal);child.killed=true;return true;};
          child.handoffDelay={method,threadId,effects:0};
          const rpc=e.rpc.bind(e);e.rpc=(name,params,timeout)=>rpc(name,params,name===method&&params.threadId===threadId?100:timeout);
          const options={bind:async authority=>{fence=authority;},checkpoint:async()=>{},transfer:async()=>{transfers++;},complete:async()=>{completions++;}};
          const work=route==='relocate'?e.relocateFamily(snapshot,destination,options):e.recoverHandoffFamily(review,destination,options);void work.catch(()=>{});
          await waitFor(()=>child.handoffDelay.request);assert(child.handoffDelay.request,`${route} ${method} ${threadId} must reach the real RPC`);
          // Selected Stop can finish before the outstanding metadata request does.
          if(unknownExit){
            // A completed cancellation may still have its fulfillment queued.
            const interrupt=e.interruptFamily.bind(e),gate=new Promise(resolve=>releaseStop=resolve);
            e.interruptFamily=async target=>{const value=await interrupt(target);await gate;return value;};
            const stopping=e.stopHandoff(fence,{snapshot,lease});void stopping.catch(()=>{});
            await waitFor(()=>e.child===null);assert.equal(fence.exitUnconfirmed,true);releaseStop();
            await assert.rejects(stopping,{code:'HANDOFF_EXIT_UNCONFIRMED'},'Late cancellation success cannot clear metadata uncertainty');
          }else{assert.equal((await e.stopHandoff(fence,{snapshot,lease})).state,'stopped');assert.equal(child.killed,false);}
          const rejected=await work.then(()=>null,error=>error);await e.disposal;
          if(!unknownExit){await new Promise(resolve=>setTimeout(resolve,260));assert.equal(child.handoffDelay.effects,0,'Timed-out handoff must prevent metadata mutation after selected Stop and task rejection');}
          assert.equal(rejected?.code,'HANDOFF_EXIT_UNCONFIRMED');assert.equal(rejected.handoffStarted,true);assert.match(rejected.message,/timed out/);
          assert.equal(e.epoch,epoch+1);assert.equal(e.processLife,null);assert.equal(e.child,null);assert.equal(fence.exitUnconfirmed,true);
          assert.equal(e.handoffFor(threadId),fence);assert.equal(e.projectMutation.handle,lease);assert.equal(completions,0);
          assert.equal(transfers,method==='thread/archive'&&threadId==='move-root'?0:1);
          assert.throws(()=>e.checkHandoffAuthority(destination,fence,{snapshot,lease}),/Stop|process|lifecycle|cancel/i);
          await e.disposal;
          if(unknownExit){
            assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(life.exited,false);assert.equal(e.exitUnconfirmed,true);
            assert.equal(child.handoffDelay.effects,1,'An unconfirmed process may still apply the timed-out metadata mutation');
            await stat(env.TMPDIR);assert.equal(e.projectMutation.handle,lease);await assert.rejects(e.ensure(),/exit.*unconfirmed/i);
          }else{
            assert.equal(life.exited,true);await stat(env.TMPDIR);
            assert.equal(child.handoffDelay.effects,0,'Confirmed process exit prevents delayed metadata mutation');
          }
          const before=e.sequence,q=child.handoffDelay.request;
          child.emitMessage({id:q.id,result:{thread:{...child.threads.get(threadId),cwd:destination}}});
          child.emitMessage({method:'thread/started',params:{thread:{...child.threads.get(threadId),cwd:destination}}});
          await tick();assert.equal(e.sequence,before);assert.equal(e.handoffFor(threadId),fence);assert.equal(fence.exitUnconfirmed,true);assert.equal(e.loaded.size,0);assert.equal(e.threadInfo.size,0);
          await assert.rejects(e.stopHandoff(fence,{snapshot,lease}),/Stop|process|lifecycle|cancel/i);
          console.log(`handoff-timeout ${route} ${method} ${threadId} ${unknownExit?'unconfirmed exit retained':'confirmed exit'} passed`);
        }finally{releaseStop?.();clearTimeout(child.handoffDelay?.timer);if(!child.exited)child.emit('exit',0,null);lease?.release();await e.close();}
      }
      {
        const {e,child}=await make();let lease,release;
        try{
          const snapshot=await e.prepareHandoff('move-root');lease=await e.reserveProjectMutation(async()=>[source,destination]);
          let fence,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),epoch=e.epoch,life=e.processLife;
          const work=e.relocateFamily(snapshot,destination,{bind:async authority=>{fence=authority;entered();await gate;},checkpoint:async()=>{},transfer:async()=>{}});void work.catch(()=>{});await ready;
          child.deferredReads=new Map([['move-root',[]],['move-peer',[]]]);e.runs.set('move-peer','peer-running');
          for(const id of child.deferredReads.keys())await assert.rejects(e.rpc('thread/read',{threadId:id,includeTurns:false},20),/timed out/);
          assert.equal(child.killed,false);assert.equal(e.epoch,epoch);assert.equal(e.processLife,life);assert.notEqual(fence.exitUnconfirmed,true);assert.equal(e.runs.get('move-peer'),'peer-running');
          child.deferredReads=null;release();await work;assert.equal(e.handoffFor('move-root'),undefined);assert.equal(child.killed,false);
          console.log('handoff-timeout read-only selected and unrelated timeouts preserve execution passed');
        }finally{release?.();lease?.release();await e.close();}
      }
    }finally{clearInterval(timerKeepAlive);}
    if(process.argv.includes('--handoff-timeout-only')){console.log('coding-engine handoff timeout checks passed');break checks;}
    // The manager's terminal callback must commit while the selected family is still fenced.
    for(const route of ['relocate','recover'])for(const mode of ['success','callback-failure','stop','committed-stop','lease-released','checkpoint-stop','invalid-null','invalid-object']){
      const {e,child}=await make();let lease,release;
      try{
        const snapshot=await e.prepareHandoff('move-root');let review;
        lease=await e.reserveProjectMutation(async()=>{if(route==='recover')review=await e.prepareHandoffRecovery(snapshot,destination,journalFor(snapshot,[]));return [source,destination];});
        let fence,entered,committed=false,completions=0,transfers=0;const phases=[],ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
        const check=()=>e.checkHandoffAuthority(destination,fence,{snapshot,lease});
        const complete=async after=>{
          completions++;assert.equal(phases.at(-1),'family-verified');check();
          assert.equal(after.cwd,destination);assert.deepEqual(after.members,snapshot.members.map(t=>({...t,cwd:destination})));
          assert(Object.isFrozen(after)&&Object.isFrozen(after.members)&&after.members.every(Object.isFrozen));
          assert.throws(()=>e.checkHandoffAuthority(destination,{...fence},{snapshot,lease}),/retained engine fence/i);
          assert.throws(()=>e.checkHandoffAuthority(destination,fence,{snapshot,lease:{...lease}}),/binding/i);
          entered();await gate;
          // The completion callback owns the last cancellation check before its durable commit.
          check();if(mode==='callback-failure')throw new Error('fixture completion failed');
          committed=true;
          // A Stop after the commit cannot turn committed success into a rejected handoff.
          if(mode==='committed-stop')await e.stopHandoff(fence,{snapshot,lease});
        };
        const before=child.calls.length,options={bind:async authority=>{fence=authority;check();},checkpoint:async phase=>{phases.push(phase);if(mode==='checkpoint-stop'&&phase==='family-verified')await e.stopHandoff(fence,{snapshot,lease});},transfer:async()=>{transfers++;},complete:mode==='invalid-null'?null:mode==='invalid-object'?{}:complete};
        const work=route==='relocate'?e.relocateFamily(snapshot,destination,options):e.recoverHandoffFamily(review,destination,options);void work.catch(()=>{});
        if(mode.startsWith('invalid-')){
          await assert.rejects(work,/callbacks/i);assert.equal(fence,undefined);assert.equal(transfers,0);assert.equal(completions,0);
          assert(!child.calls.slice(before).some(q=>['thread/archive','thread/unarchive','thread/resume'].includes(q.method)));
          if(route==='recover')assert.equal(e.handoffFor('move-root').recovery.consumed,false,'Invalid completion cannot consume recovery review');
          continue;
        }
        if(mode==='checkpoint-stop'){
          await assert.rejects(work,/Stop|cancel|changed/i);assert.equal(completions,0);assert.equal(committed,false);assert.equal(e.handoffFor('move-root'),fence);continue;
        }
        assert.equal(await Promise.race([ready.then(()=>true),work.then(()=>false)]),true,'Verified family must enter the completion callback before releasing its fence');
        assert.equal(e.handoffFor('move-root'),fence);assert.equal(fence.running,true);assert.equal(transfers,1);assert.equal(committed,false);
        for(const input of [{action:'archive',threadId:'move-child'},{action:'unarchive',threadId:'move-archived'},{action:'read',threadId:'move-root'},{action:'send',threadId:'move-root',text:'must remain fenced'}]){
          const count=child.calls.length;await assert.rejects(e.handle(input),/handoff/i);assert.equal(child.calls.length,count,'Blocked admission must not reach the engine RPC');
        }
        await assert.rejects(e.thread('move-child'),/handoff/i);assert.equal((await e.handle({action:'read',threadId:'move-peer'})).thread.cwd,peer);
        if(mode==='stop')assert.equal((await e.stopHandoff(fence,{snapshot,lease})).state,'stopped');
        if(mode==='lease-released')lease.release();
        release();
        if(['callback-failure','stop','lease-released'].includes(mode)){
          await assert.rejects(work,error=>error.handoffStarted===true&&/completion|Stop|cancel|changed|lease/i.test(error.message));
          assert.equal(committed,false);assert.equal(e.handoffFor('move-root'),fence);assert.equal(fence.running,false);lease.release();
          await assert.rejects(e.handle({action:'read',threadId:'move-root'}),/handoff/i,'Failed completion retains its fence after lease release');
        }else{
          const after=await work;assert.equal(after.cwd,destination);assert.equal(committed,true);assert.equal(completions,1);assert.equal(e.handoffFor('move-root'),undefined);
          assert.throws(check,/retained engine fence/i,'Completed callback authority cannot be reused');
        }
        assert.equal(child.killed,false,'Completion preserves the shared peer process');
      }finally{release?.();lease?.release();await e.close();}
    }
    console.log('family completion callback checks passed (16 cases)');
    for(const state of ['all-archived','partial-archive','mixed'])for(const target of [source,destination]){
      const {e,child}=await make();let lease;try{
        const snapshot=await e.prepareHandoff('move-root'),intents=[];lease=await e.reserveProjectMutation(async()=>[source,destination]);
        await assert.rejects(e.relocateFamily(snapshot,destination,{checkpoint:async(phase,data)=>{if(['family-archive-intent','family-resume-intent','family-rearchive-intent'].includes(phase))intents.push({phase,...(data.threadId?{threadId:data.threadId}:{}),destination});if(state!=='mixed'&&phase==='family-transfer-intent'||state==='mixed'&&phase==='family-resume-intent'&&data.threadId==='move-child')throw new Error('fixture interrupted');},transfer:async()=>{}}),/fixture interrupted/);
        if(state==='partial-archive'){intents.push({phase:'family-resume-intent',threadId:'move-child',destination:source});await e.rpc('thread/unarchive',{threadId:'move-child'});}
        const previous=e.handoffFor('move-root');await e.stopHandoff(previous,{snapshot,lease});lease.release();e.runs.set('move-peer','unrelated-running');
        let review;lease=await e.reserveProjectMutation(async()=>{review=await e.prepareHandoffRecovery(snapshot,destination,journalFor(snapshot,intents));const paths=await e.projectMutationInventory();assert(paths.includes(peer));return [source,destination];});
        assert(Object.isFrozen(review)&&Object.isFrozen(review.observed.members));assert.equal(review.observed.members.find(t=>t.id==='move-root').archived,state!=='mixed');assert.equal(review.observed.cwd,state==='mixed'?destination:source);
        const fence=e.handoffFor('move-root');assert.notEqual(fence,previous);assert.throws(()=>e.checkHandoffAuthority(destination,fence,{snapshot,lease}),/no execution authority/);
        e.assertProject=async(cwd,authority)=>{if(cwd===peer)return;assert.equal(cwd,target);assert.equal(authority,fence);e.checkHandoffAuthority(cwd,authority,{snapshot,lease});};const phases=[],from=child.calls.length;let transferred=0;
        const after=await e.recoverHandoffFamily(structuredClone(review),target,{bind:async authority=>{assert.equal(authority,fence);e.checkHandoffAuthority(target,authority,{snapshot,lease});},checkpoint:async phase=>{phases.push(phase);},transfer:async()=>{transferred++;assert.deepEqual(child.calls.slice(from).filter(q=>q.method==='thread/archive').map(q=>q.params.threadId),state==='all-archived'?[]:[state==='partial-archive'?'move-child':'move-root']);assert(snapshot.members.every(t=>!child.loadedIds.includes(t.id)));assert.equal(e.runs.get('move-peer'),'unrelated-running');await assert.rejects(e.handle({action:'read',threadId:'move-root'}),/handoff/);}});
        assert.equal(transferred,1);assert.equal(after.cwd,target);assert.deepEqual(after.members,snapshot.members.map(t=>({...t,cwd:target})));assert.equal(phases.at(-1),'family-verified');assert.deepEqual(child.calls.slice(from).filter(q=>q.method==='thread/resume').map(q=>q.params.threadId),['move-root','move-child','move-archived']);assert.equal(e.runs.get('move-peer'),'unrelated-running');assert.equal(child.killed,false);assert.equal(e.handoffFor('move-root'),undefined);
      }finally{lease?.release();e.runs.clear();await e.close();}
    }
    {
      const {e,child}=await make();let lease;try{
        const snapshot=await e.prepareHandoff('move-root'),journal=journalFor(snapshot,[]),record=(phase,data)=>{if(['family-archive-intent','family-resume-intent','family-rearchive-intent'].includes(phase))journal.intents.push({phase,...(data.threadId?{threadId:data.threadId}:{}),destination:data.destination});};
        lease=await e.reserveProjectMutation(async()=>[source,destination]);await assert.rejects(e.relocateFamily(snapshot,destination,{checkpoint:async(phase,data)=>{record(phase,data);if(phase==='family-resume-intent'&&data.threadId==='move-child')throw new Error('outward interrupted');},transfer:async()=>{}}),/outward interrupted/);
        let prior=e.handoffFor('move-root');await e.stopHandoff(prior,{snapshot,lease});lease.release();
        for(const field of ['running','exitUnconfirmed','life']){const before=prior[field];prior[field]=field==='life'?{}:true;const callsBefore=child.calls.length;await assert.rejects(e.reserveProjectMutation(async()=>{await e.prepareHandoffRecovery(snapshot,destination,journal);return [source,destination];}),/ownership|lifecycle|quiescence/i);assert.equal(e.handoffFor('move-root'),prior);assert(!child.calls.slice(callsBefore).some(q=>q.method==='thread/archive'));prior[field]=before;}
        let review;const acquire=()=>e.reserveProjectMutation(async()=>{review=await e.prepareHandoffRecovery(snapshot,destination,journal);return [source,destination];});
        lease=await acquire();const abandoned=e.handoffFor('move-root');lease.release();assert.equal(e.handoffFor('move-root'),prior);assert.equal(abandoned.recovery.review,null);
        lease=await acquire();await assert.rejects(e.recoverHandoffFamily(review,source,{checkpoint:async(phase,data)=>{record(phase,data);if(phase==='family-resume-intent'&&data.threadId==='move-child')throw new Error('restore interrupted');},transfer:async()=>{}}),/restore interrupted/);
        prior=e.handoffFor('move-root');assert.equal(prior.destination,source);assert.equal(prior.originalDestination,destination);await e.stopHandoff(prior,{snapshot,lease});lease.release();
        lease=await acquire();const after=await e.recoverHandoffFamily(review,destination,{checkpoint:async(phase,data)=>record(phase,data),transfer:async()=>{}});assert.deepEqual(after.members,snapshot.members.map(t=>({...t,cwd:destination})));assert(journal.intents.some(i=>i.phase==='family-resume-intent'&&i.destination===source));assert.equal(child.killed,false);
      }finally{lease?.release();await e.close();}
    }
    for(const failure of ['unexplained-cwd','unexplained-unarchive','history','header-replaced','missing-member','new-member','wrong-parent','foreign-cwd','active','endless']){
      const {e,child,meta}=await make();let lease;try{
        const snapshot=await e.prepareHandoff('move-root');await e.rpc('thread/archive',{threadId:'move-root'});const t=child.threads.get('move-root');await e.rpc('thread/unarchive',{threadId:t.id});t.cwd=destination;
        const intents=[{phase:'family-archive-intent',destination},{phase:'family-resume-intent',threadId:t.id,destination}];
        if(failure==='unexplained-cwd')intents.pop();if(failure==='unexplained-unarchive'){child.threads.get('move-archived').archived=false;}
        if(failure==='history')t.turns.push({id:'new-unreviewed-turn',status:'completed',items:[]});if(failure==='header-replaced'){const bytes=await readFile(t.path);await rename(t.path,t.path+'.old');await writeFile(t.path,bytes);}
        if(failure==='missing-member')child.threads.delete('move-archived');if(failure==='new-member'){const extra=meta('recovery-extra','move-root',true);child.threads.set(extra.id,extra);}if(failure==='wrong-parent')child.threads.get('move-child').parentThreadId='move-peer';if(failure==='foreign-cwd')t.cwd=peer;if(failure==='active')t.status={type:'active'};if(failure==='endless')child.handoffEndless=true;
        const before=child.calls.length;await assert.rejects(e.reserveProjectMutation(async()=>{await e.prepareHandoffRecovery(snapshot,destination,journalFor(snapshot,intents));return [source,destination];}),/Recovery|recovery|Stop|Handoff|handoff|ownership/i,failure);assert(!child.calls.slice(before).some(q=>['thread/archive','thread/unarchive','thread/resume'].includes(q.method)));assert.equal(e.projectMutation,null);assert(e.handoffFor('move-root'),'Unverified interrupted state keeps a non-executable recovery guard');
      }finally{child.handoffEndless=false;lease?.release();e.runs.clear();await e.close();}
    }
    for(const mode of ['original-review-release','mixed-review-release','resolver-failure','stale-review','checkpoint-stale','header-checkpoint-missing','transfer-failure','stop','unconfirmed-stop','epoch-change','forged-review','wrong-target']){
      const {e,child}=await make();let lease,release;try{
        const snapshot=await e.prepareHandoff('move-root'),intents=[];
        if(mode!=='original-review-release'){await e.rpc('thread/archive',{threadId:'move-root'});intents.push({phase:'family-archive-intent',destination});await e.rpc('thread/unarchive',{threadId:'move-root'});child.threads.get('move-root').cwd=destination;intents.push({phase:'family-resume-intent',threadId:'move-root',destination});}
        const journal=journalFor(snapshot,intents);let review;
        const acquire=()=>e.reserveProjectMutation(async()=>{review=await e.prepareHandoffRecovery(snapshot,destination,journal);if(mode==='resolver-failure')throw new Error('fixture resolver refused');return [source,destination];});
        if(mode==='resolver-failure'){await assert.rejects(acquire(),/fixture resolver/);assert(e.handoffFor('move-root'));assert.equal(e.handoffFor('move-root').recovery.review,null);continue;}
        lease=await acquire();const fence=e.handoffFor('move-root');e.runs.set('move-peer','peer-running');
        if(mode.endsWith('review-release')){e.discoveryQueue.add('move-child');lease.release();assert.equal(e.handoffFor('move-root')===undefined,mode==='original-review-release');await assert.rejects(e.recoverHandoffFamily(review,source,{checkpoint:async()=>{},transfer:async()=>{}}),/review|lease/i);e.drainDiscovery();await tick();assert.equal(child.killed,false);if(mode==='mixed-review-release'){assert.equal(fence.recovery.review,null);assert(e.discoveryQueue.has('move-child'));}continue;}
        const before=child.calls.length;let transfers=0,started,allow;const held=new Promise(r=>started=r),wait=new Promise(r=>allow=r);release=allow;
        if(mode==='stale-review')child.threads.get('move-root').cwd=peer;
        const work=e.recoverHandoffFamily(mode==='forged-review'?{...review,fingerprint:'forged'}:review,mode==='wrong-target'?peer:source,{checkpoint:async phase=>{
          if(phase==='family-archive-intent'&&mode==='checkpoint-stale')child.threads.get('move-child').turns.push({id:'unreviewed',status:'completed',items:[]});
          if(phase==='family-archive-intent'&&mode==='header-checkpoint-missing')await rm(child.threads.get('move-child').path);
          if(phase==='family-archive-intent'&&mode==='epoch-change')e.epoch++;
          if(phase==='family-transfer-intent'&&['stop','unconfirmed-stop'].includes(mode)){started();await wait;}
        },transfer:async()=>{transfers++;if(mode==='transfer-failure')throw new Error('fixture transfer failed');}});
        let observed;const rejected=assert.rejects(work,error=>{observed=error;return /Recovery|recovery|history|header|ENOENT|fixture|Stop|cancel|confirm|authority/i.test(error.message);},mode);
        if(['stop','unconfirmed-stop'].includes(mode)){
          await held;
          if(mode==='unconfirmed-stop'){const t=child.threads.get('move-root');t.status={type:'active'};t.turns.push({id:'unknown-running',status:'inProgress',items:[]});e.runs.set(t.id,'unknown-running');child.interruptError='fixture interrupt unconfirmed';await assert.rejects(e.stopHandoff(fence,{snapshot,lease}),{code:'HANDOFF_EXIT_UNCONFIRMED'});}
          else assert.equal((await e.stopHandoff(fence,{snapshot,lease})).state,'stopped');allow();
        }
        await rejected;assert.equal(transfers,mode==='transfer-failure'?1:0);assert.equal(e.runs.get('move-peer'),'peer-running');assert.equal(child.killed,false);
        if(['stale-review','checkpoint-stale','header-checkpoint-missing','epoch-change','forged-review','wrong-target'].includes(mode))assert(!child.calls.slice(before).some(q=>q.method==='thread/archive'));
        if(mode==='unconfirmed-stop'){assert.equal(observed.code,'HANDOFF_EXIT_UNCONFIRMED');assert.equal(fence.exitUnconfirmed,true);}else if(!['forged-review','wrong-target'].includes(mode))assert.equal(observed.handoffStarted,['transfer-failure','stop'].includes(mode));
        lease.release();if(!['forged-review','wrong-target'].includes(mode))assert(e.handoffFor('move-root'),'Consumed interrupted recovery retains its guard');
      }finally{release?.();lease?.release();child.interruptError=null;e.runs.clear();for(const t of child.threads.values())if(t.status?.type==='active')t.status={type:'idle'};await e.close();}
    }
    {
      const {e,child,meta}=await make();let lease;try{
        const snapshot=await e.prepareHandoff('move-root');await e.rpc('thread/archive',{threadId:'move-root'});await e.rpc('thread/unarchive',{threadId:'move-root'});child.threads.get('move-root').cwd=destination;
        const journal=journalFor(snapshot,[{phase:'family-archive-intent',destination},{phase:'family-resume-intent',threadId:'move-root',destination}]);let review;lease=await e.reserveProjectMutation(async()=>{review=await e.prepareHandoffRecovery(snapshot,destination,journal);return [source,destination];});e.runs.set('move-peer','peer-running');
        const late=meta('recovery-late-child','move-root',false,destination);late.status={type:'active'};late.turns.push({id:'recovery-late-turn',status:'inProgress',items:[]});let settled=false;
        const work=e.recoverHandoffFamily(review,source,{checkpoint:async()=>{},transfer:async()=>{child.threads.set(late.id,late);child.loadedIds.push(late.id);child.background=new Map([[late.id,new Set(['late-command'])]]);child.deferredReads=new Map([[late.id,[]]]);child.emitMessage({method:'turn/started',params:{threadId:late.id,turn:{id:'recovery-late-turn'}}});await tick();const reads=child.deferredReads.get(late.id);child.deferredReads=null;for(const q of reads)child.emitMessage({id:q.id,result:{thread:late}});await tick();}});work.then(()=>settled=true,()=>settled=true);
        await waitFor(()=>child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId===late.id));await tick();assert.equal(settled,false,'Restoring to source must still verify a late child running at the original destination');
        late.status={type:'idle'};late.turns.at(-1).status='interrupted';child.emitMessage({method:'turn/completed',params:{threadId:late.id,turn:{id:'recovery-late-turn',status:'interrupted'}}});
        await assert.rejects(work,error=>error.code!=='HANDOFF_EXIT_UNCONFIRMED'&&/changed|cancel/i.test(error.message));assert.equal(child.background.get(late.id).size,0);assert.equal(e.runs.has(late.id),false);assert.equal(e.runs.get('move-peer'),'peer-running');assert.equal(child.killed,false);
      }finally{lease?.release();e.runs.clear();child.deferredReads=null;await e.close();}
    }
    {
      const {e,child}=await make();let cold,lease;try{
        const target=join(e.dataDir,'Worktrees','retained');await mkdir(target,{recursive:true});
        const snapshot=await e.prepareHandoff('move-root');await e.rpc('thread/archive',{threadId:'move-root'});await e.rpc('thread/unarchive',{threadId:'move-root'});child.threads.get('move-root').cwd=target;await e.close();
        const journal={version:1,snapshotFingerprint:snapshot.fingerprint,destination:target,intents:[{phase:'family-archive-intent',destination:target},{phase:'family-resume-intent',threadId:'move-root',destination:target}]},admissions=[];
        cold=new CodingEngine({dataDir:e.dataDir,binary:'/fake/codex',localBaseURL:'http://127.0.0.1:1234/v1',spawnProcess:(...args)=>{const next=spawnFake(...args);Object.assign(next,{handoff:true,handoffSyntheticTurns:true,handoffPageSize:1,threads:new Map([...child.threads].map(([id,t])=>[id,structuredClone(t)])),loadedIds:[]});return next;},assertProject:async(cwd,authority)=>{admissions.push(cwd);if(cwd===peer)return;if(authority){cold.checkHandoffAuthority(cwd,authority,{snapshot,lease});return;}throw Object.assign(new Error('retained handoff project fence'),{code:'HANDOFF_PENDING'});}});
        let review;lease=await cold.reserveProjectMutation(async()=>{review=await cold.prepareHandoffRecovery(snapshot,target,journal);assert.equal(review.observed.cwd,target);assert(Array.isArray(await cold.projectMutationInventory()));return [source,target];});
        assert(!admissions.includes(e.dataDir),'Fixed startup config inspection is independent of public project execution admission');
        await assert.rejects(cold.checkConfig(target),/retained handoff/);await assert.rejects(cold.prepare(source),/retained handoff/);assert(admissions.includes(target)&&admissions.includes(source));
        const after=await cold.recoverHandoffFamily(review,target,{checkpoint:async()=>{},transfer:async()=>{}});assert.equal(after.cwd,target);assert.deepEqual(after.members,snapshot.members.map(t=>({...t,cwd:target})));
      }finally{lease?.release();await cold?.close();await e.close();}
    }
    for(const failure of ['legacy-root','legacy-child','missing','malformed','oversized','wrong-id','wrong-parent','wrong-provider','symlink','outside','replaced','checkpoint-missing']){
      const {e,child}=await make();let lease,transfers=0;
      try{
        const t=child.threads.get(failure==='legacy-root'?'move-root':'move-child'),path=t.path,original=await readFile(path,'utf8'),header=JSON.parse(original);
        const snapshot=await e.prepareHandoff('move-root');
        if(failure.startsWith('legacy'))header.payload.base_instructions.text='Original scratch /old/project/.saleh-coding-tmp-legacy';
        if(failure==='wrong-id')header.payload.id='different-thread';
        if(failure==='wrong-parent')header.payload.parent_thread_id='different-root';
        if(failure==='wrong-provider')header.payload.model_provider='saleh_cloud';
        if(failure==='missing')await rm(path);
        else if(failure==='malformed')await writeFile(path,'{bad}\n');
        else if(failure==='oversized')await writeFile(path,' '.repeat(65536)+original);
        else if(failure==='symlink'){await rename(path,path+'.original');await symlink(path+'.original',path);}
        else if(failure==='outside'){t.path=join(root,'outside-handoff.jsonl');await writeFile(t.path,original);}
        else if(failure==='replaced'){await rename(path,path+'.original');await writeFile(path,original);}
        else if(failure!=='checkpoint-missing')await writeFile(path,JSON.stringify(header)+'\n');
        if(!['replaced','checkpoint-missing'].includes(failure))await assert.rejects(e.prepareHandoff('move-root'),/handoff.*compatib|session header|ENOENT|symbolic/i,`${failure} must fail preparation`);
        lease=await e.reserveProjectMutation(async()=>[source,destination]);
        await assert.rejects(e.relocateFamily(snapshot,destination,{checkpoint:async phase=>{if(failure==='checkpoint-missing'&&phase==='family-archive-intent')await rm(path);},transfer:async()=>{transfers++;}}),/compatib|session header|stale|ENOENT|symbolic/i);
        assert.equal(transfers,0);assert(!child.calls.some(q=>q.method==='thread/archive'),`${failure} must reject before archival`);assert.equal(e.handoffFor('move-root'),undefined);
      }finally{lease?.release();await e.close();}
    }
    const {e,child}=await make();let lease;
    try{
      await e.resolveFamily('move-child');child.threads.get('move-root').cwd=destination;await e.thread('move-root');
      await assert.rejects(e.resolveFamily('move-child'),/differs from its parent/,'Unfenced relocation reproduces the parent/child mismatch');
      child.threads.get('move-root').cwd=source;await e.thread('move-root');
      await assert.rejects(e.prepareHandoff('move-child'),/root chat/i);
      const snapshot=await e.prepareHandoff('move-root');
      assert.equal(snapshot.members.find(t=>t.id==='move-root').lastTurnId,'saved-move-root','Legacy last-turn identity comes from persisted conversation history, not synthetic activity turns');
      assert.equal(snapshot.members.length,3);assert(snapshot.members.find(t=>t.id==='move-archived').archived);assert(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.members)&&Object.isFrozen(snapshot.members[0]));assert.deepEqual(JSON.parse(JSON.stringify(snapshot)),snapshot);
      for(const member of snapshot.members){assert.equal(member.compatibility.version,1);assert.match(member.compatibility.headerHash,/^[a-f0-9]{64}$/);assert(Object.isFrozen(member.compatibility)&&Object.isFrozen(member.compatibility.identity));}
      e.runs.set('move-child','new-turn');await assert.rejects(e.prepareHandoff('move-root'),/Stop.*first/i);e.runs.delete('move-child');
      child.background=new Map([['move-child',new Set(['background-child'])]]);await assert.rejects(e.prepareHandoff('move-root'),/Stop.*first/i);child.background.clear();
      child.handoffRepeatedCursor=true;await assert.rejects(e.prepareHandoff('move-root'),/cursor/i);child.handoffRepeatedCursor=false;
      child.handoffEndless=true;await assert.rejects(e.prepareHandoff('move-root'),/verification limit/i);child.handoffEndless=false;
      await assert.rejects(e.relocateFamily(snapshot,destination,{checkpoint:async()=>{},transfer:async()=>{}}),/lease/i);
      lease=await e.reserveProjectMutation(async()=>[source,destination]);
      let bound;
      e.assertProject=async(cwd,authority)=>{if(cwd===peer){assert.equal(authority,null);return;}const fence=e.handoffFor('move-root');assert.equal(authority,bound,'Manager binds authority before destination preparation');assert.equal(authority,fence,'Only the retained internal capability authorizes destination preparation');e.checkHandoffAuthority(cwd,authority,{snapshot,lease});};
      child.deferredReads=new Map([['move-child',[]]]);const oldRead=e.thread('move-child'),oldHistory=e.handle({action:'read',threadId:'move-child'});await tick();
      e.discover('move-child');e.discoveryQueue.add('move-archived');
      const phases=[];
      const moved=e.relocateFamily(snapshot,destination,{bind:async fence=>{
        bound=fence;e.checkHandoffAuthority(destination,fence,{snapshot:structuredClone(snapshot),lease});
        assert.throws(()=>e.checkHandoffAuthority(destination,{...fence},{snapshot,lease}),/handoff/i);
        assert.throws(()=>e.checkHandoffAuthority(source,fence,{snapshot,lease}),/handoff/i);
        assert.throws(()=>e.checkHandoffAuthority(destination,fence,{snapshot:{...snapshot,cwd:peer},lease}),/snapshot|binding/i);
        assert.throws(()=>e.checkHandoffAuthority(destination,fence,{snapshot,lease:{...lease}}),/lease|binding/i);
      },checkpoint:async(phase,data)=>{phases.push(phase);assert(data);if(phase==='family-archive-intent'){assert(!child.calls.some(q=>q.method==='thread/archive'));await assert.rejects(e.handle({action:'archive',threadId:'move-root'}),/handoff/i);}},transfer:async()=>{
        assert(!child.loadedIds.some(id=>snapshot.members.some(m=>m.id===id)),'Entire family is unloaded before transfer');
        assert.equal((await e.handle({action:'read',threadId:'move-peer'})).thread.cwd,peer);
        const terminal=await e.handle({action:'terminalStart',threadId:'move-peer',command:'pwd'});await e.handle({action:'terminalStop',processId:terminal.processId});
        for(const action of ['read','family','send','fork','review'])await assert.rejects(e.handle({action,threadId:'move-root',...(action==='send'?{text:'blocked'}:{})}),/handoff|busy/i);
        e.discover('move-root');e.discover('move-child');e.discover('move-peer');
      }});
      void Promise.allSettled([oldRead,oldHistory,moved]);
      assert(bound===e.handoffFor('move-root'),'Authority binding runs before relocation first yields');
      await tick();assert(!child.calls.some(q=>q.method==='thread/archive'),'Existing reads drain before archival');await assert.rejects(e.thread('move-child'),/handoff/i);
      const pending=child.deferredReads.get('move-child');child.deferredReads=null;for(const q of pending)child.emitMessage({id:q.id,result:{thread:child.threads.get('move-child')}});await oldRead;assert.equal((await oldHistory).thread.cwd,source);
      const after=await moved;
      assert.equal(after.cwd,destination);assert.deepEqual(after.members.map(t=>[t.id,t.archived,t.lastTurnId]),snapshot.members.map(t=>[t.id,t.archived,t.lastTurnId]));
      assert.equal(phases.at(-1),'family-verified');assert(phases.indexOf('family-unloaded')<phases.indexOf('family-transfer-intent'));assert(phases.indexOf('family-transferred')<phases.indexOf('family-resume-intent'));
      for(const q of child.calls.filter(q=>q.method==='thread/resume')){assert(q.params.baseInstructions.includes('current TMPDIR environment variable'));assert(!q.params.baseInstructions.includes('/.saleh-coding-tmp-'));assert.deepEqual(q.params.runtimeWorkspaceRoots,[destination]);assert.equal(q.params.model,handoffModel);}
      assert.equal((await e.resolveFamily('move-archived')).root.id,'move-root');assert.equal((await e.thread('move-root')).cwd,destination);assert.equal(child.threads.get('move-peer').cwd,peer);
      assert.deepEqual(await e.prepareHandoff('move-root'),after,'A second handoff can be prepared immediately despite stale catalog cwd and no intervening turn');
      assert.throws(()=>e.checkHandoffAuthority(destination,bound,{snapshot,lease}),/handoff/i,'Completed authority cannot be reused');
      e.assertProject=async()=>{};lease.release();lease=await e.reserveProjectMutation(async()=>[source,destination]);const back=await e.relocateFamily(after,source,{checkpoint:async()=>{},transfer:async()=>{}});assert.equal(back.cwd,source);
    }finally{lease?.release();await e.close();}
    for(const failure of ['bind','stale','changed-family','checkpoint','checkpoint-stale','archive-extra','transfer','stop','stop-resume','verified-checkpoint','exit','late-child','late-child-read','late-child-activity','late-known-child','lease-released','stopped-lease']){
      const {e,child,meta}=await make(),lateId=failure==='late-known-child'?'move-child':'late-running-child';let lease;try{
        const snapshot=await e.prepareHandoff('move-root');lease=await e.reserveProjectMutation(async()=>[source,destination]);let effects=0;
        if(failure==='stale')child.threads.get('move-root').turns.push({id:'unreviewed-turn',status:'completed',items:[]});
        if(failure==='changed-family')child.threads.set('new-child',meta('new-child','move-root'));
        if(failure==='stopped-lease')await e.stop();
        if(failure==='archive-extra')child.handoffArchiveExtra=meta('archive-extra','move-root');
        const moved=e.relocateFamily(snapshot,destination,{bind:async()=>{if(failure==='bind')throw new Error('handoff binding failed');},checkpoint:async(phase,data)=>{
          if(failure==='checkpoint'&&phase==='family-archive-intent'||failure==='verified-checkpoint'&&phase==='family-verified')throw new Error('checkpoint failed');
          if(failure==='checkpoint-stale'&&phase==='family-archive-intent')child.threads.get('move-root').turns.push({id:'checkpoint-unreviewed-turn',status:'completed',items:[]});
          if(failure==='stop-resume'&&phase==='family-resume-intent'&&data.threadId==='move-child'){e.discover('move-child');await e.stop();assert.equal(child.killed,false,'Stop during a mixed-cwd transition must preserve peer process and skip fenced queued discovery');}
        },transfer:async()=>{
          effects++;
          if(failure==='transfer')throw new Error('transfer failed');
          if(failure==='stop')await e.stop();
          if(failure==='exit')await e.close();
          if(failure==='lease-released')lease.release();
          if(failure==='late-child'){const t=meta('late-child','move-root');child.threads.set(t.id,t);child.emitMessage({method:'thread/started',params:{thread:t}});}
          if(['late-child-read','late-child-activity','late-known-child'].includes(failure)){
            const t=meta(lateId,'move-root');t.status={type:'active'};t.turns.push({id:'late-running-turn',status:'inProgress',items:[]});child.threads.set(t.id,t);child.loadedIds.push(t.id);child.background=new Map([[t.id,new Set(['late-background'])]]);child.deferredReads=new Map([[t.id,[]]]);
            child.emitMessage({method:'turn/started',params:{threadId:t.id,turn:{id:'late-running-turn'}}});await tick();
            if(failure==='late-child-activity')child.emitMessage({method:'item/started',params:{threadId:'move-root',turnId:'saved-move-root',item:{id:'late-activity',type:'subAgentActivity',kind:'started',agentThreadId:t.id}}});
            const reads=child.deferredReads.get(t.id);child.deferredReads=null;for(const q of reads)child.emitMessage({id:q.id,result:{thread:t}});await tick();
          }
        }});
        if(['late-child-read','late-child-activity','late-known-child'].includes(failure)){
          let settled=false;void moved.then(()=>settled=true,()=>settled=true);
          await waitFor(()=>child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId===lateId));
          assert(child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId===lateId),'An active late child must actually receive interruption after its ancestry becomes known');
          assert.equal(settled,false,'Handoff rejection must wait for child completion, not release its lease on interrupt acknowledgement');
          assert(child.background.get(lateId).has('late-background'),'Background inventory is retained until its exact turn completes');
          const t=child.threads.get(lateId);t.status={type:'idle'};t.turns.at(-1).status='interrupted';child.emitMessage({method:'turn/completed',params:{threadId:t.id,turn:{id:'late-running-turn',status:'interrupted'}}});
        }
        let rejected;try{await moved;assert.fail('Injected handoff failure must reject');}catch(error){rejected=error;assert.match(error.message,/stale|changed|checkpoint|transfer|Stop|closed|cancel|family|lease|binding/i);}
        if(['late-child-read','late-child-activity','late-known-child'].includes(failure)){
          assert.equal(e.runs.has(lateId),false);assert.equal(e.familyStops.size,0);assert.equal(child.background.get(lateId).size,0);assert.equal(child.killed,false,'Selected-family cancellation preserves the shared peer engine');assert(!child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId==='move-peer'));
        }
        if(failure==='late-child-read'){
          const t=meta('second-late-child','move-root');t.status={type:'active'};t.turns.push({id:'second-late-turn',status:'inProgress',items:[]});child.threads.set(t.id,t);child.loadedIds.push(t.id);child.background.set(t.id,new Set(['second-late-background']));child.deferredReads=new Map([[t.id,[]]]);
          child.emitMessage({method:'turn/started',params:{threadId:t.id,turn:{id:'second-late-turn'}}});await tick();
          const reads=child.deferredReads.get(t.id);child.deferredReads=null;for(const q of reads)child.emitMessage({id:q.id,result:{thread:t}});
          await waitFor(()=>child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId===t.id));
          assert(child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId===t.id),'The retained failure fence rearms cancellation for a second unknown active child after the first Stop settled');
          const stopped=e.familyStops.get('move-root');assert(stopped);let settled=false;void stopped.then(()=>settled=true,()=>settled=true);await tick();assert.equal(settled,false);assert(e.runs.has(t.id));assert(child.background.get(t.id).has('second-late-background'));
          t.status={type:'idle'};t.turns.at(-1).status='interrupted';child.emitMessage({method:'turn/completed',params:{threadId:t.id,turn:{id:'second-late-turn',status:'interrupted'}}});await stopped;await tick();
          assert.equal(e.runs.has(t.id),false);assert.equal(e.familyStops.size,0);assert.equal(child.background.get(t.id).size,0);assert.equal(child.killed,false);assert(e.handoffFor('move-root'));assert(!child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId==='move-peer'));
        }
        if(failure==='stop-resume')assert.equal(child.killed,false,'Stop preserves the shared process while family discovery is fenced');
        const noEffect=['bind','stale','changed-family','checkpoint','checkpoint-stale','stopped-lease'].includes(failure);
        if(noEffect){assert.equal(effects,0);assert(!child.calls.some(q=>q.method==='thread/archive'));assert.notEqual(rejected.handoffStarted,true);}
        else assert.equal(rejected.handoffStarted,true);
        if(failure==='archive-extra')assert.equal(effects,0,'Unexpected cascaded children reject before Git transfer');
        if(failure==='transfer')await assert.rejects(e.prepare(destination,e.handoffFor('move-root')),/recovery/i,'A retained failed fence cannot authorize preparation');
        lease.release();
        if(noEffect)assert.equal(e.handoffFor('move-root'),undefined,'Known no-effect rejection releases only its temporary engine fence');
        else {await assert.rejects(e.handle({action:'send',threadId:'move-root',text:'must stay fenced'}),/handoff|busy|closed/i,'Unknown or mutated failure retains its execution fence after lease release');}
      }finally{lease?.release();await e.close();}
    }
    for(const point of ['bind','family-archive-intent','transfer','mixed','unconfirmed','prearchive-unconfirmed','direct-unconfirmed']){
      const {e,child}=await make();let lease,release;
      try{
        const snapshot=await e.prepareHandoff('move-root');lease=await e.reserveProjectMutation(async()=>[source,destination]);
        let bound,entered,settled=false;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),hold=async()=>{entered();await gate;};
        const moved=e.relocateFamily(snapshot,destination,{bind:async fence=>{bound=fence;if(point==='bind')await hold();},checkpoint:async(phase,data)=>{
          if(point===phase||point==='prearchive-unconfirmed'&&phase==='family-archive-intent'||['mixed','unconfirmed','direct-unconfirmed'].includes(point)&&phase==='family-resume-intent'&&data.threadId==='move-child')await hold();
        },transfer:async()=>{if(point==='transfer')await hold();}});void moved.catch(()=>{});await ready;
        assert.equal(typeof e.stopHandoff,'function','Manager needs a selected-only handoff Stop');
        assert(!child.calls.some(q=>q.method==='thread/archive')||!['bind','family-archive-intent'].includes(point));
        await assert.rejects(e.stopHandoff({...bound},{snapshot,lease}),/handoff/i);
        await assert.rejects(e.stopHandoff(bound,{snapshot,lease:{...lease}}),/binding|lease/i);
        assert.equal(bound.cancelled,false,'Untrusted Stop cannot revoke a valid handoff');
        const peerThread=child.threads.get('move-peer');peerThread.status={type:'active'};peerThread.turns.push({id:'peer-keeps-working',status:'inProgress',items:[]});
        child.emitMessage({method:'turn/started',params:{threadId:peerThread.id,turn:{id:'peer-keeps-working'}}});
        child.background=new Map([[peerThread.id,new Set(['peer-background'])]]);
        if(point==='direct-unconfirmed'){
          e.terminals.set('selected-direct',{threadId:'move-root',life:e.processLife,done:new Promise(()=>{}),decoders:new Map(),truncated:new Set()});child.failDirectTermination=true;
        }
        if(['mixed','unconfirmed','prearchive-unconfirmed'].includes(point)){
          assert.equal(child.threads.get('move-root').cwd,point==='prearchive-unconfirmed'?source:destination);assert.equal(child.threads.get('move-child').cwd,source);
          const selected=child.threads.get('move-root');selected.status={type:'active'};selected.turns.push({id:'selected-running',status:'inProgress',items:[]});child.handoffSyntheticTurns=false;
          e.runs.set(selected.id,'selected-running');e.startedTurns.set(selected.id,'selected-running');child.background.set(selected.id,new Set(['selected-background']));
          if(point.endsWith('unconfirmed'))child.interruptError='Selected interruption could not be confirmed';
          else child.deferredBackgroundTerminations=[];
        }
        const stopping=e.stopHandoff(bound,{snapshot,lease});void stopping.then(()=>settled=true,()=>settled=true);
        assert.equal(bound.cancelled,true,'Selected Stop revokes authority before yielding');
        assert.throws(()=>e.checkHandoffAuthority(destination,bound,{snapshot,lease}),/Stop|cancel|recovery/i);
        if(point==='mixed'){
          await waitFor(()=>child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId==='move-root'));assert.equal(settled,false,'Interrupt acknowledgement cannot release selected Stop');
          assert(child.background.get('move-root').has('selected-background'));
          const selected=child.threads.get('move-root');selected.status={type:'idle'};selected.turns.at(-1).status='interrupted';child.emitMessage({method:'turn/completed',params:{threadId:selected.id,turn:{id:'selected-running',status:'interrupted'}}});
          await waitFor(()=>child.deferredBackgroundTerminations.length>0);assert.equal(settled,false,'Selected Stop waits for background command confirmation');
          assert.equal(child.deferredBackgroundTerminations.length,1);const q=child.deferredBackgroundTerminations[0];child.background.get('move-root').clear();child.deferredBackgroundTerminations=null;child.emitMessage({id:q.id,result:{terminated:true}});
        }
        if(point.endsWith('unconfirmed')){await assert.rejects(stopping,error=>error.code==='HANDOFF_EXIT_UNCONFIRMED');assert.equal(bound.exitUnconfirmed,true);}
        else {assert.equal((await stopping).state,'stopped');assert.notEqual(bound.exitUnconfirmed,true);}
        assert.equal(child.killed,false,'Selected Stop never closes the shared peer process');assert.equal(e.runs.get('move-peer'),'peer-keeps-working');assert(child.background.get('move-peer').has('peer-background'));
        assert(!child.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId==='move-peer'||q.method==='thread/backgroundTerminals/terminate'&&q.params.threadId==='move-peer'));
        release();await assert.rejects(moved,error=>{assert.equal(error.handoffStarted,!['bind','family-archive-intent','prearchive-unconfirmed'].includes(point));if(point.endsWith('unconfirmed'))assert.equal(error.code,'HANDOFF_EXIT_UNCONFIRMED');return /Stop|cancel|changed|confirm|recovery/i.test(error.message);});
        assert.equal(!!e.handoffFor('move-root'),!['bind','family-archive-intent'].includes(point));
        if(point==='unconfirmed'){
          child.interruptError=null;const selected=child.threads.get('move-root');selected.status={type:'idle'};selected.turns.at(-1).status='interrupted';child.emitMessage({method:'turn/completed',params:{threadId:selected.id,turn:{id:'selected-running',status:'interrupted'}}});
          assert.equal((await e.stopHandoff(bound,{snapshot,lease})).state,'stopped');assert.equal(bound.exitUnconfirmed,false);assert.equal(child.background.get(selected.id).size,0);assert(e.handoffFor(selected.id));assert.throws(()=>e.checkHandoffAuthority(destination,bound,{snapshot,lease}),/recovery/i,'Confirmed retry cannot restore relocation execution authority');
        }
      }finally{release?.();lease?.release();await e.close();}
    }
  }
  {
    const project=join(root,'handoff-temp-project');await mkdir(project);const actions=[];
    const e=new CodingEngine({dataDir:join(root,'handoff-temp-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',temporaryOperation:async(action,input)=>{actions.push(action);return fakeTemporaryOperation(action,input);}});
    try{
      assert.equal(typeof e.handoffTemporary,'function','Handoff must inspect existing verified scratch without allocating');
      const count=children.length;assert.equal(await e.handoffTemporary(project),null);assert.equal(children.length,count);assert.deepEqual(actions,[]);
      await e.ensure();assert.equal(await e.handoffTemporary(project),null);assert.deepEqual(actions,[]);
      const env=await e.temporaryEnvironment(project,e.epoch),owned=await e.handoffTemporary(project);assert.equal(owned.path,env.TMPDIR);assert.equal(owned.cwd,project);assert(Object.isFrozen(owned));assert.deepEqual(actions,['create','verify','verify']);
      const alias=join(root,'handoff-temp-alias');await symlink(project,alias);await assert.rejects(e.handoffTemporary(alias),/canonical/i);assert.equal(actions.filter(a=>a==='create').length,1);
      let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),operation=e.temporaryOperation;
      e.temporaryOperation=async(action,input)=>{if(action==='verify'){entered();await gate;}return operation(action,input);};
      const pending=e.handoffTemporary(project);await ready;await e.stop();release();await assert.rejects(pending,/Stop|process|closed/i);e.temporaryOperation=operation;
      await rename(owned.path,owned.path+'-original');await mkdir(owned.path);await writeFile(join(owned.path,'.saleh-owner'),owned.nonce);await assert.rejects(e.handoffTemporary(project),/identity/i);assert.equal(actions.filter(a=>a==='create').length,1);
    }finally{await e.close();}
  }
  {
    const project=join(root,'missing-history-project'),away=project+'-away';await mkdir(project);
    const e=new CodingEngine({dataDir:join(root,'missing-history-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try {
      await e.handle({action:'start',cwd:project});const child=children.at(-1);
      child.thread.status={type:'idle'};
      child.thread.turns=[{id:'saved-turn',status:'completed',items:[{id:'saved-reply',type:'agentMessage',text:'Saved reply survives a missing checkout.'}]}];
      const nested={...child.thread,id:'missing-child',parentThreadId:'thread-1',canAcceptDirectInput:false,historyMode:'paginated'};
      child.threads=new Map([['thread-1',child.thread],[nested.id,nested]]);
      child.familyPages=new Map([['thread-1:',{data:[nested],nextCursor:null}]]);
      await rename(project,away);
      const saved=await e.handle({action:'read',threadId:'thread-1'});
      assert.equal(saved.thread.cwd,project);
      assert.equal(saved.thread.turns[0].items[0].text,'Saved reply survives a missing checkout.');
      assert.equal((await e.handle({action:'read',threadId:nested.id})).thread.turns[0].items[0].text,saved.thread.turns[0].items[0].text,'Paginated child history remains readable');
      assert.equal((await e.handle({action:'family',threadId:nested.id})).rootThreadId,'thread-1');
      for(const action of ['rename','archive','unarchive']){
        await e.handle({action,threadId:'thread-1',...(action==='rename'?{name:'Saved chat'}:{})});
        await assert.rejects(e.handle({action,threadId:nested.id,...(action==='rename'?{name:'Child'}:{})}),/Child history is read-only/);
      }
      await assert.rejects(e.handle({action:'send',threadId:nested.id,text:'Child remains read-only'}),/Child history is read-only/);
      for(const cwd of ['relative/path','/invalid\0path',null]){
        child.threads.set('bad-path',{...child.thread,id:'bad-path',cwd});
        await assert.rejects(e.handle({action:'read',threadId:'bad-path'}),/absolute|Invalid directory/);
      }
      const execution=[{action:'start',cwd:project},{action:'send',threadId:'thread-1',text:'Do not execute'},
        {action:'review',threadId:'thread-1'},{action:'fork',threadId:'thread-1'},
        {action:'terminalStart',threadId:'thread-1',command:'pwd'},{action:'git',threadId:'thread-1'}];
      const noExecution=from=>assert(!child.calls.slice(from).some(q=>['thread/start','thread/resume','thread/fork','turn/start','review/start','command/exec','turn/steer','command/exec/write'].includes(q.method)||q.result?.decision==='accept'),'Missing or noncanonical saved directory must never reach execution');
      let before=child.calls.length;
      for(const input of execution)await assert.rejects(e.handle(input),/ENOENT/);
      let claims=0;const scheduled=await e.runScheduled({cwd:project,prompt:'Do not claim',onClaim:async()=>{claims++;}});
      assert.equal(scheduled.status,'failed');assert.match(scheduled.message,/ENOENT/);assert.equal(claims,0);noExecution(before);
      e.runs.set('thread-1','missing-turn');
      e.terminals.set('missing-terminal',{threadId:'thread-1',life:e.processLife,bytes:0,decoders:new Map(),truncated:new Set()});
      child.emitMessage({id:8699,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'missing-turn',itemId:'missing-command',command:'pwd',cwd:project}});await tick();
      const approval=[...e.approvals.values()][0];assert(approval);
      const continuations=[{action:'steer',threadId:'thread-1',turnId:'missing-turn',text:'Do not steer'},
        {action:'terminalWrite',processId:'missing-terminal',text:'Do not write'},
        {action:'approval',id:approval.id,decision:'accept'}];
      before=child.calls.length;for(const input of continuations)await assert.rejects(e.handle(input),/ENOENT/);noExecution(before);
      assert(e.approvals.has(approval.id),'Failed directory validation must not consume the approval');
      await symlink(away,project);
      try {
        assert.equal((await e.handle({action:'read',threadId:'thread-1'})).thread.cwd,project,'History must not retarget its saved directory through a replacement symlink');
        e.runs.delete('thread-1');before=child.calls.length;
        for(const input of execution)await assert.rejects(e.handle(input),input.action==='terminalStart'?/canonical directory|terminal is already active/:/canonical directory/);
        e.runs.set('thread-1','missing-turn');for(const input of continuations)await assert.rejects(e.handle(input),/canonical directory/);noExecution(before);
      } finally {await rm(project);}
      await e.handle({action:'approval',id:approval.id,decision:'decline'});
      await e.handle({action:'terminalStop',processId:'missing-terminal'});e.terminals.delete('missing-terminal');
      const interrupted=e.handle({action:'interrupt',threadId:'thread-1',turnId:'missing-turn'});
      await waitFor(()=>child.calls.some(q=>q.method==='turn/interrupt'&&q.params.turnId==='missing-turn'));
      assert(child.calls.some(q=>q.method==='turn/interrupt'&&q.params.turnId==='missing-turn'));
      child.emitMessage({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'missing-turn',status:'interrupted'}}});
      await interrupted;await Promise.all([...e.familyStops.values()]);
      child.loadedIds=['thread-1',nested.id];child.background=new Map([[nested.id,new Set(['missing-background'])]]);
      await e.stop();assert.equal(child.background.get(nested.id).size,0);assert.equal(child.killed,false,'Control cleanup must succeed without closing the healthy process when its saved directory is missing');
    } finally {await rename(away,project).catch(()=>{});await e.close();}
  }
  {
    const project=join(root,'inventory-project'),unregistered=join(root,'inventory-unregistered'),other=join(root,'inventory-other');for(const cwd of [project,unregistered,other])await mkdir(cwd);
    const e=new CodingEngine({dataDir:join(root,'inventory-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try{
      assert.equal(typeof e.projectMutationInventory,'function','A pending lease must inventory engine-owned projects beyond registered Git peers');
      await assert.rejects(e.projectMutationInventory(),/pending.*lease/i);await e.ensure();const c=children.at(-1);
      const meta=(id,cwd,status='idle')=>({id,cwd,model:localConfig.model,modelProvider:'saleh_local',status:{type:status},turns:[]});
      c.threads=new Map([['unregistered-owner',meta('unregistered-owner',unregistered)],['other-owner',meta('other-owner',other)],['uncached-owner',meta('uncached-owner',other)]]);c.loadedIds=['unregistered-owner','other-owner'];
      e.rememberThread(meta('unregistered-owner',project));e.rememberThread(c.threads.get('other-owner'));e.runs.set('unregistered-owner','active-turn');e.runs.set('other-owner','unrelated-turn');
      let found;const acquire=()=>e.reserveProjectMutation(async()=>{found=await e.projectMutationInventory();return [project,...found.filter(cwd=>cwd===unregistered)];});
      await assert.rejects(acquire(),error=>error.code==='PROJECT_BUSY');assert(found.includes(unregistered)&&found.includes(other));assert.equal(e.threadInfo.get('unregistered-owner').cwd,unregistered,'Inventory must refresh stale saved cwd');e.runs.delete('unregistered-owner');
      c.background=new Map([['unregistered-owner',new Set(['background-command'])]]);await assert.rejects(acquire(),error=>error.code==='PROJECT_BUSY');c.background.clear();
      e.terminals.set('inventory-pty',{threadId:'unregistered-owner'});await assert.rejects(acquire(),error=>error.code==='PROJECT_BUSY');e.terminals.delete('inventory-pty');
      const admission={cwd:null,threadId:'uncached-owner'};e.admissions.add(admission);e.scheduled={cwd:other};
      const lease=await acquire();assert.equal(e.runs.get('other-owner'),'unrelated-turn');assert.equal(e.mutationBlocks(other),false);assert(found.includes(other));lease.release();e.admissions.delete(admission);e.scheduled=null;
      const starting={cwd:other,threadId:null};e.admissions.add(starting);e.busy.add('new-thread');const startLease=await acquire();assert(!c.calls.some(q=>q.method==='thread/read'&&q.params.threadId==='new-thread'),'The new-thread busy sentinel is scoped by its admission cwd, never read as a real chat');startLease.release();e.admissions.delete(starting);e.busy.delete('new-thread');
      e.scheduled={cwd:unregistered};await assert.rejects(acquire(),error=>error.code==='PROJECT_BUSY');e.scheduled=null;
      const pendingRelated={cwd:null,threadId:'unregistered-owner'};e.admissions.add(pendingRelated);await assert.rejects(acquire(),error=>error.code==='PROJECT_BUSY');assert.equal(pendingRelated.cwd,unregistered);e.admissions.delete(pendingRelated);
      const unknown={cwd:null};e.admissions.add(unknown);await assert.rejects(acquire(),/unresolved|identity|project/i);e.admissions.delete(unknown);
      c.loadedPages=new Map(Array.from({length:20},(_,i)=>[i?String(i):'',{data:['bounded-'+i],nextCursor:String(i+1)}]));const inventoryReads=c.calls.filter(q=>q.method==='thread/loaded/list').length;await assert.rejects(acquire(),/verification limit/);assert.equal(c.calls.filter(q=>q.method==='thread/loaded/list').length-inventoryReads,20);delete c.loadedPages;
      e.runs.clear();c.loadedIds=[];c.deferredLoaded=[];const pending=acquire(),rejected=assert.rejects(pending,/cancelled|lifecycle/i);await waitFor(()=>c.deferredLoaded.length===1);const stopping=e.stop();await waitFor(()=>c.deferredLoaded.length===2);
      for(const q of c.deferredLoaded)c.emitMessage({id:q.id,result:{data:[],nextCursor:null}});delete c.deferredLoaded;await stopping;await rejected;assert.equal(e.projectMutation,null);
    }finally{e.scheduled=null;e.admissions.clear();e.terminals.clear();await e.close();}
  }
  {
    const project=join(root,'mutation-project'),other=join(root,'mutation-other');await mkdir(project);await mkdir(other);
    const e=new CodingEngine({dataDir:join(root,'mutation-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try {
      assert.equal(typeof e.reserveProjectMutation,'function','Engine must own project-mutation admission leases');
      let resolvePaths,claims=0;const before=children.length;
      const acquiring=e.reserveProjectMutation(()=>new Promise(resolve=>{resolvePaths=resolve;}));assert(resolvePaths,'Provisional reservation precedes the first await');
      for(const input of [{action:'start',cwd:other},{action:'send',threadId:'unknown',text:'blocked before metadata'}])await assert.rejects(e.handle(input),error=>error.code==='PROJECT_BUSY');
      await assert.rejects(e.runScheduled({cwd:other,prompt:'blocked',onClaim:async()=>{claims++;}}),error=>error.code==='PROJECT_BUSY');
      await assert.rejects(e.reserveProjectMutation(async()=>[other]),error=>error.code==='PROJECT_BUSY');assert.equal(claims,0);assert.equal(children.length,before);
      resolvePaths([project]);const lease=await acquiring;assert.equal(children.length,before,'Mutation reservation must not launch an engine');
      await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');
      await e.handle({action:'start',cwd:other});assert.equal((await e.handle({action:'status'})).busy,true);
      const c=children.at(-1),metadata={id:'mutation-owned',cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'},turns:[]};e.rememberThread(metadata);
      c.threads=new Map([[metadata.id,metadata],['uncached-overlap',{...metadata,id:'uncached-overlap'}],['uncached-unrelated',{...metadata,id:'uncached-unrelated',cwd:other}]]);
      e.terminals.set('mutation-terminal',{threadId:metadata.id,life:e.processLife,bytes:0,decoders:new Map(),truncated:new Set()});
      e.approvals.set('mutation-approval',{id:'mutation-approval',serverId:8791,params:{threadId:metadata.id,turnId:'turn-blocked'}});
      for(const input of [
        {action:'start',cwd:root},{action:'send',threadId:metadata.id,text:'blocked'},
        {action:'steer',threadId:metadata.id,turnId:'turn-blocked',text:'blocked'},
        {action:'review',threadId:metadata.id},{action:'fork',threadId:metadata.id},
        {action:'terminalStart',threadId:metadata.id,command:'blocked'},
        {action:'terminalWrite',processId:'mutation-terminal',text:'blocked'},
        {action:'approval',id:'mutation-approval',decision:'accept'},
        {action:'send',threadId:'uncached-overlap',text:'blocked after metadata'}
      ])await assert.rejects(e.handle(input),error=>error.code==='PROJECT_BUSY');
      await e.handle({action:'approval',id:'mutation-approval',decision:'decline'});e.terminals.delete('mutation-terminal');
      await e.handle({action:'send',threadId:'uncached-unrelated',text:'allowed after metadata'});
      c.emitMessage({method:'turn/completed',params:{threadId:'uncached-unrelated',turn:{id:'turn-uncached-unrelated',status:'completed'}}});
      await assert.rejects(e.handle({action:'reloadProviders'}),/busy/);
      await e.stop();await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY','Stop cannot release another owner’s Git-process lease');
      lease.release();lease.release();const newer=await e.reserveProjectMutation(async()=>[project]);lease.release();
      await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY','An old release cannot clear a new owner');
      e.fail(new Error('synthetic engine exit while native Git remains owned'));await e.disposal;
      await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');newer.release();
    } finally {await e.close();}
  }
  {
    const project=join(root,'mutation-races'),other=join(root,'mutation-races-other');await mkdir(project);await mkdir(other);
    const e=new CodingEngine({dataDir:join(root,'mutation-races-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try {
      const cwd=e.cwd.bind(e);let resume;
      e.cwd=async value=>{await new Promise(resolve=>{resume=resolve;});return cwd(value);};
      const foreground=e.handle({action:'start',cwd:project});await waitFor(()=>!!resume);e.cwd=cwd;
      await assert.rejects(e.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY','An already admitted overlapping action wins acquisition');resume();await foreground;
      let resolvePaths;resume=null;e.cwd=async value=>{await new Promise(resolve=>{resume=resolve;});return cwd(value);};
      const prior=e.handle({action:'start',cwd:project});await waitFor(()=>!!resume);e.cwd=cwd;
      const acquiring=e.reserveProjectMutation(()=>new Promise(resolve=>{resolvePaths=resolve;}));resume();await prior;
      resolvePaths([project]);const lease=await acquiring;lease.release();
      const c=children.at(-1),meta={id:'mutation-live',cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'},turns:[]};c.threads=new Map([[meta.id,meta]]);e.rememberThread(meta);
      await e.handle({action:'send',threadId:meta.id,text:'existing work'});await assert.rejects(e.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY');
      c.emitMessage({method:'turn/completed',params:{threadId:meta.id,turn:{id:'turn-mutation-live',status:'completed'}}});
      const terminal=await e.handle({action:'terminalStart',threadId:meta.id,command:'existing direct terminal'});await assert.rejects(e.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY');
      c.emitMessage({id:c.commandRequest.id,result:{exitCode:0,stdout:'',stderr:''}});await tick();assert(!e.terminals.has(terminal.processId));
      c.loadedIds=[meta.id];c.background=new Map([[meta.id,new Set(['idle-command'])]]);
      await assert.rejects(e.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY','Actual idle model commands block Git mutation');c.background.get(meta.id).clear();
      c.deferredReads=new Map([[meta.id,[]]]);const resolving=e.reserveProjectMutation(async()=>[project]);await waitFor(()=>c.deferredReads.get(meta.id).length===1);assert.equal(c.deferredReads.get(meta.id).length,1);
      await e.handle({action:'start',cwd:other});
      c.emitMessage({method:'turn/started',params:{threadId:meta.id,turn:{id:'late-mutation-turn',status:'inProgress'}}});
      const held=c.deferredReads.get(meta.id);delete c.deferredReads;for(const q of held)c.emitMessage({id:q.id,result:{thread:meta}});
      await assert.rejects(resolving,error=>error.code==='PROJECT_BUSY','Activity arriving during inventory must be rechecked before ownership returns');
      c.emitMessage({method:'turn/completed',params:{threadId:meta.id,turn:{id:'late-mutation-turn',status:'completed'}}});
      const final=await e.reserveProjectMutation(async()=>[project]);final.release();
    } finally {await e.close();}
  }
  {
    const project=join(root,'mutation-scheduled'),other=join(root,'mutation-scheduled-other');await mkdir(project);await mkdir(other);
    const e=new CodingEngine({dataDir:join(root,'mutation-scheduled-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try {
      await e.ensure();const c=children.at(-1);c.nextThreadId='mutation-scheduled-root';c.nextTurnId='mutation-scheduled-turn';c.threads=new Map();let releaseClaim,admitted=false;
      const run=e.runScheduled({cwd:project,prompt:'already admitted schedule',onClaim:()=>new Promise(resolve=>{releaseClaim=resolve;}),onThread:async id=>c.threads.set(id,{...c.thread,status:{type:'idle'}}),onTurn:async()=>{admitted=true;}});
      await waitFor(()=>!!releaseClaim);assert(releaseClaim);
      await assert.rejects(e.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY','Scheduled ownership wins over a later overlapping mutation');
      const unrelated=await e.reserveProjectMutation(async()=>[other]);releaseClaim();await waitFor(()=>admitted);assert(admitted,'An unrelated mutation must not invalidate scheduled callbacks after awaits');
      c.emitMessage({method:'turn/completed',params:{threadId:c.nextThreadId,turn:{id:c.nextTurnId,status:'completed'}}});assert.equal((await run).status,'completed');
      let claimed=false;await assert.rejects(e.runScheduled({cwd:other,prompt:'blocked by held mutation',onClaim:async()=>{claimed=true;}}),error=>error.code==='PROJECT_BUSY');assert.equal(claimed,false);unrelated.release();
    } finally {await e.close();}
  }
  {
    const project=join(root,'mutation-invalid');await mkdir(project);
    const e=new CodingEngine({dataDir:join(root,'mutation-invalid-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try {
      for(const paths of [[],Array(129).fill(project),'not-an-array',['relative'],[project+'/'],[null]])await assert.rejects(e.reserveProjectMutation(async()=>paths),/canonical|paths|absolute|directory/);
      let resolvePaths;const pending=e.reserveProjectMutation(()=>new Promise(resolve=>{resolvePaths=resolve;}));const rejected=assert.rejects(pending,/cancelled|lifecycle/);
      await e.stop();await assert.rejects(e.reserveProjectMutation(async()=>[project]),error=>error.code==='PROJECT_BUSY');resolvePaths([project]);await rejected;
      const lease=await e.reserveProjectMutation(async()=>[project,project]);lease.release();assert.equal((await e.handle({action:'status'})).busy,false);
    } finally {await e.close();}
  }
  {
    // A durable claim is the boundary: no model dispatch, even a fresh thread,
    // may precede it; reservations cover async foreground admission too.
    const project=join(root,'schedule-project'),other=join(root,'schedule-other');await mkdir(project);await mkdir(other);
    const scheduled=new CodingEngine({dataDir:join(root,'schedule-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try {
      assert.equal(typeof scheduled.runScheduled,'function','CodingEngine must own scheduled dispatch and its project lease');
      let releaseCwd;const originalCwd=scheduled.cwd.bind(scheduled);
      scheduled.cwd=async value=>{await new Promise(resolve=>{releaseCwd=resolve;});return originalCwd(value);};
      const pending=scheduled.handle({action:'start',cwd:project});await waitFor(()=>!!releaseCwd);assert(releaseCwd);
      let claims=0;await assert.rejects(scheduled.runScheduled({cwd:project,prompt:'fixture',onClaim:async()=>{claims++;}}),error=>error.code==='PROJECT_BUSY');assert.equal(claims,0);
      scheduled.cwd=originalCwd;releaseCwd();await pending;
      scheduled.cwd=async value=>{await new Promise(resolve=>{releaseCwd=resolve;});return originalCwd(value);};releaseCwd=null;
      const lateBusy=scheduled.runScheduled({cwd:project,prompt:'fixture',onClaim:async()=>{claims++;}});await waitFor(()=>!!releaseCwd);assert(releaseCwd);
      scheduled.rememberThread({id:'late-active',cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'active'}});scheduled.runs.set('late-active','late-turn');
      const busyResult=assert.rejects(Promise.race([lateBusy,new Promise(resolve=>setTimeout(resolve,100))]),error=>error.code==='PROJECT_BUSY','Activity discovered before durable claim must remain retryable');scheduled.cwd=originalCwd;releaseCwd();await busyResult;assert.equal(claims,0);
      scheduled.runs.delete('late-active');scheduled.threadInfo.delete('late-active');
      const child=children.at(-1);child.familyPages=new Map();child.nextThreadId='scheduled-root';child.nextTurnId='scheduled-turn';
      child.threads=new Map([['foreground',{...child.thread,id:'foreground',status:{type:'idle'}}],['other',{...child.thread,id:'other',cwd:other,status:{type:'idle'}}]]);
      let releaseClaim,releaseThread,releaseDispatch;const before=child.calls.length;
      const run=scheduled.runScheduled({cwd:project,prompt:'fixture',effort:'none',onClaim:()=>new Promise(r=>{releaseClaim=r;}),onThread:()=>new Promise(r=>{releaseThread=r;}),onDispatch:()=>new Promise(r=>{releaseDispatch=r;})});
      await waitFor(()=>!!releaseClaim);assert(releaseClaim);assert(!child.calls.slice(before).some(q=>q.method==='thread/start'));
      await assert.rejects(scheduled.handle({action:'start',cwd:project}),/scheduled|lease|busy/i);
      await assert.rejects(scheduled.handle({action:'start',cwd:root}),/scheduled|lease|busy/i);
      await assert.rejects(scheduled.handle({action:'send',threadId:'foreground',text:'blocked'}),/scheduled|lease|busy/i);
      await scheduled.handle({action:'send',threadId:'other',text:'unrelated project continues'});
      releaseClaim();await waitFor(()=>!!releaseThread);assert(releaseThread);
      assert(!child.calls.slice(before).some(q=>q.method==='turn/start'&&q.params.threadId==='scheduled-root'),'onThread must durably finish before inference');
      child.threads.set('scheduled-root',{...child.thread,status:{type:'idle'}});releaseThread();
      await waitFor(()=>!!releaseDispatch);assert(releaseDispatch);assert(!child.calls.slice(before).some(q=>q.method==='turn/start'&&q.params.threadId==='scheduled-root'),'onDispatch must finish durably before inference');releaseDispatch();
      await waitFor(()=>child.calls.some(q=>q.method==='turn/start'&&q.params.threadId==='scheduled-root'));assert(child.calls.some(q=>q.method==='turn/start'&&q.params.threadId==='scheduled-root'));
      child.emitMessage({method:'turn/completed',params:{threadId:'scheduled-root',turn:{id:'scheduled-turn',status:'completed'}}});
      const result=await run;assert.equal(result.status,'completed');assert.equal(result.threadId,'scheduled-root');assert.equal(result.turnId,'scheduled-turn');
      const start=child.calls.find(q=>q.method==='thread/start'&&q.params.cwd===project&&q.params.model===localConfig.model&&q.params.allowProviderModelFallback===false);assert(start);
      await scheduled.handle({action:'start',cwd:project});
    } finally {await scheduled.close();}
  }
  {
    const fixture=async name=>{
      const project=join(root,`scheduled-${name}`);await mkdir(project);
      const e=new CodingEngine({dataDir:join(root,`scheduled-${name}-home`),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});await e.ensure();
      const c=children.at(-1);c.nextThreadId=`root-${name}`;c.nextTurnId=`turn-${name}`;c.familyPages=new Map();c.threads=new Map();let admitted=false;
      const opts={cwd:project,prompt:'deterministic fixture',onClaim:async()=>{},onThread:async id=>c.threads.set(id,{...c.thread,status:{type:'idle'}}),onTurn:async()=>{admitted=true;}};
      const ready=async()=>{await waitFor(()=>admitted);assert(admitted,'scheduled turn must be admitted');};
      const complete=(status='completed')=>c.emitMessage({method:'turn/completed',params:{threadId:c.nextThreadId,turn:{id:c.nextTurnId,status}}});
      return {e,c,opts,ready,complete,project};
    };
    {
      const {e,c,opts,ready,complete}=await fixture('background-stop');
      try {
        const controller=new AbortController(),run=e.runScheduled({...opts,signal:controller.signal});await ready();
        const other='other-background';c.background=new Map([[other,new Set(['keep-running'])]]);
        controller.abort();await tick();await tick();
        assert(!c.calls.some(q=>q.method==='thread/backgroundTerminals/list'&&q.params.threadId===c.nextThreadId),'An empty list before terminal proof cannot authorize cleanup');
        // The tool publishes its process only as the interrupted turn unwinds.
        c.background.set(c.nextThreadId,new Set(['late-process']));complete('interrupted');
        const result=await run;assert.equal(result.status,'interrupted');
        assert.equal(c.background.get(c.nextThreadId).size,0,'Interrupted scheduled command must be terminated before lease release');
        assert.deepEqual([...c.background.get(other)],['keep-running'],'Scoped cleanup must preserve unrelated commands');
      } finally {await e.close();}
    }
    {
      const {e,c,opts,ready,complete}=await fixture('background-completed');
      try {
        const run=e.runScheduled(opts);await ready();c.background=new Map([[c.nextThreadId,new Set(['still-running'])]]);complete();
        let finished=false;void run.then(()=>{finished=true;});await new Promise(r=>setTimeout(r,30));
        assert.equal(finished,false,'Normal completion must retain the project lease while a model command runs');
        assert(!c.calls.some(q=>q.method==='thread/backgroundTerminals/terminate'),'Normal completion does not kill requested background work');
        c.background.get(c.nextThreadId).clear();e.scheduled.wake?.();assert.equal((await run).status,'completed');
      } finally {await e.close();}
    }
    {
      const {e,c,opts,project}=await fixture('background-admission');
      try {
        const id='idle-loaded';c.loadedIds=[id];c.threads.set(id,{id,cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'},turns:[]});c.background=new Map([[id,new Set(['existing-process'])]]);
        let claimed=false;await assert.rejects(e.runScheduled({...opts,onClaim:async()=>{claimed=true;}}),error=>error.code==='PROJECT_BUSY');assert.equal(claimed,false,'Busy command must be discovered before durable claim');
        await e.stop();assert.equal(c.background.get(id).size,0,'Global Stop must terminate commands owned by idle loaded threads');
      } finally {await e.close();}
    }
    {
      const {e,c,opts,ready,complete,project}=await fixture('background-history');
      try {
        const old='archived-child';c.threads.set(old,{id:old,parentThreadId:c.nextThreadId,canAcceptDirectInput:false,cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'notLoaded'},turns:[]});
        c.familyPages.set(`${c.nextThreadId}:`,{data:[c.threads.get(old)],nextCursor:null});c.loadedIds=[c.nextThreadId];
        const run=e.runScheduled(opts);await ready();complete();assert.equal((await run).status,'completed');
        assert(!c.calls.some(q=>q.method==='thread/backgroundTerminals/list'&&q.params.threadId===old),'Saved notLoaded children are excluded by authoritative loaded inventory');
      } finally {await e.close();}
    }
    for(const malformed of ['cursor','identity']){
      const {e,c,opts,project}=await fixture(`background-invalid-${malformed}`);
      try {
        const id='idle-invalid';c.loadedIds=[id];c.threads.set(id,{id,cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'},turns:[]});
        c.backgroundPages=malformed==='cursor'?new Map([[`${id}:`,{data:[],nextCursor:'repeat'}],[`${id}:repeat`,{data:[],nextCursor:'repeat'}]]):new Map([[`${id}:`,{data:[{processId:{invalid:true}}],nextCursor:null}]]);
        let claimed=false;const result=await e.runScheduled({...opts,onClaim:async()=>{claimed=true;}});assert.equal(result.status,'failed');assert.equal(claimed,false);assert.match(result.message,/cursor|identity/);
        await e.stop();assert.equal(c.killed,true,'Malformed authoritative cleanup inventory must fail closed');
      } finally {await e.close();}
    }
    {
      const {e,c}=await fixture('background-old-life');const life=e.processLife;
      try {
        c.background=new Map([['old-thread',new Set(['old-process'])]]);c.deferredBackgroundTerminations=[];
        const cleanup=e.backgroundIdle(['old-thread'],life,true);const rejected=assert.rejects(cleanup,/process changed/);
        await waitFor(()=>c.deferredBackgroundTerminations.length===1);assert.equal(c.deferredBackgroundTerminations.length,1);
        e.processLife={...life};const at=c.calls.length;c.emitMessage({id:c.deferredBackgroundTerminations[0].id,result:{terminated:true}});await rejected;
        assert(!c.calls.slice(at).some(q=>q.method==='thread/backgroundTerminals/list'),'A previous process lifetime cannot finish cleanup against a replacement');
      } finally {e.processLife=life;await e.close();}
    }
    {
      const {e,c,project}=await fixture('direct-reject-during-inventory');let unhandled=false;const observed=()=>{unhandled=true;};process.on('unhandledRejection',observed);
      try {
        const id='direct-thread';c.threads.set(id,{id,cwd:project,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'},turns:[]});
        await e.handle({action:'terminalStart',threadId:id,command:'fixture'});c.failDirectTermination=true;c.deferredLoaded=[];
        const stopped=e.stop();await waitFor(()=>c.deferredLoaded.length===1);await tick();assert.equal(unhandled,false,'Concurrent direct terminal rejection needs a handler before inventory completes');
        const held=c.deferredLoaded;delete c.deferredLoaded;for(const request of held)c.emitMessage({id:request.id,result:{data:[],nextCursor:null}});
        await stopped;assert.equal(c.killed,true,'Direct termination failure still fails Stop closed after inventory joins');
      } finally {process.removeListener('unhandledRejection',observed);await e.close();}
    }
    {
      const {e,c,opts,ready,complete}=await fixture('archived-missing-project');
      try {
        const archived=join(root,'deleted-archived-project');await mkdir(archived);const scheduledId=c.nextThreadId;c.nextThreadId='archived-missing';
        await e.handle({action:'start',cwd:archived});c.threads.set(c.nextThreadId,{...c.thread,status:{type:'notLoaded'}});await e.handle({action:'archive',threadId:c.nextThreadId});
        c.loadedIds=[];c.nextThreadId=scheduledId;await rm(archived,{recursive:true});let claimed=false,outcome;
        const run=e.runScheduled({...opts,onClaim:async()=>{claimed=true;}});void run.then(result=>{outcome=result;});await waitFor(()=>claimed||outcome);
        assert.equal(claimed,true,`Archived unloaded project must not block an unrelated schedule: ${JSON.stringify(outcome)}`);await ready();complete();assert.equal((await run).status,'completed');
      } finally {await e.close();}
    }
    {
      const {e,c,opts}=await fixture('claim');
      try {
        const result=await e.runScheduled({...opts,onClaim:async()=>{throw new Error('durable claim write failed');}});
        assert.equal(result.status,'failed');assert.match(result.message,/durable claim/);assert(!c.calls.some(q=>q.method==='thread/start'));
        let releaseClaim;const controller=new AbortController();const run=e.runScheduled({...opts,signal:controller.signal,onClaim:()=>new Promise(r=>{releaseClaim=r;})});
        await waitFor(()=>!!releaseClaim);assert(releaseClaim);controller.abort();
        const stopped=await Promise.race([run,new Promise(resolve=>setTimeout(()=>resolve({status:'still-waiting'}),50))]);
        assert.equal(stopped.status,'interrupted','Stop must not await a held durable callback before ending undispatched work');releaseClaim();await tick();assert(!c.calls.some(q=>q.method==='thread/start'));
      } finally {await e.close();}
    }
    {
      const {e,c,opts}=await fixture('held-dispatch');
      try{
        let releaseDispatch;const controller=new AbortController(),run=e.runScheduled({...opts,signal:controller.signal,onDispatch:()=>new Promise(r=>{releaseDispatch=r;})});
        await waitFor(()=>!!releaseDispatch);assert(releaseDispatch);controller.abort();assert.equal((await run).status,'interrupted');assert(e.scheduled,'Held durable invalidation retains its reservation');
        releaseDispatch();await e.scheduledDisposal;assert.equal(e.scheduled,null);assert(!c.calls.some(q=>q.method==='turn/start'),'Stop while invalidating never dispatches a late turn');
      }finally{await e.close();}
    }
    {
      const {e,c,opts}=await fixture('late-thread');
      try {
        c.deferredStarts=[];let recordedThreads=0,createdThreads=0;const controller=new AbortController();
        const run=e.runScheduled({...opts,signal:controller.signal,onCreated:async thread=>{assert.equal(thread.id,c.nextThreadId);createdThreads++;},onThread:async()=>{recordedThreads++;}});
        await waitFor(()=>c.deferredStarts.length===1);assert.equal(c.deferredStarts.length,1);controller.abort();
        assert.equal((await run).status,'interrupted');assert(e.scheduled,'Late native creation retains its reservation until body settlement');
        await assert.rejects(e.runScheduled(opts),error=>error.code==='PROJECT_BUSY');
        const request=c.deferredStarts[0];c.emitMessage({id:request.id,result:{thread:{id:c.nextThreadId,cwd:opts.cwd,model:localConfig.model,modelProvider:'saleh_local',status:{type:'idle'}}}});
        await e.scheduledDisposal;await tick();assert.equal(e.scheduled,null);assert.equal(createdThreads,1,'Late native identity must still be durably owned');assert.equal(recordedThreads,0,'A late thread/start reply must not revive a finished schedule through onThread');
        assert(!c.calls.some(q=>q.method==='turn/start'),'A late empty-thread reply must never dispatch inference');
      } finally {await e.close();}
    }
    {
      const {e,c,opts}=await fixture('early-completion');
      try {c.completeBeforeResponse=true;const result=await e.runScheduled(opts);assert.equal(result.status,'completed');assert.equal(result.turnId,c.nextTurnId,'Early completion belongs to the returned exact turn');}
      finally {await e.close();}
    }
    {
      const {e,c,opts,ready,complete,project}=await fixture('family');
      try {
        const run=e.runScheduled(opts);await ready();const child={...c.threads.get(c.nextThreadId),id:'scheduled-child',parentThreadId:c.nextThreadId,canAcceptDirectInput:false,status:{type:'active'},turns:[{id:'child-turn',status:'inProgress'}]};
        c.threads.set(child.id,child);c.familyPages.set('',{data:[child],nextCursor:null});
        c.emitMessage({method:'thread/started',params:{thread:child}});c.emitMessage({method:'turn/started',params:{threadId:child.id,turn:{id:'child-turn',status:'inProgress'}}});
        complete();let settled=false;void run.then(()=>{settled=true;});await tick();await tick();assert.equal(settled,false,'Root completion cannot release a running child');
        await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');
        child.status={type:'idle'};child.turns[0].status='completed';c.emitMessage({method:'turn/completed',params:{threadId:child.id,turn:{id:'child-turn',status:'completed'}}});
        assert.equal((await run).status,'completed');
      } finally {await e.close();}
    }
    {
      const {e,c,opts,ready,complete,project}=await fixture('unclassified-child');
      try {
        const run=e.runScheduled(opts);await ready();c.deferredFamilyPages=[];complete();
        await waitFor(()=>c.deferredFamilyPages.length===1);assert.equal(c.deferredFamilyPages.length,1);
        const childId='late-unclassified-child';c.deferredReads=new Map([[childId,[]]]);
        c.emitMessage({method:'turn/started',params:{threadId:childId,turn:{id:'late-child-turn',status:'inProgress'}}});
        await waitFor(()=>c.deferredReads.get(childId).length===1);assert.equal(c.deferredReads.get(childId).length,1);
        const oldPage=c.deferredFamilyPages[0];delete c.deferredFamilyPages;c.emitMessage({id:oldPage.id,result:{data:[],nextCursor:null}});
        assert.equal(await Promise.race([run.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),50))]),false,'Unclassified active discovery must block a stale empty family snapshot from releasing the lease');
        await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');
        const child={...c.threads.get(c.nextThreadId),id:childId,parentThreadId:c.nextThreadId,canAcceptDirectInput:false,status:{type:'active'},turns:[{id:'late-child-turn',status:'inProgress'}]};
        c.threads.set(childId,child);c.familyPages.set('',{data:[child],nextCursor:null});const discovery=c.deferredReads.get(childId)[0];delete c.deferredReads;
        c.emitMessage({id:discovery.id,result:{thread:child}});await tick();
        child.status={type:'idle'};child.turns[0].status='completed';c.emitMessage({method:'turn/completed',params:{threadId:childId,turn:{id:'late-child-turn',status:'completed'}}});
        assert.equal((await run).status,'completed');
      } finally {await e.close();}
    }
    {
      const {e,c,opts,ready,complete,project}=await fixture('approval');
      try {
        const run=e.runScheduled(opts);await ready();
        c.emitMessage({id:9180,method:'item/commandExecution/requestApproval',params:{threadId:c.nextThreadId,turnId:c.nextTurnId,itemId:'requires-approval',command:'outside scope',cwd:project}});await tick();
        assert.equal(c.calls.filter(q=>q.id===9180&&q.result?.decision==='decline').length,1);assert.equal(e.approvals.size,0);assert(!e.events.some(x=>x.method==='coding/approvalRequested'));
        assert(c.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId===c.nextThreadId));
        let settled=false;void run.then(()=>{settled=true;});await tick();assert.equal(settled,false,'An interrupt acknowledgement does not release a scheduled lease');
        await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');complete('interrupted');
        const result=await run;assert.equal(result.status,'needs-review');assert.match(result.message,/approval/);
      } finally {await e.close();}
    }
    {
      const {e,c,opts,ready,project}=await fixture('approval-failure');
      try {
        const run=e.runScheduled(opts);await ready();c.interruptError='interruption transport failed';
        c.emitMessage({id:9181,method:'item/commandExecution/requestApproval',params:{threadId:c.nextThreadId,turnId:c.nextTurnId,itemId:'requires-approval',command:'outside scope',cwd:project}});
        const result=await run;assert.equal(result.status,'needs-review','Approval remains a visible needs-review outcome if interruption fails');assert.match(result.message,/approval/);assert(!c.calls.some(q=>q.result?.decision==='accept'));
      } finally {await e.close();}
    }
    {
      const {e,c,opts,ready,complete,project}=await fixture('stop');
      try {
        const controller=new AbortController(),run=e.runScheduled({...opts,signal:controller.signal});await ready();
        const otherId='unrelated-foreground';c.threads.set(otherId,{...c.threads.get(c.nextThreadId),id:otherId,cwd:root,status:{type:'active'}});e.rememberThread(c.threads.get(otherId));e.runs.set(otherId,'unrelated-turn');
        const at=c.calls.length;controller.abort();await tick();
        assert(c.calls.slice(at).some(q=>q.method==='turn/interrupt'&&q.params.threadId===c.nextThreadId));assert(!c.calls.slice(at).some(q=>q.method==='turn/interrupt'&&q.params.threadId===otherId),'Scheduled Stop must preserve unrelated turns');
        c.emitMessage({method:'turn/completed',params:{threadId:c.nextThreadId,turn:{id:'obsolete-turn',status:'completed'}}});await tick();
        await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');
        complete('interrupted');assert.equal((await run).status,'interrupted');assert.equal(e.runs.get(otherId),'unrelated-turn');
      } finally {await e.close();}
    }
    {
      const {e,c,opts,ready,complete}=await fixture('quit-order');
      try {
        const controller=new AbortController(),run=e.runScheduled({...opts,signal:controller.signal});await ready();
        const rootThread=c.threads.get(c.nextThreadId);rootThread.status={type:'active'};rootThread.turns=[{id:c.nextTurnId,status:'inProgress'}];
        c.emitMessage({method:'turn/started',params:{threadId:c.nextThreadId,turn:{id:c.nextTurnId,status:'inProgress'}}});
        c.deferredReads=new Map([[c.nextThreadId,[]]]);
        const admissionRead=Promise.allSettled([e.thread(c.nextThreadId)]);
        controller.abort();const stopping=e.stop();
        await waitFor(()=>c.deferredReads.get(c.nextThreadId).length===2);assert.equal(c.deferredReads.get(c.nextThreadId).length,2,'Control verification must not reuse a pending admission read');
        const reads=c.deferredReads.get(c.nextThreadId),beforeInterrupt=structuredClone(rootThread);delete c.deferredReads;
        rootThread.status={type:'idle'};rootThread.turns[0].status='interrupted';complete('interrupted');
        for(const request of reads)c.emitMessage({id:request.id,result:{thread:beforeInterrupt}});await stopping;
        assert.equal((await admissionRead)[0].status,'rejected','Foreground metadata retains its Stop epoch guard');
        const result=await run;assert.equal(result.status,'interrupted',`Signal abort then global Stop must retain exact completion proof: ${JSON.stringify(result)}`);
        assert.equal(result.turnId,c.nextTurnId);assert.equal(c.killed,false,'Stop must not kill a healthy engine because its own epoch invalidated cancellation metadata');assert.equal(e.scheduled,null);
      } finally {await e.close();}
    }
    {
      const {e,c,opts,complete}=await fixture('late-admission');
      try {
        c.deferredTurns=[];const run=e.runScheduled(opts);await waitFor(()=>c.deferredTurns.length===1);assert.equal(c.deferredTurns.length,1);
        c.emitMessage({method:'turn/started',params:{threadId:c.nextThreadId,turn:{id:c.nextTurnId,status:'inProgress'}}});
        const stopped=e.stop();complete('interrupted');const request=c.deferredTurns[0];c.emitMessage({id:request.id,result:{turn:{id:c.nextTurnId,status:'inProgress'}}});await stopped;
        const result=await run;assert.equal(result.status,'interrupted',`Global Stop must retain observed exact completion across a late admission response: ${JSON.stringify(result)}`);assert.equal(result.turnId,c.nextTurnId);assert.equal(e.scheduled,null);
      } finally {await e.close();}
    }
    {
      const {e,c,opts}=await fixture('late-turn-callback');const originalTimeout=globalThis.setTimeout;let grace,recordedTurns=0;
      try {
        c.deferredTurns=[];const controller=new AbortController();const run=e.runScheduled({...opts,signal:controller.signal,onTurn:async()=>{recordedTurns++;}});
        await waitFor(()=>c.deferredTurns.length===1);assert.equal(c.deferredTurns.length,1);
        globalThis.setTimeout=(fn,ms,...args)=>{if(ms===10000){grace=fn;return originalTimeout(()=>{},ms);}return originalTimeout(fn,ms,...args);};controller.abort();assert(grace);grace();
        assert.equal((await run).status,'unknown');const request=c.deferredTurns[0];c.emitMessage({id:request.id,result:{turn:{id:c.nextTurnId,status:'inProgress'}}});await tick();await tick();
        assert.equal(recordedTurns,0,'A turn admission reply after terminal outcome must not revive it through onTurn');
      } finally {globalThis.setTimeout=originalTimeout;await e.close();}
    }
    {
      const {e,c,opts,ready,project}=await fixture('deadline');const originalTimeout=globalThis.setTimeout;let ceiling,grace;
      try {
        globalThis.setTimeout=(fn,ms,...args)=>{if(ms===30*60*1000){ceiling=fn;return originalTimeout(()=>{},ms);}if(ms===10000){grace??=fn;return originalTimeout(()=>{},ms);}return originalTimeout(fn,ms,...args);};
        const run=e.runScheduled(opts);await ready();assert(ceiling,'Background run must have a finite 30-minute ceiling');ceiling();await tick();assert(grace,'Interruption confirmation must be bounded');grace();
        const result=await run;assert.equal(result.status,'unknown');assert.match(result.message,/30-minute/);
        await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');
        c.emit('exit',1,null);await e.disposal;await tick();assert.equal(e.scheduled,null,'A timed-out retained lease releases only after its exact process exits');
      } finally {globalThis.setTimeout=originalTimeout;await e.close();}
    }
    {
      const {e,c,opts,ready,project}=await fixture('uncertain');
      try {
        const run=e.runScheduled(opts);await ready();const life=e.processLife;c.kill=()=>true;
        e.fail(new Error('synthetic transport loss'));assert.equal((await run).status,'unknown');
        await assert.rejects(e.handle({action:'start',cwd:project}),error=>error.code==='PROJECT_BUSY');assert.equal(life.exited,false);
        c.emit('exit',1,null);await e.disposal;assert.equal(e.scheduled,null,'Only actual process exit releases an uncertain lease');
      } finally {await e.close();}
    }
  }
  {
    const project=join(root,'managed-project');await mkdir(project);let replaced=false,checks=0;
    const guarded=new CodingEngine({dataDir:join(root,'managed-check-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',assertProject:async cwd=>{if(cwd===project){checks++;if(replaced)throw new Error('Managed checkout identity changed.');}}});
    try {
      await guarded.handle({action:'start',cwd:project});const child=children.at(-1);assert(checks>0,'Start must validate managed project ownership');
      replaced=true;const before=child.calls.length;
      for(const input of [{action:'start',cwd:project},{action:'send',threadId:'thread-1',text:'Edit the project'},{action:'review',threadId:'thread-1'},{action:'fork',threadId:'thread-1'},{action:'terminalStart',threadId:'thread-1',command:'pwd'},{action:'git',threadId:'thread-1'}])await assert.rejects(guarded.handle(input),/Managed checkout identity changed/);
      assert(!child.calls.slice(before).some(q=>['thread/start','thread/fork','thread/resume','turn/start','review/start','command/exec'].includes(q.method)),'Replaced managed project must never reach execution');
      assert.equal((await guarded.handle({action:'read',threadId:'thread-1'})).thread.id,'thread-1','Saved history remains readable without starting project work');
      replaced=false;await guarded.handle({action:'send',threadId:'thread-1',text:'Start'});
      const terminal=await guarded.handle({action:'terminalStart',threadId:'thread-1',command:'cat'});
      child.emitMessage({id:8700,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'managed-approval',command:'pwd',cwd:project}});await tick();
      const approval=[...guarded.approvals.values()][0];assert(approval);
      const continuations=[{action:'steer',threadId:'thread-1',turnId:'turn-1',text:'Continue'},{action:'terminalWrite',processId:terminal.processId,text:'input'},{action:'approval',id:approval.id,decision:'accept'}];
      replaced=true;const continuationStart=child.calls.length;
      for(const input of continuations)await assert.rejects(guarded.handle(input),/Managed checkout identity changed/,'Active work must revalidate its managed checkout');
      assert(!child.calls.slice(continuationStart).some(q=>['turn/steer','command/exec/write'].includes(q.method)||q.result?.decision==='accept'));
      assert(guarded.approvals.has(approval.id),'Failed validation does not consume the pending approval');
      replaced=false;
      for(const input of continuations.slice(0,2))await guarded.handle(input);
      const releases=[];guarded.assertProject=async()=>new Promise(resolve=>releases.push(resolve));
      const obsolete=Promise.allSettled(continuations.map(input=>guarded.handle(input)));await waitFor(()=>releases.length===3);assert.equal(releases.length,3);
      const originalSession=guarded.terminals.get(terminal.processId),obsoleteAt=child.calls.length;
      guarded.runs.set('thread-1','replacement-turn');guarded.terminals.set(terminal.processId,{...originalSession});guarded.approvals.set(approval.id,{...approval});
      for(const release of releases.splice(0))release();
      assert((await obsolete).every(r=>r.status==='rejected'),'Changed turn, process or approval identity must prevent delayed dispatch');
      assert(!child.calls.slice(obsoleteAt).some(q=>['turn/steer','command/exec/write'].includes(q.method)||q.result?.decision==='accept'));
      guarded.runs.set('thread-1','turn-1');guarded.terminals.set(terminal.processId,originalSession);guarded.approvals.set(approval.id,approval);
      const pending=continuations.map(input=>guarded.handle(input)),settled=Promise.allSettled(pending);await waitFor(()=>releases.length===3);assert.equal(releases.length,3);
      const stoppedAt=child.calls.length;const guardStop=guarded.stop();child.emitMessage({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}}});await guardStop;for(const release of releases)release();
      assert((await settled).every(r=>r.status==='rejected'&&/cancelled|expired|inactive|active/i.test(r.reason.message)),'Stop while identity validation waits must prevent all delayed dispatch');
      assert(!child.calls.slice(stoppedAt).some(q=>['turn/steer','command/exec/write'].includes(q.method)||q.result?.decision==='accept'));
      assert.equal(child.calls.filter(q=>q.id===8700&&q.result?.decision==='decline').length,1,'Stop still declines the pending approval exactly once');
    } finally {await guarded.close();}
  }
  {
    const a=join(root,'temp-project-a'),b=join(root,'temp-project-b');await mkdir(a);await mkdir(b);
    const tempEngine=new CodingEngine({dataDir:join(root,'temp-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    await tempEngine.handle({action:'start',cwd:a});const child=children.at(-1);
    const config=child.calls.find(q=>q.method==='thread/start').params.config;
    const scratch=config['shell_environment_policy.set.TMPDIR'];
    assert.equal(typeof scratch,'string','thread start must configure project-local temporary files');
    const advisory=child.calls.find(q=>q.method==='thread/start').params.baseInstructions;assert(advisory.includes('current TMPDIR environment variable'));assert(!advisory.includes('/.saleh-coding-tmp-'));
    assert.equal(await realpath(scratch),scratch);assert.equal(scratch.startsWith(a+'/.saleh-coding-tmp-'),true);assert.equal((await stat(scratch)).mode&0o777,0o700);
    const env={TMPDIR:scratch,TMP:scratch,TEMP:scratch,TMPPREFIX:join(scratch,'zsh')};
    for(const [key,value]of Object.entries(env))assert.equal(config['shell_environment_policy.set.'+key],value);
    child.threads=new Map([['a',{...child.thread,id:'a'}],['same-project',{...child.thread,id:'same-project'}],['b',{...child.thread,id:'b',cwd:b}],['b-two',{...child.thread,id:'b-two',cwd:b}]]);
    await tempEngine.handle({action:'terminalStart',threadId:'a',command:`cat <<EOF
hello
EOF`});
    assert.deepEqual(child.commandRequest.params.env,env);assert.deepEqual(child.commandRequest.params.sandboxPolicy.writableRoots,[a]);
    await tempEngine.handle({action:'fork',threadId:'a'});
    assert.equal(child.calls.find(q=>q.method==='thread/fork').params.config['shell_environment_policy.set.TMPDIR'],scratch);
    await tempEngine.handle({action:'send',threadId:'a',text:'resume'});
    assert.equal(child.calls.find(q=>q.method==='thread/resume').params.config['shell_environment_policy.set.TMPDIR'],scratch);
    assert.equal((await readdir(a)).filter(n=>n.startsWith('.saleh-coding-tmp-')).length,1);
    const originalMkdtemp=fsPromises.mkdtemp;let release,allocations=0;
    fsPromises.mkdtemp=async(...args)=>{if(args[0].startsWith(b+'/')){allocations++;await new Promise(r=>{release=r;});}return originalMkdtemp(...args);};syncBuiltinESMExports();
    try {
      const starts=['b','b-two'].map(threadId=>tempEngine.handle({action:'terminalStart',threadId,command:'pwd'}));
      const settled=Promise.allSettled(starts);await waitFor(()=>!!release);assert(release);assert.equal(allocations,1,'same-project allocation must be single-flight');
      const before=child.calls.filter(q=>q.method==='command/exec').length;const tempStop=tempEngine.stop();child.emitMessage({method:'turn/completed',params:{threadId:'a',turn:{id:'turn-a',status:'interrupted'}}});await tempStop;release();
      assert((await settled).every(r=>r.status==='rejected'&&/cancelled|Stop/i.test(r.reason.message)),'Stop cancels pending allocation dispatch');
      assert.equal(child.calls.filter(q=>q.method==='command/exec').length,before);
    } finally {fsPromises.mkdtemp=originalMkdtemp;syncBuiltinESMExports();}
    await tempEngine.handle({action:'terminalStart',threadId:'b',command:'pwd'});const other=child.commandRequest.params.env.TMPDIR;
    assert.notEqual(other,scratch);assert(other.startsWith(b+'/'));assert.equal((await readdir(b)).filter(n=>n.startsWith('.saleh-coding-tmp-')).length,1);
    const unknown=join(a,'.saleh-coding-tmp-unknown');await mkdir(unknown);
    child.kill=()=>{child.killed=true;return true;};
    const closing=tempEngine.close();await tick();await stat(scratch);await stat(other);
    child.emit('exit',0,null);await closing;
    await stat(scratch);await stat(other);await stat(unknown);
    const replaced=new CodingEngine({dataDir:join(root,'temp-replaced'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    await replaced.handle({action:'start',cwd:a});const replacedChild=children.at(-1),owned=replacedChild.calls.find(q=>q.method==='thread/start').params.config['shell_environment_policy.set.TMPDIR'];
    await rename(owned,owned+'-moved');await symlink(unknown,owned);
    const before=replacedChild.calls.length;await assert.rejects(replaced.handle({action:'terminalStart',threadId:'thread-1',command:'pwd'}),/temporary|identity/i);
    assert(!replacedChild.calls.slice(before).some(q=>q.method==='command/exec'),'replaced directory must not dispatch a command');
    await replaced.close();assert((await lstat(owned)).isSymbolicLink());await stat(owned+'-moved');await stat(unknown);
    assert(replaced.events.some(e=>e.method==='coding/error'&&/identity.*no cleanup was attempted/i.test(e.params.message)),'unverified scratch is reported without claiming it was preserved');
    const late=new CodingEngine({dataDir:join(root,'temp-late'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});await late.ensure();const lateChild=children.at(-1);let releaseLate;
    const scratchBeforeLate=(await readdir(b)).filter(n=>n.startsWith('.saleh-coding-tmp-')).length;
    fsPromises.mkdtemp=async(...args)=>{await new Promise(r=>{releaseLate=r;});return originalMkdtemp(...args);};syncBuiltinESMExports();
    try {
      const starting=late.handle({action:'start',cwd:b});const rejected=assert.rejects(starting,/cancelled|closed|Stop/i);await waitFor(()=>!!releaseLate);assert(releaseLate);
      const closing=late.close();await tick();releaseLate();await Promise.all([closing,rejected]);
      assert(!lateChild.calls.some(q=>q.method==='thread/start'),'late allocation cannot launch after close');assert.equal((await readdir(b)).filter(n=>n.startsWith('.saleh-coding-tmp-')).length,scratchBeforeLate+1,'late allocation is retained alongside prior scratch');
    } finally {fsPromises.mkdtemp=originalMkdtemp;syncBuiltinESMExports();}
    const swapTarget=join(root,'outside-project-swap-target');await mkdir(swapTarget,{mode:0o755});const targetMode=(await stat(swapTarget)).mode;let swappedPath;
    const operations=[];
    const swapped=new CodingEngine({dataDir:join(root,'temp-swap'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',temporaryOperation:async(action,input)=>{
      operations.push(action);const result=await fakeTemporaryOperation(action,input);
      if(action==='create'){swappedPath=result.path;await rename(swappedPath,swappedPath+'-moved');await symlink(swapTarget,swappedPath);}return result;
    }});
    await assert.rejects(swapped.handle({action:'start',cwd:b}),/temporary/i);assert(swappedPath);await swapped.close();
    assert.deepEqual(operations,['create','verify','verify'],'creation and identity verification go through the native helper; disposal must never request removal');
    assert.equal((await stat(swapTarget)).mode,targetMode,'engine never chmods a substituted directory outside the project');
    await assert.rejects(stat(join(swapTarget,'.saleh-owner')),{code:'ENOENT'},'engine never writes its marker through a substituted directory');
    const missingHelper=new NativeCodingEngine({dataDir:join(root,'temp-no-helper'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',nativeHelper:'',localModels});
    await assert.rejects(missingHelper.handle({action:'start',cwd:b}),/native helper.*unavailable/);await missingHelper.close();
    const unconfirmed=new CodingEngine({dataDir:join(root,'temp-unconfirmed'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    await unconfirmed.handle({action:'start',cwd:b});const unconfirmedChild=children.at(-1),leftover=unconfirmedChild.calls.find(q=>q.method==='thread/start').params.config['shell_environment_policy.set.TMPDIR'];
    const signals=[];unconfirmedChild.kill=signal=>{signals.push(signal);unconfirmedChild.killed=true;return true;};
    unconfirmed.fail(new Error('fixture failure'));await unconfirmed.disposal;assert.deepEqual(signals,['SIGTERM','SIGKILL']);await stat(leftover);
    assert.match(unconfirmed.message,/exit.*unconfirmed|exit.*confirm/i);await assert.rejects(unconfirmed.ensure(),/exit.*unconfirmed|exit.*confirm/i);await unconfirmed.close();
  }
  {
    const home=join(root,'migration'),migrate=new CodingEngine({dataDir:home});
    const generated=await migrate.configFile();
    assert.match(generated,/multi_agent = true/,'built-in agents must be explicitly enabled in app-owned configuration');
    const legacy=generated.replace('multi_agent = true\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 3\nexpose_spawn_agent_model_overrides = false','multi_agent = false')+'\n[projects."/fixture"]\ntrust_level = "trusted"\n[skills]\nconfig = []\n';
    await writeFile(join(home,'config.toml'),legacy);await writeFile(join(home,'.saleh-config.sha256'),createHash('sha256').update(legacy).digest('hex'));
    const upgraded=await migrate.configFile();assert.match(upgraded,/multi_agent = true/);assert(upgraded.endsWith('[skills]\nconfig = []\n'),'migration preserves app-owned trust and disabled skills');
    assert.equal((await readFile(join(home,'.saleh-config.sha256'),'utf8')).trim(),createHash('sha256').update(upgraded).digest('hex'));
    const changed=upgraded.replace('hooks = false','hooks = true');await writeFile(join(home,'config.toml'),changed);
    await assert.rejects(migrate.configFile(),/changed outside/);assert.equal(await readFile(join(home,'config.toml'),'utf8'),changed);
    await migrate.close();
  }
  for(const scenario of ['ready','exhausted','other-error','wrong-id','different-path','already-verified','no-discovery','changed-model','stop','replacement']){
    const e=new CodingEngine({dataDir:join(root,'metadata-'+scenario),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    try{
      await e.ensure();const child=children.at(-1),parent={id:'metadata-root',cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[],status:{type:'idle'}},nested={...parent,id:'metadata-child',parentThreadId:parent.id,canAcceptDirectInput:false};
      child.threads=new Map([[parent.id,parent],[nested.id,nested]]);await e.resolveFamily(parent.id);
      if(scenario==='already-verified')await e.resolveFamily(nested.id);
      const path=join(e.dataDir,'sessions','2026','10','13','rollout-2026-10-13T03-04-53-'+(scenario==='wrong-id'?'another-child':nested.id)+'.jsonl');
      const message=scenario==='other-error'?'failed to read thread: malformed session metadata':`failed to read thread: thread-store internal error: failed to read session metadata ${path}: rollout at ${scenario==='different-path'?path+'.other':path} is empty`;
      child.metadataReadErrors=new Map([[nested.id,Array(scenario==='exhausted'?9:1).fill(message)]]);
      const reads=()=>child.calls.filter(q=>q.method==='thread/read'&&q.params.threadId===nested.id).length,before=reads();
      if(scenario==='no-discovery'){await assert.rejects(e.thread(nested.id),/empty/);assert.equal(reads()-before,1);continue;}
      // Public protocol can announce an unknown child's status before its parent activity and durable header.
      child.emitMessage({method:'thread/status/changed',params:{threadId:nested.id,status:{type:'idle'}}});
      child.emitMessage({method:'item/started',params:{threadId:parent.id,turnId:'parent-turn',item:{id:'spawn-child',type:'subAgentActivity',kind:'started',agentThreadId:nested.id}}});
      const work=e.discoveries.get(nested.id);assert(work);await tick();
      if(scenario==='changed-model')nested.model='unreviewed-model';
      if(scenario==='stop')await e.stop();
      if(scenario==='replacement'){e.fail(new Error('Fixture process replacement'));await e.disposal;await e.ensure();}
      await work;
      if(scenario==='ready'){
        assert.equal(child.killed,false,'A newly observed empty child rollout must become readable without closing the peer engine');assert.equal(reads()-before,2);assert(e.verifiedThreads.has(nested.id));assert.equal(e.threadInfo.get(nested.id).parentThreadId,parent.id);assert.equal(e.threadInfo.get(nested.id).model,parent.model);
      }else if(['stop','replacement'].includes(scenario)){
        assert.equal(reads()-before,1,'Revoked discovery must not issue another metadata read');assert.equal(e.threadInfo.has(nested.id)&&e.verifiedThreads.has(nested.id),false);
        if(scenario==='stop')assert.equal(child.killed,false);else {const replacement=children.at(-1);assert.notEqual(replacement,child);assert.equal(replacement.killed,false);assert(!replacement.calls.some(q=>q.method==='thread/read'&&q.params.threadId===nested.id));}
      }else{
        assert.equal(child.killed,true,'Unsupported, previously verified, invalid or exhausted metadata still fails closed');assert.equal(reads()-before,scenario==='exhausted'?8:scenario==='changed-model'?2:1);
        if(scenario==='changed-model')assert.match(e.message,/differs from its parent/);else assert.match(e.message,/empty|malformed/);
      }
    }finally{await e.close();}
  }
  {
  const familyEngine=new CodingEngine({dataDir:join(root,'family'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await familyEngine.ensure();const familyChild=children.at(-1);
  const meta=(id,parent=null)=>({id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[],parentThreadId:parent,canAcceptDirectInput:parent?false:true,source:parent?{subAgent:{thread_spawn:{parent_thread_id:parent,depth:1,agent_path:'/root/child'}}}:'appServer',status:{type:'idle'}});
  const rmeta=meta('family-root'),cmeta=meta('family-child','family-root'),gmeta=meta('family-grandchild','family-child'),other=meta('unrelated');
  familyChild.threads=new Map([rmeta,cmeta,gmeta,other].map(t=>[t.id,t]));
  familyChild.familyPages=new Map([['family-root:',{data:[cmeta],nextCursor:'page2'}],['family-root:page2',{data:[gmeta],nextCursor:null}]]);
  const family=await familyEngine.handle({action:'family',threadId:'family-child'});
  assert.equal(family.rootThreadId,'family-root');assert.equal(family.threads[0].id,'family-child');assert.equal(family.nextCursor,'page2');assert.equal(family.stopping,false);
  assert.equal((await familyEngine.handle({action:'family',threadId:'family-root',cursor:'page2'})).threads[0].id,'family-grandchild');
  const beforeFamilyRefresh=familyEngine.events.filter(e=>e.method==='coding/family/updated').length;
  await familyEngine.handle({action:'family',threadId:'family-child'});
  assert.equal(familyEngine.events.filter(e=>e.method==='coding/family/updated').length,beforeFamilyRefresh,'reading unchanged family must not trigger an invalidation loop');
  cmeta.canAcceptDirectInput=null;
  for(const action of ['send','steer','review','fork','rename','archive','unarchive','terminalStart'])await assert.rejects(familyEngine.handle({action,threadId:'family-child',...({send:{text:'forbidden'},steer:{text:'forbidden',turnId:'ct'},rename:{name:'forbidden'},terminalStart:{command:'pwd'}}[action]??{})}),/child|direct input|read.only/i);
  const childGit=await familyEngine.handle({action:'git',threadId:'family-child'});assert.match(childGit.diff,/diff --git/,'child history permits inherited read-only Git inspection');
  cmeta.preview='p'.repeat(600000);cmeta.turns=[{id:'saved',status:'completed',items:[{id:'text',type:'agentMessage',text:'x'.repeat(600000)}]}];
  const childView=await familyEngine.handle({action:'read',threadId:'family-child'});
  assert.equal(childView.thread.parentThreadId,'family-root');assert.equal(childView.thread.canAcceptDirectInput,false,'child capability must survive clipped display metadata');
  cmeta.preview='';cmeta.turns=[];
  const event=(method,threadId,more)=>familyChild.emitMessage({method,params:{threadId,...more}});
  const started=(id,turnId)=>event('turn/started',id,{turn:{id:turnId,status:'inProgress',items:[]}});
  const finished=(id,turnId)=>event('turn/completed',id,{turn:{id:turnId,status:'interrupted',items:[]}});
  const activity=(parent,turnId,id)=>event('item/started',parent,{turnId,item:{id:`spawn-${id}`,type:'subAgentActivity',kind:'started',agentThreadId:id,agentPath:'/root/not-a-uuid'}});
  started('family-root','rt');started('family-child','ct');started('family-grandchild','gt');started('unrelated','ut');
  activity('family-root','rt','family-child');activity('family-child','ct','family-grandchild');await tick();
  const approval=(serverId,id,turnId)=>familyChild.emitMessage({id:serverId,method:'item/commandExecution/requestApproval',params:{threadId:id,turnId,itemId:`approval-${serverId}`,command:'pwd',cwd:root}});
  approval(8000,'family-child','ct');approval(8001,'unrelated','ut');await waitFor(()=>familyEngine.approvals.size>=2);
  assert(familyEngine.approvals.size>=2,JSON.stringify({message:familyEngine.message,runs:[...familyEngine.runs],events:familyEngine.events.slice(-5),responses:familyChild.calls.filter(q=>q.id>=8000)}));
  familyChild.emitMessage({id:8010,method:'item/commandExecution/requestApproval',params:{command:'x'.repeat(5000),cwd:root,threadId:'family-child',turnId:'ct',itemId:'approval-long'}});await tick();
  assert.equal((await familyEngine.handle({action:'events',after:familyEngine.sequence})).approvals.find(a=>a.params.itemId==='approval-long')?.params.threadId,'family-child','approval routing survives long command text before identity fields');
  familyChild.familyPages.set('family-child:',{data:[gmeta],nextCursor:null});
  await familyEngine.handle({action:'interruptFamily',threadId:'family-child'});
  assert(!familyChild.calls.some(q=>q.method==='turn/interrupt'&&['family-root','unrelated'].includes(q.params.threadId)),'child Stop cancels only its subtree, preserving parent and unrelated root');
  finished('family-root','rt');
  familyChild.deferredReads=new Map([['family-root',[]]]);
  const stoppingFamily=familyEngine.handle({action:'interruptFamily',threadId:'family-root'});await tick();
  assert(familyChild.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId==='family-child'),'known children must receive Stop before slow discovery completes');
  const stoppedReads=familyChild.deferredReads.get('family-root');familyChild.deferredReads=null;for(const q of stoppedReads)familyChild.emitMessage({id:q.id,result:{thread:rmeta}});
  const cancelled=await stoppingFamily;
  assert.equal(cancelled.targetThreadId,'family-root');assert.equal(cancelled.state,'stopping');
  const interrupted=()=>familyChild.calls.filter(q=>q.method==='turn/interrupt').map(q=>q.params.threadId);
  assert(interrupted().includes('family-child')&&interrupted().includes('family-grandchild'));assert(!interrupted().includes('unrelated'));
  assert.deepEqual(familyChild.calls.find(q=>q.id===8000)?.result,{decision:'decline'});assert([...familyEngine.approvals.values()].some(a=>a.params.threadId==='unrelated'));
  const held=meta('family-held','family-child');familyChild.threads.set(held.id,held);familyChild.deferredReads=new Map([[held.id,[]]]);
  started(held.id,'held-turn');approval(8003,held.id,'held-turn');await tick();
  assert(![...familyEngine.approvals.values()].some(a=>a.params.threadId===held.id),'unknown ancestry approval stays invisible');
  activity('family-child','ct',held.id);await tick();
  assert.deepEqual(familyChild.calls.find(q=>q.id===8003)?.result,{decision:'decline'},'Stop revokes held approval before deferred ancestry read completes');
  const heldReads=familyChild.deferredReads.get(held.id);familyChild.deferredReads=null;for(const q of heldReads)familyChild.emitMessage({id:q.id,result:{thread:held}});await waitFor(()=>!familyEngine.discoveries.has(held.id));finished(held.id,'held-turn');
  const late=meta('family-late','family-child');familyChild.threads.set(late.id,late);
  started(late.id,'lt');approval(8002,late.id,'lt');activity('family-child','ct',late.id);await waitFor(()=>interrupted().includes(late.id)&&familyChild.calls.some(q=>q.id===8002&&!q.method));
  assert(interrupted().includes(late.id),'late multilevel spawn is interrupted after its parent completed');assert.deepEqual(familyChild.calls.find(q=>q.id===8002)?.result,{decision:'decline'});
  finished('family-child','ct');finished('family-grandchild','gt');finished(late.id,'lt');await waitFor(()=>!familyEngine.familyStops.size);
  assert.equal((await familyEngine.handle({action:'family',threadId:'family-root'})).stopping,false,'observed completion clears stopping presentation while fence remains armed');
  await familyEngine.handle({action:'send',threadId:'family-root',text:'Fresh work'});
  const fresh=meta('family-fresh','family-root');familyChild.threads.set(fresh.id,fresh);activity('family-root','turn-family-root',fresh.id);started(fresh.id,'fresh-turn');await waitFor(()=>familyEngine.threadInfo.get(fresh.id)?.model);
  assert(!interrupted().includes(fresh.id),'fresh explicit parent turn does not inherit a completed Stop');
  event('item/started','family-root',{turnId:'turn-family-root',item:{id:'follow-child',type:'subAgentActivity',kind:'interacted',agentThreadId:'family-child'}});
  const beforeReuse=interrupted().filter(id=>id==='family-child').length;started('family-child','reused-turn');await tick();assert.equal(interrupted().filter(id=>id==='family-child').length,beforeReuse,'reused child follows the new parent turn after interacted activity');
  const old=meta('family-old-late','family-root');familyChild.threads.set(old.id,old);activity('family-root','rt',old.id);started(old.id,'old-turn');await waitFor(()=>interrupted().includes(old.id));
  assert(interrupted().includes(old.id),'old originating turn remains cancelled after new work begins');
  const activeFamily=(await familyEngine.handle({action:'status'})).activeTurns.find(t=>t.threadId===fresh.id);assert.equal(activeFamily.rootThreadId,'family-root');assert.equal(activeFamily.parentThreadId,'family-root');
  assert(familyEngine.events.some(e=>e.method==='coding/family/updated'&&e.params.rootThreadId==='family-root'));
  const idleRoot=meta('idle-root');familyChild.threads.set(idleRoot.id,idleRoot);await familyEngine.thread(idleRoot.id);started(idleRoot.id,'idle-turn');finished(idleRoot.id,'idle-turn');
  familyChild.loadedIds=[...familyChild.threads.keys()];const allFamilyStop=familyEngine.stop();for(const [id,turnId]of familyEngine.runs)if(turnId)finished(id,turnId);await allFamilyStop;
  const idleLate=meta('idle-late',idleRoot.id);familyChild.threads.set(idleLate.id,idleLate);started(idleLate.id,'idle-late-turn');activity(idleRoot.id,'idle-turn',idleLate.id);await waitFor(()=>interrupted().includes(idleLate.id));assert(interrupted().includes(idleLate.id),'global Stop fences late spawns from parents that just became idle');
  const globalLate=meta('global-late','family-root');familyChild.threads.set(globalLate.id,globalLate);started(globalLate.id,'global-late-turn');activity('family-root','turn-family-root',globalLate.id);await waitFor(()=>interrupted().includes(globalLate.id));assert(interrupted().includes(globalLate.id),'global Stop also cancels delayed descendants');
  await familyEngine.close();
  const restart=new CodingEngine({dataDir:join(root,'family'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});await restart.ensure();const restartedChild=children.at(-1);restartedChild.threads=familyChild.threads;restartedChild.familyPages=familyChild.familyPages;
  assert.equal((await restart.handle({action:'family',threadId:'family-grandchild'})).rootThreadId,'family-root','restart reconstructs ancestry from stored metadata without sessionId');assert.deepEqual((await restart.handle({action:'status'})).stoppingFamilies,[]);
  cmeta.status={type:'active'};cmeta.turns=[{id:'unobserved-child-turn',status:'inProgress',items:[]}];
  await restart.handle({action:'interruptFamily',threadId:cmeta.id});assert(restartedChild.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId===cmeta.id&&q.params.turnId==='unobserved-child-turn'),'selected active child is cancelled even before its live turn event arrives');
  cmeta.status={type:'idle'};cmeta.turns=[];
  const raced=meta('race-root');raced.status={type:'active'};raced.turns=[{id:'race-turn',status:'inProgress',items:[]}];restartedChild.threads.set(raced.id,raced);restartedChild.familyPages.set('race-root:',{data:[],nextCursor:null});restartedChild.historyBatch={before:[{method:'turn/completed',params:{threadId:raced.id,turn:{id:'race-turn',status:'completed',items:[]}}}]};
  await restart.handle({action:'interruptFamily',threadId:raced.id});assert(!restart.runs.has(raced.id),'completion before active-turn snapshot response cannot resurrect a completed run');
  restartedChild.threads.set('conflicting-child',{...meta('conflicting-child','family-root'),modelProvider:'saleh_cloud'});
  await assert.rejects(restart.handle({action:'family',threadId:'conflicting-child'}),/provider|model|project/);
  restartedChild.threads.set('cycle-a',meta('cycle-a','cycle-b'));restartedChild.threads.set('cycle-b',meta('cycle-b','cycle-a'));await assert.rejects(restart.handle({action:'family',threadId:'cycle-a'}),/family|ancestry/i);assert(!restart.threadInfo.has('cycle-b'),'rejected cycle must not poison cached ownership');
  restartedChild.threads.set('wrong-identity',meta('different-thread'));await assert.rejects(restart.handle({action:'read',threadId:'wrong-identity'}),/identity|isolated/);
  const oversized={preview:'x'.repeat(300000),...meta('long-child','family-root')};restartedChild.threads.set(oversized.id,oversized);restartedChild.familyPages=new Map([['',{data:[oversized],nextCursor:null}]]);
  const preserved=(await restart.handle({action:'family',threadId:'family-root'})).threads[0];assert.equal(preserved.parentThreadId,'family-root');assert.equal(preserved.canAcceptDirectInput,false);assert.equal(preserved.model,localConfig.model);assert.equal(preserved.cwd,root);
  restartedChild.familyPages=new Map([['',{data:[],nextCursor:'again'}],['again',{data:[],nextCursor:'again'}]]);
  await assert.rejects(restart.handle({action:'interruptFamily',threadId:'family-root'}),/cursor/);assert.equal(restartedChild.killed,true,'unconfirmed bounded family discovery closes shared engine');await restart.close();
  const ancestry=new CodingEngine({dataDir:join(root,'false-only-ancestry'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});await ancestry.ensure();const ancestryChild=children.at(-1);
  const unknown={...meta('false-only'),canAcceptDirectInput:false,turns:[{id:'unknown-turn',status:'inProgress',items:[]}]};delete unknown.parentThreadId;delete unknown.source;
  const parentOnly=meta('parent-only','family-root');delete parentOnly.source;
  const sourceOnly=meta('source-only','family-root');delete sourceOnly.parentThreadId;
  ancestryChild.threads=new Map([rmeta,unknown,parentOnly,sourceOnly].map(t=>[t.id,t]));ancestryChild.familyPages=new Map([['',{data:[parentOnly,sourceOnly],nextCursor:null}]]);
  assert.equal((await ancestry.handle({action:'read',threadId:unknown.id})).thread.canAcceptDirectInput,false,'direct history remains readable without promoting uncertain ancestry');
  await assert.rejects(ancestry.handle({action:'family',threadId:unknown.id}),/ancestry|parent/,'false-only metadata cannot become a verified root');assert(!ancestry.verifiedThreads.has(unknown.id));
  for(const id of [parentOnly.id,sourceOnly.id])assert.equal((await ancestry.handle({action:'family',threadId:id})).rootThreadId,rmeta.id,'either explicit parent or subAgent source verifies ancestry');
  ancestry.runs.set(unknown.id,'unknown-turn');ancestryChild.emitMessage({id:8500,method:'item/commandExecution/requestApproval',params:{threadId:unknown.id,turnId:'unknown-turn',itemId:'unknown-item',command:'pwd',cwd:root}});
  await waitFor(()=>ancestryChild.calls.some(q=>q.id===8500&&!q.method));assert.deepEqual(ancestryChild.calls.find(q=>q.id===8500)?.result,{decision:'decline'});assert.equal(ancestry.approvals.size,0);assert(!ancestry.verifiedThreads.has(unknown.id),'unscoped false-only approval never verifies a root');await ancestry.close();
  for(const discovery of ['unknown','changed-model','unrelated']){
    const e=new CodingEngine({dataDir:join(root,`child-stop-discovery-${discovery}`),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
    await e.ensure();const c=children.at(-1);let stop,discoveryWork;
    const release=()=>{const reads=c.deferredReads;c.deferredReads=null;for(const [id,requests]of reads??[])for(const q of requests)c.emitMessage({id:q.id,result:{thread:c.threads.get(id)}});};
    try{
      const parent=meta('stop-parent'),target=meta('stop-child',parent.id),peer=meta('stop-peer'),peerChild=meta('stop-peer-child',peer.id),unclassified=meta('stop-unclassified',target.id);
      c.threads=new Map([parent,target,peer,peerChild].map(t=>[t.id,t]));
      for(const t of c.threads.values())e.rememberThread(t);
      await e.resolveFamily(target.id,true);await e.resolveFamily(peerChild.id,true);
      if(discovery==='unknown'){
        const saved={threadInfo:e.threadInfo,verifiedThreads:e.verifiedThreads,discoveries:e.discoveries,discoveryQueue:e.discoveryQueue};
        const depth=length=>{for(let i=0;i<length;i++){const id=`guard-depth-${i}`;e.threadInfo.set(id,meta(id,i+1<length?`guard-depth-${i+1}`:null));e.verifiedThreads.add(id);}};
        const guards=[
          ['verified unrelated child',peerChild.id,false,()=>{}],
          ['selected child',target.id,true,()=>{}],
          ['selected descendant',unclassified.id,true,()=>{e.threadInfo.set(unclassified.id,unclassified);e.verifiedThreads.add(unclassified.id);}],
          ['unrelated root',peer.id,true,()=>{}],
          ['unknown child',unclassified.id,true,()=>{}],
          ['unverified child',peerChild.id,true,()=>e.verifiedThreads.delete(peerChild.id)],
          ['unverified ancestor',peerChild.id,true,()=>e.verifiedThreads.delete(peer.id)],
          ['missing ancestor',peerChild.id,true,()=>e.threadInfo.delete(peer.id)],
          ...['cwd','model','modelProvider'].map(key=>[`current ${key} mismatch`,peerChild.id,true,()=>e.threadInfo.set(peer.id,{...peer,[key]:`different-${key}`})]),
          ['source parent mismatch',peerChild.id,true,()=>e.threadInfo.set(peerChild.id,{...peerChild,source:meta('guard-source',target.id).source})],
          ['child-shaped root capability',peerChild.id,true,()=>e.threadInfo.set(peer.id,{...peer,canAcceptDirectInput:false})],
          ['child-shaped root source',peerChild.id,true,()=>e.threadInfo.set(peer.id,{...peer,source:{subAgent:{}}})],
          ['ancestry cycle',peerChild.id,true,()=>e.threadInfo.set(peer.id,meta(peer.id,peerChild.id))],
          ['32-node ancestry', 'guard-depth-0',false,()=>depth(32)],
          ['33-node ancestry', 'guard-depth-0',true,()=>depth(33)]
        ];
        for(const [name,id,pending,change]of guards)for(const lane of ['discoveries','discoveryQueue']){
          try{
            e.threadInfo=new Map(saved.threadInfo);e.verifiedThreads=new Set(saved.verifiedThreads);e.discoveries=new Map();e.discoveryQueue=new Set();change();
            assert.equal(e.discoveryPending(target.id),false);assert.equal(e.discoveryPending(),false);
            if(lane==='discoveries')e.discoveries.set(id,Promise.resolve());else e.discoveryQueue.add(id);
            assert.equal(e.discoveryPending(target.id),pending,`${lane}: ${name} scoped discovery guard`);
            assert.equal(e.discoveryPending(),true,`${lane}: ${name} must retain the global discovery fence`);
          }finally{Object.assign(e,saved);}
        }
      }
      const heldId=discovery==='unknown'?unclassified.id:peerChild.id;
      if(discovery==='unknown')c.threads.set(heldId,unclassified);
      if(discovery==='changed-model')e.rememberThread({...peerChild,model:'currently-incoherent-model'});
      c.deferredReads=new Map([[heldId,[]]]);e.discover(heldId);
      await waitFor(()=>c.deferredReads.get(heldId).length===1);assert.equal(c.deferredReads.get(heldId).length,1);
      discoveryWork=e.discoveries.get(heldId);assert(discoveryWork);
      assert.equal(e.verifiedThreads.has(heldId),discovery!=='unknown');
      assert.equal(e.rootFor(heldId),discovery==='unknown'?null:peer.id);assert.equal(e.within(heldId,target.id),false);
      if(discovery==='changed-model')assert.notEqual(e.threadInfo.get(heldId).model,e.threadInfo.get(peer.id).model,'Prior verification does not establish coherent current ancestry');
      for(const t of [parent,target,peer])c.emitMessage({method:'turn/started',params:{threadId:t.id,turn:{id:`turn-${t.id}`,status:'inProgress',items:[]}}});
      c.background=new Map([parent,target,peer].map(t=>[t.id,new Set([`command-${t.id}`])]));await tick();
      const life=e.processLife,ack=await e.interruptFamily(target.id);stop=e.familyStops.get(target.id);assert(stop);assert.equal(ack.state,'stopping');
      let settled=false,stopError;void stop.then(()=>{settled=true;},error=>{settled=true;stopError=error;});
      c.emitMessage({method:'turn/completed',params:{threadId:target.id,turn:{id:`turn-${target.id}`,status:'interrupted',items:[]}}});
      await waitFor(()=>c.background.get(target.id).size===0);assert.equal(c.background.get(target.id).size,0);
      assert.equal(e.runs.has(target.id),false);assert.equal(e.completedTurns.get(target.id),`turn-${target.id}`);
      if(discovery==='unrelated'){
        await waitFor(()=>settled);assert.equal(settled,true,'Selected child Stop must settle while verified unrelated child discovery remains held');assert.equal(stopError,undefined);
        assert(e.discoveries.has(heldId),'Child Stop must not cancel or consume unrelated discovery');
        assert.equal(e.discoveryPending(),true,'Global workspace and scheduled discovery fences remain pending');
      }else{
        await new Promise(resolve=>setTimeout(resolve,75));assert.equal(settled,false,`${discovery} discovery must keep child Stop fail-closed after its known command terminates`);
        release();await stop;
      }
      assert.equal(e.runs.get(parent.id),`turn-${parent.id}`);assert.equal(e.runs.get(peer.id),`turn-${peer.id}`);
      assert(c.background.get(parent.id).has(`command-${parent.id}`));assert(c.background.get(peer.id).has(`command-${peer.id}`));
      assert(!c.calls.some(q=>['turn/interrupt','thread/backgroundTerminals/terminate'].includes(q.method)&&[parent.id,peer.id,peerChild.id].includes(q.params.threadId)),'Selected Stop must not control parent or unrelated work');
      assert.equal(e.processLife,life);assert.equal(c.killed,false);assert(!e.events.some(event=>event.method==='coding/error'),'Discovery isolation must not trigger shared-engine failure');
    }finally{release();await Promise.allSettled([stop,discoveryWork].filter(Boolean));await e.close();}
  }
  children.length=0;calls.length=0;
  }
  const failureFanout=new CodingEngine({dataDir:join(root,'failure-fanout'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  const affected=Array.from({length:33},(_,i)=>({threadId:`failure-thread-${i}`,turnId:`failure-turn-${i}`}));
  for(const {threadId,turnId} of affected)failureFanout.runs.set(threadId,turnId);
  failureFanout.fail(new Error('Fixture shared-engine failure'));
  const failureEvents=failureFanout.events.filter(e=>e.method==='coding/error');
  assert.deepEqual(failureEvents.flatMap(e=>e.params.turns),affected,'a shared failure must report every affected chat exactly once');
  assert(failureEvents.every(e=>e.params.turns.length<=32),'failure notifications retain bounded batches');assert.equal(failureFanout.runs.size,0);
  const beforeEmptyFailure=failureFanout.sequence;failureFanout.fail(new Error('Fixture empty failure'));
  const emptyFailure=failureFanout.events.filter(e=>e.sequence>beforeEmptyFailure&&e.method==='coding/error');assert.equal(emptyFailure.length,1);assert.deepEqual(emptyFailure[0].params.turns,[]);
  await failureFanout.close();
  assert.equal((await engine.handle({action:'status'})).provider,'local');
  assert.equal(children.length,0,'status does not spawn');
  await assert.rejects(engine.handle({action:'config/write'}),/unsupported|unknown/i);
  await assert.rejects(engine.handle({action:'start',cwd:'relative'}),/absolute|directory/i);
  await assert.rejects(engine.handle({action:'start',cwd:root,provider:'openai'}),/cloud|provider/i);
  await assert.rejects(engine.handle({action:'send',threadId:'thread-1',text:' '}),/text/i);
  const started=await engine.handle({action:'start',cwd:root});
  assert.equal(started.thread.id,'thread-1');
  const child=children.at(-1);
  assert(child.args.includes('features.plugins=false'),'Execution engine must disable plugin startup before launch');
  assert.equal(child.options.cwd,'/private/var/empty','the app-server must not inherit an ambient writable data directory');
  assert.equal(child.options.env.CODEX_HOME,join(root,'state'));
  assert.equal(child.options.env.CODEX_SQLITE_HOME,undefined);
  assert.equal(child.options.env.OPENAI_API_KEY,undefined);
  assert.equal(child.options.env.ZDOTDIR,join(root,'state'));
  const launchGuard=new CodingEngine({dataDir:join(root,'writable-launch'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'}),originalAccess=fsPromises.access,childCount=children.length;
  try {
    fsPromises.access=async(path,mode)=>path==='/private/var/empty'&&mode===2?undefined:originalAccess(path,mode);syncBuiltinESMExports();
    await assert.rejects(launchGuard.handle({action:'list'}),/launch directory.*writable/i);
    assert.equal(children.length,childCount,'effective write access must block spawn even when ownership and Unix mode look safe');
  } finally {fsPromises.access=originalAccess;syncBuiltinESMExports();await launchGuard.close();}
  assert(calls.some(q=>q.method==='initialize'));
  assert(calls.some(q=>q.method==='skills/config/write'&&q.params.enabled===false));
  const start=calls.find(q=>q.method==='thread/start').params;
  assert.equal(start.config['features.plugins'],false,'Thread starts must retain disabled plugin startup');
  assert.equal(start.model,localConfig.model);assert.equal(start.modelProvider,'saleh_local');
  assert.equal(start.approvalPolicy,'on-request');assert.equal(start.sandbox,'workspace-write');
  assert.equal(start.approvalsReviewer,'user');
  assert.equal(start.allowProviderModelFallback,false);
  assert.equal(start.environments,undefined,'native local execution environment must remain available');
  assert.equal((await engine.handle({action:'list'})).threads.length,1);
  child.thread.path=join(root,'state','sessions','not-materialized.jsonl');
  child.unmaterialized=true;const empty=await engine.handle({action:'read',threadId:'thread-1'});assert.equal(empty.pendingMaterialization,true);assert.deepEqual(empty.thread.turns,[]);child.unmaterialized=false;
  assert.deepEqual((await engine.rolloutReceipts(child.thread)).receipts,[],'live polling tolerates a not-yet-persisted rollout');delete child.thread.path;
  child.cursorRace=true;
  const read=await engine.handle({action:'read',threadId:'thread-1'});
  assert(JSON.stringify(read.thread.turns).includes('after-snapshot'));assert(!(await engine.handle({action:'events',after:read.cursor})).events.some(e=>e.params.delta==='after-snapshot'),'Merged deltas must not replay twice');
  child.cursorRace=false;
  const liveEngine=new CodingEngine({dataDir:join(root,'live-history'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await liveEngine.handle({action:'start',cwd:root});const liveChild=children.at(-1);
  liveChild.threads=new Map(['a','b'].map(id=>[id,{id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[{id:`turn-${id}`,status:'inProgress',items:[]}]}]));
  const liveEvent=(method,threadId,params={})=>({method,params:{threadId,turnId:`turn-${threadId}`,...params}});
  const liveText=(threadId,delta)=>liveEvent('item/agentMessage/delta',threadId,{itemId:'message',delta});
  const readLive=id=>liveEngine.handle({action:'read',threadId:id});
  const textIn=result=>result.thread.turns.find(t=>t.id==='turn-a')?.items.find(i=>i.id==='message')?.text;
  const userItem=id=>({type:'userMessage',id,clientId:null,content:[{type:'text',text:'Identical intentional input',text_elements:[]}]});
  for(const [id,liveIds,savedIds,count] of [['single-user',['live-1'],['item-1'],1],['repeated-user',['live-1','live-2'],['item-1','item-2'],2],['steering-user',['live-1','live-2'],['item-1'],2],['live-only-user',['live-1','live-2'],[],2],['mixed-user',['live-1','live-2'],['live-2','item-1'],2]]){
    liveChild.threads.set(id,{id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[{id:`turn-${id}`,status:'inProgress',items:savedIds.map(userItem)}]});
    liveChild.emitMessage(liveEvent('turn/started',id,{turn:{id:`turn-${id}`,status:'inProgress',items:[]}}));
    for(const itemId of liveIds)liveChild.emitMessage(liveEvent('item/started',id,{item:userItem(itemId)}));
    const userHistory=await readLive(id);assert.equal(userHistory.thread.turns[0].items.filter(i=>i.type==='userMessage').length,count,`${id}: match differing user IDs one-to-one without dropping intentional repetition`);
    liveChild.emitMessage(liveEvent('turn/completed',id,{turn:{id:`turn-${id}`,status:'interrupted',items:[]}}));liveChild.threads.get(id).turns[0].status='interrupted';
    assert.equal((await readLive(id)).thread.turns[0].items.filter(i=>i.type==='userMessage').length,count,`${id}: the stopped snapshot has the same input multiplicity`);
  }
  const answerText='NATIVE_PARENT_USED NATIVE_CHILD_fdb3f5c05cbfa508';
  const agentItem=(id,extra={})=>({type:'agentMessage',id,text:answerText,phase:null,memoryCitation:null,delivery:null,questions:null,...extra});
  for(const [id,liveItems,savedItems,count] of [
    ['single-agent',[agentItem('msg_h6u406w4ukicnme20z3qf5')],[agentItem('item-2')],1],
    ['repeated-agent',[agentItem('msg-1'),agentItem('msg-2')],[agentItem('item-2'),agentItem('item-3')],2],
    ['mixed-agent',[agentItem('msg-1'),agentItem('msg-2')],[agentItem('msg-2'),agentItem('item-2')],2],
    ['unsaved-agent',[agentItem('msg-1'),agentItem('msg-2')],[agentItem('item-2')],2],
    ['partial-agent',[agentItem('msg-1',{text:'NATIVE_PARENT_USED'})],[agentItem('item-2')],2],
    ['phase-agent',[agentItem('msg-1',{phase:'commentary'})],[agentItem('item-2',{phase:'final_answer'})],2],
    ['delivery-agent',[agentItem('msg-1',{delivery:{type:'different'}})],[agentItem('item-2')],2],
  ]){
    liveChild.threads.set(id,{id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[{id:`turn-${id}`,status:'completed',items:savedItems}]});
    liveChild.emitMessage(liveEvent('turn/started',id,{turn:{id:`turn-${id}`,status:'inProgress',items:[]}}));
    for(const item of liveItems)liveChild.emitMessage(liveEvent('item/completed',id,{item}));
    liveChild.emitMessage(liveEvent('turn/completed',id,{turn:{id:`turn-${id}`,status:'completed',items:[]}}));
    const history=await readLive(id);assert.equal(history.thread.turns[0].items.filter(i=>i.type==='agentMessage').length,count,`${id}: reconcile differing assistant IDs one-to-one using full content and phase`);
    assert.equal((await readLive(id)).thread.turns[0].items.filter(i=>i.type==='agentMessage').length,count,`${id}: repeated reads preserve message multiplicity`);
  }
  for(const id of ['a','b']){
    liveChild.emitMessage(liveEvent('turn/started',id,{turn:{id:`turn-${id}`,status:'inProgress',items:[]}}));
    liveChild.emitMessage(liveEvent('item/started',id,{item:{id:'message',type:'agentMessage',text:''}}));
  }
  liveChild.emitMessage(liveText('a','The keeper'));liveChild.emitMessage(liveText('b','Other chat'));
  assert.equal(textIn(await readLive('a')),'The keeper','an omitted active item must hydrate the full consumed prefix');
  liveChild.historyBatch={after:[liveText('a',' climbed')]};
  const beforeSuffix=await readLive('a');
  assert.equal(textIn(beforeSuffix),'The keeper climbed','snapshot includes deltas received before the final synchronous merge');
  const suffix=liveEngine.events.filter(e=>e.sequence>beforeSuffix.cursor&&e.params.threadId==='a').map(e=>e.params.delta??'').join('');
  assert.equal(textIn(beforeSuffix)+suffix,'The keeper climbed','post-snapshot continuation must replay exactly once');
  assert.equal((await readLive('b')).thread.turns[0].items[0].text,'Other chat','live projections are isolated by thread, even with identical item IDs');
  liveChild.threads.get('a').turns[0].items=[{id:'message',type:'agentMessage',text:'The keeper climbed'}];
  assert.equal(textIn(await readLive('a')),'The keeper climbed','an already-present prefix must not be appended twice');
  liveChild.threads.get('a').historyMode='paginated';
  liveChild.threads.get('a').turns[0].items=[];
  assert.equal(textIn(await readLive('a')),'The keeper climbed','paginated reads preserve the same live projection');
  liveChild.threads.get('a').historyMode='legacy';
  liveChild.emitMessage(liveEvent('thread/name/updated','a',{threadName:'Renamed A'}));
  liveChild.emitMessage(liveEvent('thread/status/changed','a',{status:{type:'active',activeFlags:['waitingOnApproval']}}));
  liveChild.emitMessage(liveEvent('turn/plan/updated','a',{plan:[{step:'Inspect',status:'inProgress'}]}));
  liveChild.emitMessage(liveEvent('turn/diff/updated','a',{diff:'diff --git a/x b/x\n+new'}));
  liveChild.emitMessage(liveEvent('item/started','a',{item:{id:'command',type:'commandExecution',command:'printf marker',status:'inProgress',aggregatedOutput:''}}));
  liveChild.emitMessage(liveEvent('item/commandExecution/outputDelta','a',{itemId:'command',delta:'marker\n'}));
  liveChild.emitMessage(liveEvent('item/started','a',{item:{id:'summary',type:'reasoning',summary:[],content:['PRIVATE RAW']}}));
  liveChild.emitMessage(liveEvent('item/reasoning/summaryTextDelta','a',{itemId:'summary',summaryIndex:0,delta:'Checking the fixture'}));
  const display=await readLive('a'),displayTurn=display.thread.turns[0];
  assert.equal(display.thread.name,'Renamed A');assert.deepEqual(display.thread.status.activeFlags,['waitingOnApproval']);
  assert.equal(displayTurn.plan[0].step,'Inspect');assert.match(displayTurn.diff,/\+new/);
  assert.equal(displayTurn.items.find(i=>i.id==='command').aggregatedOutput,'marker\n');
  assert.deepEqual(displayTurn.items.find(i=>i.id==='summary').summary,['Checking the fixture']);assert(!JSON.stringify(display).includes('PRIVATE RAW'));
  assert.equal(liveEngine.items.get('a/command').item.aggregatedOutput,'','display deltas never mutate exact approval snapshots');
  liveChild.historyBatch={before:[liveEvent('item/completed','a',{item:{id:'message',type:'agentMessage',text:'Final authoritative text'}}),liveEvent('turn/completed','a',{turn:{id:'turn-a',status:'completed',items:[]}})]};
  const finished=await readLive('a');
  assert.equal(finished.thread.turns[0].status,'completed');assert.equal(textIn(finished),'Final authoritative text','completion during a read retains the authoritative full item');
  liveChild.threads.get('a').turns[0]={id:'turn-a',status:'completed',items:[{id:'message',type:'agentMessage',text:'Final authoritative text'}]};
  assert.equal(textIn(await readLive('a')),'Final authoritative text','durable completion is not duplicated');
  liveChild.threads.get('a').status={type:'idle'};
  liveChild.threads.get('a').turns[0].items=[{id:'message',type:'agentMessage',text:'Final'}, {id:'summary',type:'reasoning',summary:['Saved reasoning','Extra saved part']}];
  const authoritative=await readLive('a');
  assert.equal(textIn(authoritative),'Final','completed saved text is authoritative even when shorter than observed text');
  assert.deepEqual(authoritative.thread.turns[0].items.find(i=>i.id==='summary').summary,['Saved reasoning','Extra saved part'],'live summaries never discard extra durable parts');
  liveChild.emitMessage(liveEvent('turn/completed','b',{turn:{id:'turn-b',status:'interrupted',items:[]}}));
  liveChild.threads.get('b').turns[0]={id:'turn-b',status:'interrupted',items:[]};
  assert.equal((await readLive('b')).thread.turns[0].items[0].text,'Other chat','stopped partial output survives empty final snapshots');
  liveChild.emitMessage(liveText('b','late text after completion'));
  assert.equal((await readLive('b')).thread.turns[0].items[0].text,'Other chat','late deltas cannot alter a finished item');
  liveChild.emitMessage(liveEvent('turn/started','a',{turn:{id:'oversize-turn',status:'inProgress',items:[]}}));
  liveChild.emitMessage({method:'item/agentMessage/delta',params:{threadId:'a',turnId:'oversize-turn',itemId:'huge',delta:'x'.repeat(600000)}});
  const capped=await readLive('a');assert.equal(capped.historyTruncated,true,'live history bounds must report lost output');assert(JSON.stringify(capped).length<510000);
  liveChild.emitMessage({method:'item/agentMessage/delta',params:{threadId:'a',turnId:'oversize-turn',itemId:'huge',delta:'x'.repeat(240000)}});
  liveChild.emitMessage({method:'item/agentMessage/delta',params:{threadId:'a',turnId:'oversize-turn',itemId:'huge',delta:'x'.repeat(240000)}});
  liveChild.emitMessage({method:'turn/completed',params:{threadId:'a',turn:{id:'oversize-turn',status:'interrupted',items:[]}}});
  const boundedFinal=await readLive('a');assert.equal(boundedFinal.thread.turns.find(t=>t.id==='oversize-turn').status,'interrupted','exhausted content budget still preserves final control state');assert.equal(boundedFinal.historyTruncated,true);
  liveChild.emitMessage(liveEvent('turn/started','b',{turn:{id:'failed-turn',status:'inProgress',items:[]}}));
  liveChild.emitMessage({method:'item/agentMessage/delta',params:{threadId:'b',turnId:'failed-turn',itemId:'failed-message',delta:'Partial before failure'}});
  liveChild.emitMessage({method:'error',params:{threadId:'b',turnId:'failed-turn',error:{message:'Fixture error'},willRetry:false}});
  const failedView=await readLive('b'),failedTurn=failedView.thread.turns.find(t=>t.id==='failed-turn');
  assert.equal(failedTurn.status,'failed');assert.equal(failedTurn.error.message,'Fixture error');assert.equal(failedTurn.items[0].text,'Partial before failure');assert.equal(failedView.thread.status.type,'idle');
  liveChild.emitMessage(liveEvent('turn/started','b',{turn:{id:'capped-completion',status:'inProgress',items:[]}}));
  liveChild.emitMessage({method:'turn/completed',params:{turn:{items:[{text:'x'.repeat(300000),id:'large-final-item',type:'agentMessage'}],status:'interrupted',id:'capped-completion'},threadId:'b'}});
  const cappedCompletion=await readLive('b');assert.equal(cappedCompletion.thread.turns.find(t=>t.id==='capped-completion')?.status,'interrupted','display caps cannot discard final control fields placed after large content');assert.equal(cappedCompletion.historyTruncated,true);
  const completionEvent=liveEngine.events.findLast(e=>e.method==='turn/completed');assert.equal(completionEvent.params.threadId,'b');assert.equal(completionEvent.params.turn.id,'capped-completion');assert.equal(completionEvent.params.turn.status,'interrupted');assert.equal(completionEvent.params.turn.items[0].id,'large-final-item');assert.equal(completionEvent.truncated,true);
  liveEngine.push('coding/terminal/completed',{error:'e'.repeat(30000),processId:'terminal-control',threadId:'b',exitCode:1,truncated:true});
  const terminalControl=liveEngine.events.at(-1).params;assert.equal(terminalControl.threadId,'b');assert.equal(terminalControl.processId,'terminal-control');assert.equal(terminalControl.exitCode,1);assert.equal(terminalControl.truncated,true);
  liveEngine.push('error',{error:{message:'e'.repeat(30000)},willRetry:false,threadId:'b',turnId:'capped-completion'});
  const errorControl=liveEngine.events.at(-1).params;assert.equal(errorControl.willRetry,false);assert.equal(errorControl.threadId,'b');assert.equal(errorControl.turnId,'capped-completion');
  liveEngine.push('coding/error',{message:'e'.repeat(30000),turns:[{threadId:'b',turnId:'capped-completion'},{threadId:'pending',turnId:null}]});
  assert.deepEqual(liveEngine.events.at(-1).params.turns,[{threadId:'b',turnId:'capped-completion'},{threadId:'pending',turnId:null}]);
  liveChild.emitMessage(liveEvent('turn/started','thread-1',{turn:{id:'turn-thread-1',status:'inProgress',items:[]}}));liveChild.emitMessage(liveText('thread-1','Before rollout materializes'));liveChild.unmaterialized=true;
  const notMaterialized=await readLive('thread-1');assert.equal(notMaterialized.thread.turns[0]?.items[0]?.text,'Before rollout materializes','unmaterialized fallback also captures live state at the response boundary');liveChild.unmaterialized=false;
  await liveEngine.close();
  const partialDir=join(root,'partial-history'),partialFile=join(partialDir,'interrupted-history.json');
  const makePartial=()=>new CodingEngine({dataDir:partialDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  let partialEngine=makePartial();await partialEngine.handle({action:'start',cwd:root});let partialChild=children.at(-1);
  for(const [id,status] of [['a','interrupted'],['b','failed']]){
    partialChild.emitMessage(liveEvent('turn/started',id,{turn:{id:`turn-${id}`,status:'inProgress',items:[]}}));
    partialChild.emitMessage(liveText(id,`Visible ${id} prefix`));
    partialChild.emitMessage(liveEvent('item/started',id,{item:{id:'raw',type:'reasoning',summary:['Not persisted'],content:['SECRET RAW']}}));
    partialChild.emitMessage(liveEvent('turn/completed',id,{turn:{id:`turn-${id}`,status,items:[]}}));
  }
  await partialEngine.close();
  assert.equal((await stat(partialFile)).mode&0o777,0o600);
  const persisted=await readFile(partialFile,'utf8');assert(!persisted.includes('Not persisted')&&!persisted.includes('SECRET RAW'));assert(persisted.includes('Visible a prefix')&&persisted.includes('Visible b prefix'),'serialized simultaneous stops preserve both threads');
  partialEngine=makePartial();await partialEngine.handle({action:'start',cwd:root});partialChild=children.at(-1);
  partialChild.threads=new Map(['a','b'].map(id=>[id,{id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',status:{type:'idle'},turns:[{id:`turn-${id}`,status:id==='a'?'interrupted':'failed',items:[]}]}]));
  const restored=await partialEngine.handle({action:'read',threadId:'a'});
  assert.equal(textIn(restored),'Visible a prefix','a fresh engine restores stopped partial output omitted from saved rollout');assert.equal(restored.thread.status.type,'idle','sidecar cannot restore stale active metadata');
  assert.equal((await partialEngine.handle({action:'read',threadId:'b'})).thread.turns[0].items[0].text,'Visible b prefix');
  partialChild.threads.get('a').turns[0]={id:'turn-a',status:'completed',items:[{id:'message',type:'agentMessage',text:'Saved final'}]};
  assert.equal(textIn(await partialEngine.handle({action:'read',threadId:'a'})),'Saved final','saved complete history wins over a restored partial');
  await partialEngine.close();
  assert(!(await readFile(partialFile,'utf8')).includes('Visible a prefix'),'durably replaced partials retire from the sidecar');
  const badUtf8=Buffer.concat([Buffer.from('{"version":1,"truncated":false,"threads":[{"id":"a","turns":[{"id":"t","status":"interrupted","items":[{"id":"m","type":"agentMessage","text":"'),Buffer.from([0xff]),Buffer.from('"}]}]}]}')]);
  for(const [label,bad] of [['corrupt','{broken'],['oversize','x'.repeat(1048577)],['utf8',badUtf8],['schema',JSON.stringify({version:1,truncated:false,threads:[{id:'a',turns:[{id:'turn-a',status:'inProgress',items:[]}]}]})]]){
    const dataDir=join(root,`bad-partial-${label}`);await mkdir(dataDir);const file=join(dataDir,'interrupted-history.json');await writeFile(file,bad);
    const invalid=new CodingEngine({dataDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});await invalid.handle({action:'start',cwd:root});
    const warning=await invalid.handle({action:'read',threadId:'thread-1'});assert.match(warning.historyWarning,/partial.*history/i);assert.equal(warning.historyTruncated,true);
    const invalidChild=children.at(-1);invalidChild.emitMessage(liveEvent('turn/started','thread-1',{turn:{id:'turn-thread-1',status:'inProgress',items:[]}}));invalidChild.emitMessage(liveText('thread-1','Do not overwrite evidence'));invalidChild.emitMessage(liveEvent('turn/completed','thread-1',{turn:{id:'turn-thread-1',status:'interrupted',items:[]}}));
    await invalid.close();assert.deepEqual(await readFile(file),Buffer.from(bad),'untrusted partial history is preserved unchanged');
  }
  const failingDir=join(root,'partial-write-failure'),failing=new CodingEngine({dataDir:failingDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await failing.handle({action:'start',cwd:root});const failingChild=children.at(-1);await mkdir(join(failingDir,'interrupted-history.json'));
  let releaseWrite;failing.historyWrite=new Promise(resolve=>{releaseWrite=resolve;});
  failingChild.emitMessage(liveEvent('turn/started','thread-1',{turn:{id:'turn-thread-1',status:'inProgress',items:[]}}));failingChild.emitMessage(liveText('thread-1','Unsaved partial'));
  failingChild.emitMessage(liveEvent('turn/completed','thread-1',{turn:{id:'turn-thread-1',status:'interrupted',items:[]}}));
  let readFinished=false;const failedSaveRead=failing.handle({action:'read',threadId:'thread-1'}).then(value=>{readFinished=true;return value;});
  await tick();assert.equal(readFinished,false,'completion read waits for its pending save outcome');releaseWrite();
  const failedSave=await failedSaveRead;assert.match(failedSave.historyWarning,/could not be saved/i);assert.equal(failedSave.historyTruncated,true);await failing.close();
  const capDir=join(root,'partial-total-cap'),capEngine=new CodingEngine({dataDir:capDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await capEngine.handle({action:'start',cwd:root});const capChild=children.at(-1);
  for(let i=0;i<5;i++){const id=`cap-${i}`;capChild.emitMessage(liveEvent('turn/started',id,{turn:{id:`turn-${id}`,status:'inProgress',items:[]}}));capChild.emitMessage(liveText(id,'x'.repeat(230000)));capChild.emitMessage(liveEvent('turn/completed',id,{turn:{id:`turn-${id}`,status:'interrupted',items:[]}}));}
  await capEngine.close();const capBytes=await readFile(join(capDir,'interrupted-history.json')),capDocument=JSON.parse(capBytes);
  assert(capBytes.length<=1048576);assert.equal(capDocument.truncated,true);assert(capDocument.threads.some(t=>t.id==='cap-4'),'the total cap keeps the most recent stopped reply');
  const git=await engine.handle({action:'git',threadId:'thread-1'});
  assert.equal(git.branch,'main');assert(git.status.includes('new.txt'));assert(git.diff.includes('Staged changes:'));
  assert(child.calls.filter(q=>q.method==='command/exec'&&!q.params.processId).every(q=>q.params.sandboxPolicy.type==='readOnly'&&q.params.sandboxPolicy.networkAccess===false));
  const sent=await engine.handle({action:'send',threadId:'thread-1',text:'Hello',effort:'none'});
  assert.equal(sent.turn.id,'turn-1');
  assert.equal(calls.find(q=>q.method==='turn/start').params.environments,undefined);
  await assert.rejects(engine.handle({action:'send',threadId:'thread-1',text:'Again'}),/steer|running|active/i);
  await assert.rejects(engine.handle({action:'interrupt',threadId:'thread-1',turnId:'stale'}),/stale|active/i);
  const params={threadId:'thread-1',turnId:'turn-1',itemId:'item-1',startedAtMs:1,command:'pwd',cwd:root};
  child.emitMessage({id:900,method:'item/commandExecution/requestApproval',params}); await tick();
  let events=await engine.handle({action:'events',after:0});
  assert.equal(events.approvals.length,1);
  const approval=events.approvals[0];
  assert.deepEqual((await engine.handle({action:'approvalInfo',id:approval.id})).params,params);
  await assert.rejects(engine.handle({action:'approval',id:approval.id,decision:'acceptForSession'}),/decision/i);
  await engine.handle({action:'approval',id:approval.id,decision:'accept'});
  assert.deepEqual(child.calls.find(q=>q.id===900).result,{decision:'accept'});
  await assert.rejects(engine.handle({action:'approval',id:approval.id,decision:'accept'}),/expired|pending|unknown/i);
  child.emitMessage({id:901,method:'item/tool/requestUserInput',params:{}}); await tick();
  assert(child.calls.find(q=>q.id===901).error,'unsupported requests are explicitly rejected');
  child.emitMessage({id:902,method:'item/fileChange/requestApproval',params}); await tick();
  assert.deepEqual(child.calls.find(q=>q.id===902)?.result,{decision:'decline'},'file approval without exact item is denied');
  child.emitMessage({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'item-1',type:'fileChange',changes:[{path:'x.txt',diff:'+new',kind:{type:'update'}}]}}});
  child.emitMessage({id:903,method:'item/fileChange/requestApproval',params}); await tick();
  const pending=(await engine.handle({action:'events',after:0})).approvals[0];
  assert.equal((await engine.handle({action:'approvalInfo',id:pending.id})).item.changes[0].diff,'+new');
  await assert.rejects(engine.handle({action:'reloadProviders'}),/busy|active|running/i);
  child.emitMessage({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}}); await tick();
  await assert.rejects(engine.handle({action:'approvalInfo',id:pending.id}),/expired|pending|unknown/i);
  child.completeBeforeResponse=true;
  await engine.handle({action:'send',threadId:'thread-1',text:'Quick turn'});
  assert.equal((await engine.handle({action:'status'})).running,false,'delayed start reply must not resurrect completed turn');
  await engine.handle({action:'send',threadId:'thread-1',text:'Next quick turn'});
  child.completeBeforeResponse=false;
  for(let i=0;i<1010;i++) child.emitMessage({method:'item/agentMessage/delta',params:{threadId:'thread-1',delta:'x'.repeat(i===1009?100000:1)}});
  child.emitMessage({method:'item/reasoning/rawContentDelta',params:{delta:'do not surface'}}); await tick();
  events=await engine.handle({action:'events',after:0});
  assert.equal(events.gap,true);assert(events.events.length<=1000);
  assert(events.events.every(e=>JSON.stringify(e).length<70000));
  assert(!JSON.stringify(events.events).includes('do not surface'));
  const terminal=await engine.handle({action:'terminalStart',threadId:'thread-1',command:'pwd'});
  assert.deepEqual(child.commandRequest.params.command,['/bin/zsh','-f','-c','pwd']);
  const outputCursor=(await engine.handle({action:'events',after:0})).cursor;
  const unicode=Buffer.from('م🌊');
  for(const bytes of [unicode.subarray(0,1),unicode.subarray(1,4),unicode.subarray(4)])child.emitMessage({method:'command/exec/outputDelta',params:{processId:terminal.processId,stream:'stdout',deltaBase64:bytes.toString('base64'),capReached:false}});
  await tick();
  assert.equal((await engine.handle({action:'events',after:outputCursor})).events.filter(e=>e.method==='coding/terminal/output').map(e=>e.params.output).join(''),'م🌊','split UTF-8 output is decoded across chunks');
  assert.equal(child.commandRequest.params.sandboxPolicy.networkAccess,false);
  assert.deepEqual(child.commandRequest.params.sandboxPolicy.writableRoots,[root]);
  await engine.handle({action:'terminalWrite',processId:terminal.processId,text:'abc'});
  assert.equal(calls.find(q=>q.method==='command/exec/write').params.deltaBase64,'YWJj');
  await assert.rejects(engine.handle({action:'terminalWrite',processId:terminal.processId,text:'x'.repeat(16001)}),/text|size|long|bytes/i);
  await engine.handle({action:'send',threadId:'thread-1',text:'second'});
  const engineStop=engine.stop();child.emitMessage({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}}});await engineStop;
  assert(calls.some(q=>q.method==='turn/interrupt'));assert(calls.some(q=>q.method==='command/exec/terminate'));
  assert.equal((await engine.handle({action:'events',after:0})).approvals.length,0);
  assert.equal(child.killed,false,'Stop keeps history process alive');
  await assert.rejects(engine.handle({action:'terminalWrite',processId:terminal.processId,text:'late'}),/active|owned/i);
  child.emitMessage({id:child.commandRequest.id,result:{exitCode:0,stdout:'',stderr:''}}); await tick();
  child.stdout.write('not-json\n');await tick();
  assert(child.killed,'malformed protocol terminates process');
  await engine.close();
  await writeFile(join(root,'state','providers.json'),JSON.stringify({cloud:{name:'Cloud coding',baseURL:'https://api.example.com/v1',model:'chosen-model'}}));
  const providers=(await engine.handle({action:'status'})).providers;assert.equal(providers.find(p=>p.id==='cloud').model,'chosen-model');
  const next=new CodingEngine({dataDir:join(root,'oversized'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await next.handle({action:'list'});const oversized=children.at(-1);
  oversized.stdout.write('x'.repeat(41*1024*1024));await tick();
  assert(oversized.killed,'oversize protocol terminates process');await next.close();
  const dying=new CodingEngine({dataDir:join(root,'dying'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await dying.handle({action:'list'});const dyingChild=children.at(-1);
  dyingChild.stdin._write=(_c,_e,done)=>done();
  const blocked=dying.handle({action:'read',threadId:'thread-1'});
  await tick();dyingChild.emit('exit',1,null);
  await assert.rejects(blocked,/exit|closed|process/i);await dying.close();
  const cloudDir=join(root,'cloud');
  const cloud=new CodingEngine({dataDir:cloudDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',readCloudKey:async()=>'fake-test-credential'});
  await cloud.configFile();
  await writeFile(join(cloudDir,'providers.json'),JSON.stringify({cloud:{name:'Cloud coding',baseURL:'https://api.example.com/v1',model:'chosen-model'}}));
  await cloud.handle({action:'start',cwd:root,provider:'cloud'});
  const cloudChild=children.at(-1);
  assert.equal(cloudChild.options.env.SALEH_CODING_CLOUD_KEY,'fake-test-credential');
  assert(cloudChild.args.includes('shell_environment_policy.exclude=["SALEH_CODING_LOCAL_KEY","SALEH_CODING_CLOUD_KEY"]'));
  assert.equal(cloudChild.calls.find(q=>q.method==='thread/start').params.modelProvider,'saleh_cloud');
  await cloud.handle({action:'send',threadId:'thread-1',text:'Cloud message'});
  assert.equal(cloudChild.calls.find(q=>q.method==='turn/start').params.model,'chosen-model');
  assert(!JSON.stringify(await cloud.handle({action:'status'})).includes('fake-test-credential'));
  await cloud.close();
  const unavailable=new CodingEngine({dataDir:cloudDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',readCloudKey:async()=>{throw new Error('locked');}});
  await unavailable.handle({action:'start',cwd:root});
  assert.equal(children.at(-1).options.env.SALEH_CODING_CLOUD_KEY,undefined);
  assert.equal((await unavailable.handle({action:'status'})).providers.find(p=>p.id==='cloud').available,false);
  await assert.rejects(unavailable.handle({action:'start',cwd:root,provider:'cloud'}),/cloud|provider/i);
  await unavailable.close();
  let releaseKey;
  const delayedKey=new Promise(resolve=>{releaseKey=resolve;});
  const closing=new CodingEngine({dataDir:cloudDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1',readCloudKey:()=>delayedKey});
  const before=children.length;
  const starting=closing.handle({action:'list'});await tick();await closing.close();releaseKey('fake-test-credential');
  await assert.rejects(starting,/closed|cancelled/i);
  assert.equal(children.length,before,'close prevents an in-flight launch from creating a new subprocess');
  const trustDir=join(root,'trust-home');
  const makeTrust=()=>new CodingEngine({dataDir:trustDir,binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  const trusted=makeTrust();await trusted.handle({action:'start',cwd:root});await trusted.close();
  const reopened=makeTrust();await reopened.handle({action:'list'});await reopened.close();
  const configPath=join(trustDir,'config.toml');
  await writeFile(configPath,(await readFile(configPath,'utf8')).replace('hooks = false','hooks = true'));
  const altered=makeTrust();await assert.rejects(altered.handle({action:'list'}),/configuration changed/i);await altered.close();
  const project=join(root,'inherited-config');await mkdir(join(project,'.codex'),{recursive:true});
  await writeFile(join(project,'.codex','config.toml'),'[mcp_servers.unexpected]\ncommand = "do-not-run"\n');
  const protectedEngine=new CodingEngine({dataDir:join(root,'protected-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await assert.rejects(protectedEngine.handle({action:'start',cwd:project}),/project.*config|\.codex/i);
  assert(!children.at(-1).calls.some(q=>q.method==='thread/start'));
  await protectedEngine.close();
  const hiddenProject=join(root,'hidden-project');await mkdir(hiddenProject);
  projectLayers.set(hiddenProject,[{name:{type:'project',dotCodexFolder:join(hiddenProject,'.codex')},config:{},disabledReason:'untrusted project'}]);
  const hiddenEngine=new CodingEngine({dataDir:join(root,'hidden-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await assert.rejects(hiddenEngine.handle({action:'start',cwd:hiddenProject}),/project.*config|\.codex/i);
  assert(!children.at(-1).calls.some(q=>q.method==='thread/start'));await hiddenEngine.close();
  const missingProject=join(root,'missing-inventory');await mkdir(missingProject);projectLayers.set(missingProject,'missing');
  const missingEngine=new CodingEngine({dataDir:join(root,'missing-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await assert.rejects(missingEngine.handle({action:'start',cwd:missingProject}),/layer|inventory/i);
  assert(!children.at(-1).calls.some(q=>q.method==='thread/start'));await missingEngine.close();
  const cancelEngine=new CodingEngine({dataDir:join(root,'cancel-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await cancelEngine.handle({action:'start',cwd:root});await cancelEngine.handle({action:'send',threadId:'thread-1',text:'Pending start'});
  const cancelChild=children.at(-1);cancelChild.rejectInterruptOnce=true;
  const cancellation=await cancelEngine.handle({action:'interrupt',threadId:'thread-1',turnId:'turn-1'});
  assert.match(cancellation.message,/queued|interruption requested/i);assert.equal(cancelChild.killed,false);
  cancelChild.emitMessage({id:990,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'late-item',command:'pwd',cwd:root,startedAtMs:1}});await tick();
  assert.deepEqual(cancelChild.calls.find(q=>q.id===990)?.result,{decision:'decline'},'late approvals after Stop are declined');
  const interruptCalls=()=>cancelChild.calls.filter(q=>q.method==='turn/interrupt');
  cancelChild.emitMessage({method:'turn/started',params:{threadId:'other-thread',turn:{id:'other-turn'}}});await tick();
  assert.equal(interruptCalls().length,1,'another thread is not cancelled');
  cancelChild.emitMessage({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});await tick();
  assert.equal(interruptCalls().length,2);assert.equal(interruptCalls()[1].params.turnId,'turn-1');
  cancelChild.emitMessage({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}}});
  await waitFor(()=>!cancelEngine.familyStops.size);cancelChild.nextTurnId='turn-next';await cancelEngine.handle({action:'send',threadId:'thread-1',text:'Explicit fresh work'});
  cancelChild.emitMessage({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-next'}}});await tick();
  assert.equal(interruptCalls().length,2,'later turns do not inherit cancellation');
  cancelChild.interruptError='unexpected interruption failure';
  await assert.rejects(cancelEngine.handle({action:'interrupt',threadId:'thread-1',turnId:'turn-next'}),/unexpected interruption failure/);
  assert.equal(cancelChild.killed,true,'unexpected interruption failures close the process');await cancelEngine.close();
  const concurrent=new CodingEngine({dataDir:join(root,'concurrent-home'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await concurrent.handle({action:'start',cwd:root});const concurrentChild=children.at(-1);
  concurrentChild.threads=new Map(['a','b'].map(id=>[id,{id,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[]}]));
  await Promise.all(['a','b'].map(threadId=>concurrent.handle({action:'send',threadId,text:`Work in ${threadId}`})));
  await assert.rejects(concurrent.handle({action:'send',threadId:'a',text:'Duplicate'}),/running|active|steer/i);
  assert.deepEqual((await concurrent.handle({action:'status'})).activeTurns.map(({threadId,turnId})=>({threadId,turnId})).sort((a,b)=>a.threadId.localeCompare(b.threadId)),[{threadId:'a',turnId:'turn-a'},{threadId:'b',turnId:'turn-b'}],'status exposes simultaneous threads');
  const heldReads=[];concurrentChild.deferredReads=new Map([['a',heldReads]]);
  concurrentChild.emitMessage({method:'item/agentMessage/delta',params:{threadId:'b',turnId:'turn-b',delta:'B is streaming'}});await tick();
  const promptPoll=await Promise.race([concurrent.handle({action:'events',after:0}),tick().then(()=>null)]);
  assert(promptPoll?.events.some(e=>e.params.delta==='B is streaming'),'a stalled A receipt refresh cannot delay buffered B events');
  await concurrent.handle({action:'events',after:promptPoll.cursor});
  assert.equal(heldReads.length,1,'repeated polls keep one refresh in flight per thread');
  concurrentChild.emitMessage({id:heldReads[0].id,error:{code:-32000,message:'A history unavailable'}});await tick();
  const errorPoll=await concurrent.handle({action:'events',after:promptPoll.cursor});
  assert(errorPoll.events.some(e=>e.method==='coding/receiptError'&&e.params.threadId==='a'),'receipt failures stay thread-scoped');
  concurrentChild.deferredReads.delete('a');for(const q of heldReads.slice(1))concurrentChild.emitMessage({id:q.id,result:{thread:concurrentChild.threads.get('a')}});await tick();
  const bTerminal=await concurrent.handle({action:'terminalStart',threadId:'b',command:'read value'});
  concurrentChild.emitMessage({id:992,method:'item/commandExecution/requestApproval',params:{threadId:'b',turnId:'turn-b',itemId:'b-approval',command:'pwd',cwd:root}});await tick();
  const bApproval=(await concurrent.handle({action:'events',after:0})).approvals.find(a=>a.params.threadId==='b');
  await concurrent.handle({action:'interrupt',threadId:'a',turnId:'turn-a'});
  concurrentChild.emitMessage({method:'turn/completed',params:{threadId:'a',turn:{id:'turn-a',status:'interrupted'}}});await tick();
  assert.deepEqual((await concurrent.handle({action:'status'})).activeTurns.map(({threadId,turnId})=>({threadId,turnId})),[{threadId:'b',turnId:'turn-b'}]);
  assert.equal((await concurrent.handle({action:'approvalInfo',id:bApproval.id})).params.threadId,'b');
  assert((await concurrent.handle({action:'status'})).terminals.some(t=>t.processId===bTerminal.processId));
  assert(!concurrentChild.calls.some(q=>q.method==='turn/interrupt'&&q.params.threadId==='b'),'selected Stop never interrupts B');
  await waitFor(()=>!concurrent.familyStops.size);await concurrent.handle({action:'send',threadId:'a',text:'Restart A'});
  concurrentChild.deferredInterrupts=[];
  const stopping=concurrent.stop();
  const secondStop=concurrent.stop();
  await assert.rejects(concurrent.handle({action:'send',threadId:'c',text:'Too soon'}),/stopping|stop.*progress/i);
  await assert.rejects(concurrent.handle({action:'terminalStart',threadId:'b',command:'pwd'}),/stopping|stop.*progress/i);
  concurrentChild.emitMessage({id:991,method:'item/commandExecution/requestApproval',params:{threadId:'a',turnId:'turn-a',itemId:'late',command:'touch marker',cwd:root}});await tick();
  assert.deepEqual(concurrentChild.calls.find(q=>q.id===991)?.result,{decision:'decline'},'global Stop declines late approvals for known turns');
  assert.equal(concurrentChild.deferredInterrupts.length,2,'overlapping global Stops share exact interruptions');
  for(const q of concurrentChild.deferredInterrupts){concurrentChild.emitMessage({id:q.id,result:{}});concurrentChild.emitMessage({method:'turn/completed',params:{threadId:q.params.threadId,turn:{id:q.params.turnId,status:'interrupted'}}});}
  await Promise.all([stopping,secondStop]);
  assert.deepEqual((await concurrent.handle({action:'status'})).activeTurns.map(({threadId,turnId})=>({threadId,turnId})),[]);
  concurrentChild.deferredInterrupts=null;
  await concurrent.handle({action:'send',threadId:'b',text:'A fresh turn after Stop'});
  assert.equal((await concurrent.handle({action:'status'})).activeTurns[0].threadId,'b');
  await concurrent.close();
  const boundedRefresh=new CodingEngine({dataDir:join(root,'bounded-refresh'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  await boundedRefresh.handle({action:'start',cwd:root});const boundedChild=children.at(-1);
  boundedChild.threads=new Map(Array.from({length:6},(_,i)=>[`reader-${i}`,{id:`reader-${i}`,cwd:root,model:localConfig.model,modelProvider:'saleh_local',historyMode:'legacy',turns:[]}]));
  for(const id of boundedChild.threads.keys())await boundedRefresh.thread(id);
  boundedChild.deferredReads=new Map(Array.from({length:6},(_,i)=>[`reader-${i}`,[]]));
  for(const threadId of boundedChild.deferredReads.keys())boundedChild.emitMessage({method:'turn/started',params:{threadId,turn:{id:`turn-${threadId}`}}});await tick();
  await boundedRefresh.handle({action:'events',after:0});await boundedRefresh.handle({action:'events',after:0});
  assert.equal([...boundedChild.deferredReads.values()].reduce((sum,v)=>sum+v.length,0),4,'receipt refresh concurrency is bounded');
  for(const requests of boundedChild.deferredReads.values())for(const q of requests)boundedChild.emitMessage({id:q.id,error:{code:-32000,message:'history unavailable'}});await tick();
  await boundedRefresh.handle({action:'events',after:0});
  assert.equal(boundedChild.deferredReads.get('reader-4').length,1,'later threads receive a refresh slot');
  assert.equal(boundedChild.deferredReads.get('reader-5').length,1,'refresh scheduling is fair');
  await boundedRefresh.close();
  const validating=new CodingEngine({dataDir:join(root,'stop-during-validation'),binary:'/fake/codex',spawnProcess:spawnFake,localBaseURL:'http://127.0.0.1:1234/v1'});
  const validate=validating.cwd.bind(validating);let releaseDirectory;
  validating.cwd=async value=>{validating.cwd=validate;await new Promise(resolve=>{releaseDirectory=resolve;});return validate(value);};
  const validatingStart=validating.handle({action:'start',cwd:root});
  await validating.stop();releaseDirectory();
  await assert.rejects(validatingStart,/cancelled|stop/i,'Stop invalidates a start still validating its directory');
  await validating.close();
  const receiptHome=join(root,'receipt-home'),receiptPath=join(receiptHome,'sessions','receipt.jsonl');
  await mkdir(join(receiptHome,'sessions'),{recursive:true});
  const receiptRecords=[{type:'session_meta',payload:{id:'thread-1'}},{type:'event_msg',payload:{type:'task_started',turn_id:'receipt-turn'}},{type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-receipt',arguments:JSON.stringify({cmd:'printf RECEIPT_PASS',workdir:root})}},{type:'response_item',payload:{type:'function_call_output',call_id:'orphan',output:'not a paired execution'}},{type:'response_item',payload:{type:'function_call_output',call_id:'call-receipt',output:'Chunk ID: test\nWall time: 0.002 seconds\nProcess exited with code 0\nOutput:\nRECEIPT_PASS\n'}},{type:'event_msg',payload:{type:'task_complete',turn_id:'receipt-turn'}}];
  await writeFile(receiptPath,receiptRecords.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const spawnReceipt=(...args)=>{const c=spawnFake(...args);c.thread={id:'thread-1',cwd:root,modelProvider:'saleh_local',historyMode:'legacy',path:receiptPath,turns:[{id:'receipt-turn',items:[{id:'user',type:'userMessage'},{id:'final',type:'agentMessage',phase:'final_answer',text:'done'}]}]};return c;};
  const makeReceipt=()=>new CodingEngine({dataDir:receiptHome,binary:'/fake/codex',spawnProcess:spawnReceipt,localBaseURL:'http://127.0.0.1:1234/v1'});
  let receiptEngine=makeReceipt(),history=await receiptEngine.handle({action:'read',threadId:'thread-1'});
  assert.deepEqual(history.thread.turns[0].items.map(i=>i.type),['userMessage','commandExecution','agentMessage']);
  assert.equal(history.thread.turns[0].items[1].aggregatedOutput,'RECEIPT_PASS\n');assert.equal(history.thread.turns[0].items[1].exitCode,0);
  children.at(-1).emitMessage({method:'turn/started',params:{threadId:'thread-1',turn:{id:'receipt-turn'}}});
  let live;
  for(let attempt=0;attempt<100;attempt++){
    live=await receiptEngine.handle({action:'events',after:0});
    if(live.events.some(e=>e.method==='item/completed'&&e.params.item?.id==='call-receipt'))break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert(live.events.some(e=>e.method==='item/completed'&&e.params.item?.id==='call-receipt'),'asynchronous refresh publishes receipts on a later poll');
  assert(!(await receiptEngine.handle({action:'events',after:live.cursor})).events.some(e=>e.params.item?.id==='call-receipt'));
  const native={...history.thread.turns[0].items[1],id:'native-command'};delete native.receiptSource;
  children.at(-1).thread.turns[0].items.splice(1,0,native);
  assert.equal((await receiptEngine.handle({action:'read',threadId:'thread-1'})).thread.turns[0].items.filter(i=>i.type==='commandExecution').length,1);
  children.at(-1).thread.turns[0].items=[{id:'user',type:'userMessage'},{id:'final',type:'agentMessage',phase:'final_answer',text:'done'},native];
  assert.deepEqual((await receiptEngine.handle({action:'read',threadId:'thread-1'})).thread.turns[0].items.map(i=>i.id),['user','native-command','final'],'A matched late command is positioned before the final, with native identity retained');
  children.at(-1).thread.turns[0]={id:'receipt-turn',status:'completed',items:[{id:'prelude',type:'agentMessage',phase:'commentary',text:'A real prelude'},native]};
  assert.deepEqual((await receiptEngine.handle({action:'read',threadId:'thread-1'})).thread.turns[0].items.map(i=>i.id),['prelude','native-command'],'Explicit commentary is not a final anchor even in a completed turn');
  await receiptEngine.close();receiptEngine=makeReceipt();
  assert.equal((await receiptEngine.handle({action:'read',threadId:'thread-1'})).thread.turns[0].items[1].id,'call-receipt');
  const omittedPrefix=receiptRecords.slice(0,-1).map(record=>({...record,payload:{...record.payload,...(record.payload.call_id?{call_id:'omitted-'+record.payload.call_id}:{})}}));
  await writeFile(receiptPath,omittedPrefix.map(r=>JSON.stringify(r)).join('\n')+'\n'+JSON.stringify({padding:'x'.repeat(32*1024*1024)})+'\n'+receiptRecords.slice(1).map(r=>JSON.stringify(r)).join('\n')+'\n');
  history=await receiptEngine.handle({action:'read',threadId:'thread-1'});assert.equal(history.historyTruncated,true);assert.equal(history.thread.turns[0].items[1].id,'call-receipt');
  assert(!history.thread.turns[0].items.some(item=>item.id==='omitted-call-receipt'),'Missing prefix receipts must remain explicitly truncated');
  const deniedOutput='Error parsing function arguments\nProcess exited with code 0\nThis text is not an execution receipt.';
  receiptRecords.splice(-1,0,{type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-denied',arguments:JSON.stringify({cmd:'not executed'})}},{type:'response_item',payload:{type:'function_call_output',call_id:'call-denied',output:deniedOutput}},{type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-running',arguments:JSON.stringify({cmd:'still running'})}},{type:'response_item',payload:{type:'function_call_output',call_id:'call-running',output:'Chunk ID: test\nWall time: 0.002 seconds\nProcess running with session ID 123\nOutput:\nProcess exited with code 0\n'}},{type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'call-unpaired',arguments:JSON.stringify({cmd:'no result recorded'})}});
  await writeFile(receiptPath,receiptRecords.map(r=>JSON.stringify(r)).join('\n')+'\n');
  history=await receiptEngine.handle({action:'read',threadId:'thread-1'});
  const unknown=history.thread.turns[0].items.find(i=>i.id==='call-denied');assert.equal(unknown.status,'unknown');assert.equal(unknown.exitCode,null);assert.equal(unknown.aggregatedOutput,deniedOutput);
  const ongoing=history.thread.turns[0].items.find(i=>i.id==='call-running');assert.equal(ongoing.status,'inProgress');assert.equal(ongoing.exitCode,null);assert.equal(ongoing.aggregatedOutput,'Process exited with code 0\n');
  assert(!history.thread.turns[0].items.some(i=>i.id==='call-unpaired'));
  // A moved chat must not relabel earlier commands with its current checkout.
  const commandPair=(id,args)=>[{type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:id,arguments:JSON.stringify(args)}},{type:'response_item',payload:{type:'function_call_output',call_id:id,output:'Chunk ID: test\nWall time: 0.002 seconds\nProcess exited with code 0\nOutput:\nHERE\n'}}];
  const movedReceipts=[receiptRecords[0],{type:'turn_context',payload:{turn_id:'before-move',cwd:'/original-checkout'}},...commandPair('before',{cmd:'pwd'}),{type:'turn_context',payload:{turn_id:'after-move',cwd:'/destination-checkout'}},{type:'event_msg',payload:{type:'task_started',turn_id:'after-move'}},...commandPair('after',{cmd:'pwd'}),...commandPair('explicit',{cmd:'pwd',workdir:'/explicit-checkout'}),{type:'event_msg',payload:{type:'task_started',turn_id:'unknown-context'}},...commandPair('unknown',{cmd:'pwd'})];
  await writeFile(receiptPath,movedReceipts.map(r=>JSON.stringify(r)).join('\n')+'\n');
  assert.deepEqual((await receiptEngine.rolloutReceipts(children.at(-1).thread)).receipts.map(r=>[r.item.id,r.item.cwd]),[['before','/original-checkout'],['after','/destination-checkout'],['explicit','/explicit-checkout'],['unknown',null]]);
  const fifo=join(receiptHome,'sessions','fifo-receipt.jsonl');await promisify(execFile)('/usr/bin/mkfifo',[fifo]);
  const fifoScript=`import {CodingEngine} from ${JSON.stringify(new URL('./coding-engine.mjs',import.meta.url).href)};const e=new CodingEngine({dataDir:${JSON.stringify(receiptHome)}});try{await e.rolloutReceipts({id:'thread-1',path:${JSON.stringify(fifo)}});process.exitCode=2;}catch(e){console.error(e.message);process.exitCode=1;}`;
  let fifoResult;await promisify(execFile)(process.execPath,['--input-type=module','-e',fifoScript],{timeout:1500,killSignal:'SIGKILL'}).then(r=>{fifoResult=r;},e=>{fifoResult=e;});assert.equal(fifoResult.killed,false,'A malformed receipt must not hang history or handoff Stop');assert.equal(fifoResult.code,1);assert.match(fifoResult.stderr,/regular file/);
  const escaped=join(root,'outside-receipt.jsonl');await writeFile(escaped,JSON.stringify(receiptRecords[0])+'\n');
  const link=join(receiptHome,'sessions','escape.jsonl');await symlink(escaped,link);children.at(-1).thread.path=link;
  await assert.rejects(receiptEngine.handle({action:'read',threadId:'thread-1'}),/outside|rollout/i);await receiptEngine.close();
  console.log('coding-engine checks passed');
} finally {await engine.close();await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:20});}
}

const errorScopeEngine=new CodingEngine({dataDir:'/tmp/saleh-error-scope-check'});errorScopeEngine.runs.set('only-thread','only-turn');errorScopeEngine.fail(new Error('Fixture scope'));assert.deepEqual(errorScopeEngine.events.at(-1).params.turns,[{threadId:'only-thread',turnId:'only-turn'}]);await errorScopeEngine.close();
