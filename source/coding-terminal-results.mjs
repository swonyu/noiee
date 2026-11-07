import {open,lstat,realpath,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,normalize,dirname,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const FILE='terminal-results.json',OUTPUT=262144,COMMAND=80000,RECORD=2097152,STORE=8388608,FINALIZED=16,PENDING=8,SUMMARY=65536,DETAIL=2162688;
const ROW=['recordId','ownerId','threadId','rootThreadId','ownerGeneration','cwd','command','output','createdAt','endedAt','state','exitCode','stopRequested','outputTruncated','droppedOutputBytes','observationComplete','error'];
const STATES=new Set(['intent','not-started','exited','unconfirmed']);
const exact=(v,keys)=>v!==null&&typeof v==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const bytes=v=>Buffer.byteLength(v,'utf8');
const wellFormed=v=>typeof v==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
const text=(v,max,empty=true)=>wellFormed(v)&&(empty||v.length>0)&&bytes(v)<=max;
const id=v=>text(v,160,false)&&!/[\x00-\x1f\x7f]/.test(v);
const pathText=v=>text(v,4096,false)&&isAbsolute(v)&&normalize(v)===v&&!/[\x00-\x1f\x7f]/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const hash=v=>createHash('sha256').update(v).digest('hex');
const version=s=>['dev','ino','mode','uid','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const renamedVersion=s=>['dev','ino','mode','uid','nlink','size','mtimeNs'].map(k=>String(s[k])).join(':');
const directoryVersion=s=>['dev','ino','mode','uid'].map(k=>String(s[k])).join(':');
function prefix(value,max){
 // At least one UTF-8 byte per UTF-16 unit: any surrogate cut by this bounded
 // slice begins beyond max bytes and cannot enter the retained prefix.
 const buffer=Buffer.from(value.slice(0,max+1));let end=Math.min(max,buffer.length);while(end>0&&(buffer[end]&0xc0)===0x80)end--;return buffer.subarray(0,end).toString('utf8');
}
function boundedRecord(row){
 if(bytes(JSON.stringify(row))<=RECORD)return row;
 const output=row.output;let low=0,high=bytes(output);
 while(low<high){const mid=Math.ceil((low+high)/2),candidate=prefix(output,mid),test={...row,output:candidate,outputTruncated:true,droppedOutputBytes:row.droppedOutputBytes+bytes(output)-bytes(candidate)};if(bytes(JSON.stringify(test))<=RECORD)low=mid;else high=mid-1;}
 row.output=prefix(output,low);row.droppedOutputBytes+=bytes(output)-bytes(row.output);row.outputTruncated=true;
 if(bytes(JSON.stringify(row))>RECORD)throw Error('Terminal result metadata exceeds its byte limit.');return row;
}

/** Evidence only. verifyHome must verify the coordinator's trusted durable home
 * binding; getThreadIds supplies this owner's committed catalog membership.
 * Neither callback may initialize the catalog during read-only inspection.
 * The coordinator owns one writer per live owner and drains it after finalizers.
 * ponytail: no cross-process writer framework; source stamps/hash fail closed on
 * external changes, while the existing owner lease fences cooperating writers.
 * The final source check and rename are not a hostile same-user pathname CAS.
 * droppedOutputBytes counts only bytes this store omitted (a lower bound when
 * upstream truncation is reported); outputTruncated can therefore be true at 0.
 * fault is a trusted fixture seam, never a page/native request field. */
export class CodingTerminalResults {
 #directory;#ownerId;#root;#generation;#threads;#verifyHome;#readOnly;#fault;#ancestors=null;#data=null;#disk=null;#loaded=false;#blocked=null;
 #queue=Promise.resolve();#tokens=new WeakMap();#live=new Map();
 constructor({directory,ownerId,rootThreadId,ownerGeneration,getThreadIds,verifyHome,readOnly=false,fault}={}){
  if(!pathText(directory)||directory==='/'||!uuid(ownerId)||!id(rootThreadId)||typeof readOnly!=='boolean'||(!readOnly||ownerGeneration!==undefined)&&!uuid(ownerGeneration)||typeof getThreadIds!=='function'||typeof verifyHome!=='function'||fault!==undefined&&typeof fault!=='function')throw Error('Invalid terminal result store binding.');
  this.#directory=directory;this.#ownerId=ownerId;this.#root=rootThreadId;this.#generation=ownerGeneration;this.#threads=getThreadIds;this.#verifyHome=verifyHome;this.#readOnly=readOnly;this.#fault=fault;
 }
 #serial(work){const result=this.#queue.then(work);this.#queue=result.catch(()=>{});return result;}
 #writable(){if(this.#readOnly)throw Error('Terminal result inspection is read-only.');if(this.#blocked)throw this.#blocked;}
 #block(){return this.#blocked??=Object.assign(Error('Terminal result persistence is blocked: evidence is unavailable, changed, corrupt, or saving is unconfirmed. Existing evidence was preserved.'),{code:'TERMINAL_RESULTS_BLOCKED'});}
 #members(){const values=this.#threads();if(!Array.isArray(values)||values.length===0||values.some(x=>!id(x))||new Set(values).size!==values.length||!values.includes(this.#root))throw Error('Invalid terminal result owner/thread binding.');return new Set(values);}
 #thread(threadId){if(!id(threadId)||!this.#members().has(threadId))throw Error('Terminal result thread is outside its owner binding.');}
 async #guard(){
  await this.#verifyHome();this.#members();const paths=[];for(let p=this.#directory;;p=dirname(p)){paths.unshift(p);if(dirname(p)===p)break;}
  const handles=[],observed=[];
  try{
   for(let i=0;i<paths.length;i++){
    const path=paths[i],before=await lstat(path,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink()||await realpath(path)!==path||i===paths.length-1&&(before.uid!==BigInt(process.getuid())||(before.mode&0o077n)!==0n))throw Error('Unsafe terminal result directory.');
    const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(file);const stamp=directoryVersion(await file.stat({bigint:true}));
    if(stamp!==directoryVersion(before)||this.#ancestors&&(this.#ancestors.length!==paths.length||this.#ancestors[i]!==stamp))throw Error('Terminal result home identity changed.');observed.push(stamp);
   }
   for(let i=0;i<paths.length;i++)if(directoryVersion(await handles[i].stat({bigint:true}))!==observed[i]||directoryVersion(await lstat(paths[i],{bigint:true}))!==observed[i]||await realpath(paths[i])!==paths[i])throw Error('Terminal result directory changed during verification.');
   await this.#verifyHome();this.#ancestors??=observed;
  }finally{await Promise.allSettled(handles.map(file=>file.close()));}
 }
 async #read(path){
  let before;try{before=await lstat(path,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const valid=s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.uid===BigInt(process.getuid())&&(s.mode&0o7777n)===0o600n&&s.size>=0n&&s.size<=BigInt(STORE);
  if(!valid(before))throw Error('Unsafe terminal result file.');const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const opened=await file.stat({bigint:true});if(!valid(opened)||version(opened)!==version(before))throw Error('Terminal result file changed while opening.');
   const buffer=Buffer.alloc(Number(opened.size)+1);let used=0;while(used<buffer.length){const read=await file.read(buffer,used,buffer.length-used,used);if(!read.bytesRead)break;used+=read.bytesRead;}
   if(BigInt(used)!==opened.size)throw Error('Terminal result file size changed.');const after=await file.stat({bigint:true}),named=await lstat(path,{bigint:true});
   if(!valid(after)||!valid(named)||version(opened)!==version(after)||version(opened)!==version(named)||await realpath(path)!==path)throw Error('Terminal result file changed during read.');
   const bufferBytes=buffer.subarray(0,used);return {bytes:bufferBytes,hash:hash(bufferBytes),stamp:version(after),renamedStamp:renamedVersion(after)};
  }finally{await file.close();}
 }
 #validate(data){
  if(!exact(data,['version','ownerId','rootThreadId','omittedCount','records'])||data.version!==1||data.ownerId!==this.#ownerId||data.rootThreadId!==this.#root||!integer(data.omittedCount)||!Array.isArray(data.records)||data.records.length>FINALIZED+PENDING)throw Error('Invalid terminal result owner/schema binding.');
  const members=this.#members(),seen=new Set();let pending=0,finalized=0;
  for(const row of data.records){
   if(!exact(row,ROW)||!uuid(row.recordId)||seen.has(row.recordId)||row.ownerId!==this.#ownerId||row.rootThreadId!==this.#root||!members.has(row.threadId)||!uuid(row.ownerGeneration)||!pathText(row.cwd)||!text(row.command,COMMAND,false)||!text(row.output,OUTPUT)||!integer(row.createdAt)||!(row.endedAt===null||integer(row.endedAt)&&row.endedAt>=row.createdAt)||!STATES.has(row.state)||typeof row.stopRequested!=='boolean'||typeof row.outputTruncated!=='boolean'||typeof row.observationComplete!=='boolean'||!integer(row.droppedOutputBytes)||row.droppedOutputBytes>0&&!row.outputTruncated||!(row.error===null||text(row.error,2000,false))||bytes(JSON.stringify(row))>RECORD)throw Error('Invalid terminal result record schema or thread binding.');
   seen.add(row.recordId);if(row.state==='intent')pending++;else finalized++;
   if(row.state==='exited'){if(!Number.isSafeInteger(row.exitCode)||row.exitCode< -2147483648||row.exitCode>2147483647||row.endedAt===null||!row.observationComplete)throw Error('Invalid observed terminal exit.');}
   else if(row.exitCode!==null)throw Error('Only observed terminal exits may contain an exit code.');
   if(row.state==='intent'&&(row.endedAt!==null||row.stopRequested||row.observationComplete||row.error!==null||row.output!==''||row.outputTruncated)||row.state==='not-started'&&(row.endedAt===null||!row.observationComplete||row.output!==''||row.outputTruncated)||row.state==='unconfirmed'&&row.observationComplete)throw Error('Invalid terminal observation state.');
  }
  if(pending>PENDING||finalized>FINALIZED)throw Error('Terminal result record limit exceeded.');return data;
 }
 async #load(){
  if(this.#blocked)throw this.#blocked;
  try{
   await this.#guard();const disk=await this.#read(join(this.#directory,FILE));await this.#guard();
   if(!this.#readOnly&&this.#loaded&&((disk?.stamp??null)!==(this.#disk?.stamp??null)||(disk?.hash??null)!==(this.#disk?.hash??null)))throw Error('Terminal result evidence was replaced or removed.');
   const data=disk?this.#validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(disk.bytes))):{version:1,ownerId:this.#ownerId,rootThreadId:this.#root,omittedCount:0,records:[]};
   this.#data=data;this.#disk=disk;this.#loaded=true;return data;
  }catch(error){if(this.#readOnly)throw error;throw this.#block();}
 }
 #next(){const next=structuredClone(this.#data);for(const row of next.records)if(row.state==='intent'&&!this.#live.has(row.recordId)){row.state='unconfirmed';row.observationComplete=false;}return next;}
 #retain(next){
  const remove=()=>{const index=next.records.findIndex(row=>row.state!=='intent');if(index<0||next.omittedCount===Number.MAX_SAFE_INTEGER)throw Error('Terminal result pending/retention limit exceeded.');next.records.splice(index,1);next.omittedCount++;};
  while(next.records.filter(row=>row.state!=='intent').length>FINALIZED)remove();
  while(bytes(JSON.stringify(next))>STORE)remove();this.#validate(next);return Buffer.from(JSON.stringify(next));
 }
 async #save(next){
  try{
   const encoded=this.#retain(next);await this.#load();const temp=join(this.#directory,'.terminal-results.'+randomUUID()+'.tmp');
   const file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(encoded);await file.sync();}finally{await file.close();}
   const written=await this.#read(temp);if(written?.hash!==hash(encoded))throw Error('Temporary terminal result changed.');await this.#fault?.('before-commit');await this.#load();
   await rename(temp,join(this.#directory,FILE));const directory=await open(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
   try{if(directoryVersion(await directory.stat({bigint:true}))!==this.#ancestors.at(-1))throw Error('Terminal result home changed before sync.');await directory.sync();}finally{await directory.close();}
   await this.#guard();const committed=await this.#read(join(this.#directory,FILE));await this.#guard();
   if(committed?.hash!==written.hash||committed?.renamedStamp!==written.renamedStamp)throw Error('Committed terminal result changed.');this.#data=next;this.#disk=committed;
  }catch{throw this.#block();}
 }
 begin(options){
  let value;try{this.#writable();if(!exact(options,['threadId','cwd','command'])||!pathText(options.cwd)||!text(options.command,COMMAND,false))throw Error('Invalid terminal result command/text metadata.');this.#thread(options.threadId);value={...options};}catch(error){return Promise.reject(error);}
  return this.#serial(async()=>{
   this.#writable();await this.#load();this.#thread(value.threadId);const next=this.#next();if(next.records.filter(row=>row.state==='intent').length>=PENDING)throw Error('Terminal result pending intent limit reached.');
   const row={recordId:randomUUID(),ownerId:this.#ownerId,threadId:value.threadId,rootThreadId:this.#root,ownerGeneration:this.#generation,cwd:value.cwd,command:value.command,output:'',createdAt:Date.now(),endedAt:null,state:'intent',exitCode:null,stopRequested:false,outputTruncated:false,droppedOutputBytes:0,observationComplete:false,error:null};next.records.push(row);await this.#save(next);
   const token=Object.freeze({recordId:row.recordId});this.#tokens.set(token,row.recordId);this.#live.set(row.recordId,{row:structuredClone(row),finishing:false});return token;
  });
 }
 #active(token){const recordId=this.#tokens.get(token),entry=this.#live.get(recordId);if(!entry||entry.finishing)throw Error('Terminal result requires its original unfinished in-memory token.');return entry;}
 append(token,output,options={}){
  this.#writable();const {row}=this.#active(token);if(!wellFormed(output)||!exact(options,[])&&!exact(options,['truncated'])||Object.hasOwn(options,'truncated')&&typeof options.truncated!=='boolean')throw Error('Invalid terminal output Unicode text or truncation marker.');
  const size=bytes(output),kept=row.droppedOutputBytes>0?'':prefix(output,OUTPUT-bytes(row.output)),dropped=size-bytes(kept);
  if(!Number.isSafeInteger(row.droppedOutputBytes+dropped))throw Error('Terminal output dropped-byte count exceeds its bound.');row.output+=kept;row.droppedOutputBytes+=dropped;row.outputTruncated=row.outputTruncated||options.truncated===true||row.droppedOutputBytes>0;
 }
 finish(token,options){
  let entry,row;try{
   this.#writable();entry=this.#active(token);if(!exact(options,['state','exitCode','stopRequested','observationComplete','error'])||!['not-started','exited','unconfirmed'].includes(options.state))throw Error('Invalid terminal final observation.');
   row=boundedRecord({...entry.row,...options,endedAt:Math.max(Date.now(),entry.row.createdAt)});this.#validate({version:1,ownerId:this.#ownerId,rootThreadId:this.#root,omittedCount:0,records:[row]});entry.finishing=true;
  }catch(error){return Promise.reject(error);}
  return this.#serial(async()=>{this.#writable();await this.#load();const next=this.#next(),index=next.records.findIndex(r=>r.recordId===row.recordId);if(index<0)throw this.#block();next.records.splice(index,1);next.records.push(row);await this.#save(next);this.#live.delete(row.recordId);return structuredClone(row);});
 }
 inspect(options){
  let value;try{if(!exact(options,['threadId'])&&!exact(options,['threadId','recordId'])||Object.hasOwn(options??{},'recordId')&&!uuid(options.recordId))throw Error('Invalid terminal result inspection.');this.#thread(options.threadId);value={...options};}catch(error){return Promise.reject(error);}
  return this.#serial(async()=>{
   const data=await this.#load();this.#thread(value.threadId);const envelope={ownerId:this.#ownerId,threadId:value.threadId,omittedCount:data.omittedCount};
   const project=row=>({...structuredClone(row),...(row.state==='intent'?{state:'unconfirmed',observationComplete:false}: {})});let result;
   if(value.recordId){const row=data.records.find(r=>r.recordId===value.recordId&&r.threadId===value.threadId);if(!row)throw Error('Saved terminal result is not in this thread.');result={...envelope,record:project(row)};}
   else result={...envelope,records:data.records.filter(r=>r.threadId===value.threadId).slice().reverse().map(raw=>{const row=project(raw),commandPreview=prefix(row.command,256);return {recordId:row.recordId,createdAt:row.createdAt,endedAt:row.endedAt,state:row.state,exitCode:row.exitCode,stopRequested:row.stopRequested,outputTruncated:row.outputTruncated,observationComplete:row.observationComplete,commandPreview,commandTruncated:commandPreview!==row.command};})};
   if(bytes(JSON.stringify(result))>(value.recordId?DETAIL:SUMMARY))throw Error('Terminal result response exceeds its byte limit.');return result;
  });
 }
 async drain(){for(;;){const pending=this.#queue;await pending;if(pending===this.#queue)break;}if(this.#blocked)throw this.#blocked;}
}
