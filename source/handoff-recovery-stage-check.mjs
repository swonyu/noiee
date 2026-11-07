import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,lstat,realpath,readdir,link,rename,symlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const exec=promisify(execFile),binary=process.env.HANDOFF_FILES_HELPER;
assert(binary,'HANDOFF_FILES_HELPER must name the privately compiled native helper.');
const root=await realpath(await mkdtemp(join(tmpdir(),'handoff-recovery-stage-'))),checks=[];
// execFile has no stdin option; keep one bounded child and write the reviewed JSON.
const call=async(action,input)=>new Promise((resolve,reject)=>{const child=execFile(binary,['--handoff-files',action],{maxBuffer:20*1024*1024,timeout:30000},(error,stdout,stderr)=>{if(error)reject(new Error(stderr||error.message));else{try{resolve(JSON.parse(stdout));}catch(e){reject(e);}}});child.stdin.end(JSON.stringify(input));});
const descriptor=async path=>{const s=await lstat(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)};};
const create=async path=>{await mkdir(path,{mode:0o700});return descriptor(path);};
const clean=({root,stamps,rootStamp})=>({root,stamps,rootStamp});
const content=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['identity','ctime',...(row.kind==='directory'?['nlink']:[])].includes(key)));
const paths=async(root,excluded=[])=>{const names=[];async function walk(part=''){for(const name of (await readdir(join(root.path,part))).sort()){const path=part?part+'/'+name:name;if(name==='.git'||excluded.some(x=>path===x||path.startsWith(x+'/')))continue;names.push(path);if((await lstat(join(root.path,path))).isDirectory())await walk(path);}}await walk();return names;};
const snapshot=async root=>({root,...await call('snapshot',{root,paths:await paths(root)})});
const observe=async f=>call('recoverySnapshot',{roots:await Promise.all(f.roots.map(async(root,i)=>({root,paths:await paths(root,i===0?f.excluded:[])})))});
let api;try{api=await import('./handoff-recovery-stage.mjs');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;api={};}
let sequence=0;
async function fixture(label='destination',{timed=false}={}){
  const dir=join(root,String(++sequence));await mkdir(dir,{mode:0o700});const r={};for(const name of ['live','before','candidate','candidate-before','capture'])r[name]=await create(join(dir,name));
  await mkdir(join(r.live.path,'.git'));await writeFile(join(r.live.path,'.git/sentinel'),'GIT');await mkdir(join(r.live.path,'scratch'));await writeFile(join(r.live.path,'scratch/keep'),'SCRATCH');
  await mkdir(join(r.live.path,'hold'));await mkdir(join(r.live.path,'hold/inner'));await writeFile(join(r.live.path,'hold/inner/ignored'),'IGNORED');
  if(!timed){
    await writeFile(join(r.live.path,'a'),'ORIGINAL');await link(join(r.live.path,'a'),join(r.live.path,'b'));await writeFile(join(r.live.path,'stable'),'UNCHANGED');await writeFile(join(r.live.path,'gone'),'REMOVE AT FINISH');await mkdir(join(r.live.path,'dir'));await writeFile(join(r.live.path,'dir/file'),'ORIGINAL CHILD');await symlink('../original-literal',join(r.live.path,'literal'));
    for(const [base,text] of [[r.live,'original'],[r.candidate,'candidate']]){if(base===r.candidate){await writeFile(join(base.path,'a'),'INCOMING');await link(join(base.path,'a'),join(base.path,'b'));await mkdir(join(base.path,'dir'));await writeFile(join(base.path,'dir/file'),'INCOMING CHILD');await symlink('../incoming-literal',join(base.path,'literal'));await mkdir(join(base.path,'added-empty'));}
      for(const name of ['a','dir','dir/file','literal']){await exec('/usr/bin/xattr',['-s','-w','com.saleh.recovery-stage',label+'-'+text,join(base.path,name)]);await exec('/bin/chmod',['-h','+a','everyone allow read,readattr,readextattr,readsecurity',join(base.path,name)]);}await chmod(join(base.path,'a'),0o751);
    }
  }
  const excluded=['scratch','hold/inner/ignored'],original={root:r.live,...await call('snapshot',{root:r.live,paths:await paths(r.live,excluded)}),ignored:['hold/inner/ignored'],omitted:['scratch']};
  const before={root:r.before,...await call('copy',{source:r.live,destination:r.before,stamps:original.stamps})},candidate=await snapshot(r.candidate),immutable={root:r['candidate-before'],...await call('copy',{source:r.candidate,destination:r['candidate-before'],stamps:candidate.stamps})},capture=await snapshot(r.capture);
  const install=timed?[]:['a','b','dir/file','literal','added-empty'],remove=timed?[]:['gone'];
  const manifest={version:4,[label]:r.live.path,native:{[label]:original},copies:{[label]:before},stages:{[label]:{...candidate,immutable,capture,install,remove,before:original.stamps,beforeRootStamp:original.rootStamp}}};
  const f={dir,label,r,manifest,excluded,temporary:[{cwd:r.live.path,...await descriptor(join(r.live.path,'scratch'))}],roots:[r.live,r.candidate,r.capture]};
  if(!timed){await rename(join(r.live.path,'a'),join(r.capture.path,'00000000'));await rename(join(r.candidate.path,'a'),join(r.live.path,'a'));await writeFile(join(r.live.path,'unexpected'),'UNREVIEWED NEW WORK');}
  return f;
}
async function prepare(f,mode,observed=undefined){
  observed??=await observe(f);const review=api.reviewHandoffRecoveryFiles?.(f.manifest,f.label,mode,observed,{temporary:f.temporary});
  assert(review?.desired?.stamps,'Recovery must derive a complete immutable native target before creating new roots.');
  const stage=await create(join(f.dir,'new-stage-'+sequence)),capture=await create(join(f.dir,'new-capture-'+sequence));
  const result=await api.prepareHandoffRecoveryFiles(review,{stage,capture,native:call,check:()=>{}});return {review,result};
}
async function proof(f,result){
  const receipt=await call('recoverPublish',result.input),projected=api.handoffRecoveryPublishedState(result,receipt);
  const actual=await call('recoverySnapshot',{roots:projected.roots.map(value=>({root:value.root,paths:Object.keys(value.stamps)}))});
  assert.deepEqual(actual.roots,projected.roots);assert.equal(actual.bytes,projected.bytes);
  assert.equal(result.review.bytes,actual.roots[0].bytes,'Review byte count matches the actual selected native state including symlinks and entry xattrs');
  assert.deepEqual(await paths(f.r.live,f.excluded),Object.keys(result.review.desired.stamps).sort());
  for(const [name,row] of Object.entries(result.review.desired.stamps))assert.deepEqual(content(projected.live.stamps[name]),content(row),name+' exact target');
  assert.equal(await readFile(join(f.r.live.path,'.git/sentinel'),'utf8'),'GIT');if(f.temporary.length)assert.equal(await readFile(join(f.r.live.path,'scratch/keep'),'utf8'),'SCRATCH');assert.equal(await readFile(join(f.r.live.path,'hold/inner/ignored'),'utf8'),'IGNORED');
  return {receipt,projected};
}
try{
  const staleScratch=await fixture();staleScratch.temporary=[];staleScratch.excluded=['hold/inner/ignored'];const {result:scratchResult}=await prepare(staleScratch,'restore'),{receipt:scratchReceipt}=await proof(staleScratch,scratchResult);assert(scratchResult.input.remove.includes('scratch'));assert(scratchResult.input.remove.includes('scratch/keep'));assert(!scratchResult.excluded.includes('scratch'));assert.equal(await readFile(join(scratchResult.input.capture.path,scratchReceipt.captured['scratch/keep']),'utf8'),'SCRATCH');checks.push('Old omitted scratch without a fresh identity proof is selected and captured as current work');
  for(const label of ['source','destination'])for(const mode of ['restore','finish']){
    const f=await fixture(label),{result}=await prepare(f,mode),{receipt,projected}=await proof(f,result);
    assert.equal(await readFile(join(f.r.live.path,'a'),'utf8'),mode==='restore'?'ORIGINAL':'INCOMING');assert.equal(await readFile(join(f.r.live.path,'stable'),'utf8'),'UNCHANGED');
    assert.deepEqual(projected.live.stamps.a.identity,projected.live.stamps.b.identity);assert.notDeepEqual(projected.live.stamps.a.identity,f.manifest.copies[label].stamps.a.identity);
    assert.equal(await readFile(join(result.input.capture.path,receipt.captured.unexpected),'utf8'),'UNREVIEWED NEW WORK');
    assert.equal(!!projected.live.stamps.gone,mode==='restore');assert.equal(!!projected.live.stamps['added-empty'],mode==='finish');
    await writeFile(join(f.dir,'proof.json'),JSON.stringify({result,receipt,projected},null,2));checks.push(label+' '+mode+': partial forward stage, split hardlinks, complete immutable target, exact native metadata, new work retained');
    for(const name of ['dir','dir/file']){const clock=structuredClone(receipt);clock.retained[0].stamps[name].ctime='1:0';assert.throws(()=>api.handoffRecoveryPublishedState(result,clock),/Invalid|recovery/i,'Unrelated witness ctime must remain exact: '+name);}
    for(const fault of ['live','capture','retained','topology','root','slot','slot permutation']){const bad=structuredClone(receipt);if(fault==='live')bad.live.a.sha256='0'.repeat(64);if(fault==='capture')delete bad.capture[bad.captured.unexpected];if(fault==='retained')bad.retained[0].stamps.b.mode^=1;if(fault==='topology')bad.live.b.identity.ino='1234567';if(fault==='root')bad.liveRootStamp.mode^=1;if(fault==='slot')bad.captured.unexpected='99999999';if(fault==='slot permutation'){const [a,b]=Object.keys(bad.captured),x=bad.captured[a],y=bad.captured[b];[bad.captured[a],bad.captured[b]]=[y,x];[bad.capture[x],bad.capture[y]]=[bad.capture[y],bad.capture[x]];}assert.throws(()=>api.handoffRecoveryPublishedState(result,bad),/Invalid|recovery/i,fault+' receipt must reject');}
  }
  const timed=await fixture('source',{timed:true});await exec('/usr/bin/touch',['-m','-t','203001010101',join(timed.r.live.path,'hold/inner'),join(timed.r.live.path,'hold'),timed.r.live.path]);
  const untouched=await call('snapshot',{root:timed.r.live,paths:['hold','hold/inner','hold/inner/ignored','scratch','scratch/keep']});const {result:timeResult}=await prepare(timed,'restore'),{receipt:timeReceipt}=await proof(timed,timeResult);
  assert.deepEqual(timeResult.input.install,[]);assert.deepEqual(timeResult.input.remove,[]);assert.deepEqual(timeReceipt.capture,{});assert.deepEqual(timeReceipt.remainingStage,{});
  const after=await call('snapshot',{root:timed.r.live,paths:['hold','hold/inner','hold/inner/ignored','scratch','scratch/keep']});for(const path of ['hold/inner/ignored','scratch','scratch/keep'])assert.deepEqual(after.stamps[path],untouched.stamps[path]);checks.push('Retained nested directory time-only restoration leaves ignored child and scratch exact with empty stage/capture');
  for(const fault of ['immutable','original','stale live','stale witness','capture occupied','root metadata','excluded ancestor','legacy finish','capacity','stop']){
    const f=await fixture(),observed=await observe(f),beforeNames=await readdir(f.dir);
    if(fault==='root metadata'){await exec('/usr/bin/xattr',['-w','com.saleh.changed-root','NEW ROOT METADATA',f.r.live.path]);const changed=await observe(f);assert.throws(()=>api.reviewHandoffRecoveryFiles(f.manifest,f.label,'restore',changed),/root.*metadata/i);}
    else if(fault==='excluded ancestor'){await chmod(join(f.r.live.path,'hold'),0o700);const changed=await observe(f);assert.throws(()=>api.reviewHandoffRecoveryFiles(f.manifest,f.label,'restore',changed),/excluded|ignored/i);}
    else if(fault==='legacy finish'){delete f.manifest.stages[f.label].immutable;f.manifest.version=3;assert.throws(()=>api.reviewHandoffRecoveryFiles(f.manifest,f.label,'finish',observed),/immutable|legacy/i);const {result}=await prepare(f,'restore');await proof(f,result);}
    else if(fault==='capacity'){observed.roots.push(...Array.from({length:5},()=>observed.roots[1]));assert.throws(()=>api.reviewHandoffRecoveryFiles(f.manifest,f.label,'restore',observed),/capacity|witness|roots/i);assert.deepEqual(await readdir(f.dir),beforeNames);}
    else {
      const review=api.reviewHandoffRecoveryFiles(f.manifest,f.label,'finish',observed),stage=await create(join(f.dir,'reject-stage')),capture=await create(join(f.dir,'reject-capture'));
      if(fault==='immutable')await writeFile(join(f.r['candidate-before'].path,'a'),'CORRUPTED IMMUTABLE');if(fault==='original')await writeFile(join(f.r.before.path,'stable'),'CORRUPTED ORIGINAL');if(fault==='stale live')await writeFile(join(f.r.live.path,'unexpected'),'NEWER WORK');if(fault==='stale witness')await writeFile(join(f.r.capture.path,'00000000'),'NEWER WITNESS');if(fault==='capture occupied')await writeFile(join(capture.path,'keep'),'KEEP');
      let calls=0;await assert.rejects(api.prepareHandoffRecoveryFiles(review,{stage,capture,native:async(...args)=>{calls++;return call(...args);},check:()=>{if(fault==='stop')throw Error('Stopped before native staging');}}),/changed|immutable|donor|contents|empty|Stopped|input|preserved/i,fault);assert.deepEqual(await readdir(stage.path),[]);if(fault==='stop')assert.equal(calls,0);
    }checks.push('Refused '+fault+' before live effects');
  }
  // Model a second interruption by exclusively moving one live alias to the first
  // recovery capture, then one staged alias into live. Every root is retained.
  const repeated=await fixture(),{result:first}=await prepare(repeated,'restore');
  await rename(join(repeated.r.live.path,'a'),join(first.input.capture.path,'00000000'));await rename(join(first.input.stage.path,'a'),join(repeated.r.live.path,'a'));repeated.roots.push(first.input.stage,first.input.capture);
  const again=await observe(repeated);sequence++;const {result:second}=await prepare(repeated,'finish',again),{projected:secondProof}=await proof(repeated,second);assert.equal(secondProof.retained.length,4);assert.equal(await readFile(join(repeated.r.live.path,'a'),'utf8'),'INCOMING');checks.push('Repeated recovery accounts for original plus partial prior recovery stage/capture hardlink witnesses');
  repeated.roots.push(second.input.stage,second.input.capture);sequence++;const {result:third}=await prepare(repeated,'restore'),{projected:thirdProof}=await proof(repeated,third);assert.equal(thirdProof.roots.length,9);assert.equal(thirdProof.retained.length,6);repeated.roots.push(third.input.stage,third.input.capture);const full=await observe(repeated);assert.throws(()=>api.reviewHandoffRecoveryFiles(repeated.manifest,repeated.label,'finish',full),/capacity/i);checks.push('Nine roots and six retained witnesses complete; another recovery refuses before creating roots');
  const unicode=await fixture();for(const name of ['e\u0301','z','\uE000','\u{10000}','__proto__','constructor'])await writeFile(join(unicode.r.live.path,name),'NEW '+name);const {result:unicodeResult}=await prepare(unicode,'restore'),{receipt:unicodeReceipt}=await proof(unicode,unicodeResult);assert.deepEqual(unicodeReceipt.captured,unicodeResult.captured);const utf8=Object.keys(unicodeResult.captured).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));assert(utf8.indexOf('e\u0301')<utf8.indexOf('z'));assert(utf8.indexOf('\uE000')<utf8.indexOf('\u{10000}'));checks.push('Durable UTF-8 slot mapping agrees with real recovery helper for decomposed, non-BMP, PUA and literal object-property names');
  for(const fault of ['late live','late witness','late capture']){const f=await fixture(),{result}=await prepare(f,'finish');if(fault==='late live')await writeFile(join(f.r.live.path,'unexpected'),'LATE LIVE');if(fault==='late witness')await exec('/usr/bin/xattr',['-w','com.saleh.late','LATE WITNESS',f.r.candidate.path]);if(fault==='late capture')await writeFile(join(result.input.capture.path,'keep'),'LATE CAPTURE');const liveBefore=await observe(f),stageBefore=await snapshot(result.input.stage),captureNames=await readdir(result.input.capture.path);await assert.rejects(call('recoverPublish',result.input),/changed|pre-existing|concurrent|preserved/i);assert.deepEqual(await observe(f),liveBefore);assert.deepEqual(await snapshot(result.input.stage),stageBefore);assert.deepEqual(await readdir(result.input.capture.path),captureNames);checks.push('Native publication refuses '+fault+' after preparation without consuming stage or live entries');}
  const stopped=await fixture(),stopReview=api.reviewHandoffRecoveryFiles(stopped.manifest,stopped.label,'finish',await observe(stopped)),stopStage=await create(join(stopped.dir,'stop-stage')),stopCapture=await create(join(stopped.dir,'stop-capture')),actions=[];await assert.rejects(api.prepareHandoffRecoveryFiles(stopReview,{stage:stopStage,capture:stopCapture,native:async(...args)=>{actions.push(args[0]);return call(...args);},check:()=>{if(actions.length===3)throw Error('Stopped after immutable donor checks');}}),/Stopped/);assert(!actions.includes('materialize'));assert.deepEqual(await readdir(stopStage.path),[]);assert.deepEqual(await readdir(stopCapture.path),[]);checks.push('Stop between native reads prevents materialization and preserves empty private roots');
  const evidence={passed:true,root,binary,checks};await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
}catch(error){await writeFile(join(root,'evidence.json'),JSON.stringify({passed:false,root,binary,checks,error:error.stack},null,2)+'\n');console.error('Evidence: '+join(root,'evidence.json'));throw error;}
