/* Explicit, task-scoped SKILL.md inventory and text preview. No automatic execution. */
(() => {
  'use strict';
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const plain = (value, max, empty = false) => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  const identity = value => plain(value, 200) && /^[A-Za-z0-9_.:-]+$/.test(value);
  const bounded = value => String(value?.message || value || 'The request could not be confirmed.').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500);
  const same = (a, b) => !!a && !!b && a.threadId === b.threadId && a.cwd === b.cwd;
  const fields = ['id', 'name', 'description', 'path', 'bytes', 'sha256'];
  function skill(value) {
    if (!object(value) || !identity(value.id) || !plain(value.name, 200) || !plain(value.description, 2000, true) || !plain(value.path, 4096) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 65536 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error('Skill metadata is invalid or exceeds its limits.');
    return Object.freeze(Object.fromEntries(fields.map(key => [key, value[key]])));
  }
  function create({host, native, getContext, onInsert} = {}) {
    const document = host?.ownerDocument;
    if (!host || !document || typeof document.createElement !== 'function' || typeof host.replaceChildren !== 'function') throw new TypeError('A skill panel host is required.');
    const element = (tag, text = '', className = '') => {const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node;};
    const button = (text, action, handler) => {const node = element('button', text); node.type = 'button'; node.dataset.action = action; node.addEventListener('click', handler); return node;};
    let epoch = 0, open = true, pending = null, inventory = null, reviewed = null, inserted = false, notice = 'Refresh skills to inspect this task’s project.', noticeState = 'idle';
    const context = () => {
      let value; try {value = typeof getContext === 'function' ? getContext() : null;} catch {return null;}
      if (!object(value) || !identity(value.threadId) || !plain(value.cwd, 4096) || !value.cwd.startsWith('/')) return null;
      return {threadId: value.threadId, cwd: value.cwd, canInsert: value.canInsert === true, busy: value.busy === true, unavailableReason: typeof value.unavailableReason === 'string' && value.unavailableReason.trim() ? bounded(value.unavailableReason) : ''};
    };
    const current = token => open && token.epoch === epoch && same(token.scope, context());
    const status = (text, state = 'ready') => {notice = text; noticeState = state;};
    const responseScope = (value, scope) => {
      if (!object(value) || value.isError || value.cancelled || !same(value, scope) || !identity(value.inventoryId)) throw Error('Skill response scope is invalid or does not match this task.');
    };
    const start = scope => {const token = {epoch: ++epoch, scope}; pending = token; return token;};
    function render() {
      const scope = context(), unavailable = typeof native !== 'function', busy = !!pending || !!scope?.busy;
      const title = element('h3', 'This task’s skills');
      const explanation = element('p', 'Review a SKILL.md text snapshot, then explicitly insert it into this task’s draft. Relative resources are not bundled. Normal project tools and approvals still apply.', 'muted');
      const state = element('p', !scope ? 'Choose a task with a project to inspect skills.' : unavailable ? 'Native skill discovery is unavailable.' : notice);
      state.dataset.state = !scope || unavailable ? 'unavailable' : noticeState; state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
      const refresh = button('Refresh skills', 'refresh', refreshInventory); refresh.disabled = !open || !scope || unavailable || busy;
      const actions = element('div', '', 'workspace-extensions-actions'); actions.append(refresh);
      const nodes = [title, explanation, state, actions];
      if (scope?.unavailableReason) nodes.push(element('p', scope.unavailableReason, 'muted'));
      if (inventory && same(inventory, scope)) {
        nodes.push(element('p', `${inventory.skills.length} skill${inventory.skills.length === 1 ? '' : 's'} found${inventory.truncated || inventory.issues.length ? ' · inventory incomplete; inspect the issues below' : ''}.`, 'muted'));
        for (const issue of inventory.issues) nodes.push(element('p', issue, 'workspace-extension-meta'));
        if (!inventory.skills.length) nodes.push(element('p', 'No project skills were found in this inventory.', 'muted'));
        for (const entry of inventory.skills) {
          const row = element('section', '', 'workspace-extension-row'); row.dataset.skillId = entry.id;
          const preview = button('Preview', 'preview', () => previewSkill(entry)); preview.disabled = !open || busy || unavailable;
          row.append(element('strong', entry.name), element('p', entry.description), element('p', `${entry.path} · ${entry.bytes} bytes`, 'workspace-extension-meta'), preview); nodes.push(row);
        }
      }
      if (reviewed && same(reviewed, scope)) {
        const preview = element('section', '', 'workspace-extension-row');
        preview.append(element('h4', `Reviewed text · ${reviewed.name}`), element('p', `${reviewed.path} · revision ${reviewed.sha256.slice(0, 12)}`, 'workspace-extension-meta'));
        const text = element('pre', reviewed.text); text.tabIndex = 0; text.setAttribute('aria-label', `${reviewed.name} SKILL.md text`); preview.append(text);
        const insert = button('Insert reviewed text', 'insert', insertReviewed); insert.disabled = !open || busy || inserted || !scope.canInsert || typeof onInsert !== 'function'; preview.append(insert);
        if (typeof onInsert !== 'function') preview.append(element('p', 'Draft insertion is unavailable in this view.', 'muted'));
        else if (!scope.canInsert && !scope.unavailableReason) preview.append(element('p', 'This task cannot accept draft text right now.', 'muted'));
        preview.append(element('p', 'This inserts reviewed text only. It does not load an engine skill, send a message, or run tools.', 'muted')); nodes.push(preview);
      }
      host.setAttribute('aria-busy', pending ? 'true' : 'false'); host.replaceChildren(...nodes);
    }
    async function refreshInventory() {
      const scope = context(); if (!open || !scope || scope.busy || pending || typeof native !== 'function') {render(); return;}
      const token = start(scope); inventory = null; reviewed = null; inserted = false; status('Reading project skill inventory…', 'loading'); render();
      try {
        const result = await native({op: 'codingSkills', input: {action: 'list', threadId: scope.threadId}}); if (!current(token)) return;
        responseScope(result, scope);
        if (!Array.isArray(result.skills) || result.skills.length > 128 || !Array.isArray(result.issues) || result.issues.length > 130 || typeof result.truncated !== 'boolean') throw Error('Skill inventory is invalid or exceeds its limits.');
        const seen = new Set(), skills = result.skills.map(value => {const entry = skill(value); if (seen.has(entry.id)) throw Error('Skill inventory contains duplicate identities.'); seen.add(entry.id); return entry;});
        const issues = result.issues.map(value => {
          if (plain(value, 500)) return value;
          if (object(value) && plain(value.path, 4096, true) && plain(value.message, 500)) return `${value.path ? value.path + ': ' : ''}${value.message}`.slice(0, 1000);
          throw Error('Skill inventory contains an invalid issue.');
        });
        inventory = Object.freeze({...scope, inventoryId: result.inventoryId, skills: Object.freeze(skills), issues: Object.freeze(issues), truncated: result.truncated});
        status('Inventory read. Select Preview to inspect exact skill text. No skill has been inserted or loaded.');
      } catch (error) {if (current(token)) {inventory = null; reviewed = null; status(`Skill inventory could not be verified. ${bounded(error)} Refresh explicitly to try again.`, 'error');}}
      finally {if (pending === token) {pending = null; render();}}
    }
    async function previewSkill(entry) {
      const scope = context(); if (!open || !scope || scope.busy || pending || typeof native !== 'function' || !inventory || !same(inventory, scope) || !inventory.skills.includes(entry)) {render(); return;}
      const selectedInventory = inventory, token = start(scope); reviewed = null; inserted = false; status(`Reading ${entry.name} for review…`, 'loading'); render();
      try {
        const result = await native({op: 'codingSkills', input: {action: 'preview', threadId: scope.threadId, inventoryId: selectedInventory.inventoryId, skillId: entry.id}}); if (!current(token)) return;
        responseScope(result, scope); const returned = skill(result);
        if (result.inventoryId !== selectedInventory.inventoryId || fields.some(key => returned[key] !== entry[key])) throw Error('Skill metadata changed or does not match the reviewed inventory.');
        if (typeof result.text !== 'string' || result.text.length > 65536 || typeof TextEncoder !== 'function') throw Error('Skill preview text or UTF-8 verification is unavailable.');
        const bytes = new TextEncoder().encode(result.text);
        if (bytes.length !== entry.bytes) throw Error('Skill preview text is invalid or its byte count changed.');
        if (typeof globalThis.crypto?.subtle?.digest !== 'function') throw Error('Skill text integrity verification is unavailable in this view.');
        const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes); if (!current(token)) return;
        const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        if (sha256 !== entry.sha256) throw Error('Skill preview content changed or does not match its reported revision.');
        reviewed = Object.freeze({threadId: scope.threadId, cwd: scope.cwd, inventoryId: selectedInventory.inventoryId, skillId: entry.id, name: entry.name, description: entry.description, path: entry.path, bytes: entry.bytes, sha256: entry.sha256, text: result.text});
        status('Text previewed. Insert reviewed text explicitly to add this snapshot to the draft.');
      } catch (error) {if (current(token)) {reviewed = null; inventory = null; status(`Skill preview could not be verified. ${bounded(error)} Refresh the inventory before trying again.`, 'error');}}
      finally {if (pending === token) {pending = null; render();}}
    }
    async function insertReviewed() {
      const scope = context();
      if (!open || !scope || scope.busy || !scope.canInsert || pending || inserted || !reviewed || !same(reviewed, scope) || typeof onInsert !== 'function') {render(); return;}
      const snapshot = reviewed, token = start(scope); status('Inserting reviewed text into the draft…', 'inserting'); render();
      try {
        const result = await onInsert(snapshot); if (!current(token)) return;
        if (!object(result) || result.inserted !== true) throw Error('Draft insertion was not confirmed.');
        inserted = true; status('Inserted reviewed text into this task’s draft. No message was sent and no engine skill was loaded.', 'inserted');
      } catch (error) {if (current(token)) {inserted = true; status(`Text insertion is unconfirmed. ${bounded(error)} Inspect the draft before choosing Preview again; no automatic retry was made.`, 'unconfirmed');}}
      finally {if (pending === token) {pending = null; render();}}
    }
    function invalidate(kind) {
      epoch++; pending = null; inventory = null; reviewed = null; inserted = false; open = kind !== 'close';
      status(kind === 'stop' ? 'Stop was requested. Refresh skills explicitly before reviewing or inserting another snapshot.' : 'Refresh skills to inspect this task’s project.', kind === 'stop' ? 'unconfirmed' : 'idle'); render();
    }
    render();
    return Object.freeze({change: () => invalidate('change'), close: () => invalidate('close'), stop: () => invalidate('stop')});
  }
  globalThis.SalehCodingSkills = Object.freeze({create});
})();
