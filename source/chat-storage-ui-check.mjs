// Actual Chat/Coding pages and local HTTP run routes; synthetic upstream only.
// Native permission sheets and computer execution remain separate installed gates.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const capacityOnly=process.argv.includes('--capacity-only');
const source=resolve(process.argv[2]||new URL('.',import.meta.url).pathname),agentOnly=process.argv.includes('--agent-continuity-only'),deepUnicodeOnly=process.argv.includes('--deep-unicode-only'),deepLimitOnly=process.argv.includes('--deep-limit-only'),inventoryOnly=process.argv.includes('--parallel-inventory-only'),admissionOnly=process.argv.includes('--parallel-admission-only'),sidebarOnly=process.argv.includes('--sidebar-focus-only'),parallelOnly=process.argv.includes('--parallel-only')||inventoryOnly||admissionOnly||sidebarOnly;
const require=createRequire(pathToFileURL(join(source,'chat-runs-ui-check.mjs'))),{chromium}=require('playwright');
const {createServer}=await import(pathToFileURL(join(source,'server.mjs'))),{nativeSignature}=await import(pathToFileURL(join(source,'agent.mjs')));
const root=await realpath(await mkdtemp(join(tmpdir(),'saleh-chat-runs-ui-'))),dataDir=join(root,'Coding');await mkdir(dataDir,{mode:0o700});
const model='fixture',streams=[],signals=[],requests=[],errors=[],gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const localModels={upstream:'http://127.0.0.1:1234',async catalog(){return {online:true,models:[{id:model,label:'Synthetic model',available:true,loaded:true,contextLength:65536,capabilities:{chat:true,agent:true,coding:true,standard:true,deep:true,vision:parallelOnly}}]};},async resolve(id){return {id,contextLength:65536,generation:{max_tokens:2048}};}};
let heldIntent=null,intentSeen=null;
const token=randomUUID(),nativeAttempts=[],nativeAttemptPaths=[],providerCalls=[],deniedCodingCalls=[],unexpectedNativeCalls=[];let agentAuthority=false,departures=0,stopControls=0,controlsPending=0,heldAgentReview=null;
const agentArgs={server:'continuity_fixture',name:'echo',arguments:{value:'ONE_REVIEWED_RESULT'}};
const agentHub={async prepareCall(value){assert.deepEqual(value,agentArgs);return structuredClone(value);},async call(value,{prepared,signal}={}){assert(agentAuthority&&!signal?.aborted,'Synthetic provider must never run after native authority revocation');assert.deepEqual(value,agentArgs);assert.deepEqual(prepared,agentArgs);providerCalls.push(structuredClone(value));return {content:[{type:'text',text:'ONE_REVIEWED_RESULT'}],isError:false};}};
const inert={async stop(){return {stopped:true};},async close(){return {stopped:true};}};
const server=createServer({instanceToken:token,model,localModels,chatRunOptions:{fault:async(stage,row)=>{if(stage==='before-commit'&&row.status==='intent'&&heldIntent){intentSeen.resolve();await heldIntent.promise;}}},coding:{...inert,dataDir},hub:{...inert,...(agentOnly?agentHub:{})},worktrees:{...inert},gitWorkflow:{...inert},fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));signals.push(options.signal);return new Response(new ReadableStream({start(c){streams.push(c);options.signal.addEventListener('abort',()=>c.error(options.signal.reason),{once:true});}}),{headers:{'content-type':'text/event-stream'}});}});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true}),context=await browser.newContext({viewport:{width:1360,height:900}}),page=await context.newPage();
await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
page.on('pageerror',error=>errors.push(error.message));

const draft='QUOTA169_'+ 'x'.repeat(18000),chat={id:'quota-chat',title:'Retained quota fixture',updated:1,draft:'',project:'',notes:'',model,thinking:'standard',mode:'chat',file:null,ownerExtension:{kept:true},messages:[{id:'legacy-message',role:'assistant',content:'Legacy retained',state:'complete',reasoning:'r'.repeat(70000),reasoningTruncated:false,reasoningOpen:true,ownerExtension:{kept:'message'},receipts:Array.from({length:60},(_,i)=>({tool:'fixture'+i,status:'returned',message:'kept'+i,output:'v'.repeat(i===59?33000:20)}))}]};
try {
 await page.addInitScript(({chat,model})=>{
  localStorage.setItem('saleh-local-model-default-v1',model);
  localStorage.setItem('qwen-local-chats-v1',JSON.stringify({chats:[chat],selectedId:chat.id}));
  let lo=0,hi=8*1024*1024;
  while(lo<hi){const n=Math.ceil((lo+hi)/2);try{localStorage.setItem('fixture-quota-filler','x'.repeat(n));lo=n;}catch(e){if(e.name!=='QuotaExceededError')throw e;hi=n-1;}}
  localStorage.setItem('fixture-quota-filler','x'.repeat(Math.max(0,lo-8192)));
  window.quotaFailures=[];const original=Storage.prototype.setItem;
  Storage.prototype.setItem=function(key,value){try{return original.call(this,key,value);}catch(e){window.quotaFailures.push({key,name:e.name});throw e;}};
 },{chat,model});
 await page.goto(origin);await page.waitForFunction(()=>document.getElementById('connection').className==='online');
 const baseline=await page.evaluate(()=>localStorage.getItem('qwen-local-chats-v1'));
 await page.locator('#prompt').fill(draft);await page.locator('#send').click();
 for(let i=0;i<500&&!requests.length;i++)await delay(20);
 const visibleNotice=await page.evaluate(()=>JSON.stringify({notice:document.getElementById('notice').textContent,storage:document.getElementById('storage-notice').textContent,activity:document.getElementById('activity').textContent,inert:document.body.inert}));
 assert.equal(requests.length,1,'Quota-sized history must commit before one explicit inference: '+visibleNotice);
 const readSnapshot=()=>page.evaluate(async()=>{const db=await new Promise((yes,no)=>{const r=indexedDB.open('saleh-chat-snapshots-v1',1);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});return new Promise((yes,no)=>{const tx=db.transaction('snapshots');const r=tx.objectStore('snapshots').get('head');let row;r.onsuccess=()=>row=r.result;tx.oncomplete=()=>{db.close();yes(JSON.parse(row.payload));};tx.onabort=()=>no(tx.error);});});
 assert.equal(await page.evaluate(()=>localStorage.getItem('qwen-local-chats-v1'))===baseline,true,'Legacy source bytes remain exact');
 let committed=await readSnapshot();let retained=committed.chats.find(c=>c.id===chat.id);
 assert.deepEqual(retained.messages[0],chat.messages[0],'No reasoning, later receipt, or unknown field is lost');assert.deepEqual(retained.ownerExtension,chat.ownerExtension);
 streams[0].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'STORAGE169_OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'));streams[0].close();
 await page.waitForFunction(()=>document.querySelector('.assistant:last-child .markdown')?.textContent.includes('STORAGE169_OK')||document.getElementById('messages').textContent.includes('STORAGE169_OK'));
 await page.locator('#prompt').fill('DRAFT169_SAFE');assert.equal(await page.evaluate(()=>window.salehSaveBeforeLeave()),true);
 committed=await readSnapshot();retained=committed.chats.find(c=>c.id===chat.id);assert.equal(retained.draft,'DRAFT169_SAFE');assert.equal(retained.messages.at(-1).content,'STORAGE169_OK');assert.deepEqual(retained.messages[0],chat.messages[0]);
 await page.reload();await page.waitForFunction(()=>document.getElementById('connection').className==='online');assert.equal(await page.locator('#prompt').inputValue(),'DRAFT169_SAFE');assert.equal(requests.length,1,'Reload never resends');
 assert.deepEqual((await readSnapshot()).chats.find(c=>c.id===chat.id).messages[0],chat.messages[0]);assert.deepEqual(errors,[]);
 await page.waitForFunction(async()=>await window.salehSaveBeforeLeave(),null,{timeout:10000});
 const base=await readSnapshot(),newChat={...chat,id:'recovered169',title:'Recovered fixture',messages:[],draft:'RECOVERED169_DRAFT'},recovery={exportedAt:new Date().toISOString(),chats:[...base.chats,newChat]};
 await page.locator('#workspace-settings-open').click();await page.locator('#recovery-selected-id').fill(newChat.id);await page.locator('#recovery-file').setInputFiles({name:'recovery169.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(recovery))});
 await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Exact recovery saved')).catch(async error=>{console.log(JSON.stringify(await page.evaluate(()=>({notice:document.getElementById('notice').textContent,storage:document.getElementById('storage-notice').textContent}))));throw error;});
 const recovered=await readSnapshot();assert.deepEqual(recovered.chats.slice(0,base.chats.length),base.chats);assert.equal(recovered.selectedId,newChat.id);assert.equal(await page.locator('#prompt').inputValue(),newChat.draft);assert.equal(requests.length,1,'Explicit recovery does not send inference');
 const invalid=structuredClone(recovery);invalid.chats[0].messages[0].content='ALTERED_OLD_CONTENT';await page.locator('#recovery-file').setInputFiles({name:'bad-recovery169.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(invalid))});await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Exact recovery not applied'));assert.deepEqual(await readSnapshot(),recovered,'Altered history recovery must leave authority intact');
 if(await page.locator('#workspace-settings-close').isVisible())await page.locator('#workspace-settings-close').click();
 for(const heldCall of [1,2]){
  const beforeRequests=requests.length,draft='STOP_DURING_SAVE_'+heldCall;
  await page.waitForFunction(async()=>await window.salehSaveBeforeLeave(),null,{timeout:10000});await page.evaluate(heldCall=>{const originals={commit:SalehChatStorage.commit,check:SalehChatStorage.check};let calls=0;window.fixtureSaveWaiting=false;for(const key of ['commit','check'])SalehChatStorage[key]=async(...args)=>{if(++calls===heldCall){window.fixtureSaveWaiting=true;await new Promise(resolve=>window.releaseFixtureSave=resolve);}return originals[key](...args);};window.restoreFixtureSave=()=>Object.assign(SalehChatStorage,originals);},heldCall);
  await page.locator('#prompt').fill(draft);await page.locator('#send').click();await page.waitForFunction(()=>window.fixtureSaveWaiting);
  assert.equal(requests.length,beforeRequests,'No inference while admission save is held');await page.locator('#stop').click();await page.evaluate(()=>releaseFixtureSave());
  await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Stopped before text admission'));
  assert.equal(requests.length,beforeRequests,'Stop during either commit prevents inference');assert.equal(await page.locator('#prompt').inputValue(),draft);await page.evaluate(()=>restoreFixtureSave());
 }
 console.log(JSON.stringify({passed:true,quotaHistorySaved:true,legacyUnchanged:true,fullFieldsAnd60ReceiptsRetained:true,draftReload:true,noReplay:true,stopDuringBothSaveGates:true,explicitRecoveryAndRefusal:true,realModels:0,originalStoresTouched:false,fixtureRoot:root}));
} finally {await browser.close();await server.shutdownTools();server.close();}
