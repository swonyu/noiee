import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {chromium} from './node_modules/playwright/index.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const source=fs.readFileSync(path.join(directory,'coding.js'),'utf8'),names=[];
const extract=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);};
const catalog=extract('  function catalogProgressSnapshot(', '  async function refreshStatus(');
const reveal=extract('  async function viewGoalTurn(', '  function saveGoalDraft(');
const check=(ok,name)=>{assert.equal(ok,true,name);assert(!names.includes(name));names.push(name);};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const progress={schemaVersion:1,id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',requestId:null,archived:false,searching:false,state:'loading',phase:'owner-history',ownersTotal:4,ownersCompleted:1,threadsVerified:6,elapsedMs:1200,phaseElapsedMs:100};
const allActions=[];
function fixture(){
  const timers=new Map(),requests=[],paints=[];let serial=0,sample={deferred:true,catalogProgress:progress};
  const state={disposed:false,archived:false,listRequest:0,listed:[],listState:'loaded',listLoaded:false,listHistoryWarning:'',listProgress:null,listStartedAt:0,cursor:19,eventNotice:'kept live notice',
    threads:new Map([['pending',{id:'pending',turns:[],archived:false}],['first',{id:'first',turns:[{id:'retained-turn'}],archived:false}]]),
    preferences:{pendingThreads:{pending:{}},drafts:{first:'KEEP exact draft α  \n'}},setupCreatedRoots:new Set(),
    performance:{now:()=>2400},setTimeout:fn=>{const id=++serial;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    childChat:thread=>!!thread.parentThreadId,renderSidebar:()=>paints.push({ids:[...state.listed],state:state.listState}),
    banner:(id,text)=>{state.notice={id,text};},syncMCPOutcomes:()=>{state.synced=true;},
    call:async(action,input)=>{allActions.push(action);if(action==='events')return sample;assert.equal(action,'list');const pending=deferred();requests.push({input,...pending});return pending.promise;}
  };
  const context=vm.createContext(state);vm.runInContext(catalog,context);
  return{context,requests,paints,timers,setSample:value=>{sample=value;},tick:async()=>{const next=timers.entries().next().value;assert(next);timers.delete(next[0]);await next[1]();}};
}
{
  const f=fixture(),s=f.context,work=s.loadList();
  check(s.listState==='loading'&&s.listed.length===0,'pending catalog exposes no provisional rows');
  await f.tick();
  check(s.listProgress.threadsVerified===6&&s.catalogLoadingText().includes('6 checked')&&s.cursor===19&&s.listed.length===0,'display-only progress leaves rows and event cursor unchanged');
  f.setSample({deferred:true,catalogProgress:{...progress,elapsedMs:900,threadsVerified:1}});await f.tick();
  check(s.listProgress.threadsVerified===6,'regressing scan progress is ignored');
  f.setSample({deferred:true,catalogProgress:{...progress,id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',threadsVerified:90}});await f.tick();
  check(s.listProgress.threadsVerified===6,'a different scan cannot replace the current progress observation');
  f.requests[0].resolve({threads:[{id:'first',name:'First verified chat'}],nextCursor:'page-two',historyIncomplete:true,historyWarning:'Some older history is unavailable.'});await flush();
  check(s.listed.join(',')==='pending,first'&&s.listState==='loading'&&f.requests[1].input.cursor==='page-two','verified first page and pending drafts become visible before later pages finish');
  check(s.threads.get('first').turns[0].id==='retained-turn'&&s.preferences.drafts.first==='KEEP exact draft α  \n','incremental catalog publication preserves loaded turns and exact drafts');
  f.requests[1].resolve({threads:[{id:'second',name:'Second verified chat'},{id:'child',parentThreadId:'first'}],nextCursor:null});await work;
  check(s.listed.join(',')==='pending,first,second'&&s.listState==='loaded'&&s.listLoaded&&s.synced&&s.listHistoryWarning==='Some older history is unavailable.','completed paging retains history warnings and excludes child rows');
  check(f.timers.size===0&&s.notice.text==='kept live notice','completed paging stops progress sampling and preserves the live event notice');
}
{
  const f=fixture(),s=f.context,work=s.loadList();
  f.requests[0].resolve({threads:[{id:'first'}],nextCursor:'page-two'});await flush();
  f.requests[1].reject(Error('Generated page failure'));await assert.rejects(work,/Generated page failure/);
  check(s.listState==='failed'&&s.listed.includes('first')&&!s.listLoaded&&s.listHistoryWarning.includes('missing')&&f.timers.size===0,'later-page failure retains verified rows with an explicit incomplete state');
}
for(const change of ['selection-mode','new-request','disposed']){
  const f=fixture(),s=f.context,work=s.loadList();
  if(change==='selection-mode')s.archived=true;else if(change==='new-request')s.listRequest++;else s.disposed=true;
  f.requests[0].resolve({threads:[{id:'stale'}],nextCursor:null});await work;
  check(!s.threads.has('stale')&&!s.listed.includes('stale')&&f.timers.size===0,'late catalog reply is ignored after '+change);
}
{
  const f=fixture(),s=f.context,work=s.loadList();
  f.requests[0].resolve({threads:[{id:'first'}],nextCursor:'loop'});await flush();
  f.requests[1].resolve({threads:[],nextCursor:'loop'});await assert.rejects(work,/pagination/);
  check(s.listState==='failed'&&f.requests.length===2,'repeating pagination stops without a request loop');
  for(const invalid of [{...progress,archived:true},{...progress,searching:true},{...progress,state:'complete'},{...progress,threadsVerified:-1},{...progress,ownersCompleted:5},{...progress,elapsedMs:Infinity},{...progress,phase:'unknown'}])assert.equal(s.catalogProgressSnapshot(invalid,false),null);
  check(true,'invalid or unrelated progress cannot produce a loading observation');
}

const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
try{
  const context=await browser.newContext({viewport:{width:900,height:650}}),requests=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();
  await page.setContent('<!doctype html><html><body><textarea id="prompt">KEEP composer draft α  </textarea><div id="messages"></div></body></html>');
  await page.evaluate(code=>{
    window.selectedId='root';window.selectionEpoch=1;window.disposed=false;window.reads=[];window.pendingRead=null;
    window.thread={id:'root',turns:[{id:'older',status:'completed'},{id:'exact',status:'completed'},{id:'newest',status:'completed'}]};
    window.$=id=>document.getElementById(id);window.current=()=>window.thread;window.goalContext=()=>({canInspect:true});window.message=error=>error.message;
    window.readThread=async id=>{window.reads.push(id);if(window.pendingRead)await window.pendingRead;};
    window.renderMessages=()=>{const host=$('messages');host.replaceChildren();for(const turn of window.thread.turns){const section=document.createElement('section');section.className='turn';section.dataset.turnId=turn.id;section.textContent='Saved '+turn.id;section.style.height='350px';host.append(section);}};
    window.viewGoalTurn=new Function(code+'\nreturn viewGoalTurn;')();
    window.target={threadId:'root',goalId:'goal',attemptId:'attempt',turnId:'exact',goalRevision:3,binding:{rootThreadId:'root'}};
    window.renderMessages();
  },reveal);
  const result=await page.evaluate(async()=>({result:await viewGoalTurn(target),focused:document.activeElement.dataset.turnId,reads:reads.length,draft:$('prompt').value}));
  check(result.result.shown&&result.focused==='exact'&&result.reads===0&&result.draft==='KEEP composer draft α  ','View result focuses the exact acknowledged turn while preserving the composer');
  const missing=await page.evaluate(async()=>{const response=await viewGoalTurn({...target,turnId:'missing'});return{response,reads:[...reads],focused:document.activeElement.dataset.turnId};});
  check(!missing.response.shown&&missing.response.reason.includes('exact turn')&&missing.reads.join(',')==='root'&&missing.focused==='exact','missing result permits one history read without falling back to the newest turn');
  const wrong=await page.evaluate(async()=>{const before=reads.length;const response=await viewGoalTurn({...target,binding:{rootThreadId:'other'}});return{response,unchanged:reads.length===before};});
  check(!wrong.response.shown&&wrong.unchanged,'mismatched result binding is refused before any history read');
  const inherited=await page.evaluate(async()=>{thread.turns.find(t=>t.id==='exact').status='inheritedStopped';return viewGoalTurn(target);});
  check(!inherited.shown,'inherited parent context cannot stand in for a Goal continuation result');
  await page.evaluate(()=>{thread.turns=[];window.pendingRead=new Promise(resolve=>{window.releaseRead=resolve;});window.pendingView=viewGoalTurn(target);});
  const late=await page.evaluate(async()=>{selectedId='other';selectionEpoch++;thread={id:'other',turns:[{id:'exact',status:'completed'}]};releaseRead();return pendingView;});
  check(!late.shown&&late.reason.includes('changed'),'selection changes during a result read prevent late focus or scrolling');
  check(requests.length===0,'result navigation makes no model, native or network request');
  await context.close();
}finally{await browser.close();}
check(allActions.every(action=>['list','events'].includes(action)),'catalog controller uses only list and event reads');
check(fs.readFileSync(path.join(directory,'coding.js'),'utf8')===source,'tested controller source remains unchanged');
console.log(JSON.stringify({schemaVersion:1,name:'coding-catalog-ui',passed:names.length,failed:0,checks:names}));
