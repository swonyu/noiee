import {mkdir,writeFile,lstat,realpath} from 'node:fs/promises';
import {join,posix} from 'node:path';
import {createHash} from 'node:crypto';

const FILE_BYTES=32*1024*1024,MAX_BYTES=128*1024*1024;
const below=(parent,path)=>path===parent||path.startsWith(parent+'/');
const fold=path=>path.normalize('NFD').toUpperCase().toLowerCase();
const equal=(a,b)=>Boolean(a&&b&&a.mode===b.mode&&a.oid===b.oid);
const kind=entry=>entry.mode==='120000'?'symlink':'file';
const gitMode=row=>row.kind==='symlink'?'120000':row.mode&0o100?'100755':'100644';
const sorted=map=>Object.fromEntries([...map].sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
function parents(path){const out=[];for(let p=posix.dirname(path);p!=='.';p=posix.dirname(p))out.push(p);return out;}
function conflict(path,reason){throw Object.assign(new Error('Native handoff conflict at '+path+': '+reason),{code:'CONFLICT'});}
// UF_TRACKED (Darwin 0x40) belongs to each inode; full donor flags remain exact in native snapshots and replay.
function metadata(row){return {kind:row.kind,uid:row.uid,gid:row.gid,flags:row.flags-(row.flags&0x40),acl:row.acl,xattrs:row.xattrs,mode:row.kind==='directory'?row.mode:row.mode&~0o111};}
function compatible(path,a,b,mode){
  if(!a||!b||a.kind!==b.kind)return;
  if(JSON.stringify(metadata(a))!==JSON.stringify(metadata(b))||(gitMode(a)===mode&&gitMode(b)===mode&&a.mode!==b.mode))conflict(path,'incompatible native permissions, ownership, flags, ACL or extended attributes');
}
function groups(rows){const groups=new Map();for(const [path,row] of rows)if(row.kind==='file'){const key=row.identity.dev+':'+row.identity.ino;const names=groups.get(key)??[];names.push(path);groups.set(key,names);}return [...groups.values()].map(x=>x.sort());}
function namespace(paths){
  const seen=new Map();if(paths.size>20000)throw new Error('Native candidate exceeds 20,000 entries.');
  for(const path of paths){const key=fold(path);if(seen.has(key)&&seen.get(key)!==path)conflict(path,'case or Unicode alias');seen.set(key,path);}
}

// Select complete native mutations. Git supplies leaf bytes/modes; captured native state
// supplies metadata, empty directories and hardlink relationships that Git cannot record.
function select(p,label,current,desired,sourceMap){
  const all=['source','destination'].map(x=>new Map(Object.entries(p.native[x].stamps))),liveIndex=label==='source'?0:1,live=all[liveIndex],other=all[0];
  const directories=new Set(),install=new Set(),remove=new Set(),choices=new Map();
  const ignored=[...p.native[label].ignored,...p.native[label].omitted];
  const obstructed=path=>ignored.some(x=>below(fold(path),fold(x))||below(fold(x),fold(path)));
  const needed=new Set([...desired.keys(),...ignored].flatMap(parents)),leafAbove=path=>[path,...parents(path)].some(x=>desired.has(x));
  for(const [path,row] of live)if(row.kind==='directory'){
    if(label==='destination'){if(!leafAbove(path))directories.add(path);}
    else if(needed.has(path))directories.add(path);
  }
  for(const path of desired.keys())for(const dir of parents(path))directories.add(dir);
  if(label==='destination')for(const path of p.native.source.emptyDirectories){
    if(leafAbove(path))conflict(path,'incoming empty directory collides with a final leaf');
    for(const dir of [path,...parents(path)])directories.add(dir);
  }
  if(label==='destination')for(const path of new Set([...sourceMap.keys()].flatMap(parents).concat(p.native.source.emptyDirectories.flatMap(path=>[path,...parents(path)])))){
    if(directories.has(path)&&live.get(path)?.kind==='directory')compatible(path,other.get(path),live.get(path),gitMode(live.get(path)));
  }
  namespace(new Set([...desired.keys(),...directories]));
  for(const path of directories){
    if(obstructed(path)&&live.get(path)?.kind!=='directory')conflict(path,'directory collides with ignored or owned temporary content');
    if(live.has(path)&&live.get(path).kind!=='directory'&&(live.get(path).flags&0x40))conflict(path,'Darwin cannot preserve a document-tracked original when replacing it with a directory');
    if(live.get(path)?.kind!=='directory')install.add(path);
  }
  for(const [path,row] of live){
    if(row.kind==='directory'&&!directories.has(path)||row.kind!=='directory'&&!desired.has(path)&&!directories.has(path))remove.add(path);
  }
  for(const path of install)remove.delete(path);
  for(const path of remove)if(live.get(path)?.kind==='directory'&&obstructed(path))conflict(path,'directory removal includes ignored or owned temporary content');
  for(const [path,target] of desired){
    if(obstructed(path))conflict(path,'final leaf collides with ignored or owned temporary content');
    const k=kind(target),a=other.get(path)?.kind===k?other.get(path):null,b=live.get(path)?.kind===k?live.get(path):null;
    if(label==='destination')compatible(path,a,b,target.mode);
    let donor=b&&equal(target,current.get(path))?liveIndex:a?0:b?liveIndex:undefined;
    if(label==='destination'&&a&&equal(target,sourceMap.get(path))&&!equal(target,current.get(path)))donor=0;
    choices.set(path,donor);if(!equal(target,current.get(path)))install.add(path);
    remove.delete(path);
  }
  // Preserve projected surviving groups. Overlapping, different source/destination
  // relationships are a topology conflict, rather than silently joining two groups.
  const required=[],liveGroups=groups(live),owners=new Map(),requiredKeys=new Set(),liveKeys=new Set(liveGroups.map(x=>JSON.stringify(x)));
  for(const donor of label==='source'?[0]:[0,1])for(const group of groups(all[donor])){
    const members=group.filter(path=>desired.get(path)?.mode!=='120000'&&desired.has(path));if(members.length<2)continue;
    const key=JSON.stringify(members);
    for(const path of members)if(owners.has(path)&&owners.get(path)!==key)conflict(path,'incompatible incoming and destination hardlink relationships');else owners.set(path,key);
    if(requiredKeys.has(key))continue;requiredKeys.add(key);
    if(!members.every(path=>equal(desired.get(path),desired.get(members[0]))))conflict(members[0],'hardlinked files require different final contents or executable modes');
    required.push({key,members,donor});
    if(!liveKeys.has(key))for(const path of members)install.add(path);
  }
  let changed=true;while(changed){changed=false;
    for(const members of [...liveGroups,...required.map(x=>x.members)])if(members.some(x=>install.has(x)||remove.has(x)))for(const path of members)if(desired.has(path)&&!install.has(path)){install.add(path);changed=true;}
  }
  for(const {members,donor} of required)if(members.some(x=>install.has(x)))for(const path of members)choices.set(path,donor);
  const entries=new Map(),before=new Map(),synthesized=[];
  for(const path of [...install].sort()){
    if(directories.has(path))continue;
    const target=desired.get(path);if(!target)throw new Error('Native selection lacks its final Git leaf.');
    const donor=choices.get(path),row=donor===undefined?null:all[donor].get(path),k=kind(target),entry={kind:k};
    if(row)entry.donor=donor;
    if(!row||!equal(target,(donor===0?sourceMap:current).get(path))){
      entry.blob=target.oid;
      if(k==='file')entry.mode=row?(gitMode(row)===target.mode?row.mode:(row.mode&~0o111)|(target.mode==='100755'?0o111:0)):target.mode==='100755'?0o755:0o644;
      else if(!row)entry.mode=0o777;
      synthesized.push({path,metadataFrom:row?(donor===0?'source':'destination'):null,mode:entry.mode??row.mode});
    }
    entries.set(path,entry);
  }
  const stageDirs=new Set([...install].filter(x=>directories.has(x)));
  for(const path of install)for(const parent of parents(path))stageDirs.add(parent);
  for(const path of stageDirs){
    const own=live.get(path),incoming=other.get(path);let donor;
    if(own?.kind==='directory'){
      donor=liveIndex;
    }else if(incoming?.kind==='directory')donor=0;
    entries.set(path,donor===undefined?{kind:'directory',mode:0o755}:{kind:'directory',donor});
    if(donor===undefined)synthesized.push({path,metadataFrom:null,mode:0o755});
  }
  for(const path of [...install,...remove])for(const name of [path,...parents(path)])if(live.has(name))before.set(name,live.get(name));
  return {entries,install:[...install].sort(),remove:[...remove].sort(),before:sorted(before),beforeRootStamp:p.native[label].rootStamp,synthesized};
}

export async function prepareHandoffStages(p,builder,native,check,now){
  const refs=p.candidate.recovery.refs,maps={},blobs=new Map();
  for(const name of ['sourceWorking','sourceUntracked','destinationWorking','destinationUntracked','candidateWorking','sourceCleanup'])maps[name]=await builder.treeEntries(refs[name].tree,{verified:true});
  const union=(a,b)=>{const m=new Map(a);for(const [path,value] of b){if(m.has(path))throw new Error('Duplicate native/Git capture path.');m.set(path,value);}return m;};
  const current={source:union(maps.sourceWorking,maps.sourceUntracked),destination:union(maps.destinationWorking,maps.destinationUntracked)};
  async function readBlob(oid){
    check();const bytes=(await builder.verifiedGit(['cat-file','blob',oid],{raw:true,maxOutputBytes:FILE_BYTES+65536})).stdout;
    if(bytes.length>FILE_BYTES||createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')!==oid)throw new Error('Verified candidate blob changed or exceeds 32 MiB.');check();return bytes;
  }
  for(const label of ['source','destination']){
    const rows=new Map(Object.entries(p.native[label].stamps)),leaves=[...rows].filter(([,v])=>v.kind!=='directory');
    if(leaves.length!==current[label].size)throw new Error('Native and Git '+label+' leaf inventories differ.');
    for(const [path,row] of leaves){
      const target=current[label].get(path);if(!target||kind(target)!==row.kind||gitMode(row)!==target.mode)conflict(path,'native type/executable mode disagrees with captured Git state');
      if(!blobs.has(target.oid)){const b=await readBlob(target.oid);blobs.set(target.oid,{sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length,...(row.kind==='symlink'?{targetBase64:b.toString('base64')}: {})});}
      const digest=blobs.get(target.oid);if(row.kind==='file'?row.bytes!==digest.bytes||row.sha256!==digest.sha256:createHash('sha256').update(Buffer.from(row.targetBase64,'base64')).digest('hex')!==digest.sha256)conflict(path,'native bytes disagree with captured Git state');
    }
  }
  const selections={destination:select(p,'destination',current.destination,maps.candidateWorking,current.source),source:select(p,'source',current.source,maps.sourceCleanup,current.source)};
  const moment=now();if(!Number.isSafeInteger(moment)||moment<0)throw new Error('Invalid handoff review time.');const timestamp=Math.floor(moment/1000)+':'+(moment%1000)*1000000;
  async function root(name){check();const path=join(p.directory,name);await mkdir(path,{mode:0o700});const s=await lstat(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==BigInt(process.getuid())||(s.mode&0o077n)||await realpath(path)!==path)throw new Error('Candidate stage is not private and canonical.');check();return {path,dev:String(s.dev),ino:String(s.ino)};}
  const payloadRoot=await root('payloads'),payloadNames=new Set();let size=0;
  for(const selection of Object.values(selections))for(const entry of selection.entries.values())if(entry.blob){
    if(!payloadNames.has(entry.blob)){const bytes=await readBlob(entry.blob);size+=bytes.length;if(size>MAX_BYTES)throw new Error('Synthesized handoff payloads exceed 128 MiB.');blobs.set(entry.blob,{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});await writeFile(join(payloadRoot.path,entry.blob),bytes,{flag:'wx',mode:0o600,flush:true});check();payloadNames.add(entry.blob);}
    entry.payload=entry.blob;delete entry.blob;
  }
  const payload={root:payloadRoot,...await native('snapshot',{root:payloadRoot,paths:[...payloadNames].sort()})};
  const result={timestamp,payload,policy:'Exact donors retain logical content, transferable native metadata and timestamps; inode-local managed storage remains bound to retained originals and is not replayed. Synthesized bytes retain compatible donor metadata and birthtime with review-time mtime; entries without donors use standard permissions, current ownership, no ACL or copied xattrs, native kernel provenance and review-time timestamps.'};
  for(const label of ['destination','source']){
    const selection=selections[label],destination=await root(label+'-candidate'),entries=sorted(selection.entries);
    const staged=await native('materialize',{destination,donors:['source','destination'].map(x=>({root:p.copies[x].root,stamps:p.copies[x].stamps,rootStamp:p.copies[x].rootStamp})),payload:{root:payload.root,stamps:payload.stamps,rootStamp:payload.rootStamp},entries,timestamp});
    const target=label==='source'?maps.sourceCleanup:maps.candidateWorking;
    if(JSON.stringify(Object.keys(staged.stamps).sort())!==JSON.stringify(Object.keys(entries).sort()))throw new Error('Native stage contains missing or unexpected entries.');
    for(const [path,row] of Object.entries(staged.stamps))if(row.kind!=='directory'){
      const leaf=target.get(path),digest=leaf&&blobs.get(leaf.oid);if(!leaf||!digest||kind(leaf)!==row.kind||gitMode(row)!==leaf.mode||(row.kind==='file'?row.bytes!==digest.bytes||row.sha256!==digest.sha256:createHash('sha256').update(Buffer.from(row.targetBase64,'base64')).digest('hex')!==digest.sha256))throw new Error('Native stage differs from verified Git candidate: '+path);
    }
    const immutableRoot=await root(label+'-candidate-before'),immutable={root:immutableRoot,...await native('copy',{source:destination,destination:immutableRoot,stamps:staged.stamps})};
    const captureRoot=await root(label+'-capture'),capture={root:captureRoot,...await native('snapshot',{root:captureRoot,paths:[]})};
    result[label]={root:destination,...staged,install:selection.install,remove:selection.remove,before:selection.before,beforeRootStamp:selection.beforeRootStamp,synthesized:selection.synthesized,capture,immutable};check();
  }
  return result;
}
