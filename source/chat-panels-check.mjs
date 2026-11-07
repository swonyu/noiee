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
 await page.locator('#open-tools').click();assert.equal(await page.locator('#inspector-title').textContent(),'Tools','Tools panel must retain its shared app bindings: '+errors.join(';'));
 await page.locator('#open-computer').click();assert.equal(await page.locator('#inspector-title').textContent(),'Computer','Computer panel must retain its shared app bindings: '+errors.join(';'));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,toolsAndComputerPanels:true,realModels:0,originalStoresTouched:false}));
} finally {await browser.close();await server.shutdownTools();server.close();}
