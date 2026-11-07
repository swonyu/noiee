// Offline execution of shipped Coding UI functions with synthetic DOM/native dependencies.
// This does not exercise a browser, native controller, model, server, or real terminal.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Optional positional argument selects the exact integrated coding.js under test.
const sourcePath = process.argv[2] ? resolve(process.argv[2]) : process.env.MODEL_PICKER_SOURCE ? resolve(process.env.MODEL_PICKER_SOURCE, 'coding.js') : fileURLToPath(new URL('./coding.js', import.meta.url));
const source = readFileSync(sourcePath, 'utf8');
const submissionSource = readFileSync(resolve(dirname(sourcePath), 'coding-submission.js'), 'utf8');
const noOp = () => {};
function statement(start) {
  for (let end = source.indexOf('\n', start); end >= 0; end = source.indexOf('\n', end + 1)) {
    const text = source.slice(start, end);
    try {new vm.Script(text); return text;} catch (error) {if (!(error instanceof SyntaxError)) throw error;}
  }
  assert.fail('Shipped statement has no complete boundary');
}
function definition(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(source);
  assert(match, `Shipped ${name} function exists`);
  return statement(match.index);
}
function handler(id, next) {
  const start = source.indexOf(`  $('${id}').`);
  // Some IDs occur earlier in control updates; select the actual event assignment.
  const match = new RegExp(`^  \\$\\('${id}'\\)\\.(?:onclick|onsubmit) = `, 'm').exec(source);
  assert(start >= 0 && match, `Shipped ${id} handler exists`);
  return statement(match.index);
}
function node(text = '') {
  return {value: '', textContent: text, disabled: false, hidden: false, dataset: {}, children: [], options: [], selectedOptions: [{textContent: 'Local', disabled: false}], scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    append(...items) {this.children.push(...items);}, replaceChildren(...items) {this.children = items;}, setAttribute: noOp, querySelectorAll: () => [], classList:{toggle:noOp,add:noOp,remove:noOp}};
}
function harness(extra = {}) {
  const nodes = new Map(), calls = [], pending = [], stored = new Map();
  const $ = id => {if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id);};
  for (const id of ['prompt', 'terminal-command', 'terminal-input', 'git-message', 'git-author-name', 'git-author-email', 'git-branch-name']) $(id).value = 'fixture';
  $('provider').value = 'local'; $('effort').value = 'none';
  const thread = {id: 'saved', cwd: '/fixture', model: 'exact', modelProvider: 'local', turns: [], historyOnly: true, status: {type: 'active'}}; // Real familyBusy derives the fixture's pending work from status.
  const snapshot = {id: 'snapshot', repositoryId: 'repo', cwd: '/fixture', head: 'commit', entries: [{id: 'file', canStage: true, canUnstage: true}], branches: []};
  const git = {snapshot, usable: true, selected: new Set(['file']), revision: 0};
  const c = vm.createContext({$, calls, selectedId: thread.id, threads: new Map([[thread.id, thread]]), terminals: new Map(), threadReads: new Map(), snapshotCursors: new Map(), archived: false, listed: [], cursor: 0, disposed: false, pollFailed: false, structuredClone,
    localStorage: {getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value)},
    families: new Map(), workspaceSync: new Map(), approvals: [], questionRecords: new Map(), questionSnapshotReady: false, questionGeneration: 0,
    submissionDispatches: new Map(), codingRequest: null, stopNotice: '', stopResultEligible: false,
    listState:'idle',storageBlocked:false,attachmentReads:new Map(),attachmentStorage:{busy:false},followupStates:new Map(),
    // View-only surfaces outside these model/admission fixtures stay inert.
    observeTurns:noOp,closeSavedHistory:noOp,managedCloudChat:()=>false,renderComposerAttachments:noOp,clearImagePreviews:noOp,renderDraftAttachments:noOp,
    codingSkillProjects: new Map(), codingSkillRequests: new Set(), codingSkillsComponent: null, codingSkillsHost: null, codingSkillsOpen: false, codingSkillsScope: '', codingSkillsGeneration: 0,
    mcpSetup: null, mcpOutcomes: {invalidate: noOp, refresh: noOp, select: noOp, current:()=>({error:'',loading:false})},
    bridge: {}, engine: {available: true}, acting: false, newModel: 'exact', localModels: {online: true, models: [{id: 'exact', loaded: true, available: true, capabilities: {coding: true, standard: true, deep: true}}]},
    preferences: {unread: {}, pendingThreads: {}, gitDrafts: {repo: {}}, handoffChats: {}}, sessionView: false, familyReadSequence: 0, pendingFamilyStops: new Map(), pendingTerminalStarts: new Map(),
    gitResults: new Map([[thread.id, git]]), gitOperation: null, gitEpoch: 0, gitFormRepository: '', gitCall: async (...args) => {calls.push(['git', ...args]); return {cancelled: true};},
    worktreeMutating: false, worktreesBusy: false, worktreesReadOnly:false,worktreeCreateAvailable:true,worktreeOpenAvailable:true,worktreeRecoveryCopyAvailable:true,worktreeStopRequested: false, worktreeReconnectAvailable: false, worktreeSource: '', worktreesLoaded: false, worktrees: new Map(), handoffs: new Map(), worktreeMutation: null,
    renderModelControls: noOp, scheduleControlState: noOp,publishingControls:noOp,renderFollowups:noOp, renderGit: noOp, renderTerminal: noOp, renderSidebar: noOp, renderFamily: noOp, controls: noOp,
    renderCodingRequestFeedback: noOp, renderQuestions: noOp, renderSubmission: noOp, renderMetrics: noOp, renderMCPSetup: noOp, renderChildResult: noOp, renderStartupRecovery: noOp,
    clearCodingFilePreview: noOp, refreshTerminalResults: noOp, terminalResultEvent: () => false,
    save: noOp, pty: {availability: noOp, revoke: noOp}, crypto: {randomUUID: () => 'fixture'},
    banner: (id, text) => {$(id).textContent = text;}, message: error => error?.message || String(error), outcome: () => '', renderMessages: noOp,
    refreshStatus: async () => {calls.push(['status']);}, loadList: async () => {calls.push(['list']);}, readFamily: async () => {calls.push(['family']);}, select: async () => {},
    call: async (...args) => {calls.push(args); return {thread: {...thread}, cursor: 1};}, start: async (...args) => {calls.push(['start', ...args]);},
    element: (_tag, _class, text) => node(text), syncNode: (oldNode, replacement) => {oldNode.children = replacement.children;},
    ...extra});
  // Execute shipped pure helper definitions, not copied admission approximations. No app IIFE runs.
  const helpersEnd = source.search(/\n\((?:async )?\(\) => \{/);
  assert(helpersEnd > 0, 'Shipped pure helpers end before the application IIFE');
  const helpers = source.slice(0, helpersEnd);
  vm.runInContext(readFileSync(resolve(dirname(sourcePath),'model-policy.js'),'utf8'),c);
  vm.runInContext(readFileSync(resolve(dirname(sourcePath),'model-picker.js'),'utf8'),c);
  vm.runInContext(submissionSource, c);
  vm.runInContext('const submissionStore = SalehSubmission.createStore(localStorage);', c);
  const declarations = ['current', 'gitFields', 'childChat', 'ownedChat', 'directInput', 'canExecute', 'canStartWork', 'localThread', 'codingModelState', 'title', 'activeTurn', 'historyPending', 'setupBlocking', 'agentWorking', 'working', 'waiting', 'familyFor', 'workspaceBlocked', 'workspaceStopTarget', 'familyBusy', 'familyStopping', 'sessionIds', 'pendingQuestion', 'waitingAnswer', 'questionLabel', 'affectedCheckout'].map(name => {
    const match = source.match(new RegExp(`^  const ${name} = .*`, 'm')); assert(match, `Shipped ${name} definition exists`);
    return statement(match.index);
  }).join('\n');
  vm.runInContext(`${helpers}\n${declarations}\nthis.policy = {ownedChat, directInput, canExecute};`, c);
  for (const name of ['queueHasPending','followupEnabled']) {const match=source.match(new RegExp(`^  const ${name}=.*`,'m'));assert(match);vm.runInContext(statement(match.index),c);}
  for (const name of ['composeUsesQueue','taskModeFor']) vm.runInContext(definition(name),c);
  for (const name of ['workspaceFor', 'subtreeIds', 'checkoutNotice', 'pendingCodingRequestCount', 'codingActivityOverview', 'clearStopNotice', 'invalidateCodingSkills', 'syncCodingSkillsScope', 'codingSkillsControlState', 'revokeTerminalInput', 'cancelSubmissions', 'closeQuestion', 'cancelQuestions', 'settleFamilyStops', 'gitState', 'invalidateGit', 'rememberGitForm', 'syncMCPOutcomes', 'act']) vm.runInContext(definition(name), c);
  // Track the real action wrapper's promise; a test may explicitly instrument act to detect forbidden use.
  const shippedAct = c.act;
  c.act = extra.act || ((...args) => {const task = shippedAct(...args);pending.push(task);return task;});
  return {c, $, nodes, calls, thread, git, load: name => vm.runInContext(definition(name), c), run: code => vm.runInContext(code, c), flush: async () => {for (let i = 0; i < 10; i++) await Promise.resolve(); await Promise.all(pending);}};
}

test('merged Coding UI contains no unresolved conflicts', () => assert.doesNotMatch(source, /^(?:<<<<<<<|=======|>>>>>>>)/m));

test('history-only permissions stay closed for present, missing, and offline models', () => {
  const h = harness();
  for (const catalog of [h.c.localModels, {online: true, models: []}, {online: false, models: []}]) {
    h.c.localModels = catalog;
    for (const name of ['ownedChat', 'directInput', 'canExecute']) assert.equal(h.c.policy[name](h.thread), false, name);
  }
  for (const extra of [{metadataPending: true}, {archived: true}, {parentThreadId: 'parent'}, {canAcceptDirectInput: false}]) assert.equal(h.c.policy.canExecute({...h.thread, historyOnly: false, ...extra}), false);
});

test('history-only controls block new chat, fork and Git while scoped Stops remain available', () => {
  const h = harness(); h.load('gitControlState'); h.load('controls');
  h.c.terminals.set('saved', {processId: 'terminal', running: true});
  for (const models of [h.c.localModels.models, []]) {
    h.c.localModels.models = models; h.c.controls();
    for (const id of ['new-chat', 'fork-chat', 'rename-chat', 'archive-chat', 'send', 'review-changes', 'refresh-changes', 'changes-toggle', 'git-stage', 'git-commit', 'terminal-run']) assert.equal(h.$(id).disabled, true, id);
    assert.equal(h.$('stop').disabled, false); assert.equal(h.$('terminal-stop').disabled, false);
    assert.equal(h.$('run-status').textContent, 'Saved history');
  }
});

test('missing model blocks inference but leaves owned-chat Git and independent terminals available', () => {
  const h = harness(); h.thread.historyOnly = false; h.c.localModels.models = []; h.load('gitControlState'); h.load('controls'); h.c.controls();
  for (const id of ['send', 'review-changes', 'new-chat']) assert.equal(h.$(id).disabled, true, id);
  for (const id of ['terminal-run', 'terminal-shell', 'terminal-toggle', 'git-stage', 'git-commit', 'refresh-changes']) assert.equal(h.$(id).disabled, false, id);
});

test('event handlers refuse history-only fork, new chat and Git mutations with a loaded model', async () => {
  const h = harness();
  h.run(handler('fork-chat')); h.run(handler('new-chat')); h.load('mutateGit');
  await h.$('new-chat').onclick(); await h.$('fork-chat').onclick(); await h.c.mutateGit('stage'); await h.flush();
  assert.deepEqual(h.calls, []);
});

test('saved read retains top-level history-only/source metadata and original model identity', async () => {
  const h = harness(); h.thread.historyOnly = false;
  h.c.call = async (op, input) => {h.calls.push([op, input]); return {thread: {id: 'saved', cwd: '/fixture', model: 'missing-model', turns: []}, historyOnly: true, historySource: 'creation-receipt', cursor: 4};};
  h.load('readThread'); const result = await h.c.readThread('saved');
  assert.equal(result.historyOnly, true); assert.equal(result.historySource, 'creation-receipt'); assert.equal(result.model, 'missing-model');
  assert.deepEqual(h.calls.map(([op]) => op), ['read']); assert.equal(h.c.policy.canExecute(result), false);
});

test('saved-empty labels survive model selection and missing inventory', () => {
  const h = harness(); h.thread.historySource = 'creation-receipt'; h.c.localModels.models = [];
  h.load('gitControlState'); h.load('controls'); h.load('renderTurns'); h.load('renderMessages'); h.c.controls(); h.c.renderMessages();
  assert.equal(h.$('run-status').textContent, 'Saved empty chat');
  assert.match(h.$('child-notice').textContent, /creation record is saved/);
  assert.match(h.$('messages').children.map(child => child.textContent).join('\n'), /saved creation record preserves this chat’s original identity/);
});

for (const startup of [false, true]) {
  test(`model inventory cannot hold the ${startup ? 'startup status' : 'saved-history refresh'} lane`, async () => {
    const h = harness({refreshModels: () => new Promise(() => {}), readThread: async () => {h.calls.push(['read']);}});
    if (startup) {
      const marker = "if (!bridge) {banner('notice', 'Open Noiee.app";
      const start = source.indexOf('\n', source.indexOf(marker)) + 1;
      const end = source.indexOf('    try {await refreshWorktrees();}', start);
      assert(start > 0 && end > start); h.run(source.slice(start, end) + '\n  });');
    } else {h.run(handler('refresh')); h.$('refresh').onclick();}
    for (let i = 0; i < 12; i++) await Promise.resolve();
    assert(h.calls.some(([op]) => op === 'status'), `${startup ? 'startup' : 'refresh'} reaches status while inventory is unresolved`);
    assert(h.calls.some(([op]) => op === 'list'), `${startup ? 'startup' : 'refresh'} reaches saved list while inventory is unresolved`);
    if (!startup) assert(h.calls.some(([op]) => op === 'read'));
  });
}

test('explicit model refresh does not occupy the ordinary action lane', async () => {
  const h = harness({refreshModels: () => new Promise(() => {}), act: () => {throw Error('Model refresh occupied the ordinary action lane');}});
  h.run(handler('models-refresh')); h.$('models-refresh').onclick();
});

test('scoped Stop and existing-terminal Stop dispatch with missing model and history-only selection', async () => {
  const h = harness(); h.c.localModels.models = []; h.c.terminals.set('saved', {processId: 'independent', running: true});
  h.run(handler('stop', 'rename-chat')); h.run(handler('terminal-stop'));
  await h.$('stop').onclick(); await h.$('terminal-stop').onclick();
  assert.deepEqual(h.calls.filter(([op]) => ['interruptFamily', 'terminalStop'].includes(op)).map(([op, input]) => [op, {...input}]), [['interruptFamily', {threadId: 'saved'}], ['terminalStop', {processId: 'independent'}]]);
});

for (const completion of ['immediate-family', 'event-family']) {
  test(`owner Stop ${completion} settlement refreshes saved history once and preserves drafts and cursors`, async () => {
    const h = harness({invalidFamilies: new Set(), familyReads: new Map(), familyWarnings: new Map(), familyReadSequence: 1, cursor: 11, renderApprovals: noOp});
    h.thread.historyOnly = false; h.thread.status = {type: 'idle'};
    h.thread.turns = [{id: 'stopped-turn', status: 'failed', error: {message: 'Coding engine closed.'}, items: []}];
    h.c.families.set('saved', {rootThreadId: 'saved', ids: ['saved'], stoppingTargets: [], readSequence: 1});
    h.c.pendingFamilyStops.set('saved', {requestPending: false, afterRead: 1});
    h.c.preferences.drafts = {saved: 'unsent composer draft'}; h.$('prompt').value = h.c.preferences.drafts.saved;
    const question = {id: 'closed-question', params: {threadId: 'saved'}, live: false, fields: [{question: {id: 'answer'}, input: {value: 'unsent question draft'}}]};
    h.c.questionRecords.set(question.id, question);
    h.load('applyEvent'); h.load('readThread'); h.load('readFamily'); h.load('retainReadEvent');
    const event = {sequence: 11, method: 'coding/family/updated', params: {threadId: 'saved', rootThreadId: 'saved'}};
    const replay = new Set(); h.c.applyEvent(event, replay, new Set(), true);
    assert.equal(replay.size, 0); assert.equal(h.c.invalidFamilies.size, 0, 'History replay must not schedule another refresh');
    const unrelated = new Set(); h.c.applyEvent({...event, params: {threadId: 'peer', rootThreadId: 'peer'}}, unrelated, new Set());
    assert.equal(unrelated.size, 0, 'An unrelated root must not reload the stopped chat');
    h.c.call = async (op, input) => {
      h.calls.push([op, input]); assert.equal(input.threadId, 'saved');
      const thread = {...h.thread, turns: [{id: 'stopped-turn', status: 'interrupted', items: []}]};
      if (op === 'read') {h.c.retainReadEvent(event); return {thread, cursor: 10};}
      assert.equal(op, 'family'); return {rootThreadId: 'saved', root: thread, threads: [], stoppingTargets: [], nextCursor: null};
    };
    h.c.settleFamilyStops();
    assert.equal(h.calls.length, 0, 'Old family metadata cannot trigger a history refresh');
    if (completion === 'event-family') {
      const reload = new Set(); h.c.applyEvent(event, reload, new Set());
      assert.equal(reload.size, 0, 'An update alone cannot bypass the fresh family settlement guard');
      assert.equal(h.c.invalidFamilies.has('saved'), true);
    }
    await h.c.readFamily('saved', true);
    await h.c.threadReads.get('saved')?.promise;
    assert.equal(h.c.familyWarnings.size, 0);
    assert.equal(h.c.pendingFamilyStops.has('saved'), false, 'Fresh guarded family metadata settles the local Stop');
    assert.equal(h.calls.filter(([op]) => op === 'read').length, 1, 'Settlement must refresh saved turn history even before its final event arrives');
    assert.equal(h.c.threads.get('saved').turns[0].status, 'interrupted');
    const settled = new Set(); h.c.applyEvent(event, settled, new Set());
    assert.equal(settled.size, 0, 'A later event without pending Stop must not reload history');
    await h.c.readFamily('saved', true); h.c.settleFamilyStops();
    assert.deepEqual(h.calls.map(([op]) => op), ['family', 'read', 'family'], 'Repeated metadata settlement must not repeat the history read');
    assert.equal(h.c.cursor, 11); assert.equal(h.c.snapshotCursors.get('saved'), 10);
    assert.equal(h.$('prompt').value, 'unsent composer draft'); assert.equal(h.c.preferences.drafts.saved, 'unsent composer draft');
    assert.equal(h.c.questionRecords.get(question.id), question); assert.equal(question.fields[0].input.value, 'unsent question draft');
  });
}

test('independent terminal start dispatches for owned chat even when its model is missing', async () => {
  const h = harness(); h.thread.historyOnly = false; h.c.localModels.models = [];
  h.c.call = async (op, input) => {h.calls.push([op, input]); return {processId: 'synthetic'};};
  h.run(handler('terminal-form', 'terminal-input-form')); h.$('terminal-form').onsubmit({preventDefault: noOp}); await h.flush();
  assert.deepEqual(h.calls.map(([op, input]) => [op, {...input}]), [['terminalStart', {threadId: 'saved', command: 'fixture'}]]);
});
