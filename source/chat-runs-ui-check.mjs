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
const old={id:'old-chat',title:'Retained ordinary chat',draft:'OLD_DRAFT',updated:1,project:'',notes:'',model,thinking:'standard',mode:'chat',file:null,messages:[{id:'old-user',role:'user',content:'OLD_USER',state:'complete'},{id:'old-answer',role:'assistant',content:'OLD_ANSWER',state:'complete'}]};
const chat={...old,id:'text-chat',title:agentOnly?'Synthetic Agent run':'Synthetic text run',mode:agentOnly?'agent':'chat',draft:'',messages:[]};
const capacityChats=[],capacityReceipts=new Map(),capacityReads=[];
page.on('request',request=>{if(new URL(request.url()).pathname==='/api/chat/runs'&&request.method()==='POST'){const input=request.postDataJSON();if(input.action==='read')capacityReads.push(input.runId);}});
if(capacityOnly){
 await mkdir(join(root,'chat-runs'),{mode:0o700});
 for(let i=0;i<260;i++){
  const runId=randomUUID(),id='capacity-history',userId='capacity-user-'+i,answerId='capacity-answer-'+i,inputDigest='a'.repeat(64),userMessage='OLD_REQUEST_'+i,content='OLD_CAPACITY_'+i;
  const row={version:1,runId,chatId:id,userMessageId:userId,assistantMessageId:answerId,inputDigest,userMessage,requestedModel:model,resolvedModel:model,thinking:'standard',createdAt:1,updatedAt:i+1,endedAt:i+1,revision:1,status:'complete',content,reasoning:'',finishReason:'stop',stopRequested:false,error:null};
  const bytes=Buffer.from(JSON.stringify(row));capacityReceipts.set(runId,bytes);await writeFile(join(root,'chat-runs',runId+'.json'),bytes,{mode:0o600,flag:'wx'});
  capacityChats.push({...old,id,title:'Capacity history '+i,draft:'CAPACITY_DRAFT_'+i,updated:i+1,messages:[{id:userId,role:'user',content:userMessage,state:'complete'},{id:answerId,role:'assistant',content,state:'complete',note:'',reasoning:'',reasoningTruncated:false,textRun:{runId,userMessageId:userId,inputDigest,revision:1,admitted:true,draftCleared:true,submittedDraft:userMessage,imported:false}}]});
 }
 if(capacityOnly)capacityChats.splice(0,capacityChats.length,{...capacityChats[0],title:'Long capacity history',messages:capacityChats.flatMap(chat=>chat.messages)});
}
const maps={drafts:{retained:'CODING_DRAFT'},terminalDrafts:{retained:{command:'COMMAND_DRAFT',input:'STDIN_DRAFT'}},scheduleDrafts:{retained:{name:'SCHEDULE_DRAFT'}},gitDrafts:{retained:'GIT_DRAFT'},worktreeGitDrafts:{}};
await context.addInitScript(({old,chat,maps,parallelOnly,capacityChats})=>{if(localStorage.getItem('fixture-seeded'))return;localStorage.setItem('fixture-seeded','1');localStorage.setItem('saleh-local-model-default-v1','fixture');localStorage.setItem('qwen-local-chats-v1',JSON.stringify({chats:[chat,...(parallelOnly?[{...chat,id:'parallel-chat',title:'Parallel B'}]:[]),old,...capacityChats],selectedId:chat.id}));localStorage.setItem('qwen-coding-ui-v1',JSON.stringify({selectedId:'',...maps}));},{old,chat,maps,parallelOnly,capacityChats});
async function fixtureSnapshot(value) {
 const payload=value===undefined?undefined:JSON.stringify(value),hash=payload===undefined?null:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const db=await new Promise((yes,no)=>{const r=indexedDB.open('saleh-chat-snapshots-v1',1);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});
 return new Promise((yes,no)=>{const tx=db.transaction('snapshots',payload===undefined?'readonly':'readwrite'),store=tx.objectStore('snapshots'),r=store.get('head');let result;r.onsuccess=()=>{if(payload===undefined)result=JSON.parse(r.result.payload);else{result=value;store.put({...r.result,payload,hash,revision:r.result.revision+1,commitId:crypto.randomUUID()},'head');}};tx.oncomplete=()=>{db.close();yes(result);};tx.onabort=()=>{db.close();no(tx.error);};});
}
const snapshot=()=>page.evaluate(fixtureSnapshot);
const wait=async(fn,label)=>{const until=Date.now()+6000;while(!await fn()){if(Date.now()>until)throw Error('Timeout: '+label+' '+JSON.stringify({errors,ui:await page.locator('body').innerText(),saved:await snapshot()}));await delay(15);}};
async function bounded(promise,label,ms=6000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timeout: '+label)),ms);})]);}finally{clearTimeout(timer);}}
const chunk=(index,content,finish=null)=>streams[index].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:finish}]})+'\n\n'));
const saved=async()=>((await snapshot()).chats.find(c=>c.id==='text-chat'));
async function checkPanelLayout(label,reviewVisible=false){
 for(const width of [390,760]){
  await page.setViewportSize({width,height:900});
  const layout=await page.evaluate(()=>{const panel=document.getElementById('chat-background'),status=document.getElementById('chat-background-status'),original=status.textContent;status.textContent+=' · '+('LONG_SAVED_STATUS_'.repeat(16));const box=panel.getBoundingClientRect(),style=getComputedStyle(panel),children=[...panel.children].filter(node=>!node.hidden).map(node=>{const b=node.getBoundingClientRect();return {left:b.left,right:b.right};});const value={visible:!panel.hidden,display:style.display,neutral:style.color===getComputedStyle(document.body).color,left:box.left,right:box.right,width:innerWidth,scroll:panel.scrollWidth,client:panel.clientWidth,children};panel.hidden=true;value.hiddenDisplay=getComputedStyle(panel).display;panel.hidden=false;status.textContent=original;return value;});
  assert.equal(layout.visible,true,label+' panel visible');assert.equal(layout.display,'flex');assert.equal(layout.neutral,true,label+' neutral workspace text');assert.equal(layout.hiddenDisplay,'none');assert(layout.left>=-1&&layout.right<=width+1,label+' '+width+' panel bounds');assert(layout.scroll<=layout.client+1,label+' '+width+' panel overflow');for(const child of layout.children)assert(child.left>=layout.left-1&&child.right<=layout.right+1,label+' '+width+' control wraps inside panel');
  await page.locator('#chat-background-open').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>{const active=document.activeElement,style=getComputedStyle(active);return !!active.closest('#chat-background')&&active.matches(':focus-visible')&&style.outlineStyle!=='none'&&parseFloat(style.outlineWidth)>0;}),true,label+' keyboard focus remains visible');
  if(reviewVisible)assert.equal(await page.evaluate(()=>document.activeElement.id),'chat-background-review',label+' continuation button receives keyboard focus');
 }
 await page.setViewportSize({width:1360,height:900});
}

// Source-level native bridge seam only. Real NativeToolsController epoch/sheet
// revocation still needs its separate native fixture/installed gate. No shell,
// computer, real provider or real native bridge is available here.
async function signedControl(operation,input={}){
 const route='/api/tools/'+operation,body=JSON.stringify(input),nonce=randomUUID(),time=String(Date.now());
 controlsPending++;try{
  const response=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json','X-Qwen-Nonce':nonce,'X-Qwen-Time':time,'X-Qwen-Permit':nativeSignature(token,route,nonce,time,body)},body});
  const result=await response.json();assert.equal(response.status,200,result.error);return result;
 }finally{controlsPending--;}
}
async function departAgentPage(){
 agentAuthority=false;departures++;
 const result=await signedControl('depart');assert.equal(result.stopped,true,'Native departure must settle its requested scope');return result;
}
async function agentBridge(body,pathname){
 if(body?.op==='departPage'){assert.deepEqual(body,{op:'departPage'});return departAgentPage();}
 if(body?.op==='cancelTools'){
  assert.deepEqual(body,{op:'cancelTools'});agentAuthority=false;stopControls++;
  const result=await signedControl('stop',{coding:false});assert.equal(result.stopped,true,'Explicit Stop must drain Agent inference');return result;
 }
 nativeAttempts.push(structuredClone(body));nativeAttemptPaths.push(pathname);
 assert(agentAuthority,'No native action authority survives page departure or Stop');
 assert.deepEqual(Object.keys(body).sort(),['op','runId','stepId']);assert.equal(body.op,'agentStep');
 assert(nativeAttempts.length<=2,'Only the two explicitly reviewed synthetic steps may execute');
 const selector={runId:body.runId,stepId:body.stepId},pending=await signedControl('agentStep',{action:'inspect',...selector});
 assert.equal(pending.name,'execute_tool');assert.deepEqual(pending.arguments,agentArgs);assert.equal(pending.state,'pending');
 const reviewHold=heldAgentReview;
 if(reviewHold){reviewHold.entered.resolve();await bounded(reviewHold.beforeClaim.promise,'release native inspection',12000);}
 const claimId=randomUUID();await signedControl('agentStep',{action:'claim',...selector,stepDigest:pending.stepDigest,generation:pending.generation,claimId});
 if(reviewHold){reviewHold.claimed.resolve();await bounded(reviewHold.afterClaim.promise,'release claimed native action',12000);}
 assert(agentAuthority,'Review authority must still hold immediately before dispatch');
 const result=await signedControl('call',{...pending.arguments,agentClaim:{...selector,claimId}});
 return signedControl('agentStep',{action:'complete',...selector,claimId,outcome:{kind:'returned',result}});
}
async function checkAgentContinuity(){
 await context.exposeBinding('__continuityNative',async({frame},body)=>{
  const url=new URL(frame.url());assert.equal(frame,page.mainFrame());assert.equal(url.origin,origin);assert(['/','/coding'].includes(url.pathname));
  if(['departPage','cancelTools','agentStep'].includes(body?.op))return agentBridge(body,url.pathname);
  // Exposing the shared bridge also starts Coding's unrelated inventory reads.
  // Refuse only these exact read/clear envelopes; never route them to native/API work.
  const keys=Object.keys(body||{}).sort().join(),input=body?.input,inputKeys=Object.keys(input||{}).sort().join();
  const denied=url.pathname==='/coding'&&keys==='input,op'&&(
   body.op==='coding'&&(inputKeys==='action'&&input.action==='status'||inputKeys==='action,after'&&input.action==='events'&&input.after===0)
   ||['codingFilePreview','codingSkills'].includes(body.op)&&inputKeys==='action'&&input.action==='clear');
  (denied?deniedCodingCalls:unexpectedNativeCalls).push(structuredClone(body));
  throw Error(denied?'Coding reads are unavailable in this Agent-only fixture.':'Unexpected native request in Agent continuity fixture.');
 });
 await context.addInitScript(()=>{
  if(['/','/coding'].includes(location.pathname))window.webkit={messageHandlers:{tools:{postMessage:body=>window.__continuityNative(body)}}};
 });
 // The native app also revokes on main-frame navigation, independently of the
 // old document's pagehide callback. Exercise the real signed departure route.
 await page.route(url=>url.origin===origin&&['/','/coding'].includes(url.pathname),async route=>{
  if(route.request().isNavigationRequest()&&route.request().frame()===page.mainFrame()){
   agentAuthority=false;
   await departAgentPage();
  }
  await route.continue();
 });
 await page.goto(origin);await page.waitForFunction(()=>window.qwenAgent?.available===true);
 await page.locator('#prompt').fill('STOP_CONTROL_NO_TOOL');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();
 await wait(()=>streams.length===1,'Agent Stop control reached synthetic model');
 const stopIds=(await saved()).messages.map(m=>m.id);
 await page.locator('#prompt').fill('DRAFT_AFTER_STOP');await page.locator('#stop').click();
 await wait(async()=>signals[0].aborted&&(await saved()).messages.at(-1).state==='stopped'&&stopControls>0&&controlsPending===0,'Agent Stop settled');
 assert.deepEqual((await saved()).messages.map(m=>m.id),stopIds);assert.equal((await saved()).draft,'DRAFT_AFTER_STOP');assert.equal(providerCalls.length,0);assert.equal(requests.length,1);
 assert.equal(await page.locator('#chat-background-review').isHidden(),true);assert.doesNotMatch(await page.locator('#chat-background-status').innerText(),/Paused — continue tool actions/);
 const stoppedHistory=structuredClone((await saved()).messages);
 console.log('PASS ordinary Agent explicit Stop drains inference, retains draft/history and performs no tool');
 agentAuthority=true;await page.locator('#prompt').fill('Call continuity_fixture echo once with ONE_REVIEWED_RESULT, then summarize that result.');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();
 await wait(()=>streams.length===2,'Agent first step reached synthetic model');
 streams[1].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'continuity_call_1',type:'function',function:{name:'execute_tool',arguments:JSON.stringify(agentArgs)}}]},finish_reason:'tool_calls'}]})+'\n\n'));streams[1].close();
 await wait(()=>streams.length===3&&providerCalls.length===1,'One tool returned; post-tool answer held');
 await wait(async()=>(await saved()).messages.at(-1).receipts?.[0]?.status==='returned','Returned receipt persisted before departure');
 const before=await saved(),ids=before.messages.map(m=>m.id),receipt=structuredClone(before.messages.at(-1).receipts[0]);
 assert.deepEqual(before.messages.slice(0,2),stoppedHistory);assert.equal(before.messages.length,4);assert.equal(new Set(ids).size,4);assert.equal(before.messages.at(-1).agent,true);
 assert.equal(requests.length,3);assert.equal(requests[2].messages.filter(m=>m.role==='tool').length,1);assert.match(requests[2].messages.find(m=>m.role==='tool').content,/ONE_REVIEWED_RESULT/);
 assert.equal(signals[2].aborted,false);assert.equal(before.messages.at(-1).state,'streaming');
 await page.locator('#prompt').fill('UNSENT_AGENT_CONTINUITY_DRAFT');await page.locator('#workspace-rail').getByRole('button',{name:'Tasks',exact:true}).click();
 const navigated=await page.waitForURL('**/coding',{timeout:2500}).then(()=>true,()=>false);
 assert.equal(navigated,true,'Accepted ordinary Agent work must allow Tasks navigation while its post-tool answer remains owned');
 assert(departures>0);assert.equal(agentAuthority,false);assert.equal(signals[2].aborted,false,'Departure must detach the accepted run, not cancel its answer');assert.equal(nativeAttempts.length,1);assert.equal(providerCalls.length,1);
 assert.equal((await saved()).draft,'UNSENT_AGENT_CONTINUITY_DRAFT');assert.deepEqual((await saved()).messages.map(m=>m.id),ids);
 chunk(2,'GENUINE_SYNTHETIC_AGENT_FINAL','stop');streams[2].close();
 await page.locator('#workspace-rail').getByRole('button',{name:'Chat',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');
 await wait(async()=>(await saved()).messages.at(-1).state==='complete','Same Agent reply reattached and saved');
 const completed=await saved();assert.deepEqual(completed.messages.map(m=>m.id),ids);assert.equal(completed.messages.at(-1).content,'GENUINE_SYNTHETIC_AGENT_FINAL');assert.deepEqual(completed.messages.at(-1).receipts,[receipt]);assert.equal(completed.draft,'UNSENT_AGENT_CONTINUITY_DRAFT');assert.equal(await page.locator('#prompt').inputValue(),completed.draft);
 await page.locator('#chat-background-receipt').click();await page.waitForFunction(()=>document.querySelector('#chat-run-receipt-dialog h2')?.textContent==='Saved Agent result');const agentSaved=completed.messages.at(-1),agentText=await page.locator('#chat-run-receipt-dialog pre').textContent();assert(agentText.includes(agentSaved.content));assert(agentText.includes('Action receipts:\n'+JSON.stringify(agentSaved.receipts,null,2)));if(agentSaved.reasoning)assert(agentText.includes('Model reasoning · model output:\n'+agentSaved.reasoning));await page.locator('#chat-run-receipt-dialog').getByRole('button',{name:'Close',exact:true}).click();
 await page.reload();await page.waitForFunction(()=>window.qwenAgent?.available===true);await wait(async()=>(await saved()).messages.at(-1).state==='complete','Cold Agent completion retained');
 assert.deepEqual((await saved()).messages,completed.messages);assert.equal((await saved()).draft,completed.draft);assert.equal(requests.length,3,'Two continuity model steps plus Stop control only');assert.equal(nativeAttempts.length,1,'No new native action attempted after departure');assert.equal(providerCalls.length,1,'No tool replay on reattach or reload');
 assert.equal(await page.locator('#chat-background-review').isHidden(),true);assert.doesNotMatch(await page.locator('#chat-background-status').innerText(),/Paused — continue tool actions/);
 assert.deepEqual((await snapshot()).chats.find(c=>c.id==='old-chat'),old);const currentMaps=await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')));for(const [key,value] of Object.entries(maps))assert.deepEqual(currentMaps[key],value,key+' preserved');assert.deepEqual(errors,[]);
 // A tool proposed after departure waits for a fresh explicit review, including after reload.
 await page.locator('#prompt').fill('SECOND_RUN_REQUIRES_FRESH_REVIEW');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await wait(()=>streams.length===4,'fresh review run reached model');
 await page.locator('#prompt').fill('PENDING_REVIEW_UNSENT_DRAFT');await page.locator('#workspace-rail').getByRole('button',{name:'Tasks',exact:true}).click();await page.waitForURL('**/coding');
 streams[3].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'continuity_call_2',type:'function',function:{name:'execute_tool',arguments:JSON.stringify(agentArgs)}}]},finish_reason:'tool_calls'}]})+'\n\n'));streams[3].close();
 await page.waitForFunction(()=>!document.getElementById('chat-background-review').hidden);assert.equal(nativeAttempts.length,1);assert.equal(providerCalls.length,1);
 assert.match(await page.locator('#chat-background-status').innerText(),/Paused — continue tool actions/);assert.equal(await page.locator('#chat-background-review').innerText(),'Continue tool actions');
 await page.locator('#workspace-rail').getByRole('button',{name:'Chat',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');await page.waitForFunction(()=>!document.getElementById('chat-background-review').hidden);await page.reload();await page.waitForFunction(()=>!document.getElementById('chat-background-review').hidden&&!document.getElementById('chat-background-review').disabled);
 assert.equal(nativeAttempts.length,1);assert.equal(providerCalls.length,1);assert.equal((await saved()).draft,'PENDING_REVIEW_UNSENT_DRAFT');assert.equal(requests.length,4);
 assert.match(await page.locator('#chat-background-status').innerText(),/Paused — continue tool actions/);assert.equal(await page.locator('#chat-background-review').innerText(),'Continue tool actions');
 // Stop notifications revoke document grants immediately; presentation must not await polling.
 const clearedStates=await page.evaluate(async run=>{const value=await window.SalehChatRuns.inspect(run),states=[];for(const event of ['agent-stopped','tools-stopped']){window.SalehChatRuns.allowAgentReview(run);window.SalehChatRuns.receive(value,false);const before=document.getElementById('chat-background-status').textContent;window.dispatchEvent(new Event(event));states.push([before,document.getElementById('chat-background-status').textContent]);}return states;},(await saved()).messages.at(-1).textRun.runId);
 for(const [before,after] of clearedStates){assert.match(before,/Preparing tool action…/);assert.match(after,/Paused — continue tool actions/);}
 assert.equal(nativeAttempts.length,1);assert.equal(providerCalls.length,1);
 const resumed=await saved(),resumedIds=resumed.messages.map(m=>m.id),resumedRun=resumed.messages.at(-1).textRun.runId;
 await page.locator('#workspace-rail').getByRole('button',{name:'Tasks',exact:true}).click();await page.waitForURL('**/coding');await page.waitForFunction(()=>!document.getElementById('chat-background-review').hidden&&!document.getElementById('chat-background-review').disabled);
 assert.match(await page.locator('#chat-background-status').innerText(),/Paused — continue tool actions/);assert.equal(await page.locator('#chat-background-review').innerText(),'Continue tool actions');
 await checkPanelLayout('Paused Agent in Tasks',true);await wait(()=>controlsPending===0,'departure controls settled before explicit continuation');
 assert.equal(agentAuthority,false);assert.equal(nativeAttempts.length,1);assert.equal(providerCalls.length,1);assert.equal(requests.length,4);assert.deepEqual(unexpectedNativeCalls,[]);
 heldAgentReview={entered:gate(),beforeClaim:gate(),claimed:gate(),afterClaim:gate()};agentAuthority=true;
 await page.getByRole('button',{name:'Continue tool actions',exact:true}).click();await bounded(heldAgentReview.entered.promise,'Tasks continuation reached native inspection');
 await page.waitForFunction(()=>document.getElementById('chat-background-status').textContent.includes('Preparing tool action…'));
 assert.equal(await page.locator('#chat-background-review').isDisabled(),true);assert.doesNotMatch(await page.locator('#chat-background-status').innerText(),/Paused — continue tool actions/);assert.equal(providerCalls.length,1);
 heldAgentReview.beforeClaim.resolve();await bounded(heldAgentReview.claimed.promise,'Tasks continuation claim saved');
 await page.waitForFunction(()=>document.getElementById('chat-background-status').textContent.includes('Waiting for the action result…'));
 assert.equal(await page.locator('#chat-background-review').isHidden(),true);assert.doesNotMatch(await page.locator('#chat-background-status').innerText(),/Paused — continue tool actions/);assert.equal(providerCalls.length,1);
 heldAgentReview.afterClaim.resolve();await wait(()=>streams.length===5&&providerCalls.length===2,'explicit Tasks continuation dispatches once');heldAgentReview=null;
 chunk(4,'FRESH_REVIEW_FINAL','stop');streams[4].close();await page.waitForFunction(()=>document.getElementById('chat-background-status').textContent.includes('Reply saved'));
 const tasksFinal=await page.evaluate(runId=>window.SalehChatRuns.inspect(runId),resumedRun);assert.equal(tasksFinal.live,false);assert.equal(tasksFinal.run.content,'FRESH_REVIEW_FINAL');assert.equal(tasksFinal.run.pendingStep,null);assert.equal(tasksFinal.run.receipts.length,1);assert.equal(tasksFinal.run.receipts[0].status,'returned');
 assert.equal(await page.locator('#chat-background-review').isHidden(),true);assert.deepEqual(nativeAttemptPaths,['/','/coding']);
 await page.locator('#workspace-rail').getByRole('button',{name:'Chat',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');await wait(async()=>(await saved()).messages.at(-1).state==='complete','same Tasks final projected into original Chat');
 assert.deepEqual((await saved()).messages.map(m=>m.id),resumedIds);assert.deepEqual((await saved()).messages.at(-1).receipts,tasksFinal.run.receipts);
 assert.equal(nativeAttempts.length,2);assert.equal(providerCalls.length,2);assert.equal((await saved()).draft,'PENDING_REVIEW_UNSENT_DRAFT');assert.deepEqual((await saved()).messages.slice(0,4),completed.messages);assert.deepEqual((await snapshot()).chats.find(c=>c.id==='old-chat'),old);assert.deepEqual(errors,[]);
 const finalMaps=await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')));for(const [key,value] of Object.entries(maps))assert.deepEqual(finalMaps[key],value,key+' preserved');assert(deniedCodingCalls.some(body=>body.op==='coding'&&body.input.action==='status'));assert.deepEqual(unexpectedNativeCalls,[]);
 console.log(JSON.stringify({passed:true,fixtureRoot:root,agentContinuity:true,pausedContinuationClear:true,explicitContinuationFromTasks:true,reviewingAndClaimedStates:true,upstreamRequests:requests.length,toolInvocations:providerCalls.length,nativeAttemptPaths,deniedCodingCalls,sameMessageIds:resumedIds,oldChatAndDraftsPreserved:true,nativePermissionControllerExercised:false,codingNativeExecutionExercised:false}));
}

async function checkAdmissionInventory(){
 await page.goto(origin);await page.locator('#prompt').fill('ADMISSION_INVENTORY');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.evaluate(()=>window.SalehChatRuns.refresh());await page.waitForFunction(async()=>await window.salehSaveBeforeLeave());
 const startSeen=gate(),sendStart=gate(),listSeen=gate(),sendList=gate(),sendReads=gate();let holdList=true,holdReads=false,startHeld=false,refreshing;
 const interleave=async route=>{
  const input=route.request().method()==='POST'?route.request().postDataJSON():null;
  if(input?.action==='start'){startHeld=true;startSeen.resolve();await sendStart.promise;await route.fallback();}
  else if(input?.action==='list'&&holdList&&startHeld){holdList=false;const response=await route.fetch();assert.equal((await response.json()).runs.length,0);listSeen.resolve();await sendList.promise;await route.fulfill({response});}
  else if(input?.action==='read'&&holdReads){const response=await route.fetch();await sendReads.promise;await route.fulfill({response});}
  else await route.fallback();
 };
 await page.route('**/api/chat/runs',interleave);
 try{
  await page.locator('#send').click();await bounded(startSeen.promise,'start held before backend registration');refreshing=page.evaluate(()=>window.SalehChatRuns.refresh());void refreshing.catch(()=>{});await bounded(listSeen.promise,'pre-admission empty inventory captured');sendStart.resolve();await wait(()=>streams.length===1,'new run inference');await wait(async()=>(await saved()).messages.at(-1)?.textRun?.admitted&&(await saved()).messages.at(-1).textRun.revision>=2,'running observation after empty inventory capture');await page.locator('#prompt').fill('ADMISSION_DRAFT_KEEP');await wait(async()=>(await saved()).draft==='ADMISSION_DRAFT_KEEP','admission draft persisted before late inventory');
  holdReads=true;sendList.resolve();await bounded(refreshing,'old inventory response delivered');assert.equal(await page.locator('#stop').isVisible(),true,'Old empty inventory must not erase a newly observed live run');assert.equal(await page.locator('#send').isHidden(),true);assert.equal(signals[0].aborted,false);assert.equal((await saved()).draft,'ADMISSION_DRAFT_KEEP');assert.equal(requests.length,1);
 }finally{sendStart.resolve();sendList.resolve();sendReads.resolve();await page.unroute('**/api/chat/runs',interleave);}
 await page.locator('#stop').click();await wait(async()=>(await saved()).messages.at(-1).state==='stopped','admission-race run stopped');assert.deepEqual((await snapshot()).chats.find(c=>c.id==='old-chat'),old);assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,staleEmptyInventoryRefused:true,upstreamCalls:requests.length,oldChatAndDraftsPreserved:true,fixtureRoot:root,installedAppTouched:false}));
}

async function checkSidebarFocus(){
 await page.goto(origin);await page.waitForFunction(()=>!!window.salehWorkspace);
 const before=await snapshot();const sidebarValue=structuredClone(before);const changedSidebar=await page.evaluate(value=>{value.chats.unshift(...Array.from({length:35},(_,i)=>({...value.chats[0],id:'deep-'+i,title:'Earlier '+i,project:'Project '+i,messages:[],updated:100+i})));value.chats.find(c=>c.id===value.selectedId).project='A very long project name '.repeat(12);return value;},sidebarValue);await page.evaluate(fixtureSnapshot,changedSidebar);await page.reload();await page.waitForFunction(()=>!!document.querySelector('#chats [aria-current="page"]'));
 assert(await page.locator('#chats [aria-current="page"]').evaluate(node=>{const b=node.getBoundingClientRect(),p=document.getElementById('chats').getBoundingClientRect();return b.top>=p.top-1&&b.bottom<=p.bottom+1;}),'Restored Chat selection is revealed below many groups');
 await page.evaluate(()=>{document.getElementById('chats').scrollTop=0;document.querySelector('#chats .project-heading').click();});assert.equal(await page.locator('#chats').evaluate(n=>n.scrollTop),0,'Unrelated rerender retains manual scroll');
 await page.locator('#chats [aria-current="page"]').evaluate(node=>{const heading=node.closest('.project-group').querySelector('[data-workspace-project]');if(heading.scrollWidth>heading.clientWidth+1)throw Error('Long project label overflows');window.salehWorkspace.toggleProject(heading.dataset.workspaceProject);});
 assert.equal(await page.locator('#chats [aria-current="page"]').count(),0,'Explicitly collapsed selected project stays collapsed');await page.evaluate(()=>window.dispatchEvent(new Event('workspace-preferences-change')));assert.equal(await page.locator('#chats [aria-current="page"]').count(),0);await page.evaluate(()=>{const heading=[...document.querySelectorAll('#chats [data-workspace-project]')].find(n=>n.dataset.workspaceProject.includes('A very long project name'));window.salehWorkspace.toggleProject(heading.dataset.workspaceProject);});
 await page.evaluate(fixtureSnapshot,before);await page.reload();
 await page.goto(origin);await page.waitForFunction(()=>!!window.SalehChatRuns&&!!window.salehWorkspace);await page.evaluate(()=>window.SalehChatRuns.refresh());
 await page.locator('#chats button').filter({hasText:'Parallel B'}).first().click();await page.locator('#search').fill('Synthetic text run');
 const button=page.locator('#chats button').filter({hasText:'Synthetic text run'}).first();await button.focus();const idle=await button.elementHandle();
 await page.evaluate(()=>window.SalehChatRuns.refresh());assert.equal(await idle.evaluate(node=>node.isConnected&&document.activeElement===node),true,'Unchanged inventory/readiness must retain the focused sidebar button');
 await page.evaluate(()=>window.dispatchEvent(new Event('workspace-preferences-change')));assert.equal(await idle.evaluate(node=>node.isConnected&&document.activeElement===node),true,'Unchanged preferences must retain sidebar focus');
 await page.keyboard.press('Enter');assert.equal((await snapshot()).selectedId,'text-chat','Enter must open the focused chat');
 await page.locator('#prompt').fill('FOCUS_STREAM_REQUEST');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await wait(()=>streams.length===1,'focus fixture upstream');await wait(async()=>(await saved()).messages.at(-1)?.textRun?.admitted,'focus fixture admission');
 await page.locator('#prompt').fill('FOCUS_UNSENT_DRAFT');await button.focus();const streaming=await button.elementHandle();chunk(0,'STREAM_PARTIAL');await wait(async()=>(await saved()).messages.at(-1)?.content==='STREAM_PARTIAL','focus fixture partial');
 assert.equal(await streaming.evaluate(node=>node.isConnected&&document.activeElement===node),true,'Streaming progress with unchanged visible rows must retain sidebar focus');
 await page.locator('#search').fill('NEW_SEARCH_MATCH');assert.equal(await button.count(),0);chunk(0,' NEW_SEARCH_MATCH');await wait(async()=>await button.count()===1,'streamed content must update search membership');
 chunk(0,' FINAL','stop');streams[0].close();await wait(async()=>(await saved()).messages.at(-1)?.state==='complete','focus fixture complete');await wait(async()=>!(await button.innerText()).startsWith('· '),'terminal state must remove active indicator');
 assert.equal((await saved()).draft,'FOCUS_UNSENT_DRAFT');assert.deepEqual((await snapshot()).chats.find(c=>c.id==='old-chat'),old);assert.equal(requests.length,1);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,sidebarFocus:true,idleRefreshRetainsNode:true,streamingRetainsNode:true,keyboardSelection:true,searchMembershipAndActiveStateUpdated:true,oldChatAndDraftsPreserved:true,fixtureRoot:root,installedAppTouched:false}));
}

async function checkParallelChats(){
 const both=async()=>(await snapshot()).chats.filter(c=>['text-chat','parallel-chat'].includes(c.id)),select=title=>page.locator('#chats button').filter({hasText:title}).first().click();
 await page.goto(origin);await page.locator('#prompt').fill('PARALLEL_A');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await wait(()=>streams.length===1,'parallel A upstream');await wait(async()=>(await saved()).messages.at(-1)?.textRun?.admitted,'A durable admission');
 await page.locator('#prompt').fill('UNSENT_DRAFT_A');await select('Parallel B');await page.locator('#prompt').fill('PARALLEL_B');
 await page.locator('#message-files').setInputFiles({name:'parallel-image.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64')});
 await page.getByRole('button',{name:'Remove parallel-image.png',exact:true}).waitFor();assert.equal(await page.locator('#send').isDisabled(),true);assert.match(await page.locator('#activity').innerText(),/image Chats/);await page.locator('#composer').evaluate(form=>form.requestSubmit());assert.equal(requests.length,1);assert.equal((await both()).find(c=>c.id==='parallel-chat').messages.length,0);assert.equal(await page.locator('#prompt').inputValue(),'PARALLEL_B');await page.getByRole('button',{name:'Remove parallel-image.png',exact:true}).click();
 await bounded(page.waitForFunction(()=>!document.getElementById('send').disabled&&!document.getElementById('send').hidden), 'second chat Send remains usable while A runs');await page.locator('#send').click();await wait(()=>streams.length===2,'parallel B upstream');await wait(async()=>(await both()).every(c=>c.messages.at(-1)?.textRun?.admitted),'both admissions saved');
 await page.locator('#prompt').fill('UNSENT_DRAFT_B');chunk(0,'A_PARTIAL');chunk(1,'B_PARTIAL');await wait(async()=>(await both()).every(c=>c.messages.at(-1)?.content.endsWith('PARTIAL')),'both partials projected');const ids=(await both()).map(c=>({id:c.id,messages:c.messages.map(m=>m.id)}));
 await select('Synthetic text run');assert.equal(await page.locator('#prompt').inputValue(),'UNSENT_DRAFT_A');assert.equal(await page.locator('#stop').isVisible(),true);assert.equal(signals[0].aborted,false);assert.equal(signals[1].aborted,false);
 if(inventoryOnly){
  await page.evaluate(()=>window.SalehChatRuns.refresh());await page.waitForFunction(async()=>await window.salehSaveBeforeLeave());let reads=0;
  const interleave=async route=>{
   if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='list'){
    const response=await route.fetch(),marker='_FOCUSED_TICK_'+(++reads);chunk(0,marker);await wait(async()=>(await saved()).messages.at(-1).content.includes(marker),'focused progress before inventory delivery');await route.fulfill({response});
   }else await route.fallback();
  };
  await page.route('**/api/chat/runs',interleave);chunk(1,'_FINAL','stop');streams[1].close();void page.evaluate(()=>window.SalehChatRuns.refresh()).catch(()=>{});
  await wait(async()=>(await both()).find(c=>c.id==='parallel-chat').messages.at(-1).state==='complete','background completion must survive focused progress on every inventory');assert(reads>0);assert.equal(signals[0].aborted,false);assert.equal(requests.length,2);assert.equal((await saved()).draft,'UNSENT_DRAFT_A');assert.equal((await both()).find(c=>c.id==='parallel-chat').draft,'UNSENT_DRAFT_B');
  await page.unroute('**/api/chat/runs',interleave);await page.locator('#stop').click();await wait(async()=>(await saved()).messages.at(-1).state==='stopped','focused run stopped after inventory check');assert.deepEqual((await snapshot()).chats.find(c=>c.id==='old-chat'),old);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,parallelInventory:true,interleavedInventories:reads,upstreamCalls:requests.length,oldChatAndDraftsPreserved:true,fixtureRoot:root,installedAppTouched:false}));return;
 }
 await page.locator('#workspace-rail').getByRole('button',{name:'Tasks',exact:true}).click();await page.waitForURL('**/coding');await page.waitForFunction(()=>document.getElementById('chat-background-status').textContent.includes('2 running'));assert(signals.every(s=>!s.aborted));
 await page.locator('#workspace-rail').getByRole('button',{name:'Chat',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');await page.reload();await wait(async()=>(await both()).every(c=>c.messages.at(-1)?.state==='streaming'),'both live reattached after reload');assert.equal(requests.length,2);
 await select('Synthetic text run');await page.waitForFunction(()=>!document.getElementById('stop').hidden);await page.locator('#stop').click();await wait(async()=>signals[0].aborted&&(await saved()).messages.at(-1)?.state==='stopped','selected A Stop');assert.equal(signals[1].aborted,false);assert.equal((await saved()).draft,'UNSENT_DRAFT_A');
 await select('Parallel B');assert.equal(await page.locator('#prompt').inputValue(),'UNSENT_DRAFT_B');await page.waitForFunction(()=>!document.getElementById('stop').hidden);chunk(1,'_FINAL','stop');streams[1].close();await wait(async()=>(await both()).find(c=>c.id==='parallel-chat').messages.at(-1)?.state==='complete','B finishes independently');
 await page.reload();await page.waitForFunction(()=>!!window.SalehChatRuns);await wait(async()=>(await both()).find(c=>c.id==='parallel-chat').messages.at(-1)?.content==='B_PARTIAL_FINAL','cold B final');
 const after=await both();assert.deepEqual(after.map(c=>({id:c.id,messages:c.messages.map(m=>m.id)})),ids);assert.equal(after.find(c=>c.id==='text-chat').draft,'UNSENT_DRAFT_A');assert.equal(after.find(c=>c.id==='text-chat').messages.at(-1).state,'stopped');assert.equal(after.find(c=>c.id==='parallel-chat').draft,'UNSENT_DRAFT_B');assert.equal(requests.length,2);assert.deepEqual((await snapshot()).chats.find(c=>c.id==='old-chat'),old);
 const currentMaps=await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')));for(const [key,value] of Object.entries(maps))assert.deepEqual(currentMaps[key],value);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,parallelChats:true,upstreamCalls:requests.length,selectedStopIsolated:true,oldChatAndDraftsPreserved:true,fixtureRoot:root,installedAppTouched:false}));
}

async function checkDeepLimit(){
 const reasoning='\n Still solving 🧪 <b>literal reasoning</b>\n',draft='B164_LIMIT_DRAFT_SAFE';
 await page.goto(origin);await page.locator('#prompt').fill('SYNTHETIC_DEEP_LIMIT');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#thinking').selectOption('deep');await page.locator('#send').click();
 await wait(()=>streams.length===1,'Deep limit upstream');await wait(async()=>!!(await saved()).messages.at(-1).textRun?.admitted,'Deep limit admission');
 const ids=(await saved()).messages.map(m=>m.id),runId=(await saved()).messages.at(-1).textRun.runId,file=join(root,'chat-runs',runId+'.json');
 await page.locator('#prompt').fill(draft);await page.waitForFunction(async()=>await window.salehSaveBeforeLeave()===true,null,{timeout:30000});
 streams[0].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:reasoning},finish_reason:null}]})+'\n\n'));chunk(0,null,'length');streams[0].close();
 await wait(async()=>(await saved()).messages.at(-1).state==='length','Deep reasoning-only length outcome');
 const bytes=await readFile(file),receipt=JSON.parse(bytes);assert.equal(receipt.status,'length');assert.equal(receipt.finishReason,'length');assert.equal(receipt.error,null);assert.equal(receipt.content,'');assert.equal(receipt.reasoning,reasoning);assert.equal(receipt.resolvedModel,model);
 async function projection(){
  const value=await saved(),reply=value.messages.at(-1);assert.equal(reply.state,'length');assert.equal(reply.content,'');assert.equal(reply.reasoning,reasoning);assert.equal(value.draft,draft);assert.deepEqual(value.messages.map(m=>m.id),ids);assert.equal(reply.textRun.runId,runId);
  await page.waitForFunction(()=>document.getElementById('chat-background-status').textContent.includes('Length limit reached'));
  assert.match(await page.locator('#chat-background-status').innerText(),/Length limit reached/);assert.match(await page.locator('.run-outcome').innerText(),/limit before producing an answer/);assert.match(await page.locator('.reasoning-note').innerText(),/Partial response/);assert.equal(await page.locator('.reasoning-text').textContent(),reasoning);assert.equal(await page.locator('#prompt').inputValue(),draft);assert.equal(await page.locator('.retry-reply').count(),1);assert.equal(await page.locator('#send').isEnabled(),true);
  await page.locator('#chat-background-receipt').click();const dialog=page.locator('#chat-run-receipt-dialog');await dialog.waitFor();await page.waitForFunction(()=>document.querySelector('#chat-run-receipt-dialog h2')?.textContent==='Saved Chat result');
  assert.equal(await dialog.locator('pre').textContent(),'SYNTHETIC_DEEP_LIMIT\n\n'+'\n\nModel reasoning · model output:\n'+reasoning,'Saved-result dialog must retain exact Deep reasoning when the answer is empty');assert.equal(await dialog.locator('pre b').count(),0,'Model markup stays literal text');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  assert.deepEqual((await snapshot()).chats.find(c=>c.id===old.id),old);assert.equal(requests.length,1,'Limit and reload must not trigger an automatic retry');assert.deepEqual(await readFile(file),bytes);
 }
 await projection();await page.reload();await page.locator('.reasoning-text').waitFor();await page.evaluate(()=>window.SalehChatRuns.refresh());await projection();
 const currentMaps=await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')));for(const [key,value] of Object.entries(maps))assert.deepEqual(currentMaps[key],value);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,deepLimit:true,reasoningRetained:true,answerNotClaimed:true,liveAndColdOutcomeExact:true,oldChatAndDraftsPreserved:true,upstreamCalls:requests.length,fixtureRoot:root,installedAppTouched:false}));
}

async function checkDeepUnicode(){
 const raw='x'.repeat(63999)+'🌊',prefix='x'.repeat(63999),answer='\n\nB163_DEEP_UNICODE_OK\n',draft='B163_UNICODE_DRAFT_SAFE';
 await page.goto(origin);await page.locator('#prompt').fill('SYNTHETIC_DEEP_UNICODE');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#thinking').selectOption('deep');await page.locator('#send').click();
 await wait(()=>streams.length===1,'Deep Unicode upstream');await wait(async()=>!!(await saved()).messages.at(-1).textRun?.admitted,'Deep Unicode admission');
 const ids=(await saved()).messages.map(message=>message.id),runId=(await saved()).messages.at(-1).textRun.runId,receiptPath=join(root,'chat-runs',runId+'.json');
 await page.locator('#prompt').fill(draft);await page.waitForFunction(async()=>await window.salehSaveBeforeLeave()===true,null,{timeout:30000});
 streams[0].enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{reasoning_content:raw},finish_reason:null}]})+'\n\n'));chunk(0,answer,'stop');streams[0].close();
 await wait(async()=>(await saved()).messages.at(-1).state==='complete','Deep Unicode final');
 const receiptBytes=await readFile(receiptPath),receipt=JSON.parse(receiptBytes);
 assert.equal(receipt.reasoning,raw,'The durable receipt keeps every provider reasoning byte');assert.equal(receipt.reasoning.isWellFormed(),true);assert.equal(receipt.content,answer);assert.equal(receipt.thinking,'deep');assert.equal(receipt.status,'complete');assert.equal(receipt.resolvedModel,model);assert.deepEqual([receipt.userMessageId,receipt.assistantMessageId],ids);
 async function projection(label){
  const current=await saved(),reply=current.messages.at(-1);
  assert.equal(reply.reasoning.isWellFormed(),true,label+': the saved thinking prefix must not split a surrogate pair');assert.equal(reply.reasoning,raw,label+': retain complete reasoning in authoritative history');assert.equal(reply.reasoningTruncated,true);assert.equal(reply.content,answer);assert.equal(reply.state,'complete');assert.equal(current.thinking,'deep');assert.equal(current.draft,draft);assert.deepEqual(current.messages.map(message=>message.id),ids);assert.equal(reply.textRun.runId,runId);
  assert.equal(await page.locator('.reasoning-text').textContent(),prefix);assert.match(await page.locator('.reasoning-note').textContent(),/preview is limited|truncated/);assert.equal(await page.locator('#prompt').inputValue(),draft);assert.deepEqual((await snapshot()).chats.find(c=>c.id===old.id),old);
 }
 await projection('Live final');await page.reload();await page.locator('.reasoning-text').waitFor();await page.evaluate(()=>window.SalehChatRuns.refresh());await projection('Cold reload');assert.equal(requests.length,1,'Reload must not replay Deep inference');assert.deepEqual(await readFile(receiptPath),receiptBytes);
 const currentMaps=await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')));for(const [key,value] of Object.entries(maps))assert.deepEqual(currentMaps[key],value);
 // Independent saved/imported-message path: these messages have no backend run links.
 const cases=[{id:'split',raw,expected:prefix,truncated:true},{id:'bmp',raw:'ب'.repeat(64000),expected:'ب'.repeat(64000),truncated:false},{id:'emoji-fit',raw:'x'.repeat(63998)+'🌊',expected:'x'.repeat(63998)+'🌊',truncated:false}],coldChat={...chat,id:'unicode-cold',title:'Synthetic cold Unicode',thinking:'deep',draft:'B163_COLD_DRAFT_SAFE',messages:cases.map(value=>({id:value.id,role:'assistant',state:'complete',content:'COLD_'+value.id,reasoning:value.raw}))};
 const coldContext=await browser.newContext();
 try{
  await coldContext.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
  await coldContext.addInitScript(({coldChat,old})=>{if(localStorage.getItem('fixture-seeded'))return;localStorage.setItem('fixture-seeded','1');localStorage.setItem('saleh-local-model-default-v1','fixture');localStorage.setItem('qwen-local-chats-v1',JSON.stringify({chats:[coldChat,old],selectedId:coldChat.id}));},{coldChat,old});
  const coldPage=await coldContext.newPage();coldPage.on('pageerror',error=>errors.push(error.message));await coldPage.goto(origin);await coldPage.locator('.reasoning-text').first().waitFor();
  const coldSaved=await coldPage.evaluate(fixtureSnapshot),normalized=coldSaved.chats.find(c=>c.id==='unicode-cold');assert.equal(normalized.draft,coldChat.draft);assert.deepEqual(normalized.messages.map(message=>message.id),cases.map(value=>value.id));assert.deepEqual(coldSaved.chats.find(c=>c.id===old.id),old);
  for(const value of cases){const message=normalized.messages.find(message=>message.id===value.id);assert.equal(message.textRun,undefined);assert.equal(message.reasoning.isWellFormed(),true,'Cold normalizer '+value.id+': thinking text stays well-formed');assert.equal(message.reasoning,value.raw,'Cold normalizer '+value.id+': full authoritative reasoning');assert.equal(message.reasoningTruncated,undefined,'Absent historical flags remain absent');assert.equal(message.content,'COLD_'+value.id);assert.equal(await coldPage.locator('article[data-id="'+value.id+'"] .reasoning-text').textContent(),value.expected);}
 }finally{await coldContext.close();}
 assert.equal(requests.length,1);assert.deepEqual(await readFile(receiptPath),receiptBytes);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,deepUnicode:true,upstreamCalls:requests.length,durableReasoningExact:true,liveAndColdPrefixesWellFormed:true,coldNormalizerCases:cases.map(value=>value.id),answerDraftAndIDsPreserved:true,fixtureRoot:root,installedAppTouched:false}));
}

async function checkCapacity(){
 await page.goto(origin);await page.locator('#prompt').fill('CAPACITY_NEW_REQUEST');await page.waitForFunction(()=>!document.getElementById('send').disabled,null,{timeout:8000});
 assert.equal((await snapshot()).chats.length,3);const initial=await snapshot();await page.locator('#restore-file').setInputFiles({name:'duplicate.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({exportedAt:new Date().toISOString(),chats:[...initial.chats,{...initial.chats.find(chat=>chat.id==='capacity-history'),id:'duplicate-run-chat'}]}))});await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('Duplicate saved text-run links'));assert.deepEqual(await snapshot(),initial,'Duplicate run IDs still fail validation');
 await page.locator('#send').click();await wait(()=>streams.length===1,'capacity new send');await wait(async()=>!!(await saved()).messages.at(-1).textRun?.admitted,'capacity admission');
 await page.locator('#prompt').fill('CAPACITY_UNSENT_DRAFT');chunk(0,'CAPACITY_PARTIAL');await page.locator('#stop').click();await wait(async()=>(await saved()).messages.at(-1).state==='stopped','capacity Stop');
 await page.locator('.retry-reply').last().click();await wait(()=>streams.length===2,'capacity Retry after 128');chunk(1,'CAPACITY_FINAL','stop');streams[1].close();await wait(async()=>(await saved()).messages.at(-1).state==='complete','capacity retry final');
 assert.equal((await saved()).draft,'CAPACITY_UNSENT_DRAFT');assert.equal((await saved()).messages.at(-1).content,'CAPACITY_FINAL');
 await page.reload();await page.waitForFunction(()=>!!window.SalehChatRuns);await page.evaluate(()=>window.SalehChatRuns.refresh());assert.equal((await saved()).draft,'CAPACITY_UNSENT_DRAFT');assert.equal((await saved()).messages.at(-1).content,'CAPACITY_FINAL');
 const inventory=await page.evaluate(()=>window.SalehChatRuns.request({action:'list'}));assert.equal(inventory.runs.length,128);assert.equal(inventory.truncated,true);
 for(const historical of capacityChats)assert.deepEqual((await snapshot()).chats.find(chat=>chat.id===historical.id),historical,'Historical chat/draft/link retained: '+historical.id);
 const oldest=capacityChats[0].messages[1].textRun.runId;assert(!inventory.runs.some(value=>value.run.runId===oldest));
 const historical=await page.evaluate(runId=>window.SalehChatRuns.inspect(runId),oldest);assert.equal(historical.run.content,'OLD_CAPACITY_0');
 await page.goto(origin+'/?chatId=capacity-history');await page.locator('#prompt').waitFor();await page.evaluate(()=>window.SalehChatRuns.refresh());assert.equal(await page.locator('#prompt').inputValue(),'CAPACITY_DRAFT_0');assert((await page.locator('#messages').innerText()).includes('OLD_CAPACITY_0'));
 await page.evaluate(async()=>{const inventory=await window.SalehChatRuns.request({action:'list'});window.dispatchEvent(new CustomEvent('chat-run-list',{detail:inventory}));});const omitted=new Set([...capacityReceipts.keys()].filter(id=>!inventory.runs.some(value=>value.run.runId===id)));await bounded(wait(()=>capacityReads.filter(id=>omitted.has(id)).length>=omitted.size,'initial long-chat reconciliation'),'long-chat reconciliation',20000);await page.waitForFunction(async()=>await window.salehSaveBeforeLeave(),null,{timeout:90000});const beforeReads=capacityReads.filter(id=>omitted.has(id)).length;
 await page.evaluate(async()=>{const inventory=await window.SalehChatRuns.request({action:'list'});window.dispatchEvent(new CustomEvent('chat-run-list',{detail:inventory}));});await page.waitForFunction(async()=>await window.salehSaveBeforeLeave(),null,{timeout:90000});assert.equal(capacityReads.filter(id=>omitted.has(id)).length,beforeReads,'Unchanged omitted history must not rescan all receipts on every refresh');
 await signedControl('stop',{coding:false});await page.evaluate(async()=>{const inventory=await window.SalehChatRuns.request({action:'list'});window.dispatchEvent(new CustomEvent('chat-run-list',{detail:inventory}));});await page.waitForFunction(async()=>await window.salehSaveBeforeLeave(),null,{timeout:90000});assert(capacityReads.filter(id=>omitted.has(id)).length>beforeReads,'A new admission generation invalidates historical reconciliation');
 assert.equal((await readdir(join(root,'chat-runs'))).length,262);for(const [id,bytes] of capacityReceipts)assert.deepEqual(await readFile(join(root,'chat-runs',id+'.json')),bytes);
 assert.equal(requests.length,2,'Reload and historical receipt reads do not replay generation');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,capacity:true,historicalReceipts:260,newExplicitRuns:2,oldReceiptsAndDraftsPreserved:true,directOldestRead:true,inventoryBound:128,fixtureRoot:root,installedAppTouched:false}));
}

let held=gate(),sent=gate(),holdStart=!capacityOnly&&!parallelOnly&&!deepUnicodeOnly&&!deepLimitOnly,prepareRelease=null;
await page.route('**/api/chat/runs',async route=>{if(!agentOnly&&route.request().method()==='POST'&&route.request().postDataJSON()?.action==='start'&&holdStart){holdStart=false;const response=await route.fetch();sent.resolve();await held.promise;await route.fulfill({response});}else await route.continue();});
try{
 if(capacityOnly)await checkCapacity();else if(deepLimitOnly)await checkDeepLimit();else if(deepUnicodeOnly)await checkDeepUnicode();else if(sidebarOnly)await checkSidebarFocus();else if(admissionOnly)await checkAdmissionInventory();else if(parallelOnly)await checkParallelChats();else if(agentOnly)await checkAgentContinuity();else{
 await page.goto(origin);await page.locator('#prompt').fill('FIRST_REQUEST');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await sent.promise;await wait(()=>streams.length===1,'first upstream');
 await page.locator('#prompt').fill('DRAFT_EDITED_DURING_ADMISSION');held.resolve();await wait(async()=>!!(await saved()).messages.at(-1).textRun?.admitted,'durable admission');assert.equal(await page.locator('#prompt').inputValue(),'DRAFT_EDITED_DURING_ADMISSION');await checkPanelLayout('Chat');
 chunk(0,'FIRST_PARTIAL ');await page.locator('#workspace-rail').getByRole('button',{name:'Tasks',exact:true}).click();await page.waitForURL('**/coding');await page.waitForFunction(()=>!document.getElementById('chat-background').hidden);assert.equal(signals[0].aborted,false);assert.equal(requests.length,1);await checkPanelLayout('Coding');
 chunk(0,'FIRST_FINAL','stop');streams[0].close();await page.waitForFunction(()=>document.getElementById('chat-background-status').textContent.includes('Reply saved'));await page.locator('#chat-background-open').click();await page.waitForURL('**/?chatId=text-chat');
 await wait(async()=>(await saved()).messages.at(-1).state==='complete','saved final projected');assert.equal((await saved()).messages.at(-1).content,'FIRST_PARTIAL FIRST_FINAL');assert.equal((await saved()).draft,'DRAFT_EDITED_DURING_ADMISSION');await page.reload();await wait(async()=>(await saved()).messages.at(-1).state==='complete','reload final');assert.equal((await saved()).messages.length,2);assert.equal(requests.length,1);
 await page.locator('#chat-background-receipt').click();await page.waitForFunction(()=>document.querySelector('#chat-run-receipt-dialog h2')?.textContent==='Saved Chat result');assert.equal(await page.locator('#chat-run-receipt-dialog pre').textContent(),'FIRST_REQUEST\n\nFIRST_PARTIAL FIRST_FINAL','No-reasoning Chat retains its existing saved-result text');await page.locator('#chat-run-receipt-dialog').getByRole('button',{name:'Close',exact:true}).click();
 await page.locator('#workspace-rail').getByRole('button',{name:'Tasks',exact:true}).click();await page.waitForURL('**/coding');await page.evaluate(()=>window.SalehChatRuns.refresh());assert(await page.locator('#chat-background').isHidden(),'Cold Tasks load hides incidental unrelated fully saved success');assert.equal((await saved()).draft,'DRAFT_EDITED_DURING_ADMISSION');
 await page.goto(origin+'/?chatId=text-chat');await page.evaluate(()=>window.SalehChatRuns.refresh());await page.locator('#chat-background').waitFor({state:'visible',timeout:6000});assert(await page.locator('#chat-background').isVisible(),'Saved completion remains available in its own chat');
 const first=(await saved()).messages.at(-1),stale={run:{version:1,runId:first.textRun.runId,chatId:'text-chat',userMessageId:first.textRun.userMessageId,assistantMessageId:first.id,inputDigest:first.textRun.inputDigest,userMessage:'FIRST_REQUEST',status:'running',revision:1,content:'STALE',reasoning:'',updatedAt:1},live:true,durableRevision:1,persistence:'saved',saveError:null};await page.evaluate(value=>window.SalehChatRuns.receive(value),stale);assert.equal((await saved()).messages.at(-1).content,'FIRST_PARTIAL FIRST_FINAL');
 await page.locator('#prompt').fill('SECOND_REQUEST');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await wait(()=>streams.length===2,'second upstream');chunk(1,'SECOND_PARTIAL');await page.locator('#workspace-rail').getByRole('button',{name:'Tasks',exact:true}).click();await page.waitForURL('**/coding');await page.waitForFunction(()=>!document.getElementById('chat-background-stop').hidden);await page.locator('#chat-background-stop').click();await page.waitForFunction(()=>document.getElementById('chat-background-status').textContent.includes('Stopped'));
 await page.locator('#chat-background-open').click();await wait(async()=>(await saved()).messages.at(-1).state==='stopped','stopped partial projected');assert.equal((await saved()).messages.at(-1).content,'SECOND_PARTIAL');assert.equal(signals[1].aborted,true);await page.reload();await page.waitForFunction(()=>!!window.SalehChatRuns);await wait(async()=>(await saved()).messages.at(-1).state==='stopped','cold page result');assert.equal((await saved()).messages.length,4);assert.equal(requests.length,2);
 assert.deepEqual((await snapshot()).chats.find(c=>c.id==='old-chat'),old);const currentMaps=await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')));for(const [key,value] of Object.entries(maps))assert.deepEqual(currentMaps[key],value,key+' preserved');
 // Stop while prepare itself is delayed: the late ticket must never cause a start POST.
 const preparedSeen=gate();prepareRelease=gate();const prepareStarts=[],trackPrepareStart=request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/chat/runs'&&request.postDataJSON()?.action==='start')prepareStarts.push(request.postDataJSON());};page.on('request',trackPrepareStart);
 const holdPrepare=async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON()?.action==='prepare'){preparedSeen.resolve();await bounded(prepareRelease.promise,'delayed prepare release',12000);}await route.fallback();};await page.route('**/api/chat/runs',holdPrepare);
 await page.locator('#prompt').fill('STOP_DURING_PREPARE');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await bounded(preparedSeen.promise,'prepare held before delivery');
 const stopResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/chat/runs'&&response.request().postDataJSON()?.action==='stop');await page.locator('#stop').click();const stopReply=await bounded(stopResponse,'Stop before prepare'),stopBody=await bounded(stopReply.json(),'Stop before prepare body');assert.equal(stopReply.status(),200);assert.equal(stopBody.run,null);
 prepareRelease.resolve();await wait(async()=>await page.locator('#stop').isHidden()&&(await saved()).messages.at(-1).state==='unconfirmed','delayed prepare cancelled locally');assert.equal(prepareStarts.length,0);assert.equal(requests.length,2);assert.equal((await saved()).draft,'STOP_DURING_PREPARE');assert.equal(await page.locator('#prompt').inputValue(),'STOP_DURING_PREPARE');
 await page.unroute('**/api/chat/runs',holdPrepare);page.off('request',trackPrepareStart);prepareRelease=null;
 // Local quota failure after durable backend admission must keep the submitted draft visible.
 heldIntent=gate();intentSeen=gate();await page.locator('#prompt').fill('QUOTA_DRAFT');await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await intentSeen.promise;
 await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;window.fixtureQuota=true;IDBObjectStore.prototype.put=function(value,key){if(window.fixtureQuota&&this.name==='snapshots'&&key==='head')throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,value,key);};});heldIntent.resolve();heldIntent=null;
 await page.waitForFunction(()=>document.getElementById('storage-notice').textContent.includes('Synthetic quota'));assert.equal(await page.locator('#prompt').inputValue(),'QUOTA_DRAFT');assert.equal((await saved()).draft,'QUOTA_DRAFT');assert.equal((await saved()).messages.at(-1).textRun.admitted,false);
 await page.evaluate(()=>{window.fixtureQuota=false;});await wait(()=>streams.length===3,'quota run upstream');await page.locator('#stop').click();await wait(async()=>(await saved()).messages.at(-1).state==='stopped','quota recovery stopped');assert.equal(requests.length,3);
 // A newer snapshot with a wrong chat binding cannot alter the local answer.
 const completed=(await saved()).messages.at(-1);await page.evaluate(({reply})=>window.dispatchEvent(new CustomEvent('chat-run-snapshot',{detail:{run:{version:1,runId:reply.textRun.runId,chatId:'wrong-chat',userMessageId:reply.textRun.userMessageId,assistantMessageId:reply.id,inputDigest:reply.textRun.inputDigest,userMessage:'SECOND_REQUEST',status:'complete',revision:reply.textRun.revision+1,content:'WRONG_BINDING',reasoning:'',updatedAt:Date.now()},live:false,durableRevision:reply.textRun.revision+1,persistence:'saved',saveError:null}})),{reply:completed});assert.equal((await saved()).messages.at(-1).content,'');
 // Storage conflict blocks projection and leaves the other writer's exact value untouched.
 const other={...await snapshot(),foreignRevision:'preserved'};await page.evaluate(fixtureSnapshot,other);const linked=other.chats.find(c=>c.id==='text-chat').messages.at(-1);await page.evaluate(async saved=>{const value=await window.SalehChatRuns.inspect(saved.textRun.runId);value.run.revision++;value.durableRevision=value.run.revision;value.run.content='CONFLICTING_PROJECTION';window.dispatchEvent(new CustomEvent('chat-run-snapshot',{detail:value}));},linked);assert.deepEqual(await snapshot(),other);
 // Deleted local history is never rebuilt by discovering a retained backend receipt.
 await page.evaluate(fixtureSnapshot,{chats:[old],selectedId:old.id});await page.reload();await page.waitForFunction(()=>!document.getElementById('chat-background').hidden);assert.deepEqual((await snapshot()).chats,[old]);assert.equal(requests.length,3);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,upstreamCalls:requests.length,oldChatAndDraftsPreserved:true,codingNativeExecutionExercised:false}));
}
}finally{held.resolve();prepareRelease?.resolve();heldIntent?.resolve();heldAgentReview?.beforeClaim.resolve();heldAgentReview?.afterClaim.resolve();await page.unrouteAll({behavior:'ignoreErrors'});await server.shutdownTools();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
