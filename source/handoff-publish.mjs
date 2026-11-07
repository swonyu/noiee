import {mkdir,open,lstat,realpath,readdir,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,isAbsolute,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const MAX=1048576,OID=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAMES=['sourceHead','sourceIndex','sourceWorking','sourceUntracked','destinationHead','destinationIndex','destinationWorking','destinationUntracked','candidateIndex','candidateTrackedWorking','candidateWorking','sourceCleanup'];
const sha=b=>createHash('sha256').update(b).digest('hex'),id=s=>({dev:String(s.dev),ino:String(s.ino)}),same=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),fail=m=>new Error('Handoff Git: '+m);
const sorted=m=>[...m].sort(([a],[b])=>a<b?-1:a>b?1:0);
const safeRef=value=>typeof value==='string'&&Buffer.byteLength(value)<=4096&&value.startsWith('refs/')&&!/[\0-\x20\x7f~^:?*\[\\]/.test(value)&&!value.includes('..')&&!value.includes('@{')&&value.split('/').every(part=>part&&!part.startsWith('.')&&!part.endsWith('.')&&!part.endsWith('.lock'));
async function bounded(path,max,check,expected,singleLink=false){
  check();const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const a=await f.stat({bigint:true});if(!a.isFile()||a.size<0n||a.size>BigInt(max)||singleLink&&a.nlink!==1n)throw fail('invalid bounded file: '+path);const parts=[];let size=0;for await(const b of f.createReadStream({autoClose:false})){check();size+=b.length;if(size>max)throw fail('file exceeds limit');parts.push(b);}const z=await f.stat({bigint:true});if(!same(id(a),id(z))||a.size!==z.size||a.mtimeNs!==z.mtimeNs||a.ctimeNs!==z.ctimeNs||singleLink&&z.nlink!==1n)throw fail('file changed while reading');const data=Buffer.concat(parts),stamp={identity:id(a),hash:sha(data),bytes:data.length};if(expected&&!equal(stamp,expected))throw fail('reviewed artifact changed: '+path);check();return {data,stamp};}finally{await f.close();}
}
async function capturePreparedLocks(entries,check){const locks=[];for(const [path,raw] of entries){const value=await bounded(path,8192,check,undefined,true);if(value.data.toString('utf8')!==raw)throw fail('prepared Git lock differs from intended bytes');locks.push({path,stamp:value.stamp});}return locks;}
async function verifyPreparedLocks(locks,check){for(const {path,stamp} of locks){check();await bounded(path,8192,check,stamp,true);check();}}
function refRows(out){const rows=out.split('\n').filter(Boolean);if(rows.length>10000)throw fail('ref inventory exceeds 10,000 entries');return new Map(rows.map(row=>{const fields=row.split('\0');if(fields.length!==3||!fields[0].startsWith('refs/')||!OID.test(fields[1]))throw fail('unsupported ref inventory');return [fields[0],fields.slice(1)];}));}
function peersView(records,s,d,sourceDetached,destinationChanged){return records.map(row=>{let head=row.head,branch=row.branch;if(row.path===s.r.cwd&&sourceDetached){head=s.head;branch=undefined;}if(row.path===d.r.cwd&&destinationChanged){head=s.head;branch=s.refBranch?'refs/heads/'+s.refBranch:undefined;}return {path:row.path,id:row.id,head,branch,rest:row.raw.split('\0').filter(x=>!x.startsWith('HEAD ')&&!x.startsWith('branch ')&&x!=='detached')};});}

function baselineShape(baseline){
  if(baseline?.version!==1||Buffer.byteLength(JSON.stringify(baseline))>8*MAX||!Array.isArray(baseline.originalRefs)||baseline.originalRefs.length>10000||!equal(Object.keys(baseline.states??{}).sort(),['destination','source']))throw fail('invalid recovery baseline');
  const names=new Set();for(const row of baseline.originalRefs){if(!Array.isArray(row)||row.length!==2||!safeRef(row[0])||names.has(row[0])||!Array.isArray(row[1])||row[1].length!==2||!OID.test(row[1][0])||typeof row[1][1]!=='string'||row[1][1]&&!safeRef(row[1][1]))throw fail('invalid baseline ref');names.add(row[0]);}
  for(const state of Object.values(baseline.states)){
    if(!OID.test(state.head)||typeof state.refBranch!=='string'||state.refBranch&&!safeRef('refs/heads/'+state.refBranch)||typeof state.config!=='string'||Buffer.byteLength(state.config)>2*MAX||!/^[a-f0-9]{64}$/.test(state.fingerprint)||!Array.isArray(state.configFiles)||state.configFiles.length>4096)throw fail('invalid baseline state');
    for(const f of state.configFiles)if(typeof f.path!=='string'||!isAbsolute(f.path)||resolve(f.path)!==f.path||!/^\d+$/.test(f.id?.dev)||!/^\d+$/.test(f.id?.ino)||!/^[a-f0-9]{64}$/.test(f.hash))throw fail('invalid baseline configuration');
    if(state.refBranch&&!equal(new Map(baseline.originalRefs).get('refs/heads/'+state.refBranch),[state.head,'']))throw fail('baseline current branch differs');
  }
  return baseline;
}
// Persist this compact value inside the manager's stamped preparation manifest.
export async function captureHandoffGitBaseline(plan,{runner,inspector,check}){
  const alive=()=>{check();if(runner.blocked||inspector.runner?.blocked)throw fail('process exit unconfirmed');};
  const states={};for(const label of ['source','destination']){const state=plan.states[label];if(state.headRaw!==(state.refBranch?'ref: refs/heads/'+state.refBranch+'\n':state.head+'\n'))throw fail('noncanonical original HEAD bytes require inspection before recoverable handoff');await inspector.verifyRepository(state.r);alive();const current=await inspector.readState(state.r,inspector.epoch,{omitUntracked:(plan.temporary??[]).filter(t=>t.cwd===state.r.cwd).map(t=>t.path.slice(t.cwd.length+1))});alive();if(current.fingerprint!==state.fingerprint)throw fail('captured Git state is stale');states[label]=Object.fromEntries(['head','refBranch','config','configFiles','fingerprint'].map(key=>[key,state[key]]));}
  const originalRefs=sorted(refRows((await runner.run(['--git-dir='+plan.states.source.r.gitDir,'for-each-ref','--count=10001','--format=%(refname)%00%(objectname)%00%(symref)'],{scope:{},check:alive})).stdout));alive();
  return JSON.parse(JSON.stringify(baselineShape({version:1,originalRefs,states})));
}
export async function rehydrateHandoffGitStates({baseline,repositories,candidate},{check}){
  baselineShape(baseline);const states={};
  for(const label of ['source','destination']){
    const saved=baseline.states[label],head=await bounded(candidate.artifacts[label+'OriginalHead'],8192,check,candidate.recovery[label+'Head']),index=await bounded(candidate.artifacts[label+'OriginalIndex'],4*MAX,check,candidate.recovery[label+'Index']);
    const headRaw=new TextDecoder('utf-8',{fatal:true}).decode(head.data);if(headRaw!==(saved.refBranch?'ref: refs/heads/'+saved.refBranch+'\n':saved.head+'\n')||repositories[label]?.cwd===undefined)throw fail('baseline differs from original HEAD');
    states[label]={...saved,r:repositories[label],headRaw,index:index.data,branch:saved.refBranch};
  }
  check();return states;
}

function recoveryLockPaths(plan){
  const paths=new Map(),{source:s,destination:d}=plan.states;
  for(const state of [s,d]){paths.set(join(state.r.gitDir,'index.lock'),{owner:'application',kind:'index'});paths.set(join(state.r.gitDir,'HEAD.lock'),{owner:'git',kind:'head'});if(state.refBranch)paths.set(join(s.r.commonDir,'refs/heads/'+state.refBranch+'.lock'),{owner:'application',kind:'branch'});}
  for(const name of NAMES)paths.set(join(s.r.commonDir,'refs/saleh/handoff/'+plan.id+'/'+name+'.lock'),{owner:'git',kind:'ref'});
  return paths;
}
// This checks Git only. The manager must independently prove process exit, validate
// its durable manifest/journal and reserve the entire peer set before calling it.
export async function reviewHandoffGitRecovery(plan,{runner,inspector,check,locks=[]}){
  if(!UUID.test(plan?.id)||!plan.states?.source||!plan.states?.destination||!Array.isArray(locks)||locks.length>64)throw fail('invalid recovery authority');baselineShape(plan.gitBaseline);
  const alive=()=>{check();if(runner.blocked||inspector.runner?.blocked)throw fail('process exit unconfirmed');};alive();if(runner.child||inspector.runner?.child)throw fail('process still owns Git recovery');
  const read=(path,max,stamp)=>bounded(path,max,alive,stamp),{source:s,destination:d}=plan.states,c=plan.candidate,known=recoveryLockPaths(plan),journal=new Map();
  const run=async args=>{const result=await runner.run(['--git-dir='+s.r.gitDir,'--literal-pathspecs',...args],{scope:{},env:{GIT_ALTERNATE_OBJECT_DIRECTORIES:''},check:alive});alive();return result;};
  for(const lock of locks){const type=known.get(lock.path);if(!type||journal.has(lock.path)||lock.owner!==type.owner||lock.kind!==type.kind||!/^\d+$/.test(lock.identity?.dev)||!/^\d+$/.test(lock.identity?.ino)||!/^[a-f0-9]{64}$/.test(lock.hash)||!Number.isSafeInteger(lock.bytes)||lock.bytes<0||lock.bytes>4*MAX)throw fail('invalid journaled Git lock');journal.set(lock.path,lock);}
  const states={};for(const [label,state] of Object.entries(plan.states)){
    await inspector.verifyRepository(state.r);alive();const head=await read(join(state.r.gitDir,'HEAD'),8192),index=await read(join(state.r.gitDir,'index'),4*MAX),raw=new TextDecoder('utf-8',{fatal:true}).decode(head.data);
    const rawKnown=label==='source'?[state.headRaw,c.branch.sourceAfter]:[state.headRaw,c.branch.destinationAfter,state.head+'\n',s.head+'\n'];
    if(!rawKnown.includes(raw)||![c.recovery[label+'Index'].hash,c.recovery[label==='source'?'sourceCleanupIndex':'index'].hash].includes(index.stamp.hash))throw fail('live recovery HEAD or index is outside the retained states');
    for(const file of state.configFiles){const value=await read(file.path,MAX);if(!same(value.stamp.identity,file.id)||value.stamp.hash!==file.hash)throw fail('configuration file changed');}
    const config=(await runner.run(['--git-dir='+state.r.gitDir,'config','--includes','--null','--show-origin','--list'],{scope:{},check:alive})).stdout;if(config!==state.config)throw fail('Git configuration changed');
    states[label]={head:{raw,...head.stamp},index:index.stamp};
  }
  const refs=sorted(refRows((await run(['for-each-ref','--count=10001','--format=%(refname)%00%(objectname)%00%(symref)'])).stdout)),map=new Map(refs);
  for(const [ref,value] of plan.gitBaseline.originalRefs)if(!equal(map.get(ref),value))throw fail('original ref changed; recovery preserves all refs');
  for(const name of NAMES){const value=map.get('refs/saleh/handoff/'+plan.id+'/'+name);if(value&&!equal(value,[c.recovery.refs[name].commit,'']))throw fail('retained recovery ref changed');}
  const observedLocks=[];for(const [path,type] of known){let value;try{value=await read(path,4*MAX);}catch(error){if(error.code==='ENOENT')continue;throw error;}const lock=journal.get(path);if(!lock||!same(lock.identity,value.stamp.identity))throw fail('unowned or replaced Git lock retained: '+path);
    if(value.stamp.hash!==lock.hash||value.stamp.bytes!==lock.bytes||(await lstat(path,{bigint:true})).nlink!==1n)throw fail('journaled lock contents or links changed');observedLocks.push({path,...value.stamp,...type});
  }
  for(const path of [join(s.r.commonDir,'packed-refs.lock'),join(s.r.commonDir,'config.lock'),...Object.values(plan.states).map(state=>join(state.r.gitDir,'config.worktree.lock'))])try{await lstat(path);throw fail('unowned Git metadata lock retained: '+path);}catch(error){if(error.code!=='ENOENT')throw error;}
  const peers=await inspector.peerInventory(s.r,inspector.epoch);alive();
  const expected=plan.peers.records.map(row=>{const label=row.path===s.r.cwd?'source':row.path===d.r.cwd?'destination':null;if(!label)return row;const raw=states[label].head.raw,branch=raw.startsWith('ref: ')?raw.slice(5).trim():undefined,head=branch?map.get(branch)?.[0]:raw.trim();if(!OID.test(head))throw fail('recovery HEAD cannot resolve');return {...row,head,branch};});
  if(!equal(peersView(peers.records,s,d,false,false),peersView(expected,s,d,false,false)))throw fail('recovery peer inventory changed');
  // Bind HEAD/index again after the config/ref/peer reads.
  for(const [label,state] of Object.entries(plan.states)){await inspector.verifyRepository(state.r);await read(join(state.r.gitDir,'HEAD'),8192,states[label].head&&(({raw,...stamp})=>stamp)(states[label].head));await read(join(state.r.gitDir,'index'),4*MAX,states[label].index);}
  alive();const value={version:1,id:plan.id,states,refs,peers,locks:observedLocks};if(Buffer.byteLength(JSON.stringify(value))>8*MAX)throw fail('recovery review exceeds limit');return {...value,fingerprint:sha(JSON.stringify(value))};
}

export async function verifyHandoffGitRecovery(plan,receipt,{runner,inspector,check}){
  if(receipt?.id!==plan.id||!['restored','finished'].includes(receipt?.state))throw fail('invalid recovery receipt');
  const current=await reviewHandoffGitRecovery(plan,{runner,inspector,check,locks:receipt.locks??[]});
  if(current.locks.length)throw fail('recovery retains live Git locks');
  if(receipt.state==='restored'){for(const [label,state] of Object.entries(plan.states))if(current.states[label].head.raw!==state.headRaw||current.states[label].index.hash!==plan.candidate.recovery[label+'Index'].hash)throw fail('original HEAD or index was not restored');}
  else await verifyHandoffGitPublication(plan,receipt,{runner,inspector,check});
  if(!equal(current.refs,receipt.refs)||!equal(current.states,receipt.states)||!equal(current.peers,receipt.peers))throw fail('recovered Git state changed');
  if(!OID.test(receipt.pack?.oid)||receipt.pack.keepPath!==join(plan.states.source.r.commonDir,'objects/pack/pack-'+receipt.pack.oid+'.keep'))throw fail('invalid recovery GC keep receipt');await bounded(receipt.pack.keepPath,8192,check,receipt.pack.stamp);
  if(receipt.state==='restored')await runner.run(['--git-dir='+plan.states.source.r.gitDir,'fsck','--full','--no-references','--no-reflogs','--no-dangling',...NAMES.map(name=>plan.candidate.recovery.refs[name].commit)],{scope:{},env:{GIT_ALTERNATE_OBJECT_DIRECTORIES:''},check});
  const final=await reviewHandoffGitRecovery(plan,{runner,inspector,check,locks:receipt.locks??[]});if(!equal(final,current))throw fail('recovered Git state changed during object verification');
  check();return {verified:true,...final};
}

// Recover only reviewed Git states. Native bytes/metadata and chat recovery are
// caller-owned barriers. Any failure retains recovery artifacts; it is not a rollback.
export async function restoreHandoffGit(plan,review,{restoreFiles,...options}){return recoverHandoffGit(plan,review,{...options,transferFiles:restoreFiles,finish:false});}
export async function finishHandoffGit(plan,review,{finishFiles,...options}){return recoverHandoffGit(plan,review,{...options,transferFiles:finishFiles,finish:true});}
async function recoverHandoffGit(plan,review,{runner,inspector,check,checkpoint,transferFiles,finish}){
  if(![check,checkpoint,transferFiles].every(f=>typeof f==='function')||review?.id!==plan.id||review.version!==1||!isAbsolute(plan.directory)||resolve(plan.directory)!==plan.directory)throw fail('invalid recovery publication authority');
  const {fingerprint,...reviewed}=review;if(sha(JSON.stringify(reviewed))!==fingerprint)throw fail('recovery review fingerprint differs');
  const {source:s,destination:d}=plan.states,c=plan.candidate,owned=[],journal=new Map(review.locks.map(lock=>[lock.path,lock])),expected=structuredClone(review.states),retiredLocks=[],refs=new Map(review.refs),recoveryRefs=Object.fromEntries(NAMES.map(name=>[name,'refs/saleh/handoff/'+plan.id+'/'+name]));
  const env={GIT_ALTERNATE_OBJECT_DIRECTORIES:'',GIT_COMMITTER_NAME:'Saleh handoff recovery',GIT_COMMITTER_EMAIL:'handoff@localhost'},mutation=['-c','core.fsync=all','-c','core.fsyncMethod=fsync'];let phase='git-recovery-checking',cancelled=false,pack,native,result,error;
  const alive=()=>{check();if(runner.blocked||inspector.runner?.blocked)throw fail('process exit unconfirmed');},read=(path,max,stamp)=>bounded(path,max,alive,stamp);
  const point=async(name,details={})=>{alive();phase=name;await checkpoint(name,details);alive();};
  const sync=async path=>{const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}};
  const directory=async(path,expectedIdentity,privateRoot=false)=>{alive();const stat=await lstat(path,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(path)!==path||expectedIdentity&&!same(id(stat),expectedIdentity)||privateRoot&&(stat.uid!==BigInt(process.getuid())||(stat.mode&0o077n)))throw fail('recovery directory identity changed');return id(stat);};
  const run=async(r,args,options={})=>{alive();const result=await runner.run(['--git-dir='+r.gitDir,'--literal-pathspecs',...args],{...options,env,check:alive,onUnavailable:()=>{if(runner.child?.cancelled)cancelled=true;}});alive();return result;};
  const stampHead=head=>{const {raw,...stamp}=head;return stamp;};
  async function diskCheck(bound=alive){
    bound();for(const [label,state] of Object.entries(plan.states)){await inspector.verifyRepository(state.r);await read(join(state.r.gitDir,'HEAD'),8192,stampHead(expected[label].head));await read(join(state.r.gitDir,'index'),4*MAX,expected[label].index);for(const file of state.configFiles){const value=await read(file.path,MAX);if(!same(value.stamp.identity,file.id)||value.stamp.hash!==file.hash)throw fail('configuration file changed');}bound();}
    for(const lock of owned)if(lock.path)await read(lock.path,4*MAX,lock.stamp);bound();
  }
  async function stateCheck(){const current=await reviewHandoffGitRecovery(plan,{runner,inspector,check:alive,locks:[...journal.values()]});if(!equal(current.states,expected)||!equal(current.refs,sorted(refs)))throw fail('reviewed recovery state changed');await diskCheck();return current;}
  async function acquire(path,kind){
    const root=path.startsWith(s.r.commonDir+'/refs/')?s.r.commonDir:dirname(path),parents=[];for(let at=dirname(path);at!==root;at=dirname(at)){if(at==='/'||!at.startsWith(root+'/'))throw fail('lock path escapes repository');parents.unshift(at);}await directory(root);for(const at of parents){await mkdir(at,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await directory(at);}
    const file=await open(path,'wx',0o600),identity=id(await file.stat({bigint:true})),lock={path,file,identity,kind,stamp:{identity,hash:sha(Buffer.alloc(0)),bytes:0}};owned.push(lock);await file.sync();await sync(dirname(path));const row={path,...lock.stamp,owner:'application',kind};journal.set(path,row);await point('git-recovery-lock-acquired',{lock:row});return lock;
  }
  async function publishHead(label,raw,phaseName){
    const state=plan.states[label],before=expected[label].head.raw;if(before===raw)return;
    await point(phaseName+'-publishing');await stateCheck();let parent,prepared,work;
    const oid=value=>value.startsWith('ref: ')?refs.get(value.slice(5).trim())?.[0]:value.trim(),old=before.startsWith('ref: ')?'ref '+before.slice(5).trim():'oid '+oid(before);
    const command=raw.startsWith('ref: ')?`symref-update HEAD ${raw.slice(5).trim()} ${old}\n`:`update HEAD ${oid(raw)} ${oid(before)}\n`;
    const bound=()=>{alive();if(!parent||runner.child!==parent||parent.cancelled||parent.exited||parent.unavailable)throw fail('prepared recovery transaction authority ended');};
    try{await run(state.r,[...mutation,'update-ref','--stdin'],{input:'start\noption no-deref\n'+command+'prepare\n',scope:inspector.refScope(state.r,[]),prepared:()=>{parent=runner.child;work=(async()=>{await diskCheck(bound);const path=join(state.r.gitDir,'HEAD.lock'),locks=await capturePreparedLocks([[path,raw]],bound);prepared=locks[0].stamp;const lock={path,...prepared,owner:'git',kind:'head'};journal.set(path,lock);await point('git-recovery-ref-lock-prepared',{lock});bound();await diskCheck(bound);await verifyPreparedLocks(locks,bound);})();return work;}});}finally{await work?.catch(()=>{});}
    await sync(state.r.gitDir);const current=await read(join(state.r.gitDir,'HEAD'),8192);if(!same(current.stamp.identity,prepared?.identity)||current.data.toString('utf8')!==raw)throw fail('restored HEAD differs from prepared lock');expected[label].head={raw,...current.stamp};await stateCheck();await point(phaseName+'-published',{head:{path:join(state.r.gitDir,'HEAD'),...expected[label].head}});
  }
  try{
    const current=await reviewHandoffGitRecovery(plan,{runner,inspector,check:alive,locks:review.locks});if(!equal(current,review))throw fail('recovery review changed');
    await directory(plan.directory,plan.recovery?.directory,true);const original=await rehydrateHandoffGitStates({baseline:plan.gitBaseline,repositories:{source:s.r,destination:d.r},candidate:c},{check:alive});
    for(const label of ['source','destination'])if(original[label].headRaw!==plan.states[label].headRaw||!original[label].index.equals(plan.states[label].index))throw fail('original recovery artifacts differ from plan');
    const targets={};for(const label of ['source','destination']){const key=finish?(label==='source'?'sourceCleanupIndex':'index'):label+'Index',path=finish?c.artifacts[key]:c.artifacts[label+'OriginalIndex'];targets[label]={index:(await read(path,4*MAX,c.recovery[key])).data,hash:c.recovery[key].hash,head:finish?c.branch[label+'After']:original[label].headRaw};}
    if(c.branch.sourceAfter!==s.head+'\n'||c.branch.destinationAfter!==(s.refBranch?'ref: refs/heads/'+s.refBranch+'\n':s.head+'\n'))throw fail('candidate HEAD semantics differ');
    // Re-import from a fresh independent repository even when publication ended
    // before object import. The retained GC keep protects every original index blob.
    await read(c.artifacts.bundle,512*MAX,c.recovery.bundle);const privateRepo=join(plan.directory,'recovery-'+randomUUID()+'.git');await mkdir(privateRepo,{mode:0o700});await sync(plan.directory);await point('git-recovery-objects-preparing',{directory:privateRepo,identity:await directory(privateRepo,null,true)});
    await runner.run(['init','--bare',privateRepo],{scope:{dirs:[privateRepo]},env,check:alive});const privateState={gitDir:privateRepo};await run(privateState,['bundle','verify',c.artifacts.bundle]);await run(privateState,['bundle','unbundle',c.artifacts.bundle],{scope:{dirs:[privateRepo]}});await read(c.artifacts.bundle,512*MAX,c.recovery.bundle);await run(privateState,['fsck','--full','--no-reflogs',...NAMES.map(n=>c.recovery.refs[n].commit)]);
    const objectsExpected=NAMES.flatMap(n=>[c.recovery.refs[n].commit,c.recovery.refs[n].tree]),objectsActual=(await run(privateState,['rev-parse',...NAMES.flatMap(n=>[c.recovery.refs[n].commit,c.recovery.refs[n].commit+'^{tree}'])])).stdout.trim().split('\n');if(!equal(objectsActual,objectsExpected))throw fail('independent recovery objects differ');
    const packs=(await readdir(join(privateRepo,'objects/pack'))).filter(name=>/^pack-[a-f0-9]{40}\.pack$/.test(name));if(packs.length!==1)throw fail('expected one recovery pack');const packPath=join(privateRepo,'objects/pack',packs[0]),bytes=await read(packPath,512*MAX),objects=join(s.r.commonDir,'objects');await directory(objects);await mkdir(join(objects,'pack')).catch(error=>{if(error.code!=='EEXIST')throw error;});await directory(join(objects,'pack'));
    await point('git-recovery-objects-importing',{path:packPath,stamp:bytes.stamp});await stateCheck();const packed=await read(packPath,512*MAX,bytes.stamp),imported=(await run(s.r,[...mutation,'index-pack','--stdin','--strict','--keep=Saleh handoff recovery '+plan.id],{input:packed.data,scope:{dirs:[objects]}})).stdout.trim(),match=/^(?:keep|pack)\t([a-f0-9]{40})$/.exec(imported);if(!match||packs[0]!=='pack-'+match[1]+'.pack')throw fail('recovery pack identity differs');
    pack={oid:match[1],keepPath:join(objects,'pack','pack-'+match[1]+'.keep')};pack.stamp=(await read(pack.keepPath,8192)).stamp;await sync(join(objects,'pack'));await sync(objects);await point('git-recovery-objects-imported',{pack});await stateCheck();
    if(review.locks.length){const retained=join(plan.directory,'retained-locks-'+randomUUID());await mkdir(retained,{mode:0o700});await sync(plan.directory);for(const [index,lock] of review.locks.entries()){
      await stateCheck();const target=join(retained,String(index).padStart(3,'0'));await read(lock.path,4*MAX,(({path,owner,kind,...stamp})=>stamp)(lock));await point('git-recovery-lock-retiring',{lock,target});await read(lock.path,4*MAX,(({path,owner,kind,...stamp})=>stamp)(lock));await rename(lock.path,target);await sync(dirname(lock.path));await sync(retained);const value=await read(target,4*MAX);if(!same(value.stamp.identity,lock.identity)||value.stamp.hash!==lock.hash)throw fail('retained lock identity changed');retiredLocks.push({path:lock.path,retainedPath:target,...value.stamp});await point('git-recovery-lock-retired',retiredLocks.at(-1));
    }}
    if(finish){
      const missing=NAMES.filter(name=>!refs.has(recoveryRefs[name]));
      if(missing.length){
        await point('git-recovery-refs-creating',{refs:Object.fromEntries(missing.map(name=>[name,recoveryRefs[name]]))});await stateCheck();let parent,work;
        const bound=()=>{alive();if(!parent||runner.child!==parent||parent.cancelled||parent.exited||parent.unavailable)throw fail('prepared recovery transaction authority ended');};
        try{await run(s.r,[...mutation,'update-ref','--stdin'],{input:'start\n'+missing.map(name=>`create ${recoveryRefs[name]} ${c.recovery.refs[name].commit}\n`).join('')+'prepare\n',scope:inspector.refScope(s.r,missing.map(name=>recoveryRefs[name])),prepared:()=>{parent=runner.child;work=(async()=>{await diskCheck(bound);const prepared=await capturePreparedLocks(missing.map(name=>[join(s.r.commonDir,recoveryRefs[name]+'.lock'),c.recovery.refs[name].commit+'\n']),bound);for(const {path,stamp} of prepared){const lock={path,...stamp,owner:'git',kind:'ref'};journal.set(path,lock);await point('git-recovery-ref-lock-prepared',{lock});bound();}await diskCheck(bound);await verifyPreparedLocks(prepared,bound);})();return work;}});}finally{await work?.catch(()=>{});}
        for(const name of missing)refs.set(recoveryRefs[name],[c.recovery.refs[name].commit,'']);for(let path=dirname(join(s.r.commonDir,recoveryRefs.sourceHead));;path=dirname(path)){await sync(path);if(path===s.r.commonDir)break;}await stateCheck();await point('git-recovery-refs-created',{refs:recoveryRefs});
      }
    }
    const indexLocks={};for(const [label,state] of Object.entries(plan.states).sort((a,b)=>a[1].r.gitDir<b[1].r.gitDir?-1:1))indexLocks[label]=await acquire(join(state.r.gitDir,'index.lock'),'index');
    for(const ref of [...new Set([s,d].filter(state=>state.refBranch).map(state=>'refs/heads/'+state.refBranch))].sort())await acquire(join(s.r.commonDir,ref+'.lock'),'branch');
    for(const label of ['source','destination']){const lock=indexLocks[label];await lock.file.writeFile(targets[label].index);await lock.file.sync();lock.stamp=(await read(lock.path,4*MAX)).stamp;journal.set(lock.path,{path:lock.path,...lock.stamp,owner:'application',kind:'index'});}await point('git-recovery-locked',{locks:[...journal.values()].filter(row=>owned.some(lock=>lock.path===row.path))});await stateCheck();
    if(finish)await publishHead('source',c.branch.sourceAfter,'git-recovery-source-detach');
    else{const raw=expected.destination.head.raw,oid=raw.startsWith('ref: ')?refs.get(raw.slice(5).trim())[0]:raw.trim();await publishHead('destination',oid+'\n','git-recovery-destination-detach');}
    await point('git-recovery-files-'+(finish?'finishing':'restoring'));await stateCheck();native=await transferFiles();alive();await stateCheck();await point('git-recovery-files-'+(finish?'finished':'restored'));
    for(const label of finish?['destination','source']:['source','destination']){const state=plan.states[label],lock=indexLocks[label];if(expected[label].index.hash===targets[label].hash)continue;await point('git-recovery-'+label+'-index-publishing');await stateCheck();await read(lock.path,4*MAX,lock.stamp);await lock.file.close();lock.file=null;await diskCheck();await rename(lock.path,join(state.r.gitDir,'index'));lock.path=null;await sync(state.r.gitDir);const value=await read(join(state.r.gitDir,'index'),4*MAX);if(!same(value.stamp.identity,lock.identity)||value.stamp.hash!==targets[label].hash)throw fail('recovered index differs');expected[label].index=value.stamp;await stateCheck();await point('git-recovery-'+label+'-index-published',{index:{path:join(state.r.gitDir,'index'),...value.stamp}});}
    await publishHead('source',targets.source.head,'git-recovery-source-head');await publishHead('destination',targets.destination.head,'git-recovery-destination-head');await stateCheck();
    await run(s.r,['fsck','--full','--no-references','--no-reflogs','--no-dangling',...NAMES.map(n=>c.recovery.refs[n].commit)]);await stateCheck();await point('git-recovery-'+(finish?'finished':'restored'));
  }catch(e){error=e;}
  finally{
    for(const lock of owned)if(lock.file){try{await lock.file.close();}catch(e){error??=e;}lock.file=null;}
    let authorized=!cancelled&&error?.code!=='CANCELLED';try{alive();}catch{authorized=false;}
    if(authorized&&!runner.child&&!inspector.runner?.child)for(const lock of owned)if(lock.path)try{await inspector.verifyRepository(s.r);await inspector.verifyRepository(d.r);await read(lock.path,4*MAX,lock.stamp);await unlink(lock.path);await sync(dirname(lock.path));lock.path=null;}catch(e){error??=e;}
  }
  if(error){error.handoffGitRecovery={phase,pack,retiredLocks,retainedLocks:owned.filter(lock=>lock.path).map(lock=>({path:lock.path,...lock.stamp,owner:'application',kind:lock.kind}))};throw error;}
  const final=await reviewHandoffGitRecovery(plan,{runner,inspector,check:alive,locks:[...journal.values()]});result={id:plan.id,state:finish?'finished':'restored',states:final.states,refs:final.refs,peers:final.peers,locks:final.locks,pack,native,retiredLocks,...(finish?{originalRefs:review.refs.filter(([ref])=>!Object.values(recoveryRefs).includes(ref)),recoveryRefs}:{})};await verifyHandoffGitRecovery(plan,result,{runner,inspector,check:alive});return result;
}

// Fresh read-only proof for the manager's final barrier after engine/chat relocation.
export async function verifyHandoffGitPublication(plan,receipt,{runner,inspector,check}){
  const alive=()=>{check();if(runner.blocked||inspector.runner?.blocked)throw fail('process exit unconfirmed');},read=(path,max,stamp)=>bounded(path,max,alive,stamp),{source:s,destination:d}=plan.states,c=plan.candidate;
  const run=async(state,args)=>{alive();const out=await runner.run(['--git-dir='+state.r.gitDir,'--literal-pathspecs',...args],{scope:{},env:{GIT_ALTERNATE_OBJECT_DIRECTORIES:''},check:alive});alive();return out;};
  if(!UUID.test(plan.id)||!Array.isArray(receipt.originalRefs)||receipt.originalRefs.length>10000||!equal(Object.keys(receipt.recoveryRefs).sort(),[...NAMES].sort()))throw fail('invalid publication receipt');
  if(plan.gitBaseline){baselineShape(plan.gitBaseline);const original=new Map(receipt.originalRefs);for(const [ref,value] of plan.gitBaseline.originalRefs)if(!equal(original.get(ref),value))throw fail('publication original ref differs from persisted baseline');}
  const expected=new Map(receipt.originalRefs);for(const name of NAMES){const ref='refs/saleh/handoff/'+plan.id+'/'+name;if(receipt.recoveryRefs[name]!==ref||expected.has(ref))throw fail('invalid retained recovery ref');expected.set(ref,[c.recovery.refs[name].commit,'']);}
  for(const [state,raw,hash] of [[s,c.branch.sourceAfter,c.recovery.sourceCleanupIndex.hash],[d,c.branch.destinationAfter,c.recovery.index.hash]]){
    await inspector.verifyRepository(state.r);alive();if((await read(join(state.r.gitDir,'HEAD'),8192)).data.toString('utf8')!==raw||(await read(join(state.r.gitDir,'index'),4*MAX)).stamp.hash!==hash)throw fail('published HEAD or index changed');
    for(const file of state.configFiles){const value=await read(file.path,MAX);if(!same(value.stamp.identity,file.id)||value.stamp.hash!==file.hash)throw fail('configuration file changed');}
    if((await run(state,['config','--includes','--null','--show-origin','--list'])).stdout!==state.config)throw fail('Git configuration changed');
  }
  if(!equal(sorted(refRows((await run(s,['for-each-ref','--count=10001','--format=%(refname)%00%(objectname)%00%(symref)'])).stdout)),sorted(expected)))throw fail('published ref inventory changed');
  if(!OID.test(receipt.pack.oid)||receipt.pack.keepPath!==join(s.r.commonDir,'objects/pack/pack-'+receipt.pack.oid+'.keep'))throw fail('invalid GC keep receipt');await read(receipt.pack.keepPath,8192,receipt.pack.stamp);
  // The exact ref inventory is checked above. refs verify misclassifies held branch .lock files.
  await run(s,['fsck','--full','--no-references','--no-reflogs','--no-dangling',...NAMES.map(n=>c.recovery.refs[n].commit)]);
  const peers=await inspector.peerInventory(s.r,inspector.epoch);alive();if(!equal(peersView(peers.records,s,d,false,false),peersView(plan.peers.records,s,d,true,true)))throw fail('published peer inventory changed');
  // Recheck mutable HEAD/index bytes after the longer object traversal.
  for(const [state,raw,hash] of [[s,c.branch.sourceAfter,c.recovery.sourceCleanupIndex.hash],[d,c.branch.destinationAfter,c.recovery.index.hash]]){await inspector.verifyRepository(state.r);if((await read(join(state.r.gitDir,'HEAD'),8192)).data.toString('utf8')!==raw||(await read(join(state.r.gitDir,'index'),4*MAX)).stamp.hash!==hash)throw fail('published state changed during verification');}
  alive();return {verified:true,peers};
}

// Caller retains the complete peer lease, durable journal, native captures and Stop authority.
// No rollback: recovery refs, GC keep, private artifacts and ambiguous locks remain inspectable.
export async function publishHandoffGit(plan,{runner,inspector,check,checkpoint,publishFiles}){
  if(!UUID.test(plan?.id)||!isAbsolute(plan.directory)||resolve(plan.directory)!==plan.directory||![check,checkpoint,publishFiles].every(f=>typeof f==='function')||!runner?.run||!inspector?.verifyRepository)throw fail('invalid publication authority');
  const {source:s,destination:d}=plan.states??{},c=plan.candidate;if(!s?.r||!d?.r||s.r.cwd===d.r.cwd||s.r.commonDir!==d.r.commonDir||!same(s.r.identities.common,d.r.identities.common)||!c?.recovery||!equal(Object.keys(c.recovery.refs).sort(),[...NAMES].sort()))throw fail('invalid prepared checkout pair or recovery');
  for(const state of [s,d])if(!OID.test(state.head)||!Buffer.isBuffer(state.index))throw fail('committed captured state required');
  for(const row of Object.values(c.recovery.refs))if(!OID.test(row.commit)||!OID.test(row.tree))throw fail('invalid recovery object');
  const env={GIT_ALTERNATE_OBJECT_DIRECTORIES:'',GIT_COMMITTER_NAME:'Saleh handoff',GIT_COMMITTER_EMAIL:'handoff@localhost'},locks=[],recoveryRefs=Object.fromEntries(NAMES.map(name=>[name,'refs/saleh/handoff/'+plan.id+'/'+name]));
  let phase='checking',pack,native,result,error,refs,retained=false,sourceDetached=false,destinationChanged=false,cancelled=false;
  const indexHashes={source:sha(s.index),destination:sha(d.index)};
  const alive=()=>{check();if(runner.blocked||inspector.runner?.blocked)throw fail('process exit unconfirmed');};
  const point=async(name,details={})=>{alive();phase=name;await checkpoint(name,details);alive();};
  async function directory(path,expected,privateRoot=false){alive();const st=await lstat(path,{bigint:true});if(!st.isDirectory()||st.isSymbolicLink()||await realpath(path)!==path||expected&&!same(id(st),expected)||privateRoot&&(st.uid!==BigInt(process.getuid())||(st.mode&0o077n)))throw fail('directory identity or permissions changed: '+path);alive();return id(st);}
  const read=(path,max,expected)=>bounded(path,max,alive,expected);
  const sync=async path=>{const f=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await f.sync();}finally{await f.close();}};
  const run=async(r,args,options={})=>{alive();const out=await runner.run(['--git-dir='+r.gitDir,'--literal-pathspecs',...args],{...options,env:{...env,...options.env},check:alive,onUnavailable:()=>{if(runner.child?.cancelled)cancelled=true;options.onUnavailable?.();}});alive();return out;};
  const mutation=['-c','core.fsync=all','-c','core.fsyncMethod=fsync'];
  async function artifactChecks(){
    for(const [key,path,max] of [['bundle',c.artifacts.bundle,512*MAX],['sourceHead',c.artifacts.sourceOriginalHead,8192],['destinationHead',c.artifacts.destinationOriginalHead,8192],['sourceIndex',c.artifacts.sourceOriginalIndex,4*MAX],['destinationIndex',c.artifacts.destinationOriginalIndex,4*MAX],['index',c.artifacts.index,4*MAX],['sourceCleanupIndex',c.artifacts.sourceCleanupIndex,4*MAX]])await read(path,max,c.recovery[key]);
    if(c.recovery.sourceIndex.hash!==sha(s.index)||c.recovery.destinationIndex.hash!==sha(d.index)||c.recovery.sourceHead.hash!==sha(s.headRaw)||c.recovery.destinationHead.hash!==sha(d.headRaw))throw fail('captured state differs from recovery');
  }
  async function refMap(){return refRows((await run(s.r,['for-each-ref','--count=10001','--format=%(refname)%00%(objectname)%00%(symref)'])).stdout);}
  async function verifyRefs(){const expected=new Map(refs);if(retained)for(const name of NAMES)expected.set(recoveryRefs[name],[c.recovery.refs[name].commit,'']);if(!equal(sorted(await refMap()),sorted(expected)))throw fail('ref inventory changed');}
  async function lockCheck(){for(const lock of locks)if(lock.path){const st=await lstat(lock.path,{bigint:true});if(!st.isFile()||st.nlink!==1n||!same(id(st),lock.identity))throw fail('owned lock identity or links changed');}}
  async function diskState(bound=alive){
    bound();for(const [label,state,raw] of [['source',s,sourceDetached?c.branch.sourceAfter:s.headRaw],['destination',d,destinationChanged?c.branch.destinationAfter:d.headRaw]]){
      await inspector.verifyRepository(state.r);bound();if((await read(join(state.r.gitDir,'HEAD'),8192)).data.toString('utf8')!==raw||(await read(join(state.r.gitDir,'index'),4*MAX)).stamp.hash!==indexHashes[label])throw fail('HEAD or index changed: '+label);
      for(const file of state.configFiles){if(!same((await read(file.path,MAX)).stamp.identity,file.id)||(await read(file.path,MAX)).stamp.hash!==file.hash)throw fail('configuration file changed');bound();}
    }await lockCheck();bound();
  }
  const peerView=(records,expected=false)=>peersView(records,s,d,expected&&sourceDetached,expected&&destinationChanged);
  async function stateCheck(){await diskState();for(const state of [s,d])if((await run(state.r,['config','--includes','--null','--show-origin','--list'])).stdout!==state.config)throw fail('Git configuration changed');await verifyRefs();const peers=await inspector.peerInventory(s.r,inspector.epoch);alive();if(!equal(peerView(peers.records),peerView(plan.peers.records,true)))throw fail('peer inventory changed');return peers;}
  async function parents(path,root,create=false){const pending=[];for(let p=dirname(path);p!==root;p=dirname(p)){if(p==='/'||!p.startsWith(root+'/'))throw fail('ref path escapes repository');pending.unshift(p);}for(const p of pending){if(create)await mkdir(p,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(p);}}
  async function acquire(path,root){await parents(path,root,true);alive();const file=await open(path,'wx',0o600),identity=id(await file.stat({bigint:true}));const lock={path,originalPath:path,identity,file};locks.push(lock);await file.sync();await sync(dirname(path));await point('git-lock-acquired',{lock:{path,identity,owner:'application',kind:path.endsWith('/index.lock')?'index':'branch',hash:sha(Buffer.alloc(0)),bytes:0}});return lock;}
  async function transaction(state,commands,refNames=[],headRaw){
    let parent,work;const bound=()=>{alive();if(!parent||runner.child!==parent||parent.cancelled||parent.exited||parent.unavailable)throw fail('prepared transaction authority ended');};
    try{await run(state.r,[...mutation,'update-ref','--stdin'],{input:'start\n'+commands+'prepare\n',scope:inspector.refScope(state.r,refNames),prepared:()=>{parent=runner.child;work=(async()=>{await diskState(bound);const intended=refNames.length?refNames.map(ref=>[join(state.r.commonDir,ref+'.lock'),c.recovery.refs[NAMES.find(name=>recoveryRefs[name]===ref)].commit+'\n']):[[join(state.r.gitDir,'HEAD.lock'),headRaw]],prepared=await capturePreparedLocks(intended,bound);for(const {path,stamp} of prepared){await point('git-ref-lock-prepared',{lock:{path,...stamp,owner:'git',kind:refNames.length?'ref':'head'}});bound();}await diskState(bound);await verifyPreparedLocks(prepared,bound);})();return work;}});await sync(state.r.gitDir);}finally{await work?.catch(()=>{});}
  }
  try{
    alive();await directory(plan.directory,plan.recovery?.directory,true);await directory(c.artifacts.verifiedRepository,c.recovery.verifiedRepository,true);await artifactChecks();
    if(c.branch.sourceAfter!==s.head+'\n'||c.branch.destinationAfter!==(s.refBranch?'ref: refs/heads/'+s.refBranch+'\n':s.head+'\n'))throw fail('candidate HEAD semantics differ');
    refs=await refMap();for(const state of [s,d]){if(state.refBranch&&!equal(refs.get('refs/heads/'+state.refBranch),[state.head,'']))throw fail('current branch is not an ordinary reviewed ref');const current=await inspector.readState(state.r,inspector.epoch,{omitUntracked:(plan.temporary??[]).filter(t=>t.cwd===state.r.cwd).map(t=>t.path.slice(t.cwd.length+1))});alive();if(current.fingerprint!==state.fingerprint)throw fail('captured Git state is stale');}
    if(plan.gitBaseline){baselineShape(plan.gitBaseline);if(!equal(sorted(refs),plan.gitBaseline.originalRefs))throw fail('original ref baseline changed');for(const label of ['source','destination'])for(const key of ['head','refBranch','config','configFiles','fingerprint'])if(!equal(plan.states[label][key],plan.gitBaseline.states[label][key]))throw fail('state differs from persisted baseline');}
    await stateCheck();for(const ref of Object.values(recoveryRefs))if(refs.has(ref))throw fail('recovery ref already exists');await point('git-baseline-verified',{baseline:plan.gitBaseline??baselineShape({version:1,originalRefs:sorted(refs),states:Object.fromEntries(Object.entries(plan.states).map(([label,state])=>[label,Object.fromEntries(['head','refBranch','config','configFiles','fingerprint'].map(key=>[key,state[key]]))]))})});
    // Rebuild from the stamped bundle: the reusable verified directory's inode alone does not bind its pack bytes.
    const privateRepo=join(plan.directory,'publication.git');await mkdir(privateRepo,{mode:0o700});await runner.run(['init','--bare',privateRepo],{scope:{dirs:[privateRepo]},env,check:alive});const privateState={gitDir:privateRepo};
    await run(privateState,['bundle','verify',c.artifacts.bundle]);await run(privateState,['bundle','unbundle',c.artifacts.bundle],{scope:{dirs:[privateRepo]}});await read(c.artifacts.bundle,512*MAX,c.recovery.bundle);
    await run(privateState,['fsck','--full','--no-reflogs',...NAMES.map(n=>c.recovery.refs[n].commit)]);
    const expected=NAMES.flatMap(n=>[c.recovery.refs[n].commit,c.recovery.refs[n].tree]),actual=(await run(privateState,['rev-parse',...NAMES.flatMap(n=>[c.recovery.refs[n].commit,c.recovery.refs[n].commit+'^{tree}'])])).stdout.trim().split('\n');if(!equal(actual,expected))throw fail('independent objects differ');
    const packs=(await readdir(join(privateRepo,'objects/pack'))).filter(n=>/^pack-[a-f0-9]{40}\.pack$/.test(n));if(packs.length!==1)throw fail('expected one independent recovery pack');const packPath=join(privateRepo,'objects/pack',packs[0]),packReview=(await read(packPath,512*MAX)).stamp;
    const objects=join(s.r.commonDir,'objects');await directory(objects);
    await point('git-objects-importing',{path:packPath,stamp:packReview});await stateCheck();const packed=await read(packPath,512*MAX,packReview);await mkdir(join(objects,'pack')).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(join(objects,'pack'));
    const imported=(await run(s.r,[...mutation,'index-pack','--stdin','--strict','--keep=Saleh handoff '+plan.id],{input:packed.data,scope:{dirs:[objects]}})).stdout.trim(),match=/^(?:keep|pack)\t([a-f0-9]{40})$/.exec(imported);if(!match||packs[0]!=='pack-'+match[1]+'.pack')throw fail('imported pack identity differs');
    pack={oid:match[1],keepPath:join(objects,'pack','pack-'+match[1]+'.keep')};pack.stamp=(await read(pack.keepPath,8192)).stamp;const keep=await open(pack.keepPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{await keep.sync();}finally{await keep.close();}await sync(join(objects,'pack'));await sync(objects);await point('git-objects-imported',{pack});
    const loaded=(await run(s.r,['rev-parse',...NAMES.flatMap(n=>[c.recovery.refs[n].commit,c.recovery.refs[n].commit+'^{tree}'])])).stdout.trim().split('\n');if(!equal(loaded,expected))throw fail('imported object references differ');
    for(const ref of Object.values(recoveryRefs)){let path=dirname(join(s.r.commonDir,ref));while(path!==s.r.commonDir){try{await directory(path);}catch(e){if(e.code!=='ENOENT')throw e;}path=dirname(path);}}
    await point('git-recovery-refs-creating',{refs:recoveryRefs});await stateCheck();await transaction(s,NAMES.map(n=>`create ${recoveryRefs[n]} ${c.recovery.refs[n].commit}\n`).join(''),Object.values(recoveryRefs));retained=true;for(let path=dirname(join(s.r.commonDir,recoveryRefs.sourceHead));;path=dirname(path)){await sync(path);if(path===s.r.commonDir)break;}await verifyRefs();await point('git-recovery-refs-created',{refs:recoveryRefs});
    await point('git-locking');const indexLocks={};for(const [label,state] of [['source',s],['destination',d]].sort((a,b)=>a[1].r.gitDir<b[1].r.gitDir?-1:1))indexLocks[label]=await acquire(join(state.r.gitDir,'index.lock'),state.r.gitDir);
    for(const ref of [...new Set([s,d].filter(x=>x.refBranch).map(x=>'refs/heads/'+x.refBranch))].sort())await acquire(join(s.r.commonDir,ref+'.lock'),s.r.commonDir);
    await stateCheck();for(const [label,path,key] of [['source',c.artifacts.sourceCleanupIndex,'sourceCleanupIndex'],['destination',c.artifacts.index,'index']]){await indexLocks[label].file.writeFile((await read(path,4*MAX,c.recovery[key])).data);await indexLocks[label].file.sync();}await point('git-locked',{locks:await Promise.all(locks.map(async lock=>({path:lock.path,...(await read(lock.path,4*MAX)).stamp,owner:'application',kind:lock.path.endsWith('/index.lock')?'index':'branch'})))});
    await point('git-source-head-publishing');await stateCheck();if(s.headRaw!==c.branch.sourceAfter)await transaction(s,`option no-deref\nupdate HEAD ${s.head} ${s.head}\n`,[],c.branch.sourceAfter);sourceDetached=true;await stateCheck();await point('git-source-head-published');
    await point('git-files-publishing');await stateCheck();native=await publishFiles();alive();await stateCheck();await point('git-files-published');
    for(const [label,state,key] of [['destination',d,'index'],['source',s,'sourceCleanupIndex']]){
      await point('git-'+label+'-index-publishing');await stateCheck();const lock=indexLocks[label];if((await read(lock.path,4*MAX)).stamp.hash!==c.recovery[key].hash)throw fail('candidate index lock bytes changed');await lock.file.close();lock.file=null;await lockCheck();alive();await rename(lock.path,join(state.r.gitDir,'index'));lock.path=null;await sync(state.r.gitDir);const stamp=(await read(join(state.r.gitDir,'index'),4*MAX)).stamp;if(!same(stamp.identity,lock.identity))throw fail('published index identity differs');indexHashes[label]=c.recovery[key].hash;await stateCheck();await point('git-'+label+'-index-published',{index:{path:join(state.r.gitDir,'index'),...stamp}});
    }
    await point('git-destination-head-publishing');await stateCheck();const command=s.refBranch?`option no-deref\nsymref-update HEAD refs/heads/${s.refBranch} ${d.refBranch?'ref refs/heads/'+d.refBranch:'oid '+d.head}\n`:`option no-deref\nupdate HEAD ${s.head} ${d.head}\n`;
    if(d.headRaw!==c.branch.destinationAfter)await transaction(d,command,[],c.branch.destinationAfter);destinationChanged=true;await stateCheck();await point('git-destination-head-published');await artifactChecks();
    result={sourceHead:{raw:c.branch.sourceAfter,oid:s.head},destinationHead:{raw:c.branch.destinationAfter,oid:s.head},sourceIndex:{hash:indexHashes.source,tree:c.sourceCleanup.index},destinationIndex:{hash:indexHashes.destination,tree:c.index},originalRefs:sorted(refs),recoveryRefs,pack,native};result.peers=(await verifyHandoffGitPublication(plan,result,{runner,inspector,check:alive})).peers;await point('git-verified',{sourceHead:result.sourceHead,destinationHead:result.destinationHead,sourceIndex:result.sourceIndex,destinationIndex:result.destinationIndex});
  }catch(e){error=e;}
  finally{
    for(const lock of locks)if(lock.file){try{await lock.file.close();}catch(e){error??=e;}lock.file=null;}
    let authorized=!cancelled&&error?.code!=='CANCELLED';try{alive();}catch{authorized=false;}
    if(authorized&&!runner.child&&!inspector.runner?.child){for(const lock of locks)if(lock.path){try{await inspector.verifyRepository(s.r);await inspector.verifyRepository(d.r);const st=await lstat(lock.path,{bigint:true});if(!st.isFile()||!same(id(st),lock.identity))throw fail('owned lock replaced; preserved');await unlink(lock.path);await sync(dirname(lock.path));lock.path=null;}catch(e){error??=e;}}}
  }
  if(error){error.handoffGit={phase,pack,recoveryRefs,recoveryRefsConfirmed:retained,retainedLocks:locks.filter(x=>x.path).map(x=>({path:x.path,identity:x.identity}))};throw error;}return result;
}
