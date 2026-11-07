import {join,dirname,normalize,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mkdir,lstat,realpath} from 'node:fs/promises';
import {captureGuestPublication,publishGuestChanges,verifyGuestPublication} from './guest-publication.mjs';
import {readGuestContentFile,captureGuestContent,verifyGuestContent,collectGuestChanges,runGuestCommand,runGuestCommandResult,guestNative} from './guest-content.mjs';
import {handoffPublishedState} from './handoff-native.mjs';
import {restoreSnapshot,hostGitWitness} from './handoff-git.mjs';
import {GIT_FLAGS} from './git-runner.mjs';

const workspaces=new WeakMap(),hostMutations=new WeakMap(),validationFailures=new WeakMap(),sha=b=>createHash('sha256').update(b).digest('hex');
// This identifies a validation origin, not worker closure. Only the owner can
// certify settlement, bound to its fresh per-publication check function.
export const isGuestWorkspaceValidationFailure=(error,check)=>typeof check==='function'&&validationFailures.get(error)===check;
const require=(ok,message)=>{if(!ok)throw Error('Guest workspace: '+message);};
const same=(a,b,message)=>require(isDeepStrictEqual(a,b),message);
const fold=v=>v.normalize('NFD').toUpperCase().toLowerCase();
const below=(a,b)=>a===b||b.startsWith(a+'/');
const snapshot=v=>({stamps:v.stamps,rootStamp:v.rootStamp,bytes:v.bytes});
function callbacks({native,checkpoint,check}){require([native,checkpoint,check].every(f=>typeof f==='function'),'admitted native, durable checkpoint and check are required');}
function originalInventory(value,scratchName,git=false){
  same(Object.keys(value.excluded),git?['.git']:[],'Git or other excluded project content requires a verified transfer contract');
  for(const [path,row] of [['',value.rootStamp],...Object.entries(value.stamps)]){
    require(!below(fold(scratchName),fold(path)),'host content collides with guest scratch');
    require(!Object.hasOwn(row,'storageXattrs')&&row.acl===null&&row.flags===0&&Object.keys(row.xattrs).every(k=>k==='com.apple.provenance'||path===''&&k==='com.apple.macl'),'unsupported project ACL, flags or extended attributes');
    require(row.uid===value.rootStamp.uid&&row.gid===value.rootStamp.gid,'mixed project ownership is unsupported');
    if(path){
      require(row.kind==='symlink'?row.mode<=0o777:(row.kind==='directory'?[0o700,0o755]:[0o600,0o644,0o700,0o755]).includes(row.mode),'unsupported project mode');
      require(row.kind==='directory'||row.nlink===1,'project hardlinks require a verified transfer contract');
    }
  }
}
function scratchInventory(value,state,empty=false){
  same(Object.keys(value.excluded).sort(),[...state.exclude,...state.git?['.git']:[]].sort(),'guest excluded namespace differs from retained scratch and Git');
  const version=value.excluded[state.exclude[0]];
  require(Array.isArray(version)&&version[0]===state.scratch.dev&&version[1]===state.scratch.ino&&Number(version[2])===0o40700,'guest scratch identity or mode changed');
  if(state.git){
    const current=value.excluded['.git'];require(Array.isArray(current)&&current.length===11&&current.every(v=>typeof v==='string'),'invalid guest Git identity');
    for(const index of [0,1,2,3,4,7,10])same(current[index],state.gitVersion[index],'guest Git identity or metadata changed');
  }
  if(empty)require(Object.keys(value.stamps).length===0,'guest workspace was not empty before seeding');
}
function guestContext(state,{engine,life,signal,check}){
  require(state.engine===engine&&state.life===life,'guest workspace lifetime changed');
  return {engine,life,signal,check,helper:state.helper,cwd:state.guestHome,sandboxPolicy:{type:'workspaceWrite',writableRoots:[state.guestHome,state.root.path],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}};
}
export function guestWorkspaceRepository(workspace){const state=workspaces.get(workspace);return state?.hostGitWitness?Object.freeze({cwd:state.hostRoot.path,commonRepositoryId:state.hostGitWitness.commonRepositoryId}):null;}
async function verifyWorkspaceGit(state,options){
  const context=guestContext(state,options),remote=(a,v)=>guestNative(context,a,v);
  require(state.git&&state.gitWitness&&state.hostGitWitness,'retained Git synchronization witnesses are unavailable');
  const inventory=await verifyGuestContent({baseline:state.guest,native:remote,check:options.check});scratchInventory(inventory,state);
  same(await remote('inventory',{root:{path:state.git.path,...state.git.identity},exclude:[]}),state.gitWitness,'guest Git changed; its index, refs and metadata were preserved');
  options.check();return {context,remote,inventory};
}

// Both phases are callable only through the owner's retained shared Git lease.
// A ticket is an in-memory capability; serialized data cannot recreate it.
export async function prepareHostGitWorkspace(options){
  callbacks(options);const state=workspaces.get(options.workspace);require(state&&!state.pending&&!state.hostMutation,'workspace synchronization is pending or failed');
  const {native,check,inspectGit,checkpoint}=options;require(typeof inspectGit==='function','host Git inspection admission is missing');
  const before=await verifyGuestPublication({baseline:state.host,native,check});
  const {inventory}=await verifyWorkspaceGit(state,options),admitted=await inspectGit();
  same(admitted.witness,state.hostGitWitness,'host Git changed since the retained guest import');await admitted.reverify();
  same(await verifyGuestPublication({baseline:state.host,native,check}),before,'host changed during synchronization preflight');
  await verifyWorkspaceGit(state,options);
  const ticket=Object.freeze({id:randomUUID()}),sequence=(state.hostGitSequence??0)+1;
  await checkpoint('host-git-'+sequence+'-before',{id:ticket.id,host:before,guest:inventory,git:state.gitWitness,hostGit:state.hostGitWitness});check();
  await admitted.reverify();same(await verifyGuestPublication({baseline:state.host,native,check}),before,'host changed during preflight durability');
  same((await verifyWorkspaceGit(state,options)).inventory,inventory,'guest changed during preflight durability');check();
  state.hostGitSequence=sequence;state.hostMutation=ticket;hostMutations.set(ticket,{state,before,inventory,sequence,finished:false});return ticket;
}

// Recheck every prepared owner after all preflight callbacks settle and before
// the reviewed host action. The original capabilities remain unconsumed.
export async function verifyHostGitWorkspace(options){
  callbacks(options);const entry=hostMutations.get(options.ticket),state=workspaces.get(options.workspace);
  require(entry&&entry.state===state&&state.hostMutation===options.ticket&&!entry.finished&&!state.pending,'host Git synchronization ticket is stale');
  const {native,check,inspectGit}=options;require(typeof inspectGit==='function','host Git inspection admission is missing');const admitted=await inspectGit();
  same(admitted.witness,state.hostGitWitness,'host Git changed after synchronization preflight');await admitted.reverify();
  same(await verifyGuestPublication({baseline:state.host,native,check}),entry.before,'host changed after synchronization preflight');
  same((await verifyWorkspaceGit(state,options)).inventory,entry.inventory,'guest changed after synchronization preflight');check();
}

export async function refreshHostGitWorkspace(options){
  callbacks(options);const entry=hostMutations.get(options.ticket),state=workspaces.get(options.workspace);
  require(entry&&entry.state===state&&state.hostMutation===options.ticket&&!entry.finished&&!state.pending,'host Git synchronization ticket is stale');
  entry.finished=true;const {native,check,checkpoint,snapshotGit,gitPath,indexSHA256,indexTree,target}=options;
  require(typeof target==='boolean'&&/^[a-f0-9]{64}$/.test(indexSHA256)&&/^[a-f0-9]{40}$/.test(indexTree),'invalid reviewed index witness');
  const save=(name,data)=>checkpoint('host-git-'+entry.sequence+'-'+name,data),{context,remote}=await verifyWorkspaceGit(state,options);
  const hostAfter=await verifyGuestPublication({baseline:state.host,native,check,gitMetadataChanged:true}),admitted=await snapshotGit(),witness=hostGitWitness(admitted.snapshot);
  const expected=structuredClone(state.hostGitWitness);if(target){expected.index={hash:indexSHA256,bytes:witness.index?.bytes};expected.indexTree=indexTree;}
  same(witness,expected,'host Git post-state differs from the exact reviewed index operation');await admitted.reverify();
  const candidatePath=join(state.guestHome,'host-git-'+randomUUID());
  const candidate=await importGuestGit(state,context,admitted,gitPath,save,candidatePath);
  const beforePlacement=(await verifyWorkspaceGit(state,options)).inventory;await admitted.reverify();
  same(await verifyGuestPublication({baseline:state.host,native,check,gitMetadataChanged:true}),hostAfter,'host changed during guest Git import');
  // Keep the protected .git root. The native publisher retains every original
  // descendant before installing the candidate; the owner lease covers both calls.
  const paths=['capture','empty'].map(name=>join(state.guestHome,'host-git-'+randomUUID()+'-'+name));
  const descriptors=await runGuestCommand({...context,command:['/bin/zsh','-f','-c','set -eu; umask 077; for p in "$@"; do /bin/mkdir -m 700 "$p"; /usr/bin/stat -f "%d:%i" "$p"; done','saleh-git-stages',...paths],input:Buffer.alloc(0)});
  const ids=descriptors.toString('utf8').trim().split('\n');require(ids.length===2&&ids.every(value=>/^\d+:\d+$/.test(value)),'invalid guest Git publication identities');
  const roots=paths.map((path,i)=>{const [dev,ino]=ids[i].split(':');return {path,dev,ino};}),gitRoot={path:state.git.path,...state.git.identity},candidateRoot={path:candidatePath,...candidate.git.identity};
  let gitState={root:gitRoot,...state.gitWitness},stageState={root:candidateRoot,...candidate.witness};
  let captureState={root:roots[0],...await remote('inventory',{root:roots[0],exclude:[]})},emptyState={root:roots[1],...await remote('inventory',{root:roots[1],exclude:[]})};
  for(const value of [captureState,emptyState]){same(value.stamps,{},'guest Git capture or stage was not empty');same(value.excluded,{},'guest Git capture or stage has excluded entries');}
  const placement={...context,sandboxPolicy:{...context.sandboxPolicy,writableRoots:[gitRoot.path,candidatePath,...paths]}};
  const verifyState=async expected=>{const actual=await remote('inventory',{root:expected.root,exclude:[]});same(snapshot(actual),snapshot(expected),'guest Git publication state changed');same(actual.excluded,{},'guest Git publication namespace changed');check();};
  const verifyAll=async()=>{
    await admitted.reverify();same(await verifyGuestPublication({baseline:state.host,native,check,gitMetadataChanged:true}),hostAfter,'host changed during guest Git publication');
    const working=await remote('inventory',{root:state.root,exclude:state.exclude});scratchInventory(working,state);
    same({...working,excluded:{...working.excluded,'.git':beforePlacement.excluded['.git']}},beforePlacement,'guest working contents or metadata changed during Git publication');
    for(const value of [gitState,stageState,captureState,emptyState])await verifyState(value);check();
  };
  const publish=async(name,stage,capture,install,remove)=>{
    try{
      const plan={native:{destination:{...gitState,ignored:[],omitted:[]}},stages:{destination:{...stage,before:gitState.stamps,beforeRootStamp:gitState.rootStamp,install,remove,capture}}};
      await save(name+'-plan',structuredClone(plan));check();await verifyAll();
      const receipt=await guestNative(placement,'publish',{root:gitRoot,stage:stage.root,capture:capture.root,before:gitState.stamps,staged:stage.stamps,beforeRootStamp:gitState.rootStamp,stagedRootStamp:stage.rootStamp,captureRootStamp:capture.rootStamp,install,remove});check();
      const outcome=handoffPublishedState(plan,'destination',receipt);for(const value of Object.values(outcome))await verifyState(value);
      const result={...outcome,captured:structuredClone(receipt.captured)};await save(name+'-outcome',structuredClone(result));check();return result;
    }catch(error){throw Error('Guest Git '+(name==='retain'?'retention':'installation')+' failed: '+error.message,{cause:error});}
  };
  const retained=await publish('retain',emptyState,captureState,[],Object.keys(gitState.stamps));
  gitState=retained.live;captureState=retained.capture;emptyState=retained.stage;await verifyAll();
  const installed=await publish('install',stageState,emptyState,Object.keys(stageState.stamps),[]);
  gitState=installed.live;stageState=installed.stage;emptyState=installed.capture;await verifyAll();
  const live=await remote('inventory',{root:state.root,exclude:state.exclude}),version=live.excluded['.git'];
  const next={...state,git:{...state.git,indexTree:candidate.git.indexTree},gitVersion:version};scratchInventory(live,next);
  const placed=await remote('inventory',{root:gitRoot,exclude:[]});same(snapshot(placed),snapshot(gitState),'installed guest Git differs from verified publication');same(placed.excluded,{},'installed guest Git exclusions differ');
  const originalDirectory=await lstat(state.directory,{bigint:true});require(originalDirectory.isDirectory()&&originalDirectory.dev===state.directoryIdentity.dev&&originalDirectory.ino===state.directoryIdentity.ino&&originalDirectory.uid===BigInt(process.getuid())&&(originalDirectory.mode&0o777n)===0o700n&&await realpath(state.directory)===state.directory,'private workspace directory changed');
  const directory=join(state.directory,'host-git-'+entry.sequence);await mkdir(directory,{mode:0o700});
  const fixedHost=async(action,input,...rest)=>{const value=await native(action,input,...rest);if(action==='inventory'&&isDeepStrictEqual(input.root,state.hostRoot))same(value,hostAfter,'host changed during Git baseline renewal');return value;};
  const host=await captureGuestPublication({root:state.hostRoot,exclude:[],directory,native:fixedHost,checkpoint:save,check});
  const guest=await captureGuestContent({root:state.root,exclude:state.exclude,expected:host.donor,native:remote,check});
  await save('ready',structuredClone({hostBaseline:host.id,guestBaseline:guest.id,git:next.git,gitWitness:placed,hostGit:witness,retained:captureState,publications:{retained,installed}}));check();
  await admitted.reverify();await fixedHost('inventory',{root:state.hostRoot,exclude:[]});
  await verifyAll();
  same(await remote('inventory',{root:gitRoot,exclude:[]}),placed,'guest Git changed before renewal');
  same(await remote('inventory',{root:state.root,exclude:state.exclude}),live,'guest working tree changed before renewal');check();
  Object.assign(state,{host,guest,git:next.git,gitVersion:version,gitWitness:placed,hostGitWitness:witness,round:state.round+1,hostMutation:null});return {synchronized:true};
}

async function importGuestGit(state,context,admitted,gitPath,checkpoint,destination=null){
  const {check}=context,remote=(action,input)=>guestNative(context,action,input);
  await admitted.reverify();check();
  const manifest=structuredClone(admitted.snapshot),bytes=Buffer.from(admitted.bundleBytes),bundle=manifest.bundle;
  require(bytes.length===bundle.bytes&&sha(bytes)===bundle.hash,'admitted Git bundle bytes changed');
  const before=await remote('inventory',{root:state.root,exclude:state.exclude});scratchInventory(before,state);
  const path=join(state.guestHome,'workspace-'+randomUUID()+'-git-bundle'),bundlePath=join(path,'recovery.bundle');
  const id=await runGuestCommand({...context,command:['/bin/zsh','-f','-c','set -eu; umask 077; /bin/mkdir -m 700 "$1"; /usr/bin/stat -f "%d:%i" "$1"','saleh-git-bundle',path],input:Buffer.alloc(0)});
  require(/^\d+:\d+\n$/.test(id.toString('utf8')),'invalid guest Git bundle directory identity');
  const [dev,ino]=id.toString('utf8').trim().split(':'),bundleRoot={path,dev,ino};
  await runGuestCommand({...context,command:['/bin/zsh','-f','-c','set -Ceu; umask 077; /usr/bin/base64 -D > "$1"','saleh-git-bundle',bundlePath],input:Buffer.from(bytes.toString('base64'))});
  const received=await remote('inventory',{root:bundleRoot,exclude:[]});
  same(Object.keys(received.stamps),['recovery.bundle'],'guest Git bundle namespace differs');same(received.excluded,{},'unexpected excluded Git bundle entry');
  const row=received.stamps['recovery.bundle'];require(row.kind==='file'&&row.mode===0o600&&row.nlink===1&&row.bytes===bundle.bytes&&row.sha256===bundle.hash,'guest Git bundle type, mode, size or digest differs');
  const gitDir=destination??join(state.root.path,'.git');
  await runGuestCommand({...context,sandboxPolicy:{...context.sandboxPolicy,writableRoots:[gitDir]},command:['/bin/mkdir','-m','700',gitDir],input:Buffer.alloc(0)});
  const descriptor=await runGuestCommand({...context,command:['/usr/bin/stat','-f','%d:%i',gitDir],input:Buffer.alloc(0)});
  require(/^\d+:\d+\n$/.test(descriptor.toString('utf8')),'invalid guest Git root identity');
  const [gitDev,gitIno]=descriptor.toString('utf8').trim().split(':'),gitRoot={path:gitDir,dev:gitDev,ino:gitIno};
  const gitState={path:gitDir,identity:{dev:gitDev,ino:gitIno},indexTree:manifest.trees.index};
  if(!destination){
    const created=await remote('inventory',{root:state.root,exclude:state.exclude}),version=created.excluded['.git'];
    require(Array.isArray(version)&&version.length===11&&version.every(v=>typeof v==='string')&&Number(version[2])===0o40700&&version[3]===String(created.rootStamp.uid)&&version[4]===String(created.rootStamp.gid)&&version[7]==='0','guest Git directory identity, ownership or mode differs');
    state.git=gitState;state.gitVersion=structuredClone(version);
  }
  const targetCheck=async()=>{check();const current=await remote('inventory',{root:state.root,exclude:state.exclude});scratchInventory(current,state);same(current.stamps,before.stamps,'working contents changed during Git import');same(current.bytes,before.bytes,'working byte count changed during Git import');same(current.excluded[state.exclude[0]],before.excluded[state.exclude[0]],'scratch changed during Git import');check();};
  const git=async(args,{input='',allowCodes=[0]}={})=>{
    await targetCheck();
    const bin=dirname(gitPath),env={HOME:state.guestHome,PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',LC_ALL:'C',GIT_EXEC_PATH:bin,GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALTERNATE_OBJECT_DIRECTORIES:'',GIT_INDEX_FILE:join(gitDir,'index')};
    const result=await runGuestCommandResult({...context,sandboxPolicy:{...context.sandboxPolicy,writableRoots:[gitDir]},command:['/bin/zsh','-f','-c','umask 077; exec "$@"','saleh-git','/usr/bin/env','-i',...Object.entries(env).map(([key,value])=>key+'='+value),gitPath,...GIT_FLAGS,'--git-dir='+gitDir,'--literal-pathspecs',...args],input:Buffer.from(input)});
    await targetCheck();require(allowCodes.includes(result.code),'guest Git command failed');
    return {...result,stdout:new TextDecoder('utf-8',{fatal:true}).decode(result.stdout),stderr:new TextDecoder('utf-8',{fatal:true}).decode(result.stderr)};
  };
  await git(['init','--bare','--quiet','--template=']);await git(['config','core.bare','false']);
  const restored=await restoreSnapshot(manifest,git,{bundlePath});
  same(await remote('inventory',{root:bundleRoot,exclude:[]}),received,'guest Git bundle changed during import');
  await admitted.reverify();await targetCheck();
  const witness=await remote('inventory',{root:gitRoot,exclude:[]}),root=witness.rootStamp;
  require(root.kind==='directory'&&root.mode===0o700&&root.uid===before.rootStamp.uid&&root.gid===before.rootStamp.gid&&root.flags===0&&root.acl===null&&Object.keys(root.xattrs).every(k=>k==='com.apple.provenance'),'imported guest Git root ownership, permissions or metadata differ');
  await checkpoint('git-ready',{git:gitState,bundle:{root:bundleRoot,...received},restored,witness});check();
  same(await remote('inventory',{root:gitRoot,exclude:[]}),witness,'imported guest Git changed during durability');
  return {git:gitState,witness};
}

// Called once inside resource.prepare's retained owner publication admission.
export async function prepareGuestWorkspace(options){
  callbacks(options);const {hostRoot,directory,scratch,guestHome,helper,engine,life,signal,check,native,checkpoint,snapshotGit,gitPath}=options;check();
  require(scratch&&scratch.cwd!== '/'&&dirname(scratch.path)===scratch.cwd&&/^\.saleh-coding-tmp-[A-Za-z0-9_-]+$/.test(scratch.path.slice(scratch.cwd.length+1)),'invalid retained guest scratch');
  require([hostRoot.path,scratch.cwd,guestHome,directory,helper].every(p=>typeof p==='string'&&isAbsolute(p)&&normalize(p)===p&&p!=='/'),'noncanonical workspace path');
  require(!below(guestHome,scratch.cwd)&&!below(scratch.cwd,guestHome),'guest workspace overlaps executor home');
  const state={engine,life,helper,guestHome,scratch:structuredClone(scratch),root:{path:scratch.cwd,dev:scratch.projectDev,ino:scratch.projectIno},exclude:[scratch.path.slice(scratch.cwd.length+1)],hostRoot:structuredClone(hostRoot),directory,round:0,pending:null};
  const context=guestContext(state,options),remote=(a,v)=>guestNative(context,a,v);
  const initial=await remote('inventory',{root:state.root,exclude:state.exclude});scratchInventory(initial,state,true);check();
  let gitSnapshot,placementRequested=false;
  state.host=await captureGuestPublication({root:hostRoot,directory,exclude:[],check,checkpoint,native:async(action,input,...rest)=>{
    if(['copy','materialize','publish'].includes(action))placementRequested=true;
    const value=await native(action,input,...rest);
    if(action==='inventory'&&isDeepStrictEqual(input.root,hostRoot)){
      if(Object.keys(value.excluded).length){
        same(Object.keys(value.excluded),['.git'],'only root Git metadata has a transfer contract');
        require(typeof snapshotGit==='function'&&gitPath===join(guestHome,'Git/bin/git'),'Git requires an owner snapshot and admitted private runtime');
        if(!gitSnapshot){
          gitSnapshot=await snapshotGit();check();
          require(gitSnapshot&&typeof gitSnapshot.reverify==='function'&&Buffer.isBuffer(gitSnapshot.bundleBytes)&&gitSnapshot.bundleBytes.length>0&&gitSnapshot.bundleBytes.length<=32*1024*1024&&gitSnapshot.snapshot?.bundle?.bytes===gitSnapshot.bundleBytes.length&&sha(gitSnapshot.bundleBytes)===gitSnapshot.snapshot.bundle.hash,'invalid admitted Git snapshot bytes');
        }
        await gitSnapshot.reverify();check();
      }
      try{originalInventory(value,state.exclude[0],!!gitSnapshot);}
      catch(error){if(!placementRequested)validationFailures.set(error,check);throw error;}
    }return value;
  }});check();
  if(gitSnapshot){await gitSnapshot.reverify();check();}
  state.directoryIdentity=await lstat(directory,{bigint:true});check();
  const paths=['payload','stage','capture'].map(name=>join(guestHome,'workspace-'+randomUUID()+'-'+name));
  const bytes=await runGuestCommand({...context,command:['/bin/zsh','-f','-c','set -eu; umask 077; for p in "$@"; do /bin/mkdir -m 700 "$p"; /usr/bin/stat -f "%d:%i" "$p"; done','saleh-workspace',...paths],input:Buffer.alloc(0)});
  const ids=bytes.toString('utf8').trim().split('\n');require(ids.length===3&&ids.every(v=>/^\d+:\d+$/.test(v)),'invalid guest staging identities');
  const [payloadRoot,stageRoot,captureRoot]=paths.map((path,i)=>{const [dev,ino]=ids[i].split(':');return {path,dev,ino};});
  const payloads=new Map(),entries=Object.create(null);
  for(const [path,row] of Object.entries(state.host.donor.stamps)){
    check();let bytes;
    if(row.kind==='file')bytes=await readGuestContentFile({root:state.host.donor.root,inventory:state.host.donor,path,native,check});
    else if(row.kind==='symlink')bytes=Buffer.from(row.targetBase64,'base64');
    const entry={kind:row.kind,mode:row.mode};if(bytes){entry.payload=sha(bytes);payloads.set(entry.payload,bytes);}entries[path]=entry;
  }
  for(const [slot,bytes] of payloads)await runGuestCommand({...context,command:['/bin/zsh','-f','-c','set -Ceu; umask 077; /usr/bin/base64 -D > "$1"','saleh-payload',join(payloadRoot.path,slot)],input:Buffer.from(bytes.toString('base64'))});
  const payload=await remote('inventory',{root:payloadRoot,exclude:[]});check();
  same(Object.keys(payload.stamps).sort(),[...payloads.keys()].sort(),'payload namespace differs');same(payload.excluded,{},'unexpected excluded payload');
  for(const [slot,bytes] of payloads){const row=payload.stamps[slot];require(row.kind==='file'&&row.nlink===1&&row.sha256===slot&&row.bytes===bytes.length,'payload receipt differs');}
  const now=Date.now(),stage={root:stageRoot,...await remote('materialize',{destination:stageRoot,donors:[],payload:{root:payloadRoot,stamps:payload.stamps,rootStamp:payload.rootStamp},entries,timestamp:Math.floor(now/1000)+':'+(now%1000)*1000000})};check();
  // Validate the complete staged portable contents before any placement effect.
  await captureGuestContent({root:stageRoot,expected:state.host.donor,native:remote,check});
  const before=await remote('inventory',{root:state.root,exclude:state.exclude});same(before,initial,'guest changed before seed placement');
  const capture={root:captureRoot,...await remote('inventory',{root:captureRoot,exclude:[]})};require(!Object.keys(capture.stamps).length&&!Object.keys(capture.excluded).length,'seed capture was not empty');check();
  const install=Object.keys(stage.stamps).sort();
  if(install.length){
    const candidate={...stage,before:{},beforeRootStamp:before.rootStamp,install,remove:[],capture};
    const plan={native:{destination:{root:state.root,...before,ignored:state.exclude,omitted:state.exclude}},stages:{destination:candidate}};
    await checkpoint('seed-plan',structuredClone(plan));check();
    const receipt=await remote('publish',{root:state.root,stage:stageRoot,capture:captureRoot,before:{},staged:stage.stamps,beforeRootStamp:before.rootStamp,stagedRootStamp:stage.rootStamp,captureRootStamp:capture.rootStamp,install,remove:[]});
    const outcome=handoffPublishedState(plan,'destination',receipt);
    for(const [label,expected] of Object.entries(outcome)){
      const actual=await remote('inventory',{root:expected.root,exclude:label==='live'?state.exclude:[]});
      same(snapshot(actual),snapshot(expected),'independent seed '+label+' differs');same(actual.excluded,label==='live'?initial.excluded:{},'seed exclusions changed');
    }
    await checkpoint('seed-outcome',outcome);check();
  }
  const final=await remote('inventory',{root:state.root,exclude:state.exclude});scratchInventory(final,state);same(final.excluded,initial.excluded,'scratch changed during seeding');
  if(gitSnapshot){const imported=await importGuestGit(state,context,gitSnapshot,gitPath,checkpoint);state.gitWitness=imported.witness;state.hostGitWitness=hostGitWitness(gitSnapshot.snapshot);}
  state.guest=await captureGuestContent({root:state.root,exclude:state.exclude,expected:state.host.donor,native:remote,check});
  await checkpoint('seed-ready',{hostBaseline:state.host.id,guestBaseline:state.guest.id,root:state.root,exclude:state.exclude,scratch:state.scratch,...state.git?{git:state.git}:{}});check();
  if(gitSnapshot){await gitSnapshot.reverify();scratchInventory(await remote('inventory',{root:state.root,exclude:state.exclude}),state);check();}
  const workspace=Object.freeze({id:randomUUID()});workspaces.set(workspace,state);return workspace;
}

// Every round remains inside the caller's owner publication admission. Concurrent
// calls share its original promise; a failed round is retained and never replayed.
export function publishGuestWorkspace(options){
  try{
    callbacks(options);const state=workspaces.get(options.workspace);require(state,'workspace is unknown');
    require(!state.hostMutation,'host Git synchronization remains pending or failed');
    const context=guestContext(state,options);if(state.pending)return state.pending;
    options.check();const round=state.round,work=state.pending=Promise.resolve().then(()=>publishRound(state,options,context));
    work.then(()=>{if(state.round===round+1)state.pending=null;},()=>{});return work;
  }catch(error){return Promise.reject(error);}
}
async function publishRound(state,{native,checkpoint,check},context){
  check();const remote=(a,v)=>guestNative(context,a,v),round=state.round;
  const save=(name,data)=>checkpoint('round-'+round+'-'+name,data);
  const inventory=await remote('inventory',{root:state.root,exclude:state.exclude});scratchInventory(inventory,state);
  const fixedGuest=async(action,input)=>{
    const value=await remote(action,input);
    if(action==='inventory'&&isDeepStrictEqual(input.root,state.root))same(value,inventory,'guest changed since collection witness');return value;
  };
  const changes=await collectGuestChanges({baseline:state.guest,native:fixedGuest,check});
  await save('guest-changes',{inventory,changes:changes.map(({data,...row})=>row)});check();
  const outcome=await publishGuestChanges({baseline:state.host,changes,native,checkpoint:save,check});
  // Accepted host effects settle and save their outcome before this cancellation
  // boundary. The owner can drain a confirmed outcome while rejecting its stale
  // response; this consumed capability must not begin another donor copy.
  if(context.signal?.aborted)return {...outcome,renewed:false};
  check();
  const fixedHost=async(action,input,...rest)=>{
    check();const value=await native(action,input,...rest);check();
    if(action==='inventory'&&isDeepStrictEqual(input.root,state.hostRoot))same(value,{...snapshot(outcome.live),excluded:outcome.live.excluded},'host changed since publication witness');return value;
  };
  const current=await lstat(state.directory,{bigint:true});check();
  for(const key of ['dev','ino','uid','gid','mode'])same(current[key],state.directoryIdentity[key],'private workspace identity or metadata changed');
  require(current.isDirectory()&&await realpath(state.directory)===state.directory,'private workspace path changed');check();
  const nextRound=round+1,directory=join(state.directory,'round-'+nextRound);
  await mkdir(directory,{mode:0o700});check();
  const host=await captureGuestPublication({root:state.hostRoot,directory,exclude:[],native:fixedHost,check,checkpoint:(name,data)=>checkpoint('round-'+nextRound+'-'+name,data)});
  const guest=await captureGuestContent({root:state.root,exclude:state.exclude,expected:host.donor,native:fixedGuest,check});
  await checkpoint('round-'+nextRound+'-ready',{previous:{hostBaseline:state.host.id,guestBaseline:state.guest.id},hostBaseline:host.id,guestBaseline:guest.id,directory});check();
  // Durability callbacks also form part of the admission: neither side may drift
  // while the fresh donor and ready receipt are being retained.
  await fixedHost('inventory',{root:state.hostRoot,exclude:[]});
  await fixedGuest('inventory',{root:state.root,exclude:state.exclude});check();
  Object.assign(state,{host,guest,round:nextRound});return outcome;
}
