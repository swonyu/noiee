import {nativeByteSizes,storageValues} from './handoff-storage.mjs';
import {mkdir,lstat,realpath,writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {handoffPublishedState} from './handoff-native.mjs';

const baselines=new WeakMap(),conflicts=new WeakMap(),FILE=32*1024*1024,TOTAL=128*1024*1024;
// Origin only: the owner separately certifies original worker settlement.
export const isGuestPublicationConflict=(error,check)=>typeof check==='function'&&conflicts.get(error)===check;
const fail=message=>{throw Error('Guest publication: '+message);};
const require=(ok,message)=>{if(!ok)fail(message);};
const same=(a,b,message)=>require(isDeepStrictEqual(a,b),message);
const fold=name=>name.normalize('NFD').toUpperCase().toLowerCase();
const below=(a,b)=>a===b||b.startsWith(a+'/');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const parents=name=>name.split('/').slice(0,-1).map((_,i)=>name.split('/').slice(0,i+1).join('/'));
const clean=state=>({root:state.root,stamps:state.stamps,rootStamp:state.rootStamp});
const snapshot=state=>({stamps:state.stamps,bytes:state.bytes,rootStamp:state.rootStamp});
const sorted=map=>Object.fromEntries([...map].sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
function callbacks(native,checkpoint,check){require(typeof native==='function'&&typeof checkpoint==='function'&&typeof check==='function','trusted native, durable checkpoint and admission check required');}
async function privateRoot(path,device){
  require(typeof path==='string'&&isAbsolute(path)&&await realpath(path)===path,'private directory must be canonical and absolute');
  const s=await lstat(path,{bigint:true});
  require(s.isDirectory()&&s.uid===BigInt(process.getuid())&&!(s.mode&0o077n)&&String(s.dev)===device,'private directory ownership, permissions or device mismatch');
  return {path,dev:String(s.dev),ino:String(s.ino)};
}
async function childRoot(state,name,check){
  check();await privateRoot(state.directory,state.root.dev);
  const path=join(state.directory,name);await mkdir(path,{mode:0o700});
  const root=await privateRoot(path,state.root.dev);check();return root;
}

// Host-only capability: capture before guest execution. Call inside owner.publish.
// native must save each mutating worker's process receipt before release and settle
// only after actual worker closure AND every durable callback, including on Stop.
export async function captureGuestPublication({root,exclude=[],directory,native,checkpoint,check}){
  callbacks(native,checkpoint,check);check();
  root=structuredClone(root);exclude=structuredClone(exclude);
  const work=await privateRoot(directory,root.dev);
  require(!below(root.path,directory)&&!below(directory,root.path),'private workspace overlaps project');
  const empty=await native('inventory',{root:work,exclude:[]});
  require(Object.keys(empty.stamps).length===0&&Object.keys(empty.excluded).length===0&&empty.rootStamp.acl===null,'workspace is not empty or has an ACL');check();
  const original=await native('inventory',{root,exclude});check();
  const state={id:randomUUID(),root,exclude,directory,original,used:false};
  const donorRoot=await childRoot(state,'donor',check);
  state.donor={root:donorRoot,...await native('copy',{source:root,destination:donorRoot,stamps:original.stamps})};check();
  same(await native('inventory',{root,exclude}),original,'host changed while copying baseline');check();
  await checkpoint('baseline',structuredClone({version:1,...state}));check();
  // A caller can export the donor, but cannot replace the captured host authority.
  const handle=Object.freeze({id:state.id,donor:structuredClone(state.donor)});baselines.set(handle,state);return handle;
}

// Inspection never consumes or changes a publication capability. Only the
// retained host-Git coordinator may allow the known .git directory metadata to
// change; every working entry and root metadata value still has to match.
export async function verifyGuestPublication({baseline,native,check,gitMetadataChanged=false}){
  check();const state=baselines.get(baseline);require(state&&!state.used,'baseline is unknown or already consumed');
  const current=await native('inventory',{root:state.root,exclude:state.exclude});check();
  if(!gitMetadataChanged){same(current,state.original,'host changed since guest baseline');return current;}
  const before=state.original.excluded['.git'],after=current.excluded['.git'];
  require(Array.isArray(before)&&Array.isArray(after)&&before.length===11&&after.length===11,'Git exclusion identity is unavailable');
  same([0,1,2,3,4,7,10].map(i=>after[i]),[0,1,2,3,4,7,10].map(i=>before[i]),'host Git identity changed');
  same({...current,excluded:{...current.excluded,'.git':before}},state.original,'host working content changed during Git operation');return current;
}

function selection(state,changes){
  require(Array.isArray(changes)&&changes.length<=20000,'invalid change count');
  const original=new Map(Object.entries(state.original.stamps)),desired=new Map(original),operations=new Map(),payloads=new Map(),aliases=new Map();let total=0;
  const excluded=[...state.exclude,...Object.keys(state.original.excluded)].map(fold);
  function name(path,protectedPath=false){
    require(typeof path==='string'&&path.length>0&&Buffer.byteLength(path)<=4096&&!path.includes('\0')&&Buffer.from(path).toString('utf8')===path,'invalid path');
    const parts=path.split('/');require(parts.length<=64&&parts.every(p=>p&&p!=='.'&&p!=='..'&&(protectedPath||fold(p)!=='.git')),'protected or invalid path');
    let prefix='';for(const part of parts){prefix+=(prefix?'/':'')+part;const key=fold(prefix);require(!aliases.has(key)||aliases.get(key)===prefix,'case or Unicode alias');aliases.set(key,prefix);}
  }
  for(const path of [...original.keys(),...Object.keys(state.original.excluded),...state.exclude])name(path,true);
  for(const change of changes){
    require(change&&typeof change==='object'&&!Array.isArray(change),'invalid change record');
    const {path,kind,mode}=change;name(path);
    require(!operations.has(path),'duplicate change');
    require(!excluded.some(x=>below(x,fold(path))||below(fold(path),x)),'change intersects excluded content');
    require(['file','directory','symlink','remove'].includes(kind),'unsupported change kind');
    const allowed=kind==='remove'?['path','kind']:kind==='directory'?['path','kind','mode']:['path','kind','data','bytes','sha256','mode'];
    require(Object.keys(change).every(k=>allowed.includes(k)),'guest metadata or unknown fields are not permitted');
    const before=original.get(path),entry={kind};
    if(kind==='remove'){
      require(before,'removal is absent from baseline');desired.delete(path);operations.set(path,entry);continue;
    }
    if(mode!==undefined)require(Number.isSafeInteger(mode)&&(kind==='symlink'?mode>=0&&mode<=0o777:(kind==='directory'?[0o700,0o755]:[0o600,0o644,0o700,0o755]).includes(mode)),'unsupported mode');
    if(before?.kind===kind)entry.donor=0;
    if(kind==='directory'){
      if(before?.kind==='directory'){require(mode===undefined||mode===before.mode,'existing directory mode changes are unsupported');continue;}
      entry.mode=mode??0o755;
    }else{
      const hasPayload=['data','bytes','sha256'].some(k=>Object.hasOwn(change,k));
      if(hasPayload){
        require(typeof change.data==='string'&&change.data.length<=Math.ceil(FILE/3)*4&&Number.isSafeInteger(change.bytes)&&change.bytes>=0&&change.bytes<=FILE&&typeof change.sha256==='string'&&/^[a-f0-9]{64}$/.test(change.sha256),'invalid payload declaration');
        const bytes=Buffer.from(change.data,'base64');
        require(bytes.length===change.bytes&&bytes.toString('base64')===change.data&&sha(bytes)===change.sha256,'payload size or digest mismatch');
        total+=bytes.length;require(total<=TOTAL,'payloads exceed 128 MiB');
        if(kind==='symlink')require(bytes.length>0&&bytes.length<=4096&&!bytes.includes(0),'invalid literal symlink payload');
        entry.payload=change.sha256;payloads.set(entry.payload,bytes);
      }else require(entry.donor===0&&mode!==undefined,'new entries require payloads');
      if(mode!==undefined)entry.mode=mode;
      if(entry.donor===undefined)entry.mode=mode??(kind==='symlink'?0o777:0o644);
    }
    operations.set(path,entry);desired.set(path,entry);
  }
  require(desired.size+Object.keys(state.original.excluded).length<=20000,'final namespace exceeds 20,000 entries including exclusions');
  let liveBytes=0;
  for(const [path,entry] of desired){
    const changed=operations.has(path),donor=changed?(entry.donor===0?original.get(path):null):entry;
    const bytes=changed&&entry.payload?payloads.get(entry.payload).length:donor?.kind==='file'?donor.bytes:donor?.kind==='symlink'?Buffer.from(donor.targetBase64,'base64').length:0;
    liveBytes+=bytes+Object.values(donor?.xattrs??{}).reduce((sum,x)=>sum+x.bytes,0)+(donor&&!changed?storageValues(donor).reduce((sum,x)=>sum+x.bytes,0):0);
    require(liveBytes<=TOTAL,'final live bytes exceed 128 MiB');
  }
  for(const [path] of desired)for(const parent of parents(path))require(desired.get(parent)?.kind==='directory','missing final directory ancestor');
  // Removing/replacing directories requires an explicit decision for every child.
  for(const [path,entry] of operations)if(original.get(path)?.kind==='directory'&&entry.kind!=='directory'){
    for(const child of original.keys())if(child.startsWith(path+'/'))require(operations.get(child)?.kind==='remove','directory removal has unselected descendants');
  }
  const groups=new Map();for(const [path,row] of original)if(row.kind==='file'){
    const key=row.identity.dev+':'+row.identity.ino,list=groups.get(key)??[];list.push(path);groups.set(key,list);
  }
  for(const group of groups.values())if(group.some(n=>operations.has(n))){
    const surviving=group.filter(n=>desired.get(n)?.kind==='file');
    let decision;
    for(const path of surviving){
      const entry=operations.get(path)??{kind:'file',donor:0},row=original.get(path);
      require(entry.donor===0,'new hardlink topology is unsupported');
      const value={payload:entry.payload??null,mode:entry.mode??row.mode};
      if(decision)same(value,decision,'hardlink aliases require identical content and modes');else decision=value;
      operations.set(path,entry);
    }
  }
  const install=[],remove=[],entries=new Map(),before=new Map();
  for(const [path,entry] of operations){
    if(entry.kind==='remove')remove.push(path);else {install.push(path);entries.set(path,entry);}
    for(const n of [path,...parents(path)])if(original.has(n))before.set(n,original.get(n));
  }
  for(const path of install)for(const parent of parents(path))if(!entries.has(parent)){
    require(original.get(parent)?.kind==='directory','new ancestor must be explicit');entries.set(parent,{kind:'directory',donor:0});
  }
  return {install:install.sort(),remove:remove.sort(),entries:sorted(entries),before:sorted(before),payloads};
}

// One-shot publication. The calling owner's operation must include this entire
// promise. Exceptions retain the owner's fence; this function never removes evidence.
export async function publishGuestChanges({baseline,changes,native,checkpoint,check}){
  callbacks(native,checkpoint,check);check();
  const state=baselines.get(baseline);require(state&&!state.used,'baseline is unknown or already consumed');state.used=true;
  const selected=selection(state,changes),{root,exclude,original}=state;
  // ponytail: any permitted host change conflicts. Add disjoint merging only with a reviewed conflict policy.
  const current=await native('inventory',{root,exclude});
  try{same(current,original,'host changed since guest baseline');}
  catch(error){conflicts.set(error,check);throw error;}
  check();
  if(selected.install.length+selected.remove.length===0){
    const result={published:false,unchanged:true,live:structuredClone({root,...original})};await checkpoint('outcome',structuredClone(result));return result;
  }
  const payloadRoot=await childRoot(state,'payload',check);
  for(const [slot,bytes] of selected.payloads){check();await writeFile(join(payloadRoot.path,slot),bytes,{flag:'wx',mode:0o600,flush:true});check();}
  const payload={root:payloadRoot,...await native('inventory',{root:payloadRoot,exclude:[]})};check();
  same(Object.keys(payload.stamps).sort(),[...selected.payloads.keys()].sort(),'unexpected payload namespace');
  require(Object.keys(payload.excluded).length===0,'unexpected excluded payload');
  for(const [slot,bytes] of selected.payloads){const row=payload.stamps[slot];require(row.kind==='file'&&row.nlink===1&&row.bytes===bytes.length&&row.sha256===sha(bytes),'payload changed on disk');}
  const stageRoot=await childRoot(state,'stage',check),now=Date.now(),timestamp=Math.floor(now/1000)+':'+(now%1000)*1000000;
  const stage={root:stageRoot,...await native('materialize',{destination:stageRoot,donors:[clean(state.donor)],payload:clean(payload),entries:selected.entries,timestamp})};check();
  same(Object.keys(stage.stamps).sort(),Object.keys(selected.entries).sort(),'unexpected materialized namespace');
  for(const [path,entry] of Object.entries(selected.entries)){
    const row=stage.stamps[path],donor=entry.donor===0?state.donor.stamps[path]:null,bytes=selected.payloads.get(entry.payload);
    require(storageValues(row).length===0,'unexpected materialized storage');
    require(row.kind===entry.kind&&row.mode===(entry.mode??donor?.mode),'materialized kind or mode differs');
    if(bytes)require(row.kind==='file'?row.bytes===bytes.length&&row.sha256===sha(bytes):row.targetBase64===bytes.toString('base64'),'materialized content differs');
    if(donor)for(const key of ['uid','gid','flags','xattrs','storageXattrs','acl','birthtime',...(bytes?[]:['mtime'])])same(row[key],donor[key],'donor metadata differs: '+key);
  }
  // Include synthesized kernel metadata and unchanged host files in the final
  // inventory bounds, not just the changed stage. Keep retained ancestor rows.
  const projected=new Map(Object.entries(original.stamps));
  for(const path of selected.remove)projected.delete(path);
  for(const path of selected.install)projected.set(path,stage.stamps[path]);
  let finalBytes=0;
  for(const row of projected.values())for(const size of nativeByteSizes(row))finalBytes+=size;
  require(finalBytes<=TOTAL,'final native bytes exceed 128 MiB');
  const finalInventory={stamps:sorted(projected),bytes:finalBytes,rootStamp:original.rootStamp,excluded:original.excluded};
  // Bound either JSON serializer's escaping plus generated inode/time/link values.
  const encoded=JSON.stringify(finalInventory).replace(/[\/\u007f-\uffff]/g,c=>c==='/'?'\\/':'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  require(Buffer.byteLength(encoded)+128*(projected.size+Object.keys(original.excluded).length+1)<=8*1024*1024,'final inventory metadata exceeds its bounded limit');
  const captureRoot=await childRoot(state,'capture',check),capture={root:captureRoot,...await native('inventory',{root:captureRoot,exclude:[]})};check();
  require(!Object.keys(capture.stamps).length&&!Object.keys(capture.excluded).length,'capture is not empty');
  const candidate={...stage,before:selected.before,beforeRootStamp:original.rootStamp,install:selected.install,remove:selected.remove,capture};
  const plan={native:{destination:{root,...original,ignored:Object.keys(original.excluded),omitted:exclude}},stages:{destination:candidate}};
  await checkpoint('plan',structuredClone(plan));check();
  same(await native('inventory',{root,exclude}),original,'host changed before publication');check();
  const receipt=await native('publish',{root,stage:stageRoot,capture:captureRoot,before:selected.before,staged:stage.stamps,beforeRootStamp:original.rootStamp,stagedRootStamp:stage.rootStamp,captureRootStamp:capture.rootStamp,install:selected.install,remove:selected.remove});
  const result=handoffPublishedState(plan,'destination',receipt);
  // After an admitted effect, complete observation and durable outcome even if
  // Stop makes the caller's response stale. settle permits read-only inspection.
  for(const [label,expected] of Object.entries(result)){
    const actual=await native('inventory',{root:expected.root,exclude:label==='live'?exclude:[]},{settle:true});
    same(snapshot(actual),snapshot(expected),'independent '+label+' state differs');
    same(actual.excluded,label==='live'?original.excluded:{},'independent excluded namespace differs');
  }
  const outcome={published:true,...result,live:{...result.live,excluded:structuredClone(original.excluded)},receipt};await checkpoint('outcome',structuredClone(outcome));return outcome;
}
