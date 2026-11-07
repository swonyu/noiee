// Offline shipped-reader/renderer check. No application, browser, server, stores or model.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const path = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('./coding.js', import.meta.url));
const source = readFileSync(path, 'utf8');
const begin = source.indexOf('// MCP OUTCOMES HELPERS BEGIN'), end = source.indexOf('// MCP OUTCOMES HELPERS END');
const renderBegin = source.indexOf('  function renderMCPOutcomes('), renderEnd = source.indexOf('\n  }\n', renderBegin);
assert(begin >= 0 && end > begin && renderBegin > end && renderEnd > renderBegin, 'Actual shipped reader/renderer boundaries required');
const syncBegin = source.indexOf('  function syncMCPOutcomes('), syncEnd = source.indexOf('\n  }\n', syncBegin);
assert(syncBegin > end && syncEnd > syncBegin);
const shipped = source.slice(begin, end) + '\n' + source.slice(syncBegin, syncEnd + 5) + '\n' + source.slice(renderBegin, renderEnd + 5);
const busy = 'Tools are busy stopping; wait for Stop to finish before starting or reading work.';
const unavailable = 'Saved MCP outcomes are unavailable. Refresh to check again.';
const absent = threadId => ({threadId, available: false});
const node = text => ({textContent: text || '', children: [], dataset: {}, hidden: false, contains() {return false;}, append(...items) {this.children.push(...items);}, setAttribute() {}});
const text = item => [item.textContent, ...item.children.map(text)].join('\n');
function fixture(first, id = 'native-test') {
  const replies = [first], calls = [], host = node();
  const c = vm.createContext({TextEncoder, document:{activeElement:null}, selectedId: id, disposed: false, bridge: {}, current: () => ({historySource:'owner',metadataPending:false}),
    $: name => name === 'coding-mcp-outcomes' ? host : null,
    element: (_tag, _class, value) => node(value), syncNode: (old, next) => Object.assign(old, next),
    read: async threadId => {calls.push(threadId);assert(replies.length, 'No automatic or unarranged read');const reply = replies.shift();if (reply instanceof Error) throw reply;return typeof reply === 'function' ? reply(threadId) : reply;}});
  vm.runInContext(shipped + '\nthis.mcpOutcomes = codingMCPOutcomeReader({read, changed: renderMCPOutcomes});', c);
  c.mcpOutcomes.select(id);
  return {c, host, calls, reader: c.mcpOutcomes, text: () => text(host),
    flush: async () => {for (let i = 0; i < 12; i++) await Promise.resolve();},
    refresh: async reply => {replies.push(reply);await c.mcpOutcomes.refresh();},
    reconcile: async reply => {if (reply) replies.push(reply);c.syncMCPOutcomes();for (let i = 0; i < 12; i++) await Promise.resolve();},
    postStop: async reply => {replies.push(reply);c.mcpOutcomes.invalidate('Checking saved MCP outcomes after the Stop response.');for (let i = 0; i < 12; i++) await Promise.resolve();}};
}
function journal(threadId = 'native-test') {
  return {threadId, available: true, ownerId: '11111111-1111-4111-8111-111111111111', storeId: '22222222-2222-4222-8222-222222222222', revision: 1, blocked: false, warning: '', cached: false, complete: true,
    records: [{attemptId: '33333333-3333-4333-8333-333333333333', ownerGeneration: 'owner-generation', processGeneration: 'process-generation', threadId, turnId: 'turn', callId: 'call', rpcId: 'rpc', server: 'fixture', name: 'read', createdAt: 1, intendedAt: 1, providerAt: null, deliveryAt: null, provider: 'unknown', delivery: 'unknown', reason: null, persistence: 'durable'}]};
}

test('busy Stop does not turn verified no-MCP state into missing evidence; existing post-response refresh recovers', async () => {
  const h = fixture(absent('native-test'));await h.flush();
  assert.equal(h.host.hidden, true);
  await h.refresh(Error(busy));
  assert.equal(h.host.hidden, true, 'Busy Stop must not turn a verified no-MCP snapshot into missing evidence');
  assert.equal(h.reader.current().error, '');assert.equal(h.reader.current().snapshot.available, false);
  assert.deepEqual(h.calls, ['native-test', 'native-test'], 'Busy Stop cannot schedule another read or action');
  await h.postStop(absent('native-test'));
  assert.equal(h.host.hidden, true);assert.equal(h.reader.current().error, '');assert.equal(h.calls.length, 3);
});

test('busy first read displays waiting without claiming unavailable or verified outcomes', async () => {
  const h = fixture(Error(busy));await h.flush();
  assert.equal(h.host.hidden, false);assert.equal(h.reader.current().snapshot, null);
  assert.match(h.text(), /waiting for Stop|Stop is still finishing/i);
  assert.doesNotMatch(h.text(), /Saved outcome evidence is unavailable|Saved MCP outcomes are unavailable/);
  assert.equal(h.calls.length, 1);
  await h.postStop(absent('native-test'));assert.equal(h.host.hidden, true);
});

test('busy Stop retains unknown action evidence and saved incomplete-journal warnings', async () => {
  const saved = journal();saved.complete = false;saved.blocked = true;saved.warning = 'Fixture journal evidence is incomplete.';
  const h = fixture(saved);await h.flush();
  await h.refresh(Error(busy));
  assert.equal(h.host.hidden, false);assert.equal(h.reader.current().snapshot.records.length, 1);
  assert.match(h.text(), /Completion unknown/);assert.match(h.text(), /Fixture journal evidence is incomplete/);
  assert.doesNotMatch(h.text(), /Saved MCP outcomes are unavailable/);
});

test('unrelated failures, malformed snapshots and disappeared evidence remain errors through busy Stop', async () => {
  const h = fixture(journal());await h.flush();
  await h.refresh(Error('different transport failure'));assert.equal(h.reader.current().error, unavailable);
  await h.refresh(Error(busy));assert.equal(h.reader.current().error, unavailable);
  await h.refresh({threadId: 'wrong', available: false});assert.match(h.reader.current().error, /could not be validated/);
  const corrupt = h.reader.current().error;
  await h.refresh(Error(busy));assert.equal(h.reader.current().error, corrupt);
  await h.refresh(absent('native-test'));assert.match(h.reader.current().error, /earlier evidence is retained/);
  assert.equal(h.reader.current().snapshot.records.length, 1);assert.match(h.text(), /Completion unknown/);
});

test('only the exact stopping rejection is transient, and a later failure is still unavailable', async () => {
  const h = fixture(Error(busy));await h.flush();
  await h.refresh(Error(busy + ' Different failure.'));
  assert.equal(h.reader.current().error, unavailable);assert.match(h.text(), /Saved outcome evidence is unavailable/);
  assert.doesNotMatch(h.text(), /waiting for Stop|Stop is still finishing/i);
});

test('a delayed busy rejection cannot change a newly selected task', async () => {
  let reject;
  const h = fixture(() => new Promise((_resolve, fail) => {reject = fail;}));await h.flush();
  h.c.selectedId = 'other';h.reader.select('other', 'legacy');reject(Error(busy));await h.flush();
  assert.equal(h.reader.current().threadId, 'other');assert.equal(h.reader.current().error, '');
  assert.match(h.text(), /unavailable for this legacy chat/);assert.doesNotMatch(h.text(), /waiting for Stop|Stop is still finishing/i);
  assert.deepEqual(h.calls, ['native-test']);
});

test('verified same-task history reconciliation rechecks a failed startup inspection without dispatching calls', async () => {
  const h = fixture(Error('Coding owner metadata is changing; outcome inspection is incomplete. Retry inspection.'));await h.flush();
  assert.equal(h.reader.current().error, unavailable);assert.equal(h.calls.length, 1);
  await h.reconcile(absent('native-test'));
  assert.equal(h.reader.current().error, '');assert.equal(h.host.hidden, true);
  assert.deepEqual(h.calls, ['native-test', 'native-test']);
  await h.reconcile();assert.equal(h.calls.length, 2, 'Healthy metadata redraw does not keep reading');
});

test('history reconciliation retains real uncertain receipts and never treats an absent journal as success', async () => {
  const saved = journal();saved.blocked = true;saved.complete = false;saved.warning = 'Retain this real incomplete-journal evidence.';
  const h = fixture(saved);await h.flush();
  await h.reconcile();assert.equal(h.calls.length, 1, 'A verified blocked snapshot is not a transport error and is not retried');
  await h.refresh(Error('Transport unavailable'));await h.reconcile(absent('native-test'));
  assert.equal(h.reader.current().snapshot.records.length, 1);assert.equal(h.reader.current().snapshot.warning, saved.warning);
  assert.match(h.reader.current().error, /earlier evidence is retained/);assert.match(h.text(), /Completion unknown/);
});
