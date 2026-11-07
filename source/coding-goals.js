/* Durable Goals UI. Reads never start a turn; Continue is an explicit, revision-bound action. */
(() => {
  'use strict';
  const states = new Set(['ready','paused','complete','budgetLimited','needsReview']);
  const outcomes = new Set(['starting','running','completed','failed','interrupted','unknown']);
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const text = value => typeof value === 'string' && value.length <= 4000 && !value.includes('\0') && new TextEncoder().encode(value).length <= 16000;
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  function validView(value) {
    if (!value || typeof value !== 'object' || !integer(value.revision) ||
        value.available !== undefined && typeof value.available !== 'boolean' ||
        value.blockedReason !== undefined && (typeof value.blockedReason !== 'string' || value.blockedReason.length > 4000)) return false;
    if (value.goal === null) return value.revision === 0;
    const goal = value.goal;
    if (!goal || typeof goal !== 'object' || !id(goal.id) || !goal.binding || !id(goal.binding.rootThreadId) || goal.revision < 1 || goal.revision !== value.revision || !states.has(goal.state) ||
        !text(goal.objective) || !goal.objective.trim() || !text(goal.completionCriteria) || !goal.completionCriteria.trim() ||
        !integer(goal.maxTurns) || goal.maxTurns < 1 || goal.maxTurns > 20 || !Array.isArray(goal.attempts) ||
        goal.attempts.length > 20 || goal.attemptsUsed !== goal.attempts.length ||
        goal.attemptsRemaining !== goal.maxTurns - goal.attemptsUsed || goal.attemptsRemaining < 0 ||
        !integer(goal.createdAt) || !integer(goal.updatedAt) ||
        goal.completionEvidence != null && !text(goal.completionEvidence)) return false;
    const seen = new Set();
    return goal.attempts.every(attempt => {
      if (!attempt || !id(attempt.id) || seen.has(attempt.id) || !outcomes.has(attempt.status) ||
          !['plan','build'].includes(attempt.mode) || !['none','high'].includes(attempt.effort) ||
          attempt.turnId != null && !id(attempt.turnId) || !integer(attempt.claimedAt)) return false;
      seen.add(attempt.id); return true;
    });
  }
  function sameBinding(a,b,depth = 0) {
    if (a === b) return true;
    if (depth > 8 || !a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
    return keys.length === other.length && keys.every((key,index) => key === other[index] && sameBinding(a[key],b[key],depth + 1));
  }
  function scopedView(value,threadId,previous = null) {
    return validView(value) && (!value.goal || value.goal.binding.rootThreadId === threadId) &&
      (!previous || !!value.goal && value.goal.id === previous.id && sameBinding(value.goal.binding,previous.binding));
  }
  function validDraft(draft) {
    return !!draft && typeof draft === 'object' && !Array.isArray(draft) &&
      Object.keys(draft).every(key => ['objective','completionCriteria','maxTurns','evidence','revision','editing','completing'].includes(key)) &&
      text(draft.objective ?? '') && text(draft.completionCriteria ?? '') && text(draft.evidence ?? '') &&
      typeof draft.maxTurns === 'string' && draft.maxTurns.length <= 6 && integer(draft.revision) &&
      typeof draft.editing === 'boolean' && typeof draft.completing === 'boolean';
  }
  function create({getContext,call,getDraft,saveDraft,run,onTurn,onChange}) {
    const $ = name => document.getElementById('goal-' + name);
    let scope = '', epoch = 0, view = null, inspected = false, loading = false, pending = null, disposed = false;
    let error = '', notice = '', opened = false, draftError = false, hydratedDraft = null, lastReadAt = 0, lastAttempts = null;
    const active = goal => goal?.attempts?.some(attempt => ['starting','running'].includes(attempt.status));
    const draft = () => getDraft(scope);
    const usableDraft = () => validDraft(draft()) ? draft() : null;
    const status = goal => active(goal) ? (goal.state === 'paused' ? 'Paused for next turn · current work continues' : 'Working') :
      ({ready:'Ready to continue',paused:'Paused',complete:'Marked complete',budgetLimited:'Turn limit reached',needsReview:'Outcome needs review'}[goal?.state] || 'No saved goal');
    const snapshot = (goal = view?.goal) => ({objective:goal?.objective || '',completionCriteria:goal?.completionCriteria || '',
      maxTurns:String(goal?.maxTurns || 3),evidence:'',revision:view?.revision ?? 0,editing:false,completing:false});
    function store(value) {
      if (!scope || value !== null && !validDraft(value)) {draftError = true; render(); return false;}
      if (!saveDraft(scope,value)) {draftError = true; render(); return false;}
      draftError = false; hydratedDraft = null; return true;
    }
    function hydrate() {
      const saved = usableDraft();
      if (!saved || same(saved,hydratedDraft)) return;
      for (const key of ['objective','completionCriteria','maxTurns','evidence']) {
        const field = $(({completionCriteria:'criteria',maxTurns:'limit'}[key] || key) + '-input');
        if (field.value !== saved[key]) field.value = saved[key];
      }
      hydratedDraft = structuredClone(saved);
    }
    function persistFields() {
      const prior = usableDraft();
      if (!prior) return false;
      const saved = store({...prior,objective:$('objective-input').value,completionCriteria:$('criteria-input').value,
        maxTurns:$('limit-input').value,evidence:$('evidence-input').value});
      render(); return saved;
    }
    function startEdit() {
      if (!view || view.available === false || pending || loading || draftError || draft() != null && !usableDraft() || getContext().busy || !getContext().canEdit || view.goal?.state === 'complete') return;
      const saved = usableDraft();
      if (!store(saved?.editing ? saved : {...snapshot(),editing:true})) return;
      opened = true; render(); $('objective-input').focus();
    }
    function open() {
      if (!getContext().canInspect) return;
      opened = true;
      if (view && !view.goal && draft() == null) startEdit();
      render();
    }
    function close() {
      opened = false; render(); $('toggle').focus();
    }
    async function refresh() {
      const context = getContext();
      if (disposed || !scope || !context.canInspect || loading || pending) return;
      const selected = scope, generation = epoch;
      loading = true; render();
      try {
        const result = await call('goalInspect',{threadId:selected});
        if (scope !== selected || epoch !== generation) return;
        if (!scopedView(result,selected,view?.goal)) throw Error('The saved goal could not be verified. Your goal and drafts are preserved.');
        if (view && result.revision < view.revision) throw Error('An older goal response arrived. Refresh to check the current revision.');
        view = result; error = ''; lastReadAt = Date.now();
        if (opened && result.available !== false && !result.goal && draft() == null) store({...snapshot(),editing:true});
      } catch (caught) {
        if (scope === selected && epoch === generation) error = caught?.message || 'The saved goal could not be read.';
      } finally {
        if (scope === selected && epoch === generation) {loading = false; inspected = true; render(); onChange();}
      }
    }
    async function change(action, extra = {}, capturedDraft = null) {
      const context = getContext(), selected = scope, generation = epoch;
      if (disposed || !view || view.available === false || error || draftError || draft() != null && !usableDraft() || pending || loading || context.busy || !context.canEdit ||
          action === 'goalContinue' && !context.canContinue) return;
      const revision = view.revision, previousGoal = view.goal, focused = document.activeElement;
      let acknowledgedAction = false;
      if (capturedDraft && capturedDraft.revision !== revision) {error = 'The goal changed while you were editing. Your draft is kept; cancel the edit to review the latest goal.';render();return;}
      const cancellation = {cancelled:false};
      pending = {threadId:selected,action,cancellation}; notice = ''; render();
      await run(async () => {
        try {
          const result = await call(action,{threadId:selected,expectedRevision:revision,...extra},cancellation);
          if (disposed) return;
          if (cancellation.cancelled || result.cancelled === true) {
            if (scope === selected) error = 'The request was cancelled. Refresh the goal to check its saved state before continuing.';
            return;
          }
          const acknowledged = scopedView(result,selected,previousGoal) && result.goal && result.revision > revision;
          const exactChange = action === 'goalSave' ? result.goal?.objective === extra.objective &&
            result.goal?.completionCriteria === extra.completionCriteria && result.goal?.maxTurns === extra.maxTurns :
            action === 'goalComplete' ? result.goal?.state === 'complete' && result.goal?.completionEvidence === extra.evidence :
            action === 'goalPause' ? result.goal?.state === 'paused' :
            action === 'goalResume' ? result.goal?.state === 'ready' :
            action === 'goalContinue' ? !!previousGoal && result.goal?.attemptsUsed === previousGoal.attemptsUsed + 1 &&
              previousGoal.attempts.every((attempt,index) => result.goal?.attempts[index]?.id === attempt.id) &&
              result.goal?.attempts.at(-1)?.mode === extra.mode && result.goal?.attempts.at(-1)?.effort === extra.effort &&
              !!result.turn?.id && result.goal?.attempts.at(-1)?.turnId === result.turn.id : false;
          if (!acknowledged || !exactChange) throw Error('The action reply could not be verified. It may have succeeded. Refresh the goal before continuing.');
          acknowledgedAction = true;
          if (scope === selected && epoch === generation) {
            view = result; error = ''; inspected = true; lastReadAt = Date.now();
            if (capturedDraft && same(getDraft(selected),capturedDraft)) store(null);
            if (action === 'goalPause') notice = 'Next continuation paused. Current work continues until it finishes or you use Stop.';
            if (action === 'goalResume') notice = 'Goal ready. Choose Continue goal when you want the next turn.';
            if (action === 'goalSave') notice = 'Goal saved. Work starts when you choose Continue goal.';
            if (action === 'goalComplete') notice = 'Completion and your review evidence are saved.';
          }
          if (action === 'goalContinue') await onTurn(selected,result);
        } catch (caught) {
          if (scope === selected && epoch === generation) error = caught?.message || 'The goal action could not be confirmed. Refresh before continuing.';
        } finally {
          pending = null; if (!disposed) {render(); onChange();}
          if (!disposed && acknowledgedAction && scope === selected && epoch === generation && !draftError && ['goalSave','goalComplete'].includes(action)) {
            $('panel').scrollTop = 0;
            if (document.activeElement === focused || document.activeElement === document.body || !document.activeElement?.isConnected) $('heading').focus({preventScroll:true});
          }
        }
      });
    }
    function renderAttempts(goal) {
      const key = JSON.stringify(goal?.attempts || []);
      if (key === lastAttempts) return;
      lastAttempts = key;
      const rows = document.createDocumentFragment();
      for (const [index,attempt] of (goal?.attempts || []).entries()) {
        const row = document.createElement('li'), heading = document.createElement('strong'), detail = document.createElement('p');
        heading.textContent = String(index + 1) + '. ' + ({starting:'Starting · acknowledgement pending',running:'Working',completed:'Turn finished',failed:'Failed',interrupted:'Stopped',unknown:'Outcome unconfirmed'}[attempt.status]);
        const stamp = new Date(attempt.claimedAt).toLocaleString();
        detail.textContent = (attempt.mode === 'plan' ? 'Plan' : 'Build') + ' · ' + (attempt.effort === 'high' ? 'Deep' : 'Standard') + ' · ' + stamp;
        row.append(heading,detail);
        if (integer(attempt.contractRevision) && integer(attempt.maxTurnsAtDispatch)) {
          const contract = document.createElement('p');contract.textContent = 'Saved goal revision ' + attempt.contractRevision + ' · turn limit ' + attempt.maxTurnsAtDispatch;row.append(contract);
        }
        if (['unknown','failed'].includes(attempt.status) && typeof attempt.message === 'string' && attempt.message.length <= 2000) {
          const explanation = document.createElement('p');explanation.textContent = attempt.message;row.append(explanation);
        }
        if (attempt.turnId) {const turn = document.createElement('p');turn.className = 'goal-attempt-id';turn.textContent = 'Turn ' + attempt.turnId;row.append(turn);}
        const tokens = attempt.observedUsage?.last?.totalTokens;
        if (integer(tokens)) {const usage = document.createElement('p');usage.textContent = 'Reported token snapshot: ' + tokens.toLocaleString();row.append(usage);}
        rows.append(row);
      }
      $('attempt-list').replaceChildren(rows);
      $('attempts').hidden = !goal?.attempts?.length;
    }
    function render() {
      if (disposed) return;
      const context = getContext(), goal = view?.goal, saved = usableDraft();
      const storedInvalid = draft() != null && !saved, busy = !!pending || loading || context.busy;
      const held = !!error || storedInvalid || draftError || view?.available === false || !context.canEdit;
      const edit = !!saved?.editing, completing = !!saved?.completing;
      $('toggle').disabled = !context.canInspect;
      $('toggle').setAttribute('aria-expanded',String(opened && context.canInspect));
      $('panel').hidden = !opened || !context.canInspect;
      $('bar').hidden = !goal || !context.canInspect;
      $('bar-title').textContent = goal?.objective || '';
      $('bar-state').textContent = status(goal);
      $('bar-budget').textContent = goal ? goal.attemptsUsed + '/' + goal.maxTurns + ' attempts' : '';
      $('view').hidden = !goal;
      $('empty').hidden = !!goal || loading || edit;
      $('loading').hidden = !loading;
      $('refresh').disabled = !context.canInspect || loading || !!pending;
      $('notice').textContent = storedInvalid ? 'A saved goal draft could not be read. It is preserved; editing is paused.' :
        draftError ? 'Your goal draft could not be saved. Keep this window open and copy the text before leaving.' :
        error || (view?.available === false ? view.blockedReason || 'This saved goal is available for inspection only.' : '') || notice || context.blockedReason || '';
      $('notice').hidden = !$('notice').textContent;
      $('objective').textContent = goal?.objective || '';
      $('criteria').textContent = goal?.completionCriteria || '';
      $('state').textContent = status(goal);
      $('budget').textContent = goal ? goal.attemptsUsed + ' of ' + goal.maxTurns + ' continuation attempts used.' : '';
      $('continuation-note').textContent = 'Continue starts one ' + (context.mode === 'plan' ? 'Plan' : 'Build') +
        ' turn with ' + (context.effort === 'high' ? 'Deep' : 'Standard') + ' reasoning. Review its result before continuing.';
      $('continue').hidden = !goal || goal.state !== 'ready';
      $('continue').disabled = busy || held || edit || completing || active(goal) || !context.canContinue || !goal?.attemptsRemaining;
      $('pause').hidden = !goal || goal.state !== 'ready';
      $('pause').disabled = busy || held || edit || completing;
      $('resume').hidden = !goal || goal.state !== 'paused';
      $('resume').disabled = busy || held || edit || completing || active(goal) || !goal?.attemptsRemaining;
      $('edit').hidden = !goal || goal.state === 'complete' || edit;
      $('edit').disabled = busy || held || completing || active(goal) || goal?.state === 'needsReview';
      $('new').disabled = busy || held || !view;
      $('review-complete').hidden = !goal || goal.state === 'complete' || completing;
      $('review-complete').disabled = busy || held || edit || active(goal) || goal?.state === 'needsReview';
      $('editor').hidden = !edit;
      $('complete-form').hidden = !completing;
      $('saved-evidence').hidden = !goal?.completionEvidence;
      $('evidence').textContent = goal?.completionEvidence || '';
      const stale = saved && saved.revision !== view?.revision;
      $('edit-note').textContent = stale ? 'This goal changed after your draft was saved. Cancel this edit to review the latest goal; your draft is kept until you choose Cancel.' :
        'Opening or saving a goal starts no work. Started or uncertain attempts count toward the turn limit.';
      for (const name of ['objective-input','criteria-input','limit-input','evidence-input','reviewed']) $(name).disabled = busy || held;
      $('save').disabled = busy || held || stale;
      $('complete').disabled = busy || held || stale || !$('reviewed').checked;
      $('cancel-edit').disabled = !!pending;
      $('cancel-complete').disabled = !!pending;
      $('pause-note').hidden = !goal || goal.state === 'complete';
      hydrate(); renderAttempts(goal);
    }
    function update() {
      if (disposed) return;
      const context = getContext(), next = context.threadId || '';
      if (scope !== next) {
        scope = next; epoch++; view = null; inspected = false; loading = false;
        error = ''; notice = ''; draftError = false; hydratedDraft = null; lastAttempts = null;
        opened = !!usableDraft()?.editing || !!usableDraft()?.completing;
        $('reviewed').checked = false;
      }
      render();
      if (context.canInspect && !inspected && !loading && !pending) void refresh();
    }
    function tick() {
      if (!disposed && getContext().canInspect && view?.goal && !getContext().busy && Date.now() - lastReadAt > 4000 &&
          (active(view.goal) || view.goal.state === 'needsReview')) void refresh();
    }
    function cancelPending() {
      if (!pending) return;
      pending.cancellation.cancelled = true;
      if (scope === pending.threadId) notice = 'Stop requested. The saved outcome remains unconfirmed until the original request settles.';
      render();
    }
    window.addEventListener('agent-stopped',cancelPending);
    window.addEventListener('tools-stopped',cancelPending);
    window.addEventListener('pagehide',() => {cancelPending();disposed = true;epoch++;},{once:true});
    $('toggle').onclick = () => opened ? close() : open();
    $('open-saved').onclick = open;
    $('close').onclick = close;
    $('refresh').onclick = () => void refresh();
    $('new').onclick = startEdit; $('edit').onclick = startEdit;
    for (const name of ['objective-input','criteria-input','limit-input','evidence-input']) $(name).oninput = persistFields;
    $('editor').onsubmit = event => {
      event.preventDefault(); if (!persistFields()) return; const saved = usableDraft();
      if (!saved?.editing || !text(saved.objective) || !saved.objective.trim() ||
          !text(saved.completionCriteria) || !saved.completionCriteria.trim()) return;
      const limit = Number(saved.maxTurns);
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) return;
      void change('goalSave',{objective:saved.objective,completionCriteria:saved.completionCriteria,maxTurns:limit},structuredClone(saved));
    };
    $('cancel-edit').onclick = () => {if (!pending && store(null)) {notice = '';render();}};
    $('cancel-complete').onclick = () => {if (!pending && store(null)) {$('reviewed').checked = false;render();}};
    $('continue').onclick = () => {
      const context = getContext();
      void change('goalContinue',{mode:context.mode,effort:context.effort});
    };
    $('pause').onclick = () => void change('goalPause');
    $('resume').onclick = () => void change('goalResume');
    $('review-complete').onclick = () => {
      if (!view?.goal || active(view.goal) || view.goal.state === 'needsReview' || pending) return;
      if (store({...snapshot(),completing:true})) {$('reviewed').checked = false;render();$('evidence-input').focus();}
    };
    $('reviewed').onchange = render;
    $('complete-form').onsubmit = event => {
      event.preventDefault(); if (!persistFields()) return; const saved = usableDraft();
      if (!$('reviewed').checked || !saved?.completing || !saved.evidence?.trim()) return;
      void change('goalComplete',{evidence:saved.evidence},structuredClone(saved));
    };
    return Object.freeze({update,refresh,tick,cancelPending,hasPending:() => !!pending});
  }
  globalThis.NoieeCodingGoals = Object.freeze({create,validView,validDraft});
})();
