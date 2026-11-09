// Runs actual Chat persistence/leave/structural functions and the prompt input callback.
// Uses the actual attachment serializer, inert DOM controls, a manual timer and gated storage.
// No sockets, models, native operations, browser stores or original app data are accessed.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source=process.argv[2]?resolve(process.argv[2]):fileURLToPath(new URL('.',import.meta.url));
const app=readFileSync(resolve(source,'app.js'),'utf8');
function extract(start,end){
  const a=app.indexOf(start),b=app.indexOf(end,a);
  assert(a>=0&&a===app.lastIndexOf(start)&&b>a,'Actual app source anchors must be unique: '+start);
  return app.slice(a,b);
}
const persistence=extract('function captureSnapshot(', 'function groupChatSidebar(');
const input=extract("$('prompt').addEventListener('input',", "$('prompt').addEventListener('compositionstart',");
const helpers=['attachments.js','attachment-storage.js'].map(name=>readFileSync(resolve(source,name),'utf8')).join('\n');
console.log(JSON.stringify({scope:'source-bound Chat persistence VM; no installed/native acceptance',appSHA256:createHash('sha256').update(app).digest('hex')}));

function gate(){let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};}

function fixture({historyBytes=0}={}){
  const timers=new Map(),writes=[],notices=[],conflicts=[];
  let nextTimer=1,serializations=0,checks=0,hold=null,failure=null;
  const prompt={value:'original draft',handlers:new Map(),addEventListener(name,fn){assert(!this.handlers.has(name));this.handlers.set(name,fn);}};
  const chat={id:'chat-fixture',title:'Retained title',draft:prompt.value,project:'Fixture project',notes:'Retained notes',messages:[{id:'message-1',role:'assistant',content:'x'.repeat(historyBytes),state:'complete',unknown:{kept:true}}],unknown:{kept:'chat'}};
  const context=vm.createContext({
    TextEncoder,TextDecoder,structuredClone,atob,btoa,crypto:webcrypto,
    window:{},document:{body:{}},inspectionTasks:new Set(),attachmentReads:new Map(),
    snapshotFields:{unknownSnapshot:{kept:true}},chats:[chat],selectedId:chat.id,
    observedSnapshot:null,dirtyRevision:0,saveTimer:null,saveTail:Promise.resolve(),
    reconcileTail:Promise.resolve(),reconcileHold:null,reconcileSequence:0,
    storageBlocked:false,storageHydrating:false,pageDisposed:false,restoring:false,
    structuralPending:false,structuralWriting:false,unreadableData:false,computerBusy:false,
    originalData:null,lastSavedSnapshot:null,
    $:id=>{assert.equal(id,'prompt');return prompt;},
    current:()=>context.chats.find(row=>row.id===context.selectedId),
    resize:()=>{},controls:()=>{},notice:value=>notices.push(value),storageNotice:value=>notices.push(value),
    storageConflict:value=>{conflicts.push(value);context.storageBlocked=true;},
    indexedDB:{open(){throw Error('This focused fixture must not access a browser store.');}},
    setTimeout(fn,delay){const id=nextTimer++;timers.set(id,{fn,delay});return id;},
    clearTimeout(id){timers.delete(id);}
  });
  vm.runInContext(helpers,context,{timeout:2000});
  const actualSerialize=context.SalehAttachmentStorage.serialize;
  context.SalehAttachmentStorage.serialize=(...args)=>{serializations++;return actualSerialize(...args);};
  context.attachmentStorage=context.SalehAttachmentStorage;
  const storage={
    async commit(payload){
      const pending=hold;
      if(pending){pending.started.release();await pending.released.promise;if(hold===pending)hold=null;}
      if(failure)throw failure;
      writes.push(payload);
    },
    async check(){checks++;if(failure)throw failure;}
  };
  context.chatStorage=storage;
  vm.runInContext(persistence+'\n'+input,context,{timeout:2000});
  context.lastSavedSnapshot=context.captureSnapshot().payload;
  serializations=0;
  return {
    context,chat,prompt,timers,writes,notices,conflicts,
    get serializations(){return serializations;},get checks(){return checks;},
    input(value){prompt.value=value;prompt.handlers.get('input')({type:'input'});},
    holdCommit(){assert.equal(hold,null);hold={started:gate(),released:gate()};const pending=hold;return {started:pending.started.promise,release:pending.released.release};},
    failCommit(error){failure=error;},
    async fireTimer(){assert.equal(timers.size,1,'Exactly one save timer is pending');const [id,timer]=timers.entries().next().value;assert.equal(timer.delay,500);timers.delete(id);timer.fn();await context.saveTail;},
    saved(){assert(writes.length,'A snapshot must have been committed');return JSON.parse(writes.at(-1));}
  };
}

test('rapid input with 8 MiB history defers all snapshot serialization until the single timer',async()=>{
  const f=fixture({historyBytes:8*1024*1024}),before=f.context.dirtyRevision;
  for(let i=0;i<100;i++)f.input('Latest draft '+i+' العربية 😀');
  assert.equal(f.serializations,0,'Input must not serialize the complete history');
  assert.equal(f.context.dirtyRevision,before+100,'Every input records a revision before an async boundary');
  assert.equal(f.timers.size,1);assert.equal(f.writes.length,0);
  await f.fireTimer();
  assert.equal(f.serializations,2,'The existing save captures once before and once after commit');
  assert.equal(f.writes.length,1);assert.equal(f.saved().chats[0].draft,f.prompt.value);
  assert.equal(f.saved().chats[0].messages[0].content.length,8*1024*1024);
  assert.deepEqual(f.saved().chats[0].messages[0].unknown,{kept:true});
  assert.deepEqual(f.saved().unknownSnapshot,{kept:true});
});

test('explicit leave cancels the pending timer and commits the latest draft before returning true',async()=>{
  const f=fixture();f.input('Unsent draft saved before leave');
  assert.equal(f.serializations,0);
  assert.equal(await f.context.window.salehSaveBeforeLeave(),true);
  assert.equal(f.timers.size,0);assert.equal(f.saved().chats[0].draft,f.prompt.value);
  assert.equal(f.context.lastSavedSnapshot,f.writes.at(-1));
});

test('an edit during a held save prevents a successful acknowledgment and the timer saves newer text',async()=>{
  const f=fixture();f.input('Submitted snapshot');const held=f.holdCommit();
  const saving=f.context.save();await held.started;
  f.input('Newer unsent text');held.release();
  assert.equal(await saving,false,'An older saved snapshot must not acknowledge newer edits');
  assert.equal(f.saved().chats[0].draft,'Submitted snapshot');
  assert.equal(f.chat.draft,'Newer unsent text');
  await f.fireTimer();assert.equal(f.saved().chats[0].draft,'Newer unsent text');
});

test('edit then revert during a held save remains observable even when serialized bytes match',async()=>{
  const f=fixture();f.input('Candidate');const held=f.holdCommit();
  const saving=f.context.save();await held.started;
  const serializations=f.serializations;
  f.input('Temporary change');f.input('Candidate');
  assert.equal(f.serializations,serializations,'Reversion detection does not require serializing edits');
  held.release();assert.equal(await saving,false,'An ABA edit must invalidate the earlier revision');
  assert.equal(f.saved().chats[0].draft,'Candidate');
  assert.equal(await f.context.window.salehSaveBeforeLeave(),true,'A new stable explicit save can acknowledge the current draft');
  assert.equal(f.checks,1);assert.equal(f.timers.size,0);
});

test('leave refuses an edit-revert race during its save and succeeds on a fresh stable attempt',async()=>{
  const f=fixture();f.input('Leaving candidate');const held=f.holdCommit();
  const leaving=f.context.window.salehSaveBeforeLeave();await held.started;
  f.input('Changed during leave');f.input('Leaving candidate');held.release();
  assert.equal(await leaving,false);
  assert.equal(await f.context.window.salehSaveBeforeLeave(),true);
  assert.equal(f.saved().chats[0].draft,'Leaving candidate');
});

test('structural commit retains its revision conflict guard for an edit-revert race',async()=>{
  const f=fixture(),held=f.holdCommit();let applied=false;
  const changing=f.context.changeSnapshot(()=>({
    value:{...f.context.snapshotFields,chats:[{...f.chat,title:'Structural title'}],selectedId:f.chat.id},
    apply(){applied=true;f.chat.title='Structural title';}
  }));
  await held.started;f.input('Transient edit');f.input('original draft');held.release();
  await assert.rejects(changing,/workspace changed while saving/);
  assert.equal(applied,false);assert.equal(f.chat.title,'Retained title');
  assert.equal(f.context.storageBlocked,true);assert.equal(f.conflicts.length,1);
  assert.equal(await f.context.window.salehSaveBeforeLeave(),false);
});

test('unchanged structural transactions still commit and apply normally',async()=>{
  const f=fixture();
  assert.equal(await f.context.changeSnapshot(()=>({
    value:{...f.context.snapshotFields,chats:[{...f.chat,title:'Updated title'}],selectedId:f.chat.id},
    apply(){f.chat.title='Updated title';}
  })),true);
  assert.equal(f.saved().chats[0].title,'Updated title');assert.equal(f.chat.title,'Updated title');
  assert.equal(f.context.storageBlocked,false);assert.equal(f.timers.size,0);
});

test('deferred serialization errors still prevent save and leave without committing',async()=>{
  const f=fixture();f.context.snapshotFields.circular=f.context.snapshotFields;
  f.input('Draft with invalid snapshot');assert.equal(f.serializations,0);
  await f.fireTimer();
  assert.equal(f.writes.length,0);assert(f.notices.some(value=>/could not be saved/.test(value)));
  assert.equal(await f.context.window.salehSaveBeforeLeave(),false);
  assert.equal(f.chat.draft,'Draft with invalid snapshot');
});

test('a storage conflict blocks acknowledgment and preserves the unsent draft',async()=>{
  const f=fixture();f.input('Retain this on conflict');
  f.failCommit(Object.assign(Error('Fixture stale snapshot'),{code:'conflict'}));
  assert.equal(await f.context.save(),false);assert.equal(f.context.storageBlocked,true);
  assert.equal(f.writes.length,0);assert.equal(f.chat.draft,'Retain this on conflict');
  assert.equal(await f.context.window.salehSaveBeforeLeave(),false);
});

test('existing save admission flags still prevent pending input from writing',async()=>{
  for(const flag of ['storageBlocked','storageHydrating','pageDisposed','restoring','structuralWriting']){
    const f=fixture();f.input('Retained while '+flag);f.context[flag]=true;
    await f.fireTimer();assert.equal(f.writes.length,0,flag);assert.equal(f.serializations,0,flag);
  }
});
