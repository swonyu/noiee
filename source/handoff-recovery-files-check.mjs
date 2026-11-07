import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {watch} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,lstat,link,rename,realpath,unlink,symlink,chmod,rmdir,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const source=dirname(fileURLToPath(import.meta.url));
const work='/Users/saleh/Documents/Codex/2026-10-12/i-want-the-app-to-work/work';
const fixture=await realpath(await mkdtemp(join(tmpdir(),'handoff-native-recovery-')));
const build=await mkdtemp(join(work,'handoff-native-recovery-build-')),binary=process.env.HANDOFF_RECOVERY_BINARY||join(build,'handoff-files');
const evidence={passed:false,fixture,checks:[]};
function run(bin,args,input){return spawnSync(bin,args,{input,encoding:'utf8',maxBuffer:20*1024*1024,timeout:30000});}
function call(action,input){const result=run(binary,['--handoff-files',action],JSON.stringify(input));assert.equal(result.status,0,result.stderr||result.error?.message);return JSON.parse(result.stdout);}
function reject(action,input,pattern){const result=run(binary,['--handoff-files',action],JSON.stringify(input));assert.equal(result.error,undefined,result.error?.message);assert.notEqual(result.status,0);assert.match(result.stderr,pattern);}
const content=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['identity','ctime',...(row.kind==='directory'?['nlink']:[])].includes(key)));
const snapshot=async (path,paths)=>{const root=await descriptor(path);return {root,...call('snapshot',{root,paths})};};
const clean=({root,stamps,rootStamp})=>({root,stamps,rootStamp});
const dirs=async name=>{const result={};for(const part of ['live','stage','capture','witness']){result[part]=join(fixture,name+'-'+part);await mkdir(result[part],{mode:0o700});}return result;};
const descriptor=async path=>{const s=await lstat(path,{bigint:true});return {path,dev:String(s.dev),ino:String(s.ino)};};
try {
  if(!process.env.HANDOFF_RECOVERY_BINARY){
    await writeFile(join(build,'main.swift'),'import Foundation\nimport Darwin\nexit(HandoffFiles.command(CommandLine.arguments))\n');
    const compiled=run('/usr/bin/swiftc',['-O',join(source,'CodingTemporary.swift'),join(source,'HandoffFiles.swift'),join(build,'main.swift'),'-o',binary]);assert.equal(compiled.status,0,compiled.stderr);
  }
  evidence.binary=binary;
  const unicode=await dirs('capture-order'),unicodeNames=['e\u0301','z','\uE000','\u{10000}'];
  for(const name of unicodeNames)await writeFile(join(unicode.live,name),'retained '+name);
  const ub=await snapshot(unicode.live,unicodeNames),us=await snapshot(unicode.stage,[]),uc=await snapshot(unicode.capture,[]);
  const ordered=call('recoverPublish',{root:ub.root,stage:us.root,capture:uc.root,before:ub.stamps,staged:us.stamps,beforeRootStamp:ub.rootStamp,stagedRootStamp:us.rootStamp,captureRootStamp:uc.rootStamp,install:[],remove:unicodeNames,retained:[],directoryTimes:{}});
  const captureOrder=[...unicodeNames].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  assert.deepEqual(ordered.captured,Object.fromEntries(captureOrder.map((name,i)=>[name,String(i).padStart(8,'0')])),'Recovery slots must match the durable UTF-8 byte-ordered original-name map');
  for(const name of unicodeNames)assert.equal(await readFile(join(unicode.capture,ordered.captured[name]),'utf8'),'retained '+name);
  evidence.checks.push('Recovery capture slots use UTF-8 byte order for decomposed and non-BMP paths');
  const paths={};for(const name of ['live','old-stage','old-capture','before-copy','restore-stage','new-capture']){paths[name]=join(fixture,name);await mkdir(paths[name],{mode:0o700});}
  await writeFile(join(paths.live,'a'),'ORIGINAL');await link(join(paths.live,'a'),join(paths.live,'b'));
  await writeFile(join(paths['old-stage'],'a'),'INCOMING');await link(join(paths['old-stage'],'a'),join(paths['old-stage'],'b'));
  const original=call('snapshot',{root:await descriptor(paths.live),paths:['a','b']});
  const immutable=call('copy',{source:await descriptor(paths.live),destination:await descriptor(paths['before-copy']),stamps:original.stamps});
  await rename(join(paths.live,'a'),join(paths['old-capture'],'00000000'));
  const ordinary=run(binary,['--handoff-files','snapshot'],JSON.stringify({root:await descriptor(paths.live),paths:['b']}));
  assert.notEqual(ordinary.status,0);assert.match(ordinary.stderr,/Hardlink outside/);
  evidence.checks.push('Ordinary snapshot still refuses hardlink outside one root');
  const input={roots:await Promise.all([['live',['b']],['old-stage',['a','b']],['old-capture',['00000000']]].map(async([name,pathsSelected])=>({root:await descriptor(paths[name]),paths:pathsSelected})))};
  const observed=call('recoverySnapshot',input);
  assert.equal(observed.roots.length,3);assert.deepEqual(observed.roots[0].stamps.b.identity,original.stamps.b.identity);assert.deepEqual(observed.roots[2].stamps['00000000'].identity,original.stamps.a.identity);
  assert.equal(observed.roots[0].stamps.b.nlink,2);assert.equal(observed.roots[2].stamps['00000000'].nlink,2);
  assert.equal(await readFile(join(paths.live,'b'),'utf8'),'ORIGINAL');assert.equal(await readFile(join(paths['old-capture'],'00000000'),'utf8'),'ORIGINAL');
  evidence.checks.push('Recovery snapshot proves hardlink closure across reviewed live and capture roots');
  for(const change of ['extra field','missing alias','reused root','wrong identity','protected path','implicit ancestor']){
    const bad=structuredClone(input);
    if(change==='extra field')bad.extra=true;
    if(change==='missing alias')bad.roots.pop();
    if(change==='reused root')bad.roots[2]=bad.roots[1];
    if(change==='wrong identity')bad.roots[0].root.ino='1';
    if(change==='protected path')bad.roots[0].paths=['.git/HEAD'];
    if(change==='implicit ancestor')bad.roots[0].paths=['folder/file'];
    reject('recoverySnapshot',bad,/Invalid|outside|overlap|identity|Protected|ancestor/);
    evidence.checks.push('Rejected '+change);
  }
  await link(join(paths.live,'b'),join(fixture,'external-alias'));
  reject('recoverySnapshot',input,/Hardlink outside/);await unlink(join(fixture,'external-alias'));
  evidence.checks.push('Rejected external hardlink outside all recovery roots');
  await writeFile(join(paths['old-capture'],'unreviewed'),'DO NOT LOSE');reject('recoverySnapshot',input,/pre-existing|concurrent/);
  await rename(join(paths['old-capture'],'unreviewed'),join(fixture,'retained-unreviewed'));
  await chmod(paths['old-capture'],0o755);reject('recoverySnapshot',input,/private permissions/);await chmod(paths['old-capture'],0o700);
  evidence.checks.push('Rejected unreviewed witness contents and public witness permissions');
  const fifo=join(paths.live,'fifo');assert.equal(run('/usr/bin/mkfifo',[fifo]).status,0);
  const special=structuredClone(input);special.roots[0].paths.push('fifo');reject('recoverySnapshot',special,/Special filesystem/);await unlink(fifo);
  await symlink('literal',join(paths.live,'literal'));assert.equal(run('/bin/ln',['-P',join(paths.live,'literal'),join(paths.live,'literal-alias')]).status,0);
  const linked=structuredClone(input);linked.roots[0].paths.push('literal','literal-alias');reject('recoverySnapshot',linked,/Hardlinked symlinks/);await unlink(join(paths.live,'literal-alias'));await unlink(join(paths.live,'literal'));
  evidence.checks.push('Rejected FIFO without blocking and hardlinked symlinks');
  await rename(paths.live,paths.live+'-held');await mkdir(paths.live,{mode:0o700});reject('recoverySnapshot',input,/identity changed/);await rmdir(paths.live);await rename(paths.live+'-held',paths.live);
  evidence.checks.push('Rejected replaced live root without changing held contents');
  call('recoverySnapshot',input);
  await writeFile(join(paths.live,'new-work'),'UNEXPECTED CURRENT CONTENT');input.roots[0].paths.push('new-work');
  const current=call('recoverySnapshot',input),stage=call('copy',{source:await descriptor(paths['before-copy']),destination:await descriptor(paths['restore-stage']),stamps:immutable.stamps});
  const capture=call('snapshot',{root:await descriptor(paths['new-capture']),paths:[]});
  const restore={root:current.roots[0].root,stage:await descriptor(paths['restore-stage']),capture:await descriptor(paths['new-capture']),before:current.roots[0].stamps,staged:stage.stamps,beforeRootStamp:current.roots[0].rootStamp,stagedRootStamp:stage.rootStamp,captureRootStamp:capture.rootStamp,install:['a','b'],remove:['new-work'],retained:current.roots.slice(1).map(({root,stamps,rootStamp})=>({root,stamps,rootStamp})),directoryTimes:{'':original.rootStamp.mtime}};
  const restored=call('recoverPublish',restore);
  assert.equal(await readFile(join(paths.live,'a'),'utf8'),'ORIGINAL');assert.equal(await readFile(join(paths.live,'b'),'utf8'),'ORIGINAL');
  assert.deepEqual(restored.live.a.identity,restored.live.b.identity);assert.equal(restored.live.a.nlink,2);assert.equal(restored.liveRootStamp.mtime,original.rootStamp.mtime);
  assert.equal(await readFile(join(paths['new-capture'],restored.captured['new-work']),'utf8'),'UNEXPECTED CURRENT CONTENT');
  assert.deepEqual(restored.capture[restored.captured.b].identity,original.stamps.b.identity);assert.equal(restored.retained.length,2);
  assert.deepEqual(call('snapshot',{root:await descriptor(paths['before-copy']),paths:['a','b']}),immutable);
  evidence.checks.push('Restored independent original hardlink pair while retaining split original and unexpected live bytes');
  // Recovery may replace a directory only after every reviewed child is retained.
  const directory=await dirs('directories');
  for(const key of ['live','stage']){await mkdir(join(directory[key],'keep'));await mkdir(join(directory[key],'swap'));await writeFile(join(directory[key],'keep/file'),key==='live'?'OLD':'RESTORED');await symlink(key==='live'?'old-literal':'../restored-literal',join(directory[key],'literal'));}
  await writeFile(join(directory.live,'swap/old'),'OLD CHILD');await writeFile(join(directory.stage,'swap/new'),'RESTORED CHILD');await writeFile(join(directory.live,'keep/unrelated'),'UNRELATED');
  await mkdir(join(directory.live,'.git'));await writeFile(join(directory.live,'.git/sentinel'),'GIT UNTOUCHED');const gitIdentity=await descriptor(join(directory.live,'.git'));
  for(const path of [directory.live,join(directory.live,'keep'),join(directory.live,'swap'),join(directory.live,'literal'),join(directory.stage,'swap'),join(directory.stage,'literal'),join(directory.stage,'keep/file')]){
    assert.equal(run('/usr/bin/xattr',['-s','-wx','com.saleh.recovery','0001ff',path]).status,0);
    assert.equal(run('/bin/chmod',['-h','+a','everyone allow read,readattr,readextattr,readsecurity',path]).status,0);
  }
  await chmod(join(directory.stage,'keep/file'),0o751);
  assert.equal(run('/usr/bin/xattr',['-wx','com.apple.ResourceFork','00ff',join(directory.stage,'keep/file')]).status,0);
  assert.equal(run('/usr/bin/xattr',['-w','com.apple.quarantine','0081;60000000;RecoveryProbe;',join(directory.stage,'keep/file')]).status,0);
  const db=await snapshot(directory.live,['keep','keep/file','swap','swap/old','literal']),ds=await snapshot(directory.stage,['keep','keep/file','swap','swap/new','literal']),dc=await snapshot(directory.capture,[]);
  const di={root:db.root,stage:ds.root,capture:dc.root,before:db.stamps,staged:ds.stamps,beforeRootStamp:db.rootStamp,stagedRootStamp:ds.rootStamp,captureRootStamp:dc.rootStamp,install:['keep/file','swap','swap/new','literal'],remove:['swap/old'],retained:[],directoryTimes:{'':'1700000000:123456789',keep:'1700000001:987654321'}};
  await writeFile(join(fixture,'directory-input.json'),JSON.stringify(di,null,2));
  const ordinaryDirectory=structuredClone(di);delete ordinaryDirectory.retained;delete ordinaryDirectory.directoryTimes;reject('publish',ordinaryDirectory,/Existing directories must retain/);
  const dr=call('recoverPublish',di);
  for(const name of di.install)assert.deepEqual(content(dr.live[name]),content(ds.stamps[name]),'restored native metadata '+name);
  for(const [name,slot] of Object.entries(dr.captured)){assert.deepEqual(dr.capture[slot].identity,db.stamps[name].identity);assert.deepEqual(content(dr.capture[slot]),content(db.stamps[name]),'captured native metadata '+name);}
  assert.equal(dr.live.keep.mtime,di.directoryTimes.keep);assert.equal(dr.liveRootStamp.mtime,di.directoryTimes['']);
  for(const key of ['identity','birthtime','mode','flags','acl','xattrs']){assert.deepEqual(dr.live.keep[key],db.stamps.keep[key]);assert.deepEqual(dr.liveRootStamp[key],db.rootStamp[key]);}
  assert.deepEqual(await descriptor(join(directory.live,'.git')),gitIdentity);assert.equal(await readFile(join(directory.live,'keep/unrelated'),'utf8'),'UNRELATED');
  assert.deepEqual(await readdir(join(directory.capture,dr.captured.swap)),[]);assert.equal(await readFile(join(directory.capture,dr.captured['swap/old']),'utf8'),'OLD CHILD');
  await writeFile(join(fixture,'directory-receipt.json'),JSON.stringify({input:di,receipt:dr},null,2));
  evidence.checks.push('Restored directory and literal symlink metadata, resource fork, quarantine, ACL, executable mode and explicit directory times; retained empty original directory, unrelated child and .git identity');

  for(const fault of ['live bytes','stage bytes','witness bytes','witness root metadata','occupied capture','extra stage child','wrong root identity','FIFO replacement','extra field','invalid time','file time','unselected directory child']){
    const d=await dirs('reject-'+fault.replaceAll(' ','-'));
    await writeFile(join(d.live,'file'),'OLD');await writeFile(join(d.stage,'file'),'NEW');await writeFile(join(d.witness,'retained'),'WITNESS');
    const b=await snapshot(d.live,['file']),s=await snapshot(d.stage,['file']),c=await snapshot(d.capture,[]),w=await snapshot(d.witness,['retained']);
    const f={root:b.root,stage:s.root,capture:c.root,before:b.stamps,staged:s.stamps,beforeRootStamp:b.rootStamp,stagedRootStamp:s.rootStamp,captureRootStamp:c.rootStamp,install:['file'],remove:[],retained:[clean(w)],directoryTimes:{}};
    if(fault==='live bytes')await writeFile(join(d.live,'file'),'LATE OLD');
    if(fault==='stage bytes')await writeFile(join(d.stage,'file'),'LATE NEW');
    if(fault==='witness bytes')await writeFile(join(d.witness,'retained'),'LATE WITNESS');
    if(fault==='witness root metadata')assert.equal(run('/usr/bin/xattr',['-w','com.saleh.changed','late',d.witness]).status,0);
    if(fault==='occupied capture')await writeFile(join(d.capture,'keep'),'CAPTURE KEEP');
    if(fault==='extra stage child')await writeFile(join(d.stage,'keep'),'STAGE KEEP');
    if(fault==='wrong root identity')f.root.ino='1';
    if(fault==='FIFO replacement'){await rename(join(d.live,'file'),join(fixture,'fifo-retained-original'));assert.equal(run('/usr/bin/mkfifo',[join(d.live,'file')]).status,0);}
    if(fault==='extra field')f.extra=true;
    if(fault==='invalid time')f.directoryTimes['']='00:1';
    if(fault==='file time')f.directoryTimes.file='1700000000:0';
    if(fault==='unselected directory child'){
      await mkdir(join(d.live,'dir'));await writeFile(join(d.live,'dir/unreviewed'),'KEEP');
      const added=await snapshot(d.live,['file','dir']);f.before=added.stamps;f.beforeRootStamp=added.rootStamp;f.remove=['dir'];
    }
    const captureNames=await readdir(d.capture),attempt=run(binary,['--handoff-files','recoverPublish'],JSON.stringify(f));
    assert.equal(attempt.error,undefined,fault+' must not hang');assert.equal(attempt.status,1,fault+' must reject');assert.deepEqual(await readdir(d.capture),captureNames,fault+' must reject before capture');
    if(fault!=='FIFO replacement')assert.equal(await readFile(join(d.live,'file'),'utf8'),fault==='live bytes'?'LATE OLD':'OLD');
    assert.equal(await readFile(join(d.stage,'file'),'utf8'),fault==='stage bytes'?'LATE NEW':'NEW');
    evidence.checks.push('Recovery rejected '+fault+' before capture');
  }

  for(const times of [{},{'':'1700000000:123456789'}]){
    const emptyDirs=await dirs(Object.keys(times).length?'empty-time':'empty-noop');
    const e=await snapshot(emptyDirs.live,[]),s=await snapshot(emptyDirs.stage,[]),c=await snapshot(emptyDirs.capture,[]),w=await snapshot(emptyDirs.witness,[]);
    const emptyInput={root:e.root,stage:s.root,capture:c.root,before:{},staged:{},beforeRootStamp:e.rootStamp,stagedRootStamp:s.rootStamp,captureRootStamp:c.rootStamp,install:[],remove:[],retained:[clean(w)],directoryTimes:times};
    const result=call('recoverPublish',emptyInput);
    assert.deepEqual(result.live,{});assert.deepEqual(result.captured,{});assert.deepEqual(result.capture,{});assert.deepEqual(result.remainingStage,{});
    assert.equal(result.liveRootStamp.mtime,times['']||e.rootStamp.mtime);assert.equal(result.liveRootStamp.birthtime,e.rootStamp.birthtime);
    assert.deepEqual((await snapshot(emptyDirs.live,[])).rootStamp,result.liveRootStamp);
    assert.deepEqual(result.retained,[clean(w)]);
    const ordinaryEmpty=structuredClone(emptyInput);delete ordinaryEmpty.retained;delete ordinaryEmpty.directoryTimes;reject('publish',ordinaryEmpty,/Invalid publication request/);
    const late=await snapshot(emptyDirs.live,[]);emptyInput.beforeRootStamp=late.rootStamp;
    assert.equal(run('/usr/bin/xattr',['-w','com.saleh.late','CHANGED ROOT',emptyDirs.live]).status,0);reject('recoverPublish',emptyInput,/root metadata changed/);
    assert.deepEqual(await readdir(emptyDirs.capture),[]);
  }
  evidence.checks.push('Recovery-only empty mutation and root-mtime-only restoration return actual root stamps; changed empty root rejected, ordinary empty publish unchanged');
  const timed=await dirs('directory-time-only');await mkdir(join(timed.live,'outer/inner/unselected'),{recursive:true});await mkdir(join(timed.live,'unrelated'));
  await writeFile(join(timed.live,'outer/inner/keep'),'UNSELECTED FILE');await writeFile(join(timed.live,'outer/inner/unselected/child'),'UNSELECTED CHILD');await symlink('../../literal-target',join(timed.live,'outer/inner/unselected/link'));
  for(const name of ['outer','outer/inner','outer/inner/keep']){assert.equal(run('/usr/bin/xattr',['-wx','com.saleh.directory-time','0001ff',join(timed.live,name)]).status,0);assert.equal(run('/bin/chmod',['+a','everyone allow read,readattr,readextattr,readsecurity',join(timed.live,name)]).status,0);}
  await chmod(join(timed.live,'outer/inner'),0o751);await chmod(join(timed.live,'outer/inner/keep'),0o640);
  const allTimed=['outer','outer/inner','outer/inner/keep','outer/inner/unselected','outer/inner/unselected/child','outer/inner/unselected/link','unrelated'];
  const fullTimed=await snapshot(timed.live,allTimed),tb=await snapshot(timed.live,['outer','outer/inner']),ts=await snapshot(timed.stage,[]),tc=await snapshot(timed.capture,[]);
  const times={'':'1700000000:123456789',outer:'1700000001:234567890','outer/inner':'1700000002:345678901'};
  const timeInput={root:tb.root,stage:ts.root,capture:tc.root,before:tb.stamps,staged:{},beforeRootStamp:tb.rootStamp,stagedRootStamp:ts.rootStamp,captureRootStamp:tc.rootStamp,install:[],remove:[],retained:[],directoryTimes:times};
  const tr=call('recoverPublish',timeInput),afterTimed=await snapshot(timed.live,allTimed);
  for(const name of ['outer','outer/inner']){assert.equal(tr.live[name].mtime,times[name]);assert.deepEqual({...afterTimed.stamps[name],mtime:fullTimed.stamps[name].mtime,ctime:fullTimed.stamps[name].ctime},fullTimed.stamps[name]);assert.deepEqual(tr.live[name],afterTimed.stamps[name]);}
  assert.equal(afterTimed.rootStamp.mtime,times['']);assert.deepEqual({...afterTimed.rootStamp,mtime:fullTimed.rootStamp.mtime,ctime:fullTimed.rootStamp.ctime},fullTimed.rootStamp);
  for(const name of allTimed.filter(name=>!Object.hasOwn(tb.stamps,name)))assert.deepEqual(afterTimed.stamps[name],fullTimed.stamps[name],'Unselected native entry must remain exact: '+name);
  for(const key of ['captured','capture','remainingStage'])assert.deepEqual(tr[key],{});assert.deepEqual(await readdir(timed.stage),[]);assert.deepEqual(await readdir(timed.capture),[]);
  for(const [key,saved] of [['remainingStageRootStamp',ts.rootStamp],['captureRootStamp',tc.rootStamp]])assert.deepEqual({...tr[key],ctime:saved.ctime},saved);
  await writeFile(join(fixture,'directory-time-only-receipt.json'),JSON.stringify({input:timeInput,before:fullTimed,receipt:tr,after:afterTimed},null,2));
  evidence.checks.push('Recovery-only nested retained directory timestamps preserve all unselected bytes, inodes and native metadata with empty private stage and capture');
  const latestTime={...timeInput,before:tr.live,beforeRootStamp:tr.liveRootStamp,stagedRootStamp:tr.remainingStageRootStamp,captureRootStamp:tr.captureRootStamp};
  for(const fault of ['invalid timestamp','missing exact directory time','missing ancestor directory time','unreviewed directory time','non-directory row','unrelated directory row','unselected staged row','forward publish']){
    const bad=structuredClone(latestTime);
    if(fault==='invalid timestamp')bad.directoryTimes['outer/inner']='00:1';
    if(fault==='missing exact directory time')delete bad.directoryTimes['outer/inner'];
    if(fault==='missing ancestor directory time')delete bad.directoryTimes.outer;
    if(fault==='unreviewed directory time')bad.directoryTimes.unrelated=times.outer;
    if(fault==='non-directory row'){bad.before['outer/inner/keep']=afterTimed.stamps['outer/inner/keep'];bad.directoryTimes['outer/inner/keep']=times.outer;}
    if(fault==='unrelated directory row')bad.before.unrelated=afterTimed.stamps.unrelated;
    if(fault==='unselected staged row')bad.staged.outer=afterTimed.stamps.outer;
    if(fault==='forward publish'){bad.before.unrelated=afterTimed.stamps.unrelated;bad.remove=['unrelated'];delete bad.retained;delete bad.directoryTimes;}
    reject(fault==='forward publish'?'publish':'recoverPublish',bad,/Invalid|unrelated|not a retained directory|unselected/);
    assert.deepEqual(await snapshot(timed.live,allTimed),afterTimed);assert.deepEqual(await readdir(timed.stage),[]);assert.deepEqual(await readdir(timed.capture),[]);
    evidence.checks.push('Directory-time-only recovery rejected '+fault+' without changing live state');
  }
  assert.equal(run('/usr/bin/xattr',['-w','com.saleh.stale','LATE DIRECTORY METADATA',join(timed.live,'outer/inner')]).status,0);
  const staleTime=await snapshot(timed.live,allTimed);reject('recoverPublish',latestTime,/Reviewed publication input changed/);assert.deepEqual(await snapshot(timed.live,allTimed),staleTime);assert.deepEqual(await readdir(timed.stage),[]);assert.deepEqual(await readdir(timed.capture),[]);
  evidence.checks.push('Directory-time-only recovery rejected stale retained-directory metadata before mutation');
  const limit=await dirs('witness-limit');await writeFile(join(limit.live,'file'),'OLD');await writeFile(join(limit.stage,'file'),'NEW');
  const lb=await snapshot(limit.live,['file']),ls=await snapshot(limit.stage,['file']),lc=await snapshot(limit.capture,[]),witnesses=[await snapshot(limit.witness,[])];
  for(let i=1;i<7;i++){const path=join(fixture,'witness-limit-'+i);await mkdir(path,{mode:0o700});witnesses.push(await snapshot(path,[]));}
  const limited={root:lb.root,stage:ls.root,capture:lc.root,before:lb.stamps,staged:ls.stamps,beforeRootStamp:lb.rootStamp,stagedRootStamp:ls.rootStamp,captureRootStamp:lc.rootStamp,install:['file'],remove:[],retained:witnesses.map(clean),directoryTimes:{}};
  reject('recoverPublish',limited,/Invalid recovery publication witnesses/);assert.deepEqual(await readdir(limit.capture),[]);assert.equal(await readFile(join(limit.live,'file'),'utf8'),'OLD');assert.equal(await readFile(join(limit.stage,'file'),'utf8'),'NEW');
  limited.retained.pop();const lr=call('recoverPublish',limited);assert.equal(lr.retained.length,6);
  const nine={roots:await Promise.all([limit.live,limit.stage,limit.capture,...witnesses.slice(0,6).map(w=>w.root.path)].map(async path=>({root:await descriptor(path),paths:await readdir(path)})))};
  assert.equal(call('recoverySnapshot',nine).roots.length,9);nine.roots.push({root:witnesses[6].root,paths:[]});reject('recoverySnapshot',nine,/Invalid recovery snapshot request/);
  evidence.checks.push('Nine total roots and six retained witnesses accepted; seventh witness publication refused before capture and tenth inventory root rejected');
  // A killed real helper may split both incoming and original groups again.
  const stopped=await dirs('interrupted'),beforeDir=join(fixture,'interrupted-before'),oldStage=join(fixture,'interrupted-old-stage'),oldCapture=join(fixture,'interrupted-old-capture');
  for(const path of [beforeDir,oldStage,oldCapture])await mkdir(path,{mode:0o700});
  const pairs=Array.from({length:32},(_,i)=>String(i).padStart(3,'0')),all=pairs.flatMap(i=>['a'+i,'b'+i]);
  for(const i of pairs){await writeFile(join(stopped.live,'a'+i),'ORIGINAL '+i);await link(join(stopped.live,'a'+i),join(stopped.live,'b'+i));await writeFile(join(oldStage,'a'+i),'INCOMING '+i);await link(join(oldStage,'a'+i),join(oldStage,'b'+i));}
  const initial=await snapshot(stopped.live,all),saved=call('copy',{source:initial.root,destination:await descriptor(beforeDir),stamps:initial.stamps});
  for(const [n,i] of pairs.entries()){await rename(join(stopped.live,'a'+i),join(oldCapture,String(n).padStart(8,'0')));await rename(join(oldStage,'a'+i),join(stopped.live,'a'+i));}
  const split=call('recoverySnapshot',{roots:await Promise.all([stopped.live,oldStage,oldCapture].map(async path=>({root:await descriptor(path),paths:await readdir(path)})))});
  const ready=call('copy',{source:await descriptor(beforeDir),destination:await descriptor(stopped.stage),stamps:saved.stamps}),empty=await snapshot(stopped.capture,[]);
  const stoppedInput={root:split.roots[0].root,stage:await descriptor(stopped.stage),capture:empty.root,before:split.roots[0].stamps,staged:ready.stamps,beforeRootStamp:split.roots[0].rootStamp,stagedRootStamp:ready.rootStamp,captureRootStamp:empty.rootStamp,install:all,remove:[],retained:split.roots.slice(1).map(clean),directoryTimes:{'':initial.rootStamp.mtime}};
  await writeFile(join(fixture,'interrupted-input.json'),JSON.stringify(stoppedInput,null,2));
  await new Promise((resolve,reject)=>{
    const child=spawn(binary,['--handoff-files','recoverPublish'],{stdio:['pipe','pipe','pipe']});let killed=false,stderr='';child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
    const watcher=watch(stopped.capture,()=>{if(!killed)killed=child.kill('SIGKILL');});const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    child.once('error',reject);child.once('close',(code,signal)=>{watcher.close();clearTimeout(timer);try{assert(killed,stderr);assert.equal(signal,'SIGKILL');resolve();}catch(error){reject(error);}});child.stdin.end(JSON.stringify(stoppedInput));
  });
  const post=call('recoverySnapshot',{roots:await Promise.all([stopped.live,stopped.stage,stopped.capture,oldStage,oldCapture].map(async path=>({root:await descriptor(path),paths:await readdir(path)})))});
  assert(Object.keys(post.roots[2].stamps).length>0);assert(Object.keys(post.roots[0].stamps).length>0,'kill must interrupt before full capture');
  for(const [n,i] of pairs.entries()){
    const original=post.roots.flatMap(r=>Object.values(r.stamps)).filter(row=>row.identity.ino===initial.stamps['a'+i].identity.ino);
    const incoming=post.roots.flatMap(r=>Object.values(r.stamps)).filter(row=>row.identity.ino===split.roots[0].stamps['a'+i].identity.ino);
    assert.equal(original.length,2);assert(original.every(row=>row.sha256===initial.stamps['a'+i].sha256));assert.equal(incoming.length,2);assert(incoming.every(row=>row.sha256===split.roots[0].stamps['a'+i].sha256));
    assert.equal(await readFile(join(oldCapture,String(n).padStart(8,'0')),'utf8'),'ORIGINAL '+i);assert.equal(await readFile(join(oldStage,'b'+i),'utf8'),'INCOMING '+i);
  }
  const nextStage=join(fixture,'resumed-stage'),nextCapture=join(fixture,'resumed-capture');await mkdir(nextStage,{mode:0o700});await mkdir(nextCapture,{mode:0o700});
  const next=call('copy',{source:await descriptor(beforeDir),destination:await descriptor(nextStage),stamps:saved.stamps}),nextEmpty=await snapshot(nextCapture,[]);
  const resumedInput={root:post.roots[0].root,stage:await descriptor(nextStage),capture:nextEmpty.root,before:post.roots[0].stamps,staged:next.stamps,beforeRootStamp:post.roots[0].rootStamp,stagedRootStamp:next.rootStamp,captureRootStamp:nextEmpty.rootStamp,install:all,remove:[],retained:post.roots.slice(1).map(clean),directoryTimes:{'':initial.rootStamp.mtime}};
  const resumed=call('recoverPublish',resumedInput);
  for(const i of pairs){assert.equal(await readFile(join(stopped.live,'a'+i),'utf8'),'ORIGINAL '+i);assert.deepEqual(resumed.live['a'+i].identity,resumed.live['b'+i].identity);assert.equal(resumed.live['a'+i].nlink,2);}
  assert.deepEqual(call('snapshot',{root:await descriptor(beforeDir),paths:all}),saved);
  await writeFile(join(fixture,'interruption-receipts.json'),JSON.stringify({post,resumedInput,resumed},null,2));
  evidence.interruption={signal:'SIGKILL',capturedBeforeExit:Object.keys(post.roots[2].stamps).length,originalAliases:64,incomingAliases:64,resumedRetainedRoots:resumed.retained.length};
  evidence.checks.push('SIGKILL during recovery retained every original and incoming hardlink alias; fresh cross-root review then second recovery completed without changing immutable before-copy');
  evidence.passed=true;
} catch(error) {evidence.error=error.stack;process.exitCode=1;}
finally {await writeFile(join(fixture,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));}
