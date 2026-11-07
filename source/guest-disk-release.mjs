// Explicit reviewed storage accounting; never execution recovery or guest reuse.
import {open,lstat,realpath,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {readFilesystemIdentity,readFilesystemIdentities,isFilesystemIdentity,sameFilesystemIdentity} from './filesystem-identity.mjs';
import {verifyHandoffProcessReceipt,verifyHandoffProcessIdentity} from './handoff-process.mjs';

const fail=()=>Error('Retired guest disk evidence changed or is ineligible; storage remains charged for inspection.');
const require=value=>{if(!value)throw fail();};
const shape=(value,keys)=>require(value&&typeof value==='object'&&!Array.isArray(value)&&equal(Object.keys(value).sort(),[...keys].sort()));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
const directory=s=>({...identity(s),mode:Number(s.mode),uid:Number(s.uid)});
export const diskStamp=s=>({...identity(s),size:String(s.size),mode:String(s.mode),uid:String(s.uid),nlink:String(s.nlink),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),blocks:String(s.blocks)});
const fileStamp=s=>{const {blocks,...stamp}=diskStamp(s);return stamp;};
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const stable=context=>isFilesystemIdentity(context.runtime.identity);
const compact=value=>({volumeUUID:value.volumeUUID,ino:value.ino});
const persistedSame=(a,b)=>sameFilesystemIdentity(compact(a),compact(b));
const nativeUUID=value=>typeof value==='string'&&/^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}$/.test(value);
const pointer=file=>({receiptSHA256:file.sha256,receiptIdentity:file.identity});
const proof=file=>({sha256:file.sha256,identity:file.identity});
async function absent(path){try{await lstat(path);throw fail();}catch(error){if(error.code!=='ENOENT')throw error;}}
async function dir(context,path,expected){
 const s=await lstat(path,{bigint:true});require(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&(s.mode&0o777n)===0o700n&&await realpath(path)===path);
 let current=directory(s);
 if(stable(context)){const filesystem=await readFilesystemIdentity({path,nativeHelper:context.nativeHelper});require(filesystem.ino===current.ino&&equal(directory(await lstat(path,{bigint:true})),current));current={...filesystem,mode:current.mode,uid:current.uid};}
 require(!expected||(stable(context)?persistedSame(current,expected):same(current,expected)));return current;
}
async function dirs(context,entries){
 require(entries.length===3);
 if(!stable(context)){const values=[];for(const [path,expected] of entries)values.push(await dir(context,path,expected));return values;}
 const before=[];
 for(const [path] of entries){
  const s=await lstat(path,{bigint:true});require(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===BigInt(process.getuid())&&(s.mode&0o777n)===0o700n&&await realpath(path)===path);before.push(directory(s));
 }
 const identities=await readFilesystemIdentities({paths:entries.map(([path])=>path),nativeHelper:context.nativeHelper}),values=[];
 for(let index=0;index<entries.length;index++){
  const [path,expected]=entries[index],current=before[index],filesystem=identities[index];
  require(filesystem.ino===current.ino&&equal(directory(await lstat(path,{bigint:true})),current));
  const value={...filesystem,mode:current.mode,uid:current.uid};require(!expected||persistedSame(value,expected));values.push(value);
 }
 return values;
}
async function file(context,path,json=true){
 const before=await lstat(path,{bigint:true});require(before.isFile()&&!before.isSymbolicLink()&&before.mode===0o100600n&&before.uid===BigInt(process.getuid())&&before.nlink===1n&&before.size>0n&&before.size<=1048576n);
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  require(equal(fileStamp(await f.stat({bigint:true})),fileStamp(before)));const bytes=await f.readFile();
  const persisted=stable(context)?await readFilesystemIdentity({path,nativeHelper:context.nativeHelper}):identity(before);
  require(persisted.ino===String(before.ino)&&bytes.length===Number(before.size)&&equal(fileStamp(await f.stat({bigint:true})),fileStamp(before))&&equal(fileStamp(await lstat(path,{bigint:true})),fileStamp(before)));
  const {dev,...rest}=fileStamp(before);return {value:json?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):null,sha256:hash(bytes),identity:persisted,stamp:stable(context)?{...rest,...persisted}:fileStamp(before)};
 }finally{await f.close();}
}
// Keep every proof descriptor held until the shared identity observation and
// all original byte/stat checks finish. This is not a cache or atomic snapshot.
async function fileGroup(context,entries){
 require(Array.isArray(entries)&&entries.length>=1&&entries.length<=32&&entries.every(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&typeof row[1]==='boolean')&&new Set(entries.map(row=>row[0])).size===entries.length);
 entries=entries.map(row=>[...row]);
 if(!stable(context)){const values=[];for(const [path,json] of entries)values.push(await file(context,path,json));return values;}
 const held=[];
 try{
  for(const [path,json] of entries){
   const before=await lstat(path,{bigint:true});require(before.isFile()&&!before.isSymbolicLink()&&before.mode===0o100600n&&before.uid===BigInt(process.getuid())&&before.nlink===1n&&before.size>0n&&before.size<=1048576n);
   const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),row={path,json,before,f};held.push(row);
   require(equal(fileStamp(await f.stat({bigint:true})),fileStamp(before)));row.bytes=await f.readFile();
  }
  const identities=await readFilesystemIdentities({paths:entries.map(row=>row[0]),nativeHelper:context.nativeHelper}),values=[];
  for(let index=0;index<held.length;index++){
   const {path,json,before,f,bytes}=held[index],persisted=identities[index];
   require(persisted.ino===String(before.ino)&&bytes.length===Number(before.size)&&equal(fileStamp(await f.stat({bigint:true})),fileStamp(before))&&equal(fileStamp(await lstat(path,{bigint:true})),fileStamp(before)));
   const {dev,...rest}=fileStamp(before);values.push({value:json?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)):null,sha256:hash(bytes),identity:persisted,stamp:{...rest,...persisted}});
  }
  return values;
 }finally{
  const closed=await Promise.allSettled(held.map(({f})=>f.close())),failure=closed.find(result=>result.status==='rejected');if(failure)throw failure.reason;
 }
}
function paths(context){const {runtime,allocation:a}=context,allocation=join(runtime.path,a.ownerId+'-'+a.generation);return {allocation,root:join(allocation,'guest'),receipts:join(allocation,'receipts')};}
const failedKind='failed-provisioning';
const emptyKind='empty-allocation';
const failedGuestNames=['auxiliary.bin','disk.img','fixture.json','hardware-model.bin','install-claim.json','install-terminal.json','installed.json','machine-id.bin','provision-claim.json','provision-events.jsonl','provision-terminal.json'];
const failedReceiptNames=['installation.json','provisioning.json'];
const startupNames=['address-found','callback-entered','callback-settled','ready-resolved','scan-first-drained','scan-first-result','scan-ready-drained','scan-ready-result'].map(name=>'startup-phase-'+name+'.json');
export function isFailedDiskOwner(row,a){return !!row&&row.id===a.ownerId&&row.state==='creating'&&row.rootThreadId===null&&row.threads?.length===0&&row.model===null&&row.creation===null&&row.fork===null&&row.mcp?.kind==='never-enabled'&&row.generation?.id===a.generation&&row.generation.nativeOpen===false&&row.generation.executorClosed===true&&row.generation.execution==='unrevoked'&&a.closed===true&&!!a.identity;}
async function emptyEvidence(context,phase='review'){
 const {catalog,runtime,allocation:a,owner}=context,p=paths(context);require(isFailedDiskOwner(owner,a));
 await dir(context,catalog.path,catalog.identity);await dir(context,runtime.path,runtime.identity);
 const [allocationIdentity,rootIdentity,receiptsIdentity]=await dirs(context,[[p.allocation,a.identity],[p.root],[p.receipts]]);
 const receipts=phase==='review'?[]:phase==='intent'?['disk-release-intent.json']:['disk-release-intent.json','disk-release.json'];
 const namespace=async()=>require(equal((await readdir(p.allocation)).sort(),['allocation.json','guest','receipts'])&&!(await readdir(p.root)).length&&equal((await readdir(p.receipts)).sort(),receipts));
 await namespace();
 const allocation=await file(context,join(p.allocation,'allocation.json')),v=allocation.value;
 shape(v,['version','ownerId','generation','cwd','hostIdentity','root','resources','account','bundle','restartAllowed']);
 require(v.version===(stable(context)?2:1)&&v.ownerId===a.ownerId&&v.generation===a.generation&&v.cwd===owner.cwd&&equal(v.resources,a.resources)&&equal(v.root,rootIdentity)&&v.restartAllowed===false);
 const basis={kind:emptyKind,catalog,runtime,allocationIdentity,rootIdentity,receiptsIdentity,ownerId:a.ownerId,generation:a.generation,proofs:{allocation:proof(allocation)}};
 const request={version:1,ownerId:a.ownerId,generation:a.generation,allocation:p.allocation,allocationIdentity:directory(await lstat(p.allocation,{bigint:true})),rootIdentity:directory(await lstat(p.root,{bigint:true})),receiptsIdentity:directory(await lstat(p.receipts,{bigint:true})),allocationFile:{sha256:allocation.sha256,stamp:allocation.stamp}};
 await dirs(context,[[p.allocation,allocationIdentity],[p.root,rootIdentity],[p.receipts,receiptsIdentity]]);await namespace();
 require(equal(await file(context,join(p.allocation,'allocation.json')),allocation));
 return {p,basis,request};
}
export async function inspectEmptyAllocation(context){const {basis,request}=await emptyEvidence(context);return {basis,request};}
const emptyResult=basis=>({version:1,ownerId:basis.ownerId,generation:basis.generation,empty:true,physicalClosed:true,descriptorsClosed:true});
async function failedEvidence(context){
 const {catalog,runtime,allocation:a,owner}=context,p=paths(context);require(isFailedDiskOwner(owner,a));
 await dir(context,catalog.path,catalog.identity);await dir(context,runtime.path,runtime.identity);
 const [allocationIdentity,rootIdentity,receiptsIdentity]=await dirs(context,[[p.allocation,a.identity],[p.root],[p.receipts]]);
 require(equal((await readdir(p.allocation)).sort(),['allocation.json','guest','receipts']));
 const guestNames=(await readdir(p.root)).sort(),receiptNames=(await readdir(p.receipts)).sort();
 require(equal(guestNames,failedGuestNames.filter(name=>name!=='disk.img'||!a.diskRelease).sort())&&failedReceiptNames.every(name=>receiptNames.includes(name))&&receiptNames.every(name=>[...failedReceiptNames,...startupNames,'disk-release-intent.json','disk-release.json'].includes(name)));
 const names=['allocation.json',...guestNames.filter(name=>!['disk.img','auxiliary.bin'].includes(name)).map(name=>'guest/'+name),...receiptNames.filter(name=>!name.startsWith('disk-release')).map(name=>'receipts/'+name)];
 const records=await fileGroup(context,names.map(name=>[join(p.allocation,name),!['guest/hardware-model.bin','guest/machine-id.bin','guest/provision-events.jsonl'].includes(name)])),files=Object.fromEntries(names.map((name,index)=>[name,records[index]]));
 const allocation=files['allocation.json'],installation=files['receipts/installation.json'],installClaim=files['guest/install-claim.json'],installTerminal=files['guest/install-terminal.json'],recorded=files['receipts/provisioning.json'],claim=files['guest/provision-claim.json'],terminal=files['guest/provision-terminal.json'];
 const av=allocation.value,i=installClaim.value,it=installTerminal.value,c=claim.value,t=terminal.value;
 shape(av,['version','ownerId','generation','cwd','hostIdentity','root','resources','account','bundle','restartAllowed']);
 require(av.version===(stable(context)?2:1)&&av.ownerId===a.ownerId&&av.generation===a.generation&&av.cwd===owner.cwd&&equal(av.resources,a.resources)&&equal(av.root,rootIdentity)&&av.restartAllowed===false);
 shape(i,['version','ownerId','generation','guestId','root','process','parent','image','resources','restartAllowed']);
 require(i.version===1&&i.ownerId===a.ownerId&&i.generation===a.generation&&nativeUUID(i.guestId)&&equal(i.resources,a.resources)&&i.restartAllowed===false);
 shape(c,['version','ownerId','generation','guestId','epoch','root','artifacts','metadataSHA256','process','parent','provisioning','restartAllowed','trustedProvisioningOnly','executionAdmitted','installationClaimSHA256','installationTerminalSHA256','resources','policy',...(c.version===2?['filesystem']:[])]);
 require(c.version===(stable(context)?2:1)&&c.ownerId===a.ownerId&&c.generation===a.generation&&c.guestId===i.guestId&&nativeUUID(c.epoch)&&equal(c.root,i.root)&&equal(c.parent,i.parent)&&equal(c.resources,a.resources)&&c.provisioning===true&&c.trustedProvisioningOnly===true&&c.executionAdmitted===false&&c.restartAllowed===false&&c.installationClaimSHA256===installClaim.sha256&&c.installationTerminalSHA256===installTerminal.sha256);
 require(stable(context)?isFilesystemIdentity(c.filesystem?.root)&&persistedSame(c.filesystem.root,rootIdentity)&&['ino','mode','uid'].every(key=>c.root[key]===rootIdentity[key]):equal(c.root,rootIdentity));
 shape(c.policy,['user','fullName','maximumRunSeconds']);require(equal({user:c.policy.user,fullName:c.policy.fullName},av.account)&&Number.isSafeInteger(c.policy.maximumRunSeconds)&&c.policy.maximumRunSeconds>0);
 for(const worker of [i.process,c.process]){verifyHandoffProcessReceipt(worker,{nonce:a.generation,pid:worker?.pid});verifyHandoffProcessIdentity(c.parent,{uid:process.getuid(),bootSession:worker.bootSession});}
 require(i.process.pid!==c.process.pid&&![i.process.pid,c.process.pid].includes(c.parent.pid));
 require(equal(installation.value,{ownerId:a.ownerId,generation:a.generation,guestId:c.guestId,claimSHA256:installClaim.sha256,claim:i})&&equal(recorded.value,{ownerId:a.ownerId,generation:a.generation,claimSHA256:claim.sha256,claim:c}));
 shape(it,['event','ownerId','generation','guestId','claimSHA256','passed','closed','started','cancelled','error','state','loadCallbackSettled','installCallbackSettled','stopCallbackSettled','imageUnchanged','fixtureSHA256','installedSHA256','storage']);
 require(it.event==='completed'&&it.ownerId===a.ownerId&&it.generation===a.generation&&it.guestId===c.guestId&&it.claimSHA256===installClaim.sha256&&['passed','closed','started','loadCallbackSettled','installCallbackSettled','stopCallbackSettled','imageUnchanged'].every(key=>it[key]===true)&&it.cancelled===false&&it.error===''&&it.state===0&&it.fixtureSHA256===files['guest/fixture.json'].sha256&&it.installedSHA256===files['guest/installed.json'].sha256);
 const artifacts=['fixture.json','installed.json','hardware-model.bin','machine-id.bin','auxiliary.bin','disk.img','install-claim.json','install-terminal.json'];shape(c.artifacts,artifacts);shape(c.metadataSHA256,artifacts.filter(name=>!['disk.img','auxiliary.bin'].includes(name)));shape(it.storage,['hardware-model.bin','machine-id.bin','auxiliary.bin','disk.img']);
 for(const name of artifacts){
  const s=c.artifacts[name];shape(s,['dev','ino','size','mode','uid','nlink','mtimeSec','mtimeNS','ctimeSec','ctimeNS']);
  require(['dev','ino','size'].every(key=>typeof s[key]==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(s[key]))&&['mode','uid','nlink','mtimeSec','mtimeNS','ctimeSec','ctimeNS'].every(key=>Number.isSafeInteger(s[key]))&&s.mode===0o100600&&s.uid===process.getuid()&&s.nlink===1&&s.mtimeNS>=0&&s.mtimeNS<1e9&&s.ctimeNS>=0&&s.ctimeNS<1e9);
  if(Object.hasOwn(c.metadataSHA256,name)){const current=files['guest/'+name];require(c.metadataSHA256[name]===current.sha256&&['ino','size','mode','uid','nlink',...(stable(context)?[]:['dev'])].every(key=>current.stamp[key]===String(s[key]))&&(stable(context)?current.identity.volumeUUID===rootIdentity.volumeUUID:true));}
  if(Object.hasOwn(it.storage,name)){const storage=it.storage[name];shape(storage,['identity','sha256']);require(equal(storage.identity,{dev:s.dev,ino:s.ino,size:s.size,mode:s.mode,uid:s.uid,nlink:s.nlink,mtimeNS:String(BigInt(s.mtimeSec)*1000000000n+BigInt(s.mtimeNS)),ctimeNS:String(BigInt(s.ctimeSec)*1000000000n+BigInt(s.ctimeNS))})&&storage.sha256===(name==='disk.img'||name==='auxiliary.bin'?null:c.metadataSHA256[name]));}
 }
 const fixture=files['guest/fixture.json'].value,installed=files['guest/installed.json'].value;
 require(fixture.guestId===c.guestId&&['cpu','memoryBytes','diskBytes'].every(key=>fixture[key]===a.resources[key])&&fixture.directoryShares===0&&installed.controller===fixture.controller&&installed.build===fixture.build&&installed.installed===true&&installed.state==='stopped');
 require(equal(t,{event:'stop-completed',ownerId:a.ownerId,generation:a.generation,guestId:c.guestId,epoch:c.epoch,claimSHA256:claim.sha256,reason:'Provisioning shutdown deadline',state:0,closureConfirmed:true,started:true,faulted:true,productionContainment:false,errorCode:0,errorDomain:''}));
 const original=c.artifacts['disk.img'];require(original.size===String(a.resources.diskBytes));
 const aux=await lstat(join(p.root,'auxiliary.bin'),{bigint:true});let auxiliary=diskStamp(aux);require(aux.isFile()&&aux.mode===0o100600n&&aux.uid===BigInt(process.getuid())&&aux.nlink===1n&&['ino','size',...(stable(context)?[]:['dev'])].every(key=>auxiliary[key]===c.artifacts['auxiliary.bin'][key]));
 if(stable(context)){const persisted=await readFilesystemIdentity({path:join(p.root,'auxiliary.bin'),nativeHelper:context.nativeHelper});require(persisted.volumeUUID===rootIdentity.volumeUUID&&persisted.ino===auxiliary.ino&&equal(auxiliary,diskStamp(await lstat(join(p.root,'auxiliary.bin'),{bigint:true}))));const {dev,...rest}=auxiliary;auxiliary={...rest,...persisted};}
 if(stable(context)){shape(c.filesystem,['root','disk']);require(isFilesystemIdentity(c.filesystem.disk)&&c.filesystem.disk.ino===original.ino);}
 const failed={parent:c.parent,processes:[i.process,c.process],files:Object.fromEntries(names.map(name=>[name,{sha256:files[name].sha256,stamp:files[name].stamp}])),auxiliary,namespace:['allocation.json','guest','receipts',...guestNames.filter(name=>name!=='disk.img').map(name=>'guest/'+name),...receiptNames.filter(name=>!name.startsWith('disk-release')).map(name=>'receipts/'+name)].sort()};
 const basis={catalog,runtime,allocationIdentity,rootIdentity,receiptsIdentity,ownerId:a.ownerId,generation:a.generation,guestId:c.guestId,epoch:c.epoch,proofs:{allocation:proof(allocation),installation:proof(installation),installationClaim:proof(installClaim),installationTerminal:proof(installTerminal),provisioning:proof(recorded),claim:proof(claim),terminal:proof(terminal)},kind:failedKind,failed};
 await dirs(context,[[p.allocation,allocationIdentity],[p.root,rootIdentity],[p.receipts,receiptsIdentity]]);
 return {p,basis,original,filesystem:c.filesystem};
}
async function evidence(context,kind){
 if(kind===failedKind)return failedEvidence(context);
 const {catalog,runtime,allocation:a}=context,p=paths(context);
 require(a.closed===true&&a.identity);await dir(context,catalog.path,catalog.identity);await dir(context,runtime.path,runtime.identity);
 const [allocationIdentity,rootIdentity,receiptsIdentity]=await dirs(context,[[p.allocation,a.identity],[p.root],[p.receipts]]);
 const [allocation,retirement,claim,terminal]=await fileGroup(context,[[join(p.allocation,'allocation.json'),true],[join(p.receipts,'retirement.json'),true],[join(p.root,'boot-claim.json'),true],[join(p.root,'boot-terminal.json'),true]]);
 const av=allocation.value,r=retirement.value,c=claim.value,t=terminal.value;
 shape(av,['version','ownerId','generation','cwd','hostIdentity','root','resources','account','bundle','restartAllowed']);
 shape(r,['version','ownerId','generation','allocation','root','guestId','epoch','claimSHA256','claimIdentity','terminalSHA256','restartAllowed']);
 require(av.version===(stable(context)?2:1)&&av.ownerId===a.ownerId&&av.generation===a.generation&&equal(av.resources,a.resources)&&equal(av.root,rootIdentity)&&av.restartAllowed===false);
 require(r.version===(stable(context)?2:1)&&r.ownerId===a.ownerId&&r.generation===a.generation&&equal(r.allocation,allocationIdentity)&&equal(r.root,rootIdentity)&&nativeUUID(r.guestId)&&nativeUUID(r.epoch)&&r.restartAllowed===false&&r.claimSHA256===claim.sha256&&equal(r.claimIdentity,claim.stamp)&&r.terminalSHA256===terminal.sha256);
 require((stable(context)?c.version===2:[1,2].includes(c.version))&&c.ownerId===a.ownerId&&c.generation===a.generation&&c.guestId===r.guestId&&c.epoch===r.epoch&&(stable(context)?isFilesystemIdentity(c.filesystem?.root)&&persistedSame(c.filesystem.root,rootIdentity)&&c.root?.ino===rootIdentity.ino&&c.root?.mode===rootIdentity.mode&&c.root?.uid===rootIdentity.uid:equal(c.root,rootIdentity))&&c.executionAdmitted===true&&c.trustedProvisioningOnly===false&&c.provisioning===false&&c.restartAllowed===false);
 verifyHandoffProcessReceipt(c.process,{nonce:a.generation,pid:c.process?.pid});verifyHandoffProcessIdentity(c.parent,{uid:process.getuid(),bootSession:c.process.bootSession});
 require(t.event==='stop-completed'&&['ownerId','generation','guestId','epoch'].every(k=>t[k]===c[k])&&t.claimSHA256===claim.sha256&&t.reason==='parent Stop'&&t.state===0&&t.closureConfirmed===true&&t.started===true&&t.cancelledBeforeBoot!==true&&t.faulted===false&&t.productionContainment===false&&t.errorCode===0&&t.errorDomain==='');
 const original=c.artifacts?.['disk.img'];require(original&&original.size===String(a.resources.diskBytes)&&original.mode===0o100600&&original.uid===process.getuid()&&original.nlink===1);
 // Keep every small record and its exact bytes. The retirement receipt is not
 // closure authority by itself: the caller must also own a closed reservation.
 const basis={catalog,runtime,allocationIdentity,rootIdentity,receiptsIdentity,ownerId:a.ownerId,generation:a.generation,guestId:r.guestId,epoch:r.epoch,proofs:{allocation:proof(allocation),retirement:proof(retirement),claim:proof(claim),terminal:proof(terminal)}};
 await dirs(context,[[p.allocation,allocationIdentity],[p.root,rootIdentity],[p.receipts,receiptsIdentity]]);
 if(stable(context)){shape(c.filesystem,['root','disk']);require(isFilesystemIdentity(c.filesystem.disk)&&c.filesystem.disk.ino===original.ino);}
 return {p,basis,original,filesystem:c.filesystem};
}
export async function inspectRetiredDisk(context,{allowIntent=false,kind,detectEmpty=false}={}){
 if(kind===emptyKind||kind===failedKind&&detectEmpty&&!(await readdir(paths(context).root)).length)return inspectEmptyAllocation(context);
 const {p,basis,original,filesystem}=await evidence(context,kind);
 if(!allowIntent){await absent(join(p.receipts,'disk-release-intent.json'));await absent(join(p.receipts,'disk-release.json'));}
 const s=await lstat(join(p.root,'disk.img'),{bigint:true}),disk=diskStamp(s);
 require(s.isFile()&&!s.isSymbolicLink()&&s.mode===0o100600n&&s.uid===BigInt(process.getuid())&&s.nlink===1n&&s.size===BigInt(context.allocation.resources.diskBytes)&&['ino','size',...(stable(context)?[]:['dev'])].every(k=>disk[k]===original[k]));
 if(stable(context)){require(sameFilesystemIdentity(await readFilesystemIdentity({path:join(p.root,'disk.img'),nativeHelper:context.nativeHelper}),filesystem.disk)&&equal(diskStamp(await lstat(join(p.root,'disk.img'),{bigint:true})),disk));}
 const rootIdentity=directory(await lstat(p.root,{bigint:true}));await dir(context,p.root,basis.rootIdentity);
 return {basis,request:{version:1,ownerId:basis.ownerId,generation:basis.generation,guestId:basis.guestId,epoch:basis.epoch,root:p.root,rootIdentity,disk}};
}
async function durable(context,name,value){
 const p=paths(context),expected=await dir(context,p.receipts),live=directory(await lstat(p.receipts,{bigint:true})),bytes=Buffer.from(JSON.stringify(value)+'\n');require(bytes.length<=1048576);
 const f=await open(join(p.receipts,name),'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
 await dir(context,p.receipts,expected);const d=await open(p.receipts,constants.O_RDONLY|constants.O_NOFOLLOW);try{require(same(identity(await d.stat({bigint:true})),live));await d.sync();}finally{await d.close();}
 await dir(context,p.receipts,expected);return file(context,join(p.receipts,name));
}
export async function recordDiskReleaseIntent(context,review,worker){
 verifyHandoffProcessReceipt(worker,{nonce:worker?.nonce,pid:worker?.pid});
 require(equal(await inspectRetiredDisk(context,{kind:review.snapshot.basis.kind}),review.snapshot));
 const value={version:stable(context)?2:1,action:review.snapshot.basis.kind===emptyKind?'releaseEmptyAllocation':'disposeGuestDisk',reviewId:review.id,basis:review.snapshot.basis,request:review.snapshot.request,requestSHA256:hash(JSON.stringify(review.snapshot.request)),worker};
 return durable(context,'disk-release-intent.json',value);
}
export async function completeDiskRelease(context,review,intent,result){
 if(review.snapshot.basis.kind===emptyKind){
  require(equal(result,emptyResult(review.snapshot.basis)));
  const {p,basis,request}=await emptyEvidence(context,'intent');require(equal(basis,review.snapshot.basis)&&equal(request,review.snapshot.request));
  const current=await file(context,join(p.receipts,'disk-release-intent.json'));require(equal(pointer(current),pointer(intent))&&equal(current.value,intent.value));
  return pointer(await durable(context,'disk-release.json',{version:stable(context)?2:1,action:'releaseEmptyAllocation',intent:pointer(intent),worker:intent.value.worker,workerClosed:true,result,basis}));
 }
 const expected={version:1,ownerId:review.ownerId,generation:review.generation,guestId:review.guestId,epoch:review.snapshot.request.epoch,unlinked:true,descriptorsClosed:true,disk:review.snapshot.request.disk,rootIdentity:review.snapshot.request.rootIdentity,logicalBytes:review.logicalBytes,allocatedBytes:review.allocatedBytes};require(equal(result,expected));
 const {p,basis}=await evidence({...context,allocation:{...context.allocation,diskRelease:true}},review.snapshot.basis.kind);require(equal(basis,review.snapshot.basis));await absent(join(p.root,'disk.img'));
 const current=await file(context,join(p.receipts,'disk-release-intent.json'));require(equal(pointer(current),pointer(intent))&&equal(current.value,intent.value));
 const receipt=await durable(context,'disk-release.json',{version:stable(context)?2:1,action:'disposeGuestDisk',intent:pointer(intent),worker:intent.value.worker,workerClosed:true,result,basis});
 return pointer(receipt);
}
export async function verifyDiskRelease(context){
 const a=context.allocation;require(a.diskRelease);const p=paths(context),receipt=await file(context,join(p.receipts,'disk-release.json'));
 if(receipt.value?.basis?.kind===emptyKind){
  const {basis,request}=await emptyEvidence(context,'released'),r=receipt.value;
  require(equal(pointer(receipt),a.diskRelease));shape(r,['version','action','intent','worker','workerClosed','result','basis']);
  const intent=await file(context,join(p.receipts,'disk-release-intent.json')),v=intent.value;shape(v,['version','action','reviewId','basis','request','requestSHA256','worker']);
  verifyHandoffProcessReceipt(v.worker,{nonce:v.worker?.nonce,pid:v.worker?.pid});
  require(r.version===(stable(context)?2:1)&&r.action==='releaseEmptyAllocation'&&r.workerClosed===true&&equal(r.basis,basis)&&equal(r.intent,pointer(intent))&&equal(r.worker,v.worker)&&v.version===r.version&&v.action===r.action&&equal(v.basis,basis)&&v.requestSHA256===hash(JSON.stringify(v.request))&&equal(r.result,emptyResult(basis)));
  // Raw device numbers may change after reboot; receipt identity remains bound
  // to the same filesystem UUID/inode and all other directory/file fields.
  const expected=structuredClone(request);
  if(stable(context))for(const key of ['allocationIdentity','rootIdentity','receiptsIdentity']){
   const old=v.request?.[key];shape(old,['dev','ino','mode','uid']);require(typeof old.dev==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(old.dev));expected[key].dev=old.dev;
  }
  require(equal(v.request,expected));return true;
 }
 const {basis}=await evidence(context,receipt.value?.basis?.kind);
 require(equal(pointer(receipt),a.diskRelease));const r=receipt.value;shape(r,['version','action','intent','worker','workerClosed','result','basis']);
 const intent=await file(context,join(p.receipts,'disk-release-intent.json')),v=intent.value;shape(v,['version','action','reviewId','basis','request','requestSHA256','worker']);
 verifyHandoffProcessReceipt(v.worker,{nonce:v.worker?.nonce,pid:v.worker?.pid});
 require(r.version===(stable(context)?2:1)&&r.action==='disposeGuestDisk'&&r.workerClosed===true&&equal(r.basis,basis)&&equal(r.intent,pointer(intent))&&equal(r.worker,v.worker)&&v.version===(stable(context)?2:1)&&v.action===r.action&&equal(v.basis,basis)&&v.requestSHA256===hash(JSON.stringify(v.request)));
 const d=v.request.disk,rootIdentity=stable(context)?v.request.rootIdentity:basis.rootIdentity;
 if(stable(context)){shape(rootIdentity,['dev','ino','mode','uid']);require(typeof rootIdentity.dev==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(rootIdentity.dev)&&['ino','mode','uid'].every(key=>rootIdentity[key]===basis.rootIdentity[key]));}
 const expected={version:1,ownerId:a.ownerId,generation:a.generation,guestId:basis.guestId,epoch:basis.epoch,root:p.root,rootIdentity,disk:d};require(equal(v.request,expected)&&d.size===String(a.resources.diskBytes));
 require(equal(r.result,{version:1,ownerId:a.ownerId,generation:a.generation,guestId:basis.guestId,epoch:basis.epoch,unlinked:true,descriptorsClosed:true,disk:d,rootIdentity,logicalBytes:d.size,allocatedBytes:String(BigInt(d.blocks)*512n)}));await absent(join(p.root,'disk.img'));
 return true;
}
