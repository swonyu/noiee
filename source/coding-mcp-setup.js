(() => {
  'use strict';
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const exact = (v, keys) => object(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
  const text = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
  const id = v => typeof v === 'string' && /^[\w.-]{1,160}$/.test(v);
  const serverId = v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(v);
  const copy = v => JSON.parse(JSON.stringify(v));
  const finite = v => Number.isSafeInteger(v) && v >= 0;
  const executionMode = v => !Object.hasOwn(v,'executionMode') ? 'vm' : ['native','vm'].includes(v.executionMode) ? v.executionMode : null;
  const errors = Object.freeze({'expired':'Coding MCP setup expired; prepare and review again.','cancelled':'Coding MCP setup was cancelled.','setup-failed':'Coding MCP setup failed; retained status and evidence were preserved.','creation-unconfirmed':'Chat creation is unconfirmed. Inspect this setup; do not create or send again automatically.','closure-unconfirmed':'Owned connection or execution closure is unconfirmed; resources remain retained.'});
  function requestValue(v) {
    if (!(exact(v, 'cwd,provider,model,serverIds') || exact(v, 'cwd,provider,model,serverIds,executionMode')) || !executionMode(v) || !text(v.cwd) || !v.cwd.startsWith('/') || !['local','cloud'].includes(v.provider) || !text(v.model, 200) || !Array.isArray(v.serverIds) || v.serverIds.length < 1 || v.serverIds.length > 64 || v.serverIds.some(x => !serverId(x)) || new Set(v.serverIds).size !== v.serverIds.length) return null;
    return {cwd:v.cwd,provider:v.provider,model:v.model,executionMode:executionMode(v),serverIds:[...v.serverIds].sort()};
  }
  function status(v) {
    if (!exact(v, 'setupId,revision,expiresAt,phase,request,creation,root,cleanup,error') || !uuid(v.setupId) || !Number.isSafeInteger(v.revision) || v.revision < 0 || !(v.expiresAt === null || finite(v.expiresAt)) || !['preparing','prepared','committing','created','cancelled','failed'].includes(v.phase) || !requestValue(v.request) || !['not-started','unknown','confirmed'].includes(v.creation) || !['not-requested','pending','closed','unconfirmed'].includes(v.cleanup)) return null;
    if (v.error !== null && (!exact(v.error, 'code,message') || !Object.hasOwn(errors,v.error.code) || v.error.message !== errors[v.error.code])) return null;
    if (['preparing','prepared'].includes(v.phase) && v.creation !== 'not-started' || v.phase === 'created' && v.creation !== 'confirmed') return null;
    if (['preparing','prepared'].includes(v.phase) && v.expiresAt === null || ['committing','created'].includes(v.phase) && v.expiresAt !== null) return null;
    if (v.creation === 'confirmed') {
      const r = v.root, t = r?.thread;
      if (!exact(r, 'ownerId,generation,thread') || !uuid(r.ownerId) || !uuid(r.generation) || !(exact(t, 'id,cwd,model,modelProvider,createdAt,updatedAt,name,historyMode') || exact(t, 'id,cwd,model,modelProvider,createdAt,updatedAt,name,historyMode,executionMode')) || executionMode(t) !== executionMode(v.request) || !id(t.id) || t.cwd !== v.request.cwd || t.model !== v.request.model || t.modelProvider !== `saleh_${v.request.provider}` || ![t.createdAt,t.updatedAt].every(x => x === null || finite(x)) || !(t.name === null || typeof t.name === 'string' && t.name.length <= 2000 && !t.name.includes('\0')) || ![null,'legacy','paginated'].includes(t.historyMode)) return null;
    } else if (v.root !== null) return null;
    return {...copy(v),request:requestValue(v.request)};
  }
  function independent(body) {
    return exact(body, 'op,input') && body.op === 'codingMCP' && exact(body.input, 'action,setupId') && ['setupStatus','cancelSetup'].includes(body.input.action) && uuid(body.input.setupId);
  }
  function inventory(result) {
    if (!object(result) || !Array.isArray(result.servers) || result.servers.length > 128) throw Error('Configured provider inventory is unavailable or exceeds its display limit.');
    const seen = new Set(), rows = [];
    for (const row of result.servers) {
      if (!object(row) || !serverId(row.id) || seen.has(row.id)) throw Error('Configured provider inventory contains an invalid or duplicate ID.');
      seen.add(row.id);
      if (row.configRemoved === true) continue;
      rows.push({id:row.id,transport:row.transport === 'stdio' ? 'Local process' : row.transport === 'http' ? 'HTTP provider' : 'Provider transport reviewed by the app'});
    }
    return rows;
  }
  function summary(s) {
    if (!s) return 'Waiting for the original setup identity. No task creation is confirmed.';
    const phase = {preparing:'Preparing tool setup.',prepared:'Ready for native review.',committing:'Creating the task after native review.',created:'Task setup completed.',cancelled:'Setup cancelled.',failed:'Setup failed.'}[s.phase];
    const creation = s.creation === 'confirmed' ? `Task created: ${s.root.thread.name || s.root.thread.id}. No message was sent.` : s.creation === 'unknown' ? 'Task creation is unconfirmed. Inspect this setup; do not submit another.' : 'Task creation has not started.';
    const cleanup = {'not-requested':'Cleanup has not been requested.',pending:'Cleanup is still pending.',closed:'Setup resources are closed.',unconfirmed:'Cleanup is unconfirmed; resources may still be active.'}[s.cleanup];
    return `${phase} ${creation} ${cleanup}${s.error ? ` ${s.error.message}` : ''}`;
  }
  function create({request, getContext = () => ({}), changed = () => {}, recordRoot = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now()}) {
    let session = null, disposed = false, poll = null, sequence = 0;
    const stopPoll = () => {if (poll !== null) clearTimer(poll); poll = null;};
    const blocking = () => !!session && !session.localEnded && (session.cancelPending || session.reviewPending || session.cancelRequested && session.status?.cleanup !== 'closed' || !session.status || ['preparing','prepared','committing'].includes(session.status.phase) || session.status.creation === 'unknown' || ['pending','unconfirmed'].includes(session.status.cleanup));
    function view() {
      const s = session?.status || null;
      return {setupId:session?.setupId || null,status:s && copy(s),request:session?.request && copy(session.request),blocking:blocking(),invalidated:!!session?.invalidated,notice:session?.notice || '',summary:session?.localEnded ? 'Setup cancelled before it was dispatched. No task was created.' : summary(s),reviewing:!!session?.reviewPending,reading:!!session?.reading,cancelling:!!session?.cancelPending,canReview:!!s && s.phase === 'prepared' && !session.reviewSent && !session.invalidated && !session.reading && !disposed && (s.expiresAt === null || s.expiresAt > now()),canInspect:!!session?.setupId && !session.reading && !disposed,canCancel:!!session && !session.localEnded && !session.cancelPending && !disposed && (blocking() || s?.phase === 'created')};
    }
    const emit = () => {if (!disposed) changed(view());};
    function schedule() {
      stopPoll();
      if (disposed || !session?.setupId || session.invalidated || session.reading || session.pollPaused || !blocking()) return;
      if (session.polls >= 200) {session.pollPaused = true; session.notice = 'Automatic inspection paused. Use Inspect setup to check the original attempt.';emit();return;}
      poll = setTimer(() => {poll = null; void inspect(true);}, 1500);
    }
    function accept(value, token) {
      if (session !== token) return false;
      const next = status(value);
      if (!next || token.setupId && next.setupId !== token.setupId || next.request.provider !== token.request.provider || next.request.model !== token.request.model || next.request.executionMode !== token.request.executionMode || JSON.stringify(next.request.serverIds) !== JSON.stringify(token.request.serverIds) || token.status && next.request.cwd !== token.status.request.cwd) throw Error('Unverified setup status');
      if (token.status && next.revision <= token.status.revision) return false;
      const receipt = next.root && `${next.root.ownerId}/${next.root.generation}/${next.root.thread.id}`;
      const prior = token.status, phases = {preparing:0,prepared:1,committing:2,created:3,failed:4,cancelled:4};
      if (token.rootReceipt && token.rootReceipt !== receipt || prior?.creation === 'unknown' && next.creation === 'not-started' || prior && (phases[next.phase] < phases[prior.phase] || prior.cleanup !== 'not-requested' && next.cleanup === 'not-requested' || prior.cleanup === 'closed' && next.cleanup !== 'closed')) throw Error('Changed setup lifecycle evidence');
      token.setupId = next.setupId;token.status = next;token.notice = '';
      if (['committing','created','cancelled','failed'].includes(next.phase)) token.reviewPending = false;
      if (next.cleanup === 'closed') token.cancelPending = false;
      if (next.creation === 'confirmed') {
        if (!token.rootReceipt || next.phase === 'created' && !token.createdObserved) {
          const first = !token.rootReceipt;token.rootReceipt = receipt;
          const context = getContext(), origin = token.origin;
          const select = !disposed && !token.invalidated && next.phase === 'created' && context.epoch === origin.epoch && context.threadId === origin.threadId && context.draft === origin.draft;
          if (next.phase === 'created') token.createdObserved = true;
          if (first || select) Promise.resolve(recordRoot(copy(next.root), select)).catch(() => {if (session === token) {token.notice = 'The task was created, but opening its history failed. Select the recorded task to inspect it.';emit();}});
        }
      }
      emit();return true;
    }
    function timeout(token, note, relevant) {
      return setTimer(() => {if (session === token && relevant()) {token.notice = note;token.pollPaused = true;emit();}}, 8000);
    }
    async function prepare(input) {
      if (disposed || blocking()) return false;
      const clean = requestValue(input);if (!clean) throw Error('Choose a project, explicit model/provider, and one to 64 configured tools.');
      stopPoll();
      const token = {sequence:++sequence,request:clean,origin:copy(getContext()),setupId:null,status:null,reviewSent:false,invalidated:false,polls:0,reads:0,readSequence:0,dispatch:{cancelled:false},notice:''};session = token;emit();
      const timer = timeout(token, 'Setup identity has not arrived. Do not submit again; a late response will be inspected.', () => !token.setupId && !token.localEnded);
      try {
        const value = await request({op:'codingMCP',input:{action:'prepareStart',...copy(clean)}},token.dispatch);
        if (token.dispatch.cancelled && value?.cancelled === true) {token.localEnded = true;emit();return true;}
        accept(value,token);
        if (token.cancelRequested) await cancel();
      } catch {if (session === token) {token.notice = 'The setup identity could not be verified. No retry was sent. Keep this attempt visible and use Stop before reopening the workspace.';emit();}}
      finally {clearTimer(timer);schedule();}
      return true;
    }
    async function inspect(automatic = false) {
      const token = session;if (!token?.setupId || token.reading || disposed || automatic && token.invalidated) return false;
      if (token.reads >= 256) {token.pollPaused = true;token.notice = 'This page reached its inspection limit. No task was resubmitted. Use Stop before reopening the workspace.';emit();return false;}
      stopPoll();token.reading = true;token.reads++;const read = ++token.readSequence;if (automatic) token.polls++;else {token.pollPaused = false;token.polls = 0;}emit();
      const timer = setTimer(() => {if (session === token && token.readSequence === read) {token.readSequence++;token.reading = false;token.pollPaused = true;token.notice = 'Status inspection did not return. Use Inspect setup to read the original setup again; creation will not be resubmitted.';emit();}},8000);
      try {const result = await request({op:'codingMCP',input:{action:'setupStatus',setupId:token.setupId}});accept(result,token);}
      catch {if (token.readSequence === read) {token.pollPaused = true;token.notice = 'The original setup status could not be verified. Use Inspect setup to check it; no new setup or task was submitted.';}}
      finally {clearTimer(timer);if (token.readSequence === read) {token.reading = false;emit();schedule();}}
      return true;
    }
    async function review() {
      if (!view().canReview) return false;
      const token = session;token.reviewSent = true;token.reviewPending = true;token.reviewDispatch = {cancelled:false};emit();
      const timer = timeout(token, 'Review or creation has not returned. Inspect the original setup; do not create another task.', () => token.reviewPending);
      try {accept(await request({op:'codingMCP',input:{action:'reviewStart',setupId:token.setupId,revision:token.status.revision}},token.reviewDispatch),token);}
      catch {if (token.reviewPending) {token.pollPaused = true;token.notice = 'The review reply was lost or could not be verified. Inspect the original setup; review will not be resubmitted.';}}
      finally {clearTimer(timer);token.reviewPending = false;emit();schedule();}
      return true;
    }
    function invalidate() {
      stopPoll();const token = session;if (!token) return false;
      token.invalidated = true;token.dispatch.cancelled = true;if (token.reviewDispatch) token.reviewDispatch.cancelled = true;emit();return true;
    }
    async function cancel() {
      const token = session;if (!token) return false;
      token.cancelRequested = true;invalidate();
      if (!token.setupId || token.cancelPending) {emit();return false;}
      token.cancelPending = true;emit();
      const timer = timeout(token, 'Cancellation has not been confirmed. Inspect the original setup; already started work may still exist.', () => token.cancelPending && token.status?.cleanup !== 'closed');
      try {accept(await request({op:'codingMCP',input:{action:'cancelSetup',setupId:token.setupId}}),token);}
      catch {if (token.cancelPending && token.status?.cleanup !== 'closed') {token.pollPaused = true;token.notice = 'Cancellation could not be confirmed. Inspect the original setup; already started work may still exist.';}}
      finally {clearTimer(timer);token.cancelPending = false;emit();schedule();}
      return true;
    }
    function dispose() {disposed = true;invalidate();}
    return Object.freeze({prepare,review,inspect,invalidate,cancel,dispose,view});
  }
  globalThis.SalehCodingMCPSetup = Object.freeze({create,status,independent,inventory,requestValue,summary});
})();
