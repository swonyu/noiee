import {nativeByteSizes,storageValues,independentCopyContent} from './handoff-storage.mjs';
import {isDeepStrictEqual} from 'node:util';
import {posix} from 'node:path';

const fail=message=>{throw new Error('Invalid native handoff recovery: '+message);};
const require=(condition,message)=>{if(!condition)fail(message);};
const same=(a,b,message)=>require(isDeepStrictEqual(a,b),message);
const own=(value,key)=>Object.hasOwn(value,key);
const order=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const sorted=rows=>Object.fromEntries([...rows].sort(([a],[b])=>order(a,b)));
const without=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)));
const content=row=>without(row,['identity','ctime',...(row.kind==='directory'?['nlink']:[])]);
const structure=row=>without(row,['identity','ctime','mtime','nlink']);
const identity=row=>row.identity.dev+':'+row.identity.ino;
const below=(parent,path)=>path===parent||path.startsWith(parent+'/');
const fold=path=>path.normalize('NFD').toUpperCase().toLowerCase();
const clean=({root,stamps,rootStamp})=>({root,stamps,rootStamp});
function parents(name){const out=[];for(let p=posix.dirname(name);p!=='.';p=posix.dirname(p))out.push(p);return out;}
function keys(value,expected,message){same(Object.keys(value).sort(order),[...expected].sort(order),message);}
function time(value){return typeof value==='string'&&/^-?(0|[1-9]\d{0,18}):(0|[1-9]\d{0,8})$/.test(value)&&value.split(':')[0]!== '-0'&&BigInt(value.split(':')[0])>=-9223372036854775808n&&BigInt(value.split(':')[0])<=9223372036854775807n;}
function namespace(rows){
  require(Object.keys(rows).length<=20000,'selected path limit');const seen=new Set();
  for(const [name,row] of Object.entries(rows)){
    require(name&&Buffer.byteLength(name)<=4096&&name.split('/').every(x=>x&&x!=='.'&&x!=='..'&&fold(x)!=='.git'&&!x.includes('\0')),'invalid selected path');
    require(!seen.has(fold(name)),'case or Unicode path alias');seen.add(fold(name));
    require(['file','directory','symlink'].includes(row.kind),'unsupported native entry');
    for(const p of parents(name))require(own(rows,p)&&rows[p].kind==='directory','missing directory ancestor: '+name);
  }
}
function state(root,stamps,rootStamp){
  namespace(stamps);same(rootStamp.identity,{dev:root.dev,ino:root.ino},'root identity');require(rootStamp.kind==='directory','root kind');let bytes=0;
  for(const row of Object.values(stamps))for(const size of nativeByteSizes(row)){
    require(Number.isSafeInteger(size)&&size>=0&&size<=32*1024*1024,'entry byte limit');bytes+=size;require(bytes<=128*1024*1024,'selected byte limit');
  }
  return {root,stamps,rootStamp,bytes};
}
function topology(roots){
  const dirs=new Set(),leaves=new Map();
  for(const value of roots){
    const id=identity(value.rootStamp);require(!dirs.has(id),'root inode reused');dirs.add(id);
    for(const row of Object.values(value.stamps)){
      require(row.identity.dev===value.root.dev,'entry device differs');const id=identity(row);
      if(row.kind==='directory'){require(!dirs.has(id),'directory inode reused');dirs.add(id);}
      else {const group=leaves.get(id)??[];group.push(row);leaves.set(id,group);}
    }
  }
  for(const [id,rows] of leaves){require(!dirs.has(id),'leaf reuses directory inode');require(rows[0].nlink===rows.length&&(rows[0].kind!=='symlink'||rows.length===1),'incomplete retained hardlink group');for(const row of rows)same(row,rows[0],'hardlink aliases differ');}
}
function independentCopy(original,copy,message){
  keys(copy.stamps,Object.keys(original.stamps),message+' namespace');
  const mapping=new Map(),reverse=new Map();
  for(const [name,row] of Object.entries(original.stamps)){
    require(storageValues(copy.stamps[name]).length===0,message+' unexpected target storage: '+name);
    same(content(copy.stamps[name]),independentCopyContent(row),message+' metadata: '+name);
    const from=identity(row),to=identity(copy.stamps[name]);require(from!==to,message+' must be independent');
    require(!mapping.has(from)||mapping.get(from)===to,message+' lost hardlink');require(!reverse.has(to)||reverse.get(to)===from,message+' joined unrelated inodes');mapping.set(from,to);reverse.set(to,from);
  }
  topology([copy]);
}

// Pure: run before creating recovery roots. `observed` is the freshly verified
// live-first recoverySnapshot; original stage/capture precede journal-owned pairs.
// `temporary` contains only current scratch descriptors already verified by caller.
export function reviewHandoffRecoveryFiles(manifest,label,mode,observed,{temporary=[]}={}){
  require(['source','destination'].includes(label)&&['restore','finish'].includes(mode),'label or mode');
  require(Array.isArray(observed?.roots)&&observed.roots.length>=3&&observed.roots.length<=7,'recovery witness capacity exceeded before root creation');
  const original=manifest.native[label],candidate=manifest.stages[label],copy=manifest.copies[label],live=observed.roots[0];
  same(live.root,original.root,'live checkout descriptor');same(observed.roots[1].root,candidate.root,'original stage descriptor');same(observed.roots[2].root,candidate.capture.root,'original capture descriptor');
  const roots=observed.roots.map(value=>state(value.root,value.stamps,value.rootStamp));same(roots,observed.roots,'observed native state');same(roots.reduce((n,r)=>n+r.bytes,0),observed.bytes,'observed byte count');topology(roots);
  same(without(live.rootStamp,['ctime','mtime','nlink']),without(original.rootStamp,['ctime','mtime','nlink']),'root structural metadata cannot be recreated');
  independentCopy(original,copy,'immutable original');
  const donors=[copy];if(mode==='finish'){require(candidate.immutable,'Finish requires an immutable candidate; legacy handoff can only Restore');independentCopy(candidate,candidate.immutable,'immutable candidate');donors.push(candidate.immutable);}
  const excluded=[...new Set(['.git',...original.ignored,...temporary.filter(t=>t.cwd===original.root.path).map(t=>{require(t.path.startsWith(t.cwd+'/'),'scratch descriptor path');return t.path.slice(t.cwd.length+1);})])];
  const excludedBelow=name=>excluded.some(x=>below(fold(name),fold(x))),insideExcluded=name=>excluded.some(x=>below(fold(x),fold(name)));
  const choices=new Map(Object.keys(copy.stamps).map(name=>[name,0]));
  if(mode==='finish'){
    for(const name of candidate.remove){require(choices.has(name),'candidate removes unknown original');choices.delete(name);}
    for(const name of candidate.install){require(own(candidate.immutable.stamps,name),'candidate install has no immutable donor');choices.set(name,1);}
  }
  const desired=sorted([...choices].map(([name,index])=>[name,structuredClone(donors[index].stamps[name])]));namespace(desired);
  // Surviving same-donor aliases form the final groups; materialize projects their
  // nlink count without joining independent original/candidate inodes.
  const groups=new Map();for(const [name,row] of Object.entries(desired))if(row.kind==='file'){const key=choices.get(name)+':'+identity(row),group=groups.get(key)??[];group.push(name);groups.set(key,group);}for(const group of groups.values())for(const name of group)desired[name].nlink=group.length;
  const bytes=state(live.root,desired,original.rootStamp).bytes;
  for(const [name,row] of Object.entries(desired))require(!insideExcluded(name)&&!(row.kind!=='directory'&&excludedBelow(name)),'target conflicts with excluded content: '+name);
  for(const name of Object.keys(live.stamps))require(!insideExcluded(name),'observed selection includes excluded content: '+name);
  const install=new Set(),remove=new Set(),retained=new Set();
  for(const [name,row] of Object.entries(desired)){
    const before=live.stamps[name];
    if(row.kind==='directory'&&before?.kind==='directory'&&isDeepStrictEqual(structure(before),structure(row)))retained.add(name);else install.add(name);
  }
  // Replacing an ancestor requires capturing every selected descendant, including
  // otherwise compatible directories. Excluded descendants make that impossible.
  for(const name of [...retained])if(parents(name).some(p=>install.has(p))) {retained.delete(name);install.add(name);}
  for(const name of Object.keys(live.stamps))if(!retained.has(name)&&!install.has(name))remove.add(name);
  for(const name of [...install,...remove]){
    require(!(live.stamps[name]?.kind==='directory'&&excludedBelow(name)),'directory replacement includes excluded content: '+name);
    require(!(desired[name]?.kind==='directory'&&(live.stamps[name]?.flags&0x40)),'document-tracked original cannot become a directory');
  }
  const stagedNames=new Set([...install].flatMap(name=>[name,...parents(name)])),entries=sorted([...stagedNames].map(name=>[name,{kind:desired[name].kind,donor:choices.get(name)}]));
  const directoryTimes=sorted([['',original.rootStamp.mtime],...[...retained].map(name=>[name,desired[name].mtime])]);for(const value of Object.values(directoryTimes))require(time(value),'invalid desired directory timestamp');
  const captured=Object.fromEntries([...new Set([...remove,...[...install].filter(name=>own(live.stamps,name))])].sort(order).map((name,i)=>[name,String(i).padStart(8,'0')]));
  return structuredClone({label,mode,bytes,observed,donors:donors.map(clean),desired:{stamps:desired,rootStamp:original.rootStamp},excluded,entries,install:[...install].sort(order),remove:[...remove].sort(order),directoryTimes,captured});
}

// The manager must persist stage/capture ownership under its current attempt before
// this function's first writable native callback. It supplies the gated callback.
export async function prepareHandoffRecoveryFiles(review,{stage,capture,native,check}){
  review=structuredClone(review);check();
  const run=async(action,input)=>{check();const result=await native(action,input);check();return result;};
  const observe=async()=>same(await run('recoverySnapshot',{roots:review.observed.roots.map(value=>({root:value.root,paths:Object.keys(value.stamps)}))}),review.observed,'reviewed live or retained witness changed');
  await observe();
  for(const donor of review.donors){const current=await run('snapshot',{root:donor.root,paths:Object.keys(donor.stamps)});same(current.stamps,donor.stamps,'immutable donor entries changed');same(current.rootStamp,donor.rootStamp,'immutable donor root changed');}
  const empty={root:capture,...await run('snapshot',{root:capture,paths:[]})};
  const staged={root:stage,...await run('materialize',{destination:stage,donors:review.donors,payload:clean(empty),entries:review.entries,timestamp:'0:0'})};
  keys(staged.stamps,Object.keys(review.entries),'materialized namespace');
  independentCopy({stamps:Object.fromEntries(Object.keys(review.entries).map(name=>[name,review.desired.stamps[name]]))},staged,'materialized immutable');
  await observe();
  const input={root:review.observed.roots[0].root,stage,capture,before:review.observed.roots[0].stamps,staged:staged.stamps,beforeRootStamp:review.observed.roots[0].rootStamp,stagedRootStamp:staged.rootStamp,captureRootStamp:empty.rootStamp,install:review.install,remove:review.remove,retained:review.observed.roots.slice(1).map(clean),directoryTimes:review.directoryTimes};
  return {review,desired:review.desired,excluded:review.excluded,captured:review.captured,stage:staged,capture:empty,input};
}

// This validates/projections a receipt only. The caller must freshly enumerate the
// selected live namespace and every exact private tree, then recoverySnapshot all
// returned roots and compare them before declaring the transaction complete.
export function handoffRecoveryPublishedState(prepared,receipt){
  const {input,desired}=prepared,install=new Set(input.install),captured=new Set([...input.remove,...input.install.filter(name=>own(input.before,name))]);
  keys(receipt,['live','capture','remainingStage','captured','liveRootStamp','remainingStageRootStamp','captureRootStamp','retained'],'receipt fields');
  keys(receipt.live,Object.keys(desired.stamps),'complete live namespace');keys(receipt.captured,captured,'captured name set');
  const expectedSlots=Object.fromEntries([...captured].sort(order).map((name,i)=>[name,String(i).padStart(8,'0')]));same(prepared.captured,expectedSlots,'reviewed UTF-8 capture slots');same(receipt.captured,expectedSlots,'receipt UTF-8 capture slots');
  const slots=[...captured].map((_,i)=>String(i).padStart(8,'0'));same(Object.values(receipt.captured).sort(order),slots,'capture slot bijection');keys(receipt.capture,slots,'capture namespace');
  const directories=Object.keys(input.staged).filter(name=>input.staged[name].kind==='directory');keys(receipt.remainingStage,directories,'remaining stage namespace');
  const known=new Set([input.beforeRootStamp,input.stagedRootStamp,input.captureRootStamp,desired.rootStamp,...Object.values(desired.stamps),...Object.values(input.before),...Object.values(input.staged),...input.retained.flatMap(value=>[value.rootStamp,...Object.values(value.stamps)])].map(identity));
  const match=(actual,expected,message,newDirectory=false)=>{
    require(actual&&time(actual.ctime)&&Number.isSafeInteger(actual.nlink)&&actual.nlink>0,message+' native clock/link count');
    const omitted=['ctime',...(expected.kind==='directory'?['nlink']:[]),...(newDirectory?['identity']:[])];same(without(actual,omitted),without(expected,omitted),message);
    if(newDirectory){keys(actual.identity,['dev','ino'],message+' identity');require(actual.identity.dev===expected.identity.dev&&/^[1-9]\d{0,19}$/.test(actual.identity.ino)&&BigInt(actual.identity.ino)<=18446744073709551615n&&!known.has(identity(actual)),message+' new directory inode');known.add(identity(actual));}
  };
  for(const [name,row] of Object.entries(receipt.live)){
    if(install.has(name))match(row,input.staged[name],'installed '+name,row.kind==='directory');
    else match(row,{...input.before[name],mtime:input.directoryTimes[name]},'retained directory '+name);
    same(content(row),content(desired.stamps[name]),'complete desired native result: '+name);
  }
  for(const name of captured)match(receipt.capture[receipt.captured[name]],input.before[name],'captured original '+name);
  for(const name of directories)match(receipt.remainingStage[name],input.staged[name],'remaining stage '+name);
  match(receipt.liveRootStamp,{...input.beforeRootStamp,mtime:input.directoryTimes['']},'live root');match(receipt.remainingStageRootStamp,input.stagedRootStamp,'stage root');match(receipt.captureRootStamp,input.captureRootStamp,'capture root');
  same(content(receipt.liveRootStamp),content(desired.rootStamp),'complete desired root metadata');
  require(Array.isArray(receipt.retained)&&receipt.retained.length===input.retained.length,'retained witness count');
  const changedAliases=new Set([...captured].filter(name=>input.before[name].kind==='file').map(name=>identity(input.before[name])));
  const retained=receipt.retained.map((value,i)=>{const before=input.retained[i];keys(value,['root','stamps','rootStamp'],'witness fields');same(value.root,before.root,'witness descriptor');same(value.rootStamp,before.rootStamp,'witness root metadata');keys(value.stamps,Object.keys(before.stamps),'witness namespace');for(const [name,row] of Object.entries(before.stamps)){if(changedAliases.has(identity(row)))match(value.stamps[name],row,'witness alias '+i+'/'+name);else same(value.stamps[name],row,'unchanged witness '+i+'/'+name);}return state(value.root,value.stamps,value.rootStamp);});
  const live=state(input.root,receipt.live,receipt.liveRootStamp),stage=state(input.stage,receipt.remainingStage,receipt.remainingStageRootStamp),capture=state(input.capture,receipt.capture,receipt.captureRootStamp),roots=[live,stage,capture,...retained];topology(roots);
  return {live,stage,capture,retained,roots,bytes:roots.reduce((n,value)=>n+value.bytes,0)};
}
