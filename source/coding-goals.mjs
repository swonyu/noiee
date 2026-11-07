import {open,lstat,realpath,rename,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join,normalize} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {validateQueueBinding} from './coding-queue.mjs';

const MAX_BYTES=8*1024*1024,MAX_GOALS=64;
const ACTIONS=new Set(['goalInspect','goalSave','goalPause','goalResume','goalContinue','goalComplete']);
const TERMINAL=new Set(['completed','failed','interrupted']);
const copy=value=>structuredClone(value),sha=value=>createHash('sha256').update(value).digest('hex');
const shape=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error('Invalid Goal fields.');};
const identifier=value=>{if(typeof value!=='string'||!/^[\w.-]{1,160}$/.test(value))throw Error('Invalid Goal task identity.');return value;};
const uuid=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))throw Error('Invalid Goal receipt identity.');return value;};
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw Error('Invalid Goal count or revision.');return value;};
const boundedText=(value,empty=false)=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>4000||Buffer.byteLength(value)>16000||value.includes('\0')||!empty&&!value.trim())throw Error('Goal text must contain 1–4000 characters and at most 16000 UTF-8 bytes.');return value;};
const pin=(s,file=false)=>Object.fromEntries((file?['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs']:['dev','ino','mode','uid']).map(k=>[k,String(s[k])]));
const samePin=(a,b,renamed=false)=>!!a&&!!b&&Object.keys(a).every(k=>renamed&&k==='ctimeNs'||a[k]===b[k]);
const stale=()=>Object.assign(Error('The saved Goal changed. Refresh it before making this change.'),{code:'GOAL_STALE'});

export const isGoalAction=action=>ACTIONS.has(action);
export function validateGoalRequest(input){
 const action=input?.action;if(!ACTIONS.has(action))throw Error('Unsupported Goal action.');
 shape(input,['action','threadId',...(action==='goalInspect'?[]:['expectedRevision']),...(action==='goalSave'?['objective','completionCriteria','maxTurns']:action==='goalContinue'?['mode','effort']:action==='goalComplete'?['evidence']:[])]);
 identifier(input.threadId);if(action!=='goalInspect')integer(input.expectedRevision);
 if(action==='goalSave'){boundedText(input.objective);boundedText(input.completionCriteria);integer(input.maxTurns,1,20);}
 if(action==='goalContinue'&&(!['build','plan'].includes(input.mode)||!['none','high'].includes(input.effort)))throw Error('Choose Build or Plan and a supported reasoning effort before continuing the Goal.');
 if(action==='goalComplete')boundedText(input.evidence);
 return copy(input);
}
function usage(value){
 if(value===null)return null;
 shape(value,['source','observedAt','threadId','turnId','last','total']);
 if(value.source!=='engine-notification'||typeof value.observedAt!=='string'||!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString()!==value.observedAt)throw Error('Invalid Goal usage provenance.');
 identifier(value.threadId);identifier(value.turnId);
 for(const part of ['last','total']){const row=value[part];shape(row,['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens',...(Object.hasOwn(row??{},'cacheWriteInputTokens')?['cacheWriteInputTokens']:[])]);for(const count of Object.values(row))integer(count);}
 return copy(value);
}
export function goalPrompt(goal,{mode,effort}){
 boundedText(goal.objective);boundedText(goal.completionCriteria);
 if(!['build','plan'].includes(mode)||!['none','high'].includes(effort))throw Error('Invalid Goal continuation settings.');
 return `Work on this saved Noiee Goal for this one explicitly requested turn.\n\nObjective:\n${goal.objective}\n\nDone when:\n${goal.completionCriteria}\n\nThis is attempt ${goal.attempts.length+1} of ${goal.maxTurns}. Work within the selected ${mode==='plan'?'Plan (read-only)':'Build'} mode and existing project permissions. Report concrete evidence, unresolved failures, and the next useful step. Do not treat this message as permission to create a native Goal, schedule future work, submit further turns, or mark the saved Goal complete. The user controls the next Continue and records completion evidence separately.`;
}

// This contract never creates native Goals or dispatches turns. The coordinator
// is the only writer; a durable claim is consumed before its existing send path.
export class CodingGoals {
 #data=null;#disk=null;#directory=null;#serial=Promise.resolve();#blocked=null;#liveClaims=new Set();
 constructor({dataDir}={}){if(typeof dataDir!=='string'||!isAbsolute(dataDir)||normalize(dataDir)!==dataDir||dataDir.includes('\0'))throw Error('Goals require a canonical data directory.');this.dataDir=dataDir;this.path=join(dataDir,'coding-goals.json');}
 #enqueue(fn){const result=this.#serial.then(fn);this.#serial=result.catch(()=>{});return result;}
 async #verifyDirectory(){const s=await lstat(this.dataDir,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(this.dataDir)!==this.dataDir)throw Error('Goal storage directory is not private and canonical.');const next=pin(s);if(this.#directory&&!samePin(this.#directory,next))throw Error('Goal storage directory changed.');this.#directory??=next;}
 async #read(path){
  await this.#verifyDirectory();let s;try{s=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!s.isFile()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||s.nlink!==1n||s.size>BigInt(MAX_BYTES))throw Error('Goal ledger type, ownership, permissions or size is invalid.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=pin(await file.stat({bigint:true}),true);if(!samePin(before,pin(s,true)))throw Error('Goal ledger changed while opening.');const bytes=await file.readFile();if(bytes.length>MAX_BYTES||!samePin(before,pin(await file.stat({bigint:true}),true))||!samePin(before,pin(await lstat(path,{bigint:true}),true)))throw Error('Goal ledger changed while reading.');await this.#verifyDirectory();return {bytes,hash:sha(bytes),pin:before};}finally{await file.close();}
 }
 async #diskCheck(){const current=await this.#read(this.path);if((current?.hash??null)!==(this.#disk?.hash??null)||!!current!==!!this.#disk||current&&!samePin(current.pin,this.#disk.pin))throw Error('Goal ledger changed externally; retained records were not reset.');}
 #validate(data){
  shape(data,['version','revision','goals']);if(data.version!==1)throw Error('Unsupported Goal ledger version.');integer(data.revision,1);if(!Array.isArray(data.goals)||data.goals.length>MAX_GOALS)throw Error('Goal retention limit reached; existing goals were kept.');const roots=new Set(),ids=new Set();
  for(const goal of data.goals){
   shape(goal,['id','binding','revision','state','objective','completionCriteria','maxTurns','attempts','completionEvidence','createdAt','updatedAt']);uuid(goal.id);validateQueueBinding(goal.binding);integer(goal.revision,1);boundedText(goal.objective);boundedText(goal.completionCriteria);integer(goal.maxTurns,1,20);integer(goal.createdAt,1);integer(goal.updatedAt,goal.createdAt);boundedText(goal.completionEvidence,true);
   if(!['ready','paused','complete'].includes(goal.state)||goal.state==='complete'&&!goal.completionEvidence.trim()||goal.state!=='complete'&&goal.completionEvidence!==''||roots.has(goal.binding.rootThreadId)||ids.has(goal.id)||!Array.isArray(goal.attempts)||goal.attempts.length>goal.maxTurns)throw Error('Invalid or duplicate Goal contract.');roots.add(goal.binding.rootThreadId);ids.add(goal.id);
   let pending=0;
   for(const [index,attempt] of goal.attempts.entries()){
    shape(attempt,['id','generation','contractRevision','contractHash','maxTurnsAtDispatch','mode','effort','status','turnId','claimedAt','endedAt','message','observedUsage']);uuid(attempt.id);uuid(attempt.generation);integer(attempt.contractRevision,1,goal.revision-1);integer(attempt.maxTurnsAtDispatch,index+1,20);if(typeof attempt.contractHash!=='string'||!/^[a-f0-9]{64}$/.test(attempt.contractHash))throw Error('Invalid Goal contract provenance.');integer(attempt.claimedAt,1);if(attempt.endedAt!==null)integer(attempt.endedAt,attempt.claimedAt);if(attempt.turnId!==null)identifier(attempt.turnId);
    if(ids.has(attempt.id)||!['build','plan'].includes(attempt.mode)||!['none','high'].includes(attempt.effort)||!['starting','running','unknown',...TERMINAL].includes(attempt.status)||typeof attempt.message!=='string'||attempt.message.length>1600||attempt.status==='starting'&&attempt.turnId!==null||['running','completed','failed'].includes(attempt.status)&&attempt.turnId===null||TERMINAL.has(attempt.status)&&attempt.endedAt===null||['starting','running'].includes(attempt.status)&&attempt.endedAt!==null)throw Error('Invalid Goal attempt receipt.');ids.add(attempt.id);
    const observed=usage(attempt.observedUsage);if(observed&&(observed.threadId!==goal.binding.rootThreadId||observed.turnId!==attempt.turnId))throw Error('Goal usage belongs to a different turn.');
    if(['starting','running','unknown'].includes(attempt.status))pending++;
   }
   if(pending>1||pending&&goal.state==='complete')throw Error('Goal has overlapping or unresolved attempts.');
  }
 }
 async #load(){
  if(this.#blocked)throw Error(this.#blocked);
  try{
   await this.#verifyDirectory();const names=await readdir(this.dataDir);if(names.some(name=>name.startsWith('coding-goals.json.')&&name.endsWith('.tmp')))throw Error('Interrupted Goal publication is retained for inspection.');
   if(this.#data){await this.#diskCheck();return;}
   this.#disk=await this.#read(this.path);this.#data=this.#disk?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.#disk.bytes)):{version:1,revision:1,goals:[]};this.#validate(this.#data);
  }catch(error){this.#blocked='Goal storage is blocked; no records were replaced. '+String(error.message).slice(0,1000);throw Error(this.#blocked);}
 }
 async #save(next,check=()=>{}){
  this.#validate(next);const bytes=Buffer.from(JSON.stringify(next));if(bytes.length>MAX_BYTES)throw Error('Goal storage exceeds its retention bound; existing records were kept.');
  // Cancellation is checked before staging. After a durable claim is published,
  // callers hold it on uncertainty and never infer that a send did not happen.
  check();await this.#diskCheck();check();let temp;
  try{
   temp=this.path+'.'+randomUUID()+'.tmp';const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   const staged=await this.#read(temp);if(staged?.hash!==sha(bytes))throw Error('Goal stage changed before publication.');await this.#diskCheck();
   await rename(temp,this.path);const directory=await open(this.dataDir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{if(!samePin(this.#directory,pin(await directory.stat({bigint:true}))))throw Error('Goal directory changed before sync.');await directory.sync();}finally{await directory.close();}
   const committed=await this.#read(this.path);if(committed?.hash!==staged.hash||!samePin(staged.pin,committed.pin,true))throw Error('Goal publication identity changed.');this.#disk=committed;this.#data=next;
  }catch(error){this.#blocked='Goal publication is unconfirmed; retained records must be inspected. '+String(error.message).slice(0,1000);throw Error(this.#blocked);}
 }
 #find(data,root){return data.goals.find(goal=>goal.binding.rootThreadId===root)??null;}
 #binding(goal,binding){if(goal&&!equal(goal.binding,validateQueueBinding(binding)))throw Error('Goal owner, project, model or execution binding changed.');}
 #revision(goal,expected){integer(expected);if((goal?.revision??0)!==expected)throw stale();}
 #pending(goal){return goal.attempts.some(attempt=>['starting','running','unknown'].includes(attempt.status));}
 #view(goal){
  if(!goal)return {goal:null,revision:0};const result=copy(goal);for(const attempt of result.attempts)if(['starting','running'].includes(attempt.status)&&!this.#liveClaims.has(attempt.id)){attempt.status='unknown';attempt.message='Observation ended before a verified terminal receipt. This attempt will not be retried.';}
  if(result.attempts.some(attempt=>attempt.status==='unknown'))result.state='needsReview';else if(result.state==='ready'&&result.attempts.length>=result.maxTurns&&!this.#pending(result))result.state='budgetLimited';
  result.attemptsUsed=result.attempts.length;result.attemptsRemaining=result.maxTurns-result.attempts.length;
  return {goal:result,revision:result.revision};
 }
 #touch(data,goal){integer(goal.revision+1,1);goal.revision++;goal.updatedAt=Math.max(Date.now(),goal.updatedAt);data.revision++;}
 inspect(root){identifier(root);return this.#enqueue(async()=>{await this.#load();return this.#view(this.#find(this.#data,root));});}
 edit(input,binding,check=()=>{}){
  input=validateGoalRequest(input);binding=validateQueueBinding(binding);if(binding.rootThreadId!==input.threadId||!['goalSave','goalPause','goalResume','goalComplete'].includes(input.action))throw Error('Invalid Goal edit binding.');
  return this.#enqueue(async()=>{
   await this.#load();const next=copy(this.#data);let goal=this.#find(next,input.threadId);this.#revision(goal,input.expectedRevision);this.#binding(goal,binding);
   if(goal?.state==='complete')throw Error('This Goal is complete. Start another task for a new Goal.');
   if(input.action==='goalSave'){
    if(goal&&this.#pending(goal))throw Error('Wait for the Goal attempt to finish and be verified before editing it.');
    if(goal&&input.maxTurns<goal.attempts.length)throw Error('The attempt budget cannot be lower than attempts already reserved.');
    if(!goal){const now=Date.now();goal={id:randomUUID(),binding,revision:1,state:'ready',objective:input.objective,completionCriteria:input.completionCriteria,maxTurns:input.maxTurns,attempts:[],completionEvidence:'',createdAt:now,updatedAt:now};next.goals.push(goal);next.revision++;}
    else{if(goal.state==='ready'&&goal.attempts.length>=goal.maxTurns&&input.maxTurns>goal.maxTurns)goal.state='paused';Object.assign(goal,{objective:input.objective,completionCriteria:input.completionCriteria,maxTurns:input.maxTurns});this.#touch(next,goal);}
   }else{
    if(!goal)throw Error('Save a Goal first.');
    if(input.action==='goalPause')goal.state='paused';
    else{if(this.#pending(goal))throw Error('This Goal has an active or unknown attempt. Inspect its exact receipt before continuing.');if(input.action==='goalResume'){if(goal.attempts.length>=goal.maxTurns)throw Error('The Goal attempt budget is exhausted. Increase it explicitly before resuming.');goal.state='ready';}else{goal.state='complete';goal.completionEvidence=input.evidence;}}
    this.#touch(next,goal);
   }
   await this.#save(next,check);return this.#view(goal);
  });
 }
 prepare(root,expectedRevision,binding){identifier(root);binding=validateQueueBinding(binding);return this.#enqueue(async()=>{await this.#load();const goal=this.#find(this.#data,root);this.#revision(goal,expectedRevision);this.#binding(goal,binding);if(!goal||goal.state!=='ready'||this.#pending(goal)||goal.attempts.length>=goal.maxTurns)throw Error('The Goal is paused, finished, budget-limited, or has an unresolved attempt. Inspect it before continuing.');return copy(goal);});}
 claim(root,expectedRevision,binding,{generation,mode,effort},check=()=>{}){
  identifier(root);uuid(generation);binding=validateQueueBinding(binding);if(!['build','plan'].includes(mode)||!['none','high'].includes(effort))throw Error('Invalid Goal attempt mode or effort.');
  return this.#enqueue(async()=>{await this.#load();const next=copy(this.#data),goal=this.#find(next,root);this.#revision(goal,expectedRevision);this.#binding(goal,binding);if(!goal||goal.state!=='ready'||this.#pending(goal)||goal.attempts.length>=goal.maxTurns)throw Error('Goal continuation is no longer eligible.');const attempt={id:randomUUID(),generation,contractRevision:goal.revision,contractHash:sha(JSON.stringify([goal.objective,goal.completionCriteria,goal.maxTurns])),maxTurnsAtDispatch:goal.maxTurns,mode,effort,status:'starting',turnId:null,claimedAt:Date.now(),endedAt:null,message:'One attempt is reserved; awaiting its exact turn receipt.',observedUsage:null};goal.attempts.push(attempt);this.#touch(next,goal);await this.#save(next,check);this.#liveClaims.add(attempt.id);return copy(attempt);});
 }
 #receipt(root,attemptId,update){identifier(root);uuid(attemptId);return this.#enqueue(async()=>{await this.#load();const next=copy(this.#data),goal=this.#find(next,root),attempt=goal?.attempts.find(row=>row.id===attemptId);if(!attempt)throw Error('Unknown Goal attempt.');if(update(attempt,goal)!==false){this.#touch(next,goal);await this.#save(next);}return this.#view(goal);});}
 acknowledge(root,attemptId,turnId){identifier(turnId);return this.#receipt(root,attemptId,attempt=>{if(attempt.turnId!==null){if(attempt.turnId!==turnId)throw Error('Goal turn identity changed.');return false;}if(attempt.status!=='starting')throw Error('Goal claim is no longer awaiting a turn.');attempt.turnId=turnId;attempt.status='running';attempt.message='Exact turn receipt retained; awaiting verified completion.';});}
 finish(root,attemptId,{turnId,status,observedUsage=null,message=''},check=()=>{}){
  if(turnId!==null)identifier(turnId);if(![...TERMINAL,'unknown'].includes(status)||typeof message!=='string'||message.length>1600)throw Error('Invalid Goal attempt outcome.');observedUsage=usage(observedUsage);
  return this.#receipt(root,attemptId,(attempt,goal)=>{
   check();if(attempt.turnId!==turnId||['completed','failed'].includes(status)&&turnId===null||observedUsage&&(observedUsage.threadId!==root||observedUsage.turnId!==turnId))throw Error('Goal outcome belongs to a different turn.');
   if(TERMINAL.has(attempt.status)){if(attempt.status!==status)throw Error('A verified Goal outcome cannot be replaced.');return false;}
   if(attempt.status==='unknown'&&status==='unknown')return false;
   attempt.status=status;attempt.endedAt=Math.max(Date.now(),attempt.claimedAt);attempt.message=message||'The exact Goal turn outcome was observed.';attempt.observedUsage=observedUsage;this.#liveClaims.delete(attemptId);
   if(status!=='completed')goal.state='paused';
  });
 }
 async drain(){await this.#serial;}
}
