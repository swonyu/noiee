import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {chromium} from 'playwright';

const root = new URL('.', import.meta.url);
assert(existsSync(new URL('coding.html', root)), 'Coding workspace page must exist');
const html = await readFile(new URL('coding.html', root), 'utf8');
if(process.argv.includes('--git-publishing-only'))for(const id of ['git-publish-panel','git-remote','git-publish-branch','git-base-branch','git-remote-check','git-publish','git-pr-title','git-pr-body','git-pr-create','git-remote-receipts'])assert(html.includes(`id="${id}"`),`Missing Changes publication control: ${id}`);
const fixtureModel='qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp';
for (const id of ['prompt', 'terminal-command', 'terminal-input', 'schedule-prompt']) {
  const textarea = html.match(new RegExp(`<textarea\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] || '';
  for (const attribute of ['spellcheck="false"', 'autocorrect="off"', 'autocapitalize="off"']) assert(textarea.includes(attribute), `${id} disables native text correction: ${attribute}`);
}
assert.match(html, /<textarea\b[^>]*\bid="schedule-prompt"[^>]*\bmaxlength="20000"/, 'Scheduled instructions respect the native prompt character ceiling; native validates UTF-8 bytes');
const server = createServer(async (req, res) => {
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Ordinary Chat fixture</title><a id=return-coding href=/coding>Open Coding</a>');return;}
  if(req.url==='/api/chat/runs'&&req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{action:'list'});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({runs:[],generation:'11111111-1111-4111-8111-111111111111'}));return;}
  if(req.url==='/api/access'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(process.argv.includes('--recovery-startup-only')?{mode:'full',managedChangesBlocked:false,recoveryStartup:true}:{mode:'full',managedChangesBlocked:true}));return;}
  if(req.url==='/api/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({online:true,models:[{id:fixtureModel,label:'Fixture model',available:true,loaded:true,capabilities:{coding:true,standard:true,deep:true}},...(process.argv.some(arg=>['--polish-layout-only','--schedule-mode-only'].includes(arg))?[{id:'local/saleh-qwen38-uncensored-8bit',label:'Saleh Qwen38 Uncensored 8bit',available:true,loaded:true,contextLength:131072,capabilities:{coding:true,standard:true,deep:true}}]:[])]}));return;}
  const name = req.url === '/coding' ? 'coding.html' : req.url.slice(1);
  const assets = {'xterm.js':'node_modules/@xterm/xterm/lib/xterm.js','xterm-fit.js':'node_modules/@xterm/addon-fit/lib/addon-fit.js','xterm.css':'node_modules/@xterm/xterm/css/xterm.css'};
  if (!['coding.html', 'coding.js', 'model-policy.js', 'model-picker.js', 'chat-runs.js', 'work.js', 'coding.css', 'coding-terminal.js', 'coding-submission.js','coding-goals.js', 'attachments.js', 'attachment-storage.js', 'coding-metrics.js', 'coding-skills.js', 'coding-mcp-setup.js', 'workspace.css', 'workspace-extensions.js', 'workspace.js', ...Object.keys(assets)].includes(name)) {res.writeHead(404).end(); return;}
  res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(await readFile(new URL(assets[name] || name, root)));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({channel: 'chrome', headless: true, chromiumSandbox: true,args:['--disable-gpu']});
const context = await browser.newContext({viewport: {width: 1360, height: 900}, permissions: ['clipboard-read', 'clipboard-write']});
const origin = `http://127.0.0.1:${server.address().port}`;
const localOnly = route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient');
await context.route('**/*', localOnly);
const page = await context.newPage(), errors = [], calls = [], events = [], approvals = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {if (['script','stylesheet'].includes(response.request().resourceType()) && response.status() >= 400) errors.push(`Workspace asset failed: ${new URL(response.url()).pathname} (${response.status()})`);});
let sequence = 0, counter = 0, turnCounter = 0, gap = false, eventBusy = false, failSend = false, nativeActive = 0, maxNative = 0, terminalActive = false, failReadOnce = false, finishTerminalAtStatus = false;
let hideAllThreads = false, omitEmpty = false, cancelStart = false, failStart = false, failRename = false;
let readHistoryWarning = 'Partial answer recovery unavailable: fixture invalid file.';
const completionReadModes = new Map();
const mcpOutcomeFixtures=new Map();let mcpOutcomeError='',holdMCP=false,releaseMCP=null;
let heldApproval = null, releaseApproval = null, ordinaryActive = 0, maxOrdinary = 0;
let heldReadThreadId = '', releaseRead = null, holdTerminalStart = false, releaseTerminalStart = null;
let holdSend = false, releaseSend = null;
let holdReview = false, releaseReview = null;
const workspaceSync = new Map(); let holdStatus = false, releaseStatus = null, holdEvents = false, releaseEvents = null;
let terminalThreadId = 'new-1', terminalProcessId = 'terminal-1';
let interactive=null,cancelInteractive=false,cancelAttach=false;
const savedCommandRows=new Map();let savedCommandError='',savedCommandMalformed='',holdSavedCommand='',releaseSavedCommand=null;
const savedOwner='11111111-1111-4111-8111-111111111111';
const savedRow=(thread,id,overrides={})=>({recordId:id,ownerId:savedOwner,threadId:thread,rootThreadId:thread,ownerGeneration:'22222222-2222-4222-8222-222222222222',cwd:'/fixture/saved-project',command:'printf <saved-command>',output:'SAVED <img src=x onerror=alert(1)> OUTPUT',createdAt:1700000000000,endedAt:1700000001000,state:'exited',exitCode:137,stopRequested:true,outputTruncated:false,droppedOutputBytes:0,observationComplete:true,error:null,...overrides});
let deferInterruptCompletion = false, finishInterrupt = null, holdInterruptReply = false, releaseInterruptReply = null, failFamilyStop = false;
const familyStopping = new Set(); let repeatFamilyCursor = false, heldFamily = '', releaseFamily = null;
let worktreeBusy = false, holdWorktreeCreate = false, releaseWorktreeCreate = null, worktreeCancelled = false;
let cancelWorktreeCreate = false, failWorktreeCreate = false, cancelWorktreeOpen = false, failWorktreeOpen = false, failWorktreeList = false, cancelFolder = false, allowCloud = false, rejectManagedStart = false;
let holdWorktreeOpen = false, releaseWorktreeOpen = null;
let holdWorktreeStop = false, releaseWorktreeStop = null;
let worktreeLifecycleOutcome = '', holdWorktreeLifecycle = false, releaseWorktreeLifecycle = null;
const handoffs=[];let handoffOutcome='',holdHandoff=false,releaseHandoff=null,handoffReadBlocked=false,handoffReadFailure='refused';
let recoveryOutcome='',holdRecovery=false,releaseRecovery=null,recoveryFamily=null,recoveryCorrupt=null;
let recoveryCopyReadOnly=false,recoveryCopyOutcome='',recoveryCopyCorrupt=null;
let worktreeOpenAvailable,worktreeCreateAvailable=null,worktreeHandoffAvailable;
const worktrees = [{id:'managed-ready',source:'/fixture/source',commit:'a'.repeat(40),head:'b'.repeat(40),cwd:'/fixture/managed/ready',createdAt:1,state:'ready',dirty:true,message:''}, {id:'managed-missing',source:'/fixture/source',commit:'c'.repeat(40),cwd:'/fixture/managed/missing',createdAt:2,state:'missing',message:'Checkout is missing'}, {id:'managed-inspect',source:'/fixture/<img src=x onerror=alert(1)>',commit:'d'.repeat(40),cwd:'/fixture/managed/uncertain',createdAt:3,state:'needs-inspection',message:'Interrupted checkout; inspect before continuing'}];
const scheduleId='11111111-1111-4111-8111-111111111111', schedules=[{id:scheduleId,name:'Saved <img src=x onerror=alert(1)>',cwd:'/fixture/older',prompt:'Review project',effort:'none',cadence:{type:'interval',minutes:60},active:false,status:'paused',nextRunAt:null,runs:[{id:'run-1',scheduledFor:1,startedAt:2,finishedAt:3,status:'needs-review',threadId:'saved',message:'Exact <script>unsafe()</script>',manual:true}]}];
let scheduleRunningId=null, scheduleWarning='', scheduleHistoryTruncated=false, cancelSchedule=false, failSchedule=false, holdSchedule=false, releaseSchedule=null;
const gitFixtures=new Map();let gitRevision=0, gitOutcome='completed', failGitInspect=false, holdGit='', releaseGit=null, gitNoSnapshot=false, gitStopOutcome='cancelled', holdGitStop=false, releaseGitStop=null;
const publishViews=new Map(),publishedRefs=new Map();let prDisposition='created',malformedRemote=false,lostReply=false,inspectionBadURL=false;
const gitSnapshot=cwd=>{if(!gitFixtures.has(cwd))gitFixtures.set(cwd,{id:'33333333-3333-4333-8333-333333333333',repositoryId:`repo-${cwd}`,commonRepositoryId:`common-${cwd}`,cwd,branch:'fixture-branch',head:'a'.repeat(40),branches:[{name:'fixture-branch',head:'a'.repeat(40),current:true,checkedOut:false},{name:'feature/safe',head:'b'.repeat(40),current:false,checkedOut:false},{name:'feature/elsewhere',head:'c'.repeat(40),current:false,checkedOut:true}],entries:[{id:'mixed',path:'mixed file.txt',index:'M',worktree:'M',canStage:true,canUnstage:true},{id:'untracked',path:'<img src=x onerror=alert(1)>\nnew.txt',index:'?',worktree:'?',canStage:true,canUnstage:false},{id:'staged',path:'staged.txt',index:'A',worktree:' ',canStage:false,canUnstage:true}],diff:'diff --git a/app.js b/app.js\n+<img src=x onerror=alert(1)>',truncated:true,author:{name:'Fixture Author',email:'fixture@example.invalid'}});return gitFixtures.get(cwd);};
const scheduleResult=()=>({schedules:copy(schedules),runningId:scheduleRunningId,warning:scheduleWarning,historyTruncated:scheduleHistoryTruncated});
const threads = new Map([['saved', {id: 'saved', cwd: '/fixture/older', name: 'Saved chat', turns: [], archived: false}]]);
const emit = (method, params) => events.push({sequence: ++sequence, method, params});
const copy = value => structuredClone(value);
const rootId = id => {const seen=new Set(); while(threads.get(id)?.parentThreadId&&!seen.has(id)){seen.add(id);id=threads.get(id).parentThreadId;}return id;};
const subtree = id => [...threads.values()].filter(thread=>{const seen=new Set();let next=thread.id;while(next&&!seen.has(next)){if(next===id)return true;seen.add(next);next=threads.get(next)?.parentThreadId;}return false;});

const goalFixtures = new Map(); let goalHoldAction = '', goalRelease = null, goalThrow = '', goalMalformed = false, goalBadReply = '', goalReorderBinding = false, goalBlocked = false;
const goalReply = id => {const goal = goalFixtures.get(id);return {goal:goal ? copy(goal) : null,revision:goal?.revision || 0};};
async function goalFixture(p,thread) {
  assert(process.argv.includes('--goals-only'));
  assert(thread && !thread.parentThreadId && (p.action === 'goalInspect' || !thread.archived));
  let goal = goalFixtures.get(thread.id), turn = null;
  if (goalBadReply && p.action === 'goalSave') {
    if (goalBadReply === 'empty') return {goal:null,revision:0};
    const fake=copy(goal);
    if(goalBadReply!=='unchanged')fake.revision++;
    if(goalBadReply==='wrong-thread')fake.binding.rootThreadId='different-task';
    if(goalBadReply==='wrong-id')fake.id=randomUUID();
    if(goalBadReply==='wrong-values')fake.objective='Different objective';
    return {goal:fake,revision:fake.revision};
  }
  if (p.action === 'goalInspect') {
    if (goal) for (const attempt of goal.attempts) {
      const known = thread.turns.find(value => value.id === attempt.turnId);
      if (attempt.status === 'running' && known && ['completed','interrupted','failed'].includes(known.status)) {
        attempt.status = known.status;attempt.endedAt = Date.now();goal.revision++;goal.updatedAt = Date.now();
        if (goal.state === 'ready' && goal.attemptsRemaining === 0) goal.state = 'budgetLimited';
      }
    }
  } else {
    assert.equal(p.expectedRevision,goal?.revision || 0,'The UI must send the exact observed revision');
    if (goalThrow === p.action) {goalThrow = '';throw Error('Fixture action refused before dispatch');}
    if (p.action === 'goalSave') {
      assert(Number.isInteger(p.maxTurns) && p.maxTurns >= 1 && p.maxTurns <= 20);
      assert(typeof p.objective === 'string' && typeof p.completionCriteria === 'string');
      const prior = goal;
      assert.notEqual(prior?.state,'complete');
      goal = {...prior,id:prior?.id || randomUUID(),binding:prior?.binding || {rootThreadId:thread.id,ownerId:savedOwner,cwd:thread.cwd,model:fixtureModel,provider:'local',executionMode:'native'},revision:(prior?.revision || 0)+1,state:prior?.state === 'budgetLimited' ? 'paused' : prior?.state || 'ready',
        objective:p.objective,completionCriteria:p.completionCriteria,maxTurns:p.maxTurns,attempts:prior?.attempts || [],
        attemptsUsed:prior?.attemptsUsed || 0,attemptsRemaining:p.maxTurns-(prior?.attemptsUsed || 0),
        completionEvidence:prior?.completionEvidence || null,createdAt:prior?.createdAt || Date.now(),updatedAt:Date.now()};
      goalFixtures.set(thread.id,goal);
    } else {
      assert(goal);
      if (p.action === 'goalContinue') {
        assert.equal(goal.state,'ready');assert(goal.attemptsRemaining > 0);
        assert(['plan','build'].includes(p.mode));assert(['none','high'].includes(p.effort));
        turn = {id:'goal-turn-'+(++turnCounter),status:'inProgress',items:[{id:'goal-user-'+turnCounter,type:'userMessage',content:[{type:'text',text:'Continue saved goal: '+goal.objective}]}]};
        thread.turns.push(turn);emit('turn/started',{threadId:thread.id,turn:copy(turn)});
        goal.attempts.push({id:randomUUID(),claimedAt:Date.now(),contractRevision:goal.revision,contractHash:'a'.repeat(64),maxTurnsAtDispatch:goal.maxTurns,turnId:turn.id,status:'running',mode:p.mode,effort:p.effort,observedUsage:null});
        goal.attemptsUsed++;goal.attemptsRemaining--;
      } else if (p.action === 'goalPause') goal.state = 'paused';
      else if (p.action === 'goalResume') {assert.equal(goal.state,'paused');goal.state = 'ready';}
      else if (p.action === 'goalComplete') {assert(p.evidence.trim());goal.state = 'complete';goal.completionEvidence = p.evidence;}
      else throw Error('Unhandled Goal fixture action');
      goal.revision++;goal.updatedAt = Date.now();
    }
  }
  const result = {...goalReply(thread.id),...(turn ? {turn:copy(turn)} : {})};
  if (goalBlocked) {result.available=false;result.blockedReason='Fixture owner binding is available for inspection only.';}
  if (goalReorderBinding && result.goal) result.goal.binding=Object.fromEntries(Object.entries(result.goal.binding).reverse());
  if (goalMalformed && result.goal) result.goal.attemptsUsed = 999;
  if (goalHoldAction === p.action) {goalHoldAction = '';await new Promise(resolve => {goalRelease = resolve;});}
  if (goalThrow === p.action+'-after-start') {goalThrow = '';throw Error('The Goal reply was lost after dispatch; inspect before continuing');}
  return result;
}

const metadata = thread => ({model:fixtureModel,...copy(thread), turns: [], status:{type:thread.turns.some(turn=>turn.status==='inProgress')?'active':'idle'}});
let startupOutcome='cancelled',startupRelease=null,fixtureOwners=[],fixtureListWarning='';
await page.exposeBinding('codingNative', async (_, body) => {
  nativeActive++; maxNative = Math.max(maxNative, nativeActive); calls.push(copy(body));
  const outcomeRead = body.op === 'coding' && Object.keys(body).length === 2 && body.input?.action === 'mcpOutcomes' && Object.keys(body.input).length === 2 && typeof body.input.threadId === 'string' && /^[\w.-]{1,160}$/.test(body.input.threadId);
  const previewClear = body.op === 'codingFilePreview' && Object.keys(body).length === 2 && body.input?.action === 'clear' && Object.keys(body.input).length === 1;
  const terminalResultRead = body.op==='coding' && Object.keys(body).length===2 && body.input?.action==='terminalResults' && ['action,threadId','action,recordId,threadId'].includes(Object.keys(body.input).sort().join()) && typeof body.input.threadId==='string' && /^[A-Za-z0-9_.-]{1,160}$/.test(body.input.threadId) && (!Object.hasOwn(body.input,'recordId') || typeof body.input.recordId==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.input.recordId));
  const ordinary = !outcomeRead && !terminalResultRead && !previewClear && !(body.op === 'coding' && ['status', 'events', 'interrupt', 'interruptFamily', 'terminalStop', 'terminalSnapshot', 'terminalInput', 'terminalResize'].includes(body.input?.action)) && !(body.op === 'codingWorktrees' && body.input?.action === 'stop') && !(body.op === 'codingSchedules' && ['pause','stop'].includes(body.input?.action)) && !(body.op === 'codingGit' && body.input?.action === 'stop');
  if (ordinary) {ordinaryActive++; maxOrdinary = Math.max(maxOrdinary, ordinaryActive);}
  try {
    if(previewClear)return {cleared:true};
    if(body.op==='codingRecovery'){
      assert.deepEqual(body.input,{model:fixtureModel});
      if(startupOutcome==='hold'){await new Promise(resolve=>{startupRelease=resolve;});}
      if(startupOutcome==='error')throw Error('Current recovery inspection failed; retained startup unchanged.');
      if(startupOutcome==='existing')return {existingThreadId:'startup-continuation',message:'Saved continuation opened.'};
      if(startupOutcome==='cancelled')return {cancelled:true,message:'Continuation review cancelled; originals retained.'};
      if(startupOutcome==='corrupt')return {thread:{id:'unverified-copy',cwd:'/fixture/new',model:'wrong-model',modelProvider:'saleh_local'},executionMode:'native',copyId:'33333333-3333-4333-8333-333333333333'};
      const thread={id:'startup-continuation',name:'Recovered continuation',cwd:'/fixture/independent-startup',model:fixtureModel,modelProvider:'saleh_local',executionMode:'native',archived:false,turns:[]};threads.set(thread.id,thread);return {thread:copy(thread),executionMode:'native',copyId:'33333333-3333-4333-8333-333333333333'};
    }
    if(body.op==='codingStorage'){assert.deepEqual(body.input,{failed:true});return {cancelled:true,message:'Guest disk retained.'};}
    if(body.op==='codingGit'){
      const p=body.input;if(p.action==='stop'){assert.deepEqual(Object.keys(p).sort(),['action','requestId']);const state=gitStopOutcome;gitStopOutcome='cancelled';if(holdGitStop){holdGitStop=false;await new Promise(resolve=>{releaseGitStop=resolve;});}return {state:state==='mismatch'?'unknown':state,requestId:state==='mismatch'?'44444444-4444-4444-8444-444444444444':p.requestId,message:state==='unknown'?'Git process exit is unconfirmed; retained for inspection.':`Fixture Git Stop ${state}; inspect before another action.`};}
      const t=threads.get(p.threadId);assert(t);const snapshot=gitSnapshot(t.cwd);
      if(p.action==='inspect'){assert.deepEqual(Object.keys(p).sort(),['action','threadId']);if(failGitInspect){failGitInspect=false;throw Error('Git inspection temporarily unavailable');}const result={snapshot:copy(snapshot)};if(holdGit==='inspect'){holdGit='';await new Promise(resolve=>{releaseGit=resolve;});}return result;}
      if(['remoteInspect','publishBranch','createPR','inspectRemoteOutcome','acknowledgeRemoteOutcome'].includes(p.action)){
        assert(!t.parentThreadId && !t.source?.subAgent && t.canAcceptDirectInput!==false);
        const keys={remoteInspect:['snapshotId','remote','branch','base'],publishBranch:['snapshotId','remoteSnapshotId'],createPR:['snapshotId','remoteSnapshotId','title','body'],inspectRemoteOutcome:[],acknowledgeRemoteOutcome:['observationId']}[p.action];assert.deepEqual(Object.keys(p).sort(),['action','threadId','requestId',...keys].sort());
        if(holdGit===p.action){holdGit='';await new Promise(resolve=>{releaseGit=resolve;});}
        if(p.action==='remoteInspect'){
          assert.equal(p.snapshotId,snapshot.id);const remote=snapshot.remotes.find(row=>row.name===p.remote && row.supported);assert(remote);
          const draftKey=createHash('sha256').update(JSON.stringify([snapshot.repositoryId,7,21,remote.url,p.branch,p.base])).digest('hex');
          const view={id:randomUUID(),localSnapshotId:snapshot.id,repositoryId:snapshot.repositoryId,localHead:snapshot.head,remote:copy(remote),branch:p.branch,base:p.base,account:{id:7,login:'fixture'},repository:{id:21,fullName:'fixture/repo',canPush:true},oldOID:publishedRefs.get(snapshot.cwd+':'+p.branch)??null,baseOID:'b'.repeat(40),draftKey,expiresAt:Date.now()+120000};publishViews.set(view.id,view);return {remoteSnapshot:malformedRemote ? {...view,repositoryId:'WRONG'} : copy(view)};
        }
        if(p.action==='inspectRemoteOutcome')return {observation:{id:randomUUID(),requestId:p.requestId,headOID:snapshot.head,baseOID:'b'.repeat(40),matches:lostReply?[{id:67,number:12,url:inspectionBadURL?'https://evil.invalid/pull/12':'https://github.com/fixture/repo/pull/12',state:'open',draft:true,head:{repoId:21,fullName:'fixture/repo',ref:'fixture-branch',sha:snapshot.head},base:{repoId:21,fullName:'fixture/repo',ref:'main',sha:'b'.repeat(40)}}]:[],expiresAt:Date.now()+120000}};
        if(p.action==='acknowledgeRemoteOutcome'){const row=snapshot.remoteReceipts.find(row=>row.requestId===p.requestId);assert(row);row.remoteAcknowledged=true;return {acknowledged:true,requestId:p.requestId};}
        const view=publishViews.get(p.remoteSnapshotId);assert(view);assert.equal(view.localSnapshotId,p.snapshotId);assert.equal(view.repositoryId,snapshot.repositoryId);
        const state=gitOutcome;gitOutcome='completed';snapshot.remoteReceipts??=[];
        if(state==='unknown')snapshot.remoteReceipts.push({requestId:p.requestId,kind:p.action,state,message:'Uncertain fixture publication',remoteAcknowledged:false,remoteIntent:{repository:{id:21,fullName:'fixture/repo'}},remoteURL:p.action==='createPR' && !lostReply?'https://github.com/fixture/repo/pull/12':undefined,remoteNumber:p.action==='createPR' && !lostReply?12:undefined});
        if(state!=='completed')return {state,requestId:p.requestId,message:'Fixture '+state};
        if(p.action==='publishBranch')publishedRefs.set(snapshot.cwd+':'+view.branch,snapshot.head);
        const disposition=p.action==='publishBranch'?'published':prDisposition;
        return {state,requestId:p.requestId,message:'Fixture '+disposition,disposition,...(p.action==='createPR'?{url:'https://github.com/fixture/repo/pull/12',number:12}:{}),snapshot:copy(snapshot)};
      }
      assert(!t.parentThreadId&&!t.source?.subAgent&&t.canAcceptDirectInput!==false,'Child Git mutations forbidden');
      assert.match(p.requestId,/^[a-f0-9-]{36}$/);assert.equal(p.snapshotId,snapshot.id);
      const fields=['action','threadId','snapshotId','requestId',...(['stage','unstage'].includes(p.action)?['entryIds']:p.action==='commit'?['message','authorName','authorEmail']:['name'])];assert.deepEqual(Object.keys(p).sort(),fields.sort());
      if(holdGit===p.action){holdGit='';await new Promise(resolve=>{releaseGit=resolve;});}
      const state=gitOutcome;gitOutcome='completed';if(state!=='completed')return {state,requestId:p.requestId,message:`Fixture ${state}: inspect before retry`};
      if(['stage','unstage'].includes(p.action)){assert(p.entryIds.length);for(const id of p.entryIds){const entry=snapshot.entries.find(e=>e.id===id);assert(entry);if(p.action==='stage'){entry.index='M';entry.worktree=' ';entry.canStage=false;entry.canUnstage=true;}else{entry.index=' ';entry.worktree='M';entry.canStage=true;entry.canUnstage=false;}}}
      if(p.action==='commit')for(const entry of snapshot.entries){entry.index=' ';entry.canUnstage=false;}
      if(p.action==='switchBranch'){const branch=snapshot.branches.find(branch=>branch.name===p.name);assert(branch&&!branch.current&&!branch.checkedOut);snapshot.branch=branch.name;snapshot.head=branch.head;for(const entry of snapshot.branches)entry.current=entry===branch;}
      snapshot.id=`33333333-3333-4333-8333-${String(++gitRevision).padStart(12,'0')}`;
      const result={state,requestId:p.requestId,message:`Fixture ${p.action} completed`,snapshot:copy(snapshot)};if(gitNoSnapshot){gitNoSnapshot=false;delete result.snapshot;}return result;
    }
    if (body.op === 'codingChooseFolder') {if(cancelFolder){cancelFolder=false;return {cancelled:true};}return {cwd: '/fixture/project'};}
    if (body.op === 'codingConfigureProvider') return {message: 'Cloud setup required.'};
    if (body.op === 'codingSchedules') {
      const p=body.input, record=schedules.find(value=>value.id===p.id);
      if(p.action==='list'){assert.deepEqual(p,{action:'list'});return scheduleResult();}
      if(['stop','pause'].includes(p.action)){assert.deepEqual(Object.keys(p).sort(),p.action==='stop'?['action']:['action','id']);for(const value of schedules)if(p.action==='stop'||value.id===p.id){value.active=false;value.status='paused';value.nextRunAt=null;}scheduleRunningId=null;return scheduleResult();}
      if(holdSchedule){holdSchedule=false;await new Promise(resolve=>{releaseSchedule=resolve;});}
      if(cancelSchedule){cancelSchedule=false;return {cancelled:true};}if(failSchedule){failSchedule=false;throw Error('Scheduled project busy; run was not started');}
      if(p.action==='save'){
        assert.deepEqual(Object.keys(p).sort(),['action','cadence','cwd','effort','executionMode','id','model','name','prompt']);assert(['none','high'].includes(p.effort));assert(['native','vm'].includes(p.executionMode));
        const value={id:p.id||'22222222-2222-4222-8222-222222222222',name:p.name,cwd:p.cwd,prompt:p.prompt,effort:p.effort,model:p.model,executionMode:p.executionMode,cadence:copy(p.cadence),active:true,status:'active',nextRunAt:Date.now()+60000,runs:record?.runs||[]};if(record)Object.assign(record,value);else schedules.push(value);return {...scheduleResult(),schedule:copy(value)};
      }
      assert.deepEqual(Object.keys(p).sort(),['action','id']);assert(record);
      if(p.action==='resume'){record.active=true;record.status='active';record.nextRunAt=Date.now()+60000;}
      else if(p.action==='run'){record.runs.unshift({id:'manual-run',scheduledFor:Date.now(),startedAt:Date.now(),finishedAt:Date.now(),status:'completed',threadId:'saved',message:'Manual result',manual:true});}
      else if(p.action==='delete'){assert(!record.active&&scheduleRunningId!==p.id);schedules.splice(schedules.indexOf(record),1);}
      else throw Error(`Unexpected schedule action ${p.action}`);
      return {...scheduleResult(),schedule:copy(record)};
    }
    if (body.op === 'codingWorktrees') {
      const p=body.input;
      if(p.action==='list'){assert.deepEqual(Object.keys(p),['action']);if(failWorktreeList){failWorktreeList=false;throw Error('Managed list unavailable');}return {worktrees:copy(worktrees),handoffs:copy(handoffs),busy:worktreeBusy,readOnly:recoveryCopyReadOnly,recoveryCopyAvailable:recoveryCopyReadOnly,...(worktreeOpenAvailable===undefined?{}:{openAvailable:worktreeOpenAvailable}),...(worktreeCreateAvailable===undefined?{}:{createAvailable:worktreeCreateAvailable??!recoveryCopyReadOnly}),...(worktreeHandoffAvailable===undefined?{}:{handoffAvailable:worktreeHandoffAvailable})};}
      if(p.action==='stop'){assert.deepEqual(p,{action:'stop'});worktreeCancelled=true;worktreeBusy=false;releaseWorktreeCreate?.();if(holdWorktreeStop){holdWorktreeStop=false;await new Promise(resolve=>{releaseWorktreeStop=resolve;});}return {message:'Worktree creation stop requested.'};}
      if(p.action==='create'){
        assert.deepEqual(Object.keys(p).sort(),p.copyChanges===true?['action','copyChanges','cwd','ref']:['action','cwd','ref']);if(cancelWorktreeCreate){cancelWorktreeCreate=false;return {cancelled:true};}if(failWorktreeCreate){failWorktreeCreate=false;throw Error('Checkout outcome uncertain; refresh the managed list.');}
        worktreeBusy=true;worktreeCancelled=false;if(holdWorktreeCreate){holdWorktreeCreate=false;await new Promise(resolve=>{releaseWorktreeCreate=resolve;});}worktreeBusy=false;if(worktreeCancelled)return {cancelled:true};
        const record={id:`managed-${worktrees.length}`,source:p.cwd,commit:'e'.repeat(40),cwd:`/fixture/managed/${worktrees.length}`,createdAt:4,state:'ready',message:''};worktrees.push(record);return {worktree:copy(record)};
      }
      if(['archive','restore'].includes(p.action)){
        assert.deepEqual(Object.keys(p).sort(),['action','id']);const record=worktrees.find(value=>value.id===p.id);assert(record);assert.equal(record.state,p.action==='archive'?'ready':'archived');
        const outcome=worktreeLifecycleOutcome;worktreeLifecycleOutcome='';
        if(holdWorktreeLifecycle){holdWorktreeLifecycle=false;await new Promise(resolve=>{releaseWorktreeLifecycle=resolve;});}
        if(outcome==='cancelled')return {cancelled:true};if(outcome==='failed')throw Error('Restore destination is occupied. No files were overwritten.');
        if(outcome==='stale-reply')return {worktree:{...copy(record),state:'archived'}};
        record.state=outcome==='unknown'?'needs-inspection':p.action==='archive'?'archived':'ready';record.message=outcome==='unknown'?'Worktree outcome unconfirmed; retained for inspection.':'';if(p.action==='archive')record.archivedAt=Date.now();else if(record.state==='ready')gitSnapshot(record.cwd).repositoryId+='-restored';return {worktree:copy(record)};
      }
      if(p.action==='recoverCopy'){
        assert.deepEqual(Object.keys(p).sort(),['action','id']);const retained=handoffs.find(h=>h.id===p.id);assert(retained);const outcome=recoveryCopyOutcome;recoveryCopyOutcome='';
        if(holdRecovery){holdRecovery=false;await new Promise(resolve=>releaseRecovery=resolve);}
        if(outcome==='cancelled')return {cancelled:true};if(outcome==='failed')throw Error('Copy donor changed; new output retained for inspection');
        const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',base='/fixture/Recovered Projects/'+id;
        const result={copy:{id,operation:'handoff-original-copy',handoffId:p.id,rootThreadId:retained.rootThreadId,source:retained.source,target:base+'/project',head:'a'.repeat(40),indexTree:'b'.repeat(40),files:3,bytes:10,omittedCount:0,receiptPath:base+'/receipt.json',independent:true,originalRecoveryComplete:false}};
        recoveryCopyCorrupt?.(result);return result;
      }
      if(p.action==='recoverHandoff'){
        assert.deepEqual(Object.keys(p).sort(),['action','id','mode']);assert(['restore','finish'].includes(p.mode));
        const retained=handoffs.find(h=>h.id===p.id);assert(retained,'Recovery uses retained handoff ID');const h=copy(retained),target=p.mode==='restore'?h.source:h.destination,outcome=recoveryOutcome;recoveryOutcome='';
        if(holdRecovery){holdRecovery=false;await new Promise(resolve=>{releaseRecovery=resolve;});}
        if(outcome==='cancelled')return {cancelled:true,message:'Recovery review cancelled'};
        if(outcome==='refused')throw Error('Same-boot writer exit is unconfirmed; recovery retained.');
        const family={...copy(recoveryFamily),cwd:target,members:recoveryFamily.members.map(m=>({...copy(m),cwd:target}))};
        const result={handoff:{id:h.id,rootThreadId:h.rootThreadId,source:h.source,destination:h.destination,mode:p.mode,target,state:'complete',recoveryDirectory:h.recoveryDirectory},family};
        if(recoveryCorrupt){const corrupt=recoveryCorrupt;recoveryCorrupt=null;corrupt(result);return result;}
        if(outcome!=='late'){
          for(const member of family.members)Object.assign(threads.get(member.id),member);
          handoffs.splice(handoffs.findIndex(h=>h.id===p.id),1);const record=worktrees.find(r=>r.id===h.worktreeId);record.state='ready';
        }
        return result;
      }
      if(p.action==='handoff'){
        assert.deepEqual(Object.keys(p).sort(),['action','id','threadId']);const record=worktrees.find(r=>r.id===p.id),root=threads.get(p.threadId),source=root.cwd,destination=source===record.source?record.cwd:record.source,outcome=handoffOutcome;handoffOutcome='';
        if(outcome==='cancelled')return {cancelled:true};
        const recovery={id:'77777777-7777-4777-8777-777777777777',worktreeId:record.id,rootThreadId:root.id,source,destination,phase:'git-files-publishing',state:'needs-inspection',message:'Recovery retained; inspect before continuing.',recoveryDirectory:'/fixture/recovery/<img src=x onerror=alert(1)>'};
        if(['failed','late'].includes(outcome)){handoffs.push(recovery);record.state='needs-inspection';}
        if(holdHandoff){holdHandoff=false;await new Promise(resolve=>{releaseHandoff=resolve;});}
        if(outcome==='failed')throw Error('Handoff retained for inspection.');
        const members=subtree(root.id).map(t=>({id:t.id,cwd:destination,parentThreadId:t.parentThreadId??null,archived:t.archived,modelProvider:t.modelProvider}));
        if(outcome!=='late')for(const member of members)threads.get(member.id).cwd=destination;
        return {handoff:{id:recovery.id,rootThreadId:root.id,source,destination,state:'complete',recoveryDirectory:recovery.recoveryDirectory},family:{rootThreadId:root.id,cwd:destination,members}};
      }
      if(p.action==='open'){
        assert(['local','cloud'].includes(p.provider));assert(['native','vm'].includes(p.executionMode));assert.deepEqual(Object.keys(p).sort(),p.provider==='local'?['action','executionMode','id','model','provider']:['action','executionMode','id','provider']);if(p.provider==='local')assert.equal(p.model,fixtureModel);if(cancelWorktreeOpen){cancelWorktreeOpen=false;return {cancelled:true};}if(failWorktreeOpen){failWorktreeOpen=false;throw Error('Managed checkout identity changed');}
        if(holdWorktreeOpen){holdWorktreeOpen=false;await new Promise(resolve=>{releaseWorktreeOpen=resolve;});}
        const record=worktrees.find(value=>value.id===p.id);assert.equal(record.state,'ready');const thread={id:`managed-chat-${++counter}`,cwd:record.cwd,name:'New chat',model:p.provider==='local'?p.model:'fixture-cloud-model',modelProvider:`saleh_${p.provider}`,executionMode:p.executionMode,turns:[],archived:false};threads.set(thread.id,thread);return {thread:copy(thread)};
      }
      throw Error(`Unexpected worktree action ${p.action}`);
    }
    assert.equal(body.op, 'coding');
    const p = body.input, thread = threads.get(p.threadId);
    if (p.action.startsWith('goal')) return await goalFixture(p,thread);
    switch (p.action) {
      case 'mcpOutcomes': {if(holdMCP){holdMCP=false;await new Promise(resolve=>{releaseMCP=resolve;});}if(mcpOutcomeError)throw Error(mcpOutcomeError);if(mcpOutcomeFixtures.has(p.threadId))return copy(mcpOutcomeFixtures.get(p.threadId));throw Error('Unhandled fixture action mcpOutcomes');}
      case 'terminalResults': {
        assert.deepEqual(Object.keys(p).sort(),p.recordId?['action','recordId','threadId']:['action','threadId']);
        if(savedCommandError)throw Error(savedCommandError);
        const records=copy(savedCommandRows.get(p.threadId)||[]),result={ownerId:savedOwner,threadId:p.threadId,omittedCount:3};
        if(p.recordId){result.record=records.find(row=>row.recordId===p.recordId);assert(result.record);}
        else result.records=records.map(row=>({recordId:row.recordId,createdAt:row.createdAt,endedAt:row.endedAt,state:row.state,exitCode:row.exitCode,stopRequested:row.stopRequested,outputTruncated:row.outputTruncated,observationComplete:row.observationComplete,commandPreview:row.command.slice(0,30),commandTruncated:row.command.length>30}));
        if(savedCommandMalformed==='owner')result.ownerId='not-an-owner';
        if(savedCommandMalformed==='large'&&result.record)result.record.output='x'.repeat(262145);
        if(savedCommandMalformed==='unicode'&&result.record)result.record.output='\ud800';
        if(savedCommandMalformed==='state'&&result.record){result.record.state='unconfirmed';result.record.exitCode=0;}
        if(p.recordId&&holdSavedCommand===p.threadId){holdSavedCommand='';await new Promise(resolve=>{releaseSavedCommand=resolve;});}
        return result;
      }
      case 'status': {const wasActive=terminalActive;if(finishTerminalAtStatus){finishTerminalAtStatus=false;terminalActive=false;emit('coding/terminal/completed',{threadId:terminalThreadId,processId:terminalProcessId,exitCode:0});} const result = {available: true, running: true, goals:process.argv.includes('--goals-only'), owners:copy(fixtureOwners), workspaceSync: copy([...workspaceSync.values()]), workspaceSyncCursor: sequence, activeTurns: [...threads.values()].flatMap(t => t.turns.filter(turn => turn.status === 'inProgress').map(turn => ({threadId:t.id,turnId:turn.id,rootThreadId:rootId(t.id),parentThreadId:t.parentThreadId}))), stoppingFamilies:[...familyStopping], model: 'Local Qwen', provider: 'local', terminals: [...(wasActive ? [{threadId: terminalThreadId, processId: terminalProcessId}] : []), ...(interactive ? [{...interactive,screen:undefined}] : [])], providers: [{id: 'local', name: 'Local Qwen', available: true}, ...(allowCloud ? [{id:'cloud',name:'Fixture cloud',available:true}] : [])], message: 'Local engine available'};if(holdStatus){holdStatus=false;await new Promise(resolve=>{releaseStatus=resolve;});}return result;}
      case 'list': return {threads: [...threads.values()].filter(t => !hideAllThreads && !t.parentThreadId && t.archived === !!p.archived && (!omitEmpty || t.id === 'saved' || t.turns.length) && !(handoffReadBlocked && handoffs.some(h=>h.rootThreadId===t.id))).map(metadata), nextCursor: null, ...(fixtureListWarning ? {historyIncomplete:true,historyWarning:fixtureListWarning} : {}), ...(handoffReadBlocked ? {historyIncomplete:true,historyWarning:'Some worktree handoffs remain incomplete. Their history is unavailable; verified saved chats are listed.'} : {})};
      case 'historyPage': {assert(process.argv.includes('--delegated-receipts-only'));assert(thread);return {threadId:thread.id,pageCursor:p.cursor??null,nextCursor:null,truncated:false,turn:copy(thread.turns.at(-1)??null)};}
      case 'family': {if(!thread)throw new Error('Thread not found');const root=rootId(thread.id), all=subtree(root).filter(t=>t.id!==root), offset=Number(p.cursor||0);const result={rootThreadId:root,root:metadata(threads.get(root)),threads:all.slice(offset,offset+1).map(metadata),nextCursor:repeatFamilyCursor?'1':offset+1<all.length?String(offset+1):null,stopping:[...familyStopping].some(id=>rootId(id)===root),stoppingTargets:[...familyStopping].filter(id=>rootId(id)===root)};if(p.threadId===heldFamily){heldFamily='';await new Promise(resolve=>{releaseFamily=resolve;});}return result;}
      case 'interruptFamily': {
        if(failFamilyStop){failFamilyStop=false;if(holdInterruptReply){holdInterruptReply=false;await new Promise(resolve=>{releaseInterruptReply=resolve;});}throw Error('Fixture parent Stop failed; owner remains retained.');}
        familyStopping.add(thread.id);emit('coding/family/updated',{threadId:rootId(thread.id),rootThreadId:rootId(thread.id)});
        if(subtree(thread.id).length===1){const turn=thread.turns.findLast(value=>value.status==='inProgress'),finish=()=>{if(turn){turn.status='interrupted';emit('turn/completed',{threadId:thread.id,turn:copy(turn)});}if(terminalActive&&terminalThreadId===thread.id){terminalActive=false;emit('coding/terminal/completed',{threadId:thread.id,processId:terminalProcessId,exitCode:null,error:'Stopped'});}if(interactive?.threadId===thread.id&&['running','stopping'].includes(interactive.state)){Object.assign(interactive,{state:'stopping',revision:interactive.revision+1,inputGranted:false});emit('coding/terminal/updated',{...interactive,screen:undefined});Object.assign(interactive,{state:'exited',exitCode:0,revision:interactive.revision+1,inputGranted:false,screen:'SHELL_EXITED'});emit('coding/terminal/completed',{...interactive,screen:undefined});}if(!subtree(thread.id).some(t=>t.turns.some(v=>v.status==='inProgress')))familyStopping.delete(thread.id);emit('coding/family/updated',{threadId:rootId(thread.id),rootThreadId:rootId(thread.id)});};if(deferInterruptCompletion){deferInterruptCompletion=false;finishInterrupt=finish;}else finish();}
        if(holdInterruptReply){holdInterruptReply=false;await new Promise(resolve=>{releaseInterruptReply=resolve;});}
        return {rootThreadId:rootId(thread.id),targetThreadId:thread.id,state:'stopping',message:'Stopping fixture family'};
      }
      case 'start': {assert.equal(p.provider, 'local'); if(rejectManagedStart && p.cwd.startsWith('/fixture/managed/'))throw Error('Managed checkout identity changed'); if(cancelStart){cancelStart=false;return {cancelled:true};} if(failStart){failStart=false;throw new Error('Fixture folder unavailable');} const t = {id: `new-${++counter}`, cwd: p.cwd, model: p.model, name: 'New chat', turns: [], archived: false}; threads.set(t.id, t); return {thread: copy(t)};}
      case 'read': {if(completionReadModes.get(p.threadId)==='failed')throw Error('Completion history temporarily unavailable');if(handoffReadBlocked&&handoffs.some(h=>h.rootThreadId===p.threadId)){if(handoffReadFailure==='missing')return {cursor:sequence};if(handoffReadFailure==='mismatch')return {thread:{...copy(thread),id:'different-history-root'},cursor:sequence};throw Error('This chat has a retained worktree handoff. Inspect its original recovery; no work was replayed.');}if(failReadOnce){failReadOnce=false;throw new Error('History temporarily unavailable');} if(!thread)throw new Error('Thread not found'); const result={thread: {model:fixtureModel,...copy(thread)}, cursor: sequence, historyWarning: readHistoryWarning, pendingMaterialization: omitEmpty && !thread.turns.length && thread.name === 'New chat'}; if(completionReadModes.get(p.threadId)==='incomplete'){result.historyTruncated=true;result.thread.turns=[];}if(completionReadModes.get(p.threadId)==='warning')result.historyWarning='Completion history is incomplete';if(p.threadId===heldReadThreadId){heldReadThreadId='';await new Promise(resolve=>{releaseRead=resolve;});} return result;}
      case 'send': {
        if (failSend) {failSend = false; throw new Error('Fixture provider unavailable');}
        const turn = {id: `turn-${++turnCounter}`, status: 'inProgress', items: [{id: `user-${turnCounter}`, type: 'userMessage', content: [{type: 'text', text: p.text}]}]};
        if(holdSend)turn.items.push({id:'send-race-answer',type:'agentMessage',text:''});
        thread.turns.push(turn); emit('turn/started', {threadId: thread.id, turn: copy(turn)}); const result={turn:copy(turn)}; if(holdSend){holdSend=false;await new Promise(resolve=>{releaseSend=resolve;});} return result;
      }
      case 'steer': assert.equal(p.turnId, thread.turns.at(-1).id); return {turnId: p.turnId};
      case 'interrupt': {const turn = thread.turns.at(-1); assert.equal(p.turnId, turn.id); const finish=()=>{turn.status = 'interrupted'; emit('turn/completed', {threadId: thread.id, turn: copy(turn)});}; if(deferInterruptCompletion){deferInterruptCompletion=false;finishInterrupt=finish;}else finish(); if(holdInterruptReply){holdInterruptReply=false;await new Promise(resolve=>{releaseInterruptReply=resolve;});}return {};}
      case 'rename': if(failRename){failRename=false;throw new Error('Fixture rename unavailable');} thread.name = p.name; return {};
      case 'archive': thread.archived = true; return {};
      case 'unarchive': thread.archived = false; return {};
      case 'fork': {const t = {...copy(thread), id: `new-${++counter}`, name: 'Forked chat', archived: false}; threads.set(t.id, t); return {thread: t};}
      case 'review': {const turn = {id: `turn-${++turnCounter}`, status: 'inProgress', items: []}; thread.turns.push(turn); const result={turn: copy(turn), reviewThreadId: thread.id};if(holdReview){holdReview=false;emit('turn/started',{threadId:thread.id,turn:copy(turn)});await new Promise(resolve=>{releaseReview=resolve;});}return result;}
      case 'events': {
        if (eventBusy) {eventBusy = false; throw new Error('Native tools are busy; try again.');}
        const result = {events: copy(events.filter(e => e.sequence > p.after)), cursor: sequence, gap, approvals: copy(approvals),...(process.argv.some(arg=>['--polish-layout-only','--goals-only'].includes(arg))?{questions:[]}:{} )}; gap = false;if(holdEvents){holdEvents=false;await new Promise(resolve=>{releaseEvents=resolve;});}return result;
      }
      case 'approval': {const i = approvals.findIndex(a => a.id === p.id); assert(i >= 0); if(p.id === heldApproval) await new Promise(resolve => {releaseApproval=resolve;}); const currentIndex=approvals.findIndex(a=>a.id===p.id);if(currentIndex>=0)approvals.splice(currentIndex, 1); return {message: p.decision === 'accept' ? 'Approved once; execution outcome pending.' : 'Declined.'};}
      case 'git': return {branch: 'fixture-branch', status: ' M app.js\n?? new.txt', diff: 'diff --git a/app.js b/app.js\n+<img src=x onerror=alert(1)>', truncated: true};
      case 'terminalStart': {if(p.mode==='pty'){assert.deepEqual(Object.keys(p).sort(),['action','cols','command','mode','rows','threadId']);assert.equal(p.command,'');assert.equal(p.cols,100);assert.equal(p.rows,30);if(cancelInteractive){cancelInteractive=false;return {cancelled:true};}interactive={processId:'pty-fixture',threadId:p.threadId,cwd:thread.cwd,mode:'pty',state:'running',cols:100,rows:30,revision:1,screen:'INTERACTIVE_READY\r\n$ ',scrollback:500,inputGranted:true};return copy(interactive);}terminalActive = true; terminalThreadId=p.threadId; const processId=terminalProcessId=holdTerminalStart?'terminal-race':'terminal-1'; if(holdTerminalStart){holdTerminalStart=false;await new Promise(resolve=>{releaseTerminalStart=resolve;});} return {processId};}
      case 'terminalSnapshot': {assert.equal(p.processId,interactive.processId);const frame=copy(interactive);if(p.after===frame.revision)delete frame.screen;return frame;}
      case 'terminalAttach': {assert.equal(p.processId,interactive.processId);if(cancelAttach){cancelAttach=false;return {cancelled:true};}interactive.inputGranted=true;return copy(interactive);}
      case 'terminalInput': {assert.equal(p.processId,interactive.processId);assert.equal(interactive.inputGranted,true);const bytes=Buffer.from(p.dataBase64,'base64');assert(bytes.length>0&&bytes.length<=16000);return {};}
      case 'terminalResize': {assert.equal(p.processId,interactive.processId);assert.equal(interactive.inputGranted,true);Object.assign(interactive,{cols:p.cols,rows:p.rows,revision:interactive.revision+1});return {};}
      case 'terminalWrite': return {message: 'Input sent'};
      case 'terminalStop': if(interactive?.processId===p.processId){Object.assign(interactive,{state:'exited',exitCode:0,revision:interactive.revision+1,inputGranted:false,screen:'SHELL_EXITED'});emit('coding/terminal/completed',{...interactive,screen:undefined});return {};}terminalActive = false; emit('coding/terminal/completed', {threadId: terminalThreadId, processId: p.processId, exitCode: null, error: 'Stopped'}); return {};
      default: throw new Error(`Unhandled fixture action ${p.action}`);
    }
  } finally {nativeActive--; if(ordinary)ordinaryActive--;}
});
await context.addInitScript(fixtureDefault => {window.webkit = {messageHandlers: {tools: {postMessage: body => window.codingNative(body).then(result=>{if(body.input?.action==='interruptFamily')window.lastInterruptReply=body.input.threadId;if(body.input?.action==='events')window.lastEventsCursor=result.cursor;if(body.input?.action==='terminalResults')window.lastTerminalResultId=result.record?.recordId||'';return result;})}}}; if(!sessionStorage.getItem('ordinary-fixture-seeded')){localStorage.setItem('qwen-local-chats-v1','LEGACY_UNTOUCHED');localStorage.setItem('saleh-local-model-default-v1',fixtureDefault);sessionStorage.setItem('ordinary-fixture-seeded','1');} const seed=sessionStorage.getItem('coding-fixture-preferences');if(seed){localStorage.setItem('qwen-coding-ui-v1',seed);sessionStorage.removeItem('coding-fixture-preferences');}},process.argv.some(arg=>['--polish-layout-only','--schedule-mode-only'].includes(arg))?'local/saleh-qwen38-uncensored-8bit':fixtureModel);
const text = async (selector, expected) => {try{await page.waitForFunction(({selector, expected}) => document.querySelector(selector)?.textContent.includes(expected), {selector, expected}, {timeout: 6000});}catch(error){console.error('FIXTURE TEXT MISMATCH',JSON.stringify({selector,expected,state:await page.evaluate(selector=>({actual:document.querySelector(selector)?.textContent,notice:document.querySelector('#notice')?.textContent,worktreeNotice:document.querySelector('#worktrees-notice')?.textContent,title:document.querySelector('#thread-title')?.textContent,sendDisabled:document.querySelector('#send')?.disabled}),selector),recentCalls:calls.slice(-12)}));throw error;}};
const countAction = action => calls.filter(c => c.input?.action === action).length;
const until = async predicate => {for(let i=0;i<120&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,50));assert(predicate(),'Fixture condition timed out');};

async function checkDeepResponsePresentation() {
  readHistoryWarning='';await page.waitForFunction(()=>!document.querySelector('#prompt').disabled&&!document.querySelector('#new-project').disabled);
  const before=calls.length,draft='KEEP_DEEP_PRESENTATION_DRAFT',id='deep-presentation';
  await page.locator('#prompt').fill(draft);await page.locator('#prompt').focus();
  const maps=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return Object.fromEntries(['drafts','attachmentDrafts','terminalDrafts','gitDrafts','worktreeGitDrafts','scheduleDrafts','efforts','taskModes','followupEdits'].map(k=>[k,p[k]]));});
  const retained=await maps(),blank={id:'deep-separator',type:'agentMessage',text:'\n\n',phase:null},turn={id,status:'inProgress',items:[{id:'deep-user',type:'userMessage',content:[{type:'text',text:'Use one read-only command, then answer.'}]},blank]};
  threads.get('saved').turns.push(turn);emit('turn/started',{threadId:'saved',turn:copy(turn)});
  await text('[data-turn-id="'+id+'"] .turn-outcome','Working…');
  const section=page.locator('[data-turn-id="'+id+'"]');assert.equal(await section.locator('article.assistant').count(),0,'A streaming Deep separator must not become an empty Assistant card');
  blank.truncated=true;emit('item/completed',{threadId:'saved',turnId:id,item:copy(blank)});await text('[data-turn-id="'+id+'"]','Live output truncated.');assert.equal(await section.locator('article.assistant').count(),0,'Suppressing a separator keeps its truncation warning visible');
  const command={id:'deep-command',type:'commandExecution',command:'printf DEEP_UI_ONLY',cwd:'/fixture/older',status:'completed',aggregatedOutput:'DEEP_UI_ONLY',exitCode:0,commandActions:[]};
  turn.items.push(command);emit('item/completed',{threadId:'saved',turnId:id,item:copy(command)});await text('[data-turn-id="'+id+'"]','Command · exited 0');
  const answer={id:'deep-answer',type:'agentMessage',text:'\n\n    DEEP_INDENT\n\n```python\n    print("م🌊")\n\n```\n',phase:null};turn.items.push(answer);turn.status='completed';const original=copy(turn);
  emit('turn/completed',{threadId:'saved',turn:copy(turn)});await text('[data-turn-id="'+id+'"] .turn-outcome','Turn finished');
  assert.equal(await section.locator('article.assistant').count(),1);assert.equal(await section.locator('[data-item-id="deep-separator"]').count(),0);
  await section.locator('.message-copy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),answer.text,'Copy message preserves every original space, newline and Unicode character');
  await section.locator('.copy-code').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'    print("م🌊")\n\n');
  const solo={id:'deep-whitespace-only',status:'completed',items:[{id:'deep-user-blank',type:'userMessage',content:[{type:'text',text:'\n\n'}]},{id:'deep-blank-final',type:'agentMessage',text:'  \n\t',phase:null}]};threads.get('saved').turns.push(solo);emit('turn/started',{threadId:'saved',turn:copy(solo)});
  await text('[data-turn-id="'+solo.id+'"]','The model returned only whitespace.');const empty=page.locator('[data-turn-id="'+solo.id+'"]');assert.equal(await empty.locator('article.user').count(),1);await empty.locator('.message-copy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),solo.items[1].text);
  for(const status of ['completed','interrupted','failed']){
    const end={id:'deep-empty-'+status,status,items:[copy(command),{id:'commentary-'+status,type:'agentMessage',phase:'commentary',text:'The command returned.'},{id:'blank-'+status,type:'agentMessage',phase:'final_answer',text:'\n\n'}]};threads.get('saved').turns.push(end);emit('turn/started',{threadId:'saved',turn:copy(end)});await text('[data-turn-id="'+end.id+'"]','The model returned only whitespace.');const row=page.locator('[data-turn-id="'+end.id+'"]');assert.equal(await row.locator('article.assistant').count(),2,'A terminal empty final must stay visible even after commentary and a tool');await row.locator('[data-item-id="blank-'+status+'"] .message-copy').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'\n\n');
  }
  assert.deepEqual(turn,original);assert.deepEqual(await maps(),retained);assert.equal(await page.locator('#prompt').inputValue(),draft);
  await page.reload();await text('[data-turn-id="'+id+'"]','DEEP_INDENT');await text('[data-turn-id="'+solo.id+'"]','The model returned only whitespace.');assert.equal(await section.locator('article.assistant').count(),1);assert.deepEqual(await maps(),retained);assert.equal(await page.locator('#prompt').inputValue(),draft);
  const readsOnly=new Set(['coding/status','coding/events','coding/list','coding/read','coding/family','coding/mcpOutcomes','coding/terminalResults','codingWorktrees/list','codingSchedules/list','codingFilePreview/clear','codingSkills/clear']);assert(calls.slice(before).every(c=>readsOnly.has(c.op+'/'+c.input?.action)),'Presentation must never dispatch a model turn, tool or mutation');assert.deepEqual(errors,[]);
}

async function checkCodingParity() {
  const checks=[],check=async(name,run)=>{await run();checks.push(name);};
  const selected=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId);
  const maps=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return Object.fromEntries(['drafts','attachmentDrafts','terminalDrafts','gitDrafts','worktreeGitDrafts','scheduleDrafts','efforts','taskModes','followupEdits'].map(key=>[key,p[key]]));});
  readHistoryWarning='';
  const inherited={id:'parity-inherited',status:'inheritedStopped',items:[{id:'inherited-user',type:'userMessage',content:[{type:'text',text:'PARENT_CONTEXT_UNCHANGED'},{type:'localImage',image:{sha256:'a'.repeat(64),width:1,height:1,bytes:100}}]},{id:'inherited-answer',type:'agentMessage',text:'PARENT_REPORT_NOT_CHILD_OUTCOME'},{id:'inherited-command',type:'commandExecution',cwd:'/fixture/older',command:'false',status:'failed',exitCode:1,aggregatedOutput:'PARENT_FAILURE'}]};
  const child={id:'parity-child',parentThreadId:'saved',rootThreadId:'saved',canAcceptDirectInput:false,name:'Parity reader <img src=x>',cwd:'/fixture/older',model:fixtureModel,archived:false,turns:[inherited]};
  const parentTurn={id:'parity-parent',status:'completed',items:[{id:'parent-report',type:'agentMessage',text:'The model claims all tests passed.'}]};
  threads.get('saved').turns=[parentTurn];threads.set(child.id,child);
  threads.set('parity-grandchild',{...copy(child),id:'parity-grandchild',parentThreadId:child.id,name:'Nested parity reader',turns:[]});
  await page.reload();await text('#thread-title','Saved chat');await page.waitForFunction(()=>!document.querySelector('#prompt').disabled);
  await page.locator('#prompt').fill('KEEP_PARITY_PARENT_DRAFT مرحبا');
  await page.locator('#message-files').setInputFiles({name:'parity-keep.txt',mimeType:'text/plain',buffer:Buffer.from('KEEP_PARITY_ATTACHMENT')});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).attachmentDrafts?.saved?.length===1);
  const kept=await maps(),before=calls.length,originalInherited=copy(inherited);
  const openChild=async()=>{await page.locator('#family-list [data-thread-id="parity-child"]').click();await text('#thread-title',child.name);await page.waitForFunction(()=>!document.querySelector('#return-to-parent').disabled);};
  await openChild();
  await check('Child replaces disabled composer with read-only result and verified parent action',async()=>{
    assert(await page.locator('#child-result').isVisible());assert(await page.locator('#composer').isHidden());assert(await page.locator('#task-mode-hint').isHidden());assert(await page.locator('#model-status').isHidden());
    assert(await page.locator('#prompt').isDisabled());assert(await page.locator('#send').isDisabled());assert(await page.locator('#return-to-parent').isVisible());
  });
  await check('Inherited-only history is not the agent outcome',async()=>{
    await text('#child-result-status','No agent result recorded');assert(!(await page.locator('#child-result').innerText()).includes('PARENT_REPORT'));assert(await page.locator('#child-result-report').isHidden());
    assert.match(await page.locator('#family-list [data-thread-id="parity-child"]').getAttribute('aria-description'),/No agent result yet/);
  });
  await check('Inherited context starts collapsed and explicitly labels its provenance',async()=>{
    assert.equal(await page.locator('.inherited-context').count(),1);assert.equal(await page.locator('.inherited-context').evaluate(node=>node.open),false);
    await text('.inherited-context>summary','Inherited parent context · 1 turn');assert(await page.getByText('PARENT_CONTEXT_UNCHANGED',{exact:true}).isHidden());
    assert.equal(await page.locator('.inherited-context .verification-summary').count(),0);
  });
  await page.locator('.inherited-context>summary').click();
  await check('Opening inherited context preserves raw content without recasting the stop marker',async()=>{
    assert(await page.getByText('PARENT_CONTEXT_UNCHANGED',{exact:true}).isVisible());await text('.inherited-outcome','Inherited parent context');
    await text('.inherited-context .message-label','inherited parent context');assert.deepEqual(inherited,originalInherited);
  });
  await check('Inherited attachments retain their normal guarded image view without a fake history cursor',async()=>{
    assert(await page.locator('.inherited-context').getByRole('button',{name:'View image 1',exact:true}).isEnabled());
    assert(!calls.slice(before).some(row=>row.input?.action==='readImage'));assert.deepEqual(errors,[]);
  });
  const active={id:'parity-own',status:'inProgress',items:[]};child.turns.push(active);emit('turn/started',{threadId:child.id,turn:copy(active)});await text('#child-result-status','Working…');
  await check('Active child retains the original Stop control outside the hidden composer',async()=>{
    assert(await page.locator('#stop').isVisible());assert.equal(await page.locator('#stop').evaluate(node=>node.parentElement.id),'child-actions');assert.equal(await page.locator('[id="stop"]').count(),1);assert(await page.locator('#child-result-report').isHidden());
  });
  await check('Direct child execution remains refused even with forged DOM submission',async()=>{
    const at=calls.length;await page.evaluate(()=>{document.querySelector('#prompt').value='MUST_NOT_SEND';document.querySelector('#composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});await page.waitForTimeout(80);
    assert(!calls.slice(at).some(row=>['send','steer','review','fork'].includes(row.input?.action)));
  });
  const report={id:'parity-report',type:'agentMessage',text:'All checks passed, says the model. <script>NEVER_RUN</script>'},command={id:'parity-command',type:'commandExecution',cwd:'/fixture/older',command:'node fixture-check.mjs',status:'completed',exitCode:1,aggregatedOutput:'ONE CHECK FAILED'};
  active.items=[command,report];active.status='completed';emit('turn/completed',{threadId:child.id,turn:copy(active)});await text('#child-result-status','Turn finished');
  await check('Execution completion and command failure remain distinct from verification',async()=>{
    await text('#child-result-evidence','1 failed');await text('#child-result-evidence','Verification: not established');
    const row=page.locator('[data-turn-id="parity-own"]');await text('[data-turn-id="parity-own"] .execution-summary','Execution');assert.equal(await row.locator('.verification-summary').getAttribute('data-state'),'failed');
    assert.equal(await row.locator('.verification-summary strong').innerText(),'Verification: not established');assert(!(await page.locator('#child-result-evidence').innerText()).includes('exited 0'));
  });
  await check('The latest report is labeled model output and rendered as inert text',async()=>{
    await page.locator('#child-result-report>summary').click();assert.equal(await page.locator('#child-result-report-text').innerText(),report.text);
    assert.equal(await page.locator('#messages script,#messages img,#child-result script,#child-result img').count(),0);await text('[data-item-id="parity-report"] .message-label','model output');
  });
  await check('Live completion preserves expanded inherited evidence and original history',async()=>{
    assert.equal(await page.locator('.inherited-context').evaluate(node=>node.open),true);assert.deepEqual(inherited,originalInherited);
  });
  await page.locator('#return-to-parent').click();await text('#thread-title','Saved chat');
  await check('Return to parent restores its exact draft and all nine draft maps',async()=>{
    assert.equal(await page.locator('#prompt').inputValue(),'KEEP_PARITY_PARENT_DRAFT مرحبا');assert.deepEqual(await maps(),kept);assert(await page.locator('#composer').isVisible());await page.waitForFunction(()=>document.activeElement===document.querySelector('#prompt'));
    assert.equal(await page.locator('#stop').evaluate(node=>node.nextElementSibling.id),'send');
  });
  await check('Model prose alone never becomes parent verification',async()=>{
    assert.equal(await page.locator('#messages .verification-summary strong').innerText(),'Verification: not established');await text('#messages .command-counts','No command receipts');
  });
  await openChild();await page.locator('#family-list [data-thread-id="parity-grandchild"]').click();await text('#thread-title','Nested parity reader');await page.waitForFunction(()=>!document.querySelector('#return-to-parent').disabled);
  await page.locator('#return-to-parent').click();await text('#thread-title',child.name);
  await check('Nested child returns to its immediate verified parent',async()=>assert.equal(await selected(),child.id));
  await page.evaluate(()=>{window.oldParityReturn=document.querySelector('#return-to-parent').onclick;});
  heldFamily='saved';releaseFamily=null;emit('coding/family/updated',{threadId:'saved',rootThreadId:'saved'});await until(()=>releaseFamily);
  await check('Pending family refresh rejects a stale retained parent handler',async()=>{
    await page.evaluate(()=>window.oldParityReturn());await text('#notice','Refresh the agent family');assert.equal(await selected(),child.id);
  });
  releaseFamily();await page.waitForFunction(()=>!document.querySelector('#return-to-parent').disabled);
  repeatFamilyCursor=true;await page.locator('#refresh').click();await text('#family-notice','pagination');
  await check('Incomplete family metadata keeps parent navigation unavailable',async()=>{
    assert(await page.locator('#return-to-parent').isDisabled());await page.evaluate(()=>window.oldParityReturn());assert.equal(await selected(),child.id);await text('#child-parent-label','unavailable');
  });
  repeatFamilyCursor=false;await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#return-to-parent').disabled);
  await page.reload();await text('#thread-title',child.name);await page.waitForFunction(()=>!document.querySelector('#return-to-parent').disabled);
  await check('Cold child selection retains its result, read-only layout and collapsed context',async()=>{
    assert(await page.locator('#composer').isHidden());assert.equal(await page.locator('.inherited-context').evaluate(node=>node.open),false);await text('#child-result-status','Turn finished');assert.deepEqual(await maps(),kept);
  });
  const stopped={id:'parity-stop',status:'inProgress',items:[]};child.turns.push(stopped);emit('turn/started',{threadId:child.id,turn:copy(stopped)});await text('#child-result-status','Working…');
  await check('Child Stop dispatches only the selected subtree through the original handler',async()=>{
    const at=calls.filter(row=>row.input?.action==='interruptFamily').length;await page.locator('#stop').click();await until(()=>calls.filter(row=>row.input?.action==='interruptFamily').length===at+1);
    assert.equal(calls.filter(row=>row.input?.action==='interruptFamily').length,at+1);assert.equal(calls.filter(row=>row.input?.action==='interruptFamily').at(-1).input.threadId,child.id);
    await text('#child-result-status','Stopping');assert(await page.locator('#stop').isDisabled());assert.deepEqual(threads.get('saved').turns,[parentTurn]);
  });
  stopped.status='interrupted';emit('turn/completed',{threadId:child.id,turn:copy(stopped)});familyStopping.delete(child.id);emit('coding/family/updated',{threadId:'saved',rootThreadId:'saved'});await text('#child-result-status','Stopped');
  await check('Confirmed child interruption has its own outcome and never reopens direct input',async()=>{
    assert(await page.locator('#stop').isHidden());assert(await page.locator('#composer').isHidden());assert(await page.locator('#prompt').isDisabled());assert(await page.locator('#child-result-report').isHidden());
  });
  await check('Parent navigation and child result fit narrow and medium windows',async()=>{
    for(const width of [390,650,1360]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      const rect=await page.locator('#return-to-parent').evaluate(node=>node.getBoundingClientRect().toJSON());assert(rect.width>0&&rect.left>=0&&rect.right<=width&&rect.bottom<=900);}
  });
  await page.locator('#return-to-parent').click();await text('#thread-title','Saved chat');
  fixtureOwners=[{id:'retained-1',state:'creating',rootThreadId:null},{id:'retained-2',state:'creating',rootThreadId:null}];
  fixtureListWarning='Some task startups remain incomplete. Their history is unavailable; verified saved chats are listed.';
  await page.locator('#refresh').click();await text('#startup-recovery-summary','2 incomplete task startups');
  await check('Retained startup warning is bounded, counted and initially collapsed',async()=>{
    assert(await page.locator('#startup-recovery').isVisible());assert.equal(await page.locator('#startup-recovery-details').evaluate(node=>node.open),false);assert(!(await page.locator('#event-notice').textContent()).includes('Some task startups remain incomplete'));
  });
  await check('Recovery summary uses the existing review action without altering a draft',async()=>{
    const at=calls.filter(row=>row.op==='codingRecovery').length;await page.locator('#review-startup-recovery').click();await text('#notice','Continuation review cancelled');
    assert.equal(calls.filter(row=>row.op==='codingRecovery').length,at+1);assert.equal(await selected(),'saved');assert.deepEqual(await maps(),kept);
  });
  fixtureOwners[0].rootThreadId='saved';fixtureListWarning='Current saved history inspection failed. This is not only an old startup warning.';
  await page.locator('#refresh').click();await text('#startup-recovery-current','selected task');await text('#event-notice',fixtureListWarning);
  await check('Selected-task recovery and arbitrary current history failures stay prominent',async()=>{
    assert(await page.locator('#startup-recovery-current').isVisible());assert(await page.locator('#event-notice').isVisible());
  });
  startupOutcome='error';await page.locator('#review-startup-recovery').click();await text('#notice','Current recovery inspection failed');
  await check('Current recovery failure is not collapsed into the retained summary',async()=>{
    assert(await page.locator('#notice').isVisible());assert(await page.locator('#startup-recovery').isVisible());assert.deepEqual(await maps(),kept);
  });
  fixtureOwners=[];fixtureListWarning='';emit('coding/family/updated',{threadId:'saved',rootThreadId:'saved'});await page.waitForFunction(()=>document.querySelector('#startup-recovery').hidden);
  await check('Clearing retained count does not erase a current operation failure',async()=>{
    await text('#notice','Current recovery inspection failed');assert(await page.locator('#notice').isVisible());
  });
  fixtureListWarning='Some task startups remain incomplete. Their history is unavailable; verified saved chats are listed.';
  await page.locator('#refresh').click();await text('#startup-recovery-summary','count unavailable');
  await check('Missing startup inventory reports an unknown count rather than zero',async()=>{
    assert(await page.locator('#startup-recovery').isVisible());await page.waitForFunction(()=>!document.querySelector('#review-startup-recovery').disabled);
  });
  await check('Parity navigation never dispatches a model or mutates saved thread history',async()=>{
    assert(!calls.slice(before).some(row=>row.op==='coding'&&['start','send','steer','review','fork','rename','archive','terminalStart'].includes(row.input?.action)));
    assert.deepEqual(threads.get('saved').turns,[parentTurn]);assert.deepEqual(inherited,originalInherited);assert.deepEqual(await maps(),kept);assert.deepEqual(errors,[]);
  });
  return checks;
}

async function checkDelegatedReceipts() {
  readHistoryWarning='';
  const child={id:'delegated-child',parentThreadId:'saved',rootThreadId:'saved',canAcceptDirectInput:false,name:'Reader <img src=x>',cwd:'/fixture/older',model:fixtureModel,archived:false,turns:[{id:'child-turn',status:'completed',items:[{id:'child-command',type:'commandExecution',command:'printf CHILD_OK',cwd:'/fixture/older',status:'completed',exitCode:0,aggregatedOutput:'CHILD_OK'},{id:'child-answer',type:'agentMessage',text:'\n\nCHILD_DONE'}]}]};
  threads.set(child.id,child);threads.set('grandchild',{...copy(child),id:'grandchild',parentThreadId:child.id,name:'Grandchild',turns:[]});
  const activity=(id,kind,agentThreadId=child.id)=>({id,type:'subAgentActivity',kind,agentThreadId,agentPath:'/root/reader <img src=x>',model:fixtureModel,reasoningEffort:'high'});
  const turn={id:'delegated-parent',status:'completed',items:[activity('started','started'),activity('finished','completed'),activity('unrelated','completed','foreign-root'),activity('missing','started','missing-child'),activity('wrong-parent','completed','grandchild'),{id:'parent-answer',type:'agentMessage',text:'\n\nPARENT_DONE'}]};
  threads.get('saved').turns=[turn];threads.set('foreign-root',{id:'foreign-root',name:'Unrelated chat',cwd:'/fixture/foreign',turns:[],archived:false});
  await page.reload();await text('#thread-title','Saved chat');await page.waitForFunction(()=>!document.querySelector('#prompt').disabled);
  await page.locator('#prompt').fill('KEEP_DELEGATION_DRAFT مرحبا');
  await page.locator('#message-files').setInputFiles({name:'keep.txt',mimeType:'text/plain',buffer:Buffer.from('KEEP ATTACHMENT')});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).attachmentDrafts?.saved?.length===1);
  const maps=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return Object.fromEntries(['drafts','attachmentDrafts','terminalDrafts','gitDrafts','worktreeGitDrafts','scheduleDrafts','efforts','taskModes','followupEdits'].map(k=>[k,p[k]]));});
  let retained=await maps();const at=calls.length;
  const started=page.locator('[data-key="delegated-parent:started"]'),finished=page.locator('[data-key="delegated-parent:finished"]');
  assert.match(await started.locator('summary').textContent(),/^Agent started/);
  assert.match(await finished.locator('summary').textContent(),/^Agent finished/);
  assert.equal(await started.locator('pre').textContent(),JSON.stringify(turn.items[0],null,2),'Raw activity remains unchanged');
  await text('.verification-summary','No direct command results are recorded in this chat.');
  assert.equal(await page.locator('.verification-summary strong').textContent(),'Verification: not established');
  await started.locator('summary').click();await started.getByRole('button',{name:'Open agent',exact:true}).waitFor();
  assert.equal(await page.locator('[data-key="delegated-parent:unrelated"] button,[data-key="delegated-parent:missing"] button,[data-key="delegated-parent:wrong-parent"] button').count(),0,'Unverified or unrelated IDs never become navigation links');
  assert.equal(await page.locator('#messages img,#messages script').count(),0);
  await page.evaluate(()=>{window.agentSavedSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='qwen-coding-ui-v1')throw new DOMException('full','QuotaExceededError');return window.agentSavedSet.call(this,k,v);};});
  const childReads=()=>calls.filter(c=>c.op==='coding'&&c.input.action==='read'&&c.input.threadId==='delegated-child').length;
  const readsBefore=childReads();await started.getByRole('button',{name:'Open agent',exact:true}).click();await text('#storage-notice','could not be saved');await text('#thread-title','Saved chat');assert.equal(childReads(),readsBefore);assert.deepEqual(await maps(),retained);
  await page.evaluate(()=>{Storage.prototype.setItem=window.agentSavedSet;delete window.agentSavedSet;window.agentFileRead=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){const file=this;return new Promise(resolve=>{window.releaseAgentFile=()=>resolve(window.agentFileRead.call(file));});};});
  await page.locator('#message-files').setInputFiles({name:'late.txt',mimeType:'text/plain',buffer:Buffer.from('KEEP LATE ATTACHMENT')});await page.waitForFunction(()=>typeof window.releaseAgentFile==='function');
  await started.getByRole('button',{name:'Open agent',exact:true}).click();await text('#storage-notice','Wait for image loading');await text('#thread-title','Saved chat');assert.equal(childReads(),readsBefore);
  await page.evaluate(()=>{window.releaseAgentFile();File.prototype.arrayBuffer=window.agentFileRead;delete window.agentFileRead;});await page.waitForFunction(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).attachmentDrafts.saved.length===2);retained=await maps();
  await started.getByRole('button',{name:'Open agent',exact:true}).click();await text('#thread-title',child.name);await text('#messages','CHILD_OK');
  assert(await page.locator('#prompt').isDisabled());assert(await page.locator('#send').isDisabled());
  await page.locator('#family-list [data-thread-id="saved"]').click();await text('#thread-title','Saved chat');
  assert.equal(await page.locator('#prompt').inputValue(),'KEEP_DELEGATION_DRAFT مرحبا');assert.deepEqual(await maps(),retained);
  // A stale button must not navigate after its verified family binding changes.
  await started.locator('summary').click();await page.evaluate(()=>window.oldAgentLink=document.querySelector('[data-key="delegated-parent:started"] button'));
  child.parentThreadId='foreign-root';child.rootThreadId='foreign-root';emit('coding/family/updated',{threadId:'saved',rootThreadId:'saved'});
  await page.waitForFunction(()=>!document.querySelector('[data-key="delegated-parent:started"] button'));
  await page.evaluate(()=>window.oldAgentLink.click());await text('#thread-title','Saved chat');assert.deepEqual(await maps(),retained);
  child.parentThreadId='saved';child.rootThreadId='saved';emit('coding/family/updated',{threadId:'saved',rootThreadId:'saved'});
  await page.waitForFunction(()=>!!document.querySelector('[data-key="delegated-parent:started"] button'));
  await page.reload();await text('#thread-title','Saved chat');await text('[data-key="delegated-parent:finished"]','Agent finished');assert.deepEqual(await maps(),retained);
  await page.locator('#chat-menu > summary').click();await page.locator('#browse-history').click();await text('#saved-history-status','Saved turn 1');
  assert.match(await page.locator('#saved-history-messages [data-key="delegated-parent:started"] summary').textContent(),/^Agent started/);
  assert.equal(await page.locator('#saved-history-messages [data-key="delegated-parent:started"] pre').textContent(),JSON.stringify(turn.items[0],null,2));assert.equal(await page.locator('#saved-history-messages').getByRole('button',{name:'Open agent',exact:true}).count(),0);
  await page.locator('#saved-history-close').click();assert.deepEqual(await maps(),retained);
  assert(calls.slice(at).every(c=>['coding/status','coding/events','coding/list','coding/read','coding/family','coding/historyPage','coding/mcpOutcomes','coding/terminalResults','codingWorktrees/list','codingSchedules/list','codingFilePreview/clear','codingSkills/clear'].includes(c.op+'/'+c.input?.action)),'Navigation must never dispatch a model or mutate a chat');
  assert.deepEqual(errors,[]);
}

async function checkLiveCommandOrder() {
  await page.waitForFunction(()=>!document.querySelector('#new-project').disabled&&!document.querySelector('#prompt').disabled);
  readHistoryWarning='';const before=calls.length,draft='KEEP_LIVE_ORDER_UNSENT_DRAFT';
  await page.locator('#prompt').fill(draft);await page.locator('#prompt').focus();
  const maps=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return Object.fromEntries(['drafts','attachmentDrafts','terminalDrafts','gitDrafts','worktreeGitDrafts','scheduleDrafts','efforts','taskModes','followupEdits'].map(k=>[k,p[k]]));});
  const retained=await maps();completionReadModes.set('saved','failed');
  for(const [phase,verified] of [['final_answer',true],[null,true],['commentary',true],[null,false]]) {
    const id='late-command-'+(phase||'completed')+'-'+verified,commentary={id:id+'-commentary',type:'agentMessage',phase:'commentary',text:'Prelude '+id},final={id:id+'-final',type:'agentMessage',text:'Final '+id,...(phase?{phase}: {})};
    const turn={id,status:'inProgress',items:[{id:id+'-user',type:'userMessage',content:[{type:'text',text:'Check '+id}]},commentary,final]};
    threads.get('saved').turns.push(turn);emit('turn/started',{threadId:'saved',turn:copy(turn)});await text('#messages',final.text);
    const command={id:id+'-command',type:'commandExecution',command:'printf ORDERED',status:'completed',aggregatedOutput:'ORDERED '+id,exitCode:0,...(verified?{receiptSource:'persistedToolOutput'}:{})};
    turn.items.splice(2,0,command);emit('item/completed',{threadId:'saved',turnId:id,item:copy(command)});await text('#messages',command.aggregatedOutput);
    const section=page.locator('[data-turn-id="'+id+'"]');
    if(!phase)assert((await section.textContent()).indexOf(final.text)<(await section.textContent()).indexOf('ORDERED '+id),'No final phase means an in-progress turn retains observed arrival order');
    await section.locator('.receipt summary').click();await page.locator('#prompt').focus();
    turn.status='completed';emit('turn/completed',{threadId:'saved',turn:{...copy(turn),itemsView:'summary',items:[copy(final)]}});await text('[data-turn-id="'+id+'"] .turn-outcome','Turn finished');
    const order=await section.evaluate(node=>[...node.children].filter(n=>n.matches('article,details')).map(n=>n.dataset.itemId||n.dataset.key));
    const end=verified&&phase!=='commentary'?[id+':'+command.id,id+'-final']:[id+'-final',id+':'+command.id];
    assert.deepEqual(order,[id+'-user',id+'-commentary',...end],'Only a verified receipt beyond a final anchor moves; commentary and unverified arrival order stay intact');
    assert(await section.locator('.receipt').evaluate(node=>node.open),'Reordering keeps the receipt expanded');
    assert.equal(await page.locator('#prompt').inputValue(),draft);assert.equal(await page.evaluate(()=>document.activeElement.id),'prompt');assert.deepEqual(await maps(),retained);
  }
  completionReadModes.delete('saved');
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);assert.equal(await page.locator('#prompt').inputValue(),draft);
  const readsOnly=new Set(['coding/status','coding/events','coding/list','coding/read','coding/family','coding/mcpOutcomes','coding/terminalResults','codingWorktrees/list','codingSchedules/list','codingFilePreview/clear','codingSkills/clear']);
  assert(calls.slice(before).every(c=>readsOnly.has(c.op+'/'+c.input?.action)),'History reconciliation dispatches no model turn, command or mutation');assert.deepEqual(errors,[]);
}

async function checkSelectedTitleSync() {
  readHistoryWarning='';const id='title-current',draft='KEEP_TITLE_UNSENT_DRAFT',row=key=>page.locator('.chat-row[data-thread-id="'+key+'"] > button').first(),beforeCalls=calls.length;
  threads.set(id,{id,cwd:'/fixture/title-project',name:null,preview:'',executionMode:'native',turns:[],archived:false});
  await page.locator('#refresh').click();await row(id).waitFor();await row(id).click();await text('#thread-title','New chat');
  await page.waitForFunction(()=>!document.querySelector('#prompt').disabled&&!document.querySelector('#new-project').disabled);
  await page.locator('#prompt').fill(draft);await page.locator('#prompt').evaluate(node=>{node.focus();node.setSelectionRange(5,10);});
  const draftState=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1')),node=document.querySelector('#prompt');return {selectedId:p.selectedId,value:node.value,start:node.selectionStart,end:node.selectionEnd,focused:document.activeElement===node,maps:Object.fromEntries(['drafts','terminalDrafts','scheduleDrafts','gitDrafts','worktreeGitDrafts'].map(key=>[key,p[key]])),ordinary:localStorage.getItem('qwen-local-chats-v1')};});
  const retained=await draftState();assert.equal(retained.selectedId,id);assert.equal(retained.maps.drafts[id],draft);assert(retained.focused);
  const waitRow=(key,label)=>page.waitForFunction(({key,label})=>document.querySelector('.chat-row[data-thread-id="'+key+'"] > button')?.textContent===label,{key,label},{timeout:6000});
  const generated='Use MCP server acceptance84 tool echo exactly once';threads.get(id).name=generated;emit('thread/name/updated',{threadId:id,threadName:generated});
  await waitRow(id,generated);
  assert.equal(await page.locator('#thread-title').textContent(),generated,'Selected header must match the sidebar after an automatic name event');
  assert.deepEqual(await draftState(),retained,'Name-only redraw preserves unsent text, all draft maps, cursor and focus');

  const preview='Use the saved preview after a completed turn without a name notification; remaining text is deliberately longer than seventy characters.';
  const turn={id:'title-preview-turn',status:'completed',items:[{id:'title-preview-answer',type:'agentMessage',text:'TITLE_PREVIEW_HISTORY_LOADED'}]};
  Object.assign(threads.get(id),{name:null,preview});threads.get(id).turns.push(copy(turn));
  const named=events.filter(event=>event.method==='thread/name/updated').length,reads=calls.filter(c=>c.op==='coding'&&c.input?.action==='read'&&c.input.threadId===id).length;
  // Live event lacks saved items/preview. Only the existing completion read supplies them.
  emit('turn/completed',{threadId:id,turn:{...copy(turn),items:[]}});
  await text('#messages','TITLE_PREVIEW_HISTORY_LOADED');await waitRow(id,preview.slice(0,70));
  assert(calls.filter(c=>c.op==='coding'&&c.input?.action==='read'&&c.input.threadId===id).length>reads,'Completion refreshed selected saved history');
  assert.equal(events.filter(event=>event.method==='thread/name/updated').length,named,'Preview path emits no name notification');
  assert.equal(await page.locator('#thread-title').textContent(),preview.slice(0,70),'Selected header must use the same saved-preview fallback as its sidebar');
  assert.deepEqual(await draftState(),retained,'History-only title refresh preserves drafts, cursor and focus');

  const other='Another chat received a generated title';threads.get('saved').name=other;emit('thread/name/updated',{threadId:'saved',threadName:other});await waitRow('saved',other);
  assert.equal(await page.locator('#thread-title').textContent(),preview.slice(0,70),'Another chat cannot overwrite the selected header');
  assert.deepEqual(await draftState(),retained,'Another chat update preserves the selected draft and focus');
  const readsOnly=new Set(['coding/status','coding/events','coding/list','coding/read','coding/family','coding/mcpOutcomes','coding/terminalResults','codingWorktrees/list','codingSchedules/list','codingFilePreview/clear','codingSkills/clear']);
  assert(calls.slice(beforeCalls).every(c=>readsOnly.has(c.op+'/'+c.input?.action)),'Title synchronization grants no execution, mutation, input or replay authority');
  assert.deepEqual(errors,[]);
}

async function checkUIClarity(helperOnly = false) {
  await page.waitForFunction(()=>!document.querySelector('#new-project').disabled && !document.querySelector('#prompt').disabled);
  readHistoryWarning='';const savedBefore=copy(threads.get('saved'));
  await page.locator('#prompt').fill('KEEP_UI_CLARITY_DRAFT');
  const drafts=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return Object.fromEntries(['drafts','terminalDrafts','scheduleDrafts','gitDrafts','worktreeGitDrafts'].map(k=>[k,p[k]]));});
  const beforeDrafts=await drafts(),beforeCalls=calls.length;
  await page.setViewportSize({width:390,height:844});
  if(!helperOnly){
    mcpOutcomeFixtures.set('saved',{threadId:'saved',available:true,ownerId:savedOwner,storeId:'22222222-2222-4222-8222-222222222222',revision:1,blocked:false,warning:'',cached:false,complete:true,records:[]});
    await page.locator('#mcp-outcomes-refresh').click();await text('#coding-mcp-outcomes','0 saved attempts');
    for(const width of [1360,390]){await page.setViewportSize({width,height:900});assert(await page.locator('#coding-mcp-outcomes').evaluate(node=>node.getBoundingClientRect().height<=80),'A verified empty receipt list stays compact');assert(await page.locator('#mcp-outcomes-evidence').isHidden());}
    await page.setViewportSize({width:1360,height:900});
    holdMCP=true;releaseMCP=null;await page.locator('#mcp-outcomes-refresh').click();await until(()=>releaseMCP);await page.locator('#mcp-outcomes-evidence > summary').focus();releaseMCP();await page.waitForFunction(()=>document.querySelector('#coding-mcp-outcomes').dataset.empty==='true');assert.equal(await page.evaluate(()=>document.activeElement.id),'mcp-outcomes-refresh','A newly empty receipt list returns focus to its surviving Refresh control');
    const record={attemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerGeneration:'fixture-owner',processGeneration:'fixture-process',threadId:'saved',turnId:'fixture-turn',callId:'fixture-call',rpcId:1,server:'fixture',name:'inspect',createdAt:1000,intendedAt:1001,providerAt:null,deliveryAt:null,provider:'unknown',delivery:'unknown',reason:null,persistence:'durable'};
    const snapshot={threadId:'saved',available:true,ownerId:'11111111-1111-4111-8111-111111111111',storeId:'22222222-2222-4222-8222-222222222222',revision:1,blocked:true,warning:'FIXTURE_WARNING_ALPHA: The saved journal is incomplete. Retain the original evidence and inspect the affected target before another action.',cached:false,complete:false,records:[record]};
    mcpOutcomeFixtures.set('saved',snapshot);
    await page.locator('#mcp-outcomes-refresh').click();await text('#mcp-outcomes-warning','FIXTURE_WARNING_ALPHA');
    const disclosure=page.locator('#mcp-outcomes-evidence');assert.equal(await disclosure.count(),1,'MCP evidence needs an explicit whole-section disclosure');const summary=disclosure.locator(':scope > summary');
    if(!await disclosure.evaluate(node=>node.open))await summary.click();
    const receipts=page.locator('#mcp-outcomes-details');if(!await receipts.evaluate(node=>node.open))await receipts.locator(':scope > summary').click();
    assert(await page.locator('#mcp-outcomes-warning').isVisible(),'Expanded evidence retains the complete original warning');
    await text('#coding-mcp-outcomes','Completion unknown');await text('#coding-mcp-outcomes','Engine delivery unknown');
    assert.equal(await page.locator('.mcp-outcome').count(),1);assert.match(await page.locator('.mcp-outcome').textContent(),/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
    const expandedHeight=await page.locator('#thread').evaluate(node=>node.getBoundingClientRect().height);
    await summary.click();
    assert(await page.locator('#mcp-outcomes-warning').isHidden(),'Collapsing MCP evidence must hide the full warning body, not only receipts');
    assert(await page.locator('.mcp-outcome').isHidden());assert(await page.locator('#mcp-outcomes-refresh').isVisible());
    assert(await page.locator('.mcp-outcomes-status').isVisible());assert(await page.locator('#mcp-outcomes-caution').isVisible());
    assert.match(await page.locator('#mcp-outcomes-caution').innerText(),/may have happened.*incomplete.*before retrying/s);
    assert((await page.locator('#thread').evaluate(node=>node.getBoundingClientRect().height))>expandedHeight+40,'Explicit collapse restores useful history space at narrow width');
    snapshot.revision++;snapshot.warning='FIXTURE_WARNING_BETA: A later read still cannot establish a complete journal.';
    await page.locator('#mcp-outcomes-refresh').click();await text('#mcp-outcomes-warning','FIXTURE_WARNING_BETA');
    assert.equal(await disclosure.evaluate(node=>node.open),false,'Read-only refresh preserves explicit collapse');
    snapshot.revision++;snapshot.warning='FIXTURE_WARNING_EVENT: The original warning remains inspectable after a live update.';
    emit('coding/mcpOutcomesChanged',{threadId:'saved'});await text('#mcp-outcomes-warning','FIXTURE_WARNING_EVENT');
    assert.equal(await disclosure.evaluate(node=>node.open),false,'Same-chat event synchronization preserves explicit collapse');
    mcpOutcomeError='Tools are busy stopping; wait for Stop to finish before starting or reading work.';
    await page.evaluate(()=>window.dispatchEvent(new Event('tools-stopped')));await text('.mcp-outcomes-status','Waiting for Stop to finish');
    assert(await page.locator('.mcp-outcomes-status').isVisible());assert(await page.locator('#mcp-outcomes-caution').isVisible());
    assert.match(await page.locator('#mcp-outcomes-caution').innerText(),/Stop.*may have happened/s);assert.equal(await disclosure.evaluate(node=>node.open),false);
    mcpOutcomeError='';await page.locator('#mcp-outcomes-refresh').click();await text('.mcp-outcomes-status','Saved outcome evidence');
    await summary.focus();await page.keyboard.press('Enter');assert(await disclosure.evaluate(node=>node.open),'Native disclosure supports the keyboard');
    assert(await page.locator('#mcp-outcomes-warning').isVisible());assert.equal(await page.locator('.mcp-outcome').count(),1);
    await summary.click();assert.equal(await disclosure.evaluate(node=>node.open),false);
    const other={id:'clarity-other',cwd:'/fixture/clarity-other',name:'Other clarity chat',turns:[],archived:false};threads.set(other.id,other);
    mcpOutcomeFixtures.set(other.id,{...copy(snapshot),threadId:other.id,ownerId:'33333333-3333-4333-8333-333333333333',records:[],warning:'OTHER_CHAT_WARNING: Inspect this separate chat.'});
    await page.setViewportSize({width:1360,height:900});await page.locator('#refresh').click();await page.getByRole('button',{name:other.name,exact:true}).click();await text('#mcp-outcomes-warning','OTHER_CHAT_WARNING');
    assert(await page.locator('#mcp-outcomes-evidence').evaluate(node=>node.open),'New chat warning gets its own expanded default');
    await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');await text('#mcp-outcomes-warning','FIXTURE_WARNING_EVENT');
    assert.equal(await page.locator('#prompt').inputValue(),'KEEP_UI_CLARITY_DRAFT');assert.equal(await page.locator('.mcp-outcome').count(),1);
    threads.delete(other.id);mcpOutcomeFixtures.delete(other.id);
  }
  await page.setViewportSize({width:390,height:844});await text('#composer-hint','Enter to send');
  assert(await page.locator('#composer-hint').isVisible(),'Narrow Coding must retain its dynamic composer guidance');
  assert.equal(await page.locator('#composer-hint').evaluate(node=>getComputedStyle(node).fontSize),'12px');
  assert(await page.locator('#run-status').isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const sends=countAction('send');await page.locator('#prompt').press('End');await page.locator('#prompt').press('Shift+Enter');assert.equal(countAction('send'),sends,'Newline does not send');await page.locator('#prompt').fill('KEEP_UI_CLARITY_DRAFT');
  threads.set('saved',{...copy(savedBefore),historyOnly:true});await page.reload();await text('#composer-hint','Read-only history');
  assert(await page.locator('#composer-hint').isVisible());assert(await page.locator('#send').isDisabled());assert(await page.locator('#prompt').isDisabled());
  assert.equal(await page.locator('#prompt').inputValue(),'KEEP_UI_CLARITY_DRAFT');
  threads.set('saved',savedBefore);await page.reload();await text('#composer-hint','Enter to send');
  const afterDrafts=await drafts();for(const [map,entries]of Object.entries(beforeDrafts))for(const [key,value]of Object.entries(entries||{}))assert.deepEqual(afterDrafts[map][key],value,'Existing draft preserved: '+map+'/'+key);
  assert.deepEqual(threads.get('saved'),savedBefore);assert.equal(await page.evaluate(()=>localStorage.getItem('qwen-local-chats-v1')),'LEGACY_UNTOUCHED');
  const reads=new Set(['coding/status','coding/events','coding/list','coding/read','coding/family','coding/mcpOutcomes','coding/terminalResults','codingWorktrees/list','codingSchedules/list','codingFilePreview/clear','codingSkills/clear']);
  assert(calls.slice(beforeCalls).every(c=>reads.has(c.op+'/'+c.input?.action)),'Evidence/helper inspection grants no execution, tool, input or replay authority');
  assert.deepEqual(errors,[]);
}

async function checkCompletionWhileAway() {
  readHistoryWarning = '';
  const a = 'saved', b = 'away-task', row = id => page.locator(`.chat-row[data-thread-id="${id}"]`);
  threads.set(b,{id:b,cwd:'/fixture/away',name:'Away task',turns:[],archived:false});
  const ready = async () => {await text('#thread-title','Saved chat');await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);};
  const openA = async () => {await row(a).locator('button').first().click();await ready();};
  const returnToCoding = async () => {await page.locator('#return-coding').click();await ready();};
  const leave = async () => {await page.locator('#back-chat').click();await page.waitForURL(origin+'/');};
  const startB = async () => {
    await page.locator('#refresh').click();await row(b).locator('button').first().click();await text('#thread-title','Away task');
    await page.locator('#prompt').fill('B fixture work');await page.locator('#send').click();await text('#run-status','Working');
    const turn=threads.get(b).turns.at(-1);await openA();return turn;
  };
  const finishB = (turn,status='completed') => {turn.status=status;if(status==='failed')turn.error={message:'Away fixture failure'};turn.items.push({id:`answer-${turn.id}`,type:'agentMessage',text:`AWAY RESULT ${turn.id}`});emit('turn/completed',{threadId:b,turn:copy(turn)});};
  const inspectB = async turn => {await row(b).locator('button').first().click();await text('#messages',`AWAY RESULT ${turn.id}`);await page.waitForFunction(id=>!JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).unread[id],b);await openA();};
  const retainedDrafts = async () => assert.equal(await page.locator('#prompt').inputValue(),'KEEP_A_DRAFT');
  await page.locator('#prompt').fill('KEEP_A_DRAFT');
  const first=await startB();await leave();const callsWhileAway=calls.length;finishB(first);await returnToCoding();
  await text('#session-overview','1 unread');assert.match(await row(b).innerText(),/Activity finished.*unread/);await retainedDrafts();
  await page.locator('#session-overview').click();assert(await row(b).isVisible(),'Finished B remains in Active and unread');await page.locator('#session-overview').click();
  await page.reload();await ready();await text('#session-overview','1 unread');await retainedDrafts();
  await inspectB(first);await page.reload();await ready();assert(!/unread/.test(await row(b).innerText()),'Reading B consumes its recovered completion across reload');
  const recoveryReads = new Set(['coding/status','coding/events','coding/list','coding/read','coding/family','coding/mcpOutcomes','coding/terminalResults','codingWorktrees/list','codingSchedules/list','codingFilePreview/clear','codingSkills/clear']);
  assert(calls.slice(callsWhileAway).every(c=>recoveryReads.has(`${c.op}/${c.input?.action}`)),'Recovery only uses history/status reads and preview/skill revocation');
  for(const mode of ['failed','incomplete','warning']) {
    const turn=await startB();await leave();finishB(turn,'failed');completionReadModes.set(b,mode);await returnToCoding();
    assert(!/unread/.test(await row(b).innerText()),`${mode} history cannot manufacture a completion badge`);
    assert((await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).watchedTurns)).some(w=>w.threadId===b&&w.turnId===turn.id),`${mode} read retains the exact watched turn`);
    completionReadModes.delete(b);await page.reload();await ready();await text('#session-overview','1 unread');assert.match(await row(b).innerText(),/Error.*unread/);await inspectB(turn);
  }
  // The existing live-event path consumes the same watcher; reload cannot re-mark a read result.
  const live=await startB();finishB(live);await text('#session-overview','1 unread');await inspectB(live);await page.reload();await ready();assert(!/unread/.test(await row(b).innerText()));
  // An old active-status reply cannot re-watch a completion already read in the meantime.
  const stale=await startB();holdStatus=true;releaseStatus=null;await page.locator('#refresh').click();await until(()=>releaseStatus);finishB(stale);await text('#session-overview','1 unread');
  await row(b).locator('button').first().click();await text('#messages',`AWAY RESULT ${stale.id}`);await row(a).locator('button').first().click();await text('#thread-title','Saved chat');releaseStatus();await ready();
  assert(!/unread/.test(await row(b).innerText()),'Late status cannot resurrect an inspected completion');await page.reload();await ready();assert(!/unread/.test(await row(b).innerText()));
  // A still-running turn read on return stays watched until its real completion.
  const running=await startB();await leave();await returnToCoding();assert.match(await row(b).innerText(),/Working/);assert(!/unread/.test(await row(b).innerText()));finishB(running,'interrupted');await text('#session-overview','1 unread');assert.match(await row(b).innerText(),/Stopped.*unread/);await inspectB(running);
  await retainedDrafts();
  // A late review acknowledgement may preserve local Stop presentation, never prove physical completion.
  await row(b).locator('button').first().click();await text('#thread-title','Away task');await page.locator('#changes-toggle').click();holdReview=true;releaseReview=null;await page.locator('#review-changes').click();await until(()=>releaseReview);
  const stoppedReview=threads.get(b).turns.at(-1);await page.waitForFunction(({threadId,turnId})=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).watchedTurns.some(w=>w.threadId===threadId&&w.turnId===turnId),{threadId:b,turnId:stoppedReview.id});
  await page.evaluate(()=>window.dispatchEvent(new Event('agent-stopped')));releaseReview();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);
  assert((await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).watchedTurns)).some(w=>w.threadId===b&&w.turnId===stoppedReview.id),'Local Stop plus late acknowledgement retains the unconfirmed turn');
  await page.locator('#close-panel').click();await openA();finishB(stoppedReview,'interrupted');await text('#session-overview','1 unread');await inspectB(stoppedReview);
  const seedWatches = async watches => page.evaluate(watchedTurns=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));p.watchedTurns=watchedTurns;sessionStorage.setItem('coding-fixture-preferences',JSON.stringify(p));},watches);
  const unresolved={threadId:b,turnId:'not-in-this-history'};
  await seedWatches([unresolved,unresolved,null,{threadId:b,turnId:'../invalid'}]);await page.reload();await ready();
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).watchedTurns),[unresolved],'Preferences validate/deduplicate exact pairs without treating a missing turn as completed');
  const oversized=Array.from({length:513},()=>unresolved);await seedWatches(oversized);const beforeOversized=calls.length;await page.reload();await ready();await text('#event-notice','preserved unchanged');
  await page.locator('#prompt').fill('KEEP_A_DRAFT');assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).watchedTurns),oversized,'Oversized tracking stays intact while other preferences save');
  assert(!calls.slice(beforeOversized).some(c=>c.op==='coding'&&c.input?.action==='read'&&c.input.threadId===b),'Oversized tracking cannot fan out history reads');
  await retainedDrafts();assert.equal(await page.evaluate(()=>localStorage.getItem('qwen-local-chats-v1')),'LEGACY_UNTOUCHED');assert.deepEqual(errors,[]);
}


async function checkScheduleModes() {
  const nativeId='33333333-3333-4333-8333-333333333333', savedThreads=copy([...threads]);
  const scheduleCalls=action=>calls.filter(c=>c.op==='codingSchedules'&&c.input.action===action);
  const row=id=>page.locator('.schedule-row[data-schedule-id="'+id+'"]');
  schedules.push({...copy(schedules[0]),id:nativeId,name:'Native saved schedule',model:'local/saleh-qwen38-uncensored-8bit',executionMode:'native'});
  const oldRuns=copy(schedules[1].runs);
  await page.locator('#prompt').fill('KEEP_CHAT_DRAFT');await page.locator('#schedules-toggle').click();
  assert.equal(await page.locator('#schedule-execution-mode').count(),1,'Scheduled work must expose an explicit execution mode before native review');
  const mode=page.locator('#schedule-execution-mode'),model=page.locator('#schedule-model'),chosen='local/saleh-qwen38-uncensored-8bit';
  assert.equal(await model.inputValue(),chosen,'New schedules start with the configured default');
  await text('#schedules-list','Native saved schedule');assert.match(await row(scheduleId).innerText(),/Virtual machine/);assert.match(await row(nativeId).innerText(),/Native/);
  await row(scheduleId).locator('[data-schedule-action="edit"]').click();assert.equal(await mode.inputValue(),'vm','Omitted legacy schedule mode stays VM');assert.equal(await model.inputValue(),fixtureModel,'A legacy saved schedule retains its model');
  await page.locator('#schedule-new').click();assert.equal(await mode.inputValue(),'vm','New schedule preserves the existing VM default');assert.equal(await model.inputValue(),chosen);
  await page.locator('#schedule-name').fill('NEW_NATIVE_DRAFT');await page.locator('#schedule-prompt').fill('NEW_NATIVE_PROMPT');await mode.selectOption('native');
  cancelSchedule=true;await page.locator('#schedule-save').click();await text('#schedules-notice','cancelled');
  assert.equal(scheduleCalls('save').at(-1).input.executionMode,'native');assert.equal(scheduleCalls('save').at(-1).input.model,chosen);assert.equal(await model.inputValue(),chosen);assert.equal(await mode.inputValue(),'native');assert.equal(await page.locator('#schedule-prompt').inputValue(),'NEW_NATIVE_PROMPT');
  await row(scheduleId).locator('[data-schedule-action="edit"]').click();await page.locator('#schedule-new').click();assert.equal(await mode.inputValue(),'native','Switching editors keeps the explicit mode draft');
  await row(nativeId).locator('[data-schedule-action="edit"]').click();assert.equal(await mode.inputValue(),'native','Editing a saved native schedule must not default to VM');
  await page.locator('#schedule-prompt').fill('KEEP_NATIVE_SCHEDULE_DRAFT');
  await page.evaluate(id=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));delete p.scheduleDrafts[id].executionMode;delete p.scheduleDrafts[id].model;localStorage.setItem('saleh-local-model-default-v1','qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp');sessionStorage.setItem('coding-fixture-preferences',JSON.stringify(p));},nativeId);
  const mutationsBeforeReload=scheduleCalls('save').length+scheduleCalls('run').length+scheduleCalls('resume').length;
  await page.reload();await text('#thread-title','Saved chat');await page.locator('#schedules-toggle').click();await text('#schedules-list','Native saved schedule');
  assert.equal(await mode.inputValue(),'native','A cold legacy-shaped draft inherits its native saved definition');assert.equal(await model.inputValue(),chosen,'A missing draft model inherits its saved binding, not a changed default');assert.equal(await page.locator('#schedule-prompt').inputValue(),'KEEP_NATIVE_SCHEDULE_DRAFT');
  assert.equal(scheduleCalls('save').length+scheduleCalls('run').length+scheduleCalls('resume').length,mutationsBeforeReload,'Reload never creates or runs scheduled work');
  await page.locator('#schedule-save').click();await text('#schedules-notice','saved');assert.equal(scheduleCalls('save').at(-1).input.executionMode,'native');assert.equal(schedules.find(s=>s.id===nativeId).executionMode,'native');
  await mode.selectOption('vm');await model.selectOption(fixtureModel);await page.locator('#schedule-prompt').fill('UNSAVED_VM_EDIT');
  await row(nativeId).locator('[data-schedule-action="run"]').click();await text('#schedules-notice','Run now');assert.deepEqual(scheduleCalls('run').at(-1).input,{action:'run',id:nativeId});assert.equal(schedules.find(s=>s.id===nativeId).executionMode,'native','Run now does not adopt an unsaved editor mode');assert.equal(schedules.find(s=>s.id===nativeId).model,chosen,'Run now keeps the saved model');
  await row(nativeId).locator('[data-schedule-action="pause"]').click();await until(()=>!schedules.find(s=>s.id===nativeId).active);await page.waitForFunction(()=>!document.querySelector('[data-schedule-id="33333333-3333-4333-8333-333333333333"] [data-schedule-action="resume"]').disabled);
  await row(nativeId).locator('[data-schedule-action="resume"]').click();await until(()=>schedules.find(s=>s.id===nativeId).active);assert.deepEqual(scheduleCalls('resume').at(-1).input,{action:'resume',id:nativeId});
  await mode.selectOption('native');await page.locator('#schedule-prompt').fill('KEEP_AFTER_STOP');holdSchedule=true;releaseSchedule=null;await page.locator('#schedule-save').click();await until(()=>releaseSchedule);await page.locator('#schedules-stop').click();await until(()=>scheduleCalls('stop').length===1);cancelSchedule=true;releaseSchedule();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  assert.equal(await mode.inputValue(),'native');assert.equal(await page.locator('#schedule-prompt').inputValue(),'KEEP_AFTER_STOP');assert.equal(await model.inputValue(),fixtureModel);assert.equal(schedules.find(s=>s.id===nativeId).model,chosen,'Stopped review cannot replace the saved model');assert(!schedules.some(s=>s.active));
  const malformed=schedules.find(s=>s.id===nativeId);malformed.executionMode='future';await page.locator('#schedules-refresh').click();await text('#schedules-notice','invalid list');assert(await row(nativeId).locator('[data-schedule-action="run"]').isDisabled(),'Unknown server mode cannot become VM execution');malformed.executionMode='native';await page.locator('#schedules-refresh').click();await text('#schedules-list','Native saved schedule');
  await page.evaluate(id=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));p.scheduleDrafts[id].executionMode='future';p.scheduleDrafts[id].model={future:true};sessionStorage.setItem('coding-fixture-preferences',JSON.stringify(p));},nativeId);
  await page.reload();await text('#thread-title','Saved chat');await page.locator('#schedules-toggle').click();await text('#schedules-list','Native saved schedule');assert.equal(await mode.inputValue(),'','Unknown saved draft mode requires an explicit choice');assert(await page.locator('#schedule-save').isDisabled());
  assert.equal(await page.evaluate(id=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).scheduleDrafts[id].executionMode,nativeId),'future','Loading does not rewrite an unsupported draft');
  assert.equal(await model.inputValue(),'');assert.deepEqual(await page.evaluate(id=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).scheduleDrafts[id].model,nativeId),{future:true});await mode.selectOption('native');assert(await page.locator('#schedule-save').isDisabled());await model.selectOption(chosen);assert.equal(await page.locator('#schedule-prompt').inputValue(),'KEEP_AFTER_STOP');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_CHAT_DRAFT');assert.deepEqual([...threads],savedThreads);
  assert.deepEqual(schedules.find(s=>s.id===nativeId).runs.slice(1),oldRuns,'Prior saved run rows stay byte-equivalent despite future schedule mode edits');assert.equal(await page.evaluate(()=>localStorage.getItem('qwen-local-chats-v1')),'LEGACY_UNTOUCHED');assert(!calls.some(c=>c.op==='coding'&&['start','send','steer','terminalStart'].includes(c.input?.action)));assert.deepEqual(errors,[]);
}

async function checkSavedCommandResults() {
  assert.equal(await page.locator('#terminal-results').count(),1,'Saved reviewed-command selector must exist');
  const first='33333333-3333-4333-8333-333333333333',second='44444444-4444-4444-8444-444444444444',peer='55555555-5555-4555-8555-555555555555';
  savedCommandRows.set('saved',[savedRow('saved',first),savedRow('saved',second,{state:'unconfirmed',exitCode:null,endedAt:null,observationComplete:false,output:'UNCONFIRMED EVIDENCE',outputTruncated:true})]);
  threads.set('result-peer',{id:'result-peer',cwd:'/fixture/peer',name:'Result peer',archived:false,turns:[]});savedCommandRows.set('result-peer',[savedRow('result-peer',peer,{output:'PEER ONLY',exitCode:0,stopRequested:false})]);
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Saved chat',exact:true}).click();await page.locator('#prompt').fill('KEEP_RESULT_PROMPT');await page.locator('#terminal-toggle').click();await page.locator('#terminal-command').fill('KEEP_RESULT_COMMAND');await page.locator('#terminal-input').fill('KEEP_RESULT_INPUT');await text('#terminal-saved-output','SAVED <img');
  const drafts=async()=>[await page.locator('#prompt').inputValue(),await page.locator('#terminal-command').inputValue(),await page.locator('#terminal-input').inputValue()];
  const original=await drafts();await text('#terminal-saved-status','exit 137');await text('#terminal-results-notice','owner');assert.equal(await page.locator('#terminal-saved-result img').count(),0);assert(await page.locator('#stop').isHidden());assert(await page.locator('#terminal-stop').isDisabled());assert(await page.locator('#terminal-write').isDisabled());
  await page.locator('#terminal-results').selectOption(second);await text('#terminal-saved-status','Outcome unconfirmed');await text('#terminal-saved-warning','truncated');assert.deepEqual(await drafts(),original);
  await page.reload();await text('#thread-title','Saved chat');await page.locator('#terminal-toggle').click();await text('#terminal-saved-output','SAVED <img');assert.deepEqual(await drafts(),original);
  // Native busy-Stop is a transient read refusal: previous evidence stays visible and no retry loop starts.
  savedCommandError='Tools are busy stopping; wait for Stop to finish before starting or reading work.';await page.locator('#terminal-results-refresh').click();await text('#terminal-results-notice','Stop');await text('#terminal-saved-output','SAVED <img');savedCommandError='';
  for(const mode of ['owner','large','unicode','state']){savedCommandMalformed=mode;await page.locator('#terminal-results-refresh').click();await text('#terminal-results-notice','unavailable');await text('#terminal-saved-output','SAVED <img');savedCommandMalformed='';}
  savedCommandRows.get('saved')[0].output='REFRESHED RESULT';emit('coding/terminal/resultsChanged',{threadId:'saved'});await text('#terminal-saved-output','REFRESHED RESULT');
  emit('coding/terminal/resultSaveFailed',{threadId:'saved',message:'fixture disk unavailable'});await text('#terminal-results-notice','save');await text('#terminal-saved-output','REFRESHED RESULT');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tools-stop-result',{detail:{stopped:true}})));await text('#terminal-saved-output','REFRESHED RESULT');
  // An actual running command owns the live view; saved rows grant no process/input authority.
  await page.locator('#terminal-command').fill('printf live-fixture');await page.locator('#terminal-run').click();await text('#terminal-status','Running');assert(await page.locator('#terminal-saved-result').isHidden());assert(await page.locator('#terminal-results').isDisabled());await page.locator('#terminal-stop').click();await text('#terminal-status','Stopped');await page.locator('#terminal-command').fill(original[1]);
  holdSavedCommand='saved';releaseSavedCommand=null;await page.locator('#terminal-results').selectOption(second);await until(()=>releaseSavedCommand);await page.getByRole('button',{name:'Result peer',exact:true}).click();await text('#terminal-saved-output','PEER ONLY');releaseSavedCommand();releaseSavedCommand=null;await page.waitForFunction(id=>window.lastTerminalResultId===id,second);assert.equal(await page.locator('#terminal-saved-output').innerText(),'PEER ONLY');
  // Archived/read-only owner evidence remains inspectable; no execution control becomes writable.
  threads.get('result-peer').historyOnly=true;await page.locator('#refresh').click();await text('#thread-model','Recorded');assert(!await page.locator('#terminal-toggle').isDisabled());assert(await page.locator('#terminal-run').isDisabled());assert(await page.locator('#terminal-shell').isDisabled());await text('#terminal-saved-output','PEER ONLY');
  await page.getByRole('button',{name:'Saved chat',exact:true}).click();assert.deepEqual(await drafts(),original);await text('#terminal-saved-output','REFRESHED RESULT');
  const classifier=await page.evaluate(()=>{const good={op:'coding',input:{action:'terminalResults',threadId:'saved'}};return [codingTerminalResultsIndependent(good),codingTerminalResultsIndependent({...good,input:{...good.input,recordId:'33333333-3333-4333-8333-333333333333'}}),codingTerminalResultsIndependent({...good,input:{...good.input,extra:true}}),codingTerminalResultsIndependent({...good,input:{...good.input,recordId:'BAD'}}),codingTerminalResultsIndependent({...good,extra:true})];});assert.deepEqual(classifier,[true,true,false,false,false]);
  assert.equal(calls.filter(c=>c.input?.action==='terminalStart').length,1,'Only the explicitly clicked fixture live command starts; saved evidence never runs');assert(!calls.some(c=>['send','steer'].includes(c.input?.action)));
  holdSavedCommand='saved';releaseSavedCommand=null;await page.locator('#terminal-results').selectOption(second);await until(()=>releaseSavedCommand);const beforeClose=await page.locator('#terminal-saved-output').innerText();await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));releaseSavedCommand();releaseSavedCommand=null;await page.waitForFunction(id=>window.lastTerminalResultId===id,second);assert.equal(await page.locator('#terminal-saved-output').innerText(),beforeClose,'Page closure discards late detail');assert.deepEqual(errors,[]);
}

async function checkWorkspaceOrdering(rootThreadId) {
  const failures=[];
  for(const absent of [false,true]){
    const older={rootThreadId,state:absent?'waiting':'complete',message:absent?'OLDER_PENDING':'OLDER_COMPLETE',round:absent?4:2};
    workspaceSync.set(rootThreadId,older);holdEvents=true;releaseEvents=null;emit('coding/workspaceSync',copy(older));await until(()=>releaseEvents);const olderCursor=sequence;
    if(absent)workspaceSync.delete(rootThreadId);
    else {const newer={rootThreadId,state:'publishing',message:'NEWER_STATUS_PUBLISHING',round:3};workspaceSync.set(rootThreadId,newer);emit('coding/workspaceSync',copy(newer));}
    await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);
    if(absent)assert(!await page.locator('#send').isDisabled());else await text('#run-status','NEWER_STATUS_PUBLISHING');
    releaseEvents();await page.waitForFunction(cursor=>window.lastEventsCursor===cursor,olderCursor);
    try {if(absent){assert(!await page.locator('#send').isDisabled(),'Older pending event cannot resurrect a row removed by a newer status snapshot');assert(!(await page.locator('#run-status').innerText()).includes('OLDER_PENDING'));}
      else {assert.match(await page.locator('#run-status').innerText(),/NEWER_STATUS_PUBLISHING/,'Older completion cannot replace a newer round status snapshot');assert(await page.locator('#send').isDisabled());}}
    catch(error){failures.push(error);}
    await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);
  }
  assert.equal(failures.length,0,failures.map(error=>error.message).join('\n'));
}

async function checkWorkspaceSync() {
  const id='workspace-root', turn={id:'workspace-turn',status:'completed',items:[]};
  threads.set(id,{id,cwd:'/fixture/workspace',name:'Workspace fixture',archived:false,turns:[turn]});
  const childId='workspace-child';threads.set(childId,{id:childId,parentThreadId:id,cwd:'/fixture/workspace',name:'Workspace child',archived:false,turns:[],canAcceptDirectInput:false});
  const sync=(state,message,round=1,blocked)=>{const row={rootThreadId:id,state,message,round,...(blocked===undefined?{}:{blocked})};workspaceSync.set(id,row);emit('coding/workspaceSync',copy(row));};
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Workspace fixture',exact:true}).click();await text('#run-status','Turn finished');await page.locator('#prompt').fill('KEEP_WORKSPACE_DRAFT');
  const childSync={rootThreadId:childId,state:'waiting',message:'Waiting for workspace family identity.',round:1};workspaceSync.set(childId,childSync);emit('coding/workspaceSync',copy(childSync));await text('#run-status','Waiting for workspace family identity.');assert(await page.locator('#send').isDisabled(),'A child completion fences its already known family before root resolution');workspaceSync.delete(childId);
  sync('waiting','Waiting for active family work before saving workspace changes.');await text('#run-status','Waiting for active family work');
  for(const control of ['send','new-chat','fork-chat','review-changes','terminal-run','terminal-shell'])assert(await page.locator('#'+control).isDisabled(),control+' waits for workspace saving');
  assert(!await page.locator('#prompt').isDisabled(),'Draft remains editable');await page.locator('#prompt').fill('EDITED_WORKSPACE_DRAFT');assert(!await page.locator('#stop').isHidden());assert(!await page.locator('#stop').isDisabled(),'Stop remains available after raw completion');
  const before=calls.length;await page.evaluate(()=>{document.querySelector('#terminal-command').value='must not run';for(const id of ['composer','terminal-form'])document.querySelector('#'+id).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));for(const id of ['new-chat','fork-chat','review-changes','terminal-shell'])document.querySelector('#'+id).dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  await page.waitForTimeout(100);assert(!calls.slice(before).some(c=>['send','steer','start','fork','review','terminalStart'].includes(c.input?.action)),'Handler guards also fence new work');
  const activeTurn={id:'workspace-next-turn',status:'inProgress',items:[]};threads.get(id).turns.push(activeTurn);emit('turn/started',{threadId:id,turn:copy(activeTurn)});await text('#send','Steer');assert(await page.locator('#send').isDisabled());const steers=countAction('steer');await page.evaluate(()=>document.querySelector('#composer').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(countAction('steer'),steers);activeTurn.status='completed';emit('turn/completed',{threadId:id,turn:copy(activeTurn)});await text('#send','Send');await text('#run-status','Waiting for active family work');
  sync('publishing','Saving workspace changes.');await text('#run-status','Saving workspace changes.');assert(!await page.locator('#stop').isDisabled());
  sync('complete','Workspace changes saved.');await text('#run-status','Workspace changes saved.');assert(!await page.locator('#send').isDisabled());assert(await page.locator('#stop').isHidden());
  await checkWorkspaceOrdering(id);
  // An older status snapshot must not erase a newer event, including absent rows.
  workspaceSync.clear();holdStatus=true;releaseStatus=null;await page.locator('#refresh').click();await until(()=>releaseStatus);
  sync('publishing','Saving second workspace round.',2);await text('#run-status','Saving second workspace round.');releaseStatus();await until(()=>ordinaryActive===0);await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await text('#run-status','Saving second workspace round.');assert(await page.locator('#send').isDisabled());
  sync('failed','Workspace synchronization failed: fixture conflict <img src=x>.',2);await text('#run-status','fixture conflict');assert.equal(await page.locator('#run-status img').count(),0);assert(await page.locator('#send').isDisabled());
  assert(subtree(id).every(thread=>thread.turns.every(turn=>turn.status!=='inProgress'))&&!interactive&&!terminalActive&&!approvals.length,'Failed-save Stop fixture has no active turn, terminal or approval');assert(!await page.locator('#stop').isHidden(),'Idle failed save must offer parent Stop');assert(!await page.locator('#stop').isDisabled());
  failFamilyStop=true;holdInterruptReply=true;releaseInterruptReply=null;const failedStops=countAction('interruptFamily');await page.locator('#stop').click();await until(()=>releaseInterruptReply);assert.equal(countAction('interruptFamily'),failedStops+1);assert.equal(calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input.threadId,id);await text('#notice','Waiting for the engine to confirm');await text('#run-status','fixture conflict');assert(await page.locator('#send').isDisabled());assert(!await page.locator('#prompt').isDisabled());await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await text('#run-status','fixture conflict');assert(await page.locator('#send').isDisabled());releaseInterruptReply();await text('#notice','Fixture parent Stop failed');await text('#run-status','fixture conflict');assert(await page.locator('#send').isDisabled());assert(!await page.locator('#stop').isDisabled(),'Failed Stop does not remove the recovery control');await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await text('#run-status','fixture conflict');assert(await page.locator('#send').isDisabled(),'Retained failed owner status keeps the work fence after failed Stop');
  await page.getByRole('button',{name:'Workspace child',exact:true}).click();await text('#thread-title','Workspace child');assert.match(await page.locator('#stop').getAttribute('aria-label'),/Workspace fixture/);failFamilyStop=true;await page.locator('#stop').click();await text('#notice','Fixture parent Stop failed');assert.equal(calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input.threadId,id,'Failed workspace recovery from child targets parent');await text('#run-status','fixture conflict');await page.getByRole('button',{name:'Workspace fixture',exact:true}).first().click();assert.equal(await page.locator('#prompt').inputValue(),'EDITED_WORKSPACE_DRAFT');
  await page.reload();await text('#thread-title','Workspace fixture');await text('#run-status','fixture conflict');assert(await page.locator('#new-chat').isDisabled());assert.equal(await page.locator('#prompt').inputValue(),'EDITED_WORKSPACE_DRAFT');
  await page.getByRole('button',{name:'Saved chat',exact:true}).first().click();await page.locator('#prompt').fill('OTHER_FAMILY');assert(!await page.locator('#send').isDisabled(),'Another family remains usable');
  await page.getByRole('button',{name:'Workspace fixture',exact:true}).first().click();sync('complete','Workspace changes saved.',3);await text('#run-status','Workspace changes saved.');await page.locator('#terminal-toggle').click();await page.locator('#terminal-shell').click();await text('#pty-status','Keyboard input enabled');
  sync('waiting','Waiting for the active terminal before saving.',4);await text('#run-status','Waiting for the active terminal');assert(!await page.locator('#terminal-toggle').isDisabled());
  const inputCount=countAction('terminalInput'),resizeCount=countAction('terminalResize');await page.locator('.pty-view:not([inert]) .xterm-helper-textarea').focus();await page.keyboard.type('echo workspace');await until(()=>countAction('terminalInput')>inputCount);await page.setViewportSize({width:1100,height:900});await until(()=>countAction('terminalResize')>resizeCount);
  sync('failed','Workspace synchronization failed with a retained terminal.',4);await text('#run-status','retained terminal');const failedInput=countAction('terminalInput');await page.locator('.pty-view:not([inert]) .xterm-helper-textarea').focus();await page.keyboard.type('echo retained');await until(()=>countAction('terminalInput')>failedInput);
  const retainedMessage='Workspace save stopped. Stop the parent chat before continuing.';
  sync('cancelled',retainedMessage,4,true);await text('#run-status',retainedMessage);assert(await page.locator('#send').isDisabled(),'Consumed cancelled publication stays blocked');assert(!await page.locator('#prompt').isDisabled());const retainedInput=countAction('terminalInput');await page.locator('.pty-view:not([inert]) .xterm-helper-textarea').focus();await page.keyboard.type('echo cancelled');await until(()=>countAction('terminalInput')>retainedInput);
  approvals.push({id:'workspace-approval',method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:turn.id,command:'printf workspace',cwd:'/fixture/workspace'}});await text('#approvals','printf workspace');assert(!await page.locator('#approvals button[data-decision="accept"]').isDisabled());await page.locator('#approvals button[data-decision="decline"]').click();await until(()=>!approvals.length);
  assert(!await page.locator('#terminal-stop').isDisabled());await page.locator('#terminal-stop').click();await text('#pty-status','exited');
  // Cancellation can still dispatch while waiting after the last raw activity ended.
  sync('publishing','Saving final workspace round.',4);await text('#run-status','Saving final workspace round.');const stops=countAction('interruptFamily');await page.locator('#stop').click();await until(()=>countAction('interruptFamily')===stops+1);sync('cancelled','Workspace synchronization stopped.',4);await text('#run-status','Workspace synchronization stopped.');
  assert(!await page.locator('#send').isDisabled(),'Ordinary cancelled row without blocked remains nonblocking');sync('cancelled','Workspace synchronization stopped normally.',5,false);await text('#run-status','stopped normally');assert(!await page.locator('#new-chat').isDisabled(),'Explicit blocked:false is nonblocking');
  familyStopping.clear();workspaceSync.clear();await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);assert(!(await page.locator('#run-status').textContent()).includes('Workspace synchronization'));
  sync('cancelled',retainedMessage,6,true);await text('#run-status',retainedMessage);await page.reload();await text('#thread-title','Workspace fixture');await text('#run-status',retainedMessage);
  for(const control of ['send','new-chat','fork-chat','review-changes','terminal-run','terminal-shell'])assert(await page.locator('#'+control).isDisabled(),control+' remains fenced after retained cancellation reload');assert(!await page.locator('#prompt').isDisabled());assert(!await page.locator('#stop').isDisabled());
  await page.getByRole('button',{name:'Workspace child',exact:true}).click();await text('#thread-title','Workspace child');await text('#run-status',retainedMessage);assert.match(await page.locator('#stop').getAttribute('aria-label'),/Workspace fixture/,'Retained cancellation offers parent Stop from the child');const retainedStops=countAction('interruptFamily');await page.locator('#stop').click();await until(()=>countAction('interruptFamily')===retainedStops+1);assert.equal(calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input.threadId,id,'Stop targets the parent owner');await page.waitForFunction(root=>window.lastInterruptReply===root,id);
  familyStopping.clear();workspaceSync.clear();await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await page.getByRole('button',{name:'Workspace fixture',exact:true}).first().click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert(!await page.locator('#new-chat').isDisabled(),'Cleared owner row releases the workspace fence');assert.equal(await page.locator('#prompt').inputValue(),'EDITED_WORKSPACE_DRAFT');assert.deepEqual(errors,[]);
}

async function checkInteractiveTerminal() {
  threads.set('pty-chat',{id:'pty-chat',cwd:'/fixture/interactive',name:'Interactive fixture',archived:false,turns:[{id:'pty-history',status:'completed',items:[]}]});
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Interactive fixture',exact:true}).click();await page.locator('#prompt').fill('KEEP_PTY_DRAFT');await page.locator('#terminal-toggle').click();
  assert.equal(await page.locator('#terminal-shell').count(),1,'An explicit interactive shell action complements the legacy command panel');
  await page.locator('#terminal-command').fill('KEEP_COMMAND_DRAFT');cancelInteractive=true;await page.locator('#terminal-shell').click();assert.equal(interactive,null,'Cancelled start launches no process');
  await page.locator('#terminal-shell').click();await text('#pty-status','Keyboard input enabled');assert(await page.locator('#terminal-run').isDisabled());assert(await page.locator('#terminal-shell').isDisabled());
  const active=()=>page.locator('.pty-view:not([inert]) .xterm-helper-textarea');await active().focus();const n=countAction('terminalInput');await page.keyboard.type('echo مرحبا');await until(()=>countAction('terminalInput')>n);await page.keyboard.press('Escape');assert(await page.locator('#terminal-panel').isVisible(),'Focused terminal owns Escape');
  await page.keyboard.press('Control+Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'pty-follow','Documented shortcut leaves the terminal');
  for(const width of [1100,900,1360]){await page.setViewportSize({width,height:900});const layout=await page.evaluate(()=>{const rect=selector=>document.querySelector(selector).getBoundingClientRect();return {conversation:rect('.conversation').width,screen:rect('#pty-screen').width,sendRight:rect('#send').right,composerRight:rect('#composer').right};});assert(layout.conversation>=359,`Terminal leaves a usable conversation at ${width}px: ${JSON.stringify(layout)}`);assert(layout.screen>=240,'Terminal remains usable beside the conversation');assert(layout.sendRight<=layout.composerRight,'Send stays inside the composer');}
  interactive.inputGranted=false;await page.reload();await text('#thread-title','Interactive fixture');await page.locator('#terminal-toggle').click();await text('#pty-status','Read-only');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_PTY_DRAFT');assert.equal(await page.locator('#terminal-command').inputValue(),'KEEP_COMMAND_DRAFT');
  cancelAttach=true;await page.locator('#pty-attach').click();await text('#pty-status','Read-only');await page.locator('#pty-attach').click();await text('#pty-status','Keyboard input enabled');
  assert(!await page.locator('#stop').isHidden(),'A reattached terminal-only shell offers selected-chat Stop');assert(!await page.locator('#stop').isDisabled());assert.equal(await page.locator('#send').textContent(),'Send','A shell is not an active model turn');
  // Keep the event lane behind status/snapshot settlement across two terminal generations.
  holdEvents=true;releaseEvents=null;await until(()=>releaseEvents);
  const shellStops=countAction('interruptFamily'),steers=countAction('steer');await active().focus();const beforeStop=countAction('terminalInput');await page.locator('#stop').click();await text('#pty-status','exited');assert.equal(countAction('interruptFamily'),shellStops+1);assert.deepEqual(calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input,{action:'interruptFamily',threadId:'pty-chat'});await active().focus();await page.keyboard.type('blocked');assert.equal(countAction('terminalInput'),beforeStop);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_PTY_DRAFT');assert.equal(threads.get('pty-chat').turns[0].status,'completed','Terminal Stop preserves completed model history');await page.waitForFunction(()=>document.querySelector('#stop').hidden);
  assert(!JSON.stringify(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')))).includes('مرحبا'),'Interactive keystrokes are never persisted');assert.deepEqual(errors,[]);assert.equal(interactive.state,'exited','The old PTY remains in retained engine status');
  if(!await page.locator('#terminal-command-panel').evaluate(node=>node.open))await page.locator('#terminal-command-panel summary').click();await page.locator('#terminal-command').fill('printf selected-stop');await page.locator('#terminal-run').click();await text('#terminal-status','Running');assert(!await page.locator('#stop').isHidden(),'A terminal-only command offers selected-chat Stop');assert(!await page.locator('#stop').isDisabled());assert.equal(await page.locator('#send').textContent(),'Send');
  emit('coding/terminal/output',{threadId:terminalThreadId,processId:terminalProcessId,output:'SELECTED_STOP_FINAL_OUTPUT'});
  await page.locator('#terminal-input').fill('KEEP_SELECTED_STOP_INPUT');const commandStops=countAction('interruptFamily');await page.locator('#stop').click();
  await until(()=>countAction('interruptFamily')===commandStops+1&&!terminalActive);await page.waitForFunction(()=>document.querySelector('#stop').hidden);
  const stoppedCursor=sequence,latePTY=events.filter(event=>event.params.processId===interactive.processId&&['coding/terminal/updated','coding/terminal/completed'].includes(event.method));
  assert.deepEqual(latePTY.slice(-2).map(event=>event.params.state),['stopping','exited']);assert(await page.evaluate(cursor=>window.lastEventsCursor<cursor,latePTY.at(-2).sequence),'Old PTY events are still undelivered after the newer command stopped');
  releaseEvents();releaseEvents=null;await page.waitForFunction(cursor=>window.lastEventsCursor>=cursor,stoppedCursor);await text('#terminal-status','Stopped');await text('#terminal-output','SELECTED_STOP_FINAL_OUTPUT');
  assert.equal(countAction('interruptFamily'),commandStops+1);assert.deepEqual(calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input,{action:'interruptFamily',threadId:'pty-chat'});assert.equal(countAction('steer'),steers);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_PTY_DRAFT');assert.equal(await page.locator('#terminal-command').inputValue(),'printf selected-stop');assert.equal(await page.locator('#terminal-input').inputValue(),'KEEP_SELECTED_STOP_INPUT');await page.waitForFunction(()=>document.querySelector('#stop').hidden);
  // A later status response still contains the older exited PTY; it must not replace this result.
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#terminal-run').disabled);assert.equal(await page.locator('#terminal-status').innerText(),'Stopped');assert((await page.locator('#terminal-output').innerText()).includes('SELECTED_STOP_FINAL_OUTPUT'));assert.equal(await page.locator('#prompt').inputValue(),'KEEP_PTY_DRAFT');assert.equal(await page.locator('#terminal-command').inputValue(),'printf selected-stop');assert.equal(await page.locator('#terminal-input').inputValue(),'KEEP_SELECTED_STOP_INPUT');assert.deepEqual(errors,[]);interactive=null;
  await page.locator('#terminal-command').fill('printf delayed-stop');await page.locator('#terminal-run').click();await text('#terminal-status','Running');await page.locator('#terminal-input').fill('UNSENT_AFTER_STOP');await page.evaluate(()=>window.dispatchEvent(new Event('agent-stopped')));assert.equal(await page.locator('#terminal-status').innerText(),'Stop requested','Global Stop waits for legacy command completion instead of claiming exit');assert(await page.locator('#terminal-run').isDisabled());assert(await page.locator('#terminal-write').isDisabled(),'Stopping legacy commands reject further input');
  emit('coding/terminal/output',{threadId:terminalThreadId,processId:terminalProcessId,output:'LAST_OUTPUT_BEFORE_EXIT'});await text('#terminal-output','LAST_OUTPUT_BEFORE_EXIT');terminalActive=false;emit('coding/terminal/completed',{threadId:terminalThreadId,processId:terminalProcessId,exitCode:0});await text('#terminal-status','Exited · code 0');assert(!(await page.locator('#terminal-run').isDisabled()));await page.locator('#close-panel').click();
  // Both terminal paths share unread labels with turns; a terminal exit is only activity.
  threads.set('pty-child',{id:'pty-child',cwd:'/fixture/interactive',name:'Interactive child',parentThreadId:'pty-chat',archived:false,turns:[]});
  await page.locator('#refresh').click();
  for(const mode of ['legacy','pty']){
    await page.getByRole('button',{name:'Interactive child',exact:true}).click();await text('#thread-title','Interactive child');
    emit('coding/terminal/completed',{threadId:'pty-chat',processId:terminalProcessId,exitCode:0,...(mode==='pty'?{mode:'pty',state:'exited',revision:99}:{})});
    await text('.chat-row[data-thread-id="pty-chat"] .chat-status','Activity finished · unread');
    await text('.family-row[data-key="pty-chat"] .family-status','Activity finished · unread');
    await page.reload();await text('#thread-title','Interactive child');await text('.family-row[data-key="pty-chat"] .family-status','Activity finished · unread');
    await page.getByRole('button',{name:'Interactive fixture',exact:true}).first().click();await text('#thread-title','Interactive fixture');
    assert.equal(threads.get('pty-chat').turns.length,1,'Terminal events add no model turn');
  }

}

async function checkWorktreeLifecycle() {
  assert.equal(await page.locator('select#worktrees-view').count(),1,'Worktrees provide an accessible Active/Archived selector');
  const id='55555555-5555-4555-8555-555555555555',cwd='/fixture/managed/lifecycle',chatId='lifecycle-chat';
  const record={id,cwd,source:'/fixture/lifecycle-source',commit:'a'.repeat(40),head:'b'.repeat(40),createdAt:1,state:'ready',dirty:false,message:''};worktrees.push(record);
  threads.set(chatId,{id:chatId,cwd,name:'Lifecycle history',archived:false,modelProvider:'saleh_local',turns:[{id:'lifecycle-saved',status:'completed',items:[{id:'lifecycle-answer',type:'agentMessage',text:'ORIGINAL_LIFECYCLE_HISTORY'}]}]});
  const row=()=>page.locator(`[data-worktree-id="${id}"]`),wtCalls=action=>calls.filter(c=>c.op==='codingWorktrees'&&c.input.action===action),selected=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId);
  for(const [peer,path] of [['lifecycle-peer',record.source],['lifecycle-unrelated','/fixture/unrelated-lifecycle']])threads.set(peer,{id:peer,cwd:path,name:peer,archived:false,turns:[{id:peer+'-turn',status:'completed',items:[]}]});
  gitSnapshot(record.source).commonRepositoryId=gitSnapshot(cwd).commonRepositoryId;
  await page.reload();
  await page.locator('#refresh').click();
  for(const peer of ['lifecycle-peer','lifecycle-unrelated']){await page.getByRole('button',{name:peer,exact:true}).click();if(await page.locator('#changes-panel').isVisible())await page.locator('#refresh-changes').click();else await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');}
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Lifecycle history',exact:true}).click();await text('#messages','ORIGINAL_LIFECYCLE_HISTORY');await page.locator('#prompt').fill('KEEP_LIFECYCLE_DRAFT');await page.locator('#effort').selectOption('high');
  await page.locator('#terminal-toggle').click();await page.locator('#terminal-command').fill('printf keep-command');await page.locator('#terminal-input').fill('keep-stdin');
  await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');await openDetailsFor('#git-message');await page.locator('#git-message').fill('KEEP_LIFECYCLE_COMMIT');await openDetailsFor('#git-author-name');await page.locator('#git-author-name').fill('Fixture Author');await openDetailsFor('#git-author-email');await page.locator('#git-author-email').fill('fixture@example.invalid');await openDetailsFor('#git-branch-name');await page.locator('#git-branch-name').fill('feature/restore-text');await openDetailsFor('#git-switch-branch');await page.locator('#git-switch-branch').selectOption('feature/safe');
  await page.locator('#worktrees-toggle').click();await text('#worktrees-list',cwd);assert.equal(await page.locator('#worktrees-view').inputValue(),'active');
  assert.match(await row().innerText(),/This checkout has no local changes\./,'Ready refreshed checkout retains live Git status');
  const noAuto=()=>calls.filter(c=>c.op==='coding'&&['start','send','steer','review','fork','terminalStart','terminalWrite','archive','unarchive'].includes(c.input.action)).length,initialActions=noAuto();
  worktreeLifecycleOutcome='cancelled';await row().locator('[data-worktree-archive]').click();await text('#worktrees-notice','cancelled');assert.equal(await selected(),chatId);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_LIFECYCLE_DRAFT');
  await text('#git-status','refresh required');assert.equal(await page.locator('#git-message').inputValue(),'KEEP_LIFECYCLE_COMMIT');
  await page.getByRole('button',{name:'lifecycle-peer',exact:true}).click();await text('#git-status','refresh required');await page.getByRole('button',{name:'lifecycle-unrelated',exact:true}).click();await text('#git-status','snapshot;');await page.getByRole('button',{name:'Lifecycle history',exact:true}).click();await text('#messages','ORIGINAL_LIFECYCLE_HISTORY');
  await row().locator('[data-worktree-archive]').click();await text('#checkout-notice','archived');assert.equal(await row().count(),0,'Archived checkout leaves the Active list');await page.locator('#worktrees-view').selectOption('archived');await text('#worktrees-list',cwd);assert.equal(await row().locator('[data-worktree-open]').count(),0);
  assert.doesNotMatch(await row().innerText(),/This checkout has (?:no )?local changes\./,'Archived dirty:false is not a live clean-checkout claim');assert.match(await row().innerText(),/Restore the original checkout/,'Archived records explain retained recovery and restoration');
  for(const control of ['send','new-chat','fork-chat','review-changes','terminal-run','terminal-write','refresh-changes','git-commit'])assert(await page.locator('#'+control).isDisabled(),`Archived checkout disables ${control}`);
  assert(!(await page.locator('#prompt').isDisabled()),'Unsent text stays editable while the checkout is archived');await page.locator('#prompt').fill('EDITED_ARCHIVED_DRAFT');
  await page.evaluate(()=>{for(const form of ['composer','terminal-form','terminal-input-form','git-commit-form'])document.querySelector('#'+form).dispatchEvent(new Event('submit',{cancelable:true}));document.querySelector('#fork-chat').onclick();document.querySelector('#review-changes').onclick();});assert.equal(noAuto(),initialActions,'Archive and disabled handlers start no work and do not archive chats');
  await page.reload();await text('#messages','ORIGINAL_LIFECYCLE_HISTORY');await text('#checkout-notice','archived');assert.equal(await selected(),chatId);assert.equal(await page.locator('#prompt').inputValue(),'EDITED_ARCHIVED_DRAFT');assert.equal(await page.locator('#effort').inputValue(),'high');assert(await page.locator('#send').isDisabled());
  await page.locator('#terminal-toggle').click();assert.equal(await page.locator('#terminal-command').inputValue(),'printf keep-command');assert.equal(await page.locator('#terminal-input').inputValue(),'keep-stdin');
  await page.locator('#worktrees-toggle').click();await page.locator('#worktrees-view').selectOption('archived');await text('#worktrees-list',cwd);
  for(const outcome of ['cancelled','failed']){worktreeLifecycleOutcome=outcome;await row().locator('[data-worktree-restore]').click();await text('#worktrees-notice',outcome==='failed'?'occupied':'cancelled');assert.equal(await selected(),chatId);assert.equal(await page.locator('#prompt').inputValue(),'EDITED_ARCHIVED_DRAFT');await page.locator('#worktrees-refresh').click();}
  await row().locator('[data-worktree-restore]').click();await text('#worktrees-notice','restored');assert(await page.locator('#checkout-notice').isHidden());assert.equal(await selected(),chatId);assert.equal(noAuto(),initialActions);assert(!(await page.locator('#send').isDisabled()));
  await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');assert.equal(await page.locator('#git-message').inputValue(),'KEEP_LIFECYCLE_COMMIT');
  assert.equal(await page.locator('#git-author-name').inputValue(),'Fixture Author');assert.equal(await page.locator('#git-author-email').inputValue(),'fixture@example.invalid');assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/restore-text');assert.equal(await page.locator('#git-switch-branch').inputValue(),'','Restoration does not carry a branch switch selection or Git authority');
  const nextRepository=gitSnapshot(cwd).repositoryId+'-restored';await context.addInitScript(repository=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));p.gitDrafts[repository]={message:'NEWER_REPOSITORY_DRAFT'};localStorage.setItem('qwen-coding-ui-v1',JSON.stringify(p));},nextRepository);
  await page.locator('#worktrees-toggle').click();await page.locator('#worktrees-view').selectOption('active');await row().locator('[data-worktree-archive]').click();await text('#checkout-notice','archived');await page.reload();await text('#checkout-notice','archived');await page.locator('#worktrees-toggle').click();await page.locator('#worktrees-view').selectOption('archived');await row().locator('[data-worktree-restore]').click();await text('#worktrees-notice','restored');await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');assert.equal(await page.locator('#git-message').inputValue(),'NEWER_REPOSITORY_DRAFT','Restored text never overwrites a newer repository draft');assert.equal(await page.locator('#git-author-name').inputValue(),'');
  await page.locator('#worktrees-toggle').click();await page.locator('#worktrees-view').selectOption('active');
  // A worktree Stop also fences an older affected Git inspection, without changing unrelated Git epochs.
  worktreeBusy=true;await page.locator('#worktrees-refresh').click();await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');holdGit='inspect';releaseGit=null;await page.locator('#refresh-changes').click();await until(()=>releaseGit);
  await page.locator('#worktrees-toggle').click();await page.locator('#worktree-stop').click();await until(()=>wtCalls('stop').length>0);releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);await text('#git-status','refresh required');await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');
  // Queue archive behind a history read, then revoke before native dispatch.
  await page.locator('#worktrees-toggle').click();await page.locator('#worktrees-view').selectOption('active');
  for(const cancellation of ['scoped','tools-stopped','agent-stopped','pagehide']){
    await page.locator('#worktrees-refresh').click();heldReadThreadId=chatId;releaseRead=null;await page.getByRole('button',{name:'Lifecycle history',exact:true}).click();await until(()=>releaseRead);const before=wtCalls('archive').length;
    await row().locator('[data-worktree-archive]').click();await text('#worktree-stop','Stop worktree');
    if(cancellation==='scoped')await page.locator('#worktree-stop').click();else await page.evaluate(name=>window.dispatchEvent(new Event(name)),cancellation);
    releaseRead();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);assert.equal(wtCalls('archive').length,before,`${cancellation} fences queued lifecycle mutation`);assert.equal(await page.locator('#prompt').inputValue(),'EDITED_ARCHIVED_DRAFT');
  }
  await page.reload();await text('#thread-title','Lifecycle history');await page.locator('#worktrees-toggle').click();await text('#worktrees-list',cwd);
  // A late successful mutation reply cannot overwrite Stop's refreshed ledger state.
  worktreeLifecycleOutcome='stale-reply';holdWorktreeLifecycle=true;releaseWorktreeLifecycle=null;await row().locator('[data-worktree-archive]').click();await until(()=>releaseWorktreeLifecycle);
  await page.evaluate(()=>{window.staleArchivePaint=false;new MutationObserver(()=>{if(document.querySelector('#checkout-notice').textContent.includes('Checkout archived'))window.staleArchivePaint=true;}).observe(document.querySelector('#checkout-notice'),{childList:true,subtree:true,characterData:true});});
  await page.locator('#worktree-stop').click();releaseWorktreeLifecycle();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await until(()=>nativeActive===0);assert(await page.locator('#checkout-notice').isHidden());assert.equal(await page.evaluate(()=>window.staleArchivePaint),false,'Stopped response cannot briefly repaint an obsolete archive result');
  assert.equal(await selected(),chatId);assert.equal(await page.locator('#prompt').inputValue(),'EDITED_ARCHIVED_DRAFT');assert.equal(noAuto(),initialActions);
  worktreeLifecycleOutcome='unknown';await page.locator('#worktrees-view').selectOption('active');await row().locator('[data-worktree-archive]').click();await text('#worktrees-list','needs-inspection');await text('#checkout-notice','inspection');assert.equal(await selected(),chatId);assert.equal(await page.locator('#prompt').inputValue(),'EDITED_ARCHIVED_DRAFT');assert.equal(wtCalls('archive').at(-1).input.id,id);
  record.state='ready';record.message='';await page.locator('#worktrees-refresh').click();await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Lifecycle controls fit narrow layout');await page.setViewportSize({width:1360,height:900});assert.deepEqual(errors,[]);
}

async function checkWorktreeHandoff() {
  const id='66666666-6666-4666-8666-666666666666',rootId='handoff-root',source='/fixture/handoff-source',destination='/fixture/managed/handoff';
  const record={id,source,cwd:destination,commit:'a'.repeat(40),state:'ready',message:''};worktrees.push(record);
  for(const [chat,cwd,parent] of [[rootId,source,null],['handoff-child',source,rootId],['handoff-source-descendant',source+'/sub',null],['handoff-destination-descendant',destination+'/sub',null]])threads.set(chat,{id:chat,cwd,name:chat,parentThreadId:parent,archived:false,executionMode:'native',modelProvider:'saleh_local',turns:[{id:chat+'-turn',status:'completed',items:[{id:chat+'-answer',type:'agentMessage',text:'KEEP_HANDOFF_HISTORY'}]}]});
  const row=()=>page.locator('[data-worktree-id="'+id+'"]'),button=()=>row().locator('[data-worktree-handoff]'),selected=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId),moves=()=>calls.filter(c=>c.op==='codingWorktrees'&&c.input.action==='handoff'),noAuto=()=>calls.filter(c=>c.op==='coding'&&['start','send','steer','fork','archive','unarchive'].includes(c.input.action)||c.op==='codingWorktrees'&&c.input.action==='open').length;
  await page.reload();await page.locator('#refresh').click();await page.getByRole('button',{name:rootId,exact:true}).first().click();await text('#messages','KEEP_HANDOFF_HISTORY');await page.locator('#prompt').fill('KEEP_HANDOFF_DRAFT');await page.locator('#effort').selectOption('high');await page.locator('#worktrees-toggle').click();await text('#worktrees-list',destination);
  assert.equal(await button().count(),1,'Ready worktree exposes same-chat handoff');assert.equal(await button().innerText(),'Move this chat here');const before=noAuto();
  handoffOutcome='cancelled';await button().click();await text('#worktrees-notice','cancelled');assert.equal(await selected(),rootId);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');
  await button().click();await text('#worktrees-notice','Chat moved');assert.deepEqual(moves().at(-1).input,{action:'handoff',id,threadId:rootId});await text('#project-path',destination);assert.equal(await selected(),rootId);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');assert.equal(await page.locator('#effort').inputValue(),'high');assert.equal(await button().innerText(),'Move this chat back');assert.equal(threads.get('handoff-child').cwd,destination);assert.equal(noAuto(),before);
  await button().click();await text('#project-path',source);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');
  await page.getByRole('button',{name:'handoff-child',exact:true}).click();assert(await button().isDisabled(),'Child cannot move the family');await page.getByRole('button',{name:rootId,exact:true}).first().click();
  threads.get('handoff-child').turns[0].status='inProgress';emit('turn/started',{threadId:'handoff-child',turn:copy(threads.get('handoff-child').turns[0])});await page.waitForFunction(()=>document.querySelector('[data-worktree-handoff]')?.disabled);threads.get('handoff-child').turns[0].status='completed';emit('turn/completed',{threadId:'handoff-child',turn:copy(threads.get('handoff-child').turns[0])});await page.locator('#refresh').click();await page.waitForFunction(id=>!document.querySelector('[data-worktree-id="'+id+'"] [data-worktree-handoff]').disabled,id);
  holdHandoff=true;releaseHandoff=null;await button().click();await until(()=>releaseHandoff);await page.getByRole('button',{name:'Saved chat',exact:true}).click();releaseHandoff();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);assert.equal(await selected(),'saved','Late success preserves newer selection');await page.getByRole('button',{name:rootId,exact:true}).first().click();await text('#project-path',destination);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');
  heldReadThreadId='saved';releaseRead=null;const queuedTurn={id:'handoff-queue-turn',status:'completed',items:[]};threads.get('saved').turns=[queuedTurn];emit('turn/completed',{threadId:'saved',turn:copy(queuedTurn)});await until(()=>releaseRead);const queuedBefore=moves().length;await button().click();assert.equal(moves().length,queuedBefore,'Handoff waits behind ordinary metadata');await page.locator('#worktree-stop').click();releaseRead();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await page.waitForFunction(()=>document.querySelector('#worktree-stop').hidden);assert.equal(moves().length,queuedBefore,'Stop revokes queued handoff before native dispatch');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');
  handoffOutcome='failed';await button().click();await text('#worktrees-notice','retained');await text('#worktrees-list','git-files-publishing');await text('#worktrees-list','/fixture/recovery/<img');assert.equal(await page.locator('#worktrees-list img').count(),0);assert(await page.locator('#send').isDisabled());
  for(const chat of ['handoff-source-descendant','handoff-destination-descendant']){await page.getByRole('button',{name:chat,exact:true}).click();await text('#checkout-notice','needs inspection');assert(await page.locator('#send').isDisabled());}
  await page.getByRole('button',{name:rootId,exact:true}).first().click();
  handoffReadBlocked=true;const count=moves().length;
  const retainedPreferences=await page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return {drafts:p.drafts,efforts:p.efforts,pendingThreads:p.pendingThreads,handoffChats:p.handoffChats};});
  assert(!retainedPreferences.pendingThreads[rootId],'Retained handoff is not an unsent creation receipt');
  assert.equal(retainedPreferences.handoffChats[rootId].executionMode,undefined,'Cold placeholder has no verified execution mode');
  const retainedHistory=copy(threads.get(rootId));
  for(const failure of ['refused','missing','mismatch']) {
    handoffReadFailure=failure;const boundary=calls.length;
    await page.reload();await text('#checkout-notice','needs inspection');
    await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await until(()=>nativeActive===0);
    assert(calls.slice(boundary).some(c=>c.op==='coding'&&c.input.action==='read'&&c.input.threadId===rootId),failure+': history read actually reached its completed failure');
    assert.equal(await selected(),rootId);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');assert.equal(await page.locator('#effort').inputValue(),'high');
    assert.deepEqual(await page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return {drafts:p.drafts,efforts:p.efforts,pendingThreads:p.pendingThreads,handoffChats:p.handoffChats};}),retainedPreferences,failure+': all retained draft and handoff records remain exact');
    assert.deepEqual(threads.get(rootId),retainedHistory,failure+': refusal cannot mutate backend history');
    assert.equal(await page.locator('#messages .turn').count(),0,failure+': unavailable history is not fabricated');
    for(const control of ['prompt','send','fork-chat','review-changes','terminal-command','terminal-input','terminal-run','terminal-shell','terminal-write','refresh-changes'])assert(await page.locator('#'+control).isDisabled(),failure+': '+control+' remains fenced');
    assert(!calls.slice(boundary).some(c=>c.op==='coding'&&c.input.action==='mcpOutcomes'&&c.input.threadId===rootId),failure+': unverified metadata never grants outcome-read authority');
    assert.equal(moves().length,count,'Reload does not replay handoff');assert.equal(noAuto(),before);
    const messages=await page.locator('#messages').innerText(),mode=await page.locator('#thread-execution-mode').innerText(),outcomes=await page.locator('#coding-mcp-outcomes').innerText();
    assert(!messages.includes('Loading saved history'),failure+': a settled failed metadata read must not remain Loading saved history');
    assert.match(messages,/could not be checked|history (?:is )?unavailable/i,failure+': terminal history failure is explicit');
    assert(!/Virtual machine/i.test(mode),failure+': unknown execution mode must not be labeled Virtual machine');
    assert.match(mode,/unavailable|unknown|unverified|checking/i,failure+': no execution identity is invented');
    assert.match(await page.locator('#run-status').innerText(),/refresh|unavailable|could not|unverified|failed/i,failure+': run status records a settled failure');
    assert.match(await page.locator('#model-status').innerText(),/could not|unavailable|unverified|failed/i,failure+': model status records a settled failure');
    assert(!outcomes.includes('Checking chat history'),failure+': settled failure must not leave outcome history checking');
    assert.match(outcomes,/unavailable|could not|cannot/i,failure+': outcomes are explicitly unavailable');
    await page.setViewportSize({width:390,height:844});assert(await page.locator('#composer-hint').isVisible(),failure+': narrow history recovery guidance stays visible');assert.equal(await page.locator('#composer-hint').innerText(),'Refresh history to check this chat');await page.setViewportSize({width:1360,height:900});
  }
  handoffReadFailure='refused';
  handoffReadBlocked=false;handoffs.length=0;record.state='ready';threads.get(rootId).archived=false;await page.locator('#refresh').click();await page.locator('#worktrees-toggle').click();await page.locator('#worktrees-refresh').click();
  if(process.argv.includes('--handoff-loading-only')){await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await text('#messages','KEEP_HANDOFF_HISTORY');await text('#thread-execution-mode','Native macOS');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');assert(!(await page.locator('#messages').innerText()).includes('Saved history could not be checked'));assert.deepEqual(errors,[]);return;}
  handoffOutcome='late';holdHandoff=true;releaseHandoff=null;await button().click();await until(()=>releaseHandoff);await page.locator('#worktree-stop').click();releaseHandoff();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await text('#checkout-notice','needs inspection');assert.equal(await page.locator('#project-path').innerText(),destination,'Stopped late success cannot change local chat path');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');assert.equal(noAuto(),before);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('tools-stop-result',{detail:{stopped:false,message:'Unmatched stale receipt.'}})));assert.equal(await page.locator('#notice').textContent(),'','A global Stop receipt requires its preceding Stop request');
  await page.evaluate(()=>{window.dispatchEvent(new Event('tools-stopped'));window.dispatchEvent(new CustomEvent('tools-stop-result',{detail:{stopped:false,message:'Selected exit remains unconfirmed.'}}));});await text('#worktrees-notice','Stop could not be confirmed');await text('#notice','Stop could not be confirmed');assert(await page.locator('#send').isDisabled());
  await page.evaluate(()=>{window.dispatchEvent(new Event('tools-stopped'));window.dispatchEvent(new CustomEvent('tools-stop-result',{detail:{stopped:true,message:'Selected process exit verified.'}}));});await text('#worktrees-notice','Stop confirmed');assert(await page.locator('#send').isDisabled(),'A Stop receipt cannot clear retained recovery');
  for(const event of ['tools-stopped','agent-stopped','pagehide']){
    handoffs.length=0;record.state='ready';await page.reload();await text('#thread-title',rootId);await page.locator('#worktrees-toggle').click();await text('#worktrees-list',destination);
    const before=moves().length;handoffOutcome='late';holdHandoff=true;releaseHandoff=null;await button().click();await until(()=>releaseHandoff);await page.evaluate(name=>window.dispatchEvent(new Event(name)),event);releaseHandoff();await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await page.locator('#worktrees-refresh').click();await text('#checkout-notice','needs inspection');assert.equal(moves().length,before+1,event+' cannot replay handoff');assert.equal(await selected(),rootId);assert.equal(await page.locator('#project-path').innerText(),destination);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_HANDOFF_DRAFT');
  }
  for(const width of [650,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Handoff recovery fits narrow viewport');}await page.setViewportSize({width:1360,height:900});assert.deepEqual(errors,[]);
  handoffs.length=0;record.state='ready';threads.get(rootId).archived=false;await page.reload();await text('#thread-title',rootId);
}

async function checkRecoveryCopy() {
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',retained={id,worktreeId:'copy-worktree',rootThreadId:'saved',source:'/fixture/older',destination:'/fixture/managed-copy',recoveryDirectory:'/fixture/retained-copy',phase:'family-resume-intent',state:'needs-inspection',message:'Retained original handoff'};
  recoveryCopyReadOnly=true;handoffs.push(copy(retained));await page.reload();await text('#thread-title','Saved chat');await page.waitForFunction(()=>!document.querySelector('#prompt').disabled);await page.locator('#prompt').fill('KEEP_COPY_DRAFT');
  await page.locator('#worktrees-toggle').click();await text('#worktrees-list','Retained original handoff');const row=()=>page.locator('[data-handoff-id="'+id+'"]'),button=()=>row().locator('[data-handoff-copy]');
  assert(await row().locator('[data-handoff-recovery="restore"]').isDisabled());assert(await row().locator('[data-handoff-recovery="finish"]').isDisabled());assert(await button().isEnabled());
  const state=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return {selectedId:p.selectedId,drafts:p.drafts,attachmentDrafts:p.attachmentDrafts,handoffChats:p.handoffChats,ordinary:localStorage.getItem('qwen-local-chats-v1')};}),prior=await state(),sends=countAction('send'),starts=countAction('start');
  for(const outcome of ['cancelled','failed','success']){recoveryCopyOutcome=outcome;await button().click();await text('#worktrees-notice',outcome==='cancelled'?'cancelled':outcome==='failed'?'donor changed':'Recovered project copy:');await page.waitForFunction(()=>!document.querySelector('[data-handoff-copy]').disabled);assert.deepEqual(await state(),prior);assert.equal(await row().count(),1);assert.deepEqual(handoffs,[retained]);}
  for(const key of ['target','handoffId','receiptPath','independent','originalRecoveryComplete','files','extra']){recoveryCopyCorrupt=r=>r.copy[key]=null;await button().click();await text('#worktrees-notice','could not be verified');await page.waitForFunction(()=>!document.querySelector('[data-handoff-copy]').disabled);assert.deepEqual(await state(),prior);}recoveryCopyCorrupt=null;
  recoveryCopyOutcome='failed';holdRecovery=true;releaseRecovery=null;await button().click();await until(()=>releaseRecovery);await page.locator('#worktree-stop').click();releaseRecovery();await page.waitForFunction(()=>!document.querySelector('[data-handoff-copy]').disabled);await text('#worktrees-notice','Stop could not be confirmed');assert.deepEqual(await state(),prior);assert.equal(countAction('send'),sends);assert.equal(countAction('start'),starts);assert.equal(await row().count(),1);
  for(const width of [390,650,1360]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  assert.deepEqual(errors,[]);
}

async function checkHandoffRecovery() {
  const id='88888888-8888-4888-8888-888888888888',worktreeId='99999999-9999-4999-8999-999999999999',root='recovery-root',child='recovery-child',leaf='recovery-leaf',source='/fixture/recovery-source',destination='/fixture/recovery-destination';
  const record={id:worktreeId,source,cwd:destination,commit:'a'.repeat(40),state:'needs-inspection',message:''};worktrees.push(record);
  const retained={id,worktreeId,rootThreadId:root,source,destination,phase:'family-resuming',state:'needs-inspection',message:'Interrupted recovery retained.',recoveryDirectory:'/fixture/retained/<img src=x onerror=alert(1)>'};
  recoveryFamily={rootThreadId:root,cwd:source,model:fixtureModel,modelProvider:'saleh_local',fingerprint:'a'.repeat(64),members:[
    {id:root,parentThreadId:null,archived:false},{id:child,parentThreadId:root,archived:true},{id:leaf,parentThreadId:child,archived:false}
  ].map(m=>({...m,cwd:source,model:fixtureModel,modelProvider:'saleh_local',lastTurnId:m.id+'-turn',compatibility:{version:1,headerHash:'b'.repeat(64),identity:{dev:'1',ino:'2'}}}))};
  for(const member of recoveryFamily.members)threads.set(member.id,{...copy(member),name:member.id,turns:[{id:member.id+'-turn',status:'completed',items:[{id:member.id+'-answer',type:'agentMessage',text:'KEEP_RECOVERY_HISTORY '+member.id}]}]});
  for(const [chat,cwd] of [['recovery-source-descendant',source+'/sub'],['recovery-destination-descendant',destination+'/sub']])threads.set(chat,{id:chat,cwd,name:chat,archived:false,turns:[{id:chat+'-turn',status:'completed',items:[]}]});
  const row=()=>page.locator('[data-handoff-id="'+id+'"]'),button=mode=>row().locator('[data-handoff-recovery="'+mode+'"]'),prefs=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1'))),recoveries=()=>calls.filter(c=>c.op==='codingWorktrees'&&c.input.action==='recoverHandoff');
  const noAuto=()=>calls.filter(c=>c.op==='coding'&&['start','send','steer','fork','archive','unarchive','review','approval','terminalStart','terminalAttach','terminalInput','terminalWrite'].includes(c.input.action)||c.op==='codingWorktrees'&&c.input.action==='open'||c.op==='codingSchedules'&&c.input.action!=='list'||c.op==='codingGit'&&!['inspect','stop'].includes(c.input.action)).length;
  const seed=async(selection=root,placeholder=false)=>{
    handoffs.splice(0,handoffs.length,copy(retained));record.state='needs-inspection';handoffReadBlocked=placeholder;
    for(const m of recoveryFamily.members){const t=threads.get(m.id);t.cwd=m.id===root?source:destination;t.archived=m.id===root||m.id===leaf;}
    await page.evaluate(({selection,root,child,leaf,source,destination})=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));p.selectedId=selection;for(const id of [root,child,leaf,'saved']){p.drafts[id]='DRAFT '+id;p.efforts[id]='high';p.terminalDrafts[id]={command:'COMMAND '+id,input:'STDIN '+id};}p.handoffChats[root]={cwd:source,source,destination,name:root,modelProvider:'saleh_local',uncertain:true};sessionStorage.setItem('coding-fixture-preferences',JSON.stringify(p));},{selection,root,child,leaf,source,destination});
    await page.reload();await text('#thread-title',selection==='saved'?'Saved chat':selection);await page.locator('#worktrees-toggle').click();await text('#worktrees-list','Interrupted recovery');
  };
  const settle=()=>page.waitForFunction(()=>!document.querySelector('#new-project').disabled);
  const assertKept=async selected=>{const p=await prefs();assert.equal(p.selectedId,selected);for(const id of [root,child,leaf,'saved']){assert.equal(p.drafts[id],'DRAFT '+id);assert.equal(p.efforts[id],'high');assert.deepEqual(p.terminalDrafts[id],{command:'COMMAND '+id,input:'STDIN '+id});}assert.equal(noAuto(),initialAuto);};
  await seed();const initialAuto=noAuto();assert.equal(await button('restore').count(),1,'Retained handoff exposes Review restore');assert.equal(await button('finish').count(),1,'Retained handoff exposes Review finish');assert.equal(await button('restore').innerText(),'Review restore');assert.equal(await button('finish').innerText(),'Review finish');assert(!await button('restore').isDisabled(),'Archived root and unavailable checkout may request review');
  assert.equal(await page.locator('#worktrees-list img').count(),0);
  for(const mode of ['restore','finish']){
    for(const outcome of ['cancelled','refused']){recoveryOutcome=outcome;await button(mode).click();await text('#worktrees-notice',outcome==='cancelled'?'cancelled':'unconfirmed');await settle();assert.equal((await prefs()).handoffChats[root].uncertain,true);assert.equal(await row().count(),1);await assertKept(root);}
    await seed(root,true);await button(mode).click();await text('#worktrees-notice',mode==='restore'?'Handoff restored':'Handoff finished');await settle();assert.deepEqual(recoveries().at(-1).input,{action:'recoverHandoff',id,mode});await text('#project-path',mode==='restore'?source:destination);await text('#messages','KEEP_RECOVERY_HISTORY');assert.equal((await prefs()).handoffChats[root].uncertain,false);assert.equal(threads.get(child).archived,true,'Original reviewed archive flags replace mixed cache');assert.equal(threads.get(leaf).archived,false);assert.equal(await row().count(),0);await assertKept(root);assert.equal(threads.get(root).model,fixtureModel,'Recovery retains its reviewed available model');assert(await page.locator('#send').isEnabled(),'Verified recovery permits a later explicit Send');
    handoffReadBlocked=false;await page.reload();await text('#project-path',mode==='restore'?source:destination);await assertKept(root);
    await seed();
  }
  failWorktreeList=true;await page.locator('#worktrees-refresh').click();await text('#worktrees-notice','Managed list unavailable');assert(await button('restore').isDisabled());assert(await button('finish').isDisabled());await page.locator('#worktrees-refresh').click();await settle();
  for(const chat of ['recovery-source-descendant','recovery-destination-descendant']){await seed(chat);await page.locator('#prompt').fill('UNSENT DESCENDANT');recoveryOutcome='cancelled';await button('restore').click();await settle();for(const control of ['send','fork-chat','review-changes','terminal-shell','terminal-run','refresh-changes'])assert(await page.locator('#'+control).isDisabled(),control+' stays fenced at '+chat);assert.equal(await page.locator('#prompt').inputValue(),'UNSENT DESCENDANT');}
  await seed();
  // A valid reply retains already-rendered history if a later history refresh fails.
  threads.get(root).archived=false;await page.locator('#refresh').click();await settle();await text('#messages','KEEP_RECOVERY_HISTORY');failReadOnce=true;await button('restore').click();await text('#worktrees-notice','metadata refresh is unavailable');await settle();await text('#messages','KEEP_RECOVERY_HISTORY');await assertKept(root);assert.equal((await prefs()).handoffChats[root].uncertain,true,'Unavailable refresh retains the checkout fence');
  // Native reviewed membership is authoritative even while a different chat is selected.
  await seed();holdRecovery=true;releaseRecovery=null;await button('finish').click();await until(()=>releaseRecovery);await page.getByRole('button',{name:'recovery-source-descendant',exact:true}).click();await text('#checkout-notice','Both checkouts');await page.getByRole('button',{name:'Saved chat',exact:true}).click();releaseRecovery();await text('#worktrees-notice','Handoff finished');await settle();await assertKept('saved');assert.equal(await page.locator('#prompt').inputValue(),'DRAFT saved');
  // Recovering either checkout invalidates both cached Git inspections while unrelated text/state stays usable.
  for(const name of ['recovery-source-descendant','recovery-destination-descendant','Saved chat']){await page.getByRole('button',{name,exact:true}).click();if(!await page.locator('#changes-panel').isVisible())await page.locator('#changes-toggle').click();else await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await openDetailsFor('#git-message');await page.locator('#git-message').fill('GIT '+name);}
  handoffs.push(copy(retained));await page.locator('#worktrees-toggle').click();await text('#worktrees-list','Interrupted recovery');await button('restore').click();await text('#worktrees-notice','Handoff restored');await settle();
  for(const name of ['recovery-source-descendant','recovery-destination-descendant','Saved chat']){await page.getByRole('button',{name,exact:true}).click();await text('#git-status',name==='Saved chat'?'snapshot;':'refresh required');assert.equal(await page.locator('#git-message').inputValue(),'GIT '+name);}await assertKept('saved');
  const malformed=[r=>r.handoff.id=worktreeId,r=>r.handoff.rootThreadId='saved',r=>r.handoff.source=destination,r=>r.handoff.destination=source,r=>r.handoff.mode='finish',r=>r.handoff.target=destination,r=>r.handoff.state='pending',r=>r.family.cwd=destination,r=>r.family.members.push(copy(r.family.members[0])),r=>r.family.members[1].cwd=destination,r=>r.family.members[1].archived=1,r=>r.family.members[1].parentThreadId=r.family.members[1].id,r=>r.family.members[0].id='other-root',r=>r.family.members[0].turns=[],r=>r.family.members=[]];
  for(const corrupt of malformed){await seed();recoveryCorrupt=corrupt;await button('restore').click();await text('#worktrees-notice','could not be verified');await settle();assert.equal((await prefs()).handoffChats[root].uncertain,true);assert.equal(await row().count(),1);await text('#project-path',source);await assertKept(root);}
  await seed();recoveryCorrupt=r=>{handoffs.length=0;record.state='ready';r.handoff.mode='finish';};await button('restore').click();await text('#worktrees-notice','could not be verified');await settle();assert.equal((await prefs()).handoffChats[root].uncertain,true,'Malformed reply cannot clear uncertainty through an absent retained row');assert(await page.locator('#send').isDisabled());await assertKept(root);
  // Stop during the post-success history refresh also keeps the fence and suppresses success.
  await seed();heldReadThreadId=root;releaseRead=null;await button('restore').click();await until(()=>releaseRead);await page.locator('#worktree-stop').click();releaseRead();await settle();assert.equal((await prefs()).handoffChats[root].uncertain,true);assert(!/Handoff restored/.test(await page.locator('#worktrees-notice').innerText()));await assertKept(root);
  // Scoped/global cancellation revokes queued dispatch, and invalidates late replies.
  for(const cancellation of ['scoped','tools-stopped','agent-stopped','pagehide']){
    await seed();heldReadThreadId='saved';releaseRead=null;await page.getByRole('button',{name:'Saved chat',exact:true}).click();await until(()=>releaseRead);const before=recoveries().length;await button('restore').click();
    if(cancellation==='scoped')await page.locator('#worktree-stop').click();else await page.evaluate(name=>window.dispatchEvent(new Event(name)),cancellation);
    releaseRead();await settle();assert.equal(recoveries().length,before,cancellation+' revokes queued recovery');assert.equal((await prefs()).handoffChats[root].uncertain,true);await assertKept('saved');
    await seed();holdRecovery=true;releaseRecovery=null;recoveryOutcome='late';await button('finish').click();await until(()=>releaseRecovery);
    await page.evaluate(()=>{window.recoverySuccessPaint=false;new MutationObserver(()=>{if(/Handoff (restored|finished)/.test(document.querySelector('#worktrees-notice').textContent))window.recoverySuccessPaint=true;}).observe(document.querySelector('#worktrees-notice'),{childList:true,subtree:true,characterData:true});});
    // Simulate a stale list losing the retained row: the in-flight pair still fences descendants.
    handoffs.length=0;worktreeBusy=true;
    for(const chat of ['recovery-source-descendant','recovery-destination-descendant']){await page.getByRole('button',{name:chat,exact:true}).click();assert(await page.locator('#send').isDisabled());assert(await page.locator('#fork-chat').isDisabled());assert(await page.locator('#review-changes').isDisabled());}
    if(cancellation==='scoped')await page.locator('#worktree-stop').click();else await page.evaluate(name=>window.dispatchEvent(new Event(name)),cancellation);
    releaseRecovery();await settle();worktreeBusy=false;assert.equal(await page.evaluate(()=>window.recoverySuccessPaint),false,'Late success never paints after '+cancellation);assert.equal((await prefs()).handoffChats[root].uncertain,true);await assertKept('recovery-destination-descendant');
    await page.evaluate(()=>{window.dispatchEvent(new Event('tools-stopped'));window.dispatchEvent(new CustomEvent('tools-stop-result',{detail:{stopped:true,message:'Fixture process exit verified'}}));});assert.equal((await prefs()).handoffChats[root].uncertain,true,'Stop confirmation alone cannot clear recovery');
  }
  await seed();for(const width of [650,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Recovery review actions fit narrow viewport');}await page.setViewportSize({width:1360,height:900});assert.deepEqual(errors,[]);
  handoffs.length=0;record.state='ready';handoffReadBlocked=false;for(const id of [root,child,leaf,'recovery-source-descendant','recovery-destination-descendant'])threads.delete(id);await page.evaluate(root=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));delete p.handoffChats[root];p.selectedId='saved';sessionStorage.setItem('coding-fixture-preferences',JSON.stringify(p));},root);await page.reload();await text('#thread-title','Saved chat');
}

async function checkApprovalValidation() {
  const valid={id:'validated-approval',method:'item/commandExecution/requestApproval',params:{threadId:'saved',turnId:'validation-turn',command:'cat valid-sibling.txt',cwd:'/fixture/older'}};
  approvals.push({}, {}, valid, copy(valid));
  await text('#approvals','cat valid-sibling.txt');
  assert.equal(await page.locator('#approvals .approval').count(),1,'Malformed and duplicate records never create actionable approval cards');
  await text('#approval-notice','3 approval records were omitted');
  assert(!(await page.locator('#approvals').innerText()).includes('undefined'));
  assert.equal(countAction('approval'),0,'Validation never resolves a request automatically');
  await page.reload();await text('#thread-title','Saved chat');await text('#approval-notice','3 approval records were omitted');
  assert.equal(await page.locator('#approvals .approval').count(),1,'Startup uses the same approval validation as polling');
  const turn={id:'validation-turn',status:'inProgress',items:[]};threads.get('saved').turns.push(turn);emit('turn/started',{threadId:'saved',turn:copy(turn)});
  emit('item/agentMessage/delta',{threadId:'saved',turnId:turn.id,itemId:'validation-answer',delta:'VALIDATION_STREAM_CONTINUES'});
  await text('#messages','VALIDATION_STREAM_CONTINUES');
  await page.getByRole('button',{name:'Review once',exact:true}).click();
  assert.deepEqual(calls.filter(call=>call.input?.action==='approval').at(-1).input,{action:'approval',id:valid.id,decision:'accept'},'Only the valid sibling reaches native review');
  approvals.splice(0);await page.waitForFunction(()=>document.querySelector('#approvals').hidden);
  threads.get('saved').turns=[];calls.splice(calls.findIndex(call=>call.input?.action==='approval'),1);
  await page.reload();await text('#thread-title','Saved chat');assert.deepEqual(errors,[]);
}
async function checkBranchSwitching(gitCalls) {
  const choose=async(name)=>{await page.getByRole('button',{name,exact:true}).click();await text('#thread-title',name);};
  const refresh=async()=>{await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');};
  const original=gitSnapshot('/fixture/older');
  threads.set('git-same',{id:'git-same',cwd:'/fixture/older',name:'Same checkout',turns:[],archived:false});
  threads.set('git-linked',{id:'git-linked',cwd:'/fixture/linked',name:'Linked checkout',turns:[],archived:false});
  gitSnapshot('/fixture/linked').commonRepositoryId=original.commonRepositoryId;
  await page.locator('#refresh').click();await refresh();
  for(const name of ['Same checkout','Linked checkout','Other Git']){await choose(name);await refresh();}
  await choose('Saved chat');
  const picker=page.locator('#git-switch-branch');assert(await picker.locator('option[value="fixture-branch"]').isDisabled());assert(await picker.locator('option[value="feature/elsewhere"]').isDisabled());
  const before=gitCalls('switchBranch').length;await openDetailsFor('#git-switch-branch');await picker.selectOption('feature/safe');assert.equal(gitCalls('switchBranch').length,before,'Selection does not dispatch a branch switch');
  for(const outcome of ['stale','failed','unknown','cancelled']){
    gitOutcome=outcome;await openDetailsFor('#git-switch');await page.locator('#git-switch').click();await text('#git-notice',outcome);assert.equal(await picker.inputValue(),'feature/safe');assert.equal(await page.locator('#git-message').inputValue(),'PERSIST_GIT_TEXT');assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/persist');assert.equal(await page.locator('#prompt').inputValue(),'GIT_CHAT_DRAFT');assert(await page.locator('#git-switch').isDisabled());
    if(outcome==='stale'){for(const name of ['Same checkout','Linked checkout']){await choose(name);await text('#git-status','refresh required');}await choose('Other Git');await text('#git-status','snapshot;');await choose('Saved chat');}
    await refresh();
  }
  holdGit='switchBranch';releaseGit=null;await openDetailsFor('#git-switch');await page.locator('#git-switch').click();await until(()=>releaseGit);await choose('Linked checkout');await text('#git-status','refresh required');releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);await text('#git-status','refresh required');
  await choose('Saved chat');await text('#git-branch','feature/safe');assert.equal(gitCalls('switchBranch').at(-1).input.name,'feature/safe');assert(await page.locator('#git-switch').isDisabled(),'The newly current branch cannot be switched to again');assert.equal(await page.locator('#git-message').inputValue(),'PERSIST_GIT_TEXT');assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/persist');
  await openDetailsFor('#git-switch-branch');await picker.selectOption('fixture-branch');await page.reload();await text('#thread-title','Saved chat');await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');assert.equal(await picker.inputValue(),'fixture-branch','Target is draft text across restart, never a grant');assert.equal(gitCalls('switchBranch').length,before+5,'Reload never dispatches a switch');
  const branches=original.branches;original.branches=[];original.branchWarning='Branch inventory is incomplete; refresh to retry.';await refresh();await text('#git-branch-warning','incomplete');assert(await page.locator('#git-switch').isDisabled());await page.locator('#git-paths input[data-entry-id="mixed"]').check();assert(!(await page.locator('#git-stage').isDisabled()),'Unavailable branches do not disable reviewed file actions');assert.equal(await picker.inputValue(),'fixture-branch','Unavailable saved target is retained without authority');original.branches=branches;delete original.branchWarning;await refresh();
  for(const name of ['Same checkout','Linked checkout']){await choose(name);await refresh();}await choose('Saved chat');
  holdGit='switchBranch';releaseGit=null;gitStopOutcome='unknown';await openDetailsFor('#git-switch');await page.locator('#git-switch').click();await until(()=>releaseGit);await openDetailsFor('#git-stop');await page.locator('#git-stop').click();await text('#git-notice','process exit is unconfirmed');releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);await text('#git-notice','process exit is unconfirmed');assert.equal(await picker.inputValue(),'fixture-branch');assert.equal(await page.locator('#git-message').inputValue(),'PERSIST_GIT_TEXT');
  for(const name of ['Same checkout','Linked checkout']){await choose(name);await text('#git-status','refresh required');}
  await choose('Saved chat');threads.delete('git-same');threads.delete('git-linked');
}
async function openDetailsFor(selector){
  const disclosure=page.locator(selector).locator('xpath=ancestor::details[1]');
  if(await disclosure.count()&&await disclosure.getAttribute('open')===null)await disclosure.locator('summary').first().click();
}
async function checkGitPublishingCap(){
  const fixture=gitSnapshot('/fixture/older');fixture.remotes=[{name:'origin',supported:true,host:'github.com',owner:'fixture',repo:'repo',fullName:'fixture/repo',url:'https://github.com/fixture/repo.git'}];fixture.remoteReceipts=[];
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).publishDrafts);assert.equal(Object.keys(before).length,128);
  await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');await openDetailsFor('#git-remote');await page.locator('#git-remote-check').click();await text('#git-notice','128');assert(await page.locator('#git-pr-title').isDisabled(),'A full draft map must refuse a new editable slot before text can be lost');
  await page.locator('#git-publish-branch').fill('another-new-target');await page.locator('#git-remote-check').click();await text('#git-notice','128');assert(await page.locator('#git-pr-body').isDisabled());assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).publishDrafts),before);assert.deepEqual(errors,[]);
}
async function checkGitPublishing(){
  const fixture=gitSnapshot('/fixture/older');fixture.remotes=[{name:'origin',supported:true,host:'github.com',owner:'fixture',repo:'repo',fullName:'fixture/repo',url:'https://github.com/fixture/repo.git'},{name:'unsafe',supported:false,reason:'Unsupported URL'}];fixture.remoteReceipts=[];
  const remoteCalls=action=>calls.filter(row=>row.op==='codingGit' && row.input.action===action);
  const target=async()=>{await page.locator('#git-remote-check').click();await text('#git-notice','target checked');};
  const fresh=async()=>{await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await target();};
  await page.locator('#prompt').fill('KEEP_PUBLISH_CHAT_DRAFT');await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');assert.equal(await page.locator('#git-publish-panel').getAttribute('open'),null);await openDetailsFor('#git-remote');assert.equal(remoteCalls('remoteInspect').length,0,'Opening Changes never authenticates or reads a remote');
  assert(await page.locator('#git-remote option[value="unsafe"]').isDisabled());await target();assert.match(await page.locator('#git-remote-status').innerText(),/fixture · fixture\/repo/);
  await page.locator('#git-pr-title').fill('Original draft');await page.locator('#git-pr-body').fill('KEEP_BODY <img src=x onerror=alert(1)>');
  const key=await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).publishDrafts)[0]);assert.match(key,/^[a-f0-9]{64}$/);
  await page.locator('#git-publish-branch').fill('feature/other');assert.equal(await page.locator('#git-pr-title').inputValue(),'');assert(await page.locator('#git-pr-body').isDisabled());await target();await page.locator('#git-pr-title').fill('Other target');await page.locator('#git-pr-body').fill('OTHER_BODY');
  await page.locator('#git-publish-branch').fill('fixture-branch');await target();assert.equal(await page.locator('#git-pr-title').inputValue(),'Original draft');assert.match(await page.locator('#git-pr-body').inputValue(),/^KEEP_BODY/);
  await openDetailsFor('#git-message');await page.locator('#git-message').fill('KEEP_COMMIT_TOO');await openDetailsFor('#git-remote');
  const checks=remoteCalls('remoteInspect').length;await page.reload();await text('#thread-title','Saved chat');await page.locator('#changes-toggle').click();await text('#git-status','snapshot;');await openDetailsFor('#git-remote');assert.equal(remoteCalls('remoteInspect').length,checks);assert.equal(await page.locator('#git-pr-title').inputValue(),'Original draft');assert(await page.locator('#git-publish').isDisabled());
  await target();const pushes=remoteCalls('publishBranch').length;await page.locator('#git-publish').click();await text('#git-notice','Completed:');assert.equal(remoteCalls('publishBranch').length,pushes+1);assert.equal(remoteCalls('publishBranch').at(-1).input.remoteSnapshotId!==undefined,true);assert.match(await page.locator('#git-pr-body').inputValue(),/^KEEP_BODY/);
  await target();prDisposition='existing';await page.locator('#git-pr-create').click();await text('#git-notice','Fixture existing');assert.equal(await page.locator('#git-pr-title').inputValue(),'Original draft');prDisposition='created';
  await target();holdGit='createPR';releaseGit=null;await page.locator('#git-pr-create').click();await until(()=>releaseGit);const count=remoteCalls('createPR').length;await page.evaluate(()=>{const form=document.querySelector('#git-pr-form');form.dispatchEvent(new Event('submit',{cancelable:true}));form.dispatchEvent(new Event('submit',{cancelable:true}));});assert.equal(remoteCalls('createPR').length,count,'Repeated submit cannot dispatch while busy');await page.locator('#git-pr-body').fill('NEWER_BODY');releaseGit();await text('#git-notice','Fixture created');assert.equal(await page.locator('#git-pr-body').inputValue(),'NEWER_BODY','Completion cannot clear edited draft text');
  await target();await page.locator('#git-pr-create').click();await text('#git-notice','Fixture created');assert.equal(await page.locator('#git-pr-title').inputValue(),'');assert.equal(await page.locator('#git-pr-body').inputValue(),'');
  await target();await page.locator('#git-pr-title').fill('Unknown outcome draft');await page.locator('#git-pr-body').fill('UNKNOWN_BODY');lostReply=true;gitOutcome='unknown';await page.locator('#git-pr-create').click();await text('#git-notice','unknown:');assert.equal(await page.locator('#git-pr-body').inputValue(),'UNKNOWN_BODY');assert.equal(await page.locator('#git-remote-receipts a').count(),0,'Lost reply has no saved URL before inspection');await target();assert(await page.locator('#git-publish').isDisabled());
  await page.locator('[data-remote-inspect]').click();await text('#git-notice','Saved outcome inspected');assert.equal(await page.locator('#git-remote-receipts a').getAttribute('href'),'https://github.com/fixture/repo/pull/12','Discovered PR must be openable before acknowledgement');await text('#git-remote-receipts','fixture-branch');await text('#git-remote-receipts','main');inspectionBadURL=true;await page.locator('[data-remote-inspect]').click();await text('#git-notice','could not be verified');assert.equal(await page.locator('[data-remote-acknowledge]').count(),0);assert.equal(await page.locator('#git-remote-receipts a[href^="https://evil"]').count(),0);inspectionBadURL=false;await page.locator('[data-remote-inspect]').click();await text('#git-notice','Saved outcome inspected');await page.locator('[data-remote-acknowledge]').click();await text('#git-notice','Inspection acknowledged');assert.equal(remoteCalls('acknowledgeRemoteOutcome').length,1);assert.equal(await page.locator('#git-pr-body').inputValue(),'UNKNOWN_BODY');
  for(const outcome of ['stale','failed','cancelled']){await target();gitOutcome=outcome;await page.locator('#git-pr-create').click();await text('#git-notice',outcome+':');assert.equal(await page.locator('#git-pr-body').inputValue(),'UNKNOWN_BODY');}
  await target();holdGit='createPR';releaseGit=null;await page.locator('#git-pr-create').click();await until(()=>releaseGit);await page.locator('#git-stop').click();releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert.equal(await page.locator('#git-pr-body').inputValue(),'UNKNOWN_BODY');
  await fresh();malformedRemote=true;await page.locator('#git-remote-check').click();await text('#git-notice','could not be verified');malformedRemote=false;assert(await page.locator('#git-publish').isDisabled());assert.equal(await page.locator('#git-pr-body').inputValue(),'UNKNOWN_BODY');
  await page.locator('#git-publish-branch').fill('feature/other');await target();assert.equal(await page.locator('#git-pr-body').inputValue(),'OTHER_BODY');
  threads.set('publish-other',{id:'publish-other',cwd:'/fixture/publish-other',name:'Other publish project',turns:[],archived:false});const other=gitSnapshot('/fixture/publish-other');other.remotes=copy(fixture.remotes);other.remoteReceipts=[];
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Other publish project',exact:true}).click();await text('#thread-title','Other publish project');await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await openDetailsFor('#git-remote');assert.equal(await page.locator('#git-pr-body').inputValue(),'','Another local repository cannot inherit the draft');await target();await page.locator('#git-pr-title').fill('Other repository draft');await page.locator('#git-pr-body').fill('KEEP_OTHER_REPO');
  await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await page.locator('#git-publish-branch').fill('fixture-branch');await target();
  holdGit='createPR';releaseGit=null;await page.locator('#git-pr-create').click();await until(()=>releaseGit);await page.getByRole('button',{name:'Other publish project',exact:true}).click();await text('#thread-title','Other publish project');assert.equal(await page.locator('#git-pr-body').inputValue(),'KEEP_OTHER_REPO');await page.locator('#git-pr-body').fill('NEWER_OTHER_REPO');releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert.equal(await page.locator('#git-pr-body').inputValue(),'NEWER_OTHER_REPO','A late result cannot clear a different repository draft');
  await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');await page.locator('#git-publish-branch').fill('feature/other');await target();assert.equal(await page.locator('#git-pr-body').inputValue(),'OTHER_BODY','A different head draft survives completion');
  await page.locator('#git-pr-body').focus();assert.equal(await page.locator('#git-pr-body').evaluate(node=>node===document.activeElement),true);
  for(const width of [390,650,1360]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Publishing controls fit '+width);}
  assert.equal(await page.locator('#changes-panel img').count(),0);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_PUBLISH_CHAT_DRAFT');assert.deepEqual(errors,[]);
}
async function checkGitWorkflow() {
  assert.equal(await page.locator('#git-stage').count(),1,'Changes offers reviewed selected-file staging');
  assert.equal(await page.locator('select#git-switch-branch').count(),1,'Changes offers an explicit native local-branch selector');
  await page.locator('#prompt').fill('GIT_CHAT_DRAFT');await page.locator('#changes-toggle').click();await text('#git-paths','mixed file.txt');
  assert.equal(await page.locator('#changes-panel img, #changes-panel script').count(),0);await text('#git-note','Truncated');
  const pick=id=>page.locator(`#git-paths input[data-entry-id="${id}"]`), gitCalls=action=>calls.filter(c=>c.op==='codingGit'&&c.input.action===action);
  await openDetailsFor('#git-message');await page.locator('#git-message').fill('KEEP_COMMIT_TEXT');await openDetailsFor('#git-author-name');await page.locator('#git-author-name').fill('Explicit Author');await openDetailsFor('#git-author-email');await page.locator('#git-author-email').fill('explicit@example.invalid');await openDetailsFor('#git-branch-name');await page.locator('#git-branch-name').fill('feature/kept');
  const activityTurn={id:'git-activity',status:'inProgress',items:[]};
  for(const [method,params] of [['turn/started',{threadId:'saved',turn:activityTurn}],['item/started',{threadId:'saved',turnId:activityTurn.id,item:{id:'git-file-change',type:'fileChange',changes:[]}}],['item/commandExecution/outputDelta',{threadId:'saved',turnId:activityTurn.id,itemId:'git-command',delta:'changed'}],['coding/terminal/output',{threadId:'saved',processId:'git-external-terminal',text:'activity'}]]){
    await pick('mixed').check();emit(method,copy(params));await page.waitForFunction(()=>document.querySelector('#git-stage').disabled);assert(!(await pick('mixed').isChecked()),'Live project activity clears obsolete path selection');await text('#git-status','refresh required');assert.equal(await page.locator('#git-message').inputValue(),'KEEP_COMMIT_TEXT');await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');
  }
  emit('turn/completed',{threadId:'saved',turn:{...activityTurn,status:'completed'}});await text('#run-status','Ready');await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');
  holdGit='inspect';releaseGit=null;await page.locator('#refresh-changes').click();await until(()=>releaseGit);const pendingEvents=countAction('events');emit('item/started',{threadId:'saved',turnId:'inspection-race',item:{id:'new-file-change',type:'fileChange',changes:[]}});await until(()=>countAction('events')>pendingEvents);releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);await text('#git-status','refresh required');await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');
  await pick('mixed').check();await openDetailsFor('#git-stage');await page.locator('#git-stage').click();await text('#git-notice','stage completed');assert.deepEqual(gitCalls('stage').at(-1).input.entryIds,['mixed']);assert.equal(await page.locator('#prompt').inputValue(),'GIT_CHAT_DRAFT');assert.equal(await page.locator('#git-message').inputValue(),'KEEP_COMMIT_TEXT');
  await pick('mixed').check();await openDetailsFor('#git-unstage');await page.locator('#git-unstage').click();await text('#git-notice','unstage completed');assert.deepEqual(gitCalls('unstage').at(-1).input.entryIds,['mixed']);
  for(const state of ['cancelled','stale','busy','failed','unknown']){gitOutcome=state;await openDetailsFor('#git-commit');await page.locator('#git-commit').click();await text('#git-notice',state);assert.equal(await page.locator('#git-message').inputValue(),'KEEP_COMMIT_TEXT');assert(await page.locator('#git-commit').isDisabled());await page.locator('#refresh-changes').click();await page.waitForFunction(()=>!document.querySelector('#git-commit').disabled);}
  gitNoSnapshot=true;failGitInspect=true;await openDetailsFor('#git-commit');await page.locator('#git-commit').click();await text('#git-notice','commit completed');await text('#git-notice','inspection');const commit=gitCalls('commit').at(-1).input;assert.equal(commit.message,'KEEP_COMMIT_TEXT');assert.equal(commit.authorName,'Explicit Author');assert.equal(commit.authorEmail,'explicit@example.invalid');assert.equal(await page.locator('#git-message').inputValue(),'');assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/kept');
  await page.locator('#refresh-changes').click();await page.waitForFunction(()=>!document.querySelector('#git-create-branch').disabled);await openDetailsFor('#git-create-branch');await page.locator('#git-create-branch').click();await text('#git-notice','createBranch completed');assert.equal(gitCalls('createBranch').at(-1).input.name,'feature/kept');await text('#git-branch','fixture-branch');assert.equal(await page.locator('#git-branch-name').inputValue(),'');
  await openDetailsFor('#git-branch-name');await page.locator('#git-branch-name').fill('feature/reviewed');holdGit='createBranch';releaseGit=null;await openDetailsFor('#git-create-branch');await page.locator('#git-create-branch').click();await until(()=>releaseGit);await openDetailsFor('#git-branch-name');await page.locator('#git-branch-name').fill('feature/edited-during-review');releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert.equal(gitCalls('createBranch').at(-1).input.name,'feature/reviewed');assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/edited-during-review','Completion preserves text edited after review began');
  await openDetailsFor('#git-message');await page.locator('#git-message').fill('PERSIST_GIT_TEXT');await openDetailsFor('#git-branch-name');await page.locator('#git-branch-name').fill('feature/persist');const beforeReload=calls.filter(c=>c.op==='codingGit'&&c.input.action!=='inspect').length;await page.reload();await text('#thread-title','Saved chat');await page.locator('#changes-toggle').click();await text('#git-paths','mixed file.txt');assert.equal(await page.locator('#git-message').inputValue(),'PERSIST_GIT_TEXT');assert.equal(await page.locator('#git-author-name').inputValue(),'Explicit Author');assert.equal(calls.filter(c=>c.op==='codingGit'&&c.input.action!=='inspect').length,beforeReload,'Reload never replays Git mutations');
  // A selected chat may change while an ordinary inspection is pending.
  threads.set('git-other',{id:'git-other',cwd:'/fixture/git-other',name:'Other Git',turns:[],archived:false});await page.locator('#refresh').click();holdGit='inspect';releaseGit=null;await page.locator('#refresh-changes').click();await until(()=>releaseGit);await page.getByRole('button',{name:'Other Git',exact:true}).click();releaseGit();await text('#thread-title','Other Git');assert(!(await page.locator('#git-paths').textContent()).includes('mixed file.txt'));await page.locator('#refresh-changes').click();await text('#git-paths','mixed file.txt');assert.equal(await page.locator('#git-message').inputValue(),'');await pick('mixed').check();emit('coding/terminal/output',{threadId:'saved',processId:'other-activity',text:'other project'});const eventCount=countAction('events');await until(()=>countAction('events')>eventCount);assert(!(await page.locator('#git-stage').isDisabled()),'Unrelated project activity retains this snapshot');assert(await pick('mixed').isChecked());await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');assert.equal(await page.locator('#git-message').inputValue(),'PERSIST_GIT_TEXT');
  for(const cancel of ['scoped','tools-stopped','agent-stopped','pagehide']){
    await page.locator('#refresh-changes').click();await page.waitForFunction(()=>!document.querySelector('#git-create-branch').disabled);
    heldReadThreadId='saved';releaseRead=null;await page.getByRole('button',{name:'Saved chat',exact:true}).click();await until(()=>releaseRead);
    const before=gitCalls('createBranch').length;await openDetailsFor('#git-create-branch');await page.locator('#git-create-branch').click();if(cancel==='scoped'){await openDetailsFor('#git-stop');await page.locator('#git-stop').click();}else await page.evaluate(name=>window.dispatchEvent(new Event(name)),cancel);releaseRead();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert.equal(gitCalls('createBranch').length,before,`${cancel} fences queued Git dispatch`);assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/persist');
  }
  await page.reload();await text('#thread-title','Saved chat');await page.locator('#changes-toggle').click();await text('#git-paths','mixed file.txt');
  for(const outcome of ['unknown','failed','mismatch']){
    await page.locator('#refresh-changes').click();await page.waitForFunction(()=>!document.querySelector('#git-create-branch').disabled);holdGit='createBranch';releaseGit=null;gitStopOutcome=outcome;await openDetailsFor('#git-create-branch');await page.locator('#git-create-branch').click();await until(()=>releaseGit);await openDetailsFor('#git-stop');await page.locator('#git-stop').click();await text('#git-notice',outcome==='unknown'?'process exit is unconfirmed':outcome==='failed'?'Git Stop failed':'could not be confirmed');releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/persist','Late completion cannot clear a stopped draft');assert(await page.locator('#git-create-branch').isDisabled());
  }
  // A delayed old Stop outcome cannot overwrite a newer reviewed request.
  await page.locator('#refresh-changes').click();await page.waitForFunction(()=>!document.querySelector('#git-create-branch').disabled);holdGit='createBranch';releaseGit=null;gitStopOutcome='unknown';holdGitStop=true;releaseGitStop=null;await openDetailsFor('#git-create-branch');await page.locator('#git-create-branch').click();await until(()=>releaseGit);await openDetailsFor('#git-stop');await page.locator('#git-stop').click();await until(()=>releaseGitStop);releaseGit();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);await page.locator('#refresh-changes').click();await page.waitForFunction(()=>!document.querySelector('#git-create-branch').disabled);gitOutcome='stale';await openDetailsFor('#git-create-branch');await page.locator('#git-create-branch').click();await text('#git-notice','Fixture stale');const newerNotice=await page.locator('#git-notice').textContent();releaseGitStop();await until(()=>nativeActive===0);assert.equal(await page.locator('#git-notice').textContent(),newerNotice);assert.equal(await page.locator('#git-branch-name').inputValue(),'feature/persist');
  await checkBranchSwitching(gitCalls);
  // Child inspection remains available, but both buttons and submit handlers reject writes.
  threads.set('git-child',{id:'git-child',cwd:'/fixture/older',name:'Git child',parentThreadId:'saved',canAcceptDirectInput:false,turns:[],archived:false});emit('coding/family/updated',{threadId:'saved',rootThreadId:'saved'});await text('#family-list','Git child');await page.getByRole('button',{name:'Git child',exact:true}).click();await text('#thread-title','Git child');await page.locator('#refresh-changes').click();await text('#git-paths','mixed file.txt');for(const id of ['git-stage','git-unstage','git-commit','git-create-branch','git-switch','git-switch-branch'])assert(await page.locator('#'+id).isDisabled());const before=calls.length;await page.evaluate(()=>{for(const id of ['git-commit-form','git-branch-form','git-switch-form'])document.querySelector('#'+id).dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));});assert(!calls.slice(before).some(c=>c.op==='codingGit'&&c.input.action!=='inspect'));
  for(const width of [650,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Changes fits narrow viewport');}await page.setViewportSize({width:1360,height:900});assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Saved chat',exact:true}).first().click();await text('#thread-title','Saved chat');threads.delete('git-child');threads.delete('git-other');gitFixtures.clear();await page.locator('#prompt').fill('');await page.reload();await text('#thread-title','Saved chat');
}
async function checkFileDiffView(){
  const snapshot=gitSnapshot('/fixture/older'),mixed=snapshot.entries.find(entry=>entry.id==='mixed'),staged=snapshot.entries.find(entry=>entry.id==='staged');
  const marker={id:'tmp-marker',path:'.saleh-coding-tmp-0123456789ABCDEF0123456789ABCDEF/.saleh-owner',index:'?',worktree:'?',canStage:true,canUnstage:false},trackedMarker={...marker,id:'tracked-marker',path:'nested/.saleh-coding-tmp-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.saleh-owner',index:'M',worktree:'M'},lookalike={...marker,id:'lookalike-marker',path:'.saleh-coding-tmp-user-files/.saleh-owner'},payload={...marker,id:'scratch-payload',path:'.saleh-coding-tmp-0123456789ABCDEF0123456789ABCDEF/result.txt'};snapshot.entries.push(marker,trackedMarker,lookalike,payload);
  const untracked='new file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+FIRST_UNTRACKED <img src=x onerror=alert(1)>\n+ثاني😀\n';
  const working='diff --git a/mixed file.txt b/mixed file.txt\n--- a/mixed file.txt\n+++ b/mixed file.txt\n@@ -2,3 +2,4 @@\n context\n \n-old\n+new<script>never execute</script>\n+extra\n\\ No newline at end of file\n';
  const indexed='diff --git a/mixed file.txt b/mixed file.txt\n--- a/mixed file.txt\n+++ b/mixed file.txt\n@@ -1 +1 @@\n-before\n+STAGED_EXPECTED\n';
  snapshot.truncated=false;snapshot.fileDiffs=snapshot.entries.map(entry=>({entryId:entry.id,workingTree:entry===mixed?working:entry.id==='untracked'?untracked:'',staged:entry===mixed?indexed:entry===staged?'diff --git a/staged.txt b/staged.txt\nnew file mode 100644\n@@ -0,0 +1 @@\n+NEW_STAGED_FILE\n':''}));snapshot.diff=working+'\nStaged:\n'+indexed;
  await page.locator('#prompt').fill('KEEP_DIFF_COMPOSER');await page.locator('#changes-toggle').click();await text('#git-paths','mixed file.txt');
  const open=()=>page.getByRole('button',{name:'View changes in mixed file.txt',exact:true}),pick=()=>page.locator('#git-paths input[data-entry-id="'+mixed.id+'"]'),writes=()=>calls.filter(row=>row.op==='codingGit'&&row.input.action!=='inspect').length;
  const temporary=()=>page.locator('#git-temporary-toggle'),markerButton=()=>page.getByRole('button',{name:'View changes in '+marker.path,exact:true});
  assert.equal(await temporary().count(),1,'Untracked ownership markers need a separate collapsed group');assert.equal(await temporary().getAttribute('aria-expanded'),'false');assert(await page.locator('#git-temporary-paths').isHidden());assert.equal(await markerButton().count(),0,'Collapsed markers are outside the main visible project list');
  for(const entry of [trackedMarker,lookalike,payload])assert(await page.getByRole('button',{name:'View changes in '+entry.path,exact:true}).isVisible(),'Tracked, lookalike and ordinary scratch payload paths remain visible');
  await temporary().focus();await page.keyboard.press('Enter');assert(await markerButton().isVisible());assert.equal(await temporary().getAttribute('aria-expanded'),'true');await markerButton().click();assert(!(await page.locator('#git-paths input[data-entry-id="tmp-marker"]').isChecked()));await temporary().focus();await page.evaluate(()=>window.dispatchEvent(new Event('resize')));assert(await temporary().evaluate(node=>node===document.activeElement));assert.equal(await temporary().getAttribute('aria-expanded'),'true');await temporary().click();assert(await page.locator('#git-temporary-paths').isHidden());await temporary().click();
  const markerEntries=snapshot.entries.slice(),markerViews=copy(snapshot.fileDiffs);snapshot.entries=snapshot.entries.filter(entry=>entry.id!==marker.id);snapshot.fileDiffs=snapshot.fileDiffs.filter(view=>view.entryId!==marker.id);holdGit='inspect';releaseGit=null;await page.locator('#refresh-changes').click();await until(()=>releaseGit);await temporary().focus();releaseGit();await page.waitForFunction(()=>!document.querySelector('#git-temporary-toggle'));assert(await page.locator('#git-diff-all').evaluate(node=>node===document.activeElement),'Removing the last temporary marker restores keyboard focus to All changes');snapshot.entries=markerEntries;snapshot.fileDiffs=markerViews;await page.locator('#refresh-changes').click();await page.waitForSelector('#git-temporary-toggle');
  assert.equal(await open().count(),1,'Each changed file needs navigation independent of staging selection');const before=writes();await open().click();assert(!(await pick().isChecked()));assert.equal(await open().getAttribute('aria-pressed'),'true');await text('#git-diff','Working tree');await text('#git-diff','Staged');await text('#git-diff','STAGED_EXPECTED');await text('#git-diff','new<script>never execute</script>');
  assert.equal(await page.locator('#git-diff img, #git-diff script, #git-paths img').count(),0);
  await text('#git-diff .git-diff-line[data-kind="addition"][data-new="4"]','new<script>');await text('#git-diff .git-diff-line[data-kind="deletion"][data-old="4"]','-old');assert.equal(await page.locator('#git-diff .git-diff-line').filter({hasText:'No newline at end of file'}).getAttribute('data-new'),'');assert.equal(await page.locator('#git-diff .git-diff-line[data-kind="context"][data-old="3"][data-new="3"] .git-diff-code').textContent(),' \n','Blank context consumes both source line numbers');
  await pick().check();assert.equal(await open().getAttribute('aria-pressed'),'true');await page.getByRole('button',{name:'All changes',exact:true}).click();await text('#git-diff-status','Tracked-file aggregate');assert(await pick().isChecked(),'Reading another view does not alter stage selection');await open().focus();await page.evaluate(()=>window.dispatchEvent(new Event('resize')));assert.equal(await open().evaluate(node=>node===document.activeElement),true);
  await openDetailsFor('#git-message');await page.locator('#git-message').fill('KEEP_DIFF_COMMIT');await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await open().click();assert.equal(await page.locator('#git-message').inputValue(),'KEEP_DIFF_COMMIT');
  const out=process.argv[process.argv.indexOf('--diff-view-only')+1];if(out?.startsWith('/'))await mkdir(out,{mode:0o700});
  for(const width of [1380,900,390]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Diff stays within '+width+'px workspace');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_DIFF_COMPOSER');await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));if(out?.startsWith('/'))await page.screenshot({path:out+'/changes-'+width+'.png'});}await page.setViewportSize({width:1360,height:900});
  await page.getByRole('button',{name:'View changes in '+snapshot.entries[1].path,exact:true}).click();await text('#git-diff','FIRST_UNTRACKED <img');await text('#git-diff .git-diff-line[data-kind="addition"][data-new="1"]','FIRST_UNTRACKED');await text('#git-diff .git-diff-line[data-kind="addition"][data-new="2"]','ثاني😀');assert.equal(await page.locator('#git-diff img').count(),0);
  snapshot.truncated=true;snapshot.fileDiffs=null;snapshot.diff='TRUNCATED_CAPTURE\n[Diff display truncated]';await page.locator('#refresh-changes').click();await text('#git-diff','TRUNCATED_CAPTURE');await text('#git-diff-status','File previews unavailable');assert(await open().isDisabled());
  snapshot.truncated=false;snapshot.fileDiffs=snapshot.entries.map(entry=>({entryId:entry.id,workingTree:entry===mixed?working:'',staged:entry===mixed?indexed:''}));snapshot.diff=working+'\nStaged:\n'+indexed;await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await open().click();
  const views=copy(snapshot.fileDiffs);snapshot.fileDiffs[0].workingTree='@@ -0,0 +1,2500 @@\n'+'+LARGE <script>safe</script>\n'.repeat(2500);await page.locator('#refresh-changes').click();await text('#git-diff-status','Large patch shown as plain text');assert.equal(await page.locator('#git-diff .git-diff-line').count(),0);assert.equal(await page.locator('#git-diff script').count(),0);snapshot.fileDiffs=copy(views);
  snapshot.fileDiffs[1]=copy(snapshot.fileDiffs[0]);await page.locator('#refresh-changes').click();await text('#git-notice','invalid file previews');snapshot.fileDiffs=copy(views);await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await open().click();
  snapshot.entries=snapshot.entries.filter(entry=>entry!==mixed);snapshot.fileDiffs=snapshot.fileDiffs.filter(row=>row.entryId!==mixed.id);holdGit='inspect';releaseGit=null;await page.locator('#refresh-changes').click();await until(()=>releaseGit);await open().focus();releaseGit();await text('#git-diff-title','All changes');assert.equal(await page.locator('#git-diff-all').evaluate(node=>node===document.activeElement),true,'Removing a viewed file restores focus to All changes');snapshot.entries.unshift(mixed);snapshot.fileDiffs=copy(views);await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');await open().click();
  const other=gitSnapshot('/fixture/diff-other');other.entries.push(copy(marker));other.truncated=false;other.fileDiffs=other.entries.map(entry=>({entryId:entry.id,workingTree:'',staged:''}));
  threads.set('diff-other',{id:'diff-other',cwd:'/fixture/diff-other',name:'Other diff project',turns:[],archived:false});await page.locator('#refresh').click();await page.getByRole('button',{name:'Other diff project',exact:true}).click();await text('#thread-title','Other diff project');await page.locator('#refresh-changes').click();await text('#git-status','snapshot;');assert.equal(await temporary().getAttribute('aria-expanded'),'false','A new chat does not inherit expanded marker state');assert(!(await page.locator('#git-diff').textContent()).includes('STAGED_EXPECTED'));await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_DIFF_COMPOSER');assert.equal(await page.locator('#git-message').inputValue(),'KEEP_DIFF_COMMIT');assert.equal(await temporary().getAttribute('aria-expanded'),'true','Returning to a chat retains its in-memory expansion');
  threads.set('diff-child',{id:'diff-child',cwd:'/fixture/older',name:'Read-only diff child',parentThreadId:'saved',canAcceptDirectInput:false,turns:[],archived:false});emit('coding/family/updated',{threadId:'saved',rootThreadId:'saved'});await text('#family-list','Read-only diff child');await page.getByRole('button',{name:'Read-only diff child',exact:true}).click();await text('#thread-title','Read-only diff child');await page.locator('#refresh-changes').click();await text('#git-paths','mixed file.txt');await open().click();await text('#git-diff','STAGED_EXPECTED');assert(await pick().isDisabled());assert(await page.locator('#git-stage').isDisabled());assert(!(await open().isDisabled()),'Read-only history can inspect a captured file');
  assert.equal(writes(),before,'File navigation never dispatches a Git mutation');assert.deepEqual(errors,[]);
}

async function checkGoalsUI() {
  const checks = [], record = name => {assert(!checks.includes(name));checks.push(name);};
  const executions = () => calls.filter(call => call.op === 'coding' && ['start','send','steer','review','goalContinue'].includes(call.input?.action));
  const actions = name => calls.filter(call => call.op === 'coding' && call.input?.action === name);
  const finish = id => {const thread = threads.get(id),turn = thread.turns.at(-1);assert(turn);turn.status='completed';turn.items.push({id:'goal-result-'+turn.id,type:'agentMessage',text:'Fixture result; review completion criteria.'});emit('turn/completed',{threadId:id,turn:copy(turn)});};
  const preserved = async () => assert.equal(await page.locator('#prompt').inputValue(),'KEEP_GOAL_COMPOSER_175');
  const objective = 'Fix the task summary · هدف واضح <img src=x onerror=alert(1)>';
  const criteria = 'Archived tasks do not count.\nThe three focused tests pass.\nNo unrelated files change.';
  await page.waitForFunction(() => !document.querySelector('#goal-toggle').disabled);
  await until(() => actions('goalInspect').length > 0);
  assert.equal(executions().length,0);
  await page.locator('#prompt').fill('KEEP_GOAL_COMPOSER_175');
  await page.locator('#goal-toggle').click();
  await page.locator('#goal-editor').waitFor({state:'visible'});
  await page.locator('#goal-objective-input').fill(objective);
  await page.locator('#goal-criteria-input').fill(criteria);
  await page.locator('#goal-limit-input').fill('2');
  assert.equal(executions().length,0);await preserved();
  record('inspect and editing start no work; message draft remains independent');
  const draftBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).goalDrafts.saved);
  assert.equal(draftBefore.objective,objective);assert.equal(draftBefore.completionCriteria,criteria);assert.equal(draftBefore.revision,0);
  await page.reload();await page.locator('#goal-editor').waitFor({state:'visible'});
  assert.equal(await page.locator('#goal-objective-input').inputValue(),objective);
  assert.equal(await page.locator('#goal-criteria-input').inputValue(),criteria);
  await preserved();assert.equal(executions().length,0);
  record('unsaved goal editor and composer survive reload without submission');
  await page.locator('#goal-save').click();await text('#goal-state','Ready to continue');
  assert.equal(actions('goalSave').length,1);assert.equal(executions().length,0);
  assert.equal(await page.locator('#goal-objective').textContent(),objective);
  assert.equal(await page.locator('#goal-objective img').count(),0);
  assert.equal(goalFixtures.get('saved').maxTurns,2);
  await preserved();record('save persists exact objective criteria and limit as text without starting');
  assert.equal(await page.locator('#goal-heading').evaluate(node=>node===document.activeElement),true);
  assert.equal(await page.locator('#goal-panel').evaluate(node=>node.scrollTop),0);
  record('successful Save restores focus and scroll to the saved goal summary');
  goalReorderBinding=true;await page.locator('#goal-refresh').click();await text('#goal-state','Ready to continue');
  assert(!(await page.locator('#goal-continue').isDisabled()));assert(!(await page.locator('#goal-notice').textContent()).includes('could not be verified'));
  goalReorderBinding=false;await page.locator('#goal-refresh').click();await text('#goal-state','Ready to continue');
  record('native dictionary key ordering does not change the exact Goal binding');
  const editsBeforeBlocked=actions('goalPause').length;
  goalBlocked=true;await page.locator('#goal-refresh').click();await text('#goal-notice','inspection only');
  assert(await page.locator('#goal-continue').isDisabled());assert(await page.locator('#goal-edit').isDisabled());
  await page.locator('#goal-pause').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(actions('goalPause').length,editsBeforeBlocked);await preserved();
  goalBlocked=false;await page.locator('#goal-refresh').click();await text('#goal-state','Ready to continue');
  record('backend read-only availability holds actions even when a disabled event is dispatched');
  await page.locator('#goal-pause').click();await text('#goal-state','Paused');
  assert.equal(executions().length,0);
  await page.reload();await page.waitForFunction(() => !document.querySelector('#goal-toggle').disabled);
  await text('#goal-bar-state','Paused');assert.equal(executions().length,0);
  await page.locator('#goal-toggle').click();await text('#goal-state','Paused');await preserved();
  record('paused goal survives page restart with no automatic continuation');
  await page.locator('#goal-resume').click();await text('#goal-state','Ready to continue');
  assert.equal(executions().length,0);assert.equal(actions('goalResume').length,1);
  record('resume changes readiness only');
  await page.locator('#task-mode').selectOption('plan');await page.locator('#effort').selectOption('high');
  await text('#goal-continuation-note','Plan turn with Deep');
  goalHoldAction='goalContinue';goalRelease=null;
  await page.locator('#goal-continue').click();await until(() => goalRelease);
  await text('#coding-request-status','Continuing goal');
  assert(await page.locator('#goal-continue').isDisabled());
  await page.locator('#goal-continue').evaluate(node=>node.click());
  assert.equal(actions('goalContinue').length,1);
  assert.equal(actions('goalContinue')[0].input.mode,'plan');assert.equal(actions('goalContinue')[0].input.effort,'high');
  await preserved();goalRelease();await text('#goal-state','Working');
  await page.waitForFunction(() => !document.querySelector('#goal-pause').disabled);
  record('one explicit continuation carries reviewed mode effort and exact revision');
  assert.equal(goalFixtures.get('saved').attemptsUsed,1);assert.equal(executions().length,1);
  record('pending double activation cannot dispatch a duplicate continuation');
  const stops=actions('interruptFamily').length+actions('interrupt').length;
  await page.locator('#goal-pause').click();await text('#goal-state','current work continues');
  assert.equal(actions('interruptFamily').length+actions('interrupt').length,stops);
  assert(await page.locator('#goal-resume').isDisabled());
  assert(!(await page.locator('#stop').isHidden()));await preserved();
  record('pause holds the next continuation and accurately retains current Stop');
  finish('saved');await page.locator('#goal-refresh').click();await text('#goal-state','Paused');
  await page.locator('#goal-attempts summary').click();await text('#goal-attempt-list','Turn finished');
  assert.equal(executions().length,1);
  await page.locator('#goal-resume').click();await text('#goal-state','Ready to continue');
  await page.locator('#task-mode').selectOption('build');await page.locator('#effort').selectOption('none');
  await page.locator('#goal-continue').click();await text('#goal-state','Working');
  assert.equal(actions('goalContinue').length,2);
  finish('saved');await page.locator('#goal-refresh').click();await text('#goal-state','Turn limit reached');
  assert(await page.locator('#goal-continue').isHidden());assert.equal(executions().length,2);await preserved();
  record('completed attempts consume the saved limit without automatic chaining');
  await page.locator('#goal-edit').click();await page.locator('#goal-limit-input').fill('3');
  await page.locator('#goal-save').click();await text('#goal-state','Paused');
  assert.equal(goalFixtures.get('saved').attemptsUsed,2);assert.equal(goalFixtures.get('saved').attemptsRemaining,1);
  assert.equal(executions().length,2);
  record('increasing the limit retains prior usage and requires explicit resume');
  await page.waitForFunction(()=>!document.querySelector('#run-status').textContent.includes('Working'));
  const shotIndex=process.argv.indexOf('--screenshots'),shotDir=shotIndex>=0?process.argv[shotIndex+1]:null;
  if(shotDir){assert(shotDir.startsWith('/'));await mkdir(shotDir,{recursive:true,mode:0o700});await page.screenshot({path:shotDir+'/goal-paused-wide.png'});}
  for(const width of [1360,760,440]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert(await page.locator('#goal-panel').isVisible());
    const layout=await page.locator('#goal-panel').evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth,rect:node.getBoundingClientRect().toJSON(),width:innerWidth}));
    assert(layout.scroll<=layout.client+1,JSON.stringify(layout));
    assert(layout.rect.right<=layout.width+1&&layout.rect.left>=-1);
    if(shotDir&&width===760)await page.screenshot({path:shotDir+'/goal-paused-narrow.png'});
  }
  await page.setViewportSize({width:1360,height:900});
  record('goal panel stays within wide tablet and narrow windows without horizontal overflow');
  await page.locator('#goal-review-complete').click();
  await page.locator('#goal-evidence-input').fill('Reviewed fixture result and the three source-bound checks. Manual review only.');
  assert(await page.locator('#goal-complete').isDisabled());
  await page.locator('#goal-reviewed').check();await page.locator('#goal-complete').click();
  await text('#goal-state','Marked complete');await text('#goal-evidence','Manual review only.');
  assert(await page.locator('#goal-edit').isHidden());assert(await page.locator('#goal-continue').isHidden());
  assert.equal(executions().length,2);await preserved();
  record('completion requires reviewed evidence and remains distinct from automatic verification');
  await page.reload();await page.waitForFunction(()=>!document.querySelector('#goal-toggle').disabled);
  await text('#goal-bar-state','Marked complete');await page.locator('#goal-toggle').click();
  await text('#goal-evidence','Manual review only.');assert.equal(executions().length,2);await preserved();
  record('completed goal history and evidence survive reload without resend');
  threads.get('saved').archived=true;
  await page.locator('#show-archived').click();await page.getByRole('button',{name:'Saved chat',exact:true}).click();
  await text('#thread-title','Saved chat');await page.waitForFunction(()=>!document.querySelector('#goal-toggle').disabled);
  if(await page.locator('#goal-panel').isHidden())await page.locator('#goal-toggle').click();
  await text('#goal-evidence','Manual review only.');assert(await page.locator('#goal-edit').isHidden());assert.equal(executions().length,2);
  threads.get('saved').archived=false;await page.locator('#show-archived').click();await page.getByRole('button',{name:'Saved chat',exact:true}).click();
  if(await page.locator('#goal-panel').isHidden())await page.locator('#goal-toggle').click();
  record('archived root Goal evidence remains inspectable without mutation eligibility');
  threads.set('goal-other',{id:'goal-other',cwd:'/fixture/goal-other',name:'Other Goal task',turns:[],archived:false});
  await page.locator('#refresh').click();await page.getByRole('button',{name:'Other Goal task',exact:true}).waitFor();
  goalHoldAction='goalInspect';goalRelease=null;await page.locator('#goal-refresh').click();await until(()=>goalRelease);
  await page.getByRole('button',{name:'Other Goal task',exact:true}).click();await text('#thread-title','Other Goal task');
  goalRelease();await page.waitForFunction(()=>!document.querySelector('#goal-toggle').disabled);
  await page.locator('#goal-toggle').click();await page.locator('#goal-editor').waitFor({state:'visible'});
  assert.equal(await page.locator('#goal-objective-input').inputValue(),'');
  assert(await page.locator('#goal-bar').isHidden());assert.equal(executions().length,2);
  record('late inspection response cannot leak the previous task goal into a new selection');
  await page.locator('#goal-objective-input').fill('Second independent goal');
  await page.locator('#goal-criteria-input').fill('Keep its criteria separate.');await page.locator('#goal-save').click();
  await text('#goal-state','Ready to continue');
  await page.locator('#goal-edit').click();await page.locator('#goal-objective-input').fill('KEEP_UNSAVED_STALE_GOAL');
  goalFixtures.get('goal-other').objective='Changed elsewhere';goalFixtures.get('goal-other').revision++;
  await page.locator('#goal-refresh').click();await text('#goal-edit-note','changed after your draft');
  assert(await page.locator('#goal-save').isDisabled());
  assert.equal(await page.locator('#goal-objective-input').inputValue(),'KEEP_UNSAVED_STALE_GOAL');
  await page.locator('#goal-cancel-edit').click();await text('#goal-objective','Changed elsewhere');
  record('stale goal edits retain their text and cannot overwrite a newer revision');
  goalThrow='goalContinue-after-start';await page.locator('#goal-continue').click();
  await text('#goal-notice','reply was lost');assert(await page.locator('#goal-continue').isDisabled());
  const afterLost=actions('goalContinue').length;await page.locator('#goal-refresh').click();await text('#goal-state','Working');
  assert.equal(actions('goalContinue').length,afterLost);
  finish('goal-other');await page.locator('#goal-refresh').click();await text('#goal-state','Ready to continue');
  record('lost continuation acknowledgement holds retries and inspection never resubmits');
  goalMalformed=true;await page.locator('#goal-refresh').click();await text('#goal-notice','could not be verified');
  assert(await page.locator('#goal-continue').isDisabled());assert.equal(actions('goalContinue').length,afterLost);
  goalMalformed=false;await page.locator('#goal-refresh').click();await text('#goal-state','Ready to continue');
  record('malformed goal receipts hold actions while preserving the last saved display');
  await page.locator('#goal-edit').click();await page.locator('#goal-objective-input').focus();await page.keyboard.press('Enter');
  assert.equal(actions('goalContinue').length,afterLost);assert.equal(actions('send').length,0);
  await page.locator('#goal-cancel-edit').click();
  await page.locator('#prompt').fill('IME_UNSENT');
  await page.locator('#prompt').evaluate(node=>{for(const init of [{isComposing:true},{keyCode:229},{repeat:true}])node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...init}));});
  assert.equal(actions('send').length,0);assert.equal(await page.locator('#prompt').inputValue(),'IME_UNSENT');
  record('goal editor Enter and composing or repeated task Enter cannot send a task message');
  threads.set('goal-child',{id:'goal-child',cwd:'/fixture/goal-other',name:'Goal read-only child',parentThreadId:'goal-other',canAcceptDirectInput:false,turns:[],archived:false});
  emit('coding/family/updated',{threadId:'goal-other',rootThreadId:'goal-other'});
  await text('#family-list','Goal read-only child');await page.getByRole('button',{name:'Goal read-only child',exact:true}).click();
  await text('#thread-title','Goal read-only child');assert(await page.locator('#goal-toggle').isDisabled());
  assert(await page.locator('#goal-panel').isHidden());assert.equal(actions('goalInspect').filter(call=>call.input.threadId==='goal-child').length,0);
  record('delegated child histories cannot read or mutate the root Goal contract');
  await page.locator('#return-to-parent').click();await text('#thread-title','Other Goal task');
  await page.locator('#goal-toggle').click();await page.locator('#goal-edit').click();
  const savedBeforeStorageFailure=copy(goalFixtures.get('goal-other'));
  await page.evaluate(()=>localStorage.setItem('qwen-coding-ui-v1',localStorage.getItem('qwen-coding-ui-v1')+' '));
  await page.locator('#goal-objective-input').fill('KEEP_UNSAVED_AFTER_CAS_FAILURE');
  await text('#goal-notice','could not be saved');assert(await page.locator('#goal-save').isDisabled());
  assert.equal(await page.locator('#goal-objective-input').inputValue(),'KEEP_UNSAVED_AFTER_CAS_FAILURE');
  assert.deepEqual(goalFixtures.get('goal-other'),savedBeforeStorageFailure);
  assert.equal(await page.locator('#prompt').inputValue(),'IME_UNSENT');
  record('draft storage CAS failure preserves visible edits and blocks goal mutation');
  threads.set('goal-invalid',{id:'goal-invalid',cwd:'/fixture/goal-invalid',name:'Malformed goal draft task',turns:[],archived:false});
  const invalidDraft={unexpected:'GENERATED_DRAFT_TO_PRESERVE'};
  await page.evaluate(value=>sessionStorage.setItem('coding-fixture-preferences',JSON.stringify({selectedId:'goal-invalid',goalDrafts:{'goal-invalid':value}})),invalidDraft);
  await page.reload();await page.waitForFunction(()=>!document.querySelector('#goal-toggle').disabled);
  const savesBeforeInvalid=actions('goalSave').length;
  await page.locator('#goal-toggle').click();await text('#goal-notice','draft could not be read');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).goalDrafts['goal-invalid']),invalidDraft);
  assert.equal(actions('goalSave').length,savesBeforeInvalid);
  assert(await page.locator('#goal-new').isDisabled());await page.locator('#goal-refresh').click();
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).goalDrafts['goal-invalid']),invalidDraft);
  record('opening or refreshing an empty goal never overwrites a malformed retained editor draft');
  const currentOther=goalFixtures.get('goal-other'),baseEdit={objective:'OLD_PERSISTED_OBJECTIVE',completionCriteria:'OLD_CRITERIA',maxTurns:'3',evidence:'OLD_EVIDENCE',revision:currentOther.revision,editing:true,completing:false};
  await page.evaluate(value=>sessionStorage.setItem('coding-fixture-preferences',JSON.stringify({selectedId:'goal-other',goalDrafts:{'goal-other':value}})),baseEdit);
  await page.reload();await page.locator('#goal-editor').waitFor({state:'visible'});
  const goalBeforeForgedReply=copy(goalFixtures.get('goal-other'));
  for(const badReply of ['empty','unchanged','wrong-thread','wrong-id','wrong-values']){
    goalBadReply=badReply;
    await page.locator('#goal-save').click();await text('#goal-notice','action reply could not be verified');
    assert.equal(await page.locator('#goal-objective-input').inputValue(),'OLD_PERSISTED_OBJECTIVE');
    assert.equal(await page.locator('#goal-criteria-input').inputValue(),'OLD_CRITERIA');
    assert.deepEqual(goalFixtures.get('goal-other'),goalBeforeForgedReply);
    await page.locator('#goal-refresh').click();await text('#goal-state','Ready to continue');
  }
  goalBadReply='';
  record('absent stale mis-scoped replacement and mismatched mutation replies retain the exact editor draft');
  const savesBeforeForcedFailure=actions('goalSave').length;
  await page.evaluate(()=>{
    window.goalOriginalSetItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key==='qwen-coding-ui-v1')throw Error('Generated storage failure');return window.goalOriginalSetItem.call(this,key,value);};
    document.getElementById('goal-objective-input').value='NEW_VISIBLE_OBJECTIVE_TO_PRESERVE';
    document.getElementById('goal-editor').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  });
  await text('#goal-notice','draft could not be saved');
  assert.equal(actions('goalSave').length,savesBeforeForcedFailure);
  assert.equal(await page.locator('#goal-objective-input').inputValue(),'NEW_VISIBLE_OBJECTIVE_TO_PRESERVE');
  await page.locator('#goal-continue').evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  assert.equal(actions('goalContinue').length,afterLost);
  record('failed persistence during Save cannot submit an older draft or bypass the hold');
  await page.evaluate(value=>{
    Storage.prototype.setItem=window.goalOriginalSetItem;
    sessionStorage.setItem('coding-fixture-preferences',JSON.stringify({selectedId:'goal-other',goalDrafts:{'goal-other':value}}));
  },{...baseEdit,editing:false,completing:true});
  await page.reload();await page.locator('#goal-complete-form').waitFor({state:'visible'});
  const completionsBeforeFailure=actions('goalComplete').length;
  await page.evaluate(()=>{
    window.goalOriginalSetItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key==='qwen-coding-ui-v1')throw Error('Generated evidence storage failure');return window.goalOriginalSetItem.call(this,key,value);};
    document.getElementById('goal-evidence-input').value='NEW_VISIBLE_EVIDENCE_TO_PRESERVE';
    document.getElementById('goal-reviewed').checked=true;
    document.getElementById('goal-complete-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  });
  await text('#goal-notice','draft could not be saved');
  assert.equal(actions('goalComplete').length,completionsBeforeFailure);
  assert.equal(await page.locator('#goal-evidence-input').inputValue(),'NEW_VISIBLE_EVIDENCE_TO_PRESERVE');
  assert.equal(goalFixtures.get('goal-other').state,'ready');
  await page.evaluate(()=>{Storage.prototype.setItem=window.goalOriginalSetItem;});
  record('failed completion-evidence persistence cannot complete with stale evidence');
  assert.deepEqual(errors,[]);record('actual task page loads every asset with no browser exceptions');
  return checks;
}

try {
  if(process.argv.includes('--git-publishing-cap-only'))await context.addInitScript(()=>{if(!localStorage.getItem('qwen-coding-ui-v1'))localStorage.setItem('qwen-coding-ui-v1',JSON.stringify({selectedId:'saved',publishDrafts:Object.fromEntries(Array.from({length:128},(_,i)=>[i.toString(16).padStart(64,'0'),{title:'KEEP_TITLE_'+i,body:'KEEP_BODY_'+i}]))}));});
  await page.goto(`http://127.0.0.1:${server.address().port}/coding`);
  await text('#thread-title', 'Saved chat');
  assert.equal(await page.locator('#worktrees-toggle').count(),1,'Managed worktrees are accessible without replacing the selected chat');
  assert.equal(await page.locator('#schedules-toggle').count(),1,'Scheduled work is accessible without replacing the selected chat');
  if (process.argv.includes('--goals-only')) {
    const checks=await checkGoalsUI();console.log(JSON.stringify({schemaVersion:1,name:'coding-goals-ui',passed:checks.length,failed:0,checks}));
  } else if (process.argv.includes('--coding-parity-only')) {
    const checks=await checkCodingParity();console.log(JSON.stringify({schemaVersion:1,name:'coding-ui-parity',passed:checks.length,failed:0,checks}));
  } else if (process.argv.includes('--recovery-startup-only')) {
    await text('#workspace-access-chip','Full access · Recovery');
    assert.match(await page.locator('#tool-access-status').textContent(),/Unrestricted tools are held/);
    const rootId='recovery-ui-root',id='99999999-9999-4999-8999-999999999999';
    threads.set(rootId,{id:rootId,name:rootId,cwd:'/fixture/recovery-source',parentThreadId:null,archived:false,executionMode:'native',modelProvider:'saleh_local',turns:[{id:'recovery-ui-turn',status:'completed',items:[{id:'recovery-ui-answer',type:'agentMessage',text:'KEEP_RECOVERY_HISTORY'}]}]});
    worktrees.push({id,source:'/fixture/recovery-source',cwd:'/fixture/managed/recovery',commit:'a'.repeat(40),state:'ready',message:''});
    worktreeOpenAvailable=false;worktreeCreateAvailable=false;worktreeHandoffAvailable=true;
    await page.reload();await page.getByRole('button',{name:rootId,exact:true}).first().click();await text('#messages','KEEP_RECOVERY_HISTORY');
    await page.locator('#prompt').fill('KEEP_RECOVERY_STARTUP_DRAFT');
    await page.locator('#worktrees-toggle').click();await text('#worktrees-list','/fixture/managed/recovery');
    const row=()=>page.locator('[data-worktree-id="'+id+'"]'),move=()=>row().locator('[data-worktree-handoff]');
    assert(!await move().isDisabled(),'The idle owned root must otherwise qualify for handoff');
    worktreeHandoffAvailable=false;await page.locator('#worktrees-refresh').click();assert(await move().isDisabled(),'Explicit false handoff capability must hold new handoff');
    assert(await row().locator('[data-worktree-open]').isDisabled());assert(await page.locator('#worktree-choose-source').isDisabled());assert(await page.locator('#worktree-create').isDisabled());
    assert(!await row().locator('[data-worktree-archive]').isDisabled(),'Verified lifecycle stays available in recovery mode');
    worktreeHandoffAvailable='invalid';await page.locator('#worktrees-refresh').click();await text('#worktrees-notice','invalid worktree capabilities');assert(await move().isDisabled());assert(await row().locator('[data-worktree-archive]').isDisabled());
    worktreeHandoffAvailable=false;await page.locator('#worktrees-refresh').click();assert(!await row().locator('[data-worktree-archive]').isDisabled());
    failWorktreeList=true;await page.locator('#worktrees-refresh').click();assert(await move().isDisabled());assert(await row().locator('[data-worktree-archive]').isDisabled());await page.locator('#worktrees-refresh').click();
    await row().locator('[data-worktree-archive]').click();await text('#worktrees-notice','archived');await page.locator('#worktrees-view').selectOption('archived');await text('#worktrees-list','/fixture/managed/recovery');assert(!await row().locator('[data-worktree-restore]').isDisabled());await row().locator('[data-worktree-restore]').click();await text('#worktrees-notice','restored');
    for(const width of [390,650,1360]){
      await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Recovery status fits '+width);
      assert.equal(await page.locator('#prompt').inputValue(),'KEEP_RECOVERY_STARTUP_DRAFT');
    }
    await page.reload();await text('#thread-title',rootId);await text('#workspace-access-chip','Full access · Recovery');
    assert.equal(await page.locator('#prompt').inputValue(),'KEEP_RECOVERY_STARTUP_DRAFT');
    assert(!calls.some(c=>c.op==='coding'&&!['status','list','read','family','events','mcpOutcomes','terminalResults'].includes(c.input.action)),'Recovery status must not dispatch coding work');
    assert(!calls.some(c=>c.op==='codingWorktrees'&&['create','open','handoff'].includes(c.input.action)),'Held execution capabilities never dispatch');
    assert.deepEqual(errors,[]);console.log('PASS recovery startup UI: reviewed lifecycle, held create/open/handoff, invalid/stale list refusal, Full Access, draft/history retention after reload and three widths.');
  } else if (process.argv.includes('--full-access-worktree-only')) {
    const selected=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId);
    await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);const origin=await selected(),sends=countAction('send');await page.locator('#prompt').fill('KEEP_FULL_ACCESS_WORKTREE_DRAFT');
    recoveryCopyReadOnly=true;worktreeOpenAvailable=true;await page.locator('#worktrees-toggle').click();await text('#worktrees-list','/fixture/managed/ready');
    const openButton=page.locator('[data-worktree-id="managed-ready"] [data-worktree-open]');assert(!await openButton.isDisabled(),'Explicit opening capability must work while checkout mutations stay read-only');assert(await page.locator('[data-worktree-id="managed-ready"] [data-worktree-archive]').isDisabled());assert(await page.locator('#worktree-create').isDisabled());
    await openButton.click();await text('#project-path','/fixture/managed/ready');assert.notEqual(await selected(),origin);assert.equal(countAction('send'),sends);assert.equal(await page.evaluate(id=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).drafts[id],origin),'KEEP_FULL_ACCESS_WORKTREE_DRAFT');
    for(const capability of [false,undefined]){worktreeOpenAvailable=capability;await page.locator('#worktrees-refresh').click();assert(await openButton.isDisabled(),'Absent or false capability must retain the read-only fence');}
    worktreeOpenAvailable='invalid';await page.locator('#worktrees-refresh').click();await text('#worktrees-notice','invalid worktree capabilities');assert(await openButton.isDisabled());
    worktreeOpenAvailable=true;failWorktreeList=true;await page.locator('#worktrees-refresh').click();await text('#worktrees-notice','Managed list unavailable');assert(await openButton.isDisabled());await page.locator('#worktrees-refresh').click();assert(!await openButton.isDisabled());
    worktreeBusy=true;await page.locator('#worktrees-refresh').click();assert(await openButton.isDisabled());worktreeBusy=false;await page.locator('#worktrees-refresh').click();assert(!await openButton.isDisabled());
    worktreeCreateAvailable=true;await page.locator('#worktrees-refresh').click();assert(!await page.locator('#worktree-choose-source').isDisabled(),'Explicit creation capability must enable the source picker');await openDetailsFor('#worktree-choose-source');await page.locator('#worktree-choose-source').click();await text('#worktree-source','/fixture/project');await page.locator('#worktree-ref').fill('target');assert(!await page.locator('#worktree-create').isDisabled());const starts=countAction('start'),creates=calls.filter(c=>c.op==='codingWorktrees'&&c.input.action==='create').length;await page.locator('#worktree-create').click();await text('#worktrees-list','/fixture/managed/3');assert.equal(calls.filter(c=>c.op==='codingWorktrees'&&c.input.action==='create').length,creates+1);assert.equal(countAction('start'),starts);assert.equal(countAction('send'),sends);assert.equal(await page.evaluate(id=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).drafts[id],origin),'KEEP_FULL_ACCESS_WORKTREE_DRAFT');assert(await page.locator('[data-worktree-id="managed-ready"] [data-worktree-archive]').isDisabled());
    for(const capability of [false,undefined,'invalid']){worktreeCreateAvailable=capability;await page.locator('#worktrees-refresh').click();assert(await page.locator('#worktree-create').isDisabled());assert(await page.locator('#worktree-choose-source').isDisabled());}
    recoveryCopyReadOnly=false;worktreeCreateAvailable=undefined;await page.locator('#worktrees-refresh').click();assert(await page.locator('#worktree-create').isDisabled(),'Missing explicit capability must not grant creation in a mutable list');recoveryCopyReadOnly=true;
    worktreeCreateAvailable=true;await page.locator('#worktrees-refresh').click();assert(!await page.locator('#worktree-create').isDisabled());worktreeBusy=true;await page.locator('#worktrees-refresh').click();assert(await page.locator('#worktree-create').isDisabled());worktreeBusy=false;failWorktreeList=true;await page.locator('#worktrees-refresh').click();assert(await page.locator('#worktree-create').isDisabled());await page.locator('#worktrees-refresh').click();assert(!await page.locator('#worktree-create').isDisabled());assert.deepEqual(errors,[]);console.log('PASS Full Access worktree opening and creation: explicit capabilities, preserved draft, no prompt, invalid/stale/busy failures fenced; lifecycle remains disabled');
  } else if (process.argv.includes('--audit-focus-only')) {
    await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);
    await page.locator('#prompt').fill('KEEP_PANEL_FOCUS_DRAFT');
    for(const [toggle,field] of [['schedules-toggle','schedule-name'],['worktrees-toggle','worktree-ref'],['terminal-toggle','terminal-command'],['changes-toggle','git-message']]){
      await page.locator('#'+toggle).click();await page.locator('#'+field).focus();await page.keyboard.press('Escape');
      assert(await page.locator('#workspace-panel').isHidden());
      assert.equal(await page.evaluate(()=>document.activeElement.id),toggle,'Escape returns to the project panel trigger');
      await page.locator('#'+toggle).click();await page.locator('#close-panel').click();
      assert.equal(await page.evaluate(()=>document.activeElement.id),toggle,'Close returns to the project panel trigger');
      assert.equal(await page.locator('#prompt').inputValue(),'KEEP_PANEL_FOCUS_DRAFT');
    }
    await page.locator('#chat-menu > summary').click();await page.locator('#fork-chat').focus();await page.keyboard.press('Escape');assert(!await page.locator('#chat-menu').evaluate(node=>node.open));assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#chat-menu > summary')),true,'Escape restores the Chat actions trigger');
    assert(!calls.some(c=>c.op==='coding'&&['start','send','steer','terminalStart'].includes(c.input?.action)));
    assert.deepEqual(errors,[]);console.log('PASS project tools focus: four panel triggers, Escape/Close, no execution and retained draft');
  } else if (process.argv.includes('--polish-layout-only')) {
    const output=process.argv[process.argv.indexOf('--polish-layout-only')+1];assert(output?.startsWith('/'));await mkdir(output,{mode:0o700});
    readHistoryWarning='';mcpOutcomeFixtures.set('saved',{threadId:'saved',available:true,ownerId:savedOwner,storeId:'22222222-2222-4222-8222-222222222222',revision:1,blocked:false,warning:'',cached:false,complete:true,records:[]});threads.set('saved',{id:'saved',name:'Refine the workspace',cwd:'/fixture/Saleh-Uncensored',model:'local/saleh-qwen38-uncensored-8bit',executionMode:'native',archived:false,turns:[{id:'layout-turn',status:'completed',items:[{id:'layout-user',type:'userMessage',content:[{type:'text',text:'Polish the workspace. Keep my chats and drafts safe.'}]},{id:'layout-answer',type:'agentMessage',text:'I’ll start with the layout and keep every saved conversation in place.\n\n### What I will refine\n\n- Give project and chat titles more room.\n- Keep the selected model and task mode beside your draft.\n- Make panels and keyboard navigation consistent.\n\nUse Plan to review an approach, or Build when you are ready to implement.'}]}]});
    await page.reload();await text('#thread-title','Refine the workspace');await page.waitForFunction(()=>!document.querySelector('#new-project').disabled);await page.locator('#prompt').fill('Keep the layout clear, and preserve my drafts.');
    for(let i=0;i<35;i++)threads.set('layout-old-'+i,{id:'layout-old-'+i,cwd:'/fixture/Older project '+i,name:'Earlier chat '+i,turns:[],archived:false});
    const selectedLayout=threads.get('saved');threads.delete('saved');threads.set('saved',{...selectedLayout,cwd:'/fixture/'+('A long selected project name '.repeat(12))});
    await page.reload();await text('#thread-title','Refine the workspace');await page.waitForFunction(()=>!!document.querySelector('#thread-list [aria-current="page"]'));
    assert(await page.locator('#thread-list [aria-current="page"]').evaluate(n=>{const b=n.getBoundingClientRect(),p=document.getElementById('thread-list').getBoundingClientRect();return b.top>=p.top-1&&b.bottom<=p.bottom+1;}),'Restored Tasks selection is revealed below many groups');
    const headingTitle=await page.locator('#thread-list [aria-current="page"]').locator('xpath=ancestor::section[1]').locator('[data-workspace-project]').getAttribute('title'),heading=page.locator('#thread-list').getByTitle(headingTitle,{exact:true});await heading.click();assert.equal(await page.locator('#thread-list [aria-current="page"]').count(),0);await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.equal(await heading.getAttribute('aria-expanded'),'false','Refresh preserves explicitly collapsed project');await heading.click();
    await page.locator('#thread-list').evaluate(n=>n.scrollTop=0);await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#refresh').disabled);assert.equal(await page.locator('#thread-list').evaluate(n=>n.scrollTop),0,'Polling retains manual sidebar scroll');
    for(const [key] of threads)if(key.startsWith('layout-old-'))threads.delete(key);threads.set('saved',selectedLayout);await page.reload();await text('#thread-title','Refine the workspace');
    for(const width of [1380,900,390,1720]){
      await page.setViewportSize({width,height:900});await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
      const metrics=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return{width:innerWidth,scroll:document.documentElement.scrollWidth,ids,composer:document.getElementById('composer').getBoundingClientRect().toJSON(),send:document.getElementById('send').getBoundingClientRect().toJSON()};});
      assert.equal(new Set(metrics.ids).size,metrics.ids.length);assert(metrics.scroll<=width);for(const item of [metrics.composer,metrics.send])assert(item.x>=0&&item.right<=width&&item.bottom<=900);assert.equal(await page.locator('#prompt').inputValue(),'Keep the layout clear, and preserve my drafts.');await page.screenshot({path:output+'/tasks-'+width+'.png'});
    }
    assert(!calls.some(c=>c.op==='coding'&&['start','send','steer','terminalStart'].includes(c.input?.action)));assert.deepEqual(errors,[]);console.log('PASS Tasks layout: four widths, actual frontend with private fixture, no execution and preserved draft');
  } else if (process.argv.includes('--delegated-receipts-only')) {
    await checkDelegatedReceipts();console.log('PASS delegated receipts: readable saved activity, verified-child navigation, stale/foreign ID refusal, child read-only view, exact raw details, drafts/attachments and reload; no execution');
  } else if (process.argv.includes('--deep-presentation-only')) {
    await checkDeepResponsePresentation();console.log('PASS Deep presentation: no separator cards, real command outcome, exact raw message/code copy, standalone whitespace and user content, reload and nine draft maps; no execution');
  } else if (process.argv.includes('--live-history-only')) {
    await checkLiveCommandOrder();console.log('PASS live command ordering: late verified receipts before explicit/completed final, commentary kept, failed history refresh, expanded receipt, focus and all nine draft maps; no execution');
  } else if (process.argv.includes('--title-sync-only')) {
    await checkSelectedTitleSync();console.log('PASS selected Coding title: automatic name, saved preview, unrelated chat isolation, exact draft/cursor/focus preservation and read-only requests');
  } else if (process.argv.includes('--ui-clarity-only') || process.argv.includes('--composer-hint-only')) {
    await checkUIClarity(process.argv.includes('--composer-hint-only'));console.log('PASS UI clarity: collapsible complete MCP evidence, visible Stop/uncertainty, refresh/event/selection state, narrow dynamic helper and retained drafts without execution');
  } else if (process.argv.includes('--schedule-mode-only')) {
    await checkScheduleModes();console.log('PASS schedule mode UI: explicit native/VM, legacy draft cold edit, exact Run/Resume inputs, Cancel/Stop retention, malformed mode refusal, unchanged chat/history');
  } else if (process.argv.includes('--completion-away-only')) {
    await checkCompletionWhileAway();console.log('PASS Coding completion while away: exact turn recovery, unread/reload/read lifecycle, failed and incomplete history retention, live completion and drafts');
  } else if (process.argv.includes('--terminal-results-only')) {
    await checkSavedCommandResults();console.log('PASS saved reviewed-command UI: cold evidence, bounds, stale reads, Stop, result events, drafts and capability separation');
  } else if (process.argv.includes('--failed-startups-only')) {
    await page.waitForFunction(()=>!document.querySelector('#failed-startups').disabled);
    await page.locator('#prompt').fill('KEEP_UNSENT_STARTUP_DRAFT مرحبا');
    await page.locator('#message-files').setInputFiles({name:'keep-draft.txt',mimeType:'text/plain',buffer:Buffer.from('KEEP ATTACHMENT')});
    await page.waitForFunction(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return p.attachmentDrafts?.saved?.length===1;});
    const state=()=>page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));return {selected:p.selectedId,drafts:p.drafts,attachments:p.attachmentDrafts,ordinary:localStorage.getItem('qwen-local-chats-v1'),model:localStorage.getItem('saleh-local-model-default-v1')};}),before=await state(),history=copy(threads.get('saved')),at=calls.length;
    await page.locator('#failed-startups').click();await text('#notice','Continuation review cancelled');assert.deepEqual(await state(),before);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_UNSENT_STARTUP_DRAFT مرحبا');
    startupOutcome='corrupt';await page.locator('#failed-startups').click();await text('#notice','could not be verified');assert.deepEqual(await state(),before);
    await page.evaluate(()=>{window.startupSavedSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='qwen-coding-ui-v1')throw new DOMException('full','QuotaExceededError');return window.startupSavedSet.call(this,k,v);};});
    const blockedCalls=calls.filter(c=>c.op==='codingRecovery').length;await page.locator('#failed-startups').click();await text('#storage-notice','could not be saved');assert.equal(calls.filter(c=>c.op==='codingRecovery').length,blockedCalls);assert.deepEqual(await state(),before);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_UNSENT_STARTUP_DRAFT مرحبا');
    await page.evaluate(()=>{Storage.prototype.setItem=window.startupSavedSet;delete window.startupSavedSet;});
    startupOutcome='hold';await page.locator('#failed-startups').click();await page.waitForFunction(()=>document.querySelector('#failed-startups').disabled);while(!startupRelease)await new Promise(r=>setTimeout(r,10));
    await page.evaluate(()=>{window.startupSavedSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='qwen-coding-ui-v1')throw new DOMException('full','QuotaExceededError');return window.startupSavedSet.call(this,k,v);};});
    startupOutcome='created';startupRelease();await text('#notice','current draft could not be saved');assert.deepEqual(await state(),before);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_UNSENT_STARTUP_DRAFT مرحبا');
    await page.evaluate(()=>{Storage.prototype.setItem=window.startupSavedSet;delete window.startupSavedSet;});
    startupOutcome='created';heldReadThreadId='startup-continuation';releaseRead=null;await page.locator('#failed-startups').click();await until(()=>releaseRead);
    await page.evaluate(()=>{window.startupSavedSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='qwen-coding-ui-v1')throw new DOMException('full','QuotaExceededError');return window.startupSavedSet.call(this,k,v);};});
    await page.locator('#prompt').fill('KEEP_LATE_HISTORY_DRAFT مرحبا من جديد');releaseRead();await text('#notice','This view is kept until');assert.equal((await state()).selected,'saved');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_LATE_HISTORY_DRAFT مرحبا من جديد');assert.deepEqual((await state()).attachments,before.attachments);
    await page.evaluate(()=>{Storage.prototype.setItem=window.startupSavedSet;delete window.startupSavedSet;document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));});
    heldReadThreadId='startup-continuation';releaseRead=null;await page.locator('#failed-startups').click();await until(()=>releaseRead);
    await page.evaluate(()=>{window.startupFileRead=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){const file=this;return new Promise(resolve=>{window.releaseStartupFile=()=>resolve(window.startupFileRead.call(file));});};});
    await page.locator('#message-files').setInputFiles({name:'late-attachment.txt',mimeType:'text/plain',buffer:Buffer.from('KEEP LATE ATTACHMENT')});await page.waitForFunction(()=>typeof window.releaseStartupFile==='function');releaseRead();await text('#notice','This view is kept until');assert.equal((await state()).selected,'saved');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_LATE_HISTORY_DRAFT مرحبا من جديد');
    await page.evaluate(()=>{window.releaseStartupFile();File.prototype.arrayBuffer=window.startupFileRead;delete window.startupFileRead;});await page.waitForFunction(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).attachmentDrafts.saved.length===2);const finalDraft=await state();
    startupOutcome='created';await page.locator('#failed-startups').click();await text('#thread-title','Recovered continuation');await text('#notice','Continuation chat opened in the verified project copy.');assert(!await page.locator('#notice').textContent().then(t=>t.includes('Reviewing failed task startups')));await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_LATE_HISTORY_DRAFT مرحبا من جديد');
    startupOutcome='existing';await page.locator('#failed-startups').click();await text('#thread-title','Recovered continuation');await text('#notice','Saved continuation opened.');await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');
    const after=await state();assert.deepEqual(after.drafts,finalDraft.drafts);assert.deepEqual(after.attachments,finalDraft.attachments);assert.equal(after.model,before.model);assert.equal(after.ordinary,before.ordinary);assert.deepEqual(threads.get('saved'),history);
    assert(!calls.slice(at).some(c=>c.op==='coding'&&['start','send','steer','terminalStart'].includes(c.input?.action)));assert.deepEqual(errors,[]);console.log('PASS failed startup UI: Cancel/malformed/save failure preserve Arabic draft, attachment, selection, saved history and model; late failed save retains view; confirmed continuation opens without a turn.');
  } else if (process.argv.includes('--failed-storage-only')) {
    const savedHistory=copy(threads.get('saved'));await page.locator('#prompt').fill('KEEP_SAVED_DRAFT');
    hideAllThreads=true;await page.evaluate(()=>{const p=JSON.parse(localStorage.getItem('qwen-coding-ui-v1'));p.selectedId='';sessionStorage.setItem('coding-fixture-preferences',JSON.stringify(p));});await page.reload();await page.waitForFunction(()=>!document.querySelector('#failed-guest-storage').disabled);
    await page.locator('#prompt').evaluate(node=>{node.value='KEEP_UNSENT_DRAFT';node.dispatchEvent(new Event('input',{bubbles:true}));});
    const selection=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId);
    assert.equal(await selection(),'');assert(!await page.locator('#failed-guest-storage').isDisabled());
    const before=calls.length;await page.locator('#failed-guest-storage').click();await text('#notice','Guest disk retained.');
    assert.deepEqual(calls.slice(before).filter(c=>c.op==='codingStorage'),[{op:'codingStorage',input:{failed:true}}]);
    assert.equal(await selection(),'');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_UNSENT_DRAFT');assert.deepEqual(threads.get('saved'),savedHistory);
    assert(!calls.slice(before).some(c=>c.op!=='codingStorage'&&(c.op!=='coding'||!['status','events','list','read','family','mcpOutcomes','terminalResults'].includes(c.input?.action))),'Global inspection cannot start a chat, guest, terminal or model');
    hideAllThreads=false;await page.locator('#refresh').click();await page.getByRole('button',{name:'Saved chat',exact:true}).click();await text('#thread-title','Saved chat');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_SAVED_DRAFT');assert.deepEqual(threads.get('saved'),savedHistory);
    const wording=await readFile(new URL('Tools.swift',root),'utf8');const section=wording.slice(wording.indexOf('private func provisioningReview('),wording.indexOf('private func dismissProvisioning('));
    assert(section.indexOf('1. In the guest window')<section.indexOf('Project:'));assert(section.includes('2. Select Request guest shutdown'));assert(section.includes('if prompted'));assert(section.includes('within 60 seconds'));assert(section.includes('button:"Request guest shutdown",expected:expected,provisioningId:requestId'));
    assert.deepEqual(errors,[]);console.log('PASS failed guest storage: no selected chat, exact native inspection payload, cancel preserves selection/drafts/history with no execution; provisioning instructions preserve existing request binding and state the 60-second deadline.');
  } else if (process.argv.includes('--command-outcomes-only')) {
    const cmd=(id,status,exitCode,extra={})=>({id,type:'commandExecution',command:'node check.mjs',cwd:'/fixture/project',status,exitCode,aggregatedOutput:'All tests passed! <img src=x onerror=window.injected=true>',...extra});
    const cases=[
      ['zero',cmd('c','completed',0),'exited 0'],
      ['nonzero',cmd('c','completed',1),'exited 1'],
      ['failed',cmd('c','failed',2),'failed · recorded exit 2'],
      ['failed-malformed-exit',cmd('c','failed','1'),'failed · exit unavailable'],
      ['cancelled-malformed-exit',cmd('c','cancelled',false),'cancelled · exit unavailable'],
      ['failed-zero',cmd('c','failed',0),'failed · recorded exit 0 · conflicting status/exit'],
      ['cancelled',cmd('c','cancelled',null),'cancelled'],
      ['declined',cmd('c','declined',null),'declined'],
      ['interrupted',cmd('c','interrupted',130),'interrupted · recorded exit 130'],
      ['missing',cmd('c',undefined,undefined),'outcome unavailable'],
      ['missing-status-exit',cmd('c',undefined,1),'outcome unavailable · recorded exit 1'],
      ['missing-exit',cmd('c','completed',null),'exit unavailable'],
      ['string-exit',cmd('c','completed','0'),'outcome unavailable'],
      ['fractional-exit',cmd('c','completed',0.5),'outcome unavailable'],
      ['boolean-exit',cmd('c','completed',false),'outcome unavailable'],
      ['saved-in-progress',cmd('c','inProgress',null),'no final result recorded'],
      ['in-progress-exit',cmd('c','inProgress',0),'conflicting status · recorded exit 0'],
      ['unknown-status',cmd('c','unexpected',null),'outcome unavailable'],
    ];
    const saved=threads.get('saved');saved.turns=cases.map(([id,item])=>({id,status:'completed',items:[item]}));readHistoryWarning='';
    saved.turns.push({id:'duplicate',status:'completed',items:[cmd('same','completed',0),cmd('same','completed',1)]});
    saved.turns.push({id:'duplicate-failed',status:'completed',items:[cmd('same','failed',0),cmd('same','completed',1)]},{id:'duplicate-cancelled',status:'completed',items:[cmd('same','cancelled',null),cmd('same','completed',0)]});
    await page.getByRole('button',{name:'Saved chat',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.turn').length===21&&!document.querySelector('#new-project').disabled);
    for(const [id,item,label] of cases){
      const receipt=page.locator(`[data-turn-id="${id}"] .receipt`);assert.equal(await receipt.locator('summary').textContent(),`Command · ${label} · node check.mjs`,id);
      const raw=`Folder: /fixture/project\n$ node check.mjs\n\n${item.aggregatedOutput}${item.exitCode!=null?`\nExit code: ${item.exitCode}`:''}`;
      assert.equal(await receipt.locator('pre').textContent(),raw,id+' preserves raw output');
      assert.equal(await page.locator(`[data-turn-id="${id}"] .verification-summary strong`).textContent(),'Verification: not established');
    }
    assert.deepEqual(await page.locator('[data-turn-id="duplicate"] .receipt summary').allTextContents(),['Command · conflicting receipts · recorded exit 0 · node check.mjs','Command · conflicting receipts · recorded exit 1 · node check.mjs']);
    assert.equal(await page.locator('[data-turn-id="duplicate-failed"] .receipt summary').first().textContent(),'Command · failed · conflicting receipts · recorded exit 0 · node check.mjs');
    assert.equal(await page.locator('[data-turn-id="duplicate-cancelled"] .receipt summary').first().textContent(),'Command · cancelled · conflicting receipts · node check.mjs');
    assert.equal(await page.locator('#messages img, #messages script').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
    await page.locator('[data-turn-id="zero"] .receipt summary').click();await page.locator('#prompt').fill('KEEP_COMMAND_LABEL_DRAFT');
    await page.locator('#thread').evaluate(node=>{node.scrollTop=0;});
    await page.evaluate(()=>{const pre=document.querySelector('[data-turn-id="zero"] pre');const range=document.createRange();range.selectNodeContents(pre);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.receiptPre=pre;window.receiptSelection=selection.toString();});
    const beforeScroll=await page.locator('#thread').evaluate(node=>node.scrollTop);
    saved.turns[1].items[0].exitCode=2;emit('turn/completed',{threadId:'saved',turn:copy(saved.turns[1])});
    await page.waitForFunction(()=>document.querySelector('[data-turn-id="nonzero"] .receipt summary')?.textContent==='Command · exited 2 · node check.mjs');
    assert(await page.locator('[data-turn-id="zero"] .receipt').evaluate(node=>node.open),'expanded receipt preserved');
    assert.equal(await page.locator('#prompt').inputValue(),'KEEP_COMMAND_LABEL_DRAFT');
    assert.equal(await page.locator('#thread').evaluate(node=>node.scrollTop),beforeScroll,'scroll position preserved');
    assert(await page.evaluate(()=>window.receiptPre===document.querySelector('[data-turn-id="zero"] pre')&&getSelection().toString()===window.receiptSelection),'raw node and text selection preserved');
    assert(!calls.some(c=>c.op==='coding'&&!['status','list','read','family','events','mcpOutcomes','terminalResults'].includes(c.input.action)),'no execution');
    for(const width of [650,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'labels fit narrow layout');}
    assert.deepEqual(errors,[]);console.log('PASS command outcome labels: 18 receipt cases, duplicate conflicts, raw output, escaped text, conservative verification, disclosure/draft/selection/scroll preservation, narrow layouts; no execution.');
  } else if (process.argv.includes('--history-only')) {
    threads.set('creation-receipt',{id:'creation-receipt',cwd:'/fixture/older',name:'Saved empty chat',turns:[],archived:false,historyOnly:true,historySource:'creation-receipt',nativeHistoryAvailable:false,canAcceptDirectInput:null});
    await page.locator('#refresh').click();await page.getByRole('button',{name:'Saved empty chat',exact:true}).click();await text('#thread-title','Saved empty chat');
    for(const id of ['prompt','send','effort','rename-chat','fork-chat','archive-chat','review-changes','terminal-run','terminal-shell','changes-toggle','refresh-changes'])assert(await page.locator('#'+id).isDisabled(),id+' must be read-only');
    await text('#run-status','Saved empty chat');await text('#child-notice','cannot accept messages');await text('#messages','original identity');assert(!(await page.locator('#child-notice').innerText()).includes('parent chat'));
    const before=calls.length;await page.evaluate(()=>{document.querySelector('#prompt').value='must not create';document.querySelector('#composer').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));for(const id of ['archive-chat','fork-chat','rename-chat','review-changes','terminal-toggle','changes-toggle','refresh-changes'])document.querySelector('#'+id).dispatchEvent(new MouseEvent('click',{bubbles:true}));});
    await page.reload();await text('#thread-title','Saved empty chat');assert(await page.locator('#prompt').isDisabled());assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId),'creation-receipt');
    assert(!calls.slice(before).some(c=>c.op==='codingGit'||c.op==='coding'&&!['status','events','list','read','family','terminalSnapshot','mcpOutcomes','terminalResults'].includes(c.input.action)),'Inspection cannot replace or mutate the original chat');
    await page.getByRole('button',{name:'Saved chat',exact:true}).first().click();await text('#thread-title','Saved chat');assert(!(await page.locator('#prompt').isDisabled()));await page.locator('#prompt').fill('ordinary chat remains writable');assert(!(await page.locator('#send').isDisabled()));assert.deepEqual(errors,[]);
    console.log('PASS: saved creation receipt retains its identity across reload with read-only controls and submission guards; ordinary chat remains writable');
  } else if (process.argv.includes('--workspace-sync-only')) {
    await checkWorkspaceSync();console.log('PASS workspace synchronization UI: saving/failure fences, editable drafts, scoped controls, status/event race and reload, approvals, interactive terminal input/resize/Stop');
  } else if (process.argv.includes('--terminal-only')) {
    await checkInteractiveTerminal();console.log('PASS interactive terminal UI: explicit reviewed start, coherent frames/input, focused Escape, Cancel/reattach/reload, Stop and draft preservation');
  } else if (process.argv.includes('--recovery-copy-only')) {
    await checkRecoveryCopy();console.log('PASS recovery copy UI: Full Access readonly controls, exact payload/result, Cancel/failure/Stop, retained handoff and drafts, no automatic chat or prompt, narrow layout');
  } else if (process.argv.includes('--handoff-recovery-only')) {
    omitEmpty=true;await checkHandoffRecovery();console.log('PASS public handoff recovery UI: both reviewed modes, original family, drafts/history/reload/selection, refusal/Cancel, malformed/late replies and scoped/global Stop fences');
  } else if (process.argv.includes('--handoff-only') || process.argv.includes('--handoff-loading-only')) {
    await checkWorktreeHandoff();console.log('PASS handoff UI: same family, exact payloads, retained drafts, settled refused/missing/mismatched cold-history availability, unknown mode, outcome fences and verified read recovery');
  } else if (process.argv.includes('--worktree-lifecycle-only')) {
    await checkWorktreeLifecycle();console.log('PASS: worktree archive/restore preserves original chats and drafts, reload availability, reviewed payloads, Git invalidation and lifecycle cancellation');
  } else if (process.argv.includes('--diff-view-only')) {
    await checkFileDiffView();console.log('PASS focused Changes: file/checkbox isolation, staged/working line numbers, text safety, focus, raw fallback, drafts, chat isolation and three widths');
  } else if (process.argv.includes('--git-publishing-cap-only')) {
    await checkGitPublishingCap();console.log('PASS: full128-target PR draft map refuses new editing before any text loss; old drafts exact across target/recheck');
  } else if (process.argv.includes('--git-publishing-only')) {
    await checkGitPublishing();console.log('PASS publishing UI: exact target/payload, account-scoped drafts, reload, existing/created/unknown outcomes, changed text, single dispatch, Stop, saved inspection/acknowledgement, malformed targets, text safety and three widths');
  } else if (process.argv.includes('--git-only')) {
    await checkGitWorkflow();console.log('PASS: reviewed local Git snapshots, exact payloads, drafts, outcomes, queue/Stop fencing, child inspection and responsive layout');
  } else if (process.argv.includes('--approvals-only')) {
    await checkApprovalValidation();console.log('PASS: malformed and duplicate approvals are non-actionable at poll/startup; valid sibling review and streaming remain intact');
  } else if (process.argv.includes('--completed-schedule-only')) {
    schedules[0].status='completed';schedules[0].cadence={type:'once',at:1};
    await page.locator('#schedules-toggle').click();await text('#schedules-list','completed');
    const remove=page.locator('[data-schedule-action="delete"]');assert(!(await remove.isDisabled()),'An idle completed one-time schedule can be deleted');
    await remove.click();await until(()=>schedules.length===0);assert(threads.has('saved'),'Deleting a completed schedule preserves its saved chat');assert.deepEqual(errors,[]);
    console.log('PASS: idle completed one-time schedule deletion uses the native action and preserves saved chats');
  } else {
  await checkApprovalValidation();
  await checkGitWorkflow();
  await text('#messages', readHistoryWarning); readHistoryWarning='';
  await page.locator('#new-project').click(); await text('#project-path', '/fixture/project');
  assert.equal(await page.locator('#thread-title').innerText(), 'New chat');
  assert(!(await page.locator('#messages').textContent()).includes('Partial answer recovery unavailable'), 'Successful history read clears a resolved recovery warning');
  await page.locator('#effort').selectOption('high');
  await page.locator('#prompt').fill('Implement a safe fixture'); await page.locator('#send').click();
  await text('#run-status', 'Working');
  assert.equal(calls.find(c => c.input?.action === 'send').input.effort, 'high');
  emit('item/started', {threadId: 'new-1', turnId: 'turn-1', item: {id: 'answer', type: 'agentMessage', text: ''}});
  emit('item/agentMessage/delta', {threadId: 'new-1', turnId: 'turn-1', itemId: 'answer', delta: 'Streaming safely\n```js\nconsole.log(42);\n```\n<img src=x onerror=alert(1)>'});
  emit('item/reasoning/textDelta', {threadId: 'new-1', turnId: 'turn-1', itemId: 'thought', contentIndex: 0, delta: 'Checking the fixture.'});
  await text('#messages', 'Streaming safely');
  assert.equal(await page.locator('#messages img, #messages script').count(), 0);
  await page.locator('.copy-code').click(); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'console.log(42);\n');
  await page.locator('#prompt').fill('Keep the draft focused'); await page.locator('#prompt').focus();
  emit('item/agentMessage/delta', {threadId: 'new-1', turnId: 'turn-1', itemId: 'answer', delta: '\nMore output'});
  await text('#messages', 'More output'); assert.equal(await page.locator('#prompt').inputValue(), 'Keep the draft focused'); assert(await page.locator('#prompt').evaluate(el => el === document.activeElement));
  await page.locator('#send').click(); assert.equal(countAction('steer'), 1);
  threads.get('new-1').turns[0].items.push({id: 'answer', type: 'agentMessage', text: 'Snapshot text'});
  emit('item/agentMessage/delta', {threadId: 'new-1', turnId: 'turn-1', itemId: 'answer', delta: 'Snapshot text'});
  await page.getByRole('button', {name: 'Saved chat', exact: true}).click();
  await page.getByRole('button', {name: 'New chat', exact: true}).click(); await text('#messages', 'Snapshot text');
  approvals.push({id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {threadId: 'new-1', turnId: 'turn-1', command: 'cat fixture.txt', cwd: '/fixture/project', reason: 'Read the fixture'}});
  await text('#approvals', 'cat fixture.txt'); assert.equal(countAction('approval'), 0, 'No automatic approval');
  assert.equal(await page.locator('.assistant .content').innerText(), 'Snapshot text', 'Snapshot cursor prevents replaying deltas already read');
  await page.getByRole('button', {name: 'Review once', exact: true}).click();
  assert.equal(countAction('approval'), 1); assert.equal(calls.find(c => c.input?.action === 'approval').input.decision, 'accept');
  const command={id:'command-done',type:'commandExecution',command:'cat fixture.txt',status:'completed',aggregatedOutput:'RECEIPT_PRESERVED',exitCode:0};
  emit('item/completed',{threadId:'new-1',turnId:'turn-1',item:command});await text('#messages','RECEIPT_PRESERVED');
  const turn = threads.get('new-1').turns[0];turn.items.push(command); turn.status = 'completed'; turn.items.find(item => item.id === 'answer').text = 'Durable final answer';
  failReadOnce=true;emit('turn/completed', {threadId: 'new-1', turn: {...copy(turn),itemsView:'summary',items:[copy(turn.items.find(item=>item.id==='answer'))]}}); await text('#messages', 'Durable final answer'); await text('#run-status', 'Turn finished');assert.match(await page.locator('#messages').textContent(),/RECEIPT_PRESERVED/,'Summary completion retains prior tool receipts');
  await page.locator('#prompt').fill('Draft for new chat'); await page.getByRole('button', {name: 'Saved chat', exact: true}).click();
  await page.locator('#prompt').fill('Draft for saved chat'); await page.getByRole('button', {name: 'New chat', exact: true}).click();
  assert.equal(await page.locator('#prompt').inputValue(), 'Draft for new chat');
  await page.reload(); await text('#thread-title', 'New chat'); assert.equal(await page.locator('#prompt').inputValue(), 'Draft for new chat');
  assert.equal(await page.evaluate(() => localStorage.getItem('qwen-local-chats-v1')), 'LEGACY_UNTOUCHED');
  await page.locator('#rename-chat').click(); await page.locator('#rename-title').fill('Fixture work'); await page.locator('#rename-save').click(); await text('#thread-title', 'Fixture work');
  await page.locator('#changes-toggle').click(); await text('#git-diff', 'diff --git'); await text('#git-note', 'untracked'); await text('#git-note', 'Truncated'); assert.equal(await page.locator('#git-diff img').count(), 0);
  await page.locator('#review-changes').click(); await text('#run-status', 'Working'); deferInterruptCompletion=true; await page.locator('#stop').click(); await text('#notice','Stop requested for Fixture work'); finishInterrupt(); await text('#run-status', 'Stopped'); await page.waitForFunction(()=>document.querySelector('#notice').hidden);assert(await page.locator('#notice').isHidden(),'Matching family confirmation clears its Stop notice');
  await page.locator('#terminal-toggle').click(); await page.locator('#terminal-command').fill('printf fixture'); await page.locator('#terminal-run').click(); await text('#terminal-status', 'Running');
  assert(!await page.locator('#stop').isHidden(),'A terminal-only chat also offers selected-chat Stop');assert(!await page.locator('#stop').isDisabled());
  assert(!await page.locator('#terminal-stop').isDisabled(),'Terminal-only command remains stoppable');await text('#session-overview','1 working');
  emit('coding/terminal/output', {threadId: 'new-1', processId: 'terminal-1', output: 'fixture output\n'}); await text('#terminal-output', 'fixture output');
  await page.reload(); await text('#thread-title', 'Fixture work'); await page.locator('#terminal-toggle').click(); await text('#terminal-status', 'Running'); await text('#terminal-output', 'earlier output');
  await page.locator('#terminal-input').fill('input\n'); await page.locator('#terminal-write').click(); assert.equal(countAction('terminalWrite'), 1);
  await page.locator('#terminal-stop').click(); await text('#terminal-status', 'Stopped');
  await page.locator('#terminal-command').fill('printf second');await page.locator('#terminal-run').click();finishTerminalAtStatus=true;await page.reload();await text('#thread-title','Fixture work');await page.locator('#terminal-toggle').click();await text('#terminal-status','Exited · code 0');
  await page.locator('#close-panel').click();
  failSend = true; await page.locator('#prompt').fill('Keep on failure'); await page.locator('#send').click(); await text('#notice', 'Fixture provider unavailable'); assert.equal(await page.locator('#prompt').inputValue(), 'Keep on failure');
  eventBusy = true; gap = true; await text('#event-notice', 'reloaded');
  await page.locator('#chat-menu summary').click(); await page.locator('#archive-chat').click(); await page.locator('#show-archived').click(); await page.getByRole('button', {name: 'Fixture work', exact: true}).click();
  await text('#run-status', 'Submission outcome unconfirmed'); assert.equal(threads.get('new-1').archived,true); assert.equal(await page.locator('#archive-chat').textContent(),'Unarchive chat'); assert(await page.locator('#send').isDisabled(),'Archiving keeps unresolved submission protection');
  const sendsBeforeSubmissionReview=countAction('send'); await page.locator('#submission-check').click(); await page.locator('#submission-ack').click(); await text('#run-status', 'Archived');
  assert.equal(countAction('send'),sendsBeforeSubmissionReview,'Checking and acknowledging the notice never resends the draft'); assert.equal(await page.locator('#prompt').inputValue(),'Keep on failure');
  await page.locator('#chat-menu summary').click(); await page.locator('#archive-chat').click(); await text('#thread-title', 'Fixture work');
  await page.locator('#chat-menu summary').click(); await page.locator('#fork-chat').click(); await text('#thread-title', 'Forked chat'); assert.equal(countAction('fork'), 1);
  await page.locator('#search').fill('no match'); await text('#thread-list', 'No matching chats'); await page.locator('#search').fill('');
  await page.locator('#prompt').fill('Keyboard send'); await page.locator('#prompt').press('Enter'); await text('#run-status', 'Working');
  threads.get('new-2').turns.at(-1).status='failed';emit('coding/error',{message:'Fixture engine exited',turns:[{threadId:'new-2',turnId:threads.get('new-2').turns.at(-1).id}]});await text('#run-status','Error');await text('#notice','Fixture engine exited');assert.equal(await page.locator('#send').textContent(),'Send');
  await page.locator('#prompt').fill('Recover after exit');await page.locator('#send').click();await text('#run-status','Working');
  emit('coding/error',{message:'Old queued failure',turns:[{threadId:'new-2',turnId:threads.get('new-2').turns.at(-2).id}]});await text('#notice','Old queued failure');assert.match(await page.locator('#run-status').textContent(),/Working/,'An old failure cannot fail a newer turn');
  await page.evaluate(() => window.dispatchEvent(new Event('agent-stopped'))); await text('#run-status', 'Stopped');
  for (const width of [900, 650, 390]) {await page.setViewportSize({width, height: 844}); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`); assert(await page.locator('#send').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), `composer clipped at ${width}`);}
  await page.locator('#sidebar-toggle').click(); assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'true'); await page.locator('#close-sidebar').click(); assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
  await mkdir('/tmp/saleh-coding-ui', {recursive: true}); await page.screenshot({path: '/tmp/saleh-coding-ui/narrow.png'});
  await page.setViewportSize({width: 1360, height: 900}); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.screenshot({path: '/tmp/saleh-coding-ui/desktop.png'});
  omitEmpty = true; await page.locator('#new-project').click(); await text('#thread-title', 'New chat');
  assert.equal(await page.locator('#thread-list').getByRole('button', {name: 'New chat', exact: true}).count(), 1, 'Unmaterialized start stays in the sidebar');
  await page.locator('#effort').selectOption('high'); await page.locator('#prompt').fill('UNSENT_RESTART_DRAFT');
  await page.locator('#rename-chat').click(); await page.locator('#rename-title').fill('Unsent named chat'); await page.locator('#rename-save').click(); await text('#thread-title', 'Unsent named chat');
  const missingId = `new-${counter}`, startsBeforeReload = countAction('start'), sendsBeforeReload = countAction('send');
  await page.reload(); await text('#thread-title', 'Unsent named chat'); assert.equal(await page.locator('#prompt').inputValue(), 'UNSENT_RESTART_DRAFT');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId), missingId, 'Readable empty thread retains its original id despite list omission');
  assert.equal(countAction('start'), startsBeforeReload); assert.equal(countAction('send'), sendsBeforeReload);
  await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  failReadOnce = true; await page.locator('#refresh').click(); await text('#notice', 'History temporarily unavailable'); assert(await page.locator('#send').isDisabled(), 'Ambiguous read failure does not recreate a chat');
  assert.equal(countAction('start'), startsBeforeReload); await page.locator('#refresh').click();
  assert.equal(await page.evaluate(id => JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).pendingThreads[id].model, missingId),fixtureModel,'Unsent metadata preserves the model returned by start');
  threads.delete(missingId); await page.reload(); await text('#thread-title', 'Unsent named chat');
  assert.equal(await page.locator('#prompt').inputValue(), 'UNSENT_RESTART_DRAFT'); assert.equal(await page.locator('#effort').inputValue(), 'high');
  assert.equal(countAction('start'), startsBeforeReload, 'Reload never starts a thread'); assert.equal(countAction('send'), sendsBeforeReload, 'Reload never sends a draft');
  cancelStart = true; await page.locator('#send').click(); assert.equal(await page.locator('#prompt').inputValue(), 'UNSENT_RESTART_DRAFT'); assert.equal(countAction('send'), sendsBeforeReload, 'Cancelled replacement never sends');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId), missingId, 'Cancelled replacement does not migrate draft');
  failStart = true; await page.locator('#send').click(); await text('#notice', 'Fixture folder unavailable'); assert.equal(await page.locator('#prompt').inputValue(), 'UNSENT_RESTART_DRAFT');
  failRename = true; failSend = true; await page.locator('#send').click(); await page.locator('#notice').waitFor();
  assert.match(await page.locator('#notice').innerText(), /Fixture rename unavailable/, 'Replacement name is saved before sending');
  assert.equal(countAction('send'), sendsBeforeReload, 'Rename failure never sends'); assert.equal(await page.locator('#prompt').inputValue(), 'UNSENT_RESTART_DRAFT');
  const startsAfterRenameFailure = countAction('start');
  await page.locator('#send').click(); await text('#notice', 'Fixture provider unavailable'); assert.equal(countAction('start'), startsAfterRenameFailure, 'Rename retry keeps the replacement thread'); assert.equal(await page.locator('#prompt').inputValue(), 'UNSENT_RESTART_DRAFT'); assert.equal(await page.locator('#effort').inputValue(), 'high');
  const replacementId = `new-${counter}`; assert.notEqual(replacementId, missingId); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId), replacementId);
  assert.equal(calls.filter(c => c.input?.action === 'send').at(-1).input.threadId, replacementId); assert.equal(calls.filter(c => c.input?.action === 'send').at(-1).input.effort, 'high');
  await text('#run-status','Submission outcome unconfirmed'); assert(await page.locator('#send').isDisabled(),'An unconfirmed replacement send cannot be retried automatically');
  const sendsBeforeReplacementReview=countAction('send'); await page.locator('#submission-check').click(); await page.locator('#submission-ack').click();
  assert.equal(countAction('send'),sendsBeforeReplacementReview,'Review does not resend the replacement draft'); assert.equal(await page.locator('#prompt').inputValue(),'UNSENT_RESTART_DRAFT');
  await page.locator('#send').click(); await text('#run-status', 'Working'); assert.equal(await page.locator('#prompt').inputValue(), '');
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).pendingThreads).length), 0, 'Materialized chat no longer needs unsent metadata');
  assert.equal(threads.get(replacementId).name, 'Unsent named chat', 'Replacement custom name is durable');
  await page.locator('#refresh').click(); await text('#thread-title', 'Unsent named chat');
  assert.equal(await page.locator('#thread-list').getByRole('button', {name: 'Unsent named chat', exact: true}).count(), 1);
  await page.reload(); await text('#thread-title', 'Unsent named chat'); assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId), replacementId);
  assert.equal(maxOrdinary, 1, 'Ordinary native requests are serialized'); assert.deepEqual(errors, []);
  for (const thread of threads.values()) for (const turn of thread.turns) if (turn.status === 'inProgress') turn.status = 'completed';
  await page.reload(); await text('#thread-title','Unsent named chat');
  await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).unread),{'new-2':{itemId:'turn-4',status:'completed'}},'Reload recovers the older task that finished after its UI-only Stop');
  await page.locator('.chat-row[data-thread-id="new-2"] button').first().click();await text('[data-turn-id="turn-4"] .turn-outcome','Turn finished');
  await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).unread['new-2']);
  await page.locator(`.chat-row[data-thread-id="${replacementId}"] button`).first().click();await text('#thread-title','Unsent named chat');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).unread),{},'Explicitly reading the recovered result establishes the concurrency test baseline');
  const makeConcurrent = async (name, expectedStatus = 'Working') => {
    await page.locator('#new-chat').click(); await text('#thread-title','New chat');
    await page.locator('#rename-chat').click(); await page.locator('#rename-title').fill(name); await page.locator('#rename-save').click(); await text('#thread-title',name);
    await page.locator('#prompt').fill(`${name} work`); await page.locator('#send').click(); await text('#run-status',expectedStatus);
    const id=`new-${counter}`; return {id,turn:threads.get(id).turns.at(-1)};
  };
  const a=await makeConcurrent('Concurrent A'), b=await makeConcurrent('Concurrent B');
  assert.equal(await page.locator('#session-overview').count(),1,'Concurrent sessions have a visible overview');
  await text('#session-overview','2 working');
  const row = id => page.locator(`.chat-row[data-thread-id="${id}"]`);
  assert.match(await row(a.id).innerText(),/Working/); assert.match(await row(b.id).innerText(),/Working/);
  const itemA={id:'a-answer',type:'agentMessage',text:'A first'}, itemB={id:'b-answer',type:'agentMessage',text:'B first'};
  for (const [session,item] of [[a,itemA],[b,itemB]]) {session.turn.items.push(item); emit('item/started',{threadId:session.id,turnId:session.turn.id,item:copy(item)});}
  await text('#messages','B first');
  await page.locator('#prompt').fill('B unsent draft'); await page.locator('#prompt').focus();
  itemA.text+=' background'; emit('item/agentMessage/delta',{threadId:a.id,turnId:a.turn.id,itemId:itemA.id,delta:' background'});
  await page.waitForFunction(() => document.querySelector('#prompt') === document.activeElement); assert.equal(await page.locator('#prompt').inputValue(),'B unsent draft');
  await row(a.id).locator('button').first().click(); await text('#messages','A first background'); await page.locator('#prompt').fill('A unsent draft');
  await page.locator('#terminal-toggle').click(); await page.locator('#terminal-command').fill('printf A'); await page.locator('#terminal-input').fill('A stdin');
  await row(b.id).locator('button').first().click(); assert.equal(await page.locator('#prompt').inputValue(),'B unsent draft'); assert.equal(await page.locator('#terminal-command').inputValue(),''); assert.equal(await page.locator('#terminal-input').inputValue(),'');
  await page.locator('#terminal-command').fill('printf B'); await page.locator('#terminal-input').fill('B stdin');
  await row(a.id).locator('button').first().click(); assert.equal(await page.locator('#terminal-command').inputValue(),'printf A'); assert.equal(await page.locator('#terminal-input').inputValue(),'A stdin'); await page.locator('#close-panel').click();
  const receiptA={id:'a-command',type:'commandExecution',command:'printf A',status:'completed',aggregatedOutput:'A receipt',exitCode:0}; a.turn.items.push(receiptA); emit('item/completed',{threadId:a.id,turnId:a.turn.id,item:copy(receiptA)}); await text('#messages','A receipt');
  const summary=page.locator('.receipt summary').last(); await summary.click(); await summary.focus();
  await page.evaluate(() => {window.auditTranscript=document.querySelector('#messages .assistant');window.auditSummary=document.activeElement;});
  itemB.text+=' background'; emit('item/agentMessage/delta',{threadId:b.id,turnId:b.turn.id,itemId:itemB.id,delta:' background'});
  await text('#session-overview','2 working'); await page.waitForTimeout(1200);
  assert(await page.evaluate(() => window.auditTranscript === document.querySelector('#messages .assistant') && window.auditSummary === document.activeElement && window.auditSummary.parentElement.open),'Background delta preserves selected transcript, focus and open receipt');
  emit('coding/receiptError',{threadId:a.id,turnId:a.turn.id,message:'Fixture receipt read delayed'}); await text('#messages','Fixture receipt read delayed'); assert.match(await page.locator('#run-status').innerText(),/Working/,'Receipt failure is nonfatal');
  const readsBeforeReload=calls.filter(call=>call.input?.action==='read').length;
  await page.reload(); await text('#thread-title','Concurrent A'); await text('#session-overview','2 working'); await page.waitForFunction(() => !document.querySelector('#new-chat').disabled);
  const hydrated=calls.filter(call=>call.input?.action==='read').slice(readsBeforeReload).map(call=>call.input.threadId);
  assert(hydrated.includes(a.id)&&hydrated.includes(b.id),'Reload hydrates both active conversations before consuming new deltas');
  await page.locator('#terminal-toggle').click(); assert.equal(await page.locator('#terminal-command').inputValue(),'printf A'); assert.equal(await page.locator('#terminal-input').inputValue(),'A stdin'); await page.locator('#close-panel').click();
  itemB.text+=' after reload'; emit('item/agentMessage/delta',{threadId:b.id,turnId:b.turn.id,itemId:itemB.id,delta:' after reload'});
  await page.waitForTimeout(1200); assert.match(await row(b.id).innerText(),/Working/);
  b.turn.status='completed'; emit('turn/completed',{threadId:b.id,turn:copy(b.turn)}); await text('#session-overview','1 unread'); assert.match(await row(b.id).innerText(),/Activity finished.*unread/);
  assert.equal(await page.locator('#thread-title').innerText(),'Concurrent A'); assert.equal(await page.locator('#prompt').inputValue(),'A unsent draft'); assert(!await page.locator('#messages').textContent().then(value => value.includes('B first')));
  await page.reload(); await text('#thread-title','Concurrent A'); assert.match(await row(b.id).innerText(),/Activity finished.*unread/,'Background unread survives reload');
  const interruptsBefore=countAction('interruptFamily'); deferInterruptCompletion=true; await page.locator('#stop').click(); await text('#notice','Stop requested for Concurrent A');
  await row(b.id).locator('button').first().click(); await text('#thread-title','Concurrent B'); assert.match(await page.locator('#notice').innerText(),/Concurrent A/,'Stop notice identifies its background target');
  emit('coding/error',{message:'Unrelated provider warning',turns:[]}); await text('#notice','Unrelated provider warning'); finishInterrupt(); await text('#thread-list','Stopped · unread'); assert.equal(await page.locator('#notice').innerText(),'Unrelated provider warning','Completion does not clear an unrelated notice');
  const interrupted=calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input; assert.equal(interrupted.threadId,a.id); assert.deepEqual(Object.keys(interrupted).sort(),['action','threadId']);assert.equal(countAction('interruptFamily'),interruptsBefore+1); assert.equal(b.turn.status,'completed');
  await page.reload(); await text('#thread-title','Concurrent B'); assert.match(await row(a.id).innerText(),/Stopped.*unread/,'Background stopped state survives reload');
  await row(a.id).locator('button').first().click(); await text('#run-status','Stopped');
  await row(b.id).locator('button').first().click(); await text('#messages','B first background after reload'); assert(!/unread/.test(await row(b.id).innerText()));
  await page.locator('#prompt').fill('B next'); await page.locator('#send').click(); await text('#run-status','Working'); const nextB=threads.get(b.id).turns.at(-1);
  await row(a.id).locator('button').first().click(); await page.locator('#prompt').fill('A next'); await page.locator('#send').click(); await text('#run-status','Working'); const nextA=threads.get(a.id).turns.at(-1);
  await page.locator('#terminal-toggle').click(); await page.locator('#terminal-run').click(); await text('#terminal-status','Running');
  approvals.push({id:'concurrent-approval',method:'item/commandExecution/requestApproval',params:{threadId:b.id,turnId:nextB.id,command:'printf B',cwd:'/fixture/project'}}); await text('#approvals','Concurrent B'); assert.match(await row(b.id).innerText(),/Needs review/);
  heldApproval='concurrent-approval'; await page.getByRole('button',{name:'Review once',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#stop') && !document.querySelector('#stop').disabled);
  emit('item/started',{threadId:a.id,turnId:nextA.id,item:{id:'during-review',type:'agentMessage',text:'A progresses during B review'}}); await text('#messages','A progresses during B review');
  const terminalStopsBefore=countAction('terminalStop'); await page.locator('#terminal-stop').click(); await text('#terminal-status','Stopped'); assert.equal(countAction('terminalStop'),terminalStopsBefore+1,'Terminal Stop also bypasses pending review');
  holdInterruptReply=true; await page.locator('#stop').click(); await text('#run-status','Stopped'); assert.equal(calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input.threadId,a.id); assert.equal(nextB.status,'inProgress'); assert(!await page.locator('#notice').isHidden(),'Family confirmation waits for the pending Stop reply');
  releaseInterruptReply(); await page.waitForFunction(threadId=>window.lastInterruptReply===threadId,a.id);assert(!await page.locator('#notice').isHidden(),'Pending ordinary review cannot falsely confirm the family settled');
  assert(maxNative>1,'Read/control lane overlaps pending approval'); assert.equal(maxOrdinary,1,'Mutating native requests remain serialized'); releaseApproval(); heldApproval=null;await page.waitForFunction(()=>document.querySelector('#stop').hidden);assert(!/Stop requested/.test(await page.locator('#notice').innerText()),'Late Stop reply settles after fresh family confirmation without clearing unrelated approval result');
  await page.waitForFunction(() => !document.querySelector('#new-chat').disabled);
  nextB.status='failed'; nextB.error={message:'B isolated failure'}; emit('turn/completed',{threadId:b.id,turn:copy(nextB)}); await text('#session-overview','1 unread'); assert.match(await row(b.id).innerText(),/Error.*unread/);
  await page.locator('#close-panel').click();
  for (const width of [650,390]) {await page.setViewportSize({width,height:844}); assert(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth),'Concurrent overview stays within narrow viewport');}
  await page.locator('#session-overview').click(); assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'),'true');
  await page.setViewportSize({width:1360,height:900});
  const delayed=await makeConcurrent('Delayed response');
  const delayedItem={id:'delayed-answer',type:'agentMessage',text:'Snapshot base'}; delayed.turn.items.push(delayedItem); emit('item/started',{threadId:delayed.id,turnId:delayed.turn.id,item:copy(delayedItem)}); await text('#messages','Snapshot base');
  heldReadThreadId=delayed.id; releaseRead=null; await page.locator('#refresh').click();
  await until(()=>releaseRead);
  delayedItem.text+=' + live delta'; emit('item/agentMessage/delta',{threadId:delayed.id,turnId:delayed.turn.id,itemId:delayedItem.id,delta:' + live delta'});
  const delayedReceipt={id:'delayed-command',type:'commandExecution',command:'printf delayed',status:'completed',aggregatedOutput:'DELAYED_RECEIPT',exitCode:0}; delayed.turn.items.push(delayedReceipt); emit('item/completed',{threadId:delayed.id,turnId:delayed.turn.id,item:copy(delayedReceipt)});
  delayed.turn.items.push({...copy(delayedReceipt),id:'durable-only-command',aggregatedOutput:'DURABLE_ONLY_RECEIPT'});
  delayed.turn.status='completed'; emit('turn/completed',{threadId:delayed.id,turn:{...copy(delayed.turn),items:[],itemsView:'summary'}}); await text('#run-status','Turn finished'); await text('#messages','DELAYED_RECEIPT');
  releaseRead(); await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  assert.match(await page.locator('#run-status').innerText(),/Turn finished/,'Delayed read cannot revive a completed turn');
  assert.equal(await page.locator('.assistant .content').last().innerText(),'Snapshot base + live delta','Newer delta survives delayed snapshot exactly once'); assert.match(await page.locator('#messages').textContent(),/DELAYED_RECEIPT/); assert.equal(await page.locator('#send').textContent(),'Send');
  assert.match(await page.locator('#messages').textContent(),/DURABLE_ONLY_RECEIPT/,'Completion during a stale read still refreshes persisted-only command receipts');
  await page.locator('#terminal-toggle').click(); await page.locator('#terminal-command').fill('printf fast'); holdTerminalStart=true; await page.locator('#terminal-run').click();
  await until(()=>releaseTerminalStart);
  emit('coding/terminal/output',{threadId:delayed.id,processId:'terminal-race',output:'EARLY_TERMINAL_OUTPUT\n'}); terminalActive=false; emit('coding/terminal/completed',{threadId:delayed.id,processId:'terminal-race',exitCode:0});
  const earlyTerminalSequence=sequence; await until(()=>calls.some(call=>call.input?.action==='events'&&call.input.after>=earlyTerminalSequence));
  releaseTerminalStart(); await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  assert.match(await page.locator('#terminal-output').textContent(),/EARLY_TERMINAL_OUTPUT/,'Output before terminalStart response is retained'); assert.match(await page.locator('#terminal-status').innerText(),/Exited · code 0/,'Completion before terminalStart response is retained');
  await page.locator('#close-panel').click(); holdSend=true;
  const lateStart=await makeConcurrent('Late turn response','Waiting for submission acknowledgement'); await until(()=>releaseSend);
  const lateAnswer=lateStart.turn.items.find(item=>item.id==='send-race-answer'); lateAnswer.text='FINAL_BEFORE_START_REPLY'; emit('item/agentMessage/delta',{threadId:lateStart.id,turnId:lateStart.turn.id,itemId:lateAnswer.id,delta:lateAnswer.text});
  lateStart.turn.status='completed'; failReadOnce=true; emit('turn/completed',{threadId:lateStart.id,turn:{...copy(lateStart.turn),items:[],itemsView:'summary'}}); await text('#messages .turn-outcome','Turn finished'); await text('#run-status','Waiting for submission acknowledgement');
  assert(await page.locator('#send').isDisabled(),'Streamed completion cannot acknowledge a held send reply'); assert.equal(await page.locator('#prompt').inputValue(),'Late turn response work','Draft stays until the send reply is confirmed');
  releaseSend(); await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled); await text('#messages','History refresh failed');
  assert.match(await page.locator('#run-status').innerText(),/Turn finished/,'Late initial RPC reply cannot revive final turn when durable read fails'); assert.equal(await page.locator('.assistant .content').last().innerText(),'FINAL_BEFORE_START_REPLY','Late initial items cannot erase streamed text');
  await page.locator('#prompt').fill('Buffer overflow fixture'); await page.locator('#send').click(); await text('#run-status','Working');
  const overflowTurn=threads.get(lateStart.id).turns.at(-1), overflowItem={id:'overflow-answer',type:'agentMessage',text:''}; overflowTurn.items.push(overflowItem); emit('item/started',{threadId:lateStart.id,turnId:overflowTurn.id,item:copy(overflowItem)});
  heldReadThreadId=lateStart.id; releaseRead=null; const callsBeforeOverflow=calls.length, readCountBeforeOverflow=countAction('read'); await page.locator('#refresh').click(); await until(()=>releaseRead);
  for(let i=0;i<513;i++){overflowItem.text+='x';emit('item/agentMessage/delta',{threadId:lateStart.id,turnId:overflowTurn.id,itemId:overflowItem.id,delta:'x'});}
  overflowTurn.status='completed';emit('turn/completed',{threadId:lateStart.id,turn:{...copy(overflowTurn),items:[],itemsView:'summary'}}); await text('#run-status','Turn finished'); releaseRead(); await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  const overflowReadIds=calls.slice(callsBeforeOverflow).filter(call=>call.op==='coding'&&call.input?.action==='read').map(call=>call.input.threadId);
  assert.equal(countAction('read')-readCountBeforeOverflow,3,'Overflow retry and unresolved-watch reconciliation are the only history reads');
  assert.equal(overflowReadIds.filter(id=>id===lateStart.id).length,2,'Overflow performs one fresh history read');
  assert.deepEqual(overflowReadIds.filter(id=>id!==lateStart.id),['saved'],'Refresh independently retries the retained unresolved validation turn exactly once');
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).watchedTurns.filter(watch=>watch.threadId==='saved')),[{threadId:'saved',turnId:'validation-turn'}],'Missing history preserves the unresolved watch after Refresh');
  assert.equal(await page.locator('.assistant .content').last().innerText(),'x'.repeat(513),'Bounded overflow recovery loses no final output'); assert.match(await page.locator('#run-status').innerText(),/Turn finished/);
  const spawningRoot=await makeConcurrent('Spawning root');await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  heldFamily=spawningRoot.id;releaseFamily=null;emit('coding/family/updated',{threadId:spawningRoot.id,rootThreadId:spawningRoot.id});await until(()=>releaseFamily);
  deferInterruptCompletion=true;await page.locator('#stop').click();await text('#notice','Spawning root');
  const spawningChild={id:'late-first-child',parentThreadId:spawningRoot.id,agentNickname:'Late first child',canAcceptDirectInput:false,cwd:'/fixture/project',turns:[{id:'late-first-turn',status:'inProgress',items:[]}],archived:false};threads.set(spawningChild.id,spawningChild);finishInterrupt();await text('#messages .turn-outcome','Stopped');
  assert(!await page.locator('#notice').isHidden(),'Initially childless Stop waits for family confirmation after parent completion and blocked late-child discovery');
  emit('coding/family/updated',{threadId:spawningRoot.id,rootThreadId:spawningRoot.id});releaseFamily();await text('#family-list','Late first child');assert(!await page.locator('#notice').isHidden());
  spawningChild.turns[0].status='interrupted';emit('turn/completed',{threadId:spawningChild.id,turn:copy(spawningChild.turns[0])});familyStopping.delete(spawningRoot.id);emit('coding/family/updated',{threadId:spawningRoot.id,rootThreadId:spawningRoot.id});await page.waitForFunction(()=>document.querySelector('#notice').hidden);
  const familyRoot=await makeConcurrent('Family root'); familyRoot.turn.status='completed';emit('turn/completed',{threadId:familyRoot.id,turn:copy(familyRoot.turn)});await text('#run-status','Turn finished');
  await page.locator('#prompt').fill('PARENT_DRAFT_KEEP');await page.locator('#effort').selectOption('high');await page.locator('#terminal-toggle').click();await page.locator('#terminal-command').fill('printf parent-draft');await page.locator('#terminal-input').fill('parent stdin');await page.locator('#close-panel').click();
  await page.locator('#refresh').click();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  heldFamily=familyRoot.id;releaseFamily=null;emit('coding/family/updated',{threadId:familyRoot.id,rootThreadId:familyRoot.id});await until(()=>releaseFamily);
  const makeChild=(id,parent,name)=>{const turn={id:id+'-turn',status:'inProgress',items:[{id:id+'-answer',type:'agentMessage',text:name+' BEFORE_METADATA'}]},child={id,parentThreadId:parent,agentNickname:name,agentRole:'reviewer',canAcceptDirectInput:null,source:{subAgent:'fixture'},historyMode:'paginated',cwd:'/fixture/project',modelProvider:'saleh_local',turns:[turn],archived:false};threads.set(id,child);return child;};
  const child=makeChild('family-child',familyRoot.id,'Reader agent'),grandchild=makeChild('family-grandchild',child.id,'Nested agent');
  emit('item/agentMessage/delta',{threadId:child.id,turnId:child.turns[0].id,itemId:child.turns[0].items[0].id,delta:'BEFORE_METADATA'});
  emit('coding/family/updated',{threadId:familyRoot.id,rootThreadId:familyRoot.id});
  await page.waitForFunction(()=>!document.querySelector('#stop').hidden,null,{timeout:6000});assert(!await page.locator('#stop').isDisabled(),'Trusted active child root metadata keeps Stop available before the held family read resolves');releaseFamily();
  await text('#family-list','Reader agent');await text('#family-list','Nested agent');assert(!await page.locator('#stop').isHidden(),'Idle parent retains Stop while descendants work');
  const familyButton=id=>page.locator(`#family-list button[data-thread-id="${id}"]`);
  await familyButton(child.id).click();await text('#messages','Reader agent BEFORE_METADATA');assert(await page.locator('#prompt').isDisabled(),'Child metadata with null input flag is read-only');
  await text('#child-notice','parent');await text('#family-list','Family root');
  for(const id of ['send','effort','terminal-run','terminal-shell','terminal-write','review-changes','fork-chat'])assert(await page.locator('#'+id).isDisabled(),`Child disables execution control ${id}`);
  assert(!await page.locator('#terminal-toggle').isDisabled(),'A child may inspect saved evidence without direct input');await page.locator('#terminal-toggle').click();assert(await page.locator('#terminal-panel').isVisible());await page.locator('#close-panel').click();
  const beforeForbidden=calls.length;
  await page.evaluate(()=>{document.querySelector('#prompt').value='MUST_NOT_SEND';for(const id of ['composer','terminal-form'])document.querySelector('#'+id).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));for(const id of ['review-changes','fork-chat'])document.querySelector('#'+id).dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  await page.waitForTimeout(100);assert(!calls.slice(beforeForbidden).some(c=>['send','steer','terminalStart','review','fork'].includes(c.input?.action)),'Child handler guards reject direct invocation');
  approvals.push({id:'child-approval',method:'item/commandExecution/requestApproval',params:{threadId:child.id,turnId:child.turns[0].id,command:'cat child-fixture',cwd:'/fixture/project'}});await text('#approvals','Reader agent');await text('#approvals','Family root');
  await page.reload();await text('#thread-title','Reader agent');await text('#messages','Reader agent BEFORE_METADATA');assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId),child.id,'Saved child selection survives root-only list');assert(await page.locator('#prompt').isDisabled());
  await familyButton(familyRoot.id).click();assert.equal(await page.locator('#prompt').inputValue(),'PARENT_DRAFT_KEEP');assert.equal(await page.locator('#effort').inputValue(),'high');await page.locator('#terminal-toggle').click();assert.equal(await page.locator('#terminal-command').inputValue(),'printf parent-draft');assert.equal(await page.locator('#terminal-input').inputValue(),'parent stdin');await page.locator('#close-panel').click();
  heldFamily=familyRoot.id;releaseFamily=null;emit('coding/family/updated',{threadId:familyRoot.id,rootThreadId:familyRoot.id});await until(()=>releaseFamily);
  const familyStops=countAction('interruptFamily');await page.locator('#stop').click();await until(()=>countAction('interruptFamily')===familyStops+1);assert.equal(calls.filter(c=>c.input?.action==='interruptFamily').at(-1).input.threadId,familyRoot.id,'Idle-parent family Stop bypasses pending family read');
  child.turns[0].status='interrupted';emit('turn/completed',{threadId:child.id,turn:copy(child.turns[0])});await text('#notice','Family root');assert(!await page.locator('#notice').isHidden(),'One child completion cannot clear a family Stop');
  const lateChild=makeChild('family-late-child',familyRoot.id,'Late agent');emit('item/agentMessage/delta',{threadId:lateChild.id,turnId:lateChild.turns[0].id,itemId:lateChild.turns[0].items[0].id,delta:'BEFORE_METADATA'});emit('coding/family/updated',{threadId:familyRoot.id,rootThreadId:familyRoot.id});
  releaseFamily();await text('#family-list','Late agent');assert(!await page.locator('#notice').isHidden(),'Late child remains in pending family Stop');
  for(const target of [grandchild,lateChild]){target.turns[0].status='interrupted';emit('turn/completed',{threadId:target.id,turn:copy(target.turns[0])});}approvals.splice(0,approvals.length);emit('coding/family/updated',{threadId:familyRoot.id,rootThreadId:familyRoot.id});await text('#family-list','Stopped');assert(!await page.locator('#notice').isHidden(),'Cancellation fence keeps notice until the whole subtree settles');
  familyStopping.delete(familyRoot.id);emit('coding/family/updated',{threadId:familyRoot.id,rootThreadId:familyRoot.id});await page.waitForFunction(()=>document.querySelector('#notice').hidden);assert(await page.locator('#stop').isHidden(),'Settled family hides Stop');
  repeatFamilyCursor=true;await page.locator('#refresh').click();await text('#family-notice','pagination');repeatFamilyCursor=false;await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#family-notice').hidden);
  for(const width of [650,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Family navigation remains within narrow viewport');}await page.setViewportSize({width:1360,height:900});
  const wtCalls=action=>calls.filter(c=>c.op==='codingWorktrees'&&c.input.action===action), selected=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId);
  const worktreeChat=await makeConcurrent('Worktree source chat');
  await page.locator('#prompt').fill('KEEP_WORKTREE_PROMPT');await page.locator('#terminal-toggle').click();await page.locator('#terminal-command').fill('printf keep-command');await page.locator('#terminal-input').fill('keep-stdin');await page.locator('#close-panel').click();
  await page.locator('#worktrees-toggle').click();await text('#worktrees-list','needs-inspection');await text('#worktrees-list','/fixture/managed/ready');await text('#worktrees-list','a'.repeat(40));await text('#worktrees-list','b'.repeat(40));assert.equal(await selected(),worktreeChat.id);
  const wtRow=id=>page.locator(`[data-worktree-id="${id}"]`);
  assert(await wtRow('managed-missing').locator('button').isDisabled());assert(await wtRow('managed-inspect').locator('button').isDisabled());assert.equal(await page.locator('#worktrees-list img').count(),0);
  const startsBeforeWorktrees=countAction('start'), sendsBeforeWorktrees=countAction('send');
  await openDetailsFor('#worktree-choose-source');await page.locator('#worktree-choose-source').click();await text('#worktree-source','/fixture/project');await page.locator('#worktree-ref').fill('feature/local');cancelFolder=true;await openDetailsFor('#worktree-choose-source');await page.locator('#worktree-choose-source').click();assert.equal(await page.locator('#worktree-ref').inputValue(),'feature/local');
  cancelWorktreeCreate=true;await page.locator('#worktree-create').click();await page.waitForFunction(()=>!document.querySelector('#worktree-create').disabled);assert.equal(await selected(),worktreeChat.id);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  assert.deepEqual(await page.locator('#worktree-copy-option').evaluate(el=>({display:getComputedStyle(el).display,width:el.querySelector('input').getBoundingClientRect().width,height:el.querySelector('input').getBoundingClientRect().height})),{display:'flex',width:16,height:16},'Local copy choice must retain a readable native checkbox row');
  assert(!await page.locator('#worktree-copy-changes').isChecked(),'Commit-only creation stays the default');await page.locator('#worktree-copy-changes').check();
  failWorktreeCreate=true;await page.locator('#worktree-create').click();await text('#worktrees-notice','outcome uncertain');assert.equal(await page.locator('#worktree-ref').inputValue(),'feature/local');assert.equal(wtCalls('create').length,2,'Uncertain create never retries automatically');assert(await page.locator('#worktree-copy-changes').isChecked(),'Uncertain create preserves the explicit copy choice');assert.equal(wtCalls('create').at(-1).input.copyChanges,true);
  failWorktreeList=true;await page.locator('#worktrees-refresh').click();await text('#worktrees-notice','Managed list unavailable');assert(await wtRow('managed-ready').locator('[data-worktree-open]').isDisabled(),'Stale list records cannot open until verified');
  await page.locator('#worktrees-refresh').click();await page.locator('#worktree-create').click();await text('#worktrees-list','/fixture/managed/3');assert.equal(countAction('start'),startsBeforeWorktrees);assert.equal(countAction('send'),sendsBeforeWorktrees);assert.equal(await selected(),worktreeChat.id);
  assert.deepEqual(wtCalls('create').at(-1).input,{action:'create',cwd:'/fixture/project',ref:'feature/local',copyChanges:true});
  await page.locator('#worktree-ref').focus();const refFocused=()=>page.locator('#worktree-ref').evaluate(el=>el===document.activeElement);
  emit('item/agentMessage/delta',{threadId:worktreeChat.id,turnId:worktreeChat.turn.id,itemId:'worktree-stream',delta:'STREAM_DURING_WORKTREE_PANEL'});await text('#messages','STREAM_DURING_WORKTREE_PANEL');assert(await refFocused());
  holdWorktreeCreate=true;releaseWorktreeCreate=null;await page.locator('#worktree-create').click();await until(()=>releaseWorktreeCreate);assert(!await page.locator('#worktree-stop').isDisabled());assert(await page.locator('#worktree-copy-changes').isDisabled(),'Copy choice is frozen during a reviewed creation');
  const stopsBeforeWorktree=countAction('interruptFamily');deferInterruptCompletion=true;await page.locator('#stop').click();await until(()=>countAction('interruptFamily')===stopsBeforeWorktree+1);await text('#notice','Worktree source chat');
  emit('item/agentMessage/delta',{threadId:worktreeChat.id,turnId:worktreeChat.turn.id,itemId:'worktree-stream',delta:' STILL_STREAMING'});await text('#messages','STILL_STREAMING');
  await page.locator('#worktree-stop').click();await until(()=>wtCalls('stop').length===1);await page.waitForFunction(()=>!document.querySelector('#worktree-create').disabled);await text('#notice','Worktree source chat');assert.equal(worktreeChat.turn.status,'inProgress','Worktree Stop does not stop an unrelated chat');finishInterrupt();await text('#run-status','Stopped');
  const openButton=wtRow('managed-ready').locator('[data-worktree-open]');cancelWorktreeOpen=true;await openButton.click();await page.waitForFunction(()=>!document.querySelector('[data-worktree-id="managed-ready"] [data-worktree-open]').disabled);assert.equal(await selected(),worktreeChat.id);
  failWorktreeOpen=true;await openButton.click();await text('#worktrees-notice','identity changed');assert.equal(await selected(),worktreeChat.id);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  failReadOnce=true;await openButton.click();await text('#worktrees-notice','Chat created; history could not be opened');const retainedId=`managed-chat-${counter}`;assert.equal(await selected(),worktreeChat.id,'Trailing history failure cannot replace the selected chat');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  assert(await page.evaluate(id=>!!JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).pendingThreads[id],retainedId),'Created empty chat retained after failed history read');assert.equal(await page.evaluate(id=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).pendingThreads[id].model,retainedId),fixtureModel,'Managed draft keeps its explicitly selected local model');const opensBeforeRetry=wtCalls('open').length;
  await page.locator(`.chat-row[data-thread-id="${retainedId}"] button`).first().click();await text('#project-path','/fixture/managed/ready');assert.equal(wtCalls('open').length,opensBeforeRetry,'Selecting retained chat retries history without creating a duplicate');assert.equal(await page.locator('#prompt').inputValue(),'');
  await page.locator('#prompt').fill('MANAGED_UNSENT');omitEmpty=true;const actionsBeforeReload={start:countAction('start'),send:countAction('send'),open:wtCalls('open').length};await page.reload();await text('#project-path','/fixture/managed/ready');assert.equal(await selected(),retainedId);assert.equal(await page.locator('#prompt').inputValue(),'MANAGED_UNSENT');assert.deepEqual({start:countAction('start'),send:countAction('send'),open:wtCalls('open').length},actionsBeforeReload);
  threads.delete(retainedId);rejectManagedStart=true;await page.reload();await text('#project-path','/fixture/managed/ready');await page.locator('#send').click();await text('#notice','Managed checkout identity changed');assert.equal(await selected(),retainedId);assert.equal(await page.locator('#prompt').inputValue(),'MANAGED_UNSENT');assert.equal(countAction('send'),actionsBeforeReload.send);rejectManagedStart=false;
  await page.locator('#worktrees-toggle').click();await text('#worktrees-list','/fixture/managed/ready');await wtRow('managed-ready').locator('[data-worktree-open]').click();await text('#project-path','/fixture/managed/ready');await page.waitForFunction(id=>JSON.parse(localStorage.getItem('qwen-coding-ui-v1')).selectedId!==id,retainedId);assert.equal(await page.locator('#prompt').inputValue(),'');assert.equal(wtCalls('open').at(-1).input.provider,'local');assert.equal(countAction('send'),actionsBeforeReload.send);
  allowCloud=true;await page.locator('#refresh').click();await page.locator('#workspace-settings-open').click();await page.locator('#provider').selectOption('cloud');await page.locator('#workspace-settings-close').click();await text('#worktrees-provider','Fixture cloud');holdWorktreeOpen=true;releaseWorktreeOpen=null;await wtRow('managed-ready').locator('[data-worktree-open]').click();await until(()=>releaseWorktreeOpen);
  await page.locator('#workspace-settings-open').click();await page.locator('#provider').selectOption('local');await page.locator('#workspace-settings-close').click();await page.locator(`.chat-row[data-thread-id="${worktreeChat.id}"] button`).first().click();releaseWorktreeOpen();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert.equal(wtCalls('open').at(-1).input.provider,'cloud','Open captures the explicitly selected provider before awaiting native review');assert.equal(await selected(),worktreeChat.id,'Late Open result preserves a newer chat selection');assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  await page.locator('#terminal-toggle').click();assert.equal(await page.locator('#terminal-command').inputValue(),'printf keep-command');assert.equal(await page.locator('#terminal-input').inputValue(),'keep-stdin');await page.locator('#worktrees-toggle').click();
  const realRecordCount=worktrees.length;for(let i=realRecordCount;i<129;i++)worktrees.push({...worktrees[0],id:`overflow-${i}`});await page.locator('#worktrees-refresh').click();await text('#worktrees-notice','display limit');assert(await wtRow('managed-ready').locator('[data-worktree-open]').isDisabled());worktrees.length=realRecordCount;await page.locator('#worktrees-refresh').click();
  assert.equal(await page.locator('#worktree-ref').getAttribute('maxlength'),'512');for(const attribute of ['spellcheck','autocorrect','autocapitalize'])assert.equal(await page.locator('#worktree-ref').getAttribute(attribute),attribute==='spellcheck'?'false':'off');
  for(const width of [650,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Worktrees panel fits narrow viewport');}await page.setViewportSize({width:1360,height:900});
  await openDetailsFor('#worktree-choose-source');await page.locator('#worktree-choose-source').click();await text('#worktree-source','/fixture/project');
  for (const cancellation of ['stop', 'tools-stopped', 'agent-stopped', 'pagehide']) {
    heldReadThreadId=worktreeChat.id;releaseRead=null;
    await page.locator(`.chat-row[data-thread-id="${worktreeChat.id}"] button`).first().click();await until(()=>releaseRead);
    const before=wtCalls('create').length;await page.locator('#worktree-create').click();
    assert.equal(wtCalls('create').length,before,'Create is queued behind the held history read');
    if(cancellation==='stop'){
      holdWorktreeStop=true;releaseWorktreeStop=null;await page.locator('#worktree-stop').click();await until(()=>releaseWorktreeStop);
    }else await page.evaluate(name=>window.dispatchEvent(new Event(name)),cancellation);
    releaseRead();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
    assert.equal(wtCalls('create').length,before,`${cancellation} must revoke a queued create before native dispatch`);
    if(cancellation==='stop'){
      assert(await page.locator('#worktree-create').isDisabled(),'A completed create callback cannot clear an in-flight Stop');
      releaseWorktreeStop();
    }
    await page.waitForFunction(()=>!document.querySelector('#worktree-create').disabled);
    assert.equal(await selected(),worktreeChat.id);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  }
  // Synthetic pagehide permanently disposes that document; later edits need a new page.
  await page.reload();await text('#thread-title',threads.get(worktreeChat.id).name);await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);
  assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  const scheduleCalls=action=>calls.filter(c=>c.op==='codingSchedules'&&c.input.action===action), scheduleRow=id=>page.locator(`.schedule-row[data-schedule-id="${id}"]`);
  await page.locator('#schedules-toggle').click();await text('#schedules-list','Saved <img');assert.equal(await selected(),worktreeChat.id);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');assert.equal(await page.locator('#schedules-list img, #schedules-list script').count(),0);await text('#schedules-list','needs review');
  await page.locator('#schedule-name').fill('Nightly review');await page.locator('#schedule-prompt').fill('Check exact project bytes');await page.locator('#schedule-effort').selectOption('high');await page.locator('#schedule-minutes').fill('17');
  cancelSchedule=true;await page.locator('#schedule-save').click();await text('#schedules-notice','cancelled');assert.equal(await page.locator('#schedule-name').inputValue(),'Nightly review');assert.equal(await selected(),worktreeChat.id);
  await scheduleRow(scheduleId).locator('[data-schedule-action="edit"]').click();await page.locator('#schedule-name').fill('UNSAVED EXISTING');await page.locator('#schedule-new').click();assert.equal(await page.locator('#schedule-name').inputValue(),'Nightly review','Switching editor preserves new schedule draft');
  await page.locator('#schedule-save').click();await text('#schedules-notice','saved');const createdSchedule=schedules.at(-1);assert.deepEqual(scheduleCalls('save').at(-1).input,{action:'save',id:null,name:'Nightly review',cwd:threads.get(worktreeChat.id).cwd,prompt:'Check exact project bytes',effort:'high',model:fixtureModel,executionMode:'vm',cadence:{type:'interval',minutes:17}});assert.equal(await selected(),worktreeChat.id);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  await scheduleRow(scheduleId).locator('[data-schedule-action="edit"]').click();assert.equal(await page.locator('#schedule-name').inputValue(),'UNSAVED EXISTING');await page.locator('#close-panel').click();await page.locator('#schedules-toggle').click();assert.equal(await page.locator('#schedule-name').inputValue(),'UNSAVED EXISTING');
  await page.locator('#schedule-cadence').selectOption('calendar');await page.locator('#schedule-time').fill('09:30');await page.locator('#schedule-timezone').fill('Asia/Riyadh');for(const day of [0,1,2,3,4,5,6])await page.locator(`#schedule-days input[value="${day}"]`).setChecked([0,2,4].includes(day));await page.locator('#schedule-save').click();await text('#schedules-notice','saved');assert.deepEqual(scheduleCalls('save').at(-1).input.cadence,{type:'calendar',days:[0,2,4],time:'09:30',timeZone:'Asia/Riyadh'});
  await page.locator('#schedule-cadence').selectOption('once');await page.locator('#schedule-at').fill('2030-10-12T15:30');await page.locator('#schedule-save').click();await text('#schedules-notice','saved');const expectedAt=await page.evaluate(()=>new Date('2030-10-12T15:30').getTime());assert.deepEqual(scheduleCalls('save').at(-1).input.cadence,{type:'once',at:expectedAt});
  await scheduleRow(scheduleId).locator('[data-schedule-action="pause"]').click();await until(()=>!schedules[0].active);await page.waitForFunction(()=>!document.querySelector('[data-schedule-action="resume"]').disabled);failSchedule=true;await scheduleRow(scheduleId).locator('[data-schedule-action="run"]').click();await text('#schedules-notice','not started');await scheduleRow(scheduleId).locator('[data-schedule-action="resume"]').click();await until(()=>schedules[0].active);
  scheduleWarning='Project requires fresh review';scheduleHistoryTruncated=true;await page.locator('#schedules-refresh').click();await text('#schedules-warning','Project requires fresh review');await text('#schedules-warning','Earlier run history');scheduleWarning='';scheduleHistoryTruncated=false;
  await page.locator('#schedule-prompt').fill('PERSISTED SCHEDULE DRAFT');const mutationsBeforeReload=scheduleCalls('save').length+scheduleCalls('run').length+scheduleCalls('resume').length;await page.reload();await text('#thread-title',threads.get(worktreeChat.id).name);await page.locator('#schedules-toggle').click();await text('#schedules-list','Nightly review');assert.equal(await page.locator('#schedule-prompt').inputValue(),'PERSISTED SCHEDULE DRAFT');assert.equal(scheduleCalls('save').length+scheduleCalls('run').length+scheduleCalls('resume').length,mutationsBeforeReload);
  for(const cancellation of ['stop','pause','tools-stopped','agent-stopped','pagehide']){
    heldReadThreadId=worktreeChat.id;releaseRead=null;await page.locator(`.chat-row[data-thread-id="${worktreeChat.id}"] button`).first().click();await until(()=>releaseRead);
    const before=scheduleCalls('save').length;await page.locator('#schedule-save').click();assert.equal(scheduleCalls('save').length,before);
    if(cancellation==='stop')await page.locator('#schedules-stop').click();else if(cancellation==='pause')await scheduleRow(scheduleId).locator('[data-schedule-action="pause"]').click();else await page.evaluate(name=>window.dispatchEvent(new Event(name)),cancellation);
    releaseRead();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert.equal(scheduleCalls('save').length,before,`${cancellation} revokes queued save before native dispatch`);assert.equal(await page.locator('#schedule-prompt').inputValue(),'PERSISTED SCHEDULE DRAFT');assert.equal(await selected(),worktreeChat.id);
  }
  await page.reload();await text('#thread-title',threads.get(worktreeChat.id).name);await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);await page.locator('#schedules-toggle').click();await page.waitForFunction(()=>!document.querySelector('#schedule-save').disabled);
  assert.equal(await page.locator('#schedule-prompt').inputValue(),'PERSISTED SCHEDULE DRAFT');
  holdSchedule=true;releaseSchedule=null;await scheduleRow(scheduleId).locator('[data-schedule-action="run"]').click();await until(()=>releaseSchedule);const stopBefore=scheduleCalls('stop').length;await page.locator('#schedules-stop').click();await until(()=>scheduleCalls('stop').length===stopBefore+1);cancelSchedule=true;releaseSchedule();await page.waitForFunction(()=>!document.querySelector('#new-chat').disabled);assert(!schedules.some(value=>value.active));
  const startsBeforeHistory=countAction('start');await scheduleRow(scheduleId).locator('summary').click();failReadOnce=true;await scheduleRow(scheduleId).locator('[data-schedule-chat]').click();await text('#schedules-notice','History temporarily unavailable');assert.equal(await selected(),worktreeChat.id);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');await scheduleRow(scheduleId).locator('[data-schedule-chat]').click();await text('#thread-title','Saved chat');assert.equal(countAction('start'),startsBeforeHistory);await page.locator(`.chat-row[data-thread-id="${worktreeChat.id}"] button`).first().click();await text('#thread-title',threads.get(worktreeChat.id).name);assert.equal(await page.locator('#prompt').inputValue(),'KEEP_WORKTREE_PROMPT');
  await scheduleRow(createdSchedule.id).locator('[data-schedule-action="delete"]').click();await until(()=>!schedules.some(value=>value.id===createdSchedule.id));assert(threads.has('saved'),'Deleting schedule preserves run chats');
  for(const width of [650,390]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Scheduled panel fits narrow viewport');}await page.setViewportSize({width:1360,height:900});
  assert.equal(maxOrdinary,1,'Ordinary requests stay serialized through delayed response recovery and worktree/schedule review');
  assert.deepEqual(errors, []);
  const fallback = await browser.newContext(); await fallback.route('**/*', localOnly); const browserPage = await fallback.newPage(); await browserPage.goto(`http://127.0.0.1:${server.address().port}/coding`); await browserPage.getByText('Open Saleh Uncensored.app to use the coding workspace.', {exact: true}).waitFor(); assert(await browserPage.locator('#send').isDisabled()); await fallback.close();
  await checkWorktreeLifecycle();
  await checkWorktreeHandoff();
  await checkHandoffRecovery();
  await checkInteractiveTerminal();
  console.log('PASS coding UI: existing lifecycle/concurrency/family checks; managed worktree create/open/archive/restore/handoff, history and draft/reload preservation, exact payloads, uncertainty, Git invalidation and Stop fences; scheduling and reviewed Git checks.');
  }
} finally {await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
