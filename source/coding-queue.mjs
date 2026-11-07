import {mkdir,open,lstat,realpath,rename,readdir,link,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join,normalize} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFilesystemIdentity,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import './attachments.js';

const MAX_BYTES=64*1024*1024,MAX_ITEMS=128,MAX_ROOTS=64;
const sha=value=>createHash('sha256').update(value).digest('hex');
const copy=value=>structuredClone(value);
const shape=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw Error('Invalid follow-up queue fields.');};
const uuid=value=>{if(typeof value!=='string'||! /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))throw Error('Invalid follow-up identifier.');return value;};
const text=(value,max)=>{if(typeof value!=='string'||!value.trim()||!value.isWellFormed()||value.length>max||/[\0\r\n]/.test(value))throw Error('Invalid follow-up identity text.');return value;};
const engineId=value=>{text(value,160);if(!/^[\w.-]+$/.test(value))throw Error('Invalid Coding identity.');return value;};
const integer=value=>{if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid follow-up revision or time.');return value;};
const stable=value=>{if(!isFilesystemIdentity(value))throw Error('Invalid follow-up filesystem identity.');return value;};
const errorMessage=error=>String(error?.message??error).slice(0,1600);
const cancelled=()=>Object.assign(Error('Follow-up operation was cancelled by Stop or shutdown.'),{code:'QUEUE_CANCELLED'});
const pin=(s,file=false)=>Object.fromEntries((file?['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs']:['dev','ino','mode','uid']).map(k=>[k,String(s[k])]));
const samePin=(a,b,renamed=false)=>!!a&&!!b&&Object.keys(a).every(k=>renamed&&k==='ctimeNs'||a[k]===b[k]);
const finalStates=['completed','failed','interrupted','unknown','removed'];

export function validateQueueBinding(value){
 shape(value,['version','ownerId','home','rootThreadId','cwd','projectIdentity','provider','model','executionMode']);
 if(value.version!==1)throw Error('Unsupported follow-up binding version.');
 uuid(value.ownerId);stable(value.home);engineId(value.rootThreadId);stable(value.projectIdentity);text(value.cwd,4096);text(value.model,200);
 if(!isAbsolute(value.cwd)||normalize(value.cwd)!==value.cwd||!['local','cloud'].includes(value.provider)||!['native','vm'].includes(value.executionMode))throw Error('Invalid follow-up project, provider or execution mode.');
 const {version,ownerId,rootThreadId,cwd,provider,model,executionMode}=value;
 return {version,ownerId,home:{volumeUUID:value.home.volumeUUID,ino:value.home.ino},rootThreadId,cwd,projectIdentity:{volumeUUID:value.projectIdentity.volumeUUID,ino:value.projectIdentity.ino},provider,model,executionMode};
}
export function normalizeQueueRequest(value){
 shape(value,['text','attachments','effort',...(Object.hasOwn(value??{},'mode')?['mode']:[])]);
 if(!['none','high'].includes(value.effort))throw Error('Invalid follow-up reasoning effort.');
 if(Object.hasOwn(value,'mode')&&!['build','plan'].includes(value.mode))throw Error('Invalid follow-up task mode.');
 const request={text:value.text,attachments:globalThis.SalehAttachments.normalize(value.attachments),effort:value.effort,...(Object.hasOwn(value,'mode')?{mode:value.mode}:{})};
 globalThis.SalehAttachments.codingInput(request);return copy(request);
}
const acceptanceHash=(binding,request)=>sha(JSON.stringify([binding,request]));

// Only the owner coordinator supplies bindings and claim/turn receipts. This
// ledger never grants execution authority and never retries a claimed send.
export class CodingQueue {
 #data=null; #serial=Promise.resolve(); #identityReader; #directoryPin=null; #disk=null;
 #blocked=null; #epoch=0; #rootEpochs=new Map(); #paused=new Set(); #allPaused=false; #closed=false;
 constructor({dataDir,nativeHelper,identityReader}={}){
  if(typeof dataDir!=='string'||!isAbsolute(dataDir)||normalize(dataDir)!==dataDir||dataDir.includes('\0'))throw Error('Queue requires a canonical absolute data directory.');
  if(identityReader!==undefined&&typeof identityReader!=='function')throw Error('Invalid queue identity reader.');
  this.dataDir=dataDir;this.ledger=join(dataDir,'coding-queue.json');
  this.#identityReader=identityReader??(options=>readFilesystemIdentity({...options,nativeHelper}));
 }
 #enqueue(fn){const result=this.#serial.then(fn);this.#serial=result.catch(()=>{});return result;}
 #ticket(root){return {root,epoch:this.#epoch,revision:this.#rootEpochs.get(root)??0};}
 #check(ticket){if(this.#closed||ticket.epoch!==this.#epoch||ticket.revision!==(this.#rootEpochs.get(ticket.root)??0))throw cancelled();if(this.#blocked)throw Error(this.#blocked);}
 #block(error){this.#blocked??='Follow-up storage is blocked; retained records were not reset. '+errorMessage(error);this.#allPaused=true;return Error(this.#blocked);}
 async #directory(){
  const s=await lstat(this.dataDir,{bigint:true});
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(this.dataDir)!==this.dataDir)throw Error('Queue directory is not a private canonical directory.');
  if(this.#directoryPin&&!samePin(this.#directoryPin,pin(s)))throw Error('Queue directory identity changed.');
  this.#directoryPin??=pin(s);return s;
 }
 async #read(path){
  await this.#directory();let present;try{present=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!present.isFile()||present.isSymbolicLink()||present.uid!==BigInt(process.getuid())||(present.mode&0o077n)||present.nlink!==1n||present.size>BigInt(MAX_BYTES))throw Error('Queue ledger type, ownership, permissions or size is invalid.');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=await file.stat({bigint:true});if(!samePin(pin(before,true),pin(present,true)))throw Error('Queue ledger changed while opening.');
   const bytes=await file.readFile();
   if(bytes.length>MAX_BYTES||!samePin(pin(before,true),pin(await file.stat({bigint:true}),true))||!samePin(pin(before,true),pin(await lstat(path,{bigint:true}),true)))throw Error('Queue ledger changed while reading.');
   await this.#directory();return {bytes,hash:sha(bytes),pin:pin(before,true)};
  }finally{await file.close();}
 }
 async #checkDisk(){const current=await this.#read(this.ledger);if((current?.hash??null)!==(this.#disk?.hash??null)||Boolean(current)!==Boolean(this.#disk)||current&&!samePin(current.pin,this.#disk.pin))throw Error('Queue ledger changed externally; inspect it before continuing.');}
 async #checkTemporaries(){
  const names=(await readdir(this.dataDir)).filter(name=>name.startsWith('coding-queue.json.')),retained=names.filter(name=>name.endsWith('.tmp'));
  await this.#directory();
  if(retained.length)throw Error('Interrupted follow-up publication retained: '+retained[0].slice(0,200)+'. Inspect the retained files before further queue writes.');
  const cancelled=names.filter(name=>name.endsWith('.tmp.cancelled'));let bytes=0n;
  for(const name of cancelled){const info=await lstat(join(this.dataDir,name),{bigint:true});if(!info.isFile()||info.isSymbolicLink()||info.uid!==BigInt(process.getuid())||(info.mode&0o077n)||info.nlink!==1n)throw Error('Retained cancelled publication identity or permissions changed.');bytes+=info.size;}
  await this.#directory();
  if(cancelled.length>=MAX_ITEMS||bytes>=BigInt(MAX_BYTES))throw Error('Retained cancelled follow-up publications reached the inspection limit; all bytes were kept.');
 }
 async #syncDirectory(){
  const directory=await open(this.dataDir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{if(!samePin(this.#directoryPin,pin(await directory.stat({bigint:true}))))throw Error('Queue directory changed before sync.');await directory.sync();}finally{await directory.close();}
 }
 #validate(data){
  shape(data,['version','directory','revision','groups']);stable(data.directory);integer(data.revision);
  if(data.version!==1||!Array.isArray(data.groups)||data.groups.length>MAX_ROOTS)throw Error('Invalid follow-up queue schema.');
  const roots=new Set(),ids=new Set();
  for(const group of data.groups){
   shape(group,['binding','active','revision','nextSequence','items']);validateQueueBinding(group.binding);integer(group.revision);integer(group.nextSequence);
   if(typeof group.active!=='boolean'||!Array.isArray(group.items)||roots.has(group.binding.rootThreadId))throw Error('Invalid or duplicate follow-up root.');roots.add(group.binding.rootThreadId);
   const sequences=new Set();let inFlight=0;
   for(const item of group.items){
    shape(item,['id','sequence','revision','acceptanceHash','request','status','claim','turnId','message','createdAt','updatedAt']);uuid(item.id);integer(item.sequence);integer(item.revision);integer(item.createdAt);integer(item.updatedAt);normalizeQueueRequest(item.request);
    if(ids.has(item.id)||sequences.has(item.sequence)||item.sequence>=group.nextSequence||item.updatedAt<item.createdAt||typeof item.acceptanceHash!=='string'||! /^[a-f0-9]{64}$/.test(item.acceptanceHash))throw Error('Invalid or duplicate follow-up item.');ids.add(item.id);sequences.add(item.sequence);
    if(!['queued','claimed','acknowledged',...finalStates].includes(item.status)||typeof item.message!=='string'||item.message.length>1600)throw Error('Invalid follow-up status.');
    if(['queued','removed'].includes(item.status)){if(item.claim!==null||item.turnId!==null)throw Error('Unsent follow-up has a dispatch receipt.');}
    else{
     shape(item.claim,['id','generation']);uuid(item.claim.id);uuid(item.claim.generation);
     if(item.turnId!==null)engineId(item.turnId);
     if(['acknowledged','completed'].includes(item.status)&&item.turnId===null||item.status==='claimed'&&item.turnId!==null)throw Error('Follow-up turn receipt is missing or inconsistent.');
    }
    if(['claimed','acknowledged'].includes(item.status))inFlight++;
   }
   if(inFlight>1)throw Error('A root has overlapping follow-up claims.');
  }
  if(ids.size>MAX_ITEMS)throw Error('Follow-up storage limit reached; no existing records were removed.');
 }
 async #save(next,check=()=>{}){
  this.#validate(next);const bytes=Buffer.from(JSON.stringify(next));
  if(bytes.length>MAX_BYTES)throw Error('Follow-up storage exceeds 64 MiB; no existing records were removed.');
  let published=false,temp,written;
  try{
   check();await this.#checkDisk();check();
   temp=this.ledger+'.'+randomUUID()+'.tmp';const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
   written=await this.#read(temp);if(written?.hash!==sha(bytes))throw Error('Temporary follow-up ledger changed.');
   await this.#checkDisk();check();
   // ponytail: The existing coordinator lease provides one writer. Supporting
   // arbitrary external writers requires a CAS publication protocol, not retries.
   await rename(temp,this.ledger);published=true;
   await this.#syncDirectory();
   const committed=await this.#read(this.ledger);
   if(committed?.hash!==written.hash||!samePin(written.pin,committed.pin,true))throw Error('Published follow-up ledger changed.');
   this.#disk=committed;this.#data=next;
  }catch(error){
   if(!published&&error.code==='QUEUE_CANCELLED'){
    if(temp)try{
     const current=await this.#read(temp);if(!written||current?.hash!==written.hash||!samePin(current.pin,written.pin))throw Error('Cancelled follow-up stage changed before retention.');
     await this.#checkDisk();const retained=temp+'.cancelled';await link(temp,retained);
     // link refuses an existing destination. Both names must still identify
     // this writer's stage before its unpublished temporary name is removed.
     const linked=await lstat(temp,{bigint:true}),kept=await lstat(retained,{bigint:true}),expected={...written.pin,nlink:'2'};
     if(!samePin(expected,pin(linked,true),true)||!samePin(expected,pin(kept,true),true))throw Error('Cancelled follow-up stage changed before retention completed.');
     await unlink(temp);await this.#syncDirectory();
     const saved=await this.#read(retained);if(saved?.hash!==written.hash||!samePin(saved.pin,written.pin,true))throw Error('Cancelled follow-up stage changed during retention.');
    }catch(failure){throw this.#block(failure);}
    throw error;
   }
   throw this.#block(error);
  }
 }
 async #load(){
  if(this.#blocked)throw Error(this.#blocked);
  try{
   if(this.#data){await this.#checkDisk();await this.#checkTemporaries();return;}
   await mkdir(this.dataDir,{recursive:true,mode:0o700});const before=await this.#directory();
   const directory=stable(await this.#identityReader({path:this.dataDir}));
   if(directory.ino!==String(before.ino))throw Error('Queue directory identity differs from its open path.');await this.#directory();
   this.#disk=await this.#read(this.ledger);
   if(!this.#disk){this.#data={version:1,directory,revision:1,groups:[]};await this.#checkTemporaries();return;}
   const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.#disk.bytes));this.#validate(data);
   if(!sameFilesystemIdentity(data.directory,directory))throw Error('Saved queue directory was replaced.');
   this.#data=data;await this.#checkTemporaries();const next=copy(data);let changed=false;
   for(const group of next.groups){
    let rootChanged=group.active;group.active=false;
    for(const item of group.items)if(['claimed','acknowledged'].includes(item.status)){
     item.status='unknown';item.message='Restart interrupted observation; this claimed follow-up will not be sent again automatically.';item.updatedAt=Math.max(Date.now(),item.updatedAt);item.revision++;rootChanged=true;
    }
    if(rootChanged){group.revision++;changed=true;}
   }
   if(changed){next.revision++;await this.#save(next);}
  }catch(error){throw this.#block(error);}
 }
 #group(data,root){const group=data.groups.find(g=>g.binding.rootThreadId===root);if(!group)throw Error('Unknown follow-up root.');return group;}
 #find(data,id){for(const group of data.groups){const item=group.items.find(i=>i.id===id);if(item)return {group,item};}throw Error('Unknown follow-up item.');}
 #revision(value,expected){integer(expected);if(value.revision!==expected)throw Object.assign(Error('Follow-up revision changed; refresh before editing.'),{code:'QUEUE_STALE'});}
 #touch(data,group,item){data.revision++;group.revision++;if(item){item.revision++;item.updatedAt=Math.max(Date.now(),item.updatedAt);}}
 #head(group){if(!group.active||this.#allPaused||this.#paused.has(group.binding.rootThreadId)||group.items.some(i=>['claimed','acknowledged','unknown'].includes(i.status)))return null;return group.items.find(i=>i.status==='queued')??null;}
 inspect(){return this.#enqueue(async()=>{try{await this.#load();}catch{}return {...copy(this.#data??{version:1,revision:0,groups:[]}),blocked:!!this.#blocked,warning:this.#blocked??''};});}
 head(root){engineId(root);return this.#enqueue(async()=>{await this.#load();return copy(this.#head(this.#group(this.#data,root)));});}
 accept(value,check=()=>{}){
  if(typeof check!=='function')throw Error('Invalid trusted follow-up admission check.');
  shape(value,['id','binding','request']);const id=uuid(value.id),binding=validateQueueBinding(value.binding),request=normalizeQueueRequest(value.request),hash=acceptanceHash(binding,request),ticket=this.#ticket(binding.rootThreadId);
  return this.#enqueue(async()=>{
   await this.#load();this.#check(ticket);
   for(const group of this.#data.groups){const item=group.items.find(i=>i.id===id);if(item){if(item.acceptanceHash!==hash||!isDeepStrictEqual(group.binding,binding))throw Error('Follow-up identifier conflicts with a different accepted request.');return copy(item);}}
   const next=copy(this.#data);let group=next.groups.find(g=>g.binding.rootThreadId===binding.rootThreadId);
   if(group&&!isDeepStrictEqual(group.binding,binding))throw Error('Follow-up owner, project or model binding changed.');
   if(!group){group={binding,active:!this.#allPaused&&!this.#paused.has(binding.rootThreadId),revision:1,nextSequence:1,items:[]};next.groups.push(group);}
   const now=Date.now(),item={id,sequence:group.nextSequence++,revision:1,acceptanceHash:hash,request,status:'queued',claim:null,turnId:null,message:'Saved for the next turn.',createdAt:now,updatedAt:now};group.items.push(item);this.#touch(next,group);
   await this.#save(next,()=>{this.#check(ticket);check();});return copy(item);
  });
 }
 #editItem(id,revision,edit){
  uuid(id);integer(revision);const epoch=this.#epoch,versions=new Map(this.#rootEpochs);
  return this.#enqueue(async()=>{await this.#load();const next=copy(this.#data),{group,item}=this.#find(next,id),ticket={root:group.binding.rootThreadId,epoch,revision:versions.get(group.binding.rootThreadId)??0};this.#check(ticket);this.#revision(item,revision);if(item.status!=='queued')throw Error('Only queued, unsent follow-ups can be edited or removed.');edit(item);this.#touch(next,group,item);await this.#save(next,()=>this.#check(ticket));return copy(item);});
 }
 edit(id,revision,request){const normalized=normalizeQueueRequest(request);return this.#editItem(id,revision,item=>{item.request=normalized;});}
 remove(id,revision){return this.#editItem(id,revision,item=>{item.status='removed';item.message='Removed before sending.';});}
 reorder(root,revision,ids){
  engineId(root);integer(revision);if(!Array.isArray(ids)||ids.length>MAX_ITEMS||new Set(ids).size!==ids.length)throw Error('Invalid follow-up order.');ids=ids.map(uuid);const ticket=this.#ticket(root);
  return this.#enqueue(async()=>{await this.#load();this.#check(ticket);const next=copy(this.#data),group=this.#group(next,root);this.#revision(group,revision);const queued=group.items.filter(i=>i.status==='queued');if(queued.length!==ids.length||ids.some(id=>!queued.some(i=>i.id===id)))throw Error('Order must include every queued follow-up exactly once.');const ordered=ids.map(id=>queued.find(i=>i.id===id));let index=0;group.items=group.items.map(item=>item.status==='queued'?ordered[index++]:item);this.#touch(next,group);await this.#save(next,()=>this.#check(ticket));return copy(group);});
 }
 resume(root,revision,check=()=>{}){
  if(typeof check!=='function')throw Error('Invalid trusted follow-up admission check.');
  engineId(root);integer(revision);const ticket=this.#ticket(root);
  return this.#enqueue(async()=>{await this.#load();this.#check(ticket);const next=copy(this.#data),group=this.#group(next,root);this.#revision(group,revision);if(group.items.some(i=>['claimed','acknowledged','unknown'].includes(i.status)))throw Error('A follow-up has an active or unknown outcome; verify it before resuming.');group.active=true;this.#touch(next,group);await this.#save(next,()=>{this.#check(ticket);check();});if(ticket.epoch===this.#epoch&&ticket.revision===(this.#rootEpochs.get(root)??0)){this.#paused.delete(root);this.#allPaused=false;}return copy(group);});
 }
 pause(root){engineId(root);this.#rootEpochs.set(root,(this.#rootEpochs.get(root)??0)+1);this.#paused.add(root);return this.#enqueue(async()=>{await this.#load();const next=copy(this.#data),group=next.groups.find(g=>g.binding.rootThreadId===root);if(group?.active){group.active=false;this.#touch(next,group);await this.#save(next);}return copy(group??null);});}
 pauseAll(){this.#epoch++;this.#allPaused=true;return this.#enqueue(async()=>{await this.#load();const next=copy(this.#data);let changed=false;for(const group of next.groups)if(group.active){group.active=false;this.#touch(next,group);changed=true;}if(changed)await this.#save(next);});}
 claim(id,revision,attempt){
  uuid(id);integer(revision);shape(attempt,['generation']);const generation=uuid(attempt.generation),epoch=this.#epoch,versions=new Map(this.#rootEpochs);
  return this.#enqueue(async()=>{await this.#load();const next=copy(this.#data),{group,item}=this.#find(next,id),ticket={root:group.binding.rootThreadId,epoch,revision:versions.get(group.binding.rootThreadId)??0};this.#check(ticket);this.#revision(item,revision);const head=this.#head(group);if(head?.id!==id)throw Object.assign(Error('Follow-up is not the next queued item, or its queue is paused.'),{code:head?'QUEUE_STALE':'QUEUE_CANCELLED'});item.status='claimed';item.claim={id:randomUUID(),generation};item.message='Dispatch claimed; awaiting the exact turn receipt.';this.#touch(next,group,item);await this.#save(next,()=>this.#check(ticket));return copy(item.claim);});
 }
 #receipt(id,claimId,update){
  uuid(id);uuid(claimId);
  return this.#enqueue(async()=>{await this.#load();const next=copy(this.#data),{group,item}=this.#find(next,id);if(item.claim?.id!==claimId)throw Error('Follow-up claim identity changed.');const changed=update(item,group);if(changed!==false){this.#touch(next,group,item);await this.#save(next);}return copy(item);});
 }
 acknowledge(id,claimId,turnId){
  engineId(turnId);return this.#receipt(id,claimId,item=>{
   if(item.turnId!==null){if(item.turnId!==turnId)throw Error('Follow-up turn identity changed.');return false;}
   if(!['claimed','unknown','interrupted'].includes(item.status))throw Error('Follow-up cannot receive another turn receipt.');
   item.turnId=turnId;if(item.status==='claimed')item.status='acknowledged';item.message='Exact turn receipt saved; completion still requires verification.';
  });
 }
 finish(id,claimId,result){
  shape(result,['status','turnId','message']);if(!['completed','failed','interrupted','unknown'].includes(result.status)||typeof result.message!=='string'||result.message.length>1600)throw Error('Invalid follow-up outcome.');if(result.turnId!==null)engineId(result.turnId);result=copy(result);
  return this.#receipt(id,claimId,(item,group)=>{
   if(result.turnId!==item.turnId||result.status==='completed'&&item.turnId===null)throw Error('Follow-up outcome does not match its saved turn identity.');
   if(finalStates.includes(item.status)){
    if(item.status===result.status&&item.message===result.message)return false;
    // Exact retained outcomes can resolve uncertainty without requeueing or resuming work.
    if(item.status!=='unknown'||item.turnId===null||result.status==='unknown')throw Error('Follow-up already has a retained terminal outcome.');
   }
   item.status=result.status;item.message=result.message;if(item.status!=='completed')group.active=false;
  });
 }
 async close(){this.#closed=true;await this.pauseAll();}
}
