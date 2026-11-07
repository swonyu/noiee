import {mkdir,lstat,realpath,open,rename,unlink,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,isAbsolute,normalize} from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';

const LIMIT=32768,hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.slice().sort().join();
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const stamp=s=>[s.dev,s.ino,s.mode,s.uid,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join('/');
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
const privateDir=s=>s.isDirectory()&&s.uid===BigInt(process.getuid())&&!(s.mode&0o077n);

// One ordinary Agent hub owns this record. Fingerprints are private comparison
// data, never a replacement for the per-boot native approval MAC.
export class MCPRecoveryState {
 constructor(directory,fault){this.directory=directory;this.file=join(directory,'state.json');this.fault=fault;this.tail=Promise.resolve();this.failed=false;this.unreviewed=new Set();}
 enqueue(operation){const task=this.tail.then(async()=>{if(this.failed)throw Error('MCP recovery state is unavailable; retained evidence was kept.');try{return await operation();}catch(error){this.failed=true;throw error;}});this.tail=task.catch(()=>{});return task;}
 async guard(){
  const parent=dirname(this.directory);
  if(!isAbsolute(this.directory)||normalize(this.directory)!==this.directory||this.directory.includes('\0')||await realpath(parent)!==parent)throw Error('Unsafe MCP recovery parent.');
  const p=await lstat(parent,{bigint:true});if(!p.isDirectory()||p.uid!==BigInt(process.getuid())||p.mode&0o022n)throw Error('Unsafe MCP recovery parent.');
  let created=false;try{await mkdir(this.directory,{mode:0o700});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}
  const d=await lstat(this.directory,{bigint:true});if(!privateDir(d)||await realpath(this.directory)!==this.directory||this.parent&&!same(p,this.parent)||this.identity&&!same(d,this.identity))throw Error('MCP recovery directory changed.');
  this.parent??=p;this.identity??=d;
  if(created){const fd=await open(parent,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{if(!same(await fd.stat({bigint:true}),p))throw Error('MCP recovery parent changed.');await fd.sync();}finally{await fd.close();}}
 }
 async read(){
  let before;try{before=await lstat(this.file,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!before.isFile()||before.uid!==BigInt(process.getuid())||(before.mode&0o777n)!==0o600n||before.nlink!==1n||before.size>BigInt(LIMIT))throw Error('Unsafe MCP recovery record.');
  const fd=await open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{if(stamp(before)!==stamp(await fd.stat({bigint:true})))throw Error('MCP recovery record changed.');const bytes=Buffer.alloc(LIMIT+1);let size=0;while(size<bytes.length){const result=await fd.read(bytes,size,bytes.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
   if(size>LIMIT||BigInt(size)!==before.size||stamp(before)!==stamp(await fd.stat({bigint:true}))||stamp(before)!==stamp(await lstat(this.file,{bigint:true})))throw Error('MCP recovery record changed.');
   return{stamp:stamp(before),hash:sha(bytes.subarray(0,size)),bytes:bytes.subarray(0,size)};
  }finally{await fd.close();}
 }
 validate(value){
  if(!exact(value,['version','id','revision','salt','clean','servers'])||value.version!==1||typeof value.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)||!Number.isSafeInteger(value.revision)||value.revision<1||!hex(value.salt)||typeof value.clean!=='boolean'||!Array.isArray(value.servers)||value.servers.length>64)throw Error('Invalid MCP recovery record; original bytes were kept.');
  const ids=new Set();for(const row of value.servers){if(!exact(row,['id','transport','config','catalog'])||typeof row.id!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(row.id)||ids.has(row.id)||!['stdio','http'].includes(row.transport)||!hex(row.config)||!hex(row.catalog))throw Error('Invalid MCP recovery entry.');ids.add(row.id);}return value;
 }
 async unchanged(){await this.guard();const current=await this.read();if((current?.stamp??null)!==(this.disk?.stamp??null)||(current?.hash??null)!==(this.disk?.hash??null))throw Error('MCP recovery record changed externally.');}
 async sync(){const fd=await open(this.directory,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try{if(!same(await fd.stat({bigint:true}),this.identity))throw Error('MCP recovery directory changed.');await fd.sync();}finally{await fd.close();}await this.guard();}
 async write(value,current=()=>true){
  this.validate(value);const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>LIMIT)throw Error('MCP recovery record is full.');await this.unchanged();
  const temp=join(this.directory,randomUUID()+'.tmp'),fd=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  await this.fault?.('before-publish',structuredClone(value));await this.unchanged();
  if(!current()){await unlink(temp);return false;}
  // ponytail: the existing single ordinary hub is the writer; hostile same-user
  // replacement between namespace check and rename needs a stronger FS boundary.
  await rename(temp,this.file);await this.sync();const saved=await this.read();if(saved?.hash!==sha(bytes))throw Error('MCP recovery commit could not be confirmed.');this.disk=saved;this.value=value;return true;
 }
 openBoot(){return this.boot??=this.enqueue(async()=>{
  await this.guard();const names=await readdir(this.directory);if(names.some(name=>name!=='state.json'))throw Error('Unfinished MCP recovery evidence is retained.');
  this.disk=await this.read();let saved;
  if(this.disk){try{saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.disk.bytes));}catch{throw Error('Invalid MCP recovery JSON; original bytes were kept.');}this.validate(saved);}
  else saved={version:1,id:randomUUID(),revision:1,salt:randomBytes(32).toString('hex'),clean:false,servers:[]};
  const rows=structuredClone(saved.servers),eligible=!!this.disk&&saved.clean;
  if(this.disk&&!saved.clean)this.unreviewed=new Set(rows.map(row=>row.id));
  await this.write({...saved,revision:saved.revision+1,clean:false});return{eligible,rows};
 });}
 fingerprint(domain,value){if(!this.value)throw Error('MCP recovery is not initialized.');return sha('SalehAgentMCP:v1\0'+domain+'\0'+this.value.salt+'\0'+canonical(value));}
 async remember(row,current){await this.openBoot();return this.enqueue(async()=>{if(!current())return false;const next={...this.value,revision:this.value.revision+1,clean:false,servers:[...this.value.servers.filter(item=>item.id!==row.id),row]};const saved=await this.write(next,current);if(saved)this.unreviewed.delete(row.id);return saved;});}
 async forget(id=null){await this.openBoot();return this.enqueue(async()=>{const next={...this.value,revision:this.value.revision+1,clean:false,servers:id===null?[]:this.value.servers.filter(row=>row.id!==id)};await this.write(next);if(id===null)this.unreviewed.clear();else this.unreviewed.delete(id);});}
 async close(){if(!this.boot)return;await this.openBoot();return this.enqueue(()=>this.write({...this.value,revision:this.value.revision+1,clean:this.unreviewed.size===0}));}
}
