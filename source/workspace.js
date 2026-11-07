/* Presentation preferences only. History, execution and permissions remain owned by their existing controllers. */
(() => {
  'use strict';
  const key = 'saleh-workspace-ui-v1';
  const empty = () => ({version: 1, pinnedChat: [], pinnedCoding: [], collapsedProjects: []});
  const valid = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit;
  function normalize(value) {
    if (value === null) return empty();
    if (!value || value.version !== 1 || Array.isArray(value)) throw Error('Saved sidebar settings have an unsupported format. They were kept unchanged.');
    const result = empty();
    for (const name of ['pinnedChat', 'pinnedCoding', 'collapsedProjects']) {
      const rows = value[name];
      if (!Array.isArray(rows) || rows.length > 500 || rows.some(row => !valid(row, name === 'collapsedProjects' ? 4096 : 512))) throw Error('Saved sidebar settings could not be read. They were kept unchanged.');
      result[name] = [...new Set(rows)];
    }
    return result;
  }
  function createStore(storage, changed = () => {}, failed = () => {}) {
    let state = empty();
    const read = () => normalize(JSON.parse(storage.getItem(key) || 'null'));
    function refresh() {try {state = read(); changed();} catch (error) {failed(error.message);} }
    function mutate(field, id, replacement) {
      if (!valid(id, field === 'collapsedProjects' ? 4096 : 512) || replacement !== undefined && !valid(replacement, 512)) return false;
      try {
        const next = read();
        if (replacement !== undefined && !next[field].includes(id)) return true;
        next[field] = replacement !== undefined ? [...new Set(next[field].map(value => value === id ? replacement : value))] : next[field].includes(id) ? next[field].filter(value => value !== id) : [...next[field], id];
        if (next[field].length > 500) throw Error('Sidebar limit reached. Unpin a chat or expand a project before adding more.');
        storage.setItem(key, JSON.stringify(next)); state = next; changed(); return true;
      } catch (error) {failed(error.message || 'Sidebar settings could not be saved. Existing history and drafts are unchanged.'); return false;}
    }
    const field = scope => {if (!['chat', 'coding'].includes(scope)) throw Error('Unknown workspace.'); return scope === 'chat' ? 'pinnedChat' : 'pinnedCoding';};
    return {refresh, pinned: (scope, id) => state[field(scope)].includes(id), collapsed: path => state.collapsedProjects.includes(path),
      togglePin: (scope, id) => mutate(field(scope), id), remapPin: (scope, oldId, newId) => mutate(field(scope), oldId, newId), toggleProject: path => mutate('collapsedProjects', path)};
  }
  // Presentation of this launch's existing policy; this never grants authority.
  function toolAuthority(mode, access, nativeTools = true) {
    const policy = access?.mode === 'full' ? 'Full Access' : access?.mode === 'reviewed' ? 'Ask Before Tools' : 'Access unconfirmed';
    if (mode === 'chat') return {label:'Chat · tools off', state:'off', notice:false,
      detail:'The next message uses your conversation and supplied context without calling tools. ' + policy + ' applies only to modes that use tools.'};
    if (mode !== 'agent') return {label:access?.recoveryStartup ? 'Full access · Recovery' : policy, state:access?.mode || 'unknown', notice:false,
      detail:access?.recoveryStartup ? 'Recovery startup holds unrestricted tools.' : access?.mode === 'full' ? 'Operational tools run without app approval. Required choices and macOS permissions still apply.' : access?.mode === 'reviewed' ? 'Tool actions follow native review. Approved routine reads can run automatically.' : 'Current tool access could not be checked.'};
    if (!nativeTools) return {label:'Agent · Mac app required', state:'unknown', notice:true,
      detail:'Agent tools require the native Noiee app. Chat can answer without tools.'};
    if (!access) return {label:'Agent · access unconfirmed', state:'unknown', notice:true,
      detail:'Current tool access could not be checked. Review this launch in tool access settings before requesting tools.'};
    if (access.recoveryStartup) return {label:'Agent · recovery hold', state:'held', notice:true,
      detail:'Recovery startup holds unrestricted tools. Saved history and explicit recovery remain available.'};
    return {label:'Agent · ' + policy, state:access.mode, notice:false,
      detail:access.mode === 'full' ? 'For the next message, Agent may use enabled tools without operational approval. Required choices and macOS permissions still apply.' : 'For the next message, Agent may use enabled tools through native review. Approved routine reads can run automatically.'};
  }
  globalThis.SalehWorkspaceState = Object.freeze({normalize, createStore, toolAuthority, key});
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  // Explicit modal isolation keeps Tasks dialogs accessible after asynchronous hydration.
  let activeDialog = null;
  const dialogVisible = node => node?.isConnected && !node.disabled && !node.closest('[hidden],[inert]') && node.getClientRects().length;
  const dialogInert = node => {activeDialog?.syncInert(); return activeDialog?.inert.has(node) ? activeDialog.inert.get(node) !== null : node.inert;};
  const dialogControls = dialog => [...dialog.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex]')].filter(node => node.tabIndex >= 0 && dialogVisible(node));
  function closeDialog(dialog, restore = true) {
    const state = activeDialog?.dialog === dialog ? activeDialog : null;
    if (!state) {dialog.close(); return;}
    state.syncInert();
    activeDialog = null; state.observer.disconnect();
    if (dialog.matches(':popover-open')) dialog.hidePopover();
    dialog.close();
    for (const [node, value] of state.inert) value === null ? node.removeAttribute('inert') : node.setAttribute('inert', value);
    for (const [name, value] of state.attributes) value === null ? dialog.removeAttribute(name) : dialog.setAttribute(name, value);
    if (restore) [state.opener, document.getElementById('workspace-quick-open'), document.getElementById('prompt')].find(node => dialogVisible(node) && node.tabIndex >= 0)?.focus();
  }
  function openDialog(dialog, opener = document.activeElement) {
    if (!(dialog instanceof HTMLDialogElement) || dialog.parentElement !== document.body || document.body.inert) throw Error('The dialog cannot open in this page state.');
    if (activeDialog?.dialog === dialog) return;
    if (activeDialog) closeDialog(activeDialog.dialog, false);
    if (document.querySelector('dialog[open]')) throw Error('Close the existing dialog first.');
    if (typeof dialog.showPopover !== 'function') throw Error('This WebKit does not support the dialog presentation.');
    const state = {dialog, opener, lastFocus: null, inert: new Map(), attributes: new Map(['popover','aria-modal','tabindex'].map(name => [name, dialog.getAttribute(name)])), observer: null};
    function isolate() {
      state.observer.disconnect();
      for (const node of document.body.children) if (node !== dialog) {
        if (!state.inert.has(node)) state.inert.set(node, node.getAttribute('inert'));
        node.inert = true;
      }
      state.observer.observe(document.body, {childList: true});
      for (const node of state.inert.keys()) if (node.parentElement === document.body) state.observer.observe(node, {attributes: true, attributeFilter: ['inert']});
    }
    state.observer = new MutationObserver(records => {
      if (activeDialog !== state) return;
      state.syncInert(records);
      if (!dialog.isConnected || !dialog.open || !dialog.matches(':popover-open')) {closeDialog(dialog); return;}
    });
    state.syncInert = (records = state.observer.takeRecords()) => {
      for (const record of records) if (record.type === 'attributes' && state.inert.has(record.target)) state.inert.set(record.target, record.target.getAttribute('inert'));
      if (records.length) isolate();
    };
    activeDialog = state;
    try {
      dialog.popover = 'manual'; dialog.setAttribute('aria-modal', 'true'); dialog.tabIndex = -1;
      dialog.show(); dialog.showPopover(); isolate();
      (dialogControls(dialog)[0] || dialog).focus();
    } catch (error) {closeDialog(dialog, false); throw error;}
  }
  document.addEventListener('focusin', event => {
    const state = activeDialog; if (!state || document.body.inert) return;
    if (state.dialog.contains(event.target)) {state.lastFocus = event.target; return;}
    event.stopPropagation(); (dialogVisible(state.lastFocus) ? state.lastFocus : dialogControls(state.dialog)[0] || state.dialog).focus();
  }, true);
  document.addEventListener('keydown', event => {
    const state = activeDialog; if (!state || event.isComposing || document.body.inert) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (state.dialog.dispatchEvent(new Event('cancel', {cancelable: true}))) closeDialog(state.dialog);
    } else if (event.key === 'Tab') {
      const controls = dialogControls(state.dialog), first = controls[0], last = controls.at(-1), outside = !state.dialog.contains(document.activeElement);
      if (!controls.length || outside || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last || document.activeElement === state.dialog) {
        event.preventDefault(); event.stopImmediatePropagation(); ((event.shiftKey ? last : first) || state.dialog).focus();
      }
    }
  }, true);
  document.addEventListener('close', event => {if (activeDialog?.dialog === event.target && !event.target.open) closeDialog(event.target);}, true);
  document.addEventListener('toggle', event => {if (activeDialog?.dialog === event.target && !event.target.matches(':popover-open')) closeDialog(event.target);}, true);
  window.addEventListener('pagehide', () => {if (activeDialog) closeDialog(activeDialog.dialog, false);});

  let currentAccess = null;
  function renderToolAuthority() {
    const chip=$('workspace-access-chip'),mode=$('chat-mode')?.value;
    const view=toolAuthority(mode,currentAccess,!!window.webkit?.messageHandlers?.tools);
    if(chip){
      chip.textContent=view.label;chip.dataset.mode=view.state;
      chip.title=view.detail+' Open tool access settings.';
      chip.setAttribute('aria-label',view.label+'. Open tool access settings.');
    }
    const detail=$('composer-authority-detail');
    if(detail){detail.textContent=view.detail;detail.hidden=!view.notice;}
    const welcome=$('welcome-authority');
    if(welcome)welcome.textContent=mode==='agent'
      ? 'Agent can use enabled tools. Its access policy is shown beside the message field.'
      : 'Chat answers with the context you share. Use Agent for tools, or Tasks for a project.';
  }
  async function showToolAccess() {
    const status=$('tool-access-status'),recovery=$('tool-access-recovery');
    if(!status||!recovery)return;
    try {
      const response=await fetch('/api/access',{cache:'no-store'}),value=await response.json();
      const held=value?.recoveryStartup??false;
      if(!response.ok||!['full','reviewed'].includes(value?.mode)||typeof value.managedChangesBlocked!=='boolean'||typeof held!=='boolean'||held&&(value.mode!=='full'||value.managedChangesBlocked)||value.mode==='full'&&!value.managedChangesBlocked&&!held)throw Error('Invalid access status');
      currentAccess=Object.freeze({mode:value.mode,managedChangesBlocked:value.managedChangesBlocked,recoveryStartup:held});
      status.textContent=held?'Full Access · Recovery startup. Unrestricted tools are held; saved history, text chat and explicit recovery remain available.':value.mode==='full'?'Full Access · Operational tools run without app approval.':'Ask Before Tools · Tool actions follow native review. Approved routine reads can run automatically.';
      recovery.hidden=!value.managedChangesBlocked&&!held;
      if(held)recovery.textContent='Finish the retained recovery before releasing unrestricted tools. Canceling recovery startup in the app menu takes effect only after normal quit and relaunch.';
    } catch {
      currentAccess=null;
      status.textContent='Current tool access could not be checked. Check the app window title for the running mode.';
      recovery.hidden=true;
    }
    renderToolAuthority();
  }
  $('chat-mode')?.addEventListener('change',renderToolAuthority);
  window.addEventListener('chat-selection-change',renderToolAuthority);
  window.addEventListener('chat-busy',renderToolAuthority);
  renderToolAuthority();
  void showToolAccess();
  function feedback(text) {
    let node = $('workspace-feedback');
    if (!node) {node = document.createElement('p'); node.id = 'workspace-feedback'; node.className = 'banner'; node.setAttribute('role', 'status'); document.querySelector('main').prepend(node);}
    node.textContent = text;
  }
  const preferences = createStore({getItem: name => localStorage.getItem(name), setItem: (name, value) => localStorage.setItem(name, value)},
    () => window.dispatchEvent(new Event('workspace-preferences-change')), feedback);
  function pinButton(scope, id, title) {
    const button = document.createElement('button'), pinned = preferences.pinned(scope, id);
    button.className = 'workspace-pin'; button.type = 'button'; button.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6l-1 5 3 3v1h-4v5l-1-1-1 1v-5H5v-1l3-3-1-5Z"/></svg>';
    button.dataset.workspacePin = id; button.dataset.workspaceScope = scope;
    button.setAttribute('aria-pressed', String(pinned)); button.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${title}`); button.title = pinned ? 'Unpin chat' : 'Pin chat';
    button.onclick = event => {
      event.stopPropagation(); preferences.togglePin(scope, id);
      [...document.querySelectorAll('[data-workspace-pin]')].find(node => node.dataset.workspacePin === id && node.dataset.workspaceScope === scope)?.focus();
    };
    return button;
  }
  const revealed = new WeakMap();
  function revealCurrent(list, id) {
    if (!list || !id || revealed.get(list) === id) return;
    const selected = list.querySelector('[aria-current="page"]');
    if (!selected?.getClientRects().length) return;
    selected.scrollIntoView({block:'nearest', inline:'nearest'}); revealed.set(list, id);
  }
  globalThis.salehWorkspace = Object.freeze({...preferences, pinButton, openDialog, closeDialog, dialogInert, revealCurrent});

  let returnFocus = null;
  const utilityOverlay = matchMedia('(max-width: 1149px)');
  function utilityPanel() {
    if (!utilityOverlay.matches || document.body.inert || document.querySelector('dialog[open]') || $('mcp-setup') && !$('mcp-setup').hidden || $('sidebar')?.getAttribute('aria-modal') === 'true') return null;
    return [$('workspace-settings'), $('workspace-extensions-panel')].find(node => node && !node.hidden && !node.inert) || null;
  }
  const utilityControls = panel => [...panel.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[inert],[hidden]'));
  function containUtilityFocus() {
    const panel = utilityPanel();
    if (panel && !panel.contains(document.activeElement)) utilityControls(panel)[0]?.focus();
  }
  document.addEventListener('focusin', event => {
    const panel = utilityPanel();
    if (panel && !panel.contains(event.target)) {event.stopPropagation(); containUtilityFocus();}
  }, true);
  document.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const panel = utilityPanel(); if (!panel) return;
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); if (panel.id === 'workspace-settings') closeSettings(); else globalThis.SalehExtensions?.close();}
    if (event.key === 'Tab') {
      const controls = utilityControls(panel), first = controls[0], last = controls.at(-1), outside = !panel.contains(document.activeElement);
      if (outside || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {event.preventDefault(); event.stopPropagation(); (event.shiftKey ? last : first)?.focus();}
    }
  }, true);
  utilityOverlay.addEventListener('change', containUtilityFocus);
  window.addEventListener('workspace-reveal-main', () => {closeSettings(false); globalThis.SalehExtensions?.close();});
  function closeOtherPanels() {
    if (!$('context-panel')?.hidden) $('close-context')?.click();
    if ($('workspace-panel') && !$('workspace-panel').hidden) $('close-panel')?.click();
    if (document.body.classList.contains('sidebar-open')) $('close-sidebar')?.click();
  }
  function closeSettings(restore = true) {
    if (!$('workspace-settings')) return;
    $('workspace-settings').hidden = true; $('workspace-settings-open')?.setAttribute('aria-expanded', 'false');
    if (!$('workspace-extensions-panel') || $('workspace-extensions-panel').hidden) document.body.classList.remove('workspace-utility-open');
    if (restore) [returnFocus, $('sidebar-toggle'), $('open-sidebar'), $('prompt')].find(node => node?.isConnected && !node.disabled && !node.closest('[inert],[hidden]') && node.getClientRects().length)?.focus();
  }
  $('workspace-settings-open')?.addEventListener('click', () => {
    if (!$('workspace-settings').hidden) {closeSettings(); return;}
    closeOtherPanels(); globalThis.SalehExtensions?.close();
    returnFocus = $('workspace-settings-open'); $('workspace-settings').hidden = false;
    document.body.classList.add('workspace-utility-open'); $('workspace-settings-open').setAttribute('aria-expanded', 'true'); $('workspace-settings-close').focus();
  });
  $('workspace-settings-close')?.addEventListener('click', () => closeSettings());
  $('workspace-extensions-open')?.addEventListener('click', () => {
    closeOtherPanels(); closeSettings(false);
    if (!globalThis.SalehExtensions) {feedback('Extensions could not load. Reload this view when your draft is saved.'); return;}
    globalThis.SalehExtensions.open(); document.body.classList.add('workspace-utility-open');
  });
  document.addEventListener('click', event => {
    const id = event.target.closest?.('button')?.id;
    if (['new-chat', 'new-tools-task', 'open-tools', 'open-computer', 'toggle-context', 'find-chat', 'changes-toggle', 'terminal-toggle', 'worktrees-toggle', 'schedules-toggle', 'back-chat', 'open-coding', 'sidebar-toggle', 'open-sidebar', 'session-overview'].includes(id)) {
      closeSettings(false); globalThis.SalehExtensions?.close();
    }
  }, true);
  // Commands dispatch existing controls. Their controllers retain saving,
  // admission, model selection and tool authority; the palette grants none.
  const quick = document.createElement('dialog'); quick.id = 'workspace-quick-dialog';
  quick.setAttribute('aria-labelledby', 'workspace-quick-title');
  quick.innerHTML = '<div class="workspace-quick-heading"><div><h2 id="workspace-quick-title">Command palette</h2><p id="workspace-quick-scope"></p></div><button id="workspace-quick-close" type="button" aria-label="Close command palette">×</button></div><label class="sr-only" for="workspace-quick-query">Find a command</label><input id="workspace-quick-query" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="workspace-quick-results" aria-describedby="workspace-quick-count" placeholder="Search commands…" autocomplete="off" spellcheck="false" maxlength="120"><p id="workspace-quick-count" role="status" aria-live="polite" aria-atomic="true"></p><div id="workspace-quick-results" role="listbox" aria-label="Commands"></div><p id="workspace-quick-empty" hidden>No matching commands. Try “project”, “history”, “tools”, or “settings”.</p><p class="workspace-quick-hint">↑ ↓ Choose <span>↵ Run command</span><span>Esc Close</span></p>';
  document.body.append(quick);
  const command = (id,label,detail,group,keywords='',shortcut='',unavailable='Unavailable in the current workspace state.') => ({id,label,detail,group,keywords,shortcut,unavailable});
  const quickActions = [
    command('new-chat','New chat','Start a chat without replacing the current draft','Workspace','create conversation','⌘K','Wait for workspace saving or recovery to finish.'),
    command('new-project','New project…','Choose a project through the existing project dialog','Tasks','folder directory create'),
    command('prompt','Write a message','Focus the current composer and keep its text','Conversation','focus draft input','', 'This conversation is read-only or the composer is unavailable.'),
    command('search','Search chats','Find a conversation in the sidebar','Workspace','filter title'),
    command('find-chat','Find in this chat','Find text in the current conversation','Chat','search message','⌘F'),
    command('history-search-open','Search task history','Search saved messages across tasks','Tasks','find older conversation'),
    command('browse-history','Browse saved history','Read older turns in this task','Tasks','past previous messages'),
    command('return-to-parent','Return to parent chat','Continue from this agent’s parent conversation','Tasks','child agent back','', 'The current parent binding must be verified first.'),
    command('session-overview','Session overview','Inspect this project’s current session','Tasks','run status'),
    command('workspace-settings-open','Settings','Review models and this launch’s tool policy','Workspace','preferences permissions approval access','⌘,'),
    command('workspace-extensions-open','Extensions','Browse tools and skills','Workspace','plugins mcp install'),
    command('open-tools','Tools','Inspect connected tools and the tool catalog','Chat','mcp skills permissions'),
    command('open-computer','Computer controls','Open the existing computer practice panel','Chat','screen window'),
    command('toggle-context','Working context','Open notes and attached context','Chat','project file brief instructions'),
    command('rename-chat','Rename chat','Edit this conversation’s title','Chat','name title'),
    command('show-archived','Show archived chats','Switch the sidebar’s saved-chat filter','Workspace','archive history'),
    command('compact-context','Compact context','Summarize earlier context using the existing compaction flow','Chat','summary memory','', 'Wait for current work or storage checks, or review a stale summary.'),
    command('compaction-full-history','Use full history','Keep saved summaries while using original messages','Chat','summary originals reset'),
    command('compaction-rebuild','Rebuild context summary','Create a new summary from the original history','Chat','compact stale memory'),
    command('changes-toggle','Project changes','Inspect changes in the current project','Project','git diff review'),
    command('terminal-toggle','Project terminal','Open the current project’s terminal panel','Project','shell console'),
    command('worktrees-toggle','Worktrees','Inspect managed project copies and retained recovery','Project','git branches handoff restore'),
    command('schedules-toggle','Schedules','Inspect this project’s scheduled work','Project','automation recurring'),
    command('failed-startups','Review failed task startups…','Inspect retained startup recovery through native review','Recovery','failed incomplete project continuation'),
    command('stop','Stop current work','Use this conversation’s existing Stop control','Conversation','cancel interrupt'),
    command('refresh','Refresh Tasks','Refresh the existing task view','Tasks','reload update'),
    command('open-coding','Open Tasks','Continue in your project workspace','Workspace','coding code project'),
    command('back-chat','Open Chat','Return to your conversations','Workspace','home messages'),
  ];
  const hiddenNavigation = new Set(['open-coding','back-chat']);
  let quickActive = null, quickRows = [], quickObserver = null;
  function commandState(action) {
    const target=$(action.id);if(!target)return null;
    const toggle=$('sidebar-toggle')||$('open-sidebar');
    const collapsed=target.closest('#sidebar')&&toggle?.getAttribute('aria-expanded')==='false';
    for(let node=target;node;node=node.parentElement){
      if(node.hidden && !(node.id==='sidebar'&&collapsed))return null;
      if(dialogInert(node)&&!(node.id==='sidebar'&&collapsed))return {target,available:false,reason:'Wait for the current dialog or workspace transition.'};
    }
    if(!target.getClientRects().length&&!collapsed&&!hiddenNavigation.has(action.id)&&!target.closest('details:not([open])'))return null;
    const available=!target.disabled&&target.getAttribute('aria-disabled')!=='true'&&!(collapsed&&toggle.disabled);
    return {target,available,reason:available?'':target.dataset.commandDisabledReason||action.unavailable};
  }
  function quickTarget(id) {
    const action=quickActions.find(row=>row.id===id)||{id,unavailable:'Unavailable.'};
    const state=commandState(action);
    return state?.available&&!document.body.inert?state.target:null;
  }
  function commandLabel(action) {
    if(action.id==='show-archived')return $('show-archived')?.getAttribute('aria-pressed')==='true'?'Show active chats':'Show archived chats';
    return action.label;
  }
  function selectQuickAction(id) {
    quickActive=id;
    for(const button of $('workspace-quick-results').querySelectorAll('[role="option"]')){
      const selected=button.dataset.command===id;button.setAttribute('aria-selected',String(selected));
      if(selected){$('workspace-quick-query').setAttribute('aria-activedescendant',button.id);button.scrollIntoView({block:'nearest'});}
    }
    if(!id)$('workspace-quick-query').removeAttribute('aria-activedescendant');
  }
  function watchQuickTargets() {
    quickObserver?.disconnect();
    if(!quick.open)return;
    quickObserver??=new MutationObserver(()=>{if(quick.open)renderQuickActions(true);});
    const watched=new Set();
    for(const action of quickActions)for(let node=$(action.id);node&&node!==document.documentElement;node=node.parentElement){
      if(watched.has(node))continue;watched.add(node);
      quickObserver.observe(node,{attributes:true,attributeFilter:['disabled','hidden','inert','aria-disabled','aria-pressed','data-command-disabled-reason']});
    }
  }
  function renderQuickActions(preserve=false) {
    const query=$('workspace-quick-query').value.trim().replace(/^>\s*/,'').toLocaleLowerCase(),terms=query.split(/\s+/).filter(Boolean);
    const rows=quickActions.flatMap(action=>{
      const state=commandState(action);if(!state)return [];
      const label=commandLabel(action),text=[label,action.detail,action.group,action.keywords].join(' ').toLocaleLowerCase();
      if(!terms.every(term=>text.includes(term)))return [];
      return [{...action,label,...state,score:query&&label.toLocaleLowerCase().startsWith(query)?2:terms.length&&terms.every(term=>label.toLocaleLowerCase().includes(term))?1:0}];
    }).sort((a,b)=>b.score-a.score);
    quickRows=rows;
    $('workspace-quick-results').replaceChildren();$('workspace-quick-empty').hidden=rows.length>0;
    const available=rows.filter(row=>row.available);
    $('workspace-quick-count').textContent=rows.length+' command'+(rows.length===1?'':'s')+(rows.length>available.length?' · '+(rows.length-available.length)+' unavailable':'');
    const task=document.body.classList.contains('workspace-coding');
    const title=(task?$('thread-title')||$('title'):$('title'))?.textContent?.trim();
    $('workspace-quick-scope').textContent=(task?'Tasks':'Chat')+(title?' · '+title.slice(0,160):'');
    for(const row of rows){
      const button=document.createElement('button'),text=document.createElement('span'),label=document.createElement('strong'),detail=document.createElement('small'),group=document.createElement('span');
      button.type='button';button.id='workspace-command-'+row.id;button.dataset.command=row.id;button.tabIndex=-1;
      button.setAttribute('role','option');button.setAttribute('aria-disabled',String(!row.available));button.disabled=!row.available;
      button.setAttribute('aria-label',row.label+'. '+(row.available?row.detail:'Unavailable. '+row.reason));
      label.textContent=row.label;detail.textContent=row.available?row.detail:'Unavailable · '+row.reason;group.className='workspace-command-group';group.textContent=row.group;
      text.className='workspace-command-text';text.append(label,detail);button.append(text,group);
      if(row.shortcut){const shortcut=document.createElement('kbd');shortcut.textContent=row.shortcut;button.append(shortcut);}
      button.onclick=()=>activateWorkspaceAction(row.id);
      $('workspace-quick-results').append(button);
    }
    selectQuickAction(preserve&&available.some(row=>row.id===quickActive)?quickActive:available[0]?.id||null);
    watchQuickTargets();
  }
  function activateWorkspaceAction(id) {
    let target=quickTarget(id);if(!target){if(quick.open)renderQuickActions(true);return;}
    closeQuickActions(false);
    // Closing a dialog can change controller state. Recheck before dispatch.
    target=quickTarget(id);if(!target){feedback('The command became unavailable. No action was taken.');return;}
    if(id==='search'){
      const toggle=$('sidebar-toggle')||$('open-sidebar');
      if(toggle?.getAttribute('aria-expanded')!=='true')toggle?.click();
      target.focus();
    }else if(id==='prompt')target.focus();
    else target.click();
  }
  function openQuickActions() {
    if(document.body.inert||document.querySelector('dialog[open]')||$('mcp-setup')&&!$('mcp-setup').hidden)return;
    const opener=document.activeElement;
    closeOtherPanels();closeSettings(false);globalThis.SalehExtensions?.close();
    $('workspace-quick-query').value='';renderQuickActions();openDialog(quick,opener);$('workspace-quick-query').focus();watchQuickTargets();
  }
  function closeQuickActions(restore=true) {quickObserver?.disconnect();closeDialog(quick,restore);}
  const quickTrigger=$('workspace-quick-open');
  if(quickTrigger){
    quickTrigger.setAttribute('aria-label','Command palette');quickTrigger.setAttribute('aria-keyshortcuts','Meta+Shift+P Control+Shift+P Meta+J Control+J');
    quickTrigger.title='Command palette (⌘⇧P · also ⌘J)';
    const label=quickTrigger.querySelector('span'),shortcut=quickTrigger.querySelector('kbd');
    if(label)label.textContent='Commands';if(shortcut)shortcut.textContent='⌘⇧P';
    quickTrigger.addEventListener('click',openQuickActions);
  }
  $('workspace-quick-close').onclick=()=>closeQuickActions();
  $('workspace-quick-query').oninput=()=>renderQuickActions();
  quick.addEventListener('cancel',event=>{event.preventDefault();closeQuickActions();});
  quick.addEventListener('close',()=>quickObserver?.disconnect());
  quick.addEventListener('keydown',event=>{
    event.stopPropagation();
    if(event.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();closeQuickActions();return;}
    if(['ArrowDown','ArrowUp','PageDown','PageUp'].includes(event.key)){
      event.preventDefault();renderQuickActions(true);
      const rows=quickRows.filter(row=>row.available);if(!rows.length)return;
      const current=rows.findIndex(row=>row.id===quickActive),step=event.key==='PageDown'?5:event.key==='PageUp'?-5:event.key==='ArrowDown'?1:-1;
      selectQuickAction(rows[(Math.max(0,current)+step%rows.length+rows.length)%rows.length].id);
      $('workspace-quick-query').focus();
    }else if(event.key==='Enter'&&document.activeElement===$('workspace-quick-query')){
      event.preventDefault();if(quickActive)activateWorkspaceAction(quickActive);
    }
  });
  // The rail and palette share existing button dispatch, including draft guards.
  const rail = document.createElement('nav'); rail.id = 'workspace-rail'; rail.setAttribute('aria-label', 'Workspaces');
  const mark = document.createElement('span'); mark.className = 'workspace-rail-mark'; mark.textContent = 'N'; mark.setAttribute('aria-hidden', 'true'); rail.append(mark);
  const icons = {
    chat:'<path d="M4 4h12v9H9l-5 3V4Z"/>', tasks:'<rect x="3" y="4" width="14" height="12" rx="2"/><path d="m6 8 2 2-2 2m5 0h3"/>',
    search:'<circle cx="8.5" cy="8.5" r="5"/><path d="m12 12 4.5 4.5"/>', extensions:'<rect x="3" y="3" width="5" height="5" rx="1"/><rect x="12" y="3" width="5" height="5" rx="1"/><rect x="3" y="12" width="5" height="5" rx="1"/><rect x="12" y="12" width="5" height="5" rx="1"/>',
    settings:'<circle cx="10" cy="10" r="3"/><path d="M8 3h4l1 3 3 1 1 4-3 2-1 3H8l-1-3-3-1-1-4 3-2 2-3Z"/>'
  };
  function railItem(label, id, icon, parent = rail) {
    const node = document.createElement(id ? 'button' : 'span');
    node.title = label; node.setAttribute('aria-label', label);
    if(id){node.type='button';node.dataset.workspaceAction=id;}else node.setAttribute('aria-current','page');
    node.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${icons[icon]}</svg>`; parent.append(node);
  }
  for(const [id,icon] of [['workspace-extensions-open','extensions'],['workspace-settings-open','settings']]) {
    const mark=$(id)?.querySelector('.workspace-nav-icon');
    if(mark)mark.innerHTML=`<svg viewBox="0 0 20 20" aria-hidden="true">${icons[icon]}</svg>`;
  }
  railItem('Chat', $('back-chat') ? 'back-chat' : null, 'chat');
  railItem('Tasks', $('open-coding') ? 'open-coding' : null, 'tasks');
  railItem('Search chats', 'search', 'search'); railItem('Extensions', 'workspace-extensions-open', 'extensions');
  const railBottom = document.createElement('div'); railBottom.className = 'workspace-rail-bottom'; rail.append(railBottom);
  railItem('Settings', 'workspace-settings-open', 'settings', railBottom);
  rail.addEventListener('click', event => {
    const id = event.target.closest('[data-workspace-action]')?.dataset.workspaceAction;
    if (!id || document.body.inert || document.querySelector('dialog[open]') || $('mcp-setup') && !$('mcp-setup').hidden) return;
    closeOtherPanels(); closeSettings(false); globalThis.SalehExtensions?.close(); activateWorkspaceAction(id);
  });
  document.body.insertBefore(rail, $('sidebar')); document.body.classList.add('has-workspace-rail');
  $('workspace-access-chip')?.addEventListener('click', () => $('workspace-settings-open')?.click());
  $('welcome-project')?.addEventListener('click', () => $('new-project')?.click());
  $('welcome-history')?.addEventListener('click', () => $('history-search-open')?.click());
  $('welcome-commands')?.addEventListener('click',openQuickActions);
  $('welcome-tasks')?.addEventListener('click',()=>activateWorkspaceAction('open-coding'));
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === 'j' || event.shiftKey && event.key.toLowerCase() === 'p')) {event.preventDefault(); event.stopPropagation(); if (quick.open) closeQuickActions(); else openQuickActions(); return;}
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && !$('workspace-settings')?.hidden && $('workspace-settings')?.contains(document.activeElement)) {
      event.preventDefault(); event.stopPropagation(); closeSettings(); return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ',' && !$('rename-dialog')?.open) {event.preventDefault(); $('workspace-settings-open')?.click();}
  }, true);
  window.addEventListener('storage', event => {if (event.key === key || event.key === null) preferences.refresh();});
  window.addEventListener('workspace-extensions-closed', () => {if ($('workspace-settings')?.hidden) document.body.classList.remove('workspace-utility-open');});
  preferences.refresh();
})();
