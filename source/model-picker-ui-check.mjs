async function fixtureSnapshot(value) {
 const payload=value===undefined?undefined:JSON.stringify(value),hash=payload===undefined?null:[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const db=await new Promise((yes,no)=>{const r=indexedDB.open('saleh-chat-snapshots-v1',1);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});
 return new Promise((yes,no)=>{const tx=db.transaction('snapshots',payload===undefined?'readonly':'readwrite'),store=tx.objectStore('snapshots'),r=store.get('head');let result;r.onsuccess=()=>{if(payload===undefined)result=JSON.parse(r.result.payload);else{result=value;store.put({...r.result,payload,hash,revision:r.result.revision+1,commitId:crypto.randomUUID()},'head');}};tx.oncomplete=()=>{db.close();yes(result);};tx.onabort=()=>{db.close();no(tx.error);};});
}
// Offline tests of shipped UI model logic and Agent request payloads.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.MODEL_PICKER_SOURCE ? pathToFileURL(resolve(process.env.MODEL_PICKER_SOURCE) + '/') : new URL('.', import.meta.url);
const source = name => readFileSync(new URL(name, root), 'utf8');
const legacy = 'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp';
const preferred = 'local/saleh-qwen38-uncensored-8bit';
const defaultKey = 'saleh-local-model-default-v1';
const storage = (entries = {}) => {
  const values = new Map(Object.entries(entries));
  return {getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value))};
};
const model = (id, extra = {}) => ({id, key: id, label: id, loaded: true, available: true, state: 'loaded', capabilities: {chat: true, agent: true, coding: true, standard: true, deep: true, vision: false}, reasons: {}, ...extra});
const catalog = {online: true, defaultModel:legacy, models: [model(legacy), model('other'), model('standard-only', {capabilities: {chat: true, agent: true, coding: true, standard: true, deep: false}}), model('unloaded', {loaded: false, state: 'installed'}), model('unsupported', {capabilities: {chat: false, agent: false, coding: false, deep: false}, reasons: {chat: 'Unsupported chat format'}, state: 'unsupported'})]};
function helpers(file, localStorage = storage()) {
  const text = source(file), start = text.indexOf('// MODEL PICKER HELPERS BEGIN'), end = text.indexOf('// MODEL PICKER HELPERS END');
  assert(start >= 0 && end > start, `${file} model picker helpers must exist`);
  const context = vm.createContext({localStorage});
  vm.runInContext(source('model-policy.js')+'\n'+source('model-picker.js')+'\nconst pendingModelDefaults=new WeakSet();', context);
  vm.runInContext(text.slice(start, end) + '\nthis.api = {modelDefault, modelEligibility, modelOptions,connectionState,capabilityOverview};', context);
  return {context, api: context.api};
}
for (const file of ['app.js', 'coding.js']) {
  test(`${file}: fresh default comes only from inventory, preserves missing saved ID`, () => {
    assert.equal(helpers(file).api.modelDefault(), '');
    assert.equal(helpers(file).api.modelDefault(catalog), legacy);
    assert.equal(helpers(file).api.modelDefault({online:true,models:[model('custom')]}), 'custom');
    assert.equal(helpers(file).api.modelDefault({online:true,models:[model('a'),model('b')]}), '');
    const fresh=helpers(file).api;
    assert.equal(fresh.modelDefault({online:true,defaultModel:legacy,models:[model(legacy,{loaded:false}),model('ready')]}), 'ready');
    assert.equal(fresh.modelDefault({online:true,defaultModel:legacy,models:[model(legacy,{capabilities:{chat:true,coding:false,standard:true}}),model('ready')]},'coding'), 'ready');
    assert.equal(fresh.modelDefault({online:true,defaultModel:legacy,models:[model(legacy,{loaded:false}),model('ready-a'),model('ready-b')]}), '');
    assert.equal(fresh.modelDefault({online:true,defaultModel:legacy,models:[model(legacy,{loaded:false}),model('other',{loaded:false})]}), legacy);
    assert.equal(helpers(file,storage({[defaultKey]:preferred})).api.modelDefault(catalog), preferred);
    assert.equal(helpers(file).api.modelEligibility(catalog,preferred,'chat').code, 'MODEL_SELECTION_MISSING');
    assert.equal(helpers(file, storage({[defaultKey]: 'removed'})).api.modelDefault(), 'removed');
    assert.equal(helpers(file, storage({[defaultKey]: ''})).api.modelDefault(), '');
    assert.equal(helpers(file, {getItem() {throw Error('blocked');}}).api.modelDefault(), '');
  });
  test(`${file}: readiness fails closed for unknown, unloaded and incompatible choices`, () => {
    const {api} = helpers(file);
    assert.equal(api.modelEligibility(catalog, 'other', 'chat').ready, true);
    for (const id of ['missing', 'unloaded', 'unsupported', '']) assert.equal(api.modelEligibility(catalog, id, 'chat').ready, false, id);
    assert.match(api.modelEligibility(catalog, 'unsupported', 'chat').reason, /Unsupported chat format/);
    assert.equal(api.modelEligibility({...catalog, online: false}, 'other', 'chat').ready, false);
    assert.equal(api.modelEligibility({online: true, models: [model('unknown', {capabilities: {}})]}, 'unknown', 'coding').ready, false);
    assert.equal(api.modelEligibility({online: true, models: [model('standard', {capabilities: {chat: true, deep: false}})]}, 'standard', 'chat', true).ready, false);
  });
  test(`${file}: options retain unavailable selection and literal labels`, () => {
    const {api, context} = helpers(file);
    context.document = {createElement: tag => ({tag, textContent: '', value: ''})};
    const select = {children: [], get options() {return this.children;}, replaceChildren(...nodes) {this.children = nodes;}, append(node) {this.children.push(node);}, value: ''};
    api.modelOptions(select, {...catalog, models: [...catalog.models, model('unsafe', {label: '<img src=x onerror=alert(1)>'})]}, 'removed');
    assert.equal(select.value, 'removed');
    assert(select.children.some(option => option.value === 'removed' && /unavailable|missing/i.test(option.textContent)));
    assert(select.children.some(option => option.value === 'unloaded' && /installed/i.test(option.textContent)));
    assert(select.children.some(option => option.value === 'unsupported' && /unsupported/i.test(option.textContent)));
    assert(select.children.some(option => option.value === 'unsafe' && option.textContent.includes('<img')));
  });
  test(`${file}: unchanged inventory preserves options and reconciles an unsaved selection`, () => {
    const {api, context} = helpers(file);
    context.document = {createElement: tag => ({tag, textContent: '', value: ''})};
    const select = {children: [], get options() {return this.children;}, replaceChildren(...nodes) {this.children = nodes;}, append(node) {this.children.push(node);}, value: ''};
    api.modelOptions(select, catalog, legacy);
    const original = [...select.options];
    for (let i = 0; i < 12; i++) api.modelOptions(select, structuredClone(catalog), legacy);
    assert.equal(select.options.length, original.length);
    original.forEach((option, index) => assert.equal(select.options[index], option, 'Polling must retain each existing option'));
    select.value = 'other'; // A preference write failed; controls must restore the saved default.
    api.modelOptions(select, catalog, legacy);
    assert.equal(select.value, legacy);
    original.forEach((option, index) => assert.equal(select.options[index], option));
    api.modelOptions(select, catalog, 'other');
    assert.equal(select.value, 'other');
    original.forEach((option, index) => assert.equal(select.options[index], option, 'A known selected ID does not change the choices'));
    const changed = structuredClone(catalog); changed.models[1].label = 'Renamed model';
    api.modelOptions(select, changed, 'other');
    assert(select.options.some(option => option.value === 'other' && option.textContent.includes('Renamed model')));
    assert.equal(select.value, 'other');
    api.modelOptions(select, {...changed, models: changed.models.filter(row => row.id !== 'other')}, 'other');
    assert(select.options.some(option => option.value === 'other' && /unavailable/.test(option.textContent)));
    assert.equal(select.value, 'other');
  });
}
test('legacy chats migrate to the fixed model, never the new default', () => {
  const {context} = helpers('app.js', storage({[defaultKey]: 'other'}));
  const text = source('app.js'), start = text.indexOf('function normalizeChats('), end = text.indexOf('\nfunction notice(', start);
  Object.assign(context, {window: {}, qwenWork: {}});
  vm.runInContext(text.slice(start, end), context);
  const old = {id: 'old', title: 'Existing', draft: '', messages: []};
  assert.equal(context.normalizeChats([old])[0].model, legacy);
  assert.equal(context.normalizeChats([{...old, model: 'removed'}])[0].model, 'removed');
});
test('new chats snapshot the default and do not change existing chats', () => {
  const localStorage = storage(), {context} = helpers('app.js', localStorage);
  Object.assign(context, {crypto: {randomUUID: () => 'fixture'}, window: {}});
  const definition = source('app.js').match(/^const newChat = .*$/m)?.[0];
  assert(definition); vm.runInContext(definition + '\nthis.createChat = newChat;', context);
  assert.equal(context.createChat().model, '');
  assert.equal(context.createChat(catalog).model, legacy);
  localStorage.setItem(defaultKey, 'other');
  const first = context.createChat();
  localStorage.setItem(defaultKey, 'removed');
  assert.equal(first.model, 'other');
  assert.equal(context.createChat().model, 'removed');
});
test('new chats choose Deep only when the selected model confirms support', () => {
  const localStorage = storage({[defaultKey]: 'standard-only'}), {context} = helpers('app.js', localStorage);
  Object.assign(context, {crypto: {randomUUID: () => 'fixture'}, window: {}});
  const definition = source('app.js').match(/^const newChat = .*$/m)?.[0];
  assert(definition); vm.runInContext(definition + '\nthis.createChat = newChat;', context);
  const first = context.createChat(catalog);
  assert.equal(first.model, 'standard-only');
  assert.equal(first.thinking, 'standard', 'A loaded Standard-only model must start with a supported response mode');
  assert.equal(context.createChat().thinking, 'standard', 'Before inventory is available, Deep support is unconfirmed');
  localStorage.setItem(defaultKey, 'other');
  assert.equal(context.createChat(catalog).thinking, 'deep', 'Confirmed Deep models retain the existing default');
  assert.equal(first.model, 'standard-only'); assert.equal(first.thinking, 'standard');
});
test('New chat before inventory preserves an empty saved Deep chat and opens a ready draft', () => {
  const {context, api} = helpers('app.js', storage({[defaultKey]: 'standard-only'}));
  const old = {id: 'saved-deep', title: 'Saved', updated: 1, draft: '', project: '', notes: '', model: 'standard-only', thinking: 'deep', mode: 'chat', file: null, messages: []};
  const before = JSON.stringify(old), button = {};
  Object.assign(context, {storageHydrating:false,storageBlocked:false,restoring:false,structuralPending:false,crypto: {randomUUID: () => 'fresh'}, window: {}, chats: [old], localModels: {online: null, models: []}, attachmentReads: new WeakMap(), draftAttachments: () => [], selectedId: old.id, document: {body: {classList: {remove() {}}}}, sidebarState() {}, save() {}, render() {}, $: id => id === 'new-chat' ? button : {focus() {}}});
  const text = source('app.js'), definition = text.match(/^const newChat = .*$/m)?.[0];
  assert(definition); vm.runInContext(definition, context);
  const start = text.indexOf("$('new-chat').onclick = "), end = text.indexOf("\n$('search').oninput", start);
  assert(start >= 0 && end > start); vm.runInContext(text.slice(start, end), context);
  button.onclick();
  assert.equal(context.selectedId, 'fresh', 'Unknown Deep support must not reuse the saved incompatible empty chat');
  assert.equal(context.chats.length, 2); assert.equal(JSON.stringify(old), before);
  const fresh = context.chats[0];
  assert.equal(fresh.model, 'standard-only'); assert.equal(fresh.thinking, 'standard');
  assert.equal(api.modelEligibility(catalog, fresh.model, fresh.mode, fresh.thinking === 'deep').ready, true);
});
test('Coding start snapshots the selected local model and blocks an unloaded choice', async () => {
  const {context} = helpers('coding.js');
  const text = source('coding.js'), from = text.indexOf('  async function start(cwd'), to = text.indexOf('  async function adoptStartedThread', from);
  const calls = [];
  Object.assign(context, {newModel: 'other', localModels: catalog, selectedId: 'existing', setupBlocking: () => false, checkoutNotice: () => '', $: id => ({value: id === 'execution-mode' ? 'native' : 'local'}), call: async (action, input) => {calls.push({action, input}); return {thread: {id: 'new', model: input.model}};}, adoptStartedThread: async () => {}});
  vm.runInContext(text.slice(from, to), context);
  await context.start('/fixture');
  assert.equal(calls[0].input.model, 'other');
  assert.equal(calls[0].input.executionMode, 'native');
  context.newModel = 'unloaded';
  await assert.rejects(context.start('/fixture'), /not loaded/i);
  assert.equal(calls.length, 1);
});
test('Coding pending drafts retain the pinned model instead of a later default', () => {
  const {context} = helpers('coding.js', storage({[defaultKey]: 'other'}));
  const text = source('coding.js'), from = text.indexOf('  function rememberPending('), to = text.indexOf('\n  function ', from + 5);
  Object.assign(context, {preferences: {pendingThreads: {}}, title: value => value.name, save() {}});
  vm.runInContext(text.slice(from, to), context);
  context.rememberPending({id: 'existing', cwd: '/fixture', name: 'Draft', model: legacy}, 'local');
  assert.equal(context.preferences.pendingThreads.existing.model, legacy);
});
test('Coding observes the first shared-default change without rewriting an explicit new-chat choice', () => {
  const {context} = helpers('coding.js', storage({[defaultKey]: 'other'}));
  let listener;
  Object.assign(context, {newModel: legacy, localModels:catalog, controls() {}, window: {addEventListener: (_name, callback) => {listener = callback;}}});
  const line = source('coding.js').split('\n').find(value => value.includes("window.addEventListener('storage'") && value.includes('LOCAL_MODEL_DEFAULT_KEY'));
  assert(line); vm.runInContext(line, context);
  listener({key: defaultKey, oldValue: null, newValue: 'other'});
  assert.equal(context.newModel, 'other');
  context.newModel = 'explicit-choice';
  listener({key: defaultKey, oldValue: 'other', newValue: 'next'});
  assert.equal(context.newModel, 'explicit-choice');
});
test('Coding pending restoration migrates absent model only; invalid null remains blocked', () => {
  const {context} = helpers('coding.js');
  Object.assign(context, {threads: new Map(), preferences: {pendingThreads: {old: {cwd: '/fixture', provider: 'local'}, invalid: {cwd: '/fixture', provider: 'local', model: null}}}});
  const text = source('coding.js'), from = text.indexOf('    for (const [id, draft] of Object.entries(preferences.pendingThreads))'), to = text.indexOf('\n  } catch', from);
  vm.runInContext(text.slice(from, to), context);
  assert.equal(context.threads.get('old').model, legacy);
  assert.equal(context.threads.get('invalid').model, '');
});
test('Coding new project captures model before the asynchronous folder chooser', async () => {
  const {context} = helpers('coding.js');
  const button = {}, provider = {value: 'local'}, calls = [];
  let release;
  Object.assign(context, {newModel: 'other', localModels:catalog, refreshModels:async()=>{}, selectedId: 'origin', $: id => id === 'provider' ? provider : button, act: async fn => fn(), native: () => new Promise(resolve => {release = resolve;}), start: async (cwd, selection) => calls.push({cwd, selection})});
  const code=source('coding.js'),start=code.indexOf("  $('new-project').onclick"),end=code.indexOf("  $('new-chat').onclick",start);
  assert(start>=0&&end>start);vm.runInContext(code.slice(start,end),context);
  const work = button.onclick(); context.newModel = legacy; provider.value = 'cloud';
  for(let n=0;n<10&&!release;n++)await Promise.resolve();assert.equal(typeof release,'function');release({cwd: '/fixture'}); await work;
  assert.equal(calls[0].selection?.model, 'other');
  assert.equal(calls[0].selection?.provider, 'local');
});
test('New project checks actual local readiness before opening the native folder picker', async () => {
  const code=source('coding.js'),from=code.indexOf("  $('new-project').onclick"),to=code.indexOf("  $('new-chat').onclick",from);
  for(const selected of ['missing','unloaded','unsupported']) {
    const {context}=helpers('coding.js'),button={},calls=[];
    Object.assign(context,{newModel:selected,selectedId:null,localModels:catalog,$:id=>id==='provider'?{value:'local'}:button,act:fn=>fn(),refreshModels:async()=>calls.push('inventory'),native:async()=>{calls.push('folder');return {};},start:async()=>calls.push('start')});
    vm.runInContext(code.slice(from,to),context);
    await assert.rejects(button.onclick());assert.deepEqual(calls,['inventory']);
  }
});
test('Readiness distinguishes inventory failure from a connected loaded model with an unavailable mode',()=>{
  const {api}=helpers('app.js');
  const small={...catalog,models:[model('small',{contextLength:8192,capabilities:{chat:true,agent:false,coding:false,standard:true,deep:false},reasons:{coding:'Tasks require 32768 tokens.'}})]};
  const state=api.connectionState(small,api.modelEligibility(small,'small','coding'));
  assert.match(state.label,/Model loaded/);assert.equal(state.state,'unavailable');
  const malformed={online:false,connected:true,status:'invalid',models:[],error:{code:'LOCAL_MODEL_INVENTORY_INVALID'},message:'Inventory format is invalid.'};
  assert.equal(api.connectionState(malformed,api.modelEligibility(malformed,'small','chat')).label,'Model inventory error');
  assert.match(api.capabilityOverview(small,'small'),/8,192 tokens loaded/);assert.match(api.capabilityOverview(small,'small'),/Tasks require 32768/);
});
for(const mode of ['chat','agent'])test(mode+' generation captures model and reasoning before backend admission', async () => {
  const text = source('app.js'), from = text.indexOf('async function generate('), to = text.indexOf("$('restore-file').onchange", from);
  assert(from >= 0 && to > from);
  const calls = [], notices = [], selected={contextLength:131072};let release;
  const response = new Promise(resolve => {release = resolve;});
  const context = vm.createContext({
    activeRuns: new Map(), storageHydrating: false, storageBlocked: false, restoring:false,structuralPending:false,computerBusy: false, deletingChats: new Set(), textRunsReady: true, TextEncoder,
    attachmentReads: new WeakMap(), chatModelState: () => ({ready: true,entry:selected}), notice: value => notices.push(value), AbortController,
    qwenWork: {normalizeSources: value => value},
    generateRun: async (chat, selection, preserveDraft) => {await response;calls.push({messages:chat.messages, selection,preserveDraft});},
  });
  vm.runInContext(source('attachments.js') + '\nthis.attachments = SalehAttachments;', context);
  const occupancy=text.indexOf('const activeFor = ');assert(occupancy>=0);vm.runInContext(text.slice(occupancy,text.indexOf('\nlet showArchived',occupancy)),context);
  vm.runInContext(text.slice(from, to), context);
  const chat = {id: 'chat', model: 'other', thinking: 'standard', mode, messages: [{role: 'user', content: 'Fixture'}]};
  const running = context.generate(chat);
  chat.model = legacy; chat.thinking = 'deep';selected.contextLength=8192;release();await running;
  assert.equal(calls.length, 1);assert.equal(calls[0].selection.model, 'other');assert.equal(calls[0].selection.thinking, 'standard');
  assert.equal(calls[0].selection.contextLength,131072);
  assert.equal(calls[0].messages.at(-1).content, 'Fixture');assert.equal(notices.length, 0);
});

test('real frontend selectors and dispatch through a routed browser fixture', {skip: process.env.MODEL_PICKER_BROWSER !== '1'}, async t => {
  const {chromium} = await import('playwright');
  let browser;
  try {browser = await chromium.launch({channel: 'chrome', headless: true, chromiumSandbox: true});}
  catch (error) {
    if (/EPERM|EACCES|Operation not permitted|Permission denied|sandbox|bootstrap_check_in|MachPortRendezvous/i.test(error.message)) {
      t.diagnostic(`BLOCKED browser launch/environment: ${error.message.split('\n')[0]}; ${/SIGABRT/.test(error.message) ? 'Chrome exited SIGABRT; ' : ''}${/kill EPERM/.test(error.message) ? 'cleanup kill EPERM' : 'permission/sandbox diagnostic'}`); t.skip('Browser execution blocked; no sandbox weakening'); return;
    }
    throw error;
  }
  const errors = [], nativeCalls = [], chatCalls = [], runs=new Map(), admissions=new Map(),generation=crypto.randomUUID();
  const assetNames = {'/': 'index.html', '/coding': 'coding.html', '/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/xterm-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js', '/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css'};
  const assets = new Set(['model-policy.js','model-picker.js','chat-storage.js','chat-runs.js','coding-submission.js', 'attachments.js','attachment-storage.js','coding-metrics.js','coding-skills.js','coding-mcp-setup.js','workspace.css','workspace-extensions.js','workspace.js','index.html', 'app.js', 'style.css', 'tools.js', 'computer.js', 'work.js', 'coding.html', 'coding.js', 'coding.css', 'coding-terminal.js']);
  // Match the real app's trustworthy loopback origin; nonlocal HTTP disables crypto.randomUUID.
  const setup = async context => context.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, 'http://127.0.0.1:18787', 'Fixture must not contact any other origin');
    if (url.pathname === '/api/models') return route.fulfill({json: catalog});
    if(url.pathname==='/api/chat/runs'){
      const input=route.request().postDataJSON();let result;
      if(input.action==='list')result={generation,truncated:false,runs:[...runs.values()]};
      else if(input.action==='prepare'){result={runId:input.runId,inputDigest:input.inputDigest,generation,ticket:crypto.randomUUID()};admissions.set(input.runId,result);}
      else if(input.action==='start'){
        chatCalls.push(input);const now=Date.now(),row={version:1,runId:input.runId,chatId:input.chatId,userMessageId:input.userMessageId,assistantMessageId:input.assistantMessageId,inputDigest:admissions.get(input.runId).inputDigest,userMessage:input.messages.at(-1).content,requestedModel:input.model,resolvedModel:input.model,thinking:input.thinking,createdAt:now,updatedAt:now,endedAt:now,revision:1,status:'complete',content:'Fixture reply',reasoning:'',finishReason:'stop',stopRequested:false,error:null};
        result={run:row,live:false,durableRevision:1,persistence:'saved',saveError:null};runs.set(input.runId,result);
      }else if(input.action==='read')result=runs.get(input.runId)??{run:null,live:false,durableRevision:0,persistence:'absent',saveError:null};
      else throw Error('Unexpected fixture run action '+input.action);
      return route.fulfill({json:result});
    }
    const name = assetNames[url.pathname] || url.pathname.slice(1);
    if (!assetNames[url.pathname] && !assets.has(name)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({body: readFileSync(new URL(name, root)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'});
  });
  const failedDefaultSave = async page => {
    const before = await page.locator('#default-model').inputValue();
    await page.evaluate(key => {
      window.fixtureDefaultOptions = [...document.querySelector('#default-model').options];
      window.fixtureDefaultSetter = Storage.prototype.setItem;
      Storage.prototype.setItem = function(name, value) {if (name === key) throw new DOMException('Fixture default save failure', 'QuotaExceededError'); return window.fixtureDefaultSetter.call(this, name, value);};
    }, defaultKey);
    try {
      await page.locator('#default-model').selectOption(legacy);
      assert.equal(await page.locator('#default-model').inputValue(), before);
      assert.match(await page.locator('#notice').textContent(), /default could not be saved/);
      assert(await page.evaluate(() => window.fixtureDefaultOptions.every((option, index) => document.querySelector('#default-model').options[index] === option)));
    } finally {await page.evaluate(() => {Storage.prototype.setItem = window.fixtureDefaultSetter;});}
  };
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 900}}); await setup(context);
    await context.addInitScript(({legacy, defaultKey}) => {
      if (!localStorage.getItem('qwen-local-chats-v1')) {
        localStorage.setItem(defaultKey, 'other');
        localStorage.setItem('qwen-local-chats-v1', JSON.stringify({selectedId: 'old', chats: [{id: 'old', title: 'Existing chat', draft: 'Preserved', thinking: 'standard', mode: 'chat', messages: []}]}));
      }
    }, {legacy, defaultKey});
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
    await page.goto('http://127.0.0.1:18787/');
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('Loaded locally'));
    assert.equal(await page.locator('#chat-model').inputValue(), legacy);
    assert.equal(await page.locator('#default-model').inputValue(), 'other');
    await page.locator('#new-chat').click();
    assert.deepEqual(errors, [], 'Creating a chat must not throw in the browser');
    assert.equal(await page.locator('#chat-model').inputValue(), 'other');
    await page.locator('#workspace-settings-open').click();
    await failedDefaultSave(page);
    assert.equal(await page.locator('#chat-model').inputValue(), 'other');
    await page.locator('#workspace-settings-close').click();
    await page.locator('#chat-model').selectOption('unloaded');
    await page.locator('#prompt').fill('Do not dispatch an unloaded model');
    assert(await page.locator('#send').isDisabled());
    assert.match(await page.locator('#model-status').textContent(), /not loaded/i);
    await page.evaluate(() => document.querySelector('#composer').dispatchEvent(new Event('submit', {cancelable: true})));
    assert.equal(chatCalls.length, 0);
    await page.locator('#chat-model').selectOption('other');
    await page.locator('#thinking').selectOption('standard');
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#messages').textContent.includes('Fixture reply'));
    assert.equal(chatCalls[0].model, 'other');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('Loaded locally'));
    assert.equal(await page.locator('#chat-model').inputValue(), 'other');
    await page.locator('#chat-model').selectOption('unsupported');
    assert.match(await page.locator('#model-status').textContent(), /Unsupported chat format/);
    for (const width of [760, 390]) {await page.setViewportSize({width, height: 844}); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));}
    await context.close();

    const standard = await browser.newContext({viewport: {width: 1280, height: 900}}); await setup(standard);
    await standard.addInitScript(({defaultKey}) => {
      localStorage.setItem(defaultKey, 'standard-only');
      const chat = (id, draft, thinking) => ({id, title: id, updated: 1, draft, project: '', notes: '', model: 'standard-only', thinking, mode: 'chat', file: null, messages: []});
      localStorage.setItem('qwen-local-chats-v1', JSON.stringify({selectedId: 'saved-draft', chats: [chat('saved-draft', 'KEEP_OLD_DRAFT', 'standard'), chat('saved-deep-empty', '', 'deep')]}));
    }, {defaultKey});
    const standardPage = await standard.newPage(); standardPage.on('pageerror', error => errors.push(error.message)); standardPage.setDefaultTimeout(6000);
    await standardPage.goto('http://127.0.0.1:18787/');
    await standardPage.waitForFunction(() => document.querySelector('#model-status').textContent.includes('Loaded locally'));
    const beforeChats = (await standardPage.evaluate(fixtureSnapshot)).chats;
    await standardPage.locator('#new-chat').click();
    assert.equal(await standardPage.locator('#chat-model').inputValue(), 'standard-only');
    assert.equal(await standardPage.locator('#thinking').inputValue(), 'standard');
    await standardPage.locator('#prompt').fill('NEW_READY_DRAFT');
    await standardPage.waitForFunction(() => !document.querySelector('#send').disabled).catch(async error => {
      t.diagnostic(await standardPage.evaluate(() => ({model: document.querySelector('#model-status').textContent, notice: document.querySelector('#notice').textContent, storage: document.querySelector('#storage-notice').textContent, activity: document.querySelector('#activity').textContent})));
      throw error;
    });
    for(let retry=0;retry<100;retry++){if((await standardPage.evaluate(fixtureSnapshot)).chats.some(chat=>chat.draft==='NEW_READY_DRAFT'))break;await new Promise(resolve=>setTimeout(resolve,20));}
    const afterChats = (await standardPage.evaluate(fixtureSnapshot)).chats;
    for (const old of beforeChats) assert.deepEqual(afterChats.find(chat => chat.id === old.id), old, 'Saved chats and their response preferences remain exact');
    assert.equal(afterChats.length, beforeChats.length + 1, 'An incompatible saved empty chat is preserved, not reused');
    assert.deepEqual(errors, []); await standard.close();

    const coding = await browser.newContext({viewport: {width: 1280, height: 900}}); await setup(coding);
    const threads = new Map([['saved', {id: 'saved', name: 'Saved chat', cwd: '/fixture/project', model: legacy, modelProvider: 'saleh_local', turns: [], archived: false}]]);
    const codingPage = await coding.newPage(); codingPage.on('pageerror', error => errors.push(error.message)); codingPage.setDefaultTimeout(6000);
    await codingPage.exposeBinding('fixtureNative', (_, body) => {
      nativeCalls.push(body); const input = body.input || {}, thread = threads.get(input.threadId);
      if (body.op === 'codingWorktrees' && input.action === 'list') return {worktrees: [], handoffs: [], busy: false};
      assert.equal(body.op, 'coding');
      switch (input.action) {
        case 'status': return {available: true, model: legacy, provider: 'local', providers: [{id: 'local', name: 'Local models', available: true}], activeTurns: [], terminals: [], stoppingFamilies: []};
        case 'list': return {threads: [...threads.values()].map(value => ({...value, turns: []})), nextCursor: null};
        case 'events': return {events: [], cursor: 0, gap: false, approvals: []};
        case 'family': return {rootThreadId: thread.id, root: {...thread, turns: []}, threads: [], nextCursor: null, stoppingTargets: []};
        case 'read': return {thread, cursor: 0};
        case 'start': {const created = {id: 'created', name: 'New chat', cwd: input.cwd, model: input.model, modelProvider: 'saleh_local', turns: [], archived: false}; threads.set(created.id, created); return {thread: created};}
        default: throw Error(`Unexpected fixture native action ${input.action}`);
      }
    });
    await coding.addInitScript(({defaultKey}) => {if (localStorage.getItem(defaultKey) === null) localStorage.setItem(defaultKey, 'other'); window.webkit = {messageHandlers: {tools: {postMessage: body => {if (body.input?.action === 'events') window.fixturePickerPolls = (window.fixturePickerPolls || 0) + 1; return window.fixtureNative(body);}}}};}, {defaultKey});
    await codingPage.goto('http://127.0.0.1:18787/coding');
    await codingPage.waitForFunction(() => document.querySelector('#thread-model').textContent.includes('qwen3.8') && !document.querySelector('#new-chat').disabled);
    assert.equal(await codingPage.locator('#new-chat-model').inputValue(), 'other');
    await codingPage.locator('#new-chat').click();
    await codingPage.waitForFunction(() => document.querySelector('#thread-model').textContent === 'other');
    assert.equal(nativeCalls.find(call => call.input?.action === 'start').input.model, 'other');
    await codingPage.locator('#workspace-settings-open').click();
    await codingPage.evaluate(() => {
      window.fixturePickerBaseline = window.fixturePickerPolls || 0;
      window.fixturePickerOptions = ['default-model', 'new-chat-model'].map(id => [id, [...document.getElementById(id).options]]);
    });
    await codingPage.waitForFunction(() => window.fixturePickerPolls >= window.fixturePickerBaseline + 3);
    assert(await codingPage.evaluate(() => window.fixturePickerOptions.every(([id, options]) => options.every((option, index) => document.getElementById(id).options[index] === option))), 'Completed Coding polls retain both option lists');
    await failedDefaultSave(codingPage);
    assert.equal(await codingPage.locator('#new-chat-model').inputValue(), 'other');
    assert.equal(await codingPage.locator('#thread-model').textContent(), 'other');
    await codingPage.locator('#new-chat-model').selectOption('unloaded');
    assert(await codingPage.locator('#new-chat').isDisabled());
    assert.equal(await codingPage.locator('#thread-model').textContent(), 'other', 'New-chat choice cannot rewrite current model');
    await codingPage.locator('#workspace-settings-close').click();
    await codingPage.locator('#prompt').fill('KEEP_DRAFT');
    await codingPage.reload();
    await codingPage.waitForFunction(() => document.querySelector('#thread-model').textContent === 'other');
    assert.equal(await codingPage.locator('#prompt').inputValue(), 'KEEP_DRAFT');
    for (const width of [760, 390]) {await codingPage.setViewportSize({width, height: 844}); assert(await codingPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));}
    assert.deepEqual(errors, []);
  } finally {await browser.close();}
});
