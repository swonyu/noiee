// Ordinary submission markers are observations, never replay authority. Queue
// markers also carry a persistent acceptance ID; only backend lookup confirms it.
(() => {
  'use strict';
  const KEY = 'saleh-coding-submissions-v1', LIMIT = 64;
  const identity = value => typeof value === 'string' && /^[\w.-]{1,160}$/.test(value);
  const valid = record => record && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).sort().join(',') === (record.operation === 'queue' ? 'draftHash,localId,operation,startedAt,threadId' : 'localId,operation,startedAt,threadId')
    && identity(record.threadId) && identity(record.localId) && ['send', 'steer', 'queue'].includes(record.operation)
    && (record.operation !== 'queue' || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.localId) && /^[a-f0-9]{64}$/.test(record.draftHash))
    && Number.isSafeInteger(record.startedAt) && record.startedAt >= 0;
  function createStore(storage, {now = Date.now, uuid = () => globalThis.crypto.randomUUID()} = {}) {
    const states = new Map(), ignored = new Map(), reviewedWithoutStorage = new Set();
    let disk = new Map(), readIssue = '', writeIssue = '';
    const copy = state => state ? {...state, record: {...state.record}} : null;
    const same = (state, token) => !!state && state.record.localId === token?.localId && state.record.threadId === token?.threadId;
    function refresh() {
      try {
        const raw = storage.getItem(KEY);
        let records = [];
        if (raw !== null) {
          if (typeof raw !== 'string' || raw.length > 32768) throw Error('Invalid submission metadata');
          const value = JSON.parse(raw);
          if (!value || value.version !== 1 || Object.keys(value).sort().join(',') !== 'entries,version' || !Array.isArray(value.entries) || value.entries.length > LIMIT || value.entries.some(record => !valid(record)) || new Set(value.entries.map(record => record.threadId)).size !== value.entries.length || new Set(value.entries.map(record => record.localId)).size !== value.entries.length) throw Error('Invalid submission metadata');
          records = value.entries;
        }
        disk = new Map(records.map(record => [record.threadId, {...record}])); readIssue = '';
        for (const [id, record] of disk) {
          if (ignored.get(id) === record.localId) continue;
          ignored.delete(id);
          if (!same(states.get(id), record)) states.set(id, {record: {...record}, phase: 'unknown', inFlight: false, checked: false, checking: false, reason: 'A saved submission has no confirmed reply in this page. Review history and task state before sending again.'});
        }
        for (const [id, state] of states) if (!disk.has(id) && !state.volatile && !state.inFlight) states.delete(id);
      } catch {
        readIssue = 'Saved submission notices could not be read. Their contents were preserved. After reviewing task state, you can allow a new message with tracking for this page only; it cannot protect you after reload.';
      }
      return warning();
    }
    function warning() {return readIssue || writeIssue;}
    function current(threadId) {
      if (!identity(threadId)) return null;
      if (readIssue && !states.has(threadId) && !reviewedWithoutStorage.has(threadId)) {
        if (states.size >= LIMIT) return {record: {threadId, localId: 'capacity', operation: 'unknown', startedAt: now()}, phase: 'unknown', inFlight: false, checked: false, checking: false, capacity: true, reason: 'This page already tracks 64 unresolved submission notices. Review a previously opened chat before tracking another.'};
        states.set(threadId, {record: {threadId, localId: uuid(), operation: 'unknown', startedAt: now()}, phase: 'unknown', inFlight: false, checked: false, checking: false, volatile: true, storageOnly: true, reason: 'Saved submission state is unavailable. Review this chat before allowing another message.'});
      }
      return copy(states.get(threadId));
    }
    function write(next) {
      if (readIssue) return false;
      try {storage.setItem(KEY, JSON.stringify({version: 1, entries: [...next.values()]})); disk = next; writeIssue = ''; return true;}
      catch {writeIssue = 'Submission notices could not be saved. Tracking is available for this page only and cannot protect you after reload. Keep this page open and review history before sending again.'; return false;}
    }
    function begin(threadId, operation, requirePersistent = false, draftHash) {
      refresh();
      if (!identity(threadId) || !['send', 'steer', 'queue'].includes(operation)) throw Error('Invalid submission identity.');
      if (current(threadId)) throw Error('Review the earlier submission before sending another message.');
      const known = new Set([...disk.keys(), ...states.keys()]);
      if (known.size >= LIMIT && !known.has(threadId)) throw Error('There are 64 unresolved submission notices. Review an earlier chat before sending another message.');
      const record = {threadId, localId: uuid(), operation, startedAt: now(), ...(operation === 'queue' ? {draftHash} : {})};
      if (!valid(record)) throw Error('A local submission marker could not be created. No message was sent.');
      const next = new Map(disk); next.set(threadId, record);
      const persisted = write(next);
      if((requirePersistent||operation==='queue')&&!persisted)throw Error('The submission notice could not be saved. No message was sent; your draft is kept.');
      states.set(threadId, {record, phase: 'waiting', inFlight: true, checked: false, checking: false, volatile: !persisted, reason: ''});
      if (persisted) ignored.delete(threadId);
      return {...record};
    }
    function markUnknown(token, reason, inFlight = false) {
      refresh(); const state = states.get(token?.threadId);
      if (!same(state, token)) return false;
      Object.assign(state, {phase: 'unknown', inFlight, checked: false, checking: false, reason: String(reason || 'The submission outcome is unconfirmed.').slice(0, 1600)});
      return true;
    }
    function remove(state) {
      const {threadId, localId} = state.record, next = new Map(disk);
      if (next.get(threadId)?.localId === localId || next.get(threadId)?.localId === ignored.get(threadId)) next.delete(threadId);
      const persisted = write(next);
      // An explicitly acknowledged notice may be hidden only for this page when storage fails.
      if (!persisted && disk.has(threadId) && !ignored.has(threadId)) ignored.set(threadId, localId);
      states.delete(threadId);
      return persisted;
    }
    function settle(token, outcome) {
      refresh(); const state = states.get(token?.threadId);
      if (!same(state, token)) return false;
      state.inFlight = false;
      if (state.phase !== 'waiting' && state.record.operation !== 'queue') {state.checked = false; state.checking = false; return false;}
      if (!['confirmed', 'cancelled'].includes(outcome)) {markUnknown(token, 'The submission outcome is unconfirmed. Review history before sending again.'); return false;}
      if (state.volatile && disk.get(token.threadId)?.localId !== token.localId) {states.delete(token.threadId); return true;}
      const persisted = remove(state);
      if (!persisted) {
        ignored.delete(token.threadId);
        states.set(token.threadId, {...state, phase: 'unknown', volatile: true, reason: 'The reply arrived, but its saved submission notice could not be cleared. Review task state before sending again.'});
        return false;
      }
      return true;
    }
    function stop() {
      refresh();
      for (const state of states.values()) {
        state.phase = 'unknown'; state.checked = false; state.checking = false;
        state.reason = 'Stop was requested. Any message already sent may have run. Review task state before sending again.';
      }
    }
    function startCheck(token) {
      refresh(); const state = states.get(token?.threadId);
      if (!same(state, token) || state.phase !== 'unknown' || state.inFlight || state.checking) return false;
      state.checked = false; state.checking = true; return true;
    }
    function finishCheck(token, succeeded) {
      refresh(); const state = states.get(token?.threadId);
      if (!same(state, token) || !state.checking) return false;
      state.checking = false; state.checked = succeeded === true && !state.inFlight && state.phase === 'unknown'; return state.checked;
    }
    function acknowledge(token) {
      refresh(); const state = states.get(token?.threadId);
      if (!same(state, token) || state.phase !== 'unknown' || state.inFlight || state.checking || !state.checked) return false;
      if (readIssue) {reviewedWithoutStorage.add(token.threadId); if (reviewedWithoutStorage.size > LIMIT) reviewedWithoutStorage.delete(reviewedWithoutStorage.values().next().value); states.delete(token.threadId);}
      else remove(state);
      return true;
    }
    refresh();
    return Object.freeze({current, begin, settle, markUnknown, stop, startCheck, finishCheck, acknowledge, refresh, warning});
  }
  globalThis.SalehSubmission = Object.freeze({createStore, storageKey: KEY});
})();
