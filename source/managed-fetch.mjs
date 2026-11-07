import {open,lstat,readdir,readlink,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const MANAGED_FETCH_ID='managed-fetch';
const REVISION='f14622be6addadd62adade8fe848ad68bc8c8db8a62f74ef29ca74948036ea8f';
const MANIFEST='ef429821f36d44e2f4a753ca4ee115493fe3cead9d920511cfa1cc9adc5b34cc';
const CONTRACT='fb90c11977fb1dd578178215207d71f1be7754f9ed190798eba09d5b1d643e6a';
const PYTHON='/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/bin/python3.14';
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const require=(value,message)=>{if(!value)throw Error(message);};
export function fetchPluginRequest(value){
 require(plain(value),'Invalid fixed Fetch request.');
 require(['catalog','install','set_enabled'].includes(value.action),'Unsupported fixed Fetch action.');
 const keys=value.action==='set_enabled'?['action','enabled']:['action'];
 require(Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'Invalid fixed Fetch request fields.');
 if(value.action==='set_enabled')require(typeof value.enabled==='boolean','Fetch enabled must be a Boolean.');
 return value;
}
const identity=s=>['dev','ino','mode','uid','gid'].map(k=>String(s[k])).join(':');
const stamp=s=>['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
const privateOwned=s=>require(s.uid===BigInt(process.getuid())&&(s.mode&0o022n)===0n,'Managed Fetch path owner or permissions changed.');
async function chain(directory){
 require(typeof directory==='string'&&path.isAbsolute(directory)&&path.normalize(directory)===directory&&await realpath(directory)===directory,'Managed Fetch path is not canonical.');
 const held=[];let current=path.parse(directory).root;
 try{
  for(const name of directory.slice(current.length).split(path.sep).filter(Boolean)){
   current=path.join(current,name);const file=await open(current,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);held.push({file,current,row:await file.stat({bigint:true})});
   const s=held.at(-1).row;require(s.isDirectory()&&[0n,BigInt(process.getuid())].includes(s.uid)&&(s.mode&0o022n)===0n,'Managed Fetch ancestor changed.');
  }
  privateOwned(held.at(-1).row);
  return {async verify(){for(const h of held)require(identity(h.row)===identity(await h.file.stat({bigint:true}))&&identity(h.row)===identity(await lstat(h.current,{bigint:true})),'Managed Fetch ancestor identity changed.');},async close(){await Promise.allSettled(held.map(h=>h.file.close()));}};
 }catch(error){await Promise.allSettled(held.map(h=>h.file.close()));throw error;}
}
async function checkedFile(filename,{hash,size,mode,limit=1024*1024,bytes=false}={}){
 const before=await lstat(filename,{bigint:true});privateOwned(before);
 require(before.isFile()&&before.nlink===1n&&before.size>=0n&&before.size<=BigInt(limit)&&(size===undefined||before.size===BigInt(size))&&(mode===undefined||Number(before.mode&0o777n)===mode),'Managed Fetch file metadata changed.');
 const file=await open(filename,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);const chunks=[],digest=createHash('sha256'),buffer=Buffer.alloc(65536);let total=0;
 try{
  require(stamp(before)===stamp(await file.stat({bigint:true})),'Managed Fetch file changed before read.');
  while(true){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;require(total<=limit,'Managed Fetch file exceeds its bound.');digest.update(buffer.subarray(0,bytesRead));if(bytes)chunks.push(Buffer.from(buffer.subarray(0,bytesRead)));}
  const actual=digest.digest('hex');require(hash===undefined||hash===actual,'Managed Fetch content changed.');
  require(stamp(before)===stamp(await file.stat({bigint:true}))&&stamp(before)===stamp(await lstat(filename,{bigint:true})),'Managed Fetch file changed during read.');
  return bytes?Buffer.concat(chunks):actual;
 }finally{await file.close();}
}
async function verifyRuntime(runtime,entries){
 const held=[],seen=new Set(),children=new Map();
 for(const name of Object.keys(entries)){const parent=path.posix.dirname(name);if(!children.has(parent))children.set(parent,[]);children.get(parent).push(path.posix.basename(name));}
 async function walk(relative){
  const filename=path.join(path.dirname(runtime),relative),entry=entries[relative],before=await lstat(filename,{bigint:true});seen.add(relative);privateOwned(before);
  if(entry.type==='file'){await checkedFile(filename,{hash:entry.sha256,size:entry.bytes,mode:entry.mode,limit:entry.bytes});return;}
  require(Number(before.mode&0o777n)===entry.mode,'Managed Fetch mode changed.');
  if(entry.type==='symlink'){
   require(relative.startsWith('runtime/bin/')&&before.isSymbolicLink()&&await readlink(filename)===entry.target&&await realpath(filename)===PYTHON&&entry.resolvedPath===PYTHON,'Managed Fetch Python alias changed.');
   require(stamp(before)===stamp(await lstat(filename,{bigint:true})),'Managed Fetch alias changed during inspection.');return;
  }
  require(before.isDirectory(),'Managed Fetch directory type changed.');const file=await open(filename,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);held.push({file,filename,before});
  require(identity(before)===identity(await file.stat({bigint:true})),'Managed Fetch directory changed.');
  const names=(await readdir(filename)).sort(),expected=(children.get(relative)??[]).sort();require(JSON.stringify(names)===JSON.stringify(expected),'Managed Fetch installed namespace changed.');
  for(const name of names)await walk(relative+'/'+name);
  require(JSON.stringify(names)===JSON.stringify((await readdir(filename)).sort()),'Managed Fetch namespace changed during inspection.');
 }
 try{await walk('runtime');require(seen.size===Object.keys(entries).length,'Managed Fetch manifest is incomplete.');for(const h of held)require(identity(h.before)===identity(await h.file.stat({bigint:true}))&&identity(h.before)===identity(await lstat(h.filename,{bigint:true})),'Managed Fetch held directory changed.');}
 finally{await Promise.allSettled(held.map(h=>h.file.close()));}
}

// Trusted app assembly only. This is one fixed entry, not a user package loader.
export function createManagedFetch({parent,resources}){
 require(typeof parent==='string'&&path.isAbsolute(parent)&&typeof resources==='string'&&path.isAbsolute(resources),'Invalid trusted Fetch runtime assembly.');
 let heldDisabled=false,epoch=0;
 const resolve=async()=>{
  if(heldDisabled)return null;const expected=epoch;
  const held=[];
  try{
   held.push(await chain(parent));
   const recordFile=path.join(parent,'fetch-plugin-v1.json');
   const raw=await checkedFile(recordFile,{limit:8192,mode:0o600,bytes:true}),v=JSON.parse(raw);
   require(plain(v)&&Object.keys(v).sort().join(',')==='enabled,id,manifestSHA256,revision,version'&&v.version===1&&v.id===MANAGED_FETCH_ID&&v.revision===REVISION&&v.manifestSHA256===MANIFEST&&typeof v.enabled==='boolean','Managed Fetch state changed.');
   if(!v.enabled)return null;
   held.push(await chain(resources));
   const manifest=JSON.parse(await checkedFile(path.join(resources,'fetch-runtime-v20261024-manifest.json'),{hash:MANIFEST,limit:1024*1024,bytes:true}));
   const contract=JSON.parse(await checkedFile(path.join(resources,'fetch-python-v20261024-contract.json'),{hash:CONTRACT,limit:8192,bytes:true}));
   for(const name of ['executable','framework']){const item=contract[name];require(await realpath(item.absolutePath)===item.absolutePath,'Qualified Python canonical path changed.');await checkedFile(item.absolutePath,{hash:item.sha256,size:item.bytes,mode:item.mode,limit:item.bytes});}
   const base=path.join(parent,'extensions','fetch'),runtime=path.join(base,REVISION,'runtime');held.push(await chain(runtime));
   await verifyRuntime(runtime,manifest.entries);
   for(const name of ['home','tmp']){const p=path.join(base,name);held.push(await chain(p));require(Number((await lstat(p,{bigint:true})).mode&0o777n)===0o700,'Managed Fetch private working directory changed.');}
   require(raw.equals(await checkedFile(recordFile,{limit:8192,mode:0o600,bytes:true})),'Managed Fetch state changed during verification.');
   for(const c of held)await c.verify();
   if(heldDisabled||expected!==epoch)return null;
   return {command:path.join(runtime,'bin/python'),args:['-I','-B','-m','mcp_server_fetch'],cwd:base,env:{HOME:path.join(base,'home'),TMPDIR:path.join(base,'tmp'),PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'}};
  }catch{return null;}
  finally{await Promise.allSettled(held.map(c=>c.close()));}
 };
 // The shared native disable admission fences new connections/calls before
 // awaiting existing hub drains. No saved Coding owner or registry is edited.
 resolve.holdDisabled=()=>{heldDisabled=true;epoch++;};
 resolve.admitEnable=()=>{heldDisabled=false;epoch++;};
 resolve.isHeldDisabled=()=>heldDisabled;
 return Object.freeze(resolve);
}
