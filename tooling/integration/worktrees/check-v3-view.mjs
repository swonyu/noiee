// Generated identities and data only. Real signed-map verifier/WeakSet is used;
// its existing readOwner/readIdentity injection points replace native reads.
import assert from 'node:assert/strict';
import {mkdir,lstat,readFile,writeFile,readdir,chmod,cp,symlink,link,unlink,rename} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import fsPromises from 'node:fs/promises';
import childProcess from 'node:child_process';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
const base=process.env.NOIEE_WORKTREE_FIXTURE_ROOT;
if(!base||!base.startsWith(join(homedir(),'Library/Caches/NoieeWorktreeChecks-'))||dirname(base)!==join(homedir(),'Library/Caches'))throw Error('Fresh isolated Noiee worktree fixture root required');
const baseline='/Users/saleh/Library/Caches/SalehTransport171/model-http-ojbszvb2/source';
const selected=process.argv.includes('--red')?baseline:process.env.NOIEE_WORKTREE_SOURCE;
if(!selected||!selected.startsWith('/'))throw Error('Explicit selected source is required');
const effects={subprocess:0,network:0,fetch:0,git:0,nativeHelper:0,originalStore:0};
const protectedPaths=['/Users/saleh/Applications/','/Users/saleh/Library/Application Support/Qwen Local/','/Users/saleh/Library/WebKit/','/Users/saleh/Library/HTTPStorages/','/Users/saleh/Library/Preferences/'];
for(const name of ['open','lstat','stat','readFile','writeFile','readdir','mkdir','realpath','readlink','rmdir','unlink','rename','symlink','link','copyFile','cp']){
  const original=fsPromises[name];fsPromises[name]=(...args)=>{
    for(const value of args.slice(0,['rename','symlink','link','copyFile','cp'].includes(name)?2:1)){
      const path=value instanceof URL?fileURLToPath(value):typeof value==='string'?value:null;
      if(path&&protectedPaths.some(root=>path.startsWith(root))){effects.originalStore++;throw Error('Original store/app filesystem action forbidden: '+name);}
    }
    return original(...args);
  };
}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=()=>{effects.subprocess++;throw Error('Generated fixture forbids child process');};
net.Socket.prototype.connect=function(){effects.network++;throw Error('Generated fixture forbids network');};
syncBuiltinESMExports();globalThis.fetch=async()=>{effects.fetch++;throw Error('Generated fixture forbids fetch');};
assert.equal(readFile,fsPromises.readFile);assert.equal(lstat,fsPromises.lstat);
const hash=b=>createHash('sha256').update(b).digest('hex');
const priorBoot='11111111-1111-4111-8111-111111111111',currentBoot='22222222-2222-4222-8222-222222222222',volume='33333333-3333-4333-8333-333333333333';
const raw=async path=>{const s=await lstat(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino)};};
const fsIdentity=async({path,signal}={})=>{signal?.throwIfAborted();return {volumeUUID:volume,ino:String((await lstat(path,{bigint:true})).ino)};};
const stamp=async path=>({identity:await raw(path),hash:hash(await readFile(path)),bytes:Number((await lstat(path)).size)});
const privateWrite=async(path,data,mode=0o600)=>{await writeFile(path,typeof data==='string'?data:JSON.stringify(data),{mode});await chmod(path,mode);};
const results=[];
async function fixture({archive=false,version=1,mutateLedger,mutateMap,mutateFiles}={}){
  const directory=join(base,'generated-'+randomUUID());await mkdir(directory,{mode:0o700});
  const dataDir=join(directory,'Coding'),root=join(dataDir,'Worktrees'),project=join(directory,'retained-project'),common=join(project,'.git');
  const id=randomUUID(),cwd=join(root,id),admin=join(common,'worktrees',id);
  for(const path of [dataDir,root,project,common,join(common,'worktrees'),cwd,admin])await mkdir(path,{mode:0o700});
  await privateWrite(join(project,'fixture.txt'),'original generated content\n');await privateWrite(join(cwd,'.git'),'gitdir: '+admin+'\n');await privateWrite(join(cwd,'fixture.txt'),'ordinary checkout file\n');
  for(const [name,value] of [['gitdir',join(cwd,'.git')+'\n'],['commondir','../..\n'],['locked','Saleh managed worktree '+id+'\n']])await privateWrite(join(admin,name),value,0o644);
  const rootNow=await raw(root),oldDev=String(BigInt(rootNow.dev)+100n),historical=async path=>({...await raw(path),dev:oldDev});
  const record={id,source:project,cwd,commonDir:common,gitDir:common,admin,commit:'a'.repeat(40),createdAt:1,state:'ready',message:'Generated ready record',identities:{}};
  for(const [key,path] of [['source',project],['common',common],['sourceGit',common],['cwd',cwd],['admin',admin],['gitfile',join(cwd,'.git')]])record.identities[key]=await historical(path);
  let archivePaths;
  if(archive){
    const aid=randomUUID(),parent=join(root,'.archives'),directory=join(parent,aid);await mkdir(parent,{mode:0o700});await mkdir(directory,{mode:0o700});
    archivePaths={parent,directory,index:join(directory,'original-index'),manifest:join(directory,'manifest.json'),bundle:join(directory,'recovery.bundle')};
    record.archive={id:aid,head:'b'.repeat(40),phase:'restored',parent:await historical(parent),directory:await historical(directory)};
    for(const key of ['index','manifest','bundle']){await privateWrite(archivePaths[key],'generated '+key+'\n');record.archive[key]={...await stamp(archivePaths[key]),identity:await historical(archivePaths[key])};}
  }
  const ledger={version,root:{...rootNow,dev:oldDev},records:[record],...(version===2?{handoffs:[]}: {})};
  let handoffDirectory;
  if(version===2){
    const hid=randomUUID(),parent=join(root,'.handoffs');await mkdir(parent,{mode:0o700});handoffDirectory=join(parent,hid);await mkdir(handoffDirectory,{mode:0o700});
    ledger.handoffs.push({id:hid,worktreeId:id,rootThreadId:'generated-root',source:project,destination:cwd,paths:[{path:project,identity:record.identities.source},{path:cwd,identity:record.identities.cwd}],phase:'recovery-ready',state:'needs-inspection',message:'generated',createdAt:1,updatedAt:1,recovery:null});
  }
  if(mutateLedger)await mutateLedger({ledger,record,root,rootNow,project,cwd,admin,common,dataDir,archivePaths});
  const ledgerPath=join(dataDir,'managed-worktrees.json');await privateWrite(ledgerPath,ledger);const ledgerBytes=await readFile(ledgerPath);
  const rows=new Map(),namespaces=[];
  const add=async(path,historicalIdentity=null)=>{
    if(rows.has(path)){if(historicalIdentity)assert.deepEqual(rows.get(path).historicalIdentity,historicalIdentity);return;}
    const s=await lstat(path);rows.set(path,{path,historicalIdentity,identity:await fsIdentity({path}),mode:s.mode,uid:s.uid,type:s.isFile()?'file':'directory',...(s.isFile()?{sha256:hash(await readFile(path)),bytes:s.size}:{})});
  };
  await add(dataDir);await add(root,ledger.root);await add(ledgerPath);
  for(const [key,path] of [['source',project],['common',common],['sourceGit',common],['cwd',cwd],['admin',admin],['gitfile',join(cwd,'.git')]])await add(path,record.identities[key]);
  for(const name of ['gitdir','commondir','locked'])await add(join(admin,name));
  if(archivePaths){for(const key of ['parent','directory','index','manifest','bundle'])await add(archivePaths[key],['parent','directory'].includes(key)?record.archive[key]:record.archive[key].identity);}
  if(handoffDirectory){await add(dirname(handoffDirectory));await add(handoffDirectory);}
  for(const row of rows.values())if(row.type==='directory'&&row.path!==dataDir&&row.path!==project&&row.path!==cwd)namespaces.push({path:row.path,names:(await readdir(row.path)).sort()});
  const dataDirectory={path:dataDir,...await fsIdentity({path:dataDir}),uid:process.getuid()};
  const doc={version:1,kind:'reviewed-current-worktree-handoff-admission',historicalContinuity:false,captureBootSession:priorBoot,dataDirectory,evidence:Object.fromEntries(['prebootCheckpointSHA256','closedCheckpointSHA256','observationSHA256','reviewSHA256'].map(key=>[key,hash('generated-'+key)])),rows:[...rows.values()],namespaces};
  if(mutateMap)await mutateMap({doc,ledger,record,dataDir,root,project,cwd,common,admin,ledgerPath,archivePaths});
  const resources=join(directory,'resources');await cp(selected,resources,{recursive:true,dereference:false});
  const mapPath=join(resources,'worktree-handoff-adoption.json');await chmod(mapPath,0o600);await privateWrite(mapPath,doc,0o400);
  const legacyPath=join(resources,'legacy-admission.mjs'),legacy=await readFile(legacyPath,'utf8'),pattern=/WORKTREE_HANDOFF_ADOPTION_SHA256=(?:null|"[a-f0-9]{64}")/g;
  assert.equal([...legacy.matchAll(pattern)].length,1);await privateWrite(legacyPath,legacy.replace(pattern,'WORKTREE_HANDOFF_ADOPTION_SHA256='+JSON.stringify(hash(await readFile(mapPath)))),0o644);
  await privateWrite(join(resources,'owned-runtime.json'),'{}',0o444);
  const nativeHelper=join(resources,'legacy-boot-helper');await privateWrite(nativeHelper,'Generated helper bytes; never executed.\n',0o555);
  const original={version:1,kind:'legacy-history-admission',dataDirectory:{path:dataDir,dev:oldDev,ino:dataDirectory.ino,uid:process.getuid()},bootSession:priorBoot,oldApplication:{path:join(resources,'Old.app'),payloadSha256:hash('old')},successorSha256:hash('old-successor')};
  const originalPath=join(directory,'original.json');await privateWrite(originalPath,original,0o400);
  const files=[];for(const name of (await readdir(resources)).sort())if(name!=='legacy-boot-helper'&&(await lstat(join(resources,name))).isFile())files.push({path:name,sha256:hash(await readFile(join(resources,name)))});
  const successor={files,nativeHelper:{path:nativeHelper,sha256:hash(await readFile(nativeHelper))}};
  const admission={version:2,kind:'legacy-history-postboot-rebind',dataDirectory,bootSession:priorBoot,oldApplication:original.oldApplication,successorSha256:hash(JSON.stringify(successor)),originalIntent:{path:originalPath,sha256:hash(await readFile(originalPath))},adoptionBootSession:currentBoot,evidence:{prebootBaselineSHA256:hash('pre'),postbootSnapshotSHA256:hash('post'),adoptionAuditSHA256:hash('audit')}};
  const admissionPath=join(directory,'admission.json');await privateWrite(admissionPath,admission,0o400);
  const intent={version:3,kind:'legacy-history-successor-update',dataDirectory,bootSession:priorBoot,oldApplication:original.oldApplication,successorSha256:hash(JSON.stringify(successor)),admissionIntent:{path:admissionPath,sha256:hash(await readFile(admissionPath))},predecessorIntentSha256:hash('predecessor')};
  const intentPath=join(directory,'intent.json');await privateWrite(intentPath,intent,0o400);await privateWrite(join(resources,'legacy-admission.json'),{version:1,intent:{path:intentPath,sha256:hash(await readFile(intentPath))},successor},0o400);
  const {createLegacyAdmission}=await import(pathToFileURL(legacyPath)),{ManagedWorktrees}=await import(pathToFileURL(join(resources,'managed-worktrees.mjs')));
  const owner={version:1,bootSession:currentBoot,pid:process.pid,pgid:process.pid,uid:process.getuid(),startSec:'1',startUsec:0};
  const legacyAdmission=createLegacyAdmission({resources,readOwner:async()=>({version:1,bootSession:currentBoot,owner}),readIdentity:fsIdentity});
  const fresh=(trusted=legacyAdmission)=>{
    const m=new ManagedWorktrees({dataDir,nativeHelper,legacyAdmission:trusted,managedMutationBlocked:true,readIdentities:async({paths,signal})=>Promise.all(paths.map(path=>fsIdentity({path,signal})))});
    m.runner.verify=async()=>{};m.runner.run=async()=>{effects.git++;throw Error('No Git permitted');};
    m.handoffProcess=async operation=>{if(operation==='boot')return {version:1,bootSession:currentBoot};effects.nativeHelper++;throw Error('No native helper permitted');};return m;
  };
  if(mutateFiles)await mutateFiles({mapPath,legacyPath,intentPath,admissionPath,originalPath,ledgerPath,root,project,cwd,admin,common,dataDir,archivePaths});
  return {directory,dataDir,resources,root,project,cwd,admin,common,ledger,record,ledgerPath,ledgerBytes,mapPath,intentPath,archivePaths,legacyAdmission,ManagedWorktrees,fresh,unchanged:async()=>assert.deepEqual(await readFile(ledgerPath),ledgerBytes)};
}
async function check(label,action){await action();results.push(label);}
const positive=async f=>{
  const m=f.fresh();try{const status=await m.inspectUnconfinedAccess();assert.equal(status.bootSession,currentBoot);assert.deepEqual(status.handoffs,[]);assert.equal(m.loaded,false);assert.deepEqual(m.records,[]);assert.deepEqual(m.handoffs,[]);await status.recheck();await m.assertUnconfinedAccess();await f.unchanged();return status;}finally{assert.equal((await m.close()).stopped,true);await f.unchanged();}
};
if(process.argv.includes('--red')){const f=await fixture();try{await positive(f);}catch(error){throw Error('RED: authenticated ready v1 view is omitted by frozen source: '+error.message,{cause:error});}throw Error('Expected frozen source RED');}

await check('exact authenticated ready-v1 read-only manager view',async()=>positive(await fixture()));
await check('complete restored archive remains authenticated',async()=>positive(await fixture({archive:true})));

await check('Git-produced0644 bundle remains authenticated inside private archive directories',async()=>positive(await fixture({archive:true,mutateLedger:({archivePaths})=>chmod(archivePaths.bundle,0o644)})));
for(const [key,mode] of [['bundle',0o664],['index',0o644],['manifest',0o644],['parent',0o755],['directory',0o755]])await check('restored archive '+key+' still refuses unsafe mode '+mode.toString(8),async()=>{const f=await fixture({archive:true,mutateLedger:({archivePaths})=>chmod(archivePaths[key],mode)}),m=f.fresh();try{await assert.rejects(m.assertUnconfinedAccess());assert.equal(m.loaded,false);await f.unchanged();}finally{await m.close();}});

await check('empty-regular-Git-lock-is-valid-per-verifyRecord',async()=>positive(await fixture({mutateLedger:({admin})=>writeFile(join(admin,'locked'),'')})));
const negatives=[
  ['missing legacy verifier',{noVerifier:true}],
  ['empty-ledger',{mutateLedger:({ledger})=>{ledger.records=[];}}],
  ...['source','common','sourceGit','cwd','admin','gitfile'].map(key=>['historical-'+key,{mutateMap:({doc,record})=>{const row=doc.rows.find(r=>r.historicalIdentity&&r.historicalIdentity.ino===record.identities[key].ino);row.historicalIdentity={...row.historicalIdentity,ino:'999999999'};}}]),
  ...['creating','archiving','archived','restoring','needs-inspection','missing'].map(state=>['non-ready-'+state,{mutateLedger:({record})=>record.state=state}]),
  ['ledger-extra-field',{mutateLedger:({ledger})=>ledger.authority='invented'}],
  ['identity-extra-field',{mutateLedger:({record})=>record.identities.authority={dev:'1',ino:'2'}}],
  ['missing-gitfile-row',{mutateMap:({doc,cwd})=>{doc.rows=doc.rows.filter(row=>row.path!==join(cwd,'.git'));}}],
  ['missing-control-row',{mutateMap:({doc,dataDir})=>{doc.rows=doc.rows.filter(row=>row.path!==dataDir);}}],
  ['wrong-volume',{mutateMap:({doc,project})=>doc.rows.find(row=>row.path===project).identity.volumeUUID=priorBoot}],
  ['wrong-row-owner',{mutateMap:({doc,project})=>doc.rows.find(row=>row.path===project).uid=process.getuid()+1}],
  ['missing-admin-control-namespace',{mutateMap:({doc,admin})=>{doc.namespaces=doc.namespaces.filter(row=>row.path!==admin);}}],
  ['namespace-extra-name',{mutateMap:({doc,root})=>doc.namespaces.find(row=>row.path===root).names.push('unobserved')}],
  ['forged-closure-evidence',{mutateMap:({doc})=>doc.evidence.closedCheckpointSHA256='not-a-digest'}],
  ['wrong-data-home',{mutateMap:({doc})=>doc.dataDirectory.ino='999999999'}],
  ['unchanged-old08a38-map-is-not-v1-proof',{mutateMap:async({doc})=>{const old=JSON.parse(await readFile(join(baseline,'worktree-handoff-adoption.json')));for(const key of Object.keys(doc))delete doc[key];Object.assign(doc,old);}}],
  ['root-inode-changed',{mutateLedger:({ledger})=>ledger.root.ino='999999999'}],
  ['pending-reconnect',{mutateFiles:({ledgerPath})=>privateWrite(ledgerPath+'.reconnect','{}')}],
  ['ledger-content-tamper',{mutateFiles:async({ledgerPath})=>writeFile(ledgerPath,Buffer.concat([await readFile(ledgerPath),Buffer.from(' ')]))}],
  ['map-content-tamper',{mutateFiles:async({mapPath})=>{await chmod(mapPath,0o600);await writeFile(mapPath,Buffer.concat([await readFile(mapPath),Buffer.from(' ')]));await chmod(mapPath,0o400);}}],
  ['unsafe-ledger-mode',{mutateFiles:({ledgerPath})=>chmod(ledgerPath,0o644)}],
  ['hardlinked-ledger',{mutateFiles:({ledgerPath})=>link(ledgerPath,ledgerPath+'.alias')}],
  ['symlink-ledger',{mutateFiles:async({ledgerPath})=>{await rename(ledgerPath,ledgerPath+'.original');await symlink(ledgerPath+'.original',ledgerPath);}}],
  ['unsafe-root-mode',{mutateFiles:({root})=>chmod(root,0o755)}],
  ['unsafe-data-home-mode',{mutateFiles:({dataDir})=>chmod(dataDir,0o755)}],
  ['unsafe-authenticated-ready-directory',{mutateMap:({doc,project})=>doc.rows.find(row=>row.path===project).mode=0o40777,mutateFiles:({project})=>chmod(project,0o777)}],
  ['archive-not-restored',{archive:true,mutateLedger:({record})=>record.archive.phase='captured'}],
  ['archive-missing-file-row',{archive:true,mutateMap:({doc,archivePaths})=>{doc.rows=doc.rows.filter(row=>row.path!==archivePaths.bundle);}}],
  ['archive-missing-namespace',{archive:true,mutateMap:({doc,archivePaths})=>{doc.namespaces=doc.namespaces.filter(row=>row.path!==archivePaths.directory);}}],
  ['archive-metadata-hash-drift',{archive:true,mutateLedger:({record})=>record.archive.bundle.hash='f'.repeat(64)}],
];
for(const [label,options] of negatives)await check(label,async()=>{const f=await fixture(options),m=f.fresh(options.noVerifier?null:f.legacyAdmission);try{await assert.rejects(m.assertUnconfinedAccess());assert.equal(m.loaded,false);assert.deepEqual(m.records,[]);}finally{await m.close();}});
await check('foreign verifier still refused',async()=>{const f=await fixture();assert.throws(()=>new f.ManagedWorktrees({dataDir:f.dataDir,legacyAdmission:{prepareWorktreeHandoff:async()=>({})}}),/trusted/);});
await check('managed lifecycle mutation authority remains absent',async()=>{const f=await fixture(),m=f.fresh();try{await m.assertUnconfinedAccess();await assert.rejects(m.load(),/identity changed/);for(const action of ['prepareReconnect','prepareArchive','prepareRestore'])await assert.rejects(m.handle({action,...(action==='prepareReconnect'?{}:{id:f.record.id})}),/Full Access/);for(const path of [f.project,f.cwd,f.dataDir])await assert.rejects(m.reserveCommand({cwd:path,fullAccess:true}));await f.unchanged();}finally{await m.close();}});
await check('proof recheck refuses changed namespace',async()=>{const f=await fixture(),m=f.fresh();try{const status=await m.inspectUnconfinedAccess();await privateWrite(join(f.root,'new.txt'),'generated');await assert.rejects(status.recheck(),/namespace|changed/);}finally{await m.close();}});
await check('retained canonical aliases and Git metadata stay fenced for commands',async()=>{
  const f=await fixture(),m=f.fresh(),alias=join(base,'project-alias-'+randomUUID());await symlink(f.project,alias);
  try{for(const path of [alias,f.admin,f.common,join(f.project,'..')])await assert.rejects(m.reserveCommand({cwd:path,fullAccess:true}));
    const ordinary=join(base,'ordinary-'+randomUUID());await mkdir(ordinary,{mode:0o700});
    m.handoffRepository=async(_cwd,_epoch,_admission,retain)=>{retain(async()=>{});return [{path:f.common}];};
    await assert.rejects(m.reserveCommand({cwd:ordinary,fullAccess:true}),/Retained|overlaps/);assert.equal(m.commandReservation,null);await f.unchanged();
  }finally{await m.close();await unlink(alias);}
});
await check('row identity race invalidates admission before dispatch',async()=>{const f=await fixture(),m=f.fresh();let changed=false;const identities=m.readIdentities;
  m.readIdentities=async args=>{const values=await identities(args);if(!changed){changed=true;await chmod(f.project,0o755);}return values;};
  try{await assert.rejects(m.assertUnconfinedAccess(),/changed/);assert.equal(m.loaded,false);await f.unchanged();}finally{await m.close();}
});
await check('Stop aborts and drains current read-only proof',async()=>{const f=await fixture(),m=f.fresh();try{const status=await m.inspectUnconfinedAccess();let entered,release;const arrived=new Promise(r=>entered=r),held=new Promise(r=>release=r);m.readIdentities=async({signal})=>{entered();await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});await held;signal.throwIfAborted();};const rejected=assert.rejects(status.recheck());await arrived;let stopped=false;const stopping=m.stop().then(value=>{stopped=true;return value;});await new Promise(r=>setImmediate(r));assert.equal(stopped,false);release();await rejected;assert.equal((await stopping).stopped,true);await assert.rejects(status.recheck());await f.unchanged();}finally{await m.close();}});
async function callRoute(handler,nativeSignature,input){
  const route='/api/tools/call',token='generated-token',bytes=Buffer.from(JSON.stringify(input)),nonce=randomUUID(),time=String(Date.now());
  const req=Readable.from([bytes]);req.method='POST';req.headers={'content-type':'application/json','x-qwen-nonce':nonce,'x-qwen-time':time,'x-qwen-permit':nativeSignature(token,route,nonce,time,bytes)};req.aborted=false;
  const res=new EventEmitter();res.destroyed=false;res.writableEnded=false;let response;await handler(req,res,route,(status,value)=>{response={status,value};res.writableEnded=true;});return response;
}
for(const denied of [false,true])await check(denied?'Coding writer guard still blocks Files dispatch':'Full Access Files effects retain configured authority',async()=>{
  const f=await fixture(),m=f.fresh();const {toolRoutes,nativeSignature}=await import(pathToFileURL(join(f.resources,'agent.mjs')));let dispatches=0;
  const coding={assertUnconfinedAccess:async()=>{if(denied)throw Error('Generated retained writer is unconfirmed.');},close:async()=>({stopped:true}),disposal:Promise.resolve(),terminals:new Map(),runs:new Map()};
  const hub={call:async(_server,_name,args)=>{dispatches++;await privateWrite(args.path,'Files wrote generated retained content\n');return {isError:false};},close:async()=>({stopped:true})};
  const handler=toolRoutes({instanceToken:'generated-token',coding,worktrees:m,hub,gitWorkflow:{close:async()=>({stopped:true})},schedules:{close:async()=>({stopped:true})},fullAccess:true,unconfinedBoot:true,upstream:'http://127.0.0.1:1234',localModels:{resolve:async()=>{throw Error('No model');}},fetchImpl:globalThis.fetch});
  try{const r=await callRoute(handler,nativeSignature,{server:'generated-configured-files',name:'write_file',arguments:{path:join(f.project,'fixture.txt')}});assert.equal(r.status,200);assert.equal(dispatches,denied?0:1);assert.equal(r.value.isError,denied);if(!denied){assert.match(await readFile(join(f.project,'fixture.txt'),'utf8'),/Files wrote/);await m.assertUnconfinedAccess();}await f.unchanged();}finally{assert.equal((await handler.close()).stopped,true);}
});
// V2 keeps its independent handoff process/owner checks. Resource-free journal
// adapters exercise those guards; no native writer/exit observation is claimed.
for(const wrong of [false,true])await check(wrong?'v2 missing writer proof still rejected':'v2 handoff admission guard remains active',async()=>{
  const f=await fixture({version:2}),m=f.fresh();const manifest={version:5,owner:{generated:true}};
  m.readHandoffRecovery=async()=>({manifest,fingerprint:'generated'});m.inspectHandoffProcesses=async()=>({bootSession:currentBoot,legacy:false,priorBootProcessesAbsent:!wrong,helpersQuiescent:true,managerQuiescence:'prior-boot'});m.handoffOwnerContext=()=>({owner:{generated:true}});
  try{if(wrong)await assert.rejects(m.assertUnconfinedAccess(),/prior-boot/);else{const status=await m.inspectUnconfinedAccess();assert.equal(status.handoffs.length,1);assert.equal(m.loaded,false);}await f.unchanged();}finally{await m.close();}
});

for(const target of ['project','cwd'])for(const operation of ['add','delete'])await check('ordinary-'+target+'-'+operation+'-preserves-proof',async()=>{
 const f=await fixture(),m=f.fresh();try{const status=await m.inspectUnconfinedAccess();const root=f[target],path=join(root,operation==='delete'?'fixture.txt':'ordinary.txt'),identity=await raw(root);if(operation==='add')await privateWrite(path,'new ordinary file');else await unlink(path);assert.deepEqual(await raw(root),identity);await status.recheck();await m.assertUnconfinedAccess();await f.unchanged();}finally{await m.close();}
});
await check('directory-nlink-and-time-changes-between-checks-remain-ordinary',async()=>{const f=await fixture(),m=f.fresh();try{const status=await m.inspectUnconfinedAccess();await mkdir(join(f.cwd,'ordinary-directory'),{mode:0o700});await status.recheck();await f.unchanged();}finally{await m.close();}});
await check('9MiB-bundle-streams-under-existing512MiB-role-without-readFile',async()=>{
 const f=await fixture({archive:true,mutateLedger:async({record,archivePaths})=>{await writeFile(archivePaths.bundle,Buffer.alloc(9*1024*1024,7));const found=await stamp(archivePaths.bundle);record.archive.bundle={...found,identity:{...found.identity,dev:record.identities.cwd.dev}};}}),m=f.fresh(),originalOpen=fsPromises.open;let wholeBundleReads=0;
 fsPromises.open=async(path,...args)=>{const file=await originalOpen(path,...args);if(String(path)===f.archivePaths.bundle)file.readFile=async()=>{wholeBundleReads++;throw Error('Whole bundle read forbidden');};return file;};syncBuiltinESMExports();
 try{await m.assertUnconfinedAccess();await m.assertUnconfinedAccess();assert.equal(wholeBundleReads,0);await f.unchanged();}finally{fsPromises.open=originalOpen;syncBuiltinESMExports();await m.close();}
});
for(const name of ['gitdir','commondir','locked'])await check('registration-'+name+'-tamper-denies',async()=>{const f=await fixture(),m=f.fresh();try{await m.assertUnconfinedAccess();await writeFile(join(f.admin,name),'tampered');await assert.rejects(m.assertUnconfinedAccess());await f.unchanged();}finally{await m.close();}});
await check('held-ledger-hash-must-authenticate-before-role-classification',async()=>{const f=await fixture(),m=f.fresh();let captured;try{await m.load();}catch(error){captured=error;}const symbol=Object.getOwnPropertySymbols(captured).find(s=>String(s).includes('legacy worktree'));captured[symbol].receipt.bytes=Buffer.from('unauthenticated');m.load=async()=>{throw captured;};try{await assert.rejects(m.assertUnconfinedAccess(),/Held legacy ledger/);}finally{await m.close();}});
await check('held-ledger-parsed-value-cannot-override-authenticated-bytes',async()=>{const f=await fixture(),m=f.fresh();let captured;try{await m.load();}catch(error){captured=error;}const symbol=Object.getOwnPropertySymbols(captured).find(s=>String(s).includes('legacy worktree'));captured[symbol].receipt.value={version:1,root:{dev:'1',ino:'2'},records:[]};m.load=async()=>{throw captured;};try{await m.assertUnconfinedAccess();await f.unchanged();}finally{await m.close();}});
await check('working-root-control-role-collision-fails-before-stat-policy',async()=>{const f=await fixture({mutateLedger:async({record,common})=>{record.source=common;record.identities.source={...record.identities.common};await privateWrite(join(common,'.git'),'gitdir: '+common+'\n',0o644);},mutateMap:async({doc,common})=>{const path=join(common,'.git'),s=await lstat(path);doc.rows.push({path,historicalIdentity:null,identity:await fsIdentity({path}),mode:s.mode,uid:s.uid,type:'file',sha256:hash(await readFile(path)),bytes:s.size});}}),m=f.fresh();try{await assert.rejects(m.assertUnconfinedAccess(),/collides/);}finally{await m.close();}});
await check('working-root-child-list-is-not-silently-accepted-as-control',async()=>{const f=await fixture({mutateMap:async({doc,project})=>doc.namespaces.push({path:project,names:(await readdir(project)).sort()})}),m=f.fresh();try{await assert.rejects(m.assertUnconfinedAccess(),/working-root child list/);}finally{await m.close();}});
for(const target of ['project','cwd'])await check('ordinary-'+target+'-change-during-check-is-still-refused',async()=>{const f=await fixture(),m=f.fresh(),identities=m.readIdentities;let changed=false;m.readIdentities=async args=>{const values=await identities(args);if(!changed){changed=true;await privateWrite(join(f[target],'concurrent.txt'),'changed during check');}return values;};try{await assert.rejects(m.assertUnconfinedAccess(),/changed/);}finally{await m.close();}});
for(const [label,key,bytes] of [['manifest-still8MiB','manifest',9*1024*1024],['index-still4MiB','index',5*1024*1024],['bundle-over512MiB','bundle',512*1024*1024+1]])await check(label,async()=>{const f=await fixture({archive:true,mutateLedger:({record})=>record.archive[key].bytes=bytes}),m=f.fresh();try{await assert.rejects(m.assertUnconfinedAccess(),/role bound/);}finally{await m.close();}});
await check('unknown-large-file-role-never-gets-bundle-bound',async()=>{const f=await fixture({mutateMap:({doc,project})=>doc.rows.push({path:join(project,'unrelated.bundle'),historicalIdentity:null,identity:{volumeUUID:volume,ino:'9999999'},mode:0o100600,uid:process.getuid(),type:'file',sha256:'a'.repeat(64),bytes:9*1024*1024})}),m=f.fresh();try{await assert.rejects(m.assertUnconfinedAccess(),/evidence row/);}finally{await m.close();}});

assert.deepEqual(effects,{subprocess:0,network:0,fetch:0,git:0,nativeHelper:0,originalStore:0});
const report={version:1,kind:'generated-authenticated-v1-readonly-view-v2-candidate',source:selected,cases:results.length,passed:results.length,failed:0,effects,actualMapActivated:false,fullAccessFilesIsReadOnly:false,managerLedgerUnchanged:true,scope:'Manager immutable view and managed lifecycle fences only; unrestricted configured Files calls retain their existing authority.',checks:results,completedUTC:new Date().toISOString()};
await writeFile(join(base,'check-result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
