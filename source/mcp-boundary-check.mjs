// Synthetic providers only. Full suite: node --max-old-space-size=128 tools/qwen-chat/mcp-boundary-check.mjs
// Individual constrained checks: node --max-old-space-size=64 tools/qwen-chat/mcp-boundary-check.mjs wire (or teardown)
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const LIMIT = 8 * 1024 * 1024;
const fixtureTool = { name: 'echo', description: 'Harmless synthetic echo.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } };
const resultFor = request => request.method === 'initialize'
  ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'boundary-fixture', version: '1' } }
  : request.method === 'tools/list' ? { tools: [fixtureTool] }
  : { content: [{ type: 'text', text: request.params.arguments.text }] };

async function oversized(write, id, ending, lineEnding = '\n') {
  // Stream a valid oversize result, or an unfinished record, without prebuilding the payload.
  await write(`{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"`);
  for (let bytes = 0; bytes <= LIMIT + 256 * 1024; bytes += 16384) {
    if (!await write('x'.repeat(16384))) return;
    if (bytes >= LIMIT - 65536) await delay(2);
  }
  if (ending) await write(`"}]}}${lineEnding}`);
}

if (process.argv[2] === '--persistent-descendant') {
  setInterval(() => {}, 1000);
} else if (process.argv[2] === '--teardown-worker') {
  const { MCPHub } = await import('./mcp.mjs');
  const [mode, dir] = process.argv.slice(3), configPath = path.join(dir, 'mcp.json');
  const hub = new MCPHub(configPath);
  const entry = { command: process.execPath, args: [fileURLToPath(import.meta.url), '--stdio', `descendant-${mode}`, path.join(dir, 'pids.json')] };
  await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: entry } }));
  try {
    if (mode === 'close') {
      const { BoundedStdioTransport } = await import('./mcp-transport.mjs');
      const transport = new BoundedStdioTransport({ ...entry, cwd: dir, env: {} }, error => { throw error; });
      let closes = 0;
      transport.onclose = () => closes++;
      await transport.start();
      for (let attempt = 0; ; attempt++) {
        try { await readFile(path.join(dir, 'pids.json')); break; }
        catch (error) { if (error.code !== 'ENOENT' || attempt === 100) throw error; await delay(10); }
      }
      await Promise.all([transport.close(), transport.close()]);
      await delay(30); // Allow the later ChildProcess close event to arrive too.
      assert.equal(closes, 1, 'SDK lifecycle notification must be delivered exactly once');
      await assert.rejects(transport.send({ jsonrpc: '2.0', method: 'no-later-dispatch' }), /disconnected/i);
    } else {
      await hub.connect('fixture', (await hub.describe()).servers[0].configHash);
      if (mode === 'stop') await hub.stop();
      else if (mode === 'oversize') await assert.rejects(hub.call('fixture', 'echo', { text: 'oversize' }), /8 MiB.*completion is unknown/i);
      else await hub.disconnect('fixture');
      assert.equal(hub.tools().total, 0);
      assert.equal((await hub.describe()).servers[0].connected, false);
    }
  } finally { await hub.close(); }
} else if (process.argv[2] === '--stdio') {
  const mode = process.argv[3];
  if (mode.startsWith('descendant-')) {
    const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), '--persistent-descendant'], { stdio: ['ignore', 'inherit', 'ignore'] });
    await writeFile(process.argv[4], JSON.stringify([process.pid, descendant.pid]));
    descendant.unref();
  }
  let refreshing = false;
  const write = data => new Promise(resolve => process.stdout.write(data, error => resolve(!error)));
  process.stdout.on('error', () => process.exit(0));
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    if (mode === 'refresh' && request.method === 'tools/call') {
      refreshing = true;
      await write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n');
      await write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: resultFor(request) }) + '\n');
    }
    else if ((request.method === 'tools/call' && mode !== 'catalog') || (request.method === 'tools/list' && (mode === 'catalog' || refreshing))) await oversized(write, request.id, mode !== 'incomplete');
    else await write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: resultFor(request) }) + '\n');
  }
  if (mode.startsWith('descendant-')) process.exit(0);
} else {
  const { MCPHub } = await import('./mcp.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'qwen-mcp-boundary-'));
  const configPath = path.join(dir, 'mcp.json'), hub = new MCPHub(configPath);
  const connect = async (entry, id = 'fixture') => {
    await writeFile(configPath, JSON.stringify({ mcpServers: { [id]: entry } }));
    return hub.connect(id, (await hub.describe()).servers[0].configHash);
  };
  const echo = { command: process.execPath, args: ['--preserve-symlinks', fileURLToPath(new URL('./mcp-check.mjs', import.meta.url)), '--fixture'] };
  try {
    if (process.argv[2] === undefined || process.argv[2] === 'teardown') {
      for (const mode of ['disconnect', 'stop', 'oversize', 'close']) {
        const fixtureDir = await mkdtemp(path.join(dir, 'descendant-'));
        try {
          await promisify(execFile)(process.execPath, ['--preserve-symlinks', fileURLToPath(import.meta.url), '--teardown-worker', mode, fixtureDir], { timeout: 5000, killSignal: 'SIGKILL' });
        } finally {
          const pids = JSON.parse(await readFile(path.join(fixtureDir, 'pids.json'), 'utf8'));
          // The provider's descendant is outside transport ownership. This test
          // owns it, so explicitly stop it even when the worker times out.
          for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
          for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) await delay(10);
          assert(!pids.some(alive), 'No synthetic provider/descendant may survive test cleanup');
        }
        console.log(`PASS teardown: ${mode} completes despite persistent inherited stdout; fixture processes cleaned`);
      }
    }
    if (process.argv[2] === undefined || process.argv[2] === 'redaction') {
      for (const [key, value] of [['MODE', 'echo'], ['MODE', 'string'], ['NODE_ENV', 'echo'], ['LOG_LEVEL', 'string']]) {
        await connect({ ...echo, env: { [key]: value } });
        const tool = hub.tools().tools[0];
        assert.equal(tool.name, 'echo', 'Nonsecret settings must preserve the callable tool identity');
        assert.equal(tool.inputSchema.properties.text.type, 'string', 'Nonsecret settings must preserve executable schemas');
        assert.equal((await hub.call(tool.server, tool.name, { text: 'safe fixture' })).content[0].text, 'safe fixture');
        await hub.disconnect('fixture');
      }
      for (const [key, secret] of [['FIXTURE_SECRET', 'echo'], ['FIXTURE_SECRET', 'string'], ['FIXTURE_SECRET', 'text'], ['CUSTOM_CREDENTIAL_VALUE', 'echo'], ['UNRECOGNIZED_VALUE', 'echo']]) {
        const connected = await connect({ ...echo, env: { [key]: secret } });
        assert.equal(hub.tools().total, 0, 'Tools with actual credential collisions must be omitted, never renamed');
        assert.equal(connected.omittedTools, 31);
        assert.match(connected.catalogWarning, /credential.*metadata/i);
        await assert.rejects(hub.call('fixture', 'echo', { text: 'blocked' }), /unknown/i);
        await hub.disconnect('fixture');
      }
      await writeFile(configPath, JSON.stringify({ mcpServers: { fixture: { ...echo, env: { FIXTURE_SECRET: 'fixture' } } } }));
      await assert.rejects(hub.describe(), /server ID.*credential/i, 'A secret collision must not silently rename a server ID');
      console.log('PASS metadata: ordinary settings remain callable; credential collisions omit tools or reject a server ID.');
    }
    if (process.argv[2] === undefined || process.argv[2] === 'wire') {
      const parse = JSON.parse;
      let oversizedParses = 0;
      JSON.parse = function (text, ...args) { if (typeof text === 'string' && Buffer.byteLength(text) > LIMIT) oversizedParses++; return parse(text, ...args); };
      try {
        const checkCall = async (label, entry) => {
          await connect(entry);
          const pending = hub.call('fixture', 'echo', { text: 'oversize probe' });
          const settled = pending.then(value => ({ value }), error => ({ error }));
          const outcome = await Promise.race([settled, delay(3000, undefined, { ref: false }).then(() => ({ timeout: true }))]);
          assert(!outcome.timeout, `${label}: incomplete/oversized bytes must stop promptly, before the normal call timeout`);
          assert(outcome.error, `${label}: an oversized result must reject`);
          assert.match(outcome.error.message, /8 MiB.*completion is unknown/i);
          assert.equal(oversizedParses, 0, `${label}: oversized JSON must never reach JSON.parse`);
          assert.equal(hub.tools().total, 0, `${label}: oversize closes the approved connection`);
          assert.equal((await hub.describe()).servers[0].connected, false);
          assert.match((await hub.describe()).servers[0].statusReason, /8 MiB/i);
          await assert.rejects(hub.call('fixture', 'echo', { text: 'no retry' }), /8 MiB|connect/i);
          console.log(`PASS wire: ${label}`);
        };
        for (const mode of ['complete', 'incomplete']) await checkCall(`stdio ${mode}`, { command: process.execPath, args: [fileURLToPath(import.meta.url), '--stdio', mode] });
        await assert.rejects(connect({ command: process.execPath, args: [fileURLToPath(import.meta.url), '--stdio', 'catalog'] }), /8 MiB/i);
        assert.equal(oversizedParses, 0, 'Oversized catalog must never reach JSON.parse');
        console.log('PASS wire: stdio catalog');
        await connect({ command: process.execPath, args: [fileURLToPath(import.meta.url), '--stdio', 'refresh'] });
        const completed = await hub.call('fixture', 'echo', { text: 'completed before catalog refresh' });
        assert.equal(completed.content[0].text, 'completed before catalog refresh');
        assert.match(completed.connectionWarning, /8 MiB/i, 'Preserve the known call result and the oversized catalog failure reason');
        assert.equal(hub.tools().total, 0);
        assert.match((await hub.describe()).servers[0].statusReason, /8 MiB/i);
        assert.equal(oversizedParses, 0);
        console.log('PASS wire: oversized catalog refresh preserves prior call evidence and limit reason');
        for (const mode of ['json', 'sse-lf', 'sse-crlf', 'sse-cr', 'sse-incomplete', 'error-body', 'sse-many']) {
          const server = http.createServer(async (req, res) => {
            if (req.method !== 'POST') { res.writeHead(405).end(); return; }
            const body = []; for await (const chunk of req) body.push(chunk);
            const request = parse(Buffer.concat(body));
            if (request.id === undefined) { res.writeHead(202).end(); return; }
            if (request.method !== 'tools/call') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: resultFor(request) })); return; }
            const sse = mode.startsWith('sse'), eol = mode === 'sse-crlf' ? '\r\n' : mode === 'sse-cr' ? '\r' : '\n';
            res.writeHead(mode === 'error-body' ? 500 : 200, { 'content-type': sse ? 'text/event-stream' : 'application/json' });
            const write = async data => {
              if (res.destroyed) return false;
              return new Promise(resolve => res.write(data, error => resolve(!error && !res.destroyed)));
            };
            if (mode === 'sse-many') {
              // A long-lived SSE connection may exceed the total byte limit when
              // each individual event is bounded. Split every CRLF across chunks.
              for (let event = 0; event < 17; event++) {
                await write(`event: keepalive\r`); await write(`\ndata: ${'x'.repeat(512 * 1024)}\r`); await write('\n\r'); await write('\n');
              }
              await write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: resultFor(request) })}\r\n\r\n`);
              res.end(); return;
            }
            if (sse) await write(`event: message${eol}data: `);
            await oversized(write, request.id, mode !== 'sse-incomplete', sse ? eol + eol : '');
            if (mode !== 'sse-incomplete') res.end();
          });
          server.listen(0, '127.0.0.1'); await once(server, 'listening');
          try {
            const entry = { url: `http://127.0.0.1:${server.address().port}/mcp` };
            if (mode === 'sse-many') {
              await connect(entry);
              assert.equal((await hub.call('fixture', 'echo', { text: 'bounded individual events' })).content[0].text, 'bounded individual events');
              assert.equal(oversizedParses, 0);
              console.log('PASS wire: HTTP SSE multiple bounded events, total > 8 MiB, split CRLF');
            } else await checkCall(`HTTP ${mode}`, entry);
          }
          finally { await hub.disconnect('fixture'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        }
      } finally { JSON.parse = parse; }
    }
  } finally { await hub.close(); await rm(dir, { recursive: true, force: true }); }
}
