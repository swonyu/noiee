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
  globalThis.SalehWorkspaceState = Object.freeze({normalize, createStore, key});
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

  async function showToolAccess() {
    const status=$('tool-access-status'),recovery=$('tool-access-recovery'),chip=$('workspace-access-chip');
    if(!status||!recovery)return;
    try {
      const response=await fetch('/api/access',{cache:'no-store'}),value=await response.json();
      const held=value?.recoveryStartup??false;
      if(!response.ok||!['full','reviewed'].includes(value?.mode)||typeof value.managedChangesBlocked!=='boolean'||typeof held!=='boolean'||held&&(value.mode!=='full'||value.managedChangesBlocked)||value.mode==='full'&&!value.managedChangesBlocked&&!held)throw Error('Invalid access status');
      status.textContent=held?'Full Access · Recovery startup. Unrestricted tools are held; saved history, text chat and explicit recovery remain available.':value.mode==='full'?'Full Access · Operational tools run without app approval.':'Ask Before Tools · Tool actions follow native review. Approved routine reads can run automatically.';
      recovery.hidden=!value.managedChangesBlocked&&!held;
      if(held)recovery.textContent='Finish the retained recovery before releasing unrestricted tools. Canceling recovery startup in the app menu takes effect only after normal quit and relaunch.';
      if(chip){chip.textContent=held?'Full access · Recovery':value.mode==='full'?'Full access':'Ask before tools';chip.dataset.mode=value.mode;chip.title=status.textContent;}
    } catch {
      status.textContent='Current tool access could not be checked. Check the app window title for the running mode.';
      recovery.hidden=true;
      if(chip){chip.textContent='Check tool access';chip.dataset.mode='unknown';chip.title=status.textContent;}
    }
  }
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
  // Navigation only: existing controllers retain saving, admission and access checks.
  const quick = document.createElement('dialog'); quick.id = 'workspace-quick-dialog';
  quick.setAttribute('aria-labelledby', 'workspace-quick-title');
  quick.innerHTML = `<div class="workspace-quick-heading"><h2 id="workspace-quick-title">Quick actions</h2><button id="workspace-quick-close" type="button" aria-label="Close quick actions">×</button></div><label class="sr-only" for="workspace-quick-query">Find an action</label><input id="workspace-quick-query" type="search" placeholder="Go to…" autocomplete="off" spellcheck="false" maxlength="120"><div id="workspace-quick-results" aria-label="Actions"></div><p id="workspace-quick-empty" role="status" hidden>No actions found. Try search, settings, or history.</p><p class="workspace-quick-hint">↑ ↓ Navigate <span>↵ Open</span><span>Esc Close</span></p>`;
  document.body.append(quick);
  const quickActions = [
    ['New chat', 'Start a new chat in this workspace', 'new-chat'],
    ['Write a message', 'Return to the composer', 'prompt'],
    ['Search chats', 'Find a saved conversation', 'search'],
    ['Find in this chat', 'Find matching text in the current conversation', 'find-chat'],
    ['Settings', 'Models and workspace preferences', 'workspace-settings-open'],
    ['Extensions', 'Browse tools and skills', 'workspace-extensions-open'],
    ['Tools', 'Open connected tools and the tool catalog', 'open-tools'],
    ['Computer', 'Open computer controls', 'open-computer'],
    ['Context', 'Open working notes and attached context', 'toggle-context'],
    ['Search task history', 'Search saved messages across tasks', 'history-search-open'],
    ['Browse saved history', 'Read older turns in this task', 'browse-history'],
    ['Toggle changes', 'Inspect the current project changes', 'changes-toggle'],
    ['Toggle terminal', 'View the project terminal', 'terminal-toggle'],
    ['Open Tasks', 'Continue in your project workspace', 'open-coding'],
    ['Open Chat', 'Return to your conversations', 'back-chat'],
  ].filter(([, , id]) => $(id));
  function quickTarget(id) {
    const target = $(id);
    if (!target || target.disabled || dialogInert(target)) return null;
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (!dialogInert(ancestor)) continue;
      // Collapsed sidebar actions remain available through the palette.
      if (ancestor.id === 'sidebar' && ($('sidebar-toggle') || $('open-sidebar'))?.getAttribute('aria-expanded') === 'false') continue;
      return null;
    }
    return target;
  }
  function activateWorkspaceAction(id) {
    const target = quickTarget(id); if (!target) {renderQuickActions(); return;}
    closeQuickActions(false);
    if (id === 'search') {
      const toggle = $('sidebar-toggle') || $('open-sidebar');
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      target.focus();
    } else if (id === 'prompt') target.focus();
    else target.click();
  }
  function renderQuickActions() {
    const query = $('workspace-quick-query').value.trim().toLocaleLowerCase();
    const rows = quickActions.filter(([label, detail]) => `${label} ${detail}`.toLocaleLowerCase().includes(query));
    $('workspace-quick-results').replaceChildren(); $('workspace-quick-empty').hidden = rows.length > 0;
    for (const [label, detail, id] of rows) {
      const button = document.createElement('button'), title = document.createElement('strong'), hint = document.createElement('small');
      button.type = 'button'; button.disabled = !quickTarget(id); title.textContent = label; hint.textContent = detail; button.append(title, hint);
      button.onclick = () => activateWorkspaceAction(id);
      $('workspace-quick-results').append(button);
    }
  }
  function openQuickActions() {
    if (document.body.inert || document.querySelector('dialog[open]') || $('mcp-setup') && !$('mcp-setup').hidden) return;
    closeOtherPanels(); closeSettings(false); globalThis.SalehExtensions?.close();
    $('workspace-quick-query').value = ''; renderQuickActions(); openDialog(quick); $('workspace-quick-query').focus();
  }
  function closeQuickActions(restore=true) {closeDialog(quick, restore);}
  $('workspace-quick-open')?.addEventListener('click', openQuickActions);
  $('workspace-quick-close').onclick = () => closeQuickActions();
  $('workspace-quick-query').oninput = renderQuickActions;
  quick.addEventListener('cancel',event=>{event.preventDefault();closeQuickActions();});
  quick.addEventListener('keydown', event => {
    event.stopPropagation(); // Keep Chat shortcuts out; native Tab still works.
    if (event.isComposing) return;
    if (event.key === 'Escape') {event.preventDefault(); closeQuickActions(); return;}
    const buttons = [...$('workspace-quick-results').querySelectorAll('button:not(:disabled)')];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); const index = buttons.indexOf(document.activeElement), next = event.key === 'ArrowDown' ? index + 1 : index < 0 ? buttons.length - 1 : index - 1;
      buttons[(next + buttons.length) % buttons.length]?.focus();
    } else if (event.key === 'Enter' && document.activeElement === $('workspace-quick-query')) {event.preventDefault(); buttons[0]?.click();}
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
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'j') {event.preventDefault(); event.stopPropagation(); if (quick.open) closeQuickActions(); else openQuickActions(); return;}
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
