/* Display-only metrics. Every call describes one reported snapshot; nothing is accumulated. */
/* Context presentation adapted from Cline, Copyright 2026 Cline Bot Inc., Apache-2.0.
 * https://github.com/cline/cline/blob/789f79e46d3ba579717e8dc8be35fe28af935b06/sdk/packages/ui/components/agent-context-usage.tsx
 * Modified for Saleh: reported totals, freshness/consistency gates, native HTML meter; no React.
 * License and attribution: bundled THIRD-PARTY-NOTICES.txt. */
(() => {
  'use strict';
  const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningOutputTokens', 'cacheWriteInputTokens'];
  const primary = ['inputTokens', 'outputTokens', 'totalTokens'];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const number = new Intl.NumberFormat('en-US', {maximumFractionDigits: 3});
  const label = value => typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, 160) : null;
  const empty = () => Object.fromEntries(fields.map(key => [key, null]));

  function normalizeTokenUsage(value) {
    const issues = [], absent = value === undefined || value === null;
    if (!absent && !object(value)) issues.push('The reported usage snapshot is invalid.');
    const read = key => {
      const result = empty(), input = object(value) ? value[key] : null;
      if (input !== undefined && input !== null && !object(input)) issues.push(`The reported ${key} usage is invalid.`);
      if (object(input)) for (const field of fields) {
        if (!own(input, field) || input[field] === null || input[field] === undefined) continue;
        if (count(input[field])) result[field] = input[field] === 0 ? 0 : input[field];
        else issues.push(`The reported ${key}.${field} is invalid and is not shown.`);
      }
      return Object.freeze(result);
    };
    const total = read('total'), last = read('last');
    let modelContextWindow = null;
    if (object(value) && value.modelContextWindow !== undefined && value.modelContextWindow !== null) {
      if (count(value.modelContextWindow)) modelContextWindow = value.modelContextWindow;
      else issues.push('The reported context-window value is invalid and is not shown.');
    }
    const available = fields.some(key => total[key] !== null);
    const incomplete = !absent && primary.some(key => total[key] === null);
    // These comparisons flag impossible subset relationships without inventing a total.
    if (total.totalTokens !== null && ['inputTokens', 'outputTokens'].some(key => total[key] !== null && total[key] > total.totalTokens)) issues.push('Reported token counts conflict; no total has been recalculated.');
    if (total.inputTokens !== null && total.cachedInputTokens !== null && total.cachedInputTokens > total.inputTokens) issues.push('Reported cached input exceeds reported input; counts are shown as reported.');
    if (total.outputTokens !== null && total.reasoningOutputTokens !== null && total.reasoningOutputTokens > total.outputTokens) issues.push('Reported reasoning output exceeds reported output; counts are shown as reported.');
    return Object.freeze({total, last, modelContextWindow, available, incomplete, absent, issues: Object.freeze(issues)});
  }

  function summarize(input = {}) {
    const data = object(input) ? input : {};
    const usage = normalizeTokenUsage(data.tokenUsage);
    const notices = [...usage.issues];
    const request = usage.last, window = usage.modelContextWindow;
    const completeRequest = primary.every(key => request[key] !== null);
    const inconsistentRequest = completeRequest && request.inputTokens + request.outputTokens !== request.totalTokens ||
      request.cachedInputTokens !== null && request.inputTokens !== null && request.cachedInputTokens > request.inputTokens ||
      request.reasoningOutputTokens !== null && request.outputTokens !== null && request.reasoningOutputTokens > request.outputTokens;
    if (inconsistentRequest) notices.push('The last reported request counts are inconsistent; context usage is not shown.');
    if (Array.isArray(data.notices)) for (const value of data.notices.slice(0, 8)) {
      if (typeof value === 'string' && value.trim()) notices.push(value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500));
    }
    if (!object(input)) notices.unshift('Run details are unavailable.');
    let durationMs = null;
    if (data.reportedTurn !== undefined && data.reportedTurn !== null && !object(data.reportedTurn)) notices.push('The reported duration is invalid and is not shown.');
    else if (object(data.reportedTurn) && data.reportedTurn.durationMs !== undefined && data.reportedTurn.durationMs !== null) {
      if (count(data.reportedTurn.durationMs)) durationMs = data.reportedTurn.durationMs;
      else notices.push('The reported duration is invalid and is not shown.');
    }
    const stale = data.stale === true;
    const incomplete = data.incomplete === true || usage.incomplete || usage.issues.length > 0 || inconsistentRequest;
    if (stale) notices.unshift('Earlier snapshot — may be out of date.');
    if (incomplete) notices.push('Reported usage is incomplete. Missing or invalid values are not zero.');
    if (!usage.available) notices.push('Token usage has not been reported for this task.');
    const format = value => value === null ? 'Not reported' : number.format(value);
    let context = null;
    if (completeRequest && window > 0 && !incomplete) {
      const fraction = request.totalTokens / window;
      context = Object.freeze({ratio: Math.min(Math.max(fraction, 0), 1),
        label: `Last reported request: ${format(request.totalTokens)} / ${format(window)} tokens (${number.format(fraction * 100)}%)${fraction > 1 ? ' — exceeds reported window' : ''}${stale ? ' — earlier snapshot' : ''}`});
    }
    const rows = [
      {label: 'Reported duration', value: durationMs === null ? 'Not reported' : durationMs < 1000 ? `${number.format(durationMs)} ms` : `${number.format(durationMs / 1000)} s`},
      {label: 'Reported thread tokens', value: format(usage.total.totalTokens)},
      {label: 'Input tokens', value: format(usage.total.inputTokens)},
      {label: 'Output tokens', value: format(usage.total.outputTokens)},
      {label: 'Reported request context', value: context?.label ?? 'Not reported'},
    ];
    for (const [key, title] of [['cachedInputTokens', 'Cached input tokens'], ['reasoningOutputTokens', 'Reasoning output tokens'], ['cacheWriteInputTokens', 'Cache-write input tokens']]) {
      if (usage.total[key] !== null) rows.push({label: title, value: format(usage.total[key])});
    }
    rows.push({label: 'Cost', value: 'Not reported'});
    const provenance = object(data.provenance) ? data.provenance : {};
    for (const [key, title] of [['source', 'Source'], ['session', 'Session']]) {
      const text = label(provenance[key]); if (text) rows.push({label: title, value: text});
    }
    return Object.freeze({
      rows: Object.freeze(rows.map(row => Object.freeze(row))),
      notices: Object.freeze([...new Set(notices)]), stale, incomplete, context,
      note: 'Token counts are reported thread totals, not a per-turn total or a measure of task success. Context usage describes the last reported request, not live context or next-request capacity. Cached input and reasoning output are breakdowns, not additional tokens. Duration includes time between turn start and completion. Cost is not calculated.',
    });
  }

  function createDetails(document, input = {}) {
    if (!document || typeof document.createElement !== 'function') throw new TypeError('A document is required to render run details.');
    const report = summarize(input), details = document.createElement('details');
    details.className = 'run-details'; details.setAttribute('aria-label', 'Run details');
    const summary = document.createElement('summary'); summary.textContent = 'Run details'; details.append(summary);
    const grid = document.createElement('dl'); grid.className = 'run-details-grid';
    for (const row of report.rows) {
      const group = document.createElement('div'), term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = row.label; description.textContent = row.value; group.append(term, description); grid.append(group);
    }
    details.append(grid);
    if (report.context) {
      const meter = document.createElement('meter');
      meter.min = 0; meter.max = 1; meter.value = report.context.ratio;
      meter.setAttribute('aria-label', report.context.label); meter.textContent = report.context.label;
      details.append(meter);
    }
    for (const text of report.notices) {
      const notice = document.createElement('p'); notice.className = 'run-details-notice'; notice.textContent = text; details.append(notice);
    }
    const note = document.createElement('p'); note.className = 'run-details-note'; note.textContent = report.note; details.append(note);
    return details;
  }

  globalThis.SalehCodingMetrics = Object.freeze({normalizeTokenUsage, summarize, createDetails});
})();
