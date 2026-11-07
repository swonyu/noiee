(() => {
  'use strict';
  if (window.SalehExtensions) return;
  const LIMIT = 12800, DISPLAY_LIMIT = 200;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
  const bounded = (value, limit = 1000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit) : '';
  const bridge = () => window.webkit?.messageHandlers?.tools;
  const element = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, id, action) => {
    const node = element('button', text); node.type = 'button'; node.id = id;
    node.addEventListener('click', action); return node;
  };
  let panel, ui, epoch = 0, read = null, mutation = null, inventoryCurrent = false;
  let servers = [], tools = [], nextOffset = null, query = '', total = 0, catalogIncomplete = false, displayLimited = false;
  const native = body => {
    const target = bridge();
    if (!target || typeof target.postMessage !== 'function') return Promise.reject(new Error('Native connection management is unavailable.'));
    try {return Promise.resolve(target.postMessage(body));} catch (error) {return Promise.reject(error);}
  };
  const visible = () => !!panel && !panel.hidden;
  const current = token => visible() && token === epoch;
  const status = (message, state = 'ready') => {ui.status.textContent = message; ui.status.dataset.state = state;};
  function ensurePanel() {
    if (panel) return;
    panel = element('aside', '', 'workspace-extensions-panel'); panel.id = 'workspace-extensions-panel';
    panel.hidden = true; panel.setAttribute('aria-labelledby', 'workspace-extensions-title');
    const heading = element('div', '', 'workspace-extensions-header');
    const title = element('h2', 'Extensions'); title.id = 'workspace-extensions-title';
    const close = button('Close', 'workspace-extensions-close', closePanel);
    heading.append(title, close);
    const scope = element('p', 'Agent chat connections', 'workspace-extensions-scope');
    const capability = element('p', 'Connections here provide tools to Agent chat only. Coding tasks use separate per-task MCP setup where supported by the runtime. Project skill text can be previewed and inserted into a draft; engine-loaded skills remain unavailable.', 'muted');
    capability.id = 'workspace-extensions-capabilities';
    const prerequisites = element('p', 'Each service may require its own account, authorization, subscription or license. Only configured compatible MCP providers appear here. Connecting does not install plugins or make every service available.', 'muted');
    const policy = element('p', 'Connect opens the existing native review. Tools keep their existing action approvals. Disconnect revokes that connection’s routine-read grant; actions already sent may still have happened.', 'muted');
    const notice = element('p'); notice.id = 'workspace-extensions-status'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const refresh = button('Refresh inventory', 'workspace-extensions-refresh', () => refreshInventory());
    const actions = element('div', '', 'workspace-extensions-actions'); actions.append(refresh);
    const list = element('div'); list.id = 'workspace-extensions-servers';
    const label = element('label', 'Find connected tools'); label.setAttribute('for', 'workspace-extensions-query');
    const input = element('input'); input.id = 'workspace-extensions-query'; input.type = 'search'; input.maxLength = 500; input.placeholder = 'Search tool names and descriptions';
    const search = button('Search tools', 'workspace-extensions-search', () => searchCatalog());
    input.addEventListener('keydown', event => {if (event.key === 'Enter') {event.preventDefault(); if (!search.disabled) searchCatalog();}});
    const searchActions = element('div', '', 'workspace-extensions-actions'); searchActions.append(search);
    const count = element('p', '', 'muted'); count.id = 'workspace-extensions-count';
    const catalog = element('div', '', 'workspace-extension-tools'); catalog.id = 'workspace-extensions-tools';
    const more = button('Show more tools', 'workspace-extensions-more', () => searchCatalog(true)); more.hidden = true;
    const body = element('div', '', 'workspace-panel-body');
    let skillHost;
    if (document.body.classList.contains('workspace-coding')) {
      skillHost = element('section'); skillHost.id = 'coding-skills'; skillHost.setAttribute('aria-label', 'Selected task skills');
      body.append(element('p', 'Project discovery is limited to .agents/skills. Only an explicit Insert reviewed text action changes the task draft.', 'muted'), skillHost);
    }
    body.append(scope, capability, prerequisites, policy, notice, actions, element('h3', 'Configured providers'), list, element('h3', 'Connected tool catalog'), label, input, searchActions, count, catalog, more);
    panel.append(heading, body);
    panel.addEventListener('keydown', event => {if (event.key === 'Escape' && !event.defaultPrevented) {event.preventDefault(); event.stopPropagation(); closePanel();}});
    document.body.append(panel);
    if (skillHost) {
      if (globalThis.SalehCodingTaskSkills?.mount) globalThis.SalehCodingTaskSkills.mount(skillHost);
      else skillHost.textContent = 'Task skill preview is unavailable. Your draft is unchanged.';
    }
    ui = {close, status: notice, refresh, list, input, search, count, catalog, more};
  }
  function controls() {
    if (!ui) return;
    const unavailable = !bridge(), busy = !!read || !!mutation;
    ui.refresh.disabled = unavailable || busy;
    ui.input.disabled = unavailable || busy || !inventoryCurrent;
    ui.search.disabled = unavailable || busy || !inventoryCurrent;
    ui.more.disabled = unavailable || busy || !inventoryCurrent;
    for (const node of ui.list.querySelectorAll('button')) node.disabled = unavailable || busy || !inventoryCurrent;
    panel.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  function serverRows(result) {
    if (!record(result) || !Array.isArray(result.servers) || result.servers.length > 128) throw new Error('Provider inventory is invalid or exceeds its display limit.');
    const seen = new Set();
    return result.servers.map(row => {
      if (!record(row) || !identity(row.id) || seen.has(row.id) || typeof row.connected !== 'boolean') throw new Error('Provider inventory contains an invalid or duplicate entry.');
      seen.add(row.id);
      for (const key of ['configRemoved', 'configChanged', 'catalogRefreshing']) if (row[key] !== undefined && typeof row[key] !== 'boolean') throw new Error('Provider inventory contains an invalid status.');
      // Copy a small display allowlist. Never retain configHash, args, env, headers or configPath.
      let transport = 'Transport details unavailable';
      if (row.transport === 'stdio') transport = 'Local process';
      if (row.transport === 'http') {
        transport = 'HTTP provider';
        try {const url = new URL(row.url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) transport = `HTTP provider · ${url.protocol}//${url.host}`;} catch {}
      }
      return {id: row.id, connected: row.connected, configRemoved: !!row.configRemoved, configChanged: !!row.configChanged, catalogRefreshing: !!row.catalogRefreshing, reason: bounded(row.statusReason, 500), transport};
    });
  }
  function catalogPage(result, offset) {
    if (!record(result) || !Array.isArray(result.tools) || result.tools.length > 20 || !Number.isSafeInteger(result.total) || result.total < 0 || result.total > LIMIT) throw new Error('Tool catalog is invalid or exceeds its display limit.');
    const next = result.nextOffset ?? null;
    if (next !== null && (!Number.isSafeInteger(next) || next <= offset || next > result.total || next > LIMIT || next !== offset + result.tools.length)) throw new Error('Tool pagination did not advance safely.');
    if (offset + result.tools.length > result.total || typeof result.truncated !== 'boolean') throw new Error('Tool catalog count is invalid.');
    const seen = new Set();
    const rows = result.tools.map(tool => {
      if (!record(tool) || !identity(tool.server) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 256 || !record(tool.inputSchema)) throw new Error('Tool catalog contains an invalid entry.');
      const key = `${tool.server}\0${tool.name}`;
      if (seen.has(key)) throw new Error('Tool catalog contains duplicate entries.'); seen.add(key);
      let schema;
      try {schema = JSON.stringify(tool.inputSchema); if (schema.length > 16384) throw Error(); schema = JSON.stringify(tool.inputSchema, null, 2);} catch {throw new Error('Tool schema is invalid or exceeds its display limit.');}
      if (schema.length > 32768) schema = schema.slice(0, 32768) + '\n[Schema display clipped]';
      return {server: tool.server, name: bounded(tool.name, 256), description: bounded(tool.description, 4000), schema};
    });
    const states = new Map();
    if (result.servers !== undefined) {
      if (!Array.isArray(result.servers) || result.servers.length > 128) throw new Error('Tool provider status is invalid.');
      for (const row of result.servers) if (record(row) && identity(row.id) && ['ready', 'connected', 'not connected', 'connecting', 'verifying catalog', 'reconnect required', 'configuration changed; reconnect', 'configuration removed; disconnect'].includes(row.status)) states.set(row.id, row.status);
    }
    return {rows, next, total: result.total, incomplete: result.truncated, states};
  }
  function renderServers() {
    ui.list.replaceChildren();
    if (!servers.length) ui.list.append(element('p', inventoryCurrent ? 'No MCP providers are configured. Use Agent chat’s existing Tools setup to add a compatible provider.' : 'No current provider inventory is available.', 'muted'));
    for (const server of servers) {
      const row = element('section', '', 'workspace-extension-row'); row.dataset.server = server.id;
      let state = !inventoryCurrent ? 'Unconfirmed · refresh required' : server.configRemoved || server.catalogState === 'configuration removed; disconnect' ? 'Configuration removed · disconnect retained session' : server.configChanged || server.catalogState === 'configuration changed; reconnect' ? 'Configuration changed · disconnect before a new review' : server.reason ? 'Unavailable · ' + server.reason : server.catalogRefreshing || server.catalogState === 'verifying catalog' ? 'Verifying catalog' : server.catalogState === 'connecting' ? 'Connecting' : server.catalogState === 'reconnect required' ? 'Reconnect required' : server.connected ? 'Connected' : 'Not connected';
      if (mutation?.id === server.id) state = mutation.op === 'connect' ? 'Connecting · native review or connection pending' : 'Disconnecting · awaiting confirmation';
      row.append(element('strong', server.id), element('p', state), element('p', server.transport, 'workspace-extension-meta'));
      const disconnect = server.connected || server.configRemoved || ['connecting', 'configuration removed; disconnect', 'configuration changed; reconnect'].includes(server.catalogState);
      const op = disconnect ? 'disconnect' : 'connect';
      const action = button(disconnect ? 'Disconnect' : 'Review connection…', '', () => changeConnection(op, server.id));
      action.dataset.op = op; row.append(action);
      // A saved error can survive successful disconnection. The current protocol
      // cannot distinguish that from a failed retained session; offer both actions.
      if (!disconnect && (server.reason || server.configChanged || server.catalogState === 'reconnect required')) {
        const cleanup = button('Disconnect retained session', '', () => changeConnection('disconnect', server.id)); cleanup.dataset.op = 'disconnect'; row.append(cleanup);
      }
      ui.list.append(row);
    }
    controls();
  }
  function renderCatalog() {
    ui.catalog.replaceChildren();
    for (const tool of tools) {
      const item = element('details', '', 'workspace-extension-tool');
      const schema = element('pre', tool.schema); schema.tabIndex = 0;
      item.append(element('summary', `${tool.server} · ${tool.name}`), element('p', tool.description), schema); ui.catalog.append(item);
    }
    ui.count.textContent = inventoryCurrent ? `${total} matching connected tools · ${tools.length} shown${displayLimited ? ' · display limited to 200; narrow your search' : catalogIncomplete && nextOffset === null ? ' · provider catalog is incomplete' : ''}. Schemas are read-only; no tool runs here.` : 'Catalog state is unconfirmed. Refresh before relying on these entries.';
    if (inventoryCurrent && !tools.length) ui.catalog.append(element('p', query ? 'No connected tools match this search.' : 'No connected tools are available.', 'muted'));
    ui.more.hidden = nextOffset === null; controls();
  }
  async function refreshInventory(completion = null) {
    if (!visible() || read || mutation) return;
    if (!bridge()) {inventoryCurrent = false; status('Read-only view: native connection management is unavailable. Open the native app to inspect and manage configured providers.', 'unavailable'); renderServers(); renderCatalog(); return;}
    const token = epoch, request = {}; read = request; inventoryCurrent = false; controls(); status('Reading provider inventory…', 'loading');
    try {
      const rows = serverRows(await native({op: 'describe'})); if (!current(token)) return;
      const term = bounded(ui.input.value, 500).trim();
      const page = catalogPage(await native({op: 'catalog', query: term, offset: 0}), 0); if (!current(token)) return;
      servers = rows.map(row => {const state = page.states.get(row.id); return {...row, connected: ['ready', 'connected'].includes(state) ? true : state === 'not connected' ? false : row.connected, catalogState: state};});
      tools = page.rows; query = term; total = page.total; nextOffset = page.next; catalogIncomplete = page.incomplete; displayLimited = false; inventoryCurrent = true;
      if (completion?.cancelled) status('Connection request cancelled. Current inventory is shown below.', 'cancelled');
      else if (completion) {
        const row = servers.find(value => value.id === completion.id);
        const connected = row?.connected && !row.reason && !row.configRemoved && !row.configChanged && !row.catalogRefreshing && ['ready', 'connected'].includes(row.catalogState);
        const disconnected = !row || !row.connected && !row.configRemoved && !['connecting', 'verifying catalog', 'configuration removed; disconnect', 'configuration changed; reconnect'].includes(row.catalogState);
        const confirmed = completion.op === 'connect' ? connected : disconnected;
        status(confirmed ? `${completion.op === 'connect' ? 'Connected to' : 'Disconnected from'} ${completion.id}. Current inventory is shown below; service task success is not established.` : 'The connection response returned, but current inventory does not confirm the requested state. Inspect the provider status below.', confirmed ? 'ready' : 'unconfirmed');
      } else status(servers.length ? 'Inventory refreshed. Connection status does not establish that a service task succeeded.' : 'No MCP providers are configured.');
      renderServers(); renderCatalog();
    } catch (error) {
      if (current(token)) {inventoryCurrent = false; status(`Inventory could not be verified. ${bounded(error?.message, 600)} Refresh explicitly to try again.`, 'error'); renderServers(); renderCatalog();}
    } finally {if (read === request) {read = null; controls();}}
  }
  async function searchCatalog(more = false) {
    if (!visible() || !inventoryCurrent || read || mutation || !bridge() || more && nextOffset === null) return;
    const token = epoch, request = {}, offset = more ? nextOffset : 0, term = more ? query : bounded(ui.input.value, 500).trim(); read = request; controls();
    status('Reading connected tool catalog…', 'loading');
    try {
      const page = catalogPage(await native({op: 'catalog', query: term, offset}), offset); if (!current(token)) return;
      const combined = more ? [...tools, ...page.rows] : page.rows, seen = new Set();
      for (const row of combined) {const id = `${row.server}\0${row.name}`; if (seen.has(id)) throw new Error('Tool catalog changed during pagination. Search again from the first page.'); seen.add(id);}
      tools = combined.slice(0, DISPLAY_LIMIT); query = term; total = page.total; displayLimited = combined.length >= DISPLAY_LIMIT && page.next !== null;
      nextOffset = displayLimited ? null : page.next; catalogIncomplete = page.incomplete;
      status('Tool catalog read. No tool was executed.'); renderCatalog();
    } catch (error) {if (current(token)) {nextOffset = null; status(`Tool catalog could not be verified. ${bounded(error?.message, 600)}`, 'error'); renderCatalog();}}
    finally {if (read === request) {read = null; controls();}}
  }
  async function changeConnection(op, id) {
    if (!visible() || !inventoryCurrent || read || mutation || !bridge() || !identity(id) || !['connect', 'disconnect'].includes(op) || !servers.some(row => row.id === id)) return;
    const token = epoch, action = {op, id}; mutation = action; renderServers();
    status(op === 'connect' ? `Review the native connection request for ${id}.` : `Disconnecting ${id}; waiting for confirmation.`, op === 'connect' ? 'connecting' : 'disconnecting');
    let completion = null;
    try {
      const result = await native({op, id});
      if (!current(token)) return;
      if (!record(result)) throw new Error('Native connection response is invalid.');
      if (result.cancelled === true && !result.isError) completion = {cancelled: true};
      else {
        if (result.isError || result.server !== id || result.connected !== (op === 'connect')) throw new Error('Native response did not confirm the requested connection state.');
        completion = {op, id};
      }
    } catch (error) {
      if (current(token)) {inventoryCurrent = false; status(`Connection outcome is unconfirmed. ${bounded(error?.message, 600)} No automatic retry was made. Refresh to inspect it.`, 'unconfirmed');}
    } finally {
      if (mutation === action) mutation = null;
      if (current(token)) {renderServers(); renderCatalog(); if (completion) await refreshInventory(completion); else controls();}
      else if (visible()) {inventoryCurrent = false; status('A prior connection request has settled outside this view. Its outcome is unconfirmed here. Refresh to inspect it; no request was repeated.', 'unconfirmed'); renderServers(); renderCatalog();}
    }
  }
  function visibleFocusTarget(node) {
    if (!node?.isConnected || node.disabled || typeof node.focus !== 'function' || !node.getClientRects?.().length) return false;
    for (let parent = node; parent; parent = parent.parentNode) {
      if (parent.hidden || parent.inert || parent.getAttribute?.('inert') !== null && parent.getAttribute?.('inert') !== undefined) return false;
    }
    const style = window.getComputedStyle?.(node);
    return !style || style.visibility !== 'hidden' && style.visibility !== 'collapse';
  }
  function closePanel() {
    if (!visible()) return;
    globalThis.SalehCodingTaskSkills?.close();
    epoch++; read = null; inventoryCurrent = false; panel.hidden = true;
    const trigger = document.getElementById('workspace-extensions-open'); trigger?.setAttribute('aria-expanded', 'false');
    window.dispatchEvent(new CustomEvent('workspace-extensions-closed'));
    for (const id of ['workspace-extensions-open', 'sidebar-toggle', 'open-sidebar', 'prompt']) {
      const target = document.getElementById(id);
      if (visibleFocusTarget(target)) {target.focus(); break;}
    }
  }
  function openPanel() {
    ensurePanel();
    if (visible()) {ui.close.focus(); return;}
    panel.hidden = false; epoch++; read = null; inventoryCurrent = false;
    globalThis.SalehCodingTaskSkills?.open();
    document.getElementById('workspace-extensions-open')?.setAttribute('aria-expanded', 'true');
    renderServers(); renderCatalog(); ui.close.focus();
    if (mutation) {status('An earlier connection request is still pending. No new request will be sent. Refresh after it settles.', 'unconfirmed'); controls();}
    else refreshInventory();
  }
  function invalidate() {
    epoch++; read = null; inventoryCurrent = false; nextOffset = null;
    if (visible()) {status('Stop was requested. Connection and catalog state are unconfirmed until refreshed. No request was repeated.', 'unconfirmed'); renderServers(); renderCatalog();}
  }
  for (const name of ['agent-stopped', 'tools-stopped']) window.addEventListener(name, invalidate);
  window.addEventListener('tools-stop-result', () => {if (visible()) invalidate();});
  window.SalehExtensions = Object.freeze({open: openPanel, close: closePanel});
})();
