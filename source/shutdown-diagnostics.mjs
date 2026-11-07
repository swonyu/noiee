import {mkdir,lstat,realpath,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute,dirname,normalize} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const names=['command','inference','tools','worktrees','git','schedules','coding'];
const same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const privateDir=s=>s.isDirectory()&&s.uid===process.getuid()&&!(s.mode&0o077);
const settled=result=>result?.stopped!==false&&result?.state!=='unknown';
async function syncDirectory(path,identity){
  const directory=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);
  try{
    if(!same(await directory.stat(),identity)||await realpath(path)!==path)throw Error('Diagnostic directory changed');
    await directory.sync();if(!same(await lstat(path),identity))throw Error('Diagnostic directory changed');
  }finally{await directory.close();}
}

// Diagnostic observations only. Neither a PID nor a saved outcome authorizes recovery.
export class ShutdownDiagnostics {
  constructor(dataDir){
    this.dataDir=dataDir;this.id=randomUUID();this.startedAt=Date.now();this.record=null;
    this.work=Promise.resolve();this.failed=false;this.savedRevision=0;
  }
  view(){return {record:structuredClone(this.record),persistence:this.failed?'failed':this.dataDir===undefined?'unavailable':!this.record?'idle':this.savedRevision===this.record.revision?'saved':'pending',savedRevision:this.savedRevision};}
  begin(trigger){
    if(this.record)return;
    const now=Date.now();this.record={version:1,id:this.id,pid:process.pid,startedAt:this.startedAt,requestedAt:now,updatedAt:now,revision:0,
      trigger:['native-request','parent-eof','sigterm','sigint'].includes(trigger)?trigger:'native-request',state:'pending',executionRevoked:null,
      subsystems:Object.fromEntries(names.map(name=>[name,'pending']))};this.save();
  }
  observe(name,result,failed=false){
    if(!this.record||!names.includes(name))return;
    this.record.subsystems[name]=failed?'failed':settled(result)?'closed':'unconfirmed';this.save();
  }
  async finish(result){
    this.record.state=result?.stopped===true?'closed':'unconfirmed';
    this.record.executionRevoked=typeof result?.results?.coding?.executionRevoked==='boolean'?result.results.coding.executionRevoked:null;
    this.save();await this.work;return !this.failed;
  }
  save(){
    this.record.revision++;this.record.updatedAt=Date.now();
    if(this.dataDir===undefined)return; // Injected resource-free hosts have no persistent store.
    const snapshot=structuredClone(this.record);
    this.work=this.work.then(async()=>{
      if(this.failed)return;
      try{await this.write(snapshot);this.savedRevision=snapshot.revision;}catch{this.failed=true;}
    });
  }
  async directory(){
    if(!this.dir){
      if(typeof this.dataDir!=='string'||!isAbsolute(this.dataDir)||normalize(this.dataDir)!==this.dataDir)throw Error('Invalid diagnostic directory');
      const created=await mkdir(this.dataDir,{recursive:true,mode:0o700});
      if(!privateDir(await lstat(this.dataDir)))throw Error('Unsafe diagnostic parent');
      this.parent=await realpath(this.dataDir);this.parentIdentity=await lstat(this.parent);
      this.dir=join(this.parent,'shutdown');await mkdir(this.dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      const s=await lstat(this.dir);if(!privateDir(s)||await realpath(this.dir)!==this.dir)throw Error('Unsafe diagnostic directory');
      this.directoryIdentity=s;this.file=join(this.dir,this.id+'.json');
      // Sync every newly created directory entry, including a previously absent data root.
      await syncDirectory(this.parent,this.parentIdentity);
      if(created){
        const first=await realpath(created);let directory=this.parent;
        if(directory!==first&&!directory.startsWith(first+'/'))throw Error('Diagnostic ancestry changed');
        while(true){const parent=dirname(directory);await syncDirectory(parent,await lstat(parent));if(directory===first)break;directory=parent;}
      }
    }
    const parent=await lstat(this.parent),directory=await lstat(this.dir);
    if(!privateDir(parent)||!privateDir(directory)||!same(parent,this.parentIdentity)||!same(directory,this.directoryIdentity)||await realpath(this.dir)!==this.dir)throw Error('Diagnostic directory changed');
  }
  async current(){
    let s;try{s=await lstat(this.file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.nlink!==1||s.size>16384)throw Error('Unsafe diagnostic file');
    const file=await open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const before=await file.stat();if(!same(s,before))throw Error('Diagnostic file changed');
      const bytes=Buffer.alloc(16385);let size=0;
      while(size<bytes.length){const r=await file.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}
      const after=await file.stat();
      if(size>16384||size!==s.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||!same(after,await lstat(this.file)))throw Error('Diagnostic file changed');
      return {identity:after,hash:hash(bytes.subarray(0,size))};
    }finally{await file.close();}
  }
  async unchanged(){
    await this.directory();const current=await this.current();
    if(Boolean(current)!==Boolean(this.disk)||current&&(!same(current.identity,this.disk.identity)||current.hash!==this.disk.hash))throw Error('Diagnostic record changed externally');
  }
  async write(snapshot){
    let temp;
    try{
      await this.unchanged();const bytes=Buffer.from(JSON.stringify(snapshot)+'\n');
      temp=join(this.dir,this.id+'.'+randomUUID()+'.tmp');
      const file=await open(temp,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
      // ponytail: one writer per random run ID; hostile same-user concurrent writers require a stronger filesystem boundary.
      await this.unchanged();await rename(temp,this.file);temp=null;
      this.disk={identity:await lstat(this.file),hash:hash(bytes)};
      await syncDirectory(this.dir,this.directoryIdentity);
    }finally{if(temp)await unlink(temp).catch(()=>{});}
  }
}
