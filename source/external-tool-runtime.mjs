// Unknown-source JavaScript runs as the user's OS account, NOT in a sandbox.
// Only immutable native publication and a fresh native review can authorize spawn.
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual,TextDecoder} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {parseExternalArtifactInstall} from './external-artifact-download.mjs';
// Fixed trusted loader: executes only the verified private fd3 snapshot, never reopens artifact.mjs.
// Self-contained modules and built-in imports only; storage separation is not an OS sandbox.
export const EXTERNAL_JS_LOADER = `import {createReadStream} from 'node:fs';import {createHash} from 'node:crypto';const expected=process.argv[1];if(!/^[a-f0-9]{64}$/.test(expected??''))throw Error('Invalid reviewed revision');let size=0;const chunks=[];for await(const chunk of createReadStream(null,{fd:3,autoClose:true,highWaterMark:65536})){size+=chunk.length;if(size>1048576)throw Error('External source exceeds bound');chunks.push(chunk);}const source=Buffer.concat(chunks);if(!size||createHash('sha256').update(source).digest('hex')!==expected)throw Error('External source digest mismatch');await import('data:text/javascript;base64,'+source.toString('base64'));`;
const hash=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const keys=(v,want)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...want].sort().join(',');
const withoutFingerprint=({fingerprint,...rest})=>rest;
const digest=v=>hash(JSON.stringify(canonical(v)));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const identity=s=>(s.isDirectory()?[s.dev,s.ino,s.mode,s.uid,s.gid,s.birthtimeMs]:[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs,s.birthtimeMs]).join(':');
const frozen=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;};

// Node has no openat: retain every ancestor descriptor and recheck names and
// identities before/after bounded reads. Native publication supplies immutability.
function checked(target,{directory=false,privateFrom,limit=1024*1024,executable=false,protectedAncestors=true}={}){
  if(!path.isAbsolute(target)||path.normalize(target)!==target)throw Error('Noncanonical external path.');
  const held=[];
  try{
    let current=path.parse(target).root;
    const parts=target.slice(current.length).split('/').filter(Boolean);
    for(let i=-1;i<parts.length;i++){
      if(i>=0)current=path.join(current,parts[i]);
      const last=i===parts.length-1,isDir=!last||directory;
      const stat=fs.lstatSync(current);
      if(stat.isSymbolicLink()||(isDir?!stat.isDirectory():!stat.isFile()))throw Error('External path type changed.');
      if(![0,process.getuid()].includes(stat.uid)||((protectedAncestors||!isDir)&&(stat.mode&0o022)))throw Error('External path is writable by another account.');
      if(privateFrom&&(current===privateFrom||current.startsWith(privateFrom+'/'))){
        if(stat.uid!==process.getuid()||(stat.mode&0o777)!==(isDir?0o700:0o400)||(!isDir&&stat.nlink!==1))throw Error('External storage ownership, links or mode changed.');
      }
      const fd=fs.openSync(current,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|(isDir?fs.constants.O_DIRECTORY:0));
      held.push({fd,name:current,stat:identity(stat)});
      if(identity(fs.fstatSync(fd))!==identity(stat))throw Error('External path changed while opening.');
    }
    const leaf=held.at(-1),stat=fs.fstatSync(leaf.fd);
    let bytes;
    if(!directory){
      if(stat.size<=0||stat.size>limit||stat.nlink!==1||executable&&!(stat.mode&0o111))throw Error('External file bounds or identity invalid.');
      const buffer=Buffer.alloc(Math.min(limit+1,stat.size+1));let total=0;
      while(total<buffer.length){const count=fs.readSync(leaf.fd,buffer,total,buffer.length-total,null);if(!count)break;total+=count;}
      bytes=buffer.subarray(0,total);
      if(bytes.length!==stat.size||bytes.length>limit)throw Error('External file changed while reading.');
    }
    for(const h of held)if(identity(fs.fstatSync(h.fd))!==h.stat||identity(fs.lstatSync(h.name))!==h.stat)throw Error('External ancestor or file changed.');
    return {bytes,identity:held.map(h=>[h.name,h.stat])};
  }finally{for(const h of held.reverse())fs.closeSync(h.fd);}
}

export class ExternalToolRuntime {
  #hub; #authority; #root; #parent; #gate; #boot; #recovery; #generation=randomUUID(); #epoch=0;
  #prepared=new Map(); #entries=new Map(); #states=new Map(); #knownRuns=new Map(); #runtimeIdentity; #rearms=new Map(); #ownedPending=new Set(); #inflight=new Set(); #historyBindings=new Map();
  constructor({parent,hub,authority,unconfinedBoot=false,recoveryStartup=true,assertUnconfinedAccess,runtimeIdentity}){
    if(typeof parent!=='string'||path.resolve(parent)!==parent||!hub||!authority||typeof authority!=='object'||typeof assertUnconfinedAccess!=='function')throw Error('Invalid trusted external runtime setup.');
    if(runtimeIdentity!==undefined&&typeof runtimeIdentity!=='function')throw Error('Invalid trusted runtime identity checker.');
    this.#runtimeIdentity=runtimeIdentity;
    this.#parent=parent;this.#root=path.join(parent,'external-tools-v1');this.#hub=hub;this.#authority=authority;this.#boot=unconfinedBoot===true;this.#recovery=recoveryStartup!==false;this.#gate=assertUnconfinedAccess;
  }
  managedExternal(){return [...this.#entries].map(([id,config])=>({id,config}));}
  #bootGate(){if(!this.#boot||this.#recovery)throw Error('External launch requires an explicitly unconfined, non-recovery boot.');}
  #artifact(revision){
    if(!sha(revision))throw Error('Invalid external revision.');
    const base=path.join(this.#root,'revisions',revision),artifact=checked(path.join(base,'artifact.mjs'),{privateFrom:this.#root});
    const receipt=checked(path.join(base,'receipt.json'),{privateFrom:this.#root,limit:16384});
    const data=JSON.parse(receipt.bytes);
    if(Object.keys(data).sort().join(',')!==['version','kind','operationId','generation','url','sha256','bytes','purpose','sourceTrust','launch'].sort().join(','))throw Error('Unexpected external receipt fields.');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(artifact.bytes);if(text.includes('\0'))throw Error('External artifact contains NUL.');
    if(hash(artifact.bytes)!==revision||data.sha256!==revision||data.bytes!==artifact.bytes.length||data.version!==1||data.kind!=='inert-external-js-install'||data.sourceTrust!=='unreviewed-external'||data.launch!=='never-started'||!uuid(data.operationId)||!uuid(data.generation))throw Error('External install receipt mismatch.');
    parseExternalArtifactInstall({action:'install',url:data.url,sha256:revision,purpose:data.purpose});
    if(fs.readdirSync(base).sort().join(',')!=='artifact.mjs,receipt.json')throw Error('Unexpected external revision contents.');
    return {bytes:artifact.bytes,source:{url:data.url,purpose:data.purpose,trust:'unreviewed-external'},artifactPath:path.join(base,'artifact.mjs'),receiptSHA256:hash(receipt.bytes),identity:digest([artifact.identity,receipt.identity])};
  }
  #runtime(){
    if(this.#runtimeIdentity)return this.#runtimeIdentity(); // Trusted dependency injection for offline fixtures; never wire-configurable.
    const contractFile=checked(fileURLToPath(new URL('./runtime-contract.json',import.meta.url)),{limit:16384});
    const contract=JSON.parse(contractFile.bytes);
    const executable=fs.realpathSync(process.execPath),file=checked(executable,{limit:256*1024*1024,executable:true,protectedAncestors:false});
    if(contract.schemaVersion!==1||contract.node?.version!==process.version||contract.node?.executableSHA256!==hash(file.bytes))throw Error('External runtime does not match the qualified runtime contract.');
    return {executable,sha256:hash(file.bytes),version:process.version,identity:digest(file.identity),contractSHA256:hash(contractFile.bytes)};
  }
  #receipt(file,optional=false){
    try{const row=checked(file,{privateFrom:this.#root,limit:65536});return {value:JSON.parse(row.bytes),sha256:hash(row.bytes)};}
    catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
  }
  #history(revision,excludeLaunchID=null){
    const runs=path.join(this.#root,'runs');
    if(!fs.existsSync(runs))return [];
    checked(runs,{directory:true,privateFrom:this.#root});
    const names=fs.readdirSync(runs).sort();if(names.length>128)throw Error('External run inspection limit exceeded.');
    const history=[];let publishedCount=0;
    for(const name of names){
      if(/^\.stage-[a-f0-9-]{36}$/.test(name))continue;
      if(!uuid(name)||++publishedCount>64)throw Error('Unrecognized retained external run or inspection limit exceeded.');
      const dir=path.join(runs,name),pending=this.#receipt(path.join(dir,'pending.json')),p=pending.value,r=p.review;
      if(!keys(p,['version','kind','review'])||p.version!==1||p.kind!=='external-js-launch-pending'||!r||!sha(r.revision)||r.launchID!==name||!sha(r.fingerprint)||r.root!==this.#root||r.parent!==this.#parent||r.id!=='external-js-'+r.revision||digest(withoutFingerprint(r))!==r.fingerprint)throw Error('Unrecognized retained external launch; inspection required.');
      if(this.#knownRuns.has(name)&&!isDeepStrictEqual(this.#knownRuns.get(name),r))throw Error('Retained owned launch receipt changed; inspection required.');
      const outcome=this.#receipt(path.join(dir,'outcome.json'),true),closure=this.#receipt(path.join(dir,'closure.json'),true);
      if(outcome){const o=outcome.value;if(!keys(o,['version','kind','launchID','fingerprint','state'])||o.version!==1||o.kind!=='external-js-launch-outcome'||o.launchID!==name||o.fingerprint!==r.fingerprint||!['connected','not-started','launch-uncertain'].includes(o.state))throw Error('Invalid retained external outcome.');}
      if(closure&&!isDeepStrictEqual(closure.value,this.#closure(r)))throw Error('Invalid retained external owned closure.');
      if(r.revision!==revision||name===excludeLaunchID)continue;
      history.push({launchID:name,fingerprint:r.fingerprint,pendingSHA256:pending.sha256,outcomeSHA256:outcome?.sha256??null,closureSHA256:closure?.sha256??null,classification:closure?'owned-closed':outcome?.value.state==='not-started'?'not-started':'unresolved'});
      if(history.length>64)throw Error('External revision launch history limit reached.');
    }
    checked(runs,{directory:true,privateFrom:this.#root});
    if(!isDeepStrictEqual(names,fs.readdirSync(runs).sort()))throw Error('External history changed during inspection.');
    return history;
  }
  #closure(review){return {version:1,kind:'external-js-owned-closure',launchID:review.launchID,revision:review.revision,fingerprint:review.fingerprint,ownedExitConfirmed:true,descendants:'not-proven-terminated'};}
  #validateRearmReview(review){
    return keys(review,['version','kind','revision','rearmID','generation','epoch','createdAt','expiresAt','history','fingerprint'])&&review.version===1&&review.kind==='external-js-rearm-review'&&sha(review.revision)&&uuid(review.rearmID)&&uuid(review.generation)&&Number.isSafeInteger(review.epoch)&&review.epoch>=0&&Number.isSafeInteger(review.createdAt)&&review.createdAt>0&&review.createdAt<=Date.now()&&review.expiresAt===review.createdAt+300000&&Array.isArray(review.history)&&review.history.length<=64&&review.history.every(row=>keys(row,['launchID','fingerprint','pendingSHA256','outcomeSHA256','closureSHA256','classification'])&&uuid(row.launchID)&&sha(row.fingerprint)&&sha(row.pendingSHA256)&&(row.outcomeSHA256===null||sha(row.outcomeSHA256))&&(row.closureSHA256===null||sha(row.closureSHA256))&&['not-started','owned-closed','unresolved'].includes(row.classification))&&new Set(review.history.map(row=>row.launchID)).size===review.history.length&&review.history.some(row=>row.classification==='unresolved')&&sha(review.fingerprint)&&digest(withoutFingerprint(review))===review.fingerprint;
  }
  #acknowledged(revision,history){
    if(!history.some(row=>row.classification==='unresolved'))return true;
    const directory=path.join(this.#root,'rearms');if(!fs.existsSync(directory))return false;
    checked(directory,{directory:true,privateFrom:this.#root});
    const names=fs.readdirSync(directory).sort();if(names.length>128)throw Error('External re-arm acknowledgment limit reached.');
    let found=false,publishedCount=0;
    for(const name of names){
      if(/^\.stage-[a-f0-9-]{36}$/.test(name))continue; // Incomplete native publication never grants acknowledgment.
      if(++publishedCount>64)throw Error('External re-arm acknowledgment limit reached.');
      if(!/^[a-f0-9-]{36}\.json$/i.test(name)||!uuid(name.slice(0,-5)))throw Error('Unrecognized external re-arm acknowledgment.');
      const {value}=this.#receipt(path.join(directory,name));
      if(!keys(value,['version','kind','review','decision'])||value.version!==1||value.kind!=='external-js-rearm-acknowledgment'||value.decision!=='acknowledge-uncertain-prior-effects'||!this.#validateRearmReview(value.review)||value.review.rearmID!==name.slice(0,-5))throw Error('Invalid external re-arm acknowledgment.');
      if(value.review.revision===revision&&isDeepStrictEqual(value.review.history,history))found=true;
    }
    checked(directory,{directory:true,privateFrom:this.#root});
    if(!isDeepStrictEqual(names,fs.readdirSync(directory).sort()))throw Error('External acknowledgments changed during inspection.');
    return found;
  }
  #requireNoOwnedLaunch(revision){
    if([...this.#ownedPending].some(id=>this.#knownRuns.get(id)?.revision===revision)||this.#inflight.has(revision))throw Error('Owned external connection or exit remains unconfirmed. Explicit successful Disconnect is required before review or re-arm.');
  }
  #prepareRearm(revision,history){
    const createdAt=Date.now();for(const [id,r]of this.#rearms)if(r.expiresAt<=createdAt||r.revision===revision)this.#rearms.delete(id);
    if(this.#rearms.size>=64)throw Error('External re-arm review limit reached.');
    const review={version:1,kind:'external-js-rearm-review',revision,rearmID:randomUUID(),generation:this.#generation,epoch:this.#epoch,createdAt,expiresAt:createdAt+300000,history};
    review.fingerprint=digest(review);frozen(review);this.#rearms.set(review.rearmID,review);this.#states.set(revision,'launch-uncertain');return {needsRearm:true,review};
  }
  async rearm({rearmID,fingerprint}={}){
    const review=this.#rearms.get(rearmID);this.#rearms.delete(rearmID);
    if(!review||review.fingerprint!==fingerprint)throw Error('Fresh native re-arm acknowledgment required.');
    this.#bootGate();await this.#gate();
    if(review.generation!==this.#generation||review.epoch!==this.#epoch||Date.now()<review.createdAt||Date.now()>=review.expiresAt)throw Error('External re-arm review stopped or expired.');
    this.#requireNoOwnedLaunch(review.revision);
    const history=this.#history(review.revision);
    if(!isDeepStrictEqual(history,review.history))throw Error('External history changed after re-arm review.');
    const {value}=this.#receipt(path.join(this.#root,'rearms',review.rearmID+'.json'));
    if(!isDeepStrictEqual(value,{version:1,kind:'external-js-rearm-acknowledgment',review,decision:'acknowledge-uncertain-prior-effects'}))throw Error('Native re-arm acknowledgment does not match review.');
    this.#states.set(review.revision,'installed-disconnected');return {rearmed:true,revision:review.revision,rearmID:review.rearmID,fingerprint};
  }
  async prepare({revision,operationId=randomUUID()}={}){
    this.#bootGate();if(!uuid(operationId))throw Error('Invalid external operation ID.');
    const epoch=this.#epoch;await this.#gate();if(epoch!==this.#epoch)throw Error('External preparation stopped.');
    this.#requireNoOwnedLaunch(revision);
    const history=this.#history(revision);
    this.#artifact(revision);
    if(!this.#acknowledged(revision,history))return this.#prepareRearm(revision,history);
    const artifact=this.#artifact(revision),runtime=this.#runtime(),launchID=randomUUID(),run=path.join(this.#root,'runs',launchID),id='external-js-'+revision;
    const config=frozen({command:runtime.executable,args:['--input-type=module','--eval',EXTERNAL_JS_LOADER,'--',revision],env:{HOME:path.join(run,'home'),TMPDIR:path.join(run,'tmp'),PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},cwd:path.join(run,'work')});
    this.#entries.set(id,config);
    const configHash=(await this.#hub.describe()).servers.find(row=>row.id===id)?.configHash;
    if(epoch!==this.#epoch||!sha(configHash))throw Error('External preparation stopped or config unavailable.');
    const createdAt=Date.now();
    for(const [key,row]of this.#prepared)if(row.expiresAt<=createdAt){this.#prepared.delete(key);this.#historyBindings.delete(key);}
    if(this.#prepared.size>=64)throw Error('External review limit reached; Stop before more reviews.');
    const review={version:1,createdAt,expiresAt:createdAt+300000,unconfinedBoot:true,recoveryStartup:false,prepareId:randomUUID(),nonce:randomBytes(32).toString('hex'),operationId,generation:this.#generation,epoch,launchID,id,parent:this.#parent,root:this.#root,revision,source:artifact.source,receiptSHA256:artifact.receiptSHA256,artifactIdentity:artifact.identity,runtime,config,configHash,configFingerprint:digest(config)};
    review.fingerprint=digest(review);frozen(review);
    // Only the newest prepare for a revision remains usable.
    for(const [key,r]of this.#prepared)if(r.revision===revision){this.#prepared.delete(key);this.#historyBindings.delete(key);}
    this.#prepared.set(review.prepareId,review);this.#historyBindings.set(review.prepareId,digest(history));this.#states.set(revision,'installed-disconnected');return review;
  }
  #verify(review){
    this.#bootGate();if(Date.now()<review.createdAt||Date.now()>=review.expiresAt)throw Error('External review expired; fresh native review required.');if(review.unconfinedBoot!==true||review.recoveryStartup!==false)throw Error('External review boot category mismatch.');if(review.epoch!==this.#epoch||review.generation!==this.#generation)throw Error('External launch stopped.');
    const history=this.#history(review.revision,review.launchID);
    if(this.#historyBindings.get(review.prepareId)!==digest(history)||!this.#acknowledged(review.revision,history))throw Error('External history changed after launch review.');
    const artifact=this.#artifact(review.revision);
    if(artifact.receiptSHA256!==review.receiptSHA256||artifact.identity!==review.artifactIdentity||digest(this.#runtime())!==digest(review.runtime)||digest(this.#entries.get(review.id))!==review.configFingerprint)throw Error('External review no longer matches artifact, runtime or configuration.');
    const run=path.join(this.#root,'runs',review.launchID);
    for(const name of ['home','tmp','work'])checked(path.join(run,name),{directory:true,privateFrom:this.#root});
    const pending=JSON.parse(checked(path.join(run,'pending.json'),{privateFrom:this.#root,limit:65536}).bytes);
    if(pending.version!==1||pending.kind!=='external-js-launch-pending'||!isDeepStrictEqual(pending.review,review))throw Error('Native pending launch receipt does not match reviewed configuration.');
    return artifact.bytes;
  }
  async commit({prepareId,nonce,fingerprint}={}, {signal}={}){
    const review=this.#prepared.get(prepareId);this.#prepared.delete(prepareId); // consumed before first await, even on failure
    if(!review||review.nonce!==nonce||review.fingerprint!==fingerprint){this.#historyBindings.delete(prepareId);throw Error('Fresh native external approval required.');}
    this.#states.set(review.revision,'connecting');this.#inflight.add(review.revision);
    let admitted=false,abortClose;
    const requireActive=()=>{signal?.throwIfAborted();if(review.epoch!==this.#epoch)throw Error('External launch stopped.');};
    const onAbort=()=>{if(admitted&&!abortClose)abortClose=this.#hub.disconnect(review.id).catch(()=>{});};
    try{
      if(signal!==undefined&&!(signal instanceof AbortSignal))throw Error('Invalid trusted external cancellation signal.');
      signal?.addEventListener('abort',onAbort,{once:true});
      requireActive();this.#bootGate();await this.#gate();requireActive();this.#verify(review);
      const current=(await this.#hub.describe()).servers.find(row=>row.id===review.id);
      requireActive();if(current?.configHash!==review.configHash)throw Error('External MCP config changed after review.');
      let grantIssued=false;
      const result=await this.#hub.connectExternal(review.id,review.configHash,this.#authority,async()=>{
        requireActive();if(grantIssued)throw Error('External launch grant already issued.');grantIssued=true;
        await this.#gate();requireActive();this.#verify(review);
        let unused=true;
        return ()=>{requireActive();if(!unused)throw Error('External launch grant already consumed.');unused=false;const snapshot=this.#verify(review);admitted=true;this.#knownRuns.set(review.launchID,review);this.#ownedPending.add(review.launchID);return snapshot;};
      });
      requireActive();this.#knownRuns.set(review.launchID,review);this.#states.set(review.revision,'connected');
      return {...result,revision:review.revision,launchID:review.launchID,fingerprint,launchState:'connected'};
    }catch(error){
      if(signal?.aborted&&admitted){onAbort();await abortClose;}
      // A failed handshake may follow arbitrary code execution. Never claim clean rollback.
      this.#states.set(review.revision,admitted?'launch-uncertain':'installed-disconnected');
      return {connected:false,revision:review.revision,launchID:review.launchID,fingerprint,launchState:admitted?'launch-uncertain':'not-started',error:String(error.message)};
    }finally{signal?.removeEventListener?.('abort',onAbort);this.#inflight.delete(review.revision);this.#historyBindings.delete(review.prepareId);}
  }
  async disconnect(revision){
    if(!sha(revision))throw Error('Invalid external revision.');
    this.#epoch++;this.#prepared.clear();this.#historyBindings.clear();this.#rearms.clear();
    const result=await this.#hub.disconnect('external-js-'+revision);
    const reviews=[...this.#knownRuns.values()].filter(r=>r.revision===revision);
    for(const r of reviews)this.#ownedPending.delete(r.launchID);
    this.#states.set(revision,'installed-disconnected');
    return {...result,connected:false,revision,closure:reviews.length?this.#closure(reviews.at(-1)):null,message:'Owned provider disconnected; descendant processes and prior effects are not proven terminated.'};
  }
  async stop(){
    this.#epoch++;this.#prepared.clear();this.#historyBindings.clear();this.#rearms.clear();
    const revisions=[...new Set([...this.#entries.keys()].map(id=>id.slice('external-js-'.length)).concat([...this.#knownRuns.values()].map(r=>r.revision)))];
    const results=await Promise.allSettled(revisions.map(async revision=>{await this.#hub.disconnect('external-js-'+revision);const reviews=[...this.#knownRuns.values()].filter(r=>r.revision===revision);for(const r of reviews)this.#ownedPending.delete(r.launchID);this.#states.set(revision,'installed-disconnected');return reviews.map(r=>this.#closure(r));}));
    const closures=results.filter(r=>r.status==='fulfilled').flatMap(r=>r.value),failed=results.some(r=>r.status==='rejected');
    return {stopped:!failed,closures,...(failed?{error:'Some owned external exits remain unconfirmed; no closure was issued for those connections.'}:{})};
  }
  async status(){const live=await this.#hub.describe();return {generation:this.#generation,entries:[...this.#states].map(([revision,state])=>{const connected=state==='connected'&&live.servers.some(row=>row.id==='external-js-'+revision&&row.connected===true);return {revision,state:state==='connected'&&!connected?'installed-disconnected':state,connected};})};}
}
