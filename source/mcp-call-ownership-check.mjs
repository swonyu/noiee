// Synthetic stdio provider and temporary config only. No real services or user config.
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {setTimeout as delay} from 'node:timers/promises';
import {MCPHub} from './mcp.mjs';

if (process.argv[2] === '--provider') {
  const log = process.argv[3];
  let revision = 0;
  const record = value => appendFileSync(log, JSON.stringify({pid: process.pid, ...value}) + '\n');
  const send = value => {if (!process.stdout.destroyed) process.stdout.write(JSON.stringify({jsonrpc: '2.0', ...value}) + '\n');};
  const tools = () => [{
    name: 'echo', description: 'Synthetic call ownership fixture ' + revision,
    inputSchema: {type: 'object', properties: {
      label: {type: 'string'}, mode: {type: 'string'},
      nested: {type: 'object', properties: {tags: {type: 'array', items: {type: 'string'}}}, required: ['tags'], additionalProperties: false},
    }, required: ['label'], additionalProperties: false},
    outputSchema: {type: 'object', properties: {label: {type: 'string'}, pid: {type: 'integer'}}, required: ['label', 'pid'], additionalProperties: false},
  }];
  async function handle(request) {
    if (request.method === 'notifications/cancelled') {record({kind: 'cancel', id: request.params.requestId}); return;}
    if (request.id === undefined) return;
    if (request.method === 'initialize') {
      record({kind: 'initialize'});
      send({id: request.id, result: {protocolVersion: request.params.protocolVersion, capabilities: {tools: {listChanged: true}}, serverInfo: {name: 'ownership-fixture', version: '1'}}});
    } else if (request.method === 'tools/list') send({id: request.id, result: {tools: tools()}});
    else if (request.method === 'tools/call') {
      const args = request.params.arguments;
      record({kind: 'call', id: request.id, name: request.params.name, arguments: args});
      if (args.mode === 'wait') return; // Deliberately ignores cancellation; no completion claim is possible.
      if (args.mode === 'delay') await delay(250);
      if (args.mode === 'catalog-change' || args.mode === 'catalog-unchanged') {
        if (args.mode === 'catalog-change') revision++;
        send({method: 'notifications/tools/list_changed'});
        await delay(30);
      }
      if (args.mode === 'throw') {send({id: request.id, error: {code: -32603, message: 'Synthetic provider failure'}}); return;}
      send({id: request.id, result: {content: [{type: 'text', text: args.label}], structuredContent: {label: args.label, pid: process.pid}, isError: args.mode === 'tool-error'}});
    } else send({id: request.id, error: {code: -32601, message: 'Unknown synthetic method'}});
  }
  createInterface({input: process.stdin}).on('line', line => {void handle(JSON.parse(line));});
} else {
  const root = await mkdtemp(join(tmpdir(), 'mcp-call-ownership-'));
  const config = join(root, 'mcp.json'), log = join(root, 'provider.jsonl');
  const hub = new MCPHub(config), other = new MCPHub(config), groups = [];
  const secret = 'synthetic-configured-secret-ownership';
  const entry = {command: process.execPath, args: ['--preserve-symlinks', fileURLToPath(import.meta.url), '--provider', log], env: {FIXTURE_SECRET: secret}};
  const save = (primary = entry) => writeFile(config, JSON.stringify({mcpServers: {fixture: primary, secondary: entry}}));
  const records = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const calls = async label => (await records()).filter(row => row.kind === 'call' && (label === undefined || row.arguments.label === label));
  const request = (label, extra = {}, server = 'fixture') => ({server, name: 'echo', arguments: {label, ...extra}});
  const prepare = async (label, extra, server) => {const input = request(label, extra, server); return {input, prepared: await hub.prepareCall(input)};};
  const invoke = ({input, prepared}, signal) => hub.call(input, {prepared, ...(signal ? {signal} : {})});
  async function connect(target = hub, server = 'fixture') {
    const row = (await target.describe()).servers.find(value => value.id === server);
    return target.connect(server, row.configHash);
  }
  async function until(check, label) {
    for (let attempt = 0; attempt < 300; attempt++) {if (await check()) return; await delay(10);}
    assert.fail('Synthetic provider checkpoint was not reached: ' + label);
  }
  async function noDispatch(label, action, pattern = /prepared|approval|config|connect|catalog|argument|signal|abort|cancel|consum|used|unknown.*tool/i) {
    const before = (await calls()).length;
    await assert.rejects(async () => action(), pattern, label);
    assert.equal((await calls()).length, before, label + ': no tools/call dispatch');
  }
  function deepFrozen(value) {
    if (!value || typeof value !== 'object') return;
    assert(Object.isFrozen(value), 'Every descriptor/argument object and array must be frozen');
    for (const child of Object.values(value)) deepFrozen(child);
  }
  try {
    // Intentional first red checkpoint: fail before starting a provider if the API is absent.
    assert.equal(typeof hub.prepareCall, 'function', 'MCPHub.prepareCall must exist before task-owned MCP calls can be tested');
    await writeFile(log, ''); await save();
    await noDispatch('preparation never implicitly connects', () => hub.prepareCall(request('not-connected')));
    assert.deepEqual(await records(), [], 'Preparing a disconnected call must not launch a provider');
    await connect();
    const input = request('frozen-exact', {nested: {tags: ['original']}}), expected = structuredClone(input);
    const descriptor = await hub.prepareCall(input);
    assert.deepEqual(Object.keys(descriptor).sort(), ['arguments', 'id', 'name', 'server']);
    assert.equal(typeof descriptor.id, 'string'); assert(descriptor.id.length > 0);
    assert.deepEqual({server: descriptor.server, name: descriptor.name, arguments: descriptor.arguments}, expected);
    deepFrozen(descriptor);
    assert.notEqual(descriptor.arguments, input.arguments); assert.notEqual(descriptor.arguments.nested, input.arguments.nested);
    input.arguments.nested.tags[0] = 'mutated-source';
    assert.deepEqual(descriptor.arguments.nested.tags, ['original']);
    assert.throws(() => {descriptor.arguments.nested.tags.push('mutation');}, TypeError);
    assert(!JSON.stringify(descriptor).includes(secret)); assert(!JSON.stringify(descriptor).includes(config));
    const returned = await hub.call(expected, {prepared: descriptor});
    assert.equal(returned.content[0].text, 'frozen-exact'); assert.equal(returned.structuredContent.label, 'frozen-exact');
    await noDispatch('single-use descriptor', () => hub.call(expected, {prepared: descriptor}));
    assert.equal((await calls('frozen-exact')).length, 1);
    groups.push('deeply frozen exact copied descriptor; confirmed single-use dispatch');

    for (const invalid of [{}, {label: 42}, {label: 'bad', extra: true}, {label: 'bad', nested: {tags: [7]}}, {label: 'x'.repeat(65537)}, {label: secret}]) {
      await noDispatch('invalid or secret-bearing prepared arguments', () => hub.prepareCall({server: 'fixture', name: 'echo', arguments: invalid}), /schema|argument|64|large|secret|credential|redact/i);
    }
    const copied = await prepare('copied-descriptor');
    await noDispatch('copied descriptor is not authority', () => hub.call(copied.input, {prepared: structuredClone(copied.prepared)}));
    const forged = await prepare('forged-descriptor');
    await noDispatch('lookalike descriptor is not authority', () => hub.call(forged.input, {prepared: Object.freeze({...forged.prepared})}));
    const mismatch = await prepare('mismatch');
    await noDispatch('changed arguments do not reuse approval', () => hub.call(request('changed-mismatch'), {prepared: mismatch.prepared}));
    const wrongTool = await prepare('wrong-tool');
    await noDispatch('changed tool does not reuse approval', () => hub.call({...wrongTool.input, name: 'different'}, {prepared: wrongTool.prepared}));
    const wrongServer = await prepare('wrong-server');
    await noDispatch('changed server does not reuse approval', () => hub.call({...wrongServer.input, server: 'secondary'}, {prepared: wrongServer.prepared}));
    await connect(other);
    const cross = await prepare('cross-hub');
    await noDispatch('cross-hub descriptor is rejected', () => other.call(cross.input, {prepared: cross.prepared}));
    await other.close();
    groups.push('schema/cap/credential preflight; copied, forged, mismatched and cross-hub authority rejected');

    const invalidSignal = await prepare('invalid-signal');
    await noDispatch('non-AbortSignal rejected', () => hub.call(invalidSignal.input, {prepared: invalidSignal.prepared, signal: {aborted: false, addEventListener() {}}}), /options|signal/i);
    const preaborted = await prepare('preaborted'), beforeController = new AbortController(); beforeController.abort();
    await noDispatch('caller preabort', () => invoke(preaborted, beforeController.signal));
    const duringConfig = await prepare('abort-during-config'), configController = new AbortController();
    const countBeforeConfig = (await calls()).length;
    const configResult = invoke(duringConfig, configController.signal);
    configController.abort(); // Same stack: preparation is consumed, async config read has not resumed.
    await assert.rejects(configResult, /abort|cancel|stopped/i);
    assert.equal((await calls()).length, countBeforeConfig, 'Immediate caller abort during config read must dispatch zero calls');
    const concurrent = await prepare('concurrent-once', {mode: 'delay'});
    const one = invoke(concurrent);
    const two = invoke(concurrent);
    const concurrentResults = await Promise.allSettled([one, two]);
    assert.equal(concurrentResults.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(concurrentResults.filter(value => value.status === 'rejected').length, 1);
    assert.equal((await calls('concurrent-once')).length, 1);
    groups.push('native AbortSignal validation; preabort and abort during config read dispatch zero; concurrent replay exactly once');

    const connectionCount = (await records()).filter(row => row.kind === 'initialize').length;
    const hanging = await prepare('cancel-only-me', {mode: 'wait'}), controller = new AbortController();
    const cancelled = assert.rejects(invoke(hanging, controller.signal), /unknown|unconfirmed|may.*happened/i);
    const sibling = await prepare('sibling-succeeds', {mode: 'delay'}), siblingResult = invoke(sibling);
    await until(async () => (await calls('cancel-only-me')).length === 1 && (await calls('sibling-succeeds')).length === 1, 'both calls dispatched');
    const cancelledRequest = (await calls('cancel-only-me'))[0]; controller.abort();
    await cancelled;
    const siblingValue = await siblingResult;
    assert.equal(siblingValue.structuredContent.label, 'sibling-succeeds');
    assert.equal(siblingValue.structuredContent.pid, cancelledRequest.pid, 'Sibling must share the provider process');
    await until(async () => (await records()).some(row => row.kind === 'cancel' && row.pid === cancelledRequest.pid && row.id === cancelledRequest.id), 'exact MCP cancellation notification');
    await noDispatch('aborted descriptor cannot replay', () => invoke(hanging));
    const stillUsable = await invoke(await prepare('same-connection-usable'));
    assert.equal(stillUsable.structuredContent.pid, cancelledRequest.pid);
    assert.equal((await records()).filter(row => row.kind === 'initialize').length, connectionCount, 'Task abort must not reconnect or disconnect the provider');
    assert.equal((await hub.describe()).servers.find(row => row.id === 'fixture').connected, true);
    assert.equal((await calls('cancel-only-me')).length, 1);
    groups.push('mid-call abort remains unknown; sibling completes; exact cancellation; same connection reusable without retry');

    const errorValue = await invoke(await prepare('returned-tool-error', {mode: 'tool-error'}));
    assert.equal(errorValue.isError, true); assert.equal(errorValue.content[0].text, 'returned-tool-error');
    assert.equal(errorValue.structuredContent.label, 'returned-tool-error');
    const thrown = await prepare('thrown-tool-error', {mode: 'throw'});
    await assert.rejects(invoke(thrown), /unconfirmed|unknown/i);
    await noDispatch('failed descriptor cannot replay', () => invoke(thrown));
    assert.equal((await calls('returned-tool-error')).length, 1); assert.equal((await calls('thrown-tool-error')).length, 1);
    groups.push('structured returned tool errors preserved; thrown failures uncertain; no retry');

    const expired = await prepare('expired-approval'), realNow = Date.now, afterExpiry = realNow() + 300001;
    try {
      Date.now = () => afterExpiry;
      await noDispatch('five-minute prepared approval expires', () => invoke(expired), /expired|prepared|approval/i);
    } finally {Date.now = realNow;}
    assert.equal((await calls('expired-approval')).length, 0);
    const staleConfig = await prepare('stale-config');
    await save({...entry, env: {...entry.env, MODE: 'changed'}});
    await noDispatch('config edited after review', () => invoke(staleConfig));
    await save();
    await noDispatch('accepted attempt consumed before awaited config rejection', () => invoke(staleConfig));
    const staleConnection = await prepare('stale-connection');
    await hub.disconnect('fixture'); await connect();
    await noDispatch('reconnect with identical config invalidates approval', () => invoke(staleConnection));
    const staleUnchanged = await prepare('stale-unchanged-catalog');
    const unchanged = await hub.call('fixture', 'echo', {label: 'notify-unchanged', mode: 'catalog-unchanged'});
    assert.equal(unchanged.content[0].text, 'notify-unchanged');
    assert.equal((await hub.describe()).servers.find(row => row.id === 'fixture').connected, true);
    await noDispatch('unchanged catalog notification requires fresh review', () => invoke(staleUnchanged));
    assert.equal((await invoke(await prepare('fresh-after-unchanged'))).isError, false);
    const staleChanged = await prepare('stale-changed-catalog');
    const changed = await hub.call('fixture', 'echo', {label: 'notify-change', mode: 'catalog-change'});
    assert.equal(changed.content[0].text, 'notify-change'); assert.match(changed.connectionWarning, /catalog.*changed/i);
    await noDispatch('changed catalog rejects prepared call', () => invoke(staleChanged));
    await hub.disconnect('fixture'); await connect();
    groups.push('no implicit connect; five-minute expiry; pins config, connection and every catalog notification; legacy dispatched results retained');

    const hash = (await hub.describe()).servers.find(row => row.id === 'fixture').configHash;
    assert.equal((await hub.call('fixture', 'echo', {label: 'legacy-three-args'})).content[0].text, 'legacy-three-args');
    assert.equal((await hub.call('fixture', 'echo', {label: 'legacy-four-args'}, hash)).content[0].text, 'legacy-four-args');
    await connect(hub, 'secondary');
    const globalA = await prepare('global-stop-a', {mode: 'wait'}), globalB = await prepare('global-stop-b', {mode: 'wait'}, 'secondary');
    const pendingA = assert.rejects(invoke(globalA), /unknown|unconfirmed|cancel/i), pendingB = assert.rejects(invoke(globalB), /unknown|unconfirmed|cancel/i);
    await until(async () => (await calls('global-stop-a')).length === 1 && (await calls('global-stop-b')).length === 1, 'global Stop calls dispatched');
    assert.deepEqual(await hub.stop(), {stopped: true}); await Promise.all([pendingA, pendingB]);
    assert.equal(hub.tools().total, 0);
    assert((await hub.describe()).servers.every(row => row.connected === false));
    await connect();
    assert.equal((await invoke(await prepare('after-global-stop'))).content[0].text, 'after-global-stop');
    groups.push('legacy signatures preserved; explicit global Stop still cancels all providers; fresh reconnect works');
    console.log(JSON.stringify({passed: true, groups, realServicesUsed: false, liveConfigTouched: false}, null, 2));
  } finally {
    const cleanup = await Promise.allSettled([hub.close(), other.close()]);
    await rm(root, {recursive: true, force: true});
    const failure = cleanup.find(value => value.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
