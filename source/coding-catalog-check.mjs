import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,lstat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {setImmediate as tick} from 'node:timers/promises';
import {CodingEngine} from './coding-engine.mjs';
import {CodingOwners} from './coding-owners.mjs';

// Generated JSON homes and in-memory CodingEngine transports only. No Codex,
// executor, shell, provider, model, SQLite, native UI or application is invoked.
const artifacts=join(dirname(fileURLToPath(import.meta.url)),'..','.artifacts');
await mkdir(artifacts,{recursive:true,mode:0o700});
const root=await realpath(await mkdtemp(join(artifacts,'coding-catalog-')));
const model='qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp',checks=[],failures=[],observations=[];
const originalFetch=globalThis.fetch,originalProcessMethods=new Map();
let processAttempts=0,networkAttempts=0;
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']){
 originalProcessMethods.set(name,childProcess[name]);
 childProcess[name]=()=>{processAttempts++;throw Error('A catalog fixture attempted to start a real process.');};
}
globalThis.fetch=async()=>{networkAttempts++;throw Error('A catalog fixture attempted a network request.');};
syncBuiltinESMExports();
const latch=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const within=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),4000);})]);}finally{clearTimeout(timer);}};
const track=promise=>{const value={settled:false};value.promise=promise.then(result=>{value.settled=true;return {result};},error=>{value.settled=true;return {error};});return value;};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function expectFailure(work,pattern){const outcome=await within(work.promise,'Fixture request did not settle');assert(outcome.error,'No catalog rows may be returned after a failed verification');assert.match(outcome.error.message,pattern);return outcome.error;}
async function check(name,body){
 try{await body();checks.push(name);console.log('PASS '+name);}
 catch(error){failures.push({name,message:error.stack??String(error)});console.error('FAIL '+name+': '+(error.stack??error));}
}
let fixtures=0;
async function fixture(label,{legacy=false,admission=true}={}){
 const home=join(root,String(++fixtures)+'-'+label),project=join(home,'project');await mkdir(project,{recursive:true,mode:0o700});
 if(legacy)await mkdir(join(home,'sessions'),{mode:0o700});
 const state={home,project,engines:[],owners:[],roots:[],familyCalls:[],closes:[],calls:[],active:0,maximum:0,admissions:0,allocations:0,modelLookups:0,readHook:null,closeHook:null,admissionHook:null,pageHook:null,pageSize:50,closeWhileReading:[]};
 const file=path=>join(path,'fixture-catalog-threads.json');
 const rows=async path=>{assert(path===home||path.startsWith(home+'/'));try{return JSON.parse(await readFile(file(path),'utf8'));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 const save=async(path,value)=>{assert(path===home||path.startsWith(home+'/'));await writeFile(file(path),JSON.stringify(value),{mode:0o600});};
 class FixtureEngine extends CodingEngine {
  constructor(options){super(options);state.engines.push(this);this.familyActive=0;}
  async ensure(){if(this.closed)throw Error('Fixture reader is closed');if(!this.processLife){this.child={killed:false};this.processLife={child:this.child,exited:false};}}
  fail(error){if(this.processLife)this.processLife.exited=true;this.processLife=null;this.child=null;super.fail(error);}
  async close(){
   if(!this.closed){
    state.closes.push({home:this.dataDir,historyOnly:this.historyOnly,active:this.familyActive});
    if(this.familyActive)state.closeWhileReading.push(this.dataDir);
    if(state.closeHook)await state.closeHook(this);
    this.closed=true;this.fail(Error('Fixture reader closed'));
   }
   return super.close();
  }
  async stop(){this.fail(Error('Fixture Stop'));return {message:'Fixture stopped'};}
  async prepare(){}
  async temporaryEnvironment(){return {};}
  async projectHasBackground(){return false;}
  async scheduledFamilyIdle(){return true;}
  async thread(id){
   if(this.closed||!this.processLife)throw Error('Fixture reader lifecycle changed');
   const thread=(await rows(this.dataDir)).find(row=>row.id===id);if(!thread)throw Error('Unknown generated thread');
   this.rememberThread(thread);return structuredClone(thread);
  }
  async resolveFamily(id,...args){
   this.familyActive++;state.active++;state.maximum=Math.max(state.maximum,state.active);
   const call={home:this.dataDir,id,historyOnly:this.historyOnly,ordinal:state.familyCalls.length};state.familyCalls.push(call);
   try{if(state.readHook)await state.readHook(this,id,call);return await super.resolveFamily(id,...args);}
   finally{this.familyActive--;state.active--;}
  }
  async handle(input){
   state.calls.push({home:this.dataDir,historyOnly:this.historyOnly,action:input.action,archived:!!input.archived});
   if(this.historyOnly&&!['list','read','family','status','events'].includes(input.action))throw Error('Fixture reader attempted execution');
   await this.ensure();
   if(input.action==='status')return {available:true,activeTurns:[],stoppingFamilies:[],terminals:[],busy:false,running:false};
   const saved=await rows(this.dataDir);
   if(input.action==='start'){
    const thread={id:randomUUID(),cwd:input.cwd,model,modelProvider:'saleh_local',parentThreadId:null,name:'fixture root',updatedAt:1,status:{type:'idle'},turns:[]};
    saved.push(thread);await save(this.dataDir,saved);this.rememberThread(thread);this.verifiedThreads.add(thread.id);return {thread};
   }
   if(input.action==='list'){
    const selected=saved.filter(row=>!!row.archived===!!input.archived&&(!input.searchTerm||String(row.name??'').includes(input.searchTerm)));
    const offset=Number(input.cursor??0),limit=state.pageSize;
    const page={threads:structuredClone(selected.slice(offset,offset+limit)),nextCursor:offset+limit<selected.length?String(offset+limit):null,truncated:false};
    return state.pageHook?await state.pageHook(this,input,page):page;
   }
   if(input.action==='read')return {thread:await this.thread(input.threadId),cursor:this.sequence};
   throw Error('Unexpected fixture action '+input.action);
  }
 }
 const settings={
  dataDir:home,
  engineOptions:{binary:join(home,'never-run-codex'),localModels:{async resolve(id){state.modelLookups++;return {id,contextLength:39424,generation:{max_tokens:2048,reasoning_effort:'none'}};}}},
  engineFactory:options=>new FixtureEngine(options),
  openExecutor:async context=>{
   state.allocations++;
   return {binding:{url:'ws://127.0.0.1:19999',authToken:'fixture-only-never-connected',launch:{argv:['/fixture/never-run'],cwd:'file:///private/var/empty',env:{HOME:context.dataDir}}},
    retire:async()=>({ownerId:context.ownerId,generation:context.generation,closed:true,revoked:true})};
  },
  ...(legacy&&admission?{assertLegacyClosed:async()=>{state.admissions++;if(state.admissionHook)await state.admissionHook();}}:{})
 };
 state.open=()=>{const owner=new CodingOwners(settings);state.owners.push(owner);return owner;};
 state.rows=rows;state.save=save;
 state.seed=async(count=1,children=8)=>{
  const owner=state.open();
  for(let index=0;index<count;index++){
   const thread=(await owner.handle({action:'start',cwd:project})).thread,engine=state.engines.findLast(engine=>engine.threadInfo.has(thread.id));
   const list=[thread,...Array.from({length:children},(_,n)=>({...thread,id:randomUUID(),name:'fixture child '+(n+1),parentThreadId:thread.id,canAcceptDirectInput:false,updatedAt:n+2}))];
   await save(engine.dataDir,list);state.roots.push({thread,engine,rows:list,home:engine.dataDir});
  }
  return owner;
 };
 state.seedLegacy=async(active=8,archived=4)=>{
  const list=Array.from({length:active+archived},(_,index)=>({id:randomUUID(),cwd:project,model,modelProvider:'saleh_local',parentThreadId:null,name:'legacy '+index,updatedAt:index,archived:index>=active,status:{type:'idle'},turns:[]}));
  await save(home,list);return list;
 };
 state.reset=()=>{state.familyCalls=[];state.closes=[];state.calls=[];state.active=0;state.maximum=0;state.closeWhileReading=[];};
 state.cleanup=async()=>{state.readHook=null;state.closeHook=null;state.admissionHook=null;state.pageHook=null;for(const owner of state.owners)await owner.close().catch(()=>{});};
 return state;
}
function progressShape(value){
 assert(value&&typeof value==='object');
 assert.deepEqual(Object.keys(value).sort(),['schemaVersion','id','requestId','archived','searching','state','phase','ownersTotal','ownersCompleted','threadsVerified','elapsedMs','phaseElapsedMs','phaseTimingsMs'].sort());
 assert.equal(value.schemaVersion,1);assert.match(value.id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
 assert(value.requestId===null||/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.requestId));
 assert.equal(typeof value.archived,'boolean');assert.equal(typeof value.searching,'boolean');
 assert(['loading','complete','failed','cancelled'].includes(value.state));
 const phases=['legacy-history','owner-history','reader-close','finalizing'];assert(phases.includes(value.phase));
 assert.deepEqual(Object.keys(value.phaseTimingsMs).sort(),phases.sort());
 for(const number of [value.ownersTotal,value.ownersCompleted,value.threadsVerified,value.elapsedMs,value.phaseElapsedMs,...Object.values(value.phaseTimingsMs)])assert(Number.isSafeInteger(number)&&number>=0);
 assert(value.ownersCompleted<=value.ownersTotal);assert(value.ownersTotal<=256);
 assert(Math.abs(Object.values(value.phaseTimingsMs).reduce((a,b)=>a+b,0)-value.elapsedMs)<=3);
 return value;
}

try{
 await check('cold owner verification overlaps four reads and confirms retirement before the next owner',async()=>{
  const f=await fixture('bounded-owner'),gate=latch(),four=latch(),closing=latch(),releaseClose=latch();
  const seeded=await f.seed(2,8);await seeded.close();f.reset();
  const first=f.roots[0].home,second=f.roots[1].home,requestId=randomUUID(),before=[f.allocations,f.modelLookups];
  f.readHook=async(engine)=>{if(engine.dataDir===first){if(f.familyCalls.length===4)four.resolve();await gate.promise;}};
  f.closeHook=async engine=>{if(engine.historyOnly&&engine.dataDir===first){closing.resolve();await releaseClose.promise;}};
  const owner=f.open(),pending=track(owner.handle({action:'list'},{requestId}));
  try{
   await within(four.promise,'Cold history did not admit four independent family reads');
   assert.equal(f.active,4);assert.equal(f.familyCalls.length,4);assert.equal(pending.settled,false);
   assert(!f.engines.some(engine=>engine.historyOnly&&engine.dataDir===second));
   const poll=await owner.handle({action:'events',after:0});assert.equal(poll.deferred,true);const loading=progressShape(poll.catalogProgress);
   assert.equal(loading.requestId,requestId);assert.equal(loading.state,'loading');assert.equal(loading.phase,'owner-history');assert.equal(loading.ownersTotal,2);assert.equal(loading.ownersCompleted,0);assert.equal(loading.threadsVerified,0);
   assert(!JSON.stringify(loading).includes(f.home));assert(!('threads' in poll));assert(!('approvals' in poll));assert(!('cursor' in poll));
   loading.ownersTotal=999;assert.equal((await owner.handle({action:'events',after:0})).catalogProgress.ownersTotal,2);
   gate.resolve();await within(closing.promise,'Reader retirement did not follow drained verification');
   assert.equal(f.active,0);assert.equal(pending.settled,false);assert(!f.engines.some(engine=>engine.historyOnly&&engine.dataDir===second));
   const retiring=progressShape((await owner.handle({action:'events',after:0})).catalogProgress);assert.equal(retiring.phase,'reader-close');assert.equal(retiring.ownersCompleted,0);
   releaseClose.resolve();const {result,error}=await within(pending.promise,'Cold catalog did not complete');assert.ifError(error);
   assert.equal(result.threads.length,18);assert.equal(f.maximum,4);assert.deepEqual(f.closeWhileReading,[]);
   const complete=progressShape(result.catalogProgress);assert.equal(complete.id,retiring.id);assert.equal(complete.state,'complete');assert.equal(complete.ownersCompleted,2);assert.equal(complete.threadsVerified,18);
   assert.equal(f.closes.filter(row=>row.historyOnly).length,2);assert.deepEqual([f.allocations,f.modelLookups],before);
   const catalog=JSON.parse(await readFile(join(f.home,'coding-owners.json'),'utf8'));assert(catalog.owners.every(row=>!row.generation.nativeOpen&&row.threads.length===9));
   observations.push({name:'cold-owner-overlap',maximumConcurrentFamilyReads:f.maximum,complete});
  }finally{gate.resolve();releaseClose.resolve();await pending.promise;await f.cleanup();}
 });
 await check('live execution engines retain sequential family verification',async()=>{
  const f=await fixture('live-serial'),gate=latch(),entered=latch(),owner=await f.seed(1,8);f.reset();
  f.readHook=async()=>{entered.resolve();await gate.promise;};const pending=track(owner.handle({action:'list'}));
  try{
   await within(entered.promise,'Live engine verification did not start');await tick();await tick();
   assert.equal(f.familyCalls.length,1);assert.equal(f.active,1);assert.equal(pending.settled,false);gate.resolve();
   const {result,error}=await within(pending.promise,'Live catalog did not complete');assert.ifError(error);assert.equal(result.threads.length,9);assert.equal(f.maximum,1);assert.equal(f.closes.length,0);
   assert(f.familyCalls.every(row=>row.historyOnly===false));
  }finally{gate.resolve();await pending.promise;await f.cleanup();}
 });
 await check('legacy admission precedes parallel verification of complete active and archived inventory',async()=>{
  const f=await fixture('legacy',{legacy:true}),admit=latch(),admitting=latch(),reads=latch(),four=latch();await f.seedLegacy(9,5);
  f.admissionHook=async()=>{admitting.resolve();await admit.promise;};
  f.readHook=async()=>{if(f.familyCalls.length===4)four.resolve();await reads.promise;};
  const owner=f.open(),pending=track(owner.handle({action:'list'}));
  try{
   await within(admitting.promise,'Legacy closure admission did not run');assert.equal(f.engines.length,0);assert.equal(f.familyCalls.length,0);
   admit.resolve();await within(four.promise,'Legacy inventory did not overlap four family reads');assert.equal(pending.settled,false);assert.equal(f.maximum,4);
   const progress=progressShape((await owner.handle({action:'events',after:0})).catalogProgress);assert.equal(progress.phase,'legacy-history');
   reads.resolve();const {result,error}=await within(pending.promise,'Legacy catalog did not finish');assert.ifError(error);assert.equal(result.threads.length,9);
   assert(result.threads.every(thread=>thread.historyOnly===true&&thread.historySource==='legacy'));assert.equal(f.familyCalls.length,14);assert.equal(result.catalogProgress.threadsVerified,14);
   assert(f.calls.some(call=>call.action==='list'&&call.archived));assert.equal(f.admissions,1);assert.equal(f.allocations,0);assert.equal(f.modelLookups,0);
   assert(f.engines.every(engine=>engine.historyOnly));assert.equal(f.closes.length,0,'The pre-existing retained legacy reader lifetime is unchanged');
  }finally{admit.resolve();reads.resolve();await pending.promise;await f.cleanup();}
 });
 await check('legacy history without closure authority never creates a reader',async()=>{
  const f=await fixture('legacy-held',{legacy:true,admission:false});await f.seedLegacy();const owner=f.open();
  try{await assert.rejects(owner.handle({action:'list'}),/explicit native-home closure authority/);assert.equal(f.engines.length,0);assert.equal(f.familyCalls.length,0);assert.equal(f.allocations,0);}
  finally{await f.cleanup();}
 });
 await check('a read failure stops scheduling and drains every admitted read before retirement',async()=>{
  const f=await fixture('read-failure'),first=latch(),others=latch(),four=latch();await (await f.seed(2,8)).close();f.reset();
  f.readHook=async(_engine,_id,call)=>{if(f.familyCalls.length===4)four.resolve();if(call.ordinal===0){await first.promise;throw Error('Fixture family read failed');}await others.promise;};
  const owner=f.open(),pending=track(owner.handle({action:'list'}));
  try{
   await within(four.promise,'Failure fixture did not start four reads');first.resolve();await tick();await tick();
   assert.equal(f.familyCalls.length,4);assert.equal(f.active,3);assert.equal(f.closes.length,0);assert.equal(pending.settled,false);
   others.resolve();await expectFailure(pending,/Fixture family read failed/);
   assert.equal(f.familyCalls.length,4);assert.equal(f.closes.length,1);assert.deepEqual(f.closeWhileReading,[]);
   assert(!f.engines.some(engine=>engine.historyOnly&&engine.dataDir===f.roots[1].home));
  }finally{first.resolve();others.resolve();await pending.promise;await f.cleanup();}
 });
 await check('request cancellation cannot publish or start another family and waits for admitted reads',async()=>{
  const f=await fixture('cancel'),first=latch(),others=latch(),four=latch(),controller=new AbortController();await (await f.seed(2,8)).close();f.reset();
  f.readHook=async(_engine,_id,call)=>{if(f.familyCalls.length===4)four.resolve();await (call.ordinal===0?first.promise:others.promise);};
  const owner=f.open(),pending=track(owner.handle({action:'list'},{requestId:randomUUID(),signal:controller.signal}));
  try{
   await within(four.promise,'Cancellation fixture did not start four reads');controller.abort();first.resolve();await tick();await tick();
   assert.equal(f.familyCalls.length,4);assert.equal(f.closes.length,0);assert.equal(pending.settled,false);
   others.resolve();await expectFailure(pending,/cancelled/);assert.equal(f.familyCalls.length,4);assert.deepEqual(f.closeWhileReading,[]);
   assert(!f.engines.some(engine=>engine.historyOnly&&engine.dataDir===f.roots[1].home));
   const catalog=JSON.parse(await readFile(join(f.home,'coding-owners.json'),'utf8'));assert(catalog.owners.every(row=>row.generation.nativeOpen===false));
  }finally{first.resolve();others.resolve();await pending.promise;await f.cleanup();}
 });
 await check('a changed reader lifetime rejects all rows without an automatic restart',async()=>{
  const f=await fixture('lifetime'),gate=latch(),four=latch();await (await f.seed(1,8)).close();f.reset();
  f.readHook=async()=>{if(f.familyCalls.length===4)four.resolve();await gate.promise;};
  const owner=f.open(),pending=track(owner.handle({action:'list'}));
  try{
   await within(four.promise,'Lifetime fixture did not start four reads');const reader=f.engines.findLast(engine=>engine.historyOnly);
   reader.fail(Error('Fixture reader lifetime ended'));gate.resolve();await expectFailure(pending,/lifecycle changed/);
   assert.equal(f.engines.filter(engine=>engine.historyOnly).length,1);assert.equal(f.familyCalls.length,4);assert.deepEqual(f.closeWhileReading,[]);
  }finally{gate.resolve();await pending.promise;await f.cleanup();}
 });
 await check('wrong root, project, model and provider still fail complete owner verification',async()=>{
  for(const field of ['root','cwd','model','modelProvider']){
   const f=await fixture('identity-'+field);await (await f.seed(1,4)).close();f.reset();
   const saved=await f.rows(f.roots[0].home);
   if(field==='root')saved.push({...saved[0],id:randomUUID(),name:'foreign root'});
   else for(const row of saved)row[field]=field==='cwd'?join(f.project,'foreign'):field==='model'?'different-model':'saleh_cloud';
   await f.save(f.roots[0].home,saved);const owner=f.open();
   try{await assert.rejects(owner.handle({action:'list'}),/root outside its assigned owner/);assert(f.closes.some(row=>row.historyOnly));assert.deepEqual(f.closeWhileReading,[]);}
   finally{await f.cleanup();}
  }
 });
 await check('a duplicate in a later owner prevents the first catalog page from escaping',async()=>{
  const f=await fixture('duplicate-owner');await (await f.seed(2,54)).close();f.reset();
  const second=await f.rows(f.roots[1].home);second[1].id=f.roots[0].rows[1].id;await f.save(f.roots[1].home,second);
  const owner=f.open();
  try{await assert.rejects(owner.handle({action:'list'}),/Duplicate native history ownership|Conflicting verified thread ownership/);assert.equal(f.engines.filter(engine=>engine.historyOnly).length,2);assert.equal(f.closes.filter(row=>row.historyOnly).length,2);assert.deepEqual(f.closeWhileReading,[]);}
  finally{await f.cleanup();}
 });
 await check('managed and legacy identities are checked for collision before exposure',async()=>{
  const f=await fixture('legacy-collision');await (await f.seed(1,4)).close();f.reset();
  await mkdir(join(f.home,'sessions'),{mode:0o700});await f.save(f.home,[f.roots[0].thread,...Array.from({length:4},(_,index)=>({...f.roots[0].thread,id:randomUUID(),name:'legacy other '+index}))]);
  // The explicit generated-home callback grants history inspection only.
  const owner=new CodingOwners({dataDir:f.home,engineOptions:{binary:join(f.home,'never-run-codex')},assertLegacyClosed:async()=>{},
   engineFactory:options=>new (f.engines[0].constructor)(options),openExecutor:async()=>{throw Error('Collision inspection attempted allocation');}});f.owners.push(owner);
  try{await assert.rejects(owner.handle({action:'list'}),/Conflicting managed and legacy thread ownership/);assert.equal(f.familyCalls.length,4);assert.deepEqual(f.closeWhileReading,[]);assert(f.closes.some(row=>row.historyOnly&&row.home===f.home));}
  finally{await f.cleanup();}
 });
 await check('unconfirmed reader retirement withholds rows and preserves its open marker and lease',async()=>{
  const f=await fixture('retirement-failure');await (await f.seed(2,4)).close();f.reset();
  f.closeHook=async engine=>{if(engine.historyOnly)throw Error('Fixture reader closure is unconfirmed');};const owner=f.open();
  try{
   await assert.rejects(owner.handle({action:'list'}),/closure is unconfirmed/);
   const catalog=JSON.parse(await readFile(join(f.home,'coding-owners.json'),'utf8'));assert.equal(catalog.owners[0].generation.nativeOpen,true);assert.equal(catalog.owners[1].generation.nativeOpen,false);await lstat(join(f.home,'coding-owners.lock'));
   assert.equal(f.engines.filter(engine=>engine.historyOnly).length,1);assert.deepEqual(f.closeWhileReading,[]);
  }finally{await f.cleanup();}
 });
 await check('retained unknown native reader markers still refuse catalog opening',async()=>{
  const f=await fixture('unknown-reader');await (await f.seed(1,4)).close();f.reset();
  const path=join(f.home,'coding-owners.json'),catalog=JSON.parse(await readFile(path,'utf8'));catalog.owners[0].generation.nativeOpen=true;await writeFile(path,JSON.stringify(catalog),{mode:0o600});
  const before=f.engines.length,owner=f.open();
  try{await assert.rejects(owner.handle({action:'list'}),/Previous native owner exit is unconfirmed/);assert.equal(f.engines.length,before);assert.equal(f.familyCalls.length,0);await lstat(join(f.home,'coding-owners.lock'));}
  finally{await f.cleanup();}
 });
 await check('verified snapshot pagination reuses no reader and remains archive and search scoped',async()=>{
  const f=await fixture('pagination');await (await f.seed(1,64)).close();f.reset();const owner=f.open();
  try{
   const first=await owner.handle({action:'list'});assert.equal(first.threads.length,50);assert(first.nextCursor);assert.equal(first.catalogProgress.threadsVerified,65);
   const before={reads:f.familyCalls.length,engines:f.engines.length,closes:f.closes.length},second=await owner.handle({action:'list',cursor:first.nextCursor});
   assert.equal(second.threads.length,15);assert.equal(second.nextCursor,null);assert.deepEqual(second.catalogProgress,first.catalogProgress);
   assert.deepEqual({reads:f.familyCalls.length,engines:f.engines.length,closes:f.closes.length},before);
   assert.equal(new Set([...first.threads,...second.threads].map(thread=>thread.id)).size,65);
   await assert.rejects(owner.handle({action:'list',archived:true,cursor:first.nextCursor}),/Expired or invalid coding list cursor/);
   await assert.rejects(owner.handle({action:'list',searchTerm:'fixture',cursor:first.nextCursor}),/Expired or invalid coding list cursor/);
   await assert.rejects(owner.handle({action:'list',cursor:first.nextCursor.split(':')[0]+':01'}),/Expired or invalid coding list cursor/);
   first.catalogProgress.ownersTotal=999;first.threads[0].name='outside mutation';
   const repeat=await owner.handle({action:'list',cursor:second.catalogProgress.id+':50'}).catch(()=>null);assert.equal(repeat,null,'A progress ID is not a pagination capability');
   const search=await owner.handle({action:'list',searchTerm:'child 6'});assert.equal(search.catalogProgress.searching,true);assert(search.threads.every(thread=>thread.name.includes('child 6')));
   const archived=await owner.handle({action:'list',archived:true});assert.equal(archived.catalogProgress.archived,true);assert.equal(archived.threads.length,0);
  }finally{await f.cleanup();}
 });
 await check('incomplete or repeated legacy inventory pages are rejected rather than exposed',async()=>{
  for(const fault of ['truncated','repeated-cursor']){
   const f=await fixture('legacy-page-'+fault,{legacy:true});await f.seedLegacy(6,0);f.pageSize=2;
   f.pageHook=async(_engine,_input,page)=>fault==='truncated'?{...page,truncated:true}:{...page,nextCursor:'0'};
   const owner=f.open();
   try{await assert.rejects(owner.handle({action:'list'}),/incomplete|Duplicate or invalid legacy history identity|pagination/);assert.deepEqual(f.closeWhileReading,[]);assert(f.closes.some(row=>row.historyOnly));}
   finally{await f.cleanup();}
  }
 });
 await check('catalog observations and generated fixtures perform no real process or network action',async()=>{
  assert.equal(processAttempts,0);assert.equal(networkAttempts,0);assert.equal(process.version,'v26.13.0');assert.equal(failures.length,0,'All generated catalog cases must pass');
 });
}finally{
 for(const [name,method] of originalProcessMethods)childProcess[name]=method;globalThis.fetch=originalFetch;syncBuiltinESMExports();
 const report={schemaVersion:1,name:'coding-catalog',passed:checks.length,failed:failures.length,checks,failures,scope:'Generated owner and legacy JSON homes with inert engine transports; no real model, provider, executor, native runtime, application, UI, network or SQLite.',fixtureRoot:root,node:process.version,processAttempts,networkAttempts,observations};
 const bytes=JSON.stringify(report,null,2)+'\n',path=join(root,'RESULT.json');await writeFile(path,bytes,{flag:'wx',mode:0o600});
 console.log('Catalog fixture evidence: '+path+' SHA256 '+sha(bytes));
 console.log(JSON.stringify({schemaVersion:1,name:'coding-catalog',passed:checks.length,failed:failures.length,checks}));
 process.exitCode=failures.length?1:0;
}
