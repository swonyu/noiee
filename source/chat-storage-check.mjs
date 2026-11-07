// Disposable browser storage only: no app server, models, native bridge or external requests.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const KEY='qwen-local-chats-v1',DB='saleh-chat-snapshots-v1',STORE='snapshots';
const source=new URL('./chat-storage.js',import.meta.url),passed=[],external=[];
const server=createServer(async(req,res)=>{
  if(req.url==='/chat-storage.js'){
    let script;try{script=await readFile(source,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;script='';}
    res.writeHead(200,{'content-type':'text/javascript'});res.end(script);return;
  }
  res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Private chat storage check</title>');
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const origin='http://127.0.0.1:'+server.address().port;
let browser;
async function fixture(legacy=null){
  const context=await browser.newContext();
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();external.push(route.request().url());return route.abort('blockedbyclient');});
  const page=await context.newPage();await page.goto(origin);
  if(legacy!==null)await page.evaluate(({KEY,legacy})=>localStorage.setItem(KEY,legacy),{KEY,legacy});
  await attach(page);return {context,page};
}
async function attach(page){
  await page.addScriptTag({url:origin+'/chat-storage.js'});
  assert.equal(await page.evaluate(()=>typeof window.SalehChatStorage?.load),'function','Atomic chat snapshot API is missing');
  await page.evaluate(({DB,STORE})=>{
    const database=()=>new Promise((resolve,reject)=>{const q=indexedDB.open(DB,1);q.onupgradeneeded=()=>q.result.createObjectStore(STORE);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    window.fixtureRecord=async(key='head',value,write=false)=>{const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,write?'readwrite':'readonly'),s=tx.objectStore(STORE),q=write?s.put(value,key):s.get(key);let result;q.onsuccess=()=>result=q.result;tx.oncomplete=()=>resolve(result??null);tx.onabort=()=>reject(tx.error||Error('Fixture transaction aborted'));});}finally{db.close();}};
  },{DB,STORE});
}
const load=page=>page.evaluate(()=>SalehChatStorage.load(async payload=>{JSON.parse(payload);}));
const commit=(page,payload,options)=>page.evaluate(({payload,options})=>SalehChatStorage.commit(payload,options),{payload,options});
const head=page=>page.evaluate(()=>fixtureRecord());
const error=(page,operation)=>page.evaluate(async operation=>{try{await eval(operation);return null;}catch(e){return {message:e.message,code:e.code||null};}},operation);
async function pendingFixture(){
  const result=await fixture(history);await result.page.evaluate(async()=>{let calls=0;try{await SalehChatStorage.load(async payload=>{JSON.parse(payload);if(++calls===2)throw Error('fixture pending interruption');});}catch(e){if(!e.message.includes('pending interruption'))throw e;}});
  await result.page.reload();await attach(result.page);assert.equal((await error(result.page,'SalehChatStorage.load(async payload=>JSON.parse(payload))')).code,'pending');return result;
}
const history=JSON.stringify({chats:[{id:'retained-chat',draft:'UNSENT',unknown:{keep:true},messages:[{id:'earlier-answer',role:'assistant',content:'KEEP',reasoning:'r'.repeat(100000),laterReceipt:{id:'later-receipt',imported:false}}]}],selectedId:'retained-chat'});
const edited=JSON.stringify({...JSON.parse(history),laterEdit:'SECOND'}),recovered=JSON.stringify({...JSON.parse(history),recovered:true});
try{
  browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  {
    const {context,page}=await fixture(' \n'+history+'\n '),legacy=await page.evaluate(KEY=>localStorage.getItem(KEY),KEY);
    const quota=await page.evaluate(KEY=>{try{localStorage.setItem(KEY,'x'.repeat(12*1024*1024));return '';}catch(e){return e.name;}},KEY);assert.equal(quota,'QuotaExceededError');
    const result=await page.evaluate(()=>{window.verified=[];return SalehChatStorage.load(async payload=>{JSON.parse(payload);verified.push(payload);});});
    assert.equal(result,legacy);assert.deepEqual(await page.evaluate(()=>verified),[legacy,legacy]);assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),legacy);
    const first=await head(page);assert.equal(first.state,'authoritative');assert.equal(first.revision,1);assert.equal(first.payload,legacy);assert.equal(first.hash,first.legacyHash);assert.match(first.commitId,/^[a-f0-9-]{36}$/);
    assert.deepEqual(await page.evaluate(()=>SalehChatStorage.identity),{revision:1,commitId:first.commitId});
    const larger=JSON.stringify({chats:[],selectedId:'',large:'x'.repeat(12*1024*1024)});await commit(page,larger);assert.equal((await head(page)).revision,2);assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),legacy);
    await page.reload();await attach(page);assert.equal(await load(page),larger);assert.equal((await head(page)).revision,2);
    await context.close();passed.push('real quota failure, byte-exact migration/readback, larger IndexedDB history and reload');
  }
  {
    const {context,page}=await fixture();assert.equal(await load(page),null);assert.deepEqual(await page.evaluate(()=>SalehChatStorage.identity),{revision:0,commitId:null});
    await commit(page,history);const first=await head(page);assert.equal(first.revision,1);assert.equal(first.legacyHash,null);
    const order=await page.evaluate(async({edited,recovered})=>{const events=[],original=IDBObjectStore.prototype.put,transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(this.name==='saleh-chat-snapshots-v1'&&args[1]==='readwrite')tx.addEventListener('complete',()=>events.push('complete:'+tx.fixtureRevision));return tx;};IDBObjectStore.prototype.put=function(value,key){const q=original.call(this,value,key);if(this.name==='snapshots'&&key==='head'){q.transaction.fixtureRevision=value.revision;q.addEventListener('success',()=>events.push('request:'+value.revision));}return q;};try{await Promise.all([SalehChatStorage.commit(edited).then(()=>events.push('resolved:2')),SalehChatStorage.commit(recovered).then(()=>events.push('resolved:3'))]);return events;}finally{IDBObjectStore.prototype.put=original;IDBDatabase.prototype.transaction=transaction;}},{edited,recovered});
    assert.deepEqual(order,['request:2','complete:2','resolved:2','request:3','complete:3','resolved:3']);assert.equal((await head(page)).payload,recovered);
    await context.close();passed.push('empty identity, serialized writes and resolution only after transaction completion');
  }
  {
    const {context,page}=await fixture(history),failure=await error(page,"SalehChatStorage.load(async()=>{throw Error('fixture image missing');})");assert.match(failure.message,/image missing/);assert.equal(await head(page),null);assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),history);
    const interrupted=await page.evaluate(async()=>{let calls=0;try{await SalehChatStorage.load(async payload=>{JSON.parse(payload);if(++calls===2)throw Error('fixture interrupted after pending');});return null;}catch(e){return e.message;}});assert.match(interrupted,/interrupted/);const pending=await head(page);assert.equal(pending.state,'pending');assert.equal(pending.payload,history);
    await page.reload();await attach(page);const blocked=await error(page,'SalehChatStorage.load(async()=>{throw Error("Verifier must not select a pending source");})');assert.match(blocked.message,/pending|migration/i);assert.deepEqual(await head(page),pending);assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),history);
    await context.close();passed.push('failed image/schema verification preserves legacy; unresolved pending blocks without fallback');
  }
  {
    const {context,page}=await fixture(history);const changed=await error(page,"SalehChatStorage.load(async()=>{localStorage.setItem('qwen-local-chats-v1','CHANGED_LEGACY');})");assert.equal(changed.code,'conflict');assert.equal(await head(page),null);assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),'CHANGED_LEGACY');
    await context.close();passed.push('legacy writer during validation blocks migration');
  }
  {
    const {context,page}=await fixture(history);await load(page);const peer=await context.newPage();await peer.goto(origin);await attach(peer);await load(peer);
    await commit(page,edited);const winning=await head(page),stale=await error(peer,`SalehChatStorage.commit(${JSON.stringify(recovered)})`);assert.equal(stale.code,'conflict');assert.deepEqual(await head(page),winning);assert.equal((await error(peer,'SalehChatStorage.check()')).code,'conflict');
    await context.close();passed.push('stale writer detects full expected head and preserves the winning payload');
  }
  {
    const {context,page}=await fixture(history);await load(page);const peer=await context.newPage();await peer.goto(origin);await attach(peer);await load(peer);
    const results=await Promise.allSettled([commit(page,edited),commit(peer,recovered)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal((await head(page)).revision,2);
    await context.close();passed.push('simultaneous compare-and-swap admits exactly one writer');
  }
  {
    const {context,page}=await fixture(history);await load(page);const before=await head(page);
    const failure=await page.evaluate(async payload=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const q=original.call(this,value,key);if(this.name==='snapshots'&&key==='head'){IDBObjectStore.prototype.put=original;window.abortedCommitId=value.commitId;q.addEventListener('success',()=>q.transaction.abort());}return q;};try{await SalehChatStorage.commit(payload,{preservePrevious:true,expected:SalehChatStorage.identity});return null;}catch(e){return e.message;}finally{IDBObjectStore.prototype.put=original;}},edited);
    assert.match(failure,/abort|transaction|complete/i);assert.deepEqual(await head(page),before);assert.equal(await page.evaluate(()=>fixtureRecord('previous:'+abortedCommitId)),null);assert.deepEqual(await page.evaluate(()=>SalehChatStorage.identity),{revision:before.revision,commitId:before.commitId});await commit(page,recovered);assert.equal((await head(page)).payload,recovered);
    await context.close();passed.push('abort after put success rejects and leaves old head/identity intact; queue remains usable');
  }
  {
    const {context,page}=await fixture(history);await load(page);const before=await head(page),expected=await page.evaluate(()=>SalehChatStorage.identity);await page.evaluate(async({recovered,expected})=>{const saving=SalehChatStorage.commit(recovered,{preservePrevious:true,expected});expected.revision=-1;expected.commitId='MUTATED_AFTER_CALL';await saving;},{recovered,expected});const after=await head(page);assert.equal(after.revision,before.revision+1);assert.deepEqual(await page.evaluate(key=>fixtureRecord(key),'previous:'+after.commitId),before);
    const stale=await page.evaluate(async({edited,recovered})=>{const expected=SalehChatStorage.identity,first=SalehChatStorage.commit(edited),second=SalehChatStorage.commit(recovered,{preservePrevious:true,expected});return (await Promise.allSettled([first,second])).map(r=>r.status==='fulfilled'?{status:r.status}:{status:r.status,code:r.reason.code});},{edited,recovered});assert.deepEqual(stale,[{status:'fulfilled'},{status:'rejected',code:'conflict'}]);assert.equal((await head(page)).payload,edited);
    await context.close();passed.push('recovery atomically retains predecessor and honors its explicit pin across queued writes');
  }
  {
    const {context,page}=await fixture(history);await load(page);const before=await head(page);await page.evaluate(value=>fixtureRecord('head',{...value,payload:value.payload+' '},true),before);assert.equal((await error(page,'SalehChatStorage.check()')).code,'conflict');assert.equal((await error(page,`SalehChatStorage.commit(${JSON.stringify(edited)})`)).code,'conflict');assert.equal((await head(page)).payload,before.payload+' ');
    await context.close();passed.push('same revision/commit identity with changed payload blocks check and saving');
  }
  {
    const {context,page}=await fixture(history);await load(page);const before=await head(page);await page.evaluate(()=>localStorage.setItem('qwen-local-chats-v1','FOREIGN'));assert.equal((await error(page,'SalehChatStorage.check()')).code,'conflict');assert.equal((await error(page,`SalehChatStorage.commit(${JSON.stringify(edited)})`)).code,'conflict');assert.deepEqual(await head(page),before);
    await context.close();passed.push('changed legacy remains a save/inference conflict after authoritative migration');
  }
  for(const cleared of [false,true]){
    const {context,page}=await fixture(history);await load(page);const before=await head(page);
    // Fault injection: a queued real change/clear event can arrive after the source bytes are restored.
    await page.evaluate(({history,cleared})=>dispatchEvent(new StorageEvent('storage',{key:cleared?null:'qwen-local-chats-v1',oldValue:cleared?null:history,newValue:cleared?null:'TEMPORARY_FOREIGN_WRITE',storageArea:localStorage})),{history,cleared});
    assert.equal((await error(page,'SalehChatStorage.check()'))?.code,'conflict');assert.deepEqual(await head(page),before);assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),history);
    await context.close();passed.push('queued legacy '+(cleared?'clear':'change')+' signal blocks after original bytes are restored');
  }
  {
    const {context,page}=await fixture(history);await load(page);const before=await head(page);
    await page.evaluate(async({before,edited})=>{const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(edited)))].map(n=>n.toString(16).padStart(2,'0')).join('');await fixtureRecord('head',{...before,payload:edited,hash},true);},{before,edited});
    await page.reload();await attach(page);const invalid=await error(page,'SalehChatStorage.load(async payload=>JSON.parse(payload))');assert.match(invalid?.message??'',/invalid|source|migration/i);assert.equal((await head(page)).payload,edited);assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),history);
    await context.close();passed.push('first migration revision must still match its exact legacy source');
  }
  {
    const {context,page}=await pendingFixture(),pending=await head(page);
    assert.equal(await page.evaluate(()=>typeof SalehChatStorage.recoveryBase),'function','Explicit pending recovery base API is missing');
    assert.equal(await page.evaluate(()=>typeof SalehChatStorage.recover),'function','Explicit pending recovery API is missing');
    const base=await page.evaluate(()=>SalehChatStorage.recoveryBase());assert.deepEqual(base,{payload:history,identity:{revision:pending.revision,commitId:pending.commitId}});assert.deepEqual(await head(page),pending);assert.equal(await page.evaluate(()=>SalehChatStorage.identity),null);
    await page.evaluate(({recovered,expected})=>{window.fixtureRecovery=SalehChatStorage.recover(recovered,expected,async(next,old)=>{JSON.parse(next);JSON.parse(old);if(JSON.stringify(JSON.parse(next).chats)!==JSON.stringify(JSON.parse(old).chats))throw Error('Earlier history changed');window.fixtureVerifying=true;await new Promise(resolve=>window.fixtureReleaseRecovery=resolve);});expected.revision=-1;expected.commitId='MUTATED_AFTER_CALL';},{recovered,expected:base.identity});
    await page.waitForFunction(()=>window.fixtureVerifying);assert.deepEqual(await head(page),pending);assert.equal(await page.evaluate(()=>SalehChatStorage.identity),null);await page.evaluate(()=>fixtureReleaseRecovery());await page.evaluate(()=>fixtureRecovery);
    const resolved=await head(page);assert.equal(resolved.state,'authoritative');assert.equal(resolved.revision,2);assert.equal(resolved.payload,recovered);assert.deepEqual(await page.evaluate(key=>fixtureRecord(key),'previous:'+resolved.commitId),pending);assert.deepEqual(await page.evaluate(()=>SalehChatStorage.identity),{revision:2,commitId:resolved.commitId});assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),history);
    await commit(page,edited);await page.reload();await attach(page);assert.equal(await load(page),edited);
    await context.close();passed.push('explicit pending recovery verifies both payloads before atomic predecessor commit and enables normal loading/saving');
  }
  {
    const {context,page}=await pendingFixture(),pending=await head(page);await page.evaluate(async()=>{window.recoveryChoice=await SalehChatStorage.recoveryBase();});
    const refused=await error(page,`SalehChatStorage.recover(${JSON.stringify(recovered)},recoveryChoice.identity,async()=>{throw Error('fixture exact-append or image verification rejected');})`);assert.match(refused.message,/verification rejected/);assert.deepEqual(await head(page),pending);assert.equal(await page.evaluate(()=>SalehChatStorage.identity),null);
    await page.evaluate(payload=>SalehChatStorage.recover(payload,recoveryChoice.identity,async(next,old)=>{JSON.parse(next);JSON.parse(old);}),recovered);assert.equal((await head(page)).payload,recovered);
    await context.close();passed.push('rejected explicit recovery verifier keeps pending source and permits a validated retry');
  }
  {
    const {context,page}=await pendingFixture(),pending=await head(page);await page.evaluate(async()=>{window.recoveryChoice=await SalehChatStorage.recoveryBase();});
    const failed=await page.evaluate(async payload=>{const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value,key){const q=original.call(this,value,key);if(this.name==='snapshots'&&key==='head'){IDBObjectStore.prototype.put=original;window.abortedRecoveryId=value.commitId;q.addEventListener('success',()=>q.transaction.abort());}return q;};try{await SalehChatStorage.recover(payload,recoveryChoice.identity,async(next,old)=>{JSON.parse(next);JSON.parse(old);});return null;}catch(e){return e.message;}finally{IDBObjectStore.prototype.put=original;}},recovered);
    assert.match(failed,/transaction|abort|complete/i);assert.deepEqual(await head(page),pending);assert.equal(await page.evaluate(()=>fixtureRecord('previous:'+abortedRecoveryId)),null);assert.equal(await page.evaluate(()=>SalehChatStorage.identity),null);
    await page.evaluate(payload=>SalehChatStorage.recover(payload,recoveryChoice.identity,async(next,old)=>{JSON.parse(next);JSON.parse(old);}),recovered);assert.equal((await head(page)).state,'authoritative');
    await context.close();passed.push('aborted pending recovery rolls back predecessor and head before a successful explicit retry');
  }
  {
    const {context,page}=await pendingFixture();await page.evaluate(async()=>{window.recoveryChoice=await SalehChatStorage.recoveryBase();});const peer=await context.newPage();await peer.goto(origin);await attach(peer);const peerChoice=await peer.evaluate(()=>SalehChatStorage.recoveryBase());
    await page.evaluate(payload=>{window.fixtureRecovery=SalehChatStorage.recover(payload,recoveryChoice.identity,async()=>{window.fixtureVerifying=true;await new Promise(resolve=>window.fixtureReleaseRecovery=resolve);}).then(()=>null,e=>({message:e.message,code:e.code}));},recovered);await page.waitForFunction(()=>window.fixtureVerifying);
    await peer.evaluate(({edited,identity})=>SalehChatStorage.recover(edited,identity,async(next,old)=>{JSON.parse(next);JSON.parse(old);}),{edited,identity:peerChoice.identity});const winner=await head(page);await page.evaluate(()=>fixtureReleaseRecovery());assert.equal((await page.evaluate(()=>fixtureRecovery)).code,'conflict');assert.deepEqual(await head(page),winner);assert.equal(winner.payload,edited);
    await context.close();passed.push('pending recovery CAS rejects a competing recovered destination during async validation');
  }
  for(const malformed of [false,true]){
    const {context,page}=await pendingFixture(),pending=await head(page);
    if(malformed)await page.evaluate(value=>fixtureRecord('head',{...value,hash:'0'.repeat(64)},true),pending);else await page.evaluate(()=>localStorage.setItem('qwen-local-chats-v1','CHANGED_LEGACY'));
    const refused=await error(page,'SalehChatStorage.recoveryBase()');assert(malformed?/invalid|hash/i.test(refused?.message??''):refused?.code==='conflict');assert.equal((await head(page)).state,'pending');assert.equal(await page.evaluate(()=>SalehChatStorage.identity),null);
    await context.close();passed.push('explicit pending recovery refuses '+(malformed?'malformed head':'changed legacy source'));
  }
  {
    const {context,page}=await fixture(history);await load(page);const before=await head(page);const refused=await page.evaluate(async()=>{try{await SalehChatStorage.commit('€'.repeat(Math.floor(256*1024*1024/3)+1));return '';}catch(e){return e.message;}});assert.match(refused,/256|limit|large/i);assert.deepEqual(await head(page),before);
    await context.close();passed.push('256 MiB ceiling uses encoded bytes and preserves prior committed payload');
  }
  assert.deepEqual(external,[]);
  console.log(JSON.stringify({passed:true,checks:passed,externalRequests:external.length,originalStoresTouched:false,appOrModelRequests:0}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
