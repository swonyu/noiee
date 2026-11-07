import {mkdir,writeFile,lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,resolve,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const OID=/^[a-f0-9]{40}$/;
const EMPTY_TREE=createHash('sha1').update('tree 0\0').digest('hex');
const MAX=1048576,BUNDLE_BYTES=512*MAX;
const inside=(root,path)=>path===root||path.startsWith(root+sep);
const sameID=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const sortedRefs=rows=>rows.sort((a,b)=>Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])));
const safeRef=value=>typeof value==='string'&&Buffer.byteLength(value)<=4096&&value.startsWith('refs/')&&!/[\0-\x20\x7f~^:?*\[\\]/.test(value)&&!value.includes('..')&&!value.includes('@{')&&value.split('/').every(part=>part&&!part.startsWith('.')&&!part.endsWith('.')&&!part.endsWith('.lock'));
function snapshotRefs(output,maximum=10000){
  const rows=output.split('\n').filter(Boolean).map(row=>row.split('\0'));
  if(rows.length>maximum||new Set(rows.map(row=>row[0])).size!==rows.length||rows.some(row=>row.length!==3||!safeRef(row[0])||!OID.test(row[1])||row[2]&&!safeRef(row[2])))throw new Error('Unsupported or excessive snapshot refs.');
  return sortedRefs(rows);
}

async function recoveryFile(path,max,check,contents=false){
  check();const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const a=await f.stat({bigint:true});if(!a.isFile()||a.uid!==BigInt(process.getuid())||a.nlink!==1n||a.size>BigInt(max))throw new Error('Handoff recovery file has invalid type, ownership, links or size.');const hash=createHash('sha256'),chunks=[];let bytes=0;
    for await(const chunk of f.createReadStream({autoClose:false})){check();bytes+=chunk.length;if(bytes>max)throw new Error('Handoff recovery file exceeds its size limit.');hash.update(chunk);if(contents)chunks.push(chunk);}
    const z=await f.stat({bigint:true});if(a.dev!==z.dev||a.ino!==z.ino||a.size!==z.size||a.mtimeNs!==z.mtimeNs)throw new Error('Handoff recovery file changed while reading.');await f.sync();check();return {identity:{dev:String(a.dev),ino:String(a.ino)},hash:hash.digest('hex'),bytes,...contents?{data:Buffer.concat(chunks)}:{}};
  }finally{await f.close();}
}
function snapshotTransfer(s){
  const fail=()=>{throw new Error('Invalid independent snapshot manifest.');},names=['head','index','working','untracked'],unborn=s?.head?.oid===null;
  if(s?.version!==1||s.kind!=='git-snapshot'||!s.head||!(unborn||OID.test(s.head.oid))||!(s.head.ref===null&&!unborn||safeRef(s.head.ref)&&s.head.ref.startsWith('refs/heads/'))||s.head.raw!==(s.head.ref?'ref: '+s.head.ref+'\n':s.head.oid+'\n'))fail();
  if(!Array.isArray(s.refs)||s.refs.length>10000||s.refs.some(row=>!Array.isArray(row)||row.length!==3||!safeRef(row[0])||!OID.test(row[1])||typeof row[2]!=='string'||row[2]&&!safeRef(row[2])))fail();
  const refs=sortedRefs(s.refs.map(row=>[...row])),byName=new Map(refs.map(row=>[row[0],row]));if(byName.size!==refs.length||JSON.stringify(refs)!==JSON.stringify(s.refs))fail();
  if(unborn?refs.some(([name])=>name===s.head.ref):s.head.ref&&!refs.some(([name,oid,target])=>name===s.head.ref&&oid===s.head.oid&&!target))fail();
  for(const [name,oid,target] of refs){const seen=new Set([name]);let next=target;while(next){const row=byName.get(next);if(!row||row[1]!==oid||seen.has(next))fail();seen.add(next);next=row[2];}}
  if(!s.trees||!s.witnesses||Object.keys(s.trees).sort().join()!==[...names].sort().join()||Object.keys(s.witnesses).sort().join()!==[...names].sort().join())fail();
  if(unborn&&s.trees.head!==EMPTY_TREE)fail();
  for(const name of names){const v=s.witnesses[name];if(!OID.test(s.trees[name])||!v||!safeRef(v.ref)||!OID.test(v.oid)||v.tree!==s.trees[name]||name==='head'&&!unborn&&v.oid!==s.head.oid)fail();}
  const bundleRefs=sortedRefs([...refs.map(([name,oid])=>[name,oid]),...names.map(name=>[s.witnesses[name].ref,s.witnesses[name].oid])]);
  if(new Set(bundleRefs.map(([name])=>name)).size!==bundleRefs.length||bundleRefs.some(([name],i)=>i&&name.startsWith(bundleRefs[i-1][0]+'/'))||JSON.stringify(bundleRefs)!==JSON.stringify(s.bundleRefs))fail();
  if(unborn&&bundleRefs.some(([name])=>inside(name,s.head.ref)||inside(s.head.ref,name)))fail();
  if(!s.bundle||typeof s.bundle.path!=='string'||!isAbsolute(s.bundle.path)||resolve(s.bundle.path)!==s.bundle.path||!Number.isSafeInteger(s.bundle.bytes)||s.bundle.bytes<=0||s.bundle.bytes>32*MAX||!/^[a-f0-9]{64}$/.test(s.bundle.hash)||!/^\d+$/.test(s.bundle.identity?.dev)||!/^\d+$/.test(s.bundle.identity?.ino))fail();
  return s;
}
// Git-only recipe. Its caller admits the exact bundle and exclusive repository;
// the trusted runner owns environment, write scope, Stop and physical settlement.
export async function restoreSnapshot(s,git,{retainWitnesses=false,bundlePath=s?.bundle?.path}={}){
  snapshotTransfer(s);
  if(typeof git!=='function'||typeof bundlePath!=='string'||!isAbsolute(bundlePath)||resolve(bundlePath)!==bundlePath||bundlePath==='/'||bundlePath.includes('\0'))throw new Error('Invalid independent snapshot restore bundle path or context.');
  await git(['bundle','verify','--quiet',bundlePath]);
  const listed=(await git(['bundle','unbundle',bundlePath])).stdout.split('\n').filter(Boolean).map(row=>{const m=/^([a-f0-9]{40}) (refs\/[^\0\r\n]+)$/.exec(row);if(!m)throw new Error('Invalid independent snapshot bundle ref.');return [m[2],m[1]];});
  if(JSON.stringify(sortedRefs(listed))!==JSON.stringify(s.bundleRefs))throw new Error('Independent snapshot bundle refs differ.');
  const refs=retainWitnesses?s.bundleRefs:s.refs;
  if(refs.length)await git(['update-ref','--stdin'],{input:refs.map(([name,oid])=>`create ${name} ${oid}\n`).join('')});
  for(const [name,,target] of s.refs)if(target)await git(['symbolic-ref',name,target]);
  if(s.head.ref)await git(['symbolic-ref','HEAD',s.head.ref]);else await git(['update-ref','--no-deref','HEAD',s.head.oid]);
  const witnesses=Object.values(s.witnesses),input=witnesses.flatMap(value=>[value.oid,value.oid+'^{tree}']).join('\n')+'\n';
  const expected=witnesses.flatMap(value=>[value.oid+' commit',value.tree+' tree']).join('\n')+'\n';
  if((await git(['cat-file','--batch-check=%(objectname) %(objecttype)'],{input})).stdout!==expected)throw new Error('Independent snapshot tree differs.');
  await git(['read-tree',s.trees.index]);
  if((await git(['write-tree'])).stdout.trim()!==s.trees.index)throw new Error('Independent staged tree differs.');
  const tree=(await git(['ls-tree','-r','-z',s.trees.index])).stdout.split('\0').filter(Boolean);if(tree.length>20000)throw new Error('Independent index exceeds its entry limit.');
  const expectedIndex=tree.map(row=>{const m=/^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);if(!m)throw new Error('Unsupported independent index entry.');return `${m[1]} ${m[2]} 0\t${m[3]}\0`;}).join('');
  if((await git(['ls-files','--stage','-z'])).stdout!==expectedIndex)throw new Error('Independent staged entries differ.');
  const expectedRefs=sortedRefs([...s.refs,...retainWitnesses?Object.values(s.witnesses).map(v=>[v.ref,v.oid,'']):[]]);
  if(JSON.stringify(snapshotRefs((await git(['for-each-ref','--count=10005','--format=%(refname)%00%(objectname)%00%(symref)'])).stdout,10004))!==JSON.stringify(expectedRefs))throw new Error('Independent snapshot repository refs differ.');
  const head=(await git(['symbolic-ref','-q','HEAD'],{allowCodes:[0,1]})).stdout.trim();
  const resolved=await git(['rev-parse','--verify','--quiet','HEAD'],{allowCodes:s.head.oid===null?[0,1]:[0]});
  if(head!==(s.head.ref??'')||(s.head.oid===null?resolved.code!==1||resolved.stdout.trim():resolved.stdout.trim()!==s.head.oid))throw new Error('Independent snapshot HEAD differs.');
  await git(['fsck','--full','--no-reflogs','--no-dangling',...Object.values(s.witnesses).map(v=>v.oid)]);
  return {head:s.head,refs:s.refs,indexTree:s.trees.index};
}

export function hostGitWitness(snapshot){
  const s=snapshot.source;return structuredClone({head:snapshot.head,refs:snapshot.refs,index:s.index?{hash:s.index.hash,bytes:s.index.bytes}:null,indexTree:snapshot.trees.index,repositoryId:s.repositoryId,commonRepositoryId:s.commonRepositoryId,configSHA256:s.configSHA256,configFiles:s.configFiles,peersFingerprint:s.peersFingerprint});
}
// Admit retained local artifacts without creating a repository. A remote caller
// separately admits its transport and destination before using restoreSnapshot.
export async function admitGitSnapshot({snapshot,check}){
  if(typeof check!=='function')throw new Error('Invalid independent snapshot admission context.');
  check();const encoded=JSON.stringify(snapshot);if(!encoded||Buffer.byteLength(encoded)>8*MAX)throw new Error('Snapshot manifest exceeds its size limit.');const s=snapshotTransfer(JSON.parse(encoded));
  const artifacts=s.artifacts;if(!artifacts||typeof artifacts.directory!=='string'||!isAbsolute(artifacts.directory)||resolve(artifacts.directory)!==artifacts.directory||artifacts.manifest!==join(artifacts.directory,'plan.json')||s.bundle.path!==join(artifacts.directory,'recovery.bundle'))throw new Error('Invalid snapshot artifact paths.');
  if(await realpath(artifacts.directory)!==artifacts.directory)throw new Error('Snapshot artifacts are noncanonical.');check();
  const manifest=await recoveryFile(artifacts.manifest,8*MAX,check,true);
  if(JSON.stringify(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifest.data)))!==encoded)throw new Error('Snapshot manifest changed before import.');
  const verifyBundle=async(contents=false)=>{const {data,...now}=await recoveryFile(s.bundle.path,32*MAX,check,contents);if(JSON.stringify({path:s.bundle.path,...now})!==JSON.stringify(s.bundle))throw new Error('Snapshot bundle changed before or during import.');return data;};
  const bundleBytes=await verifyBundle(true),admitted={snapshot:JSON.parse(encoded),bundleBytes,reverify:async()=>{
    check();if(JSON.stringify(admitted.snapshot)!==encoded)throw new Error('Admitted snapshot changed.');
    await verifyBundle();const after=await recoveryFile(artifacts.manifest,8*MAX,check);
    if(after.hash!==manifest.hash||!sameID(after.identity,manifest.identity))throw new Error('Snapshot manifest changed during import.');check();
  }};check();return admitted;
}

// Local destination admission only. This never checks out, cleans, resets or
// writes working-tree files; remote destinations need their own admission.
export async function importGitSnapshot({snapshot,directory,runGit,check}){
  if(typeof runGit!=='function'||typeof check!=='function'||typeof directory!=='string'||!isAbsolute(directory)||resolve(directory)!==directory||directory==='/')throw new Error('Invalid independent snapshot import context.');
  if(dirname(directory).split(sep).some(part=>part.normalize('NFD').toUpperCase().toLowerCase()==='.git'))throw new Error('Snapshot import collides with existing Git metadata.');
  const admitted=await admitGitSnapshot({snapshot,check}),s=admitted.snapshot;
  if(inside(s.artifacts.directory,directory)||inside(directory,s.artifacts.directory))throw new Error('Snapshot import directory overlaps retained artifacts.');
  const parent=dirname(directory),parentStat=await lstat(parent,{bigint:true});check();
  if(!parentStat.isDirectory()||parentStat.uid!==BigInt(process.getuid())||(parentStat.mode&0o022n)||await realpath(parent)!==parent)throw new Error('Snapshot import parent is noncanonical.');
  check();await mkdir(directory,{mode:0o700});check();const id=await lstat(directory,{bigint:true});
  const targetCheck=async()=>{check();const [p,d]=await Promise.all([lstat(parent,{bigint:true}),lstat(directory,{bigint:true})]);if(p.dev!==parentStat.dev||p.ino!==parentStat.ino||!d.isDirectory()||d.dev!==id.dev||d.ino!==id.ino||d.uid!==BigInt(process.getuid())||(d.mode&0o077n)||await realpath(directory)!==directory)throw new Error('Independent snapshot import directory changed.');check();};
  const git=async(args,options={})=>{await targetCheck();const value=await runGit(['--git-dir='+directory,'--literal-pathspecs',...args],{...options,env:{GIT_ALTERNATE_OBJECT_DIRECTORIES:'',GIT_INDEX_FILE:join(directory,'index')},scope:{dirs:[directory]},check});await targetCheck();return value;};
  await git(['init','--bare','--quiet','--template=']);await git(['config','core.bare','false']);
  const restored=await restoreSnapshot(s,git);await admitted.reverify();
  await targetCheck();return {verified:true,directory,identity:{dev:String(id.dev),ino:String(id.ino)},...restored,bundle:{...s.bundle}};
}

// Private candidates only. Caller owns the mutation lease, captured readState/peer inventory,
// native-byte/metadata recovery, stale-state validation, Stop and all live publication.
// This builder is single-use; retain its private directory for inspection after any failure.
// Same ordinary index contract as ManagedWorktrees.archiveState; state-bearing extensions
// must be rejected before rebuilding an index from its tree entries.
export function ordinaryIndex(index){
  if(index.length<32||index.subarray(0,4).toString()!=='DIRC'||![2,3].includes(index.readUInt32BE(4)))throw new Error('Unsupported index version.');
  let offset=12;const count=index.readUInt32BE(8);if(count>20000)throw new Error('Index exceeds 20,000 entries.');
  for(let i=0;i<count;i++){const start=offset;if(offset+62>index.length-20)throw new Error('Invalid index entry.');if(index.readUInt16BE(offset+60)&0xf000)throw new Error('Unsupported index flags or conflict stages.');offset+=62;const nul=index.indexOf(0,offset);if(nul<0)throw new Error('Invalid index path.');offset=start+Math.ceil((nul+1-start)/8)*8;}
  while(offset<index.length-20){if(offset+8>index.length-20)throw new Error('Invalid index extension.');const type=index.subarray(offset,offset+4).toString('ascii'),size=index.readUInt32BE(offset+4);if(!['TREE','EOIE','IEOT'].includes(type))throw new Error('Unsupported index extension '+type+'.');offset+=8+size;}
  if(offset!==index.length-20||!createHash('sha1').update(index.subarray(0,-20)).digest().equals(index.subarray(-20)))throw new Error('Invalid index checksum or extension length.');
}

export class HandoffGit {
  #snapshotSourceCheck=null;
  constructor({directory,runner,inspector,check}){
    if(!isAbsolute(directory)||resolve(directory)!==directory||typeof runner?.run!=='function'||typeof inspector?.representable!=='function'||typeof check!=='function')throw new Error('Invalid private handoff Git context.');
    Object.assign(this,{dir:directory,repo:join(directory,'candidate.git'),runner,inspector,check,steps:[]});
    this.artifacts={directory,repository:this.repo,objects:join(this.repo,'objects'),index:join(directory,'destination-candidate.index'),sourceCleanupIndex:join(directory,'source-cleanup.index'),sourceOriginalIndex:join(directory,'source-original-index'),destinationOriginalIndex:join(directory,'destination-original-index'),sourceOriginalHead:join(directory,'source-original-HEAD'),destinationOriginalHead:join(directory,'destination-original-HEAD'),bundle:join(directory,'recovery.bundle'),verifiedRepository:join(directory,'verified.git'),manifest:join(directory,'plan.json')};
  }
  async git(args,options={}){this.check();const result=await this.runner.run(['--git-dir='+this.repo,'--literal-pathspecs',...args],{...options,env:{...this.env,...options.env},scope:{dirs:[this.dir]},check:this.check});this.check();return result;}
  async verifiedGit(args,options={}){this.check();const result=await this.runner.run(['--git-dir='+this.artifacts.verifiedRepository,'--literal-pathspecs',...args],{...options,env:{...options.env,GIT_ALTERNATE_OBJECT_DIRECTORIES:''},scope:{dirs:[this.dir]},check:this.check});this.check();return result;}
  async read(state,args){this.check();const result=await this.runner.run(['--git-dir='+state.r.gitDir,'--work-tree='+state.r.cwd,'--literal-pathspecs',...args],{scope:{},check:this.check});this.check();return result;}
  async save(path,data){this.check();await writeFile(path,data,{flag:'wx',mode:0o600,flush:true});this.check();}
  async stamp(path,max){
    return recoveryFile(path,max,this.check);
  }
  async verifySnapshotSource(){
    this.check();if(!this.#snapshotSourceCheck)throw new Error('No completed Git snapshot source is available.');
    await this.#snapshotSourceCheck();
  }
  async validate(source,destination,peers,temporary){
    this.check();if(this.started)throw new Error('Handoff Git candidate builder is single-use.');this.started=true;
    if(!source?.r||!destination?.r||source.r.cwd===destination.r.cwd)throw new Error('Handoff requires distinct checkout roots.');
    if(source.r.commonDir!==destination.r.commonDir||source.r.commonRepositoryId!==destination.r.commonRepositoryId||!sameID(source.r.identities?.common,destination.r.identities?.common))throw new Error('Handoff requires the same common repository identity.');
    if(!Array.isArray(peers?.records)||!peers.records.length||peers.records.length>128||new Set(peers.records.map(r=>r.path)).size!==peers.records.length)throw new Error('Invalid complete peer inventory.');
    for(const state of [source,destination]){
      const r=state.r;if(!isAbsolute(r.cwd)||await realpath(r.cwd)!==r.cwd||await realpath(r.commonDir)!==r.commonDir)throw new Error('Handoff checkout paths must be canonical.');this.check();
      await this.inspector.verifyRepository(r);this.check();
      if(!OID.test(state.head)||!Buffer.isBuffer(state.index)||!(state.indexEntries instanceof Map)||!(state.files instanceof Map))throw new Error('Committed HEAD and captured Git state are required.');ordinaryIndex(state.index);
      this.inspector.representable([...state.indexEntries.keys()]);
      const peer=peers.records.find(p=>p.path===r.cwd);if(!peer||peer.head!==state.head||peer.branch!==(state.refBranch?'refs/heads/'+state.refBranch:undefined)||!sameID(peer.id,r.identities.cwd))throw new Error('Checkout does not match its captured peer registration.');
      for(const path of [r.cwd,r.gitDir,r.commonDir])if(inside(path,this.dir)||inside(this.dir,path))throw new Error('Private handoff directory overlaps a checkout or Git metadata.');
      if((await this.read(state,['ls-files','--resolve-undo','-z'])).stdout)throw new Error('Resolve-undo index state is unsupported.');
    }
    if(!Array.isArray(temporary)||temporary.length>2)throw new Error('Invalid temporary directory inventory.');this.temporary=[];
    for(const t of temporary){
      const keys=['cwd','path','nonce','projectDev','projectIno','dev','ino'];if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).length!==keys.length||keys.some(k=>!Object.hasOwn(t,k))||typeof t.nonce!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(t.nonce)||['projectDev','projectIno','dev','ino'].some(k=>typeof t[k]!=='string'||!/^\d+$/.test(t[k])))throw new Error('Invalid temporary directory ownership.');
      const state=[source,destination].find(s=>s.r.cwd===t.cwd);if(!state||this.temporary.some(p=>p.cwd===t.cwd)||typeof t.path!=='string'||!isAbsolute(t.path)||resolve(t.path)!==t.path||dirname(t.path)!==t.cwd||!sameID({dev:t.projectDev,ino:t.projectIno},state.r.identities.cwd))throw new Error('Temporary directory does not match its checkout.');
      const s=await lstat(t.path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||!sameID({dev:String(s.dev),ino:String(s.ino)},t)||await realpath(t.path)!==t.path)throw new Error('Temporary directory identity changed.');this.check();this.temporary.push({...t});
    }
    if(source.refBranch&&peers.records.some(p=>p.path!==source.r.cwd&&p.path!==destination.r.cwd&&p.branch==='refs/heads/'+source.refBranch))throw new Error('Source branch is checked out by a third-party peer.');
    if((await this.read(source,['worktree','list','--porcelain','-z'])).stdout!==peers.output)throw new Error('Peer inventory changed during candidate preparation.');
    this.check();await mkdir(this.dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const st=await lstat(this.dir);
    if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||await realpath(this.dir)!==this.dir)throw new Error('Handoff candidate directory must be private and canonical.');this.check();
  }
  async treeEntries(tree,{verified=false}={}){
    if(!OID.test(tree))throw new Error('Invalid handoff tree identity.');
    const args=['ls-tree','-r','-z',tree],output=(await (verified?this.verifiedGit(args):this.git(args))).stdout,entries=new Map();
    for(const row of output.split('\0').filter(Boolean)){const m=/^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);if(!m||entries.has(m[3])||entries.size>=20000)throw new Error('Unsupported or excessive tree entries.');entries.set(m[3],{mode:m[1],oid:m[2]});}
    this.inspector.representable([...entries.keys()]);return entries;
  }
  async tree(entries,name){
    const env={...this.env,GIT_INDEX_FILE:join(this.dir,name+'.index')};
    await this.git(['read-tree','--empty'],{env});
    if(entries.size)await this.git(['update-index','-z','--index-info'],{env,input:[...entries].map(([p,v])=>`${v.mode} ${v.oid}\t${p}\0`).join('')});
    return (await this.git(['write-tree'],{env})).stdout.trim();
  }
  async blob(data){return (await this.git(['hash-object','-w','--stdin','--no-filters'],{input:data})).stdout.trim();}
  excluded(s,path){return this.temporary.some(t=>t.cwd===s.r.cwd&&(path===t.path.slice(t.cwd.length+1)||path.startsWith(t.path.slice(t.cwd.length+1)+'/')));}
  guardTemporary(s,paths){for(const t of this.temporary.filter(t=>t.cwd===s.r.cwd))for(const path of paths)if(this.collision(path,t.path.slice(t.cwd.length+1)))throw Object.assign(new Error('Git path collides with an owned temporary directory: '+path),{code:'CONFLICT'});}
  async layers(s,label){
    const headTree=s.head===null?await this.tree(new Map(),label+'-head'):(await this.git(['rev-parse',s.head+'^{tree}'])).stdout.trim();if(this.temporary.some(t=>t.cwd===s.r.cwd))this.guardTemporary(s,[...s.indexEntries.keys(),...(await this.treeEntries(headTree)).keys()]);
    const index=await this.tree(s.indexEntries,label+'-index'),tracked=new Map(s.indexEntries),untracked=new Map();
    // readState owns the bounded changed-byte capture. Unchanged tracked blobs already
    // exist in the read-only alternate, so do not reread or rehash the whole checkout.
    for(const [path,f] of s.files)if(s.indexEntries.has(path)){
      if(f.data===null)tracked.delete(path);else tracked.set(path,{mode:f.mode,oid:await this.blob(f.data)});
    }
    // Includes index-deleted paths recreated as untracked; ignored files never become incoming files.
    const names=(await this.read(s,['ls-files','--others','--exclude-standard','-z'])).stdout.split('\0').filter(path=>path&&!this.excluded(s,path));
    for(const path of names){const f=s.files.get(path);if(!f||f.data===null)throw new Error('Untracked snapshot changed.');untracked.set(path,{mode:f.mode,oid:await this.blob(f.data)});}
    const working=await this.tree(tracked,label+'-working');
    const ignored=(await this.read(s,['ls-files','--others','--ignored','--exclude-standard','-z'])).stdout.split('\0').filter(path=>path&&!this.excluded(s,path));
    return {ignored,head:s.head,headTree,index,working,untracked};
  }
  async synthetic(tree){return (await this.git(['-c','commit.gpgSign=false','commit-tree',tree],{input:'Private tree merge input\n'})).stdout.trim();}
  async merge(base,ours,theirs,label){
    // Inputs are synthetic root commits in a sterile private repository. No user merge driver runs.
    const commits=[];for(const t of [base,ours,theirs])commits.push(await this.synthetic(t));
    const r=await this.git(['-c','merge.renames=false','-c','merge.default=text','merge-tree','--write-tree','--messages','-z','--merge-base='+commits[0],commits[1],commits[2]],{allowCodes:[0,1]});
    const tree=r.stdout.split('\0')[0];if(!/^[a-f0-9]{40}$/.test(tree))throw new Error('Invalid merge-tree result.');
    const step={label,base,ours,theirs,tree,clean:r.code===0,detail:r.stdout.slice(41)};this.steps.push(step);
    if(r.code!==0)throw Object.assign(new Error('Conflict in '+label),{code:'CONFLICT',step});
    return tree;
  }
  collision(a,b){a=a.normalize('NFD').toUpperCase().toLowerCase();b=b.normalize('NFD').toUpperCase().toLowerCase();return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');}
  guardUntracked(source,destination){
    for(const path of source.untracked.keys())for(const other of destination.untracked.keys())if(this.collision(path,other))throw Object.assign(new Error(`Untracked collision: ${path} <> ${other}`),{code:'CONFLICT',paths:[path,other]});
  }
  guardIgnored(paths,ignored,label){
    for(const path of paths)for(const other of ignored)if(this.collision(path,other))throw Object.assign(new Error(`${label} ignored obstruction: ${path} <> ${other}`),{code:'CONFLICT',paths:[path,other]});
  }
  async attributes(trees){
    for(const tree of new Set(trees)){
      const names=[...(await this.treeEntries(tree)).keys()];
      const out=(await this.git(['check-attr','--source='+tree,'-z','--stdin','filter','text','eol','working-tree-encoding','ident','merge'],{input:names.join('\0')+'\0'})).stdout.split('\0');
      for(let i=0;i+2<out.length;i+=3)if(!['unspecified','unset'].includes(out[i+2])&&!(out[i+1]==='merge'&&['text','binary'].includes(out[i+2])))throw new Error('Unsupported attribute '+out[i+1]+' on '+out[i]);
    }
  }
  async recovery(sl,dl,index,working,completeWorking){
    const refs={sourceHead:{commit:sl.head,tree:sl.headTree},sourceIndex:{tree:sl.index},sourceWorking:{tree:sl.working},sourceUntracked:{tree:await this.tree(sl.untracked,'source-untracked')},destinationHead:{commit:dl.head,tree:dl.headTree},destinationIndex:{tree:dl.index},destinationWorking:{tree:dl.working},destinationUntracked:{tree:await this.tree(dl.untracked,'destination-untracked')},candidateIndex:{tree:index},candidateTrackedWorking:{tree:working},candidateWorking:{tree:completeWorking},sourceCleanup:{commit:sl.head,tree:sl.headTree}};
    for(const [name,state] of Object.entries(refs)){state.ref='refs/saleh/handoff/'+name;state.commit??=await this.synthetic(state.tree);}
    const updates=Object.values(refs).map(s=>`update ${s.ref} ${s.commit}\n`).join('');await this.git(['update-ref','--stdin'],{input:updates});
    await this.git(['bundle','create',this.artifacts.bundle,...Object.values(refs).map(s=>s.ref)]);
    const bundle=await this.stamp(this.artifacts.bundle,BUNDLE_BYTES);
    this.check();await mkdir(this.artifacts.verifiedRepository,{mode:0o700});this.check();await this.runner.run(['init','--bare',this.artifacts.verifiedRepository],{scope:{dirs:[this.dir]},check:this.check});this.check();
    await this.verifiedGit(['bundle','verify',this.artifacts.bundle]);await this.verifiedGit(['bundle','unbundle',this.artifacts.bundle]);await this.verifiedGit(['update-ref','--stdin'],{input:updates});
    await this.verifiedGit(['fsck','--full','--no-reflogs',...Object.values(refs).map(s=>s.commit)]);
    const actual=(await this.verifiedGit(['rev-parse',...Object.values(refs).flatMap(s=>[s.ref,s.ref+'^{tree}'])])).stdout.trim().split('\n');
    if(JSON.stringify(actual)!==JSON.stringify(Object.values(refs).flatMap(s=>[s.commit,s.tree])))throw new Error('Independent handoff recovery differs from the reviewed Git states.');
    if(JSON.stringify(await this.stamp(this.artifacts.bundle,BUNDLE_BYTES))!==JSON.stringify(bundle))throw new Error('Handoff bundle changed during independent verification.');
    const recovery={bundle,refs};for(const [key,path,max] of [['sourceHead',this.artifacts.sourceOriginalHead,8192],['destinationHead',this.artifacts.destinationOriginalHead,8192],['sourceIndex',this.artifacts.sourceOriginalIndex,4*MAX],['destinationIndex',this.artifacts.destinationOriginalIndex,4*MAX],['index',this.artifacts.index,4*MAX],['sourceCleanupIndex',this.artifacts.sourceCleanupIndex,4*MAX]])recovery[key]=await this.stamp(path,max);
    const s=await lstat(this.artifacts.verifiedRepository,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||await realpath(this.artifacts.verifiedRepository)!==this.artifacts.verifiedRepository)throw new Error('Independent recovery repository changed.');recovery.verifiedRepository={dev:String(s.dev),ino:String(s.ino)};this.check();return recovery;
  }
  // Snapshot one checkout into private objects only. The caller keeps its owner
  // admission and native content baseline: ignored files, metadata and empty
  // directories are not Git objects. No host ref, index or working file is written.
  async inspect(repository){return this.#snapshot(repository,true);}
  async snapshot(captured){return this.#snapshot(captured,false);}
  async #snapshot(captured,inspection){
    this.check();if(this.started)throw new Error('Handoff Git candidate builder is single-use.');this.started=true;
    if(inspection)captured=await this.inspector.readState(captured,this.inspector.epoch,{includeDiff:false});
    const unborn=captured?.head===null;
    if(!captured?.r||!(OID.test(captured.head)||unborn&&safeRef('refs/heads/'+captured.refBranch)&&captured.headRaw==='ref: refs/heads/'+captured.refBranch+'\n')||!(Buffer.isBuffer(captured.index)||unborn&&captured.index===null&&captured.indexEntries instanceof Map&&captured.indexEntries.size===0)||typeof this.inspector.readState!=='function'||typeof this.inspector.peerInventory!=='function')throw new Error('Committed or canonical unborn HEAD and captured Git state are required.');
    const r=captured.r;
    for(const path of [r.cwd,r.gitDir,r.commonDir]){
      if(!isAbsolute(path)||await realpath(path)!==path||inside(path,this.dir)||inside(this.dir,path))throw new Error('Private snapshot directory overlaps or has noncanonical Git paths.');this.check();
    }
    const sameState=(a,b)=>a.fingerprint===b.fingerprint&&a.headRaw===b.headRaw&&(a.index===null&&b.index===null||Buffer.isBuffer(a.index)&&Buffer.isBuffer(b.index)&&a.index.equals(b.index))&&JSON.stringify(a.configFiles)===JSON.stringify(b.configFiles);
    const source=inspection?captured:await this.inspector.readState(r,this.inspector.epoch,{includeDiff:false});this.check();
    if(!sameState(source,captured))throw new Error('Snapshot source changed since capture.');
    if(source.index!==null)ordinaryIndex(source.index);else if(!unborn||source.indexEntries.size)throw new Error('Absent snapshot index has entries.');this.inspector.representable([...source.indexEntries.keys()]);
    if(source.headRaw!==(source.refBranch?'ref: refs/heads/'+source.refBranch+'\n':source.head+'\n')||source.refBranch&&!safeRef('refs/heads/'+source.refBranch))throw new Error('Noncanonical snapshot HEAD.');
    if((await this.read(source,['ls-files','--resolve-undo','-z'])).stdout)throw new Error('Resolve-undo index state is unsupported.');
    const readRefs=async()=>{
      // for-each-ref silently omits dangling symbolic refs. Check the raw ref
      // roots before accepting each resolved inventory, including stale checks.
      const connectivity=await this.read(source,['fsck','--connectivity-only','--no-reflogs','--no-dangling']);
      const notices=unborn?['notice: HEAD points to an unborn branch ('+source.refBranch+')','notice: No default references']:[];
      if(connectivity.stdout.trim()||connectivity.stderr.split('\n').filter(Boolean).some(line=>!notices.includes(line)))throw new Error('Snapshot ref connectivity reported unsupported state.');
      const result=await this.read(source,['for-each-ref','--count=10001','--format=%(refname)%00%(objectname)%00%(symref)']);
      if(result.stderr.trim())throw new Error('Snapshot ref inventory reported invalid refs.');return snapshotRefs(result.stdout);
    };
    const refs=await readRefs(),peers=await this.inspector.peerInventory(r,this.inspector.epoch);this.check();
    if(unborn?refs.some(([name])=>inside(name,'refs/heads/'+source.refBranch)||inside('refs/heads/'+source.refBranch,name)):source.refBranch&&!refs.some(([name,oid,target])=>name==='refs/heads/'+source.refBranch&&oid===source.head&&!target))throw new Error('Snapshot current branch differs from HEAD.');
    for(const [,oid,target] of refs)if(target&&!refs.some(([name,value])=>name===target&&value===oid))throw new Error('Snapshot symbolic ref target is missing or differs.');
    const sourceCheck=async()=>{
      this.check();await this.inspector.verifyRepository(r);this.check();
      const current=await this.inspector.readState(r,this.inspector.epoch,{includeDiff:false});this.check();
      if(!sameState(current,source)||JSON.stringify(await readRefs())!==JSON.stringify(refs)||(await this.inspector.peerInventory(r,this.inspector.epoch)).fingerprint!==peers.fingerprint)throw new Error('Snapshot source changed during preparation.');this.check();
    };
    if(!inspection)await sourceCheck();
    await mkdir(this.dir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const directory=await lstat(this.dir,{bigint:true});
    if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==BigInt(process.getuid())||(directory.mode&0o077n)||await realpath(this.dir)!==this.dir)throw new Error('Snapshot directory must be private and canonical.');this.check();
    this.temporary=[];
    this.env={GIT_ALTERNATE_OBJECT_DIRECTORIES:JSON.stringify(join(r.commonDir,'objects')),GIT_AUTHOR_NAME:'Private snapshot',GIT_AUTHOR_EMAIL:'snapshot@localhost',GIT_COMMITTER_NAME:'Private snapshot',GIT_COMMITTER_EMAIL:'snapshot@localhost',GIT_AUTHOR_DATE:'1700000000 +0000',GIT_COMMITTER_DATE:'1700000000 +0000'};
    await mkdir(this.repo,{mode:0o700});this.check();
    await this.runner.run(['init','--bare','--template=',this.repo],{scope:{dirs:[this.dir]},check:this.check});this.check();
    if(source.index!==null)await this.save(this.artifacts.sourceOriginalIndex,source.index);await this.save(this.artifacts.sourceOriginalHead,source.headRaw);
    const layers=await this.layers(source,'source'),trees={head:layers.headTree,index:layers.index,working:layers.working,untracked:await this.tree(layers.untracked,'source-untracked')};
    await this.attributes([trees.head,trees.index,trees.working,trees.untracked]);
    if(inspection){
      // Preflight consumes only a fresh host witness. Keep the same source/tree
      // validation, but do not build an unused transfer bundle or restore it.
      await sourceCheck();this.#snapshotSourceCheck=sourceCheck;
      return hostGitWitness({head:{oid:source.head,raw:source.headRaw,ref:source.refBranch?'refs/heads/'+source.refBranch:null},refs,trees,source:{repositoryId:r.repositoryId,commonRepositoryId:r.commonRepositoryId,configSHA256:createHash('sha256').update(source.config).digest('hex'),configFiles:source.configFiles,peersFingerprint:peers.fingerprint,index:source.index===null?null:{hash:createHash('sha256').update(source.index).digest('hex'),bytes:source.index.length}}});
    }
    const namespace='refs/guest-snapshot-'+randomUUID(),witnesses={};
    if(refs.some(([name])=>inside(namespace,name)||inside(name,namespace)))throw new Error('Snapshot witness refs collide with captured refs.');
    for(const [name,tree] of Object.entries(trees))witnesses[name]={ref:namespace+'/'+name,oid:name==='head'&&!unborn?source.head:await this.synthetic(tree),tree};
    const bundleRefs=sortedRefs([...refs.map(([name,oid])=>[name,oid]),...Object.values(witnesses).map(v=>[v.ref,v.oid])]);
    const updates=bundleRefs.map(([name,oid])=>`create ${name} ${oid}\n`).join('');
    await this.git(['update-ref','--stdin'],{input:updates});
    await this.git(['bundle','create',this.artifacts.bundle,'--stdin'],{input:bundleRefs.map(([name])=>name+'\n').join('')});
    const limit=32*MAX,bundle={path:this.artifacts.bundle,...await this.stamp(this.artifacts.bundle,limit)};
    await mkdir(this.artifacts.verifiedRepository,{mode:0o700});this.check();
    await this.runner.run(['init','--bare','--template=',this.artifacts.verifiedRepository],{scope:{dirs:[this.dir]},check:this.check});this.check();
    const transfer={version:1,kind:'git-snapshot',head:{oid:source.head,raw:source.headRaw,ref:source.refBranch?'refs/heads/'+source.refBranch:null},refs,trees,witnesses,bundleRefs,bundle};
    await restoreSnapshot(transfer,(args,options)=>this.verifiedGit(args,options),{retainWitnesses:true});
    if(JSON.stringify([...await this.treeEntries(trees.index,{verified:true})])!==JSON.stringify([...source.indexEntries]))throw new Error('Independent staged entries differ.');
    if(JSON.stringify({path:bundle.path,...await this.stamp(bundle.path,limit)})!==JSON.stringify(bundle))throw new Error('Snapshot bundle changed during verification.');
    await sourceCheck();
    const plan={version:1,kind:'git-snapshot',source:{repositoryId:r.repositoryId,commonRepositoryId:r.commonRepositoryId,fingerprint:source.fingerprint,peersFingerprint:peers.fingerprint,configSHA256:createHash('sha256').update(source.config).digest('hex'),configFiles:source.configFiles,index:source.index===null?null:await this.stamp(this.artifacts.sourceOriginalIndex,4*MAX),head:await this.stamp(this.artifacts.sourceOriginalHead,8192)},head:{oid:source.head,raw:source.headRaw,ref:source.refBranch?'refs/heads/'+source.refBranch:null},refs,trees,witnesses,bundleRefs,bundle,ignored:layers.ignored,artifacts:{directory:this.dir,repository:this.repo,verifiedRepository:this.artifacts.verifiedRepository,originalIndex:source.index===null?null:this.artifacts.sourceOriginalIndex,originalHead:this.artifacts.sourceOriginalHead,manifest:this.artifacts.manifest},limits:['Git snapshot only; no source mutation or publication.','Native metadata, ignored files and empty directories require the separately verified content transfer.','Only captured refs and their reachable objects are transferred; reflogs, configuration and hooks are not copied.','Bundle is self-contained and limited to 32 MiB; existing ordinary-index, path, attribute and changed-content bounds apply.']};
    const manifest=JSON.stringify(plan,null,2)+'\n';if(Buffer.byteLength(manifest)>8*MAX)throw new Error('Snapshot manifest exceeds its size limit.');await this.save(this.artifacts.manifest,manifest);
    const held=await open(this.dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await held.sync();}finally{await held.close();}
    await sourceCheck();this.#snapshotSourceCheck=sourceCheck;return plan;
  }
  async prepare(source,destination,peers,{temporary=[]}={}){
    await this.validate(source,destination,peers,temporary);
    this.source=source;this.destination=destination;
    this.env={GIT_ALTERNATE_OBJECT_DIRECTORIES:JSON.stringify(join(source.r.commonDir,'objects')),GIT_AUTHOR_NAME:'Private handoff',GIT_AUTHOR_EMAIL:'handoff@localhost',GIT_COMMITTER_NAME:'Private handoff',GIT_COMMITTER_EMAIL:'handoff@localhost',GIT_AUTHOR_DATE:'1700000000 +0000',GIT_COMMITTER_DATE:'1700000000 +0000'};
    this.check();await mkdir(this.repo,{mode:0o700});this.check();
    await this.runner.run(['init','--bare',this.repo],{scope:{dirs:[this.dir]},check:this.check});this.check();
    await this.save(this.artifacts.sourceOriginalIndex,source.index);await this.save(this.artifacts.destinationOriginalIndex,destination.index);await this.save(this.artifacts.sourceOriginalHead,source.headRaw);await this.save(this.artifacts.destinationOriginalHead,destination.headRaw);
    const sl=await this.layers(source,'source'),dl=await this.layers(destination,'destination');
    await this.attributes([sl.headTree,sl.index,sl.working,dl.headTree,dl.index,dl.working]);
    this.guardUntracked(sl,dl);
    const stagedDestination=await this.merge(dl.headTree,sl.headTree,dl.index,'destination staged onto source HEAD');
    const index=await this.merge(sl.headTree,stagedDestination,sl.index,'source staged onto candidate index');
    const workingDestination=await this.merge(dl.index,index,dl.working,'destination unstaged onto candidate index');
    const working=await this.merge(sl.index,workingDestination,sl.working,'source unstaged onto candidate working');
    const tracked=await this.treeEntries(working),indexEntries=await this.treeEntries(index);
    for(const [path,value] of [...dl.untracked,...sl.untracked]){
      for(const other of new Set([...tracked.keys(),...indexEntries.keys()]))if(this.collision(path,other))throw Object.assign(new Error('Candidate tracked/untracked collision: '+path),{code:'CONFLICT'});
      tracked.set(path,value);
    }
    this.inspector.representable([...tracked.keys()]);
    this.guardTemporary(destination,new Set([...tracked.keys(),...indexEntries.keys()]));
    this.guardIgnored(tracked.keys(),dl.ignored,'destination');
    this.guardIgnored((await this.treeEntries(sl.headTree)).keys(),sl.ignored,'source cleanup');
    const completeWorking=await this.tree(tracked,'destination-complete-working');
    await this.tree(indexEntries,'destination-candidate');
    await this.tree(await this.treeEntries(sl.headTree),'source-cleanup');
    const branch={sourceBefore:source.headRaw,destinationBefore:destination.headRaw,sourceAfter:source.head+'\n',destinationAfter:source.refBranch?'ref: refs/heads/'+source.refBranch+'\n':source.head+'\n',retainedDestinationBranch:destination.refBranch||null,retention:{source:source.head,destination:destination.head},branchRefsUnchanged:true};
    const changes=async(before,after)=>(await this.git(['diff-tree','--no-commit-id','--name-status','--no-renames','-r','-z',before,after])).stdout;
    const plan={version:1,artifacts:this.artifacts,objectEnvironment:{GIT_ALTERNATE_OBJECT_DIRECTORIES:this.env.GIT_ALTERNATE_OBJECT_DIRECTORIES},peers,head:source.head,index,working:completeWorking,trackedWorking:working,sourceCleanup:{head:source.head,index:sl.headTree,working:sl.headTree,deleteUntracked:[...sl.untracked.keys()]},branch,steps:this.steps,destinationLayers:{before:dl,staged:await changes(sl.headTree,index),unstaged:await changes(index,working)},sourceLayers:sl,sourceFingerprint:source.fingerprint,destinationFingerprint:destination.fingerprint,limits:['Native metadata/empty directories require separate file transfer.','Publication, cancellation, retained refs and source cleanup are not executed by preview.','Ignored leaf obstructions are rejected; native inventory must also account for empty ignored directories and filesystem metadata.','Non-UTF-8 paths, case/normalization aliases, submodules, filters, conversion, index flags and active Git operations are rejected.']};
    plan.temporary=this.temporary;plan.recovery=await this.recovery(sl,dl,index,working,completeWorking);
    await this.save(this.artifacts.manifest,JSON.stringify(plan,(_k,v)=>v instanceof Map?[...v]:v,2)+'\n');
    const directory=await open(this.dir,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}this.check();
    return plan;
  }
}
