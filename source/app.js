(async () => {
// MODEL PICKER HELPERS BEGIN
const LOCAL_MODEL_DEFAULT_KEY = 'saleh-local-model-default-v1';
const LEGACY_LOCAL_MODEL = 'qwen3.8-27b-uncensored-hauhaucs-aggressive-mtp';
const DEFAULT_LOCAL_MODEL = 'local/saleh-qwen38-uncensored-8bit';
function modelDefault() {
  try { const saved = localStorage.getItem(LOCAL_MODEL_DEFAULT_KEY); return saved === null ? DEFAULT_LOCAL_MODEL : saved; }
  catch { return ''; }
}
function modelEligibility(catalog, id, mode, deep = false, longOutput = false) {
  const entry = Array.isArray(catalog?.models) ? catalog.models.find(value => value && value.id === id) : null;
  if (catalog?.online !== true) return {ready: false, entry, reason: catalog?.message || 'Local model inventory is unavailable. Refresh models to check again.'};
  if (!entry) return {ready: false, entry: null, reason: 'The selected model is missing from the local inventory. Choose an installed model; no substitute will be used.'};
  if (entry.available !== true) return {ready: false, entry, reason: 'The selected local model is unavailable.'};
  if (entry.capabilities?.[mode] !== true) return {ready: false, entry, reason: entry.reasons?.[mode] || `Compatibility with ${mode === 'coding' ? 'Coding' : mode === 'agent' ? 'Agent' : 'Chat'} is not established.`};
  if (entry.loaded !== true) return {ready: false, entry, reason: 'Installed, but not loaded. Load this exact model in LM Studio, then refresh. This picker does not load or download models.'};
  const reasoning = deep ? 'deep' : 'standard';
  if (entry.capabilities?.[reasoning] !== true) return {ready: false, entry, reason: entry.reasons?.[reasoning] || `${deep ? 'Deep' : 'Standard'} reasoning is unsupported or unconfirmed for this model.`};
  if (longOutput && (deep || !(entry.contextLength >= 65536))) return {ready: false, entry, reason: 'Long answer needs reasoning off and a loaded context of at least 65,536 tokens.'};
  return {ready: true, entry, reason: 'Loaded locally · no API fees.'};
}
function modelOptions(select, catalog, selected) {
  const choices = [], seen = new Set();
  for (const row of Array.isArray(catalog?.models) ? catalog.models : []) {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    const state = row.state === 'unsupported' ? 'Unsupported' : row.loaded === true ? 'Loaded' : 'Installed · not loaded';
    choices.push([row.id, `${row.id === DEFAULT_LOCAL_MODEL ? 'Uncensored 8bit' : row.label || row.id} · ${state}`]);
  }
  if (!seen.has(selected)) {
    choices.push([selected, `${selected || 'No model selected'} · ${catalog?.online === null ? catalog.message || 'Inventory not checked' : 'unavailable'}`]);
  }
  if (select.options.length !== choices.length || choices.some(([value, label], index) => select.options[index].value !== value || select.options[index].textContent !== label)) {
    select.replaceChildren(...choices.map(([value, label]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
    }));
  }
  if (select.value !== selected) select.value = selected;
}
// MODEL PICKER HELPERS END

const $ = id => document.getElementById(id);
const KEY = 'qwen-local-chats-v1';
const attachments=window.SalehAttachments,attachmentStorage=window.SalehAttachmentStorage,chatStorage=window.SalehChatStorage;
const contextCompaction=window.SalehContextCompaction,compactionAdmissions=new Map(),compactionResults=new Map(),compactionApplying=new Set(),compactionReads=new Set(),compactionViews=new WeakMap();
let compactionRenderVersion=0;
let pendingSavedChats=null,storageHydrating=true,pageDisposed=false,restoring=false,structuralPending=false,structuralWriting=false;
let snapshotFields={},saveTail=Promise.resolve(),observedSnapshot=null,dirtyRevision=0,reconcileTail=Promise.resolve(),reconcileHold=null,reconcileSequence=0;
const inspectionTasks=new Set();
document.body.inert=true;
window.salehSaveBeforeLeave=async()=>false;
window.salehCanNavigate=()=>false;
window.addEventListener('pagehide',()=>{pageDisposed=true;clearTimeout(saveTimer);});
let chats = [], selectedId, saveTimer, originalData, lastSavedSnapshot, storageBlocked = false, unreadableData = false, computerBusy = false, agentView = null;
let textRunsReady=false,textRunGeneration=null;const textInspections=new Map(),textReads=new Set(),deletingChats=new Set(),activeRuns=new Map();
const newChat = catalog => { const model = modelDefault(); return { id: crypto.randomUUID(), title: 'New chat', updated: Date.now(), draft: '', project: '', notes: '', model, thinking: catalog?.models?.some(row => row?.id === model && row.capabilities?.deep === true) ? 'deep' : 'standard', mode: window.webkit?.messageHandlers?.tools ? 'agent' : 'chat', file: null, messages: [] }; };
function boundedReceiptText(text, limit) {
  const notice = '\n[Preview truncated; Export keeps the saved receipt.]';
  return text.length > limit ? text.slice(0, limit - notice.length) + notice : text;
}
function reasoningPreview(text) { return text.slice(0, text.codePointAt(63999) > 0xffff ? 63999 : 64000); }
function normalizeChats(value) {
  if (!Array.isArray(value) || value.length > 5000) throw new Error('Invalid chat collection.');
  const ids = new Set(),runIDs=new Set();
  return value.map(c => {
    if (!c || typeof c!=='object' || Array.isArray(c) || typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.title !== 'string' || typeof c.draft !== 'string' || !Array.isArray(c.messages) || c.messages.length > 10000) throw new Error('Invalid or duplicate chat.');
    if(Object.hasOwn(c,'longOutput')&&(c.longOutput!==true||c.thinking!=='standard'))throw Error('Invalid saved Long answer preference.');
    if(Object.hasOwn(c,'archived')&&typeof c.archived!=='boolean')throw Error('Invalid saved archive state.');
    for(const key of ['project','notes','model'])if(Object.hasOwn(c,key)&&typeof c[key]!=='string')throw Error('Invalid saved chat '+key+'.');
    if(Object.hasOwn(c,'updated')&&!Number.isFinite(c.updated)||Object.hasOwn(c,'thinking')&&!['standard','deep'].includes(c.thinking)||Object.hasOwn(c,'mode')&&!['chat','agent'].includes(c.mode))throw Error('Invalid saved chat settings.');
    if(c.file!==undefined&&c.file!==null&&(!c.file||typeof c.file!=='object'||Array.isArray(c.file)||typeof c.file.name!=='string'||typeof c.file.text!=='string'||c.file.text.length>12000))throw Error('Invalid saved context file.');
    ids.add(c.id); const messageIDs = new Set();
    const messages = c.messages.map(m => {
      if (!m || typeof m!=='object' || Array.isArray(m) || !['user','assistant'].includes(m.role) || typeof m.content !== 'string' || typeof m.id !== 'string' || !m.id || messageIDs.has(m.id)) throw new Error('Invalid message.');
      messageIDs.add(m.id);
      if(Object.hasOwn(m,'state')&&!['complete','stopped','error','length','streaming','unconfirmed'].includes(m.state))throw Error('Invalid saved message state.');
      for(const key of ['reasoning','note'])if(Object.hasOwn(m,key)&&typeof m[key]!=='string')throw Error('Invalid saved message '+key+'.');
      for(const key of ['reasoningOpen','reasoningTruncated','agent'])if(Object.hasOwn(m,key)&&typeof m[key]!=='boolean')throw Error('Invalid saved message '+key+'.');
      if(Object.hasOwn(m,'attachments')&&m.role!=='user')throw Error('Only user messages have attachments.');
      if(m.textRun){if(m.role!=='assistant')throw Error('A saved text run must belong to an assistant message.');const link=window.SalehChatRuns.metadata(m.textRun);if(!link.imported){if(runIDs.has(link.runId))throw Error('Duplicate saved text-run links.');runIDs.add(link.runId);}}
      if(Object.hasOwn(m,'receipts')&&(!Array.isArray(m.receipts)||m.receipts.some(r=>!r||typeof r!=='object'||Array.isArray(r)||['tool','status','message'].some(key=>typeof r[key]!=='string')||['id','input','output'].some(key=>Object.hasOwn(r,key)&&typeof r[key]!=='string'))))throw Error('Invalid saved tool receipts.');
      if(Object.hasOwn(m,'plan')){if(!Array.isArray(m.plan))throw Error('Invalid saved work plan.');if(m.plan.length)qwenWork.normalizePlan(m.plan);}
      if(Object.hasOwn(m,'sources')&&(!Array.isArray(m.sources)||m.sources.some(source=>!source||!qwenWork.safeURL(source.url)||['title','excerpt','receipt','provider','observedAt'].some(key=>typeof source[key]!=='string')||!Number.isFinite(Date.parse(source.observedAt)))))throw Error('Invalid saved sources.');
      // Keep validated source fields intact; presentation and request context have separate bounds.
      return {...m,...(Object.hasOwn(m,'attachments')?{attachments:attachments.normalize(m.attachments)}:{}),...(m.state===undefined?{state:'complete'}:{})};
    });
    if(Object.hasOwn(c,'draftAttachmentMessageId')&&(typeof c.draftAttachmentMessageId!=='string'||Object.hasOwn(c,'draftAttachments')||!messages.some(m=>m.id===c.draftAttachmentMessageId&&m.role==='user'&&m.attachments?.length)))throw Error('Invalid pending attachment draft.');
    return {updated:0,project:'',notes:'',model:LEGACY_LOCAL_MODEL,thinking:'deep',mode:window.webkit?.messageHandlers?.tools?'agent':'chat',file:null,...c,...(Object.hasOwn(c,'draftAttachments')?{draftAttachments:attachments.normalize(c.draftAttachments)}:{}),messages};
  });
}
async function hydratedSnapshot(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.chats))throw Error('Invalid saved chat snapshot.');
  const hydrated=await attachmentStorage.hydrate(value,'chat');
  const rows=normalizeChats(hydrated.chats);
  if(Object.hasOwn(value,'selectedId')&&(typeof value.selectedId!=='string'||!rows.some(chat=>chat.id===value.selectedId)))throw Error('Invalid selected chat.');
  const decoded=new Set();for(const chat of rows)for(const file of [...(chat.draftAttachments??[]),...chat.messages.flatMap(message=>message.attachments??[])])if(file.kind==='image'&&!decoded.has(file.dataURL)){await attachments.decodeImage(file.dataURL);decoded.add(file.dataURL);}
  attachmentStorage.serialize(hydrated,'chat'); // Enforce the portable byte ceiling before migration authority.
  return {...hydrated,chats:rows};
}
async function verifySnapshot(payload) {
  originalData=payload;pendingSavedChats=JSON.parse(payload);
  pendingSavedChats=await hydratedSnapshot(pendingSavedChats);
}
function messageRoom(chat){if(chat.messages.length<=9998)return true;notice('This chat has reached its saved-message limit. Your draft and previous answers are kept; continue in a new chat.');return false;}
function notice(text, source = '') { $('notice').textContent = text; $('notice').hidden = !text; $('notice').dataset.source = source; }
function storageNotice(text) { $('storage-notice').textContent=text; $('storage-notice').hidden=!text; }
const openedChat=new URLSearchParams(location.search).get('chatId');
try {
  const payload=await chatStorage.load(verifySnapshot);
  if(pageDisposed)return;
  if(payload!==null){lastSavedSnapshot=payload;snapshotFields={...pendingSavedChats};chats=pendingSavedChats.chats;selectedId=pendingSavedChats.selectedId;}
} catch(error) {
  storageBlocked=true;unreadableData=true;
  if(error?.code==='pending'&&typeof chatStorage.recoveryBase==='function'){
    try{const base=await chatStorage.recoveryBase();originalData=base.payload;pendingSavedChats=await hydratedSnapshot(JSON.parse(base.payload));snapshotFields={...pendingSavedChats};chats=pendingSavedChats.chats;selectedId=pendingSavedChats.selectedId;}catch{}
  }
  storageNotice('Saved chats could not be loaded. Stored history was kept; saving and new requests are paused. '+error.message);
}
if (!chats.length) chats.push(newChat());
if (!chats.some(c => c.id === selectedId)) selectedId = chats[0].id;
if(openedChat&&chats.some(c=>c.id===openedChat))selectedId=openedChat;
const current = () => chats.find(c => c.id === selectedId);
const activeFor = chat => [...activeRuns.values()].find(run=>run.chatId===chat.id);
const parallelTextChat = chat => chat.mode==='chat'&&![...draftAttachments(chat),...chat.messages.flatMap(message=>message.attachments??[])].some(file=>file.kind==='image');
const runBlocked = chat => !!activeFor(chat)||(Array.isArray(chat.contextCompactions?.records)&&chat.contextCompactions.records.some(row=>compactionApplying.has(row.runId)))||activeRuns.size>=2||activeRuns.size>0&&(!parallelTextChat(chat)||[...activeRuns.values()].some(run=>!run.parallelText));
let showArchived = current().archived === true;
let localModels = {online: null, models: [], message: 'Checking installed local models…'}, modelRefresh = 0;
const chatModelState = chat => {
  const choice = modelEligibility(localModels, chat.model, chat.mode, chat.thinking === 'deep', chat.longOutput === true);
  const images = files => files?.some(file => file.kind === 'image');
  if (choice.ready && choice.entry?.capabilities?.vision !== true && (images(draftAttachments(chat)) || chat.messages.some(message => message.role === 'user' && images(message.attachments)))) return {...choice, ready:false, reason:'This conversation includes images. Choose a loaded vision-capable model, or start a new chat without images.'};
  return choice;
};
function renderModelControls() {
  const chat = current(), eligibility = chatModelState(chat), row = eligibility.entry;
  modelOptions($('default-model'), localModels, modelDefault());
  modelOptions($('chat-model'), localModels, chat.model);
  $('default-model').disabled = activeRuns.size>0 || computerBusy;
  $('chat-model').disabled = !!activeFor(chat) || computerBusy;
  $('models-refresh').disabled = activeRuns.size>0;
  $('model-status').textContent = `${chat.model || 'No model selected'} · ${eligibility.reason}`;
  $('model-status').classList.toggle('sr-only',eligibility.ready);
  document.querySelector('.exact-model').textContent = chat.model || 'No model selected';
  $('loaded-context').textContent = row?.loaded === true && Number.isFinite(row.contextLength) ? `${row.contextLength.toLocaleString()} tokens` : 'Not reported for this selection';
  $('reasoning-capability').textContent = ['standard', 'deep'].map(key => `${key === 'deep' ? 'Deep' : 'Standard'}: ${row?.capabilities?.[key] === true ? 'supported' : row?.reasons?.[key] || 'unavailable or unconfirmed'}`).join(' · ');
  $('thinking').querySelector('[value=standard]').disabled = row?.capabilities?.standard !== true;
  $('thinking').querySelector('[value=deep]').disabled = row?.capabilities?.deep !== true;
  const long = modelEligibility(localModels, chat.model, chat.mode, false, true);
  $('thinking').querySelector('[value=long]').disabled = !long.ready;
  $('thinking').querySelector('[value=long]').title = long.ready ? 'Reasoning off · no fixed token cap · 30-minute model-request limit.' : long.reason;
  $('thinking').title = 'Fast and Long answer turn reasoning off. Deep reasoning turns it on. No fixed response token cap; model context, saved-data limits and a 30-minute model-request limit still apply.'+(long.ready?'':' '+long.reason);
  const pending = localModels.online === null;
  const label = pending ? 'Checking local models…' : eligibility.ready ? 'Local model ready' : localModels.online ? 'Model unavailable' : 'Local models offline';
  $('connection-text').textContent = label; $('connection').className = pending ? '' : eligibility.ready ? 'online' : 'offline';
  $('connection').title = eligibility.reason; $('connection').setAttribute('aria-label', `${label}. Refresh local model inventory`);
}
async function refreshModels() {
  const request = ++modelRefresh;
  try {
    const response = await fetch('/api/models', {cache: 'no-store'}), catalog = await response.json();
    if (!response.ok || !Array.isArray(catalog.models) || typeof catalog.online !== 'boolean') throw Error('Local model inventory is unavailable.');
    if (request !== modelRefresh) return;
    localModels = catalog;
  } catch (error) {if (request !== modelRefresh) return; localModels = {online: false, models: localModels.models, message: `Local model inventory unavailable. ${error.message}`};}
  controls();
}
const attachmentReads = new Map();
async function readUTF8(file) {
  const bytes = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
  catch { throw new Error('The selected file is not valid UTF-8. No text was changed.'); }
}
function captureSnapshot(value={...snapshotFields,chats,selectedId}) {
  const payload=attachmentStorage.serialize(value,'chat');
  if(value.chats===chats&&value.selectedId===selectedId&&payload!==observedSnapshot){observedSnapshot=payload;dirtyRevision++;}
  return {payload,revision:dirtyRevision};
}
function persistenceFailure(error) {
  if(error?.code==='conflict'){storageConflict(error.message);return;}
  storageNotice('Chat history could not be saved. '+(error?.message||String(error))+' Export chats to preserve the current work.');
}
function save() {
  clearTimeout(saveTimer);saveTimer=null;
  if(storageBlocked||storageHydrating||pageDisposed||restoring||structuralWriting)return Promise.resolve(false);
  let captured;
  try{captured=captureSnapshot();}catch(error){persistenceFailure(error);return Promise.resolve(false);}
  const result=saveTail.then(async()=>{
    if(storageBlocked||pageDisposed)return false;
    try{
      if(captured.payload===lastSavedSnapshot)await chatStorage.check();else await chatStorage.commit(captured.payload);
      lastSavedSnapshot=captured.payload;
      const current=captureSnapshot();
      const exact=!storageBlocked&&!pageDisposed&&current.revision===captured.revision&&current.payload===captured.payload;
      if(exact)storageNotice('');
      return exact;
    }catch(error){persistenceFailure(error);return false;}
  });
  saveTail=result.then(()=>{});
  return result;
}
function queueReconciliation(operation) {
  const held=reconcileHold;reconcileSequence++;
  const result=reconcileTail.then(async()=>{if(held)await held;if(!pageDisposed)return operation();});
  reconcileTail=result.catch(error=>notice('Saved run could not be applied. '+error.message));
  return reconcileTail;
}
async function drainReconciliation() {
  for(;;){await Promise.all([...inspectionTasks]);const pending=reconcileTail;await pending;if(!inspectionTasks.size&&pending===reconcileTail)return;}
}
async function changeSnapshot(makeChange,options={}) {
  const recovering=typeof options.verifyRecovery==='function';
  if(storageBlocked&&!recovering||storageHydrating||pageDisposed||structuralPending)throw Error('A storage change is already pending or unavailable.');
  structuralPending=true;const prior=reconcileTail;let release;reconcileHold=new Promise(resolve=>{release=resolve;});controls();
  try{
    await prior;structuralWriting=true;await saveTail;
    if(storageBlocked&&!recovering||pageDisposed)throw Error('The page changed before the storage update.');
    const before=captureSnapshot(),change=makeChange(),payload=captureSnapshot(change.value).payload;
    try{if(recovering)await chatStorage.recover(payload,options.expected,options.verifyRecovery);else await chatStorage.commit(payload,options);lastSavedSnapshot=payload;}catch(error){persistenceFailure(error);throw error;}
    const current=captureSnapshot();
    if(pageDisposed||current.revision!==before.revision||current.payload!==before.payload){storageConflict('The workspace changed while saving. The newer work remains in this tab; export it before reloading the committed snapshot.');throw Error('The workspace changed while saving. The newer work was kept in this tab.');}
    change.apply();if(recovering){storageBlocked=false;unreadableData=false;originalData=payload;}captureSnapshot();storageNotice('');return true;
  }finally{
    structuralWriting=false;structuralPending=false;reconcileHold=null;release();controls();
    try{if(!storageBlocked&&!pageDisposed&&captureSnapshot().payload!==lastSavedSnapshot)scheduleSave();}catch(error){persistenceFailure(error);}
  }
}
window.salehSaveBeforeLeave = async () => {
  if(storageHydrating||attachmentReads.size||attachmentStorage.busy||restoring||structuralPending){storageNotice('Wait for image loading, recovery or saving to finish before leaving.');return false;}
  try{
    await drainReconciliation();
    if(storageHydrating||attachmentReads.size||attachmentStorage.busy||restoring||structuralPending||pageDisposed)return false;
    const body=document.body,sequence=reconcileSequence;
    const saved=await save();
    return saved===true&&document.body===body&&!pageDisposed&&!storageBlocked&&!restoring&&!structuralPending&&!attachmentReads.size&&!attachmentStorage.busy&&!inspectionTasks.size&&sequence===reconcileSequence&&captureSnapshot().payload===lastSavedSnapshot;
  }catch(error){persistenceFailure(error);return false;}
};
function canNavigate(){if(storageHydrating||restoring||structuralPending||pageDisposed)return false;if(computerBusy){notice('Wait for the current computer action before leaving Chat. Your draft stays in this chat.');return false;}return true;}
window.salehCanNavigate = canNavigate;
function scheduleSave() {try{captureSnapshot();}catch(error){persistenceFailure(error);return;}if(!saveTimer)saveTimer=setTimeout(()=>{void save();},500);}
function groupChatSidebar(rows, query, archived, isPinned = () => false) {
  const needle = query.toLowerCase(), grouped = {pinned: [], projects: [], recent: []}, projects = new Map();
  const matching = rows.filter(chat => (chat.archived === true) === archived && `${chat.title} ${chat.project} ${chat.messages.map(message => message.content).join(" ")}`.toLowerCase().includes(needle));
  matching.sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const chat of matching) {
    if (isPinned(chat.id)) {grouped.pinned.push(chat); continue;}
    const name = chat.project.trim();
    if (!name) {grouped.recent.push(chat); continue;}
    if (!projects.has(name)) {
      const project = {name, key: `chat-project:${name}`, chats: []};
      projects.set(name, project); grouped.projects.push(project);
    }
    projects.get(name).chats.push(chat);
  }
  return grouped;
}
let sidebarProjection, sidebarRows;
function renderSidebar() {
  const query = $('search').value.toLowerCase(), workspace = window.salehWorkspace;
  const grouped = groupChatSidebar(chats, query, showArchived, id => workspace?.pinned('chat', id));
  const visibleChat = chat => [chat.id, chat.title, chat.project, !!activeFor(chat)];
  const projection = JSON.stringify([showArchived, query, selectedId, !!workspace, grouped.pinned.map(visibleChat), grouped.projects.map(project => {
    const collapsed = !query && !!workspace?.collapsed(project.key);
    return [project.name, collapsed, collapsed ? [] : project.chats.map(visibleChat)];
  }), grouped.recent.map(visibleChat)]);
  if (sidebarRows === chats && sidebarProjection === projection) return;
  $('chats').replaceChildren();
  $('show-archived').setAttribute('aria-pressed', String(showArchived));
  $('chat-list-label').textContent = showArchived ? 'Archived' : 'Chats';
  $('search').placeholder = showArchived ? 'Search archived chats' : 'Search chats';
  $('search').setAttribute('aria-label', $('search').placeholder);
  function appendChat(group, chat) {
    const row = document.createElement('div'); row.className = `chat-row${chat.id === selectedId ? ' selected' : ''}`;
    const button = document.createElement('button'); button.textContent = (activeFor(chat) ? '· ' : '') + chat.title;
    if (chat.project) { const project = document.createElement('span'); project.className = 'chat-project'; project.textContent = chat.project; button.prepend(project); }
    button.title = chat.title; if (chat.id === selectedId) button.setAttribute('aria-current', 'page');
    button.onclick = () => { selectedId = chat.id; document.body.classList.remove('sidebar-open'); sidebarState(); void save(); render(); $('prompt').focus(); };
    const remove = document.createElement('button'); remove.className = 'delete-chat'; remove.textContent = '×'; remove.setAttribute('aria-label', `Delete ${chat.title}`);
    remove.onclick = async () => {
      if (!confirm(`Delete “${chat.title}”? Export chats first if you want to keep a copy.`)) return;
      if(deletingChats.has(chat.id)||activeFor(chat)?.admitting){notice('Text admission or deletion is pending. Settle it before deleting this chat.');return;}
      deletingChats.add(chat.id);controls();try{for(const message of chat.messages)if(message.textRun&&!message.textRun.imported){const result=await window.SalehChatRuns.inspect(message.textRun.runId);if(result.live)await window.SalehChatRuns.stop(message.textRun.runId);}}catch(error){notice('Chat was kept because its text run could not be settled. '+error.message);deletingChats.delete(chat.id);controls();return;}
      try{await changeSnapshot(()=>{
        if(!chats.includes(chat))throw Error('The chat changed before deletion.');
        const next=chats.filter(c=>c!==chat);if(!next.length)next.push(newChat(localModels));const selected=selectedId===chat.id?next[0].id:selectedId;
        return {value:{...snapshotFields,chats:next,selectedId:selected},apply:()=>{chats=next;selectedId=selected;}};
      });}catch(error){notice('Chat was kept. '+error.message);}finally{deletingChats.delete(chat.id);render();}
    };
    row.append(button); if (workspace) row.append(workspace.pinButton('chat', chat.id, chat.title)); row.append(remove); group.append(row);
  }
  function appendSection(label, rows) {
    if (!rows.length) return;
    const group = document.createElement('section'); group.className = 'project-group';
    const heading = document.createElement('p'); heading.className = 'workspace-pinned-label'; heading.textContent = label; group.append(heading);
    for (const chat of rows) appendChat(group, chat);
    $('chats').append(group);
  }
  appendSection('Pinned', grouped.pinned);
  for (const project of grouped.projects) {
    const collapsed = !query && !!workspace?.collapsed(project.key);
    const group = document.createElement('section'); group.className = 'project-group';
    const heading = document.createElement('button'); heading.className = 'project-heading workspace-project-toggle'; heading.type = 'button';
    const label = document.createElement('span'); label.className = 'workspace-project-label'; label.textContent = project.name; heading.append(label); heading.title = project.name; heading.dataset.workspaceProject = project.key;
    heading.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} project ${project.name}`); heading.setAttribute('aria-expanded', String(!collapsed));
    heading.disabled = !!query || !workspace;
    heading.onclick = () => {
      workspace?.toggleProject(project.key);
      [...$('chats').querySelectorAll('[data-workspace-project]')].find(node => node.dataset.workspaceProject === project.key)?.focus();
    };
    group.append(heading);
    if (!collapsed) for (const chat of project.chats) appendChat(group, chat);
    $('chats').append(group);
  }
  appendSection('Recents', grouped.recent);
  if (!$('chats').children.length) { const text = document.createElement('p'); text.className = 'empty-list'; text.textContent = query ? 'No matching chats' : showArchived ? 'No archived chats' : 'No chats here. Create a new chat or open Archived.'; $('chats').append(text); }
  sidebarRows = chats; sidebarProjection = projection;
  if (!query) workspace?.revealCurrent($('chats'), selectedId);
}
window.addEventListener('workspace-preferences-change', renderSidebar);
function inlineText(parent, text) {
  for (const part of text.split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
    const link=part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if(link&&qwenWork.safeURL(link[2])){const a=document.createElement('a');a.textContent=link[1];a.href=qwenWork.safeURL(link[2]);a.target='_blank';a.rel='noopener noreferrer';parent.append(a);}
    else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) { const e = document.createElement('strong'); e.textContent = part.slice(2, -2); parent.append(e); }
    else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) { const e = document.createElement('code'); e.textContent = part.slice(1, -1); parent.append(e); }
    else parent.append(document.createTextNode(part));
  }
}
function syncNode(target, fresh) {
  if(target.nodeType===Node.TEXT_NODE){if(fresh.data.startsWith(target.data))target.appendData(fresh.data.slice(target.length));else if(target.data!==fresh.data)target.data=fresh.data;return;}
  for(const attr of [...target.attributes])if(attr.name!=='open'&&!fresh.hasAttribute(attr.name))target.removeAttribute(attr.name);
  for(const attr of fresh.attributes)if(attr.name!=='open'&&target.getAttribute(attr.name)!==attr.value)target.setAttribute(attr.name,attr.value);
  if(fresh.onclick)target.onclick=fresh.onclick;
  const key=n=>n.nodeType===Node.ELEMENT_NODE?`${n.tagName}:${n.className}`:n.nodeType;
  const children=[...fresh.childNodes];
  for(const [i,next] of children.entries()){
    let prior=target.childNodes[i];
    if(!prior||key(prior)!==key(next)){const match=[...target.childNodes].slice(i+1).find(n=>key(n)===key(next));if(match){target.insertBefore(match,prior||null);prior=match;}else{target.insertBefore(next,prior||null);continue;}}
    syncNode(prior,next);
  }
  while(target.childNodes.length>children.length)target.lastChild.remove();
}
function formatContent(container, text) {
  // ponytail: common text blocks only; no raw HTML, embedded media or full Markdown dialect.
  container.replaceChildren();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(s=>s.trim());
  const separator = line => !!line && line.includes('|') && cells(line).every(s=>/^:?-{3,}:?$/.test(s));
  for (let i=0;i<lines.length;) {
    const line=lines[i];
    if (!line.trim()) { i++; continue; }
    const fence=line.match(/^\s*(`{3,})([^`]*)$/);
    if (fence) {
      const language=fence[2].trim().slice(0,40), start=++i, body=[];
      while(i<lines.length&&!new RegExp('^\\s*`{'+fence[1].length+',}\\s*$').test(lines[i]))body.push(lines[i++]);
      const closed=i<lines.length;if(closed)i++;
      const raw=body.join('\n')+(closed&&i-1>start?'\n':'');
      const block=document.createElement('div');block.className='code-block';
      const bar=document.createElement('div');bar.className='code-heading';
      const label=document.createElement('span');label.className='code-language';label.textContent=language||'Code';
      const copy=document.createElement('button');copy.type='button';copy.className='copy-code';copy.textContent='Copy code';copy.setAttribute('aria-label','Copy code');
      copy.onclick=async event=>{const button=event.currentTarget;try{await navigator.clipboard.writeText(raw);button.textContent='Copied';}catch{notice('Copy was blocked. Select the code and copy it manually.');}};
      const pre=document.createElement('pre'),code=document.createElement('code');pre.tabIndex=0;pre.setAttribute('aria-label',language?`${language} code`:'Code block');code.textContent=raw;pre.append(code);bar.append(label,copy);block.append(bar,pre);container.append(block);continue;
    }
    const heading=line.match(/^(#{1,6})\s+(.+)$/);
    if(heading){const h=document.createElement('h'+Math.max(heading[1].length,2));inlineText(h,heading[2]);container.append(h);i++;continue;}
    if(/^\s*(?:---+|\*\*\*+)\s*$/.test(line)){container.append(document.createElement('hr'));i++;continue;}
    if(line.includes('|')&&separator(lines[i+1])){
      const wrap=document.createElement('div');wrap.className='table-scroll';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Table');
      const table=document.createElement('table'),head=document.createElement('thead'),body=document.createElement('tbody'),row=document.createElement('tr');
      for(const value of cells(line)){const cell=document.createElement('th');cell.scope='col';inlineText(cell,value);row.append(cell);}head.append(row);i+=2;
      while(i<lines.length&&lines[i].includes('|')&&lines[i].trim()){const row=document.createElement('tr');for(const value of cells(lines[i++])){const cell=document.createElement('td');inlineText(cell,value);row.append(cell);}body.append(row);}table.append(head,body);wrap.append(table);container.append(wrap);continue;
    }
    const list=line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
    if(list){const tag=list[2]?'ol':'ul',node=document.createElement(tag);if(tag==='ol'&&Number(list[2])>1)node.start=Number(list[2]);while(i<lines.length){const item=lines[i].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);if(!item||(item[2]?'ol':'ul')!==tag)break;const li=document.createElement('li');inlineText(li,item[3]);node.append(li);i++;}container.append(node);continue;}
    if(/^>\s?/.test(line)){const quote=document.createElement('blockquote'),body=[];while(i<lines.length&&/^>\s?/.test(lines[i]))body.push(lines[i++].replace(/^>\s?/,''));inlineText(quote,body.join('\n'));container.append(quote);continue;}
    const paragraph=document.createElement('p'),body=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!/^\s*(?:#{1,6}\s|`{3,}|>\s?|[-+*]\s|\d+\.\s|---+\s*$)/.test(lines[i])&&!(lines[i].includes('|')&&separator(lines[i+1])))body.push(lines[i++]);
    inlineText(paragraph,body.join('\n'));container.append(paragraph);
  }
}
function appendReasoning(reply, text) {
  if (typeof text !== 'string' || !text) return;
  reply.reasoning = (reply.reasoning || '') + text;
}
function renderReasoning(article, message) {
  if (!message.reasoning && !message.reasoningTruncated) return;
  let details = article.querySelector('.model-reasoning');
  if (!details) {
    details = document.createElement('details'); details.className = 'model-reasoning'; details.open = message.reasoningOpen === true;
    const summary = document.createElement('summary'); summary.textContent = 'Reasoning details';
    const text = document.createElement('pre'); text.className = 'reasoning-text reasoning-output'; text.dir = 'auto'; text.tabIndex = 0; text.setAttribute('aria-label', 'Model reasoning text');
    const note = document.createElement('p'); note.className = 'reasoning-note';
    details.append(summary, text, note);
    details.addEventListener('toggle', () => { if (message.reasoningOpen !== details.open) { message.reasoningOpen = details.open; scheduleSave(); } });
    article.querySelector('.content').insertAdjacentElement('afterend', details);
  }
  const text = details.querySelector('.reasoning-text'), follow = text.scrollHeight - text.scrollTop - text.clientHeight < 40;
  const preview=reasoningPreview(message.reasoning||'');
  if (text.textContent !== preview) text.textContent = preview;
  if (details.open && follow) text.scrollTop = text.scrollHeight;
  details.querySelector('.reasoning-note').textContent = 'Reasoning is generated text. Recorded tool activity shows what actions ran.' + (['stopped','error','length'].includes(message.state) ? ' Partial response; generation did not finish.' : '') + (message.reasoningTruncated||message.reasoning?.length>64000 ? ' This preview is limited to 64,000 characters; retained reasoning is included in Export.' : '');
}
// CHAT FIND BEGIN
// Adapted interaction from owner-authorized Salehman-AI; provenance in notices.
let findChatId = null, findMatches = [], findSelected = null;
function findChatMessages(messages, query) {
  const text = query.trim().toLocaleLowerCase();
  return text ? messages.filter(message => message.content.toLocaleLowerCase().includes(text)).map(message => message.id) : [];
}
function closeChatFind(restore = true) {
  $('chat-find').hidden = true; $('find-chat').setAttribute('aria-expanded', 'false');
  $('chat-find-query').value = ''; findMatches = []; findSelected = null;
  for (const article of $('messages').children) article.classList.remove('find-match', 'find-current');
  if (restore) $('find-chat').focus();
}
function refreshChatFind(jump = false, direction = 0) {
  if (findChatId !== selectedId) {closeChatFind(false); findChatId = selectedId;}
  if ($('chat-find').hidden) return;
  // ponytail: scan message text; add an index only if large-chat searches become slow.
  const query = $('chat-find-query').value;
  findMatches = findChatMessages(current().messages, query);
  const count = findMatches.length, index = count ? (Math.max(0, findMatches.indexOf(findSelected)) + direction + count) % count : -1;
  findSelected = findMatches[index] || null;
  $('chat-find-count').textContent = !query.trim() ? 'Message text' : count ? `${index + 1} of ${count} messages` : 'No matching messages';
  $('chat-find-prev').disabled = $('chat-find-next').disabled = count < 2;
  const matches = new Set(findMatches);
  for (const article of $('messages').children) {
    const selected = article.dataset.id === findSelected;
    article.classList.toggle('find-match', matches.has(article.dataset.id));
    article.classList.toggle('find-current', selected);
    if (jump && selected) article.scrollIntoView({block:'center'});
  }
}
function openChatFind() {
  if (document.body.inert || document.querySelector('dialog[open]')) return;
  setContext(false); document.body.classList.remove('sidebar-open'); sidebarState();
  if (findChatId !== selectedId) {closeChatFind(false); findChatId = selectedId;}
  $('chat-find').hidden = false; $('find-chat').setAttribute('aria-expanded', 'true');
  refreshChatFind(); $('chat-find-query').focus(); $('chat-find-query').select();
}
// CHAT FIND END
$('find-chat').onclick = openChatFind;
$('chat-find-close').onclick = () => closeChatFind();
$('chat-find-query').oninput = () => {findSelected = null; refreshChatFind(true);};
$('chat-find-prev').onclick = () => refreshChatFind(true, -1);
$('chat-find-next').onclick = () => refreshChatFind(true, 1);
$('chat-find-query').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) {event.preventDefault(); refreshChatFind(true, event.shiftKey ? -1 : 1);}
});
function renderMessages(onlyLast = false) {
  const chat = current();
  const retained=onlyLast?$('messages').lastElementChild:null;
  if (onlyLast) {
    const previous = $('messages').lastElementChild, reasoning = previous?.querySelector('.model-reasoning'), message = chat.messages.find(m=>m.id===previous?.dataset.id);
    if (reasoning && message) message.reasoningOpen = reasoning.open;
  } else $('messages').replaceChildren();
  $('welcome').hidden = chat.messages.length > 0;
  for (const m of (onlyLast ? chat.messages.slice(-1) : chat.messages)) {
    const displayState=m.state==='streaming'&&!m.textRun?'stopped':m.state,displayNote=m.state==='streaming'&&!m.textRun?'Interrupted when the page closed. Retry to generate a new answer.':m.note;
    const article = document.createElement('article'); article.dataset.id = m.id; article.className = `message ${m.role}`;
    const label = document.createElement('div'); label.className = 'message-label';
    if (m.source === 'app') label.textContent = 'Noiee';
    else if (m.role === 'assistant') { const mark = document.createElement('span'); mark.textContent = 'N'; label.append(mark, document.createTextNode('Noiee')); }
    else label.textContent = 'You';
    const content = document.createElement('div'); content.className = 'content'; content.dir = 'auto';
    if (!m.content && displayState === 'streaming') { content.classList.add('thinking'); content.textContent = m.reasoning ? '' : 'Thinking…'; }
    else formatContent(content, m.content);
    article.append(label, content);
    if(m.attachments?.length)article.append(attachmentCards(m.attachments));
    renderReasoning(article, m);
    if(m.agent && displayState!=='streaming' && !m.receipts?.length){const evidence=document.createElement('p');evidence.className='message-note execution-status';evidence.textContent='Answer only · No tool activity is recorded for this reply.';content.insertAdjacentElement('afterend',evidence);}
    if(m.plan?.length){const plan=document.createElement('details');plan.className='work-plan';plan.open=displayState==='streaming';const title=document.createElement('summary');title.textContent='Work plan · model progress';plan.append(title);const items=document.createElement('ol');for(const step of m.plan){const item=document.createElement('li');item.textContent=`${step.status.replace('_',' ')} · ${step.text}`;items.append(item);}const note=document.createElement('small');note.textContent='Plan status is model-reported. Check tool results for actual outcomes.';plan.append(items,note);article.append(plan);}
    if(m.sources?.length){const sources=document.createElement('details');sources.className='research-sources';const title=document.createElement('summary');title.textContent=`${m.sources.length} source observation${m.sources.length===1?'':'s'} · saved locally`;sources.append(title);for(const source of m.sources){const item=document.createElement('div'),a=document.createElement('a'),meta=document.createElement('small'),quote=document.createElement('p');a.href=source.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=source.title;meta.textContent=`Observed ${source.observedAt} · ${source.provider} · result ${source.receipt}${source.referenceOnly?' · file reference only; page text not retained':source.truncated?' · partial excerpt':''}`;quote.textContent=source.excerpt;item.append(a,meta,quote);sources.append(item);}const note=document.createElement('small');note.textContent='Historical tool observations; source text may be incomplete or wrong. Saved locally with this chat.';sources.append(note);article.append(sources);}
    if (m.receipts?.length) { const list=document.createElement('details'); list.className='tool-receipts'; const summary=document.createElement('summary');summary.textContent=`${m.receipts.length} tool result${m.receipts.length===1?'':'s'}`;list.append(summary);for(const r of m.receipts){const item=document.createElement('div');item.className='tool-receipt';const status=document.createElement('p');status.textContent=`${r.tool.slice(0,400)}${r.id?' · result '+r.id:''} · ${r.status.slice(0,40)}: ${boundedReceiptText(r.message,1000)}`;item.append(status);for(const [key,label] of [['input','Inputs'],['output','Returned output']])if(typeof r[key]==='string'){const detail=document.createElement('details'),heading=document.createElement('summary'),text=document.createElement('pre');detail.className='receipt-detail';heading.textContent=label;text.textContent=boundedReceiptText(r[key],key==='input'?16000:32000);text.dir='auto';text.tabIndex=0;detail.append(heading,text);item.append(detail);}list.append(item);}article.append(list); }
    if(agentView?.id===m.id){const image=document.createElement("img");image.className="agent-view";image.alt="Latest computer view for this run; not stored in chat history";image.src=agentView.image;article.append(image);}
    if (displayNote) { const note = document.createElement('p'); note.className = 'message-note'; note.textContent = displayNote; if(['error','stopped','length','unconfirmed'].includes(displayState)) {note.classList.add('run-outcome');article.insertBefore(note,article.querySelector('.model-reasoning')||content);} else article.append(note); }
    if (m.role === 'assistant' && displayState !== 'streaming') {
      const actions = document.createElement('div'); actions.className = 'message-actions';
      if (m.content) {
        const copy = document.createElement('button'); copy.textContent = 'Copy';
        copy.onclick = async event => { const button=event.currentTarget;try { await navigator.clipboard.writeText(m.content); button.textContent = 'Copied'; } catch { notice('Copy was blocked by the browser. Select the text and copy it manually.'); } };
        actions.append(copy);
      }
      if (!m.agent && m === chat.messages.at(-1) && ['error', 'stopped', 'length', 'unconfirmed'].includes(displayState)) {
        const retry = document.createElement('button'); retry.textContent = 'Retry'; retry.className = 'retry-reply'; retry.disabled = storageHydrating||storageBlocked||runBlocked(chat) || computerBusy || attachmentReads.has(chat);
        retry.onclick = () => { if (storageHydrating||storageBlocked||restoring||structuralPending||deletingChats.has(chat.id)||runBlocked(chat) || computerBusy || attachmentReads.has(chat) || !chatModelState(chat).ready) return; const prior=chat.messages.slice(0,chat.messages.indexOf(m)).findLast(row=>row.role==='user');if(!prior||!messageRoom(chat))return;chat.messages.push({id:crypto.randomUUID(),role:'user',content:prior.content,...(prior.attachments?{attachments:attachments.normalize(prior.attachments)}:{}),state:'complete'});generate(chat,true); }; actions.append(retry);
      }
      article.append(actions);
    }
    if(retained?.dataset.id===m.id)syncNode(retained,article);else{retained?.remove();$('messages').append(article);}
  }
  refreshChatFind();
}
function controls() {
  const archive = $('archive-chat'), archived = current().archived === true, active=activeFor(current()), blocked=runBlocked(current());
  archive.disabled = storageHydrating||storageBlocked||restoring||structuralPending||deletingChats.has(current().id);
  archive.title = archived ? 'Unarchive chat' : 'Archive chat'; archive.setAttribute('aria-label', archive.title);
  $('archive-status').hidden = !archived;
  document.querySelectorAll('.retry-reply').forEach(button => { button.disabled = storageHydrating||storageBlocked||blocked || computerBusy || attachmentReads.has(current()) || !chatModelState(current()).ready || !textRunsReady; });
  $('send').hidden = !!active; $('stop').hidden = !active; $('send').disabled = storageHydrating||storageBlocked||restoring||structuralPending||deletingChats.has(current().id)||blocked||computerBusy || attachmentReads.has(current()) || !$('prompt').value.trim()&&!draftAttachments(current()).length || !chatModelState(current()).ready || !textRunsReady;
  $('mode-summary').textContent=current().mode==='agent'?'Agent · Can use enabled tools':'Chat · Answers with your supplied context';
  $('thinking').disabled = !!active; $('chat-mode').disabled=!!active; $('chat-mode').querySelector('[value=agent]').disabled=!window.webkit?.messageHandlers?.tools;
  $('activity').textContent = active ? active.kind==='compact'?'Compacting context · original history and draft kept…':'Local model is working in this chat…' : blocked ? (activeRuns.size>=2?'Two Chats are running. Wait for one to finish or stop it.':'Agent and image Chats need the other ordinary runs to finish first.') : activeRuns.size ? 'Another Chat is running · one text slot available' : (current().mode==='agent' ? 'Agent · Tools enabled' : 'Chat · Answers only');
  $('restore-file').disabled = activeRuns.size>0||storageHydrating||storageBlocked||restoring||structuralPending;
  $('recovery-file').disabled = activeRuns.size>0||storageHydrating||restoring||structuralPending;
  $('new-chat').disabled=storageHydrating||storageBlocked||restoring||structuralPending;
  renderModelControls();
  renderCompaction();
  window.dispatchEvent(new CustomEvent('chat-busy', {detail:activeRuns.size>0}));
}
function resize() { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 200)}px`; }
function bottom() { $('thread').scrollTop = $('thread').scrollHeight; updateJump(); }
function updateJump() { const t=$('thread'); $('jump-latest').hidden = t.scrollHeight - t.scrollTop - t.clientHeight < 110; }
$('thread').addEventListener('scroll', updateJump);
$('jump-latest').onclick = bottom;
function renderContext() {
  renderDraftAttachments();
  const chat = current(), loading = attachmentReads.get(chat); $('project-name').value = chat.project; $('notes').value = chat.notes;
  $('file-name').textContent = loading ? `Loading ${loading.name}…` : chat.file ? `${chat.file.name} · ${chat.file.text.length.toLocaleString()} characters` : 'UTF-8 text · up to 12,000 characters and 64 KB';
  $('remove-file').hidden = !chat.file && !loading;
  $('composer-file').hidden = !chat.file && !loading;
  $('composer-file-name').textContent = loading ? `Loading ${loading.name}…` : chat.file?.name || '';
  const size = chat.notes.length + (chat.file?.text.length || 0);
  $('context-count').textContent = size ? `${size.toLocaleString()} characters in notes and the context file. Conversation and tool history are additional.` : 'No additional notes or context file.';
}
function render() { showArchived = current().archived === true; $('title').textContent = current().title; $('prompt').value = current().draft; $('thinking').value = current().longOutput === true ? 'long' : current().thinking; $('chat-mode').value=current().mode; renderSidebar(); renderMessages(); renderContext(); resize(); controls(); window.dispatchEvent(new CustomEvent('chat-selection-change',{detail:{chatId:selectedId}})); if ($('chat-find').hidden) bottom(); }
function refreshReply(chat) {
  if (chat.id !== selectedId) return;
  const thread = $('thread'), follow = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 110;
  const reply = chat.messages.at(-1), article = $('messages').lastElementChild;
  const thinking=article?.querySelector('.reasoning-text'),followThinking=thinking&&thinking.scrollHeight-thinking.scrollTop-thinking.clientHeight<40;
  renderMessages(true);
  if(followThinking){const text=$('messages').lastElementChild?.querySelector('.reasoning-text');if(text)text.scrollTop=text.scrollHeight;}
  if (follow && $('chat-find').hidden) bottom(); else updateJump();
}
const attachmentContentHashes=new WeakMap();
function trackTextRun(value){
  const row=value.run,known=activeRuns.get(row.runId);
  if(value.live){const entry=known??{};Object.assign(entry,{text:true,runId:row.runId,chatId:row.chatId,kind:row.purpose==='compact'?'compact':row.kind??'chat',parallelText:value.parallelText===true});if(value.durableRevision>0)entry.admitting=false;activeRuns.set(row.runId,entry);}
  else activeRuns.delete(row.runId);
}
async function mergeTextRun(value) {
 try{
  window.SalehChatRuns.validate(value);
  if(value.run.purpose==='compact'){await mergeCompactionRun(value);return;}
  // Backend occupancy is independent of whether this page retains its chat.
  const owner=value.run,known=chats.find(c=>c.id===owner.chatId)?.messages.find(m=>m.id===owner.assistantMessageId)?.textRun;
  if(known&&owner.revision<known.revision&&value.live)return;
  trackTextRun(value);
  controls();
  if(storageHydrating||storageBlocked)return;
  if(value.run.userContentDigest){
    const observedChat=chats.find(c=>c.id===value.run.chatId),observedUser=observedChat?.messages.find(m=>m.id===value.run.userMessageId&&m.role==='user');
    if(!observedUser)return;
    let cached=attachmentContentHashes.get(observedUser);
    // Attachment snapshots are immutable; hash once per exact message instead of re-reading megabytes on every streamed token.
    if(!cached||cached.text!==observedUser.content||cached.files!==observedUser.attachments){cached={text:observedUser.content,files:observedUser.attachments,digest:window.SalehChatRuns.contentDigest(attachments.content(observedUser))};attachmentContentHashes.set(observedUser,cached);}
    if(await cached.digest!==value.run.userContentDigest||pageDisposed||storageBlocked||!chats.includes(observedChat)||!observedChat.messages.includes(observedUser)||observedUser.content!==cached.text||observedUser.attachments!==cached.files)return;
  }
  window.SalehChatRuns.validate(value);const row=value.run,chat=chats.find(chat=>chat.id===row.chatId),reply=chat?.messages.find(message=>message.id===row.assistantMessageId),link=reply?.textRun;
  if(link&&row.revision<link.revision&&value.live)return;
  if(!chat||!reply||!link||link.imported||link.runId!==row.runId||link.userMessageId!==row.userMessageId||link.inputDigest!==row.inputDigest||!row.userContentDigest&&chat.messages.find(message=>message.id===row.userMessageId&&message.role==='user')?.content!==row.userMessage){controls();return;}
  if(storageBlocked){controls();return;}
  if((row.kind==='agent')!==!!reply.agent){notice('Saved run mode differs from this reply. Existing history was kept.');return;}
  if(row.revision<link.revision){if(!value.live&&row.status==='unconfirmed'){reply.state='unconfirmed';reply.note='Completion is unconfirmed. This page retained more partial text than the last durable backend checkpoint; no generation was replayed.';void save();refreshReply(chat);}controls();return;}
  const draftBefore=chat.draft,referenceBefore=chat.draftAttachmentMessageId,linkBefore={...link};let cleared=false;
  if(value.durableRevision>0&&!link.admitted){link.admitted=true;if(!link.draftCleared&&chat.draft===link.submittedDraft&&chat.draftAttachmentMessageId===row.userMessageId)delete chat.draftAttachmentMessageId;if(!link.draftCleared&&chat.draft===link.submittedDraft){chat.draft='';cleared=true;}link.draftCleared=true;}
  if(value.durableRevision===0){reply.note='Admission is still being saved. The submitted draft is retained.';controls();return;}
  const state=['intent','running'].includes(row.status)?'streaming':row.status;
  const note=value.saveError||row.error||(row.budgetReached?'This run reached an action or context limit. The final review used available evidence only; unfinished work may remain.':row.status==='length'?(row.content.trim()?'The reply reached its length limit.':'The model reached its limit before producing an answer. Saved reasoning is retained.'):row.status==='unconfirmed'?'Completion is unconfirmed. The saved partial is retained; no replay was made.':value.live?'Generation belongs to the backend and can continue while this page is closed.':'');
  if(link.revision===row.revision&&reply.state===state&&reply.note===note&&linkBefore.admitted===link.admitted){controls();return;}
  link.revision=row.revision;reply.content=row.content;reply.reasoning=row.reasoning;reply.reasoningTruncated=row.reasoning.length>64000;reply.state=state;reply.note=note;
  if(row.kind==='agent'&&typeof value.image==='string'&&value.image.startsWith('data:image/'))agentView={id:reply.id,image:value.image};
  if(row.kind==='agent'){reply.receipts=structuredClone(row.receipts);reply.plan=structuredClone(row.plan);reply.sources=qwenWork.normalizeSources(row.sources);if(row.nativeResult)reply.source='app';}
  chat.updated=Math.max(chat.updated,row.updatedAt);const pending=captureSnapshot().payload,saved=await save();if(!saved&&chats.includes(chat)&&chat.messages.includes(reply)&&reply.textRun===link&&captureSnapshot().payload===pending){Object.assign(link,linkBefore);if(cleared)chat.draft=draftBefore;if(referenceBefore!==undefined)chat.draftAttachmentMessageId=referenceBefore;scheduleSave();}
  if(pageDisposed)return;
  if(chat.id===selectedId){renderDraftAttachments();$('prompt').value=chat.draft;if(reply!==chat.messages.at(-1))renderMessages();else refreshReply(chat);}renderSidebar();controls();resize();
  if(!value.live){completedChatId=chat.id;$('focus-reply').hidden=false;}
 }catch(error){notice('Saved run could not be applied. Existing history and drafts were kept. '+error.message);}
}
function inspectTextLink(chat,reply,force=false) {
  const link=reply.textRun,generation=textRunGeneration;if(!link||link.imported||textReads.has(link.runId)||!force&&textInspections.get(link.runId)===generation+'/'+link.revision)return;textReads.add(link.runId);
  const task=(async()=>{
    try{
      const value=await window.SalehChatRuns.inspect(link.runId);
      await queueReconciliation(async()=>{
        if(textRunGeneration!==generation||pageDisposed)return;
        if(!value.run||!value.live&&value.persistence==='saved'&&value.durableRevision===value.run.revision&&value.run.chatId===chat.id&&value.run.assistantMessageId===reply.id&&value.run.inputDigest===link.inputDigest)textInspections.set(link.runId,generation+'/'+(value.run?.revision??link.revision));
        if(value.run)window.SalehChatRuns.receive(value,false);
        else if(chats.includes(chat)&&chat.messages.includes(reply)&&reply.textRun===link&&!link.admitted){reply.state='unconfirmed';reply.note='No saved admission is visible. The draft is retained; this request was not resubmitted.';await save();refreshReply(chat);}
      });
    }catch(error){notice('Saved text-run inspection is unavailable. Existing history and drafts were kept. '+error.message);}
    finally{textReads.delete(link.runId);}
  })();
  inspectionTasks.add(task);task.then(()=>inspectionTasks.delete(task),()=>inspectionTasks.delete(task));return task;
}
window.addEventListener('chat-run-snapshot',event=>{const value=structuredClone(event.detail);void queueReconciliation(()=>mergeTextRun(value));});
window.addEventListener('chat-run-list',event=>{const detail=structuredClone(event.detail);void queueReconciliation(()=>{
  const {runs:rows,truncated,generation}=detail;if(generation!==textRunGeneration){textRunGeneration=generation;textInspections.clear();}const byId=new Map(rows.map(value=>[value.run.runId,value]));
  for(const value of rows)trackTextRun(value);
  for(const [runId,entry] of activeRuns)if(!entry.admitting&&!byId.get(runId)?.live)activeRuns.delete(runId);
  controls();renderSidebar();if(storageHydrating||storageBlocked)return;
  inspectSelectedCompaction();
  for(const chat of chats)for(const reply of chat.messages)if(reply.textRun&&!reply.textRun.imported){const row=byId.get(reply.textRun.runId);if(!row&&(!truncated||chat.id===selectedId||!reply.textRun.admitted)||row&&row.run.revision>reply.textRun.revision||['intent','running','streaming','unconfirmed'].includes(reply.state)||row?.run.status==='unconfirmed')void inspectTextLink(chat,reply,row?.live===true||row?.run.revision>reply.textRun.revision);}
});});
window.addEventListener('chat-runs-ready',event=>{
  textRunsReady=true;if($('notice').dataset.source==='chat-runs')notice('');controls();renderSidebar();
});
window.addEventListener('chat-run-error',event=>{textRunsReady=false;notice('Text-run state is unavailable. No recovered request will be resent. '+event.detail,'chat-runs');controls();});
function compactionBlocked(chat){return storageHydrating||storageBlocked||restoring||structuralPending||deletingChats.has(chat.id)||runBlocked(chat)||computerBusy||attachmentReads.has(chat)||!textRunsReady||contextCompaction.state(chat).records.some(row=>compactionApplying.has(row.runId));}
function renderCompaction(){
  const chat=current(),region=$('context-compaction'),ticket=++compactionRenderVersion;
  try{
    const saved=contextCompaction.state(chat),blocked=!!compactionBlocked(chat);
    region.hidden=!saved.records.length&&!saved.imports?.length;
    if(region.hidden){
      // Ordinary chats need no summary fingerprint, snapshot or asynchronous SHA.
      compactionViews.delete(chat);region.dataset.state='full';
      $('compaction-status').textContent='Full history is in use.';$('compaction-details').hidden=true;$('compaction-summary').textContent='';$('compaction-range').textContent='';
      for(const id of ['compaction-apply','compaction-full-history','compaction-rebuild']){$(id).hidden=true;$(id).disabled=true;}
      $('compact-context').disabled=blocked;$('compact-context').title='Summarize complete earlier exchanges, up to 24,000 bytes per step; the newest exchange stays in full.';return;
    }
    const token=contextCompaction.viewToken(chat);
    $('compact-context').disabled=blocked;
    $('compaction-full-history').hidden=saved.activeId===null;$('compaction-full-history').disabled=blocked;
    $('compaction-rebuild').hidden=!saved.records.length;$('compaction-rebuild').disabled=true;
    $('compaction-apply').hidden=true;$('compaction-apply').disabled=true;
    const paint=view=>{
      if(pageDisposed||ticket!==compactionRenderVersion||current()!==chat)return;
      if(contextCompaction.viewToken(chat)!==token){renderCompaction();return;}
      const busy=!!compactionBlocked(chat);region.dataset.state=view.status;
      $('compaction-status').textContent=view.message+(view.pending&&activeRuns.has(view.runId)?' Use Stop to cancel this summary.':'');
      $('compaction-details').hidden=!view.summary;$('compaction-summary').textContent=view.summary;$('compaction-range').textContent=view.range;
      $('compact-context').disabled=busy||view.status==='stale';$('compact-context').title=view.status==='stale'?'Choose Rebuild summary to use the original history with the current settings.':'Summarize complete earlier exchanges, up to 24,000 bytes per step; the newest exchange stays in full.';
      $('compaction-full-history').disabled=busy;
      $('compaction-rebuild').disabled=busy||!view.canRebuild;
      $('compaction-apply').hidden=!view.canApply||!compactionResults.has(view.runId);$('compaction-apply').disabled=busy;
    };
    let entry=compactionViews.get(chat);
    if(entry?.token===token&&entry.view){paint(entry.view);return;}
    // Never keep an Active label visible while a changed binding is being checked.
    region.dataset.state='checking';$('compaction-status').textContent='Checking the saved summary against this chat…';$('compaction-details').hidden=true;
    if(entry?.token!==token){entry={token,promise:contextCompaction.describe(chat)};compactionViews.set(chat,entry);}
    void entry.promise.then(view=>{entry.view=view;paint(view);}).catch(error=>{
      if(pageDisposed||ticket!==compactionRenderVersion||current()!==chat)return;
      region.hidden=false;region.dataset.state='failed';$('compaction-status').textContent='Summary unavailable. Original history is used. '+error.message;
      $('compaction-details').hidden=true;$('compaction-apply').hidden=true;
    });
  }catch(error){region.hidden=false;region.dataset.state='failed';$('compaction-status').textContent=error.message;$('compaction-details').hidden=true;$('compaction-apply').hidden=true;$('compaction-full-history').disabled=true;$('compaction-rebuild').disabled=true;}
}
async function useFullHistory(){
  const chat=current();
  try{
    if(compactionBlocked(chat)){notice('Wait for the current summary, work or storage check before switching to full history. Your draft is kept.');return;}
    await changeSnapshot(()=>{
      if(!chats.includes(chat)||activeFor(chat)||pageDisposed)throw Error('The chat changed before full history could be saved.');
      const next=contextCompaction.fullHistory(chat);
      return {value:{...snapshotFields,chats:chats.map(row=>row===chat?next:row),selectedId},apply:()=>{chat.contextCompactions=next.contextCompactions;}};
    });
    notice('Full history is now in use. Previous summaries, original messages, your draft and attachments are kept.');
  }catch(error){notice('The full history selection could not be confirmed. '+error.message);}finally{controls();}
}
async function applyCompaction(chat,job,value){
  if(compactionApplying.has(job.runId))return;compactionApplying.add(job.runId);controls();
  try{
    const token=contextCompaction.compareToken(chat,job.source),checked=await contextCompaction.activate(chat,job,value),complete=checked.contextCompactions.records.find(row=>row.id===job.id);
    if(pageDisposed||storageBlocked||!chats.includes(chat))return;
    await changeSnapshot(()=>{
      if(!chats.includes(chat)||contextCompaction.compareToken(chat,job.source)!==token)throw Error('The original range changed while applying the summary. History and draft are kept.');
      const saved=contextCompaction.state(chat),currentJob=saved.records.find(row=>row.id===job.id);
      if(currentJob?.inputDigest!==job.inputDigest||currentJob?.source.digest!==job.source.digest)throw Error('The compaction job changed before saving.');
      const next={...chat,contextCompactions:{...saved,activeId:job.id,records:saved.records.map(row=>row.id===job.id?complete:row)}};
      return {value:{...snapshotFields,chats:chats.map(row=>row===chat?next:row),selectedId},apply:()=>{chat.contextCompactions=next.contextCompactions;}};
    });
    notice('Context compacted for '+job.source.covered.length+' earlier messages. Original history and the current draft are kept.');
  }catch(error){notice('Summary not applied. '+error.message);}finally{compactionApplying.delete(job.runId);compactionAdmissions.delete(job.runId);controls();}
}
async function mergeCompactionRun(value){
  const row=value.run;trackTextRun(value);controls();if(storageHydrating||storageBlocked)return;
  const chat=chats.find(chat=>chat.id===row.chatId);if(!chat)return;
  const job=contextCompaction.state(chat).records.find(job=>job.runId===row.runId);
  if(!job||job.imported||job.inputDigest!==row.inputDigest||job.source.digest!==row.sourceDigest||job.userMessageId!==row.userMessageId||job.assistantMessageId!==row.assistantMessageId||row.requestedModel!==job.source.model||row.resolvedModel!==null&&row.resolvedModel!==job.source.model||row.revision<job.revision)return;
  const summaryHash=row.status==='complete'?await contextCompaction.digest(row.content):null;
  compactionResults.set(row.runId,value);job.revision=row.revision;job.status=row.status;job.summary=row.content;job.summaryHash=summaryHash;job.note=value.saveError||row.error||'';controls();
  const saved=await save();controls();
  const admission=compactionAdmissions.get(row.runId);
  // Do not await the structural mutation from inside reconciliation: it drains
  // this queue before committing. Recovered results require the Apply button.
  if(saved&&row.status==='complete'&&!value.live&&value.persistence==='saved'&&value.durableRevision===row.revision&&!value.saveError&&admission&&!admission.cancelled)void applyCompaction(chat,job,value);
  if(!value.live&&row.status!=='complete')compactionAdmissions.delete(row.runId);
}
function inspectSelectedCompaction(){
  if(storageHydrating||storageBlocked||pageDisposed)return;
  let job;try{const saved=contextCompaction.state(current());job=saved.records.at(-1);if(!job||job.imported||job.id===saved.activeId)return;}catch{return;}
  const generation=textRunGeneration,key=generation+'/'+job.revision,chat=current();if(compactionReads.has(job.runId)||textInspections.get(job.runId)===key)return;compactionReads.add(job.runId);
  const task=(async()=>{
    try{
      const value=await window.SalehChatRuns.inspect(job.runId);
      await queueReconciliation(async()=>{
        if(pageDisposed||textRunGeneration!==generation||!chats.includes(chat)||!contextCompaction.state(chat).records.includes(job))return;
        textInspections.set(job.runId,generation+'/'+(value.run?.revision??job.revision));
        if(value.run?.purpose==='compact'&&value.run.chatId===chat.id&&value.run.inputDigest===job.inputDigest)window.SalehChatRuns.receive(value,false);
        else{job.status='unconfirmed';job.note='No matching saved compaction is visible. No request was resent.';await save();controls();}
      });
    }catch(error){notice('Compaction inspection is unavailable. Originals and drafts are kept. '+error.message);}finally{compactionReads.delete(job.runId);}
  })();inspectionTasks.add(task);task.then(()=>inspectionTasks.delete(task),()=>inspectionTasks.delete(task));
}
async function compactCurrent({rebuild=false}={}){
  const chat=current();try{if(compactionBlocked(chat)){notice('Wait for the current work or storage check before compacting. Your draft is kept.');return;}}catch(error){notice(error.message);return;}
  const choice=modelEligibility(localModels,chat.model,'chat',false);if(!choice.ready){notice(choice.reason);return;}
  const runId=crypto.randomUUID(),admission={text:true,admitting:true,dispatched:false,cancelled:false,runId,chatId:chat.id,kind:'compact',parallelText:true},body=document.body,url=location.href;activeRuns.set(runId,admission);controls();let job;
  const valid=()=>!admission.cancelled&&!pageDisposed&&!storageBlocked&&!storageHydrating&&!restoring&&document.body===body&&location.href===url&&chats.includes(chat);
  try{
    await drainReconciliation();if(await save()!==true)throw Error('The current draft could not be saved. No compaction request was sent.');
    if(rebuild)await changeSnapshot(()=>{
      if(!valid())throw Error('Stopped before rebuilding the summary. Original history and draft are kept.');
      const next=contextCompaction.fullHistory(chat);
      return {value:{...snapshotFields,chats:chats.map(row=>row===chat?next:row),selectedId},apply:()=>{chat.contextCompactions=next.contextCompactions;}};
    });
    const source=await contextCompaction.capture(chat,chatStorage.identity);if(!valid()||!await contextCompaction.matches(chat,source))throw Error('Stopped or changed before compaction. The draft is kept.');
    job=contextCompaction.create(source);job.runId=runId;const token=contextCompaction.compareToken(chat,source),generation=await window.SalehChatRuns.generation();
    if(textRunGeneration!==generation){textRunGeneration=generation;textInspections.clear();}
    const input={runId,chatId:chat.id,userMessageId:job.userMessageId,assistantMessageId:job.assistantMessageId,messages:[{role:'user',content:contextCompaction.prompt(source)}],model:source.model,thinking:'standard',purpose:'compact',sourceDigest:source.digest};job.inputDigest=await window.SalehChatRuns.digest(input);
    if(!valid())throw Error('Stopped before compaction admission. The draft is kept.');
    await changeSnapshot(()=>{
      if(!valid()||contextCompaction.compareToken(chat,source)!==token)throw Error('The source range changed before compaction. No request was sent.');
      const saved=contextCompaction.state(chat),next={...chat,contextCompactions:{...saved,records:[...saved.records,job]}};
      return {value:{...snapshotFields,chats:chats.map(row=>row===chat?next:row),selectedId},apply:()=>{chat.contextCompactions=next.contextCompactions;}};
    });
    compactionAdmissions.set(runId,admission);const prepared=await window.SalehChatRuns.request({action:'prepare',runId,inputDigest:job.inputDigest,generation});
    if(prepared.runId!==runId||prepared.inputDigest!==job.inputDigest||prepared.generation!==generation||typeof prepared.ticket!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(prepared.ticket))throw Error('Invalid compaction admission ticket.');
    if(!valid()||!await contextCompaction.matches(chat,source)||contextCompaction.compareToken(chat,source)!==token)throw Error('Stopped or changed before compaction dispatch. The draft is kept.');
    admission.dispatched=true;let result;
    try{result=await window.SalehChatRuns.request({action:'start',...input,ticket:prepared.ticket,generation});}
    catch(error){notice('Compaction admission is unconfirmed. Inspecting the same ID; no retry was sent. '+error.message);result=await window.SalehChatRuns.inspect(runId);}
    if(result.run&&admission.cancelled)result=await window.SalehChatRuns.stop(runId);
    if(result.run){window.SalehChatRuns.receive(result);if(result.live)void window.SalehChatRuns.watch(runId);}else throw Error('No saved compaction admission is visible. No request was resent.');
  }catch(error){
    compactionAdmissions.delete(runId);try{if(job&&contextCompaction.state(chat).records.includes(job)){job.status=admission.cancelled?'stopped':'unconfirmed';job.note=error.message;void save();}}catch{}notice(error.message);
  }finally{if(activeRuns.get(runId)===admission&&admission.admitting)activeRuns.delete(runId);controls();void window.SalehChatRuns.refresh().catch(()=>{});}
}
$('compact-context').onclick=()=>{void compactCurrent();};
$('compaction-full-history').onclick=()=>{void useFullHistory();};
$('compaction-rebuild').onclick=()=>{void compactCurrent({rebuild:true});};
$('compaction-apply').onclick=()=>{const chat=current(),job=contextCompaction.state(chat).records.at(-1),value=job&&compactionResults.get(job.runId);if(job&&value)void applyCompaction(chat,job,value);};
$('compaction-originals').onclick=()=>{const chat=current(),saved=contextCompaction.state(chat),job=saved.records.find(row=>row.id===saved.activeId)??saved.records.at(-1),id=job?.source.covered[0]?.id,article=[...$('messages').children].find(node=>node.dataset.id===id);if(article){article.tabIndex=-1;article.focus({preventScroll:true});article.scrollIntoView({block:'center'});}};
async function generateRun(chat,selection,preserveDraft) {
  const user=chat.messages.at(-1);if(user?.role!=='user')return;
  const body=document.body,url=location.href,userText=user.content,userFiles=user.attachments,sourceCount=chat.messages.length,projectionToken=contextCompaction.projectionToken(chat,sourceCount);
  const reply={id:crypto.randomUUID(),role:'assistant',content:'',state:'streaming',...(selection.mode==='agent'?{agent:true,receipts:[]}: {})},runId=crypto.randomUUID(),submittedDraft=chat.draft;
  const admission={text:true,admitting:true,dispatched:false,cancelled:false,runId,chatId:chat.id,kind:selection.mode,parallelText:parallelTextChat(chat)};activeRuns.set(runId,admission);controls();
  try{
    const generation=await window.SalehChatRuns.generation();
    if(textRunGeneration!==generation){textRunGeneration=generation;textInspections.clear();}
    const validAdmission=()=>!admission.cancelled&&!pageDisposed&&!storageBlocked&&!storageHydrating&&!restoring&&!structuralPending&&document.body===body&&location.href===url&&chats.includes(chat)&&chat.messages.includes(user)&&user.content===userText&&user.attachments===userFiles&&chat.model===selection.model&&chat.mode===selection.mode&&chat.thinking===selection.thinking&&(chat.longOutput===true)===(selection.longOutput===true)&&(textRunGeneration===null||textRunGeneration===generation)&&contextCompaction.projectionToken(chat,sourceCount)===projectionToken;
    const assertCurrent=()=>{if(!validAdmission()||chat.messages.at(-1)!==user)throw Error(admission.cancelled?'Stopped before text admission. The draft is kept.':'Chat or document changed before text admission. The draft is kept.');};
    assertCurrent();let view=chat.messages;try{view=await contextCompaction.project(chat);}catch(error){notice(error.message);}assertCurrent();
    const rawStart=contextCompaction.unsettledStart(view),rawContext=[];
    const context=view.flatMap((m,index)=>{
      const entries=m.content||m.attachments?.length ? [{role:m.role,content:m.role==='assistant'&&m.state!=='complete'?`Partial assistant response (${m.state}; unfinished and not proof of completed actions):\n${m.content}`:m.role==='user'?attachments.content(m):m.content}] : [];
      if(m.receipts?.length)entries.push({role:'assistant',content:'HISTORICAL tool receipts for the preceding turn only. These never prove execution of a later request. Do not repeat an action merely because its final answer was interrupted. Pending/unconfirmed means inspect the target before any retry. A new explicit user request needs new tool evidence; never copy an old success receipt as a new result.\n'+qwenWork.receiptContext(m.receipts)});
      if(rawStart!==null&&index>=rawStart)rawContext.push(...entries);return entries;
    });
    const previousPlan=chat.messages.findLast(m=>m.plan?.length)?.plan;
    if(previousPlan)context.splice(Math.max(0,context.length-1),0,{role:'assistant',content:qwenWork.planLabel+JSON.stringify(qwenWork.normalizePlan(previousPlan))});
    if(chat.notes||chat.project||chat.file)context.unshift({role:'user',content:['Context supplied for this conversation:',chat.project&&`Project: ${chat.project}`,chat.notes&&`Working notes:\n${chat.notes}`,chat.file&&`File: ${chat.file.name}\n${chat.file.text}`].filter(Boolean).join('\n\n')});
    const sources=qwenWork.normalizeSources(chat.messages.flatMap(message=>message.sources||[]));
    const messages=qwenWork.boundContext(context,sources,selection.mode,null,selection.contextLength);
    const raw=rawContext.map(message=>JSON.stringify(message));let retained=0;for(const message of messages)if(JSON.stringify(message)===raw[retained])retained++;
    if(retained!==raw.length)throw Error('Unsettled original history does not fit this request without omission. Your draft is kept; inspect the earlier outcome before continuing.');
    const input={runId,chatId:chat.id,userMessageId:user.id,assistantMessageId:reply.id,messages,model:selection.model,thinking:selection.thinking,...(selection.longOutput===true?{longOutput:true}:{}),...(selection.mode==='agent'?{kind:'agent',sources}:{})};
    reply.textRun=window.SalehChatRuns.metadata({runId,userMessageId:user.id,inputDigest:await window.SalehChatRuns.digest(input),revision:0,admitted:false,draftCleared:preserveDraft,submittedDraft,imported:false});
    if(!validAdmission())throw Error(admission.cancelled?'Stopped before text admission. The draft is kept.':'Chat or document changed before text admission. The draft is kept.');
    if(!chats.includes(chat)||chat.messages.at(-1)!==user)throw Error('Chat changed before text admission. The draft is kept.');
    chat.messages.push(reply);chat.updated=Date.now();
    if(await save()!==true)throw Error('The outbound messages and draft could not be saved unchanged. No model request was sent.');
    if(!validAdmission()||chat.messages.at(-1)!==reply||reply.textRun.runId!==runId)throw Error(admission.cancelled?'Stopped before text admission. The draft is kept.':'Chat or document changed while saving. No model request was sent.');
    render();let result;
    const prepared=await window.SalehChatRuns.request({action:'prepare',runId,inputDigest:reply.textRun.inputDigest,generation});
    if(prepared.runId!==runId||prepared.inputDigest!==reply.textRun.inputDigest||prepared.generation!==generation||typeof prepared.ticket!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(prepared.ticket))throw Error('Invalid text admission ticket. The draft is kept.');
    if(admission.cancelled){await window.SalehChatRuns.stop(runId);throw Error('Stopped before text admission. The draft is kept.');}
    if(!validAdmission()||chat.messages.at(-1)!==reply)throw Error('The chat or document changed before text admission. No model request was sent.');
    if(await save()!==true)throw Error('The outbound messages and draft could not be saved unchanged. No model request was sent.');
    if(!validAdmission()||chat.messages.at(-1)!==reply||reply.textRun.runId!==runId)throw Error(admission.cancelled?'Stopped before text admission. The draft is kept.':'Chat or document changed while saving. No model request was sent.');
    admission.dispatched=true;if(selection.mode==='agent')window.SalehChatRuns.allowAgentReview(runId);
    try{result=await window.SalehChatRuns.request({action:'start',...input,ticket:prepared.ticket,generation});}
    catch(error){notice('Admission response was not confirmed. Inspecting the same run ID; no retry was sent. '+error.message);result=await window.SalehChatRuns.inspect(runId);}
    if(result.run&&admission.cancelled)result=await window.SalehChatRuns.stop(runId);
    if(result.run){window.SalehChatRuns.receive(result);if(result.live)void window.SalehChatRuns.watch(runId);}
    else{reply.state='unconfirmed';reply.note='No saved admission is visible. The submitted draft is retained; no automatic retry was made.';void save();}
  }catch(error){if(chat.messages.includes(reply)){reply.state='unconfirmed';reply.note=error.message;void save();}notice(error.message);}
  finally{if(activeRuns.get(runId)===admission&&admission.admitting)activeRuns.delete(runId);renderSidebar();refreshReply(chat);controls();void window.SalehChatRuns.refresh().catch(()=>{});}
}
async function generate(chat,preserveDraft=false) {
  if (storageHydrating||storageBlocked||restoring||structuralPending||deletingChats.has(chat.id)||runBlocked(chat) || computerBusy || attachmentReads.has(chat) || !textRunsReady) return;
  const eligibility = chatModelState(chat); if (!eligibility.ready) {notice(eligibility.reason); return;}
  const selection = {model: chat.model, thinking: chat.thinking, mode: chat.mode,contextLength:eligibility.entry.contextLength,...(chat.longOutput===true?{longOutput:true}:{})};
  return generateRun(chat,selection,preserveDraft);
}
async function readBackupSelection(files) {
  if(files.length>2048||files.some(file=>file.size>qwenWork.backupLimit)||files.reduce((n,f)=>n+f.size,0)>514*1024*1024)throw Error('Select all backup parts together, up to 32 MB each and 514 MB in total.');
  const texts=[];for(const file of files)texts.push(await readUTF8(file));return qwenWork.restoreBackup(texts);
}
async function prepareSnapshotImages(value) {
  for(const chat of value.chats){await attachmentStorage.prepare(chat.draftAttachments??[]);for(const message of chat.messages)if(message.attachments)await attachmentStorage.prepare(message.attachments);}
}
const sameContent=(a,b)=>JSON.stringify(a,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)===JSON.stringify(b,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
function checkRecoveryHistory(recovered,existing=chats) {
  let previous=-1;
  for(const old of existing){
    const index=recovered.findIndex(chat=>chat.id===old.id);if(index<=previous)throw Error('Recovery would remove or reorder existing chats.');previous=index;
    const next=recovered[index],metadata=chat=>Object.fromEntries(Object.entries(chat).filter(([key])=>!['messages','draft','updated','draftAttachments','draftAttachmentMessageId'].includes(key)));
    if(!sameContent(metadata(old),metadata(next)))throw Error('Recovery would change existing chat settings or fields.');
    let priorMessage=-1;for(const message of old.messages){const at=next.messages.findIndex(row=>row.id===message.id);if(at<=priorMessage||!sameContent(message,next.messages[at]))throw Error('Recovery would remove, reorder or change existing messages.');priorMessage=at;}
  }
}
$('restore-file').onchange = async () => {
  const files=[...$('restore-file').files];$('restore-file').value='';if(!files.length||restoring||structuralPending||storageHydrating)return;restoring=true;controls();
  window.dispatchEvent(new Event('workspace-reveal-main'));
  try{
    if(activeRuns.size||storageBlocked)throw Error('Finish the reply or resolve the storage warning before restoring.');
    const value=await readBackupSelection(files),imported=await hydratedSnapshot({...value,selectedId:value?.chats?.[0]?.id});await prepareSnapshotImages(imported);
    if(pageDisposed)return;let added=[];
    await changeSnapshot(()=>{
      if(activeRuns.size)throw Error('Restore paused because a reply started.');
      const signature=c=>JSON.stringify({...c,id:'',archived:undefined,messages:c.messages.map(m=>m.textRun?{...m,textRun:{...m.textRun,imported:true}}:m)});
      const signatures=new Set(chats.map(signature)),ids=new Set(chats.map(c=>c.id));
      for(const chat of imported.chats){const sig=signature(chat);if(signatures.has(sig))continue;signatures.add(sig);if(ids.has(chat.id))chat.id=crypto.randomUUID();ids.add(chat.id);added.push(chat);}
      if(!added.length)throw Error('All chats in this backup are already here. Nothing was changed.');
      for(const chat of added){for(const message of chat.messages)if(message.textRun)message.textRun.imported=true;if(chat.contextCompactions){const retained=chat.contextCompactions;chat.contextCompactions={version:1,activeId:null,records:[],imports:[retained]};}}
      const merged=[...added,...chats],selected=added[0].id;normalizeChats(merged);
      return {value:{...snapshotFields,chats:merged,selectedId:selected},apply:()=>{chats=merged;selectedId=selected;}};
    });
    render();notice(`Restored ${added.length} chat${added.length===1?'':'s'}. Existing chats were kept; exact duplicates were skipped.`);
  }catch(error){notice('Backup not restored. '+(error instanceof SyntaxError?'The file is not valid JSON.':error.message)+' Existing chats were kept.');}finally{restoring=false;controls();try{if(!storageBlocked&&!pageDisposed&&captureSnapshot().payload!==lastSavedSnapshot)scheduleSave();}catch(error){persistenceFailure(error);}}
};
$('recovery-file').onchange=async()=>{
  const files=[...$('recovery-file').files];$('recovery-file').value='';if(!files.length||restoring||structuralPending||storageHydrating)return;
  const selectedChoice=$('recovery-selected-id').value.trim(),liveBefore=captureSnapshot();restoring=true;controls();window.dispatchEvent(new Event('workspace-reveal-main'));
  try{
    if(activeRuns.size)throw Error('Finish the reply before exact recovery.');
    await saveTail;const base=await chatStorage.recoveryBase(); // Drain earlier writes, then pin before reading the selected files.
    if(storageBlocked){
      if(snapshotFields.chats?.length&&base.payload!==null){const prior=await hydratedSnapshot(JSON.parse(base.payload));if(!sameContent(chats,prior.chats))throw Error('This tab has unsaved changes. Export them before recovering the stored history.');}
      else if(chats.some(chat=>chat.messages.length||chat.draft||draftAttachments(chat).length||chat.notes||chat.project||chat.file))throw Error('This tab has unsaved work. Export it before exact recovery.');
    }
    const value=await readBackupSelection(files),selected=selectedChoice||value?.selectedId;
    if(!selected)throw Error('Enter the recorded selected chat ID for this export before choosing its recovery files.');
    const recovered=await hydratedSnapshot({...value,selectedId:selected});await prepareSnapshotImages(recovered);if(pageDisposed)return;
    const verifyRecovery=async(nextPayload,basePayload)=>{
      const next=await hydratedSnapshot(JSON.parse(nextPayload));
      if(basePayload!==null){const previous=await hydratedSnapshot(JSON.parse(basePayload));checkRecoveryHistory(next.chats,previous.chats);}
    };
    await changeSnapshot(()=>{
      if(activeRuns.size)throw Error('Recovery paused because a reply started.');
      const now=captureSnapshot();if(now.revision!==liveBefore.revision||now.payload!==liveBefore.payload)throw Error('The current workspace changed after recovery was selected. Keep the newer work and select the files again.');
      // A blocked startup view may be a placeholder; the module verifier checks the real pending source.
      if(!storageBlocked)checkRecoveryHistory(recovered.chats);
      return {value:{...snapshotFields,...recovered,selectedId:selected},apply:()=>{snapshotFields={...snapshotFields,...recovered};chats=recovered.chats;selectedId=selected;}};
    },{expected:base.identity,verifyRecovery});
    render();notice('Exact recovery saved. Original chat and message IDs, run links and prior history were kept; the previous destination snapshot was retained.');
  }catch(error){notice('Exact recovery not applied. '+(error instanceof SyntaxError?'The file is not valid JSON.':error.message)+' Current history was kept.');}finally{restoring=false;controls();try{if(!storageBlocked&&!pageDisposed&&captureSnapshot().payload!==lastSavedSnapshot)scheduleSave();}catch(error){persistenceFailure(error);}}
};
$('composer').onsubmit = event => {
  event.preventDefault();const command=contextCompaction.classify($('prompt').value);if(command!=='text'){if(command==='compact')void compactCurrent();else notice('Use /compact as a standalone command, or choose Compact context. Your draft and attachments are kept.');return;}
  if (storageHydrating||storageBlocked||restoring||structuralPending||deletingChats.has(current().id)||runBlocked(current()) || computerBusy || attachmentReads.has(current()) || !textRunsReady) return;
  const text = $('prompt').value.trim(); if (!text&&!draftAttachments(current()).length) return;
  const chat = current(), eligibility = chatModelState(chat);
  if (!eligibility.ready) {notice(eligibility.reason); return;}
  if(!messageRoom(chat))return;
  const files=attachments.normalize(draftAttachments(chat)),message={ id: crypto.randomUUID(), role: 'user', content: text, state: 'complete',...(files.length?{attachments:files}:{}) };
  chat.messages.push(message);
  if(files.length){delete chat.draftAttachments;chat.draftAttachmentMessageId=message.id;}
  if (chat.messages.length === 1 && chat.title === 'New chat') chat.title = (text||files.map(file=>file.name).join(', ')).replace(/\s+/g, ' ').slice(0, 56);
  generate(chat);
};
window.addEventListener('computer-busy', event => { computerBusy = event.detail; controls(); });
for (const event of ['agent-stopped','tools-stopped']) window.addEventListener(event, stopped => {attachmentReads.clear();renderDraftAttachments();agentView=null;for(const entry of compactionAdmissions.values())entry.cancelled=true;for(const entry of activeRuns.values())if(entry.kind==='compact'||entry.admitting&&(!stopped.detail?.departure||!entry.dispatched))entry.cancelled=true;void window.SalehChatRuns.refresh().catch(()=>{});document.querySelectorAll('.agent-view').forEach(image=>image.remove());renderMessages(true);});
$('prompt').addEventListener('input', () => { current().draft = $('prompt').value; scheduleSave(); resize(); controls(); });
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } });
$('chat-mode').onchange=()=>{if(activeFor(current()))return;current().mode=$('chat-mode').value;void save();controls();};
$('thinking').onchange = () => { if (activeFor(current())) return; const value=$('thinking').value;if(!['standard','long','deep'].includes(value))return;current().thinking=value==='long'?'standard':value;if(value==='long')current().longOutput=true;else delete current().longOutput;void save();controls(); };
$('chat-model').onchange = () => {if (activeFor(current()) || computerBusy) return; current().model = $('chat-model').value; void save(); controls();};
$('default-model').onchange = () => {if (activeRuns.size || computerBusy) return; try {localStorage.setItem(LOCAL_MODEL_DEFAULT_KEY, $('default-model').value);} catch {notice('The default could not be saved. Your chat model is unchanged.');} controls();};
$('models-refresh').onclick = refreshModels;
$('stop').onclick = async () => {const active=activeFor(current());if(active){if(active.kind==='compact'){active.cancelled=true;const own=compactionAdmissions.get(active.runId);if(own)own.cancelled=true;}if(active.admitting){active.cancelled=true;notice('Stopping the pending text admission; the draft is kept until its outcome is known.');}const id=active.runId;$('stop').disabled=true;try{await window.SalehChatRuns.stop(id);}catch(error){notice('Stop is unconfirmed. '+error.message);}finally{$('stop').disabled=false;}return;}};
$('open-coding').onclick = async () => {
  const body=document.body,url=location.href;if(!canNavigate()||await window.salehSaveBeforeLeave()!==true||document.body!==body||location.href!==url||!canNavigate())return;
  location.href='/coding';
};
$('new-chat').onclick = () => {
  if(storageHydrating||storageBlocked||restoring||structuralPending)return;
  const empty = chats.find(c => !c.archived && c.model === modelDefault() && !attachmentReads.has(c) && !c.messages.length && !c.draft && !c.notes && !c.project && !c.file && !draftAttachments(c).length && (c.thinking !== 'deep' || localModels.models.find(row => row?.id === c.model)?.capabilities?.deep === true));
  if(!empty&&chats.length>=5000){notice('The 5,000 saved-chat limit is reached. Export a backup before removing chats to make room.');return;}
  const chat = empty || newChat(localModels); if (!empty) chats.unshift(chat); selectedId = chat.id;
  document.body.classList.remove('sidebar-open'); sidebarState(); void save(); render(); $('prompt').focus();
};
$('search').oninput = renderSidebar;
$('show-archived').onclick = () => { showArchived = !showArchived; renderSidebar(); };
$('archive-chat').onclick = async () => {
  const chat=current();if(!chat||storageBlocked||restoring||structuralPending||deletingChats.has(chat.id))return;
  const archived=chat.archived===true;
  try{await changeSnapshot(()=>{
    if(!chats.includes(chat)||(chat.archived===true)!==archived)throw Error('The chat changed before archiving.');
    const candidate={...chat};if(archived)delete candidate.archived;else candidate.archived=true;
    return {value:{...snapshotFields,chats:chats.map(row=>row===chat?candidate:row),selectedId},apply:()=>{if(archived)delete chat.archived;else chat.archived=true;}};
  });render();notice(archived?'Chat moved back to Chats.':'Chat archived. Its history and draft are kept, including in exports.');}catch(error){notice('Archive state was kept. '+error.message);controls();}
};
function overlayPanel(){return matchMedia('(max-width: 650px)').matches&&document.body.classList.contains('sidebar-open')?$('sidebar'):matchMedia('(max-width: 1249px)').matches&&!$('context-panel').hidden?$('context-panel'):null;}
function syncOverlay(){
  const panel=overlayPanel();document.querySelector('main').inert=!!panel;$('sidebar').inert=!!panel&&panel!==$('sidebar');$('context-panel').inert=!!panel&&panel!==$('context-panel');$('overlay-shade').hidden=!panel;
  for(const aside of [$('sidebar'),$('context-panel')]){if(aside===panel){aside.setAttribute('role','dialog');aside.setAttribute('aria-modal','true');}else{aside.removeAttribute('role');aside.removeAttribute('aria-modal');}}
  if(panel&&!panel.contains(document.activeElement))panel.querySelector('button')?.focus();
}
function sidebarState(){ $('open-sidebar').setAttribute('aria-expanded',String(matchMedia('(max-width: 650px)').matches?document.body.classList.contains('sidebar-open'):!document.body.classList.contains('sidebar-collapsed')));syncOverlay(); }
function toggleSidebar(close=false) {
  if(!close&&matchMedia('(max-width: 650px)').matches)setContext(false);
  if(matchMedia('(max-width: 650px)').matches)document.body.classList.toggle('sidebar-open',!close&&!document.body.classList.contains('sidebar-open'));
  else {document.body.classList.toggle('sidebar-collapsed',close||!document.body.classList.contains('sidebar-collapsed'));try{localStorage.setItem('qwen-sidebar-collapsed',String(document.body.classList.contains('sidebar-collapsed')));}catch{}}
  sidebarState();
  if(document.body.classList.contains('sidebar-open'))$('new-chat').focus();else $('open-sidebar').focus();
}
$('open-sidebar').onclick = () => toggleSidebar();
$('close-sidebar').onclick = () => toggleSidebar(true);
try{document.body.classList.toggle('sidebar-collapsed',localStorage.getItem('qwen-sidebar-collapsed')==='true');}catch{}
sidebarState();matchMedia('(max-width: 650px)').addEventListener('change',sidebarState);matchMedia('(max-width: 1249px)').addEventListener('change',syncOverlay);
let renamingId;
$('rename-chat').onclick=()=>{renamingId=selectedId;$('rename-title').value=current().title;globalThis.salehWorkspace.openDialog($('rename-dialog'), $('rename-chat'));$('rename-title').focus();$('rename-title').select();};
$('rename-cancel').onclick=()=>globalThis.salehWorkspace.closeDialog($('rename-dialog'));
$('rename-form').onsubmit=event=>{event.preventDefault();const title=$('rename-title').value.trim(),chat=chats.find(c=>c.id===renamingId);if(!title||!chat)return;chat.title=title.slice(0,120);void save();globalThis.salehWorkspace.closeDialog($('rename-dialog'));$('title').textContent=current().title;renderSidebar();};
$('rename-dialog').addEventListener('close',()=>$('rename-chat').focus());
document.addEventListener('keydown', event => {
  if(event.isComposing || document.querySelector('dialog[open]'))return;
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&event.key.toLowerCase()==='f'){event.preventDefault();$('find-chat').click();return;}
  const panel=overlayPanel();
  if(event.key==='Escape'&&!panel&&!$('chat-find').hidden&&$('chat-find').contains(document.activeElement)){event.preventDefault();closeChatFind();return;}
  if(event.key==='Tab'&&panel){const items=[...panel.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(el=>el.getClientRects().length&&!el.closest('[hidden]'));const first=items[0],last=items.at(-1);if(event.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){event.preventDefault();first?.focus();}}
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setContext(false);$('new-chat').click();}
  if(event.key==='Escape'){const sidebarOpen=document.body.classList.contains('sidebar-open'),wasOpen=!$('context-panel').hidden;const button=inspectorMode==='tools'?'open-tools':inspectorMode==='computer'?'open-computer':'toggle-context';document.body.classList.remove('sidebar-open');setContext(false);sidebarState();if(wasOpen)$(button).focus();else if(sidebarOpen)$('open-sidebar').focus();}
});
$('overlay-shade').onclick=()=>{if(!$('context-panel').hidden)$('close-context').click();else toggleSidebar(true);};
document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { if($('prompt').value.length){notice('Your draft is kept. Use a suggestion in an empty message.');$('prompt').focus();return;} $('prompt').value = button.dataset.prompt; $('prompt').dispatchEvent(new Event('input')); $('prompt').focus(); });
let backupURLs=[];
$('export').onclick = () => { window.dispatchEvent(new Event('workspace-reveal-main')); try {
  if(storageHydrating)throw Error('Wait for saved history to finish loading before exporting.');
  const data = { ...snapshotFields, exportedAt: new Date().toISOString(), chats, selectedId, ...(unreadableData && originalData ? { unreadableOriginalBackup: originalData } : {}) };
  const files=qwenWork.backupFiles(data),panel=$('backup-downloads');backupURLs.forEach(url=>URL.revokeObjectURL(url));backupURLs=[];panel.replaceChildren();panel.hidden=files.length===1;
  if(files.length>1){const info=document.createElement('p');info.textContent=`Download all ${files.length} parts. To restore, select these files together in Restore backup.`;panel.append(info);}
  for(const [i,text] of files.entries()){const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));backupURLs.push(url);const link=document.createElement('a');link.href=url;link.download=`qwen-chats-${new Date().toISOString().slice(0,10)}${files.length>1?`-part-${i+1}-of-${files.length}`:''}.json`;link.textContent=`Download part ${i+1} of ${files.length}`;if(files.length===1)link.click();else panel.append(link);}
  if(files.length>1){document.body.classList.remove('sidebar-open');setContext(false);panel.querySelector('a').focus();}
}catch(error){notice('Backup not exported. '+error.message);} };
async function checkConnection() { await refreshModels(); }
$('connection').onclick = checkConnection;
let inspectorMode = 'context';
function setContext(open, mode = 'context') {
  if(open)document.body.classList.remove('sidebar-open');
  inspectorMode = mode; $('context-panel').hidden = !open;
  $('context-fields').hidden = mode !== 'context'; $('computer-panel').hidden = mode !== 'computer'; $('tools-panel').hidden=mode!=='tools';
  $('inspector-title').textContent = mode==='tools'?'Tools':mode === 'computer' ? 'Computer' : 'Context';
  $('toggle-context').setAttribute('aria-expanded', String(open && mode === 'context'));
  $('open-tools').setAttribute('aria-expanded',String(open && mode==='tools'));
  $('open-computer').setAttribute('aria-expanded', String(open && mode === 'computer'));
  $('context-panel').setAttribute('aria-label',`${$('inspector-title').textContent} panel`);sidebarState();if(open)$('close-context').focus();
}
$('toggle-context').onclick = () => { setContext($('context-panel').hidden || inspectorMode !== 'context'); if (!$('context-panel').hidden) $('project-name').focus(); };
$('close-context').onclick = () => { const button = inspectorMode==='tools'?'open-tools':inspectorMode === 'computer' ? 'open-computer' : 'toggle-context'; setContext(false); $(button).focus(); };
$('project-name').oninput = () => { current().project = $('project-name').value; scheduleSave(); renderSidebar(); renderCompaction(); };
$('notes').oninput = () => { current().notes = $('notes').value; scheduleSave(); renderCompaction(); };
$('notes').onchange = renderContext;
$('text-file').onchange = async () => {
  const file = $('text-file').files[0], chat = current(); $('text-file').value = ''; if (!file) return;
  const read = {name:file.name}; attachmentReads.set(chat,read); renderContext(); controls();
  try {
    if (!/\.(txt|md|json|js|mjs|ts|tsx|jsx|py|csv|css|html|swift|log)$/i.test(file.name) || file.size > 64000) throw new Error('Choose a text or code file under 64 KB.');
    const text = await readUTF8(file);
    if (attachmentReads.get(chat) !== read || !chats.includes(chat)) return;
    if (text.includes('\0') || text.length > 12000) throw new Error('Choose a UTF-8 text file with at most 12,000 characters.');
    chat.file = { name: file.name, text }; void save();
  } catch (error) { if (attachmentReads.get(chat) === read && current() === chat) notice(error.message); }
  finally { if (attachmentReads.get(chat) === read) { attachmentReads.delete(chat); if (current() === chat) { renderContext(); controls(); } } }
};
$('add-file').onclick = () => $('text-file').click();
$('composer-attach').onclick = () => $('message-files').click();
$('remove-file').onclick = () => { attachmentReads.delete(current()); current().file = null; void save(); renderContext(); controls(); };
$('composer-remove-file').onclick = () => $('remove-file').click();
function draftAttachments(chat){return chat.draftAttachmentMessageId?chat.messages.find(m=>m.id===chat.draftAttachmentMessageId)?.attachments??[]:chat.draftAttachments??[];}
async function setDraftAttachments(chat,files){
  const batch=attachments.normalize(files);
  await changeSnapshot(()=>{
    if(!chats.includes(chat)||deletingChats.has(chat.id))throw Error('The attachment draft changed before saving.');
    const candidate={...chat};delete candidate.draftAttachmentMessageId;if(batch.length)candidate.draftAttachments=batch;else delete candidate.draftAttachments;
    return {value:{...snapshotFields,chats:chats.map(row=>row===chat?candidate:row),selectedId},apply:()=>{delete chat.draftAttachmentMessageId;if(batch.length)chat.draftAttachments=batch;else delete chat.draftAttachments;}};
  });
}
const attachmentCards=attachments.cards;
function renderDraftAttachments(){
  const chat=current(),files=draftAttachments(chat),area=$('draft-attachments');area.replaceChildren();
  if(files.length)area.append(attachmentCards(files,async index=>{
    attachmentReads.delete(chat);try{await setDraftAttachments(chat,files.filter((_,i)=>i!==index));}catch(error){notice(error.message);}renderDraftAttachments();controls();
  }));
  const loading=attachmentReads.get(chat);if(loading?.messageFiles){const status=document.createElement('span');status.className='attachment-loading';status.textContent='Reading attachments…';area.append(status);}
}
async function decodeAttachmentImage(dataURL){
  const dimensions=attachments.imageInfo(dataURL),image=new Image();
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('The selected image could not be decoded.'));image.src=dataURL;});
  if(!([dimensions.width,dimensions.height].includes(image.naturalWidth)&&[dimensions.width,dimensions.height].includes(image.naturalHeight)&&image.naturalWidth*image.naturalHeight===dimensions.width*dimensions.height))throw Error('Image dimensions do not match its header.');
}
async function readMessageFile(file){
  if(file.size>2*1024*1024)throw Error('Each selected file must be at most 2 MB.');
  if(/\.(png|jpe?g)$/i.test(file.name)){
    const bytes=new Uint8Array(await file.arrayBuffer()),mime=/\.png$/i.test(file.name)?'png':'jpeg';
    let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
    const dataURL='data:image/'+mime+';base64,'+btoa(binary);await decodeAttachmentImage(dataURL);
    return {kind:'image',name:file.name,dataURL};
  }
  if(!/\.(txt|md|json|js|mjs|ts|tsx|jsx|py|csv|css|html|swift|log|yaml|yml|xml|sh|kt|java|c|h|cpp|rs|go)$/i.test(file.name)||file.size>64000)throw Error('Choose UTF-8 text/code files under 64 KB, or PNG/JPEG images.');
  return {kind:'text',name:file.name,text:await readUTF8(file)};
}
$('message-files').onchange=async()=>{
  const files=[...$('message-files').files],chat=current();$('message-files').value='';if(!files.length)return;
  const previous=draftAttachments(chat),read={name:files.map(f=>f.name).join(', '),messageFiles:true};attachmentReads.set(chat,read);renderDraftAttachments();controls();
  try{
    if(files.length+previous.length>4)throw Error('Attach up to 4 files per message.');
    const selected=[];for(const file of files)selected.push(await readMessageFile(file));
    const batch=attachments.normalize([...previous,...selected]);
    await attachmentStorage.prepare(batch);
    if(pageDisposed||attachmentReads.get(chat)!==read||!chats.includes(chat)||deletingChats.has(chat.id))return;
    await setDraftAttachments(chat,batch);notice('');
  }catch(error){if(attachmentReads.get(chat)===read&&current()===chat)notice('Attachments not added. '+error.message);}
  finally{if(attachmentReads.get(chat)===read){attachmentReads.delete(chat);if(current()===chat){renderContext();controls();}}}
};
let completedChatId;
$('focus-reply').onclick=()=>{if(completedChatId&&chats.some(c=>c.id===completedChatId)){selectedId=completedChatId;void save();render();}const reply=$('messages').querySelector('.assistant:last-of-type');if(reply){reply.tabIndex=-1;reply.focus();reply.scrollIntoView({block:'start'});}};
function storageConflict(message) {
  storageBlocked = true; clearTimeout(saveTimer);
  storageNotice((message||'Another tab changed saved chats.')+' This tab has stopped saving to prevent overwriting them. Export any unsaved work here, then reload.');controls();
}
window.addEventListener('storage', event => {
  if (event.key === LOCAL_MODEL_DEFAULT_KEY) {controls(); return;}
  if (event.key !== KEY && event.key !== null) return;
  storageConflict();
});
window.addEventListener('pagehide',()=>{attachmentReads.clear();});
document.addEventListener('visibilitychange', () => { if (document.hidden) void save(); else checkConnection(); });
function startPage(){render();void save();checkConnection();setContext(false);$('prompt').focus();}
Object.assign(globalThis,{setContext,current,notice});
storageHydrating=false;document.body.inert=false;
startPage();void window.SalehChatRuns.refresh().catch(()=>{});
})().catch(error=>{document.body.inert=false;const notice=document.getElementById('storage-notice');notice.hidden=false;notice.textContent='Chat initialization failed. Stored history was kept. '+error.message;});
