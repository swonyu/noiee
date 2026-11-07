import {mkdir,lstat,realpath,readdir,writeFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {GitRunner} from './git-runner.mjs';
import {GitWorkflow} from './git-workflow.mjs';
import {HandoffGit,admitGitSnapshot} from './handoff-git.mjs';
import {prepareProjectCopy,createOriginalCopy,readCopyBundle,COPY_RECEIPT_BYTES} from './handoff-copy.mjs';
import {readHandoffJSON} from './managed-worktrees.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,sha=b=>createHash('sha256').update(b).digest('hex');
const require=(ok,message)=>{if(!ok)throw Error('Failed startup continuation: '+message);};
const optional=async(path,max)=>{try{return await readHandoffJSON(path,null,max);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function directory(path,create=false){
 if(create)await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const s=await lstat(path,{bigint:true});require(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&!(s.mode&0o077n)&&await realpath(path)===path,'directory must be private and canonical');return {path,dev:String(s.dev),ino:String(s.ino)};
}
async function save(path,value){await writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});const fd=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
const gitWitness=s=>({repositoryId:s.r.repositoryId,commonRepositoryId:s.r.commonRepositoryId,fingerprint:s.fingerprint,headRaw:s.headRaw,index:s.index===null?null:sha(s.index),configFiles:s.configFiles});

// Only writes fresh private artifacts. The owner supplies the actual read lease,
// cold-owner proofs, cancellation and anchored native helper; no owner is adopted.
export class FailedStartupCopies {
 constructor({dataDir,nativeHelper,spawnProcess,nativeFiles,now=Date.now}){
  Object.assign(this,{dataDir,parent:join(dirname(dataDir),'Recovered Projects'),artifacts:join(dataDir,'Failed Startup Copies'),nativeFiles,now,plans:new Map(),workerCounts:new Map(),context:null,workerEntry:null});
  this.runner=new GitRunner({dataDir,nativeHelper,spawnProcess,processGuard:()=>nativeHelper&&this.workerEntry?receipt=>{this.recording=this.recordWorker('git',receipt);void this.recording.catch(()=>{});return this.recording;}:null});
  this.inspector=new GitWorkflow({dataDir,spawnProcess});this.inspector.runner=this.inspector.checkoutRunner={run:(args,options)=>this.git(args,options)};
 }
 get blocked(){return this.runner.blocked||!!this.worker||!!this.recording;}
 check(){require(this.context,'operation is no longer active');this.context.check();require(!this.runner.blocked,'worker closure is unconfirmed; retain output for inspection');}
 async run(context,fn){
  require(!this.context,'another recovery operation is busy');this.context=context;
  const abort=()=>this.runner.cancel();context.signal.addEventListener('abort',abort,{once:true});
  try{this.check();return await fn();}finally{context.signal.removeEventListener('abort',abort);this.context=null;this.workerEntry=null;}
 }
 async recordWorker(kind,receipt){
  this.check();require(this.workerEntry,'worker output is unbound');const parent=await directory(this.workerEntry),path=join(parent.path,'worker-'+randomUUID()+'.json');
  const count=this.workerCounts.get(parent.path)??(await readdir(parent.path)).filter(n=>/^worker-.*\.json$/.test(n)).length;require(count<65536,'private worker step budget reached; output retained without dispatching this step');this.workerCounts.set(parent.path,count+1);
  require(!this.worker,'another worker is still recorded');await save(path,{version:1,kind,receipt});const written=await readHandoffJSON(path,null);this.worker={path,parent,stamp:written.stamp};this.check();
 }
 async closeWorker(){if(this.worker){require(!this.runner.blocked,'worker closure is unconfirmed');const worker=this.worker;require(equal(await directory(worker.parent.path),worker.parent),'worker artifact directory changed');await readHandoffJSON(worker.path,worker.stamp);await save(worker.path+'.closed',{version:1,closed:true,workerSHA256:worker.stamp.hash});this.worker=null;}}
 async git(args,options={}){
  this.check();try{return await this.runner.run(args,{...options,check:()=>this.check()});}
  finally{let failure;try{await this.recording;}catch(error){failure=error;}finally{this.recording=null;}if(!this.runner.blocked)await this.closeWorker();if(failure)throw failure;}
 }
 async native(action,input){
  this.check();return this.nativeFiles(action,input,{signal:this.context.signal,check:()=>this.check(),...action==='copy'?{record:receipt=>this.recordWorker('copy',receipt),closed:()=>this.closeWorker()}:{} });
 }
 async roots(){
  const parent=await directory(this.parent,true),artifacts=await directory(this.artifacts,true);this.check();return {parent,artifacts};
 }
 async verifyWorkers(){
  for(const parent of [this.artifacts,this.parent]){
   let root;try{root=await directory(parent);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   const entries=await readdir(parent);require(entries.length<=256,'worker artifact inventory exceeds its bound');
   for(const name of entries){if(!UUID.test(name))continue;const entry=join(parent,name);await directory(entry);const names=await readdir(entry);require(names.length<=131104,'worker inventory exceeds its bound');
    for(const file of names.filter(n=>/^worker-[a-f0-9-]{36}\.json$/.test(n))){const record=await readHandoffJSON(join(entry,file),null),closed=await optional(join(entry,file+'.closed'));require(record.value.version===1&&['git','copy'].includes(record.value.kind)&&closed&&equal(closed.value,{version:1,closed:true,workerSHA256:record.stamp.hash}),'worker closure is unconfirmed; preserve artifacts and inspect before further tools');}
   }
   require(equal(await directory(parent),root),'worker artifact root changed');
  }
 }
 async isContinuation(row){
  if(row.executionMode!=='native'||row.state!=='ready'||!row.cwd.startsWith(this.parent+'/'))return false;
  const relative=row.cwd.slice(this.parent.length+1).split('/');if(relative.length!==2||!UUID.test(relative[0])||relative[1]!=='project')return false;
  const entry=join(this.parent,relative[0]);await directory(this.parent);await directory(entry);
  const intent=await optional(join(entry,'intent.json')),receipt=await optional(join(entry,'receipt.json'),COPY_RECEIPT_BYTES),target=await optional(join(entry,'target.json'));
  // Authenticate the independent project, including later chats at that same
  // project. Every reader/worker still participates in the real shared lease.
  return intent?.value?.plan?.operation==='failed-startup-copy'&&intent.value.plan.id===relative[0]&&intent.value.plan.target===row.cwd&&receipt?.value?.state==='complete'&&receipt.value.copy?.independent===true&&receipt.value.copy.id===relative[0]&&receipt.value.copy.target===row.cwd&&equal(target?.value?.binding,intent.value.owner)&&equal(await directory(row.cwd),receipt.value.project?.root);
 }
 async records(binding){
  let parent;try{parent=await directory(this.parent);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const names=await readdir(parent.path);require(names.length<=256,'recovered project inventory exceeds its limit');const records=[];
  for(const name of names){
   if(!UUID.test(name))continue;const entry=join(parent.path,name);await directory(entry);const intent=await optional(join(entry,'intent.json'));this.check();
   if(intent?.value?.plan?.operation!=='failed-startup-copy')continue;
   const v=intent.value,p=v.plan;require(v.version===1&&v.state==='preparing'&&p.id===name&&p.target===join(entry,'project')&&UUID.test(p.ownerId)&&UUID.test(p.generation)&&p.source===v.owner?.cwd&&p.ownerId===v.owner?.ownerId&&p.generation===v.owner?.generation&&p.model===v.owner?.model,'copy intent binding changed');
   if(p.ownerId!==binding.ownerId||p.generation!==binding.generation)continue;
   require(p.source===binding.cwd,'original project binding changed');
   const complete=await optional(join(entry,'receipt.json'),COPY_RECEIPT_BYTES),verified=await optional(join(entry,'target.json')),opening=await optional(join(entry,'open-intent.json')),opened=await optional(join(entry,'opened.json'));
   if(complete){const expected={...p,receiptPath:join(entry,'receipt.json'),independent:true,originalStartupRecovered:false};delete expected.expiresAt;require(equal(complete.value.copy,expected)&&complete.value.version===1&&complete.value.state==='complete'&&complete.value.originalsMutatedByCopy===false&&equal(complete.value.omitted,[]),'copy completion receipt differs');}
   require(!opened||opening&&complete&&verified&&opened.value.version===1&&opened.value.copyId===name&&typeof opened.value.threadId==='string','chat completion receipt differs');
   records.push({entry,intent,complete,verified,opening,opened});
  }
  require(equal(await directory(parent.path),parent),'recovered projects root changed');return records;
 }
 async list(binding){
  const listed=[];
  for(const r of await this.records(binding)){
   let state=r.opened?'opened':r.opening?'opening-unknown':r.complete?(r.verified?'verified-copy':'copy-needs-inspection'):'incomplete';
   if(state==='verified-copy')try{await this.verifyTarget(r);}catch(error){if(this.blocked)throw error;this.check();state='copy-changed';}
   listed.push({id:r.intent.value.plan.id,target:r.intent.value.plan.target,model:r.intent.value.plan.model,state,threadId:r.opened?.value.threadId??null});
  }
  return listed;
 }
 async prepare(binding){
  const records=await this.records(binding);require(!records.some(r=>r.complete||r.opening),'a continuation already exists; inspect it instead of creating another');
  await this.verifyWorkers();
  for(const [id,p] of this.plans){if(p.publicPlan.expiresAt<=this.now())this.plans.delete(id);else require(p.publicPlan.ownerId!==binding.ownerId,'a review already exists for this startup');}
  require(this.plans.size<32,'too many copy reviews');const roots=await this.roots();
  require((await readdir(roots.parent.path)).length<256&&(await readdir(roots.artifacts.path)).length<256,'retained recovery capacity reached; no additional entry was created');
  const artifact=join(roots.artifacts.path,randomUUID());await mkdir(artifact,{mode:0o700});this.workerEntry=artifact;
  const repository=await this.inspector.repository(binding.cwd,this.inspector.epoch);require(repository.cwd===binding.cwd,'Git checkout root differs from the original project');
  const source={path:binding.cwd,...repository.identities.cwd},native=await this.native('inventory',{root:source,exclude:[]});
  require(equal(Object.keys(native.excluded),['.git']),'nested or aliased Git metadata is unsupported');
  const donor={root:source,stamps:native.stamps,rootStamp:native.rootStamp,bytes:native.bytes},captured=await this.inspector.readState(repository,this.inspector.epoch,{includeDiff:false});
  const builder=new HandoffGit({directory:artifact,runner:{run:(args,options)=>this.git(args,options)},inspector:this.inspector,check:()=>this.check()}),snapshot=await builder.snapshot(captured),admitted=await admitGitSnapshot({snapshot,check:()=>this.check()});
  const encoded=JSON.stringify(binding),fingerprint=sha(JSON.stringify({binding,donor,snapshot}));
  const recheck=async()=>{this.check();require(JSON.stringify(this.context.binding)===encoded,'reviewed owner or model binding changed');await this.context.recheck();await admitted.reverify();await builder.verifySnapshotSource();const next=await this.native('inventory',{root:source,exclude:[]});require(equal(next,native),'original project content, metadata or namespace changed');this.check();};
  const currentRoot=async root=>{const s=await lstat(root.path,{bigint:true});require(s.isDirectory()&&!s.isSymbolicLink()&&String(s.dev)===root.dev&&String(s.ino)===root.ino&&await realpath(root.path)===root.path,'source root changed');return root;};
  const p=await prepareProjectCopy({review:{fingerprint},binding,snapshot,donor,parent:this.parent,currentRoot,readBundle:async()=>{await admitted.reverify();return readCopyBundle(snapshot.bundle.path,snapshot.bundle,{check:()=>this.check()});},native:(action,input)=>this.native(action,input),runGit:(args,options)=>this.git(args,options),check:()=>this.check(),recheck,now:this.now});
  p.binding=structuredClone(binding);p.artifact=artifact;this.plans.set(p.id,p);return {plan:p.publicPlan};
 }
 async create(id){
  const p=this.plans.get(id);this.plans.delete(id);require(p&&p.publicPlan.expiresAt>this.now(),'review expired, cancelled or consumed');this.workerEntry=p.entry;
  try{
  await save(join(p.entry,'copy-intent.json'),{version:1,id,binding:p.binding});const result=await createOriginalCopy(p);this.check();
  const r=await this.inspector.repository(result.copy.target,this.inspector.epoch),state=await this.inspector.readState(r,this.inspector.epoch,{includeDiff:false});
  await save(join(p.entry,'target.json'),{version:1,id,binding:p.binding,git:gitWitness(state)});this.check();return result;
  }catch(error){throw Error(error.message+' New output retained for inspection: '+p.entry,{cause:error});}
 }
 cancel(id){this.plans.delete(id);return {cancelled:true};}
 cancelAll(){this.plans.clear();}
 async verifyTarget(found){
  const {entry,complete,verified}=found,v=complete.value,plan=v.copy;
  await directory(entry);await directory(plan.target);const root=v.project.root;require(root.path===plan.target&&equal(await directory(plan.target),root),'verified copy root changed');
  const native=await this.native('inventory',{root,exclude:[]});require(equal(Object.keys(native.excluded),['.git'])&&equal(native.stamps,v.project.stamps)&&equal(native.rootStamp,v.project.rootStamp)&&native.bytes===v.project.bytes,'verified copy content or namespace changed');
  const r=await this.inspector.repository(plan.target,this.inspector.epoch),state=await this.inspector.readState(r,this.inspector.epoch,{includeDiff:false});require(equal(gitWitness(state),verified.value.git),'verified copy Git state changed');
  await readHandoffJSON(join(entry,'receipt.json'),complete.stamp,COPY_RECEIPT_BYTES);await readHandoffJSON(join(entry,'target.json'),verified.stamp);this.check();return plan;
 }
 async prepareOpen(binding,id){
  const found=(await this.records(binding)).find(r=>r.intent.value.plan.id===id);require(found?.complete&&found.verified&&!found.opening&&!found.opened,'copy is incomplete, already opened or has an uncertain opening');
  const {entry,verified}=found;require(found.complete.value.copy.model===binding.model&&equal(verified.value.binding,binding),'selected model or original owner evidence changed');
  const plan=await this.verifyTarget(found);
  await save(join(entry,'open-intent.json'),{version:1,copyId:id,model:binding.model,target:plan.target});this.check();
  return {cwd:plan.target,complete:async thread=>{require(thread?.cwd===plan.target&&thread.model===binding.model&&thread.modelProvider==='saleh_local'&&typeof thread.id==='string','new native chat differs from the verified copy');await save(join(entry,'opened.json'),{version:1,copyId:id,threadId:thread.id,cwd:thread.cwd,model:thread.model});}};
 }
}
