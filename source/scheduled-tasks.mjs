import {mkdir,open,lstat,realpath,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {validateModelID} from './local-models.mjs';

const MODEL='qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp',MAX=1048576,MAX_DATE=253402300799999;
const scheduleModel=value=>Object.hasOwn(value,'model')?validateModelID(value.model):MODEL;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL=['completed','failed','interrupted','needs-review','unknown'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=value=>structuredClone(value),message=e=>String(e?.message??e).slice(0,1600);
const equalIdentity=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
function shape(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('Invalid schedule request fields.');}
function string(value,max,label,multiline=false){if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>max||value.includes('\0')||!multiline&&/[\r\n]/.test(value))throw new Error('Invalid '+label+'.');return value;}
function id(value){if(typeof value!=='string'||!UUID.test(value))throw new Error('Invalid schedule identifier.');return value;}
function time(value){if(!Number.isSafeInteger(value)||value<0||value>MAX_DATE)throw new Error('Invalid schedule time.');return value;}
function executionMode(value){const mode=Object.hasOwn(value,'executionMode')?value.executionMode:'vm';if(!['native','vm'].includes(mode))throw new Error('Invalid scheduled execution mode.');return mode;}
function identity(value){shape(value,['dev','ino']);if(!Object.values(value).every(x=>typeof x==='string'&&/^\d{1,30}$/.test(x)))throw new Error('Invalid project identity.');return value;}
function engineId(value){return string(value,200,'coding identifier').match(/^[a-zA-Z0-9_-]+$/)?value:(()=>{throw new Error('Invalid coding identifier.');})();}
function cadence(value){
  if(value?.type==='interval'){shape(value,['type','minutes']);if(!Number.isInteger(value.minutes)||value.minutes<1||value.minutes>10080)throw new Error('Interval must be 1–10080 minutes.');}
  else if(value?.type==='once'){shape(value,['type','at']);time(value.at);}
  else if(value?.type==='calendar'){
    shape(value,['type','days','time','timeZone']);if(!Array.isArray(value.days)||!value.days.length||value.days.length>7||new Set(value.days).size!==value.days.length||value.days.some(d=>!Number.isInteger(d)||d<0||d>6)||typeof value.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))throw new Error('Invalid calendar days or wall time.');
    string(value.timeZone,100,'time zone');new Intl.DateTimeFormat('en-US',{timeZone:value.timeZone}).format(0);
  }else throw new Error('Unsupported schedule cadence.');return clone(value);
}
function formatter(zone){return new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
function parts(fmt,at){const p=Object.fromEntries(fmt.formatToParts(at).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));return [p.year,p.month,p.day,p.hour,p.minute];}
function calendarInstant(fmt,day,wall){
  const wanted=[day.getUTCFullYear(),day.getUTCMonth()+1,day.getUTCDate(),...wall],nominal=Date.UTC(wanted[0],wanted[1]-1,...wanted.slice(2)),offsets=new Set();
  // Round-trip both offsets around a transition: gaps have no candidate; folds choose the first.
  for(let h=-36;h<=36;h+=6){const sample=nominal+h*3600000,p=parts(fmt,sample);offsets.add(Date.UTC(p[0],p[1]-1,...p.slice(2))-sample);}
  const candidates=[...offsets].map(offset=>nominal-offset).filter(at=>parts(fmt,at).every((v,i)=>v===wanted[i]));return candidates.length?Math.min(...candidates):null;
}
function occurrence(c,anchor,at,next){
  if(c.type==='once')return next?(c.at>at?c.at:null):(c.at<=at?c.at:null);
  if(c.type==='interval'){const period=c.minutes*60000,n=Math.floor((at-anchor)/period)+(next?1:0);return anchor+Math.max(1,n)*period;}
  const fmt=formatter(c.timeZone),p=parts(fmt,at),day=new Date(Date.UTC(p[0],p[1]-1,p[2])),wall=c.time.split(':').map(Number);
  for(let n=0;n<16;n++){if(c.days.includes(day.getUTCDay())){const candidate=calendarInstant(fmt,day,wall);if(candidate!==null&&(next?candidate>at:candidate<=at))return candidate;}day.setUTCDate(day.getUTCDate()+(next?1:-1));}
  throw new Error('No calendar occurrence found within the bounded two-week window.');
}
async function optional(path){try{return await lstat(path,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}}
const statIdentity=s=>({dev:String(s.dev),ino:String(s.ino)});
const pin=(s,file=false)=>Object.fromEntries((file?['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs']:['dev','ino','mode','uid']).map(key=>[key,String(s[key])]));
const samePin=(a,b,renamed=false)=>!!a&&!!b&&Object.keys(a).every(key=>renamed&&key==='ctimeNs'||a[key]===b[key]);
const stable=value=>{if(!isFilesystemIdentity(value))throw Error('Invalid stable schedule identity.');return value;};

export class ScheduledTasks {
  #identityReader; #recoveryOperation=null; #recoveries=new Set(); #identityOperations=new Set();
  constructor({dataDir=join(homedir(),'Library/Application Support/Qwen Local/Coding'),coding,assertProject=async()=>{},nativeHelper,identityReader,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    if(!isAbsolute(dataDir)||!coding||typeof coding.runScheduled!=='function')throw new Error('Scheduler requires an absolute data directory and coding runner.');
    if(identityReader!==undefined&&typeof identityReader!=='function')throw Error('Invalid filesystem identity reader.');
    this.#identityReader=identityReader??(options=>readFilesystemIdentity({...options,nativeHelper}));
    Object.assign(this,{dataDir,coding,assertProject,now,setTimer,clearTimer,schedules:[],plans:new Map(),queue:Promise.resolve(),epoch:0,loaded:false,blocked:false,warning:'',historyTruncated:false,running:null,pendingExecution:null,started:false,closed:false,ledgerHash:null,ledgerIdentity:null,recoveryAvailable:false});
    this.ledger=join(dataDir,'scheduled-tasks.json');
  }
  enqueue(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
  block(error,phase){if(!this.blocked){this.blocked=true;this.blockedPhase=phase;this.blockedCause=message(error);this.warning='Scheduled work is blocked. '+this.blockedCause;}this.running?.controller.abort();return new Error(this.warning);}
  checkEpoch(epoch){if(this.closed||epoch!==this.epoch)throw new Error('Schedule operation cancelled or stopped.');if(this.blocked)throw new Error(this.warning);}
  async directory(){
    const s=await lstat(this.dataDir,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(this.dataDir)!==this.dataDir)throw new Error('Schedule data directory is not a private canonical directory.');
    const result=statIdentity(s);if(this.directoryPin&&!samePin(pin(s),this.directoryPin))throw new Error('Schedule data directory identity changed.');this.directoryPin??=pin(s);return result;
  }
  async #read(path,limit=MAX){
    await this.directory();const present=await optional(path);if(!present)return null;
    if(!present.isFile()||present.isSymbolicLink()||present.uid!==BigInt(process.getuid())||(present.mode&0o077n)||present.nlink!==1n||present.size>BigInt(limit))throw new Error('Schedule ledger type, ownership, permissions or size is invalid.');
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const s=await file.stat({bigint:true});if(!samePin(pin(s,true),pin(present,true)))throw new Error('Schedule ledger changed while opening.');const bytes=await file.readFile();if(bytes.length>limit||!samePin(pin(s,true),pin(await file.stat({bigint:true}),true))||!samePin(pin(s,true),pin(await lstat(path,{bigint:true}),true)))throw new Error('Schedule ledger changed during reading or exceeds its bound.');await this.directory();return {bytes,hash:sha(bytes),identity:statIdentity(s),stamp:pin(s,true)};}finally{await file.close();}
  }
  async #guardRecovery(proof){const marker=await this.#read(this.ledger+'.recovery',2048);if(proof?(!marker||marker.hash!==proof.hash||!samePin(marker.stamp,proof.stamp)):marker){this.recoveryAvailable=false;throw Error('Unresolved schedule recovery write; inspect the original ledger and recovery files.');}}
  async disk(proof){await this.#guardRecovery(proof);return this.#read(this.ledger);}
  async checkDisk(){const current=await this.disk();if((current?.hash??null)!==this.ledgerHash||Boolean(current)!==Boolean(this.ledgerIdentity)||current&&(!equalIdentity(current.identity,this.ledgerIdentity)||!samePin(current.stamp,this.ledgerStamp)))throw new Error('Schedule ledger changed externally; reload and inspect it before continuing.');}
  validate(data){
    shape(data,['version','directory','schedules','historyTruncated']);if(![1,2].includes(data.version)||!Array.isArray(data.schedules)||data.schedules.length>32||typeof data.historyTruncated!=='boolean')throw new Error('Invalid schedule ledger schema.');const binding=data.version===1?identity:stable;binding(data.directory);
    const ids=new Set(),runIds=new Set();let total=0;
    for(const s of data.schedules){shape(s,['id','name','cwd','identity','prompt','effort','cadence','anchor','active','nextRunAt','createdAt','updatedAt','revision','runs',...(data.version===2&&Object.hasOwn(s,'executionMode')?['executionMode']:[]),...(data.version===2&&Object.hasOwn(s,'model')?['model']:[])]);if(Object.hasOwn(s,'executionMode')&&s.executionMode!=='native')throw new Error('Invalid stored scheduled execution mode.');scheduleModel(s);id(s.id);if(ids.has(s.id))throw new Error('Duplicate schedule.');ids.add(s.id);string(s.name,120,'schedule name');string(s.cwd,4096,'project path');if(!isAbsolute(s.cwd))throw new Error('Invalid project path.');binding(s.identity);string(s.prompt,20000,'prompt',true);if(!['none','high'].includes(s.effort)||typeof s.active!=='boolean'||!Number.isSafeInteger(s.revision)||s.revision<1)throw new Error('Invalid schedule settings.');cadence(s.cadence);for(const k of ['anchor','createdAt','updatedAt'])time(s[k]);if(s.nextRunAt!==null)time(s.nextRunAt);if(s.active&&s.nextRunAt===null)throw new Error('Active schedule has no next occurrence.');if(!Array.isArray(s.runs)||s.runs.length>257)throw new Error('Invalid run history.');
      for(const r of s.runs){shape(r,['id','scheduledFor','startedAt','finishedAt','status','threadId','turnId','message','manual']);id(r.id);if(runIds.has(r.id))throw new Error('Duplicate scheduled run.');runIds.add(r.id);for(const k of ['scheduledFor','startedAt'])time(r[k]);if(r.finishedAt!==null)time(r.finishedAt);if(!['claimed','running',...TERMINAL].includes(r.status)||TERMINAL.includes(r.status)!==(r.finishedAt!==null)||typeof r.manual!=='boolean'||typeof r.message!=='string'||Buffer.byteLength(r.message)>6400)throw new Error('Invalid scheduled run state.');if(r.threadId!==null)engineId(r.threadId);if(r.turnId!==null)engineId(r.turnId);total++;}
    }if(total>257)throw new Error('Scheduled run history exceeds its limit.');
  }
  async #object(path,parentSignal){
    const controller=new AbortController(),abort=()=>controller.abort(),signal=controller.signal;parentSignal?.addEventListener('abort',abort,{once:true});if(parentSignal?.aborted)abort();this.#identityOperations.add(controller);
    try{
      signal.throwIfAborted();if(await realpath(path)!==path)throw Error('Schedule identity path is not canonical.');
      const before=await lstat(path,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())throw Error('Schedule identity requires a directory.');
      const identity=stable(await this.#identityReader({path,signal}));signal.throwIfAborted();
      if(identity.ino!==String(before.ino)||!samePin(pin(before),pin(await lstat(path,{bigint:true})))||await realpath(path)!==path)throw Error('Schedule directory identity changed during inspection.');signal.throwIfAborted();
      return {identity:Object.freeze({...identity}),pin:pin(before)};
    }finally{this.#identityOperations.delete(controller);parentSignal?.removeEventListener('abort',abort);}
  }
  #eligible(data){
    if(data.version!==1||this.running||this.pendingExecution||data.schedules.some(s=>s.active||s.runs.some(r=>!TERMINAL.includes(r.status))))return false;
    const paths=new Map();for(const s of data.schedules){if(paths.has(s.cwd)&&!equalIdentity(paths.get(s.cwd),s.identity))return false;paths.set(s.cwd,s.identity);}return true;
  }
  async #snapshot(signal,proof){
    if(this.loaded||this.durableDirectory||this.blockedPhase==='save')throw Error('Loaded or persistence-blocked schedules cannot enter legacy recovery.');
    await this.directory();const current=await this.disk(proof);if(!current)throw Error('No legacy schedule ledger is available for recovery.');
    const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(current.bytes));this.validate(data);
    if(!this.#eligible(data))throw Error('Only intact legacy paused schedules with terminal runs can be recovered.');
    const root=await this.#object(this.dataDir,signal);if(root.identity.ino!==data.directory.ino)throw Error('Legacy schedule data directory was replaced.');
    const directory={path:this.dataDir,before:clone(data.directory),after:root.identity},projects=[],pins=[{path:this.dataDir,...root}];
    for(const s of data.schedules){let project=projects.find(p=>p.path===s.cwd);if(!project){const object=await this.#object(s.cwd,signal);if(object.identity.ino!==s.identity.ino)throw Error('Legacy scheduled project was replaced.');project={path:s.cwd,before:clone(s.identity),after:object.identity,scheduleIds:[]};projects.push(project);pins.push({path:s.cwd,...object});}project.scheduleIds.push(s.id);}
    for(const object of pins)if(!samePin(object.pin,pin(await lstat(object.path,{bigint:true})))||await realpath(object.path)!==object.path)throw Error('Recovery object changed during inspection.');
    const final=await this.disk(proof);if(!final||final.hash!==current.hash||!samePin(final.stamp,current.stamp))throw Error('Legacy schedule ledger changed during recovery inspection.');signal?.throwIfAborted();
    return {current,data,directory,projects,pins};
  }
  async #recheckRecovery(saved,signal,proof){const fresh=await this.#snapshot(signal,proof);if(fresh.current.hash!==saved.current.hash||!samePin(fresh.current.stamp,saved.current.stamp)||JSON.stringify([fresh.directory,fresh.projects,fresh.pins])!==JSON.stringify([saved.directory,saved.projects,saved.pins]))throw Error('Schedule recovery source or reviewed objects changed.');}
  async #write(path,bytes){const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}}
  async #syncDirectory(){const file=await open(this.dataDir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{if(!samePin(this.directoryPin,pin(await file.stat({bigint:true}))))throw Error('Schedule directory changed before sync.');await file.sync();}finally{await file.close();}await this.directory();}
  recovery(action,planId,epoch,signal){
    if(signal!==undefined&&!(signal instanceof AbortSignal))return Promise.reject(Error('Invalid recovery cancellation signal.'));
    const operation={controller:new AbortController()},abort=()=>operation.controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();this.#recoveries.add(operation);
    operation.promise=this.enqueue(async()=>{
      const check=()=>{operation.controller.signal.throwIfAborted();if(this.closed||epoch!==this.epoch)throw Error('Schedule recovery was cancelled or stopped.');if(this.running||this.pendingExecution)throw Error('Scheduled execution must be confirmed stopped before recovery.');};
      check();this.#recoveryOperation=operation;
      try{
        if(action==='prepareRecovery'){
          const snapshot=await this.#snapshot(operation.controller.signal);check();
          for(const [key,p]of this.plans)if(p.expiresAt<=this.now())this.plans.delete(key);if(this.plans.size>=32)throw Error('Too many pending schedule reviews.');
          const plan={id:randomUUID(),kind:'recover-paused',expiresAt:this.now()+120000,ledgerSHA256:snapshot.current.hash,directory:snapshot.directory,projects:snapshot.projects,scheduleCount:snapshot.data.schedules.length};
          this.plans.set(plan.id,{...plan,epoch,snapshot});return {plan:clone(plan)};
        }
        const p=this.plans.get(planId);this.plans.delete(planId);if(!p||p.kind!=='recover-paused'||p.expiresAt<=this.now()||p.epoch!==epoch)throw Error('Schedule recovery plan expired, consumed or stopped.');
        await this.#recheckRecovery(p.snapshot,operation.controller.signal);check();
        const next=clone(p.snapshot.data);next.version=2;next.directory=clone(p.directory.after);for(const s of next.schedules)s.identity=clone(p.projects.find(project=>project.path===s.cwd).after);this.validate(next);
        const bytes=Buffer.from(JSON.stringify(next));if(bytes.length>MAX)throw Error('Recovered schedule ledger exceeds 1 MiB; no history was removed.');
        const backupPath=this.ledger+'.'+p.id+'.v1.backup',temp=this.ledger+'.'+p.id+'.v2.tmp',marker=this.ledger+'.recovery';let attempted=false;
        try{
          check();attempted=true;this.recoveryAvailable=false;
          await this.#write(marker,Buffer.from(JSON.stringify({version:1,id:p.id,ledgerSHA256:p.ledgerSHA256,nextSHA256:sha(bytes),backupPath})));const proof=await this.#read(marker,2048);await this.#syncDirectory();check();
          await this.#write(backupPath,p.snapshot.current.bytes);const backup=await this.#read(backupPath);if(backup.hash!==p.ledgerSHA256)throw Error('Schedule recovery backup changed.');await this.#syncDirectory();check();
          await this.#write(temp,bytes);const written=await this.#read(temp);if(written.hash!==sha(bytes))throw Error('Recovery temporary ledger changed.');
          await this.#recheckRecovery(p.snapshot,operation.controller.signal,proof);const retained=await this.#read(backupPath);if(retained?.hash!==backup.hash||!samePin(retained.stamp,backup.stamp))throw Error('Schedule recovery backup changed before publication.');await this.#guardRecovery(proof);check();
          // ponytail: Single host writer; this final recheck is not a CAS against arbitrary external writers.
          await rename(temp,this.ledger);
          // Publication may already have happened when cancellation arrives. Finish durability; never roll back or replay.
          await this.#syncDirectory();const committed=await this.disk(proof);if(committed?.hash!==written.hash||!samePin(written.stamp,committed.stamp,true))throw Error('Recovered schedule ledger changed after publication.');
          await this.#guardRecovery(proof);await unlink(marker);
          // Ledger and backup are already synced. A crash may restore the deleted marker, conservatively blocking recovery again.
          this.schedules=next.schedules;this.historyTruncated=next.historyTruncated;this.durableDirectory=next.directory;this.ledgerHash=committed.hash;this.ledgerIdentity=committed.identity;this.ledgerStamp=committed.stamp;this.loaded=true;this.blocked=false;this.blockedPhase=null;this.blockedCause=null;this.warning='';this.plans.clear();
          return {...this.view(),recovered:true,backupPath,message:'Saved schedule records recovered and kept paused. Existing workspace restrictions remain; Resume or Run now requires separate review.'};
        }catch(error){if(attempted){this.blocked=false;throw this.block(Error('Schedule recovery persistence is unconfirmed; inspect the original ledger, any backup and recovery marker. '+message(error)),'save');}throw error;}
      }finally{if(this.#recoveryOperation===operation)this.#recoveryOperation=null;}
    }).finally(()=>{this.#recoveries.delete(operation);signal?.removeEventListener('abort',abort);});return operation.promise;
  }
  async cancelRecovery(){for(const [key,plan]of this.plans)if(plan.kind==='recover-paused')this.plans.delete(key);const pending=[...this.#recoveries];for(const operation of pending)operation.controller.abort();await Promise.allSettled(pending.map(operation=>operation.promise));return {stopped:this.#recoveries.size===0};}
  async load(){
    if(this.blocked){try{await this.#guardRecovery();}catch{this.recoveryAvailable=false;}throw new Error(this.warning);}
    try{
      if(this.loaded){await this.checkDisk();return;}
      await mkdir(this.dataDir,{recursive:true,mode:0o700});const original=await lstat(this.dataDir);if(original.isSymbolicLink()||!original.isDirectory())throw new Error('Schedule data directory must not be a symbolic link.');this.dataDir=await realpath(this.dataDir);this.ledger=join(this.dataDir,'scheduled-tasks.json');this.directoryIdentity=await this.directory();const current=await this.disk();
      if(current){const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(current.bytes));this.validate(data);if(data.version===1){this.recoveryAvailable=this.#eligible(data)&&data.directory.ino===this.directoryIdentity.ino;throw Error('Legacy scheduled records require native paused recovery review; no schedule was loaded or enabled.');}const directory=await this.#object(this.dataDir);if(!sameFilesystemIdentity(data.directory,directory.identity))throw Error('Schedule data directory was replaced.');this.durableDirectory=directory.identity;this.schedules=data.schedules;this.historyTruncated=data.historyTruncated;this.ledgerHash=current.hash;this.ledgerIdentity=current.identity;this.ledgerStamp=current.stamp;}
      else this.durableDirectory=(await this.#object(this.dataDir)).identity;
      await this.checkDisk();this.loaded=true;let recovered=false;for(const s of this.schedules)for(const r of s.runs)if(!TERMINAL.includes(r.status)){Object.assign(r,{status:'unknown',finishedAt:this.now(),message:'Host restart interrupted observation; this claimed occurrence will not be replayed.'});s.active=false;recovered=true;}
      if(recovered){this.warning='A previously claimed run has an unknown outcome after restart; its schedule is paused for review.';await this.save();}
    }catch(e){throw this.block(e,'load');}
  }
  async save(){
    let temp;try{
      await this.checkDisk();const data={version:2,directory:this.durableDirectory,schedules:this.schedules,historyTruncated:this.historyTruncated};
      let count=this.schedules.flatMap(s=>s.runs).filter(r=>TERMINAL.includes(r.status)).length,bytes=Buffer.from(JSON.stringify(data));
      const removable=this.schedules.flatMap(s=>s.runs.filter(r=>TERMINAL.includes(r.status)&&r.status!=='unknown').map(r=>({s,r}))).sort((a,b)=>a.r.startedAt-b.r.startedAt);
      while((count>256||bytes.length>MAX)&&removable.length){const {s,r}=removable.shift();s.runs=s.runs.filter(x=>x!==r);count--;data.historyTruncated=this.historyTruncated=true;bytes=Buffer.from(JSON.stringify(data));}
      if(count>256||bytes.length>MAX)throw new Error('Schedule ledger limit reached; retained uncertain runs or definitions require review.');this.validate(data);
      // ponytail: Single host writer only; external multiwriter support needs atomic displaced-version preservation across the final checkDisk→rename race.
      temp=this.ledger+'.'+randomUUID()+'.tmp';await this.#write(temp,bytes);const written=await this.#read(temp);if(written.hash!==sha(bytes))throw Error('Temporary schedule ledger changed.');await this.checkDisk();await rename(temp,this.ledger);temp=null;await this.#syncDirectory();const committed=await this.disk();if(committed?.hash!==written.hash||!samePin(written.stamp,committed.stamp,true))throw Error('Committed schedule ledger changed.');this.ledgerHash=committed.hash;this.ledgerIdentity=committed.identity;this.ledgerStamp=committed.stamp;
    }catch(e){throw this.block(e,'save');}finally{if(temp)await unlink(temp).catch(()=>{});}
  }
  publicSchedule(s){return {id:s.id,name:s.name,cwd:s.cwd,prompt:s.prompt,effort:s.effort,model:scheduleModel(s),executionMode:executionMode(s),cadence:clone(s.cadence),active:s.active,status:s.active?'active':s.cadence.type==='once'&&s.nextRunAt===null&&this.running?.scheduleId!==s.id&&s.runs[0]?.status==='completed'?'completed':'paused',nextRunAt:s.nextRunAt,runs:clone(s.runs)};}
  view(){return {schedules:this.schedules.map(s=>this.publicSchedule(s)),runningId:this.running?.scheduleId??null,warning:this.warning,historyTruncated:this.historyTruncated,recoveryAvailable:this.recoveryAvailable&&!this.running&&!this.pendingExecution&&!this.#recoveries.size};}
  find(value){id(value);const s=this.schedules.find(s=>s.id===value);if(!s)throw new Error('Unknown schedule.');return s;}
  async project(cwd,expected,signal){
    string(cwd,4096,'project path');if(!isAbsolute(cwd))throw new Error('Project path must be absolute.');const canonical=await realpath(cwd),object=await this.#object(canonical,signal);if(expected&&(canonical!==cwd||!sameFilesystemIdentity(object.identity,expected)))throw new Error('Project identity changed or was replaced; save it again after review.');await this.assertProject(cwd);if(!samePin(object.pin,pin(await lstat(canonical,{bigint:true})))||await realpath(cwd)!==canonical)throw new Error('Project changed during verification.');return {cwd:canonical,identity:object.identity};
  }
  request(input){
    if(input?.action==='save'){shape(input,['action','id','name','cwd','prompt','effort','model','cadence',...(Object.hasOwn(input,'executionMode')?['executionMode']:[])]);validateModelID(input.model);executionMode(input);if(input.id!==null)id(input.id);string(input.name,120,'schedule name');string(input.cwd,4096,'project path');string(input.prompt,20000,'prompt',true);if(!['none','high'].includes(input.effort))throw new Error('Invalid reasoning effort.');cadence(input.cadence);}
    else if(['resume','run'].includes(input?.action)){shape(input,['action','id']);id(input.id);}else throw new Error('Unknown schedule review request.');return clone(input);
  }
  async prepare(request,epoch){
    const req=this.request(request),saved=req.id?this.find(req.id):null;if(req.action==='save'&&!saved&&this.schedules.length>=32)throw new Error('Schedule limit of 32 reached.');if(saved&&this.running?.scheduleId===saved.id&&req.action!=='run')throw new Error('Pause the running schedule before editing or resuming it.');
    if(req.action==='save'){if(saved?.executionMode==='native'&&!Object.hasOwn(req,'executionMode'))throw new Error('Editing a native schedule requires an explicit execution mode.');req.executionMode=executionMode(req);}
    const project=await this.project(req.action==='save'?req.cwd:saved.cwd,req.action==='save'?null:saved.identity);this.checkEpoch(epoch);if(req.action==='save')req.cwd=project.cwd;
    const anchor=req.action==='save'?this.now():saved.anchor,c=req.action==='save'?req.cadence:saved.cadence;
    const nextRunAt=req.action==='run'?this.now():req.action==='save'&&c.type==='once'?c.at:occurrence(c,anchor,this.now(),true);if(req.action==='resume'&&nextRunAt===null)throw new Error('This one-time schedule is past; edit its time or choose Run now.');
    for(const [key,p]of this.plans)if(p.expiresAt<=this.now())this.plans.delete(key);if(this.plans.size>=32)throw new Error('Too many pending schedule reviews.');
    const plan={id:randomUUID(),request:req,...(saved&&req.action!=='save'?{definition:{...Object.fromEntries(['name','cwd','prompt','effort','cadence','active'].map(k=>[k,clone(saved[k])])),model:scheduleModel(saved),executionMode:executionMode(saved)}}:{}),project,model:req.action==='save'?req.model:scheduleModel(saved),nextRunAt,expiresAt:this.now()+120000};this.plans.set(plan.id,{...clone(plan),epoch,revision:saved?.revision??null,anchor});return {plan};
  }
  async commit(planId,epoch){
    id(planId);const p=this.plans.get(planId);this.plans.delete(planId);if(!p||p.kind==='recover-paused'||p.expiresAt<=this.now())throw new Error('Schedule plan expired, consumed or unknown.');this.checkEpoch(p.epoch);let s=p.request.id?this.find(p.request.id):null;if(s&&s.revision!==p.revision)throw new Error('Schedule changed after review.');await this.project(p.project.cwd,p.project.identity);this.checkEpoch(epoch);
    if(p.request.action==='run'){if(this.running)throw new Error('Another scheduled run is busy; Run now was not queued.');return {scheduleId:s.id,admission:this.launch(s,true,this.now())};}
    if(s&&this.running?.scheduleId===s.id)throw new Error('Pause the running schedule before changing it.');
    if(p.request.action==='save'){
      if(!s){if(this.schedules.length>=32)throw new Error('Schedule limit of 32 reached.');s={id:randomUUID(),createdAt:this.now(),revision:0,runs:[]};this.schedules.push(s);}
      Object.assign(s,{name:p.request.name,cwd:p.project.cwd,identity:p.project.identity,prompt:p.request.prompt,effort:p.request.effort,model:p.request.model,cadence:p.request.cadence,anchor:p.anchor});
      if(p.request.executionMode==='native')s.executionMode='native';else delete s.executionMode;
    }Object.assign(s,{active:true,nextRunAt:p.nextRunAt,updatedAt:this.now(),revision:s.revision+1});await this.save();this.checkEpoch(epoch);this.arm();return {scheduleId:s.id};
  }
  launch(s,manual,scheduledFor){
    const mode=executionMode(s),model=scheduleModel(s);let admitted;const admission=new Promise(resolve=>{admitted=resolve;});const run={scheduleId:s.id,revision:s.revision,controller:new AbortController(),manual,scheduledFor,claimed:false,record:null,admitted};this.running=run;
    const callbackCheck=(identityOnly=false)=>{if(this.running!==run||!identityOnly&&(run.controller.signal.aborted||this.closed)||this.blocked||run.record&&TERMINAL.includes(run.record.status))throw new Error('Scheduled run is cancelled or already finished.');};
    const check=()=>{callbackCheck();if(s.revision!==run.revision||!manual&&!s.active)throw new Error('Scheduled run cancelled before admission.');};
    run.promise=Promise.resolve().then(async()=>{
      try{
        check();await this.project(s.cwd,s.identity,run.controller.signal);check();this.pendingExecution??=run;const result=await this.coding.runScheduled({cwd:s.cwd,prompt:s.prompt,effort:s.effort,model,executionMode:mode,signal:run.controller.signal,
          onClaim:()=>this.enqueue(async()=>{await this.load();check();if(run.claimed)throw new Error('Scheduled occurrence already claimed.');await this.project(s.cwd,s.identity,run.controller.signal);check();const at=this.now();run.record={id:randomUUID(),scheduledFor,startedAt:at,finishedAt:null,status:'claimed',threadId:null,turnId:null,message:'Occurrence claimed before starting a new chat.',manual};s.runs.unshift(run.record);run.claimed=true;if(!manual){s.nextRunAt=occurrence(s.cadence,s.anchor,Math.max(at,scheduledFor),true);if(s.nextRunAt===null)s.active=false;}await this.save();run.admitted('claimed');if(run.controller.signal.aborted||this.closed)throw new Error('Scheduled run cancelled after durable claim.');}),
          onThread:threadId=>this.enqueue(async()=>{callbackCheck();await this.load();callbackCheck();if(!run.claimed)throw new Error('Chat reported before durable occurrence claim.');engineId(threadId);if(run.record.threadId&&run.record.threadId!==threadId)throw new Error('Scheduled chat identity changed.');run.record.threadId=threadId;run.record.status='running';await this.save();if(run.controller.signal.aborted||this.closed)throw new Error('Scheduled run cancelled before inference.');}),
          // The turn is already admitted: recording its identity remains necessary during cancellation.
          onTurn:turnId=>this.enqueue(async()=>{callbackCheck(true);await this.load();callbackCheck(true);if(!run.claimed||!run.record.threadId)throw new Error('Turn reported before its chat was saved.');engineId(turnId);if(run.record.turnId&&run.record.turnId!==turnId)throw new Error('Scheduled turn identity changed.');run.record.turnId=turnId;await this.save();})
        });
        await this.finish(run,s,result);
      }catch(e){
        if(!run.claimed&&e.code==='PROJECT_BUSY'){run.busy=true;this.warning='Project is busy; '+(manual?'Run now did not start and was not queued.':'the due scheduled occurrence is waiting.');}
        else if(run.claimed)await this.finish(run,s,{status:run.controller.signal.aborted?'interrupted':'unknown',message:message(e)});
        else if(!run.controller.signal.aborted&&!this.closed)await this.enqueue(async()=>{s.active=false;this.warning='Scheduled work did not start: '+message(e);if(!this.blocked)await this.save();});
      }finally{run.admitted(run.busy?'busy':'not-started');if(this.running===run)this.running=null;}
    }).catch(e=>{this.warning='Scheduled run could not be recorded: '+message(e);}).finally(()=>{run.admitted();if(this.running===run)this.running=null;});
    return admission;
  }
  async finish(run,s,result){
    await this.enqueue(async()=>{
      if(!run.claimed){if(result?.status==='interrupted'&&run.controller.signal.aborted)return;throw new Error('Coding runner returned without claiming an occurrence.');}
      if(this.blocked)return;await this.load();let status=TERMINAL.includes(result?.status)?result.status:'unknown',text=typeof result?.message==='string'?result.message:'Coding runner returned no confirmed terminal outcome.';
      if(result?.threadId&&result.threadId!==run.record.threadId||result?.turnId&&result.turnId!==run.record.turnId){status='unknown';text='Coding result identifiers did not match the saved occurrence.';}
      Object.assign(run.record,{status,finishedAt:this.now(),message:text.slice(0,1600)});if(['needs-review','unknown'].includes(status)){s.active=false;this.warning='Schedule paused: '+run.record.message;}else if(!this.closed)this.warning='';await this.save();
    });
  }
  arm(){if(!this.started||this.closed||this.blocked||this.timer||!this.schedules.some(s=>s.active))return;this.timer=this.setTimer(async()=>{this.timer=null;await this.tick();this.arm();},1000);this.timer?.unref?.();}
  async tick(){
    const epoch=this.epoch,attempted=new Set();
    try{while(attempted.size<32){
      const pending=await this.enqueue(async()=>{if(this.closed||this.blocked||this.running||epoch!==this.epoch)return;await this.load();if(this.closed||this.blocked||this.running||epoch!==this.epoch)return;const s=this.schedules.filter(s=>!attempted.has(s.id)&&s.active&&s.nextRunAt!==null&&s.nextRunAt<=this.now()).sort((a,b)=>a.nextRunAt-b.nextRunAt)[0];if(!s)return;attempted.add(s.id);const latest=occurrence(s.cadence,s.anchor,this.now(),false);return {admission:this.launch(s,false,Math.max(s.nextRunAt,latest??s.nextRunAt))};});
      // Only a preclaim busy project yields to another due definition; never overlap claimed work.
      if(!pending||await pending.admission!=='busy')break;
    }}catch(e){this.warning=message(e);}
  }
  async start(){if(this.closed)throw new Error('Scheduler is closed.');if(this.started)return;this.started=true;await this.enqueue(()=>this.load()).catch(()=>{});this.arm();}
  async handle(input,{signal}={}){
    const fields={list:['action'],prepare:['action','request'],commit:['action','planId'],prepareRecovery:['action'],commitRecovery:['action','planId'],pause:['action','id'],stop:['action'],delete:['action','id']};if(!fields[input?.action])throw new Error('Unknown schedule action.');shape(input,fields[input.action]);if(input.action==='stop')return this.stop();if(input.action==='pause')return this.pause(id(input.id));if(input.action==='delete')id(input.id);if(input.action==='prepare')this.request(input.request);if(['commit','commitRecovery'].includes(input.action))id(input.planId);
    const epoch=this.epoch;
    if(['prepareRecovery','commitRecovery'].includes(input.action))return this.recovery(input.action,input.planId,epoch,signal);
    if(input.action==='list')return this.enqueue(async()=>{try{await this.load();}catch{}return this.view();});
    const result=await this.enqueue(async()=>{await this.load();this.checkEpoch(epoch);if(input.action==='prepare')return this.prepare(input.request,epoch);if(input.action==='commit')return this.commit(input.planId,epoch);const s=this.find(input.id);if(s.active||this.running?.scheduleId===s.id)throw new Error('Only an idle paused schedule can be deleted.');this.schedules=this.schedules.filter(x=>x!==s);await this.save();return this.view();});
    if(input.action!=='commit')return result;if(result.admission)await result.admission;return this.enqueue(()=>({schedule:this.publicSchedule(this.find(result.scheduleId)),...this.view()}));
  }
  async pause(value){
    // Epoch revokes pending reviews; only this schedule's run may abort its live project inspection.
    id(value);this.epoch++;this.plans.clear();const recovery=this.#recoveryOperation;for(const operation of this.#recoveries)operation.controller.abort();const running=this.running?.scheduleId===value?this.running:null;running?.controller.abort();
    try{await this.enqueue(async()=>{if(recovery)return;await this.load();const s=this.find(value);s.active=false;s.revision++;s.updatedAt=this.now();await this.save();});}finally{if(running)await running.promise;}return this.enqueue(()=>this.view());
  }
  async stop(){
    this.epoch++;this.plans.clear();const recovery=this.#recoveryOperation;for(const operation of this.#recoveries)operation.controller.abort();for(const controller of this.#identityOperations)controller.abort();const running=this.running;running?.controller.abort();
    try{await this.enqueue(async()=>{if(recovery)return;await this.load();let changed=false;for(const s of this.schedules)if(s.active){s.active=false;s.revision++;s.updatedAt=this.now();changed=true;}if(changed)await this.save();});}catch(error){if(!this.blocked)throw error;}finally{if(running)await running.promise;}
    return this.enqueue(()=>this.currentStopResult());
  }
  currentStopResult(){
    // A run result can precede physical disposal, even when it says interrupted.
    // ponytail: Whole-Coding closure is conservative even after completion; add per-run settlement proof only if needed.
    if(!this.running&&(this.coding.shutdownUnconfirmed===false||this.coding.closed===true&&this.coding.closeSettled===true&&this.coding.exitUnconfirmed===false))this.pendingExecution=null;
    return {...this.view(),stopped:!this.running&&!this.pendingExecution&&!this.#recoveries.size,...(this.blocked?{persistence:this.blockedPhase==='load'?'not-attempted':'failed',blocked:true,message:(this.blockedPhase==='load'?'Schedule persistence was not attempted; schedules remain blocked. ':'Schedule persistence failed; schedules remain blocked. ')+this.blockedCause}:{})};
  }
  close(){
    if(this.closing)return this.closing;this.closed=true;this.epoch++;this.plans.clear();for(const operation of this.#recoveries)operation.controller.abort();for(const controller of this.#identityOperations)controller.abort();this.clearTimer(this.timer);this.timer=null;const running=this.running;running?.controller.abort();
    this.closing=(async()=>{if(running)await running.promise;await this.queue;return this.view();})();return this.closing;
  }
}
