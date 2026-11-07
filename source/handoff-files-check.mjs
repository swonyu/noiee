import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {watch} from 'node:fs';
import {mkdtemp, mkdir, writeFile, readFile, lstat, symlink, link, rename, chmod, readdir, realpath,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const sourceCode = dirname(fileURLToPath(import.meta.url));
const fixture = await realpath(await mkdtemp(join(tmpdir(), 'handoff-files-')));
const binary = join(fixture, 'handoff-files');
const processResult = (bin, args, input) => spawnSync(bin,args,{input,encoding:'utf8',maxBuffer:20*1024*1024});
function run(bin,args,input) {const r=processResult(bin,args,input);assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout;}
await writeFile(join(fixture,'main.swift'),`import Foundation
import Darwin
// Replace the selected regular file after its saved stat, before the real descriptor open.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--fifo-open-check" {
    do {
        let path=CommandLine.arguments[2], leaf=path+"/entry"
        let parent=open(path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
        precondition(parent >= 0)
        defer {close(parent)}
        try Data("reviewed".utf8).write(to:URL(fileURLWithPath:leaf))
        let reviewed=try CodingTemporary.namedInfo(parent,"entry")
        precondition(unlinkat(parent,"entry",0) == 0 && mkfifo(leaf,0o600) == 0)
        FileHandle.standardError.write(Data("Opening replaced FIFO\\n".utf8))
        let fd=try HandoffFiles.opened(parent,"entry",reviewed)
        close(fd);fatalError("replacement FIFO accepted")
    } catch {FileHandle.standardError.write(Data("\\(error)\\n".utf8));exit(1)}
}
// Native document tracking probe, entirely inside the disposable fixture.
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--tracked-rename-check" {
    do {
        let root=CommandLine.arguments[2],live=open(root+"/live",O_RDONLY|O_DIRECTORY),capture=open(root+"/capture",O_RDONLY|O_DIRECTORY)
        precondition(live >= 0 && capture >= 0);defer{close(live);close(capture)}
        func flags(_ label:String) throws {print(label,try CodingTemporary.namedInfo(capture,"00000000").st_flags)}
        precondition(renameatx_np(live,"item",capture,"00000000",UInt32(RENAME_EXCL)) == 0)
        try flags("renamed")
        var budget=0;_ = try HandoffFiles.stamp(capture,"00000000",&budget);try flags("captured stamp")
        precondition(mkdirat(live,"item",0o700) == 0);try flags("new directory")
        _ = try HandoffFiles.stamp(live,"item",&budget);try flags("directory stamp")
        precondition(fsync(live) == 0);try flags("parent sync")
        exit(0)
    } catch {FileHandle.standardError.write(Data("\\(error)\\n".utf8));exit(1)}
}
// Disposable harness exercises the real bounded-copy callback with a reviewed smaller size.
if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--growth-check" {
    do {
        let source=open(CommandLine.arguments[2],O_RDONLY|O_NOFOLLOW)
        let target=open(CommandLine.arguments[3],O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600)
        precondition(source >= 0 && target >= 0)
        defer {close(source);close(target)}
        var reviewed=try CodingTemporary.info(source)
        reviewed.st_size=1048576
        do {try HandoffFiles.requireReviewed(try CodingTemporary.info(source),HandoffFiles.header(reviewed));fatalError("growth header accepted")}
        catch {print("Header rejected growth")}
        var attributeBudget=0
        let actualAttributes=try HandoffFiles.attributes(source,try CodingTemporary.info(source),&attributeBudget)
        guard actualAttributes.storage.isEmpty else {throw HandoffFiles.fail("Growth fixture requires absent managed storage")}
        let copyReview=HandoffFiles.header(reviewed).merging(actualAttributes.stamp){_,new in new}
        try HandoffFiles.copyEntry(source,target,reviewed,reviewed:copyReview,directory:false)
        fatalError("growth byte limit accepted")
    } catch {FileHandle.standardError.write(Data("\\(error)\\n".utf8));exit(1)}
}
exit(HandoffFiles.command(CommandLine.arguments))
`);
run('/usr/bin/swiftc',['-O',join(sourceCode,'CodingTemporary.swift'),join(sourceCode,'HandoffFiles.swift'),join(fixture,'main.swift'),'-o',binary]);
const fifoRoot=join(fixture,'fifo-replacement');await mkdir(fifoRoot);
const fifoStarted=performance.now();
const fifo=spawnSync(binary,['--fifo-open-check',fifoRoot],{encoding:'utf8',timeout:1500,killSignal:'SIGKILL'});
const fifoEvidence={elapsedMs:Math.round(performance.now()-fifoStarted),status:fifo.status,signal:fifo.signal,error:fifo.error?.code??null,stderr:fifo.stderr};
await writeFile(join(fixture,'fifo-open-evidence.json'),JSON.stringify(fifoEvidence,null,2)+'\n');
assert.equal(fifo.error,undefined,`FIFO replacement blocked: ${JSON.stringify({fixture,...fifoEvidence})}`);
assert.equal(fifo.status,1);assert.match(fifo.stderr,/Opening replaced FIFO/);assert.match(fifo.stderr,/Selected entry changed while opening/);
const descriptor = async path => {const s=await lstat(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)};};
const request = (action,input) => JSON.parse(run(binary,['--handoff-files',action],JSON.stringify(input)));
const bindRoots = f => {for(const [root,key] of [['root','beforeRootStamp'],['stage','stagedRootStamp'],['capture','captureRootStamp']])f[key]=request('snapshot',{root:f[root],paths:[]}).rootStamp;return f;};
const reject = (action,input,pattern) => {const r=processResult(binary,['--handoff-files',action],JSON.stringify(input));assert.notEqual(r.status,0);if(pattern)assert.match(r.stderr,pattern);};
// Only new setup leaves may be added to a freshly created checkout.
{
  const src=join(fixture,'local-source'),dst=join(fixture,'local-destination');await mkdir(src,{mode:0o700});await mkdir(dst,{mode:0o700});
  for(const dir of [src,dst])await mkdir(join(dir,'config'),{mode:0o750});
  await writeFile(join(src,'config/setup'),'SETUP');await writeFile(join(dst,'config/tracked'),'KEEP TRACKED');await writeFile(join(dst,'.git'),'gitdir: retained');
  const source=await descriptor(src),destination=await descriptor(dst),selected=['config','config/setup'],review=request('snapshot',{root:source,paths:selected});
  const before=await descriptor(join(dst,'config'));run('/usr/bin/xattr',['-w','com.saleh.localsetup','keep',join(dst,'config')]);
  const out=request('copyLocal',{source,destination,stamps:review.stamps});assert.equal(await readFile(join(dst,'config/setup'),'utf8'),'SETUP');assert.equal(await readFile(join(dst,'config/tracked'),'utf8'),'KEEP TRACKED');assert.deepEqual(await descriptor(join(dst,'config')),before);assert.equal(run('/usr/bin/xattr',['-p','com.saleh.localsetup',join(dst,'config')]).trim(),'keep');
  assert.equal(out.stamps['config/setup'].sha256,review.stamps['config/setup'].sha256);reject('copyLocal',{source,destination,stamps:review.stamps},/Create staged file|exist/i);assert.equal(await readFile(join(dst,'config/setup'),'utf8'),'SETUP');
  const unsafe=join(fixture,'local-unsafe');await mkdir(unsafe,{mode:0o700});await symlink(src,join(unsafe,'config'));reject('copyLocal',{source,destination:await descriptor(unsafe),stamps:review.stamps},/directory|symbolic|ancestor/i);assert.equal(await readFile(join(src,'config/setup'),'utf8'),'SETUP');
  reject('copy',{source,destination,stamps:review.stamps},/entries|content|empty|pre-existing/i);
}
// A new no-checkout target has exactly its regular .git link; copied leaves are exclusive.
{
  const src=join(fixture,'checkout-source'),dst=join(fixture,'checkout-target');await mkdir(src,{mode:0o700});await mkdir(dst,{mode:0o700});await mkdir(join(src,'folder'));await mkdir(join(src,'empty'));
  await writeFile(join(src,'folder/file'),'WORKING BYTES');await link(join(src,'folder/file'),join(src,'linked'));await symlink('../outside-literal',join(src,'literal'));await writeFile(join(dst,'.git'),'gitdir: new-private-registration\n');
  const source=await descriptor(src),destination=await descriptor(dst),names=['folder','folder/file','linked','literal','empty'],review=request('snapshot',{root:source,paths:names}),gitLink=await readFile(join(dst,'.git'));
  const out=request('copyCheckout',{source,destination,stamps:review.stamps});assert.equal(await readFile(join(dst,'folder/file'),'utf8'),'WORKING BYTES');assert.equal((await lstat(join(dst,'linked'))).ino,(await lstat(join(dst,'folder/file'))).ino);assert((await lstat(join(dst,'literal'))).isSymbolicLink());assert((await lstat(join(dst,'empty'))).isDirectory());assert.deepEqual(await readFile(join(dst,'.git')),gitLink);assert.equal(out.stamps['folder/file'].sha256,review.stamps['folder/file'].sha256);
  reject('copyCheckout',{source,destination,stamps:review.stamps},/entries|content|pre-existing/i);assert.equal(await readFile(join(dst,'folder/file'),'utf8'),'WORKING BYTES');
  for(const kind of ['directory','symlink','occupied']){const path=join(fixture,'checkout-'+kind);await mkdir(path,{mode:0o700});if(kind==='directory')await mkdir(join(path,'.git'));else if(kind==='symlink')await symlink(join(dst,'.git'),join(path,'.git'));else{await writeFile(join(path,'.git'),'gitdir: new');await writeFile(join(path,'folder'),'KEEP OCCUPIED');}reject('copyCheckout',{source,destination:await descriptor(path),stamps:review.stamps},/Git link|entries|content|pre-existing/i);if(kind==='occupied')assert.equal(await readFile(join(path,'folder'),'utf8'),'KEEP OCCUPIED');}
  assert.deepEqual(request('snapshot',{root:source,paths:names}),review);reject('copyLocal',{source,destination,stamps:review.stamps},/regular files|real directories/i);
}
async function materializationChecks(){
  const dirs=Object.fromEntries(['donor0','donor1','payload','output'].map(k=>[k,join(fixture,'materialize-'+k)]));for(const dir of Object.values(dirs))await mkdir(dir,{mode:0o700});
  await mkdir(join(dirs.donor0,'folder'));await mkdir(join(dirs.donor0,'empty'));await writeFile(join(dirs.donor0,'folder/file'),'OLD');await link(join(dirs.donor0,'folder/file'),join(dirs.donor0,'linked'));await symlink('old-target',join(dirs.donor0,'literal'));
  await writeFile(join(dirs.donor1,'second'),'SECOND');
  for(const path of [join(dirs.donor0,'folder'),join(dirs.donor0,'empty'),join(dirs.donor0,'folder/file'),join(dirs.donor0,'literal')]){run('/usr/bin/xattr',['-s','-wx','com.saleh.materialize','0001ff',path]);run('/bin/chmod',['-h','+a','everyone allow read,readattr,readextattr,readsecurity',path]);}
  run('/usr/bin/xattr',['-wx','com.apple.ResourceFork','00ff',join(dirs.donor0,'folder/file')]);run('/usr/bin/xattr',['-w','com.apple.quarantine','0081;60000000;MaterializeProbe;',join(dirs.donor0,'folder/file')]);
  for(const path of [join(dirs.donor0,'folder/file'),join(dirs.donor1,'second')])run('/usr/bin/chflags',['0100',path]);
  for(const [name,bytes] of Object.entries({merged:'MERGED',restored:'RESTORED',target:'../outside-literal'}))await writeFile(join(dirs.payload,name),bytes);
  run('/usr/bin/xattr',['-w','com.saleh.payload','DO NOT COPY',join(dirs.payload,'restored')]);
  const review=async(path,paths)=>{const root=await descriptor(path);return {root,...request('snapshot',{root,paths})};};
  const donors=[await review(dirs.donor0,['folder','folder/file','linked','empty','literal']),await review(dirs.donor1,['second'])],payload=await review(dirs.payload,['merged','restored','target']);
  const clean=r=>({root:r.root,stamps:r.stamps,rootStamp:r.rootStamp});
  const input={destination:await descriptor(dirs.output),donors:donors.map(clean),payload:clean(payload),timestamp:'1700000000:123456789',entries:{folder:{kind:'directory',donor:0},'folder/file':{kind:'file',donor:0,payload:'merged',mode:0o751},linked:{kind:'file',donor:0,payload:'merged',mode:0o751},empty:{kind:'directory',donor:0},literal:{kind:'symlink',donor:0,payload:'target'},second:{kind:'file',donor:1},newdir:{kind:'directory',mode:0o755},'newdir/restored':{kind:'file',payload:'restored',mode:0o755},'newdir/link':{kind:'symlink',payload:'target',mode:0o777}}};
  await writeFile(join(fixture,'materialize-input.json'),JSON.stringify(input,null,2));const attempt=processResult(binary,['--handoff-files','materialize'],JSON.stringify(input));await writeFile(join(fixture,'materialize-attempt.json'),JSON.stringify({status:attempt.status,stdout:attempt.stdout,stderr:attempt.stderr},null,2));assert.equal(attempt.status,0,attempt.stderr);
  const out=JSON.parse(attempt.stdout);assert.equal(await readFile(join(dirs.output,'folder/file'),'utf8'),'MERGED');assert.equal(await readFile(join(dirs.output,'newdir/restored'),'utf8'),'RESTORED');assert.equal((await lstat(join(dirs.output,'folder/file'))).ino,(await lstat(join(dirs.output,'linked'))).ino);
  for(const name of ['folder/file','literal']){const row=out.stamps[name],original=donors[0].stamps[name];for(const key of ['birthtime','flags','uid','gid','xattrs','acl'])assert.deepEqual(row[key],original[key],name+' '+key);assert.equal(row.mtime,input.timestamp);}
  assert.equal(out.stamps['folder/file'].mode,0o751);assert.equal(out.stamps.literal.targetBase64,Buffer.from('../outside-literal').toString('base64'));
  for(const name of ['newdir','newdir/restored','newdir/link']){const row=out.stamps[name];assert.equal(row.birthtime,input.timestamp);assert.equal(row.mtime,input.timestamp);assert.equal(row.mode,input.entries[name].mode);assert(Object.keys(row.xattrs).every(name=>name==='com.apple.provenance'));assert.equal(row.acl,null);assert.equal(row.uid,process.getuid());assert.equal(row.gid,process.getgid());}
  for(const [i,donor] of donors.entries())assert.deepEqual(request('snapshot',{root:donor.root,paths:Object.keys(donor.stamps)}),{stamps:donor.stamps,bytes:donor.bytes,rootStamp:donor.rootStamp},'unchanged donor '+i);
  assert.deepEqual(request('snapshot',{root:payload.root,paths:Object.keys(payload.stamps)}),{stamps:payload.stamps,bytes:payload.bytes,rootStamp:payload.rootStamp});
  assert.deepEqual(request('snapshot',{root:input.destination,paths:Object.keys(input.entries)}),out);
  const freshOutput=async label=>{const path=join(fixture,'materialize-'+label);await mkdir(path,{mode:0o700});return descriptor(path);};
  const exact={...input,destination:await freshOutput('exact-donor'),entries:Object.fromEntries(Object.entries(donors[0].stamps).map(([name,row])=>[name,{kind:row.kind,donor:0}]))};const exactCopy=request('materialize',exact);assert.equal(exactCopy.stamps.literal.targetBase64,donors[0].stamps.literal.targetBase64);assert.equal(exactCopy.stamps.literal.mtime,donors[0].stamps.literal.mtime);assert.equal(await readFile(join(exact.destination.path,'folder/file'),'utf8'),'OLD');assert.equal((await lstat(join(exact.destination.path,'folder/file'))).ino,(await lstat(join(exact.destination.path,'linked'))).ino);assert.deepEqual(await readdir(join(exact.destination.path,'empty')),[]);
  const projected={...input,destination:await freshOutput('projected'),entries:{linked:{kind:'file',donor:0}}};const projection=request('materialize',projected);assert.equal(projection.stamps.linked.nlink,1);assert.notDeepEqual(projection.stamps.linked.identity,donors[0].stamps.linked.identity);assert.equal(await readFile(join(projected.destination.path,'linked'),'utf8'),'OLD');
  const synthetic={...input,donors:[],destination:await freshOutput('synthetic'),entries:{restored:{kind:'file',payload:'restored',mode:0o644},link:{kind:'symlink',payload:'target',mode:0o777},dir:{kind:'directory',mode:0o700}}};assert.equal(Object.keys(request('materialize',synthetic).stamps).length,3);
  const empty={...input,donors:[],destination:await freshOutput('empty'),entries:{}};assert.deepEqual(request('materialize',empty).stamps,{});
  const rejected=[];
  for(const fault of ['missing donor','kind mismatch','group decisions','incomplete donor review','missing payload','occupied output','wrong output identity','extra entry key','boolean mode','nondirectory ancestor','donor root stamp']){
    const f=structuredClone(input);f.destination=await freshOutput('reject-'+fault.replaceAll(' ','-'));
    if(fault==='missing donor')f.entries={missing:{kind:'file',donor:0}};
    if(fault==='kind mismatch')f.entries={literal:{kind:'file',donor:0}};
    if(fault==='group decisions')f.entries.linked.payload='restored';
    if(fault==='incomplete donor review')delete f.donors[0].stamps.linked;
    if(fault==='missing payload')f.entries['folder/file'].payload='missing';
    if(fault==='occupied output')await writeFile(join(f.destination.path,'keep'),'KEEP');
    if(fault==='wrong output identity')f.destination.ino='1';
    if(fault==='extra entry key')f.entries.second.unreviewed=true;
    if(fault==='boolean mode')f.entries.second.mode=true;
    if(fault==='nondirectory ancestor')f.entries.folder={kind:'file',payload:'merged',mode:0o644};
    if(fault==='donor root stamp')f.donors[0].rootStamp.mtime='0:0';
    const contents=await readdir(f.destination.path),r=spawnSync(binary,['--handoff-files','materialize'],{input:JSON.stringify(f),encoding:'utf8',timeout:3000,killSignal:'SIGKILL'});assert.equal(r.error,undefined,fault);assert.equal(r.status,1,fault);assert.deepEqual(await readdir(f.destination.path),contents,fault+' must fail before output');rejected.push(fault);
  }
  for(const fault of ['stale payload','replaced payload','FIFO payload','NUL symlink','empty symlink','long symlink','extra payload']){
    const path=join(fixture,'materialize-'+fault.replaceAll(' ','-'));await mkdir(path,{mode:0o700});await writeFile(join(path,'blob'),fault==='NUL symlink'?Buffer.from([65,0,66]):fault==='empty symlink'?'':fault==='long symlink'?'x'.repeat(4097):'ORIGINAL');
    const r=await review(path,['blob']),f={...input,donors:[],destination:await freshOutput('fault-output-'+fault.replaceAll(' ','-')),payload:clean(r),entries:{file:{kind:fault.includes('symlink')?'symlink':'file',payload:'blob',mode:fault.includes('symlink')?0o777:0o644}}};
    if(fault==='stale payload')await writeFile(join(path,'blob'),'CHANGED');
    if(fault==='replaced payload'||fault==='FIFO payload'){await rename(join(path,'blob'),path+'-retained-original');if(fault==='FIFO payload')run('/usr/bin/mkfifo',[join(path,'blob')]);else await writeFile(join(path,'blob'),'ORIGINAL');}
    if(fault==='extra payload')await writeFile(join(path,'extra'),'UNREVIEWED');
    const result=spawnSync(binary,['--handoff-files','materialize'],{input:JSON.stringify(f),encoding:'utf8',timeout:1500,killSignal:'SIGKILL'});assert.equal(result.error,undefined,fault+' must not block');assert.equal(result.status,1,fault);assert.deepEqual(await readdir(f.destination.path),[],fault);rejected.push(fault);
  }
  const stopPayload=join(fixture,'materialize-stop-payload');await mkdir(stopPayload,{mode:0o700});await writeFile(join(stopPayload,'large'),Buffer.alloc(24*1024*1024,88));run('/usr/bin/chflags',['0100',join(stopPayload,'large')]);const stopReview=await review(stopPayload,['large']);
  const stopped={...input,donors:[],payload:clean(stopReview),destination:await freshOutput('stopped'),entries:{large:{kind:'file',payload:'large',mode:0o644}}};
  await new Promise((resolve,reject)=>{const child=spawn(binary,['--handoff-files','materialize'],{stdio:['pipe','pipe','pipe']});let killed=false,stderr='';child.stdout.resume();child.stderr.on('data',b=>stderr+=b);const poll=setInterval(async()=>{if(!killed&&(await readdir(stopped.destination.path)).includes('large'))killed=child.kill('SIGKILL');},2),timer=setTimeout(()=>child.kill('SIGKILL'),10000);child.once('error',reject);child.once('close',async(code,signal)=>{clearInterval(poll);clearTimeout(timer);try{await writeFile(join(fixture,'materialize-stop-evidence.json'),JSON.stringify({code,signal,killed,stderr},null,2));assert(killed,stderr);assert.equal(signal,'SIGKILL');resolve();}catch(e){reject(e);}});child.stdin.end(JSON.stringify(stopped));});
  assert((await readdir(stopped.destination.path)).length>0);assert.deepEqual(request('snapshot',{root:stopReview.root,paths:['large']}),{stamps:stopReview.stamps,bytes:stopReview.bytes,rootStamp:stopReview.rootStamp});
  for(const donor of donors)assert.deepEqual(request('snapshot',{root:donor.root,paths:Object.keys(donor.stamps)}),{stamps:donor.stamps,bytes:donor.bytes,rootStamp:donor.rootStamp});
  assert.deepEqual(request('snapshot',{root:payload.root,paths:Object.keys(payload.stamps)}),{stamps:payload.stamps,bytes:payload.bytes,rootStamp:payload.rootStamp});
  const probe=join(fixture,'materialize-provenance-probe');await writeFile(probe,'PROVENANCE');const prior=processResult('/usr/bin/xattr',['-px','com.apple.provenance',probe]),removed=processResult('/usr/bin/xattr',['-d','com.apple.provenance',probe]),after=processResult('/usr/bin/xattr',['-px','com.apple.provenance',probe]);const provenance={before:prior.stdout,removeStatus:removed.status,after:after.stdout,retainedAfterRemove:prior.status===0&&after.status===0&&prior.stdout===after.stdout};await writeFile(probe+'-evidence.json',JSON.stringify(provenance,null,2));
  const evidence={passed:true,fixture,entries:Object.keys(input.entries).length,donors:donors.length,provenance,projectedHardlinks:'one selected leaf has new inode/nlink1; original donor pair remains nlink2',synthesized:'zero donors and empty selection verified',rejected,interruption:'SIGKILL retains candidate partial and unchanged payload'};await writeFile(join(fixture,'materialize-evidence.json'),JSON.stringify(evidence,null,2));return evidence;
}
if(process.env.HANDOFF_FILES_CHECK==='materialize'){console.log(JSON.stringify(await materializationChecks(),null,2));process.exit(0);}
async function publicationChecks(){
  const live=join(fixture,'publish-live'),incoming=join(fixture,'publish-stage'),capture=join(fixture,'publish-capture');
  for(const dir of [live,incoming,capture])await mkdir(dir,{mode:0o700});
  await mkdir(join(live,'.git'));await writeFile(join(live,'.git','keep'),'git metadata');await mkdir(join(live,'folder'));await mkdir(join(live,'removed'));
  await writeFile(join(live,'folder','file'),'OLD');await link(join(live,'folder','file'),join(live,'old-link'));await writeFile(join(live,'folder','unrelated'),'UNRELATED');await writeFile(join(live,'deleted'),'DELETE');
  await mkdir(join(incoming,'folder'));await mkdir(join(incoming,'newdir'));await writeFile(join(incoming,'folder','file'),'NEW');await link(join(incoming,'folder','file'),join(incoming,'newdir','link'));await symlink('../literal-outside',join(incoming,'symlink'));
  for(const path of [join(live,'folder'),join(incoming,'folder/file'),join(incoming,'newdir'),join(incoming,'symlink')]){run('/usr/bin/xattr',['-s','-wx','com.saleh.publication','0001ff',path]);run('/bin/chmod',['-h','+a','everyone allow read,readattr,readextattr,readsecurity',path]);}
  run('/usr/bin/xattr',['-w','com.apple.quarantine','0081;60000000;PublishProbe;',join(incoming,'folder/file')]);run('/usr/bin/xattr',['-wx','com.apple.ResourceFork','00ff012a',join(incoming,'folder/file')]);
  for(const path of ['folder/file','old-link','deleted'])run('/usr/bin/chflags',['0100',join(live,path)]);
  for(const path of ['folder/file','newdir/link'])run('/usr/bin/chflags',['0100',join(incoming,path)]);
  const root=await descriptor(live),stage=await descriptor(incoming),capt=await descriptor(capture),git=await descriptor(join(live,'.git'));
  const before=request('snapshot',{root,paths:['folder','folder/file','old-link','deleted','removed']}).stamps,staged=request('snapshot',{root:stage,paths:['folder','folder/file','newdir','newdir/link','symlink']}).stamps;
  const rootTime=(await lstat(live,{bigint:true})).mtimeNs;
  const input=bindRoots({root,stage,capture:capt,before,staged,install:['folder/file','newdir','newdir/link','symlink'],remove:['old-link','deleted','removed']});
  const result=processResult(binary,['--handoff-files','publish'],JSON.stringify(input));await writeFile(join(fixture,'publish-attempt.json'),JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr},null,2));assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(result.stdout);assert.deepEqual(await descriptor(live),root);assert.deepEqual(await descriptor(join(live,'.git')),git);assert.equal((await lstat(live,{bigint:true})).mtimeNs,rootTime);
  for(const [root,key] of [[input.root,'liveRootStamp'],[input.stage,'remainingStageRootStamp'],[input.capture,'captureRootStamp']])assert.deepEqual(receipt[key],request('snapshot',{root,paths:[]}).rootStamp);
  assert.equal(await readFile(join(live,'folder/unrelated'),'utf8'),'UNRELATED');assert.equal(await readFile(join(live,'folder/file'),'utf8'),'NEW');assert.equal((await lstat(join(live,'folder/file'))).ino,(await lstat(join(live,'newdir/link'))).ino);
  for(const name of input.install){const actual=receipt.live[name],expected=staged[name];for(const key of ['kind','mode','uid','gid','flags','mtime','birthtime','xattrs','acl','sha256','targetBase64'])assert.deepEqual(actual[key],expected[key],name+' '+key);}
  for(const key of ['mode','flags','mtime','birthtime','xattrs','acl'])assert.deepEqual(receipt.live.folder[key],before.folder[key],key);
  for(const name of ['folder/file','old-link','deleted','removed']){const slot=receipt.captured[name];assert(slot);assert.deepEqual(receipt.capture[slot].identity,before[name].identity);if(before[name].kind==='file')assert.equal(receipt.capture[slot].sha256,before[name].sha256);}
  assert.deepEqual(Object.keys(receipt.remainingStage).sort(),['folder','newdir']);assert.equal(await readFile(join(capture,receipt.captured['folder/file']),'utf8'),'OLD');
  await writeFile(join(fixture,'publish-receipt.json'),JSON.stringify(receipt,null,2));
  const fresh=async name=>{const dirs=['live','stage','capture'].map(part=>join(fixture,name+'-'+part));for(const dir of dirs)await mkdir(dir,{mode:0o700});return {root:await descriptor(dirs[0]),stage:await descriptor(dirs[1]),capture:await descriptor(dirs[2]),before:{},staged:{},install:[],remove:[]};};
  const reviewed=async f=>{const paths=await readdir(f.root.path),staged=await readdir(f.stage.path);f.before=request('snapshot',{root:f.root,paths}).stamps;f.staged=request('snapshot',{root:f.stage,paths:staged}).stamps;return bindRoots(f);};
  const rejected=[];
  for(const fault of ['live metadata','root metadata','stage bytes','occupied addition','occupied capture','extra staged child','root identity','protected path','nonempty removal','directory metadata overwrite']){
    const f=await fresh('reject-'+fault.replaceAll(' ','-'));await writeFile(join(f.root.path,'file'),'OLD');await writeFile(join(f.stage.path,'file'),'NEW');run('/usr/bin/chflags',['0100',join(f.root.path,'file'),join(f.stage.path,'file')]);await reviewed(f);f.install=['file'];
    if(fault==='root metadata')run('/usr/bin/xattr',['-w','com.saleh.changed','late',f.root.path]);
    if(fault==='live metadata')run('/usr/bin/xattr',['-w','com.saleh.changed','late',join(f.root.path,'file')]);
    if(fault==='stage bytes')await writeFile(join(f.stage.path,'file'),'CHANGED');
    if(fault==='occupied addition')f.before={};
    if(fault==='occupied capture')await writeFile(join(f.capture.path,'unrelated'),'CAPTURE KEEP');
    if(fault==='extra staged child')await writeFile(join(f.stage.path,'extra'),'STAGE KEEP');
    if(fault==='root identity')f.root={...f.root,ino:'1'};
    if(fault==='protected path')f.install=['.git'];
    if(fault==='nonempty removal'||fault==='directory metadata overwrite'){
      await unlink(join(f.root.path,'file'));await unlink(join(f.stage.path,'file'));await mkdir(join(f.root.path,'dir'));await mkdir(join(f.stage.path,'dir'));await writeFile(join(f.root.path,'dir/unrelated'),'KEEP');await reviewed(f);
      if(fault==='nonempty removal'){await rename(join(f.stage.path,'dir'),join(fixture,'unused-stage-dir'));f.staged={};f.install=[];f.remove=['dir'];}else f.install=['dir'];
    }
    const beforeCapture=await readdir(f.capture.path),r=spawnSync(binary,['--handoff-files','publish'],{input:JSON.stringify(f),encoding:'utf8',timeout:3000,killSignal:'SIGKILL'});assert.equal(r.error,undefined,fault);assert.equal(r.status,1,fault);assert.deepEqual(await readdir(f.capture.path),beforeCapture,fault+' must reject before capture');rejected.push(fault);
  }
  const tracked=await fresh('tracked-directory');await writeFile(join(tracked.root.path,'item'),'TRACKED');run('/usr/bin/chflags',['0100',join(tracked.root.path,'item')]);await mkdir(join(tracked.stage.path,'item'));await reviewed(tracked);tracked.install=['item'];
  reject('publish',tracked,/document-tracked/);assert.deepEqual(await readdir(tracked.capture.path),[]);assert.deepEqual(request('snapshot',{root:tracked.root,paths:['item']}).stamps,tracked.before);
  const probe=join(fixture,'native-tracked-probe');await mkdir(probe);for(const name of ['live','capture'])await mkdir(join(probe,name));await writeFile(join(probe,'live/item'),'TRACKED');run('/usr/bin/chflags',['0100',join(probe,'live/item')]);
  const tracking=run(binary,['--tracked-rename-check',probe]);assert.match(tracking,/renamed 64/);assert.match(tracking,/new directory 0/);await writeFile(join(probe,'evidence.txt'),tracking);
  for(const transition of ['file-directory','directory-file','remove-directory']){
    const f=await fresh(transition),oldPaths=transition==='file-directory'?['item']:['item','item/child'];
    if(transition==='file-directory')await writeFile(join(f.root.path,'item'),'OLD');else{await mkdir(join(f.root.path,'item'));await writeFile(join(f.root.path,'item/child'),'OLD CHILD');}
    for(const path of oldPaths.filter(p=>p.endsWith('child')||transition==='file-directory'))run('/usr/bin/chflags',[transition==='file-directory'?'0':'0100',join(f.root.path,path)]);
    f.before=request('snapshot',{root:f.root,paths:oldPaths}).stamps;
    if(transition==='file-directory'){await mkdir(join(f.stage.path,'item'));await writeFile(join(f.stage.path,'item/child'),'NEW CHILD');run('/usr/bin/chflags',['0100',join(f.stage.path,'item/child')]);f.install=['item','item/child'];}
    if(transition==='directory-file'){await writeFile(join(f.stage.path,'item'),'NEW');run('/usr/bin/chflags',['0100',join(f.stage.path,'item')]);f.install=['item'];f.remove=['item/child'];}
    if(transition==='remove-directory')f.remove=['item','item/child'];
    f.staged=request('snapshot',{root:f.stage,paths:f.install}).stamps;bindRoots(f);await writeFile(join(fixture,transition+'-input.json'),JSON.stringify(f,null,2));const out=request('publish',f);
    for(const path of oldPaths)assert.deepEqual(out.capture[out.captured[path]].identity,f.before[path].identity);
    if(transition==='file-directory')assert.equal(await readFile(join(f.root.path,'item/child'),'utf8'),'NEW CHILD');
    if(transition==='directory-file')assert.equal(await readFile(join(f.root.path,'item'),'utf8'),'NEW');
    if(transition==='remove-directory')assert.deepEqual(await readdir(f.root.path),[]);
  }
  const interrupted=await fresh('publish-interrupted'),many=Array.from({length:96},(_,i)=>'file-'+String(i).padStart(3,'0'));
  for(const name of many){await writeFile(join(interrupted.root.path,name),'OLD '+name);await writeFile(join(interrupted.stage.path,name),'NEW '+name);}
  run('/usr/bin/chflags',['0100',...many.flatMap(name=>[join(interrupted.root.path,name),join(interrupted.stage.path,name)])]);await reviewed(interrupted);interrupted.install=many;
  await new Promise((resolve,reject)=>{
    const child=spawn(binary,['--handoff-files','publish'],{stdio:['pipe','pipe','pipe']});let killed=false,stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
    const watcher=watch(interrupted.capture.path,()=>{if(!killed)killed=child.kill('SIGKILL');});const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    child.once('error',reject);child.once('close',(code,signal)=>{watcher.close();clearTimeout(timer);try{assert(killed,stderr);assert.equal(signal,'SIGKILL');resolve();}catch(e){reject(e);}});child.stdin.end(JSON.stringify(interrupted));
  });
  const retained=await readdir(interrupted.capture.path);assert(retained.length>0);
  for(const [i,name] of many.entries()){
    const slot=String(i).padStart(8,'0'),oldPath=retained.includes(slot)?join(interrupted.capture.path,slot):join(interrupted.root.path,name);assert.equal(await readFile(oldPath,'utf8'),'OLD '+name);
    const staged=await readFile(join(interrupted.stage.path,name),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return readFile(join(interrupted.root.path,name),'utf8');});assert.equal(staged,'NEW '+name);
  }
  const summary={passed:true,fixture,installed:input.install.length,captured:Object.keys(receipt.captured).length,rejected,transitions:['file-directory','directory-file','remove-directory'],trackedDirectoryReplacement:'refused before mutation; native EXCL rename plus mkdir clears retained UF_TRACKED',interruption:{signal:'SIGKILL',retainedOriginals:retained.length,verifiedOriginals:many.length,verifiedIncoming:many.length}};
  await writeFile(join(fixture,'publish-evidence.json'),JSON.stringify(summary,null,2));return summary;
}
// Empty selections still bind native root metadata for deleted-all-files transactions.
const emptySource=join(fixture,'empty-source'),emptyTarget=join(fixture,'empty-target');for(const dir of [emptySource,emptyTarget])await mkdir(dir,{mode:0o700});
run('/usr/bin/xattr',['-wx','com.saleh.root','00ff',emptySource]);
const emptyRoot=await descriptor(emptySource),emptyDestination=await descriptor(emptyTarget),emptyReview=request('snapshot',{root:emptyRoot,paths:[]});
assert.deepEqual(emptyReview.stamps,{});assert.equal(emptyReview.bytes,0);assert.deepEqual(emptyReview.rootStamp.identity,{dev:emptyRoot.dev,ino:emptyRoot.ino});assert(emptyReview.rootStamp.xattrs['com.saleh.root']);
const emptyCopy=request('copy',{source:emptyRoot,destination:emptyDestination,stamps:{}});assert.deepEqual(emptyCopy.stamps,{});assert.equal(emptyCopy.bytes,0);assert.deepEqual(emptyCopy.rootStamp,request('snapshot',{root:emptyDestination,paths:[]}).rootStamp);assert.deepEqual(request('snapshot',{root:emptyRoot,paths:[]}),emptyReview);
if(process.env.HANDOFF_FILES_CHECK==='publish'){console.log(JSON.stringify(await publicationChecks(),null,2));process.exit(0);}
const source=join(fixture,'source'), stage=join(fixture,'stage');
await mkdir(source);await mkdir(stage,{mode:0o700});await mkdir(join(source,'.git'));
await writeFile(join(source,'.git','sentinel'),'untouched');
await mkdir(join(source,'folder'));await mkdir(join(source,'empty'));
await writeFile(join(source,'folder','data'),Buffer.from([0,1,2,255,128,0]));
await link(join(source,'folder','data'),join(source,'linked'));
await writeFile(join(source,'executable'),'#!/bin/sh\nexit 0\n');await chmod(join(source,'executable'),0o751);
await writeFile(join(source,'unselected'),'keep source');
await symlink('../not-followed',join(source,'literal'));await symlink('missing',join(source,'dangling'));
for(const name of ['folder/data','empty','folder','literal']) {
  run('/usr/bin/xattr',['-s','-wx','com.saleh.handoff','00017fff00',join(source,name)]);
  run('/bin/chmod',['-h','+a','everyone allow read,readattr,readextattr,readsecurity',join(source,name)]);
}
run('/usr/bin/xattr',['-wx','com.apple.ResourceFork','7265736f7572636500ff',join(source,'folder/data')]);
run('/usr/bin/xattr',['-w','com.apple.quarantine','0081;60000000;HandoffProbe;',join(source,'folder/data')]);
for(const name of ['folder/data','linked','executable'])run('/usr/bin/chflags',['0100',join(source,name)]);
const paths=['folder','folder/data','linked','executable','literal','dangling','empty'];
const src=await descriptor(source),dst=await descriptor(stage),git=await descriptor(join(source,'.git'));
const before=request('snapshot',{root:src,paths});
const copied=request('copy',{source:src,destination:dst,stamps:before.stamps});
assert.deepEqual(request('snapshot',{root:src,paths}),before);
assert.deepEqual(await descriptor(source),src);assert.deepEqual(await descriptor(stage),dst);assert.deepEqual(await descriptor(join(source,'.git')),git);
assert.equal(await readFile(join(source,'unselected'),'utf8'),'keep source');
assert.deepEqual((await readdir(stage)).sort(),['dangling','empty','executable','folder','linked','literal']);
for(const name of paths) {
  const a=await lstat(join(source,name),{bigint:true}),b=await lstat(join(stage,name),{bigint:true});
  assert.deepEqual([a.mode,a.uid,a.gid,a.mtimeNs,a.birthtimeNs],[b.mode,b.uid,b.gid,b.mtimeNs,b.birthtimeNs]);
  const attrs=run('/usr/bin/xattr',['-s',join(source,name)]).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(run('/usr/bin/xattr',['-s',join(stage,name)]).trim().split('\n').filter(Boolean).sort(),attrs);
  for(const attr of attrs)assert.equal(run('/usr/bin/xattr',['-s','-px',attr,join(source,name)]),run('/usr/bin/xattr',['-s','-px',attr,join(stage,name)]));
  const acl=path=>run('/bin/ls',['-lde',path]).split('\n').filter(x=>/^ \d+:/.test(x));
  assert.deepEqual(acl(join(source,name)),acl(join(stage,name)));
}
assert.deepEqual(await readFile(join(stage,'folder/data')),await readFile(join(source,'folder/data')));
assert.equal((await lstat(join(stage,'linked'))).ino,(await lstat(join(stage,'folder/data'))).ino);
assert.notEqual((await lstat(join(stage,'linked'))).ino,(await lstat(join(source,'linked'))).ino);
assert.equal(copied.stamps.literal.targetBase64,Buffer.from('../not-followed').toString('base64'));

for(const path of ['../outside','/absolute','.git','.GIT/config','folder/../data','folder//data'])reject('snapshot',{root:src,paths:[path]});
reject('snapshot',{root:src,paths:['folder','FOLDER']});
reject('snapshot',{root:src,paths:['folder/data']},/ancestor/i);
reject('snapshot',{root:{...src,ino:'1'},paths},/identity/i);
await symlink('folder',join(source,'alias'));
reject('snapshot',{root:src,paths:['alias','alias/data']},/directory|ancestor|symbolic/i);
reject('copy',{source:src,destination:dst,stamps:before.stamps},/pre-existing|empty|contents/i);
const badStage=join(fixture,'public-stage');await mkdir(badStage,{mode:0o755});
reject('copy',{source:src,destination:await descriptor(badStage),stamps:before.stamps},/private/i);
const fresh=join(fixture,'fresh');await mkdir(fresh,{mode:0o700});
run('/usr/bin/xattr',['-w','com.saleh.handoff','stale',join(source,'executable')]);
reject('copy',{source:src,destination:await descriptor(fresh),stamps:before.stamps},/changed|review/i);
assert.deepEqual(await readdir(fresh),[]);
await writeFile(join(source,'external'),'external');await link(join(source,'external'),join(fixture,'external-link'));
reject('snapshot',{root:src,paths:['external']},/hardlink/i);
run('/bin/ln',['-P',join(source,'literal'),join(source,'linked-symlink')]);
reject('snapshot',{root:src,paths:['literal','linked-symlink']},/hardlink/i);
await unlink(join(source,'linked-symlink'));
run('/usr/bin/mkfifo',[join(source,'fifo')]);reject('snapshot',{root:src,paths:['fifo']},/special/i);
await rename(join(source,'folder'),join(source,'held-folder'));await symlink('../stage/folder',join(source,'folder'));
reject('copy',{source:src,destination:await descriptor(fresh),stamps:before.stamps},/changed|directory|ancestor/i);
assert.deepEqual(await readdir(fresh),[]);
const oversized=processResult(binary,['--handoff-files','snapshot'],' '.repeat(8*1024*1024+1));assert.notEqual(oversized.status,0);
const grown=join(fixture,'grown'),growthStage=join(fixture,'growth-stage');
await writeFile(grown,Buffer.alloc(4*1024*1024,98));
const growth=processResult(binary,['--growth-check',grown,growthStage]);
assert.equal(growth.status,1);assert.match(growth.stdout,/Header rejected growth/);assert.match(growth.stderr,/byte limit|canceled/i);
const growthBytes=(await lstat(growthStage)).size;
assert.ok(growthBytes>1024*1024 && growthBytes<=1024*1024+65536,'native copy must stop within one configured block');
const stoppedSource=join(fixture,'stopped-source'),stoppedStage=join(fixture,'stopped-stage');
await mkdir(stoppedSource);await mkdir(stoppedStage,{mode:0o700});
await writeFile(join(stoppedSource,'large'),Buffer.alloc(24*1024*1024,97));
run('/usr/bin/chflags',['0100',join(stoppedSource,'large')]);
const stoppedRoot=await descriptor(stoppedSource),stoppedDestination=await descriptor(stoppedStage);
const stoppedReview=request('snapshot',{root:stoppedRoot,paths:['large']});
await new Promise((resolve,reject)=>{
  const child=spawn(binary,['--handoff-files','copy'],{stdio:['pipe','pipe','pipe']});
  let killed=false,stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
  const observer=watch(stoppedStage,()=>{if(!killed){killed=child.kill('SIGKILL');}});
  const timeout=setTimeout(()=>{child.kill('SIGKILL');},10000);
  child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timeout);observer.close();try{assert.equal(killed,true,stderr);assert.equal(signal,'SIGKILL');resolve();}catch(e){reject(e);}});
  child.stdin.end(JSON.stringify({source:stoppedRoot,destination:stoppedDestination,stamps:stoppedReview.stamps}));
});
assert.ok((await readdir(stoppedStage)).length>0,'interrupted stage must remain');
assert.deepEqual(request('snapshot',{root:stoppedRoot,paths:['large']}),stoppedReview);
const publication=await publicationChecks();
const materialization=await materializationChecks();
const evidence={passed:true,fixture,paths:paths.length,metadata:['bytes','exec','symlink','xattrs','resource fork','quarantine','ACL','birthtime','mtime','hardlinks'],rejections:['protected/alias/ancestor paths','wrong root identity','symlink ancestor','occupied/private stage','metadata stale review','external hardlink','hardlinked symlink','special file','replaced ancestor','stdin limit','pre-copy size growth','regular replaced by FIFO before open'],fifo:fifoEvidence,growth:{reviewedBytes:1048576,retainedBytes:growthBytes,maxOvershoot:65536},interruption:'SIGKILL after staged entry creation retains stage and unchanged source',publication,materialization};
await writeFile(join(fixture,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
