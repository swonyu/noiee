// Actual source in a capability-free VM; guards precede every product evaluation.
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import cp from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {randomUUID,webcrypto,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const SOURCE=fileURLToPath(new URL('../../source/',import.meta.url)).replace(/\/$/,'');
assert(process.argv[2]===undefined||process.argv[2]===SOURCE,'Only the Noiee continuation source is allowed');
const effects={network:0,childProcess:0,originalStore:0,productImports:0};
const deny=key=>()=>{effects[key]++;throw Error('R2 offline guard: '+key);};
for(const [target,names]of [[net,['connect','createConnection','createServer']],[http,['request','get','createServer']],[https,['request','get','createServer']],[cp,['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]])for(const name of names)target[name]=deny(target===cp?'childProcess':'network');
net.Socket.prototype.connect=deny('network');globalThis.fetch=deny('network');
const read=fs.readFileSync.bind(fs);fs.readFileSync=(path,...rest)=>{if(!String(path).startsWith(SOURCE+'/'))return deny('originalStore')();return read(path,...rest);};syncBuiltinESMExports();
const app=fs.readFileSync(SOURCE+'/app.js','utf8'),helper=fs.readFileSync(SOURCE+'/context-compaction.js','utf8'),work=fs.readFileSync(SOURCE+'/work.js','utf8'),runs=fs.readFileSync(SOURCE+'/chat-runs.js','utf8');
const modelHelperNames=['model-policy.js','model-picker.js'].filter(name=>fs.existsSync(SOURCE+'/'+name)),modelHelpers=modelHelperNames.map(name=>fs.readFileSync(SOURCE+'/'+name,'utf8')).join('\n');
assert(!app.includes('globalThis.NoieeModelPolicy.contextProfile')||modelHelperNames.length===2,'Actual model helpers are required by the integrated outbound handler');
const extract=(start,end)=>{const a=app.indexOf(start),b=app.indexOf(end,a);assert(a>=0&&b>a,start);return app.slice(a,b);};
// Use the actual pure validator and origin declarations without starting the page event loop.
const validationStart=runs.indexOf('  const uuid='),validationEnd=runs.indexOf('  const statuses=',validationStart);assert(validationStart>=0&&validationEnd>validationStart);
const submissionValidation=runs.slice(validationStart,validationEnd),submissionHelpers=extract('let composerSubmission=','function requestComposerSubmit(');
const generation=extract('async function generateRun(', 'async function readBackupSelection('),form=extract("$('composer').onsubmit =", "window.addEventListener('computer-busy'"),modelChange=extract("$('chat-model').onchange =", "$('default-model').onchange"),modeChange=extract("$('chat-mode').onchange=", "$('thinking').onchange");
const stopHandler=extract("$('stop').onclick =", "$('open-coding').onclick"),retryStart=app.indexOf('retry.onclick ='),retryEnd=app.indexOf('; actions.append(retry)',retryStart),retryHandler=app.slice(retryStart,retryEnd+1);assert(retryStart>=0&&retryEnd>retryStart);
const rows=[],failures=[],observations=[];async function test(name,fn){try{const detail=await fn();rows.push({name,passed:true,...detail});console.log('PASS '+name);}catch(error){const row={name,passed:false,error:error.message};rows.push(row);failures.push(row);console.log('FAIL '+name+' · '+error.message);}}
const chatFixture=()=>({id:'review-chat',model:'owner-selected-Q8-fixture',thinking:'standard',mode:'chat',title:'Original',draft:'first draft😀\n ',draftAttachments:[{kind:'text',name:'draft.txt',text:' exact\n'}],unknownChat:{kept:true},notes:'',project:'',file:null,messages:Array.from({length:8},(_,n)=>({id:'original-'+n,role:n%2?'assistant':'user',content:'Original '+n+' الرياض😀',state:'complete',unknown:{kept:n}}))});
const tick=()=>new Promise(r=>setImmediate(r));
async function fixture({activeSummary=true}={}){
 let delayed=false,release,beforePrepare=null;const gate=new Promise(r=>release=r),calls=[],notices=[];let digestWaits=0;
 const crypto={randomUUID,subtle:{digest:async(...args)=>{if(delayed){digestWaits++;await gate;}return webcrypto.subtle.digest(...args);}}};
 const chat=chatFixture(),elements=new Map(),element=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false,disabled:false});return elements.get(id);};
 const context=vm.createContext({console,Event,TextEncoder,TextDecoder,structuredClone,crypto,chat,element,notices,document:{body:{},activeElement:element('prompt'),hasFocus:()=>true,visibilityState:'visible'},location:{href:'http://fixture.invalid/'},setTimeout,clearTimeout});
 vm.runInContext(modelHelpers+'\n'+work+'\n'+helper,context,{timeout:2000});
 context.contextCompaction=context.SalehContextCompaction;
 if(activeSummary){const compact=context.contextCompaction,source=await compact.capture(chat,{revision:1,commitId:randomUUID()}),job=compact.create(source);job.inputDigest='a'.repeat(64);job.status='complete';job.revision=3;job.summary='Retain the Riyadh decision. Unknown actions stay unknown.';job.summaryHash=await compact.digest(job.summary);chat.contextCompactions={version:1,activeId:job.id,records:[job]};}
 context.window={SalehChatRuns:{generation:async()=> '10000000-0000-4000-8000-000000000001',digest:async input=>createHash('sha256').update(JSON.stringify(input)).digest('hex'),metadata:value=>value,request:async input=>{calls.push(structuredClone(input));if(input.action==='prepare')await beforePrepare?.();return input.action==='prepare'?{...input,ticket:'10000000-0000-4000-8000-000000000002'}:{run:null};},receive(){},watch:async()=>{},refresh:async()=>{},stop:async()=>({run:null}),allowAgentReview(){}}};
 vm.runInContext(`
 const $=element,current=()=>chat,chats=[chat];
 let storageHydrating=false,storageBlocked=false,restoring=false,structuralPending=false,computerBusy=false,textRunsReady=true,pageDisposed=false,textRunGeneration=null;
 const deletingChats=new Set(),attachmentReads=new Map(),activeRuns=new Map(),textInspections=new Map(),pendingModelDefaults=new WeakSet();
 const activeFor=chat=>[...activeRuns.values()].find(row=>row.chatId===chat.id);
 const parallelTextChat=()=>true,runBlocked=chat=>!!activeFor(chat)||activeRuns.size>=2;
 const controls=()=>{},notice=text=>notices.push(text),save=async()=>true,render=()=>{},renderSidebar=()=>{},refreshReply=()=>{},messageRoom=()=>true,chatModelState=()=>({ready:true,entry:{contextLength:65536}});
 const draftAttachments=chat=>chat.draftAttachments??chat.messages.find(message=>message.id===chat.draftAttachmentMessageId)?.attachments??[];
 const attachments={normalize:value=>structuredClone(value),content:message=>message.content};
 ${submissionValidation}
 window.SalehChatRuns.submission=normalizeSubmission;
 ${submissionHelpers}
 ${generation}
 const pendingGenerations=[],actualGenerate=generate;generate=(...args)=>{const pending=actualGenerate(...args);pendingGenerations.push(pending);return pending;};
 ${form}
 ${modelChange}
 ${modeChange}
 ${stopHandler}
 globalThis.state=()=>({active:activeRuns.size,admissions:[...activeRuns.values()],chat});
 globalThis.submit=()=>{ $('prompt').value=chat.draft;$('composer').onsubmit(new Event('submit',{cancelable:true})); };
 globalThis.changeModel=()=>{$('chat-model').value='different-fixture-model';$('chat-model').onchange();};
 globalThis.changeMode=()=>{$('chat-mode').value='agent';$('chat-mode').onchange();};
 globalThis.cancel=()=>$('stop').onclick();
 globalThis.makeRetry=()=>{const m=chat.messages.at(-1),retry={};${retryHandler}return()=>retry.onclick(new Event('click',{cancelable:true}));};
 globalThis.awaitGenerations=()=>Promise.all(pendingGenerations);
 `,context,{timeout:2000});
 return {chat,context,calls,notices,onPrepare(fn){beforePrepare=fn;},delay(){delayed=true;},release(){delayed=false;release();},get waits(){return digestWaits;},async settle(){await context.awaitGenerations();assert.equal(context.state().active,0);}};
}

await test('Send reserves its existing admission before actual delayed SHA projection',async()=>{
 const f=await fixture();f.delay();f.context.submit();await tick();const during=f.context.state();f.chat.draft=' newer second draft😀\n\t ';f.context.submit();await tick();const users=f.chat.messages.filter(row=>row.role==='user'&&!row.id.startsWith('original-'));f.release();await f.settle();
 const starts=f.calls.filter(row=>row.action==='start');observations.push({case:'double Send',reservedDuringProjection:during.active,appendedUserIds:users.map(row=>row.id),startUserIds:starts.map(row=>row.userMessageId),draft:f.chat.draft,notices:f.notices});assert.equal(during.active,1,'No run was reserved while projection awaited SHA');assert.equal(users.length,1,'Second Send appended another user before first admission');assert.equal(starts.length,1);assert.equal(starts[0].userMessageId,users[0].id);assert.equal(starts[0].submission.path,'form-submit');assert.equal(starts[0].submission.eventType,'submit');assert.equal(starts[0].submission.isTrusted,false);assert.equal(starts[0].submission.submitter,'none');assert.equal(f.chat.draft,' newer second draft😀\n\t ');assert.equal(f.chat.messages.find(row=>row.id===users[0].id).attachments[0].text,' exact\n');return {delayedDigestCalls:f.waits,starts:starts.length};
});
for(const setting of ['Model','Mode'])await test(setting+' edit cannot cross the projection admission gap',async()=>{
 const f=await fixture();f.delay();f.context.submit();await tick();f.context['change'+setting]();const selected={model:f.chat.model,mode:f.chat.mode};f.release();await f.settle();assert.equal(selected.model,'owner-selected-Q8-fixture');assert.equal(selected.mode,'chat');assert.equal(f.calls.filter(row=>row.action==='start').length,1);return {selected};
});
await test('Stop during delayed projection sends no ordinary request and keeps the draft',async()=>{
 const f=await fixture();f.delay();f.context.submit();await tick();await f.context.cancel();f.chat.draft=' new unsent after Stop😀 ';f.release();await f.settle();assert.equal(f.calls.filter(row=>row.action==='start').length,0);assert.equal(f.chat.draft,' new unsent after Stop😀 ');
});
await test('the actual retry caller also reserves before projection and preserves the unsent draft',async()=>{
 const f=await fixture();f.chat.messages.at(-1).state='unconfirmed';const retry=f.context.makeRetry(),draft=structuredClone({text:f.chat.draft,files:f.chat.draftAttachments});f.delay();retry();await tick();const during=f.context.state().active;retry();f.release();await f.settle();const users=f.chat.messages.filter(row=>row.role==='user'&&!row.id.startsWith('original-')),starts=f.calls.filter(row=>row.action==='start');assert.equal(during,1);assert.equal(users.length,1);assert.equal(starts.length,1);assert.equal(starts[0].userMessageId,users[0].id);assert.equal(starts[0].submission.path,'retry');assert.equal(starts[0].submission.eventType,'click');assert.equal(starts[0].submission.isTrusted,false);assert.equal(starts[0].submission.retryOfUserMessageId,'original-6');assert.equal(f.chat.draft,draft.text);assert.deepEqual(f.chat.draftAttachments,draft.files);
});

for(const [name,change] of [['notes',chat=>chat.notes='changed while hashing'],['covered original',chat=>chat.messages[0].content+=' changed while hashing']])await test(name+' edit during outbound projection refuses dispatch and keeps the draft',async()=>{
 const f=await fixture(),draft=f.chat.draft;f.delay();f.context.submit();await tick();change(f.chat);f.release();await f.settle();assert.equal(f.calls.filter(row=>row.action==='start').length,0);assert.equal(f.chat.draft,draft);
});
for(const [name,change] of [['notes',chat=>chat.notes='changed after prepare'],['summary',chat=>chat.contextCompactions.records[0].summary+=' changed after prepare'],['full-history selection',chat=>chat.contextCompactions.activeId=null]])await test(name+' edit after admission prepare refuses the already projected summary',async()=>{
 const f=await fixture(),draft=f.chat.draft;f.onPrepare(()=>change(f.chat));f.context.submit();await f.settle();assert.equal(f.calls.filter(row=>row.action==='prepare').length,1);assert.equal(f.calls.filter(row=>row.action==='start').length,0);assert.equal(f.chat.draft,draft);
});
for(const [name,alter]of [
 ['unconfirmed assistant',m=>{m.state='unconfirmed';}],
 ['stopped partial assistant',m=>{m.state='stopped';}],
 ['length partial assistant',m=>{m.state='length';}],
 ['pending native step',m=>{m.pendingStep={state:'pending',stepId:randomUUID()};}],
 ['claimed native step',m=>{m.pendingStep={state:'claimed',stepId:randomUUID(),claimId:randomUUID()};}],
 ['pending tool receipt',m=>{m.receipts=[{id:randomUUID(),tool:'run_command',status:'pending',message:'Requested, outcome unknown',input:'never execute'}];}],
 ['unconfirmed tool receipt',m=>{m.receipts=[{id:randomUUID(),tool:'run_command',status:'unconfirmed',message:'Dispatch outcome unknown',input:'never execute'}];}],
 ])await test('contiguous prefix stops before '+name+' and continuation retains raw evidence',async()=>{
 const f=await fixture({activeSummary:false}),compact=f.context.contextCompaction;alter(f.chat.messages[3]);const originals=structuredClone(f.chat.messages),source=await compact.capture(f.chat,{revision:1,commitId:randomUUID()});
 assert.deepEqual(Array.from(source.covered,row=>row.id),['original-0','original-1']);assert.equal(source.excerpt.includes('Original 3'),false);const job=compact.create(source);job.inputDigest='a'.repeat(64);job.status='complete';job.revision=3;job.summary='Only the settled first exchange';job.summaryHash=await compact.digest(job.summary);f.chat.contextCompactions={version:1,activeId:job.id,records:[job]};const view=await compact.project(f.chat);assert.deepEqual(structuredClone(view.slice(1)),originals.slice(2));assert.deepEqual(f.chat.messages,originals);
});
await test('complete exchanges with confirmed failed or cancelled tool receipts remain eligible',async()=>{
 const f=await fixture({activeSummary:false}),compact=f.context.contextCompaction;f.chat.messages[3].receipts=[{id:randomUUID(),tool:'run_command',status:'error',message:'Command exited 1',input:'generated command'},{id:randomUUID(),tool:'run_command',status:'cancelled',message:'Nothing dispatched',input:'generated command'}];const source=await compact.capture(f.chat,{revision:1,commitId:randomUUID()});assert.equal(source.covered.length,6);assert(source.excerpt.includes('Command exited 1'));assert(source.excerpt.includes('Nothing dispatched'));
});
await test('an unresolved first exchange refuses without source mutation',async()=>{
 const f=await fixture({activeSummary:false}),compact=f.context.contextCompaction;f.chat.messages[1].state='unconfirmed';const before=structuredClone(f.chat);await assert.rejects(compact.capture(f.chat,{revision:1,commitId:randomUUID()}),/complete|unfinished|unsettled|unconfirmed/i);assert.deepEqual(f.chat,before);
});
await test('an orphan older user exchange is not covered',async()=>{
 const f=await fixture({activeSummary:false}),compact=f.context.contextCompaction;f.chat.messages.splice(3,1);const source=await compact.capture(f.chat,{revision:1,commitId:randomUUID()});assert.deepEqual(Array.from(source.covered,row=>row.id),['original-0','original-1']);
});
await test('continuation lowers uncertain original request and exact receipts without summary substitution',async()=>{
 const f=await fixture({activeSummary:false}),compact=f.context.contextCompaction;f.chat.messages[3].state='unconfirmed';f.chat.messages[3].receipts=[{id:randomUUID(),tool:'run_command',status:'unconfirmed',message:'Dispatch outcome unknown; inspect target',input:'never retry this generated command',output:'Exact unknown evidence الرياض😀'}];const source=await compact.capture(f.chat,{revision:1,commitId:randomUUID()}),job=compact.create(source);job.inputDigest='a'.repeat(64);job.status='complete';job.revision=3;job.summary='Settled first exchange only';job.summaryHash=await compact.digest(job.summary);f.chat.contextCompactions={version:1,activeId:job.id,records:[job]};f.chat.draft='new continuation😀';f.context.submit();await f.settle();const start=f.calls.find(row=>row.action==='start');assert(start);const text=JSON.stringify(start.messages);for(const value of ['Original 2','Original 3','Partial assistant response (unconfirmed','Dispatch outcome unknown; inspect target','never retry this generated command','Exact unknown evidence الرياض😀'])assert(text.includes(value),value);assert.equal(f.chat.contextCompactions.activeId,job.id);
});
await test('existing summary that covered an unsettled boundary is rejected rather than hiding it',async()=>{
 const f=await fixture({activeSummary:false}),compact=f.context.contextCompaction,source=await compact.capture(f.chat,{revision:1,commitId:randomUUID()});f.chat.messages[3].state='unconfirmed';source.covered[3].hash=await compact.digest(f.chat.messages[3]);const {digest,...body}=source;source.digest=await compact.digest(body);const job=compact.create(source);job.inputDigest='a'.repeat(64);job.status='complete';job.revision=3;job.summary='Legacy summary must not hide uncertainty';job.summaryHash=await compact.digest(job.summary);f.chat.contextCompactions={version:1,activeId:job.id,records:[job]};assert.equal(await compact.matches(f.chat,source,job.id),false);await assert.rejects(compact.project(f.chat),/stale|changed/);
});
await test('oversized uncertain raw suffix refuses instead of being silently trimmed',async()=>{
 const f=await fixture({activeSummary:false});f.chat.messages[3].state='unconfirmed';f.chat.messages[3].content='UNCONFIRMED RAW BOUNDARY '+ 'x'.repeat(42000);f.chat.messages[4].content='Later original request '+ 'y'.repeat(28000);f.chat.draft='  latest draft الرياض😀\n ';const original=structuredClone(f.chat.messages);f.context.submit();await f.settle();assert.equal(f.calls.filter(row=>row.action==='start').length,0);assert(f.notices.some(text=>/Unsettled original history.*omission/.test(text)),f.notices.join('\n'));assert.equal(f.chat.draft,'  latest draft الرياض😀\n ');assert.deepEqual(f.chat.messages.slice(0,original.length),original);
});
assert.deepEqual(effects,{network:0,childProcess:0,originalStore:0,productImports:0});
console.log(JSON.stringify({passed:rows.length-failures.length,failed:failures.length,rows,observations,...effects,source:SOURCE,sourcePins:Object.fromEntries(['app.js','chat-runs.js','context-compaction.js','work.js',...modelHelperNames].map(name=>[name,createHash('sha256').update(fs.readFileSync(SOURCE+'/'+name)).digest('hex')]))}));
if(failures.length)process.exitCode=1;
