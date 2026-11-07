import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile,rename,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodingEngine} from './coding-engine.mjs';

const root=await realpath(await mkdtemp(join(tmpdir(),'coding-empty-model-check-'))),saved={id:'owned-empty',cwd:root,model:'fixture/selected-model',modelProvider:'saleh_local'};
class FixtureEngine extends CodingEngine {
 constructor(home){super({dataDir:home,localModels:{async resolve(id){return {id,generation:{}};}}});this.calls=[];this.metadata={...saved,model:null,path:join(home,'sessions','empty.jsonl'),historyMode:'legacy',ephemeral:false,parentThreadId:null,status:{type:'notLoaded'},turns:[]};this.full={thread:structuredClone(this.metadata)};}
 async ensure(){if(!this.processLife){this.child={};this.processLife={child:this.child,exited:false};}}
 async prepare(){}
 async temporaryEnvironment(){return {};}
 async addReceipts(){return false;}
 async close(){this.closed=true;this.child=null;this.processLife=null;}
 async rpc(method,params){
  this.calls.push({method,params:structuredClone(params)});
  if(method==='thread/turns/list'){
   assert.equal(params.threadId,saved.id);assert.equal(params.limit,1);assert.equal(params.sortDirection,'desc');assert.equal(params.itemsView,'full');
   const turns=structuredClone(this.full.thread.turns).reverse(),index=Number(params.cursor??0);
   return {data:turns.slice(index,index+1),nextCursor:index+1<turns.length?String(index+1):null};
  }
  if(method==='thread/read')return structuredClone(params.includeTurns?this.full:{thread:this.metadata});if(method==='thread/list')return {data:params.ancestorThreadId||this.omitFromList?[]:[structuredClone(this.listed??this.metadata)],nextCursor:null};if(method==='thread/resume')return {thread:{...this.metadata,model:params.model,modelProvider:params.modelProvider}};if(method==='turn/start')return {turn:{id:'explicit-turn',status:'completed'}};throw Error('Unexpected fixture RPC '+method);
 }
}
let serial=0;
async function fixture(){const home=join(root,String(++serial));await mkdir(home,{mode:0o700});const engine=new FixtureEngine(home);await mkdir(join(home,'sessions'),{mode:0o700});await writeFile(engine.metadata.path,'fixture persisted rollout\n',{mode:0o600});engine.bindOwnedRoot(saved);await engine.ensure();return engine;}
try{
 // Exercise the real small-summary projection, including its native empty-root
 // and family routes. Only RPC/configuration are inert; threadView is not stubbed.
 for(const field of ['name','agentNickname','preview'])for(const variant of ['absent','null','empty','literal']){
  const e=await fixture();try{
   // The padding key costs seven units. The title key then uses exactly the
   // remaining budget, exposing a null/empty value at the exhausted boundary.
   const value=variant==='null'?null:variant==='literal'?'[truncated]':'';
   e.metadata={padding:'x'.repeat(1000-7-field.length),...(variant==='absent'?{}:{[field]:value}),...e.metadata};
   e.full.thread=structuredClone(e.metadata);e.omitFromList=true;
   const before=structuredClone(e.metadata),view=e.threadView(e.metadata,8000);
   assert.equal(view.truncated,true,`${field}/${variant}: real metadata clipping remains signalled`);
   const projections=[['summary',view.value],['empty-root',await e.ownedEmptyRoot(false)],['family-root',(await e.handle({action:'family',threadId:saved.id})).root]];
   for(const [route,thread]of projections){
    assert.equal(thread[field],before[field],`${route} ${field}/${variant}: title metadata must not become a synthetic truncation label`);
    assert.equal(Object.hasOwn(thread,field),Object.hasOwn(before,field),`${route} ${field}/${variant}: absent title metadata stays absent`);
    assert.equal(thread.id,saved.id);assert.equal(thread.cwd,saved.cwd);
   }
   assert.deepEqual(e.metadata,before,'Projection must not rewrite source metadata');
   assert(!e.calls.some(c=>['thread/resume','turn/start','command/exec','thread/name/set'].includes(c.method)),'Title recovery must not execute or rename');
  }finally{await e.close();}
 }
 // A cold native list can retain a pre-handoff cwd while thread/read has
 // the committed destination. Listing must use the same strict reader binding.
 for(const archived of [false,true]){const e=await fixture();try{
  e.metadata.model=saved.model;e.full.thread={...e.metadata,turns:[{id:'saved-turn',status:'completed',items:[]}]};
  e.listed={...e.metadata,cwd:join(root,'before-handoff'),updatedAt:200};e.metadata.updatedAt=100;
  const listed=await e.handle({action:'list',archived});
  assert.equal(listed.threads[0].cwd,saved.cwd,'Cold list must resolve the committed owner cwd through thread/read');
  assert.equal(listed.threads[0].model,saved.model);assert.equal(listed.threads[0].updatedAt,200,'Keep native list recency');
  assert.equal((await e.handle({action:'read',threadId:saved.id})).thread.turns.length,1);
  for(const [key,value] of [['cwd','/wrong-project'],['model','fixture/wrong'],['modelProvider','saleh_cloud'],['id','wrong-root'],['parentThreadId','wrong-parent']]){
   const original=e.metadata;e.metadata={...original,[key]:value};
   await assert.rejects(e.handle({action:'list',archived}),/binding|isolated/i,'A stale summary must not bypass the authoritative '+key+' check');e.metadata=original;
  }
  assert(!e.calls.some(c=>['thread/resume','turn/start','command/exec'].includes(c.method)),'Cold list recovery never resumes or dispatches work');
 }finally{await e.close();}}
 const cancelled=await fixture();try{
  const rpc=cancelled.rpc.bind(cancelled);cancelled.rpc=async(method,params)=>{const result=await rpc(method,params);if(method==='thread/read')cancelled.epoch++;return result;};
  await assert.rejects(cancelled.handle({action:'list'}),/cancelled/i,'Stop during list verification revokes the result');
  assert(!cancelled.calls.some(c=>['thread/resume','turn/start','command/exec'].includes(c.method)));
 }finally{await cancelled.close();}
 const inventory=await fixture();try{
  inventory.metadata.model=saved.model;const other={id:'other-root',cwd:'/other-project',model:'other-model'},rpc=inventory.rpc.bind(inventory);
  inventory.rpc=async(method,params)=>method==='thread/list'?{data:[{...inventory.metadata,cwd:'/old-project'},structuredClone(other)],nextCursor:'next-page'}:rpc(method,params);
  const result=await inventory.handle({action:'list'});assert.deepEqual(result.threads[1],other);assert.equal(result.nextCursor,'next-page');assert.equal(inventory.calls.filter(c=>c.method==='thread/read').length,1);
 }finally{await inventory.close();}
 console.log('PASS cold moved-root list resolves authoritative history and retains all root binding checks');
 const clipped=await fixture();try{
  clipped.metadata.model=saved.model;clipped.metadata.name='[truncated]';clipped.full.thread={...clipped.metadata,preview:'',turns:[{id:'large-turn',status:'completed',items:[{id:'large-answer',type:'agentMessage',text:'x'.repeat(600000)}]}]};
  const read=await clipped.handle({action:'read',threadId:saved.id});
  assert.equal(read.thread.name,'[truncated]','A genuine literal name is preserved');assert.equal(read.historyTruncated,true,'Genuinely oversized history retains its truncation flag');
  clipped.historyWarning='Fixture: retained history remains incomplete';
  const warned=await clipped.handle({action:'read',threadId:saved.id});
  assert.equal(warned.historyWarning,clipped.historyWarning,'Existing history warning survives title projection');assert.equal(warned.historyTruncated,true);
  assert(!clipped.calls.some(c=>['thread/resume','turn/start','command/exec','thread/name/set'].includes(c.method)),'History warning inspection must not execute or rename');
 }finally{await clipped.close();}
 console.log('PASS empty title boundaries across summary/native empty-root/family and genuine truncation evidence');
 const engine=await fixture();try{
  assert.equal((await engine.thread(saved.id)).model,saved.model);assert.equal((await engine.handle({action:'read',threadId:saved.id})).thread.model,saved.model);assert.equal((await engine.handle({action:'list'})).threads[0].model,saved.model);assert.equal((await engine.handle({action:'family',threadId:saved.id})).root.model,saved.model);
  assert(engine.calls.filter(c=>c.method==='thread/read'&&c.params.includeTurns===true).length>=4,'Each null-model route verifies complete history');assert(!engine.calls.some(c=>/^(turn|command)\//.test(c.method)),'Reading empty history never dispatches work');
  assert((await engine.handle({action:'send',threadId:saved.id,text:'first explicit user message'})).turn);assert.equal(engine.calls.find(c=>c.method==='thread/resume').params.model,saved.model);assert.equal(engine.calls.find(c=>c.method==='turn/start').params.model,saved.model);assert.equal(engine.calls.filter(c=>c.method==='turn/start').length,1);
  assert.throws(()=>engine.bindOwnedRoot({...saved,model:'fixture/other'}),/cannot change/);assert.throws(()=>engine.bindOwnedRoot({...saved,extra:true}),/binding/);
 }finally{await engine.close();}
 for(const archived of [false,true]){const e=await fixture();try{
  if(archived){const path=join(e.dataDir,'archived_sessions','empty.jsonl');await mkdir(join(e.dataDir,'archived_sessions'),{mode:0o700});await rename(e.metadata.path,path);e.metadata.path=e.full.thread.path=path;}
  e.omitFromList=true;assert.deepEqual((await e.handle({action:'list',archived})).threads,[],'Protocol can omit a persisted empty root');
  const thread=await e.ownedEmptyRoot(archived);assert.equal(thread.id,saved.id);assert.equal(thread.model,saved.model);assert.deepEqual(thread.turns,[]);assert.equal(await e.ownedEmptyRoot(!archived),null,'Verified root belongs only to its real archive lane');
  e.metadata.model=e.full.thread.model=saved.model;assert.equal((await e.ownedEmptyRoot(archived)).model,saved.model,'Exact nonnull model still requires an empty proof');e.full.thread.turns=[{id:'real-turn',status:'completed',items:[]}];assert.equal(await e.ownedEmptyRoot(archived),null,'Nonempty roots are not rescued from an omitted list');
  assert(!e.calls.some(c=>['thread/resume','turn/start','command/exec'].includes(c.method)),'Catalog proof never dispatches work');
 }finally{await e.close();}}
 for(const kind of ['wrong-id','null-nonempty','malformed-turns','partial','symlink','stop']){const e=await fixture();try{
  if(kind==='wrong-id')e.full.thread.id='different-root';
  if(kind==='null-nonempty')e.full.thread.turns=[{id:'unbound-turn',status:'completed',items:[]}];
  if(kind==='malformed-turns')delete e.full.thread.turns;
  if(kind==='partial')e.full.historyTruncated=true;
  if(kind==='symlink'){const path=join(e.dataDir,'sessions','alias.jsonl');await symlink(e.metadata.path,path);e.metadata.path=e.full.thread.path=path;}
  if(kind==='stop'){const rpc=e.rpc.bind(e);e.rpc=async(...args)=>{const result=await rpc(...args);e.epoch++;return result;};}
  await assert.rejects(e.ownedEmptyRoot(false),/binding|empty-root|canonical|cancelled/i,kind);assert(!e.calls.some(c=>['thread/resume','turn/start','command/exec'].includes(c.method)),kind+' catalog proof must not dispatch');
 }finally{await e.close();}}
 const cases={
  'nonnull-model':e=>{e.metadata.model='fixture/wrong';},
  'missing-model':e=>{delete e.metadata.model;},
  'wrong-cwd':e=>{e.metadata.cwd='/';},
  'wrong-provider':e=>{e.metadata.modelProvider='saleh_cloud';},
  'wrong-id':e=>{e.metadata.id='different-root';},
  'child':e=>{e.metadata.parentThreadId='different-root';},
  'nonempty':e=>{e.full.thread.turns=[{id:'saved-turn',status:'completed',items:[]}];},
  'malformed-turns':e=>{delete e.full.thread.turns;},
  'wrong-proof-id':e=>{e.full.thread.id='different-root';},
  'wrong-proof-model':e=>{e.full.thread.model='fixture/wrong';},
  'wrong-proof-cwd':e=>{e.full.thread.cwd='/';},
  'wrong-proof-provider':e=>{e.full.thread.modelProvider='saleh_cloud';},
  'wrong-proof-child':e=>{e.full.thread.canAcceptDirectInput=false;},
  'changed-path':e=>{e.full.thread.path=join(e.dataDir,'sessions','other.jsonl');},
  'outside-path':e=>{e.metadata.path=e.full.thread.path='/outside.jsonl';},
  'ephemeral':e=>{e.full.thread.ephemeral=true;},
  'active':e=>{e.full.thread.status={type:'active'};},
  'truncated':e=>{e.full.historyTruncated=true;},
  'warning':e=>{e.full.historyWarning='uncertain history';},
  'pending':e=>{e.full.pendingMaterialization=true;},
  'more-pages':e=>{e.full.nextCursor='next';},
  'partial':e=>{e.liveHistory.set(saved.id,{turns:[{id:'partial',items:[]}],truncated:false});},
  'evicted':e=>{e.liveHistoryEvicted=true;},
  'blocked':e=>{e.historyBlocked=true;},
  'local-warning':e=>{e.historyWarning='saved-history warning';},
 };
 for(const [name,mutate]of Object.entries(cases)){const e=await fixture();try{mutate(e);await assert.rejects(e.handle({action:'send',threadId:saved.id,text:'must not dispatch'}),/binding|empty-root|isolated|history/i,name);assert(!e.calls.some(c=>['thread/resume','turn/start','command/exec'].includes(c.method)),name+' must not dispatch');}finally{await e.close();}}
 const unbound=await fixture();await unbound.close();const ordinary=new FixtureEngine(join(root,'ordinary'));try{await ordinary.ensure();assert.equal((await ordinary.thread(saved.id)).model,null,'Unbound and VM/legacy engines do not acquire a model fallback');}finally{await ordinary.close();}
 console.log('PASS owned native empty model across thread/read/list/family/send and strict malformed/nonempty/partial refusal');
}finally{await rm(root,{recursive:true,force:true});}
