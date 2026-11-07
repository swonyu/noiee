// MODEL PICKER HELPERS BEGIN
const LOCAL_MODEL_DEFAULT_KEY=globalThis.NoieeModelPicker.DEFAULT_KEY;
const LEGACY_LOCAL_MODEL=globalThis.NoieeModelPolicy.DEFAULT_LOCAL_MODEL;
const DEFAULT_LOCAL_MODEL=LEGACY_LOCAL_MODEL;
const {savedDefault,modelDefault,catalogDefault,modelEligibility,modelOptions,connectionState,capabilityOverview}=globalThis.NoieeModelPicker.bind(localStorage);
// MODEL PICKER HELPERS END

function codingCommandOutcome(item, turn) {
  const integer = Number.isSafeInteger(item.exitCode), recorded = integer ? ` · recorded exit ${item.exitCode}` : '';
  // ponytail: scan this bounded saved turn; index receipts if transcript size makes it costly.
  if (typeof item.id === 'string' && item.id && turn.items.some(other => other?.type === 'commandExecution' && other.id === item.id && ['command', 'cwd', 'status', 'exitCode'].some(key => other[key] !== item[key]))) return (['failed', 'interrupted', 'cancelled', 'declined'].includes(item.status) ? item.status + ' · ' : '') + 'conflicting receipts' + recorded;
  const unavailable = item.exitCode != null && !integer ? ' · exit unavailable' : '';
  if (item.status === 'failed') return 'failed' + recorded + unavailable + (item.exitCode === 0 ? ' · conflicting status/exit' : '');
  if (['interrupted', 'cancelled', 'declined'].includes(item.status)) return item.status + recorded + unavailable;
  if (unavailable) return 'outcome unavailable';
  if (item.status === 'completed') return integer ? `exited ${item.exitCode}` : 'exit unavailable';
  if (item.status === 'inProgress') return integer ? 'conflicting status' + recorded : 'no final result recorded';
  return 'outcome unavailable' + recorded;
}

// Receipts describe command execution, not task correctness. Neither command names,
// model prose nor item order establish test coverage or the source revision checked.
function codingVerificationSummary(turn, context = {}) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const counts = {zero: 0, failed: 0, pending: 0, unknown: 0};
  let incomplete = !Array.isArray(turn?.items) || !!context.historyIncomplete || !!context.updatesInterrupted;
  let interrupted = turn?.status === 'interrupted', changed = !!turn?.diff;
  const commands = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') {incomplete = true; continue;}
    if (item.truncated) incomplete = true;
    if (item.type === 'fileChange') changed = true;
    if (item.type !== 'commandExecution') continue;
    if (typeof item.id !== 'string' || !item.id) {incomplete = true; counts.unknown++; continue;}
    const group = commands.get(item.id) || []; group.push(item); commands.set(item.id, group);
  }
  for (const group of commands.values()) {
    const first = group[0];
    const conflict = group.some(item => ['command', 'cwd', 'status', 'exitCode'].some(key => item[key] !== first[key]));
    const valid = typeof first.command === 'string' && !!first.command.trim() && typeof first.cwd === 'string' && !!first.cwd;
    if (conflict || !valid) incomplete = true;
    // Keep an explicit failure even when another receipt with the same ID conflicts.
    if (group.some(item => item.status === 'failed' || item.status === 'completed' && Number.isSafeInteger(item.exitCode) && item.exitCode !== 0)) {counts.failed++; continue;}
    if (conflict || !valid) {counts.unknown++; continue;}
    if (first.status === 'completed' && first.exitCode === 0) counts.zero++;
    else if (first.status === 'inProgress' && first.exitCode == null) counts.pending++;
    else if (['interrupted', 'cancelled'].includes(first.status)) {interrupted = true; counts.unknown++;}
    else {incomplete = true; counts.unknown++;}
  }
  if (!['inProgress', 'completed', 'interrupted'].includes(turn?.status)) incomplete = true;
  if (counts.pending && turn?.status !== 'inProgress') interrupted = true;
  const state = counts.failed ? 'failed' : interrupted ? 'interrupted' : incomplete ? 'incomplete' : turn?.status === 'inProgress' ? 'pending' : !commands.size ? 'missing' : 'unconfirmed';
  const detail = [];
  if (counts.failed) detail.push(`${counts.failed} command failure${counts.failed === 1 ? '' : 's'} recorded. Review the command receipts.`);
  if (interrupted) detail.push(turn?.status === 'interrupted' ? 'The turn was interrupted; verification is incomplete.' : 'A command has no confirmed final result. It may have finished after this receipt.');
  if (incomplete) detail.push('Evidence is incomplete or unavailable. Refresh history and review the receipts.');
  if (turn?.status === 'inProgress') detail.push('Work is still in progress.');
  if (counts.zero) detail.push(`${counts.zero} command${counts.zero === 1 ? '' : 's'} exited 0. Check coverage and source freshness are unconfirmed.`);
  if (!commands.size && !counts.unknown) detail.push(items.some(item => item?.type === 'subAgentActivity') ? 'No direct command results are recorded in this chat. Review delegated results in the agent chats.' : 'No command results are recorded.');
  if (changed) detail.push('File-change activity or a diff is recorded; source freshness is unconfirmed. Rerun relevant checks before relying on this result.');
  return {state, counts, detail: detail.join(' ')};
}

// CODING RESULT PRESENTATION BEGIN
// Presentation reads only explicit saved markers. It never changes turn state,
// establishes verification, or guesses inheritance from matching message text.
function codingOwnResultTurns(thread) {
  return (Array.isArray(thread?.turns) ? thread.turns : []).filter(turn => turn?.status !== 'inheritedStopped');
}
function codingExecutionLabel(turn) {
  return ({inProgress:'Working…', completed:turn?.id ? 'Turn finished' : 'Activity finished',
    interrupted:'Stopped', failed:'Error', inheritedStopped:'Inherited parent context'}[turn?.status] || 'Status unavailable') +
    (turn?.status !== 'inheritedStopped' && turn?.error?.message ? ` · ${turn.error.message}` : '');
}
function codingCommandCounts(counts) {
  const parts = [];
  if (counts.zero) parts.push(`${counts.zero} exited 0`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.pending) parts.push(`${counts.pending} awaiting a final result`);
  if (counts.unknown) parts.push(`${counts.unknown} unknown or conflicting`);
  return parts.length ? `Command receipts: ${parts.join(' · ')}.` : 'No command receipts in this turn.';
}
function codingChildResult(thread, context = {}) {
  const own = codingOwnResultTurns(thread), last = own.at(-1);
  const incomplete = !!(thread?.historyTruncated || thread?.historyWarning || thread?.verificationGap || context.updatesInterrupted);
  const pending = !!(thread?.metadataPending || context.historyPending);
  const status = thread?.draftReadError ? 'History unavailable · refresh to check' : pending ? 'Loading agent history…' :
    context.stopping ? 'Stopping…' : thread?.localStopped ? 'Stop requested · checking state' :
    context.waiting ? 'Waiting for review' : context.working ? 'Working…' :
    last ? codingExecutionLabel(last) : 'No agent result recorded';
  const evidence = last ? codingVerificationSummary(last, {historyIncomplete:incomplete,updatesInterrupted:context.updatesInterrupted}) : null;
  const report = !pending && !thread?.draftReadError && Array.isArray(last?.items) ?
    last.items.findLast(item => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim())?.text || '' : '';
  let preview = report.slice(0,400);
  const lastUnit = preview.charCodeAt(preview.length - 1);
  if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) preview = preview.slice(0,-1);
  return {status, turnId:last?.id || null, inheritedCount:(thread?.turns?.length || 0) - own.length,
    receiptSummary:evidence ? codingCommandCounts(evidence.counts) : 'Inherited context is separate from this agent’s result.',
    report:report.length > 400 ? preview + '…' : report,
    reportTruncated:report.length > 400, incomplete,
    verification:'Verification: not established'};
}
const CODING_RETAINED_STARTUP_WARNING = 'Some task startups remain incomplete. Their history is unavailable; verified saved chats are listed.';
function codingStartupRecovery(owners, warning = '', selectedId = '', rootId = '') {
  const retained = new Map();
  for (const row of Array.isArray(owners) ? owners : []) {
    if (row?.state === 'creating' && typeof row.id === 'string' && row.id) retained.set(row.id, row);
  }
  const count = retained.size, retainedWarning = warning === CODING_RETAINED_STARTUP_WARNING;
  const relevant = [...retained.values()].some(row => typeof row.rootThreadId === 'string' &&
    !!row.rootThreadId && [selectedId,rootId].includes(row.rootThreadId));
  return {visible:count > 0 || retainedWarning,count:count || null,relevant,
    summary:count ? `${count} incomplete task startup${count === 1 ? '' : 's'}` : 'Incomplete task startups · count unavailable',
    // Unknown history warnings remain in the live banner verbatim.
    historyWarning:retainedWarning ? '' : warning};
}
// CODING RESULT PRESENTATION END

// REPEATED COMMAND NOTICE BEGIN
// Equality/threshold principle adapted from OpenCode 014614d35b397775e5d397a490fc72368c894ec2,
// packages/opencode/src/session/processor.ts:331-380 (MIT; see THIRD-PARTY-NOTICES.txt).
// This describes retained receipts only. It never determines progress or controls execution.
function codingRepeatedCommandNotice(thread, turn, context = {}) {
  if (!thread || typeof thread.id !== 'string' || !thread.id || context.selectedThreadId !== thread.id ||
      thread.metadataPending || thread.historyReadPending || thread.draftReadError || context.historyPending ||
      thread.historyTruncated || thread.historyWarning || thread.verificationGap || context.updatesInterrupted ||
      thread.parentThreadId || thread.source?.subAgent || thread.canAcceptDirectInput === false ||
      thread.rootThreadId && thread.rootThreadId !== thread.id) return null;
  if (!turn || typeof turn.id !== 'string' || !turn.id || !Array.isArray(thread.turns) ||
      thread.turns.filter(value => value?.id === turn.id).length !== 1 || !thread.turns.includes(turn) ||
      turn.threadId !== undefined && turn.threadId !== thread.id ||
      turn.itemsView !== undefined && turn.itemsView !== 'full' ||
      !['inProgress', 'completed', 'interrupted'].includes(turn.status) || !Array.isArray(turn.items)) return null;
  const seen = new Map(); let streak = [];
  for (const item of turn.items) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.type !== 'string' || item.truncated ||
        item.threadId !== undefined && item.threadId !== thread.id || item.turnId !== undefined && item.turnId !== turn.id) return null;
    // Recovery inserts missing receipts together; their original action order is not established.
    if (item.type === 'commandExecution' && item.receiptSource === 'persistedToolOutput') return null;
    const previous = seen.get(item.id);
    if (previous) {
      if (item.type !== 'commandExecution' || previous.type !== item.type ||
          ['command', 'cwd', 'status', 'exitCode', 'source', 'receiptSource'].some(key => previous[key] !== item[key])) return null;
      continue; // Replayed updates are not distinct command actions.
    }
    seen.set(item.id, item);
    if (item.type === 'agentMessage' && typeof item.text === 'string' ||
        item.type === 'reasoning' && (item.summary === undefined || Array.isArray(item.summary) && item.summary.every(part => typeof part === 'string')) && (item.content === undefined || Array.isArray(item.content) && item.content.every(part => typeof part === 'string'))) continue;
    const complete = item.type === 'commandExecution' && item.status === 'completed' &&
      typeof item.command === 'string' && !!item.command.trim() && !item.command.includes('\0') &&
      typeof item.cwd === 'string' && item.cwd.startsWith('/') && !item.cwd.includes('\0') &&
      Number.isInteger(item.exitCode) && item.exitCode >= -2147483648 && item.exitCode <= 2147483647 &&
      Array.isArray(item.commandActions) && (item.aggregatedOutput == null || typeof item.aggregatedOutput === 'string') &&
      (item.source === undefined || item.source === 'agent') && item.receiptSource === undefined;
    if (!complete) {streak = []; continue;}
    const last = streak.at(-1);
    if (last && last.command === item.command && last.cwd === item.cwd) streak.push(item); else streak = [item];
  }
  return streak.length >= 3 ? {count: streak.length, itemIds: streak.map(item => item.id)} : null;
}
// REPEATED COMMAND NOTICE END

// METRICS ADAPTER START
// Reads replace observations; sequence numbers order delivery, not token counts.
function codingReplaceMetrics(thread, snapshot, envelope = {}, sequence = -1) {
  for (const key of ['tokenUsage', 'tokenUsageTurnId', 'tokenUsageProvenance']) {
    delete thread[key];
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) thread[key] = structuredClone(snapshot[key]);
  }
  thread.tokenUsageWarning = typeof envelope.tokenUsageWarning === 'string' ? envelope.tokenUsageWarning.slice(0, 500) : '';
  thread.tokenUsageTruncated = envelope.tokenUsageTruncated === true;
  thread.tokenUsageInterrupted = false;
  thread.tokenUsageSequence = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : -1;
}
function codingApplyUsageEvent(thread, params, sequence) {
  if (!thread || params.threadId !== thread.id || !Number.isSafeInteger(sequence) || sequence < 0 || sequence <= (thread.tokenUsageSequence ?? -1)) return false;
  // Omission in a newer observation is unknown, never permission to reuse older fields.
  for (const [field, key] of [['tokenUsage', 'tokenUsage'], ['tokenUsageTurnId', 'turnId'], ['tokenUsageProvenance', 'tokenUsageProvenance']]) {
    delete thread[field];
    if (Object.prototype.hasOwnProperty.call(params, key)) thread[field] = structuredClone(params[key]);
  }
  thread.tokenUsageSequence = sequence;
  thread.tokenUsageInterrupted = false;
  return true;
}
function codingMetricsInput(thread, updatesInterrupted = false) {
  const last = Array.isArray(thread?.turns) ? thread.turns.at(-1) : undefined;
  const provenance = thread?.tokenUsageProvenance, hasUsage = thread?.tokenUsage != null;
  const cached = provenance?.cached === true;
  const mismatch = hasUsage && (!last?.id || thread.tokenUsageTurnId !== last.id);
  const gap = !!(updatesInterrupted || thread?.tokenUsageInterrupted || thread?.verificationGap || thread?.historyWarning);
  const notices = [];
  if (cached) notices.push('Usage was restored from an earlier engine observation.');
  if (mismatch) notices.push('This usage snapshot does not describe the latest turn. Thread totals may be out of date.');
  if (gap) notices.push('Live updates or saved history are incomplete. Refresh task state to check these details.');
  if (thread?.tokenUsageWarning) notices.push(thread.tokenUsageWarning);
  if (thread?.tokenUsageTruncated) notices.push('Saved usage history was truncated; some observations may be unavailable.');
  return {reportedTurn: last, tokenUsage: thread?.tokenUsage,
    provenance: hasUsage ? {source: provenance?.source === 'engine-notification' ? 'Engine notification' : 'Source not reported',
      session: cached ? 'Earlier engine observation' : provenance?.session && provenance.cached === false ? 'Current engine session' : 'Session not reported'} : {},
    stale: hasUsage && (cached || mismatch || gap || provenance?.cached !== false),
    incomplete: !!(gap || thread?.historyTruncated || thread?.tokenUsageWarning || thread?.tokenUsageTruncated), notices};
}
// METRICS ADAPTER END

// SKILL DRAFT START
function codingSkillDraft(draft, skill) {
  const label = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
  if (typeof draft !== 'string' || !skill || !label(skill.name) || skill.name.length > 200 ||
      !label(skill.path) || !skill.path.startsWith('/') || skill.path.length > 4096 ||
      typeof skill.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(skill.sha256) ||
      typeof skill.text !== 'string' || !skill.text || skill.text.includes('\0')) throw Error('Invalid reviewed skill snapshot. Refresh its preview.');
  const longest = Math.max(2, ...(skill.text.match(/`+/g) || []).map(value => value.length));
  if (longest > 64) throw Error('Invalid Markdown fence in reviewed skill text.');
  const fence = '`'.repeat(longest + 1);
  const context = `Selected project skill text: ${skill.name}\nSource: ${skill.path}\nSHA-256: ${skill.sha256}\nApply this reviewed text within the existing task and tool permissions. Referenced resources are not bundled; do not claim they were read or run.\n${fence}markdown\n${skill.text}\n${fence}`;
  const result = draft + (draft ? '\n\n' : '') + context;
  if (result.length > 20000) throw Error('The draft and reviewed skill text exceed the 20000-character message limit. Shorten the draft or use a smaller skill; nothing was inserted.');
  return result;
}
// SKILL DRAFT END

// MCP OUTCOMES HELPERS BEGIN
function codingMCPOutcomesIndependent(body) {
  return !!body && Object.keys(body).length === 2 && body.op === 'coding' && !!body.input && Object.keys(body.input).length === 2 && body.input.action === 'mcpOutcomes' && typeof body.input.threadId === 'string' && /^[\w.-]{1,160}$/.test(body.input.threadId);
}
function codingMCPOutcomeSnapshot(value, threadId) {
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
  const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const time = v => Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000;
  const invalid = () => {throw Error('Saved MCP outcomes could not be validated for this task.');};
  if (!text(threadId, 160) || value?.threadId !== threadId) invalid();
  if (exact(value, 'threadId,available') && value.available === false) return {threadId, available:false};
  if (!exact(value, 'threadId,available,ownerId,storeId,revision,blocked,warning,cached,complete,records') || value.available !== true || !uuid(value.ownerId) || !(uuid(value.storeId) || value.storeId === null) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !['blocked','cached','complete'].every(key => typeof value[key] === 'boolean') || typeof value.warning !== 'string' || value.warning.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.warning) || !Array.isArray(value.records) || value.records.length > 256) invalid();
  if (value.storeId === null && (value.revision !== 0 || !value.blocked || value.complete || value.cached || value.records.length) || !value.complete && !value.warning) invalid();
  const seen = new Set();
  for (const row of value.records) {
    if (!exact(row, 'attemptId,ownerGeneration,processGeneration,threadId,turnId,callId,rpcId,server,name,createdAt,intendedAt,providerAt,deliveryAt,provider,delivery,reason,persistence') || !uuid(row.attemptId) || seen.has(row.attemptId) || row.threadId !== threadId || !['ownerGeneration','processGeneration','turnId','callId'].every(key => text(row[key],160)) || !(text(row.rpcId,160) || Number.isSafeInteger(row.rpcId)) || !text(row.server,100) || !text(row.name,256) || !time(row.createdAt) || !['intendedAt','providerAt','deliveryAt'].every(key => row[key] === null || time(row[key])) || !['returned_ok','returned_error','unsupported','unknown','not_sent'].includes(row.provider) || !['written','failed','withheld','unknown'].includes(row.delivery) || !['durable','unconfirmed'].includes(row.persistence)) invalid();
    if (row.intendedAt === null ? !(row.provider === 'not_sent' || row.provider === 'unknown' && row.persistence === 'unconfirmed') || !['declined','cancelled','expired','refused'].includes(row.reason) : row.reason !== null) invalid();
    seen.add(row.attemptId);
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1114112) invalid(); // 1 MiB journal plus bounded projection metadata.
  return JSON.parse(JSON.stringify(value));
}
function codingMCPOutcomePresentation(row) {
  const providers = {
    returned_ok:['Provider reported success','The provider returned a supported successful result. External effects have not been independently verified.'],
    returned_error:['Provider reported an error','An action may have happened despite the provider error; verify the target before retrying.'],
    unsupported:['Provider result unsupported','The provider returned a result this bridge cannot fully report. The action may have happened; verify the target before retrying.'],
    unknown:['Completion unknown','This action may have happened; verify the target before retrying. No automatic retry was made.'],
    not_sent:[`${({declined:'Declined',cancelled:'Cancelled',expired:'Review expired',refused:'Refused'})[row.reason] || 'Prevented'} before dispatch`,'No tool call was sent for this recorded attempt.']
  };
  const deliveries = {
    written:['Written to engine','The original engine input write was confirmed; engine processing is not confirmed.'],
    failed:['Engine delivery failed','The result could not be confirmed as written to the original engine.'],
    withheld:['Not delivered to engine','No result was delivered to the engine for this attempt.'],
    unknown:['Engine delivery unknown','Delivery to the original engine is unconfirmed.']
  };
  const [provider,detail] = providers[row.provider], [delivery,deliveryDetail] = deliveries[row.delivery];
  return {provider,detail,delivery,deliveryDetail,unknown:row.provider === 'unknown' || row.persistence === 'unconfirmed',attention:['unknown','unsupported','returned_error'].includes(row.provider) || row.persistence === 'unconfirmed',persistence:row.persistence === 'durable' ? 'Saved metadata verified; action effects are separate.' : 'Receipt persistence unconfirmed. Treat completion as unknown and verify before retrying.'};
}
function codingOrderCommandReceipts(items, completed = false) {
  let at = items.findIndex(item => item.type === 'agentMessage' && item.phase === 'final_answer');
  if (at < 0 && completed) {const last = items.findLastIndex(item => item.type === 'agentMessage');if (last >= 0 && items[last].phase == null) at = last;}
  if (at < 0) return items;
  const tail = items.slice(at), late = new Set(tail.filter(item => item.type === 'commandExecution' && item.receiptSource === 'persistedToolOutput'));
  return late.size ? [...items.slice(0,at), ...late, ...tail.filter(item => !late.has(item))] : items;
}
function codingMCPOutcomeReader({read, changed}) {
  const cache = new Map(); let selected = '', epoch = 0, disposed = false, inFlight = null, again = false;
  let state = {threadId:'',legacy:false,metadataPending:false,snapshot:null,loading:false,waitingForStop:false,stale:false,error:'',notice:''};
  const emit = () => {if (!disposed) changed(state);};
  function select(id, historySource = null, metadataPending = false) {
    const legacy = historySource === 'legacy';metadataPending = !!metadataPending;
    if (disposed || id === selected && legacy === state.legacy && metadataPending === state.metadataPending) return false;
    selected = id; epoch++; again = false; if (inFlight) inFlight.invalidated = true;
    state = {threadId:id,legacy,metadataPending,snapshot:legacy || metadataPending ? null : cache.get(id) || null,loading:false,waitingForStop:false,stale:!legacy && !metadataPending && cache.has(id),error:'',notice:''}; emit();
    if (id) void refresh(); return true;
  }
  async function refresh(notice = '') {
    if (disposed || !selected || state.legacy || state.metadataPending) return;
    state.stale = !!state.snapshot; state.notice = notice || state.notice; state.loading = true; emit();
    if (inFlight) {again = true; return inFlight.promise;}
    const token = {id:selected,epoch,invalidated:false}; inFlight = token;
    const current = () => !disposed && selected === token.id && epoch === token.epoch && !token.invalidated;
    token.promise = (async () => {
      try {
        let raw;
        try {raw = await read(token.id);} catch (error) {
          if (error?.message === 'Tools are busy stopping; wait for Stop to finish before starting or reading work.') {
            // The existing Stop-response refresh will read again; retain evidence and prior errors meanwhile.
            if (current()) state.waitingForStop = true;
            return;
          }
          throw Error('Saved MCP outcomes are unavailable. Refresh to check again.');
        }
        if (!current()) return;
        const next = codingMCPOutcomeSnapshot(raw,token.id), previous = state.snapshot?.available === true ? state.snapshot : null;
        if (previous && next.available === false) throw Error('Saved MCP outcomes are unavailable; earlier evidence is retained.');
        if (previous && (next.ownerId !== previous.ownerId || previous.storeId && next.storeId !== previous.storeId)) throw Error('The saved MCP outcome journal changed or is unavailable; earlier evidence is retained.');
        if (previous && next.revision < previous.revision) throw Error('An older MCP outcome snapshot was returned; earlier evidence is retained.');
        if (previous && next.available === true) {
          const rows = new Map(next.records.map(row => [row.attemptId,row])), identity = row => JSON.stringify(['attemptId','ownerGeneration','processGeneration','threadId','turnId','callId','rpcId','server','name','createdAt','intendedAt','reason'].map(key => row[key]));
          for (const row of previous.records) {const newer = rows.get(row.attemptId);if (newer ? identity(row) !== identity(newer) : next.complete) throw Error('Saved MCP attempt identity changed or disappeared; earlier evidence is retained.');}
        }
        if (previous && next.available === true && !next.complete) {
          const rows = new Map(previous.records.map(row => [row.attemptId,row]));
          for (const row of next.records) rows.set(row.attemptId,row);
          if (rows.size > 256) throw Error('Incomplete MCP outcomes exceed the display limit; earlier evidence is retained.');
          next.records = [...rows.values()]; next.cached = true;
        }
        // Same-task events coalesce another read. Keep this verified snapshot
        // visible but stale so a busy event stream cannot starve the receipt view.
        state.snapshot = next; state.waitingForStop = false; state.stale = !!(again || next.available && (!next.complete || next.cached)); state.error = ''; state.notice = again ? state.notice || 'Newer outcomes may be available. Checking saved evidence.' : '';
        if (next.available) {cache.delete(token.id);cache.set(token.id,next);if (cache.size > 8) cache.delete(cache.keys().next().value);}
      } catch (error) {if (current()) {state.waitingForStop = false; state.stale = true; state.error = error.message;}}
      finally {
        if (inFlight === token) inFlight = null;
        if (!disposed && selected === token.id && epoch === token.epoch) {state.loading = false; emit();}
        if (!disposed && again && selected) {again = false;void refresh();}
      }
    })();
    return token.promise;
  }
  function invalidate(notice = '') {if (!disposed && selected && !state.legacy && !state.metadataPending) {state.notice = notice;void refresh(notice);}}
  function dispose() {disposed = true;epoch++;selected = '';again = false;if (inFlight) inFlight.invalidated = true;state = {threadId:'',legacy:false,metadataPending:false,snapshot:null,loading:false,waitingForStop:false,stale:false,error:'',notice:''};cache.clear();}
  return {select,refresh,invalidate,dispose,current:()=>state};
}
// MCP OUTCOMES HELPERS END

// SAVED TERMINAL RESULTS HELPERS BEGIN
function codingTerminalResultsIndependent(body) {
  const input=body?.input;
  return body?.op==='coding' && Object.keys(body).length===2 && input?.action==='terminalResults' &&
    ['action,threadId','action,recordId,threadId'].includes(Object.keys(input).sort().join()) &&
    typeof input.threadId==='string' && /^[A-Za-z0-9_.-]{1,160}$/.test(input.threadId) &&
    (!Object.hasOwn(input,'recordId') || typeof input.recordId==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.recordId));
}
function codingTerminalResultSnapshot(value,threadId,recordId,ownerId,rootThreadId) {
  const exact=(v,keys)=>v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const bytes=v=>new TextEncoder().encode(v).length;
  const text=(v,max,empty=true)=>typeof v==='string' && (empty||v.length>0) && v.length<=max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v) && bytes(v)<=max;
  const integer=v=>Number.isSafeInteger(v)&&v>=0;
  const summary=['recordId','createdAt','endedAt','state','exitCode','stopRequested','outputTruncated','observationComplete','commandPreview','commandTruncated'];
  const detail=['recordId','ownerId','threadId','rootThreadId','ownerGeneration','cwd','command','output','createdAt','endedAt','state','exitCode','stopRequested','outputTruncated','droppedOutputBytes','observationComplete','error'];
  const fail=()=>{throw Error('Saved command results are unavailable: the response could not be verified.');};
  if(!exact(value,['ownerId','threadId','omittedCount',recordId?'record':'records'])||!uuid(value.ownerId)||ownerId&&value.ownerId!==ownerId||value.threadId!==threadId||!integer(value.omittedCount))fail();
  const rows=recordId?[value.record]:value.records;
  if(!Array.isArray(rows)||rows.length>24)fail();const seen=new Set();
  for(const row of rows){
    if(!exact(row,recordId?detail:summary)||!uuid(row.recordId)||seen.has(row.recordId)||!integer(row.createdAt)||!(row.endedAt===null||integer(row.endedAt)&&row.endedAt>=row.createdAt)||!['not-started','exited','unconfirmed'].includes(row.state)||['stopRequested','outputTruncated','observationComplete'].some(k=>typeof row[k]!=='boolean'))fail();
    seen.add(row.recordId);
    if(row.state==='exited' ? !Number.isSafeInteger(row.exitCode)||row.exitCode< -2147483648||row.exitCode>2147483647||row.endedAt===null||!row.observationComplete : row.exitCode!==null)fail();
    if(row.state==='not-started'&&(row.endedAt===null||!row.observationComplete)||row.state==='unconfirmed'&&row.observationComplete)fail();
    if(recordId){
      if(row.recordId!==recordId||row.ownerId!==value.ownerId||row.threadId!==threadId||row.rootThreadId!==rootThreadId||!uuid(row.ownerGeneration)||!text(row.cwd,4096,false)||!row.cwd.startsWith('/')||/[\x00-\x1f\x7f]/.test(row.cwd)||!text(row.command,80000,false)||!text(row.output,262144)||!integer(row.droppedOutputBytes)||row.droppedOutputBytes>0&&!row.outputTruncated||!(row.error===null||text(row.error,2000,false))||row.state==='not-started'&&(row.output!==''||row.outputTruncated)||bytes(JSON.stringify(row))>2097152)fail();
    }else if(!text(row.commandPreview,256)||typeof row.commandTruncated!=='boolean')fail();
  }
  if(bytes(JSON.stringify(value))>(recordId?2162688:65536))fail();return value;
}
// SAVED TERMINAL RESULTS HELPERS END

(async () => {
  'use strict';
  const $ = id => document.getElementById(id);
  const bridge = window.webkit?.messageHandlers?.tools;
  const storageKey = 'qwen-coding-ui-v1';
  const submissionStore = SalehSubmission.createStore({getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value)});
  const submissionDispatches = new Map();
  const questionRecords = new Map();
  let questionSnapshotReady = false, questionCursor = -1, questionGeneration = 0, questionWarning = '';
  const threads = new Map(), terminals = new Map(), pendingTerminalStarts = new Map(), gitResults = new Map(), snapshotCursors = new Map(), threadReads = new Map();
  const families = new Map(), familyReads = new Map(), familyWarnings = new Map(), invalidFamilies = new Set(), pendingFamilyStops = new Map();
  const workspaceSync = new Map(); let workspaceStatusRequest = 0, workspaceStatusApplied = 0, workspaceSnapshotCursor = -1;
  const worktrees = new Map(), handoffs = new Map();
  let gitOperation = null, gitEpoch = 0, gitFormRepository = '', gitPublishKey = '';
  let worktreeSource = '', worktreesLoaded = false, worktreesBusy = false, worktreesReadOnly = true, worktreeOpenAvailable = false, worktreeCreateAvailable = false, worktreeHandoffAvailable = false, worktreeMutating = false, worktreeStopRequested = false, worktreeReconnectAvailable = false, worktreeRecoveryCopyAvailable = false;
  let worktreeMutation = null, worktreeEpoch = 0;
  const schedules = new Map(), scheduleMutations = new Set(), scheduleControls = new Set();
  let schedulesLoaded = false, scheduleRecoveryAvailable = false, scheduleRunningId = null, scheduleRevision = 0, scheduleRead = null, scheduleLastRead = 0, scheduleEditor = '', scheduleFormReady = false;
  let familyReadSequence = 0;
  const turnWatchLimit = 512;
  let watchedTurns = [], completionTrackingBlocked = false, completionNotice = '';
  const attachments=globalThis.SalehAttachments,attachmentStorage=globalThis.SalehAttachmentStorage,attachmentReads=new Map(),imagePreviews=new Map();
  let savedHistory=null;
  let imagePreviewEpoch=0,attachmentRevision=0,storageBlocked=false,lastSavedSnapshot=null,storageHydrating=false;
  let preferences = {selectedId: '', drafts: {}, attachmentDrafts: {}, efforts: {}, taskModes: {}, pendingThreads: {}, terminalDrafts: {}, unread: {}, watchedTurns, scheduleDrafts: {}, scheduleSelectedId: '', gitDrafts: {}, worktreeGitDrafts: {}, handoffChats: {}}, selectedId = '', archived = false, panel = '', sessionView = false;
  let listed = [], approvals = [], cursor = 0, requestQueue = Promise.resolve(), acting = false, listRequest = 0, listHistoryWarning = '', eventNotice = '', stopNotice = '', stopResultEligible = false;
  let listState = 'loading', listLoaded = false;
  let approvalWarning = '', codingRequest = null, requestFeedbackTimer;
  let selectionEpoch = 0, setupPanelEpoch = 0, setupInventoryReading = false, setupInventoryReady = false;
  let setupProject = '', setupChoice = null;
  const setupCreatedRoots = new Set();
  const setupReviewQueueReleases = new Map();
  let goals = null;
  let engine = {available: false, provider: 'local'}, renamingId = '', pollTimer, disposed = false, pollFailed = false;
  const current = () => threads.get(selectedId);
  let localModels = {online: null, models: [], message: bridge ? 'Checking installed local models…' : 'Open the installed app to check local models.'}, modelRefresh = 0, newModel = modelDefault(localModels,'coding'), newModelSelected = false;
  const historyPending = thread => !!thread && !!(thread.metadataPending || thread.historyReadPending || !thread.turns?.length && threadReads.has(thread.id));
  const localThread = thread => !thread?.modelProvider || ['local', 'saleh_local'].includes(thread.modelProvider);
  const codingModelState = (thread, effort = 'none') => {
    const choice=localThread(thread)?modelEligibility(localModels,thread?.model||'','coding',effort==='high'):{ready:true,reason:'Explicit cloud provider · billing is separate from local models.'};
    try{if(localThread(thread)&&draftFiles(thread?.id).some(file=>file.kind==='image')&&choice.entry?.capabilities?.vision!==true)return {...choice,ready:false,reason:'This message needs a loaded vision-capable model. Remove the image or choose a compatible new chat.'};}
    catch(error){return {...choice,ready:false,reason:error.message};}return choice;
  };
  function renderModelControls() {
    const thread = current(), local = localThread(thread), choice = codingModelState(thread, $('effort').value), next = modelEligibility(localModels, newModel, 'coding');
    modelOptions($('default-model'), localModels, modelDefault(localModels,'coding')); modelOptions($('new-chat-model'), localModels, newModel);
    const busy = acting || !!activeTurn(thread) || childChat(thread);
    $('default-model').disabled = busy; $('new-chat-model').disabled = busy || $('provider').value !== 'local'; $('models-refresh').disabled = acting;
    $('new-model-status').textContent = $('provider').value === 'local' ? `${newModel || 'No model selected'} · ${next.reason}` : 'New chats use the explicitly selected cloud provider. The local model choice does not apply.';
    $('thread-model').textContent = thread?.historyOnly ? thread.model ? `Recorded model: ${thread.model}` : 'Recorded model unavailable' : thread?.model || (thread ? 'Model identity unavailable · refresh history' : 'Choose a project chat');
    const friendly=localModels.models.find(row=>row.id===thread?.model)?.label;
    $('thread-model-name').textContent=friendly||thread?.model||'Model unavailable';
    $('thread-model-name').title=$('thread-model').textContent;
    $('model-status').classList.toggle('sr-only',!!thread&&choice.ready&&!thread.historyOnly&&!thread.draftReadError&&!historyPending(thread));
    $('model-status').textContent = thread?.draftReadError ? 'Saved history could not be checked. Refresh history to retry.' : historyPending(thread) ? 'Loading saved chat details…' : thread?.historyOnly ? 'Saved history · read only. Viewing this chat does not require its recorded model to be loaded.' : thread && !thread.model ? 'Model identity unavailable · refresh history to check this chat.' : thread ? `${choice.reason} ${local ? 'This Coding chat is pinned to its recorded model. Start a new chat to choose another.' : 'Local defaults do not change this cloud chat.'}` : 'Choose a model for a new Coding chat. Existing chats keep their recorded model.';
    if (local && thread) {
      $('effort').querySelector('[value=none]').disabled = choice.entry?.capabilities?.standard !== true;
      $('effort').querySelector('[value=high]').disabled = choice.entry?.capabilities?.deep !== true;
    } else for (const option of $('effort').options) option.disabled = false;
    $('model-readiness-overview').textContent=capabilityOverview(localModels,modelDefault(localModels,'coding'));
    if(scheduleFormReady)renderScheduleModel();
  }
  async function refreshModels() {
    const request = ++modelRefresh;
    try {
      const response = await fetch('/api/models', {cache: 'no-store'}), catalog = await response.json();
      if (!response.ok || !Array.isArray(catalog.models) || typeof catalog.online !== 'boolean') throw Error('Local model inventory is unavailable.');
      if (request !== modelRefresh) return; localModels = catalog;
      if(!newModelSelected&&!newModel&&!savedDefault().saved){const suggested=modelDefault(localModels,'coding');if(suggested){newModel=suggested;newModelSelected=true;}}
    } catch (error) {if (request !== modelRefresh) return; localModels = {online:false,connected:false,status:'server-error',models:localModels.models,error:{code:'LOCAL_INVENTORY_ENDPOINT_ERROR'},message:'Noiee could not refresh model inventory. Check the local app connection and retry.'};}
    controls();
  }
  const childChat = thread => !!(thread?.parentThreadId || thread?.source?.subAgent || thread?.canAcceptDirectInput === false);
  const ownedChat = thread => !!thread && !thread.metadataPending && !thread.historyOnly && !childChat(thread);
  const managedCloudChat = thread => !!thread && !thread.metadataPending && !childChat(thread) && ['cloud','saleh_cloud'].includes(thread.modelProvider) && !['legacy','quarantined-owner','retained-handoff'].includes(thread.historySource);
  const directInput = thread => ownedChat(thread) && !thread.archived;
  const canExecute = thread => directInput(thread) && !checkoutNotice(thread?.cwd);
  const canStartWork = thread => canExecute(thread) && !workspaceBlocked(thread?.id);
  const title = thread => thread?.name || thread?.agentNickname || thread?.preview?.slice(0, 70) || (childChat(thread) ? 'Agent' : 'New chat');
  const activeTurn = thread => thread?.turns?.findLast(turn => turn.status === 'inProgress');
  const element = (tag, className, text) => {const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;};
  const message = error => typeof error === 'string' ? error : error?.message || String(error);
  const mcpOutcomes = codingMCPOutcomeReader({read: threadId => call('mcpOutcomes', {threadId}), changed: renderMCPOutcomes});
  const setupAPI = globalThis.SalehCodingMCPSetup;
  const setupContext = () => ({threadId:selectedId,epoch:selectionEpoch,draft:JSON.stringify([$('prompt').value,attachmentRevision,attachmentReads.has(selectedId)])});
  const mcpSetup = setupAPI?.create({request:(body, cancellation) => native(body, cancellation),getContext:setupContext,changed:() => {renderMCPSetup();controls();},recordRoot:recordMCPSetupRoot});
  const setupBlocking = () => !!mcpSetup?.view().blocking;
  function historyNotice() {
    return listLoaded ? codingStartupRecovery(engine.owners, listHistoryWarning).historyWarning : '';
  }
  function renderStartupRecovery() {
    const state = codingStartupRecovery(engine.owners, listLoaded ? listHistoryWarning : '', selectedId, familyFor(selectedId)?.rootThreadId);
    $('startup-recovery').hidden = !state.visible;
    $('startup-recovery-summary').textContent = state.summary;
    $('startup-recovery-current').hidden = !state.relevant;
    $('startup-recovery-current').textContent = state.relevant ? 'The selected task has an incomplete startup. Review its retained record before continuing.' : '';
    $('review-startup-recovery').disabled = $('failed-startups').disabled;
  }
  const banner = (id, value) => {if (id === 'notice') value = [stopNotice, value].filter(Boolean).join(' ');if (id === 'event-notice') {eventNotice = value || ''; value = [historyNotice(), completionNotice, eventNotice].filter(Boolean).join(' ');} const node = $(id); node.textContent = value || ''; node.hidden = !value; if (id === 'notice') delete node.dataset.stopFamily; if (id === 'event-notice') renderStartupRecovery();};
  const agentWorking = thread => !thread?.localStopped && (!!activeTurn(thread) || thread?.status?.type === 'active');
  const working = thread => agentWorking(thread) || !!terminals.get(thread?.id)?.running;
  const waiting = id => approvals.some(approval => approval.params?.threadId === id);
  const familyFor = id => families.get(threads.get(id)?.rootThreadId || id) || [...families.values()].find(family => family.ids.includes(id));
  function workspaceFor(id) {
    const family = familyFor(id);
    // A child's completion can arrive before the engine resolves its root.
    if (family) return family.ids.reduce((latest, member) => {const row = workspaceSync.get(member);return row && (!latest || row.sequence > latest.sequence) ? row : latest;}, workspaceSync.get(family.rootThreadId));
    const seen = new Set();
    while (id && !seen.has(id)) {seen.add(id);const thread = threads.get(id), row = workspaceSync.get(thread?.rootThreadId || id);if (row) return row;id = thread?.parentThreadId;}
  }
  const workspaceBlocked = id => {const row = workspaceFor(id);return row?.blocked === true || ['waiting','publishing','failed'].includes(row?.state);};
  const workspaceStopTarget = id => {const row = workspaceFor(id);return row?.blocked === true || row?.state === 'failed' ? familyFor(id)?.rootThreadId || row.rootThreadId : id;};
  function acceptWorkspaceSync(row, sequence) {
    if (typeof row?.rootThreadId !== 'string' || !['waiting','publishing','complete','failed','cancelled'].includes(row.state) || !Number.isSafeInteger(row.round) || row.round < 1 || row.blocked !== undefined && typeof row.blocked !== 'boolean') return;
    if ((workspaceSync.get(row.rootThreadId)?.sequence ?? -1) > sequence) return;
    workspaceSync.set(row.rootThreadId, {rootThreadId:row.rootThreadId,state:row.state,message:typeof row.message === 'string' ? row.message : '',round:row.round,blocked:row.blocked === true,sequence});
  }
  function subtreeIds(id) {
    const family = familyFor(id), ids = new Set(family?.rootThreadId === id ? family.ids : [id]);
    // Status supplies trusted root IDs before the ordinary metadata lane can catch up.
    for (const thread of threads.values()) if (thread.rootThreadId === id) ids.add(thread.id);
    for (let i = 0; i < threads.size; i++) {const size = ids.size; for (const thread of threads.values()) if (ids.has(thread.parentThreadId)) ids.add(thread.id); if (size === ids.size) break;}
    return [...ids];
  }
  const familyBusy = id => subtreeIds(id).some(value => working(threads.get(value)) || waiting(value));
  const familyStopping = id => pendingFamilyStops.has(id) || (familyFor(id)?.stoppingTargets || engine.stoppingFamilies || []).includes(id);
  const sessionIds = () => [...threads.keys()].filter(id => working(threads.get(id)) || familyBusy(id) || pendingQuestion(id) || waiting(id) || preferences.unread[id]);
  const sidebarState = () => JSON.stringify([...threads].map(([id, thread]) => [id, title(thread), thread.cwd, thread.parentThreadId, working(thread), familyBusy(id), waiting(id), questionLabel(id), preferences.unread[id]]));
  function settleFamilyStops() {
    for (const [id, stop] of pendingFamilyStops) {
      const family = familyFor(id);
      if (stop.requestPending || !family || family.readSequence <= stop.afterRead || family.stoppingTargets.some(target => subtreeIds(target).includes(id)) || familyBusy(id) || workspaceBlocked(id)) continue;
      pendingFamilyStops.delete(id);
      readThread(id).catch(error => {const thread = threads.get(id); if (thread) thread.historyWarning = `History refresh failed: ${message(error)}`; if (id === selectedId) renderMessages();});
      const node = $('notice'); if (node.dataset.stopFamily === id) banner('notice', '');
    }
  }
  function markUnread(id, itemId, status) {
    if (id === selectedId || !threads.has(id)) return;
    preferences.unread[id] = {itemId, status}; save();
  }
  const completionId = value => typeof value === 'string' && /^[\w.-]{1,160}$/.test(value);
  function observeTurns(id, turns, complete = true) {
    if (disposed || completionTrackingBlocked || !completionId(id) || !Array.isArray(turns)) return;
    let changed = false;
    for (const turn of turns) {
      if (!completionId(turn?.id)) continue;
      const index = watchedTurns.findIndex(watch => watch.threadId === id && watch.turnId === turn.id);
      if (turn.status === 'inProgress' && index < 0) {
        if (watchedTurns.length >= turnWatchLimit) {
          completionNotice = 'Completion tracking is full (512 turns). New tasks may not appear as unread; inspect their chats directly.';
          banner('event-notice', eventNotice); continue;
        }
        watchedTurns.push({threadId: id, turnId: turn.id}); changed = true;
      } else if (complete && index >= 0 && ['completed', 'interrupted', 'failed'].includes(turn.status)) {
        watchedTurns.splice(index, 1); changed = true;
        if (id !== selectedId && threads.has(id)) preferences.unread[id] = {itemId: turn.id, status: turn.status};
      }
    }
    if (changed) save();
  }
  function persistPreferences(value) {
    if(storageBlocked||storageHydrating||disposed)return false;
    try {if(localStorage.getItem(storageKey)!==lastSavedSnapshot){storageBlocked=true;banner('storage-notice','Another page changed saved Coding drafts. Saving is paused to preserve them. Copy any unsaved text here, then reload.');return false;}
      const next=attachmentStorage.serialize(value,'coding');localStorage.setItem(storageKey,next);lastSavedSnapshot=next;banner('storage-notice','');return true;}
    catch {banner('storage-notice', 'Drafts could not be saved on this device. Keep this window open and copy any unsent text.'); return false;}
  }
  function save(){preferences.selectedId=selectedId;return persistPreferences(preferences);}
  function resizePrompt(){const prompt=$('prompt');prompt.style.height='auto';prompt.style.height=`${Math.min(prompt.scrollHeight,180)}px`;}
  window.salehSaveBeforeLeave = () => {if(storageHydrating||attachmentReads.size||attachmentStorage.busy){banner('storage-notice','Wait for image loading or saving to finish before leaving.');return false;}return save();};
  window.addEventListener('pagehide',()=>{if(storageHydrating)disposed=true;},{once:true});
  try {
    lastSavedSnapshot=localStorage.getItem(storageKey);let stored = JSON.parse(lastSavedSnapshot ?? 'null');
    if(lastSavedSnapshot!==null){
      const map=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
      if(!map(stored))throw Error('Invalid saved Coding preferences.');
      for(const key of ['drafts','attachmentDrafts','efforts','taskModes','pendingThreads','terminalDrafts','unread','scheduleDrafts','gitDrafts','publishDrafts','worktreeGitDrafts','handoffChats','followupEdits','goalDrafts'])if(Object.hasOwn(stored,key)&&!map(stored[key]))throw Error('Invalid saved Coding draft map.');
      if(Object.hasOwn(stored,'taskModes')&&Object.keys(stored.taskModes).length>4096)throw Error('Saved task modes exceed the storage limit.');
    }
    if(attachmentStorage.hasRefs(stored,'coding')){storageHydrating=true;document.body.inert=true;banner('storage-notice','Loading saved images…');stored=await attachmentStorage.hydrate(stored,'coding');if(disposed)return;if(localStorage.getItem(storageKey)!==lastSavedSnapshot)throw Error('Saved Coding drafts changed while images were loading.');}
    if (stored && typeof stored === 'object') {
      preferences.selectedId = typeof stored.selectedId === 'string' ? stored.selectedId : '';
      for (const key of ['drafts', 'efforts', 'taskModes', 'pendingThreads', 'terminalDrafts', 'unread', 'scheduleDrafts', 'gitDrafts', 'publishDrafts']) if (stored[key] && typeof stored[key] === 'object') preferences[key] = stored[key];
      if(Object.hasOwn(stored,'attachmentDrafts')){preferences.attachmentDrafts=stored.attachmentDrafts;
        if(!stored.attachmentDrafts||typeof stored.attachmentDrafts!=='object'||Array.isArray(stored.attachmentDrafts))throw Error('Invalid saved attachment drafts.');
        for(const id of Object.keys(stored.attachmentDrafts))try{preferences.attachmentDrafts[id]=attachments.normalize(stored.attachmentDrafts[id]);}catch{/* Preserve invalid entries; their chat cannot send them. */}
      }
      if (stored.watchedTurns !== undefined) {
        if (!Array.isArray(stored.watchedTurns) || stored.watchedTurns.length > turnWatchLimit) {
          preferences.watchedTurns = stored.watchedTurns; completionTrackingBlocked = true;
          completionNotice = 'Saved completion tracking is invalid or exceeds 512 turns. It is preserved unchanged; inspect task history directly.';
        } else {
          const seen = new Set();
          watchedTurns = preferences.watchedTurns = stored.watchedTurns.filter(watch => {
            if (!completionId(watch?.threadId) || !completionId(watch?.turnId)) return false;
            const key = `${watch.threadId}/${watch.turnId}`;
            if (seen.has(key)) return false; seen.add(key); return true;
          }).map(({threadId, turnId}) => ({threadId, turnId}));
        }
      }
      if(Object.hasOwn(stored,'followupEdits'))preferences.followupEdits=stored.followupEdits;
      if(Object.hasOwn(stored,'goalDrafts')){if(Object.keys(stored.goalDrafts).length>128)throw Error('Saved goal drafts exceed the storage limit.');preferences.goalDrafts=stored.goalDrafts;}
      if (stored.worktreeGitDrafts && typeof stored.worktreeGitDrafts === 'object') for (const [id, draft] of Object.entries(stored.worktreeGitDrafts).slice(0, 128)) if (id.length <= 160) preferences.worktreeGitDrafts[id] = worktreeGitText(draft);
      if (stored.handoffChats && typeof stored.handoffChats === 'object') for (const [id, value] of Object.entries(stored.handoffChats).slice(0, 128)) if (validHandoffChat(id, value)) preferences.handoffChats[id] = value;
      scheduleEditor = preferences.scheduleSelectedId = typeof stored.scheduleSelectedId === 'string' ? stored.scheduleSelectedId : '';
    }
    selectedId = preferences.selectedId;
    for (const [id, value] of Object.entries(preferences.handoffChats)) threads.set(id, {id, ...value, turns: [], metadataPending: true});
    for (const [id, draft] of Object.entries(preferences.pendingThreads)) {
      if (!draft || typeof draft.cwd !== 'string' || !draft.cwd.startsWith('/') || !['local', 'cloud'].includes(draft.provider)) {delete preferences.pendingThreads[id]; continue;}
      threads.set(id, {id, cwd: draft.cwd, name: typeof draft.name === 'string' ? draft.name : 'New chat', modelProvider: `saleh_${draft.provider}`, executionMode: draft.executionMode === undefined ? 'vm' : draft.executionMode, model: draft.model === undefined ? LEGACY_LOCAL_MODEL : typeof draft.model === 'string' ? draft.model : '', turns: [], archived: false, pendingMaterialization: true, historyReadPending: true});
    }
  } catch {storageBlocked=true;banner('storage-notice', 'Saved Coding drafts could not be read. Their stored contents are preserved; saving is paused.');}finally{storageHydrating=false;document.body.inert=false;}
  if(disposed)return;

  function rememberPending(thread, provider) {
    preferences.pendingThreads[thread.id] = {cwd: thread.cwd, name: title(thread), provider, executionMode: thread.executionMode ?? 'vm', model: typeof thread.model === 'string' ? thread.model : ''};
    save();
  }

  function draftFiles(id){
    const files=preferences.attachmentDrafts;
    if(!files||typeof files!=='object'||Array.isArray(files))throw Error('Saved attachment drafts are unavailable. Their contents are preserved.');
    try{return attachments.normalize(Object.hasOwn(files,id)?files[id]:[]);}catch{throw Error('This saved attachment draft could not be read. Its contents are preserved.');}
  }
  function setDraftFiles(id,files){
    const next={...preferences,attachmentDrafts:{...preferences.attachmentDrafts}};
    if(files.length)next.attachmentDrafts[id]=attachments.normalize(files);else delete next.attachmentDrafts[id];
    if(!persistPreferences(next))throw Error('Attachments could not be saved. The previous draft was kept.');
    preferences=next;attachmentRevision++;
  }
  function renderDraftAttachments(){
    const area=$('draft-attachments'),id=selectedId;area.replaceChildren();
    try{const files=draftFiles(id);if(files.length)area.append(attachments.cards(files,index=>{
      attachmentReads.delete(id);try{setDraftFiles(id,files.filter((_,i)=>i!==index));}catch(error){banner('notice',error.message);}renderDraftAttachments();controls();
    }));}catch(error){area.append(element('p','muted',error.message));}
    if(attachmentReads.has(id))area.append(element('span','attachment-loading','Reading attachments…'));
  }
  function clearImagePreviews(){imagePreviewEpoch++;imagePreviews.clear();}
  function savedImageCard(threadId,turnId,itemId,index,image,view=null){
    const previews=view?.images??imagePreviews,render=view?.render??renderMessages;
    const card=element('div','coding-image'),key=JSON.stringify([threadId,turnId,itemId,index,image?.sha256]),cached=previews.get(key);
    if(image?.unavailable||!image?.sha256){card.append(element('span','muted','Image preview unavailable. Original history is preserved.'));return card;}
    if(cached?.dataURL){const img=element('img');img.src=cached.dataURL;img.alt=`Attached image ${index+1}`;card.append(img);return card;}
    const button=element('button','',cached?.loading?'Loading image…':`View image ${index+1}`);button.type='button';button.disabled=!!cached?.loading||!!view&&!view.valid();
    card.append(button,element('span','muted',`${image.width} × ${image.height} · ${Math.ceil(image.bytes/1024)} KB`));if(cached?.error)card.append(element('span','muted',cached.error));
    button.onclick=async()=>{
      const scope=imagePreviewEpoch,entry={loading:true};if(view&&!view.valid())return;if(previews.size>=8)previews.delete(previews.keys().next().value);previews.set(key,entry);render();
      const valid=()=>!disposed&&scope===imagePreviewEpoch&&previews.get(key)===entry&&(view?view.valid():selectedId===threadId);
      try{
        const result=await call('readImage',{threadId,turnId,itemId,index,sha256:image.sha256,...(view?{historyCursor:view.cursor}:{})},view?.cancellation);
        if(!valid())return;
        if(result.threadId!==threadId||result.turnId!==turnId||result.itemId!==itemId||result.index!==index||result.sha256!==image.sha256||view&&result.historyCursor!==view.cursor)throw Error('Image reference changed. Refresh history.');
        const info=attachments.imageInfo(result.dataURL);if(info.bytes!==image.bytes||info.width!==image.width||info.height!==image.height)throw Error('Image metadata changed. Refresh history.');
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(result.dataURL)))].map(v=>v.toString(16).padStart(2,'0')).join('');
        if(!valid())return;if(digest!==image.sha256)throw Error('Image bytes do not match saved history.');entry.dataURL=result.dataURL;
      }catch(error){entry.error=message(error);}finally{entry.loading=false;if(valid())render();}
    };return card;
  }

  function native(body, cancellation) {
    if (!bridge) return Promise.reject(new Error('Open Noiee.app to use the coding workspace.'));
    const independent = body.op === 'codingQueue' && Object.keys(body).length === 2 && ['inspect','read','pause'].includes(body.input?.action) || body.op === 'codingFilePreview' && Object.keys(body).length === 2 && body.input?.action === 'clear' && Object.keys(body.input).length === 1 || body.op === 'cancel' && Object.keys(body).length === 1 || setupAPI?.independent(body) || codingMCPOutcomesIndependent(body) || codingTerminalResultsIndependent(body) || body.op === 'coding' && ['status', 'events', 'interrupt', 'interruptFamily', 'terminalStop', 'terminalSnapshot', 'terminalInput', 'terminalResize'].includes(body.input?.action) || body.op === 'codingWorktrees' && body.input?.action === 'stop' && Object.keys(body).length === 2 && Object.keys(body.input).length === 1 || body.op === 'codingSchedules' && Object.keys(body).length === 2 && (body.input?.action === 'stop' && Object.keys(body.input).length === 1 || body.input?.action === 'pause' && typeof body.input.id === 'string' && Object.keys(body.input).length === 2) || body.op === 'codingGit' && Object.keys(body).length === 2 && body.input?.action === 'stop' && Object.keys(body.input).length === 2 && typeof body.input.requestId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(body.input.requestId);
    const review = body.op === 'codingMCP' && Object.keys(body).length === 2 && body.input?.action === 'reviewStart' && Object.keys(body.input).length === 3 && Number.isSafeInteger(body.input.revision) && body.input.revision >= 0 && setupAPI?.independent({op:'codingMCP',input:{action:'setupStatus',setupId:body.input.setupId}}) ? {revision:body.input.revision,dispatched:false,release:null} : null;
    const released = review ? new Promise(resolve => {review.release = resolve;}) : null;
    let pending = null;
    const task = (independent ? Promise.resolve() : requestQueue.catch(() => {})).then(() => {
      if (cancellation?.cancelled) return {cancelled:true};
      if (body.op === 'coding' && body.input?.action === 'answer' && cancellation) cancellation.dispatched = true;
      if (review) {review.dispatched = true;setupReviewQueueReleases.set(body.input.setupId,review);}
      if (body.op === 'coding' && ['start','send','goalContinue','steer','review','fork','rename','archive','unarchive','terminalStart','git'].includes(body.input?.action)) {
        pending = {...captureCodingRequest(body.input, threads.get(body.input.threadId), performance.now(), cancellation), requestId: null, progressRevision: 0, progress: null}; codingRequest = pending; controls();
      }
      return bridge.postMessage(body);
    }).then(result => {
      if (body.op === 'codingMCP' && setupAPI?.status(result)) {
        const waiting = setupReviewQueueReleases.get(result.setupId);
        const settled = result.phase === 'created' && result.creation === 'confirmed' || ['cancelled','failed'].includes(result.phase) && result.cleanup === 'closed';
        if (waiting?.dispatched && result.revision > waiting.revision && settled) {waiting.release();setupReviewQueueReleases.delete(result.setupId);}
        return result;
      }
      if (result?.isError || result?.error) throw new Error(message(result.error || result.message || 'Native request failed.'));
      return result || {};
    });
    if (!independent) requestQueue = review ? Promise.race([task,released]) : task;
    return task.finally(() => {if (pending && codingRequest === pending) codingRequest = null;if (review) {review.release();if (setupReviewQueueReleases.get(body.input.setupId) === review) setupReviewQueueReleases.delete(body.input.setupId);}controls();});
  }
  const call = (action, input = {}, cancellation) => native({op: 'coding', input: {action, ...input}}, cancellation);
  function codingStartupProgress(event) {
    const value = event.detail, pending = codingRequest;
    if (!pending || pending.stopping || !value || typeof value !== 'object' || !['action,requestId,revision,stage,state','action,fraction,requestId,revision,stage,state'].includes(Object.keys(value).sort().join()) || value.action !== pending.action || typeof value.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.requestId) || !Number.isSafeInteger(value.revision) || value.revision < 0) return;
    if (Object.hasOwn(value, 'fraction') && (value.state !== 'observed' || value.stage !== 'installing' || typeof value.fraction !== 'number' || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1)) return;
    if (value.state === 'begin') {if (!pending.requestId && value.revision === 0 && value.stage === null) pending.requestId = value.requestId; return;}
    if (pending.requestId !== value.requestId || value.revision <= pending.progressRevision || !['observed','unavailable','interrupted'].includes(value.state)) return;
    if (value.state === 'observed' ? !['allocating','installing','booting','waiting-connection','waiting-review','finishing-setup','preparing-project'].includes(value.stage) : value.stage !== null) return;
    pending.progressRevision = value.revision; pending.progress = {state: value.state, stage: value.stage, ...(Object.hasOwn(value, 'fraction') ? {fraction: value.fraction} : {})}; controls();
  }
  function codingRequestMessage() {
    if (codingRequest?.stopping) return 'Stop requested. Startup completion and cleanup remain unconfirmed until the original request settles.';
    const progress = codingRequest?.progress;
    if (progress?.state === 'interrupted') return 'Startup progress updates were interrupted. Startup completion and cleanup remain unconfirmed until the original request settles.';
    if (progress?.state === 'unavailable') return 'Startup progress is unavailable. The original coding request is still pending.';
    if (progress?.state === 'observed' && progress.stage === 'installing' && Number.isFinite(progress.fraction)) return `Installing the guest system · ${Math.floor(progress.fraction * 100)}%`;
    const labels = {'allocating':'Allocating the isolated workspace…','installing':'Installing the guest system…','booting':'Starting the guest…','waiting-connection':'Waiting for the guest connection…','waiting-review':'Waiting for native review. Inspect the matching guest and respond to the native review.','finishing-setup':'Finishing guest setup. If the guest asks to shut down, choose Shut Down in its window.','preparing-project':'Preparing the project workspace…'};
    return progress?.state === 'observed' ? labels[progress.stage] : 'Preparing coding request… Detailed startup status is not available yet.';
  }
  window.addEventListener('coding-startup-progress', codingStartupProgress);
  // CODING REQUEST PRESENTATION BEGIN
  function captureCodingRequest(input, thread, startedAt, dispatch) {
    return {action:input.action,threadId:input.threadId || '',cwd:input.cwd || thread?.cwd || '',
      model:input.action === 'start' ? input.model || '' : thread?.model || '',
      provider:input.action === 'start' ? input.provider || '' : thread?.modelProvider || '',startedAt,dispatch,stopping:false};
  }
  function codingRequestPresentation(request, now, stageMessage) {
    if (!request) return null;
    const actions = {start:'Starting chat',send:'Sending message',goalContinue:'Continuing goal',steer:'Steering current turn',review:'Requesting review',fork:'Forking chat',rename:'Renaming chat',archive:'Archiving chat',unarchive:'Unarchiving chat',terminalStart:'Starting terminal',git:'Requesting Git action'};
    const seconds = Number.isFinite(request.startedAt) && Number.isFinite(now) ? Math.max(0, Math.floor((now - request.startedAt) / 1000)) : null;
    return {
      headline:request.stopping ? 'Stop requested · waiting for the original request' : `Request pending · ${actions[request.action] || 'Waiting for native reply'}`,
      detail:request.stopping || request.progress ? stageMessage : request.action === 'start' ? 'Waiting for the native reply. Startup stage is not reported here. Complete any native review that appears.' : ['rename','archive','unarchive'].includes(request.action) ? 'Waiting for native acknowledgement. The requested change is not yet confirmed.' : 'Waiting for the native reply. Execution stage is not reported here. Activity may appear before acknowledgement.',
      context:[request.model ? `Requested model: ${request.model}` : `Requested provider: ${request.provider || 'unreported'} · model identity unreported`,request.cwd ? `Project: ${request.cwd}` : request.threadId ? `Chat: ${request.threadId} · project unreported` : 'Project identity unreported'].join('\n'),
      elapsed:seconds === null ? 'Total request wait unavailable' : `Total request wait (includes native review): ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`,
    };
  }
  function pendingCodingRequestCount() {
    const dispatches = [...submissionDispatches.values()];
    return submissionDispatches.size + (codingRequest && !submissionDispatches.has(codingRequest.threadId) && !dispatches.includes(codingRequest.dispatch) ? 1 : 0);
  }
  function codingActivityOverview(active, pending, review, unread) {
    return [pending ? `${pending} pending request${pending === 1 ? '' : 's'}` : '',`${active} working`,review ? `${review} need review` : '',unread ? `${unread} unread` : ''].filter(Boolean).join(' · ');
  }
  function renderCodingRequestFeedback() {
    clearTimeout(requestFeedbackTimer);
    if (disposed) return;
    const view = codingRequestPresentation(codingRequest, performance.now(), codingRequestMessage());
    $('coding-request').hidden = !view;
    for (const [id, text] of [['coding-request-status',view?.headline],['coding-request-detail',view?.detail],['coding-request-context',view?.context],['coding-request-elapsed',view?.elapsed]]) {
      const node = $(id); if (node.textContent !== (text || '')) node.textContent = text || '';
    }
    $('coding-request-stop').disabled = !codingRequest || codingRequest.stopping;
    if (view) requestFeedbackTimer = setTimeout(renderCodingRequestFeedback, 1000);
  }
  // CODING REQUEST PRESENTATION END
  const pty = new CodingTerminal({host: $('pty-screen'), status: $('pty-status'), follow: $('pty-follow'), attach: $('pty-attach'), call, changed: frame => {
    const terminal = terminals.get(frame.threadId); if (terminal?.processId !== frame.processId) return;
    const wasRunning = terminal.running, {screen, ...metadata} = frame; Object.assign(terminal, metadata, {running: ['running', 'stopping'].includes(frame.state)}); controls(); if (wasRunning !== terminal.running) renderSidebar();
  }});
  function revokeTerminalInput(ids) {
    for (const [id, start] of pendingTerminalStarts) if (!ids || ids.includes(id)) start.cancelled = true;
    for (const [id, terminal] of terminals) if (!ids || ids.includes(id)) terminal.inputGranted = false;
    if (!ids || ids.includes(selectedId)) pty.revoke();
  }
  const worktreeCall = (action, input = {}, cancellation) => native({op: 'codingWorktrees', input: {action, ...input}}, cancellation);
  function cancelWorktreeMutation() {
    worktreeEpoch++;
    if (worktreeMutation) {worktreeMutation.cancelled = true; invalidateWorktreeGit(worktreeMutation); worktreesLoaded = false;}
    else if (worktreesBusy) {for (const record of worktrees.values()) invalidateWorktreeGit(record); worktreesLoaded = false;}
    controls();
  }
  const scheduleCall = (action, input = {}, cancellation) => native({op: 'codingSchedules', input: {action, ...input}}, cancellation);
  const gitCall = (action, input = {}, cancellation) => native({op: 'codingGit', input: {action, ...input}}, cancellation);
  function cancelScheduleMutations(id) {scheduleRevision++; for (const token of scheduleMutations) if (!id || token.id === id) token.cancelled = true;}
  function clearStopNotice() {
    stopResultEligible = false;
    if (stopNotice) {const previous = stopNotice;stopNotice = '';banner('notice', '');if ($('worktrees-notice').textContent === previous) banner('worktrees-notice', '');}
  }
  async function act(fn, notice = 'notice', {userAction = true} = {}) {
    if (acting) return;
    if (userAction) clearStopNotice();
    acting = true; banner(notice, ''); controls();
    try {await fn();} catch (error) {banner(notice, message(error));}
    finally {acting = false; controls();}
  }
  let sidebarReturnFocus = null;
  function sidebar(open) {
    const side = $('sidebar'), wasOverlay = side.getAttribute('aria-modal') === 'true';
    const narrow = matchMedia('(max-width:850px)').matches;
    if (open !== undefined) document.body.classList.toggle(narrow ? 'sidebar-open' : 'sidebar-hidden', narrow ? open : !open);
    const expanded = narrow ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-hidden');
    const overlay = narrow && expanded;
    if (!narrow) document.body.classList.remove('sidebar-open');
    $('sidebar-toggle').setAttribute('aria-expanded', String(expanded)); $('sidebar-shade').hidden = !overlay;
    side.inert = !expanded;
    for (const node of document.querySelectorAll('body > main, body > aside:not(#sidebar)')) node.inert = overlay;
    if (overlay) {
      side.setAttribute('role', 'dialog'); side.setAttribute('aria-modal', 'true');
      if (!wasOverlay) sidebarReturnFocus = side.contains(document.activeElement) ? $('sidebar-toggle') : document.activeElement;
      if (!side.contains(document.activeElement) && !document.querySelector('dialog[open]')) $('close-sidebar').focus();
    } else {
      side.removeAttribute('role'); side.removeAttribute('aria-modal');
      if (wasOverlay && open === false || !expanded && side.contains(document.activeElement)) {
        [sidebarReturnFocus, $('sidebar-toggle')].find(node => node?.isConnected && !node.disabled && !node.closest('[inert],[hidden]') && node.getClientRects().length)?.focus();
      }
      sidebarReturnFocus = null;
    }
  }
  // SKILL UI START
  const codingSkillProjects = new Map(), codingSkillRequests = new Set();
  let codingSkillsComponent = null, codingSkillsHost = null, codingSkillsOpen = false, codingSkillsScope = '', codingSkillsGeneration = 0;
  function codingSkillsContext() {
    const thread = current(), threadId = selectedId, cwd = typeof thread?.cwd === 'string' ? thread.cwd : '';
    const verified = !!threadId && codingSkillProjects.get(threadId) === cwd;
    const submission = !!submissionStore.current(threadId) || submissionDispatches.has(threadId);
    const busy = acting || threadReads.has(threadId) || !!activeTurn(thread) || familyBusy(threadId) || familyStopping(threadId) || waiting(threadId) || submission;
    let unavailableReason = '';
    if (!bridge || disposed) unavailableReason = 'Native task skill discovery is unavailable.';
    else if (!thread || !verified || thread.metadataPending || thread.draftReadError || thread.missingDraft) unavailableReason = 'Refresh this task’s history to verify its project before inspecting or inserting skills.';
    else if (thread.historyOnly || childChat(thread)) unavailableReason = 'This task is read-only. Skill text can be inspected but cannot be inserted.';
    else if (thread.archived) unavailableReason = 'Unarchive this task before inserting skill text.';
    else if (busy) unavailableReason = submission ? 'Resolve the pending or unconfirmed submission before inserting skill text.' : 'Wait for the current task action to finish before inserting skill text.';
    else if (checkoutNotice(cwd)) unavailableReason = 'Resolve this project’s checkout state before inserting skill text.';
    return {threadId, cwd, busy, canInsert: !unavailableReason && directInput(thread), unavailableReason};
  }
  function invalidateCodingSkills(kind = 'change') {
    codingSkillsGeneration++;
    for (const request of codingSkillRequests) request.cancelled = true;
    if (codingSkillsComponent) {
      if (kind === 'close' || !codingSkillsOpen) codingSkillsComponent.close();
      else if (kind === 'stop') codingSkillsComponent.stop();
      else codingSkillsComponent.change();
      // Queue clear before any later inventory read; an old clear must not erase a newer snapshot.
      if (bridge && !disposed) void native({op: 'codingSkills', input: {action: 'clear'}}).catch(() => {});
    }
  }
  function syncCodingSkillsScope() {
    const thread = current(), key = JSON.stringify([selectedId, thread?.cwd || '', codingSkillProjects.get(selectedId) || '']);
    if (key === codingSkillsScope) return;
    codingSkillsScope = key;clearImagePreviews(); clearCodingFilePreview(); invalidateCodingSkills('change');
  }
  async function codingSkillsNative(body) {
    const scope = codingSkillsContext();
    if (!codingSkillsOpen || disposed || !bridge || !scope.threadId || !scope.cwd || scope.busy || codingSkillProjects.get(scope.threadId) !== scope.cwd || body?.op !== 'codingSkills' || !['list', 'preview'].includes(body.input?.action) || body.input.threadId !== scope.threadId) throw Error('Refresh the selected task’s history and wait for current actions before inspecting skills.');
    const request = {cancelled: false}, generation = codingSkillsGeneration; codingSkillRequests.add(request);
    try {
      const result = await native(body, request), now = codingSkillsContext();
      if (request.cancelled || generation !== codingSkillsGeneration || !codingSkillsOpen || disposed || now.threadId !== scope.threadId || now.cwd !== scope.cwd) throw Error('The task or skill view changed. Refresh skills explicitly.');
      return result;
    } finally {codingSkillRequests.delete(request);}
  }
  function insertCodingSkill(snapshot) {
    submissionStore.refresh();
    const context = codingSkillsContext(), prompt = $('prompt');
    if (!codingSkillsOpen || disposed || !context.canInsert || context.busy || !snapshot || snapshot.threadId !== context.threadId || snapshot.cwd !== context.cwd || prompt.disabled) throw Error('The selected task cannot accept this reviewed snapshot. Nothing was inserted.');
    const draft = prompt.value, next = codingSkillDraft(draft, snapshot);
    const saved = {...preferences, selectedId, drafts: {...preferences.drafts, [selectedId]: next}};
    // Commit storage before changing either draft. A quota/serialization error leaves text and caret intact.
    try {if(!persistPreferences(saved))throw Error('Draft storage unavailable.');}
    catch {throw Error('The reviewed text could not be saved. The draft and caret were kept; nothing was inserted.');}
    const start = prompt.selectionStart, end = prompt.selectionEnd, direction = prompt.selectionDirection, scroll = prompt.scrollTop;
    preferences.drafts[selectedId] = next; preferences.selectedId = selectedId; prompt.value = next;
    if (Number.isInteger(start) && Number.isInteger(end)) prompt.setSelectionRange(start, end, direction || 'none');
    resizePrompt();prompt.scrollTop = scroll; banner('storage-notice', ''); controls();
    return {inserted: true};
  }
  function codingSkillsControlState() {
    syncCodingSkillsScope();
    if (!codingSkillsHost || !codingSkillsComponent) return;
    const scope = codingSkillsContext(), pending = codingSkillsHost.getAttribute('aria-busy') === 'true';
    const status = codingSkillsHost.querySelector('[role="status"]')?.dataset.state;
    for (const button of codingSkillsHost.querySelectorAll('button[data-action]')) {
      const action = button.dataset.action;
      button.disabled = !codingSkillsOpen || disposed || !bridge || pending || scope.busy || (action === 'insert' ? !scope.canInsert || ['inserted', 'unconfirmed'].includes(status) : !scope.threadId || !scope.cwd || codingSkillProjects.get(scope.threadId) !== scope.cwd);
    }
  }
  globalThis.SalehCodingTaskSkills = Object.freeze({
    mount(host) {
      if (codingSkillsHost === host && codingSkillsComponent) return;
      codingSkillsHost = host;
      if (typeof globalThis.SalehCodingSkills?.create !== 'function') {host.textContent = 'Task skill preview is unavailable. Your draft is unchanged.'; return;}
      codingSkillsComponent = globalThis.SalehCodingSkills.create({host, native: codingSkillsNative, getContext: codingSkillsContext, onInsert: insertCodingSkill});
      codingSkillsComponent.close();
    },
    open() {codingSkillsOpen = true; syncCodingSkillsScope(); codingSkillsComponent?.change(); codingSkillsControlState();},
    close() {if (!codingSkillsOpen) return; codingSkillsOpen = false; invalidateCodingSkills('close');},
    stop() {invalidateCodingSkills('stop'); clearCodingFilePreview();}
  });
  // SKILL UI END

  function controls() {
    // CODING REQUEST FEEDBACK BEGIN
    renderCodingRequestFeedback();
    // CODING REQUEST FEEDBACK END
    const thread = current(), turn = activeTurn(thread), terminal = terminals.get(selectedId);
    $('thread-title').textContent = thread ? title(thread) : 'Tasks';
    const submission = submissionStore.current(selectedId) || (submissionDispatches.has(selectedId) ? {phase: 'preparing'} : null);
    const sync = workspaceFor(selectedId), stopThreadId = workspaceStopTarget(selectedId), editable = !!bridge && directInput(thread), writable = editable && engine.available !== false && !checkoutNotice(thread?.cwd), workReady = writable && !workspaceBlocked(selectedId), stopAvailable = !!thread && (queueHasPending(selectedId) || submissionDispatches.get(selectedId)?.queue || familyBusy(selectedId) || subtreeIds(selectedId).some(pendingQuestion) || familyStopping(stopThreadId) || workspaceBlocked(selectedId));
    for (const id of ['new-project', 'welcome-project', 'configure-provider']) $(id).disabled = !bridge || acting || setupBlocking();
    $('refresh').disabled = !bridge || acting || listState === 'loading';
    $('refresh').title = listState === 'loading' ? 'Loading saved chats…' : acting ? 'Wait for the current request to finish' : 'Refresh chats';
    $('refresh').setAttribute('aria-label', $('refresh').title); $('refresh').setAttribute('aria-busy', String(listState === 'loading'));
    $('execution-mode').disabled = !bridge || acting || setupBlocking();
    $('new-chat').disabled = !bridge || !thread?.cwd || !canStartWork(thread) || acting || setupBlocking() || $('provider').value === 'local' && !modelEligibility(localModels, newModel, 'coding').ready;
    $('new-tools-task').disabled = !bridge || !mcpSetup || acting;
    for (const id of ['rename-chat', 'fork-chat', 'archive-chat', 'reclaim-guest-disk', 'changes-toggle', 'terminal-toggle']) $(id).disabled = !bridge || !thread || acting;
    $('failed-guest-storage').disabled = !bridge || acting;
    $('failed-startups').disabled = !bridge || acting || setupBlocking() || storageBlocked || attachmentReads.size>0 || attachmentStorage.busy;
    for (const id of ['rename-chat', 'fork-chat', 'archive-chat', 'reclaim-guest-disk']) if (!ownedChat(thread)) $(id).disabled = true;
    $('browse-history').disabled=!bridge||!thread||historyPending(thread);
    $('cloud-connection').hidden=!managedCloudChat(thread);$('cloud-connection').disabled=!bridge||acting||!managedCloudChat(thread);
    $('terminal-toggle').disabled = !bridge || !thread || !!thread.metadataPending;
    if (thread?.historyOnly) $('changes-toggle').disabled = true;
    if (checkoutNotice(thread?.cwd) || workspaceBlocked(selectedId)) $('fork-chat').disabled = true;
    if (setupBlocking()) $('fork-chat').disabled = true;
    $('archive-chat').textContent = thread?.archived ? 'Unarchive chat' : 'Archive chat';
    $('prompt').disabled = !editable;
    $('composer-attach').disabled=!editable||setupBlocking()||storageBlocked||attachmentReads.has(selectedId);
    const queueing=composeUsesQueue(thread),queueView=followupStates.get(selectedId);
    const taskMode=taskModeFor(selectedId);$('task-mode').value=taskMode??'';
    $('task-mode').disabled=!editable||acting||storageBlocked||setupBlocking()||!!turn&&!queueing||taskMode===null;
    $('task-mode-hint').hidden=!thread;
    $('task-mode-hint').textContent=taskMode===null?'Saved task mode could not be read. It is preserved; sending is paused.':turn&&!queueing?'Steering keeps the running turn’s mode. Choose Queue next to change it.':taskMode==='plan'?'Next message: plan with read-only model tools. Connected tools stay off. Choose Build and send to implement.':'Next message: build with the tool access selected above.';
    $('effort').disabled = !editable || !!turn && !queueing || acting;
    $('send').disabled = queueing && (!!queueView?.blocked || !!queueView?.error) || !queueing && !turn && queueView?.group?.active && queueHasPending(selectedId) || !workReady || acting || setupBlocking() || !!submission || threadReads.has(selectedId) || !!thread?.draftReadError || storageBlocked || attachmentReads.has(selectedId) || (!$('prompt').value.trim() && !preferences.attachmentDrafts?.[selectedId]?.length) || !codingModelState(thread, $('effort').value).ready;
    $('send').textContent = submission?.phase === 'waiting' ? ({queue:'Saving…',steer:'Steering…',send:'Sending…'})[submission.record.operation] : queueing ? 'Queue' : turn ? 'Steer' : 'Send';
    if(taskMode===null)$('send').disabled=true;
    $('stop').hidden = !stopAvailable; $('stop').disabled = !stopAvailable || familyStopping(stopThreadId);
    $('stop').setAttribute('aria-label', `Stop ${title(threads.get(stopThreadId))}`);
    $('review-changes').disabled = !workReady || !!turn || acting || !codingModelState(thread, 'none').ready;
    $('refresh-changes').disabled = !thread || thread.historyOnly || acting || !!checkoutNotice(thread.cwd);
    $('terminal-run').disabled = !workReady || !!terminal?.running || acting || !$('terminal-command').value.trim();
    $('terminal-shell').disabled = !workReady || !!terminal?.running || acting; pty.availability(writable);
    $('terminal-command').disabled = !editable; $('terminal-input').disabled = !editable;
    $('terminal-stop').disabled = !terminal?.running || !!terminal?.stopRequested;
    $('terminal-write').disabled = !writable || !terminal?.running || terminal.stopRequested || terminal.mode === 'pty' || acting || !$('terminal-input').value;
    $('thread-execution-mode').textContent = !thread ? '' : thread.metadataPending ? 'Execution mode unavailable · refresh history' : thread.executionMode === 'native' ? 'Native macOS' : thread.historySource === 'legacy' ? 'Saved history — execution unavailable' : 'Virtual machine';
    if (thread?.executionMode === 'native') $('reclaim-guest-disk').disabled = true;
    $('reclaim-guest-disk').title = thread?.executionMode === 'native' ? 'Native macOS chats do not allocate a guest disk.' : '';
    $('thread-provider').textContent = localThread(thread) ? 'Local model' : 'Cloud model';$('thread-provider').classList.toggle('sr-only',localThread(thread));
    const last = childChat(thread) ? codingOwnResultTurns(thread).at(-1) : thread?.turns?.at(-1);
    $('run-status').textContent = !bridge ? 'Native app required' : !thread ? 'Choose a project' : thread.archived ? 'Archived' : thread.draftReadError ? 'Draft · refresh to check chat' : historyPending(thread) ? 'Loading saved history…' : thread.historySource === 'creation-receipt' ? 'Saved empty chat' : thread.historyOnly ? 'Saved history' : thread.pendingMaterialization ? 'Unsent draft' : thread.localStopped ? 'Stopped · checking engine state' : waitingAnswer(selectedId) ? 'Waiting for your answer' : working(thread) ? (waiting(selectedId) ? 'Waiting for approval' : 'Working…') : familyBusy(selectedId) ? 'Agents working…' : last ? outcome(last) : 'Ready';
    $('composer-hint').textContent = thread?.draftReadError ? 'Refresh history to check this chat' : historyPending(thread) ? 'Checking saved chat…' : thread?.historyOnly || childChat(thread) ? 'Read-only history · messages cannot be sent' : 'Enter to send · Shift Enter for a new line';
    if (thread && submission) $('run-status').textContent = submission.phase === 'preparing' ? 'Preparing message' : submission.phase === 'waiting' ? 'Waiting for submission acknowledgement' : 'Submission outcome unconfirmed';
    if (thread && sync && (workspaceBlocked(selectedId) || !submission && !working(thread) && !familyBusy(selectedId))) $('run-status').textContent = sync.message || ({waiting:'Waiting to save workspace changes.',publishing:'Saving workspace changes.',failed:'Workspace synchronization failed.',complete:'Workspace changes saved.',cancelled:'Workspace synchronization stopped.'})[sync.state];
    $('child-notice').hidden = !childChat(thread) && !thread?.metadataPending && !thread?.historyOnly;
    $('child-notice').textContent = thread?.historySource === 'creation-receipt' ? 'No message was sent in this chat. Its creation record is saved. This chat cannot accept messages.' : thread?.historyOnly ? 'This saved chat is available for inspection only.' : childChat(thread) ? 'This agent’s history is read-only. Request further work through the parent chat.' : thread?.metadataPending ? 'Chat controls are unavailable until its metadata is loaded.' : '';
    banner('checkout-notice', checkoutNotice(thread?.cwd));
    const ids = sessionIds(), active = ids.filter(id => working(threads.get(id))).length, review = ids.filter(waiting).length, unread = ids.filter(id => preferences.unread[id]).length;
    $('session-overview').textContent = codingActivityOverview(active, pendingCodingRequestCount(), review, unread);
    $('session-overview').setAttribute('aria-pressed', String(sessionView));
    $('session-overview').setAttribute('aria-label', `${$('session-overview').textContent}. Show active and unread chats`);
    for (const button of $('approvals').querySelectorAll('button[data-decision]')) button.disabled = acting;
    renderQuestions(); renderModelControls();
    const worktreeActive = worktreeMutating || worktreesBusy || worktreeStopRequested, worktreeProvider = $('provider').selectedOptions[0];
    const worktreeUnavailable = worktreeActive || worktreesReadOnly, worktreeCreateUnavailable = worktreeActive || !worktreeCreateAvailable;
    $('worktrees-toggle').disabled = !bridge;
    $('worktrees-refresh').disabled = !bridge || acting;
    $('worktrees-reconnect').hidden = !worktreeReconnectAvailable;
    $('worktrees-reconnect').disabled = !bridge || acting || worktreeActive || !worktreeReconnectAvailable;
    $('worktree-choose-source').disabled = !bridge || acting || worktreeCreateUnavailable;
    $('worktree-ref').disabled = acting || worktreeCreateUnavailable;
    $('worktree-copy-changes').disabled = !bridge || acting || worktreeCreateUnavailable;
    $('worktree-create').disabled = !bridge || acting || worktreeCreateUnavailable || !worktreeSource || !$('worktree-ref').value.trim();
    $('worktree-stop').hidden = !worktreeActive; $('worktree-stop').disabled = !bridge || worktreeStopRequested;
    $('worktree-stop').textContent = worktreeStopRequested ? 'Stopping…' : 'Stop worktree operation';
    $('worktrees-provider').textContent = `Open new chats with ${worktreeProvider?.textContent || 'Local models'} ${$('execution-mode').value === 'native' ? 'directly on macOS' : 'in a virtual machine'}. Change the provider and execution mode in Settings.`;
    for (const button of $('worktrees-list').querySelectorAll('button[data-worktree-open]')) button.disabled = !bridge || acting || setupBlocking() || worktreeActive || !worktreeOpenAvailable || !worktreesLoaded || worktrees.get(button.dataset.worktreeOpen)?.state !== 'ready' || !worktreeProvider || worktreeProvider.disabled || $('provider').value === 'local' && !modelEligibility(localModels, newModel, 'coding').ready;
    for (const button of $('worktrees-list').querySelectorAll('button[data-worktree-archive],button[data-worktree-restore]')) {
      const id = button.dataset.worktreeArchive || button.dataset.worktreeRestore;
      button.disabled = !bridge || acting || worktreeUnavailable || !worktreesLoaded || worktrees.get(id)?.state !== (button.dataset.worktreeArchive ? 'ready' : 'archived');
    }
    for (const button of $('worktrees-list').querySelectorAll('button[data-handoff-recovery]')) button.disabled = !bridge || acting || worktreeUnavailable || !worktreesLoaded || !handoffs.has(button.dataset.handoffRecoveryId);
    for (const button of $('worktrees-list').querySelectorAll('button[data-handoff-copy]')) button.disabled = !bridge || acting || worktreeActive || !worktreesLoaded || !worktreeRecoveryCopyAvailable || !handoffs.has(button.dataset.handoffCopy);
    for (const button of $('worktrees-list').querySelectorAll('button[data-worktree-handoff]')) {
      const record = worktrees.get(button.dataset.worktreeHandoff);
      button.hidden = !record || ![record.source, record.cwd].includes(thread?.cwd);
      button.textContent = thread?.cwd === record?.cwd ? 'Move this chat back' : 'Move this chat here';
      button.disabled = !bridge || acting || worktreeUnavailable || !canHandoff(record, thread);
    }
    scheduleControlState();
    gitControlState();
    renderFollowups();renderSubmission();
    renderMetrics();
    codingSkillsControlState();
    renderMCPSetup(); renderChildResult(); renderStartupRecovery(); goals?.update();
  }
  // Goals use the same draft CAS and foreground request queue as the task workspace.
  function goalContext() {
    const thread = current(), taskMode = taskModeFor(selectedId);
    const inspectable = !!bridge && engine.goals === true && ownedChat(thread) &&
      !thread.pendingMaterialization && !thread.missingDraft && !thread.metadataPending && !thread.draftReadError;
    const submission = submissionStore.current(selectedId) || submissionDispatches.has(selectedId);
    const queuePending = queueHasPending(selectedId), model = codingModelState(thread,$('effort').value);
    const blockedReason = !inspectable ? '' : storageBlocked ? 'Saved draft storage needs review before goal actions.' :
      workspaceBlocked(selectedId) || checkoutNotice(thread?.cwd) ? 'Resolve the project workspace state before continuing this goal.' :
      submission ? 'Review the pending message submission before continuing this goal.' :
      queuePending ? 'Finish or remove queued follow-ups before continuing this goal.' :
      taskMode === null ? 'The saved task mode needs review before continuing.' :
      !model.ready ? model.reason || 'The saved model must be ready before continuing.' : '';
    const canEdit = inspectable && directInput(thread) && !storageBlocked && !setupBlocking() && !workspaceBlocked(selectedId) &&
      !checkoutNotice(thread?.cwd) && !threadReads.has(selectedId) && !submission;
    return {threadId:selectedId,canInspect:inspectable,canEdit,
      canContinue:canEdit && engine.available !== false && !queuePending && !familyBusy(selectedId) &&
        !familyStopping(workspaceStopTarget(selectedId)) && taskMode !== null && model.ready,
      busy:acting,blockedReason,mode:taskMode || 'build',effort:$('effort').value === 'high' ? 'high' : 'none'};
  }
  function saveGoalDraft(id,value) {
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(id) || value !== null && !globalThis.NoieeCodingGoals.validDraft(value)) return false;
    const prior = preferences.goalDrafts || {};
    if (value !== null && !Object.hasOwn(prior,id) && Object.keys(prior).length >= 128) {
      banner('storage-notice','Saved goal drafts are full. Finish or cancel an earlier goal edit before creating another.');return false;
    }
    const next = {...preferences,goalDrafts:{...prior}};
    if (value === null) delete next.goalDrafts[id]; else next.goalDrafts[id] = structuredClone(value);
    if (!persistPreferences(next)) return false;
    preferences = next; return true;
  }
  goals = globalThis.NoieeCodingGoals.create({getContext:goalContext,call,
    getDraft:id => preferences.goalDrafts?.[id],saveDraft:saveGoalDraft,run:fn => act(fn),
    onTurn:async (id,result) => {
      if (result.turn?.id) acceptTurn(id,result.turn,true);
      await readThread(id); await readFamily(id);
      if (selectedId === id) {renderMessages();renderFamily();}
      renderSidebar();
    },onChange:controls});
  // Setup authority stays in memory and never enters saved draft/submission state.
  function selectedSetupChoice() {
    const provider = $('provider').value, option = $('provider').selectedOptions[0];
    if (!option || option.disabled || !['local','cloud'].includes(provider)) throw Error('Select an available provider in Settings.');
    const model = provider === 'local' ? newModel : engine.providers?.find(p => p.id === provider)?.model;
    if (typeof model !== 'string' || !model) throw Error('The selected provider has no verified model. Refresh Settings.');
    if (provider === 'local') {const ready = modelEligibility(localModels, model, 'coding');if (!ready.ready) throw Error(ready.reason);}
    const executionMode = $('execution-mode').value;
    if (!['native','vm'].includes(executionMode)) throw Error('Choose Native or VM execution in Settings.');
    return {provider,model,executionMode};
  }
  function renderMCPSetup() {
    if (!mcpSetup) return;
    const view = mcpSetup.view(), locked = view.blocking || view.reviewing || view.cancelling;
    $('mcp-setup-project').textContent = setupProject || 'Choose a project folder';
    $('mcp-setup-model').textContent = setupChoice ? `${setupChoice.provider === 'cloud' ? 'Cloud provider' : 'Local model'} · ${setupChoice.model} · ${setupChoice.executionMode === 'native' ? 'Native macOS' : 'Virtual machine'}` : 'Choose an available model and provider in Settings.';
    for (const id of ['mcp-setup-folder','mcp-setup-current','mcp-setup-inventory']) $(id).disabled = !bridge || acting || locked || setupInventoryReading;
    $('mcp-setup-current').disabled ||= !current()?.cwd;
    for (const input of $('mcp-setup-servers').querySelectorAll('input')) input.disabled = locked || !setupInventoryReady;
    const count = $('mcp-setup-servers').querySelectorAll('input:checked').length;
    $('mcp-setup-prepare').disabled = !bridge || acting || locked || !setupInventoryReady || !setupProject || !setupChoice || count < 1 || count > 64;
    $('mcp-setup-review').disabled = !bridge || !view.canReview;
    $('mcp-setup-inspect').disabled = !bridge || !view.canInspect;
    $('mcp-setup-cancel').disabled = !bridge || !view.canCancel;
    $('mcp-setup-cancel').textContent = view.cancelling ? 'Cancelling…' : view.status?.phase === 'created' ? 'Stop created task' : 'Cancel setup';
    $('mcp-setup-close').textContent = view.blocking ? 'Cancel and close' : 'Close';
    $('mcp-setup-close').disabled = view.cancelling;
    $('mcp-setup-receipt').hidden = !view.request;
    $('mcp-setup-identity').textContent = view.setupId ? `Setup ${view.setupId} · revision ${view.status?.revision ?? 'unconfirmed'}` : 'Setup identity pending';
    $('mcp-setup-status').textContent = view.summary;
    $('mcp-setup-notice').textContent = view.notice;$('mcp-setup-notice').hidden = !view.notice;
    $('mcp-setup-open-root').hidden = !view.status?.root;
    $('mcp-setup-open-root').disabled = acting || view.cancelling || view.reviewing;
  }
  async function refreshSetupInventory() {
    if (!mcpSetup || setupBlocking() || setupInventoryReading || $('mcp-setup').hidden) return;
    const epoch = setupPanelEpoch;setupInventoryReading = true;setupInventoryReady = false;renderMCPSetup();
    $('mcp-setup-inventory-notice').textContent = 'Reading configured tools…';
    try {
      const rows = setupAPI.inventory(await native({op:'describe'}));
      if (epoch !== setupPanelEpoch || $('mcp-setup').hidden) return;
      const host = $('mcp-setup-servers');host.replaceChildren();
      for (const row of rows) {const label = element('label'), input = element('input');input.type = 'checkbox';input.value = row.id;input.onchange = renderMCPSetup;label.append(input,document.createTextNode(`${row.id} · ${row.transport}`));host.append(label);}
      setupInventoryReady = true;$('mcp-setup-inventory-notice').textContent = rows.length ? 'Select one to 64 configured tools. This list is not a tool catalog or connection grant.' : 'No configured tools are available. Add a provider configuration before preparing a task.';
    } catch {if (epoch === setupPanelEpoch) $('mcp-setup-inventory-notice').textContent = 'Configured tool inventory could not be verified. Refresh to inspect it again.';}
    finally {setupInventoryReading = false;renderMCPSetup();}
  }
  function openMCPSetup() {
    if (!mcpSetup || acting) return;
    if (matchMedia('(max-width:850px)').matches) sidebar(false);
    clearStopNotice();$('mcp-setup').hidden = false;$('new-tools-task').setAttribute('aria-expanded','true');
    if (!setupBlocking()) {setupPanelEpoch++;setupProject = current()?.cwd || '';try {setupChoice = selectedSetupChoice();} catch (error) {setupChoice = null;$('mcp-setup-inventory-notice').textContent = message(error);}void refreshSetupInventory();}
    renderMCPSetup();$('mcp-setup-close').focus();
  }
  async function closeMCPSetup() {
    if (setupBlocking()) {await mcpSetup.cancel();if (setupBlocking()) return;}
    setupPanelEpoch++;$('mcp-setup').hidden = true;$('new-tools-task').setAttribute('aria-expanded','false');
    [$('new-tools-task'), $('sidebar-toggle')].find(node => !node.disabled && !node.closest('[inert],[hidden]') && node.getClientRects().length)?.focus();
  }
  async function recordMCPSetupRoot(root, shouldSelect) {
    const context = setupContext(), thread = root.thread;
    threads.set(thread.id,{...threads.get(thread.id),...thread,turns:threads.get(thread.id)?.turns || [],archived:false});
    setupCreatedRoots.add(thread.id);if (!listed.includes(thread.id)) listed.unshift(thread.id);renderSidebar();
    if (!shouldSelect || disposed) return;
    await readThread(thread.id);
    const latest = setupContext(), view = mcpSetup.view();
    if (disposed || view.invalidated || view.status?.phase !== 'created' || view.status?.root?.thread.id !== thread.id || latest.epoch !== context.epoch || latest.threadId !== context.threadId || latest.draft !== context.draft) return;
    archived = false;sessionView = false;await select(thread.id,{historyRead:true});
  }
  function renderMetrics() {
    const host = $('task-metrics'), thread = current(), metrics = globalThis.SalehCodingMetrics;
    if (!host) return;
    if (!thread || !metrics) {host.hidden = true; host.replaceChildren(); delete host.dataset.metricsKey; return;}
    const input = codingMetricsInput(thread, pollFailed), key = JSON.stringify([thread.id, metrics.summarize(input)]);
    host.hidden = false;
    if (host.dataset.metricsKey === key) return;
    const previous = host.querySelector('details'), focused = previous?.contains(document.activeElement);
    const details = metrics.createDetails(document, input); details.open = previous?.open === true;
    host.replaceChildren(details); host.dataset.metricsKey = key;
    if (focused) details.querySelector('summary')?.focus({preventScroll: true});
  }
  function syncMCPOutcomes() {
    const thread = current(), selected = mcpOutcomes.select(selectedId,thread?.historySource,!thread || !!thread.metadataPending);
    // A coherent history/list read may settle an earlier startup inspection failure.
    if (!selected && mcpOutcomes.current().error && !mcpOutcomes.current().loading) void mcpOutcomes.refresh();
  }
  function renderMCPOutcomes(view = mcpOutcomes.current()) {
    if (disposed || view.threadId !== selectedId) return;
    let host = $('coding-mcp-outcomes');
    if (!host) {host = element('section', 'mcp-outcomes');host.id = 'coding-mcp-outcomes';$('thread').parentNode.insertBefore(host,$('thread'));}
    const next = element('section', 'mcp-outcomes');next.id = host.id;next.dataset.threadId = view.threadId;next.setAttribute('aria-labelledby','mcp-outcomes-heading');
    const sync = () => {
      const focused=host.contains(document.activeElement);syncNode(host,next);
      if(focused&&(!host.contains(document.activeElement)||!document.activeElement.getClientRects().length))[$('mcp-outcomes-refresh'),$('workspace-quick-open'),$('prompt')].find(node=>node&&!node.disabled&&!node.closest('[hidden],[inert]')&&node.getClientRects().length)?.focus();
    };
    next.hidden = !view.threadId || view.snapshot?.available === false && !view.error;
    const rows = view.snapshot?.available === true ? view.snapshot.records : [], presented = rows.map(row => ({row,view:codingMCPOutcomePresentation(row)}));
    next.dataset.empty=String(view.snapshot?.complete===true&&rows.length===0&&view.snapshot.blocked===false&&!view.snapshot.warning&&!view.notice&&!view.error&&!view.stale&&!view.waitingForStop&&!view.loading);
    const unknown = presented.filter(item => item.view.unknown).length, uncertainDelivery = rows.filter(row => ['failed','unknown'].includes(row.delivery)).length;
    const heading = element('div','mcp-outcomes-heading'), title = element('strong','','MCP call outcomes');title.id = 'mcp-outcomes-heading';
    heading.append(title);
    if (view.legacy || view.metadataPending) {
      const status = element('p','mcp-outcomes-status',view.legacy ? 'MCP outcome records are unavailable for this legacy chat.' : current()?.draftReadError ? 'Saved MCP outcomes are unavailable while chat history cannot be verified.' : 'Checking chat history before loading saved outcomes…');status.setAttribute('role','status');next.append(heading,status);
      if (view.legacy) next.append(element('p','muted','This saved history does not establish whether earlier MCP calls ran or completed.'));
      sync();return;
    }
    const refresh = element('button','','Refresh outcomes');refresh.id = 'mcp-outcomes-refresh';refresh.type = 'button';refresh.disabled = !bridge || view.loading;refresh.onclick = () => {void mcpOutcomes.refresh();};
    heading.append(refresh);next.append(heading);
    const status = element('p','mcp-outcomes-status',view.loading ? 'Checking saved outcomes…' : view.waitingForStop ? 'Waiting for Stop to finish before checking saved outcomes…' : view.snapshot?.complete ? `${rows.length} saved ${rows.length === 1 ? 'attempt' : 'attempts'}${unknown ? ` · ${unknown} completion unknown` : ''}${uncertainDelivery ? ` · ${uncertainDelivery} delivery unconfirmed` : ''}` : 'Saved outcome evidence is unavailable or incomplete.');
    status.setAttribute('role','status');next.append(status);
    const caution = element('p','mcp-outcomes-warning');caution.id = 'mcp-outcomes-caution';
    caution.textContent = [view.waitingForStop ? 'Stop is still in progress.' : view.notice,unknown || uncertainDelivery || presented.some(item => item.view.attention) || view.error || view.stale || view.snapshot?.warning ? 'Actions may have happened; evidence may be incomplete. Verify targets before retrying.' : ''].filter(Boolean).join(' ');
    caution.hidden = !caution.textContent;next.append(caution);
    const evidence = element('details','mcp-outcomes-evidence');evidence.id = 'mcp-outcomes-evidence';evidence.dataset.key = 'mcp-outcomes-evidence';evidence.open = true;evidence.append(element('summary','','Outcome details'));
    const warning = element('p','mcp-outcomes-warning');warning.id = 'mcp-outcomes-warning';
    warning.textContent = [unknown ? 'Completion unknown: an action may have happened; verify its target before retrying.' : presented.some(item => item.view.attention) ? 'Some actions may have happened. Verify their targets before retrying.' : '',view.notice,view.error,view.snapshot?.warning || '',view.stale ? 'Showing last known evidence; it may be incomplete.' : ''].filter(Boolean).join(' ');
    warning.hidden = !warning.textContent;evidence.append(warning);
    const details = element('details','mcp-outcomes-details');details.id = 'mcp-outcomes-details';details.dataset.key = 'mcp-outcomes-list';details.append(element('summary','',rows.length ? `Inspect ${rows.length} ${rows.length === 1 ? 'call receipt' : 'call receipts'}` : view.snapshot?.complete ? 'No saved MCP call attempts for this task' : 'No verified complete receipt list'));
    const list = element('ol','mcp-outcomes-list');
    const timestamp = value => value === null ? 'Not recorded' : new Date(value).toISOString();
    for (const {row,view:description} of presented.sort((a,b) => b.row.createdAt - a.row.createdAt || a.row.attemptId.localeCompare(b.row.attemptId))) {
      const item = element('li','mcp-outcome');item.dataset.key = row.attemptId;item.dataset.attention = String(description.attention);
      item.append(element('strong','mcp-outcome-tool',`${row.server} · ${row.name}`));
      const facts = element('dl','mcp-outcome-facts');
      for (const [label,value] of [['Provider',description.provider],['Engine delivery',description.delivery],['Recorded',timestamp(row.createdAt)],['Turn / call',`${row.turnId} / ${row.callId}`],['Receipt',row.attemptId]]) facts.append(element('dt','',label),element('dd','',value));
      item.append(facts,element('p','',description.detail),element('p','muted',description.deliveryDetail),element('p','muted',description.persistence));list.append(item);
    }
    details.append(list,element('p','muted','These records do not restore approvals or connections. Refresh only reads saved evidence; it never resends a call.'));evidence.append(details);next.append(evidence);
    const changedTask = host.dataset.threadId !== view.threadId;sync();if (changedTask) {host.scrollTop = 0;const disclosure = $('mcp-outcomes-details');if (disclosure) disclosure.open = false;const expanded = $('mcp-outcomes-evidence');if (expanded) expanded.open = true;}
  }
  // FOLLOW-UP QUEUE BEGIN
  const followupStates=new Map(),followupReads=new Map();
  const followupCall=(action,input={},cancellation)=>native({op:'codingQueue',input:{action,...input}},cancellation);
  const followupEnabled=(thread=current())=>engine.followupQueue===true&&!!thread&&directInput(thread)&&!thread.pendingMaterialization&&!thread.missingDraft;
  const queueHasPending=id=>followupStates.get(id)?.group?.items.some(item=>['queued','claimed','acknowledged','unknown'].includes(item.status))===true;
  function composeUsesQueue(thread=current()){return followupEnabled(thread)&&$('followup-mode').value==='queue'&&(!!activeTurn(thread)||familyBusy(thread.id)||queueHasPending(thread.id));}
  function taskModeFor(id){const modes=preferences.taskModes,value=modes===undefined?'build':modes&&typeof modes==='object'&&!Array.isArray(modes)?Object.hasOwn(modes,id)?modes[id]:'build':null;return ['build','plan'].includes(value)?value:null;}
  function changeTaskMode(mode){
    const previous=taskModeFor(selectedId),refuse=()=>{$('task-mode').value=previous??'';return false;};
    if(!directInput(current())||storageBlocked||acting||setupBlocking()||previous===null||!['build','plan'].includes(mode))return refuse();
    if(!Object.hasOwn(preferences.taskModes??{},selectedId)&&Object.keys(preferences.taskModes??{}).length>=4096){banner('notice','Saved task modes are full. Existing choices and drafts are kept.');return refuse();}
    const next={...preferences,taskModes:{...preferences.taskModes,[selectedId]:mode}};
    if(!persistPreferences(next))return refuse();preferences=next;controls();return true;
  }
  async function queueDraftHash(draft,files,effort,mode='build'){if(!['build','plan'].includes(mode))throw Error('Invalid task mode. Your draft is kept.');const bytes=new TextEncoder().encode(JSON.stringify(mode==='build'?[draft,files,effort]:[draft,files,effort,mode]));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');}
  function installFollowupView(id,view){
    const group=view?.group,states=['queued','claimed','acknowledged','completed','failed','interrupted','unknown','removed'];
    if(typeof view?.blocked!=='boolean'||typeof view.warning!=='string'||!Number.isSafeInteger(view.revision)||view.revision<0||group!==null&&(!group||group.binding?.rootThreadId!==id||typeof group.active!=='boolean'||!Number.isSafeInteger(group.revision)||group.revision<1||!Array.isArray(group.items)||group.items.length>128||group.items.some(item=>!item||typeof item.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1||!states.includes(item.status)||typeof item.text!=='string'||item.text.length>2000||!['none','high'].includes(item.effort)||Object.hasOwn(item,'mode')&&!['build','plan'].includes(item.mode)||!Array.isArray(item.attachments)||item.attachments.length>4||item.attachments.some(file=>!file||typeof file.name!=='string'||!['text','image'].includes(file.kind)))))throw Error('The saved follow-up queue could not be verified. Refresh before changing it.');
    const previous=followupStates.get(id);if(!Number.isSafeInteger(previous?.revision)||view.blocked||view.revision>=previous.revision)followupStates.set(id,view);
  }
  async function refreshFollowups(id=selectedId){
    if(disposed||!followupEnabled(threads.get(id)))return;
    if(followupReads.has(id))return followupReads.get(id);
    const work=(async()=>{try{const view=await followupCall('inspect',{threadId:id});if(!disposed)installFollowupView(id,view);}
      catch(error){if(!disposed)followupStates.set(id,{...followupStates.get(id),error:message(error)});}
      finally{followupReads.delete(id);if(!disposed)controls();}})();followupReads.set(id,work);return work;
  }
  async function confirmQueuedDraft(token){
    if(disposed||submissionStore.current(token.threadId)?.record.localId!==token.localId)return false;
    const id=token.threadId,draft=preferences.drafts[id]??'',files=draftFiles(id),effort=preferences.efforts[id]==='high'?'high':'none',mode=taskModeFor(id),fingerprint=mode===null?null:await queueDraftHash(draft,files,effort,mode);
    if(disposed||submissionStore.current(id)?.record.localId!==token.localId)return false;
    let rollback;
    if(fingerprint===token.draftHash&&(preferences.drafts[id]??'')===draft&&JSON.stringify(draftFiles(id))===JSON.stringify(files)&&(preferences.efforts[id]==='high'?'high':'none')===effort&&taskModeFor(id)===mode){
      const before=preferences,next={...preferences,drafts:{...preferences.drafts,[id]:''},attachmentDrafts:{...preferences.attachmentDrafts}};delete next.attachmentDrafts[id];
      if(!persistPreferences(next))throw Error('Follow-up saved, but the draft update could not be saved. Your draft is kept; check the queue.');
      preferences=next;rollback=()=>{preferences=before;save();};
    }
    const confirmed=submissionStore.settle(token,'confirmed');if(!confirmed)rollback?.();
    if(selectedId===id){$('prompt').value=preferences.drafts[id]??'';resizePrompt();renderDraftAttachments();}
    return confirmed;
  }
  async function reconcileQueuedSubmission(token){
    if(token?.operation!=='queue')return false;
    const result=await followupCall('read',{threadId:token.threadId,id:token.localId});
    if(result.item===null)return false;
    if(result.item?.id!==token.localId)throw Error('The saved follow-up acceptance did not match. Your draft is kept.');
    await confirmQueuedDraft(token);return true;
  }
  async function enqueueFollowup(threadId,text,draft,files,effort,dispatch,mode=taskModeFor(threadId)){
    const hash=await queueDraftHash(draft,files,effort,mode);if(dispatch.cancelled||disposed)return;
    const token=submissionStore.begin(threadId,'queue',true,hash);controls();
    try{
      const result=await followupCall('enqueue',{threadId,id:token.localId,text,attachments:files,effort,mode},dispatch);
      if(result.cancelled===true&&!result.accepted){submissionStore.settle(token,'cancelled');return;}
      if(result.accepted!==true||result.item?.id!==token.localId)throw Error('Follow-up acceptance is unconfirmed. Check the saved queue before sending again.');
      if(!disposed)installFollowupView(threadId,result);await confirmQueuedDraft(token);
    }catch(error){submissionStore.markUnknown(token,'Queue acceptance is unconfirmed. Check the saved queue; this message will not be retried automatically.');throw error;}
    finally{controls();}
  }
  function renderFollowups(){
    const id=selectedId,view=followupStates.get(id),group=view?.group,items=group?.items??[],pending=items.filter(item=>['queued','claimed','acknowledged','unknown'].includes(item.status)),unavailable=!!view?.blocked||!!view?.error;
    $('followup-mode-label').hidden=!followupEnabled()||!activeTurn(current())&&!familyBusy(id)&&!queueHasPending(id);
    $('followup-mode').disabled=acting||!followupEnabled();$('followup-mode').querySelector('[value="steer"]').disabled=!activeTurn(current());
    const savedEdit=preferences.followupEdits?.[id],editValid=savedEdit&&typeof savedEdit.id==='string'&&Number.isSafeInteger(savedEdit.revision)&&typeof savedEdit.text==='string'&&savedEdit.text.length<=20000&&['none','high'].includes(savedEdit.effort)&&(!Object.hasOwn(savedEdit,'mode')||['build','plan'].includes(savedEdit.mode));
    const host=$('followups');host.hidden=!items.length&&!view?.error&&!view?.warning&&!savedEdit;
    $('followup-summary').textContent=pending.length?pending.length+' follow-up'+(pending.length===1?'':'s')+' · '+(group.active?'next in order':'paused'):'Saved follow-ups';
    $('followup-notice').textContent=view?.error||view?.warning||pending.some(item=>item.status==='unknown')?'Queue outcome needs inspection. '+(view?.error||view?.warning||'An uncertain turn will not be sent again automatically.'):group?.active?'Continues after this chat and its agents finish, including when you leave this page.':'Paused. Review saved work, then resume explicitly.';
    $('followup-pause').hidden=!group?.active;$('followup-pause').disabled=!bridge;
    $('followup-resume').hidden=!group||group.active||!pending.some(item=>item.status==='queued');$('followup-resume').disabled=acting||unavailable||!followupEnabled()||pending.some(item=>['claimed','acknowledged','unknown'].includes(item.status));
    $('followup-refresh').disabled=!bridge||followupReads.has(id);
    const list=element('ol');list.id='followup-list';const queued=items.filter(item=>item.status==='queued');
    for(const item of items){
      const row=element('li','followup-row');row.dataset.id=item.id;row.dataset.key='followup:'+item.id;row.append(element('span','followup-text',item.text||'Attachment follow-up'),element('span','followup-state',({queued:'Queued',claimed:'Starting',acknowledged:'Working',completed:'Finished',failed:'Failed',interrupted:'Stopped',unknown:'Outcome unconfirmed',removed:'Removed'})[item.status]+(item.mode==='plan'?' · Plan':' · Build')+(item.effort==='high'?' · Deep':' · Standard')));
      if(item.attachments.length)row.append(element('span','muted',item.attachments.map(file=>file.name).join(' · ')));
      if(item.status==='queued'){
        const actions=element('div','followup-actions'),index=queued.indexOf(item);
        for(const [label,run,disabled] of [['Edit',()=>editFollowup(id,item.id),false],['Move up',()=>moveFollowup(id,item.id,-1),index===0],['Move down',()=>moveFollowup(id,item.id,1),index===queued.length-1],['Remove',()=>changeFollowup('remove',{threadId:id,id:item.id,revision:item.revision}),false]]){
          const button=element('button','',label);button.type='button';button.disabled=acting||unavailable||!followupEnabled()||disabled;button.setAttribute('aria-label',label+' follow-up '+(index+1));button.onclick=()=>act(run);actions.append(button);
        }row.append(actions);
      }
      if(item.status==='unknown'&&item.turnId){const verify=element('button','','Check saved turn');verify.type='button';verify.disabled=acting||unavailable||!followupEnabled();verify.onclick=()=>act(()=>changeFollowup('verify',{threadId:id,id:item.id,revision:item.revision}));row.append(verify);}
      list.append(row);
    }syncNode($('followup-list'),list);
    const editor=$('followup-editor');editor.hidden=!savedEdit;
    if(savedEdit){$('followup-edit-warning').textContent=editValid?'Edits are saved locally. The queue stays paused until you resume it.':'Saved edit could not be read. It is preserved; inspect it before editing.';if(editValid){if($('followup-edit-text').value!==savedEdit.text)$('followup-edit-text').value=savedEdit.text;$('followup-edit-effort').value=savedEdit.effort;$('followup-edit-mode').value=savedEdit.mode??'build';}}
    for(const control of ['followup-edit-text','followup-edit-effort','followup-edit-mode','followup-edit-save'])$(control).disabled=acting||unavailable||!editValid||storageBlocked;
  }
  async function changeFollowup(action,input){const result=await followupCall(action,input);if(!disposed)installFollowupView(input.threadId,result);controls();return result;}
  async function moveFollowup(threadId,id,delta){
    const group=followupStates.get(threadId)?.group;if(!group)return;const ids=group.items.filter(item=>item.status==='queued').map(item=>item.id),index=ids.indexOf(id),next=index+delta;if(index<0||next<0||next>=ids.length)return;
    [ids[index],ids[next]]=[ids[next],ids[index]];await changeFollowup('reorder',{threadId,revision:group.revision,ids});
  }
  async function editFollowup(threadId,id){
    if(preferences.followupEdits?.[threadId]&&preferences.followupEdits[threadId].id!==id)throw Error('Save or cancel the current queued edit before opening another message. Your edit draft is kept.');
    await changeFollowup('pause',{threadId});const result=await followupCall('read',{threadId,id}),item=result.item;
    if(item?.id!==id||item.status!=='queued'||item.textTruncated||typeof item.text!=='string')throw Error('This follow-up already started or changed. Refresh to inspect it.');
    preferences.followupEdits??={};
    if(Object.hasOwn(item,'mode')&&!['build','plan'].includes(item.mode))throw Error('Saved queued mode could not be read. It is preserved.');
    if(!preferences.followupEdits[threadId]){if(Object.keys(preferences.followupEdits).length>=128)throw Error('Saved follow-up edits are full; finish an earlier edit first.');preferences.followupEdits[threadId]={id,revision:item.revision,text:item.text,effort:item.effort,...(Object.hasOwn(item,'mode')?{mode:item.mode}:{})};}
    if(!save())throw Error('The edit could not be saved. Original queued work is kept.');if(selectedId===threadId){$('followups').open=true;renderFollowups();$('followup-edit-text').focus();}
  }
  // FOLLOW-UP QUEUE END
  function renderSubmission() {
    const state = submissionStore.current(selectedId) || (submissionDispatches.has(selectedId) ? {phase: 'preparing', inFlight: true} : null), warning = submissionStore.warning(), box = $('submission-status');
    box.hidden = !state && !warning;
    $('submission-headline').textContent = !state ? 'Submission storage unavailable' : state.phase === 'preparing' ? 'Preparing message — not yet submitted' : state.phase === 'waiting' ? `${state.record.operation === 'queue' ? 'Saving follow-up' : state.record.operation === 'steer' ? 'Steering' : 'Sending'} — waiting for acknowledgement` : 'Submission outcome unconfirmed';
    $('submission-detail').textContent = !state ? 'Review chat history before repeating an earlier message.' : state.phase === 'preparing' ? 'Preparing this chat before submitting the message. Your draft is kept.' : state.phase === 'waiting' ? 'Your draft is kept until this request is acknowledged. Engine activity may appear before its reply; no message will be retried automatically.' : `${state.reason} ${state.checking ? 'Checking saved history and engine status…' : state.checked ? 'History and task state refreshed. Review the visible history, then explicitly allow a new message if appropriate. This does not establish whether the earlier message ran.' : state.inFlight ? 'The original request is still awaiting a reply. Existing Stop controls remain available for engine-reported activity.' : 'Check task state, inspect the history, then explicitly allow a new message. This does not resend your draft.'}`;
    $('submission-storage-warning').textContent = warning; $('submission-storage-warning').hidden = !warning;
    $('submission-check').hidden = !state || state.phase !== 'unknown';
    $('submission-check').disabled = !bridge || acting || !state || state.inFlight || state.checking || state.capacity;
    $('submission-ack').hidden = !state || state.phase !== 'unknown';
    $('submission-ack').disabled = !bridge || acting || !state?.checked || state.inFlight || state.checking;
  }
  function cancelSubmissions(ids) {
    for (const [id, dispatch] of submissionDispatches) if (!ids || ids.includes(id)) dispatch.cancelled = true;
    if (!ids) submissionStore.stop();
    else for (const id of ids) {const state = submissionStore.current(id); if (state) submissionStore.markUnknown(state.record, 'Stop was requested. Any message already sent may have run. Review task state before sending again.', state.inFlight);}
  }
  async function checkSubmission() {
    const id = selectedId, token = submissionStore.current(id)?.record;
    if (!bridge || acting || !token || !submissionStore.startCheck(token)) return;
    await act(async () => {
      let checked = false;
      try {
        if(token.operation==='queue'&&await reconcileQueuedSubmission(token)){await refreshFollowups(id);return;}
        await refreshStatus();
        if (typeof engine.available !== 'boolean' || !Array.isArray(engine.activeTurns)) throw Error('Engine status could not be verified. Try checking again.');
        const thread = await readThread(id);
        if (thread?.id !== id || thread.missingDraft || thread.draftReadError) throw Error('Saved chat history could not be verified. Your draft and submission notice are retained.');
        if (!thread.pendingMaterialization) {
          const sequence = familyReadSequence;
          await readFamily(id, true);
          const family = familyFor(id);
          if (!family?.ids?.includes(id) || family.readSequence <= sequence || familyWarnings.has(family.rootThreadId)) throw Error('The chat family could not be verified. Try checking again.');
        }
        checked = selectedId === id && !disposed;
      } finally {submissionStore.finishCheck(token, checked); controls();}
    });
  }
  const outcome = codingExecutionLabel;
  let historySearchEpoch = 0, historySearchCancellation = null;
  function cancelHistorySearch(notice = '', discardResults = true) {
    if (discardResults) historySearchEpoch++; if (historySearchCancellation) historySearchCancellation.cancelled = true;
    historySearchCancellation = null; $('history-search-cancel').hidden = true;
    if (notice) $('history-search-status').textContent = notice;
  }
  async function searchHistory() {
    cancelHistorySearch(); const query = $('history-search-query').value.trim();
    $('history-search-results').replaceChildren();
    if (!query || query.length > 256) { $('history-search-status').textContent = 'Enter a word or phrase of up to 256 characters.'; return; }
    const epoch = historySearchEpoch, cancellation = historySearchCancellation = {cancelled:false};
    const currentSearch = () => !disposed && epoch === historySearchEpoch && $('history-search-dialog').open;
    const fresh = () => currentSearch() && !cancellation.cancelled;
    const warnings = new Set(), ids = new Set(); let count = 0;
    $('history-search-cancel').hidden = false; $('history-search-status').textContent = 'Searching saved task history…';
    try {
      for (const archivedSearch of [false, true]) {
        let next; const cursors = new Set();
        try {
          do {
            const result = await call('list', {searchTerm:query, archived:archivedSearch, ...(next ? {cursor:next} : {})}, cancellation);
            if (!fresh()) return;
            if (!Array.isArray(result.threads)) throw Error('Search returned no verified inventory.');
            if (result.truncated) warnings.add('Some results exceeded the display limit. Refine your query.');
            if (result.historyIncomplete) warnings.add(typeof result.historyWarning === 'string' ? result.historyWarning.slice(0,2000) : 'Some saved history is unavailable.');
            for (const thread of result.threads) {
              if (!thread || typeof thread.id !== 'string' || !/^[\w.-]{1,160}$/.test(thread.id) || typeof thread.searchSnippet !== 'string' || ids.has(thread.id)) throw Error('Search returned an invalid or duplicate result.');
              ids.add(thread.id);
              // ponytail: cap rendered previews; refine the query instead of retaining an unbounded DOM.
              if (count >= 200) {warnings.add('Showing 200 matches. Refine your query to see other results.');break;}
              const row = element('article', 'history-search-result'), heading = element('strong','',title(thread));
              const labels = [archivedSearch ? 'Archived' : 'Active', childChat(thread) ? 'Agent' : 'Chat', thread.historyOnly ? 'History only' : ''].filter(Boolean);
              row.append(heading, element('p','muted',labels.join(' · ')), element('p','history-search-path',thread.cwd || ''), element('p','history-search-snippet',thread.searchSnippet));
              const open = element('button','','Open chat'); open.type = 'button';
              open.onclick = async () => {
                if (!currentSearch()) return;
                if (!save()) {$('history-search-status').textContent = 'Your current draft could not be saved. Keep this window open and copy it before leaving this chat.';return;}
                open.disabled = true; let committed = false;
                try {
                  await readThread(thread.id);
                  threads.get(thread.id).archived = archivedSearch;
                  if (archived !== archivedSearch) {listed = listed.filter(id => id !== thread.id);renderSidebar();}
                  if (!currentSearch()) return;
                  if (!save()) {$('history-search-status').textContent = 'Your current draft could not be saved. Keep this window open and copy it before leaving this chat.';return;}
                  committed = true; globalThis.salehWorkspace.closeDialog($('history-search-dialog')); await select(thread.id, {historyRead:true});
                } catch (error) {if (currentSearch()) $('history-search-status').textContent = `Could not open this saved chat: ${message(error)}`;else if (committed && !disposed) banner('notice',message(error));}
                finally {open.disabled = false;}
              };
              const find = element('button','','Find matching message'); find.type = 'button';
              find.onclick = () => {
                if (!currentSearch()) return;
                globalThis.salehWorkspace.closeDialog($('history-search-dialog')); openSavedHistory(thread.id, query, title(thread));
              };
              row.append(open, find); $('history-search-results').append(row); count++;
            }
            next = result.nextCursor;
            if (next && (typeof next !== 'string' || cursors.has(next) || cursors.size >= 128)) throw Error('Search pagination did not advance.');
            if (next) cursors.add(next);
            $('history-search-status').textContent = `Searching… ${count} saved matches shown.`;
          } while (next && count < 200);
        } catch (error) {if (!fresh()) return;warnings.add(message(error));}
        if (count >= 200) {warnings.add('Result limit reached. Refine your query to search the remaining history.');break;}
      }
      if (fresh()) $('history-search-status').textContent = warnings.size ? `${count} saved matches shown. Search incomplete: ${[...warnings].join(' ')}` : count ? `${count} saved matches shown.` : 'No saved matches found. Try a different phrase.';
    } finally {if (fresh()) $('history-search-cancel').hidden = true;}
  }
  function renderSidebar() {
    const list = element('nav'); list.id = 'thread-list'; list.setAttribute('aria-label', 'Saved chats');
    $('list-title').textContent = sessionView ? 'Active and unread' : archived ? 'Archived projects' : 'Projects';
    $('show-archived').textContent = archived ? 'Show active chats' : 'Show archived'; $('show-archived').setAttribute('aria-pressed', String(archived));
    const query = $('search').value.toLowerCase().trim(), groups = new Map(), pinned = [], workspace = window.salehWorkspace;
    for (const id of sessionView ? sessionIds() : listed) {
      const thread = threads.get(id); if (!thread || !`${title(thread)} ${thread.cwd || ''}`.toLowerCase().includes(query)) continue;
      if (!archived && workspace?.pinned('coding', id)) {pinned.push(thread); continue;}
      const cwd = thread.cwd || 'No project folder'; if (!groups.has(cwd)) groups.set(cwd, []); groups.get(cwd).push(thread);
    }
    function appendChat(group, thread) {
      const row = element('div', `chat-row${thread.id === selectedId ? ' selected' : ''}`), button = element('button', '', title(thread));
      row.dataset.threadId = thread.id;
      button.title = `${title(thread)}${thread.cwd ? '\n' + thread.cwd : ''}`; if (thread.id === selectedId) button.setAttribute('aria-current', 'page');
      button.onclick = () => {clearStopNotice();select(thread.id).catch(error => banner('notice', message(error)));};
      row.append(button); if (workspace) row.append(workspace.pinButton('coding', thread.id, title(thread)));
      const unread = preferences.unread[thread.id], label = waiting(thread.id) ? 'Needs review' : questionLabel(thread.id) || (working(thread) ? 'Working' : familyBusy(thread.id) ? 'Agents working' : unread ? `${outcome({status: unread.status})} · unread` : '');
      if (label) {const badge = element('span', `chat-status${unread ? ' unread' : ''}`, label); row.append(badge); button.setAttribute('aria-description', label);}
      group.append(row);
    }
    if (pinned.length) {
      const group = element('section', 'project-group'); group.dataset.key = 'workspace:pinned';
      group.append(element('div', 'workspace-pinned-label', 'Pinned'));
      for (const thread of pinned) appendChat(group, thread);
      list.append(group);
    }
    for (const [cwd, chats] of groups) {
      const collapsed = !query && workspace?.collapsed(cwd), name = cwd.split('/').filter(Boolean).at(-1) || cwd;
      const group = element('section', 'project-group'), heading = element('button', 'project-heading workspace-project-toggle');
      heading.append(element('span', 'workspace-project-label', name));
      group.dataset.key = cwd; heading.type = 'button'; heading.title = cwd; heading.dataset.workspaceProject = cwd;
      heading.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} project ${cwd}`); heading.setAttribute('aria-expanded', String(!collapsed));
      heading.disabled = !!query || !workspace;
      heading.onclick = () => {
        workspace?.toggleProject(cwd);
        [...document.querySelectorAll('[data-workspace-project]')].find(node => node.dataset.workspaceProject === cwd)?.focus();
      };
      group.append(heading);
      if (!collapsed) for (const thread of chats) appendChat(group, thread);
      list.append(group);
    }
    if (!groups.size && !pinned.length) list.append(element('p', 'empty-list', listState === 'loading' ? 'Loading saved chats…' : listState === 'failed' ? 'Saved chats could not be loaded. Refresh to try again.' : query ? 'No matching chats' : sessionView ? 'No active or unread chats' : archived ? 'No archived chats' : 'No coding chats yet'));
    syncNode($('thread-list'), list); if (!query) workspace?.revealCurrent($('thread-list'), selectedId); controls();
  }
  function verifiedParent(thread) {
    const family = familyFor(thread?.id), parent = threads.get(thread?.parentThreadId);
    if (!thread || !childChat(thread) || thread.metadataPending || !parent || parent.id === thread.id || parent.metadataPending ||
        !family || familyReads.has(family.rootThreadId) || familyWarnings.has(family.rootThreadId) || invalidFamilies.has(family.rootThreadId) ||
        !family.ids.includes(thread.id) || !family.ids.includes(parent.id)) return null;
    return parent;
  }
  function renderChildResult() {
    const thread = current(), child = childChat(thread), stop = $('stop');
    $('child-result').hidden = !child;
    $('compose-area').hidden = child;
    // Keep one Stop control and its original guarded handler in both layouts.
    if (child && stop.parentElement !== $('child-actions')) $('child-actions').append(stop);
    else if (!child && stop.parentElement !== $('send').parentElement) $('send').before(stop);
    if (!child) return;
    const parent = verifiedParent(thread), id = selectedId, epoch = selectionEpoch, parentId = parent?.id;
    const result = codingChildResult(thread, {working:working(thread),stopping:familyStopping(workspaceStopTarget(id)),
      waiting:waiting(id) || waitingAnswer(id),historyPending:historyPending(thread),updatesInterrupted:pollFailed});
    $('child-result-status').textContent = `Execution · ${result.status}`;
    $('child-result-evidence').textContent = result.receiptSummary + ' ' + result.verification + '.';
    $('child-result-warning').hidden = !result.incomplete;
    $('child-result-warning').textContent = result.incomplete ? 'This view has incomplete history or live updates. Refresh Tasks before relying on its outcome.' : '';
    $('child-result-report').hidden = !result.report;
    $('child-result-report-text').textContent = result.report;
    $('child-result-report-note').hidden = !result.reportTruncated;
    $('child-parent-label').textContent = parent ? `Further work belongs in ${title(parent)}.` : 'Parent chat is unavailable. Refresh Tasks to check the agent family.';
    const button = $('return-to-parent'); button.disabled = !parent || setupBlocking();
    button.onclick = () => {
      if (disposed || selectedId !== id || selectionEpoch !== epoch || !parentId ||
          verifiedParent(current())?.id !== parentId || setupBlocking()) {
        banner('notice', 'Refresh the agent family before returning to its parent.'); return;
      }
      if (!window.salehSaveBeforeLeave()) return;
      clearStopNotice();
      const navigation = select(parentId), targetEpoch = selectionEpoch;
      navigation.then(() => {
        if (disposed || selectedId !== parentId || selectionEpoch !== targetEpoch) return;
        const target = childChat(current()) ? $('return-to-parent') : !$('prompt').disabled ? $('prompt') : $('thread');
        target.focus();
      }).catch(error => banner('notice', message(error)));
    };
  }
  function renderFamily() {
    const thread = current(), family = familyFor(selectedId), rootId = family?.rootThreadId || thread?.rootThreadId, ids = rootId ? subtreeIds(rootId) : [selectedId];
    const warning = familyWarnings.get(family?.rootThreadId || selectedId) || '';
    $('family-panel').hidden = !thread || (!childChat(thread) && ids.length < 2 && !warning);
    $('family-notice').textContent = warning; $('family-notice').hidden = !warning;
    const list = element('ul'); list.id = 'family-list';
    for (const id of new Set(ids)) {
      const member = threads.get(id); if (!member) continue;
      let depth = 0, parent = member.parentThreadId; const seen = new Set([id]);
      while (parent && !seen.has(parent)) {seen.add(parent); depth++; parent = threads.get(parent)?.parentThreadId;}
      const row = element('li', 'family-row'), button = element('button', '', title(member)); row.dataset.key = id; row.style.setProperty('--depth', Math.min(depth, 3));
      button.dataset.threadId = id; button.title = `${title(member)} · ${id}`; if (id === selectedId) button.setAttribute('aria-current', 'page');
      button.onclick = () => {clearStopNotice();select(id).catch(error => banner('notice', message(error)));};
      const unread = preferences.unread[id], status = familyStopping(id) ? 'Stopping…' : waiting(id) ? 'Needs review' : questionLabel(id) || (working(member) ? 'Working' : unread ? `${outcome({status: unread.status})} · unread` : codingOwnResultTurns(member).length ? outcome(codingOwnResultTurns(member).at(-1)) : childChat(member) ? 'No agent result yet' : 'Idle');
      const label = `${childChat(member) ? member.agentRole || 'Agent' : 'Parent chat'} · ${status}`;
      button.setAttribute('aria-description', label); row.append(button, element('span', 'family-status', label)); list.append(row);
    }
    syncNode($('family-list'), list);
    $('family-summary').textContent = `${ids.filter(id => working(threads.get(id))).length} working${ids.some(waiting) ? ' · needs review' : ''}`;
  }
  function readFamily(id, fresh = false) {
    const thread = threads.get(id); if (!id || thread?.pendingMaterialization || thread?.missingDraft) return Promise.resolve();
    const key = familyFor(id)?.rootThreadId || thread?.rootThreadId || id;
    const prior = familyReads.get(key); if (prior) {if (fresh) prior.again = true; return prior.promise;}
    const read = {again: false, sequence: ++familyReadSequence}, startCursor = cursor;
    familyReads.set(key, read);
    read.promise = (async () => {
      let next, rootId, root, stopping = false, stoppingTargets = []; const members = new Map(), seen = new Set();
      for (let page = 0; page < 20; page++) {
        const result = await call('family', {threadId: key, ...(next ? {cursor: next} : {})});
        if (!result.rootThreadId || !result.root?.id || result.root.id !== result.rootThreadId || (rootId && rootId !== result.rootThreadId)) throw Error('The engine returned inconsistent family metadata. Refresh to retry.');
        rootId = result.rootThreadId; root = result.root; stopping = !!result.stopping; stoppingTargets = Array.isArray(result.stoppingTargets) ? result.stoppingTargets : [];
        for (const member of result.threads || []) if (member.id && member.id !== rootId) members.set(member.id, member);
        if (members.size > 400) throw Error('Agent family is too large to display completely.');
        next = result.nextCursor; if (!next) break;
        if (seen.has(next) || page === 19) throw Error('Agent family pagination did not finish. Refresh to retry.'); seen.add(next);
      }
      for (const member of [root, ...members.values()]) {
        const old = threads.get(member.id), merged = {...old, ...member, rootThreadId: rootId, turns: old?.turns || member.turns || [], metadataPending: false};
        if ((old?.activitySequence ?? -1) > startCursor) merged.status = old.status;
        threads.set(member.id, merged);
        if (childChat(merged)) listed = listed.filter(value => value !== member.id);
      }
      families.set(rootId, {rootThreadId: rootId, ids: [rootId, ...members.keys()], stopping, stoppingTargets, readSequence: read.sequence});
      engine.stoppingFamilies = [...(engine.stoppingFamilies || []).filter(target => ![rootId, ...members.keys()].includes(target)), ...stoppingTargets];
      familyWarnings.delete(key); familyWarnings.delete(rootId); settleFamilyStops(); renderFamily(); renderSidebar(); renderApprovals(); controls();
      for (const member of members.values()) {const known = threads.get(member.id); if (working(known) && !known.turns?.length) readThread(member.id).catch(error => {known.historyWarning = message(error);});}
    })().catch(error => {familyWarnings.set(key, `Agent family: ${message(error)}`); renderFamily();}).finally(() => {familyReads.delete(key); if (familyFor(selectedId)?.rootThreadId === key || selectedId === key) {renderMessages(); renderChildResult();}});
    read.promise = read.promise.then(() => read.again ? readFamily(key) : undefined);
    return read.promise;
  }
  function syncNode(target, fresh) {
    if (target.nodeType === Node.TEXT_NODE) {if (target.data !== fresh.data) target.data = fresh.data; return;}
    for (const attr of [...target.attributes]) if (attr.name !== 'open' && !fresh.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    for (const attr of fresh.attributes) if (attr.name !== 'open' && target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    target.onclick = fresh.onclick;
    const key = node => node.nodeType === Node.ELEMENT_NODE ? `${node.tagName}:${node.dataset.key || node.dataset.threadId || node.dataset.turnId || node.dataset.itemId || node.className}` : node.nodeType;
    const children = [...fresh.childNodes];
    for (const [i, next] of children.entries()) {
      let prior = target.childNodes[i];
      if (!prior || key(prior) !== key(next)) {const match = [...target.childNodes].slice(i + 1).find(node => key(node) === key(next)); if (match) {target.insertBefore(match, prior || null); prior = match;} else {target.insertBefore(next, prior || null); continue;}}
      syncNode(prior, next);
    }
    while (target.childNodes.length > children.length) target.lastChild.remove();
  }
  // FILE PREVIEW START
  let codingFilePreviewRequest = null;
  function clearCodingFilePreview() {
    if (codingFilePreviewRequest) codingFilePreviewRequest.cancelled = true;
    codingFilePreviewRequest = null;
    if (bridge && !disposed) void native({op:'codingFilePreview',input:{action:'clear'}}).catch(() => {});
  }
  function codingLocalFileLink(target) {
    let path;
    try {path = decodeURIComponent(target.startsWith('<') && target.endsWith('>') ? target.slice(1,-1) : target);} catch {return null;}
    if (path.startsWith('./')) path = path.slice(2);
    if (!path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || path.startsWith('#')) return null;
    return path;
  }
  function codingFileButton(path, label = 'Preview file') {
    const button = element('button', 'copy-code', label);button.type = 'button';button.title = `Preview current file: ${path}`;
    button.setAttribute('aria-label', `Preview current file: ${path}`);
    button.onclick = async event => {
      event.preventDefault();
      const thread = current(), threadId = selectedId, cwd = thread?.cwd;
      if (!bridge || disposed || !threadId || !cwd || codingSkillProjects.get(threadId) !== cwd || thread.metadataPending || thread.draftReadError) {banner('notice','Refresh this task’s history to verify its project before previewing a file.');return;}
      clearCodingFilePreview();const request = {cancelled:false};codingFilePreviewRequest = request;const clicked = event.currentTarget || button;clicked.disabled = true;
      try {await native({op:'codingFilePreview',input:{action:'open',threadId,path}},request);}
      catch (error) {if (!request.cancelled && !disposed && selectedId === threadId && current()?.cwd === cwd) banner('notice',message(error));}
      finally {clicked.disabled = false;}
    };
    return button;
  }
  // FILE PREVIEW END
  function inlineText(parent, text, allowFilePreview=true) {
    for (const part of String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:<[^>\n]+>|[^\s)]+)\))/g)) {
      const link = part.match(/^\[([^\]]+)\]\((<[^>\n]+>|[^\s)]+)\)$/);
      if (link && /^https?:\/\//.test(link[2])) {const node = element('a', '', link[1]); node.href = link[2]; node.target = '_blank'; node.rel = 'noopener noreferrer'; parent.append(node);}
      else if (allowFilePreview && link && codingLocalFileLink(link[2])) parent.append(codingFileButton(codingLocalFileLink(link[2]),`Preview ${link[1]}`));
      else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) parent.append(element('strong', '', part.slice(2, -2)));
      else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(element('code', '', part.slice(1, -1)));
      else parent.append(document.createTextNode(part));
    }
  }
  async function copyText(button, text) {
    try {await navigator.clipboard.writeText(text); button.textContent = 'Copied';}
    catch {banner('notice', 'Copy was blocked. Select the text and copy it manually.');}
  }
  function formatContent(parent, text, allowFilePreview=true) {
    // Safe text blocks, tables and fenced code. Model-provided HTML is never executed.
    const cells = value => value.trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim());
    const separator = value => typeof value === 'string' && value.includes('|') && cells(value).length > 0 && cells(value).every(value => /^:?-{3,}:?$/.test(value));
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length;) {
      const line = lines[i]; if (!line.trim()) {i++; continue;}
      const fence = line.match(/^\s*(`{3,})([^`]*)$/);
      if (fence) {
        const language = fence[2].trim().slice(0, 40), body = []; i++;
        while (i < lines.length && !new RegExp('^\\s*`{' + fence[1].length + ',}\\s*$').test(lines[i])) body.push(lines[i++]);
        const closed = i < lines.length; if (closed) i++;
        const raw = body.join('\n') + (closed && body.length ? '\n' : '');
        const block = element('div', 'code-block'), bar = element('div', 'code-heading'), copy = element('button', 'copy-code', 'Copy code');
        copy.type = 'button'; copy.onclick = event => copyText(event.currentTarget, raw);
        const pre = element('pre'); pre.dir = 'ltr'; pre.tabIndex = 0; pre.setAttribute('aria-label', language ? `${language} code` : 'Code block'); pre.append(element('code', '', raw));
        bar.append(element('span', 'code-language', language || 'Code'), copy); block.append(bar, pre); parent.append(block); continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {const node = element('h' + Math.min(4, Math.max(2, heading[1].length))); inlineText(node, heading[2], allowFilePreview); parent.append(node); i++; continue;}
      if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {parent.append(element('hr')); i++; continue;}
      if (line.includes('|') && separator(lines[i + 1])) {
        const wrap = element('div', 'table-scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Table');
        const table = element('table'), head = element('thead'), body = element('tbody'), headingRow = element('tr');
        for (const value of cells(line)) {const cell = element('th'); cell.scope = 'col'; inlineText(cell, value, allowFilePreview); headingRow.append(cell);}
        head.append(headingRow); i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {const row = element('tr'); for (const value of cells(lines[i++])) {const cell = element('td'); inlineText(cell, value, allowFilePreview); row.append(cell);} body.append(row);}
        table.append(head, body); wrap.append(table); parent.append(wrap); continue;
      }
      if (/^>\s?/.test(line)) {const quote = element('blockquote'), body = []; while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, '')); inlineText(quote, body.join('\n'), allowFilePreview); parent.append(quote); continue;}
      const list = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/);
      if (list) {const tag = list[2] ? 'ol' : 'ul', node = element(tag); if (tag === 'ol') node.start = Number(list[2]); while (i < lines.length) {const item = lines[i].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/); if (!item || (item[2] ? 'ol' : 'ul') !== tag) break; const li = element('li'); inlineText(li, item[3], allowFilePreview); node.append(li); i++;} parent.append(node); continue;}
      const paragraph = element('p'), body = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^\s*(?:#{1,6}\s|`{3,}|>\s?|[-+*]\s|\d+\.\s|---+\s*$)/.test(lines[i]) && !(lines[i].includes('|') && separator(lines[i+1]))) body.push(lines[i++]);
      inlineText(paragraph, body.join('\n'), allowFilePreview); parent.append(paragraph);
    }
  }
  function receipt(key, label, text, openKeys) {
    const details = element('details', 'receipt'); details.dataset.key = key; details.open = openKeys.has(key);
    const pre = element('pre', '', text); pre.tabIndex = 0; details.append(element('summary', '', label), pre); return details;
  }
  function codingFileChangeReceipt(key, item, openKeys, allowFilePreview=true) {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const details = receipt(key, `File changes · ${item.status || 'requested'}`, changes.map(change => `${change.path}\n${change.diff || ''}`).join('\n\n') || JSON.stringify(item, null, 2), openKeys);
    const files = element('div');
    for (const change of changes) if (allowFilePreview && typeof change.path === 'string' && change.path.length && change.path.length <= 4096) files.append(codingFileButton(change.path, `Preview ${change.path}`));
    if (files.childElementCount) details.append(files);
    return details;
  }
  function savedMessageText(item) {
    return item.type==='userMessage'?(Array.isArray(item.content)?item.content:[]).map(part=>typeof part?.text==='string'?part.text:'').filter(Boolean).join('\n'):['agentMessage','plan'].includes(item.type)&&typeof item.text==='string'?item.text:'';
  }
  function codingAgentReceipt(key, item, thread, openKeys, view, allowNavigation = true) {
    const labels = {started:'Agent started', interacted:'Agent updated', completed:'Agent finished'};
    const details = receipt(key, labels[item.kind] || 'Agent activity', JSON.stringify(item, null, 2), openKeys);
    const verified = () => {
      const family = familyFor(thread.id), child = threads.get(item.agentThreadId);
      return family && !familyReads.has(family.rootThreadId) && !familyWarnings.has(family.rootThreadId) && !invalidFamilies.has(family.rootThreadId) && family.ids.includes(thread.id) && family.ids.includes(child?.id) && child?.parentThreadId === thread.id && !child.metadataPending && childChat(child);
    };
    if (!view && allowNavigation && verified()) {
      const open = element('button', 'copy-code', 'Open agent'); open.type = 'button';
      open.onclick = () => {
        if (disposed || selectedId !== thread.id || !verified()) {banner('notice', 'Refresh the agent family before opening this result.'); return;}
        if (!window.salehSaveBeforeLeave()) return;
        clearStopNotice(); select(item.agentThreadId).catch(error => banner('notice', message(error)));
      };
      details.append(open);
    }
    return details;
  }
  function renderTurns(messages,thread,openKeys,view=null,inheritedContext=false) {
    let inherited = null;
    for (const turn of thread.turns || []) {
      if (turn.status === 'inheritedStopped' && !inheritedContext) {
        if (!inherited) {
          const details = element('details', 'inherited-context'), label = element('summary');
          details.dataset.key = `inherited:${thread.id}:${turn.id}`; details.open = openKeys.has(details.dataset.key);
          details.append(label, element('p', 'muted', 'Copied parent context. Its saved stopped marker does not describe this agent’s outcome.'));
          inherited = {details,label,count:0}; messages.append(details);
        }
        inherited.label.textContent = `Inherited parent context · ${++inherited.count} turn${inherited.count === 1 ? '' : 's'}`;
        if (view?.matchItem && turn.items?.includes(view.matchItem)) inherited.details.open = true;
        renderTurns(inherited.details,{...thread,turns:[turn]},openKeys,view,true);
        continue;
      }
      inherited = null;
      const section = element('section', 'turn'); section.dataset.turnId = turn.id;
      for (const item of turn.items || []) {
        const key = `${turn.id}:${item.id}`;
        if (['userMessage', 'agentMessage'].includes(item.type) || item.type === 'plan' && typeof item.text === 'string') {
          const user = item.type === 'userMessage';
          const text = savedMessageText(item);
          const whitespace = item.type === 'agentMessage' && !text.trim();
          // Display only; the final whitespace-only response stays visible and copyable.
          if (!whitespace || turn.status !== 'inProgress' && item === turn.items.findLast(other => other.type === 'agentMessage')) {
            const article = element('article', `message ${user ? 'user' : 'assistant'}`), content = element('div', 'content'); content.dir = 'auto'; article.dataset.itemId = item.id;
            if(item===view?.matchItem){article.classList.add('history-match');article.tabIndex=-1;article.setAttribute('aria-label','Matching message');}
            article.append(element('div', 'message-label', inheritedContext ? user ? 'You · inherited parent context' : 'Parent · inherited model output' : user ? 'You' : item.type === 'plan' ? 'Proposed plan · model output' : 'Assistant · model output'));
            if (whitespace) content.append(element('p', 'muted', 'The model returned only whitespace.')); else formatContent(content, text, !view && !inheritedContext); article.append(content);
            if(user)for(const [index,part] of (Array.isArray(item.content)?item.content:[]).filter(part=>['image','localImage'].includes(part.type)).entries())article.append(savedImageCard(thread.id,turn.id,item.savedImageItemId??item.id,index,part.image,view));
            if (!user && text) {const copy = element('button', 'message-copy', item.type === 'plan' ? 'Copy plan' : 'Copy message'); copy.onclick = event => copyText(event.currentTarget, text); article.append(copy);} section.append(article);
          }
        } else if (item.type === 'reasoning') {
          const text = [...(Array.isArray(item.summary)?item.summary:[]), ...(Array.isArray(item.content)?item.content:[])].map(part => typeof part === 'string' ? part : part.text || '').join('\n');
          if (text) section.append(receipt(key, 'Reasoning · model output', text, openKeys));
        } else if (item.type === 'commandExecution') {
          const text = `${item.cwd ? `Folder: ${item.cwd}\n` : ''}$ ${item.command || ''}\n\n${item.aggregatedOutput || ''}${item.exitCode != null ? `\nExit code: ${item.exitCode}` : ''}`;
          section.append(receipt(key, `Command · ${codingCommandOutcome(item, turn)}${item.command ? ` · ${item.command.slice(0, 100)}` : ''}`, text, openKeys));
        } else if (item.type === 'fileChange') section.append(codingFileChangeReceipt(key,item,openKeys,!view && !inheritedContext));
        else if (item.type === 'subAgentActivity') section.append(codingAgentReceipt(key,item,thread,openKeys,view,!inheritedContext));
        else section.append(receipt(key, `${item.type || 'Tool'}${item.status ? ` · ${item.status}` : ''}`, JSON.stringify(item, null, 2), openKeys));
        if (item.truncated) section.append(element('p', 'muted', view?'Saved output is truncated. Original history is preserved.':'Live output truncated. Saved history is refreshed when the turn ends.'));
      }
      if (Array.isArray(turn.plan)) section.append(receipt(`${turn.id}:plan`, 'Plan · model progress', (turn.plan || []).map(step => `${step.status} · ${step.step}`).join('\n'), openKeys));
      if (turn.diff) section.append(receipt(`${turn.id}:diff`, 'Turn diff', turn.diff, openKeys));
      const repeat = !view && codingRepeatedCommandNotice(thread, turn, {selectedThreadId: selectedId, historyPending: historyPending(thread), updatesInterrupted: !view && pollFailed});
      if (repeat) section.append(element('p', 'muted repeated-command-notice', `The same command has completed ${repeat.count} times in a row in this turn. Review the command receipts above to check its progress.`));
      if (inheritedContext) {
        section.append(element('p', 'turn-outcome inherited-outcome', 'Inherited parent context · original stopped marker retained'));
      } else {
        const evidence = codingVerificationSummary(turn, {historyIncomplete: !!(thread.historyTruncated || thread.historyWarning || thread.verificationGap), updatesInterrupted: !view && pollFailed});
        const execution = element('div', 'execution-summary'); execution.setAttribute('aria-label', 'Execution result');
        execution.append(element('strong', '', 'Execution'), element('p', `turn-outcome${turn.status === 'failed' ? ' error' : ''}`, outcome(turn)), element('p', 'command-counts', codingCommandCounts(evidence.counts)));
        const verification = element('aside', 'verification-summary'); verification.dataset.state = evidence.state; verification.setAttribute('aria-label', 'Verification evidence');
        verification.append(element('strong', '', 'Verification: not established'), element('p', '', evidence.detail));
        section.append(execution, verification);
      }
      messages.append(section);
    }
  }
  function renderMessages() {
    const viewport = $('thread'), atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100;
    const openKeys = new Set([...$('messages').querySelectorAll('details[open]')].map(node => node.dataset.key));
    const messages = element('div'); messages.id = 'messages'; const thread = current(); $('welcome').hidden = !!thread;
    if (!thread) {syncNode($('messages'), messages); return;}
    if (thread.historyTruncated) messages.append(element('p', 'muted', 'This history is truncated. Older or larger output may be omitted by the engine.'));
    if (thread.historyWarning) messages.append(element('p', 'muted', thread.historyWarning));
    if (!thread.turns?.length) messages.append(element('p', 'muted', thread.draftReadError ? 'Saved history could not be checked. Your draft is kept. Refresh to try again.' : historyPending(thread) ? 'Loading saved history. Your draft is kept.' : thread.historySource === 'creation-receipt' ? 'No messages were sent. The saved creation record preserves this chat’s original identity.' : thread.historyOnly ? 'This saved chat has no available messages.' : thread.pendingMaterialization ? 'Unsent draft. A project chat will be created when you send.' : childChat(thread) ? 'This agent has no saved messages yet.' : 'Ask the selected model to inspect, change, or test this project.'));
    renderTurns(messages,thread,openKeys);
    syncNode($('messages'), messages);
    if (atBottom) viewport.scrollTop = viewport.scrollHeight;
  }
  function closeSavedHistory() {
    if(savedHistory){savedHistory.cancellation.cancelled=true;if(savedHistory.request)savedHistory.request.cancelled=true;if(savedHistory.scan)savedHistory.scan.cancelled=true;savedHistory.images.clear();savedHistory=null;}
    if($('saved-history-dialog').open)globalThis.salehWorkspace.closeDialog($('saved-history-dialog'));
  }
  const savedHistoryCurrent=state=>savedHistory===state&&!disposed&&selectedId===state.selectionId&&selectionEpoch===state.selectionEpoch;
  function renderSavedHistory() {
    const state=savedHistory;if(!state)return;
    const result=state.result,area=$('saved-history-messages'),openKeys=new Set([...area.querySelectorAll('details[open]')].map(node=>node.dataset.key));
    $('saved-history-context').textContent=state.query?`Find “${state.query}” in ${state.title}. Your current chat and draft stay in place.`:'Browse one saved turn at a time. Your current reply and draft stay in place.';
    $('saved-history-status').textContent=(state.error||(state.scan?`Finding matching messages… Checking saved turn ${state.index+1}.`:state.notice||(state.loading?'Loading saved history…':result?.turn?`Saved turn ${state.index+1} from latest${result.truncated?' · Some output or tool receipts are omitted. Original history is preserved.':''}`:'No saved messages are available.')))+(state.query&&state.omitted?' Some saved text is omitted; search may be incomplete.':'');
    const busy=state.loading||!!state.scan;
    $('saved-history-older').disabled=busy||!result?.nextCursor;
    $('saved-history-newer').disabled=busy||state.index===0;
    $('saved-history-latest').disabled=busy;
    $('saved-history-next-match').hidden=!state.query;
    $('saved-history-next-match').disabled=busy||state.exhausted;
    $('saved-history-next-match').textContent=state.continueSearch?'Continue search':'Next match';
    $('saved-history-cancel-find').hidden=!state.scan;
    const revision=state.revision,valid=()=>savedHistoryCurrent(state)&&!state.loading&&!state.scan&&state.revision===revision;
    const messages=element('div');messages.id=area.id;
    if(result?.turn)renderTurns(messages,{id:state.threadId,turns:[result.turn],historyTruncated:result.truncated},openKeys,{cursor:result.pageCursor,images:state.images,valid,render:renderSavedHistory,cancellation:state.cancellation,matchItem:result.turn.items[state.matchIndex]});
    syncNode(area,messages);
  }
  async function loadSavedHistory(direction,scan=null) {
    const state=savedHistory;if(!state||!savedHistoryCurrent(state)||state.loading||state.scan!==scan)return false;
    const index=direction==='latest'?0:state.index+(direction==='older'?1:-1);
    const pageCursor=direction==='latest'?null:direction==='older'?state.result?.nextCursor:state.pages[index]?.cursor;
    if(index<0||direction==='older'&&!pageCursor)return false;
    const expected=direction==='latest'?null:state.pages[index]?.id;
    const request={cancelled:false};state.request=request;
    const valid=()=>savedHistoryCurrent(state)&&state.request===request&&!request.cancelled&&state.scan===scan&&(!scan||!scan.cancelled);
    let applied=false;
    state.loading=true;state.error='';state.revision++;state.images.clear();renderSavedHistory();
    try{
      const result=await call('historyPage',{threadId:state.threadId,...(pageCursor?{cursor:pageCursor}:{})},request);
      if(!valid())return false;
      const id=value=>typeof value==='string'&&/^[\w.-]{1,160}$/.test(value);
      if(result.threadId!==state.threadId||result.pageCursor!==pageCursor||typeof result.truncated!=='boolean'||result.turn!==null&&(!id(result.turn?.id)||!Array.isArray(result.turn.items))||result.nextCursor!==null&&(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>4096||result.nextCursor.includes('\0'))||!result.turn&&result.nextCursor)throw Error('Saved history returned an invalid page. Try Latest again.');
      if(expected&&result.turn?.id!==expected||direction==='older'&&state.pages.slice(0,index).some(p=>p.id===result.turn?.id)||result.nextCursor&&(result.nextCursor===pageCursor||direction!=='latest'&&state.pages.slice(0,index).some(p=>p.cursor===result.nextCursor)))throw Error('Saved history changed while browsing. Try Latest again.');
      if(direction==='latest'){state.pages=[];state.omitted=false;}
      state.pages[index]={cursor:pageCursor,id:result.turn?.id??null};state.index=index;state.result=result;
      state.matchIndex=-1;state.exhausted=false;state.continueSearch=false;state.notice='';state.omitted ||= result.truncated||!!result.turn?.items.some(item=>item?.truncated);
      $('saved-history-messages').replaceChildren();$('saved-history-scroll').scrollTop=0;
      applied=true;
    }catch(error){if(valid())state.error=message(error);}
    finally{if(valid()){state.request=null;state.loading=false;renderSavedHistory();}}
    return applied;
  }
  async function findSavedMessage() {
    const state=savedHistory;if(!state||!savedHistoryCurrent(state)||!state.query||state.loading||state.scan)return;
    const scan={cancelled:false};state.scan=scan;state.error='';state.notice='';state.continueSearch=false;
    const valid=()=>savedHistoryCurrent(state)&&state.scan===scan&&!scan.cancelled;
    let fetched=0;renderSavedHistory();
    try{
      if(!state.result){if(!await loadSavedHistory('latest',scan)||!valid())return;fetched++;}
      while(valid()){
        const items=state.result?.turn?.items||[];
        const index=items.findIndex((item,index)=>index>state.matchIndex&&savedMessageText(item).toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
        if(index>=0){state.matchIndex=index;state.notice=`Matching message in saved turn ${state.index+1} from latest.`;break;}
        if(!state.result?.nextCursor){state.exhausted=true;state.notice='No further match in available saved user or assistant message text. The search result may match metadata.';break;}
        // ponytail: bound each scan to100 reads; Continue search explicitly advances another batch.
        if(fetched>=100){state.continueSearch=true;state.notice='More history remains. Continue searching older messages.';break;}
        if(!await loadSavedHistory('older',scan)||!valid())return;fetched++;
      }
    }finally{
      if(valid()){state.scan=null;renderSavedHistory();if(state.matchIndex>=0){const match=$('saved-history-messages').querySelector('.history-match');match?.focus({preventScroll:true});match?.scrollIntoView({block:'start'});}}
    }
  }
  function cancelSavedFind() {
    const state=savedHistory;if(!state?.scan)return;
    state.scan.cancelled=true;state.scan=null;if(state.request)state.request.cancelled=true;state.request=null;state.loading=false;state.revision++;
    state.notice='Search cancelled. Continue to check remaining saved messages.';state.continueSearch=true;renderSavedHistory();
  }
  function openSavedHistory(threadId=selectedId,query='',name='') {
    closeSavedHistory();closeChatMenu();
    savedHistory={threadId,selectionId:selectedId,selectionEpoch,index:0,pages:[],result:null,images:new Map(),cancellation:{cancelled:false},revision:0,loading:false,error:'',request:null,scan:null,query,title:name,matchIndex:-1,notice:'',omitted:false,exhausted:false,continueSearch:false};
    $('saved-history-messages').replaceChildren();globalThis.salehWorkspace.openDialog($('saved-history-dialog'));if(query)void findSavedMessage();else void loadSavedHistory('latest');
  }
  $('browse-history').onclick=()=>{
    if(!current()||historyPending(current()))return;
    openSavedHistory();
  };
  $('saved-history-next-match').onclick=()=>void findSavedMessage();
  $('saved-history-cancel-find').onclick=cancelSavedFind;
  $('saved-history-close').onclick=closeSavedHistory;
  $('saved-history-dialog').addEventListener('close',()=>{if(!$('saved-history-dialog').open)closeSavedHistory();});
  $('saved-history-dialog').addEventListener('cancel',closeSavedHistory);
  for(const direction of ['older','newer','latest'])$('saved-history-'+direction).onclick=()=>void loadSavedHistory(direction);
  function renderSelection() {
    if(savedHistory&&!savedHistoryCurrent(savedHistory))closeSavedHistory();
    syncMCPOutcomes();renderMCPOutcomes();syncTerminalResults();
    syncCodingSkillsScope();
    const thread = current(); $('thread-title').textContent = thread ? title(thread) : 'Tasks'; $('project-path').textContent = thread?.cwd || '';$('project-path').title=thread?.cwd||'';
    $('prompt').value = typeof preferences.drafts[selectedId] === 'string' ? preferences.drafts[selectedId] : '';
    $('effort').value = preferences.efforts[selectedId] === 'high' ? 'high' : 'none';renderDraftAttachments();
    const terminalDraft = preferences.terminalDrafts[selectedId];
    $('terminal-command').value = typeof terminalDraft?.command === 'string' ? terminalDraft.command : '';
    $('terminal-input').value = typeof terminalDraft?.input === 'string' ? terminalDraft.input : '';
    renderSidebar(); renderFamily(); renderMessages(); renderPanel(); controls(); resizePrompt();
  }
  function readThread(id) {
    if (threadReads.has(id)) return threadReads.get(id).promise;
    const read = {events: [], bytes: 0, floor: -1}, reloadAfterReplay = new Set(); threadReads.set(id, read);
    const task = (async () => {
    let result;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        result = await call('read', {threadId: id});
        if (Number.isSafeInteger(result.cursor) && result.cursor >= read.floor) break;
        if (attempt) throw new Error('Live history changed too quickly to reconcile. Refresh to try again.');
        read.events = []; read.bytes = 0; read.floor = cursor;
      }
    }
    catch (error) {
      const thread = threads.get(id);
      if (!preferences.pendingThreads[id] || !thread || thread.turns?.length) throw error;
      if (!/thread[^\n]*(?:not found|not materialized|not initialized|does not exist)|(?:unknown|no such) thread|no rollout found[^\n]*thread/i.test(message(error))) {thread.draftReadError = message(error); controls(); throw error;}
      thread.pendingMaterialization = true; thread.missingDraft = true; thread.draftReadError = ''; if (id === selectedId) {renderMessages(); controls();} return thread;
    }
    if (result.thread?.id !== id) throw new Error('The engine returned no matching chat history. Refresh to try again.');
    threads.set(id, {...threads.get(id), ...result.thread, metadataPending: false, historyOnly: !!(result.historyOnly || result.thread.historyOnly), historySource: result.historySource ?? result.thread.historySource ?? null, pendingMaterialization: !!result.pendingMaterialization, missingDraft: false, draftReadError: '', historyWarning: typeof result.historyWarning === 'string' ? result.historyWarning.slice(0, 2000) : '', historyTruncated: !!result.historyTruncated, verificationGap: false, localStopped: false});
    if (typeof result.thread.cwd === 'string' && result.thread.cwd.startsWith('/')) codingSkillProjects.set(id, result.thread.cwd);
    else codingSkillProjects.delete(id);
    codingReplaceMetrics(threads.get(id), result.thread, result, result.cursor);
    if (!archived && !threads.get(id).archived && !childChat(threads.get(id)) && !listed.includes(id)) listed.push(id);
    if (result.thread.turns?.length && preferences.pendingThreads[id]) {delete preferences.pendingThreads[id]; save();}
    if (Number.isSafeInteger(result.cursor)) snapshotCursors.set(id, result.cursor);
    // The response is a snapshot. Replay only events consumed after its cursor while it was in flight.
    for (const event of read.events) if (event.sequence > result.cursor) applyEvent(event, reloadAfterReplay, new Set(), true);
    observeTurns(id, threads.get(id).turns, !result.historyTruncated && !result.historyWarning && !result.pendingMaterialization);
    settleFamilyStops(); renderFamily();
    if (id === selectedId) {syncMCPOutcomes();renderMessages(); controls();}
    renderSidebar(); return threads.get(id);
    })().catch(error => {
      const thread = threads.get(id);
      if (thread?.metadataPending) {thread.draftReadError = message(error); if (id === selectedId) renderMCPOutcomes();}
      throw error;
    }).finally(() => {threadReads.delete(id); const thread = threads.get(id); if (thread?.historyReadPending) thread.historyReadPending = false; if (id === selectedId && !thread?.turns?.length) renderMessages(); controls();});
    read.promise = task.then(thread => reloadAfterReplay.has(id) ? readThread(id) : thread);
    if (id === selectedId && !threads.get(id)?.turns?.length) renderMessages(); controls(); return read.promise;
  }
  function retainReadEvent(event) {
    if (event.method?.startsWith('coding/terminal/') || event.method === 'command/exec/outputDelta') return;
    const params = event.params || {}, ids = event.method === 'coding/error' ? (params.turns || []).map(turn => turn.threadId) : [params.threadId || params.thread?.id];
    for (const id of new Set(ids)) {
      const read = threadReads.get(id); if (!read) continue;
      const scoped = event.method === 'coding/error' ? {...event, params: {...params, turns: params.turns.filter(turn => turn.threadId === id)}} : event;
      const bytes = JSON.stringify(scoped).length;
      if (read.bytes + bytes > 1000000 || read.events.length >= 512) {read.events = []; read.bytes = 0; read.floor = event.sequence;}
      else {read.events.push(structuredClone(scoped)); read.bytes += bytes;}
    }
  }
  async function select(id, {historyRead = false} = {}) {
    closeSavedHistory();clearImagePreviews();selectionEpoch++; selectedId = id; syncCodingSkillsScope(); save(); if (matchMedia('(max-width:850px)').matches) sidebar(false); renderSelection();
    if (!historyRead) await readThread(id); await readFamily(id);void refreshFollowups(id); if (selectedId === id) {void refreshTerminalResults();if (preferences.unread[id]) {delete preferences.unread[id]; save(); renderSidebar(); renderFamily();} $('thread-title').textContent = title(current()); $('project-path').textContent = current()?.cwd || ''; $('thread').scrollTop = $('thread').scrollHeight;}
  }
  async function loadList() {
    const mode = archived, request = ++listRequest, ids = [], seen = new Set(); let next, warning = '';
    listState = 'loading'; renderSidebar();
    try {
      do {
        const result = await call('list', {archived: mode, ...(next ? {cursor: next} : {})});
        if (archived !== mode || request !== listRequest) return;
        if (result.historyIncomplete === true) warning = typeof result.historyWarning === 'string' && result.historyWarning ? result.historyWarning.slice(0, 2000) : 'Some saved history is unavailable; this chat list is incomplete.';
        for (const thread of result.threads || []) {if (!thread.id) continue; const prior = threads.get(thread.id); threads.set(thread.id, {...prior, ...thread, turns: prior?.turns || thread.turns || [], metadataPending: false, archived: mode}); if (!childChat(thread) && !ids.includes(thread.id)) ids.push(thread.id);}
        next = result.nextCursor; if (next && seen.has(next)) throw new Error('Chat pagination stopped repeating. Refresh to retry.'); seen.add(next);
      } while (next);
      if (!mode) for (const id of Object.keys(preferences.pendingThreads)) if (threads.has(id) && !threads.get(id).archived && !ids.includes(id)) ids.unshift(id);
      if (!mode) for (const id of setupCreatedRoots) if (threads.has(id) && !threads.get(id).archived && !ids.includes(id)) ids.unshift(id);
      if (archived !== mode || request !== listRequest) return;
      listed = ids; listHistoryWarning = warning; listLoaded = true; listState = 'loaded'; syncMCPOutcomes();
    } catch (error) {
      if (archived === mode && request === listRequest) listState = 'failed';
      throw error;
    } finally {
      if (request === listRequest) {
        if (archived !== mode) listState = 'failed';
        banner('event-notice', eventNotice); renderSidebar();
      }
    }
  }
  async function refreshStatus() {
    const startCursor = cursor, request = ++workspaceStatusRequest;
    engine = await call('status'); $('provider-status').textContent = engine.message || (engine.available ? 'Coding runtime available · model readiness shown in the composer' : 'Coding engine unavailable');
    banner('event-notice', eventNotice);
    // Workspace rows and their journal cursor form one snapshot. Keep its floor
    // even for absent rows, so an older event batch cannot restore deleted state.
    const snapshotCursor = engine.workspaceSyncCursor === undefined ? startCursor : engine.workspaceSyncCursor;
    if (Number.isSafeInteger(snapshotCursor) && snapshotCursor >= 0 && (snapshotCursor > workspaceSnapshotCursor || snapshotCursor === workspaceSnapshotCursor && request > workspaceStatusApplied)) {
      workspaceStatusApplied = request; workspaceSnapshotCursor = snapshotCursor;
      const rows = Array.isArray(engine.workspaceSync) ? engine.workspaceSync : [], roots = new Set(rows.map(row => row.rootThreadId));
      for (const [id, row] of workspaceSync) if (!roots.has(id) && row.sequence <= snapshotCursor) workspaceSync.delete(id);
      for (const row of rows) acceptWorkspaceSync(row, snapshotCursor);
    }
    for (const active of engine.activeTurns || []) {
      if (!active.threadId) continue;
      const prior = threads.get(active.threadId) || {id: active.threadId, turns: [], metadataPending: true};
      const known = prior.turns?.find(turn => turn.id === active.turnId);
      if ((prior.activitySequence ?? -1) <= startCursor && !['completed', 'interrupted', 'failed'].includes(known?.status)) observeTurns(active.threadId, [{id: active.turnId, status: 'inProgress'}]);
      threads.set(active.threadId, {...prior, ...(active.rootThreadId ? {rootThreadId: active.rootThreadId} : {}), ...(active.parentThreadId ? {parentThreadId: active.parentThreadId} : {}), status: (prior.activitySequence ?? -1) > startCursor ? prior.status : {type: 'active'}});
    }
    if (Array.isArray(engine.terminals)) {
      for (const session of [...engine.terminals].reverse()) if (session.threadId && session.processId) {
        const prior = terminals.get(session.threadId);
        if (prior?.processId === session.processId) {if (session.mode === 'pty' && (session.revision ?? 0) >= (prior.revision ?? 0)) Object.assign(prior, session, {running: ['running','stopping'].includes(session.state)});}
        else if (!prior || !prior.running && (session.mode !== 'pty' || ['running','stopping'].includes(session.state))) terminals.set(session.threadId, {...session, output: session.mode === 'pty' ? '' : '[Reattached to a running command; earlier output is unavailable in this page.]\n', running: session.mode !== 'pty' || ['running','stopping'].includes(session.state)});
      }
      for (const terminal of terminals.values()) if (terminal.running && !engine.terminals.some(session => session.processId === terminal.processId)) {terminal.running = false; terminal.error = 'No longer active · final output unavailable';}
      renderTerminal();
    }
    const previous = $('provider').value, providers = Array.isArray(engine.providers) ? engine.providers : [{id: 'local', name: 'Local models', available: true}];
    $('provider').replaceChildren();
    for (const entry of providers) {const provider = typeof entry === 'string' ? {id: entry, name: entry} : entry; if (!provider.id) continue; const option = element('option', '', provider.id === 'local' ? 'Local models' : provider.name || provider.label || provider.id); option.value = provider.id; option.disabled = provider.available === false || provider.configured === false; $('provider').append(option);}
    if (!$('provider').querySelector('option[value="local"]')) {const local = element('option', '', 'Local models'); local.value = 'local'; $('provider').prepend(local);}
    $('provider').value = [...$('provider').options].some(option => option.value === previous && !option.disabled) ? previous : 'local'; renderFamily(); controls();
  }
  async function start(cwd, selection = {}) {
    if (setupBlocking()) throw Error('Inspect or cancel the current tool setup before creating another task.');
    if (checkoutNotice(cwd)) throw new Error(checkoutNotice(cwd));
    const provider = selection.provider ?? ($('provider').value || 'local'), origin = selection.origin ?? selectedId, model = selection.model ?? newModel;
    if (provider === 'local') {const choice = modelEligibility(localModels, model, 'coding'); if (!choice.ready) throw Error(choice.reason);}
    const executionMode = selection.executionMode ?? $('execution-mode').value;
    if (!['native', 'vm'].includes(executionMode)) throw Error('Choose a valid Coding execution mode.');
    const result = await call('start', {cwd, provider, executionMode, ...(provider === 'local' ? {model} : {})}); if (result.cancelled) return;
    await adoptStartedThread(result.thread, provider, origin);
  }
  async function adoptStartedThread(thread, provider, origin) {
    if (!thread?.id) throw new Error('The engine did not return a new chat.');
    threads.set(thread.id, {...thread, archived: false}); rememberPending(thread, provider);
    if (!listed.includes(thread.id)) listed.unshift(thread.id); renderSidebar();
    try {await readThread(thread.id);} catch (error) {throw new Error(`Chat created; history could not be opened. Select it to retry. ${message(error)}`);}
    if (selectedId !== origin) return;
    if(!window.salehSaveBeforeLeave()){banner('notice','A new chat was created. This view is kept until your current draft and attachments can be saved. Select the new chat from Tasks when ready.');return;}
    archived = false; sessionView = false; await select(thread.id, {historyRead: true}); $('prompt').focus();
    loadList().catch(error => banner('event-notice', `Chat opened; chat list could not be refreshed. ${message(error)}`));
    refreshStatus().catch(error => banner('event-notice', `Chat opened; engine status could not be refreshed. ${message(error)}`));
  }
  function acceptTurn(id, turn, initialReply = false) {
    const thread = threads.get(id); if (!thread || !turn?.id) return;
    thread.turns ||= []; const prior = thread.turns.find(value => value.id === turn.id);
    const preserveLive = prior && turn.status === 'inProgress' && (initialReply || ['completed', 'interrupted', 'failed'].includes(prior.status));
    if (prior) {
      const items=prior.items || [];
      for(const item of turn.items || []) {const existing=items.find(value=>value.id===item.id);if(existing){if(!preserveLive)Object.assign(existing,item);}else items.push(item);}
      const ordered = codingOrderCommandReceipts(items, (preserveLive ? prior.status : turn.status) === 'completed');
      if (preserveLive) prior.items = ordered; else Object.assign(prior,turn,{items:ordered});
    } else thread.turns.push({...turn, items: codingOrderCommandReceipts(turn.items || [], turn.status === 'completed')});
    if (!preserveLive) thread.localStopped = false; thread.pendingMaterialization = false;
    thread.status = {type: activeTurn(thread) ? 'active' : 'idle'};
    if (!preserveLive) observeTurns(id, [thread.turns.find(value => value.id === turn.id)]);
    if (preferences.pendingThreads[id]) {delete preferences.pendingThreads[id]; save();}
  }
  async function send(event) {
    event.preventDefault(); let threadId = selectedId; const thread = current(), text = $('prompt').value.trim(), draft = $('prompt').value, turnId = activeTurn(thread)?.id, effort = $('effort').value, queueing=composeUsesQueue(thread),mode=taskModeFor(threadId);
    if(mode===null){banner('notice','Saved task mode could not be read. Your draft is kept; no message was sent.');return;}
    let files;try{files=draftFiles(threadId);attachments.codingInput({text,attachments:files});}catch(error){banner('notice',error.message);return;}
    submissionStore.refresh();
    if (setupBlocking() || storageBlocked || attachmentReads.has(threadId) || (!text&&!files.length) || !canStartWork(thread) || submissionStore.current(threadId)) {controls(); return;}
    const choice = codingModelState(thread, effort); if (!choice.ready) {banner('notice', choice.reason); return;}
    await act(async () => {
      if(!save())throw Error('Your draft could not be saved. No message was sent.');
      const dispatch = {cancelled: false,queue:queueing}; submissionDispatches.set(threadId, dispatch); controls();
      try {
      if (thread.draftReadError) throw new Error('Refresh this draft to verify its chat before sending.');
      if (thread.missingDraft && preferences.pendingThreads[threadId]) {
        const metadata = preferences.pendingThreads[threadId], result = await call('start', {cwd: metadata.cwd, provider: metadata.provider, executionMode: metadata.executionMode ?? 'vm', ...(metadata.provider === 'local' ? {model: metadata.model === undefined ? LEGACY_LOCAL_MODEL : metadata.model} : {})}, dispatch);
        if (result.cancelled) return;
        if (!result.thread?.id) throw new Error('The engine did not return a new chat. Your draft is kept.');
        const oldId=threadId,newId=result.thread.id,next={...preferences};
        for(const key of ['drafts','attachmentDrafts','efforts','taskModes','terminalDrafts','pendingThreads']){
          next[key]={...preferences[key]};if(Object.hasOwn(next[key],oldId))next[key][newId]=next[key][oldId];if(newId!==oldId)delete next[key][oldId];
        }
        next.drafts[newId]??=draft;next.efforts[newId]??=effort;
        next.pendingThreads[newId]={...metadata,cwd:result.thread.cwd,model:result.thread.model,executionMode:result.thread.executionMode??metadata.executionMode??'vm'};
        next.selectedId=selectedId===oldId?newId:selectedId;
        if(!persistPreferences(next))throw Error('The new empty chat was created, but its draft could not be saved. No message was sent; the original draft is kept.');
        preferences=next;threadId=newId;attachmentReads.delete(oldId);
        if(submissionDispatches.get(oldId)===dispatch)submissionDispatches.delete(oldId);submissionDispatches.set(threadId,dispatch);
        threads.set(threadId,{...result.thread,name:metadata.name,archived:false,pendingMaterialization:false});
        if(newId!==oldId){threads.delete(oldId);snapshotCursors.delete(oldId);}
        if(selectedId===oldId){clearImagePreviews();selectionEpoch++;selectedId=threadId;}
        listed=[...new Set(listed.map(id=>id===oldId?threadId:id))];
        if(threadId!==oldId)globalThis.salehWorkspace?.remapPin('coding',oldId,threadId);
        renderSelection();
      }
      const pendingName = preferences.pendingThreads[threadId]?.name?.trim();
      if (!turnId && pendingName && pendingName !== 'New chat') {
        const renamed = await call('rename', {threadId, name: pendingName}, dispatch); if (renamed.cancelled) return;
        threads.get(threadId).name = pendingName;
      }
      if (dispatch.cancelled || disposed) return;
      if(files.length&&!save())throw Error('Your attachment draft could not be saved. No message was sent.');
      if(queueing){await enqueueFollowup(threadId,text,draft,files,effort,dispatch,mode);return;}
      const token = submissionStore.begin(threadId, turnId ? 'steer' : 'send',files.length>0); controls();
      let result, acknowledged = false;
      try {
        result = await call(turnId ? 'steer' : 'send', {threadId, text, ...(files.length?{attachments:files}:{}), ...(turnId ? {turnId} : {effort,mode})}, dispatch);
        if (result.cancelled === true && !result.turn && !result.turnId) {submissionStore.settle(token, 'cancelled'); return;}
        if (result.cancelled !== undefined && result.cancelled !== false) throw Error('The native submission reply was inconsistent. Review task state before sending again.');
        const validReply = turnId ? result.turnId === turnId : typeof result.turn?.id === 'string' && /^[\w.-]{1,160}$/.test(result.turn.id) && ['inProgress', 'completed', 'interrupted', 'failed'].includes(result.turn.status);
        if (!validReply) throw Error('The engine returned no matching submission acknowledgement. Review task state before sending again.');
        let rollback;
        if(!disposed&&submissionStore.current(threadId)?.phase==='waiting'&&(preferences.drafts[threadId]??'')===draft&&JSON.stringify(draftFiles(threadId))===JSON.stringify(files)&&taskModeFor(threadId)===mode){
          const before=preferences,next={...preferences,drafts:{...preferences.drafts,[threadId]:''},attachmentDrafts:{...preferences.attachmentDrafts}};delete next.attachmentDrafts[threadId];
          if(!persistPreferences(next))throw Error('The reply arrived, but the draft update could not be saved. Your draft is kept; review task state before sending again.');
          preferences=next;rollback=()=>{preferences=before;save();};
        }
        acknowledged=submissionStore.settle(token,'confirmed');if(!acknowledged)rollback?.();
        if(selectedId===threadId){$('prompt').value=preferences.drafts[threadId]??'';resizePrompt();renderDraftAttachments();}
      } catch (error) {
        submissionStore.markUnknown(token, 'A confirmed reply was not received. The message may already have run. Review history before sending again.');
        throw error;
      } finally {controls();}
      if (acknowledged && !turnId && result.turn && !disposed) acceptTurn(threadId, result.turn, true);
      if (threadId === selectedId) renderMessages(); renderSidebar();
      } finally {for (const [id, value] of submissionDispatches) if (value === dispatch) submissionDispatches.delete(id); controls();}
    });
  }
  function installApprovals(values) {
    approvals = [];
    if (!Array.isArray(values)) {approvalWarning = 'The engine returned an invalid approval list. Waiting for a valid update.'; return;}
    const seen = new Set(), identity = value => typeof value === 'string' && /^[\w.-]{1,160}$/.test(value);
    let omitted = Math.max(0, values.length - 32);
    for (const value of values.slice(0, 32)) {
      if (!value || !identity(value.id) || !['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/call'].includes(value.method) || !value.params || Array.isArray(value.params) || !identity(value.params.threadId) || !identity(value.params.turnId) || seen.has(value.id)) {omitted++; continue;}
      seen.add(value.id); approvals.push(value);
    }
    approvalWarning = omitted ? `${omitted} approval records were omitted because they were invalid, duplicated, or exceeded the display limit. Waiting for a valid engine update.` : '';
  }
  // Question capabilities come only from complete live snapshots. Answer values never enter preferences or history reducers.
  const questionKeys = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const questionBytes = value => new TextEncoder().encode(value).length;
  const questionText = (value, nonempty = true) => typeof value === 'string' && !value.includes('\0') && (!nonempty || !!value.trim()) && questionBytes(value) <= 4096;
  const questionID = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value);
  function validQuestion(value) {
    if (!questionKeys(value, ['id','params']) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) || questionBytes(JSON.stringify(value)) > 16384) return false;
    const p = value.params;
    if (!questionKeys(p, ['threadId','turnId','itemId','isBlocking','questions']) || ![p.threadId,p.turnId,p.itemId].every(questionID) || typeof p.isBlocking !== 'boolean' || !Array.isArray(p.questions) || p.questions.length < 1 || p.questions.length > 3) return false;
    const ids = new Set();
    return p.questions.every(q => {
      if (!questionKeys(q, ['id','header','question','isOther','isSecret','options']) || !questionID(q.id) || ids.has(q.id) || !questionText(q.header) || !questionText(q.question) || typeof q.isOther !== 'boolean' || typeof q.isSecret !== 'boolean') return false;
      ids.add(q.id); if (q.options === null) return true;
      const labels = new Set();
      return Array.isArray(q.options) && q.options.length >= 1 && q.options.length <= 8 && q.options.every(o => {
        if (!questionKeys(o, ['label','description']) || !questionText(o.label) || !questionText(o.description, false) || labels.has(o.label)) return false;
        labels.add(o.label); return true;
      });
    });
  }
  const questionFingerprint = p => JSON.stringify([p.threadId,p.turnId,p.itemId,p.isBlocking,p.questions.map(q => [q.id,q.header,q.question,q.isOther,q.isSecret,q.options?.map(o => [o.label,o.description]) ?? null])]);
  const pendingQuestion = id => [...questionRecords.values()].some(r => r.live && !r.attempted && r.params.threadId === id);
  const waitingAnswer = id => questionSnapshotReady && [...questionRecords.values()].some(r => r.live && !r.attempted && r.params.threadId === id && r.params.isBlocking);
  const questionLabel = id => waitingAnswer(id) ? 'Waiting for answer' : questionSnapshotReady && pendingQuestion(id) ? 'Optional question' : '';
  function closeQuestion(record, reason = '') {
    record.live = false; record.reason ||= reason;
    if (record.token) record.token.cancelled = true;
    if (record.node && !record.dirty && !record.attempted && !record.node.contains(document.activeElement)) {record.node.remove();record.node = null;record.fields = null;}
  }
  function cancelQuestions(ids) {
    questionGeneration++;
    for (const record of questionRecords.values()) if (!ids || ids.includes(record.params.threadId)) closeQuestion(record);
    renderQuestions();
  }
  function suspendQuestions() {
    questionSnapshotReady = false;
    for (const record of questionRecords.values()) if (record.token && !record.token.dispatched) record.token.cancelled = true;
    renderQuestions();
  }
  function installQuestions(values, sequence) {
    if (disposed || Number.isSafeInteger(sequence) && sequence >= 0 && sequence < questionCursor) return;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Array.isArray(values) || values.length > 32 || !values.every(validQuestion) || new Set(values.map(q => q.id)).size !== values.length) {
      questionWarning = 'Question availability could not be checked. Your text is kept in this page. Wait for an update before sending.';
      suspendQuestions(); return;
    }
    questionCursor = sequence; questionSnapshotReady = true; questionWarning = '';
    const present = new Set(values.map(q => q.id));
    for (const record of questionRecords.values()) if (record.live && !present.has(record.id)) closeQuestion(record);
    for (const value of values) {
      const existing = questionRecords.get(value.id), fingerprint = questionFingerprint(value.params);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {closeQuestion(existing, 'This question changed unexpectedly. Sending is unavailable. Your original draft is kept in this page.');}
        continue; // Closed or attempted capabilities never revive within this page.
      }
      // Bound both editable cards and compact retired identities without evicting focused/edited drafts.
      if (questionRecords.size >= 256 || [...questionRecords.values()].filter(r => r.node).length >= 32) {questionWarning = 'Question draft limit reached. Dismiss a closed question to show another. If the limit remains, reload this page after saving any text you need.';continue;}
      const record = {id:value.id,params:value.params,fingerprint,live:true,attempted:false,dirty:false,delivery:'',reason:'',token:null,node:null,fields:null};
      questionRecords.set(record.id, record); createQuestionForm(record);
    }
    renderQuestions();
  }
  function questionAnswers(record) {
    const answers = Object.create(null);
    for (const field of record.fields || []) {
      const selected = field.radios?.find(radio => radio.checked), value = field.radios ? selected?.dataset.other === 'true' ? field.input.value : selected?.value : field.input.value;
      if (!questionText(value)) return null;
      answers[field.question.id] = {answers:[value]};
    }
    return questionBytes(JSON.stringify(answers)) <= 16384 ? answers : null;
  }
  function questionCanSend(record) {
    const thread = threads.get(record.params.threadId);
    return !!bridge && !disposed && questionSnapshotReady && record.live && !record.attempted && !acting && !!thread && !thread.metadataPending && !thread.historyOnly && !thread.localStopped;
  }
  function createQuestionForm(record) {
    const form = element('form', 'question-card');form.dataset.questionId = record.id;record.node = form;record.fields = [];
    record.heading = element('strong');record.context = element('p', 'muted');record.status = element('p', 'question-status');record.status.setAttribute('role','status');
    form.append(record.heading,record.context,record.status);
    for (const [index, question] of record.params.questions.entries()) {
      const fieldset = element('fieldset'), legend = element('legend', '', question.header), prompt = element('p', '', question.question), key = `question-${record.id}-${index}`;
      prompt.id = `${key}-prompt`;fieldset.append(legend,prompt);fieldset.setAttribute('aria-describedby',prompt.id);
      const field = {question,radios:null,input:null};
      if (question.options) {
        field.radios = [];
        for (const [i, option] of question.options.entries()) {
          const label = element('label','question-choice'), radio = element('input');radio.type = 'radio';radio.name = key;radio.value = option.label;radio.id = `${key}-${i}`;
          const copy = element('span');copy.append(element('span','',option.label));if (option.description) copy.append(element('small','muted',option.description));label.append(radio,copy);fieldset.append(label);field.radios.push(radio);
        }
        if (question.isOther) {
          const label = element('label','question-choice'), radio = element('input');radio.type = 'radio';radio.name = key;radio.dataset.other = 'true';radio.value = '';label.append(radio,element('span','','Other'));fieldset.append(label);field.radios.push(radio);
        }
      }
      if (!question.options || question.isOther) {
        const input = element(question.isSecret ? 'input' : 'textarea');if (question.isSecret) input.type = 'password';else input.rows = 2;
        input.id = `${key}-text`;input.maxLength = 4096;input.autocomplete = 'off';input.spellcheck = false;input.setAttribute('autocorrect','off');input.setAttribute('autocapitalize','off');
        const label = element('label',question.options ? '' : 'sr-only',question.options ? `Other answer for ${question.header}` : question.question);label.htmlFor = input.id;fieldset.append(label,input);field.input = input;
      }
      if (question.isSecret) fieldset.append(element('p','muted','Private response. This goes to this chat’s model and may be retained in its history. It is not saved in this page’s local storage.'));
      record.fields.push(field);form.append(fieldset);
    }
    const actions = element('div','question-actions');record.send = element('button','','Send answers');record.send.type = 'submit';record.skip = element('button','','Skip');record.skip.type = 'button';record.dismiss = element('button','','Dismiss question');record.dismiss.type = 'button';
    const open = element('button','','Open chat');open.type = 'button';open.onclick = () => select(record.params.threadId).catch(error => banner('notice', message(error)));
    actions.append(record.send,record.skip,open,record.dismiss);form.append(actions);
    form.oninput = form.onchange = () => {record.dirty = true;renderQuestions();};
    form.onsubmit = event => {event.preventDefault();void answerQuestion(record, false);};record.skip.onclick = () => {void answerQuestion(record, true);};
    record.dismiss.onclick = () => {if (record.live && !record.attempted) return;form.reset();form.remove();record.node = null;record.fields = null;renderQuestions();};
    $('question-cards').append(form);
  }
  async function answerQuestion(record, skip) {
    if (!questionCanSend(record)) return;
    const answers = skip ? {} : questionAnswers(record);if (!answers) return;
    const token = {cancelled:false,dispatched:false};record.token = token;record.attempted = true;record.skipAttempt = skip;record.delivery = 'sending';
    await act(async () => {
      try {
        const result = await call('answer', {id:record.id,answers}, token);
        if (disposed) return;
        if (questionKeys(result, ['id','threadId','turnId','submitted']) && result.id === record.id && result.threadId === record.params.threadId && result.turnId === record.params.turnId && result.submitted === true) {record.delivery = 'submitted';closeQuestion(record);}
        else record.delivery = token.dispatched ? 'unknown' : 'cancelled';
      } catch {if (!disposed) record.delivery = token.dispatched ? 'unknown' : 'cancelled';}
      finally {if (!disposed) {renderQuestions();renderSidebar();}}
    });
  }
  function renderQuestions() {
    const records = [...questionRecords.values()], visible = records.filter(r => r.node);
    const warning = questionWarning || (!questionSnapshotReady && visible.some(r => r.live) ? 'Question availability could not be checked. Your text is kept in this page. Wait for an update before sending.' : '');
    $('questions').hidden = !visible.length && !warning;$('questions-notice').textContent = warning;$('questions-notice').hidden = !warning;
    for (const record of visible) {
      const thread = threads.get(record.params.threadId), canSend = questionCanSend(record);
      record.heading.textContent = record.params.isBlocking ? 'Question for this turn' : 'Optional question';
      record.context.textContent = `${title(thread)} · ${childChat(thread) ? thread.agentRole || 'Agent' : 'Coding chat'}${thread?.cwd ? ' · '+thread.cwd : ''}`;
      record.context.title = `Chat ${record.params.threadId} · turn ${record.params.turnId} · item ${record.params.itemId}`;
      for (const field of record.fields) {if (field.input) field.input.readOnly = record.attempted;for (const radio of field.radios || []) radio.disabled = record.attempted;}
      const sent = record.token?.dispatched;
      record.status.textContent = record.delivery === 'submitted' ? (record.skipAttempt ? 'Skip submitted to this chat.' : 'Answer submitted to this chat.') : record.delivery === 'unknown' || record.attempted && sent && (!record.live || record.token.cancelled) ? 'Answer delivery unconfirmed. Your answer may have reached the chat. No retry was made; check the conversation before continuing.' : record.delivery === 'cancelled' || record.attempted && record.token?.cancelled && !sent ? 'Answer cancelled before dispatch. No answer was sent from this page.' : record.delivery === 'sending' ? 'Sending answers… Waiting for confirmation from this chat.' : record.reason || (!record.live ? 'This question is no longer accepting answers. No answer was sent from this page. Your draft is kept here until you dismiss it or leave this page.' : !questionSnapshotReady ? warning : record.params.isBlocking ? 'Waiting for your answer. Answer this question to continue this turn.' : 'Optional question. This question may close when the task or page lifecycle changes.');
      record.send.disabled = !canSend || !questionAnswers(record);record.skip.disabled = !canSend;record.dismiss.hidden = record.live && !record.attempted;record.dismiss.disabled = record.delivery === 'sending';
    }
  }
  function renderApprovals() {
    const list = $('approvals').cloneNode(false); list.hidden = !approvals.length && !approvalWarning;
    if (approvalWarning) {const note = element('p', 'muted', approvalWarning); note.id = 'approval-notice'; note.setAttribute('role', 'status'); list.append(note);}
    for (const approval of approvals) {
      const params = approval.params || {}, thread = threads.get(params.threadId), box = element('div', 'approval');
      box.dataset.key = String(approval.id);
      box.append(element('strong', '', `Approval requested · ${thread && !thread.metadataPending ? title(thread) : params.threadId || 'Coding engine'}`));
      const family = familyFor(params.threadId), rootId = family?.rootThreadId || thread?.rootThreadId;
      if (childChat(thread)) box.append(element('p', '', `Agent ${title(thread)} · parent ${title(threads.get(thread.parentThreadId || rootId))} · root ${title(threads.get(rootId))}`));
      box.append(element('p', '', params.cwd || thread?.cwd || 'Folder shown in native review'));
      box.append(element('p', '', `${approval.method}${params.reason ? ` · ${params.reason}` : ''}`));
      if (approval.method === 'item/tool/call') box.append(element('p', '', 'This MCP tool runs through a connected host provider and may act outside the project or VM. Native review shows the exact call before approval.'));
      if (approval.truncated) box.append(element('p', '', 'Preview truncated. Native review shows the complete pending request.'));
      const details = element('pre', '', JSON.stringify(params, null, 2)); details.tabIndex = 0; box.append(details);
      for (const [decision, label] of [['accept', 'Review once'], ['decline', 'Decline']]) {
        const button = element('button', '', label);
        button.dataset.decision = decision;
        button.onclick = () => act(async () => {button.disabled = true; const result = await call('approval', {id: approval.id, decision}); banner('notice', result.message || 'Decision sent. Waiting for the engine outcome.'); if (!result.cancelled) {approvals = approvals.filter(value => value.id !== approval.id); renderApprovals();} else button.disabled = false;}); box.append(button);
      }
      if (params.threadId && params.threadId !== selectedId) {const open = element('button', '', 'Open chat'); open.onclick = () => {clearStopNotice();select(params.threadId).catch(error => banner('notice', message(error)));}; box.append(open);}
      list.append(box);
    }
    syncNode($('approvals'), list);
    controls();
  }
  function renderPanel() {
    $('workspace-panel').hidden = !panel; $('changes-panel').hidden = panel !== 'changes'; $('terminal-panel').hidden = panel !== 'terminal'; $('worktrees-panel').hidden = panel !== 'worktrees'; $('schedules-panel').hidden = panel !== 'schedules';
    $('panel-title').textContent = panel === 'schedules' ? 'Scheduled' : panel === 'worktrees' ? 'Worktrees' : panel === 'terminal' ? 'Terminal' : 'Changes'; $('panel-path').textContent = current()?.cwd || 'Choose a project'; $('panel-path').hidden = ['worktrees', 'schedules'].includes(panel);
    $('changes-toggle').setAttribute('aria-expanded', String(panel === 'changes')); $('terminal-toggle').setAttribute('aria-expanded', String(panel === 'terminal'));
    $('worktrees-toggle').setAttribute('aria-expanded', String(panel === 'worktrees'));
    $('schedules-toggle').setAttribute('aria-expanded', String(panel === 'schedules'));
    renderGit();
    renderTerminal();
  }
  function validWorktree(record) {
    return record && ['id', 'source', 'commit', 'cwd', 'state'].every(key => typeof record[key] === 'string' && record[key].length > 0) && ['creating','ready','needs-inspection','missing','archiving','archived','restoring'].includes(record.state);
  }
  function validHandoffChat(id, value) {
    return /^[\w.-]{1,160}$/.test(id) && value && typeof value.modelProvider === 'string' && value.modelProvider.length <= 200 && ['cwd','source','destination'].every(key => typeof value[key] === 'string' && value[key].startsWith('/') && value[key].length <= 4096) && typeof value.name === 'string' && value.name.length <= 200 && typeof value.uncertain === 'boolean';
  }
  function validHandoff(h) {
    return h && ['id','worktreeId','rootThreadId','source','destination','phase','state','message'].every(key => typeof h[key] === 'string') && /^[\w.-]{1,160}$/.test(h.rootThreadId) && h.id.length <= 160 && h.worktreeId.length <= 160 && ['source','destination'].every(key => h[key].startsWith('/') && h[key].length <= 4096) && ['pending','needs-inspection'].includes(h.state) && /^[a-z][a-z0-9-]{0,79}$/.test(h.phase) && h.message.length <= 1600 && (h.recoveryDirectory === null || typeof h.recoveryDirectory === 'string' && h.recoveryDirectory.startsWith('/') && h.recoveryDirectory.length <= 4096);
  }
  const affectedCheckout = (cwd, pair) => [pair.source, pair.destination || pair.cwd].some(path => typeof path === 'string' && (cwd === path || cwd.startsWith(path + '/')));
  function canHandoff(record, thread = current()) {
    const family = familyFor(thread?.id);
    return worktreeHandoffAvailable && !worktreesReadOnly && worktreesLoaded && record?.state === 'ready' && ownedChat(thread) && !thread.archived && !thread.pendingMaterialization && !thread.draftReadError && [record.source,record.cwd].includes(thread.cwd) && !checkoutNotice(thread.cwd) && family?.rootThreadId === thread.id && !familyWarnings.get(thread.id) && !invalidFamilies.has(thread.id) && !familyReads.has(thread.id) && !threadReads.has(thread.id) && !familyStopping(thread.id) && !subtreeIds(thread.id).some(id => working(threads.get(id)) || waiting(id) || pendingTerminalStarts.has(id));
  }
  function checkoutNotice(cwd) {
    if (!cwd) return '';
    const handoff = [...handoffs.values()].find(h => affectedCheckout(cwd, h));
    if (handoff) return 'Handoff needs inspection at ' + handoff.phase + '. Both checkouts are unavailable. Open Worktrees for retained recovery details. Your history and draft are kept.';
    if (['handoff','recoverHandoff'].includes(worktreeMutation?.action) && affectedCheckout(cwd, worktreeMutation)) return 'Chat handoff awaiting verification. Your history and draft are kept.';
    if (Object.values(preferences.handoffChats).some(h => h.uncertain && affectedCheckout(cwd, h))) return 'Handoff outcome needs verification. Refresh Worktrees to inspect retained work. Your history and draft are kept.';
    const record = [...worktrees.values()].find(record => cwd === record.cwd || cwd.startsWith(record.cwd + '/'));
    if (!record) return '';
    if (record.state === 'archived') return 'Checkout archived. Restore it in Worktrees to continue. Your chat history and draft are kept.';
    if (!worktreesLoaded) return 'Checkout state needs verification. Refresh Worktrees before continuing. Your draft is kept.';
    if (record.state !== 'ready') return `Checkout ${record.state}. Open Worktrees for details before continuing. Your history and draft are kept.`;
    if (worktreeMutation && !worktreeMutation.cancelled && worktreeMutation.id === record.id) return 'Worktree operation awaiting confirmation. Your history and draft are kept.';
    return '';
  }
  function invalidateWorktreeGit(record) {
    const paths = [record.cwd, record.source, record.destination].filter(Boolean), common = new Set();
    for (const state of gitResults.values()) if (state.snapshot && paths.some(path => path === state.snapshot.cwd || path.startsWith(state.snapshot.cwd + '/') || state.snapshot.cwd.startsWith(path + '/'))) common.add(state.snapshot.commonRepositoryId);
    for (const path of paths) {invalidateGit(path); for (const id of common) invalidateGit(path, id);}
  }
  function renderWorktrees() {
    const list = element('ul'); list.id = 'worktrees-list'; list.setAttribute('aria-label', 'Managed worktrees');
    for (const record of worktrees.values()) {
      if ((record.state === 'archived') !== ($('worktrees-view').value === 'archived')) continue;
      const row = element('li', 'worktree-row'); row.dataset.key = record.id; row.dataset.worktreeId = record.id;
      row.append(element('strong', '', `${record.source.split('/').filter(Boolean).at(-1) || 'Worktree'} · ${record.state}${worktreesLoaded ? '' : ' · not refreshed'}`));
      const details = element('dl');
      for (const [label, value] of [['Worktree ID', record.id], ['Source', record.source], ['Base commit', record.commit], ['Location', record.cwd], ...(record.head ? [['Current HEAD', record.head]] : [])]) details.append(element('dt', '', label), element('dd', '', value));
      const inspection = element('details', 'worktree-inspection'); inspection.append(element('summary', '', 'Checkout details'), details); row.append(inspection);
      if (worktreesLoaded && record.state === 'ready' && typeof record.dirty === 'boolean') row.append(element('p', 'muted', record.dirty ? 'This checkout has local changes.' : 'This checkout has no local changes.'));
      const message = record.message || (record.state === 'archived' ? 'Archived recovery files are retained. Restore the original checkout to continue.' : '');
      if (message) row.append(element('p', '', String(message).slice(0, 2000)));
      if (Number.isFinite(record.archivedAt)) row.append(element('p', 'muted', `Archived ${new Date(record.archivedAt).toLocaleString()}`));
      const actions = element('div', 'panel-actions');
      if (record.state !== 'archived') {const open = element('button', '', 'Open new chat'); open.type = 'button'; open.dataset.worktreeOpen = record.id; open.onclick = () => openWorktree(record.id); actions.append(open);}
      if (record.state === 'ready') {const move = element('button', '', 'Move this chat here'); move.type = 'button'; move.title = 'Move this idle root chat and its agents after native review.'; move.dataset.worktreeHandoff = record.id; move.onclick = () => handoffWorktree(record.id); actions.append(move);}
      if (['ready','archived'].includes(record.state)) {
        const action = record.state === 'ready' ? 'archive' : 'restore', button = element('button', '', action === 'archive' ? 'Review archive' : 'Review restore'); button.type = 'button'; button.dataset[action === 'archive' ? 'worktreeArchive' : 'worktreeRestore'] = record.id; button.onclick = () => mutateWorktree(action, {id: record.id}); actions.append(button);
      }
      row.append(actions); list.append(row);
    }
    for (const h of handoffs.values()) {
      const row = element('li', 'worktree-row'); row.dataset.key = 'handoff-' + h.id; row.dataset.handoffId = h.id;
      row.append(element('strong', '', 'Handoff needs inspection · ' + h.phase), element('p', '', h.message));
      const details = element('dl'); for (const [label, value] of [['Chat', h.rootThreadId], ['From', h.source], ['To', h.destination], ['Recovery', h.recoveryDirectory || 'Recovery location unavailable']]) details.append(element('dt', '', label), element('dd', '', value));
      row.append(details, element('p', 'muted', 'Review restore selects the recorded original state. Review finish selects the recorded handoff result. Native review explains both checkout changes; recovery may be refused if safe completion cannot be verified.'));
      const actions = element('div', 'panel-actions');
      for (const mode of ['restore','finish']) {const button = element('button', '', `Review ${mode}`); button.type = 'button'; button.dataset.handoffRecovery = mode; button.dataset.handoffRecoveryId = h.id; button.onclick = () => recoverHandoff(h.id, mode); actions.append(button);}
      const copy = element('button', '', 'Recover original project copy'); copy.type = 'button'; copy.dataset.handoffCopy = h.id; copy.onclick = () => copyHandoff(h.id); actions.append(copy);
      row.append(element('p', 'muted', 'Recover a separate copy of the recorded original project. Your existing chats, drafts and retained handoff stay in place.'));
      row.append(actions); list.append(row);
    }
    if (!list.children.length) list.append(element('li', 'muted', worktreesLoaded ? `No ${$('worktrees-view').value} managed worktrees.` : 'Refresh to load managed worktrees.'));
    syncNode($('worktrees-list'), list); controls();
  }
  async function refreshWorktrees(verifyHandoffs = true) {
    const epoch = worktreeEpoch;
    try {
      const result = await worktreeCall('list');
      if (epoch !== worktreeEpoch) return;
      if (result.createAvailable !== undefined && typeof result.createAvailable !== 'boolean' || result.openAvailable !== undefined && typeof result.openAvailable !== 'boolean' || result.handoffAvailable !== undefined && typeof result.handoffAvailable !== 'boolean' || result.recoveryCopyAvailable !== undefined && typeof result.recoveryCopyAvailable !== 'boolean' || result.readOnly !== undefined && typeof result.readOnly !== 'boolean' || result.reconnectAvailable !== undefined && typeof result.reconnectAvailable !== 'boolean' || result.reason !== undefined && (typeof result.reason !== 'string' || result.reason.length > 2000)) throw new Error('The engine returned invalid worktree capabilities. Refresh to retry.');
      if (!Array.isArray(result.worktrees) || result.worktrees.some(record => !validWorktree(record))) throw new Error('The engine returned an invalid managed worktree list. Refresh to retry.');
      const retained = result.handoffs ?? [];
      if (!Array.isArray(retained) || retained.some(h => !validHandoff(h)) || new Set(retained.map(h => h.id)).size !== retained.length) throw new Error('The engine returned invalid handoff recovery records. Refresh to retry.');
      if (result.worktrees.length > 128 || retained.length > 128 || JSON.stringify([result.worktrees, retained]).length > 1000000) throw new Error('The managed worktree list exceeds the display limit. New results were not displayed.');
      for (const record of result.worktrees) if (worktrees.get(record.id)?.state !== record.state) invalidateWorktreeGit(record);
      worktrees.clear(); for (const record of result.worktrees) worktrees.set(record.id, record);
      handoffs.clear(); for (const h of retained) {
        handoffs.set(h.id, h); const thread = threads.get(h.rootThreadId);
        if (!thread) threads.set(h.rootThreadId, {id:h.rootThreadId, cwd:h.source, name:'Retained handoff chat', turns:[], metadataPending:true});
      }
      worktreesLoaded = true; worktreesBusy = !!result.busy; worktreesReadOnly = !!result.readOnly; worktreeOpenAvailable = result.openAvailable ?? !worktreesReadOnly; worktreeCreateAvailable = result.createAvailable === true; worktreeHandoffAvailable = result.handoffAvailable ?? !worktreesReadOnly; worktreeReconnectAvailable = result.reconnectAvailable === true; worktreeRecoveryCopyAvailable = result.recoveryCopyAvailable === true;
      const priorNotice=$('worktrees-notice').textContent;
      if(result.reason&&!priorNotice.includes(result.reason))banner('worktrees-notice',[priorNotice,result.reason].filter(Boolean).join('\n'));
      if (verifyHandoffs && !worktreesReadOnly && !worktreesBusy && (!worktreeMutation || worktreeMutation.cancelled)) for (const [id, cached] of Object.entries(preferences.handoffChats)) if (cached.uncertain && !retained.some(h => h.rootThreadId === id)) {
        try {await readThread(id); if (epoch === worktreeEpoch) {cached.uncertain = false; cached.cwd = threads.get(id).cwd;}} catch { /* Keep the draft and execution fence until metadata can be verified. */ }
      }
      save();
    } catch (error) {if (epoch === worktreeEpoch) {worktreesLoaded = false; worktreesReadOnly = true; worktreeOpenAvailable = false; worktreeCreateAvailable = false; worktreeHandoffAvailable = false; worktreeReconnectAvailable = false; worktreeRecoveryCopyAvailable = false;} throw error;}
    finally {renderWorktrees();}
  }
  async function copyHandoff(id) {
    const retained = handoffs.get(id);
    if (!retained || !worktreeRecoveryCopyAvailable || !worktreesLoaded || worktreeMutating || worktreesBusy || worktreeStopRequested) return;
    await act(async () => {
      const token = {action:'recoverCopy', cancelled:false}, epoch = ++worktreeEpoch; worktreeMutation = token; worktreeMutating = true; controls();
      try {
        const result = await worktreeCall('recoverCopy', {id}, token);
        if (token.cancelled || epoch !== worktreeEpoch) return;
        if (result.cancelled) {banner('worktrees-notice', 'Project copy review cancelled. Original recovery, chats and drafts are kept.'); return;}
        const copy = result?.copy, fields = ['id','operation','handoffId','rootThreadId','source','target','head','indexTree','files','bytes','omittedCount','receiptPath','independent','originalRecoveryComplete'];
        const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value), path = value => typeof value === 'string' && value.length <= 4096 && value.startsWith('/') && !/[\0\r\n]/.test(value) && value.slice(1).split('/').every(part => part && part !== '.' && part !== '..');
        if (!result || Object.keys(result).join() !== 'copy' || !copy || Object.keys(copy).sort().join() !== fields.sort().join() || !uuid(copy.id) || copy.operation !== 'handoff-original-copy' || copy.handoffId !== id || copy.rootThreadId !== retained.rootThreadId || copy.source !== retained.source || !path(copy.target) || !copy.target.endsWith('/'+copy.id+'/project') || [retained.source,retained.destination,retained.recoveryDirectory].filter(Boolean).some(root => copy.target === root || copy.target.startsWith(root+'/') || root.startsWith(copy.target+'/')) || copy.receiptPath !== copy.target.slice(0,-7)+'receipt.json' || copy.independent !== true || copy.originalRecoveryComplete !== false || !['head','indexTree'].every(key => typeof copy[key] === 'string' && /^[a-f0-9]{40}$/.test(copy[key])) || !['files','bytes','omittedCount'].every(key => Number.isSafeInteger(copy[key]) && copy[key] >= 0 && copy[key] <= (key === 'bytes' ? 134217728 : 20000))) throw new Error('The recovered project copy could not be verified. Inspect retained output before retrying.');
        banner('worktrees-notice', 'Recovered project copy: '+copy.target+'\nYour original handoff remains retained. Chats and drafts are kept. Open the new project when you are ready.');
      } catch (error) {if (!token.cancelled && epoch === worktreeEpoch) throw error;}
      finally {if (worktreeMutation === token) {worktreeMutation = null; worktreeMutating = false;} controls();}
    }, 'worktrees-notice');
  }
  async function reconnectWorktrees() {
    if (!worktreeReconnectAvailable || worktreeMutating || worktreesBusy || worktreeStopRequested) return;
    await act(async () => {
      const cancellation = {action:'reconnect', cancelled:false}, epoch = ++worktreeEpoch; worktreeMutation = cancellation; worktreeMutating = true; controls();
      try {
        const result = await worktreeCall('reconnect', {}, cancellation);
        if (cancellation.cancelled || epoch !== worktreeEpoch) return;
        if (result.cancelled) {banner('worktrees-notice', 'Reconnect review cancelled. Retained worktrees, history and drafts are kept.'); return;}
        if (result.reconnected !== true || !Array.isArray(result.worktrees) || !result.worktrees.length || result.worktrees.length > 128 || result.worktrees.some(record => !validWorktree(record) || record.state !== 'ready')) throw new Error('Reconnect completion could not be verified. Inspect the retained ledger and transaction evidence before retrying.');
        for (const record of result.worktrees) invalidateWorktreeGit(record);
        worktreeReconnectAvailable = false;
        try {await refreshWorktrees(false); if (!cancellation.cancelled && epoch === worktreeEpoch) banner('worktrees-notice', handoffs.size ? 'Worktrees reconnected. The interrupted handoff is still protected. Review Restore or Finish to continue original recovery.' : 'Retained worktrees reconnected. Files, Git history and recovery artifacts are kept. Open a chat when you are ready.');}
        catch (error) {if (!cancellation.cancelled && epoch === worktreeEpoch) banner('worktrees-notice', 'Reconnect completed; refreshing the managed list failed. Your history and drafts are kept. ' + message(error));}
      } finally {if (worktreeMutation === cancellation) {worktreeMutation = null; worktreeMutating = false;} controls();}
    }, 'worktrees-notice');
  }
  async function createWorktree(event) {
    event.preventDefault(); const cwd = worktreeSource, ref = $('worktree-ref').value.trim();
    if (!worktreeCreateAvailable || !cwd || !ref || worktreeMutating || worktreesBusy || worktreeStopRequested) return;
    await mutateWorktree('create', {cwd, ref, ...($('worktree-copy-changes').checked ? {copyChanges: true} : {})});
  }
  async function mutateWorktree(action, input) {
    const record = action === 'create' ? {source: input.cwd} : worktrees.get(input.id);
    if ((action === 'create' ? !worktreeCreateAvailable : worktreesReadOnly) || !record || worktreeMutating || worktreesBusy || worktreeStopRequested || action !== 'create' && (!worktreesLoaded || record.state !== (action === 'archive' ? 'ready' : 'archived'))) return;
    await act(async () => {
      if (action === 'archive' && !Object.hasOwn(preferences.worktreeGitDrafts, record.id)) {
        const snapshot = [...gitResults.values()].find(state => state.snapshot?.cwd === record.cwd)?.snapshot;
        if (snapshot && preferences.gitDrafts[snapshot.repositoryId]) {rememberWorktreeGit(snapshot, preferences.gitDrafts[snapshot.repositoryId]); save();}
      }
      const cancellation = {...record, action, cancelled: false}, epoch = ++worktreeEpoch; worktreeMutation = cancellation;
      worktreeMutating = true; invalidateWorktreeGit(record); controls();
      try {
        const result = await worktreeCall(action, input, cancellation);
        if (cancellation.cancelled || epoch !== worktreeEpoch) return;
        if (result.cancelled) {banner('worktrees-notice', `${action === 'create' ? 'Creation' : action === 'archive' ? 'Archive' : 'Restore'} cancelled. Your history and drafts are kept.`); return;}
        if (!validWorktree(result.worktree) || action !== 'create' && (result.worktree.id !== record.id || result.worktree.cwd !== record.cwd)) throw new Error('The worktree outcome is unavailable. Refresh the managed list before trying again.');
        worktrees.set(result.worktree.id, result.worktree); renderWorktrees();
        const expected = action === 'archive' ? 'archived' : 'ready';
        banner('worktrees-notice', result.worktree.state === expected ? action === 'create' ? `Worktree created. ${result.worktree.message || 'Open a new chat when you are ready.'}` : `Worktree ${action === 'archive' ? 'archived' : 'restored'}. Your existing chats and drafts are kept.` : `Worktree retained · ${result.worktree.state}. ${result.worktree.message || 'Refresh to inspect its state.'}`);
      } catch (error) {if (!cancellation.cancelled && epoch === worktreeEpoch) {worktreesLoaded = false; renderWorktrees(); throw error;}}
      finally {invalidateWorktreeGit(record); if (worktreeMutation === cancellation) {worktreeMutation = null; worktreeMutating = false;} controls();}
    }, 'worktrees-notice');
  }
  async function handoffWorktree(id) {
    const record = worktrees.get(id), thread = current(); if (worktreeMutating || worktreesBusy || worktreeStopRequested || !canHandoff(record, thread)) return;
    const threadId = thread.id, source = thread.cwd, destination = source === record.source ? record.cwd : record.source, members = subtreeIds(threadId);
    if (!Object.hasOwn(preferences.handoffChats, threadId) && Object.keys(preferences.handoffChats).length >= 128) {banner('worktrees-notice', 'Retained chat limit reached. Existing drafts are kept.'); return;}
    await act(async () => {
      const cancellation = {...record, source, destination, action:'handoff', threadId, cancelled:false}, epoch = ++worktreeEpoch;
      worktreeMutation = cancellation; worktreeMutating = true;
      preferences.handoffChats[threadId] = {cwd:source, source, destination, name:title(thread).slice(0,200), modelProvider:thread.modelProvider || '', uncertain:true}; save();
      revokeTerminalInput(members); invalidateWorktreeGit(record); controls();
      try {
        const result = await worktreeCall('handoff', {id, threadId}, cancellation);
        if (cancellation.cancelled || epoch !== worktreeEpoch) return;
        if (result.cancelled) {preferences.handoffChats[threadId].uncertain = false; save(); banner('worktrees-notice', 'Handoff cancelled. Your chat and draft are kept.'); return;}
        const h = result.handoff, family = result.family;
        if (h?.state !== 'complete' || h.rootThreadId !== threadId || h.source !== source || h.destination !== destination || family?.rootThreadId !== threadId || family.cwd !== destination || !Array.isArray(family.members) || family.members.length !== members.length || new Set(family.members.map(t => t.id)).size !== members.length || family.members.some(t => !members.includes(t.id) || t.cwd !== destination || typeof t.archived !== 'boolean' || t.archived !== !!threads.get(t.id)?.archived || (t.parentThreadId || null) !== (threads.get(t.id)?.parentThreadId || null))) throw new Error('The handoff outcome could not be verified. Recovery and your draft are retained; refresh Worktrees.');
        for (const member of family.members) {const prior = threads.get(member.id); threads.set(member.id, {...prior, ...member, metadataPending:false, pendingMaterialization:false}); delete preferences.pendingThreads[member.id];}
        Object.assign(preferences.handoffChats[threadId], {cwd:destination, uncertain:false}); save();
        if (members.includes(selectedId)) renderSelection(); else renderSidebar();
        banner('worktrees-notice', 'Chat moved. The same history, agents and unsent draft are kept.');
        try {await readThread(threadId); if (cancellation.cancelled || epoch !== worktreeEpoch) return; await readFamily(threadId, true);} catch (error) {banner('worktrees-notice', 'Chat moved; metadata refresh is unavailable. Your history and draft are kept. ' + message(error));}
      } catch (error) {
        if (!cancellation.cancelled && epoch === worktreeEpoch) {worktreesLoaded = false; banner('worktrees-notice', message(error)); try {await refreshWorktrees();} catch { /* Keep the uncertainty notice and local fence. */ }}
      } finally {
        invalidateWorktreeGit(record); if (worktreeMutation === cancellation) {worktreeMutation = null; worktreeMutating = false;} renderWorktrees(); controls();
      }
    }, 'worktrees-notice');
  }
  function validHandoffRecovery(result, token) {
    const exact = (value, keys) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
    const id = value => typeof value === 'string' && /^[\w.-]{1,160}$/.test(value), text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('\0');
    const h = result.handoff, family = result.family, target = token.mode === 'restore' ? token.source : token.destination;
    if (!exact(result, 'handoff,family') || !exact(h, 'id,rootThreadId,source,destination,mode,target,state,recoveryDirectory') || h.id !== token.id || h.rootThreadId !== token.threadId || h.source !== token.source || h.destination !== token.destination || h.mode !== token.mode || h.target !== target || h.state !== 'complete' || typeof h.recoveryDirectory !== 'string' || !h.recoveryDirectory.startsWith('/') || h.recoveryDirectory.length > 4096) return false;
    if (!exact(family, 'rootThreadId,cwd,model,modelProvider,fingerprint,members') || family.rootThreadId !== token.threadId || family.cwd !== target || !text(family.model) || !text(family.modelProvider) || !/^[a-f0-9]{64}$/.test(family.fingerprint) || !Array.isArray(family.members) || !family.members.length || family.members.length > 2001) return false;
    // Native has checked original reviewed IDs/archive flags. The current page may hold only a placeholder or a partly moved family.
    const members = new Map();
    for (const member of family.members) {
      if (!exact(member, 'id,parentThreadId,archived,cwd,model,modelProvider,lastTurnId,compatibility') || !id(member.id) || members.has(member.id) || typeof member.archived !== 'boolean' || member.cwd !== target || member.model !== family.model || member.modelProvider !== family.modelProvider || member.lastTurnId !== null && !id(member.lastTurnId) || !exact(member.compatibility, 'version,headerHash,identity') || member.compatibility.version !== 1 || !/^[a-f0-9]{64}$/.test(member.compatibility.headerHash) || !exact(member.compatibility.identity, 'dev,ino') || Object.values(member.compatibility.identity).some(value => typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value))) return false;
      if (member.id === token.threadId ? member.parentThreadId !== null : !id(member.parentThreadId)) return false;
      members.set(member.id, member);
    }
    if (!members.has(token.threadId)) return false;
    for (const member of members.values()) {let next = member.id; const seen = new Set(); while (next !== token.threadId) {if (seen.size >= 32 || seen.has(next) || !members.has(next)) return false; seen.add(next); next = members.get(next).parentThreadId;}}
    return true;
  }
  async function recoverHandoff(id, mode) {
    const retained = handoffs.get(id);
    if (worktreesReadOnly || !retained || !['restore','finish'].includes(mode) || !worktreesLoaded || worktreeMutating || worktreesBusy || worktreeStopRequested) return;
    const {rootThreadId: threadId, source, destination} = retained, thread = threads.get(threadId);
    if (!Object.hasOwn(preferences.handoffChats, threadId) && Object.keys(preferences.handoffChats).length >= 128) {banner('worktrees-notice', 'Retained chat limit reached. Existing drafts are kept.'); return;}
    await act(async () => {
      const token = {id, threadId, source, destination, mode, action:'recoverHandoff', cancelled:false}, epoch = ++worktreeEpoch;
      worktreeMutation = token; worktreeMutating = true;
      preferences.handoffChats[threadId] = {...preferences.handoffChats[threadId], cwd:thread?.cwd || source, source, destination, name:title(thread).slice(0,200), modelProvider:thread?.modelProvider || '', uncertain:true}; save();
      revokeTerminalInput([...threads.values()].filter(t => affectedCheckout(t.cwd || '', token)).map(t => t.id)); invalidateWorktreeGit(token); controls();
      const fresh = () => !token.cancelled && epoch === worktreeEpoch;
      const label = mode === 'restore' ? 'Handoff restored' : 'Handoff finished';
      try {
        const result = await worktreeCall('recoverHandoff', {id, mode}, token);
        if (!fresh()) return;
        if (result.cancelled) {banner('worktrees-notice', 'Recovery review cancelled. Retained recovery, history and drafts are kept.'); try {await refreshWorktrees(false);} catch {} return;}
        if (!validHandoffRecovery(result, token)) throw new Error('The recovery outcome could not be verified. Recovery and your draft are retained; refresh Worktrees.');
        for (const member of result.family.members) {const prior = threads.get(member.id); threads.set(member.id, {...prior, ...member, rootThreadId:threadId, turns:prior?.turns || [], metadataPending:false, pendingMaterialization:false}); delete preferences.pendingThreads[member.id];}
        preferences.handoffChats[threadId].cwd = result.handoff.target; save();
        if (result.family.members.some(t => t.id === selectedId)) renderSelection(); else renderSidebar();
        try {
          await refreshWorktrees(false); if (!fresh()) return;
          await readThread(threadId); if (!fresh()) return;
          await readFamily(threadId, true); if (!fresh()) return;
          if (threads.get(threadId)?.cwd !== result.handoff.target || familyWarnings.has(threadId) || [...handoffs.values()].some(h => h.rootThreadId === threadId)) throw new Error('Retained recovery or family metadata still requires inspection.');
          preferences.handoffChats[threadId].uncertain = false; save();
          banner('worktrees-notice', label + '. The same history, agents and unsent drafts are kept.');
        } catch (error) {if (fresh()) banner('worktrees-notice', label + '; metadata refresh is unavailable. Both checkouts remain fenced. Your history and drafts are kept. ' + message(error));}
      } catch (error) {
        if (fresh()) {worktreesLoaded = false; banner('worktrees-notice', message(error)); try {await refreshWorktrees(false);} catch { /* Retain the local fence when the manager list is unavailable. */ }}
      } finally {invalidateWorktreeGit(token); if (worktreeMutation === token) {worktreeMutation = null; worktreeMutating = false;} renderWorktrees(); controls();}
    }, 'worktrees-notice');
  }
  async function openWorktree(id) {
    if (!worktreeOpenAvailable || worktreeMutating || worktreesBusy || worktreeStopRequested || setupBlocking()) return;
    const provider = $('provider').value, option = $('provider').selectedOptions[0], origin = selectedId, model = newModel, executionMode = $('execution-mode').value;
    if (!worktreesLoaded || worktrees.get(id)?.state !== 'ready' || !option || option.disabled || !['local', 'cloud'].includes(provider)) return;
    if (!['native', 'vm'].includes(executionMode)) throw Error('Choose a valid Coding execution mode.');
    await act(async () => {
      if (provider === 'local') {const choice = modelEligibility(localModels, model, 'coding'); if (!choice.ready) throw Error(choice.reason);}
      const result = await worktreeCall('open', {id, provider, executionMode, ...(provider === 'local' ? {model} : {})}); if (result.cancelled) return;
      await adoptStartedThread(result.thread, provider, origin);
    }, 'worktrees-notice');
  }
  const scheduleDraftKey = () => scheduleEditor || 'new';
  const localDate = value => {const date = new Date(value); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';};
  const dateText = value => value == null ? '—' : new Date(value).toLocaleString();
  const validScheduleModel=value=>typeof value==='string'&&!!value.trim()&&value.length<=200&&!/[\x00-\x1f\x7f]/.test(value);
  function renderScheduleModel(model=$('schedule-model').value) {
    modelOptions($('schedule-model'),localModels,validScheduleModel(model)?model:'');
    $('schedule-model-note').textContent=modelEligibility(localModels,$('schedule-model').value,'coding',$('schedule-effort').value==='high').reason+' Each run uses this exact saved model.';
  }
  function scheduleDraft(record) {
    const cadence = record?.cadence;
    return {name: record?.name || '', cwd: record?.cwd || current()?.cwd || '', prompt: record?.prompt || '', effort: record?.effort || 'none', model: record ? Object.hasOwn(record,'model') ? record.model : LEGACY_LOCAL_MODEL : modelDefault(localModels,'coding'), executionMode: record && Object.hasOwn(record, 'executionMode') ? record.executionMode : 'vm', type: cadence?.type || 'interval', minutes: String(cadence?.minutes || 60), at: localDate(cadence?.at || Date.now() + 3600000), days: cadence?.days || [1, 2, 3, 4, 5], time: cadence?.time || '09:00', timeZone: cadence?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'};
  }
  function readScheduleForm() {
    return {name: $('schedule-name').value, cwd: $('schedule-project').dataset.cwd || '', prompt: $('schedule-prompt').value, effort: $('schedule-effort').value, model:$('schedule-model').value, executionMode: $('schedule-execution-mode').value, type: $('schedule-cadence').value, minutes: $('schedule-minutes').value, at: $('schedule-at').value, days: [...$('schedule-days').querySelectorAll('input:checked')].map(node => Number(node.value)), time: $('schedule-time').value, timeZone: $('schedule-timezone').value};
  }
  function rememberScheduleForm() {
    if (!scheduleFormReady) return;
    const key = scheduleDraftKey(), draft = readScheduleForm(), previous = preferences.scheduleDrafts[key];
    if (!['native', 'vm'].includes(draft.executionMode) && previous && Object.hasOwn(previous, 'executionMode')) draft.executionMode = previous.executionMode;
    if(!validScheduleModel(draft.model)&&previous&&Object.hasOwn(previous,'model'))draft.model=previous.model;
    preferences.scheduleDrafts[key] = draft; save();renderScheduleModel();scheduleControlState();
  }
  function editSchedule(id) {
    scheduleEditor = id; preferences.scheduleSelectedId = id;
    const draft = {...scheduleDraft(schedules.get(id)), ...preferences.scheduleDrafts[scheduleDraftKey()]};
    for (const [field, key] of [['name', 'name'], ['prompt', 'prompt'], ['effort', 'effort'], ['execution-mode', 'executionMode'], ['cadence', 'type'], ['minutes', 'minutes'], ['at', 'at'], ['time', 'time'], ['timezone', 'timeZone']]) $(`schedule-${field}`).value = draft[key];
    renderScheduleModel(draft.model);
    $('schedule-project').dataset.cwd = draft.cwd; $('schedule-project').textContent = draft.cwd || 'Choose a project folder';
    for (const input of $('schedule-days').querySelectorAll('input')) input.checked = draft.days?.includes(Number(input.value));
    scheduleFormReady = true; save(); scheduleControlState();
  }
  function scheduleControlState() {
    const pending = id => [...scheduleMutations].some(token => !token.cancelled && token.id === id), stopped = scheduleControls.has('*'), locked = acting || stopped || scheduleControls.has(scheduleEditor);
    $('schedules-toggle').disabled = !bridge; $('schedules-refresh').disabled = !bridge || acting;
    $('schedules-stop').disabled = !bridge || stopped; $('schedules-stop').textContent = stopped ? 'Stopping schedules…' : 'Stop all schedules';
    $('schedules-recover').hidden = !schedulesLoaded || !scheduleRecoveryAvailable; $('schedules-recover').disabled = !bridge || !schedulesLoaded || !scheduleRecoveryAvailable || acting || stopped;
    for (const input of $('schedule-form').querySelectorAll('input,textarea,select,button')) input.disabled = !bridge || locked;
    $('schedule-use-project').disabled = !bridge || locked || !current()?.cwd;
    $('schedule-save').disabled = !bridge || locked || !scheduleFormReady || !validScheduleModel($('schedule-model').value) || !['native', 'vm'].includes($('schedule-execution-mode').value) || (scheduleEditor && (!schedulesLoaded || !schedules.has(scheduleEditor))) || !$('schedule-name').value.trim() || !$('schedule-prompt').value.trim() || !$('schedule-project').dataset.cwd;
    $('schedule-new').disabled = !bridge || acting;
    $('schedule-editor-title').textContent = scheduleEditor ? `Edit schedule${schedules.has(scheduleEditor) ? '' : ' · unavailable'}` : 'New schedule';
    $('schedule-draft-note').textContent = !['native', 'vm'].includes($('schedule-execution-mode').value) ? 'Choose Native or Virtual machine before saving. The saved draft is kept.' : preferences.scheduleDrafts[scheduleDraftKey()] ? 'Unsaved changes kept on this device. Switching schedules preserves this draft.' : 'Review confirms the model, execution mode, project, instructions and timing.';
    const type = $('schedule-cadence').value;
    $('schedule-interval-fields').hidden = type !== 'interval'; $('schedule-once-fields').hidden = type !== 'once'; $('schedule-calendar-fields').hidden = type !== 'calendar';
    for (const field of ['minutes', 'at', 'time', 'timezone']) $(`schedule-${field}`).required = field === 'minutes' ? type === 'interval' : field === 'at' ? type === 'once' : type === 'calendar';
    for (const button of $('schedules-list').querySelectorAll('button[data-schedule-action]')) {
      const id = button.dataset.scheduleId, action = button.dataset.scheduleAction, record = schedules.get(id), running = scheduleRunningId === id;
      button.disabled = !bridge || !schedulesLoaded || stopped || scheduleControls.has(id) || (action === 'pause' ? !record?.active && !running && !pending(id) : acting || (action === 'delete' ? !!record?.active || running : action === 'resume' ? !!record?.active || running : action === 'run' ? running : false));
    }
    for (const button of $('schedules-list').querySelectorAll('button[data-schedule-chat]')) button.disabled = !bridge || acting;
  }
  function renderSchedules() {
    const list = element('ul'); list.id = 'schedules-list'; list.setAttribute('aria-label', 'Saved schedules');
    for (const record of schedules.values()) {
      const row = element('li', 'schedule-row'); row.dataset.key = record.id; row.dataset.scheduleId = record.id;
      row.append(element('strong', '', `${record.name} · ${record.status}${scheduleRunningId === record.id ? ' · running' : ''}${schedulesLoaded ? '' : ' · not refreshed'}`));
      const cadence = record.cadence, timing = cadence.type === 'once' ? `Once · ${dateText(cadence.at)}` : cadence.type === 'interval' ? `Every ${cadence.minutes} minutes` : `${cadence.days.map(day => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]).join(', ')} · ${cadence.time} · ${cadence.timeZone}`;
      row.append(element('p', 'muted', `${record.cwd}\n${record.executionMode === 'native' ? 'Native macOS' : 'Virtual machine'} · ${record.effort === 'high' ? 'Deep' : 'Standard'}\nModel: ${record.model??LEGACY_LOCAL_MODEL}\n${timing}\nNext run: ${dateText(record.nextRunAt)}`));
      const actions = element('div', 'schedule-actions');
      for (const [action, label] of [['edit','Edit'], ['pause','Pause'], ['resume','Resume'], ['run','Run now'], ['delete','Delete']]) {
        const button = element('button', '', label); button.type = 'button'; button.dataset.scheduleAction = action; button.dataset.scheduleId = record.id;
        button.onclick = () => action === 'edit' ? editSchedule(record.id) : action === 'pause' ? controlSchedules(record.id) : mutateSchedule(action, {id: record.id}); actions.append(button);
      }
      row.append(actions);
      const history = element('details', 'schedule-history'); history.dataset.key = `history-${record.id}`; history.append(element('summary', '', `Recent runs · ${record.runs.length}`));
      for (const run of record.runs) {
        const entry = element('div', 'schedule-run'); entry.dataset.key = run.id;
        entry.append(element('p', '', `${String(run.status).replaceAll('-', ' ')}${run.manual ? ' · Run now' : ''}\nScheduled: ${dateText(run.scheduledFor)}\nStarted: ${dateText(run.startedAt)} · Finished: ${dateText(run.finishedAt)}`));
        if (run.message) entry.append(element('p', 'muted', run.message));
        if (run.threadId) {const open = element('button', '', 'Open chat'); open.type = 'button'; open.dataset.scheduleChat = run.threadId; open.onclick = () => act(async () => {const origin = selectedId; await readThread(run.threadId); if (selectedId === origin) await select(run.threadId, {historyRead: true});}, 'schedules-notice'); entry.append(open);}
        history.append(entry);
      }
      row.append(history); list.append(row);
    }
    if (!schedules.size) list.append(element('li', 'muted', schedulesLoaded ? 'No schedules yet.' : 'Refresh to load schedules.'));
    syncNode($('schedules-list'), list); scheduleControlState();
  }
  function validSchedule(record) {return !!record?.id && typeof record.name === 'string' && typeof record.cwd === 'string' && !!record.cadence && Array.isArray(record.runs) && (!Object.hasOwn(record,'model')||validScheduleModel(record.model)) && (!Object.hasOwn(record, 'executionMode') || ['native', 'vm'].includes(record.executionMode));}
  function installSchedules(result) {
    if (!Array.isArray(result.schedules) || result.schedules.some(record => !validSchedule(record))) throw new Error('The scheduler returned an invalid list. Refresh to retry.');
    if (result.schedules.length > 32 || JSON.stringify(result.schedules).length > 1000000) throw new Error('The schedule list exceeds the display limit. New results were not displayed.');
    schedules.clear(); for (const record of result.schedules) schedules.set(record.id, record);
    scheduleRunningId = result.runningId || null; schedulesLoaded = true; scheduleRecoveryAvailable = result.recoveryAvailable === true;
    banner('schedules-warning', [result.warning, result.historyTruncated ? 'Earlier run history was omitted. Saved chats remain available.' : ''].filter(Boolean).join(' ')); renderSchedules();
  }
  async function refreshSchedules() {
    if (scheduleRead) return scheduleRead;
    const revision = scheduleRevision;
    scheduleRead = (async () => {try {const result = await scheduleCall('list'); if (revision === scheduleRevision) installSchedules(result);} catch (error) {schedulesLoaded = false; renderSchedules(); throw error;} finally {scheduleLastRead = Date.now(); scheduleRead = null;}})();
    return scheduleRead;
  }
  async function mutateSchedule(action, input) {
    if (scheduleControls.has('*') || scheduleControls.has(input.id)) return;
    await act(async () => {
      const token = {id: input.id, cancelled: false}; scheduleMutations.add(token); scheduleControlState();
      try {
        const result = await scheduleCall(action, input, token);
        const recovered = action === 'recover' && result.recovered === true && Array.isArray(result.schedules) && result.schedules.length <= 32 && result.schedules.every(record => validSchedule(record) && record.active === false) && JSON.stringify(result.schedules).length <= 1000000;
        if (token.cancelled || result.cancelled) {
          const notice = action !== 'recover' ? 'Schedule action cancelled. Your draft is kept.' : recovered ? 'Recovery completed. All schedules remain paused; existing workspace execution restrictions remain. Refresh to inspect the saved records. Your draft is kept.' : token.cancelled ? 'Schedule recovery was interrupted and may already have completed. Refresh to inspect the saved records. Your draft is kept.' : 'Schedule recovery review cancelled. No recovery was committed. Your draft is kept.';
          banner('schedules-notice', notice); return;
        }
        if (action === 'recover' && !recovered) throw new Error('Schedule recovery completion is unconfirmed. Refresh to inspect the saved records.');
        installSchedules(result);
        if (action === 'save') {delete preferences.scheduleDrafts[input.id || 'new']; editSchedule(result.schedule?.id || input.id);}
        banner('schedules-notice', action === 'save' ? 'Schedule saved and activated.' : action === 'run' ? 'Run now reviewed. Check the run history for its outcome.' : action === 'resume' ? 'Schedule resumed.' : action === 'recover' ? 'Saved schedules recovered. All remain paused; existing workspace execution restrictions remain. Your drafts are kept.' : 'Schedule deleted. Its chats and project files are kept.');
      } finally {scheduleMutations.delete(token); scheduleControlState();}
    }, 'schedules-notice');
  }
  async function controlSchedules(id) {
    const key = id || '*'; if (scheduleControls.has('*') || scheduleControls.has(key)) return;
    clearStopNotice();cancelScheduleMutations(id); const revision = scheduleRevision; scheduleControls.add(key); scheduleControlState();
    try {const result = await scheduleCall(id ? 'pause' : 'stop', id ? {id} : {}); if (revision === scheduleRevision) installSchedules(result);
      const blocked = result.blocked || result.persistence === 'failed';
      const notice = result.stopped === false ? 'Scheduled work cancellation is unconfirmed.' : blocked ? 'Current scheduled work stopped.' : id ? 'Schedule paused. Cancellation does not undo project changes.' : 'All schedules paused. Cancellation does not undo project changes.';
      banner('schedules-notice', notice + (blocked ? ' ' + String(result.message ?? 'Schedule persistence failed; schedules remain blocked.').slice(0,1800) : ''));}
    catch (error) {schedulesLoaded = false; renderSchedules(); banner('schedules-notice', message(error));}
    finally {scheduleControls.delete(key); scheduleControlState();}
  }
  function submitSchedule(event) {
    event.preventDefault(); const draft = readScheduleForm(); let cadence;
    if (!['native', 'vm'].includes(draft.executionMode)) {banner('schedules-notice', 'Choose Native or Virtual machine before saving. Your draft is kept.'); return;}
    if(!validScheduleModel(draft.model)){banner('schedules-notice','Choose a model before saving. Your draft is kept.');return;}
    if (draft.type === 'calendar') {if (!draft.days.length) {banner('schedules-notice', 'Choose at least one day.'); return;} cadence = {type: 'calendar', days: draft.days, time: draft.time, timeZone: draft.timeZone.trim()};}
    else if (draft.type === 'once') {const at = new Date(draft.at).getTime(); if (!Number.isSafeInteger(at)) {banner('schedules-notice', 'Choose a valid date and time.'); return;} cadence = {type: 'once', at};}
    else cadence = {type: 'interval', minutes: Number(draft.minutes)};
    mutateSchedule('save', {id: scheduleEditor || null, name: draft.name.trim(), cwd: draft.cwd, prompt: draft.prompt, effort: draft.effort, model:draft.model, executionMode: draft.executionMode, cadence});
  }
  // Saved command evidence never enters the live terminal map or any draft.
  let savedTerminal={threadId:'',epoch:0,request:0,rows:[],record:null,ownerId:null,omittedCount:0,loading:false,again:false,notice:''};
  const terminalSaveWarnings=new Map();
  const savedResultLabel=row=>row.state==='exited'?`Observed exit ${row.exitCode}${row.stopRequested?' · Stop requested':''}`:row.state==='not-started'?'Not started':'Outcome unconfirmed';
  const savedResultTime=value=>Number.isFinite(new Date(value).getTime())?new Date(value).toLocaleString():`${value} ms since epoch`;
  function syncTerminalResults() {
    if(savedTerminal.threadId!==selectedId||savedTerminal.epoch!==selectionEpoch)savedTerminal={threadId:selectedId,epoch:selectionEpoch,request:0,rows:[],record:null,ownerId:null,omittedCount:0,loading:false,again:false,notice:''};
  }
  function renderTerminalResults() {
    syncTerminalResults();const state=savedTerminal,live=!!terminals.get(selectedId)?.running,select=$('terminal-results');
    const chosen=state.record?.recordId||'';
    if(select.dataset.rows!==JSON.stringify(state.rows)){
      select.replaceChildren();for(const row of state.rows){const option=element('option','',`${savedResultTime(row.endedAt??row.createdAt)} · ${savedResultLabel(row)} · ${row.commandPreview}${row.commandTruncated?'…':''}`);option.value=row.recordId;select.append(option);}
      if(!state.rows.length){const option=element('option','','No saved results');option.value='';select.append(option);}select.dataset.rows=JSON.stringify(state.rows);
    }
    select.value=chosen;select.disabled=live||state.loading||!state.rows.length;
    $('terminal-results-refresh').disabled=!bridge||!selectedId||!!current()?.metadataPending||state.loading;
    const notices=[state.loading?'Checking saved results…':state.notice,terminalSaveWarnings.get(selectedId),state.omittedCount?`${state.omittedCount} older results omitted across this owner; this count includes its other chats.`:'',live?'Live terminal takes precedence. Saved results are read only.':''];
    if(!state.loading&&!state.notice&&!state.record)notices.unshift(current()?.historySource==='legacy'?'Saved command results are unavailable for this legacy chat.':'No saved reviewed commands.');
    $('terminal-results-notice').textContent=notices.filter(Boolean).join(' ');
    const row=state.record;$('terminal-saved-result').hidden=live||!row;
    if(!row)return;
    $('terminal-saved-status').textContent=savedResultLabel(row);
    $('terminal-saved-meta').textContent=`Project at execution: ${row.cwd}\nStarted: ${savedResultTime(row.createdAt)}${row.endedAt===null?' · End time unconfirmed':` · Observed end: ${savedResultTime(row.endedAt)}`}`;
    if($('terminal-saved-command').textContent!==row.command)$('terminal-saved-command').textContent=row.command;if($('terminal-saved-output').textContent!==row.output)$('terminal-saved-output').textContent=row.output;
    $('terminal-saved-warning').textContent=[row.outputTruncated?`Saved output is truncated${row.droppedOutputBytes?`; at least ${row.droppedOutputBytes} UTF-8 bytes omitted`:''}.`:'',!row.observationComplete?'Observation is incomplete. No command is retried.':'',row.error||''].filter(Boolean).join(' ');
  }
  async function refreshTerminalResults(recordId) {
    syncTerminalResults();const state=savedTerminal,thread=current();
    if(disposed||!bridge||panel!=='terminal'||!state.threadId||!thread||thread.metadataPending)return;
    if(thread.historySource==='legacy'){state.notice='Saved command results are unavailable for this legacy chat.';renderTerminalResults();return;}
    if(state.loading&&!recordId){state.again=true;return;}
    const request=++state.request,scope={threadId:state.threadId,rootThreadId:thread.rootThreadId||familyFor(state.threadId)?.rootThreadId||state.threadId};state.loading=true;renderTerminalResults();
    const valid=()=>!disposed&&savedTerminal===state&&state.request===request&&selectedId===scope.threadId&&selectionEpoch===state.epoch;
    try{
      const list=codingTerminalResultSnapshot(await call('terminalResults',{threadId:scope.threadId}),scope.threadId,null,state.ownerId,scope.rootThreadId);if(!valid())return;
      const chosen=recordId|| (list.records.some(row=>row.recordId===state.record?.recordId)?state.record.recordId:list.records[0]?.recordId);
      let record=null,omittedCount=list.omittedCount;
      if(chosen){const detail=codingTerminalResultSnapshot(await call('terminalResults',{threadId:scope.threadId,recordId:chosen}),scope.threadId,chosen,list.ownerId,scope.rootThreadId);if(!valid())return;record=detail.record;omittedCount=detail.omittedCount;}
      state.rows=list.records;state.ownerId=list.ownerId;state.record=record;state.omittedCount=omittedCount;state.notice='';
    }catch(error){if(valid())state.notice=message(error)==='Tools are busy stopping; wait for Stop to finish before starting or reading work.'?'Waiting for Stop to finish. Earlier saved evidence remains visible.':`Saved command results are unavailable. ${state.record?'Earlier evidence remains visible. ':''}Refresh to check again.`;}
    finally{if(valid()){state.loading=false;renderTerminalResults();if(state.again){state.again=false;void refreshTerminalResults();}}}
  }
  function terminalResultEvent(method,params) {
    if(typeof params.threadId!=='string'||!['coding/terminal/resultsChanged','coding/terminal/resultSaveFailed'].includes(method))return false;
    if(method==='coding/terminal/resultSaveFailed'){
      terminalSaveWarnings.set(params.threadId,`Result save unconfirmed${typeof params.message==='string'?`: ${params.message.slice(0,1000)}`:'.'} Physical command exit and saving are separate.`);
      while(terminalSaveWarnings.size>32)terminalSaveWarnings.delete(terminalSaveWarnings.keys().next().value);
    }
    if(params.threadId===selectedId){if(method==='coding/terminal/resultsChanged')void refreshTerminalResults();renderTerminalResults();}return true;
  }

  function renderTerminal() {
    const terminal = terminals.get(selectedId), pre = $('terminal-output'), atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80;
    pre.textContent = terminal?.mode === 'pty' ? 'Interactive output appears in the live screen above.' : terminal?.output || ''; if (atBottom) pre.scrollTop = pre.scrollHeight;
    $('pty-panel').hidden = terminal?.mode !== 'pty';
    pty.show(terminal?.mode === 'pty' ? {...terminal, threadId: selectedId, cwd: terminal.cwd || current()?.cwd} : null, panel === 'terminal', canExecute(current()));
    renderTerminalResults();
    $('terminal-status').textContent = !terminal ? 'No command started' : terminal.stopRequested && terminal.running ? 'Stop requested' : terminal.running ? 'Running' : terminal.error || (terminal.exitCode != null ? `Exited · code ${terminal.exitCode}` : 'Command finished');
    controls();
  }
  const gitFields = {message: 'git-message', authorName: 'git-author-name', authorEmail: 'git-author-email', name: 'git-branch-name', switchName: 'git-switch-branch'};
  const publishFields = {publishRemote:'git-remote',publishBranch:'git-publish-branch',publishBase:'git-base-branch'};
  const publishKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
  const savedPublishKey = key => publishKey(key) && Object.hasOwn(preferences.publishDrafts || {},key) && typeof preferences.publishDrafts[key]?.title==='string' && typeof preferences.publishDrafts[key]?.body==='string';
  const githubURL = url => typeof url === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}\.git$/.test(url);
  function prURL(url, number, fullName) {return Number.isSafeInteger(number) && number > 0 && typeof fullName === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(fullName) && typeof url === 'string' && url.toLowerCase() === `https://github.com/${fullName}/pull/${number}`.toLowerCase();}
  function validObservedPull(pr, receipt) {
    const repository=receipt?.remoteIntent?.repository;
    return repository && prURL(pr?.url,pr?.number,repository.fullName) && Number.isSafeInteger(pr.id) && pr.id>0 && ['open','closed'].includes(pr.state) && typeof pr.draft==='boolean' && ['head','base'].every(key=>pr[key]?.repoId===repository.id && pr[key].fullName?.toLowerCase()===repository.fullName.toLowerCase() && typeof pr[key].ref==='string' && pr[key].ref.length<=200 && /^[a-f0-9]{40}$/.test(pr[key].sha));
  }
  function reservePublishDraft(key) {
    preferences.publishDrafts ??= {};
    if(!savedPublishKey(key)){
      if(Object.hasOwn(preferences.publishDrafts,key) || Object.keys(preferences.publishDrafts).length>=128)return false;
      preferences.publishDrafts[key]={title:'',body:''};
    }
    return save();
  }
  function loadPublishText() {
    const draft = gitPublishKey && preferences.publishDrafts?.[gitPublishKey];
    $('git-pr-title').value = typeof draft?.title === 'string' ? draft.title : '';
    $('git-pr-body').value = typeof draft?.body === 'string' ? draft.body : '';
  }
  function loadPublishForm(snapshot, draft) {
    $('git-publish-branch').value = typeof draft.publishBranch === 'string' ? draft.publishBranch : snapshot?.branch || '';
    $('git-base-branch').value = typeof draft.publishBase === 'string' ? draft.publishBase : 'main';
    gitPublishKey = savedPublishKey(draft.publishDraftKey) ? draft.publishDraftKey : ''; loadPublishText();
  }
  function rememberPublishText() {
    if (!gitFormRepository || !gitPublishKey) return true;
    if (!savedPublishKey(gitPublishKey)) return false;
    preferences.publishDrafts[gitPublishKey] = {...preferences.publishDrafts[gitPublishKey],title:$('git-pr-title').value,body:$('git-pr-body').value}; const saved=save(); gitControlState();return saved;
  }
  function rememberPublishTarget() {
    if (!gitFormRepository) return;
    preferences.gitDrafts[gitFormRepository] = {...preferences.gitDrafts[gitFormRepository],...Object.fromEntries(Object.entries(publishFields).map(([key,id])=>[key,$(id).value])),publishDraftKey:gitPublishKey}; save();
  }
  function changePublishTarget() {
    if(!rememberPublishText()){const saved=preferences.gitDrafts[gitFormRepository];for(const [key,id] of Object.entries(publishFields))if(typeof saved?.[key]==='string')$(id).value=saved[key];return;}gitPublishKey = '';const state = gitResults.get(selectedId);if (state) state.remote = null;
    rememberPublishTarget();loadPublishText();renderPublishing(state);gitControlState();
  }
  function validRemote(view, snapshot) {
    return view && snapshot && typeof view.id === 'string' && view.localSnapshotId === snapshot.id && view.repositoryId === snapshot.repositoryId && view.localHead === snapshot.head && publishKey(view.draftKey) && githubURL(view.remote?.url) && snapshot.remotes?.some(row=>row.supported && row.name===view.remote.name && row.url===view.remote.url) && Number.isSafeInteger(view.account?.id) && view.account.id>0 && typeof view.account.login==='string' && Number.isSafeInteger(view.repository?.id) && view.repository.id>0 && typeof view.repository.fullName==='string' && typeof view.branch==='string' && typeof view.base==='string' && (view.oldOID===null || /^[a-f0-9]{40}$/.test(view.oldOID)) && (view.baseOID===null || /^[a-f0-9]{40}$/.test(view.baseOID)) && Number.isFinite(view.expiresAt);
  }
  function freshRemote(state) {
    const view = state?.remote;
    return validRemote(view,state?.snapshot) && view.expiresAt>Date.now() && view.remote.name===$('git-remote').value && view.branch===$('git-publish-branch').value && view.base===$('git-base-branch').value ? view : null;
  }
  function publishingControls(state, writable, ready) {
    const snapshot=state?.snapshot,view=freshRemote(state),remote=snapshot?.remotes?.find(row=>row.name===$('git-remote').value && row.supported);
    for(const id of Object.values(publishFields))$(id).disabled=!writable || !snapshot || !!gitOperation;
    for(const id of ['git-pr-title','git-pr-body'])$(id).disabled=!writable || !gitPublishKey;
    $('git-remote-check').disabled=!ready || !remote || !snapshot?.head || !$('git-publish-branch').value.trim() || !$('git-base-branch').value.trim();
    const fenced=snapshot?.remoteReceipts?.some(row=>row.state==='unknown' && !row.remoteAcknowledged && row.remoteIntent.repository.id===view?.repository.id);
    $('git-publish').disabled=!ready || !view || !view.repository.canPush || fenced;
    $('git-pr-create').disabled=!ready || !view || !view.repository.canPush || fenced || view.oldOID!==snapshot.head || !view.baseOID || view.branch===view.base || !$('git-pr-title').value.trim();
    for(const button of $('git-remote-receipts').querySelectorAll('button'))button.disabled=!ready;
  }
  function renderPublishing(state) {
    const snapshot=state?.snapshot,draft=preferences.gitDrafts[snapshot?.repositoryId] || {},picker=$('git-remote').cloneNode(false),saved=draft.publishRemote || $('git-remote').value;
    const empty=element('option','','Choose a GitHub remote');empty.value='';picker.append(empty);
    for(const row of snapshot?.remotes || []){const option=element('option','',row.supported ? `${row.name} · ${row.fullName}` : `${row.name} · unsupported`);option.value=row.name;option.disabled=!row.supported;picker.append(option);}
    syncNode($('git-remote'),picker);$('git-remote').value=snapshot?.remotes?.some(row=>row.name===saved) ? saved : snapshot?.remotes?.find(row=>row.supported)?.name || '';
    const view=freshRemote(state);
    $('git-remote-status').textContent=view ? `${view.account.login} · ${view.repository.fullName}\n${view.branch} ← ${view.localHead}\n${view.oldOID===view.localHead ? 'This commit is already published.' : view.oldOID ? 'Publish requires a fast-forward from '+view.oldOID : 'A new remote branch will be created.'}${view.repository.canPush ? '' : '\nThis account has no push permission.'}` : snapshot?.remoteWarning || (!snapshot?.remotes?.some(row=>row.supported) ? 'No supported GitHub HTTPS destination. See Connection help.' : 'Check target to verify the current account, destination and refs.');
    $('git-pr-draft-note').textContent=gitPublishKey ? 'Saved with this repository, account, head and base. Unsent text is kept on failure, Stop and existing PR results.' : 'Check target to start or restore a draft for this repository, account, head and base.';
    const list=$('git-remote-receipts').cloneNode(false);
    for(const receipt of [...(snapshot?.remoteReceipts || [])].reverse()){
      const row=element('div','git-remote-outcome');row.dataset.key=receipt.requestId;row.append(element('p','',`${receipt.kind==='createPR'?'Pull request':'Publish branch'} · ${receipt.state}${receipt.remoteAcknowledged?' · acknowledged':''}`),element('p','muted',receipt.message));
      if(prURL(receipt.remoteURL,receipt.remoteNumber,receipt.remoteIntent.repository.fullName)){const link=element('a','','Open pull request #'+receipt.remoteNumber);link.href=receipt.remoteURL;link.target='_blank';link.rel='noopener noreferrer';row.append(link);}
      if(receipt.state==='unknown' && !receipt.remoteAcknowledged){const observation=state.remoteObservations?.get(receipt.requestId),button=element('button','','Inspect saved outcome');button.type='button';button.dataset.remoteInspect=receipt.requestId;button.onclick=()=>inspectRemote('inspectRemoteOutcome',receipt.requestId);row.append(button);
        if(observation){row.append(element('p','muted',`Observed head: ${observation.headOID || 'absent'}\nMatching pull requests: ${observation.matches.length}. Acknowledgement permits a new review; it does not replay this request.`));for(const pr of observation.matches){const link=element('a','','Open pull request #'+pr.number);link.href=pr.url;link.target='_blank';link.rel='noopener noreferrer';row.append(element('p','muted',`${pr.state}${pr.draft?' · draft':''}\nHead: ${pr.head.ref} @ ${pr.head.sha}\nBase: ${pr.base.ref} @ ${pr.base.sha}`),link);}const ack=element('button','','Acknowledge inspected outcome');ack.type='button';ack.dataset.remoteAcknowledge=receipt.requestId;ack.onclick=()=>inspectRemote('acknowledgeRemoteOutcome',receipt.requestId,observation.id);row.append(ack);}}
      list.append(row);
    }
    syncNode($('git-remote-receipts'),list);
  }
  async function inspectRemote(action='remoteInspect',requestId=crypto.randomUUID(),observationId) {
    const threadId=selectedId,state=gitState(threadId),snapshot=state.snapshot;if(acting || gitOperation || !canExecute(current()) || !state.usable || !snapshot)return;
    if(!rememberPublishText())return;rememberPublishTarget();if(action==='remoteInspect')state.remote=null;if(action==='inspectRemoteOutcome')state.remoteObservations?.delete(requestId);const input={threadId,requestId};
    if(action==='remoteInspect')Object.assign(input,{snapshotId:snapshot.id,remote:$('git-remote').value,branch:$('git-publish-branch').value,base:$('git-base-branch').value});
    else if(action==='acknowledgeRemoteOutcome')input.observationId=observationId;
    await act(async()=>{
      const token={threadId,requestId,cancelled:false};gitOperation=token;const epoch=++gitEpoch,revision=state.revision;state.notice='Inspecting the saved GitHub target…';renderGit();
      try{const answer=await gitCall(action,input,token);if(token.cancelled || epoch!==gitEpoch || state.revision!==revision)return;
        if(action==='remoteInspect'){
          const view=answer.remoteSnapshot;if(!validRemote(view,snapshot) || view.remote.name!==input.remote || view.branch!==input.branch || view.base!==input.base)throw Error('Remote target could not be verified.');state.remote=view;
          const available=reservePublishDraft(view.draftKey),stored=preferences.gitDrafts[snapshot.repositoryId];if(stored?.publishRemote===input.remote && stored.publishBranch===input.branch && stored.publishBase===input.base){stored.publishDraftKey=available?view.draftKey:'';save();if(gitFormRepository===snapshot.repositoryId){gitPublishKey=stored.publishDraftKey;loadPublishText();}}
          state.notice=available?'GitHub target checked. Review the account, commit and branches before publishing.':'GitHub target checked. PR draft storage is full (128 targets) or unavailable. New draft editing is disabled; existing text is kept.';
        }else if(action==='inspectRemoteOutcome'){
          const o=answer.observation;if(!o || typeof o.id!=='string' || o.requestId!==requestId || !Array.isArray(o.matches) || o.matches.length>1000 || o.matches.some(pr=>!validObservedPull(pr,snapshot.remoteReceipts?.find(row=>row.requestId===requestId))) || !Number.isFinite(o.expiresAt))throw Error('Saved outcome inspection could not be verified.');state.remoteObservations??=new Map();state.remoteObservations.set(requestId,o);state.notice='Saved outcome inspected. Read the observation before acknowledging it.';
        }else{if(answer.acknowledged!==true || answer.requestId!==requestId)throw Error('Outcome acknowledgement could not be verified.');state.remoteObservations?.delete(requestId);await readGit(threadId);state.notice='Inspection acknowledged. No request was replayed. Check target for a new review.';}
      }catch(error){if(!token.cancelled && epoch===gitEpoch)state.notice=`GitHub inspection failed: ${message(error)} Your text is kept.`;}
      finally{if(gitOperation===token)gitOperation=null;if(threadId===selectedId)renderGit();}
    },'git-notice');
  }
  function gitState(id = selectedId) {
    if (!gitResults.has(id)) gitResults.set(id, {snapshot: null, usable: false, selected: new Set(), diffPath: null, temporaryExpanded: false, notice: '', revision: 0});
    return gitResults.get(id);
  }
  function rememberGitForm() {
    if (!gitFormRepository) return;
    preferences.gitDrafts[gitFormRepository] = {...preferences.gitDrafts[gitFormRepository], ...Object.fromEntries(Object.entries(gitFields).map(([key, id]) => [key, $(id).value]))}; rememberWorktreeGit(gitResults.get(selectedId)?.snapshot, preferences.gitDrafts[gitFormRepository]); save(); gitControlState();
  }
  function worktreeGitText(draft) {
    return Object.fromEntries(Object.entries({message: 8192, authorName: 120, authorEmail: 254, name: 200}).filter(([key, max]) => typeof draft?.[key] === 'string' && draft[key].length <= max).map(([key]) => [key, draft[key]]));
  }
  function rememberWorktreeGit(snapshot, draft) {
    const record = snapshot && [...worktrees.values()].find(record => record.cwd === snapshot.cwd);
    if (!record) return;
    if (!Object.hasOwn(preferences.worktreeGitDrafts, record.id) && Object.keys(preferences.worktreeGitDrafts).length >= 128) delete preferences.worktreeGitDrafts[Object.keys(preferences.worktreeGitDrafts)[0]];
    preferences.worktreeGitDrafts[record.id] = worktreeGitText(draft);
  }
  function gitControlState() {
    const state = gitResults.get(selectedId), snapshot = state?.snapshot;
    const writable = !!bridge && directInput(current()), ready = writable && canExecute(current()) && state?.usable && !acting && !gitOperation;
    for (const id of Object.values(gitFields)) $(id).disabled = !writable || !snapshot;
    for (const input of $('git-paths').querySelectorAll('input')) input.disabled = !ready;
    const selected = snapshot?.entries.filter(entry => state.selected.has(entry.id)) || [];
    $('git-stage').disabled = !ready || !selected.some(entry => entry.canStage);
    $('git-unstage').disabled = !ready || !selected.some(entry => entry.canUnstage);
    $('git-stage').textContent = `Review stage selected${selected.length ? ` (${selected.filter(entry => entry.canStage).length})` : ''}`;
    $('git-unstage').textContent = `Review unstage selected${selected.length ? ` (${selected.filter(entry => entry.canUnstage).length})` : ''}`;
    $('git-commit').disabled = !ready || !snapshot.entries.some(entry => entry.canUnstage) || !$('git-message').value.trim() || !$('git-author-name').value.trim() || !$('git-author-email').value.trim();
    $('git-create-branch').disabled = !ready || !snapshot.head || !$('git-branch-name').value.trim();
    const target = snapshot?.branches.find(branch => branch.name === $('git-switch-branch').value);
    $('git-switch').disabled = !ready || !target || target.current || target.checkedOut;
    publishingControls(state, writable, ready);
    $('git-stop').hidden = !gitOperation; $('git-stop').disabled = !bridge || !gitOperation || gitOperation.cancelled;
    $('git-stop').textContent = gitOperation?.cancelled ? 'Git action stopped · awaiting response' : `Stop Git action${gitOperation && gitOperation.threadId !== selectedId ? ` · ${title(threads.get(gitOperation.threadId))}` : ''}`;
  }
  function renderGitDiff(state) {
    const snapshot = state?.snapshot, entry = snapshot?.entries.find(row => row.path === state.diffPath);
    const view = Array.isArray(snapshot?.fileDiffs) && entry ? snapshot.fileDiffs.find(row => row.entryId === entry.id) : null;
    if (!view && state) state.diffPath = null;
    $('git-diff-title').textContent = view ? entry.path : 'All changes';
    $('git-diff-all').setAttribute('aria-pressed', String(!view));
    let notice = snapshot && !Array.isArray(snapshot.fileDiffs) ? 'File previews unavailable. Tracked-file aggregate shown; untracked contents omitted.' : snapshot && !view ? 'Tracked-file aggregate. Open an untracked file for its separate preview.' : '';
    const sections = view ? [['Working tree', view.workingTree], ['Staged', view.staged]].filter(([, patch]) => patch) : [['', snapshot?.diff || (snapshot ? 'No tracked-file diff.' : 'Refresh to inspect this repository.')]];
    const fresh = $('git-diff').cloneNode(false), plain = sections.reduce((count, [, patch]) => count + patch.split('\n').length, 0) > 2000;
    if (plain) notice = [notice, 'Large patch shown as plain text.'].filter(Boolean).join(' ');
    if (!sections.length) fresh.append(element('span', 'git-diff-empty', entry.index === '?' ? 'Untracked file. Its contents are not included in the tracked diff.' : 'No patch was captured for this file. Choose All changes to inspect the snapshot.'));
    for (const [side, patch] of sections) {
      if (side) fresh.append(element('span', 'git-diff-heading', side + '\n'));
      if (plain) {fresh.append(document.createTextNode(patch)); continue;}
      let old = 0, next = 0, left = 0, right = 0;
      for (const [index, line] of patch.split('\n').entries()) {
        const row = element('span', 'git-diff-line'), code = element('span', 'git-diff-code', line + '\n');
        row.dataset.key = side + ':' + index; row.dataset.old = ''; row.dataset.new = ''; row.dataset.kind = 'metadata';
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && hunk.slice(1).every(value => value === undefined || Number.isSafeInteger(Number(value)) && Number(value) < 100000000)) {
          [old, left, next, right] = [Number(hunk[1]), Number(hunk[2] ?? 1), Number(hunk[3]), Number(hunk[4] ?? 1)]; row.dataset.kind = 'hunk';
        } else if (line.startsWith(' ') && left && right) {row.dataset.kind = 'context'; row.dataset.old = old++; row.dataset.new = next++; left--; right--;}
        else if (line.startsWith('-') && left) {row.dataset.kind = 'deletion'; row.dataset.old = old++; left--;}
        else if (line.startsWith('+') && right) {row.dataset.kind = 'addition'; row.dataset.new = next++; right--;}
        else if (!line.startsWith('\\ No newline at end of file')) {left = right = 0;}
        row.append(code); fresh.append(row);
      }
    }
    $('git-diff-status').textContent = notice; $('git-diff-status').hidden = !notice;
    syncNode($('git-diff'), fresh);
  }
  function renderGit() {
    const state = gitResults.get(selectedId), snapshot = state?.snapshot, repository = snapshot?.repositoryId || '';
    const fileHadFocus = $('git-paths').contains(document.activeElement) && document.activeElement.matches('.git-file-open, #git-temporary-toggle');
    if (gitFormRepository !== repository) {
      gitFormRepository = repository;
      const draft = preferences.gitDrafts[repository] || {authorName: snapshot?.author.name || '', authorEmail: snapshot?.author.email || ''};
      for (const [key, id] of Object.entries(gitFields)) $(id).value = typeof draft[key] === 'string' ? draft[key] : '';
      loadPublishForm(snapshot, draft);
    }
    // Filename grouping is presentation only; it never grants scratch ownership or omits Git state.
    const markers = new Set((snapshot?.entries || []).filter(entry => entry.index === '?' && entry.worktree === '?' && /(?:^|\/)\.saleh-coding-tmp-[a-fA-F0-9]{32}\/\.saleh-owner$/.test(entry.path)));
    banner('git-notice', state?.notice);
    $('git-branch').textContent = snapshot ? `${snapshot.branch ? `Branch · ${snapshot.branch}` : snapshot.head ? 'Detached HEAD' : 'Unborn HEAD'}${snapshot.head ? ` · ${snapshot.head}` : ''}` : '';
    $('git-status').textContent = snapshot ? `${markers.size ? `${snapshot.entries.length - markers.size} project paths · ${markers.size} temporary marker${markers.size === 1 ? '' : 's'}` : `${snapshot.entries.length} changed paths`}${state.usable ? ' · snapshot; review rechecks current contents' : ' · refresh required before another action'}` : 'Refresh to inspect this repository.';
    $('git-note').textContent = snapshot ? `${snapshot.truncated ? 'Truncated output. ' : ''}${snapshot.warning || ''} All changes shows tracked diffs. Open an untracked file for its preview when available. Native review confirms the exact effect.` : 'Refresh to inspect this repository.';
    renderGitDiff(state);
    const branchDraft = preferences.gitDrafts[repository]?.switchName || '', picker = $('git-switch-branch').cloneNode(false);
    const placeholder = element('option', '', 'Choose a local branch'); placeholder.value = ''; picker.append(placeholder);
    for (const branch of snapshot?.branches || []) {const option = element('option', '', `${branch.name}${branch.current ? ' · current' : branch.checkedOut ? ' · used by another worktree' : ''}`); option.value = branch.name; option.disabled = branch.current || branch.checkedOut; picker.append(option);}
    if (branchDraft && !snapshot?.branches.some(branch => branch.name === branchDraft)) {const unavailable = element('option', '', `${branchDraft} · saved selection unavailable`); unavailable.value = branchDraft; unavailable.disabled = true; picker.append(unavailable);}
    syncNode($('git-switch-branch'), picker); $('git-switch-branch').value = branchDraft;
    banner('git-branch-warning', snapshot?.branchWarning || (snapshot && !snapshot.branches.length ? 'No local branches are available to switch.' : ''));
    const list = $('git-paths').cloneNode(false), temporary = element('ul'); temporary.id = 'git-temporary-paths'; temporary.dataset.key = 'temporary-list'; temporary.setAttribute('aria-label', 'Temporary marker paths'); temporary.hidden = !state?.temporaryExpanded;
    for (const entry of snapshot?.entries || []) {
      const row = element('li', 'git-path'); row.dataset.key = 'file:' + entry.path;
      const label = element('label'), input = element('input'); input.type = 'checkbox'; input.dataset.entryId = entry.id; input.checked = state.selected.has(entry.id); input.setAttribute('aria-label', `Select ${entry.path}`);
      input.onclick = event => {if (event.currentTarget.checked) state.selected.add(entry.id); else state.selected.delete(entry.id); gitControlState();};
      const open = element('button', 'git-file-open', entry.path); open.type = 'button'; open.setAttribute('aria-label', `View changes in ${entry.path}`); open.setAttribute('aria-controls', 'git-diff'); open.setAttribute('aria-pressed', String(state.diffPath === entry.path)); open.disabled = !Array.isArray(snapshot.fileDiffs);
      open.onclick = () => {state.diffPath = entry.path; renderGit();};
      label.append(input); row.append(label, open, element('small', '', `Index: ${entry.index.trim() || 'unchanged'} · Working tree: ${entry.worktree.trim() || 'unchanged'}`)); (markers.has(entry) ? temporary : list).append(row);
    }
    if (markers.size) {
      const group = element('li', 'git-temporary-group'); group.dataset.key = 'group:temporary-markers';
      const toggle = element('button', 'git-temporary-toggle', `${state.temporaryExpanded ? 'Hide' : 'Show'} temporary markers (${markers.size})`); toggle.id = 'git-temporary-toggle'; toggle.type = 'button'; toggle.dataset.key = 'temporary-toggle'; toggle.setAttribute('aria-expanded', String(!!state.temporaryExpanded)); toggle.setAttribute('aria-controls', temporary.id);
      toggle.onclick = () => {state.temporaryExpanded = !state.temporaryExpanded; renderGit();};
      group.append(toggle, temporary); list.append(group);
    }
    syncNode($('git-paths'), list);
    for (const input of $('git-paths').querySelectorAll('input')) input.checked = state.selected.has(input.dataset.entryId);
    if (fileHadFocus && (!document.activeElement?.isConnected || document.activeElement === document.body || document.activeElement.disabled)) $('git-diff-all').focus();
    renderPublishing(state); gitControlState();
  }
  function installGit(id, snapshot) {
    if (!snapshot || !['id','repositoryId','cwd','branch','diff'].every(key => typeof snapshot[key] === 'string') || !snapshot.id || !snapshot.repositoryId || !(snapshot.head === null || typeof snapshot.head === 'string') || !snapshot.author || typeof snapshot.author.name !== 'string' || typeof snapshot.author.email !== 'string' || !Array.isArray(snapshot.entries) || snapshot.entries.length > 20000 || JSON.stringify(snapshot).length > 1000000 || snapshot.entries.some(entry => !entry || !['id','path','index','worktree'].every(key => typeof entry[key] === 'string') || !entry.id || entry.id.length > 160 || typeof entry.canStage !== 'boolean' || typeof entry.canUnstage !== 'boolean') || new Set(snapshot.entries.map(entry => entry.id)).size !== snapshot.entries.length) throw Error('Git returned an invalid or oversized snapshot. Refresh to retry.');
    if (typeof snapshot.commonRepositoryId !== 'string' || !snapshot.commonRepositoryId || !Array.isArray(snapshot.branches) || snapshot.branches.length > 512 || snapshot.branches.some(branch => !branch || typeof branch.name !== 'string' || !branch.name || new TextEncoder().encode(branch.name).length > 200 || typeof branch.head !== 'string' || typeof branch.current !== 'boolean' || typeof branch.checkedOut !== 'boolean') || new Set(snapshot.branches.map(branch => branch.name)).size !== snapshot.branches.length || snapshot.branchWarning !== undefined && typeof snapshot.branchWarning !== 'string') throw Error('Git returned an invalid branch inventory. Refresh to retry.');
    if(snapshot.remotes!==undefined && (!Array.isArray(snapshot.remotes) || snapshot.remotes.length>32 || snapshot.remotes.some(row=>!row || typeof row.name!=='string' || row.name.length>100 || typeof row.supported!=='boolean' || row.supported && (!githubURL(row.url) || typeof row.fullName!=='string'))))throw Error('Git returned invalid publishing destinations.');
    if(snapshot.remoteReceipts!==undefined && (!Array.isArray(snapshot.remoteReceipts) || snapshot.remoteReceipts.length>128 || snapshot.remoteReceipts.some(row=>!row || typeof row.requestId!=='string' || !['publishBranch','createPR'].includes(row.kind) || typeof row.message!=='string' || !['executing','completed','unknown','cancelled','stale','failed'].includes(row.state) || typeof row.remoteAcknowledged!=='boolean' || !Number.isSafeInteger(row.remoteIntent?.repository?.id) || typeof row.remoteIntent.repository.fullName!=='string')))throw Error('Git returned invalid saved publishing outcomes.');
    const entryIds = new Set(snapshot.entries.map(entry => entry.id));
    if (snapshot.fileDiffs !== undefined && snapshot.fileDiffs !== null && (snapshot.truncated === true || !Array.isArray(snapshot.fileDiffs) || snapshot.fileDiffs.length !== snapshot.entries.length || snapshot.fileDiffs.some(row => !row || Object.keys(row).sort().join() !== 'entryId,staged,workingTree' || !entryIds.has(row.entryId) || typeof row.workingTree !== 'string' || typeof row.staged !== 'string') || new Set(snapshot.fileDiffs.map(row => row.entryId)).size !== snapshot.entries.length)) throw Error('Git returned invalid file previews. Refresh to retry.');
    const record = worktreesLoaded && [...worktrees.values()].find(record => record.cwd === snapshot.cwd && record.state === 'ready');
    if (record) {
      if (preferences.worktreeGitDrafts[record.id] && !Object.hasOwn(preferences.gitDrafts, snapshot.repositoryId)) preferences.gitDrafts[snapshot.repositoryId] = worktreeGitText(preferences.worktreeGitDrafts[record.id]);
      if (preferences.gitDrafts[snapshot.repositoryId]) {rememberWorktreeGit(snapshot, preferences.gitDrafts[snapshot.repositoryId]); save();}
    }
    const state = gitState(id); state.snapshot = snapshot; state.remote = null; state.usable = true; state.selected.clear();
  }
  function invalidateGit(cwd, commonRepositoryId) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) return;
    const path = cwd.replace(/\/+$/, '') || '/'; let changed = false;
    for (const [id, state] of gitResults) {
      const known = state.snapshot?.cwd || threads.get(id)?.cwd; if (typeof known !== 'string' || !known.startsWith('/')) continue;
      const other = known.replace(/\/+$/, '') || '/', wasUsable = state.usable;
      if (!(commonRepositoryId && state.snapshot?.commonRepositoryId === commonRepositoryId) && path !== other && !path.startsWith(other === '/' ? '/' : `${other}/`) && !other.startsWith(path === '/' ? '/' : `${path}/`)) continue;
      state.revision++; state.usable = false; state.remote = null; state.selected.clear();
      if ((!gitOperation || gitOperation.threadId !== id) && (wasUsable || !state.notice)) state.notice = 'Project activity may have changed Git contents. Refresh before another action. Your text is kept.';
      changed ||= id === selectedId;
    }
    if (changed) renderGit();
  }
  async function readGit(id = selectedId) {
    if (!id || threads.get(id)?.historyOnly) return;
    if (checkoutNotice(threads.get(id)?.cwd)) {gitState(id).notice = checkoutNotice(threads.get(id)?.cwd); if (id === selectedId) renderGit(); return false;}
    const epoch = gitEpoch, state = gitState(id), revision = state.revision; state.usable = false;
    try {const result = await gitCall('inspect', {threadId: id}); if (epoch !== gitEpoch || revision !== state.revision) return false; installGit(id, result.snapshot); state.notice = ''; return true;}
    catch (error) {if (epoch === gitEpoch) state.notice = `Git inspection failed: ${message(error)}`; return false;}
    finally {if (id === selectedId) renderGit();}
  }
  function cancelGit() {
    gitEpoch++;
    for (const state of gitResults.values()) {state.revision++; state.usable = false; state.remote = null; state.selected.clear();}
    if (gitOperation) {gitOperation.cancelled = true; gitState(gitOperation.threadId).notice = 'Git action stopped. An action already sent may have happened. Refresh to inspect; no retry was made.';}
    renderGit();
  }
  async function mutateGit(action) {
    const threadId = selectedId, state = gitState(threadId), snapshot = state.snapshot;
    if (acting || gitOperation || !canExecute(current()) || !state.usable || !snapshot) return;
    rememberGitForm(); if(!rememberPublishText())return; const draft = {...preferences.gitDrafts[snapshot.repositoryId]}, prKey = gitPublishKey, prDraft = {...preferences.publishDrafts?.[prKey]}, remote = freshRemote(state), input = {threadId, snapshotId: snapshot.id, requestId: crypto.randomUUID()};
    if (['stage','unstage'].includes(action)) {input.entryIds = snapshot.entries.filter(entry => state.selected.has(entry.id) && entry[action === 'stage' ? 'canStage' : 'canUnstage']).map(entry => entry.id); if (!input.entryIds.length) return; if (input.entryIds.length > 128) {state.notice = 'Select at most 128 paths per action.'; renderGit(); return;}}
    else if (action === 'commit') {if (!snapshot.entries.some(entry => entry.canUnstage) || !draft.message?.trim() || !draft.authorName?.trim() || !draft.authorEmail?.trim()) return; Object.assign(input, {message: draft.message, authorName: draft.authorName, authorEmail: draft.authorEmail});}
    else if (action === 'createBranch') {if (!snapshot.head || !draft.name?.trim()) return; input.name = draft.name;}
    else if (action === 'switchBranch') {const target = snapshot.branches.find(branch => branch.name === draft.switchName); if (!target || target.current || target.checkedOut) return; input.name = target.name;}
    else if (['publishBranch','createPR'].includes(action)) {if(!remote || !remote.repository.canPush)return;input.remoteSnapshotId=remote.id;if(action==='createPR'){if(remote.oldOID!==snapshot.head || !remote.baseOID || remote.base===remote.branch || !prDraft.title?.trim())return;if(new TextEncoder().encode(prDraft.title).length>256 || new TextEncoder().encode(prDraft.body||'').length>65536){state.notice='PR text exceeds the title or description byte limit. Your draft is kept.';renderGit();return;}Object.assign(input,{title:prDraft.title,body:prDraft.body||''});}}
    else return;
    await act(async () => {
      const token = {threadId, requestId: input.requestId, cancelled: false}; gitOperation = token; const epoch = ++gitEpoch; state.notice = 'Reviewing and applying Git changes…'; invalidateGit(snapshot.cwd, snapshot.commonRepositoryId); const revision = state.revision; renderGit();
      try {
        const result = await gitCall(action, input, token);
        if (token.cancelled || epoch !== gitEpoch) return;
        const snapshotCurrent = revision === state.revision; invalidateGit(snapshot.cwd, snapshot.commonRepositoryId);
        if (result.cancelled) {state.notice = 'Git review cancelled. Refresh before another action; your text is kept.'; return;}
        if (!['completed','cancelled','stale','busy','failed','unknown'].includes(result.state) || result.requestId !== input.requestId) throw Error('Git outcome was not identified. Inspect before another action; no retry was made.');
        state.notice = `${result.state === 'completed' ? 'Completed' : result.state}: ${String(result.message || '').slice(0, 2000)}${result.state === 'completed' ? '' : ' Refresh to inspect before another action; your text is kept.'}`;
        if (['publishBranch','createPR'].includes(action)) {
          if(result.state==='completed' && (action==='publishBranch' ? !['published','alreadyPublished'].includes(result.disposition) : !['created','existing'].includes(result.disposition) || !prURL(result.url,result.number,remote.repository.fullName)))throw Error('GitHub completion could not be verified; inspect the saved outcome.');
          if(action==='createPR' && result.state==='completed' && result.disposition==='created'){const saved=preferences.publishDrafts?.[prKey];if(saved?.title===prDraft.title && saved?.body===prDraft.body){preferences.publishDrafts[prKey]={title:'',body:''};save();if(gitFormRepository===snapshot.repositoryId && gitPublishKey===prKey)loadPublishText();}}
          if(result.state!=='completed'){const notice=state.notice;await readGit(threadId);if(epoch===gitEpoch)state.notice=notice;return;}
        }
        if (result.state !== 'completed') return;
        const field = action === 'commit' ? 'message' : action === 'createBranch' ? 'name' : null;
        if (field && preferences.gitDrafts[snapshot.repositoryId]?.[field] === draft[field]) {preferences.gitDrafts[snapshot.repositoryId][field] = ''; if (gitFormRepository === snapshot.repositoryId && $(gitFields[field]).value === draft[field]) $(gitFields[field]).value = ''; rememberWorktreeGit(snapshot, preferences.gitDrafts[snapshot.repositoryId]); save();}
        const completedNotice = state.notice;
        try {if (result.snapshot && snapshotCurrent) installGit(threadId, result.snapshot); else if (!await readGit(threadId)) throw Error(state.notice); if (epoch === gitEpoch) state.notice = completedNotice;}
        catch (error) {if (epoch === gitEpoch) state.notice = `${completedNotice} Current inspection failed: ${message(error)} Refresh to inspect.`;}
      } catch (error) {if (!token.cancelled && epoch === gitEpoch) {invalidateGit(snapshot.cwd, snapshot.commonRepositoryId); state.notice = `Git outcome unconfirmed: ${message(error)} Refresh to inspect; no retry was made.`;}}
      finally {if (gitOperation === token) gitOperation = null; if (threadId === selectedId) renderGit();}
    }, 'git-notice');
  }
  function terminalEvent(method, params) {
    let entry = [...terminals].find(([id, value]) => value.processId === params.processId && (!params.threadId || params.threadId === id));
    if (params.mode === 'pty' && params.threadId && params.processId) {
      const prior = entry?.[1], start = pendingTerminalStarts.get(params.threadId);
      const terminal = {...prior, ...params, output: '', running: ['running','stopping'].includes(params.state)};
      if (prior && (params.revision ?? 0) < (prior.revision ?? 0)) return;
      if (start) start.sessions.set(params.processId, terminal);
      // Explicit starts select their own buffered result; late events cannot replace another session.
      if (entry || !terminals.has(params.threadId)) terminals.set(params.threadId, terminal);
      if (method === 'coding/terminal/completed') markUnread(params.threadId, params.processId, params.error || params.exitCode ? 'failed' : 'completed');
      if (params.threadId === selectedId) renderTerminal(); return;
    }
    if (!entry) {
      const start = pendingTerminalStarts.get(params.threadId); if (!start || !params.processId) return;
      if (!start.sessions.has(params.processId)) {
        if (start.sessions.size >= 4) {start.sessions.delete(start.sessions.keys().next().value); start.truncated = true;}
        start.sessions.set(params.processId, {processId: params.processId, command: start.command, output: `$ ${start.command}\n`, running: true});
      }
      entry = [params.threadId, start.sessions.get(params.processId)];
    }
    const [threadId, terminal] = entry;
    if (method === 'coding/terminal/completed') {terminal.running = false; terminal.stopRequested = false; terminal.exitCode = params.exitCode; terminal.error = params.error ? message(params.error) : ''; markUnread(threadId, params.processId, terminal.error || params.exitCode ? 'failed' : 'completed');}
    else {
      let output = params.output ?? params.delta ?? '';
      if (params.deltaBase64) {terminal.decoders ||= {}; terminal.decoders[params.stream || 'stdout'] ||= new TextDecoder(); try {output = terminal.decoders[params.stream || 'stdout'].decode(Uint8Array.from(atob(params.deltaBase64), c => c.charCodeAt(0)), {stream: true});} catch {output = '\n[Output could not be decoded.]';}}
      const cap = 200000; terminal.output += output;
      if (terminal.output.length > cap) terminal.output = '[Earlier terminal output truncated.]\n' + terminal.output.slice(-cap);
      if (params.capReached || params.truncated) terminal.output += '\n[Terminal output truncated by the engine.]';
    }
    if (terminals.get(selectedId) === terminal) renderTerminal();
  }
  function applyEvent(event, reload, dirty, replay = false) {
    const {method, params: p = {}} = event;
    if (terminalResultEvent(method,p)) return;
    if (method === 'coding/workspaceSync') {if (!replay && event.sequence > workspaceSnapshotCursor) acceptWorkspaceSync(p,event.sequence);return;}
    // Outcome revisions are a separate clock from the paginated thread history.
    if (['coding/mcpOutcomesChanged','coding/mcpSettled'].includes(method)) {if (!replay && p.threadId === selectedId) mcpOutcomes.invalidate();return;}
    const gitActivity = !replay && (['turn/started','turn/completed','item/commandExecution/outputDelta','item/fileChange/outputDelta','command/exec/outputDelta'].includes(method) || method?.startsWith('coding/terminal/') || ['item/started','item/completed'].includes(method) && ['fileChange','commandExecution'].includes(p.item?.type));
    if (gitActivity) {const thread = threads.get(p.threadId || p.thread?.id || [...terminals].find(([, terminal]) => terminal.processId === p.processId)?.[0]); invalidateGit(thread?.cwd || p.thread?.cwd || threads.get(thread?.rootThreadId || p.rootThreadId)?.cwd);}
    if (method === 'coding/family/updated') {if (!replay && (p.rootThreadId || p.threadId)) invalidFamilies.add(p.rootThreadId || p.threadId); return;}
    if(method==='coding/error') {
      for (const thread of threads.values()) {thread.tokenUsageInterrupted = true; dirty.add(thread.id);}
      const error=message(p.message || 'The coding engine stopped.');if(!replay)banner('notice',error);
      for(const affected of p.turns || []) {const thread=threads.get(affected.threadId),turn=thread?.turns?.find(turn=>turn.id===affected.turnId);if(turn?.status==='inProgress'){turn.status='failed';turn.error={message:error};thread.localStopped=false;thread.status={type:activeTurn(thread)?'active':'idle'};observeTurns(thread.id,[turn]);if(!replay)markUnread(thread.id,turn.id,'failed');dirty.add(thread.id);}}

      if(!replay){approvals=[];renderTerminal();}return;
    }
    if (method?.startsWith('coding/terminal/') || method === 'command/exec/outputDelta') {terminalEvent(method, p); return;}
    const id = p.threadId || p.thread?.id; if (!id || event.sequence <= (snapshotCursors.get(id) ?? -1)) return;
    if (method === 'thread/tokenUsage/updated') {
      const thread = threads.get(id);
      if (codingApplyUsageEvent(thread, p, event.sequence)) {if (event.truncated) thread.verificationGap = true; dirty.add(id);}
      return;
    }
    if (method === 'thread/started' && p.thread) {threads.set(id, {...threads.get(id), ...p.thread, metadataPending: false}); if (!childChat(p.thread) && !listed.includes(id) && !archived) listed.unshift(id);}
    let thread = threads.get(id);
    if (!thread) {
      thread = {id, turns: [], metadataPending: true}; threads.set(id, thread);
      readThread(id).then(() => {if (gitActivity) invalidateGit(threads.get(id)?.cwd); return readFamily(id);}).catch(error => {thread.historyWarning = `History refresh failed: ${message(error)}`; if (id === selectedId) renderMessages();});
      // Begin the bounded read buffer before retaining this first unknown-child event.
      retainReadEvent(event);
    }
    if (event.truncated) {thread.verificationGap = true; dirty.add(id);}
    if (method === 'coding/receiptError') {thread.historyWarning = `Command history refresh failed: ${message(p.message).slice(0, 1000)} Live updates continue; the engine will retry.`; dirty.add(id); return;}
    if (method === 'thread/name/updated') thread.name = p.threadName ?? p.name ?? thread.name;
    if (['thread/status/changed', 'turn/started', 'turn/completed', 'error'].includes(method)) thread.activitySequence = event.sequence;
    if (method === 'thread/status/changed') {thread.status = p.status; if (!replay && p.status?.type === 'systemError') {markUnread(id, '', 'failed'); banner('notice', `${title(thread)}: coding engine error. Refresh to check the chat.`);}}
    if (!['thread/name/updated', 'thread/status/changed'].includes(method)) dirty.add(id);
    if (method === 'turn/started') {const known = thread.turns?.find(turn => turn.id === p.turn?.id); if (!known || known.status === 'inProgress') acceptTurn(id, p.turn);}
    if (method === 'turn/completed') {acceptTurn(id, p.turn); if (!replay) markUnread(id, p.turn?.id, p.turn?.status); reload.add(id); approvals = approvals.filter(value => value.params?.turnId !== p.turn?.id);}
    const turn = thread.turns?.find(value => value.id === p.turnId);
    if (!turn || turn.status !== 'inProgress') return;
    if (method === 'error') {turn.error = p.error; if (!p.willRetry) {turn.status = 'failed'; thread.status = {type: activeTurn(thread) ? 'active' : 'idle'}; observeTurns(id, [turn]); if (!replay) markUnread(id, turn.id, 'failed'); reload.add(id);} return;}
    if (method === 'turn/plan/updated') turn.plan = p.plan;
    if (method === 'turn/diff/updated') turn.diff = p.diff;
    if (method === 'item/started' || method === 'item/completed') {const existing = turn.items.find(value => value.id === p.item?.id); if (existing) Object.assign(existing, p.item); else if (p.item) turn.items.push(p.item);turn.items = codingOrderCommandReceipts(turn.items);}
    const deltaTypes = {'item/agentMessage/delta': ['agentMessage', 'text'], 'item/commandExecution/outputDelta': ['commandExecution', 'aggregatedOutput'], 'item/reasoning/textDelta': ['reasoning', 'content'], 'item/reasoning/summaryTextDelta': ['reasoning', 'summary']};
    const delta = deltaTypes[method]; if (!delta || typeof p.delta !== 'string') return;
    let item = turn.items.find(value => value.id === p.itemId); if (!item) {item = {id: p.itemId, type: delta[0]}; turn.items.push(item);}
    const key = delta[1];
    if (item.type === 'reasoning') {item[key] ||= []; const index = Math.max(0, Math.min(100, p.contentIndex ?? p.summaryIndex ?? 0)); const text = (item[key][index] || '') + p.delta; item.truncated ||= text.length > 100000; item[key][index] = text.slice(0, 100000);}
    else {const text = (item[key] || '') + p.delta; item.truncated ||= text.length > 500000; item[key] = text.slice(0, 500000);}
  }
  async function poll() {
    if (disposed || !bridge) return;
    try {
      const questionReadGeneration = questionGeneration;
      const result = await call('events', {after: cursor});
      // A pending owner mutation has no verified snapshot yet. Preserve the
      // cursor and approvals so the next complete snapshot can replay them.
      if (result.deferred === true) {suspendQuestions();return;}
      const reload = new Set(), dirty = new Set(), before = sidebarState();
      installApprovals(result.approvals); if (questionReadGeneration === questionGeneration) installQuestions(result.questions, result.cursor); else suspendQuestions();
      for (const record of questionRecords.values()) if (record.live && !threads.has(record.params.threadId)) reload.add(record.params.threadId);
      for (const event of result.events || []) {if (event.sequence <= cursor) continue; retainReadEvent(event); applyEvent(event, reload, dirty);}
      cursor = Number.isSafeInteger(result.cursor) ? result.cursor : cursor;
      if (pollFailed) {banner('event-notice', ''); pollFailed = false; dirty.add(selectedId);mcpOutcomes.invalidate('Live updates resumed. Checking saved MCP outcomes.');}
      if (result.gap) {for (const thread of threads.values()) thread.verificationGap = true; dirty.add(selectedId); for (const read of threadReads.values()) read.floor = cursor; if (selectedId) reload.add(selectedId); for (const thread of threads.values()) if (working(thread)) reload.add(thread.id); banner('event-notice', 'Some live events were missed. Current chat reloaded from saved history; terminal output may be incomplete.');}
      else if (result.events?.some(event => event.truncated)) banner('event-notice', 'Some live output was truncated. Saved history will refresh when the turn ends.');
      if (result.gap) {mcpOutcomes.invalidate('Some live updates were missed. Checking saved MCP outcomes.');for (const rootId of families.keys()) invalidFamilies.add(rootId);}
      if (invalidFamilies.size || result.gap) {
        const roots = [...invalidFamilies]; invalidFamilies.clear();
        refreshStatus().catch(error => banner('event-notice', message(error)));
        for (const rootId of roots) readFamily(rootId, true).then(() => {if (childChat(current()) && familyFor(selectedId)?.rootThreadId === rootId) return readThread(selectedId);}).catch(error => banner('event-notice', message(error)));
      }
      // Durable reads stay serialized with native review. Event delivery and scoped Stop do not wait for them.
      for (const id of reload) readThread(id).catch(error => {const thread = threads.get(id); if (thread) thread.historyWarning = `History refresh failed: ${message(error)}`; if (id === selectedId) renderMessages();});
      if (dirty.has(selectedId)) renderMessages();
      if (sidebarState() !== before) renderSidebar();
      settleFamilyStops(); renderFamily(); renderApprovals(); controls();
      if(!acting&&followupEnabled()&&(queueHasPending(selectedId)||!followupStates.has(selectedId)||followupStates.get(selectedId)?.error))void refreshFollowups();
      goals?.tick();
      if (panel === 'schedules' && !acting && !scheduleRead && Date.now() - scheduleLastRead > 5000) refreshSchedules().catch(error => banner('schedules-notice', message(error)));
    } catch (error) {suspendQuestions();if (!/busy|approval.*pending/i.test(message(error))) {if (!pollFailed) mcpOutcomes.invalidate('Live updates interrupted. Checking saved MCP outcomes.');pollFailed = true; banner('event-notice', `Live updates interrupted: ${message(error)} ${historyNotice() ? 'Saved history can still be read.' : 'Retrying…'}`); renderMessages(); renderMetrics();}}
    finally {if (!disposed) pollTimer = setTimeout(poll, 1000);}
  }

  window.addEventListener('workspace-preferences-change', renderSidebar);
  $('back-chat').onclick = () => {if (window.salehSaveBeforeLeave()!==true) return; globalThis.SalehCodingTaskSkills.close(); location.href = '/';};
  $('sidebar-toggle').onclick = () => sidebar($('sidebar-toggle').getAttribute('aria-expanded') !== 'true');
  $('session-overview').onclick = () => {sessionView = !sessionView; $('search').value = ''; sidebar(true); renderSidebar();};
  $('close-sidebar').onclick = $('sidebar-shade').onclick = () => sidebar(false);
  window.addEventListener('resize', () => {sidebar();resizePrompt();}); $('search').oninput = renderSidebar;
  $('history-search-open').onclick = () => {cancelHistorySearch();$('history-search-query').value = $('search').value.slice(0,256);$('history-search-results').replaceChildren();$('history-search-status').textContent = 'Search without leaving your current chat.';globalThis.salehWorkspace.openDialog($('history-search-dialog'), $('history-search-open'));$('history-search-query').focus();};
  $('history-search-form').onsubmit = event => {event.preventDefault();void searchHistory();};
  $('history-search-query').oninput = () => {cancelHistorySearch('Query changed. Press Search to find saved matches.');$('history-search-results').replaceChildren();};
  $('history-search-cancel').onclick = () => cancelHistorySearch('Search cancelled. Results shown so far may be incomplete.', false);
  $('history-search-close').onclick = () => globalThis.salehWorkspace.closeDialog($('history-search-dialog'));
  $('history-search-dialog').onclose = () => cancelHistorySearch();
  window.addEventListener('pagehide', () => cancelHistorySearch());
  $('coding-request-stop').onclick = async () => {
    const pending = codingRequest; if (!pending || pending.stopping) return;
    clearStopNotice();pending.stopping = true;goals?.cancelPending(); controls();
    try {await native({op:'cancel'});}
    catch (error) {banner('notice', `Stop could not be confirmed: ${message(error)}`);}
    finally {controls();}
  };
  $('new-project').onclick = () => {const selection = {provider: $('provider').value, model: newModel, executionMode: $('execution-mode').value, origin: selectedId}; return act(async () => {
    if(selection.provider==='local'){await refreshModels();const ready=modelEligibility(localModels,selection.model,'coding');if(!ready.ready)throw Error(ready.reason);}
    const result=await native({op:'codingChooseFolder'});if(result.cwd&&!result.cancelled)await start(result.cwd,selection);
  });};
  $('new-chat').onclick = () => {const thread = current(); if (acting || !thread?.cwd || !canStartWork(thread)) return; const selection = {provider: $('provider').value, model: newModel, executionMode: $('execution-mode').value, origin: selectedId}; return act(() => start(thread.cwd, selection));};
  $('new-tools-task').onclick = openMCPSetup;
  $('mcp-setup-close').onclick = () => {void closeMCPSetup();};
  $('mcp-setup-inventory').onclick = () => {void refreshSetupInventory();};
  $('mcp-setup-current').onclick = () => {if (!setupBlocking() && current()?.cwd) {setupProject = current().cwd;renderMCPSetup();}};
  $('mcp-setup-folder').onclick = () => {if (setupBlocking()) return;const epoch = setupPanelEpoch;return act(async () => {const result = await native({op:'codingChooseFolder'});if (epoch === setupPanelEpoch && !result.cancelled && result.cwd) {setupProject = result.cwd;renderMCPSetup();}});};
  $('mcp-setup-prepare').onclick = async () => {
    if (!mcpSetup || acting || setupBlocking() || !setupInventoryReady || !setupChoice) return;
    clearStopNotice();try {
      if (checkoutNotice(setupProject)) throw Error(checkoutNotice(setupProject));
      if (setupChoice.provider === 'local') {const ready = modelEligibility(localModels, setupChoice.model, 'coding');if (!ready.ready) throw Error(ready.reason);}
      await mcpSetup.prepare({cwd:setupProject,...setupChoice,serverIds:[...$('mcp-setup-servers').querySelectorAll('input:checked')].map(input => input.value)});
    } catch (error) {$('mcp-setup-inventory-notice').textContent = message(error);}
  };
  $('mcp-setup-review').onclick = () => {void mcpSetup?.review();};
  $('mcp-setup-inspect').onclick = () => {void mcpSetup?.inspect();};
  $('mcp-setup-cancel').onclick = () => {void mcpSetup?.cancel();};
  $('mcp-setup-open-root').onclick = () => {const id = mcpSetup?.view().status?.root?.thread.id;if (id) return act(() => select(id));};
  $('mcp-setup').addEventListener('keydown', event => {if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();void closeMCPSetup();}});
  $('refresh').onclick = () => {void refreshModels();void mcpOutcomes.refresh();return act(async () => {
    await refreshStatus(); await loadList();
    if (selectedId) {await readThread(selectedId); await readFamily(selectedId, true);}
    for (const id of new Set(watchedTurns.map(watch => watch.threadId))) if (id !== selectedId) {
      try {await readThread(id);} catch (error) {banner('event-notice', `${title(threads.get(id))}: history could not be loaded. ${message(error)}`);}
    }
  });};
  $('configure-provider').onclick = () => act(async () => {const result = await native({op: 'codingConfigureProvider'}); if (result.message) banner('notice', result.message); await refreshStatus();});
  $('provider').onchange = controls;
  $('execution-mode').onchange = controls;
  $('models-refresh').onclick = refreshModels;
  $('new-chat-model').onchange = () => {if (acting || activeTurn(current()) || childChat(current())) return; newModel = $('new-chat-model').value; newModelSelected=true; controls();};
  $('default-model').onchange = () => {
    if (acting || activeTurn(current()) || childChat(current())) return;
    const previous = modelDefault(localModels,'coding'), next = $('default-model').value;
    try {localStorage.setItem(LOCAL_MODEL_DEFAULT_KEY, next); if (newModel === previous) newModel = next;}
    catch {banner('notice', 'The default could not be saved. Existing chats are unchanged.');}
    controls();
  };
  window.addEventListener('storage', event => {if (event.key === LOCAL_MODEL_DEFAULT_KEY) {if (newModel === (event.oldValue === null ? catalogDefault(localModels,'coding') : event.oldValue)) newModel = modelDefault(localModels,'coding'); controls();}});
  $('show-archived').onclick = () => act(async () => {sessionView = false; archived = !archived; await loadList(); if (listed.length) await select(listed[0]); else {selectionEpoch++;selectedId = ''; save(); renderSelection();}});
  $('prompt').oninput = () => {if (directInput(current())) {preferences.drafts[selectedId] = $('prompt').value; save();} resizePrompt();controls();};
  $('effort').onchange = () => {if (directInput(current())) {preferences.efforts[selectedId] = $('effort').value; save(); controls();}};
  $('task-mode').onchange=()=>changeTaskMode($('task-mode').value);
  $('composer-attach').onclick=()=>$('message-files').click();
  $('message-files').onchange=async()=>{
    const files=[...$('message-files').files],id=selectedId,scope=selectionEpoch; $('message-files').value='';if(!files.length||disposed||storageBlocked||!directInput(current())||setupBlocking())return;
    const read={};attachmentReads.set(id,read);renderDraftAttachments();controls();
    try{
      const before=draftFiles(id);if(before.length+files.length>4)throw Error('Attach up to 4 files per message.');
      const imported=[];for(const file of files)imported.push(await attachments.readFile(file));
      const batch=attachments.normalize([...before,...imported]);await attachmentStorage.prepare(batch);
      if(disposed||attachmentReads.get(id)!==read||!threads.has(id))return;
      setDraftFiles(id,batch);if(selectedId===id&&selectionEpoch===scope)banner('notice','');
    }catch(error){if(!disposed&&selectedId===id&&selectionEpoch===scope&&attachmentReads.get(id)===read)banner('notice','Attachments not added. '+message(error));}
    finally{if(attachmentReads.get(id)===read)attachmentReads.delete(id);if(!disposed&&selectedId===id){renderDraftAttachments();controls();}}
  };
  window.addEventListener('storage',event=>{if((event.key===storageKey||event.key===null)&&localStorage.getItem(storageKey)!==lastSavedSnapshot){storageBlocked=true;attachmentReads.clear();banner('storage-notice','Another page changed saved Coding drafts. Saving is paused to preserve them. Copy any unsaved text here, then reload.');renderDraftAttachments();controls();}});
  $('composer').onsubmit = send;
  $('submission-check').onclick = checkSubmission;
  $('submission-ack').onclick = () => {
    const token = submissionStore.current(selectedId)?.record;
    if (!acting && token && submissionStore.acknowledge(token)) {clearStopNotice();banner('notice', 'Submission notice acknowledged. Your draft is kept; sending is a new explicit action.');}
    controls();
  };
  window.addEventListener('storage', event => {if (event.key === SalehSubmission.storageKey || event.key === null) {submissionStore.refresh(); controls();}});
  $('prompt').onkeydown = event => {if (event.key === 'Enter' && !event.shiftKey) {if(event.isComposing || event.keyCode === 229)return;event.preventDefault();if(!event.repeat && !$('send').disabled)$('composer').requestSubmit($('send'));}};
  $('followup-mode').onchange=controls;
  $('followup-refresh').onclick=()=>void refreshFollowups();
  $('followup-pause').onclick=async()=>{try{await changeFollowup('pause',{threadId:selectedId});}catch(error){banner('notice',message(error));}};
  $('followup-resume').onclick=()=>{const id=selectedId,group=followupStates.get(id)?.group;if(group)return act(()=>changeFollowup('resume',{threadId:id,revision:group.revision}));};
  const saveFollowupEdit=()=>{const edit=preferences.followupEdits?.[selectedId];if(!edit)return;edit.text=$('followup-edit-text').value;edit.effort=$('followup-edit-effort').value;edit.mode=$('followup-edit-mode').value;save();};
  $('followup-edit-text').oninput=saveFollowupEdit;$('followup-edit-effort').onchange=saveFollowupEdit;$('followup-edit-mode').onchange=saveFollowupEdit;
  $('followup-editor').onsubmit=event=>{event.preventDefault();const id=selectedId,edit=preferences.followupEdits?.[id];if(!edit)return;const snapshot={...edit};return act(async()=>{
    if(!save())throw Error('The edit could not be saved locally. No queue change was sent.');
    await changeFollowup('edit',{threadId:id,...snapshot});
    if(JSON.stringify(preferences.followupEdits?.[id])===JSON.stringify(snapshot)){const next={...preferences,followupEdits:{...preferences.followupEdits}};delete next.followupEdits[id];if(!persistPreferences(next))throw Error('Queue changed, but its local edit draft is retained. Refresh before editing again.');preferences=next;}
    controls();
  });};
  $('followup-edit-cancel').onclick=()=>{const id=selectedId,next={...preferences,followupEdits:{...preferences.followupEdits}};delete next.followupEdits[id];if(persistPreferences(next)){preferences=next;controls();}};
  $('stop').onclick = async () => {
    const threadId = workspaceStopTarget(selectedId);
    if (!threadId || !familyBusy(threadId) && !subtreeIds(threadId).some(pendingQuestion) && !workspaceBlocked(threadId) && !queueHasPending(threadId) && !submissionDispatches.get(threadId)?.queue || familyStopping(threadId)) return;
    clearStopNotice();banner('notice', `Stop requested for ${title(threads.get(threadId))} and its agents. Waiting for the engine to confirm.`);
    closeSavedHistory();invalidateCodingSkills('stop'); clearCodingFilePreview();clearImagePreviews();attachmentReads.clear();renderDraftAttachments();
    mcpOutcomes.invalidate('Stop requested. Any action already sent may have happened; checking saved outcomes.');
    cancelQuestions(subtreeIds(threadId)); cancelSubmissions(subtreeIds(threadId));
    revokeTerminalInput(subtreeIds(threadId)); const stop = {requestPending: true, afterRead: familyReadSequence}; pendingFamilyStops.set(threadId, stop); $('notice').dataset.stopFamily = threadId; controls(); renderFamily();
    try {await call('interruptFamily', {threadId}); stop.requestPending = false; await refreshStatus(); await readFamily(threadId, true); settleFamilyStops(); renderFamily();}
    catch (error) {pendingFamilyStops.delete(threadId); banner('notice', `${title(threads.get(threadId))}: ${message(error)}`);}
    finally {mcpOutcomes.invalidate('Checking saved MCP outcomes after Stop.');void refreshTerminalResults();controls();}
  };
  $('rename-chat').onclick = () => {if (!ownedChat(current())) return; renamingId = selectedId; $('rename-title').value = title(current()); globalThis.salehWorkspace.openDialog($('rename-dialog'), $('rename-chat')); $('rename-title').select();};
  $('rename-cancel').onclick = () => globalThis.salehWorkspace.closeDialog($('rename-dialog'));
  $('rename-form').onsubmit = event => {event.preventDefault(); const id = renamingId, name = $('rename-title').value.trim(); if (!name || !ownedChat(threads.get(id))) return; act(async () => {await call('rename', {threadId: id, name}); const thread = threads.get(id); if (thread) thread.name = name; if (preferences.pendingThreads[id]) {preferences.pendingThreads[id].name = name; save();} globalThis.salehWorkspace.closeDialog($('rename-dialog')); renderSidebar(); if (selectedId === id) $('thread-title').textContent = name;});};
  $('archive-chat').onclick = () => {const id = selectedId, restore = current()?.archived; if (!ownedChat(current())) return; act(async () => {await call(restore ? 'unarchive' : 'archive', {threadId: id}); if (threads.has(id)) threads.get(id).archived = !restore; closeChatMenu(); archived = false; await loadList(); if (restore) await select(id); else if (listed.length) await select(listed[0]); else {selectionEpoch++;selectedId = ''; save(); renderSelection();}});};
  $('reclaim-guest-disk').onclick = () => {const id=selectedId;if(!ownedChat(current()))return;act(async()=>{const result=await native({op:'codingStorage',input:{threadId:id}});closeChatMenu();banner('notice',result.message || 'Guest disk review finished.');});};
  $('cloud-connection').onclick = () => {
    const id=selectedId,scope=selectionEpoch;if(!managedCloudChat(current()))return;
    act(async()=>{try{const result=await native({op:'codingBindProvider',input:{threadId:id}});await readThread(id);if(!disposed&&selectedId===id&&selectionEpoch===scope){closeChatMenu();banner('notice',result.message||'Cloud connection review finished.');}}
      catch(error){if(!disposed&&selectedId===id&&selectionEpoch===scope)banner('notice',message(error));}});
  };
  $('failed-guest-storage').onclick = () => {act(async()=>{const result=await native({op:'codingStorage',input:{failed:true}});banner('notice',result.message || 'Failed guest disk review finished.');});};
  $('review-startup-recovery').onclick = () => {
    if (!$('review-startup-recovery').disabled && !$('failed-startups').disabled) $('failed-startups').click();
  };
  $('failed-startups').onclick = () => {
    if(setupBlocking()||!window.salehSaveBeforeLeave())return;const origin=selectedId,scope=selectionEpoch,model=newModel;
    return act(async()=>{
      banner('notice','Reviewing failed task startups…');
      // Listing and reviewing retained startups never needs a ready model.
      // Only a new continuation receives the model after its actual Coding check.
      const result=await native({op:'codingRecovery',input:modelEligibility(localModels,model,'coding').ready?{model}:{}});
      if(disposed)return;
      if(!window.salehSaveBeforeLeave()){banner('notice',result.thread?'A continuation chat was created, but your current draft could not be saved. This view is kept; inspect saved Tasks history when ready.':'Recovery review finished. This view is kept because the current draft could not be saved.');return;}
      if(result.thread){
        if(result.executionMode!=='native'||result.thread.model!==model||result.thread.modelProvider!=='saleh_local'||typeof result.thread.cwd!=='string'||typeof result.copyId!=='string')throw Error('Continuation chat could not be verified. Inspect saved Tasks history before retrying.');
        await adoptStartedThread(result.thread,'local',selectedId===origin&&selectionEpoch===scope?origin:null);
        if(selectedId===result.thread.id&&$('notice').textContent==='Reviewing failed task startups…')banner('notice',result.message||'Continuation chat opened in the verified project copy.');
        return;
      }else if(result.existingThreadId&&selectedId===origin&&selectionEpoch===scope){await select(result.existingThreadId);if(selectedId===result.existingThreadId&&$('notice').textContent==='Reviewing failed task startups…')banner('notice',result.message||'Saved continuation opened.');}
      if(selectedId===origin&&selectionEpoch===scope)banner('notice',result.message || 'Recovery review finished. Existing chats and drafts are kept.');
    });
  };
  $('fork-chat').onclick = () => {const id = selectedId; if (setupBlocking() || !ownedChat(current()) || checkoutNotice(current().cwd) || workspaceBlocked(id)) return; act(async () => {const result = await call('fork', {threadId: id}); if (!result.thread?.id) throw new Error('The engine returned no forked chat.'); threads.set(result.thread.id, {...result.thread, archived: false}); closeChatMenu(); archived = false; await loadList(); await select(result.thread.id);});};
  $('changes-toggle').onclick = () => {if (current()?.historyOnly) return; panel = panel === 'changes' ? '' : 'changes'; renderPanel(); if (panel) act(readGit, 'git-notice');};
  $('terminal-toggle').onclick = () => {if (!current() || current().metadataPending) return; panel = panel === 'terminal' ? '' : 'terminal'; renderPanel();if (panel === 'terminal') void refreshTerminalResults();};
  $('terminal-results').onchange = () => {if (!terminals.get(selectedId)?.running) void refreshTerminalResults($('terminal-results').value);};
  $('terminal-results-refresh').onclick = () => {void refreshTerminalResults();};
  $('worktrees-toggle').onclick = () => {panel = panel === 'worktrees' ? '' : 'worktrees'; if (panel && matchMedia('(max-width:850px)').matches) sidebar(false); renderPanel(); if (panel) act(refreshWorktrees, 'worktrees-notice');};
  $('worktrees-refresh').onclick = () => act(refreshWorktrees, 'worktrees-notice');
  $('worktrees-reconnect').onclick = reconnectWorktrees;
  $('worktrees-view').onchange = renderWorktrees;
  $('schedules-toggle').onclick = () => {panel = panel === 'schedules' ? '' : 'schedules'; if (panel && matchMedia('(max-width:850px)').matches) sidebar(false); renderPanel(); if (panel) act(async () => {await refreshSchedules(); if (!scheduleFormReady) editSchedule(scheduleEditor);}, 'schedules-notice');};
  $('schedules-refresh').onclick = () => act(refreshSchedules, 'schedules-notice');
  $('schedules-stop').onclick = () => controlSchedules();
  $('schedules-recover').onclick = () => mutateSchedule('recover', {});
  $('schedule-new').onclick = () => editSchedule('');
  $('schedule-form').oninput = $('schedule-form').onchange = rememberScheduleForm;
  $('schedule-form').onsubmit = submitSchedule;
  $('schedule-use-project').onclick = () => {if (!current()?.cwd) return; $('schedule-project').dataset.cwd = current().cwd; $('schedule-project').textContent = current().cwd; rememberScheduleForm();};
  $('schedule-choose-project').onclick = () => act(async () => {const result = await native({op: 'codingChooseFolder'}); if (result.cancelled || !result.cwd) return; $('schedule-project').dataset.cwd = result.cwd; $('schedule-project').textContent = result.cwd; rememberScheduleForm();}, 'schedules-notice');
  $('worktree-choose-source').onclick = () => act(async () => {const result = await native({op: 'codingChooseFolder'}); if (result.cancelled || !result.cwd) return; worktreeSource = result.cwd; $('worktree-source').textContent = worktreeSource;}, 'worktrees-notice');
  $('worktree-ref').oninput = controls;
  $('worktree-create-form').onsubmit = createWorktree;
  $('worktree-stop').onclick = async () => {
    if ((!worktreeMutating && !worktreesBusy) || worktreeStopRequested) return;
    clearStopNotice();const verifyHandoffs = worktreeMutation?.action !== 'recoverHandoff';
    cancelWorktreeMutation(); const epoch = worktreeEpoch; worktreeStopRequested = true; controls();
    try {const result = await worktreeCall('stop'); if (epoch !== worktreeEpoch) return; banner('worktrees-notice', (result.stopped === true ? 'Stop confirmed. ' : 'Stop could not be confirmed. ') + (typeof result.message === 'string' ? result.message.slice(0, 1600) : 'Refresh to inspect retained work.')); await refreshWorktrees(verifyHandoffs);}
    catch (error) {banner('worktrees-notice', message(error));}
    finally {worktreeStopRequested = false; controls();}
  };
  function closeChatMenu() {
    const menu=$('chat-menu'),restore=menu.open&&menu.contains(document.activeElement);
    menu.open=false;if(restore)menu.querySelector('summary')?.focus();
  }
  function closeProjectPanel() {
    const trigger=$({changes:'changes-toggle',terminal:'terminal-toggle',worktrees:'worktrees-toggle',schedules:'schedules-toggle'}[panel]);
    const restore=$('workspace-panel').contains(document.activeElement);
    panel='';renderPanel();
    if(restore)[trigger,$('workspace-quick-open'),$('prompt')].find(node=>node&&!node.disabled&&!node.closest('[hidden],[inert]')&&node.getClientRects().length)?.focus();
  }
  $('close-panel').onclick = closeProjectPanel;
  $('refresh-changes').onclick = () => act(readGit, 'git-notice');
  for (const id of Object.values(gitFields)) $(id).oninput = rememberGitForm;
  for(const id of Object.values(publishFields))$(id).oninput=changePublishTarget;
  $('git-pr-title').oninput=$('git-pr-body').oninput=rememberPublishText;
  $('git-remote-check').onclick=()=>inspectRemote();$('git-publish').onclick=()=>mutateGit('publishBranch');
  $('git-pr-form').onsubmit=event=>{event.preventDefault();mutateGit('createPR');};
  $('git-stage').onclick = () => mutateGit('stage'); $('git-unstage').onclick = () => mutateGit('unstage');
  $('git-diff-all').onclick = () => {gitState().diffPath = null; renderGit();};
  $('git-commit-form').onsubmit = event => {event.preventDefault(); mutateGit('commit');};
  $('git-branch-form').onsubmit = event => {event.preventDefault(); mutateGit('createBranch');};
  $('git-switch-form').onsubmit = event => {event.preventDefault(); mutateGit('switchBranch');};
  $('git-stop').onclick = async () => {
    const token = gitOperation; if (!token || token.cancelled) return; clearStopNotice();cancelGit(); const epoch = gitEpoch;
    try {
      const result = await gitCall('stop', {requestId: token.requestId});
      if (epoch !== gitEpoch || gitState(token.threadId).usable) return;
      if (result.cancelled === true && result.state === undefined) return;
      if (!['cancelled','unknown','failed'].includes(result.state) || result.requestId !== token.requestId || typeof result.message !== 'string' || !result.message.trim() || result.message.length > 6400) throw Error('Git Stop outcome could not be identified for this request.');
      if (result.state !== 'cancelled') {
        gitState(token.threadId).notice = `Git Stop ${result.state === 'unknown' ? 'unconfirmed' : 'failed'}: ${result.message.slice(0, 2000)} Refresh to inspect; no retry was made.`;
        if (selectedId === token.threadId) renderGit();
      }
    }
    catch (error) {if (epoch === gitEpoch && !gitState(token.threadId).usable) {gitState(token.threadId).notice = `Git Stop could not be confirmed: ${message(error)} Refresh to inspect; no retry was made.`; if (selectedId === token.threadId) renderGit();}}
    finally {controls();}
  };
  $('review-changes').onclick = () => {const id = selectedId; if (!canStartWork(current())) return; const choice = codingModelState(current(), 'none'); if (!choice.ready) {banner('notice', choice.reason); return;} act(async () => {const result = await call('review', {threadId: id}); const reviewId = result.reviewThreadId || id; if (reviewId !== id) {await loadList(); await select(reviewId);} acceptTurn(reviewId, result.turn, true); if (selectedId === reviewId) renderMessages(); renderSidebar();});};
  $('terminal-command').oninput = $('terminal-input').oninput = () => {if (directInput(current())) {preferences.terminalDrafts[selectedId] = {command: $('terminal-command').value, input: $('terminal-input').value}; save();} controls();};
  $('terminal-shell').onclick = () => {
    const threadId = selectedId; if (!canStartWork(current()) || terminals.get(threadId)?.running) return;
    act(async () => {
      const start = {mode: 'pty', command: '', sessions: new Map(), cancelled: false}; pendingTerminalStarts.set(threadId, start);
      try {
        const result = await call('terminalStart', {threadId, command: '', mode: 'pty', cols: 100, rows: 30}, start); if (result.cancelled || start.cancelled) return;
        if (!result.processId || result.mode !== 'pty') throw new Error('No interactive terminal was confirmed.');
        const early = start.sessions.get(result.processId), metadata = early && early.revision > result.revision ? early : result;
        terminals.set(threadId, {...metadata, output: '', running: ['running','stopping'].includes(metadata.state)}); invalidateGit(threads.get(threadId)?.cwd);
        if (threadId === selectedId) {renderTerminal(); $('terminal-command-panel').open = false;} renderSidebar();
      } finally {pendingTerminalStarts.delete(threadId);}
    });
  };
  $('terminal-form').onsubmit = event => {
    event.preventDefault(); const threadId = selectedId, command = $('terminal-command').value; if (!command.trim() || !canStartWork(current())) return;
    act(async () => {
      const start = {command, sessions: new Map(), truncated: false, cancelled: false}; pendingTerminalStarts.set(threadId, start);
      try {
        const result = await call('terminalStart', {threadId, command}, start); if (result.cancelled || start.cancelled) return;
        if (!result.processId) throw new Error('No terminal process was started.');
        invalidateGit(threads.get(threadId)?.cwd);
        const early = start.sessions.get(result.processId);
        terminals.set(threadId, early || {processId: result.processId, command, output: `$ ${command}\n`, running: true});
        if (!early && start.truncated) {terminals.get(threadId).output += '[Early command output was omitted. Checking command status.]\n'; await refreshStatus();}
        if (threadId === selectedId) renderTerminal(); renderSidebar();
      } finally {pendingTerminalStarts.delete(threadId);}
    });
  };
  $('terminal-input-form').onsubmit = event => {event.preventDefault(); const threadId = selectedId, terminal = terminals.get(threadId), text = $('terminal-input').value; if (!terminal?.running || terminal.stopRequested || terminal.mode === 'pty' || !text || !canExecute(current())) return; act(async () => {const result = await call('terminalWrite', {processId: terminal.processId, text}); if (!result.cancelled) invalidateGit(threads.get(threadId)?.cwd); if (!result.cancelled && preferences.terminalDrafts[threadId]?.input === text) {preferences.terminalDrafts[threadId].input = ''; if (selectedId === threadId && $('terminal-input').value === text) $('terminal-input').value = ''; save();}});};
  $('terminal-stop').onclick = async () => {const threadId = selectedId, terminal = terminals.get(threadId); if (!terminal?.running || terminal.stopRequested) return; clearStopNotice();terminal.stopRequested = true; if (terminal.mode === 'pty') terminal.state = 'stopping'; revokeTerminalInput([threadId]); renderTerminal(); try {await call('terminalStop', {processId: terminal.processId});} catch (error) {terminal.stopRequested = false; banner('notice', `${title(threads.get(threadId))}: ${message(error)}`);} finally {renderTerminal();void refreshTerminalResults();}};
  window.addEventListener('tools-stop-result', event => {
    mcpOutcomes.invalidate('Checking saved MCP outcomes after the Stop response.');void refreshTerminalResults();
    if (stopResultEligible) {
      stopResultEligible = false;
      const detail = event.detail, confirmed = detail?.stopped === true;
      const notice = (confirmed ? 'Stop confirmed. ' : 'Stop could not be confirmed. ') + (typeof detail?.message === 'string' ? detail.message.slice(0, 1600) : 'Refresh Worktrees to inspect retained work.');
      stopNotice = notice;banner('notice', ''); banner('worktrees-notice', notice);
    }
    controls();
  });
  window.addEventListener('tools-stopped', () => {closeSavedHistory();clearImagePreviews();attachmentReads.clear();renderDraftAttachments();cancelQuestions();clearStopNotice();stopResultEligible = true;if (codingRequest) codingRequest.stopping = true;controls();mcpSetup?.invalidate();mcpOutcomes.invalidate('Stop requested. Any action already sent may have happened; checking saved outcomes.');invalidateCodingSkills('stop'); clearCodingFilePreview(); revokeTerminalInput(); cancelWorktreeMutation(); cancelScheduleMutations(); cancelGit();});
  window.addEventListener('agent-stopped', () => {closeSavedHistory();clearImagePreviews();attachmentReads.clear();renderDraftAttachments();cancelQuestions();clearStopNotice();stopResultEligible = true;if (codingRequest) codingRequest.stopping = true;mcpSetup?.invalidate();mcpOutcomes.invalidate('Stop requested. Any action already sent may have happened; checking saved outcomes.');invalidateCodingSkills('stop'); clearCodingFilePreview(); cancelSubmissions(); revokeTerminalInput(); cancelWorktreeMutation(); cancelScheduleMutations(); cancelGit(); for (const thread of threads.values()) {const turn = activeTurn(thread); if (turn) {turn.status = 'interrupted'; thread.localStopped = true;}} for (const terminal of terminals.values()) if (terminal.running) {terminal.state = 'stopping'; terminal.stopRequested = true;} approvals = []; renderMessages(); renderSidebar(); renderApprovals(); renderTerminal(); controls();});
  window.addEventListener('pagehide', () => {save();closeSavedHistory();clearImagePreviews();attachmentReads.clear();clearCodingFilePreview();cancelQuestions();for(const record of questionRecords.values())record.node?.reset();questionRecords.clear();$('question-cards').replaceChildren();selectionEpoch++;setupPanelEpoch++;void mcpSetup?.dispose();mcpOutcomes.dispose();globalThis.SalehCodingTaskSkills.close(); cancelSubmissions(); revokeTerminalInput(); pty.dispose(); cancelWorktreeMutation(); cancelScheduleMutations(); cancelGit(); disposed = true; clearTimeout(pollTimer); clearTimeout(requestFeedbackTimer); save();});
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || pty.ownsFocus() || document.querySelector('dialog[open]')) return;
    const side = $('sidebar');
    if (event.key === 'Tab' && side.getAttribute('aria-modal') === 'true') {
      const items = [...side.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(node => node.getClientRects().length && !node.closest('[inert],[hidden]'));
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !side.contains(document.activeElement))) {event.preventDefault(); last?.focus();}
      else if (!event.shiftKey && (document.activeElement === last || !side.contains(document.activeElement))) {event.preventDefault(); first?.focus();}
    }
    if (event.key === 'Escape') {if(side.getAttribute('aria-modal')==='true')sidebar(false);closeProjectPanel();closeChatMenu();}
  });
  sidebar(); renderSelection();
  if (!bridge) {banner('notice', 'Open Noiee.app to use the coding workspace.'); $('provider-status').textContent = 'Native app required'; return;}
  // Bootstrap is the only background act; it must not dismiss a later Stop result.
  // Inventory controls admission to new chats/inference; saved reads and native Stop have independent lanes.
  void refreshModels();
  act(async () => {
    try {await refreshStatus();} catch (error) {listState = 'failed'; renderSidebar(); throw error;}
    await loadList(); await refreshStatus();
    try {await refreshWorktrees();} catch (error) {banner('worktrees-notice', message(error));}
    try {
      const questionReadGeneration = questionGeneration;
      const baseline = await call('events', {after: 0});
      if (baseline.deferred !== true) {
        cursor = baseline.cursor || 0; installApprovals(baseline.approvals); if (questionReadGeneration === questionGeneration) installQuestions(baseline.questions, baseline.cursor); else suspendQuestions();
        for(const event of baseline.events || []) if(event.method?.startsWith('coding/terminal/'))terminalEvent(event.method,event.params || {});
      }
    } catch (error) {
      if (!historyNotice()) throw error;
      pollFailed = true; mcpOutcomes.invalidate('Live updates unavailable. Checking saved MCP outcomes.');
      banner('event-notice', `Live updates unavailable: ${message(error)} Saved history can still be read.`);
    }
    // Establish current workspace state after skipping historical startup events.
    await refreshStatus();
    renderApprovals();
    if (selectedId && !listed.includes(selectedId) && !preferences.pendingThreads[selectedId]) {
      try {await readThread(selectedId); await readFamily(selectedId);} catch (error) {if (preferences.handoffChats[selectedId] || [...handoffs.values()].some(h => h.rootThreadId === selectedId)) banner('notice', message(error)); else selectedId = '';}
    }
    if (!threads.has(selectedId)) selectedId = listed[0] || '';
    if (selectedId) {try {await select(selectedId);} catch (error) {banner('notice', message(error));}} else renderSelection();
    const activeIds = new Set([...(engine.activeTurns || []).map(turn => turn.threadId), ...[...threads.values()].filter(working).map(thread => thread.id), ...approvals.map(approval => approval.params?.threadId), ...[...questionRecords.values()].filter(r => r.live).map(r => r.params.threadId)]);
    // ponytail: reconcile known active turns from saved history; no replay of old journal cursors.
    const historyIds = new Set([...activeIds, ...watchedTurns.map(watch => watch.threadId)]);
    for (const id of historyIds) if (id && id !== selectedId) {try {await readThread(id);} catch (error) {banner('event-notice', `${title(threads.get(id))}: history could not be loaded. ${message(error)}`);}}
    const roots = new Set([...activeIds].map(id => threads.get(id)?.rootThreadId || id));
    for (const rootId of roots) if (rootId && rootId !== familyFor(selectedId)?.rootThreadId) await readFamily(rootId);
    renderFamily(); renderSidebar(); renderApprovals();
  }, 'notice', {userAction:false}).finally(() => {pollTimer = setTimeout(poll, 1000);});
})();
