import {storageValues} from './handoff-storage.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const CHUNK=262144,FILE=32*1024*1024,TOTAL=128*1024*1024,JSON_LIMIT=8*1024*1024,baselines=new WeakMap();
const require=(ok,message)=>{if(!ok)throw Error('Guest content: '+message);};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fold=v=>v.normalize('NFD').toUpperCase().toLowerCase();
const same=(a,b,message)=>require(isDeepStrictEqual(a,b),message);
const parents=path=>path.split('/').slice(0,-1).map((_,i,parts)=>parts.slice(0,i+1).join('/'));
function encoded(data,size,hash,max=FILE){
  require(typeof data==='string'&&data.length<=Math.ceil(max/3)*4&&Number.isSafeInteger(size)&&size>=0&&size<=max&&digest(hash),'invalid byte declaration');
  const bytes=Buffer.from(data,'base64');require(bytes.length===size&&bytes.toString('base64')===data&&sha(bytes)===hash,'byte length, encoding or digest mismatch');return bytes;
}
function inspect(value){
  require(object(value)&&object(value.stamps)&&object(value.rootStamp)&&object(value.excluded)&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=TOTAL,'invalid inventory');
  storageValues(value.rootStamp);
  require(Buffer.byteLength(JSON.stringify(value))<=JSON_LIMIT,'inventory metadata exceeds its bound');
  const rows=new Map(Object.entries(value.stamps)),excluded=Object.keys(value.excluded),aliases=new Map(),groups=new Map();let bytes=0;
  require(rows.size+excluded.length<=20000,'inventory exceeds its entry bound');
  for(const path of [...rows.keys(),...excluded]){
    require(typeof path==='string'&&path&&Buffer.byteLength(path)<=4096&&!path.includes('\0')&&Buffer.from(path).toString('utf8')===path,'invalid inventory path');
    const parts=path.split('/');require(parts.length<=64&&parts.every(p=>p&&p!=='.'&&p!=='..'),'invalid inventory path');
    require(!rows.has(path)||parts.every(p=>fold(p)!=='.git'),'protected inventory path');
    const key=fold(path);require(!aliases.has(key)||aliases.get(key)===path,'aliased inventory path');aliases.set(key,path);
    for(const parent of parents(path))require(rows.get(parent)?.kind==='directory','missing inventory ancestor');
  }
  for(const [path,row] of rows){
    require(object(row)&&['file','directory','symlink'].includes(row.kind)&&Number.isSafeInteger(row.mode)&&row.mode>=0&&row.mode<=0o7777&&object(row.identity)&&/^\d+$/.test(row.identity.dev)&&/^\d+$/.test(row.identity.ino)&&Number.isSafeInteger(row.nlink)&&row.nlink>0,'invalid inventory entry');
    for(const key of ['uid','gid','flags'])require(Number.isSafeInteger(row[key])&&row[key]>=0,'invalid entry metadata');
    require((row.acl===null||typeof row.acl==='string')&&object(row.xattrs),'invalid entry metadata');
    for(const attr of Object.values(row.xattrs)){require(object(attr)&&Number.isSafeInteger(attr.bytes)&&attr.bytes>=0&&attr.bytes<=FILE&&digest(attr.sha256),'invalid attribute');bytes+=attr.bytes;}
    for(const attr of storageValues(row))bytes+=attr.bytes;
    if(row.kind==='file'){
      require(Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=FILE&&digest(row.sha256),'invalid file inventory');bytes+=row.bytes;
      const key=row.identity.dev+':'+row.identity.ino,group=groups.get(key)??[];group.push(path);groups.set(key,group);
    }else if(row.kind==='symlink'){
      require(typeof row.targetBase64==='string'&&row.targetBase64.length<=5464,'invalid literal link');
      const data=Buffer.from(row.targetBase64,'base64');require(data.length>0&&data.length<=4096&&!data.includes(0)&&data.toString('base64')===row.targetBase64&&row.nlink===1,'invalid literal link');bytes+=data.length;
    }
    require(bytes<=TOTAL,'inventory bytes exceed 128 MiB');
  }
  same(bytes,value.bytes,'inventory byte accounting differs');
  const links=new Map();
  for(const group of groups.values()){group.sort();for(const path of group){require(rows.get(path).nlink===group.length,'hardlink leaves the permitted inventory');links.set(path,group);}}
  return {rows,links};
}
function portable(inventory){
  const {rows,links}=inspect(inventory);
  return Object.fromEntries([...rows].sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(([path,row])=>[path,{kind:row.kind,mode:row.mode,...(row.kind==='file'?{bytes:row.bytes,sha256:row.sha256,links:links.get(path)}:row.kind==='symlink'?{targetBase64:row.targetBase64}:{})}]));
}

// Trusted native callback may run on the host donor or the guest. Read-only.
export async function readGuestContentFile({root,inventory,path,native,check}){
  check();const row=inventory.stamps[path];require(row?.kind==='file'&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&row.bytes<=FILE&&digest(row.sha256),'invalid requested file');
  const stamps=Object.fromEntries([...parents(path),path].map(p=>[p,inventory.stamps[p]])),parts=[];
  for(let offset=0;offset<row.bytes||offset===0;){
    check();const result=await native('readContent',{root,rootStamp:inventory.rootStamp,path,stamps,offset,length:CHUNK});check();
    require(object(result)&&Object.keys(result).sort().join(',')==='bytes,data,offset,path,sha256'&&result.path===path&&result.offset===offset&&result.bytes===Math.min(CHUNK,row.bytes-offset),'unexpected content range');
    const bytes=encoded(result.data,result.bytes,result.sha256,CHUNK);parts.push(bytes);offset+=bytes.length;if(offset===row.bytes)break;
  }
  const bytes=Buffer.concat(parts);require(bytes.length===row.bytes&&sha(bytes)===row.sha256,'assembled file digest differs');return bytes;
}

// expected is the immutable host donor inventory; identities/metadata are local
// to each OS. Only portable content, permissions and link topology must match.
export async function captureGuestContent({root,exclude=[],expected,native,check}){
  require(typeof native==='function'&&typeof check==='function','trusted callbacks required');check();
  root=structuredClone(root);exclude=structuredClone(exclude);
  const original=await native('inventory',{root,exclude});check();
  same(portable(original),portable({excluded:{},...expected}),'guest seed differs from captured host donor');
  const handle=Object.freeze({id:randomUUID()});baselines.set(handle,{root,exclude,original:structuredClone(original),used:false});return handle;
}

function validateGuestMetadata(original,current){
  same(Object.keys(current.excluded).sort(),Object.keys(original.excluded).sort(),'excluded namespace changed');
  for(const name of Object.keys(original.excluded)){
    const before=original.excluded[name],after=current.excluded[name];
    require([before,after].every(v=>Array.isArray(v)&&v.length===11&&v.every(x=>typeof x==='string')),'invalid excluded entry receipt');
    // Scratch contents may change between commands; its retained directory,
    // permissions and ownership may not. The final inventory also catches races.
    same([0,1,2,3,4,7,10].map(i=>after[i]),[0,1,2,3,4,7,10].map(i=>before[i]),'excluded identity or metadata changed');
  }
  const before=inspect(original),after=inspect(current);
  // Existing host metadata will be replayed from the host donor. Refuse guest
  // metadata edits the content protocol cannot represent instead of losing them.
  for(const key of ['uid','gid','flags','mode','acl','xattrs','storageXattrs'])same(current.rootStamp[key],original.rootStamp[key],'guest root metadata changed: '+key);
  for(const [path,row] of after.rows){
    const old=before.rows.get(path),retained=old?.kind===row.kind;
    if(retained){
      for(const key of ['uid','gid','flags','acl','xattrs','storageXattrs'])same(row[key],old[key],'unsupported guest metadata change: '+path+' '+key);
      if(row.kind==='directory')same(row.mode,old.mode,'existing directory mode change is unsupported');
    }else{
      require(!Object.hasOwn(row,'storageXattrs')&&row.uid===current.rootStamp.uid&&row.gid===current.rootStamp.gid&&row.flags===0&&row.acl===null&&Object.keys(row.xattrs).every(k=>k==='com.apple.provenance'),'unsupported new guest metadata');
    }
    if(row.kind==='file'){
      const group=retained?before.links.get(path).filter(p=>after.rows.get(p)?.kind==='file'):[path];
      same(after.links.get(path),group,'new, split or merged hardlink topology is unsupported');
    }
  }
  return {before,after};
}
// Non-consuming preflight of the retained guest capability. Use the same
// metadata rules as collection; portable equality alone cannot admit renewal.
export async function verifyGuestContent({baseline,native,check}){
  require(typeof native==='function'&&typeof check==='function','trusted callbacks required');check();
  const state=baselines.get(baseline);require(state&&!state.used,'baseline is unknown or already consumed');
  const {root,exclude,original}=state,current=await native('inventory',{root,exclude});check();
  validateGuestMetadata(original,current);same(portable(current),portable(original),'guest contents changed since the retained baseline');
  same(await native('inventory',{root,exclude}),current,'guest inventory changed during verification');check();return current;
}

// Call inside the same owner publication admission as publishGuestChanges.
// No guest metadata becomes host authority, and no partial collection is returned.
export async function collectGuestChanges({baseline,native,check}){
  require(typeof native==='function'&&typeof check==='function','trusted callbacks required');check();
  const state=baselines.get(baseline);require(state&&!state.used,'baseline is unknown or already consumed');state.used=true;
  const {root,exclude,original}=state,current=await native('inventory',{root,exclude});check();
  const {before,after}=validateGuestMetadata(original,current),changes=[];
  for(const [path,row] of after.rows){
    const old=before.rows.get(path),retained=old?.kind===row.kind;
    const changed=!retained||row.mode!==old.mode||(row.kind==='file'&&(row.bytes!==old.bytes||row.sha256!==old.sha256))||(row.kind==='symlink'&&row.targetBase64!==old.targetBase64);
    if(!changed)continue;
    const change={path,kind:row.kind};
    if(row.kind==='directory'){require([0o700,0o755].includes(row.mode),'unsupported new directory mode');change.mode=row.mode;}
    else if(row.kind==='file'){
      if(!retained||row.mode!==old.mode){require([0o600,0o644,0o700,0o755].includes(row.mode),'unsupported file mode');change.mode=row.mode;}
      if(!retained||row.bytes!==old.bytes||row.sha256!==old.sha256){const bytes=await readGuestContentFile({root,inventory:current,path,native,check});Object.assign(change,{data:bytes.toString('base64'),bytes:bytes.length,sha256:sha(bytes)});}
    }else{
      require(row.mode<=0o777,'unsupported symlink mode');if(!retained||row.mode!==old.mode)change.mode=row.mode;
      const bytes=Buffer.from(row.targetBase64,'base64');Object.assign(change,{data:row.targetBase64,bytes:bytes.length,sha256:sha(bytes)});
    }
    changes.push(change);
  }
  for(const path of before.rows.keys())if(!after.rows.has(path))changes.push({path,kind:'remove'});
  same(await native('inventory',{root,exclude}),current,'guest inventory changed during collection');check();
  return changes.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
}

// Trusted guest-only command route. The owner admission must encompass this
// promise; termination acknowledgement never substitutes for original completion.
export async function runGuestCommandResult({engine,life,command,cwd,input,check,signal,sandboxPolicy={type:'readOnly',networkAccess:false}}){
  require(life?.commands&&engine.processLife===life&&typeof check==='function','current guest command lifetime required');
  require(Array.isArray(command)&&command.length>0&&command.length<=128&&command.every(v=>typeof v==='string'&&!v.includes('\0')&&v.length<=16000)&&command[0].startsWith('/')&&typeof cwd==='string'&&cwd.startsWith('/'),'invalid trusted guest command');
  require(Buffer.isBuffer(input)&&input.length<=Math.ceil(FILE/3)*4,'guest command input exceeds its bound');check();
  if(signal?.aborted)throw signal.reason??Error('Stopped');
  const processId=randomUUID(),marker=Buffer.from('SALEH_READY_'+randomUUID()+'\n'),out=[],err=[];
  let outBytes=0,errBytes=0,readySeen=false,failure,resolveReady,rejectFault,settled=false,readyTimer;
  const ready=new Promise(resolve=>{resolveReady=resolve;}),fault=new Promise((_,reject)=>{rejectFault=reject;});void fault.catch(()=>{});
  const bad=error=>{if(!failure){failure=error instanceof Error?error:Error(String(error));rejectFault(failure);}};
  const onOutput=p=>{try{
    require(p.processId===processId&&['stdout','stderr'].includes(p.stream)&&p.capReached===false,'guest output was uncorrelated or truncated');
    require(typeof p.deltaBase64==='string'&&p.deltaBase64.length<=JSON_LIMIT,'invalid guest output encoding');
    const bytes=Buffer.from(p.deltaBase64,'base64');require(bytes.toString('base64')===p.deltaBase64,'invalid guest output encoding');
    if(p.stream==='stdout'){outBytes+=bytes.length;require(outBytes<=JSON_LIMIT+1,'guest stdout exceeds its bound');out.push(bytes);}
    else{
      errBytes+=bytes.length;require(errBytes<=65536,'guest diagnostics exceed their bound');err.push(bytes);
      if(!readySeen&&errBytes>=marker.length){require(Buffer.concat(err).subarray(0,marker.length).equals(marker),'guest readiness marker differs');readySeen=true;clearTimeout(readyTimer);resolveReady();}
    }
  }catch(error){bad(error);}};
  const work=Promise.resolve(engine.commandRPC(life,'command/exec',{processId,command:['/bin/zsh','-f','-c',`/usr/bin/printf '%s\\n' '${marker.toString().trim()}' >&2; exec "$@"`,'saleh-guest-command',...command],cwd,tty:false,streamStdin:true,streamStdoutStderr:true,timeoutMs:120000,outputBytesCap:JSON_LIMIT+65537,sandboxPolicy},135000,onOutput));
  void work.then(()=>{settled=true;},()=>{settled=true;});
  const abort=()=>bad(signal?.reason??Error('Stopped'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  readyTimer=setTimeout(()=>bad(Error('Guest command readiness timed out')),10000);
  const controls=[];
  const control=(method,params,timeout=10000)=>{const p=Promise.resolve(engine.commandRPC(life,method,{processId,...params},timeout));controls.push(p);void p.catch(()=>{});return p;};
  async function bounded(p,ms){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Guest command completion is unconfirmed')),ms);})]);}finally{clearTimeout(timer);}}
  try{
    await Promise.race([ready,fault,work.then(()=>{throw Error('Guest command exited before input admission');})]);check();
    for(let offset=0;offset<input.length;offset+=CHUNK){check();await Promise.race([control('command/exec/write',{deltaBase64:input.subarray(offset,offset+CHUNK).toString('base64')}),fault]);}
    check();await Promise.race([control('command/exec/write',{closeStdin:true}),fault]);
    const result=await Promise.race([work,fault]);if(failure)throw failure;check();
    require(result&&Number.isInteger(result.exitCode)&&result.exitCode>=0&&result.exitCode<=255&&result.stdout===''&&result.stderr==='','guest command returned invalid exit code or unexpected buffered output');
    require(readySeen,'guest readiness marker is missing');
    return {stdout:Buffer.concat(out),stderr:Buffer.concat(err).subarray(marker.length),code:result.exitCode};
  }catch(error){
    if(!settled)try{await bounded(control('command/exec/terminate',{},5000),6000);}catch{}
    // Both original completion and outstanding accepted controls must settle.
    const drained=await bounded(Promise.allSettled([work,...controls]),15000);
    if(drained[0].status==='rejected')throw Error('Guest command completion is unconfirmed',{cause:drained[0].reason});throw error;
  }finally{clearTimeout(readyTimer);signal?.removeEventListener('abort',abort);}
}

// Native/content callers retain their strict zero-exit, no-diagnostics contract.
export async function runGuestCommand(options){
  const result=await runGuestCommandResult(options);
  require(result.code===0,'guest command exited with code '+result.code);
  require(result.stderr.length===0,'guest command reported diagnostics');return result.stdout;
}

export async function guestNative(context,action,input){
  require(['inventory','readContent','materialize','publish'].includes(action),'unsupported guest native action');
  const bytes=Buffer.from(JSON.stringify(input));require(bytes.length<=JSON_LIMIT,'native JSON input exceeds 8 MiB');
  const result=await runGuestCommand({...context,command:[context.helper,'--handoff-files',action],input:bytes});
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result));require(object(value),'invalid native JSON result');return value;
}
