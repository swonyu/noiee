import {mkdir,lstat,realpath,readFile,open,rename,unlink,readdir,statfs} from 'node:fs/promises';
import {constants} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {CodingQueue,validateQueueBinding,normalizeQueueRequest} from './coding-queue.mjs';
import {join,isAbsolute,relative,dirname,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {isLegacyAdmission,verifyLegacyProvenance} from './legacy-admission.mjs';
import {CodingEngine,CodingProjects,CodingEvents,validateCodingRequest,parseCodingProvider} from './coding-engine.mjs';
import {verifyHandoffProcessIdentity,verifyHandoffHelper,verifyHandoffProcessReceipt,releaseHandoffProcess} from './handoff-process.mjs';
import {CodingMCPOutcomes} from './coding-mcp-outcomes.mjs';
import {CodingTerminalResults} from './coding-terminal-results.mjs';
import {CodingMCPState} from './coding-mcp-state.mjs';
import {createCodingMCPRegistry} from './coding-mcp-registry.mjs';
import {MCPHub} from './mcp.mjs';
import {GitRunner} from './git-runner.mjs';
import {GitWorkflow,isReviewedGitOperation} from './git-workflow.mjs';
import {ManagedWorktrees} from './managed-worktrees.mjs';
import {HandoffGit,admitGitSnapshot} from './handoff-git.mjs';
import {FailedStartupCopies} from './failed-startups.mjs';
import {isGuestWorkspaceValidationFailure} from './guest-workspace.mjs';
import {isGuestPublicationConflict} from './guest-publication.mjs';
import {inspectRetiredDisk,recordDiskReleaseIntent,completeDiskRelease,verifyDiskRelease,isFailedDiskOwner} from './guest-disk-release.mjs';
import {isDeepStrictEqual as equal} from 'node:util';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {readNativeQuarantine} from './coding-native-quarantine.mjs';

const MAX=1048576, LIMIT=256, READ=new Set(['read','historyPage','readImage','family']), CONTROL=new Set(['interrupt','interruptFamily','approval','approvalInfo','terminalStop','terminalSnapshot','terminalWrite','terminalInput','terminalResize']);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const id=value=>typeof value==='string'&&/^[\w.-]{1,160}$/.test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stamp=s=>({dev:String(s.dev),ino:String(s.ino)});
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const identity=v=>v&&Object.keys(v).length===2&&['dev','ino'].every(k=>typeof v[k]==='string'&&/^\d{1,30}$/.test(v[k]));
const sameBinding=(a,b)=>isFilesystemIdentity(a)||isFilesystemIdentity(b)?sameFilesystemIdentity(a,b):same(a,b);
const bindingKey=value=>JSON.stringify(isFilesystemIdentity(value)?[value.volumeUUID,value.ino]:[value.dev,value.ino]);
const shape=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Invalid coding owner catalog schema.');};
const overlap=(a,b)=>a===b||a.startsWith(b.endsWith('/')?b:b+'/')||b.startsWith(a.endsWith('/')?a:a+'/');
const busy=()=>Object.assign(Error('Coding owner allocation, recovery or project mutation is pending.'),{code:'PROJECT_BUSY'});
const optional=async path=>{try{return await lstat(path,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const legacyView=value=>({...value,historyOnly:true,historySource:'legacy'});
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const rolloutPath=value=>typeof value==='string'&&value.length<=4096&&!value.includes('\0')&&/^(sessions|archived_sessions)\//.test(value)&&value.split('/').every(p=>p&&p!=='.'&&p!=='..');
const resourceKeys=['cpu','memoryBytes','diskBytes'];
const resourceValues=(value,limits=false)=>{shape(value,[...resourceKeys,...(limits?['concurrent']:[])]);if(Object.values(value).some(n=>!Number.isSafeInteger(n)||n<=0)||value.memoryBytes%1048576||value.diskBytes%1048576)throw Error('Invalid executor resource policy or alignment.');};
const absolutePath=value=>typeof value==='string'&&isAbsolute(value)&&value.length<=4096&&!value.includes('\0');
const frozenRuntime=value=>Object.freeze({path:value.path,identity:Object.freeze({...value.identity})});
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const requestContext=value=>{if(value===undefined)return null;shape(value,['requestId',...(Object.hasOwn(value??{},'signal')?['signal']:[])]);if(!uuid(value.requestId)||value.signal!==undefined&&!(value.signal instanceof AbortSignal))throw Error('Invalid trusted coding request context.');return {requestId:value.requestId,signal:value.signal};};
const nativeOwner=row=>row?.executionMode==='native';
const handoffPending=()=>Object.assign(Error('This chat has a retained worktree handoff. Inspect its original recovery; no work was replayed.'),{code:'HANDOFF_PENDING'});
function handoffContext(value){
 shape(value,['id','worktreeId','source','destination','fingerprint','owner','recovery']);const o=value.owner,r=value.recovery;
 shape(o,['ownerId','home','rootThreadId','generation','executionMode','model','provider']);shape(r,['directory','manifest']);shape(r.manifest,['identity','hash','bytes']);
 if(!uuid(value.id)||!uuid(value.worktreeId)||!absolutePath(value.source)||!absolutePath(value.destination)||value.source===value.destination||!digest(value.fingerprint)||!uuid(o.ownerId)||!id(o.rootThreadId)||!uuid(o.generation)||o.executionMode!=='native'||!(isFilesystemIdentity(o.home)||identity(o.home))||typeof o.model!=='string'||!o.model||o.model.length>200||!['local','cloud'].includes(o.provider)||!identity(r.directory)||!identity(r.manifest.identity)||!digest(r.manifest.hash)||!Number.isSafeInteger(r.manifest.bytes)||r.manifest.bytes<1||r.manifest.bytes>8*MAX)throw Error('Invalid native owner handoff binding.');
 return value;
}
function handoffMarker(value,row){
 shape(value,['context','commit']);const c=handoffContext(value.context),o=c.owner;
 if(!nativeOwner(row)||row.state!=='ready'||o.ownerId!==row.id||o.rootThreadId!==row.rootThreadId||!sameBinding(o.home,row.home)||o.model!==row.model||o.provider!==row.provider||![c.source,c.destination].includes(row.cwd))throw Error('Retained handoff differs from its native owner.');
 if(value.commit!==null){const v=value.commit;shape(v,['target','fingerprint','progress']);shape(v.progress,['sequence','identity','hash','bytes']);if(![c.source,c.destination].includes(v.target)||v.target!==row.cwd||!digest(v.fingerprint)||!identity(v.progress.identity)||!digest(v.progress.hash)||!Number.isSafeInteger(v.progress.sequence)||v.progress.sequence<1||v.progress.sequence>8192||!Number.isSafeInteger(v.progress.bytes)||v.progress.bytes<1||v.progress.bytes>8*MAX)throw Error('Invalid owner handoff terminal receipt.');}
 return value;
}
const ownerThread=(row,thread)=>({...thread,executionMode:row.executionMode??'vm',...(row.quarantine?{historyOnly:true,historySource:'quarantined-owner'}:row.handoff?{historyOnly:true,historySource:'retained-handoff'}:{})});
const ownerResult=(row,result)=>!result.thread&&!result.root&&!result.threads?result:({...result,executionMode:row.executionMode??'vm',...(result.thread?{thread:ownerThread(row,result.thread)}:{}),...(result.root?{root:ownerThread(row,result.root)}:{}),...(result.threads?{threads:result.threads.map(thread=>ownerThread(row,thread))}:{})});

// One coordinator lease protects all native homes. A stale lease is preserved,
// never guessed dead from a PID or silently removed during a new launch.
export class CodingOwners {
 #projects=new CodingProjects(); #journal=new CodingEvents(); #authority;
 #rows=[]; #coldCreating=new WeakSet(); #live=new Map(); #queue=Promise.resolve(); #queuePending=0; #operations=new Set(); #allocating=new Set(); #epoch=0;
 #loaded=false; #blocked=null; #directory=null; #ownersDirectory=null; #diskStamp=null; #diskHash=null; #lease=null;
 #engineFactory; #openExecutor; #engineOptions; #snapshots=new Map(); #controls=new Map(); #closing=null; #stopping=null;
 #legacy=null; #legacyLive=null; #assertLegacyClosed; #scheduled=null;
 #legacyAdmission; #admissionProof=null; #admissionController=null; #initialAdmissionFailure=null;
 #durableIdentity=false; #liveDirectories=new Map(); #handoffCatalog=false;
 #handoffPrepared=new Map(); #handoffActive=new Map(); #handoffStatus; #handoffSelection=null;
 #forkFiles; #native=null; #helperIdentity=null;
 #managedMutationBlocked=false;
 #ownerRevisions=new Map(); #selectedStops=new Map(); #stopIntents=new Map();
 #executorPolicy=null; #executor=null; #runtimeReceipt=null;
 #loading=null; #saving=null; #catalogRevision=0; #committed=null; #outcomeReaders=new Map(); #inspections=new Set();
 #mcpConfigPath; #setups=new Map();
 #quarantineCatalog=false; #quarantines=new Map(); #unconfinedStatus;
 #followups=null; #followupPrepared=new Map(); #followupPumps=new Map(); #followupWrites=new Set(); #followupFailure=null;
 #origins=new Map(); #hostGitFailures=new Map(); #diskReviews=new Map(); #verifiedFailedReleases=new Map();
 #startupCopies=null;
 constructor({dataDir,openExecutor,engineFactory=options=>new CodingEngine(options),engineOptions={},assertLegacyClosed,legacyAdmission,forkFiles,executorPolicy,mcpConfigPath,handoffStatus,unconfinedStatus,managedMutationBlocked=false}={}) {
  if(typeof managedMutationBlocked!=='boolean')throw Error('Invalid trusted mutation access setting.');this.#managedMutationBlocked=managedMutationBlocked;
  if(typeof dataDir!=='string'||!isAbsolute(dataDir)||typeof openExecutor!=='function'||typeof engineFactory!=='function')throw Error('Invalid trusted coding owner configuration.');
  if(assertLegacyClosed!==undefined&&typeof assertLegacyClosed!=='function')throw Error('Invalid trusted legacy history admission.');
  if(legacyAdmission!==undefined&&!isLegacyAdmission(legacyAdmission))throw Error('Invalid trusted legacy reboot admission.');
  if(handoffStatus!==undefined&&typeof handoffStatus!=='function')throw Error('Invalid trusted handoff inspection callback.');this.#handoffStatus=handoffStatus;
  if(unconfinedStatus!==undefined&&typeof unconfinedStatus!=='function')throw Error('Invalid trusted unconfined inspection callback.');this.#unconfinedStatus=unconfinedStatus;
  this.#legacyAdmission=legacyAdmission;
  if(forkFiles!==undefined&&typeof forkFiles!=='function')throw Error('Invalid trusted fork file operation.');
  if(mcpConfigPath!==undefined&&!absolutePath(mcpConfigPath))throw Error('Invalid trusted MCP configuration path.');this.#mcpConfigPath=mcpConfigPath;
  if(Object.keys(engineOptions).some(k=>!['binary','spawnProcess','localBaseURL','localModels','readCloudKey','nativeHelper','temporaryOperation','assertProject','fullAccess'].includes(k)))throw Error('Unsupported trusted owner engine option.');
  if(executorPolicy!==undefined){shape(executorPolicy,['runtimeDir','resources','limits']);if(!absolutePath(executorPolicy.runtimeDir))throw Error('Invalid executor policy runtime.');resourceValues(executorPolicy.resources);resourceValues(executorPolicy.limits,true);this.#executorPolicy=Object.freeze({runtimeDir:executorPolicy.runtimeDir,resources:Object.freeze({...executorPolicy.resources}),limits:Object.freeze({...executorPolicy.limits})});}
  this.dataDir=dataDir;this.closed=false;this.#openExecutor=openExecutor;this.#engineFactory=engineFactory;this.#engineOptions={...engineOptions};
  this.#assertLegacyClosed=assertLegacyClosed;
  this.#forkFiles=forkFiles??((...args)=>this.#nativeFiles(...args));
  this.#authority=new CodingEngine({...engineOptions,dataDir,providerDataDir:dataDir,projects:this.#projects,journal:this.#journal});
  this.#startupCopies=new FailedStartupCopies({dataDir,nativeHelper:engineOptions.nativeHelper,spawnProcess:engineOptions.spawnProcess,nativeFiles:(...args)=>this.#forkFiles(...args)});
 }
 #setupView(setup){return structuredClone(Object.fromEntries(['setupId','revision','expiresAt','phase','request','creation','root','cleanup','error','review'].map(key=>[key,setup[key]])));}
 #setupChange(setup,values){Object.assign(setup,values);setup.revision++;}
 #checkSetup(setup){
  if(setup.expiresAt!==null&&Date.now()>=setup.expiresAt)this.#cancelSetup(setup,'expired');
  if(this.#setups.get(setup.setupId)!==setup||setup.controller.signal.aborted||this.closed||this.#stopping||setup.epoch!==this.#epoch)throw Error('Coding MCP setup is cancelled or expired.');
  if(this.#blocked)throw this.#blocked;if(setup.operation)this.#check(setup.epoch,setup.operation);
 }
 #setupError(code){return {code,message:({expired:'Coding MCP setup expired; prepare and review again.',cancelled:'Coding MCP setup was cancelled.', 'setup-failed':'Coding MCP setup failed; retained status and evidence were preserved.', 'creation-unconfirmed':'Chat creation is unconfirmed. Inspect this setup; do not create or send again automatically.', 'closure-unconfirmed':'Owned connection or execution closure is unconfirmed; resources remain retained.'})[code]};}
 #cancelSetup(setup,code='cancelled'){
  clearTimeout(setup.timer);setup.controller.abort();setup.operation?.controller.abort();
  if(!['cancelled','failed'].includes(setup.phase))this.#setupChange(setup,{phase:code==='cancelled'||code==='expired'?'cancelled':'failed',error:this.#setupError(code)});
  if(setup.retirement)return;
  this.#setupChange(setup,{cleanup:'pending'});
  const hub=setup.hub.close();let ticket;
  if(setup.row){this.#requestOwnerStop(setup.row,true);ticket=this.#selectedStops.get(setup.row.id);}
  // No outer operation awaits this retirement: its finally must release before
  // selected Stop can commit. Metadata acquisition remains retained separately.
  setup.retirement=(async()=>{
   const [closed]=await Promise.allSettled([hub,setup.preparation,setup.operation?.settled]);
   if(ticket)await ticket.work;
   // Selected native Stop preserves its engine; setup cancellation must then retire it.
   if(ticket&&!ticket.retiring){this.#requestOwnerStop(setup.row,true);ticket=this.#selectedStops.get(setup.row.id);if(ticket)await ticket.work;}
   if(closed.status==='rejected'||ticket?.error||setup.row?.generation&&(setup.row.generation.nativeOpen||!setup.row.generation.executorClosed)||setup.row&&this.#live.has(setup.row.id))throw Error('Coding MCP setup closure is unconfirmed.');
   this.#setupChange(setup,{cleanup:'closed'});
  })().catch(error=>{this.#setupChange(setup,{cleanup:'unconfirmed',error:this.#setupError('closure-unconfirmed')});throw error;});
  void setup.retirement.catch(()=>{});
 }
 #failSetup(setup){this.#cancelSetup(setup,setup.controller.signal.aborted||setup.operation?.controller.signal.aborted?'cancelled':setup.creation==='unknown'?'creation-unconfirmed':'setup-failed');}
 async #setupProvider(setup){
  const {provider,model}=setup.request;
  if(provider==='local'){this.#authority.profile(provider,model);return null;}
  const profile=await this.#authority.providerMetadata();this.#checkSetup(setup);
  if(!profile?.credentialId||profile.model!==model)throw Error('Save a cloud provider again before reviewing this model.');return profile;
 }
 async #prepareSetup(setup){
  this.#checkSetup(setup);await this.#authority.cwd(setup.request.cwd);this.#checkSetup(setup);
  await this.#authority.assertProject(setup.request.cwd);this.#checkSetup(setup);
  await this.#serial(async()=>{this.#checkSetup(setup);await this.#load();this.#checkSetup(setup);if(this.#engineOptions.fullAccess&&await this.#uncertain(setup.request.cwd))throw busy();this.#checkSetup(setup);await this.#quarantineScope([setup.request.cwd],()=>this.#checkSetup(setup));});this.#checkSetup(setup);
  const provider=await this.#setupProvider(setup),described=await setup.hub.describe();this.#checkSetup(setup);
  const servers=setup.request.serverIds.map(id=>{
   const matches=described.servers.filter(server=>server.id===id);if(matches.length!==1)throw Error('Unknown Coding MCP server.');const server=matches[0];
   if(!digest(server.configHash)||!['stdio','http'].includes(server.transport))throw Error('Invalid Coding MCP review metadata.');
   return Object.fromEntries(['id','configHash','transport',...(server.transport==='stdio'?['command','args','cwd','envKeys']:['url','headerKeys'])].map(key=>[key,structuredClone(server[key])]));
  });
  setup.provider=freeze(structuredClone(provider));this.#setupChange(setup,{phase:'prepared',review:freeze({provider:setup.provider,servers})});
 }
 // This is a trusted native route. Review hashes and configuration descriptors
 // never belong in the browser request/response projection or saved catalog.
 handleMCP(input,context){
  const origin=requestContext(context);
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid Coding MCP setup request.');const action=input.action;
  shape(input,action==='prepareStart'?['action','cwd','provider','model','serverIds',...(Object.hasOwn(input,'executionMode')?['executionMode']:[])]:action==='commitStart'?['action','setupId','revision','reviewedConfigs']:['action','setupId']);
  if(!['prepareStart','commitStart','setupStatus','cancelSetup'].includes(action))throw Error('Invalid Coding MCP setup action.');
  if(action==='prepareStart'){
   const {cwd,provider,model}=input,executionMode=Object.hasOwn(input,'executionMode')?input.executionMode:'vm';if(!['native','vm'].includes(executionMode)||!['local','cloud'].includes(provider)||typeof model!=='string'||!model||model.length>200||/[\x00-\x1f\x7f]/.test(model)||!Array.isArray(input.serverIds)||input.serverIds.length<1||input.serverIds.length>64||input.serverIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(id))||new Set(input.serverIds).size!==input.serverIds.length)throw Error('Invalid Coding MCP setup selection.');
   validateCodingRequest({action:'start',cwd,provider,...(provider==='local'?{model}:{})});
   if(this.closed||this.#stopping||this.#blocked)throw Error('Coding MCP setup is unavailable while owners are stopping or blocked.');if(this.#setups.size>=LIMIT)throw Error('Coding MCP retained setup limit reached.');
   const setup={setupId:randomUUID(),ownerId:randomUUID(),generation:randomUUID(),epoch:this.#epoch,revision:0,expiresAt:Date.now()+300000,phase:'preparing',request:freeze({cwd,provider,model,executionMode,serverIds:[...input.serverIds].sort()}),creation:'not-started',root:null,cleanup:'not-requested',error:null,review:null,controller:new AbortController(),hub:new MCPHub(this.#mcpConfigPath)};
   const close=setup.hub.close.bind(setup.hub);setup.hub.close=()=>{if(!setup.hubClosure){try{setup.hubClosure=Promise.resolve(close());}catch(error){setup.hubClosure=Promise.reject(error);}void setup.hubClosure.catch(()=>{});}return setup.hubClosure;};
   this.#setups.set(setup.setupId,setup);setup.timer=setTimeout(()=>this.#cancelSetup(setup,'expired'),300000);setup.timer.unref?.();
   setup.preparation=Promise.resolve().then(()=>this.#prepareSetup(setup)).catch(()=>{this.#failSetup(setup);});return this.#setupView(setup);
  }
  if(!uuid(input.setupId))throw Error('Invalid Coding MCP setup identity.');const setup=this.#setups.get(input.setupId);if(!setup)throw Error('Unknown Coding MCP setup; it cannot be recreated or adopted.');
  if(action==='setupStatus')return this.#setupView(setup);
  if(action==='cancelSetup'){this.#cancelSetup(setup);return this.#setupView(setup);}
  if(!Number.isSafeInteger(input.revision)||input.revision<0||!Array.isArray(input.reviewedConfigs)||input.reviewedConfigs.length!==setup.request.serverIds.length)throw Error('Invalid Coding MCP review proof.');
  const reviewed=input.reviewedConfigs.map(value=>{shape(value,['id','configHash']);if(typeof value.id!=='string'||!digest(value.configHash))throw Error('Invalid Coding MCP review proof.');return {id:value.id,configHash:value.configHash};}).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  this.#checkSetup(setup);
  if(setup.phase!=='prepared'||setup.revision!==input.revision||JSON.stringify(reviewed)!==JSON.stringify(setup.review.servers.map(({id,configHash})=>({id,configHash}))))throw Error('Coding MCP setup is consumed, changed or unreviewed; inspect the original setup.');
  const operation=this.#operation(setup.epoch,origin);setup.operation=operation;this.#operations.add(operation);
  clearTimeout(setup.timer);setup.reviewed=freeze(reviewed);this.#setupChange(setup,{phase:'committing',expiresAt:null});
  setup.commit=this.#serial(async()=>{await this.#load(operation);this.#checkSetup(setup);await this.#create({action:'start',cwd:setup.request.cwd,provider:setup.request.provider,executionMode:setup.request.executionMode,...(setup.request.provider==='local'?{model:setup.request.model}:{})},setup.epoch,operation,setup);this.#checkSetup(setup);this.#setupChange(setup,{phase:'created'});}).catch(()=>{this.#failSetup(setup);}).finally(()=>this.#release(operation));
  return this.#setupView(setup);
 }
 async cancelMCPSetups(){
  const pending=[...this.#setups.values()].filter(setup=>setup.phase!=='created'&&setup.cleanup!=='closed');
  for(const setup of pending)this.#cancelSetup(setup);
  const outcomes=await Promise.allSettled(pending.map(setup=>setup.retirement));
  const stopped=outcomes.every(outcome=>outcome.status==='fulfilled')&&pending.every(setup=>setup.cleanup==='closed');
  return stopped?{stopped:true}:{stopped:false,message:'Coding MCP setup closure is unconfirmed; retained setup evidence remains available.'};
 }
 #members(){return [...this.#live.values(),...(this.#legacyLive?[this.#legacyLive]:[])];}
 get disposal(){return this.#closing??Promise.all([...this.#followupWrites,...this.#members().map(x=>x.engine?.disposal),...[...this.#setups.values()].flatMap(s=>[s.preparation,s.retirement]),...(!this.#operations.size&&!this.#allocating.size?[...this.#selectedStops.values()].map(s=>s.work):[])]);}
 get exitUnconfirmed(){return this.#exitUnconfirmed();}
 #exitUnconfirmed(scoped=false){return !!this.#startupCopies?.blocked||[...this.#setups.values()].some(s=>['pending','unconfirmed'].includes(s.cleanup))||[...this.#selectedStops.values()].some(s=>s.pending)||!!this.#native||!!this.#blocked||this.#legacyUncertain()||this.#allocating.size>0||this.#members().some(x=>x.engine?.exitUnconfirmed)||this.#rows.some(r=>r.fork?.worker&&!r.fork.worker.closed||r.generation?.nativeOpen&&!this.#live.has(r.id)||r.generation&&(r.generation.execution==='unrevoked'||!r.generation.executorClosed)&&!this.#observing(r)&&!(scoped&&(this.#coldMutationRow(r)||this.#quarantined(r)&&(!r.generation.nativeOpen||this.#current(this.#live.get(r.id))&&this.#live.get(r.id).engine.historyOnly))));}
 // Legacy owns a history reader; prior unknown writers retain the execution fence.
 get shutdownUnconfirmed(){return !!this.#startupCopies?.blocked||[...this.#setups.values()].some(s=>s.cleanup!=='closed')||!!this.#blocked&&this.#blocked!==this.#initialAdmissionFailure||!!this.#legacy?.nativeOpen||!!this.#legacyLive||!!this.#native||this.#live.size>0||this.#operations.size>0||this.#allocating.size>0||this.#inspections.size>0||!!this.#authority.projectMutation||this.#authority.exitUnconfirmed||[...this.#selectedStops.values()].some(s=>s.pending)||this.#rows.some(r=>r.fork?.worker&&!r.fork.worker.closed||r.generation&&(r.generation.nativeOpen||!r.generation.executorClosed&&!this.#quarantined(r)));}
 get runs(){return this.#aggregate('runs');}
 get terminals(){return this.#aggregate('terminals');}
 #aggregate(key){const out=new Map();for(const live of this.#members())for(const [id,value] of live.engine?.[key]??[]){if(out.has(id))throw Error('Conflicting live coding capability.');out.set(id,value);}return out;}
 #serial(fn){this.#queuePending++;const work=this.#queue.then(fn).finally(()=>{this.#queuePending--;});this.#queue=work.catch(()=>{});return work;}
 #check(epoch,operation){
  if(this.closed||epoch!==this.#epoch)throw Error('Coding owner operation cancelled by Stop.');if(this.#blocked)throw this.#blocked;
  if(operation){if(operation.controller.signal.aborted)throw Error('Coding owner operation cancelled by Stop.');for(const owner of operation.owners){const row=this.#rows.find(r=>r.id===owner);if((operation.revisions.get(owner)??0)!==(this.#ownerRevisions.get(owner)??0)||this.#selectedStops.get(owner)?.pending||!operation.stopRequest&&this.#stopIntents.has(row?.rootThreadId))throw Error('Coding owner operation cancelled by selected Stop.');}}
 }
 #operation(epoch,origin=null){
  if(origin&&this.#origins.has(origin.requestId))throw Error('Coding request origin is already active.');
  const operation={epoch,revisions:new Map(this.#ownerRevisions),owners:new Set(),provisional:new Set(),controller:new AbortController()};
  if(origin){
   operation.requestId=origin.requestId;this.#origins.set(origin.requestId,operation);
   if(origin.signal){const abort=()=>operation.controller.abort();origin.signal.addEventListener('abort',abort,{once:true});operation.detachOrigin=()=>origin.signal.removeEventListener('abort',abort);if(origin.signal.aborted)abort();}
  }
  operation.settled=new Promise(resolve=>operation.release=resolve);return operation;
 }
 #bind(operation,row,provisional=false){if(!operation||!row)return;operation.owners.add(row.id);if(provisional)operation.provisional.add(row.id);this.#check(operation.epoch,operation);}
 #release(operation){operation.provisioning?.cancel();operation.detachOrigin?.();if(this.#origins.get(operation.requestId)===operation)this.#origins.delete(operation.requestId);this.#operations.delete(operation);operation.release();}
 #startupProgress(row,live,generation,operation,stage,fraction){
  // Display only: stale/malformed observations cannot affect execution or Stop.
  const current=()=>!!operation?.requestId&&!this.closed&&!this.#blocked&&operation.epoch===this.#epoch&&!operation.controller.signal.aborted&&this.#origins.get(operation.requestId)===operation&&this.#operations.has(operation)&&this.#live.get(row.id)===live&&row.generation?.id===generation&&!live.admissionClosed&&!live.retiring&&!live.controller.signal.aborted;
  if(!['allocating','installing','booting','waiting-connection','waiting-review','finishing-setup','preparing-project'].includes(stage)||!current())return;
  if(fraction!==undefined&&(stage!=='installing'||typeof fraction!=='number'||!Number.isFinite(fraction)||fraction<0||fraction>1))return;
  operation.progressCurrent=current;
  if(operation.progress?.stage!==stage||operation.progress?.fraction!==fraction)operation.progress=Object.freeze({revision:(operation.progress?.revision??0)+1,stage,...(fraction===undefined?{}:{fraction})});
 }
 #provisioningReady(row,live,generation,operation,value,signal){
  shape(value,['ownerId','generation','guestId']);
  if(!(signal instanceof AbortSignal)||value.ownerId!==row.id||value.generation!==generation||typeof value.guestId!=='string'||!/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/.test(value.guestId))throw Error('Invalid owned provisioning identity.');
  const current=()=>{
   this.#check(operation.epoch,operation);
   if(!operation.requestId||this.#origins.get(operation.requestId)!==operation||!this.#operations.has(operation)||this.#live.get(row.id)!==live||row.generation?.id!==generation||!live.executorExpected||live.engine||live.binding||live.admissionClosed||live.retiring||live.controller.signal.aborted||signal.aborted)throw Error('Provisioning request is stopped, stale or outside startup.');
  };
  current();if(live.provisioningInvoked||operation.provisioning)throw Error('Provisioning callback was already admitted.');live.provisioningInvoked=true;
  const pending=Object.freeze({id:randomUUID(),ownerId:row.id,generation,guestId:value.guestId,cwd:row.cwd}),signals=new Set([signal,live.controller.signal,operation.controller.signal]);
  let resolve,reject,settled=false;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});
  const finish=(accepted=false)=>{if(settled)return;settled=true;if(operation.provisioning===record)delete operation.provisioning;for(const signal of signals)signal.removeEventListener('abort',cancel);if(accepted)resolve(true);else reject(Error('Provisioning review was cancelled or expired.'));};
  const cancel=()=>finish(),record={pending,current,cancel,continue:()=>finish(true)};operation.provisioning=record;
  this.#startupProgress(row,live,generation,operation,'waiting-review');
  for(const signal of signals)signal.addEventListener('abort',cancel,{once:true});if([...signals].some(signal=>signal.aborted))cancel();return promise;
 }
 provisioning(input){
  shape(input,input?.action==='status'?['action','requestId']:['action','requestId','pending','decision']);
  if(!['status','decide'].includes(input.action)||!uuid(input.requestId))throw Error('Invalid provisioning control request.');
  const operation=this.#origins.get(input.requestId),record=operation?.provisioning;
  if(input.action==='status'){
   if(record)try{record.current();}catch{record.cancel();}
   const progress=operation?.progress&&operation.progressCurrent()&&(operation.progress.stage!=='waiting-review'||operation.provisioning)?{...operation.progress}:null;
   return {requestId:input.requestId,pending:operation?.provisioning?{...operation.provisioning.pending}:null,progress};
  }
  shape(input.pending,['id','ownerId','generation','guestId','cwd']);
  if(!['continue','cancel'].includes(input.decision)||!record||Object.keys(record.pending).some(key=>input.pending[key]!==record.pending[key]))throw Error('Provisioning decision is changed, expired or already consumed.');
  record.current();
  if(input.decision==='continue')record.continue();else{record.cancel();operation.controller.abort();}
  return {requestId:input.requestId,id:record.pending.id,decision:input.decision,accepted:true};
 }
 #requestOwnerStop(row,retire=false){
   this.#quarantineFence(row);const queuePause=id(row.rootThreadId)?this.#pauseFollowups(row.rootThreadId):Promise.resolve();
  // Fork Stop and setup cancellation close their provisional resources.
  if(!retire&&nativeOwner(row)&&![...this.#operations].some(operation=>operation.fork&&operation.owners.has(row.id)))return this.#requestNativeStop(row,queuePause);
  const view=()=>({rootThreadId:row.rootThreadId,targetThreadId:row.rootThreadId,state:'stopping',message:'Owner Stop requested; closure is pending.'});
  if(this.#selectedStops.get(row.id)?.pending)return view();
  const targets=new Set([row.id]),affected=new Set();
  // Only provisional destinations depend on a cancelled operation. Merely
  // observing both A and B (for example a list) must not retire both owners.
  for(let grew=true;grew;){grew=false;for(const operation of this.#operations)if([...operation.owners].some(id=>targets.has(id))){affected.add(operation);for(const id of operation.provisional)if(!targets.has(id)){targets.add(id);grew=true;}}}
  const ticket={pending:true,error:null,retiring:true},entries=[];
  for(const id of targets){const owned=this.#rows.find(r=>r.id===id),live=this.#live.get(id);this.#ownerRevisions.set(id,(this.#ownerRevisions.get(id)??0)+1);this.#selectedStops.set(id,ticket);entries.push({row:owned,generation:owned.generation?.id,live,cleanup:live?this.#cleanup(owned,live):null});}
  for(const operation of affected)operation.controller.abort();
  ticket.work=(async()=>{
   // Neither operation settlement nor raw cleanup may hold the catalog queue.
   await Promise.all([...affected].map(operation=>operation.settled));
   await queuePause;
   for(const entry of entries){
    if(entry.row.generation?.id!==entry.generation)throw this.#block(Error('Selected Stop generation changed.'));
    const current=this.#live.get(entry.row.id);if(entry.live&&current&&current!==entry.live)throw this.#block(Error('Selected Stop live ownership changed.'));
    if(!entry.live&&current){entry.live=current;entry.cleanup=this.#cleanup(entry.row,current);}
    if(entry.cleanup)entry.outcome=await entry.cleanup;
   }
   await this.#serial(async()=>{
    for(const entry of entries){
     if(entry.row.generation?.id!==entry.generation)throw this.#block(Error('Selected Stop generation changed before commit.'));
     const current=this.#live.get(entry.row.id);if(current&&current!==entry.live)throw this.#block(Error('Selected Stop live ownership changed before commit.'));
     if(current)await this.#retire(entry.row,current,entry.outcome);
    }
   });
  })().catch(error=>{ticket.error=error.message;}).finally(()=>{
   ticket.pending=false;
   // Settlement invalidates UI metadata; fresh guarded reads still decide closure.
   for(const {row:owned} of entries)if(owned.rootThreadId)this.#journal.push('coding/family/updated',{threadId:owned.rootThreadId,rootThreadId:owned.rootThreadId});
  });
  return view();
 }
 #requestNativeStop(row,queuePause){
  const view=()=>({rootThreadId:row.rootThreadId,targetThreadId:row.rootThreadId,state:'stopping',executionMode:'native',message:'Stopping tracked native work; detached host processes are outside this scope.'});
  if(this.#selectedStops.get(row.id)?.pending)return view();
  const live=this.#live.get(row.id),engine=live?.engine;
  if(!engine||engine.historyOnly){if(row.generation?.execution!=='native-stopped'||!row.generation.executorClosed)throw Error('Native tracked closure is unconfirmed.');this.#ownerRevisions.set(row.id,(this.#ownerRevisions.get(row.id)??0)+1);return queuePause.then(()=>({...view(),state:'stopped'}));}
  if(!this.#current(live)||live.nativeStopError)throw Error('Native tracked closure is unconfirmed.');
  const generation=row.generation.id,ticket={pending:true,error:null};
  this.#ownerRevisions.set(row.id,(this.#ownerRevisions.get(row.id)??0)+1);this.#selectedStops.set(row.id,ticket);
  const affected=[...this.#operations].filter(operation=>operation.owners.has(row.id));for(const operation of affected)operation.controller.abort();
  ticket.work=(async()=>{
   const requested=engine.interruptFamily(row.rootThreadId),settled=engine.familyStops.get(row.rootThreadId);
   await requested;await settled;await engine.stopCommandRequests(live.life);
   await Promise.all(affected.map(operation=>operation.settled));
   await queuePause;
   await this.#serial(async()=>{
    if(this.#live.get(row.id)!==live||row.generation.id!==generation||engine.closed||engine.processLife!==live.life||engine.child!==live.life?.child||live.life?.exited||engine.epoch!==live.epoch||engine.exitUnconfirmed||engine.runs.size||engine.terminals.size||engine.commandRequests.size)throw Error('Native tracked Stop could not confirm completion.');
    row.generation.execution='native-stopped';await this.#save();
   });
  })().catch(error=>{ticket.error=error.message;live.nativeStopError=error;}).finally(()=>{ticket.pending=false;this.#journal.push('coding/family/updated',{threadId:row.rootThreadId,rootThreadId:row.rootThreadId});});
  return view();
 }
 #block(error){this.#blocked??=Object.assign(Error('Coding owner catalog is blocked and preserved: '+error.message),error.code==='NATIVE_QUARANTINE_INVALID'?{code:error.code}:{});return this.#blocked;}
 #quarantineFence(row){if(row&&Object.hasOwn(row,'quarantine'))throw Object.assign(Error('This failed native owner is permanently quarantined; only preserved history and saved evidence may be read.'),{code:'NATIVE_OWNER_QUARANTINED'});}
 #quarantined(row){const proof=this.#quarantines.get(row.id);return !!proof&&equal(row,{...proof.originalRow,generation:{...proof.originalRow.generation,nativeOpen:row.generation?.nativeOpen},quarantine:proof.pointer});}
 async #verifyQuarantines(rows=this.#rows,directory=this.#directory,ownersDirectory=this.#ownersDirectory){
  try{
   const quarantined=rows.filter(row=>Object.hasOwn(row,'quarantine'));
   if([...this.#quarantines.keys()].some(id=>!quarantined.some(row=>row.id===id)))throw Error('A verified quarantine owner disappeared.');
   for(const row of quarantined){
    const proof=await readNativeQuarantine({dataDir:this.dataDir,row,directory,ownersDirectory,nativeHelper:this.#engineOptions.nativeHelper,expected:this.#quarantines.get(row.id)?.seal});this.#validate(proof.originalCatalog);
    const value={...proof,pointer:structuredClone(row.quarantine)},previous=this.#quarantines.get(row.id);if(previous&&!equal(previous,value))throw Error('Verified quarantine evidence changed.');
    this.#quarantines.set(row.id,freeze(value));
   }
  }catch(error){throw this.#block(Object.assign(Error(error.message),{code:'NATIVE_QUARANTINE_INVALID'}));}
 }
 async #quarantineScope(paths,check){if(this.#quarantines.size){const recheck=await this.#mutationScope(paths,check,true);await recheck?.();}}

 async #dir(path,expected){
  const s=await lstat(path,{bigint:true}),live=stamp(s),prior=this.#liveDirectories.get(path);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(path)!==path||prior&&!same(live,prior))throw Error('Coding owner directory identity or permissions changed.');
  const binding=this.#durableIdentity?await readFilesystemIdentity({path,nativeHelper:this.#engineOptions.nativeHelper}):live;
  const after=await lstat(path,{bigint:true});
  if(!same(live,stamp(after))||s.mode!==after.mode||s.uid!==after.uid||await realpath(path)!==path||expected&&!sameBinding(binding,expected))throw Error('Coding owner directory identity or permissions changed.');
  this.#liveDirectories.set(path,live);return binding;
 }
 async #root(path,expected){await this.#dir(path,expected);return {path,...this.#liveDirectories.get(path)};}
 async #savedFileIdentity(path,expected){
  const before=await lstat(path,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||!same(stamp(before),expected))throw Error('Coding owner saved file identity changed.');
  const binding=this.#durableIdentity?await readFilesystemIdentity({path,nativeHelper:this.#engineOptions.nativeHelper}):expected;
  if(!same(stamp(await lstat(path,{bigint:true})),expected))throw Error('Coding owner saved file identity changed.');return binding;
 }
 async #syncDir(path=this.dataDir){const file=await open(path,constants.O_RDONLY);try{await file.sync();}finally{await file.close();}}
 async #file(path){
  const before=await optional(path);if(!before)return null;
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.uid!==BigInt(process.getuid())||(before.mode&0o077n)||before.size>BigInt(MAX))throw Error('Invalid coding catalog file type, ownership or size.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await file.stat({bigint:true});if(!same(stamp(info),stamp(before)))throw Error('Coding catalog file changed while opening.');const bytes=await file.readFile();if(bytes.length>MAX)throw Error('Coding catalog exceeds its limit.');return {bytes,hash:hash(bytes),identity:stamp(info)};}finally{await file.close();}
 }
 async #guard(){
  await this.#dir(this.dataDir,this.#directory);await this.#dir(join(this.dataDir,'owners'),this.#ownersDirectory);
  if(!this.#legacy&&await this.#hasLegacy())throw Error('Legacy history appeared after owner admission; preserve it and reopen with explicit legacy history authority.');
  const lease=await this.#file(join(this.dataDir,'coding-owners.lock'));if(!this.#lease||!lease||!same(lease.identity,this.#lease.identity)||lease.bytes.toString()!==this.#lease.token)throw Error('Coding owner lease changed.');
  await this.#verifyQuarantines();
 }
 #validate(data){
  const validIdentity=data?.version>=10?isFilesystemIdentity:identity;
  shape(data,['version','directory','ownersDirectory','owners',...(data?.version>=2?['legacy']:[]),...(data?.version>=6?['executor']:[])]);if(![1,2,3,4,5,6,7,8,9,10,11,12,13].includes(data.version)||!validIdentity(data.directory)||!validIdentity(data.ownersDirectory)||!Array.isArray(data.owners)||data.owners.length>LIMIT)throw Error('Invalid coding owner catalog.');
  if(data.version>=2&&data.legacy!==null){shape(data.legacy,['nativeOpen',...(data.version===8||data.version>=9&&Object.hasOwn(data.legacy,'admission')?['admission','reader']:[])]);if(typeof data.legacy.nativeOpen!=='boolean')throw Error('Invalid legacy history ownership.');if(data.version===8||data.version>=9&&Object.hasOwn(data.legacy,'admission')){verifyLegacyProvenance(data.legacy.admission);if(data.legacy.reader!==null)verifyHandoffProcessIdentity(data.legacy.reader);}}
  const owners=new Set(),threads=new Set(),homes=new Set();
  for(const r of data.owners){
   shape(r,['id','home','rootThreadId','threads','cwd','provider','model','state','generation',...(data.version>=3?['creation']:[]),...(data.version>=4?['fork']:[]),...(data.version>=7?['mcp']:[]),...(data.version>=11&&Object.hasOwn(r,'executionMode')?['executionMode']:[]),...(data.version>=12&&Object.hasOwn(r,'handoff')?['handoff']:[]),...(data.version>=13&&Object.hasOwn(r,'quarantine')?['quarantine']:[])]);
   if(Object.hasOwn(r,'executionMode')&&(data.version<11||r.executionMode!=='native'))throw Error('Invalid coding execution mode.');
   if(data.version>=7){shape(r.mcp,r.mcp?.kind==='journal'?['kind','storeId']:['kind']);if(!['never-enabled','journal'].includes(r.mcp.kind)||r.mcp.kind==='journal'&&(!uuid(r.mcp.storeId)||!r.home))throw Error('Invalid owner MCP provenance.');}
   if(!uuid(r.id)||owners.has(r.id)||typeof r.cwd!=='string'||!isAbsolute(r.cwd)||r.cwd.length>4096||r.cwd.includes('\0')||!['local','cloud'].includes(r.provider)||!['creating','ready'].includes(r.state)||!Array.isArray(r.threads)||r.threads.length>2048||r.model!==null&&(typeof r.model!=='string'||!r.model||r.model.length>200))throw Error('Invalid coding owner record.');owners.add(r.id);
   if(r.home!==null){if(!validIdentity(r.home)||homes.has(bindingKey(r.home)))throw Error('Duplicate or invalid coding owner home.');homes.add(bindingKey(r.home));}
   if(r.state==='ready'&&(!id(r.rootThreadId)||!r.model||!r.home||!r.threads.includes(r.rootThreadId))||r.state==='creating'&&(r.rootThreadId!==null||r.threads.length))throw Error('Invalid coding root creation state.');
   for(const t of r.threads){if(!id(t)||threads.has(t))throw Error('Duplicate coding thread ownership.');threads.add(t);}
   if(data.version>=3&&r.creation!==null){
    shape(r.creation,['createdAt','updatedAt','name','historyMode']);const c=r.creation;
    if(r.state!=='ready'||r.threads.length!==1||['createdAt','updatedAt'].some(k=>c[k]!==null&&(!Number.isSafeInteger(c[k])||c[k]<0))||c.name!==null&&(typeof c.name!=='string'||c.name.length>2000||c.name.includes('\0'))||!['legacy','paginated',null].includes(c.historyMode))throw Error('Invalid empty chat creation receipt.');
   }
   if(r.generation!==null){shape(r.generation,['id','nativeOpen','execution',...(data.version>=5?['executorClosed']:[])]);if(!uuid(r.generation.id)||typeof r.generation.nativeOpen!=='boolean'||data.version>=5&&typeof r.generation.executorClosed!=='boolean'||!(nativeOwner(r)?['native-active','native-stopped']:['unrevoked','revoked']).includes(r.generation.execution)||nativeOwner(r)&&r.generation.execution==='native-active'&&r.generation.executorClosed||!r.home)throw Error('Invalid coding generation.');}
   if(Object.hasOwn(r,'handoff'))handoffMarker(r.handoff,r);
   if(Object.hasOwn(r,'quarantine')){const q=r.quarantine;shape(q,['version','receiptSHA256','receiptIdentity']);if(q.version!==1||!digest(q.receiptSHA256)||!isFilesystemIdentity(q.receiptIdentity)||!nativeOwner(r)||r.state!=='ready'||r.mcp.kind!=='journal'||r.creation!==null||r.fork!==null||Object.hasOwn(r,'handoff')||!r.generation||r.generation.execution!=='native-active'||r.generation.executorClosed!==false)throw Error('Invalid quarantined owner pointer or generation.');}
   if(data.version>=4&&r.fork!==null){
    const f=r.fork;shape(f,['sourceOwnerId','sourceGeneration','sourceThreadId','sourceHome','sourcePath','sourceIdentity','sha256','stage','worker','snapshot','dispatched']);
    if(!uuid(f.sourceOwnerId)||f.sourceOwnerId===r.id||!uuid(f.sourceGeneration)||!id(f.sourceThreadId)||!validIdentity(f.sourceHome)||!rolloutPath(f.sourcePath)||!validIdentity(f.sourceIdentity)||!digest(f.sha256)||typeof f.dispatched!=='boolean'||r.creation!==null)throw Error('Invalid fork provenance.');
    if(f.stage!==null&&!validIdentity(f.stage)||f.snapshot!==null&&(!validIdentity(f.snapshot)||!f.stage||!f.worker?.closed)||f.dispatched&&(!f.snapshot||!r.generation||!r.home)||r.state==='ready'&&(!f.dispatched||r.rootThreadId===f.sourceThreadId))throw Error('Invalid fork stage or dispatch state.');
    if(f.worker!==null){shape(f.worker,['process','requestHash','closed']);if(!f.stage||typeof f.worker.closed!=='boolean'||!digest(f.worker.requestHash))throw Error('Invalid fork worker state.');verifyHandoffProcessReceipt(f.worker.process,{nonce:f.worker.process?.nonce,pid:f.worker.process?.pid});}
   }
  }
  if(data.version>=11&&!data.owners.some(nativeOwner))throw Error('Native catalog version requires a native owner.');
  if(data.version===13&&!data.owners.some(row=>Object.hasOwn(row,'quarantine')))throw Error('Quarantine catalog requires its retained owner.');
  if(data.version>=4)for(const r of data.owners)if(r.fork){const source=data.owners.find(s=>s.id===r.fork.sourceOwnerId);if(!source||source.state!=='ready'||source.rootThreadId!==r.fork.sourceThreadId||!sameBinding(source.home,r.fork.sourceHome))throw Error('Fork source owner provenance changed.');}
  if(data.version>=6&&data.executor!==null){
   const e=data.executor;shape(e,['runtime','allocations']);shape(e.runtime,['path','identity']);if(!absolutePath(e.runtime.path)||!validIdentity(e.runtime.identity)||!Array.isArray(e.allocations)||e.allocations.length>LIMIT)throw Error('Invalid executor allocation catalog.');
   const generations=new Set(),directories=new Set();for(const a of e.allocations){shape(a,['ownerId','generation','resources','identity','closed',...(data.version>=9?['diskRelease']:[])]);if(data.version>=9&&a.diskRelease!==null){shape(a.diskRelease,['receiptSHA256','receiptIdentity']);if(!a.closed||!a.identity||!digest(a.diskRelease.receiptSHA256)||!validIdentity(a.diskRelease.receiptIdentity))throw Error('Invalid released disk reservation.');}resourceValues(a.resources);if(!owners.has(a.ownerId)||!uuid(a.generation)||generations.has(a.generation)||typeof a.closed!=='boolean'||a.identity!==null&&!validIdentity(a.identity))throw Error('Invalid executor reservation.');const owner=data.owners.find(r=>r.id===a.ownerId);if(nativeOwner(owner))throw Error('Native owners cannot own VM allocations.');if(a.closed&&owner.generation?.id===a.generation&&!owner.generation.executorClosed)throw Error('Closed executor reservation has no matching physical closure.');generations.add(a.generation);if(a.identity){const key=bindingKey(a.identity);if(directories.has(key))throw Error('Duplicate executor allocation directory.');directories.add(key);}}
  }
 }
 async #hasLegacy(){for(const name of ['config.toml','sessions','archived_sessions','interrupted-history.json'])if(await optional(join(this.dataDir,name)))return true;return false;}
 async #load(operation){
  if(this.#blocked)throw this.#blocked;
  if(this.#loading)return this.#loading;
  if(this.#loaded){await this.#checkDisk();return;}
  const work=this.#loadCatalog(operation);this.#loading=work;try{return await work;}finally{if(this.#loading===work)this.#loading=null;}
 }
 async #loadCatalog(operation){
  const epoch=this.#epoch;
  try{
   await mkdir(this.dataDir,{recursive:true,mode:0o700});this.#directory=await this.#dir(this.dataDir);
   const legacyFound=await this.#hasLegacy(),current=await this.#file(join(this.dataDir,'coding-owners.json'));
   const data=current?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(current.bytes)):null;if(data)try{this.#validate(data);}catch(error){if(data.version===13)error.code='NATIVE_QUARANTINE_INVALID';throw error;}
   this.#quarantineCatalog=data?.version===13;this.#handoffCatalog=data?.version>=12;this.#durableIdentity=data?data.version>=10:!!this.#engineOptions.nativeHelper;this.#directory=await this.#dir(this.dataDir);
   if(await optional(join(this.dataDir,'coding-owners.lock')))throw Error('Coding owner lease is already owned or needs recovery.');
   if(this.#quarantineCatalog){const owners=await this.#dir(join(this.dataDir,'owners'),data.ownersDirectory);if(!sameBinding(data.directory,this.#directory))throw Error('Quarantine catalog directory changed.');await this.#verifyQuarantines(data.owners,this.#directory,owners);this.#check(epoch,operation);}
   if(legacyFound||data?.legacy){
    if(this.#legacyAdmission){
     const initial=!current&&!await optional(join(this.dataDir,'owners'));
     const controller=new AbortController(),signal=operation?AbortSignal.any([controller.signal,operation.controller.signal]):controller.signal;this.#admissionController=controller;
     try{
      this.#check(epoch,operation);const proof=await this.#legacyAdmission.verify({dataDir:this.dataDir,signal});this.#check(epoch,operation);if(signal.aborted)throw Error('Legacy admission cancelled.');
      const prior=data?.legacy?.admission;
      // A changed release must explicitly name the saved predecessor. The fixed
      // admission root preserves history identity without permitting rollback.
      if(proof.version===3){
       if(!prior||![2,3].includes(prior.version)||(prior.intentSha256!==proof.intentSha256&&prior.intentSha256!==proof.predecessorIntentSha256)||(prior.version===2?prior.intentSha256:prior.admissionIntentSha256)!==proof.admissionIntentSha256||!['previousBootSession','originalIntentSha256','adoptionBootSession'].every(key=>prior[key]===proof[key])||!['path','volumeUUID','ino','uid'].every(key=>prior.dataDirectory[key]===proof.dataDirectory[key]))throw Error('Saved legacy provenance differs from the reviewed intent.');
      }else if(prior&&prior.intentSha256!==proof.intentSha256)throw Error('Saved legacy provenance differs from the reviewed intent.');
      this.#admissionProof=proof;
     }
     catch(error){
      // Only this settled, pre-lease admission can prove no coordinator resources.
      // Preserve the block and unknown legacy execution; physical close may drain.
      if(initial&&!this.#lease)try{
       await this.#dir(this.dataDir,this.#directory);
       if(!(await Promise.all(['coding-owners.json','coding-owners.lock','owners'].map(name=>optional(join(this.dataDir,name))))).some(Boolean))this.#initialAdmissionFailure=this.#block(error);
      }catch{} // Failed absence/identity inspection grants no closure exception.
      throw error;
     }finally{if(this.#admissionController===controller)this.#admissionController=null;}
    }else if(data?.legacy?.admission||legacyFound&&!this.#assertLegacyClosed&&!current)throw Error('Legacy Coding history requires explicit native-home closure authority.');
   }
   if(this.#admissionProof)this.#check(epoch,operation);
   const path=join(this.dataDir,'coding-owners.lock'),token=this.#admissionProof?JSON.stringify({version:1,nonce:randomUUID(),owner:this.#admissionProof.owner}):randomUUID();let file;
   try{file=await open(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('Coding owner lease is already owned or needs recovery.');throw e;}
   try{await file.writeFile(token);await file.sync();this.#lease={token,identity:stamp(await file.stat({bigint:true}))};}finally{await file.close();}
   await mkdir(join(this.dataDir,'owners'),{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});this.#ownersDirectory=await this.#dir(join(this.dataDir,'owners'));await this.#syncDir();
   let upgrade=false;
   if(current){if(!sameBinding(data.directory,this.#directory)||!sameBinding(data.ownersDirectory,this.#ownersDirectory))throw Error('Coding owner catalog directory was replaced.');this.#rows=data.owners;this.#legacy=data.legacy??null;this.#executor=data.executor??null;this.#diskStamp=current.identity;this.#diskHash=current.hash;upgrade=data.version<7;if(upgrade)for(const row of this.#rows){if(data.version<3)row.creation=null;if(data.version<4)row.fork=null;if(data.version<5&&row.generation)row.generation.executorClosed=false;row.mcp={kind:'never-enabled'};}}
   if(current&&data.version<9){for(const a of this.#executor?.allocations??[])a.diskRelease=null;upgrade=true;}
   if(legacyFound&&!this.#legacy){if(!this.#assertLegacyClosed&&!this.#admissionProof)throw Error('Legacy Coding history requires explicit native-home closure authority.');this.#legacy={nativeOpen:false};upgrade=true;}
   if(this.#legacy&&this.#admissionProof){this.#legacy.admission=this.#admissionProof;this.#legacy.reader??=null;upgrade=true;}
   if(!current&&(await readdir(join(this.dataDir,'owners'))).length)throw Error('Coding catalog is missing while owner homes remain; recovery is required.');
   // Released failed startups retain their execution fence. Their physical-only
   // scope exception requires the exact durable release to verify on cold load.
   for(const a of this.#executor?.allocations??[])if(a.diskRelease&&isFailedDiskOwner(this.#rows.find(r=>r.id===a.ownerId),a)){await verifyDiskRelease(this.#diskContext(a));this.#check(epoch,operation);this.#verifiedFailedReleases.set(a,JSON.stringify(a.diskRelease));}
   await this.#startupCopies.verifyWorkers();this.#check(epoch,operation);
   this.#loaded=true;if(!current||upgrade)await this.#save();else this.#snapshot(current.bytes);
   // Only initial rows can have no producer in this instance's fresh journal.
   if(current)for(const row of this.#rows)if(row.state==='creating'&&row.generation?.nativeOpen===false&&row.generation.executorClosed===true&&(!row.fork?.worker||row.fork.worker.closed===true))this.#coldCreating.add(row);
  }catch(e){throw this.#block(e);}
 }
 async #checkDisk(){await this.#guard();const current=await this.#file(join(this.dataDir,'coding-owners.json'));if((current?.hash??null)!==this.#diskHash||!same(current?.identity,this.#diskStamp))throw this.#block(Error('Coding owner catalog changed externally.'));}
 #snapshot(bytes){this.#committed=freeze({data:JSON.parse(bytes.toString()),hash:this.#diskHash,identity:{...this.#diskStamp}});}
 #save(){
  this.#catalogRevision++;
  const work=this.#writeCatalog().finally(()=>{this.#catalogRevision++;if(this.#saving===work)this.#saving=null;});this.#saving=work;return work;
 }
 async #writeCatalog(){
  let temp;try{
   await this.#checkDisk();const data={version:this.#quarantineCatalog?13:this.#handoffCatalog?12:this.#rows.some(nativeOwner)?11:this.#durableIdentity?10:9,directory:this.#directory,ownersDirectory:this.#ownersDirectory,owners:this.#rows,legacy:this.#legacy,executor:this.#executor};this.#validate(data);const bytes=Buffer.from(JSON.stringify(data));if(bytes.length>MAX)throw Error('Coding owner catalog limit reached.');
   temp=join(this.dataDir,'coding-owners.'+randomUUID()+'.tmp');const file=await open(temp,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   // ponytail: cooperating writers use the exclusive lease; hostile external
   // replacement between the final check and rename requires native CAS publication.
   await this.#checkDisk();await rename(temp,join(this.dataDir,'coding-owners.json'));temp=null;this.#diskHash=hash(bytes);this.#diskStamp=stamp(await lstat(join(this.dataDir,'coding-owners.json'),{bigint:true}));await this.#syncDir();this.#snapshot(bytes);
  }catch(e){throw this.#block(e);}finally{if(temp)await unlink(temp).catch(()=>{});}
 }
 async #mcpEvidence(row){
  for(const name of ['coding-mcp-outcomes.json','coding-mcp-outcomes.lock','coding-mcp-state.json','coding-mcp-state.lock'])if(await optional(join(this.#home(row),name)))return true;
  return false;
 }
 #outcomeReader(row){
  let entry=this.#outcomeReaders.get(row.id);
  if(entry&&(entry.storeId!==row.mcp.storeId||!sameBinding(entry.home,row.home)))throw Error('Owner outcome reader provenance changed.');
  if(!entry){entry={storeId:row.mcp.storeId,home:{...row.home},reader:new CodingMCPOutcomes({directory:this.#home(row),ownerId:row.id,readOnly:true,nativeHelper:this.#engineOptions.nativeHelper})};this.#outcomeReaders.set(row.id,entry);}
  return entry.reader;
 }
 #blockedOutcomes(row,threadId){return {threadId,available:true,ownerId:row.id,storeId:null,revision:0,blocked:true,warning:'Owner MCP outcome evidence is missing, changed, corrupt, or inconsistent with its saved provenance. Evidence was preserved; do not retry an action automatically.',cached:false,complete:false,records:[]};}
 async #outcomeGuard(snapshot,row){
  await this.#guard();const current=await this.#file(join(this.dataDir,'coding-owners.json'));
  if(current?.hash!==snapshot.hash||!same(current?.identity,snapshot.identity))throw Error('Coding owner catalog changed externally.');
  await this.#dir(this.#home(row),row.home);
 }
 async #outcomes(threadId){
  if(this.closed)throw Error('Coding owner coordinator is closed.');
  if(!this.#committed||this.#loading)await this.#load();
  for(let attempt=0;attempt<4;attempt++){
   if(this.closed)throw Error('Coding owner coordinator is closed.');if(this.#blocked)throw this.#blocked;
   if(this.#saving)await this.#saving;
   if(this.closed)throw Error('Coding owner coordinator is closed.');
   const revision=this.#catalogRevision,snapshot=this.#committed,row=snapshot?.data.owners.find(r=>r.threads.includes(threadId));
   if(!row||row.state!=='ready'||!row.home)throw Error('Unknown durable coding thread owner; MCP history cannot be discovered or adopted.');
   const changed=()=>revision!==this.#catalogRevision||!!this.#saving;
   try{await this.#outcomeGuard(snapshot,row);}catch(error){if(this.closed)throw Error('Coding owner coordinator is closed.');if(changed())continue;throw this.#block(error);}
   if(this.closed)throw Error('Coding owner coordinator is closed.');if(this.#blocked)throw this.#blocked;if(changed())continue;
   let result;
   if(row.mcp.kind==='never-enabled')result=await this.#mcpEvidence(row)?this.#blockedOutcomes(row,threadId):{threadId,available:false};
   else{
    try{
     const engine=this.#live.get(row.id)?.engine;
     result=engine?await engine.handle({action:'mcpOutcomes',threadId}):{available:true,...await this.#outcomeReader(row).inspect({threadId})};
     if(result?.available!==true||result.threadId!==threadId||result.ownerId!==row.id||!Array.isArray(result.records)||result.records.some(record=>record.threadId!==threadId)||result.storeId!==row.mcp.storeId&&!(result.storeId===null&&result.blocked===true))result=this.#blockedOutcomes(row,threadId);
    }catch{result=this.#blockedOutcomes(row,threadId);}
   }
   try{await this.#outcomeGuard(snapshot,row);}catch(error){if(this.closed)throw Error('Coding owner coordinator is closed.');if(changed())continue;throw this.#block(error);}
   if(this.closed)throw Error('Coding owner coordinator is closed.');if(this.#blocked)throw this.#blocked;if(changed())continue;return result;
  }
  throw Error('Coding owner metadata is changing; outcome inspection is incomplete. Retry inspection.');
 }
 async #terminalResults({threadId,recordId}){
  if(this.closed)throw Error('Coding owner coordinator is closed.');if(this.#blocked)throw this.#blocked;
  // Status/list own initial admission. An evidence read never creates the lease or migrates the catalog.
  if(this.#loading)await this.#loading;
  if(!this.#committed)throw Error('Coding owner metadata is not ready; load saved history before inspecting terminal results.');
  for(let attempt=0;attempt<4;attempt++){
   if(this.closed)throw Error('Coding owner coordinator is closed.');if(this.#blocked)throw this.#blocked;
   if(this.#saving)await this.#saving;
   const revision=this.#catalogRevision,snapshot=this.#committed,row=snapshot.data.owners.find(r=>r.threads.includes(threadId));
   if(!row||row.state!=='ready'||!row.home)throw Error('Unknown durable coding thread owner; terminal results cannot be discovered or adopted.');
   const changed=()=>revision!==this.#catalogRevision||!!this.#saving;
   const verifyHome=async()=>{
    try{await this.#outcomeGuard(snapshot,row);}catch(error){if(!this.closed&&!changed())throw this.#block(error);throw error;}
    if(this.closed)throw Error('Coding owner coordinator is closed.');if(this.#blocked)throw this.#blocked;
    if(changed())throw Error('Coding owner metadata changed during terminal result inspection.');
   };
   try{
    await verifyHome();
    const reader=new CodingTerminalResults({directory:this.#home(row),ownerId:row.id,rootThreadId:row.rootThreadId,readOnly:true,getThreadIds:()=>row.threads,verifyHome});
    const result=await reader.inspect({threadId,...(recordId===undefined?{}:{recordId})});await verifyHome();
    const detail=recordId!==undefined,keys=['ownerId','threadId','omittedCount',detail?'record':'records'];
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).length!==keys.length||Object.keys(result).some(key=>!keys.includes(key))||result.ownerId!==row.id||result.threadId!==threadId||!Number.isSafeInteger(result.omittedCount)||result.omittedCount<0)throw Error('Saved terminal result returned a different owner or task.');
    if(detail?result.record?.recordId!==recordId||result.record.ownerId!==row.id||result.record.threadId!==threadId||result.record.rootThreadId!==row.rootThreadId:!Array.isArray(result.records)||result.records.length>24||result.records.some(record=>!uuid(record?.recordId))||new Set(result.records.map(record=>record.recordId)).size!==result.records.length)throw Error('Saved terminal result scope could not be verified.');
    if(Buffer.byteLength(JSON.stringify(result))>(detail?2162688:65536))throw Error('Saved terminal result response exceeds its byte limit.');
    return result;
   }catch(error){if(this.closed)throw Error('Coding owner coordinator is closed.');if(changed())continue;throw error;}
  }
  throw Error('Coding owner metadata is changing; terminal result inspection is incomplete. Retry inspection.');
 }
 async #plainMCP(row){this.#quarantineFence(row);if(row.mcp.kind!=='never-enabled'||await this.#mcpEvidence(row))throw Error('Owner MCP execution or custom fork requires explicit integration; saved outcomes remain inspectable.');}
 async #executionMCP(row){
  this.#quarantineFence(row);const epoch=this.#epoch;await this.#quarantineScope([row.cwd],()=>this.#check(epoch));
  if(row.mcp.kind==='never-enabled')return this.#plainMCP(row);
  const live=this.#live.get(row.id),binding=live?.codingMCP,setup=live?.setup;
  if(!this.#current(live)||!binding||!setup||setup.controller.signal.aborted||binding.signal.aborted||binding.ownerId!==row.id||binding.generation!==row.generation?.id||setup.generation!==binding.generation||binding.outcomes!==live.outcomes||live.storeId!==row.mcp.storeId||!row.rootThreadId)throw Error('Owner MCP execution requires its original live reviewed generation; saved outcomes remain inspectable.');
 }
 async #runtime(runtime,allocations,recording=null){
  await this.#checkDisk();await this.#dir(runtime.path,runtime.identity);
  const path=join(runtime.path,'owner-catalog.json');let receipt=await this.#file(path);
  if(!receipt){
   if(this.#executor||this.#runtimeReceipt||(await readdir(runtime.path)).length)throw Error('Executor runtime binding is missing or runtime is not empty.');
   const file=await open(path,'wx',0o600);try{await file.writeFile(JSON.stringify({version:this.#durableIdentity?2:1,catalog:{path:this.dataDir,identity:this.#directory},runtime}));await file.sync();}finally{await file.close();}await this.#syncDir(runtime.path);receipt=await this.#file(path);
  }
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(receipt.bytes));shape(value,['version','catalog','runtime']);shape(value.catalog,['path','identity']);shape(value.runtime,['path','identity']);
  const validIdentity=this.#durableIdentity?isFilesystemIdentity:identity;
  if(value.version!==(this.#durableIdentity?2:1)||value.catalog.path!==this.dataDir||!validIdentity(value.catalog.identity)||!sameBinding(value.catalog.identity,this.#directory)||value.runtime.path!==runtime.path||!validIdentity(value.runtime.identity)||!sameBinding(value.runtime.identity,runtime.identity)||this.#runtimeReceipt&&(this.#runtimeReceipt.hash!==receipt.hash||!same(this.#runtimeReceipt.identity,receipt.identity)))throw Error('Executor runtime belongs to another catalog or its binding changed.');
  this.#runtimeReceipt=receipt;
  for(const name of await readdir(runtime.path)){
   if(name==='owner-catalog.json')continue;
   const a=allocations.find(a=>name===a.ownerId+'-'+a.generation),expected=a?.identity??(recording&&recording.reservation===a?recording.identity:null);
   if(!a||!expected)throw Error('Executor runtime contains an unexplained or unbound allocation.');
   await this.#dir(join(runtime.path,name),expected);
  }
  const released=allocations.filter(a=>a.diskRelease);
  for(let i=0;i<released.length;i+=4){
   const outcomes=await Promise.allSettled(released.slice(i,i+4).map(async a=>verifyDiskRelease(this.#diskContext(a))));
   const failure=outcomes.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  }
  await this.#dir(runtime.path,runtime.identity);await this.#checkDisk();
 }
 async #admission(request=true,mode='vm'){
  const policy=this.#executorPolicy;
  if(!policy){if(this.#executor)throw Error('Executor policy is required for this admitted catalog.');return;}
  if(this.#legacyUncertain()||this.#rows.some(row=>!nativeOwner(row)&&row.generation&&!this.#executor?.allocations.some(a=>a.ownerId===row.id&&a.generation===row.generation.id)))throw Error('Historical executor resources are unknown; explicit migration is required.');
  if(this.#executor&&this.#executor.runtime.path!==policy.runtimeDir)throw Error('Executor policy runtime differs from the catalog binding.');
  const runtime=this.#executor?.runtime??{path:policy.runtimeDir,identity:await this.#dir(policy.runtimeDir)};
  await this.#runtime(runtime,this.#executor?.allocations??[]);
  if(!this.#executor){this.#executor={runtime,allocations:[]};await this.#save();}
  if(!request||mode==='native')return;
  if(this.#executor.allocations.length>=LIMIT)throw Error('Executor allocation history limit reached.');
  const diskHelp=' To reclaim a retired workspace, select its saved chat and choose Chat actions → Reclaim retired guest disk…. For an incomplete startup, quit and reopen the app, then choose Review failed guest storage…. Saved chats stay; guest-only files are permanently deleted only after confirmation.';
  const total={cpu:0,memoryBytes:0,diskBytes:0,concurrent:0},add=(key,value)=>{if(value>policy.limits[key]-total[key])throw Error(key==='diskBytes'?'Coding workspace storage is full.'+diskHelp:'Executor resource capacity exceeded: '+key+'.');total[key]+=value;};
  for(const a of this.#executor.allocations){if(!a.diskRelease)add('diskBytes',a.resources.diskBytes);if(!a.closed){add('cpu',a.resources.cpu);add('memoryBytes',a.resources.memoryBytes);add('concurrent',1);}}
  for(const key of resourceKeys)add(key,policy.resources[key]);add('concurrent',1);
  const space=await statfs(runtime.path,{bigint:true});await this.#dir(runtime.path,runtime.identity);
  if(space.bsize<=0n||space.bavail<0n)throw Error('Available disk capacity could not be verified.');
  const available=space.bavail*space.bsize,required=BigInt(policy.resources.diskBytes);
  if(available<required)throw Error(`A new Coding workspace needs ${(Number(required)/1024**3).toFixed(1)} GiB of free disk space; ${(Number(available)/1024**3).toFixed(1)} GiB is available. Free disk space and try again.${diskHelp}`);
 }
 #home(row){return join(this.dataDir,'owners',row.id);}
 async #verifyHome(row){if(!row.home)throw Error('Coding owner home creation is unresolved.');await this.#guard();await this.#dir(this.#home(row),row.home);}
 async #cloudProfile(row){
  if(row.provider!=='cloud')return null;
  await this.#verifyHome(row);const path=join(this.#home(row),'providers.json'),saved=await this.#file(path);
  if(!saved)throw Object.assign(Error('Choose Bind cloud provider for this saved chat before continuing. Its history is still available.'),{code:'CLOUD_BINDING_REQUIRED'});
  const profile=parseCodingProvider(new TextDecoder('utf-8',{fatal:true}).decode(saved.bytes));
  if(!profile?.credentialId||row.model!==null&&profile.model!==row.model)throw Error('Saved cloud binding does not match this chat. Preserve it for inspection.');
  await this.#verifyHome(row);const current=await this.#file(path);
  if(!current||!same(saved.identity,current.identity)||saved.hash!==current.hash)throw Error('Saved cloud binding changed while reading.');
  return profile;
 }
 async #saveCloudProfile(row,profile,check){
  const {modelProvider,...config}=profile??{};
  const bytes=JSON.stringify({version:2,profile:config});
  if(modelProvider!=='saleh_cloud'||!parseCodingProvider(bytes)?.credentialId||row.provider!=='cloud')throw Error('A cloud owner requires an immutable provider profile.');
  check();await this.#verifyHome(row);check();
  const file=await open(join(this.#home(row),'providers.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  await this.#syncDir(this.#home(row));check();
  if(!equal(await this.#cloudProfile(row),profile))throw Error('Saved cloud binding differs from the selected provider.');check();
 }
 async #providerBinding(input,epoch,operation){
  const row=this.#rows.find(r=>r.rootThreadId===input.threadId);
  if(!row||row.state!=='ready'||row.provider!=='cloud')throw Error('Choose a saved managed cloud root chat.');
  this.#bind(operation,row);const check=()=>this.#check(epoch,operation);
  this.#quarantineFence(row);if(row.handoff)throw handoffPending();
  await this.#verifyHome(row);check();
  const present=await this.#file(join(this.#home(row),'providers.json'));
  const profile=present?await this.#cloudProfile(row):await this.#authority.providerMetadata();check();
  if(!profile?.credentialId||profile.model!==row.model)throw Error('Save a cloud provider with this chat\'s exact model before binding it.');
  const state=present?'bound':'unbound';
  const fingerprint=hash(JSON.stringify([this.#lease.token,this.#epoch,this.#ownerRevisions.get(row.id)??0,row.id,row.home,row.rootThreadId,row.model,row.generation,state,profile]));
  const result={ownerId:row.id,threadId:row.rootThreadId,model:row.model,state,profile,fingerprint};
  if(input.action==='providerBindingInfo')return result;
  if(present||input.fingerprint!==fingerprint)throw Error('Cloud binding review changed. Inspect this chat again; its connection was not replaced.');
  if(!this.#historyQuiescent(row)||!row.generation?.executorClosed||['unrevoked','native-active'].includes(row.generation.execution)||this.#hostGitFailures.has(row.id))throw busy();
  await this.#saveCloudProfile(row,profile,check);return {...result,state:'bound'};
 }
 // A fresh successor proof covers prior-boot legacy writers only. Retained
 // reader and owned-generation fences remain independent, including after reboot.
 #legacyUncertain(){return !!this.#legacy&&(!this.#admissionProof||this.#legacy.nativeOpen&&!this.#current(this.#legacyLive));}
 #uncertainRow(r){return this.#hostGitFailures.has(r.id)||r.state!=='ready'||r.generation?.nativeOpen&&!this.#live.has(r.id)||r.generation&&(r.generation.execution==='unrevoked'||!r.generation.executorClosed)&&!this.#observing(r);}
 #historyQuiescent(row){
  const live=this.#live.get(row.id);
  return !live?row.generation?.nativeOpen===false:row.generation?.nativeOpen===true&&this.#current(live)&&live.engine.historyOnly&&!live.nativeExecution&&!live.executorExpected&&!live.resource&&!live.reservation&&!live.setup&&!live.nativeStopError;
 }
 #handoffHistoryReadable(row){return !!row.handoff&&!row.quarantine&&nativeOwner(row)&&row.state==='ready'&&row.generation?.executorClosed===true&&row.generation.execution==='native-stopped'&&equal(this.#handoffBinding(row),row.handoff.context.owner)&&this.#historyQuiescent(row);}
 async #uncertain(cwd,except=null,global=false){
  const scoped=()=>this.#legacyUncertain()||this.#rows.some(r=>r!==except&&(r.handoff&&[r.handoff.context.source,r.handoff.context.destination].some(path=>overlap(path,cwd))||overlap(r.cwd,cwd)&&this.#uncertainRow(r)));
  if(!this.#engineOptions.fullAccess)return scoped();
  if(!global&&scoped())return true;
  const epoch=this.#epoch,revision=this.#catalogRevision;
  const check=()=>{this.#check(epoch);if(this.#saving||revision!==this.#catalogRevision||this.#stopping||[...this.#allocating].some(live=>live!==this.#live.get(except?.id))||[...this.#selectedStops.values()].some(t=>t.pending||t.error))throw Object.assign(Error('Full Access is unavailable while Coding ownership is changing or stopping.'),{code:'PROJECT_BUSY'});};
  check();if(this.#legacyUncertain())return true;
  const pending=this.#rows.filter(r=>r!==except&&(r.handoff||this.#uncertainRow(r)));
  if(!pending.length)return false;
  await this.#checkDisk();check();
  let status;
  if(pending.some(r=>r.quarantine||r.handoff)){
   if(!this.#unconfinedStatus)return true;
   status=await this.#unconfinedStatus();check();
   if(!status||typeof status.bootSession!=='string'||status.bootSession.length!==36||!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(status.bootSession)||!Array.isArray(status.handoffs)||typeof status.recheck!=='function'||this.#admissionProof&&this.#admissionProof.owner.bootSession!==status.bootSession)throw Error('Full Access boot evidence is unavailable or inconsistent.');
  }
  const closedHandoff=r=>r&&r.handoff&&r.generation?.executorClosed===true&&r.generation.execution==='native-stopped'&&this.#historyQuiescent(r)&&equal(this.#handoffBinding(r),r.handoff.context.owner)&&status?.handoffs.some(c=>equal(c,r.handoff.context));
  const eligible=r=>!this.#hostGitFailures.has(r.id)&&(!r.fork?.worker||r.fork.worker.closed===true)&&(this.#coldMutationRow(r)||this.#quarantined(r)&&this.#historyQuiescent(r)&&this.#quarantines.get(r.id).bootSession!==status?.bootSession&&!!status||closedHandoff(r));
  if(pending.some(r=>!eligible(r))||status?.handoffs.some(c=>!closedHandoff(this.#rows.find(r=>r.id===c.owner?.ownerId))))return true;
  // Reuse the exact cold-allocation and quarantine target/alias proof. Eligibility is never persisted or cached.
  const scope=await this.#mutationScope(global?[]:[cwd],check,false,false);check();
  await status?.recheck();check();await scope?.();check();await this.#checkDisk();check();
  return this.#legacyUncertain()||this.#rows.some(r=>r!==except&&(r.handoff||this.#uncertainRow(r))&&!eligible(r))||!global&&scoped();
 }
 #current(x){return !!x?.engine&&!x.admissionClosed&&!x.retiring&&!x.controller.signal.aborted&&!x.engine.closed&&!x.engine.exitUnconfirmed&&!!x.life&&!x.life.exited&&!!x.life.child&&x.engine.child===x.life.child&&x.engine.processLife===x.life&&x.engine.epoch===x.epoch;}
 #observing(row){const x=this.#live.get(row.id);return !!(x?.resource||x?.nativeExecution&&!x.nativeStopError)&&!x.retiring&&this.#current(x);}
 #pin(row,engine){const live=this.#live.get(row.id);if(live?.engine!==engine||!this.#current(live))throw Error('Coding owner lifecycle changed; automatic restart is refused.');engine.checkProcess(live.life);}
 #pinLegacy(live){if(this.#legacyLive!==live||!this.#current(live))throw Error('Legacy history reader lifecycle changed.');live.engine.checkProcess(live.life);}
 #legacyCollision(live){for(const threadId of live.engine.verifiedThreads)if(this.#rows.some(r=>r.threads.includes(threadId)))throw this.#block(Error('Conflicting managed and legacy thread ownership.'));}
 async #closeLegacy(live=this.#legacyLive){
  if(!live)return;if(live.retiring)return live.retiring;
  live.retiring=(async()=>{
   if(live.engine){await live.engine.close();if(!live.engine.closeSettled||live.engine.exitUnconfirmed)throw Error('Legacy native reader exit is unconfirmed.');}
   this.#legacy.nativeOpen=false;await this.#save();if(this.#legacyLive===live)this.#legacyLive=null;
  })();try{return await live.retiring;}catch(e){if(!this.closed)live.retiring=null;throw e;}
 }
 async #legacyOwner(epoch,operation){
  if(!this.#legacy)return null;if(this.#stopping)throw Error('Legacy history reader is stopping; wait for Stop to finish.');let live=this.#legacyLive;if(this.#current(live)&&live.inventory)return live;
  if(live){await this.#closeLegacy(live);this.#check(epoch);}
  if(this.#legacy.nativeOpen)throw Error('Previous legacy native reader exit is unconfirmed; recovery is required.');
  if(!this.#assertLegacyClosed&&!this.#admissionProof)throw Error('Legacy history needs trusted native-home closure authority.');
  live={engine:null,controller:new AbortController(),retiring:null,inventory:null};this.#legacyLive=live;
  try{
   if(this.#admissionProof){
    const prior=this.#admissionProof;this.#admissionProof=null;
    const proof=await this.#legacyAdmission.verify({dataDir:this.dataDir,signal:operation?AbortSignal.any([live.controller.signal,operation.controller.signal]):live.controller.signal});
    if(proof.intentSha256!==prior.intentSha256||JSON.stringify(proof.owner)!==JSON.stringify(prior.owner))throw Error('Legacy reader boot or coordinator provenance changed.');
    this.#check(epoch,operation);this.#admissionProof=proof;this.#legacy.admission=proof;this.#legacy.reader=proof.owner;
   }else{
    // This older callback admits history only; it grants no reboot authority.
    await this.#assertLegacyClosed(Object.freeze({dataDir:this.dataDir,signal:live.controller.signal}));
   }
   this.#check(epoch);await this.#guard();
   this.#legacy.nativeOpen=true;await this.#save();this.#check(epoch);
   live.engine=this.#engineFactory({...this.#engineOptions,dataDir:this.dataDir,providerDataDir:this.dataDir,projects:this.#projects,journal:this.#journal,historyOnly:true});
   if(!(live.engine instanceof CodingEngine)||live.engine.dataDir!==this.dataDir||live.engine.providerDataDir!==this.dataDir||!live.engine.historyOnly)throw Error('Trusted legacy factory returned a mismatched history reader.');
   await live.engine.ensure();live.life=live.engine.processLife;live.epoch=live.engine.epoch;this.#pinLegacy(live);this.#check(epoch);
   const inventory={active:[],archived:[]},ids=new Set();let bytes=0;
   for(const archived of [false,true]){let cursor;const cursors=new Set();do{
    this.#pinLegacy(live);const page=await live.engine.handle({action:'list',archived,...(cursor?{cursor}:{})});this.#check(epoch);
    if(page.truncated||!Array.isArray(page.threads))throw Error('Legacy history inventory is incomplete.');
    for(const thread of page.threads){if(!id(thread.id)||ids.has(thread.id))throw Error('Duplicate or invalid legacy history identity.');ids.add(thread.id);bytes+=Buffer.byteLength(JSON.stringify(thread));if(ids.size>4096||bytes>8*1024*1024)throw Error('Legacy history inventory exceeds its verification limit.');
     this.#pinLegacy(live);await live.engine.resolveFamily(thread.id);this.#check(epoch);this.#legacyCollision(live);inventory[archived?'archived':'active'].push(legacyView(thread));
    }
    cursor=page.nextCursor;if(cursor&&(typeof cursor!=='string'||cursor.length>4096||cursors.has(cursor)||cursors.size>=128))throw Error('Legacy history pagination is invalid or incomplete.');if(cursor)cursors.add(cursor);
   }while(cursor);}
   this.#pinLegacy(live);live.inventory=inventory;return live;
  }catch(e){try{await this.#closeLegacy(live);}catch{}throw e;}
 }
 #make(row,historyOnly,binding,codingMCP,temporaryOperation,publishWorkspace,cloudProfile){
  this.#coldCreating.delete(row); // A factory can register or emit before it returns.
  const generation=row.generation?.id,home=row.home;let writer,root;
  const committed=()=>{
   if(this.#blocked)throw this.#blocked;
   const saved=this.#committed?.data.owners.find(r=>r.id===row.id);
   if(!saved||saved.state!=='ready'||!saved.rootThreadId||root&&saved.rootThreadId!==root||saved.generation?.id!==generation||!sameBinding(saved.home,home))throw Error('Terminal result writer requires its committed owner/root/generation binding.');
   return saved;
  };
  const getTerminalResults=()=>{
   const saved=committed();if(writer)return writer;root=saved.rootThreadId;
   writer=new CodingTerminalResults({directory:this.#home(row),ownerId:row.id,rootThreadId:root,ownerGeneration:generation,getThreadIds:()=>committed().threads,verifyHome:async()=>{
    // Final evidence may arrive during close. Verify durable ownership without
    // acquiring the mutation queue or requiring a live execution capability.
    for(let attempt=0;attempt<4;attempt++){
     if(this.#saving)await this.#saving;
     const revision=this.#catalogRevision,snapshot=this.#committed,saved=committed(),changed=()=>revision!==this.#catalogRevision||!!this.#saving;
     try{await this.#outcomeGuard(snapshot,saved);}catch(error){if(changed())continue;throw this.#block(error);}
     if(changed())continue;committed();return;
    }
    throw Error('Coding owner metadata is changing; terminal result save could not be verified.');
   }});return writer;
  };
  const engine=this.#engineFactory({...this.#engineOptions,autoApproval:input=>this.handle(input),dataDir:this.#home(row),providerDataDir:this.dataDir,cloudProfile,projects:this.#projects,journal:this.#journal,historyOnly,...(!historyOnly?{executor:binding,temporaryOperation,publishWorkspace,getTerminalResults,...(codingMCP?{codingMCP}:{})}:row.mcp.kind==='journal'?{codingMCPOutcomes:this.#outcomeReader(row)}:{})});
  if(!(engine instanceof CodingEngine)||engine.dataDir!==this.#home(row)||engine.providerDataDir!==this.dataDir||engine.historyOnly!==historyOnly)throw Error('Trusted owner factory returned a mismatched engine.');if(nativeOwner(row)&&row.state==='ready')engine.bindOwnedRoot({id:row.rootThreadId,cwd:row.cwd,model:row.model,modelProvider:{local:'saleh_local',cloud:'saleh_cloud'}[row.provider]});return engine;
 }
 // Raw closure never writes the catalog or waits for its containing operation.
 // This lets Stop request every owned resource while late native receipts settle.
 #cleanup(row,live){
  if(live.cleanup)return live.cleanup;
  live.admissionClosed=true;live.controller.abort();if(live.engine&&!live.engine.historyOnly)live.engine.cancelAdmissions();const generation=row.generation?.id;
  if(live.setup&&live.setup.cleanup==='not-requested')this.#setupChange(live.setup,{cleanup:'pending'});
  const hub=live.setup?.hub.close(),mcpStartup=live.mcpStartup;
  live.nativeCleanup??=Promise.resolve().then(async()=>{
   const engine=live.engine,startup=live.startup;
   let nativeFailure;
   if(live.nativeExecution&&engine){
    let timer;
    try{
     const selected=this.#selectedStops.get(row.id);if(selected?.pending&&!selected.retiring)await selected.work;
     if(live.nativeStopError)throw live.nativeStopError;
     const life=engine.processLife;if(!life||life.exited||engine.closed||engine.exitUnconfirmed)throw Error('Native tracked lifetime ended before closure could be verified.');
     await Promise.race([engine.stop(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native tracked Stop deadline exceeded.')),15000);})]);
     if(engine.processLife!==life||engine.child!==life.child||life.exited||engine.closed||engine.exitUnconfirmed||engine.runs.size||engine.terminals.size||engine.commandRequests.size)throw Error('Native tracked command closure is unconfirmed.');
    }catch(error){nativeFailure=error;}finally{clearTimeout(timer);}
   }
   // Startup may acquire a relay after the first close; drain its final disposal.
   const [closed,hubClosed]=await Promise.allSettled([Promise.resolve().then(()=>engine?.close()),hub,startup,mcpStartup]);
   if(startup)await engine.close();
   if(hubClosed.status==='rejected')throw hubClosed.reason;
   if(closed.status==='rejected')throw closed.reason;
   if(nativeFailure)throw nativeFailure;
   if(engine&&(!engine.closeSettled||engine.exitUnconfirmed))throw Error('Native owner home exit is unconfirmed.');
  });
  live.executorCleanup??=Promise.resolve().then(async()=>{
   try{
   // Wait only for resource acquisition, never #owner (whose catch retires it).
   if(live.allocation)await live.allocation;
   if(!live.resource)return live.executorExpected&&!live.allocation?{ownerId:row.id,generation,closed:true,revoked:false}:null;
   if(!live.retire)throw Error('Invalid trusted executor allocation.');
   // Let native sidecars drain, but a stalled native close cannot suppress Stop.
   let timer;try{await Promise.race([live.nativeCleanup.catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);}finally{clearTimeout(timer);}
   const retire=()=>Promise.resolve().then(()=>live.retire()).then(result=>{
    if(result?.ownerId!==row.id||result?.generation!==generation||typeof result.revoked!=='boolean')throw Error('Executor retirement returned a mismatched generation.');
    if(Object.hasOwn(result,'closed')&&typeof result.closed!=='boolean')throw Error('Invalid executor physical closure receipt.');
    if(result.closed!==true)throw Error('Executor physical closure is unconfirmed.');return result;
   });
   const result=await (live.reservation?(live.executorRetirement??=retire()):retire());
   live.executorRetired=true;
   return result;
   }finally{if(live.allocationRecord)await Promise.allSettled([live.allocationRecord]);}
  });
  const nativeWork=live.nativeCleanup,executorWork=live.executorCleanup,cleanup=Promise.allSettled([nativeWork,executorWork]).then(([native,executor])=>({generation,native,executor,nativeWork,executorWork,cleanup,reservation:live.reservation,executorRetired:live.executorRetired===true}));
  live.cleanup=cleanup;return cleanup;
 }
 async #retire(row,live,settled){
  if(live.retiring)return live.retiring;
  let result;live.retiring=(async()=>{
   result=settled??await this.#cleanup(row,live);
   if(this.#live.get(row.id)!==live||row.generation?.id!==result.generation)throw this.#block(Error('Owner retirement identity changed.'));
   const errors=[result.native,result.executor].filter(x=>x.status==='rejected').map(x=>x.reason);
   if(result.executor.status==='fulfilled'&&result.executor.value?.closed===true)row.generation.executorClosed=true;
   if(result.reservation&&result.executorRetired&&result.executor.status==='fulfilled'){
    if(result.reservation!==live.reservation||!this.#executor?.allocations.includes(result.reservation)||result.reservation.ownerId!==row.id||result.reservation.generation!==result.generation)throw this.#block(Error('Executor retirement reservation changed.'));
    result.reservation.closed=true;
   }
   if(result.native.status==='fulfilled'){
    row.generation.nativeOpen=false;
    if(live.nativeExecution){row.generation.execution='native-stopped';row.generation.executorClosed=true;}
    else if(result.executor.status==='fulfilled'&&result.executor.value?.revoked)row.generation.execution='revoked';
   }
   try{await this.#save();}catch(error){errors.push(error);}
   if(!this.closed&&result.native.status==='rejected'&&live.nativeCleanup===result.nativeWork)live.nativeCleanup=null;
   if(!this.closed&&result.executor.status==='rejected'&&live.executorCleanup===result.executorWork)live.executorCleanup=null;
   if(errors.length){if(live.setup)this.#setupChange(live.setup,{cleanup:'unconfirmed',error:this.#setupError('closure-unconfirmed')});throw new AggregateError(errors,errors.map(e=>e.message).join('; '));}
   this.#live.delete(row.id);
   if(live.setup)this.#setupChange(live.setup,{cleanup:'closed'});
  })();
  try{return await live.retiring;}catch(e){live.retiring=null;if(!this.closed&&live.cleanup===result?.cleanup)live.cleanup=null;throw e;}
 }
 async #retireAll(){
  const errors=[];try{await this.#closeLegacy();}catch(error){errors.push(error);}
  for(const [owner,live] of [...this.#live])try{await this.#retire(this.#rows.find(r=>r.id===owner),live);}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError(errors,errors.map(e=>e.message).join('; '));
 }
 async #owner(row,execute,epoch,signal,operation,setup=null){
  if(execute)this.#quarantineFence(row);
  this.#bind(operation,row);signal??=operation?.controller.signal;
  const check=()=>{this.#check(epoch,operation);if(signal?.aborted)throw Error('Scheduled owner allocation cancelled.');};
  check();if(execute&&this.#engineOptions.fullAccess&&await this.#uncertain('/',row,true))throw busy();check();
  await this.#verifyHome(row);check();if(execute&&this.#projects.scheduled(row.cwd))throw busy();let live=this.#live.get(row.id);
  const cloudProfile=execute?await this.#cloudProfile(row):null;check();
  if(execute&&this.#current(live)&&!live.engine.historyOnly&&!equal(await live.engine.providerMetadata(),cloudProfile))throw Error('Cloud binding changed during this running chat.');check();
  if(execute&&this.#hostGitFailures.has(row.id))throw this.#hostGitFailures.get(row.id);
  if(execute){await this.#quarantineScope([row.cwd],check);check();await this.#admission(false);check();}
  if(execute){await this.#executionMCP(row);check();}
  if(execute&&live?.nativeStopError)throw live.nativeStopError;
  if(this.#current(live)&&(!execute||!live.engine.historyOnly)){if(execute&&nativeOwner(row)&&row.generation.execution==='native-stopped'){row.generation.execution='native-active';await this.#save();check();}return live.engine;}
  if(live){await this.#retire(row,live);check();}
  if(row.generation?.nativeOpen)throw Error('Previous native owner exit is unconfirmed; history home remains closed.');
  if(execute&&row.generation&&!row.generation.executorClosed)throw Error('Previous executor physical closure is unconfirmed; execution remains blocked.');
  if(execute&&['unrevoked','native-active'].includes(row.generation?.execution))throw Error('Previous executor generation has no revocation proof; execution remains blocked.');
  if(execute&&await this.#uncertain(row.cwd,row))throw busy();check();
  if(execute){await this.#admission(true,row.executionMode??'vm');check();}
  if(setup){this.#checkSetup(setup);if(!execute||row!==setup.row||row.id!==setup.ownerId||row.generation||row.state!=='creating')throw Error('Coding MCP promotion identity changed.');}
  const generation=execute?(setup?.generation??randomUUID()):row.generation?.id;
  const reservation=execute&&!nativeOwner(row)&&this.#executorPolicy?{ownerId:row.id,generation,resources:{...this.#executorPolicy.resources},identity:null,closed:false,diskRelease:null}:null;
  if(reservation)this.#executor.allocations.push(reservation);
  if(execute)row.generation={id:generation,nativeOpen:true,execution:nativeOwner(row)?'native-active':'unrevoked',executorClosed:false};
  else {if(!row.generation)throw Error('Owner has no native history generation.');row.generation.nativeOpen=true;}
  await this.#save();
  live={engine:null,resource:null,controller:new AbortController(),retiring:null,executorExpected:execute&&!nativeOwner(row),nativeExecution:execute&&nativeOwner(row),reservation,setup};this.#live.set(row.id,live);
  const abort=()=>live.controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{check();
   if(execute)this.#allocating.add(live);
   if(setup){
    live.outcomes=new CodingMCPOutcomes({directory:this.#home(row),ownerId:row.id,nativeHelper:this.#engineOptions.nativeHelper});
    live.mcpStartup=(async()=>{
     const receipt=await live.outcomes.initialize();check();this.#checkSetup(setup);
     if(receipt.ownerId!==row.id||!uuid(receipt.storeId))throw Error('Coding MCP journal identity changed.');
     live.storeId=receipt.storeId;row.mcp={kind:'journal',storeId:receipt.storeId};await this.#save();check();this.#checkSetup(setup);
     if(row.provider==='local'){await this.#authority.resolveModel(this.#authority.profile('local',setup.request.model));check();this.#checkSetup(setup);}
    })();try{await live.mcpStartup;}finally{live.mcpStartup=null;}
   }
   if(execute&&!nativeOwner(row)){
    // The allocator's host publisher uses this exact owner; no guest-supplied
    // destination or callback may enter this trusted seam. It never queues on
    // #serial, which can itself be waiting for this owner's publication drain.
    const publish=async({threadId,operation})=>{
     const admitted=()=>{this.#check(epoch);if(this.#live.get(row.id)!==live||row.generation?.id!==generation||!this.#current(live)||!row.rootThreadId||live.engine.rootFor(threadId)!==row.rootThreadId)throw Error('Publication owner is unassociated, stopped or stale.');};
     admitted();if(await this.#uncertain(row.cwd,row))throw busy();admitted();
     if(typeof operation!=='function')throw Error('Invalid trusted publication operation.');
     const settledConflicts=new WeakSet();
     return live.engine.runPublication({threadId,cwd:row.cwd,signal:live.controller.signal,settledPublicationFailure:error=>settledConflicts.has(error),operation:context=>this.#publicationNative(row,live,context,operation,null,error=>settledConflicts.add(error))});
    };
    const recordAllocation=value=>{
     if(live.allocationRecord)return Promise.reject(Error('Executor allocation directory was already recorded.'));
     live.allocationRecord=(async()=>{
      shape(value,['path','identity']);if(!(this.#durableIdentity?isFilesystemIdentity:identity)(value.identity)||value.path!==join(this.#executor.runtime.path,row.id+'-'+generation))throw Error('Executor allocation directory receipt differs.');
      const captured={...value.identity},current=()=>{check();if(this.#live.get(row.id)!==live||row.generation?.id!==generation||live.admissionClosed||live.controller.signal.aborted||!this.#executor.allocations.includes(reservation))throw Error('Executor allocation reservation is stopped or stale.');};
      current();if(reservation.identity!==null)throw Error('Executor allocation directory was already bound.');await this.#runtime(this.#executor.runtime,this.#executor.allocations,{reservation,identity:captured});current();await this.#dir(value.path,captured);current();
      reservation.identity=captured;await this.#save();current();await this.#dir(value.path,captured);current();
     })();void live.allocationRecord.catch(()=>{});return live.allocationRecord;
    };
    const admitted=reservation?{resources:Object.freeze({...reservation.resources}),runtime:frozenRuntime(this.#executor.runtime),recordAllocation}:{};
    const provisioning=operation?.requestId?{onProvisioningReady:(identity,signal)=>this.#provisioningReady(row,live,generation,operation,identity,signal),onStartupProgress:(stage,fraction)=>{if(stage!=='waiting-review')this.#startupProgress(row,live,generation,operation,stage,fraction);}}:{};
    this.#startupProgress(row,live,generation,operation,'allocating');
    live.allocation=Promise.resolve().then(()=>{check();return this.#openExecutor(Object.freeze({ownerId:row.id,generation,dataDir:this.#home(row),cwd:row.cwd,signal:live.controller.signal,nativeHelper:this.#engineOptions.nativeHelper,publish,...admitted,...provisioning}));}).then(resource=>{
     live.resource=resource;const retire=resource?.retire;if(typeof retire==='function')live.retire=retire.bind(resource);return resource;
    });
    await live.allocation;
    const ready=live.resource?.ready;
    if(ready!==undefined&&(!ready||typeof ready.then!=='function'))throw Error('Invalid trusted executor readiness.');
    // Keep readiness observed after cancellation; retire owns draining startup.
    live.readiness=Promise.resolve(ready);void live.readiness.catch(()=>{});
    if(!live.retire)throw Error('Invalid trusted executor allocation.');let cancel;
    const cancelled=new Promise((_,reject)=>{cancel=()=>reject(Error('Owner allocation cancelled by Stop.'));live.controller.signal.addEventListener('abort',cancel,{once:true});if(live.controller.signal.aborted)cancel();});
    try{await Promise.race([live.readiness,cancelled]);}finally{live.controller.signal.removeEventListener('abort',cancel);}
    check();if(this.#live.get(row.id)!==live||row.generation?.id!==generation||live.admissionClosed||live.retiring||live.controller.signal.aborted)throw Error('Owner allocation cancelled by Stop.');
    if(reservation){if(!live.allocationRecord)throw Error('Executor readiness has no recorded allocation directory.');await live.allocationRecord;check();if(!reservation.identity)throw Error('Executor allocation directory binding is missing.');await this.#runtime(this.#executor.runtime,this.#executor.allocations);check();}
    live.binding=live.resource.binding;
    const prepare=live.resource.prepare,temporaryOperation=live.resource.temporaryOperation,publishWorkspace=live.resource.publishChanges;
    if(!live.binding||prepare!==undefined&&typeof prepare!=='function'||temporaryOperation!==undefined&&typeof temporaryOperation!=='function'||publishWorkspace!==undefined&&typeof publishWorkspace!=='function')throw Error('Invalid trusted executor allocation.');
    live.prepare=prepare?.bind(live.resource);live.temporaryOperation=temporaryOperation?.bind(live.resource);live.publishWorkspace=publishWorkspace?.bind(live.resource);
    check();if(live.controller.signal.aborted)throw Error('Owner allocation cancelled by Stop.');
   }
   if(setup){
    live.mcpStartup=(async()=>{
     for(const selected of setup.reviewed){this.#checkSetup(setup);check();await setup.hub.connect(selected.id,selected.configHash);this.#checkSetup(setup);check();}
     const catalog=await setup.hub.completeCatalog(setup.reviewed);this.#checkSetup(setup);check();
     const registry=createCodingMCPRegistry(catalog);if(!registry.dynamicTools.length)throw Error('Coding MCP selected providers expose no tools.');
     const state=new CodingMCPState({directory:this.#home(row),ownerId:row.id,nativeHelper:this.#engineOptions.nativeHelper});
     live.codingMCP=Object.freeze({ownerId:row.id,generation,signal:live.controller.signal,hub:setup.hub,registry,state,outcomes:live.outcomes,isCurrent:threadId=>this.#live.get(row.id)===live&&row.generation?.id===generation&&row.mcp.storeId===live.storeId&&!setup.controller.signal.aborted&&this.#current(live)&&!!row.rootThreadId&&live.engine.verifiedThreads.has(threadId)&&live.engine.rootFor(threadId)===row.rootThreadId});
    })();try{await live.mcpStartup;}finally{live.mcpStartup=null;}
   }
   check();if(setup)this.#checkSetup(setup);if(live.controller.signal.aborted)throw Error('Owner allocation cancelled by Stop.');
   if(execute)this.#startupProgress(row,live,generation,operation,'preparing-project');
   live.engine=this.#make(row,!execute,live.binding,live.codingMCP,live.temporaryOperation,live.publishWorkspace,cloudProfile);live.startup=live.engine.ensure();
   try{await live.startup;}finally{live.startup=null;}
   live.life=live.engine.processLife;live.epoch=live.engine.epoch;this.#pin(row,live.engine);check();return live.engine;
  }catch(e){try{await this.#retire(row,live);}catch{}throw e;}finally{signal?.removeEventListener('abort',abort);this.#allocating.delete(live);}
 }
 async #prepareResource(row,engine,epoch,operation){
  this.#check(epoch,operation);this.#pin(row,engine);const live=this.#live.get(row.id);
  if(!live.prepare)return;
  if(!live.preparation){
   const threadId=row.rootThreadId,life=live.life;
   if(!threadId||!engine.verifiedThreads.has(threadId)||engine.rootFor(threadId)!==threadId||await this.#uncertain(row.cwd,row))throw Error('Workspace preparation requires a verified current root.');
   this.#check(epoch,operation);this.#pin(row,engine);
   // Only this invocation can recognize its exact, settled preparation error.
   // Preparation still fails and cannot replay; this proof is for final close.
   const settledCopies=new WeakSet();
   live.preparation=engine.runPublication({threadId,cwd:row.cwd,signal:AbortSignal.any([live.controller.signal,operation.controller.signal]),settledPreparationFailure:error=>settledCopies.has(error),operation:context=>this.#publicationNative(row,live,context,request=>live.prepare(Object.freeze({threadId,engine,life,...request})),error=>settledCopies.add(error))});
  }
  // The same promise remains latched after failure. The publication admission
  // owns cleanup; executor Stop must not wait here before stopping the guest.
  await live.preparation;this.#check(epoch,operation);this.#pin(row,engine);
 }
 async #remember(row,engine){
  if(row.quarantine){if(!this.#quarantined(row)||[...engine.verifiedThreads].some(id=>!row.threads.includes(id)||engine.rootFor(id)!==row.rootThreadId))throw this.#block(Object.assign(Error('Quarantined family membership changed.'),{code:'NATIVE_QUARANTINE_INVALID'}));return;}
  if(row.handoff&&engine.historyOnly){if(!this.#handoffHistoryReadable(row)||[...new Set([...engine.verifiedThreads,...engine.threadInfo.keys()])].some(id=>!row.threads.includes(id)||engine.rootFor(id)!==row.rootThreadId))throw handoffPending();return;}
  let changed=false;
  if(row.creation&&(engine.runs.has(row.rootThreadId)||engine.completedTurns.has(row.rootThreadId)||engine.startedTurns.has(row.rootThreadId)||engine.liveHistory.get(row.rootThreadId)?.turns.length)){row.creation=null;changed=true;}
  for(const threadId of engine.verifiedThreads){
   if(engine.rootFor(threadId)!==row.rootThreadId)continue;
   const other=this.#rows.find(r=>r!==row&&r.threads.includes(threadId));if(other)throw this.#block(Error('Conflicting verified thread ownership.'));
   if(this.#legacyLive?.engine?.verifiedThreads.has(threadId))throw this.#block(Error('Conflicting managed and legacy thread ownership.'));
   if(!row.threads.includes(threadId)){row.threads.push(threadId);row.creation=null;changed=true;}
  }
  if(changed)await this.#save();
 }
 async #thread(threadId,execute,epoch,operation){
  this.#bind(operation,this.#rows.find(r=>r.threads.includes(threadId)));
  const legacy=await this.#legacyOwner(epoch,operation);
  let row=this.#rows.find(r=>r.threads.includes(threadId));
  if(!row){
   const candidates=[...this.#live].filter(([,x])=>x.engine?.threadInfo.has(threadId));
   if(!candidates.length&&legacy){if(execute)throw Error('Legacy history cannot execute before adoption.');this.#pinLegacy(legacy);await legacy.engine.resolveFamily(threadId);this.#check(epoch,operation);this.#legacyCollision(legacy);return {legacy,engine:legacy.engine};}
   if(candidates.length!==1)throw Error('Unknown or conflicting coding thread owner.');
   row=this.#rows.find(r=>r.id===candidates[0][0]);this.#bind(operation,row);const engine=candidates[0][1].engine,{root}=await engine.resolveFamily(threadId);this.#check(epoch,operation);
   if(root.id!==row.rootThreadId)throw Error('Unverified coding child owner.');await this.#remember(row,engine);
  }
  this.#bind(operation,row);
  if(row.handoff&&(execute||!this.#handoffHistoryReadable(row)))throw handoffPending();
  if(row.state!=='ready')throw Error('Coding root creation is unresolved.');
  if(execute){await this.#executionMCP(row);this.#check(epoch,operation);}
  // Probe a never-dispatched root before replacing its cold reader with an executor.
  let engine=await this.#owner(row,execute&&(!row.creation||this.#observing(row)),epoch,undefined,operation),family;
  this.#pin(row,engine);
  try{family=await engine.resolveFamily(threadId);}catch(error){
   this.#check(epoch,operation);this.#pin(row,engine);
   if(row.handoff||!row.creation||threadId!==row.rootThreadId||row.threads.length!==1||!engine.historyOnly||error.code!=='CODING_THREAD_NOT_LOADED'||error.threadId!==threadId||!Number.isSafeInteger(error.cursor)||error.cursor<0||engine.historyBlocked||engine.historyWarning||engine.liveHistoryEvicted||engine.liveHistory.get(threadId)?.turns.length)throw error;
   await this.#checkDisk();this.#check(epoch,operation);this.#pin(row,engine);
   if(execute)throw Error('This saved creation record has no native session. It cannot execute or silently create a replacement chat.');
   return {row,engine,creation:{thread:this.#creationView(row),cursor:error.cursor}};
  }
  this.#check(epoch,operation);if(family.root.id!==row.rootThreadId||family.root.cwd!==row.cwd||family.root.model!==row.model||family.root.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[row.provider]))throw this.#block(Error('Saved native family no longer matches its owner.'));await this.#remember(row,engine);
  if(execute&&engine.historyOnly){engine=await this.#owner(row,true,epoch,undefined,operation);this.#pin(row,engine);family=await engine.resolveFamily(threadId);this.#check(epoch,operation);if(family.root.id!==row.rootThreadId||family.root.cwd!==row.cwd||family.root.model!==row.model||family.root.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[row.provider]))throw this.#block(Error('Saved native family changed during execution admission.'));}
  if(execute)await this.#prepareResource(row,engine,epoch,operation);
  return {row,engine,nativeRoot:family.root};
 }
 #creationView(row){return {executionMode:row.executionMode??'vm',id:row.rootThreadId,cwd:row.cwd,model:row.model,modelProvider:{local:'saleh_local',cloud:'saleh_cloud'}[row.provider],...structuredClone(row.creation),parentThreadId:null,canAcceptDirectInput:null,turns:[],historyOnly:true,historySource:'creation-receipt',nativeHistoryAvailable:false};}
 async #invalidateCreation(row){if(row.creation){row.creation=null;await this.#save();}}

 async #publicationNative(row,live,{signal,check},operation,certifyPreparationFailure=null,certifyPublicationFailure=null,maintenanceSnapshot=false){
  const {engine,life,epoch}=live,generation=row.generation.id,child=life.child,pending=new Set(),settledCopies=new WeakSet();let active=true,published=null,copyOnly=!!certifyPreparationFailure,operationFailure,mutationStarted=false,nativeFailed=false;
  const retained=()=>{
   if(!active||this.#live.get(row.id)!==live||row.generation?.id!==generation||live.engine!==engine||live.life!==life||live.epoch!==epoch||life.child!==child||engine.processLife!==life&&!(engine.processLife===null&&(live.controller.signal.aborted||engine.closed))||engine.child!==child&&engine.child!==null)throw Error('Native publication admission or owner identity is stale.');
   if(this.#blocked)throw this.#blocked;
  };
  // Fresh for this invocation; the retained preparation promise never replays it.
  const current=()=>{retained();check();};
  const native=(action,input,options={})=>{
   const work=(async()=>{
    const {record,closed,settle=false}=options;
    if(!['inventory','readContent','copy','materialize','publish'].includes(action)||Object.keys(options).some(key=>!['record','closed','settle'].includes(key))||typeof settle!=='boolean')throw Error('Unsupported owner native action or options.');
    const request=structuredClone(input),mutation=['copy','materialize','publish'].includes(action);
    if(mutation)mutationStarted=true;
    if(mutation&&action!=='copy')copyOnly=false;
    if(settle){
     retained();if(action!=='inventory'||!published)throw Error('Native settlement requires a successful publication and read-only inventory.');
     shape(request,['root','exclude']);shape(request.root,['path','dev','ino']);
     if(!published.some(root=>root.path===request.root.path&&same(root,request.root)))throw Error('Native settlement descriptor differs from the admitted publication.');
    }else current();
    if(mutation&&(typeof record!=='function'||typeof closed!=='function'))throw Error('Native mutation requires durable record and closed callbacks.');
    const ownership=Object.freeze({ownerId:row.id,generation,action,requestHash:hash(JSON.stringify(request))});
    const result=await this.#nativeFiles(action,request,{signal:settle?new AbortController().signal:signal,check:settle?retained:current,
     record:mutation?value=>record(value,ownership):undefined,closed:mutation?()=>closed(ownership):undefined,
     settledCopyFailure:certifyPreparationFailure&&action==='copy'?error=>settledCopies.add(error):undefined,
     completionCheck:action==='publish'?retained:undefined});
    if(action==='publish')published=[request.root,request.stage,request.capture];return result;
   })();
   pending.add(work);void work.then(()=>pending.delete(work),()=>{nativeFailed=true;pending.delete(work);});return work;
  };
  let gitStarted=false,gitFailure;
  const trackGit=work=>{pending.add(work);void work.then(()=>pending.delete(work),error=>{gitFailure??=error;pending.delete(work);});return work;};
  const snapshotGit=(input,options,inspection=false)=>{
   copyOnly=false;
   return trackGit((async()=>{current();if(gitStarted)throw Error('Host Git snapshot admission is single-use.');gitStarted=true;return this.#snapshotGit(row,live,{signal,check:current,track:trackGit},input,options,inspection);})());
  };
  try{current();return await operation(Object.freeze({signal,check:current,native,...certifyPreparationFailure||maintenanceSnapshot?{snapshotGit:(input,options)=>snapshotGit(input,options)}:{},...maintenanceSnapshot?{inspectGit:(input,options)=>snapshotGit(input,options,true)}:{}}));}
  catch(error){operationFailure=error;throw error;}
  finally{
   active=false;const settled=await Promise.allSettled([...pending]),failure=settled.find(result=>result.status==='rejected');if(gitFailure)throw gitFailure;if(failure)throw failure.reason;
   const validation=certifyPreparationFailure&&!mutationStarted&&!nativeFailed&&isGuestWorkspaceValidationFailure(operationFailure,current);
   if(validation||copyOnly&&settledCopies.has(operationFailure))certifyPreparationFailure(operationFailure);
   if(certifyPublicationFailure&&!mutationStarted&&!nativeFailed&&isGuestPublicationConflict(operationFailure,current))certifyPublicationFailure(operationFailure);
  }
 }
 async #snapshotGit(row,live,{signal,check,track},input,options,inspection=false){
  check();shape(input,['directory']);shape(options,['record','closed']);
  const {directory}=input,{record,closed}=options,reservation=live.reservation,runtime=this.#executor?.runtime,generation=row.generation.id;
  if(typeof record!=='function'||typeof closed!=='function')throw Error('Host Git snapshot requires durable worker record and closed callbacks.');
  if(!runtime||!reservation?.identity||reservation.closed||reservation.ownerId!==row.id||reservation.generation!==generation||!this.#executor.allocations.includes(reservation))throw Error('Host Git snapshot requires a recorded executor allocation.');
  const allocation=join(runtime.path,row.id+'-'+generation),allocationID={...reservation.identity};
  if(!absolutePath(directory)||resolve(directory)!==directory||dirname(directory)!==allocation||overlap(directory,row.cwd)||overlap(directory,this.#home(row)))throw Error('Host Git snapshot must be a fresh direct child of its allocation outside the project and owner home.');
  const project=await lstat(row.cwd,{bigint:true});check();let directoryID=null;
  const verify=async()=>{
   check();if(this.#executor?.runtime!==runtime||live.reservation!==reservation||reservation.closed||!sameBinding(reservation.identity,allocationID)||!this.#executor.allocations.includes(reservation))throw Error('Host Git allocation admission changed.');
   await this.#runtime(runtime,this.#executor.allocations);check();await this.#dir(allocation,allocationID);check();
   const now=await lstat(row.cwd,{bigint:true});if(!now.isDirectory()||now.isSymbolicLink()||!same(stamp(now),stamp(project))||await realpath(row.cwd)!==row.cwd)throw Error('Host Git source directory identity changed.');
   if(directoryID)await this.#dir(directory,directoryID);check();
  };
  let worker=null,runner;
  const withNative=async work=>{
   check();if(this.#native)throw Error('Previous native helper closure is unresolved.');
   const state={child:null,uncertain:false};this.#native=state;
   try{return await work(state);}finally{if(!state.uncertain&&this.#native===state)this.#native=null;}
  };
  const adapter={get blocked(){return runner.blocked;},run:async(args,settings={})=>{
   check();if(worker)throw Error('Another host Git worker is running.');
   const state=this.#native;if(!state)throw Error('Host Git worker has no retained native admission.');
   const scope=settings.scope??{};if(JSON.stringify(scope)!=='{}'&&JSON.stringify(scope)!==JSON.stringify({dirs:[directory]}))throw Error('Host Git worker write scope differs from its private snapshot.');
   const ownership=Object.freeze({ownerId:row.id,generation,action:'git-snapshot',requestHash:hash(JSON.stringify({worker:randomUUID(),args,scope,env:settings.env??{},inputHash:hash(settings.input??'')}))});
   const original={ownership,child:null,closed:false,recordWork:null};worker=original;
   const cancel=()=>runner.cancel();signal.addEventListener('abort',cancel,{once:true});
   let value,failure,recordFailure;
   try{
    await verify();check();this.#helperIdentity=await verifyHandoffHelper(runner.nativeHelper,this.#helperIdentity);check();
    try{value=await runner.run(args,{...settings,check:()=>{check();settings.check?.();}});}catch(error){failure=error;}
    // The release gate may lose a race to Stop while its original durable write
    // is still pending. Never issue a close receipt or release this slot early.
    try{await original.recordWork;}catch(error){failure??=error;}recordFailure=original.recordFailure;
    if(original.child){
     if(runner.blocked||!original.closed){state.uncertain=true;throw this.#block(Error('Host Git worker close is unconfirmed; snapshot and coordinator lease retained.'));}
     try{process.kill(-original.child.pid,0);throw Error('Host Git worker process group still exists.');}catch(error){if(error.code!=='ESRCH'){state.uncertain=true;throw this.#block(error);}}
     try{await closed(ownership);}catch(error){state.uncertain=true;throw this.#block(error);}
    }
    if(recordFailure){state.uncertain=true;throw this.#block(recordFailure);}
    if(failure)throw failure;await verify();return value;
   }finally{signal.removeEventListener('abort',cancel);worker=null;}
  }};
  runner=new GitRunner({dataDir:this.#home(row),nativeHelper:this.#engineOptions.nativeHelper??process.env.QWEN_LOCAL_NATIVE_HELPER,
   processGuard:()=>{const original=worker;return receipt=>{original.recordWork=(async()=>{try{await record(receipt,original.ownership);}catch(error){original.recordFailure=error;throw error;}await verify();})();return original.recordWork;};},
   spawnProcess:(...args)=>{const original=worker;check();const child=(this.#engineOptions.spawnProcess??spawn)(...args);original.child=child;this.#native.child=child;child.once('close',()=>{original.closed=true;});if(signal.aborted)queueMicrotask(()=>runner.cancel());return child;}});
  const inspector=new GitWorkflow({dataDir:this.#home(row),assertProject:this.#engineOptions.assertProject});inspector.runner=adapter;inspector.checkoutRunner=adapter;
  const builder=new HandoffGit({directory,runner:adapter,inspector,check});
  const admitted=await withNative(async()=>{
   await verify();check();await mkdir(directory,{mode:0o700});directoryID=await this.#dir(directory);await this.#dir(allocation,allocationID);await this.#syncDir(allocation);await verify();
   const repository=await inspector.repository(row.cwd,inspector.epoch);check();if(repository.cwd!==row.cwd||repository.identities.cwd.dev!==String(project.dev)||repository.identities.cwd.ino!==String(project.ino))throw Error('Host Git repository root differs from the admitted project.');
   if(inspection){const witness=await builder.inspect(repository),encoded=JSON.stringify(witness);await verify();return {witness,reverify:async()=>{check();if(JSON.stringify(witness)!==encoded)throw Error('Host Git inspection witness changed.');}};}
   const source=await inspector.readState(repository,inspector.epoch,{includeDiff:false}),snapshot=await builder.snapshot(source);await verify();return admitGitSnapshot({snapshot,check});
  });
  return Object.freeze({...inspection?{witness:admitted.witness}:{snapshot:admitted.snapshot,bundleBytes:admitted.bundleBytes},reverify:()=>track(withNative(async()=>{await verify();await admitted.reverify();await builder.verifySnapshotSource();await admitted.reverify();await verify();}))});
 }
 async #nativeFiles(action,input,{signal,record,closed,check,completionCheck,settledCopyFailure}){
  check();if(this.#native)throw Error('Previous native file helper closure is unresolved.');
  const mutation=['copy','materialize','publish','disposeGuestDisk','disposeFailedGuestDisk','releaseEmptyAllocation'].includes(action);
  if(mutation&&(typeof record!=='function'||typeof closed!=='function'))throw Error('Native mutation requires durable record and closed callbacks.');
  const body=JSON.stringify(input),limit=8*1024*1024;if(Buffer.byteLength(body)>limit)throw Error('Native file request exceeds 8 MiB.');
  const state={child:null};this.#native=state;
  let timer,exitLimit,cancel;
  try{
  const helper=this.#engineOptions.nativeHelper??process.env.QWEN_LOCAL_NATIVE_HELPER,helperID=await verifyHandoffHelper(helper,this.#helperIdentity);this.#helperIdentity=helperID;check();
  const nonce=mutation?randomUUID():null,child=(this.#engineOptions.spawnProcess??spawn)(helper,nonce?['--handoff-process','files',nonce,action]:action==='inspectFailedGuestDisk'?['--handoff-process','inspect-failed-disk']:action==='inspectEmptyAllocation'?['--handoff-process','inspect-empty-allocation']:['--handoff-files',action],{cwd:'/private/var/empty',env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},detached:true,stdio:nonce?['pipe','pipe','pipe','pipe','pipe']:['pipe','pipe','pipe']});
  state.child=child;let failure,recordFailure,code,exitSignal,count=0,diagnostics=0,recordWork,expire,abort;
  const out=[],err=[],expired=new Promise(r=>expire=r),aborted=new Promise(r=>abort=r);
  cancel=()=>{if(state.closed)return;state.cancelled=true;abort(Error('Native file helper cancelled by Stop.'));child.stdin.destroy();child.stdio?.[4]?.destroy();if(!state.exited)try{child.kill('SIGKILL');}catch(e){failure??=e;}exitLimit??=setTimeout(()=>expire(false),2500);};
  const closure=new Promise(resolve=>{child.once('error',e=>{failure=e;cancel();});child.once('close',(c,s)=>{state.exited=true;state.closed=true;code=c;exitSignal=s;resolve(true);});});
  child.once('exit',()=>{state.exited=true;});child.stdin.on('error',()=>{});child.stdio?.[4]?.on('error',()=>{});
  child.stdout.on('data',b=>{count+=b.length;if(count>limit){failure=Error('Native file helper output exceeds 8 MiB.');cancel();}else out.push(b);});
  child.stderr.on('data',b=>{diagnostics+=b.length;if(diagnostics>65536){failure=Error('Native file helper diagnostics exceed 64 KiB.');cancel();}else err.push(b);});
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  timer=setTimeout(()=>{failure=Error('Native file helper timed out.');cancel();},20000);
  const active=()=>{check();if(state.cancelled||state.exited)throw Error('Native file helper is no longer active.');};
   try{
    if(nonce)await releaseHandoffProcess(child,nonce,{record:value=>{recordWork=Promise.resolve().then(()=>record(value));return recordWork;},abort:aborted,check:active});
    active();child.stdin.end(body);
   }catch(e){failure??=e;cancel();}
   const confirmed=await Promise.race([closure,expired]);
   // A cancelled release gate may return while its durable callback still writes.
   try{await recordWork;}catch(e){recordFailure=e;failure??=e;}
   if(!confirmed)throw this.#block(Error('Native file helper close is unconfirmed; coordinator lease and stage retained.'));
   if(Number.isInteger(child.pid)&&child.pid>1)try{process.kill(-child.pid,0);throw Error('Native file helper process group still exists; lease retained.');}catch(e){if(e.code!=='ESRCH')throw this.#block(e);}
   await closed?.();if(recordFailure)throw recordFailure;
   if(this.#native===state)this.#native=null;
   if(failure)throw failure;
   if(state.cancelled||exitSignal||code!==0){
    const error=Error(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(err)).slice(0,1600)||'Native file helper failed.');
    // The original child, process group, record and closed callbacks all settled
    // above. Cancellation, signals, publication and callback failures cannot pass.
    if(action==='copy'&&!state.cancelled&&!exitSignal&&code!==0)settledCopyFailure?.(error);
    throw error;
   }
   const complete=completionCheck??check;complete();await verifyHandoffHelper(helper,helperID);complete();return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(out)));
  }finally{if(!state.child&&this.#native===state)this.#native=null;clearTimeout(timer);clearTimeout(exitLimit);if(cancel)signal.removeEventListener('abort',cancel);}
 }
 #forkStamps(result,paths){
  const rows=result?.stamps;if(!rows||typeof rows!=='object'||Array.isArray(rows)||Object.keys(rows).length!==paths.length||paths.some(p=>!Object.hasOwn(rows,p)))throw Error('Fork snapshot inventory is incomplete.');
  for(const [i,path] of paths.entries()){const r=rows[path];if(!identity(r?.identity)||r.kind!==(i===paths.length-1?'file':'directory')||r.uid!==process.getuid()||!Number.isSafeInteger(r.mode)||r.mode<0||r.mode>0o7777||(r.mode&0o022))throw Error('Fork snapshot has unsafe entries.');}
  const leaf=rows[paths.at(-1)];if(leaf.nlink!==1||!Number.isSafeInteger(leaf.bytes)||leaf.bytes<1||leaf.bytes>32*1024*1024||!digest(leaf.sha256))throw Error('Fork rollout size, links or digest is invalid.');return leaf;
 }
 async #fork(input,epoch,operation){
  const sourceRow=this.#rows.find(r=>r.rootThreadId===input.threadId);if(!sourceRow)throw Error('Independent fork requires a managed root chat.');
  await this.#verifyHome(sourceRow);await this.#plainMCP(sourceRow);
  const cloudProfile=await this.#cloudProfile(sourceRow);this.#check(epoch,operation);
  this.#bind(operation,sourceRow);
  const check=()=>{this.#check(epoch,operation);if(operation.controller.signal.aborted)throw Error('Fork cancelled by Stop.');};
  const idleCheck=async()=>{check();const uncertain=await this.#uncertain(sourceRow.cwd);check();if(this.#scheduled||uncertain||this.#projects.scheduled()||this.#projects.fenced(sourceRow.cwd)||this.#authority.projectOccupied(sourceRow.cwd)||this.#authority.projectMutation)throw busy();};
  await idleCheck();const resolved=await this.#thread(input.threadId,false,epoch,operation),engine=resolved.engine;check();if(resolved.creation)throw Error('A creation receipt has no saved native fork history.');
  const sourceIdle=async()=>{await idleCheck();if([engine.approvals,engine.approvalChecks,engine.familyOperations,engine.familyStops,engine.busy,engine.terminalStarts,engine.admissions,engine.commandRequests].some(work=>work.size))throw busy();};await sourceIdle();
  await engine.loadPartialHistory();check();this.#pin(sourceRow,engine);
  const history=await engine.handle({action:'read',threadId:input.threadId});check();this.#pin(sourceRow,engine);
  const thread=history.thread,partial=engine.liveHistory.get(input.threadId);
  if(thread.id!==sourceRow.rootThreadId||thread.cwd!==sourceRow.cwd||thread.model!==sourceRow.model||thread.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[sourceRow.provider])||engine.childThread(thread))throw Error('Fork source identity changed.');
  const expectedModel=thread.model;
  if(thread.turns?.length){await this.#invalidateCreation(sourceRow);check();this.#pin(sourceRow,engine);}
  if(history.pendingMaterialization||history.historyTruncated||history.historyWarning||engine.historyBlocked||engine.historyWarning||engine.liveHistoryEvicted||partial?.truncated||partial?.turns.some(t=>['failed','interrupted'].includes(t.status)&&t.items.some(i=>i.type==='agentMessage'))||!Array.isArray(thread?.turns)||!thread.turns.length||thread.turns.some(t=>!['completed','failed','interrupted'].includes(t.status))||!['idle','notLoaded'].includes(thread.status?.type))throw Error('Fork requires complete saved idle history; partial or empty history must be resolved first.');
  // ponytail: copy only a root rollout; family assets/child-history transfer need
  // their own complete native snapshot contract rather than silent omission.
  for(const archived of [false,true])if((await engine.handoffScan({ancestorThreadId:thread.id,sourceKinds:['subAgentThreadSpawn'],archived},check)).length)throw Error('Forking a saved child family requires family-history transfer.');
  const idle=await this.#projects.verifyIdle([sourceRow.cwd],check);idle();await sourceIdle();check();this.#pin(sourceRow,engine);
  const sourceGeneration=sourceRow.generation.id,live=this.#live.get(sourceRow.id);
  await this.#retire(sourceRow,live);check();
  if(sourceRow.generation.id!==sourceGeneration||sourceRow.generation.nativeOpen||sourceRow.generation.execution!==(nativeOwner(sourceRow)?'native-stopped':'revoked')||!sourceRow.generation.executorClosed)throw Error('Fork source executor generation has no revocation proof.');
  await this.#verifyHome(sourceRow);const compatibility=await engine.handoffCompatibility(thread);check();
  const sourcePath=relative(this.#home(sourceRow),thread.path);if(!rolloutPath(sourcePath))throw Error('Invalid fork source rollout path.');
  const paths=sourcePath.split('/').map((_,i,parts)=>parts.slice(0,i+1).join('/')),sourceRoot=await this.#root(this.#home(sourceRow),sourceRow.home);
  const reviewed=await this.#forkFiles('snapshot',{root:sourceRoot,paths},{signal:operation.controller.signal,check});check();const leaf=this.#forkStamps(reviewed,paths);
  if(!same(leaf.identity,compatibility.identity))throw Error('Fork source changed after header validation.');
  const current=await engine.handoffCompatibility(thread);check();if(current.headerHash!==compatibility.headerHash||!same(current.identity,leaf.identity))throw Error('Fork source header changed during snapshot.');
  const fresh=await this.#projects.verifyIdle([sourceRow.cwd],check);fresh();await idleCheck();
  const row=await this.#provision({cwd:sourceRow.cwd,provider:sourceRow.provider,executionMode:sourceRow.executionMode??'vm'},epoch,operation,null,cloudProfile);let destination;
  try{
   row.fork={sourceOwnerId:sourceRow.id,sourceGeneration,sourceThreadId:thread.id,sourceHome:{...sourceRow.home},sourcePath,sourceIdentity:await this.#savedFileIdentity(join(this.#home(sourceRow),sourcePath),leaf.identity),sha256:leaf.sha256,stage:null,worker:null,snapshot:null,dispatched:false};await this.#save();check();
   const stage=join(this.#home(row),'fork-source');await mkdir(stage,{mode:0o700});await this.#syncDir(this.#home(row));row.fork.stage=await this.#dir(stage);await this.#save();check();
   const request={source:sourceRoot,destination:await this.#root(stage,row.fork.stage),stamps:reviewed.stamps},requestHash=hash(JSON.stringify(request));
   const copied=await this.#forkFiles('copy',request,{signal:operation.controller.signal,check,
    record:async process=>{check();if(row.fork.worker)throw Error('Fork worker was already recorded.');row.fork.worker={process:verifyHandoffProcessReceipt(process,{nonce:process?.nonce,pid:process?.pid}),requestHash,closed:false};await this.#save();},
    closed:async()=>{if(row.fork.worker){row.fork.worker.closed=true;await this.#save();}}
   });check();const staged=this.#forkStamps(copied,paths);
   if(staged.sha256!==leaf.sha256||staged.bytes!==leaf.bytes||!row.fork.worker?.closed)throw Error('Fork staged contents or worker closure differ.');
   await this.#dir(stage,row.fork.stage);row.fork.snapshot=await this.#savedFileIdentity(join(stage,sourcePath),staged.identity);await this.#save();check();
   if(sourceRow.generation.id!==sourceGeneration||sourceRow.generation.execution!==(nativeOwner(sourceRow)?'native-stopped':'revoked')||!sourceRow.generation.executorClosed||sourceRow.generation.nativeOpen)throw Error('Fork source revocation changed.');
   destination=await this.#owner(row,true,epoch,operation.controller.signal,operation);this.#pin(row,destination);const bound=this.#live.get(row.id),generation=row.generation.id;
   row.fork.dispatched=true;await this.#save();check();this.#pin(row,destination);
   const result=await destination.forkFromSnapshot({source:{id:thread.id,cwd:row.cwd,model:thread.model,modelProvider:thread.modelProvider},path:join(stage,sourcePath),identity:staged.identity,sha256:leaf.sha256,onCreated:async created=>{
    if(this.#live.get(row.id)!==bound||bound.engine!==destination||row.generation.id!==generation)throw this.#block(Error('Fork native receipt ownership changed.'));
    await this.#commitRoot(row,created,expectedModel);
   }});check();this.#pin(row,destination);await this.#prepareResource(row,destination,epoch,operation);return ownerResult(row,result);
  }catch(error){const live=this.#live.get(row.id);if(live)try{await this.#retire(row,live);}catch{}throw error;}
 }

 async #provision(input,epoch,operation,setup=null,cloudProfile=null){
  if(input.provider==='cloud'&&!cloudProfile?.credentialId)throw Error('Save a cloud provider again before starting a new cloud chat.');
  if(input.executionMode==='native'&&!this.#durableIdentity)throw Error('Native Coding requires an existing durable filesystem identity catalog.');
  if(this.#rows.length>=LIMIT)throw Error('Coding owner limit reached.');const cwd=await this.#authority.cwd(input.cwd);this.#check(epoch,operation);if(await this.#uncertain(cwd)||this.#projects.scheduled(cwd))throw busy();this.#check(epoch,operation);
  await this.#legacyOwner(epoch,operation);this.#check(epoch,operation);
  await this.#authority.assertProject(cwd);this.#check(epoch,operation);
  await this.#quarantineScope([cwd],()=>this.#check(epoch,operation));this.#check(epoch,operation);
  await this.#admission(true,input.executionMode??'vm');this.#check(epoch,operation);
  if(setup)this.#checkSetup(setup);
  const row={id:setup?.ownerId??randomUUID(),home:null,rootThreadId:null,threads:[],cwd,provider:input.provider??'local',model:null,state:'creating',generation:null,creation:null,fork:null,mcp:{kind:'never-enabled'},...(input.executionMode==='native'?{executionMode:'native'}:{})};this.#rows.push(row);if(setup)setup.row=row;this.#bind(operation,row,true);await this.#save();this.#check(epoch,operation);
  await mkdir(this.#home(row),{mode:0o700});await this.#syncDir(join(this.dataDir,'owners'));row.home=await this.#dir(this.#home(row));await this.#save();this.#check(epoch,operation);
  if(cloudProfile)await this.#saveCloudProfile(row,cloudProfile,()=>this.#check(epoch,operation));return row;
 }
 async #commitRoot(row,thread,expectedModel){
  // Commit an exact returned native identity even if Stop arrived while start was pending.
  if(typeof expectedModel!=='string'||!expectedModel||row.state!=='creating'||!id(thread?.id)||thread.parentThreadId||thread.source?.subAgent||thread.canAcceptDirectInput===false||thread.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[row.provider])||thread.cwd!==row.cwd||thread.model!==expectedModel)throw this.#block(Error('Native root identity did not match its provisional owner.'));
  if(this.#rows.some(r=>r!==row&&r.threads.includes(thread.id)))throw this.#block(Error('Duplicate native root owner.'));
  if(this.#legacyLive?.engine?.verifiedThreads.has(thread.id))throw this.#block(Error('Conflicting managed and legacy thread ownership.'));
  if(row.fork&&(!row.fork.dispatched||thread.forkedFromId!==row.fork.sourceThreadId||thread.id===row.fork.sourceThreadId||thread.ephemeral!==false))throw this.#block(Error('Fork root provenance did not match its provisional owner.'));
  Object.assign(row,{rootThreadId:thread.id,threads:[thread.id],model:thread.model,state:'ready',creation:row.fork?null:Object.fromEntries(['createdAt','updatedAt','name','historyMode'].map(k=>[k,thread[k]??null]))});await this.#save();
  if(nativeOwner(row))this.#live.get(row.id).engine.bindOwnedRoot({id:row.rootThreadId,cwd:row.cwd,model:row.model,modelProvider:{local:'saleh_local',cloud:'saleh_cloud'}[row.provider]});
 }
 async #create(input,epoch,operation,setup=null){
  const request={...input},cwd=await this.#authority.cwd(request.cwd);this.#check(epoch,operation);if(await this.#uncertain(cwd)||this.#projects.scheduled(cwd))throw busy();this.#check(epoch,operation);
  await this.#authority.assertProject(cwd);this.#check(epoch,operation);
  let expectedModel,cloudProfile=null;
  if(request.provider==='cloud'){
   const profile=await this.#authority.providerMetadata();if(!profile?.credentialId)throw Error('Save a cloud provider again before starting a new cloud chat.');if(setup&&(profile.model!==setup.request.model||JSON.stringify(profile)!==JSON.stringify(setup.provider)))throw Error('Reviewed cloud provider changed.');expectedModel=profile.model;cloudProfile=profile;
  }else{
   const profile=this.#authority.profile(request.provider,request.model);expectedModel=profile.model;if(!setup)await this.#authority.resolveModel(profile);
  }
  this.#check(epoch,operation);
  if(setup){
   this.#checkSetup(setup);if(expectedModel!==setup.request.model||cwd!==setup.request.cwd||request.executionMode!==setup.request.executionMode)throw Error('Reviewed Coding MCP project, model or execution mode changed.');
   const described=await setup.hub.describe();this.#checkSetup(setup);
   for(const selected of setup.reviewed){const entries=described.servers.filter(server=>server.id===selected.id);if(entries.length!==1||entries[0].configHash!==selected.configHash)throw Error('Reviewed Coding MCP configuration changed.');}
  }
  // Revalidate project admission after the inventory await, before provisioning.
  // Fork snapshots and fixed-model schedules retain their independent contracts.
  const row=await this.#provision({...request,cwd},epoch,operation,setup,cloudProfile),engine=await this.#owner(row,true,epoch,undefined,operation,setup);this.#pin(row,engine);
  if(setup){this.#checkSetup(setup);if(request.provider==='cloud'&&JSON.stringify(engine.cloud)!==JSON.stringify(setup.provider))throw Error('Started cloud provider differs from its review.');this.#setupChange(setup,{creation:'unknown'});}
  const {executionMode:ignoredMode,...engineRequest}=request;const result=await engine.handle({...engineRequest,cwd});
  await this.#commitRoot(row,result.thread,expectedModel);
  const setupCreation=setup?structuredClone(row.creation):null;
  if(nativeOwner(row)){
   // Archive materializes an empty session without a synthetic turn or title.
   // Keep the returned root durable first; an interrupted reopen stays archived.
   this.#check(epoch,operation);this.#pin(row,engine);
   await engine.handle({action:'archive',threadId:row.rootThreadId});
   await this.#invalidateCreation(row);
   this.#check(epoch,operation);this.#pin(row,engine);
   await engine.handle({action:'unarchive',threadId:row.rootThreadId});
  }
  if(setup)this.#setupChange(setup,{creation:'confirmed',root:freeze({ownerId:row.id,generation:row.generation.id,thread:{id:row.rootThreadId,cwd:row.cwd,model:row.model,modelProvider:{local:'saleh_local',cloud:'saleh_cloud'}[row.provider],executionMode:row.executionMode??'vm',...setupCreation}})});
  this.#check(epoch,operation);await this.#prepareResource(row,engine,epoch,operation);return ownerResult(row,result);
 }
 #captureControls(){
  const active=new Map();for(const [owner,live] of this.#live){const engine=live.engine;if(!this.#current(live))continue;
   for(const kind of ['approvals','questions','terminals','terminalHistory'])for(const [key,handle] of engine[kind]){
    const type=kind==='approvals'?'approval':kind==='questions'?'question':'terminal',id=type+':'+key;
    if(active.has(id)&&active.get(id).handle!==handle)throw Error('Conflicting live coding capability.');
    const previous=this.#controls.get(id);if(previous===null||previous&&(previous.engine!==engine||previous.handle!==handle))throw Error('Reused or stale coding capability.');active.set(id,{owner,engine,handle});
   }
  }for(const id of this.#controls.keys())if(!active.has(id))this.#controls.set(id,null);for(const [id,value] of active)this.#controls.set(id,value);if(this.#controls.size>4096)throw Error('Coding capability history limit reached; close the coordinator before continuing.');return active;
 }
 async #list(input,epoch,operation){
  let snapshot,offset=0;const searchTerm=input.searchTerm??null,search=searchTerm===null?{}:{searchTerm};
  if(input.cursor){const [token,index]=input.cursor.split(':');offset=Number(index);snapshot=this.#snapshots.get(token);if(!snapshot||snapshot.searchTerm!==searchTerm||snapshot.archived!==!!input.archived||snapshot.expires<Date.now()||!Number.isSafeInteger(offset)||offset<0||String(offset)!==index)throw Error('Expired or invalid coding list cursor.');}
  else{
   const threads=[],ids=new Set();let truncated=false,bytes=0,historyIncomplete=false,handoffIncomplete=false;
   const legacy=await this.#legacyOwner(epoch,operation);if(legacy){
    let inventory=legacy.inventory[input.archived?'archived':'active'];
    if(searchTerm!==null){const allowed=new Map(inventory.map(t=>[t.id,t])),matches=[],seen=new Set();let cursor;
     do{this.#pinLegacy(legacy);const page=await legacy.engine.handle({action:'list',archived:!!input.archived,...search,...(cursor?{cursor}:{})});this.#check(epoch,operation);this.#pinLegacy(legacy);this.#legacyCollision(legacy);truncated||=!!page.truncated;
      for(const hit of page.threads){const verified=allowed.get(hit.id);if(!verified)throw Error('Native search returned unverified legacy history.');if(matches.some(t=>t.id===hit.id))throw Error('Duplicate legacy search identity.');matches.push({...verified,searchSnippet:hit.searchSnippet});if(matches.length>4096)throw Error('Legacy search exceeds its verification limit.');}
      cursor=page.nextCursor;if(cursor&&(typeof cursor!=='string'||cursor.length>4096||seen.has(cursor)||seen.size>=128))throw Error('Legacy search pagination is invalid or incomplete.');if(cursor)seen.add(cursor);
     }while(cursor);inventory=matches;
    }
    for(const thread of inventory){ids.add(thread.id);threads.push(thread);bytes+=Buffer.byteLength(JSON.stringify(thread));if(bytes>8*1024*1024)throw Error('Coding list exceeds its snapshot byte limit.');}
   }
   for(const row of this.#rows){
    if(row.handoff&&!this.#handoffHistoryReadable(row)){historyIncomplete=true;handoffIncomplete=true;continue;}
    if(row.state!=='ready'){
     if(row.state==='creating'&&row.generation?.nativeOpen===false&&row.generation.executorClosed===true&&!this.#live.has(row.id)&&(!row.fork?.worker||row.fork.worker.closed===true)){historyIncomplete=true;continue;}
     throw Error('Coding owner creation needs recovery; chat list is incomplete.');
    }
    const existing=this.#live.get(row.id)?.engine;
    const engine=await this.#owner(row,false,epoch,undefined,operation),reader=engine.historyOnly&&engine!==existing?this.#live.get(row.id):null;let cursor;const seen=new Set();
    try{
    do{this.#pin(row,engine);const page=await engine.handle({action:'list',archived:!!input.archived,...search,...(cursor?{cursor}:{})});this.#check(epoch,operation);truncated||=!!page.truncated;
     for(const t of page.threads){this.#pin(row,engine);const {root}=await engine.resolveFamily(t.id);if(root.id!==row.rootThreadId||root.cwd!==row.cwd||root.model!==row.model||root.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[row.provider]))throw Error('Native history contains a root outside its assigned owner.');if(ids.has(t.id))throw Error('Duplicate native history ownership.');ids.add(t.id);bytes+=Buffer.byteLength(JSON.stringify(t));if(bytes>8*1024*1024)throw Error('Coding list exceeds its snapshot byte limit.');threads.push(ownerThread(row,t));if(threads.length>4096)throw Error('Coding list exceeds its verification limit.');}
     cursor=page.nextCursor;if(cursor&&seen.has(cursor))throw Error('Native history pagination did not advance.');if(cursor)seen.add(cursor);if(seen.size>128)throw Error('Native history pagination exceeds its verification limit.');
    }while(cursor);await this.#remember(row,engine);
    if(!row.handoff&&searchTerm===null&&!ids.has(row.rootThreadId)&&(nativeOwner(row)||!input.archived&&row.creation)){
     const resolved=await this.#thread(row.rootThreadId,false,epoch,operation);this.#pin(row,engine);
     // A real rollout wins over a retained receipt, including a lost archive reply.
     const thread=resolved.creation?(!input.archived?resolved.creation.thread:null):nativeOwner(row)?await engine.ownedEmptyRoot(!!input.archived):engine.threadView(resolved.nativeRoot,8000).value;
     this.#check(epoch,operation);this.#pin(row,engine);if(!thread)continue;
     if(ids.has(thread.id))throw Error('Duplicate native history ownership.');ids.add(thread.id);bytes+=Buffer.byteLength(JSON.stringify(thread));if(bytes>8*1024*1024||threads.length>=4096)throw Error('Coding list exceeds its snapshot limit.');threads.push(ownerThread(row,thread));
    }
    }finally{
     // Listing must not retain one idle native process per saved workspace.
     if(reader&&this.#live.get(row.id)===reader)await this.#retire(row,reader);
    }
   }
   this.#check(epoch,operation);threads.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.id.localeCompare(b.id));const token=randomUUID();snapshot={token,searchTerm,archived:!!input.archived,threads,truncated,historyIncomplete,historyWarning:handoffIncomplete?'Some worktree handoffs remain incomplete. Their history is unavailable; verified saved chats are listed.':historyIncomplete?'Some task startups remain incomplete. Their history is unavailable; verified saved chats are listed.':null,expires:Date.now()+120000};this.#snapshots.set(token,snapshot);while(this.#snapshots.size>8)this.#snapshots.delete(this.#snapshots.keys().next().value);
  }
  const threads=snapshot.threads.slice(offset,offset+50);return {threads:structuredClone(threads),nextCursor:offset+50<snapshot.threads.length?snapshot.token+':'+(offset+50):null,truncated:snapshot.truncated,historyIncomplete:snapshot.historyIncomplete,historyWarning:snapshot.historyWarning};
 }
 async #status(){
  const base=await this.#authority.handle({action:'status'}),states=await Promise.all([...this.#live.values()].filter(x=>x.engine&&!x.engine.closed&&this.#rows.some(r=>r.state==='ready'&&this.#home(r)===x.engine.dataDir)).map(x=>x.engine.handle({action:'status'})));
  const workspaceSync=[...this.#live.values()].filter(x=>x.engine&&this.#rows.some(r=>r.state==='ready'&&this.#home(r)===x.engine.dataDir)).flatMap(x=>x.engine.workspaceSyncView()),workspaceSyncCursor=this.#journal.sequence;
  return {...base,followupQueue:!!this.#durableIdentity,workspaceSync,workspaceSyncCursor,activeTurns:states.flatMap(x=>x.activeTurns??[]),stoppingFamilies:[...new Set([...states.flatMap(x=>x.stoppingFamilies??[]),...this.#rows.filter(r=>r.rootThreadId&&this.#selectedStops.get(r.id)?.pending).map(r=>r.rootThreadId)])],terminals:states.flatMap(x=>x.terminals??[]),running:states.some(x=>x.running),busy:this.exitUnconfirmed||this.#operations.size>1||states.some(x=>x.busy),message:this.#blocked?.message??(this.#rows.some(r=>r.handoff)?'A worktree handoff needs inspection; affected chats remain fenced.':this.#legacyUncertain()?'Legacy chats are history-only; prior execution writers or reader closure remain unverified.':this.exitUnconfirmed?'Execution generation needs recovery; saved history remains available after confirmed native exit.':base.message),legacy:this.#legacy?{historyOnly:true,nativeOpen:this.#legacy.nativeOpen,execution:this.#admissionProof?'prior-boot-ended':'unknown'}:null,owners:this.#rows.map(r=>({id:r.id,rootThreadId:r.rootThreadId,executionMode:r.executionMode??'vm',state:r.state,nativeOpen:r.generation?.nativeOpen??false,execution:r.generation?.execution??'none',executorClosed:r.generation?.executorClosed??null,stopping:!!this.#selectedStops.get(r.id)?.pending,stopError:this.#selectedStops.get(r.id)?.error??null}))};
 }
 #followupLedger(){
  if(!this.#durableIdentity)throw Error('Follow-ups require a verified durable owner home. Saved chats remain available.');
  return this.#followups??=new CodingQueue({dataDir:join(this.dataDir,'followups'),nativeHelper:this.#engineOptions.nativeHelper});
 }
 async #followupBinding(row,operation){
  this.#check(operation.epoch,operation);this.#quarantineFence(row);
  if(row.handoff||row.state!=='ready'||!isFilesystemIdentity(row.home))throw Error('This retained owner cannot accept follow-ups before its original recovery is verified.');
  await this.#verifyHome(row);this.#check(operation.epoch,operation);
  const cwd=await this.#authority.cwd(row.cwd);await this.#authority.assertProject(cwd);this.#check(operation.epoch,operation);
  const projectIdentity=await readFilesystemIdentity({path:cwd,nativeHelper:this.#engineOptions.nativeHelper});this.#check(operation.epoch,operation);
  if(cwd!==row.cwd)throw Error('Follow-up project identity changed.');
  return validateQueueBinding({version:1,ownerId:row.id,home:row.home,rootThreadId:row.rootThreadId,cwd,projectIdentity,provider:row.provider,model:row.model,executionMode:row.executionMode??'vm'});
 }
 #cancelFollowupPreparations(root=null){
  for(const [token,entry] of this.#followupPrepared)if(root===null||entry.binding.rootThreadId===root){entry.operation.controller.abort();if(!entry.committing){this.#followupPrepared.delete(token);this.#release(entry.operation);}}
 }
 cancelQueuePreparations(){this.#cancelFollowupPreparations();return {stopped:true};}
 #pauseFollowups(root=null){
  this.#cancelFollowupPreparations(root);
  for(const [id,pump] of this.#followupPumps)if(root===null||id===root)pump.paused=true;
  const work=this.#followups?(root===null?this.#followups.pauseAll():this.#followups.pause(root)):Promise.resolve();
  this.#followupWrites.add(work);void work.catch(error=>{this.#followupFailure??=error;this.#journal.push('coding/error',{message:'Follow-up pause could not be saved. Retained work will not be replayed. '+error.message});}).finally(()=>this.#followupWrites.delete(work));return work;
 }
 async #followupPrecedence(root){
  if(!this.#durableIdentity)return false;
  const view=await this.#followupLedger().inspect();if(view.blocked)throw Error(view.warning);
  const group=view.groups.find(g=>g.binding.rootThreadId===root);
  return !!group?.active&&group.items.some(i=>['queued','claimed','acknowledged','unknown'].includes(i.status));
 }
 #followupItem({request,...item},full=false){return {...item,text:full?request.text:request.text.slice(0,2000),textTruncated:!full&&request.text.length>2000,effort:request.effort,mode:request.mode??'build',attachments:request.attachments.map(file=>({kind:file.kind,name:file.name}))};}
 #followupView(view,root){
  const group=view.groups.find(g=>g.binding.rootThreadId===root);
  return {blocked:view.blocked,warning:view.warning,revision:view.revision,group:group?{binding:group.binding,active:group.active,revision:group.revision,items:group.items.map(item=>this.#followupItem(item))}:null};
 }
 async handleQueue(input,context){
  const origin=requestContext(context),action=input?.action;
  const fields={inspect:['threadId'],read:['threadId','id'],prepare:['id','threadId','text','attachments','effort'],prepareResume:['threadId','revision'],prepareVerify:['threadId','id','revision'],commit:['token'],cancel:['token'],pause:['threadId'],edit:['threadId','id','revision','text','effort'],remove:['threadId','id','revision'],reorder:['threadId','revision','ids']};
  if(!Object.hasOwn(fields,action))throw Error('Invalid follow-up operation.');shape(input,['action',...fields[action],...(['prepare','edit'].includes(action)&&Object.hasOwn(input,'mode')?['mode']:[])]);
  if(Object.hasOwn(input,'mode')&&!['build','plan'].includes(input.mode))throw Error('Invalid follow-up task mode.');
  if(input.threadId!==undefined&&!id(input.threadId)||input.id!==undefined&&!uuid(input.id)||input.token!==undefined&&!uuid(input.token))throw Error('Invalid follow-up identity.');
  if(action==='cancel'){const entry=this.#followupPrepared.get(input.token);if(entry){entry.operation.controller.abort();if(!entry.committing){this.#followupPrepared.delete(input.token);this.#release(entry.operation);}}return {cancelled:true};}
  if(action==='pause'){await this.#pauseFollowups(input.threadId);return this.handleQueue({action:'inspect',threadId:input.threadId});}
  if(this.closed||this.#stopping)throw Error('Follow-up work was cancelled by Stop or shutdown.');
  if(action==='commit'){
   const entry=this.#followupPrepared.get(input.token);if(!entry||entry.committing)throw Error('Follow-up preparation is cancelled, expired or unknown.');entry.committing=true;
   const {operation,binding,request}=entry,abort=()=>operation.controller.abort();origin?.signal?.addEventListener('abort',abort,{once:true});if(origin?.signal?.aborted)abort();
   try{return await this.#serial(async()=>{
    await this.#load(operation);this.#check(operation.epoch,operation);const {row}=await this.#thread(binding.rootThreadId,false,operation.epoch,operation);
    if(!equal(binding,await this.#followupBinding(row,operation)))throw Error('Follow-up owner, project or model binding changed during preparation.');
    const ledger=this.#followupLedger();let item=null;
    const admission=()=>{try{this.#check(operation.epoch,operation);}catch(error){if(!this.#blocked)error.code='QUEUE_CANCELLED';throw error;}};
    if(entry.verify){
     const view=await ledger.inspect(),group=view.groups.find(g=>g.binding.rootThreadId===binding.rootThreadId),saved=group?.items.find(i=>i.id===entry.id);
     if(view.blocked)throw Error(view.warning);
     if(!group||!equal(group.binding,binding)||!saved||saved.revision!==entry.revision||saved.status!=='unknown'||!id(saved.turnId)||!saved.claim)throw Error('This uncertain follow-up has no matching exact turn receipt to verify. No work was replayed.');
     const {engine}=await this.#thread(binding.rootThreadId,true,operation.epoch,operation);
     const proof=await engine.followupIdle({threadId:binding.rootThreadId,cwd:binding.cwd,model:binding.model,modelProvider:{local:'saleh_local',cloud:'saleh_cloud'}[binding.provider]},saved.turnId);
     admission();if(!proof)throw Error('The exact saved turn and its complete tracked family are not yet verified idle. The queue stays paused.');this.#pin(row,engine);proof.check();
     item=await ledger.finish(saved.id,saved.claim.id,{status:proof.status,turnId:saved.turnId,message:'Exact saved turn '+proof.status+'; complete tracked family verified idle. Queue remains paused for explicit resume.'});
    }else if(entry.resume)await ledger.resume(binding.rootThreadId,entry.revision,admission);else item=await ledger.accept({id:entry.id,binding,request},admission);
    // Durable acceptance transfers ownership from the response socket. Owner
    // Stop still revokes the ledger and the new backend operation synchronously.
    origin?.signal?.removeEventListener('abort',abort);if(!entry.verify)this.#startFollowups(binding.rootThreadId);
    return {accepted:true,...(item?{item:this.#followupItem(item)}:{}),...(this.#followupView(await ledger.inspect(),binding.rootThreadId))};
   });}finally{origin?.signal?.removeEventListener('abort',abort);this.#followupPrepared.delete(input.token);this.#release(operation);}
  }
  const operation=this.#operation(this.#epoch,origin);this.#operations.add(operation);let retained=false;
  try{return await this.#serial(async()=>{
   await this.#load(operation);this.#check(operation.epoch,operation);const ledger=this.#followupLedger();
   if(action==='inspect')return this.#followupView(await ledger.inspect(),input.threadId);
   if(action==='read'){
    const view=await ledger.inspect();if(view.blocked)throw Error(view.warning);const item=view.groups.find(g=>g.binding.rootThreadId===input.threadId)?.items.find(i=>i.id===input.id);return {item:item?this.#followupItem(item,true):null};
   }
   const {row}=await this.#thread(input.threadId,false,operation.epoch,operation);this.#bind(operation,row);
   if(row.rootThreadId!==input.threadId)throw Error('Queue follow-ups in the existing parent chat. Child history is read-only.');
   const binding=await this.#followupBinding(row,operation);
   if(['prepare','prepareResume','prepareVerify'].includes(action)){
    if(this.#followupPrepared.size>=64)throw Error('Too many pending follow-up preparations. Cancel an earlier preparation first.');
    const resume=action==='prepareResume',verify=action==='prepareVerify',request=action==='prepare'?normalizeQueueRequest({text:input.text,attachments:input.attachments,effort:input.effort,...(Object.hasOwn(input,'mode')?{mode:input.mode}:{})}):null;
    if((resume||verify)&&(!Number.isSafeInteger(input.revision)||input.revision<1))throw Error('Invalid follow-up revision.');
    const token=randomUUID();operation.detachOrigin?.();this.#followupPrepared.set(token,{operation,binding,request,id:input.id,resume,verify,revision:input.revision,committing:false});retained=true;return {token,binding};
   }
   const view=await ledger.inspect();if(view.blocked)throw Error(view.warning);const group=view.groups.find(g=>g.binding.rootThreadId===input.threadId);
   if(!group||!equal(group.binding,binding))throw Error('Saved follow-up binding changed. Preserve it and inspect the original owner.');
   if(action==='reorder')await ledger.reorder(input.threadId,input.revision,input.ids);
   else{
    const item=group.items.find(i=>i.id===input.id);if(!item)throw Error('Unknown follow-up item.');
    if(action==='remove')await ledger.remove(input.id,input.revision);
    else await ledger.edit(input.id,input.revision,{text:input.text,attachments:item.request.attachments,effort:input.effort,...(Object.hasOwn(input,'mode')?{mode:input.mode}:Object.hasOwn(item.request,'mode')?{mode:item.request.mode}:{})});
   }
   this.#check(operation.epoch,operation);return this.#followupView(await ledger.inspect(),input.threadId);
  });}finally{if(!retained)this.#release(operation);}
 }
 #startFollowups(root){
  if(this.closed||this.#stopping||this.#blocked||this.#followupFailure||this.#stopIntents.has(root))return;
  const row=this.#rows.find(r=>r.rootThreadId===root);if(!row||this.#selectedStops.get(row.id)?.pending)return;
  const existing=this.#followupPumps.get(root);if(existing){existing.rerun=true;return;}
  const operation=this.#operation(this.#epoch),pump={operation,root,item:null,claim:null,turnId:null,proof:null};this.#bind(operation,this.#rows.find(r=>r.rootThreadId===root));this.#operations.add(operation);this.#followupPumps.set(root,pump);
  const check=()=>{this.#check(operation.epoch,operation);if(this.#followupPumps.get(root)!==pump)throw Error('Follow-up dispatcher changed.');};
  pump.work=(async()=>{
   try{
    while(true){
     check();if(pump.paused)return;const ledger=this.#followupLedger(),head=await ledger.head(root);check();if(!head)return;
     const prepared=await this.#serial(async()=>{
      await this.#load(operation);check();const {row,engine}=await this.#thread(root,true,operation.epoch,operation);check();
      const view=await ledger.inspect();if(view.blocked)throw Error(view.warning);const group=view.groups.find(g=>g.binding.rootThreadId===root),binding=await this.#followupBinding(row,operation);check();
      if(!group||!equal(binding,group.binding))throw Error('Follow-up owner, project or model binding changed before dispatch.');
      this.#pin(row,engine);return {row,engine,binding};
     });
     const {row,engine,binding}=prepared;
     const proof=await engine.followupIdle({threadId:root,cwd:binding.cwd,model:binding.model,modelProvider:{local:'saleh_local',cloud:'saleh_cloud'}[binding.provider]});check();
     if(!proof){await delay(1000,undefined,{signal:operation.controller.signal});continue;}
     pump.proof=proof;pump.item=head;pump.claim=null;pump.turnId=null;pump.dispatched=false;pump.binding=binding;
     try{await this.#handle({action:'send',threadId:root,...head.request},undefined,pump);}catch(error){if(!pump.claim&&['QUEUE_STALE','QUEUE_IDLE_CHANGED'].includes(error.code)){pump.item=null;continue;}throw error;}check();
     while(true){
      const idle=await engine.followupIdle({threadId:root,cwd:binding.cwd,model:binding.model,modelProvider:{local:'saleh_local',cloud:'saleh_cloud'}[binding.provider]},pump.turnId);check();
      if(idle){idle.check();await ledger.finish(head.id,pump.claim.id,{status:idle.status,turnId:pump.turnId,message:'Exact queued turn '+idle.status+'; tracked family and commands verified idle.'});pump.item=null;pump.claim=null;pump.turnId=null;this.#journal.push('coding/queue/updated',{threadId:root,rootThreadId:root});if(idle.status!=='completed')return;break;}
      await delay(1000,undefined,{signal:operation.controller.signal});
     }
    }
   }catch(error){
    if(pump.claim)try{await this.#followupLedger().finish(pump.item.id,pump.claim.id,{status:pump.dispatched?'unknown':'interrupted',turnId:pump.turnId,message:((pump.dispatched?'Queued turn outcome is unconfirmed; it will not be sent again automatically. ':'Follow-up interrupted before turn/start; its claim is retained and will not be retried. ')+error.message).slice(0,1600)});}catch{}
    if(!pump.paused)await this.#pauseFollowups(root).catch(()=>{});this.#journal.push('coding/queue/updated',{threadId:root,rootThreadId:root,message:error.message});
   }finally{if(this.#followupPumps.get(root)===pump)this.#followupPumps.delete(root);this.#release(operation);if(pump.rerun&&!operation.controller.signal.aborted&&operation.epoch===this.#epoch)this.#startFollowups(root);}
  })();
 }
 async handle(input,context){return this.#handle(input,context);}
 async #handle(input,context,followup=null){
  const origin=requestContext(context);
  if(input?.action==='start'&&Object.hasOwn(input,'executionMode')){if(!['native','vm'].includes(input.executionMode))throw Error('Invalid Coding execution mode.');const {executionMode,...request}=input;validateCodingRequest(request);}else input=validateCodingRequest(input);if(this.closed)return Promise.reject(Error('Coding owner coordinator is closed.'));
  if(input.action==='mcpOutcomes'){const {threadId}=input,work=Promise.resolve().then(()=>this.#outcomes(threadId));this.#inspections.add(work);return work.finally(()=>this.#inspections.delete(work));}
  if(input.action==='terminalResults'){const work=Promise.resolve().then(()=>this.#terminalResults(input));this.#inspections.add(work);return work.finally(()=>this.#inspections.delete(work));}
  if(this.#stopping&&!['status','events','approvalInfo','terminalSnapshot','terminalStop','interrupt','interruptFamily'].includes(input.action)&&!(input.action==='approval'&&input.decision==='decline'))throw Error('Coding owners are stopping; wait for Stop to finish.');
  if(input.action==='reloadProviders')return Promise.reject(Error('This coordinator route requires pending owner integration.'));
  if(['interrupt','interruptFamily'].includes(input.action)){
   const row=this.#rows.find(r=>r.threads.includes(input.threadId)||this.#live.get(r.id)?.engine?.threadInfo.has(input.threadId));
   if(row){if(input.action==='interruptFamily'&&row.rootThreadId===input.threadId)return this.#requestOwnerStop(row);if(input.action==='interrupt'){const engine=this.#live.get(row.id)?.engine;this.#pin(row,engine);engine.active(input.threadId,input.turnId);}this.#pauseFollowups(row.rootThreadId);}
  }
  const epoch=this.#epoch,operation=this.#operation(epoch,origin);operation.fork=input.action==='fork';operation.stopRequest=input.action==='interruptFamily';operation.snapshotPoll=input.action==='status'||input.action==='events';
  if(operation.stopRequest)this.#stopIntents.set(input.threadId,(this.#stopIntents.get(input.threadId)??0)+1);
  for(const row of this.#rows){const engine=this.#live.get(row.id)?.engine;if(row.threads.includes(input.threadId)||engine?.threadInfo.has(input.threadId)||input.id&&(engine?.approvals.has(input.id)||engine?.questions.has(input.id))||input.processId&&(engine?.terminals.has(input.processId)||engine?.terminalHistory.has(input.processId)))operation.owners.add(row.id);}
  this.#operations.add(operation);
  // Snapshots verify and persist ownership on the mutation queue. Defer a poll
  // instead of waiting through startup or exposing a partial/unverified snapshot.
  if(input.action==='events'&&!this.#stopping&&this.#queuePending){
   try{this.#check(epoch,operation);const after=input.after??0;if(!Number.isSafeInteger(after)||after<0||after>this.#journal.sequence)throw Error('Invalid event cursor.');return {deferred:true};}
   finally{this.#release(operation);}
  }
  const dispatch=()=>this.#serial(async()=>{
   await this.#load(operation);this.#check(epoch,operation);
   if(this.#engineOptions.fullAccess&&(['start','fork','send','steer','review','answer','terminalStart','terminalWrite','terminalInput','terminalResize'].includes(input.action)||input.action==='approval'&&input.decision==='accept')&&await this.#uncertain('/',null,true))throw Error('Full Access is unavailable while any retained Coding owner needs recovery. Saved history remains readable.');
   this.#check(epoch,operation);
   if(!READ.has(input.action)&&!['status','events','list'].includes(input.action))this.#quarantineFence(this.#rows.find(row=>row.threads.includes(input.threadId)));
   if(operation.stopRequest){const row=this.#rows.find(r=>r.rootThreadId===input.threadId);if(row)return this.#requestOwnerStop(row);}
   if(input.action==='status')return this.#status();
   if(input.action==='events'){if(this.#rows.some(r=>r.state!=='ready'&&!(this.#coldCreating.has(r)&&r.state==='creating'&&r.generation?.nativeOpen===false&&r.generation.executorClosed===true&&(!r.fork?.worker||r.fork.worker.closed===true)&&!this.#live.has(r.id))))throw Error('Unresolved root creation blocks event exposure.');await this.#legacyOwner(epoch,operation);for(const [owner,live] of this.#live)if(live.engine)await this.#remember(this.#rows.find(r=>r.id===owner),live.engine);this.#captureControls();return this.#journal.read(input.after??0);}
   if(this.#legacyUncertain()&&!READ.has(input.action)&&input.action!=='list')throw Error('Legacy execution writers are unverified; only saved history is available until adoption.');
   if(this.#authority.projectMutation&&!CONTROL.has(input.action))throw busy();
   if(['providerBindingInfo','bindProvider'].includes(input.action))return this.#providerBinding(input,epoch,operation);
   if(input.action==='start')return this.#create(input,epoch,operation);
   if(input.action==='fork')return this.#fork(input,epoch,operation);
   if(input.action==='list')return this.#list(input,epoch,operation);
   let row,engine,legacy,creation;
   if(input.id||input.processId){const key=(input.action==='answer'?'question:':input.id?'approval:':'terminal:')+(input.id??input.processId),cap=this.#captureControls().get(key);if(!cap)throw Error('Expired or unknown coding capability.');row=this.#rows.find(r=>r.id===cap.owner);engine=cap.engine;this.#bind(operation,row);await this.#verifyHome(row);}
   else if(CONTROL.has(input.action)){row=this.#rows.find(r=>r.threads.includes(input.threadId));engine=row&&this.#live.get(row.id)?.engine;if(!engine||engine.closed||engine.historyOnly||engine.processLife!==this.#live.get(row.id).life||engine.epoch!==this.#live.get(row.id).epoch)throw Error('No live owner for this control; capabilities are not restored.');}
   else ({row,engine,legacy,creation}=await this.#thread(input.threadId,!READ.has(input.action),epoch,operation));
   this.#bind(operation,row);this.#check(epoch,operation);if(row&&!READ.has(input.action))this.#quarantineFence(row);if(legacy)this.#pinLegacy(legacy);else this.#pin(row,engine);
   if(creation){if(input.action==='historyPage'){if(input.cursor)throw Error('This saved creation record has no history pages.');return {threadId:input.threadId,pageCursor:null,turn:null,nextCursor:null,truncated:false,historySource:'creation-receipt'};}if(input.action==='readImage')throw Error('This saved creation record has no images.');if(input.cursor)throw Error('A saved creation record has no family pages.');const base={executionMode:row.executionMode??'vm',historyOnly:true,historySource:'creation-receipt',nativeHistoryAvailable:false,cursor:creation.cursor};return input.action==='read'?{...base,thread:creation.thread}:{...base,rootThreadId:row.rootThreadId,root:creation.thread,threads:[],nextCursor:null,stopping:false,stoppingTargets:[],truncated:false};}
   if(!followup&&['send','review','terminalStart'].includes(input.action)&&await this.#followupPrecedence(row.rootThreadId))throw Error('Queued follow-ups have precedence in this chat. Pause the queue or use Steer for the active turn.');
   if(row&&(!READ.has(input.action)&&!CONTROL.has(input.action)||['terminalWrite','terminalInput','terminalResize'].includes(input.action)||input.action==='approval'&&input.decision==='accept')){if(this.#hostGitFailures.has(row.id))throw this.#hostGitFailures.get(row.id);await this.#executionMCP(row);this.#check(epoch,operation);this.#pin(row,engine);}
   // Direct terminals do not materialize a chat; observed turns below consume its receipt.
   if(row&&['send','steer','review','rename','archive','unarchive'].includes(input.action)){await this.#invalidateCreation(row);this.#check(epoch,operation);this.#pin(row,engine);}
   let hooks;
   if(followup){
    const live=this.#live.get(row.id),life=live.life,generation=row.generation.id,home=structuredClone(row.home);
    const receipt=()=>{if(this.#live.get(row.id)!==live||live.engine!==engine||live.life!==life||row.generation.id!==generation||!equal(row.home,home))throw Error('Queued receipt owner or generation changed.');};
    const check=()=>{this.#check(epoch,operation);this.#check(followup.operation.epoch,followup.operation);receipt();this.#pin(row,engine);if(this.#followupPumps.get(row.rootThreadId)!==followup||input.action!=='send'||input.threadId!==row.rootThreadId)throw Error('Invalid private queued dispatch context.');};
    const idle=()=>{try{followup.proof.check();}catch(error){if(!followup.claim&&error.code==='PROJECT_BUSY')error.code='QUEUE_IDLE_CHANGED';throw error;}};
    hooks={check:()=>{check();if(followup.paused)throw Error('Follow-up dispatch was paused before turn/start.');idle();followup.dispatched=true;},beforeStart:async()=>{check();idle();if(!equal(await this.#followupBinding(row,operation),followup.binding))throw Error('Follow-up binding changed before its claim.');check();idle();followup.claim=await this.#followupLedger().claim(followup.item.id,followup.item.revision,{generation});check();idle();},onTurn:async turnId=>{receipt();followup.turnId=turnId;await this.#followupLedger().acknowledge(followup.item.id,followup.claim.id,turnId);}};
   }
   const result=await engine.handle(input,input.action==='answer'?()=>{this.#check(epoch,operation);this.#pin(row,engine);}:undefined,hooks);
   if(legacy){for(const t of result.threads??[]){this.#pinLegacy(legacy);await engine.resolveFamily(t.id);this.#check(epoch,operation);}this.#legacyCollision(legacy);this.#check(epoch,operation);return {...legacyView(result),...(result.thread?{thread:legacyView(result.thread)}:{}),...(result.root?{root:legacyView(result.root)}:{}),...(result.threads?{threads:result.threads.map(legacyView)}:{})};}
   if(row.handoff){
    if(!this.#handoffHistoryReadable(row)||!engine.historyOnly||result.rootThreadId!==undefined&&result.rootThreadId!==row.rootThreadId)throw handoffPending();
    for(const thread of [result.thread,result.root,...(result.threads??[])].filter(Boolean)){
     if(!row.threads.includes(thread.id))throw handoffPending();
     const verified=await engine.resolveFamily(thread.id);this.#check(epoch,operation);this.#pin(row,engine);
     const parent=value=>value.parentThreadId??value.source?.subAgent?.thread_spawn?.parent_thread_id??null;
     if(verified.root.id!==row.rootThreadId||verified.root.cwd!==row.cwd||['cwd','model','modelProvider'].some(key=>thread[key]!==verified.thread[key])||parent(thread)!==parent(verified.thread))throw handoffPending();
    }
   }
   if(!row.handoff&&(result.thread?.turns?.length||result.root?.turns?.length||result.threads?.some(t=>t.turns?.length)))await this.#invalidateCreation(row);
   await this.#remember(row,engine);this.#captureControls();this.#check(epoch,operation);return ownerResult(row,result);
  });
  // Keep ordinary requests in admission order; a separate housekeeping queue
  // would let a later Stop commit overtake an already admitted read.
  const work=this.#loaded&&!this.#loading&&!this.#rows.some(row=>row.handoff?.commit&&!this.#live.has(row.id))?dispatch():this.#finalizeHandoffs(epoch,operation).then(dispatch);
  return work.finally(()=>{this.#release(operation);if(operation.stopRequest){const count=this.#stopIntents.get(input.threadId)-1;if(count)this.#stopIntents.set(input.threadId,count);else this.#stopIntents.delete(input.threadId);}});
 }
 #diskContext(allocation){return {catalog:{path:this.dataDir,identity:this.#directory},runtime:this.#executor.runtime,allocation,owner:this.#rows.find(r=>r.id===allocation.ownerId&&r.generation?.id===allocation.generation),nativeHelper:this.#engineOptions.nativeHelper};}
 #failedDiskEligible(row){const a=this.#executor?.allocations.find(a=>a.ownerId===row?.id&&a.generation===row.generation?.id);if(!a||!this.#coldCreating.has(row)||!isFailedDiskOwner(row,a)||a.diskRelease||this.#live.has(row.id)||this.#selectedStops.get(row.id)?.pending)throw Error('This failed startup has no verified closed, never-executing disk to review.');return a;}
 #diskEligible(row){
  const a=this.#executor?.allocations.find(a=>a.ownerId===row?.id&&a.generation===row.generation?.id);
  if(!row||row.state!=='ready'||!a?.identity||!a.closed||a.diskRelease||row.generation.nativeOpen||!row.generation.executorClosed||row.generation.execution!=='revoked'||this.#live.has(row.id)||this.#selectedStops.get(row.id)?.pending||this.#stopIntents.has(row.rootThreadId))throw Error('Stop this chat and confirm successful execution retirement before reclaiming its latest guest disk. Failed or superseded generations require separate inspection.');
  return a;
 }
 // Signed native maintenance only. No supplied path, byte credit or closure claim.
 handleDisk(input,context){
  const origin=requestContext(context),action=input?.action;
  shape(input,action==='listFailed'?['action']:action==='prepareFailed'?['action','ownerId','generation']:action==='prepare'?['action','threadId']:action==='execute'?['action','id','reviewed']:['action','id']);
  if(!['listFailed','prepareFailed','prepare','inspect','execute','cancel'].includes(action)||(action==='prepare'?!id(input.threadId):action==='prepareFailed'?!uuid(input.ownerId)||!uuid(input.generation):action!=='listFailed'&&!uuid(input.id)))throw Error('Invalid guest disk request.');
  if(action==='cancel'){this.#diskReviews.delete(input.id);return Promise.resolve({cancelled:true});}
  // Validated snapshot polls stay ahead of maintenance on the same serial queue.
  if(this.closed||this.#stopping||[...this.#operations].some(operation=>operation.snapshotPoll!==true)||this.#allocating.size||this.#exitUnconfirmed(true)||this.#authority.projectMutation)throw busy();
  const epoch=this.#epoch,operation=this.#operation(epoch,origin);this.#operations.add(operation);
  return this.#serial(async()=>{
   let lease,attempt=false,inspecting=false;
   // Recheck through dispatch; the admitted helper then owns the native fence.
   const check=()=>{this.#check(epoch,operation);lease?.check();if(!attempt&&!inspecting&&this.#exitUnconfirmed(true))throw busy();};
   try{
    await this.#load(operation);check();await this.#admission(false);check();
    for(const [key,value] of this.#diskReviews)if(value.expiresAt<=Date.now()||value.epoch!==epoch)this.#diskReviews.delete(key);
    if(action==='listFailed')return {candidates:this.#rows.flatMap(row=>{try{this.#failedDiskEligible(row);return [{ownerId:row.id,generation:row.generation.id,cwd:row.cwd}];}catch{return [];}})};
    const preparing=action==='prepare'||action==='prepareFailed',saved=preparing?null:this.#diskReviews.get(input.id);
    if(!preparing&&!saved)throw Error('Guest disk review expired, cancelled or consumed.');
    const failed=action==='prepareFailed'||['failed-provisioning','empty-allocation'].includes(saved?.review.snapshot.basis.kind);
    const row=this.#rows.find(r=>action==='prepare'?r.threads.includes(input.threadId):action==='prepareFailed'?r.id===input.ownerId&&r.generation?.id===input.generation:r.id===saved.review.ownerId);this.#bind(operation,row);
    const fresh=()=>{if(saved&&saved.expiresAt<=Date.now()){this.#diskReviews.delete(input.id);throw Error('Guest storage review expired before dispatch.');}};fresh();
    if(!failed){
     const live=this.#live.get(row?.id),generation=row?.generation?.id,a=this.#executor?.allocations.find(a=>a.ownerId===row?.id&&a.generation===generation);
     // Saved history can reopen a retired owner's native reader between review
     // steps. Drain only that exact reader before the project lease captures it.
     if(live?.engine?.historyOnly===true&&live.executorExpected===false&&live.resource===null&&live.reservation===null&&live.setup===null&&!live.allocation&&!live.retire&&!live.startup&&row.state==='ready'&&row.generation.nativeOpen===true&&row.generation.executorClosed===true&&row.generation.execution==='revoked'&&a?.identity&&a.closed===true&&!a.diskRelease){
      if(saved&&saved.review.generation!==generation)throw Error('Selected guest allocation generation changed after review.');
      this.#pin(row,live.engine);await this.#retire(row,live);check();fresh();
      if(row.generation?.id!==generation||this.#live.has(row.id))throw Error('Selected guest reader ownership changed during closure.');
     }
    }
    const eligible=()=>failed?this.#failedDiskEligible(row):this.#diskEligible(row),a=eligible();
    lease=await this.#authority.reserveProjectMutation(async()=>[row.cwd]);check();
    const current=()=>{check();if(!attempt)fresh();if(eligible()!==a)throw Error('Selected guest allocation changed.');};current();
    const snapshot=await inspectRetiredDisk(this.#diskContext(a),failed?{kind:saved?.review.snapshot.basis.kind??'failed-provisioning',detectEmpty:preparing}:{});current();
    const empty=snapshot.basis.kind==='empty-allocation';
    if(failed){
     inspecting=true;let inspected;
     try{inspected=await this.#forkFiles(empty?'inspectEmptyAllocation':'inspectFailedGuestDisk',empty?snapshot.request:{request:snapshot.request,failed:snapshot.basis.failed},{signal:operation.controller.signal,check:current});}finally{inspecting=false;}
     const expected=empty?{version:1,ownerId:row.id,generation:a.generation,empty:true,physicalClosed:true,descriptorsClosed:true}:{version:1,ownerId:row.id,generation:a.generation,guestId:snapshot.basis.guestId,physicalClosed:true};
     current();if(!equal(inspected,expected))throw Error('Failed guest physical inspection is unavailable.');
     if(!equal(snapshot,await inspectRetiredDisk(this.#diskContext(a),{kind:snapshot.basis.kind})))throw Error('Failed guest changed during physical inspection.');current();
    }
    if(preparing){
     if(this.#diskReviews.size>=LIMIT)throw Error('Retained disk review limit reached.');
     const review=freeze({id:randomUUID(),ownerId:row.id,generation:a.generation,cwd:row.cwd,...empty?{kind:'empty-allocation',logicalBytes:String(a.resources.diskBytes)}:{guestId:snapshot.basis.guestId,logicalBytes:snapshot.request.disk.size,allocatedBytes:String(BigInt(snapshot.request.disk.blocks)*512n)},expiresAt:Date.now()+300000,snapshot});
     for(const [key,value] of this.#diskReviews)if(value.review.ownerId===row.id)this.#diskReviews.delete(key);
     this.#diskReviews.set(review.id,{epoch,expiresAt:review.expiresAt,review});return structuredClone(review);
    }
    if(!equal(saved.review.snapshot,snapshot)||saved.review.generation!==a.generation)throw Error('Guest disk changed after review; no disposal was started.');
    if(action==='inspect')return structuredClone(saved.review);
    if(!equal(input.reviewed,saved.review))throw Error('Exact native guest disk review is required.');
    this.#diskReviews.delete(input.id);current();attempt=true;
    let intent,closed=false;
    const result=await this.#forkFiles(empty?'releaseEmptyAllocation':failed?'disposeFailedGuestDisk':'disposeGuestDisk',failed&&!empty?{request:snapshot.request,failed:snapshot.basis.failed}:snapshot.request,{signal:operation.controller.signal,check:current,
     record:async worker=>{current();fresh();intent=await recordDiskReleaseIntent(this.#diskContext(a),saved.review,worker);current();fresh();},
     closed:async()=>{closed=true;}});
    current();if(!closed||!intent)throw Error('Original disk disposal worker or durable intent closure is unconfirmed.');
    const released=await completeDiskRelease(this.#diskContext(a),saved.review,intent,result);current();
    // No accounting credit until final receipt AND catalog commit succeed.
    await verifyDiskRelease({...this.#diskContext(a),allocation:{...a,diskRelease:released}});check();
    // A failed/uncertain save sticks the coordinator blocked and retains its
    // lease. Never roll back a pointer whose rename may already have committed.
    a.diskRelease=released;await this.#save();check();if(failed)this.#verifiedFailedReleases.set(a,JSON.stringify(released));
    if(empty)return {released:true,kind:'empty-allocation',ownerId:row.id,generation:a.generation,releasedBytes:saved.review.logicalBytes,message:'The unused storage reservation was released. All files and failure records remain; this failed owner stays unusable. No guest disk was deleted.'};
    return {released:true,ownerId:row.id,generation:a.generation,guestId:saved.review.guestId,releasedBytes:saved.review.logicalBytes,message:failed?'The reviewed failed-startup guest disk was discarded. Original failure records and host project files remain; execution stays unrevoked and this owner cannot be reused. Its storage reservation is released; physical free space may differ.':'The reviewed retired guest disk was discarded. Saved chats and host project files were retained. Its storage reservation is released; physical free space may differ.'};
   }catch(error){if(attempt)throw this.#block(error);throw error;}
   finally{lease?.release();}
  }).finally(()=>this.#release(operation));
 }
 #coldMutationRow(row){
  const a=this.#executor?.allocations.find(a=>a.ownerId===row.id&&a.generation===row.generation?.id);
  return this.#coldCreating.has(row)&&row.state==='creating'&&row.rootThreadId===null&&!row.threads.length&&row.fork===null&&row.generation?.nativeOpen===false&&row.generation.executorClosed===true&&!this.#live.has(row.id)&&!!a?.identity&&a.closed===true&&(a.diskRelease===null||this.#verifiedFailedReleases.get(a)===JSON.stringify(a.diskRelease))&&this.#executorPolicy?.runtimeDir===this.#executor.runtime.path;
 }
 #failedStartupBinding(row,model){
  const a=this.#executor?.allocations.find(a=>a.ownerId===row?.id&&a.generation===row.generation?.id);
  if(!a||!isFailedDiskOwner(row,a)||!this.#coldMutationRow(row)||this.#selectedStops.get(row.id)?.pending)throw Error('This startup has no verified closed original to copy.');
  return {ownerId:row.id,generation:row.generation.id,cwd:row.cwd,model,home:structuredClone(row.home),ownerSHA256:hash(JSON.stringify(row)),allocationSHA256:hash(JSON.stringify(a))};
 }
 // Signed native continuation only. This leases a read of the exact failed
 // original; every write goes to exclusive new output. Original fences remain.
 handleRecovery(input,context){
  const action=input?.action,origin=requestContext(context);
  shape(input,action==='list'?['action']:action==='prepare'?['action','ownerId','generation','model']:action==='open'?['action','ownerId','generation','model','id']:['action','id']);
  if(!['list','prepare','create','open','cancel'].includes(action)||!['list','prepare'].includes(action)&&!uuid(input.id)||['prepare','open'].includes(action)&&(!uuid(input.ownerId)||!uuid(input.generation)))throw Error('Invalid failed startup continuation request.');
  const copies=this.#startupCopies??=new FailedStartupCopies({dataDir:this.dataDir,nativeHelper:this.#engineOptions.nativeHelper,spawnProcess:this.#engineOptions.spawnProcess,nativeFiles:(...args)=>this.#forkFiles(...args)});
  if(action==='cancel')return Promise.resolve(copies.cancel(input.id));
  if(this.closed||this.#stopping||[...this.#operations].some(o=>o.snapshotPoll!==true)||this.#allocating.size||this.#exitUnconfirmed(true)||this.#authority.projectMutation)throw busy();
  const epoch=this.#epoch,operation=this.#operation(epoch,origin);this.#operations.add(operation);
  return this.#serial(async()=>{
   let lease;
   const check=()=>{this.#check(epoch,operation);lease?.check();};
   try{
    await this.#load(operation);check();await this.#admission(false);check();
    if(action==='list')return await copies.run({check,signal:operation.controller.signal},async()=>{const candidates=[];for(const row of this.#rows){try{this.#failedStartupBinding(row,null);}catch{continue;}candidates.push({ownerId:row.id,generation:row.generation.id,cwd:row.cwd,continuations:await copies.list({ownerId:row.id,generation:row.generation.id,cwd:row.cwd})});}return {candidates};});
    const saved=action==='create'?copies.plans.get(input.id)?.binding:null;
    if(action==='create'&&!saved)throw Error('Failed startup review expired, cancelled or consumed.');
    const model=this.#authority.profile('local',saved?.model??input.model).model,row=this.#rows.find(row=>row.id===(saved?.ownerId??input.ownerId)&&row.generation?.id===(saved?.generation??input.generation)),binding=this.#failedStartupBinding(row,model);this.#bind(operation,row);
    if(saved&&!equal(saved,binding))throw Error('Failed startup owner or model changed after review.');
    const fold=p=>p.normalize('NFD').toUpperCase().toLowerCase(),conflict=(a,b)=>overlap(fold(a),fold(b));
    for(const root of [this.dataDir,copies.parent,this.#executor.runtime.path])if(conflict(row.cwd,root))throw Error('Original project overlaps protected application storage.');
    const inspector=new ManagedWorktrees({dataDir:this.dataDir,nativeHelper:null});inspector.assertOpenEpoch=check;
    const original=await inspector.handoffRepository(row.cwd,inspector.epoch),related=this.#rows.filter(other=>other!==row&&(this.#live.has(other.id)||other.handoff));
    for(const root of [this.dataDir,copies.parent,this.#executor.runtime.path])if(original.some(d=>conflict(d.canonical,root)))throw Error('Original Git metadata overlaps protected application storage.');
    for(const other of related){
     const paths=other.handoff?[other.cwd,other.handoff.context.source,other.handoff.context.destination]:[other.cwd];
     for(const path of paths){if(conflict(path,row.cwd))throw busy();const dirs=await inspector.handoffRepository(path,inspector.epoch,false);if(dirs.some(d=>original.some(s=>same(s.identity,d.identity)||conflict(s.canonical,d.canonical))))throw busy();}
    }
    if(this.#legacyLive&&[...this.#legacyLive.engine.threadInfo.values()].some(t=>t.cwd&&conflict(t.cwd,row.cwd)))throw busy();
    // Empty scope authenticates cold host/allocation evidence without granting
    // mutation of any cold project. The separate real lease fences its readers.
    const coldProof=await this.#mutationScope([],check),encoded=JSON.stringify(binding);
    const outputScope=async()=>{
     check();const paths=[copies.parent,copies.artifacts],protectedRows=this.#rows.filter(r=>this.#coldMutationRow(r)||this.#quarantined(r)||this.#live.has(r.id)||r.handoff),continuations=new Set();
     for(const r of this.#rows)if(await copies.isContinuation(r))continuations.add(r.id);
     for(const path of paths){
      for(const r of this.#rows)for(const protectedPath of [r.cwd,...r.handoff?[r.handoff.context.source,r.handoff.context.destination]:[]])if(conflict(path,protectedPath)&&!(path===copies.parent&&continuations.has(r.id)&&protectedPath===r.cwd))throw Error('Recovery output overlaps a protected project.');
      for(const r of protectedRows){const dirs=await inspector.handoffRepository(r.cwd,inspector.epoch,false);if(dirs.some(d=>conflict(path,d.canonical)&&!(path===copies.parent&&continuations.has(r.id)&&(d.canonical===r.cwd||d.canonical.startsWith(r.cwd+'/')))))throw Error('Recovery output overlaps protected Git metadata.');}
      let ancestor=path;while(!await optional(ancestor)){const next=dirname(ancestor);if(next===ancestor)throw Error('Recovery output parent is unavailable.');ancestor=next;}
      await this.#dir(ancestor);if((await inspector.handoffRepository(ancestor,inspector.epoch,false)).length)throw Error('Recovery output is inside an existing Git project.');check();
     }
    };
    const recheck=async()=>{check();await this.#checkDisk();await this.#verifyHome(row);await coldProof?.();await outputScope();check();if(JSON.stringify(this.#failedStartupBinding(row,model))!==encoded)throw Error('Failed startup evidence changed.');};
    await recheck();
    const roots=await copies.run({check,signal:operation.controller.signal,binding,recheck},()=>copies.roots());check();
    lease=await this.#authority.reserveProjectMutation(async()=>{await recheck();return [row.cwd,roots.parent.path,roots.artifacts.path];},recheck);await recheck();
    return await copies.run({check,signal:operation.controller.signal,binding,recheck},async()=>{
     if(action==='prepare')return copies.prepare(binding);
     if(action==='create')return copies.create(input.id);
     const opening=await copies.prepareOpen(binding,input.id);await recheck();lease.release();lease=null;
     const result=await this.#create({action:'start',cwd:opening.cwd,provider:'local',executionMode:'native',model},epoch,operation);
     await opening.complete(result.thread);check();return {...result,copyId:input.id};
    });
   }catch(error){if(copies.blocked){this.#block(Error('Recovery worker settlement is unconfirmed; project and coordinator leases retained. '+error.message,{cause:error}));lease=null;}throw error;}
   finally{lease?.release();}
  }).finally(()=>this.#release(operation));
 }
 async #mutationScope(paths,check,quarantineOnly=false,requireGit=true,storageRoot=null){
  const cold=quarantineOnly?[]:this.#rows.filter(row=>this.#coldMutationRow(row)),quarantined=this.#rows.filter(row=>this.#quarantined(row));if(!cold.length&&!quarantined.length&&!storageRoot)return null;
  // No committed root means no workspace preparation/publication. Keep its
  // execution fence and verify the recorded host root plus current Git scope.
  const inspector=new ManagedWorktrees({dataDir:this.dataDir,nativeHelper:null});inspector.assertOpenEpoch=check;
  const checks=[],proofs=[],scopes=[];let coldAdoption=null;
  if(storageRoot){if(!paths.includes(storageRoot))throw busy();const original=await this.#dir(storageRoot);check();checks.push(async()=>{await this.#dir(storageRoot,original);check();});}
  const metadata=async(cwd,required=true)=>{await this.#authority.cwd(cwd);check();const dirs=await inspector.handoffRepository(cwd,inspector.epoch,false,recheck=>checks.push(recheck));check();if(required&&!dirs.length)throw busy();return dirs;};
  if(cold.length){await this.#runtime(this.#executor.runtime,this.#executor.allocations);check();}
  for(const row of cold){
   const a=this.#executor.allocations.find(a=>a.ownerId===row.id&&a.generation===row.generation.id),path=join(this.#executor.runtime.path,a.ownerId+'-'+a.generation,'allocation.json'),file=await this.#file(path);check();if(!file)throw busy();
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.bytes));shape(value,['version','ownerId','generation','cwd','hostIdentity','root','resources','account','bundle','restartAllowed']);shape(value.hostIdentity,['dev','ino','mode','uid']);
   if(value.version!==(this.#durableIdentity?2:1)||value.ownerId!==row.id||value.generation!==row.generation.id||value.cwd!==row.cwd||!equal(value.resources,a.resources)||value.restartAllowed!==false)throw busy();
   let firstHost=null,adoptedHost=null;
   const host=async()=>{
    await this.#authority.cwd(row.cwd);const s=await lstat(row.cwd,{bigint:true});check();const current={...stamp(s),mode:Number(s.mode),uid:Number(s.uid)};
    if(!s.isDirectory()||s.isSymbolicLink()||firstHost&&!equal(firstHost,current))throw busy();firstHost??=current;
    const adoptedRequired=this.#legacyAdmission?.coldGitHostAdoptionRequired(row.id)===true;
    if(equal(value.hostIdentity,current)&&!adoptedRequired)return;
    if(!adoptedRequired||!this.#durableIdentity||!this.#legacyAdmission||!['ino','mode','uid'].every(k=>value.hostIdentity[k]===current[k]))throw busy();
    coldAdoption??=await this.#legacyAdmission.prepareColdGitHosts({dataDir:this.dataDir,checkpoint:check});check();
    adoptedHost??=await coldAdoption.host({ownerId:row.id,generation:row.generation.id,cwd:row.cwd,allocationDirectory:{path:join(this.#executor.runtime.path,a.ownerId+'-'+a.generation),identity:a.identity},allocationSHA256:file.hash,historicalHostIdentity:value.hostIdentity});check();
    await adoptedHost();check();const after=await lstat(row.cwd,{bigint:true});check();if(!equal(firstHost,{...stamp(after),mode:Number(after.mode),uid:Number(after.uid)}))throw busy();
   };
   await host();checks.push(host);proofs.push({path,file});scopes.push({row,dirs:await metadata(row.cwd)});
  }
  // Quarantine is a separate preserved native proof; never masquerade as a retired VM.
  for(const row of quarantined){
   const proof=this.#quarantines.get(row.id),host=async()=>{check();if(!this.#quarantined(row))throw busy();await this.#authority.cwd(row.cwd);check();const s=await lstat(row.cwd,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||!sameFilesystemIdentity(await readFilesystemIdentity({path:row.cwd,nativeHelper:this.#engineOptions.nativeHelper}),proof.project.identity))throw busy();check();};
   await host();checks.push(host);scopes.push({row,dirs:await metadata(row.cwd,false)});
  }
  const fold=path=>path.normalize('NFD').toUpperCase().toLowerCase(),conflict=(a,b)=>overlap(fold(a),fold(b));
  for(const path of paths){const dirs=await metadata(path,requireGit&&(cold.length>0||storageRoot!==null)&&path!==storageRoot);if(path===storageRoot&&dirs.length)throw busy();for(const scope of scopes)if(conflict(path,scope.row.cwd)||scope.dirs.some(a=>conflict(a.canonical,path))||dirs.some(b=>conflict(b.canonical,scope.row.cwd)||scope.dirs.some(a=>conflict(a.canonical,b.canonical)||same(a.identity,b.identity))))throw busy();}
  return async()=>{
   check();if(cold.some(row=>!this.#coldMutationRow(row))||quarantined.some(row=>!this.#quarantined(row)))throw busy();if(cold.length)await this.#runtime(this.#executor.runtime,this.#executor.allocations);check();
   for(const {path,file} of proofs){const now=await this.#file(path);check();if(!now||now.hash!==file.hash||!same(now.identity,file.identity))throw busy();}
   for(const recheck of checks){await recheck();check();}await this.#checkDisk();check();
  };
 }
 async assertUnconfinedAccess(cwd){
  const epoch=this.#epoch;await this.#serial(async()=>{await this.#load();this.#check(epoch);
   if(cwd!==undefined&&!absolutePath(cwd))throw Error('Invalid unconfined project directory.');
   if(await this.#uncertain(cwd??'/',null,cwd===undefined)||this.#allocating.size||[...this.#selectedStops.values()].some(ticket=>ticket.pending||ticket.error))throw Error('Full Access is unavailable while a retained Coding owner needs recovery or is stopping.');
   this.#check(epoch);
  });
 }
 async reserveProjectMutation(resolvePaths,policy=null,recovery=null){
  if(policy&&(Object.keys(policy).sort().join()!=='kind,target'||typeof policy.kind!=='string'||typeof policy.target!=='function'))throw Error('Invalid trusted Git mutation policy.');
  if(policy)policy={kind:policy.kind,target:policy.target};
  const storageRoot=['archiveWorktree','restoreWorktree'].includes(policy?.kind)?join(this.dataDir,'Worktrees'):null;
  // Ordinary reviewed Git and fresh detached creation keep their own conflict
  // checks and owner lease. They do not grant retained recovery authority.
  if(this.#managedMutationBlocked&&(recovery||!policy||!(isReviewedGitOperation(policy.kind)||policy.kind==='createWorktree')))throw Error('Retained worktree mutations remain blocked for this Full Access boot. Reviewed Git operations and fresh detached checkout creation remain available after verification. For retained recovery, prepare In-place Recovery in the app menu, then restart the Mac; Full Access stays selected while unrestricted tools are held.');
  if(recovery&&(this.#handoffPrepared.get(recovery.row.rootThreadId)!==recovery||!recovery.recovery||!equal(recovery.row.handoff?.context,recovery.context)))throw handoffPending();
  // Snapshot polls drain on the serial queue below; they do not own project mutation.
  if(this.closed||this.#stopping||[...this.#operations].some(operation=>operation.snapshotPoll!==true)||this.#allocating.size||this.#exitUnconfirmed(true))throw busy();const epoch=this.#epoch;
  const check=()=>{this.#check(epoch);if(this.#stopping||this.#allocating.size||this.#exitUnconfirmed(true)||[...this.#setups.values()].some(s=>s.cleanup!=='closed')||this.#executor?.allocations.some(a=>!a.closed&&!this.#rows.some(row=>row.id===a.ownerId&&row.generation?.id===a.generation&&this.#observing(row))))throw busy();};
  let paths,affected,scopeCheck;
  const lease=await this.#authority.reserveProjectMutation(async()=>{
   await this.#serial(()=>this.#load());check();paths=await resolvePaths();check();
   if(!Array.isArray(paths)||!paths.length||paths.length>128||paths.some(path=>!absolutePath(path)))throw busy();for(const path of paths){if(await this.#uncertain(path,recovery?.row))throw busy();check();}
   scopeCheck=await this.#mutationScope(paths,check,false,true,storageRoot);await scopeCheck?.();
   const liveRows=this.#rows.map(row=>({row,live:this.#live.get(row.id)})).filter(({live})=>live?.resource?.hasWorkspace&&!live.engine?.historyOnly);
   // A retained guest may have left the current worktree registration since its
   // import. Resolve common-repository identity as well as checkout overlap.
   if(liveRows.length){
    const inspector=new GitWorkflow({dataDir:this.dataDir,assertProject:this.#engineOptions.assertProject});inspector.check=()=>this.#check(epoch);
    const common=new Set();for(const path of paths.filter(path=>path!==storageRoot)){const repository=await inspector.repository(path,inspector.epoch);this.#check(epoch);common.add(repository.commonRepositoryId);}
    paths=[...new Set([...paths,...liveRows.filter(({live})=>common.has(live.resource.workspaceRepository?.commonRepositoryId)).map(({row})=>row.cwd)])];
   }
   affected=liveRows.filter(({row})=>paths.some(path=>overlap(path,row.cwd)));
   if(affected.length&&(!policy||!['stage','unstage'].includes(policy.kind)))throw Error('This host mutation cannot update an active isolated workspace. Stop its chat before changing branches or worktrees.');
   return paths;
  },async()=>{check();await scopeCheck?.();check();});
  try{
   const revalidateScope=lease.revalidateScope;
   lease.check();check();await revalidateScope();const target=policy?.target();if(policy&&(typeof target!=='string'||!paths.includes(target)||target===storageRoot))throw Error('Reviewed Git target differs from the shared project lease.');if(!affected.length)return lease;
   for(const {row,live} of affected)if(!this.#current(live)||typeof live.resource.hostGitOperation!=='function'||live.resource.workspaceRepository?.cwd!==row.cwd)throw Error('Live guest Git coordination is unavailable; no host mutation was admitted.');
   let used=false;
   return Object.freeze({release:lease.release,...(revalidateScope?{revalidateScope}:{}),coordinateGit:async({indexSHA256,indexTree,run})=>{
    if(used||!digest(indexSHA256)||! /^[a-f0-9]{40}$/.test(indexTree)||typeof run!=='function')throw Error('Invalid or consumed host Git coordination.');used=true;
    const operation=this.#operation(epoch);this.#operations.add(operation);
    const check=()=>{lease.check();this.#check(epoch,operation);for(const {row,live} of affected){this.#pin(row,live.engine);if(!this.#current(live)||this.#hostGitFailures.has(row.id))throw Error('Host Git owner lifetime changed or synchronization failed.');}};
    const invoke=async(entry,phase,request={})=>{const {row,live}=entry;check();return this.#publicationNative(row,live,{check,signal:AbortSignal.any([operation.controller.signal,live.controller.signal])},context=>live.resource.hostGitOperation(phase,Object.freeze({...context,threadId:row.rootThreadId,engine:live.engine,life:live.life}),request),null,null,true);};
    let answer,started=false;
    try{
     for(const {row} of affected)this.#bind(operation,row);
     check();await revalidateScope?.();check();const tickets=[];for(const entry of affected)tickets.push({entry,ticket:await invoke(entry,'prepare')});
     for(const {entry,ticket} of tickets)await invoke(entry,'verify',{ticket});
     check();await revalidateScope?.();check();started=true;answer=await run(operation.controller.signal);
     if(answer?.state!=='completed'||answer.cleanup==='unconfirmed')throw Error('Host Git operation did not confirm completion; isolated workspace remains fenced.');
     check();for(const {entry,ticket} of tickets)await invoke(entry,'refresh',{ticket,indexSHA256,indexTree,target:entry.row.cwd===target});check();
     return {...answer,synchronization:'complete'};
    }catch(error){
     const failure=Error('Isolated workspace synchronization failed. This chat remains blocked for inspection. '+error.message);
     for(const {row,live} of affected){this.#hostGitFailures.set(row.id,failure);live.engine.push('coding/error',{message:failure.message,turns:[],threadId:row.rootThreadId});}
     if(answer)return {...answer,synchronization:'failed',message:(answer.message??'Host Git outcome requires inspection.')+' '+failure.message};
     if(started)throw Error('Host Git outcome is unconfirmed. '+failure.message,{cause:error});throw failure;
    }finally{this.#release(operation);}
   }});
  }catch(error){lease.release();throw error;}
 }
 projectMutationInventory(){return this.#authority.projectMutationInventory();}
 async runScheduled(input={}){
  let {cwd,prompt,effort='none',signal,onClaim,onThread=async()=>{},onTurn=async()=>{}}=input;const executionMode=Object.hasOwn(input,'executionMode')?input.executionMode:'vm',expectedModel=this.#authority.profile('local',input.model).model;
  if(!['native','vm'].includes(executionMode))throw Error('Invalid scheduled execution mode.');
  validateCodingRequest({action:'start',cwd,model:expectedModel});validateCodingRequest({action:'send',threadId:'scheduled',text:prompt,effort});
  if(typeof onClaim!=='function'||typeof onThread!=='function'||typeof onTurn!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))throw Error('Invalid scheduled run.');
  if(this.closed||this.#stopping||this.#scheduled||this.#authority.projectMutation)throw busy();
  const epoch=this.#epoch,s=this.#operation(epoch);s.claimed=false;this.#scheduled=s;this.#operations.add(s);
  const abort=()=>s.controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const check=()=>{this.#check(epoch,s);if(s.controller.signal.aborted)throw Error('Scheduled work was interrupted.');};let execution;
  try{
   execution=await this.#serial(async()=>{
    await this.#load(s);check();cwd=await this.#authority.cwd(cwd);check();await this.#authority.assertProject(cwd);check();
    if(await this.#uncertain(cwd)||this.#projects.scheduled()||this.#authority.projectOccupied(cwd)||this.#authority.projectMutation)throw busy();
    check();
    const idle=await this.#projects.verifyIdle([cwd],check);check();idle();if(this.#authority.projectOccupied(cwd)||this.#projects.scheduled())throw busy();
    await this.#quarantineScope([cwd],check);check();await onClaim();s.claimed=true;check();
    const row=await this.#provision({cwd,provider:'local',executionMode},epoch,s);check();const engine=await this.#owner(row,true,epoch,s.controller.signal,s);check();this.#pin(row,engine);
    const live=this.#live.get(row.id),life=live.life,generation=row.generation.id;
    const receipt=()=>{if(this.#live.get(row.id)!==live||live.engine!==engine||live.life!==life||row.generation.id!==generation)throw this.#block(Error('Scheduled native receipt ownership changed.'));};
    const result=engine.runScheduled({cwd,prompt,effort,model:expectedModel,signal:s.controller.signal,
     onClaim:async()=>{check();this.#pin(row,engine);},
     onCreated:thread=>this.#serial(async()=>{receipt();await this.#commitRoot(row,thread,expectedModel);}),
     onThread:async threadId=>{check();this.#pin(row,engine);if(row.rootThreadId!==threadId)throw this.#block(Error('Scheduled chat identity changed.'));await onThread(threadId);check();this.#pin(row,engine);await this.#prepareResource(row,engine,epoch,s);},
     onDispatch:()=>this.#serial(async()=>{check();receipt();this.#pin(row,engine);await this.#invalidateCreation(row);check();this.#pin(row,engine);}),
     // Exact admitted turn receipts remain recordable during cancellation.
     onTurn:async turnId=>{receipt();await onTurn(turnId);}
    });
    return {result,settled:engine.scheduledDisposal};
   });
   return await execution.result;
  }catch(error){
   if(s.controller.signal.aborted||epoch!==this.#epoch)return {status:'interrupted',threadId:null,turnId:null,message:error.message};
   if(s.claimed)return {status:'failed',threadId:null,turnId:null,message:error.message};throw error;
  }finally{
   // ponytail: a scheduled body retains the global mutation gate; split startup
   // and running reservations if unrelated project mutation needs concurrency.
   const release=()=>{signal?.removeEventListener('abort',abort);this.#release(s);if(this.#scheduled===s)this.#scheduled=null;};
   if(execution)void execution.settled.then(release,error=>{this.#block(error);release();});else release();
  }
 }
 #handoffBinding(row){return {ownerId:row.id,home:structuredClone(row.home),rootThreadId:row.rootThreadId,generation:row.generation.id,executionMode:'native',model:row.model,provider:row.provider};}
 #handoffCheck(entry,operation){
  this.#check(entry.epoch,operation);const {row,engine}=entry;
  if(this.#handoffPrepared.get(row.rootThreadId)!==entry||!this.#rows.includes(row)||!nativeOwner(row)||row.state!=='ready'||row.generation?.id!==entry.generation||!sameBinding(row.home,entry.home)||(this.#ownerRevisions.get(row.id)??0)!==entry.revision)throw Error('Native handoff owner changed; prepare again.');
  this.#pin(row,engine);if(this.#live.get(row.id).life!==entry.life)throw Error('Native handoff process changed.');
  this.#handoffConflicts(row,entry.paths);
 }
 #handoffConflicts(row,paths){
  const fold=path=>path.normalize('NFD').toUpperCase().toLowerCase(),touch=cwd=>paths.some(path=>overlap(fold(path),fold(cwd)));
  if(this.#legacyLive&&[...this.#legacyLive.engine.threadInfo.values()].some(t=>t.cwd&&touch(t.cwd))||this.#rows.some(other=>other!==row&&(this.#live.has(other.id)&&touch(other.cwd)||other.handoff&&[other.handoff.context.source,other.handoff.context.destination].some(touch))))throw Error('Another live chat or retained handoff owns this checkout pair. Close its owner before moving this chat.');
 }
 async #finalizeHandoffs(epoch,operation){
  const pending=await this.#serial(async()=>{await this.#load(operation);this.#check(epoch,operation);return this.#rows.filter(row=>row.handoff?.commit&&!this.#live.has(row.id)).map(row=>({row,marker:structuredClone(row.handoff)}));});
  for(const {row,marker} of pending){
   if(!this.#handoffStatus)continue;this.#bind(operation,row);
   // External manager/ledger inspection must never run inside the catalog queue.
   const completed=await this.#handoffStatus(marker);this.#check(epoch,operation);if(completed!==true)continue;
   await this.#serial(async()=>{this.#check(epoch,operation);await this.#checkDisk();await this.#verifyHome(row);if(this.#live.has(row.id)||!equal(row.handoff,marker))throw handoffPending();delete row.handoff;await this.#save();this.#snapshots.clear();});
  }
 }
 async prepareHandoff(threadId){
  const epoch=this.#epoch,operation=this.#operation(epoch);this.#operations.add(operation);
  try{
   await this.#finalizeHandoffs(epoch,operation);
   return await this.#serial(async()=>{
    this.#check(epoch,operation);const row=this.#rows.find(r=>r.rootThreadId===threadId);
    if(!row||row.state!=='ready')throw Error('Handoff requires an owned root chat.');
    if(!nativeOwner(row))throw Error('Moving an isolated VM chat is not integrated; its original owner and guest disk were preserved.');
    if(row.handoff)throw handoffPending();await this.#plainMCP(row);this.#bind(operation,row);this.#handoffConflicts(row,[row.cwd]);
    const {engine,creation}=await this.#thread(threadId,true,epoch,operation);if(creation)throw Error('Handoff requires persisted native history; an empty creation receipt cannot be moved.');
    const snapshot=await engine.prepareHandoff(threadId);this.#check(epoch,operation);this.#pin(row,engine);await this.#remember(row,engine);
    if(snapshot.cwd!==row.cwd||snapshot.model!==row.model||snapshot.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[row.provider])||!equal([...row.threads].sort(),snapshot.members.map(t=>t.id).sort()))throw Error('Handoff family differs from the complete committed owner membership.');
    const previous=this.#handoffPrepared.get(threadId),entry={row,engine,epoch,life:this.#live.get(row.id).life,generation:row.generation.id,home:structuredClone(row.home),revision:this.#ownerRevisions.get(row.id)??0,snapshot:structuredClone(snapshot),paths:[row.cwd],recovery:false};
    if(previous&&previous.engine===engine&&equal(previous.snapshot,snapshot)&&previous.generation===entry.generation&&previous.revision===entry.revision&&previous.epoch===entry.epoch){this.#handoffCheck(previous,operation);return snapshot;}
    this.#handoffPrepared.set(threadId,entry);return snapshot;
   });
  }finally{this.#release(operation);}
 }
 handoffOwner(snapshot,destination){
  const entry=this.#handoffPrepared.get(snapshot?.rootThreadId);if(!entry||entry.recovery||!equal(snapshot,entry.snapshot)||!absolutePath(destination)||destination===snapshot.cwd)throw Error('Unknown native handoff review.');
  this.#handoffCheck(entry);entry.paths=[snapshot.cwd,destination];this.#handoffCheck(entry);this.#handoffSelection=entry;return this.#handoffBinding(entry.row);
 }
 async reserveHandoffReconnect(resolvePaths,context,family){
  handoffContext(context);const epoch=this.#epoch,operation=this.#operation(epoch);this.#operations.add(operation);let entry,lease;
  const check=()=>{
   this.#check(epoch);const row=entry?.row;
   if(!row||this.#handoffPrepared.get(row.rootThreadId)!==entry||!this.#rows.includes(row)||!nativeOwner(row)||row.state!=='ready'||this.#live.has(row.id)||!equal(this.#handoffBinding(row),context.owner)||!equal(row.handoff,{context:entry.context,commit:null})||row.cwd!==context.source||row.generation.nativeOpen||!row.generation.executorClosed||row.generation.execution!=='native-stopped'||(this.#ownerRevisions.get(row.id)??0)!==entry.revision)throw Error('Reconnect requires the exact original closed native owner.');
   this.#handoffConflicts(row,entry.paths);
  };
  try{
   await this.#serial(async()=>{
    await this.#load(operation);this.#check(epoch,operation);const row=this.#rows.find(r=>r.id===context.owner.ownerId);
    if(!row||!equal(row.handoff,{context,commit:null})||!equal(this.#handoffBinding(row),context.owner)||family?.fingerprint!==context.fingerprint||family.cwd!==context.source||family.rootThreadId!==row.rootThreadId||family.model!==row.model||family.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[row.provider])||!Array.isArray(family.members)||!equal([...row.threads].sort(),family.members.map(t=>t.id).sort()))throw Error('Reconnect owner or complete family binding changed.');
    this.#bind(operation,row);await this.#verifyHome(row);await this.#plainMCP(row);
    const live=this.#live.get(row.id);
    if(live?.engine?.historyOnly===true&&this.#handoffHistoryReadable(row)&&live.executorExpected===false&&live.resource===null&&live.reservation===null&&live.setup===null&&!live.allocation&&!live.retire&&!live.startup)await this.#retire(row,live);
    entry={row,epoch,context:structuredClone(context),paths:[context.source,context.destination],revision:this.#ownerRevisions.get(row.id)??0,recovery:true,reconnectOnly:true};
    this.#handoffPrepared.set(row.rootThreadId,entry);check();
   });
  }catch(error){if(entry&&this.#handoffPrepared.get(entry.row.rootThreadId)===entry)this.#handoffPrepared.delete(entry.row.rootThreadId);throw error;}finally{this.#release(operation);}
  try{
   lease=await this.reserveProjectMutation(async()=>{check();return resolvePaths();},null,entry);check();
   const revalidate=async()=>{await lease.revalidateScope?.();await this.#serial(async()=>{await this.#checkDisk();check();await this.#verifyHome(entry.row);await this.#plainMCP(entry.row);check();});};
   let consumed=false;
   return Object.freeze({...lease,revalidateScope:revalidate,release:async()=>{await lease.release();if(this.#handoffPrepared.get(entry.row.rootThreadId)===entry)this.#handoffPrepared.delete(entry.row.rootThreadId);},rebind:async(next,publish)=>{
    handoffContext(next);if(consumed||typeof publish!=='function'||!equal({...context,recovery:next.recovery},next)||next.recovery.directory.ino!==context.recovery.directory.ino||next.recovery.directory.dev===context.recovery.directory.dev)throw Error('Invalid or consumed owner reconnect descriptor.');consumed=true;
    await revalidate();
    return this.#serial(async()=>{await this.#checkDisk();check();await this.#verifyHome(entry.row);check();await publish();check();entry.row.handoff.context=structuredClone(next);await this.#save();entry.context=structuredClone(next);await this.#checkDisk();check();return true;});
   }});
  }catch(error){await lease?.release();if(entry&&this.#handoffPrepared.get(entry.row.rootThreadId)===entry)this.#handoffPrepared.delete(entry.row.rootThreadId);throw error;}
 }
 async loadHandoffRecovery(context){
  handoffContext(context);const epoch=this.#epoch,operation=this.#operation(epoch);this.#operations.add(operation);
  try{return await this.#serial(async()=>{
   await this.#load(operation);this.#check(epoch,operation);const row=this.#rows.find(r=>r.id===context.owner.ownerId);
   if(!row||!nativeOwner(row)||row.handoff&&!equal(row.handoff.context,context)||!row.handoff&&(!equal(this.#handoffBinding(row),context.owner)||row.cwd!==context.source))throw Error('Recovery does not belong to this retained native owner.');if(row.handoff)handoffMarker(row.handoff,row);this.#bind(operation,row);await this.#verifyHome(row);await this.#plainMCP(row);this.#handoffConflicts(row,[context.source,context.destination]);
   // Viewing saved history may have reopened only this owner's read-only reader.
   // Drain that pinned reader; executable or uncertain generations remain fenced.
   const live=this.#live.get(row.id),generation=row.generation?.id;
   if(live?.engine?.historyOnly===true&&this.#historyQuiescent(row)&&(!row.handoff||this.#handoffHistoryReadable(row))&&live.executorExpected===false&&live.resource===null&&live.reservation===null&&live.setup===null&&!live.allocation&&!live.retire&&!live.startup&&row.generation.executorClosed===true&&row.generation.execution==='native-stopped'){
    this.#pin(row,live.engine);await this.#retire(row,live);this.#check(epoch,operation);
    if(row.generation?.id!==generation||this.#live.has(row.id))throw Error('Recovery reader ownership changed during closure.');
   }
   // A prior-boot manager proof is not a replacement for owner shutdown proof.
   if(this.#live.has(row.id)||!row.generation||row.generation.nativeOpen||!row.generation.executorClosed||row.generation.execution!=='native-stopped')throw Error('Recovery requires confirmed closure of the original native owner before opening its home.');
   // The manager can have recorded its manifest before the first owner-marker
   // write failed. Rebind only its exact original, closed owner at the source.
   if(!row.handoff){row.handoff={context:structuredClone(context),commit:null};this.#handoffCatalog=true;await this.#save();this.#check(epoch,operation);}
   const engine=await this.#owner(row,true,epoch,undefined,operation),entry={row,engine,epoch,life:this.#live.get(row.id).life,generation:row.generation.id,home:structuredClone(row.home),revision:this.#ownerRevisions.get(row.id)??0,snapshot:null,paths:[context.source,context.destination],context:structuredClone(context),recovery:true};
   this.#handoffPrepared.set(row.rootThreadId,entry);this.#handoffSelection=entry;return true;
  });}finally{this.#release(operation);}
 }
 reserveHandoffRecovery(resolvePaths,context){const entry=this.#handoffPrepared.get(context?.owner?.rootThreadId);if(!entry?.recovery||!equal(entry.context,context))throw handoffPending();this.#handoffCheck(entry);return this.reserveProjectMutation(resolvePaths,null,entry);}
 async prepareHandoffRecovery(snapshot,destination,journal,filesystem=null){
  const entry=this.#handoffPrepared.get(snapshot?.rootThreadId);if(!entry?.recovery||snapshot.fingerprint!==entry.context.fingerprint||snapshot.cwd!==entry.context.source||destination!==entry.context.destination||!equal([...entry.row.threads].sort(),snapshot.members.map(t=>t.id).sort()))throw Error('Native recovery was not enrolled before reservation.');
  if(filesystem!==null){
   filesystem=freeze(structuredClone(filesystem));shape(filesystem,['fromDevice','toDevice','volumeUUID']);
   if(!isFilesystemIdentity(entry.row.home)||filesystem.volumeUUID!==entry.row.home.volumeUUID||filesystem.toDevice!==entry.context.recovery.directory.dev||filesystem.fromDevice===filesystem.toDevice||!identity({dev:filesystem.fromDevice,ino:'1'})||snapshot.members.some(member=>!identity(member.compatibility?.identity)||member.compatibility.identity.dev!==filesystem.fromDevice))throw Error('Recovery filesystem admission differs from its original owner and family.');
  }
  this.#handoffCheck(entry);const operation=this.#operation(entry.epoch);this.#bind(operation,entry.row);this.#operations.add(operation);
  try{await this.#serial(async()=>{await this.#checkDisk();await this.#verifyHome(entry.row);this.#handoffCheck(entry,operation);});
   const review=await entry.engine.prepareHandoffRecovery(snapshot,destination,journal,filesystem);this.#handoffCheck(entry,operation);entry.snapshot=structuredClone(snapshot);entry.review=review;return review;
  }finally{this.#release(operation);}
 }
 async handoffTemporary(cwd){const entry=this.#handoffSelection;if(!entry||!entry.paths.includes(cwd))throw Error('No selected native handoff owns this scratch lookup.');this.#handoffCheck(entry);const value=await entry.engine.handoffTemporary(cwd);this.#handoffCheck(entry);return value;}
 async verifyTemporary(value){const entry=this.#handoffSelection;if(!entry||!entry.paths.includes(value?.cwd))throw Error('No selected native handoff owns this scratch receipt.');this.#handoffCheck(entry);await entry.engine.verifyTemporary(value);this.#handoffCheck(entry);}
 checkHandoffAuthority(cwd,fence,context){const entry=this.#handoffActive.get(fence);if(!entry||entry.fence!==fence)throw Error('Unknown owner handoff fence.');this.#handoffCheck(entry,entry.operation);entry.engine.checkHandoffAuthority(cwd,fence,context);}
 stopHandoff(fence,context){const entry=this.#handoffActive.get(fence);if(!entry||entry.fence!==fence)throw Error('Unknown owner handoff cancellation fence.');return entry.engine.stopHandoff(fence,context);}
 relocateFamily(snapshot,destination,callbacks){return this.#moveHandoff(snapshot,destination,callbacks,false);}
 recoverHandoffFamily(review,target,callbacks){return this.#moveHandoff(review,target,callbacks,true);}
 async #moveHandoff(value,target,callbacks,recovery){
  const snapshot=recovery?value?.snapshot:value,entry=this.#handoffPrepared.get(snapshot?.rootThreadId),context=handoffContext(callbacks?.ownerContext);
  if(!entry||entry.recovery!==recovery||!equal(snapshot,entry.snapshot)||recovery&&!equal(value,entry.review)||!entry.paths.includes(target)||!equal(context,recovery?entry.context:{...context,source:snapshot.cwd,destination:target,fingerprint:snapshot.fingerprint,owner:this.#handoffBinding(entry.row)})||typeof callbacks.bind!=='function'||typeof callbacks.checkpoint!=='function'||typeof callbacks.transfer!=='function'||typeof callbacks.complete!=='function')throw Error('Native handoff transaction binding or callbacks changed.');
  this.#handoffCheck(entry);const operation=this.#operation(entry.epoch);this.#bind(operation,entry.row);this.#operations.add(operation);entry.operation=operation;let terminal=false,committed=null;
  const check=()=>this.#handoffCheck(entry,operation),verify=()=>this.#serial(async()=>{check();await this.#checkDisk();await this.#verifyHome(entry.row);check();}),abort=()=>{if(entry.fence&&!terminal)void entry.engine.stopHandoff(entry.fence,{snapshot:entry.snapshot,lease:entry.fence.lease.handle}).catch(()=>{});};operation.controller.signal.addEventListener('abort',abort,{once:true});
  try{
   await this.#serial(async()=>{check();await this.#checkDisk();await this.#verifyHome(entry.row);await this.#plainMCP(entry.row);check();if(recovery?!equal(entry.row.handoff?.context,context):!!entry.row.handoff)throw handoffPending();});
   const wrapped={
    bind:async fence=>{check();entry.fence=fence;this.#handoffActive.set(fence,entry);await this.#serial(async()=>{check();entry.row.handoff={context:structuredClone(context),commit:null};this.#handoffCatalog=true;await this.#save();check();});await callbacks.bind(fence);check();},
    checkpoint:async(...args)=>{await verify();await callbacks.checkpoint(...args);await verify();},
    transfer:async()=>{await verify();await callbacks.transfer();await verify();},
    complete:async family=>{
     check();const commit=async receipt=>this.#serial(async()=>{
      check();await this.#checkDisk();await this.#verifyHome(entry.row);if(!equal(entry.row.handoff?.context,context)||family.cwd!==target||family.rootThreadId!==entry.row.rootThreadId||family.model!==entry.row.model||family.modelProvider!==({local:'saleh_local',cloud:'saleh_cloud'}[entry.row.provider])||receipt.target!==target||receipt.fingerprint!==family.fingerprint)throw Error('Verified handoff owner commit differs from its family.');
      const marker={context:structuredClone(context),commit:structuredClone(receipt)};handoffMarker(marker,{...entry.row,cwd:target});entry.row.cwd=target;entry.row.handoff=marker;await this.#save();committed=structuredClone(marker);this.#snapshots.clear();check();
     });
     try{await callbacks.complete(family,commit);}catch(error){if(!committed||!this.#handoffStatus||await this.#handoffStatus(committed)!==true)throw error;}
     if(!committed)throw Error('Handoff manager did not commit the original owner binding.');terminal=true;
     // Manager fulfillment is terminal. Cleanup is metadata-only, including after
     // a late Stop. An uncertain save keeps its exact marker for cold inspection.
     try{await this.#serial(async()=>{await this.#checkDisk();await this.#verifyHome(entry.row);if(!equal(entry.row.handoff,committed))throw handoffPending();delete entry.row.handoff;await this.#save();this.#snapshots.clear();});}
     catch(error){if(!entry.row.handoff)entry.row.handoff=structuredClone(committed);this.#journal.push('coding/error',{message:'The worktree handoff completed, but owner metadata finalization is unconfirmed. Preserve the saved recovery; no work was replayed. '+error.message});}
    }
   };
   return await (recovery?entry.engine.recoverHandoffFamily(value,target,wrapped):entry.engine.relocateFamily(value,target,wrapped));
  }finally{operation.controller.signal.removeEventListener('abort',abort);entry.operation=null;if(terminal){this.#handoffActive.delete(entry.fence);this.#handoffPrepared.delete(entry.row.rootThreadId);if(this.#handoffSelection===entry)this.#handoffSelection=null;}this.#release(operation);}
 }
 async stop(){
  if(this.#stopping)return this.#stopping;
  this.#startupCopies?.cancelAll();
  const queuePause=this.#pauseFollowups();this.#epoch++;this.#admissionController?.abort();for(const setup of this.#setups.values())this.#cancelSetup(setup);for(const operation of this.#operations)operation.controller?.abort();this.#scheduled?.controller.abort();for(const live of this.#members())live.controller.abort();for(const [owner,live] of this.#live)this.#cleanup(this.#rows.find(r=>r.id===owner),live);
  this.#stopping=(async()=>{
   const results=await Promise.allSettled([queuePause,...this.#members().filter(x=>x.engine&&!x.nativeExecution).map(x=>x.engine.stop())]);let catalogChecked=false;
   // Native cleanup joins selected Stop before advancing its engine lifetime.
   // Drain its catalog commit outside the queue used by retirement. Full retirement
   // may await unresolved startup; Stop must report it pending rather than wait.
   await Promise.all([...this.#live].filter(([,live])=>live.nativeExecution).map(([id])=>this.#selectedStops.get(id)).filter(ticket=>ticket?.pending&&!ticket.retiring).map(ticket=>ticket.work));
   // An aborted snapshot poll may still be finishing its directory inspection.
   // Drain only those existing polls, outside the queue they must release.
   const pending=[...this.#operations];
   if(this.#loaded&&!this.#loading&&(!this.#legacyLive||this.#legacyLive.inventory)&&!this.#allocating.size&&!this.#authority.projectMutation&&pending.every(operation=>operation.snapshotPoll===true))await Promise.all(pending.map(operation=>operation.settled));
   // A busy publication may have renamed its catalog before updating our disk stamp.
   // Stop reports pending; only an idle retirement turn may verify that stamp.
   if(!this.#loading&&!this.#saving&&!this.#queuePending&&!this.#operations.size&&!this.#allocating.size&&!this.#authority.projectMutation)await this.#serial(async()=>{await this.#retireAll();if(this.#loaded)await this.#checkDisk();catalogChecked=true;}).catch(error=>results.push({status:'rejected',reason:error}));
   if(this.#loaded&&!this.#loading&&(!this.#legacyLive||this.#legacyLive.inventory)&&!this.#operations.size&&!this.#allocating.size&&!this.#authority.projectMutation)await Promise.allSettled([...this.#inspections]);
   return {stopped:catalogChecked&&!this.#loading&&!this.#saving&&!this.#queuePending&&!this.#operations.size&&!this.#authority.projectMutation&&!this.shutdownUnconfirmed&&!this.runs.size&&!this.terminals.size&&results.every(x=>x.status==='fulfilled'),executionRevoked:!this.exitUnconfirmed&&!this.#rows.some(nativeOwner),message:'Stop requested for every live owner; unresolved allocations and execution generations remain fenced.'};
  })();try{return await this.#stopping;}finally{this.#stopping=null;}
 }
 close(){
  if(this.#closing)return this.#closing;
  this.#startupCopies?.cancelAll();
  let resolve,reject;this.#closing=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const queuePause=this.#pauseFollowups();this.closed=true;this.#epoch++;this.#admissionController?.abort();
  for(const setup of this.#setups.values())this.#cancelSetup(setup);
  const pendingStops=[...new Set(this.#selectedStops.values())].filter(ticket=>ticket.pending);
  (async()=>{
   for(const operation of this.#operations)operation.controller?.abort();this.#scheduled?.controller.abort();for(const live of this.#members())live.controller.abort();for(const [owner,live] of this.#live)this.#cleanup(this.#rows.find(r=>r.id===owner),live);
   const legacyClose=Promise.resolve().then(()=>this.#legacyLive?.engine?.close());
   // These callbacks may themselves commit on the catalog queue. Drain outside
   // it, and never force-release a project lease whose holder is still active.
   const outcomes=await Promise.allSettled([...this.#operations].map(operation=>operation.settled).concat(pendingStops.map(ticket=>ticket.work),[...this.#setups.values()].map(setup=>setup.retirement),[queuePause,...this.#followupWrites,this.#stopping,this.#authority.projectMutation?.released,legacyClose,Promise.allSettled([...this.#inspections])]));
   const errors=outcomes.filter(x=>x.status==='rejected').map(x=>x.reason).concat(pendingStops.filter(ticket=>ticket.error).map(ticket=>Error(ticket.error)));
   await this.#queue;
   try{await this.#retireAll();}catch(error){errors.push(error);}
   try{await this.#followups?.close();}catch(error){errors.push(error);}
   try{await this.#authority.close();}catch(error){errors.push(error);}
   if(errors.length)throw new AggregateError(errors,errors.map(error=>error.message).join('; '));
   if(this.shutdownUnconfirmed)return {stopped:false,message:'Owner physical closure is unconfirmed; exclusive lease retained.'};
   if(this.#lease){await this.#guard();await unlink(join(this.dataDir,'coding-owners.lock'));this.#lease=null;await this.#syncDir();}
   return {stopped:true,executionRevoked:!this.exitUnconfirmed&&!this.#rows.some(nativeOwner),message:this.exitUnconfirmed?'Owned resources closed; execution generations remain unrevoked.':'Coding owners closed.'};
  })().then(resolve,reject);return this.#closing;
 }
}
