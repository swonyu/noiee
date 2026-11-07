import {mkdir,lstat,realpath,writeFile,open,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import {restoreSnapshot} from './handoff-git.mjs';
import {independentCopyContent} from './handoff-storage.mjs';

const MAX=32*1024*1024,OID=/^[a-f0-9]{40}$/,sha=b=>createHash('sha256').update(b).digest('hex');
const require=(ok,message)=>{if(!ok)throw Error('Recovery copy: '+message);};
const identity=s=>({dev:String(s.dev),ino:String(s.ino)}),sameStat=(a,b)=>['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);
const sort=rows=>rows.sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
const inside=(a,b)=>a===b||b.startsWith(a+'/');
export const COPY_RECEIPT_BYTES=32*1024*1024;

// Content admission for a binary retained artifact. This grants read access only:
// the current volume/inode is not a historical writer or publication capability.
export async function readCopyBundle(path,expected,{volumeUUID,readIdentity,check}){
 check();require(expected?.bytes>0&&expected.bytes<=MAX,'retained bundle exceeds the32MiB copy limit');
 require(await realpath(path)===path,'bundle path is noncanonical');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await fd.stat({bigint:true});
  require(before.isFile()&&before.uid===BigInt(process.getuid())&&before.nlink===1n&&!(before.mode&0o022n)&&before.size===BigInt(expected.bytes)&&String(before.ino)===expected.identity.ino,'bundle type, ownership, size or inode changed');
  if(volumeUUID){const current=await readIdentity(path);check();require(current.volumeUUID===volumeUUID&&current.ino===String(before.ino),'bundle current-volume binding changed');}
  else require(String(before.dev)===expected.identity.dev,'bundle device changed without authenticated read admission');
  const chunks=[];let bytes=0;for await(const chunk of fd.createReadStream({autoClose:false})){check();bytes+=chunk.length;require(bytes<=MAX,'bundle grew during reading');chunks.push(chunk);}
  const data=Buffer.concat(chunks),after=await fd.stat({bigint:true}),named=await lstat(path,{bigint:true});
  require(sameStat(before,after)&&sameStat(before,named)&&await realpath(path)===path&&data.length===expected.bytes&&sha(data)===expected.hash,'retained bundle changed or failed its recorded digest');check();
  return {data,identity:identity(before),hash:expected.hash,bytes:data.length};
 }finally{await fd.close();}
}

async function directory(path,create=false){
 if(create)await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
 const info=await lstat(path,{bigint:true});require(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===BigInt(process.getuid())&&!(info.mode&0o077n)&&await realpath(path)===path,'output directory must be private and canonical');return {path,...identity(info)};
}
async function sync(path){const fd=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
function currentDonor(saved,root){
 require(root.path===saved.root.path&&root.ino===saved.root.ino,'donor read binding differs');
 const value=structuredClone(saved),before=saved.root.dev;value.root=root;
 for(const row of [value.rootStamp,...Object.values(value.stamps)]){require(row.identity.dev===before,'donor spans unadmitted devices');row.identity.dev=root.dev;}
 return value;
}
function transfer(manifest,bundle){
 const all=manifest.candidate?.recovery?.refs,names=['sourceHead','sourceIndex','sourceWorking','sourceUntracked','destinationHead','destinationIndex','destinationWorking','destinationUntracked','candidateIndex','candidateTrackedWorking','candidateWorking','sourceCleanup'];
 require(all&&equal(Object.keys(all).sort(),[...names].sort()),'recorded Git witness set differs');
 for(const name of names)require(all[name].ref==='refs/saleh/handoff/'+name&&OID.test(all[name].commit)&&OID.test(all[name].tree),'invalid recorded Git witness');
 const selected={head:all.sourceHead,index:all.sourceIndex,working:all.sourceWorking,untracked:all.sourceUntracked},used=new Set(Object.values(selected).map(r=>r.ref));
 return {version:1,kind:'git-snapshot',head:{oid:selected.head.commit,ref:null,raw:selected.head.commit+'\n'},trees:Object.fromEntries(Object.entries(selected).map(([n,r])=>[n,r.tree])),witnesses:Object.fromEntries(Object.entries(selected).map(([n,r])=>[n,{ref:r.ref,oid:r.commit,tree:r.tree}])),refs:sort(Object.values(all).filter(r=>!used.has(r.ref)).map(r=>[r.ref,r.commit,''])),bundleRefs:sort(Object.values(all).map(r=>[r.ref,r.commit])),bundle};
}
function treeEntries(output){
 const entries=new Map();for(const row of output.split('\0').filter(Boolean)){const m=/^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);require(m&&!entries.has(m[3]),'unsupported or duplicate Git leaf');entries.set(m[3],{mode:m[1],oid:m[2]});}require(entries.size<=20000,'Git entry limit');return entries;
}
async function verifyGitBytes(p,donor){
 const working=treeEntries((await p.git(['ls-tree','-r','-z',p.recipe.trees.working])).stdout),untracked=treeEntries((await p.git(['ls-tree','-r','-z',p.recipe.trees.untracked])).stdout);
 const expected=new Map(working);for(const [name,row] of untracked){require(!expected.has(name),'overlapping working/untracked witnesses');expected.set(name,row);}
 const leaves=Object.entries(donor.stamps).filter(([name,r])=>r.kind!=='directory'&&!p.ignored?.includes(name));require(leaves.length===expected.size,'native/Git leaf namespaces differ');
 const blobs=new Map();for(const [name,row] of leaves){const item=expected.get(name),mode=row.kind==='symlink'?'120000':row.mode&0o100?'100755':'100644';require(item&&item.mode===mode,'native/Git type or executable mode differs');const group=blobs.get(item.oid)??[];group.push(row);blobs.set(item.oid,group);}
 // Bound each batch to one existing GitRunner output window, even for20k leaves.
 const groups=[...blobs];for(let at=0;at<groups.length;){let bytes=0;const batch=[];while(at<groups.length){const [oid,rows]=groups[at],n=rows[0].kind==='file'?rows[0].bytes:Buffer.from(rows[0].targetBase64,'base64').length;require(Number.isSafeInteger(n)&&n>=0&&n<=MAX,'blob byte limit');if(batch.length&&bytes+n>MAX)break;batch.push([oid,rows,n]);bytes+=n;at++;}
  const output=(await p.git(['cat-file','--batch'],{input:batch.map(([oid])=>oid).join('\n')+'\n',raw:true,maxOutputBytes:40*1024*1024})).stdout;let offset=0;
  for(const [oid,rows,n] of batch){const end=output.indexOf(10,offset);require(end>=offset&&output.subarray(offset,end).toString('ascii')===`${oid} blob ${n}`,'Git blob framing differs');const data=output.subarray(end+1,end+1+n);require(data.length===n&&output[end+1+n]===10&&createHash('sha1').update('blob '+n+'\0').update(data).digest('hex')===oid,'Git blob content differs');for(const row of rows)require(row.kind==='file'?row.bytes===n&&row.sha256===sha(data):Buffer.from(row.targetBase64,'base64').equals(data),'native bytes disagree with the recorded Git state');offset=end+n+2;}require(offset===output.length,'unexpected Git blob tail');
 }
 return {working,untracked};
}
async function namespace(root,stamps,gitRoot){
 const children=new Map([['',new Set(gitRoot?['.git']:[])],...Object.entries(stamps).filter(([,r])=>r.kind==='directory').map(([n])=>[n,new Set()])]);
 for(const name of Object.keys(stamps)){const parent=dirname(name)==='.'?'':dirname(name);require(children.has(parent),'missing native ancestor');children.get(parent).add(name.slice(parent.length+(parent?1:0)));}
 for(const [name,expected] of children)require(equal((await readdir(join(root.path,name))).sort(),[...expected].sort()),'copied native namespace changed');
 if(gitRoot)require(equal(await directory(gitRoot.path),gitRoot),'new Git directory changed');
}

export function prepareOriginalCopy(options){return prepareCopy(options);}
// A real independent Git snapshot and native inventory; no handoff is invented.
export function prepareProjectCopy(options){return prepareCopy(options,true);}
async function prepareCopy({review,parent,currentRoot,readBundle,native,runGit,check,recheck,now=Date.now,binding,snapshot,donor:projectDonor},startup=false){
 const m=review.manifest;
 if(!startup)require([4,5,6].includes(m.version)&&m.copies?.source?.root&&m.native?.source?.rootStamp,'recorded native original is unavailable');
 const saved=startup?projectDonor:m.copies.source,source=startup?binding.cwd:m.source;
 for(const path of startup?[source,snapshot.artifacts.directory]:[m.source,m.destination,review.directory])require(!inside(path,parent)&&!inside(parent,path),'copy parent overlaps retained data');
 await recheck();check();const donor=currentDonor(saved,await currentRoot(saved.root)),bundle=await readBundle();check();
 const parentRoot=await directory(parent,true);require((await readdir(parent)).length<256,'recovered project capacity reached; retained output is kept');
 const id=randomUUID(),entry=join(parent,id);await mkdir(entry,{mode:0o700});
 const omitted=startup?[]:[...new Set([...m.native.source.ignored,...m.native.source.omitted])];
 const publicPlan={id,...startup?{operation:'failed-startup-copy',ownerId:binding.ownerId,generation:binding.generation,model:binding.model}:{operation:'handoff-original-copy',handoffId:review.id,rootThreadId:m.family.rootThreadId},source,target:join(entry,'project'),head:startup?snapshot.head.oid:m.candidate.recovery.refs.sourceHead.commit,indexTree:startup?snapshot.trees.index:m.candidate.recovery.refs.sourceIndex.tree,files:Object.keys(donor.stamps).length,bytes:donor.bytes,omittedCount:omitted.length,expiresAt:now()+120000};
 try{
 await writeFile(join(entry,'intent.json'),JSON.stringify({version:1,state:'preparing',plan:publicPlan,owner:startup?binding:m.owner??null,reviewFingerprint:review.fingerprint,scope:startup?'Independent host project copy; failed startup remains retained':'Independent recorded source copy; original handoff and chat remain retained'},null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
 for(const name of ['project','witness','git'])await mkdir(join(entry,name),{mode:0o700});
 const roots=Object.fromEntries(await Promise.all(['project','witness','git'].map(async n=>[n,await directory(join(entry,n))]))),entryRoot=await directory(entry),bundlePath=join(entry,'recovery.bundle');
 const p={id,entry,entryRoot,parentRoot,roots,donor,review,check,recheck,currentRoot,readBundle,native,runGit,startup,omitted,ignored:startup?snapshot.ignored:[]};
 p.guard=async()=>{check();require(equal(await directory(parent),parentRoot)&&equal(await directory(entry),entryRoot),'copy output parent or entry changed');for(const name of ['project','witness'])require(equal(await directory(p.roots[name].path),p.roots[name]),'copy output root changed');check();};
 p.publicPlan=publicPlan;
 await writeFile(bundlePath,bundle.data,{flag:'wx',mode:0o600,flush:true});const bs=await lstat(bundlePath,{bigint:true});
 const copiedBundle={path:bundlePath,identity:identity(bs),hash:bundle.hash,bytes:bundle.bytes};
 p.recipe=startup?{...structuredClone(snapshot),bundle:copiedBundle}:transfer(m,copiedBundle);
 p.bundleCheck=()=>readCopyBundle(bundlePath,p.recipe.bundle,{check});
 p.sourceBundleCheck=async()=>{const fresh=await readBundle();require(equal(fresh.identity,bundle.identity)&&fresh.hash===bundle.hash,'recorded bundle binding changed');};
 p.git=async(args,options={})=>{await p.guard();require(equal(await directory(p.roots.git.path),p.roots.git),'copy Git root changed');const result=await runGit(['--git-dir='+p.roots.git.path,...args[0]==='init'?[]:['--work-tree='+roots.project.path],'--literal-pathspecs',...args],{...options,env:{GIT_ALTERNATE_OBJECT_DIRECTORIES:'',GIT_INDEX_FILE:join(p.roots.git.path,'index')},scope:{dirs:[entry]}});await p.guard();return result;};
 p.observeDonor=async()=>{
  await p.guard();require(equal(await currentRoot(saved.root),donor.root),'donor current read identity changed');
  let observed;
  if(startup){const inventory=await native('inventory',{root:donor.root,exclude:[]});require(equal(Object.keys(inventory.excluded),['.git']),'unexpected Git metadata in donor');observed={root:donor.root,stamps:inventory.stamps,rootStamp:inventory.rootStamp,bytes:inventory.bytes};}
  else observed=(await native('recoverySnapshot',{roots:[{root:roots.witness,paths:[]},{root:donor.root,paths:Object.keys(donor.stamps)}]})).roots[1];
  require(equal(observed,donor),'recorded donor namespace, content or metadata changed');return observed;
 };
 await p.observeDonor();await p.git(['init','--bare','--quiet','--template=']);await p.git(['config','core.bare','false']);await restoreSnapshot(p.recipe,p.git,{retainWitnesses:true});
 await verifyGitBytes(p,donor);await p.bundleCheck();await p.sourceBundleCheck();await p.observeDonor();await recheck();check();publicPlan.expiresAt=now()+120000;
 await writeFile(join(entry,'review.json'),JSON.stringify(publicPlan,null,2)+'\n',{flag:'wx',mode:0o600,flush:true});await sync(entry);check();
 return p;
 }catch(error){throw Object.assign(Error(error.message+' New output retained for inspection: '+entry,{cause:error}),{copyDirectory:entry});}
}

export async function createOriginalCopy(p){
 const {check,native,donor,roots,review}=p;check();await p.recheck();await p.guard();await p.bundleCheck();await p.sourceBundleCheck();await p.observeDonor();
 require(equal(await readdir(roots.project.path),[]),'new project is no longer empty');
 const copied=await native('copy',{source:donor.root,destination:roots.project,stamps:donor.stamps});check();require(equal(Object.keys(copied.stamps).sort(),Object.keys(donor.stamps).sort()),'copied native selection differs');
 for(const [name,row] of Object.entries(copied.stamps)){require(row.identity.dev!==donor.stamps[name]?.identity.dev||row.identity.ino!==donor.stamps[name]?.identity.ino,'copy shares a retained inode');require(equal(independentCopyContent(row),independentCopyContent(donor.stamps[name])),'copied native content or metadata differs');}
 const observed=await native('recoverySnapshot',{roots:[{root:roots.witness,paths:[]},{root:roots.project,paths:Object.keys(copied.stamps)}]});require(equal(observed.roots[1].stamps,copied.stamps),'independent copied namespace changed');
 await verifyGitBytes(p,donor);await p.observeDonor();await p.recheck();await p.guard();
 // mkdir is exclusive: a collision never replaces anything in the new project.
 const gitPath=join(roots.project.path,'.git');await mkdir(gitPath,{mode:0o700});const nextGit=await directory(gitPath);roots.git=nextGit;
 await p.git(['init','--bare','--quiet','--template=']);await p.git(['config','core.bare','false']);await restoreSnapshot(p.recipe,p.git,{retainWitnesses:true});await sync(roots.project.path);await p.guard();
 await namespace(roots.project,copied.stamps,nextGit);
 const layers=await verifyGitBytes(p,donor),actual=String((await p.git(['ls-files','--others','--exclude-standard','-z'])).stdout).split('\0').filter(Boolean);require(equal(actual.sort(),[...layers.untracked.keys()].sort()),'untracked file classification differs');
 await p.bundleCheck();await p.sourceBundleCheck();await p.observeDonor();await p.recheck();await namespace(roots.project,copied.stamps,nextGit);check();
 // Final target proof follows every callback that can inspect retained originals.
 const finalGit={head:(await p.git(['rev-parse','--verify','--quiet','HEAD'],{allowCodes:p.recipe.head.oid===null?[0,1]:[0]})).stdout.trim()||null,indexTree:(await p.git(['write-tree'])).stdout.trim(),symbolicHead:(await p.git(['symbolic-ref','-q','HEAD'],{allowCodes:[0,1]})).stdout.trim(),refs:(await p.git(['for-each-ref','--count=10005','--format=%(refname)%00%(objectname)%00%(symref)'])).stdout.split('\n').filter(Boolean).map(row=>row.split('\0'))};
 const expectedRefs=sort([...p.recipe.refs,...Object.values(p.recipe.witnesses).map(v=>[v.ref,v.oid,''])]);
 require(finalGit.head===p.recipe.head.oid&&finalGit.indexTree===p.recipe.trees.index&&finalGit.symbolicHead===(p.recipe.head.ref??'')&&equal(sort(finalGit.refs),expectedRefs),'final Git head, staging or retained refs differ');
 const absent=await lstat(join(nextGit.path,'objects/info/alternates')).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e;});require(absent,'new repository has an alternate object dependency');
 await p.git(['fsck','--full','--no-reflogs','--no-dangling',...p.recipe.bundleRefs.map(([,oid])=>oid)]);
 const finalNative=await native('snapshot',{root:roots.project,paths:Object.keys(copied.stamps)});require(equal(finalNative.stamps,copied.stamps),'copied files changed after final verification');require(['kind','mode','uid','gid','flags','acl','birthtime','xattrs'].every(key=>equal(finalNative.rootStamp[key],observed.roots[1].rootStamp[key])),'new project root security or metadata changed');await namespace(roots.project,copied.stamps,nextGit);check();
 const result={...p.publicPlan,receiptPath:join(p.entry,'receipt.json'),independent:true,...p.startup?{originalStartupRecovered:false}:{originalRecoveryComplete:false}};delete result.expiresAt;
 const receipt=JSON.stringify({version:1,state:'complete',copy:result,reviewFingerprint:review.fingerprint,originalsMutatedByCopy:false,donor,project:{root:roots.project,...finalNative},gitRoot:nextGit,finalGit,recipe:p.recipe,omitted:p.omitted})+'\n';
 require(Buffer.byteLength(receipt)<=COPY_RECEIPT_BYTES,'combined native/Git receipt exceeds its 32 MiB limit');
 await writeFile(result.receiptPath,receipt,{flag:'wx',mode:0o600,flush:true});await sync(p.entry);check();
 return {copy:result};
}
