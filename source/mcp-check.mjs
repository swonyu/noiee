// Run: node tools/qwen-chat/mcp-check.mjs. Add --bundled for installed servers' initialize/list only.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';

// A real synthetic PNG large enough to exceed the text-result cap, without image dependencies.
function fixturePNG() {
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(160, 0); header.writeUInt32BE(160, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(160 * 481); let seed = 123456;
  for (let index = 0; index < pixels.length; index++) if (index % 481) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[index] = seed & 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const PNG_IMAGE = fixturePNG();
// Validation deliberately checks encoding and format signatures, not complete pixel decoding.
const JPEG_SIGNATURE_SAMPLE = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex').toString('base64');

async function makeFixture(mode) {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const fixture = new Server({ name: 'qwen-harmless-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  let calls = 0, changed = '', slowRefresh = false;
  const searchCatalog = mode === 'search-browser' ? [
    { name: 'browser_navigate', description: 'Navigate to a web page URL in the browser.' },
    { name: 'browser_snapshot', description: 'Capture the current browser page.' },
  ] : mode === 'search-files' ? [
    { name: 'read_text_file', description: 'Read a UTF-8 text file from an allowed folder.' },
    { name: 'write_file', description: 'Write content to a file.' },
  ] : null;
  fixture.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
    if (slowRefresh) await delay(40);
    const count = (searchCatalog?.length ?? (mode === 'many' ? 205 : 31)) + (changed === 'add-tool' ? 1 : changed === 'remove-tool' ? -1 : 0);
    const start = Number(params?.cursor || 0), end = Math.min(start + 7, count);
    return {
      tools: Array.from({ length: end - start }, (_, offset) => ({
        name: searchCatalog?.[start + offset]?.name ?? (start + offset === 0 ? 'echo' : `echo_${start + offset}`),
        description: searchCatalog?.[start + offset]?.description ?? 'Harmless synthetic echo fixture.',
        inputSchema: mode === 'unsupported' ? { type: 'object', properties: { text: { $ref: 'https://example.invalid/schema' } } } : {
          ...(mode === 'implicit2020' ? { unevaluatedProperties: false } : { $schema: mode === 'dialect2020' ? 'https://json-schema.org/draft/2020-12/schema' : 'http://json-schema.org/draft-07/schema#', additionalProperties: false }),
          type: 'object', properties: { text: { type: 'string' }, mode: { type: 'string' } }, required: ['text'],
        },
        outputSchema: { ...(mode === 'dialect2020' ? { $schema: 'https://json-schema.org/draft/2020-12/schema' } : {}), type: 'object', properties: { calls: { type: changed === 'invalidate' && start + offset === 0 ? 'string' : 'integer' } }, required: ['calls'] },
      })),
      ...(end < count ? { nextCursor: String(end) } : {}),
    };
  });
  fixture.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    calls++;
    if (params.arguments?.mode === 'throw') throw new Error(`Fixture error: ${process.env.FIXTURE_SECRET}`);
    if (params.arguments?.mode === 'wait') return new Promise(() => {});
    if (['unchanged', 'unchanged-slow', 'invalidate', 'add-tool', 'remove-tool'].includes(params.arguments?.mode)) {
      changed = params.arguments.mode;
      slowRefresh = changed === 'unchanged-slow';
      await fixture.sendToolListChanged();
      await delay(slowRefresh ? 100 : 30);
    }
    if (params.arguments?.mode?.startsWith('image-')) {
      const png = { type: 'image', mimeType: 'image/png', data: PNG_IMAGE };
      const content = params.arguments.mode === 'image-jpeg' ? [{ type: 'image', mimeType: 'image/jpeg', data: JPEG_SIGNATURE_SAMPLE }] : params.arguments.mode === 'image-invalid-base64' ? [{ type: 'image', mimeType: 'image/png', data: '%%%invalid%%%' }] : params.arguments.mode === 'image-invalid' ? [
        { type: 'image', mimeType: 'image/gif', data: PNG_IMAGE },
        { type: 'image', mimeType: 'image/png', data: 'aW52YWxpZA==' },
        { type: 'image', mimeType: 'image/jpeg', data: PNG_IMAGE },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(3500000) },
      ] : [png, ...(params.arguments.mode === 'image-multiple' ? [png] : [])];
      if (params.arguments.mode !== 'image-structured') content.unshift({ type: 'text', text: `Screenshot result ${process.env.FIXTURE_SECRET}` });
      else content.push({ type: 'resource', resource: { uri: 'fixture://binary', mimeType: 'application/octet-stream', blob: PNG_IMAGE } }, { type: 'audio', mimeType: 'audio/wav', data: PNG_IMAGE });
      return { content, structuredContent: { calls, ...(params.arguments.mode === 'image-structured' ? { screenshot: PNG_IMAGE.repeat(2) } : {}) }, isError: false };
    }
    return {
      content: [{ type: 'text', text: params.arguments?.mode === 'large' ? 'x'.repeat(100000) : params.arguments?.text || '' }],
      structuredContent: { calls: params.arguments?.mode === 'bad-output' ? 'not an integer' : calls, ...(params.arguments?.mode === 'cwd' ? { cwd: process.cwd() } : {}), ...(params.arguments?.mode === 'env' ? { instanceTokenInherited: 'QWEN_LOCAL_INSTANCE_TOKEN' in process.env, arbitraryEnvInherited: 'QWEN_MCP_PRIVATE_SENTINEL' in process.env } : {}) },
      isError: params.arguments?.mode === 'error',
    };
  });
  return fixture;
}

if (process.argv[2] === '--fixture') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const fixture = await makeFixture(process.argv[3]);
  await fixture.connect(new StdioServerTransport());
} else {
  const { MCPHub, relocateBundledPreset } = await import('./mcp.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'qwen-mcp-check-'));
  const configPath = path.join(dir, 'mcp.json');
  const hub = new MCPHub(configPath);
  const secret = 'synthetic-private-fixture-value';
  const nodeFlags=process.execArgv.filter(arg=>arg==='--preserve-symlinks');if(nodeFlags.length)nodeFlags.push('--preserve-symlinks-main');
  const entry = { command: process.execPath, args: [...nodeFlags,fileURLToPath(import.meta.url), '--fixture'], env: { FIXTURE_SECRET: secret } };
  const save = value => writeFile(configPath, JSON.stringify(value));
  const originalInstanceToken = process.env.QWEN_LOCAL_INSTANCE_TOKEN;
  const originalSentinel = process.env.QWEN_MCP_PRIVATE_SENTINEL;
  process.env.QWEN_LOCAL_INSTANCE_TOKEN = 'synthetic-native-bridge-sentinel';
  process.env.QWEN_MCP_PRIVATE_SENTINEL = 'synthetic-arbitrary-env-sentinel';
  try {
    const fifo=path.join(dir,'config-fifo');assert.equal(spawnSync('/usr/bin/mkfifo',[fifo]).status,0);
    const piped=new MCPHub(fifo);let refused=false;
    const inspection=piped.describe().then(()=>assert.fail('FIFO config must be refused'),error=>{assert.match(error.message,/regular file/i);refused=true;});
    await delay(150);const prompt=refused;
    // Unblock only this private fixture on the old implementation, so red cannot hang.
    if(!prompt){const writer=await open(fifo,constants.O_WRONLY|constants.O_NONBLOCK);await writer.close();}
    await inspection;await piped.close();assert(prompt,'A FIFO config must refuse without waiting for a writer');
    const oldBase=path.join((await import('node:os')).homedir(),'Applications','Qwen Local.app','Contents','Resources');
    const resources='/tmp/Saleh Uncensored.app/Contents/Resources';
    const browserPreset={command:'/opt/homebrew/bin/node',args:[oldBase+'/node_modules/@playwright/mcp/cli.js','--isolated','--browser','chrome']};
    assert.equal(typeof relocateBundledPreset,'function','Bundled presets must survive the app rename');
    assert.equal(relocateBundledPreset(browserPreset,resources).args[0],resources+'/node_modules/@playwright/mcp/cli.js');
    assert.equal(browserPreset.args[0],oldBase+'/node_modules/@playwright/mcp/cli.js','Do not mutate persisted config');
    assert.equal(relocateBundledPreset({...browserPreset,args:[browserPreset.args[0].replace('Qwen Local.app','Saleh Uncensored.app'),...browserPreset.args.slice(1)],env:{}},resources).args[0],resources+'/node_modules/@playwright/mcp/cli.js');
    const filesPreset={command:'/opt/homebrew/bin/node',args:[oldBase+'/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',dir]};
    assert.deepEqual(relocateBundledPreset(filesPreset,resources).args,[resources+'/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',dir]);
    for(const custom of [{...browserPreset,env:{NODE_OPTIONS:'--inspect'}},{...browserPreset,args:[...browserPreset.args,'--extension']},{...browserPreset,args:['/tmp/custom-cli.js',...browserPreset.args.slice(1)]},{...browserPreset,command:'/tmp/custom-node'},{...filesPreset,args:[filesPreset.args[0],'relative']}])assert.equal(relocateBundledPreset(custom,resources),custom);
    assert.equal(relocateBundledPreset(browserPreset,'/tmp/dev-workspace'),browserPreset);
    assert.deepEqual((await hub.describe()).servers, []);
    await save({ mcpServers: { fixture: entry, remote: { url: 'https://example.invalid/mcp?key=url-private-value', headers: { Authorization: 'Bearer header-private-value' } } } });
    const described = await hub.describe();
    const row = described.servers.find(s => s.id === 'fixture');
    assert.equal(row.cwd, dir, 'Default stdio cwd must be the config directory, never the app resources directory');
    assert.deepEqual(row.envKeys, ['FIXTURE_SECRET']);
    assert(!JSON.stringify(described).includes(secret));
    assert(!JSON.stringify(described).includes('url-private-value'));
    assert(!JSON.stringify(described).includes('header-private-value'));
    assert.equal(row.connected, false);
    assert.deepEqual(hub.tools().tools, []);
    await assert.rejects(hub.connect('fixture', 'wrong-hash'), /changed|approval/i);
    await save({ mcpServers: { fixture: { ...entry, env: { FIXTURE_SECRET: 'changed-private-value' } } } });
    await assert.rejects(hub.connect('fixture', row.configHash), /changed|approval/i);
    await save({ mcpServers: { fixture: entry } });
    const { configHash } = (await hub.describe()).servers[0];
    const connection = await hub.connect('fixture', configHash);
    assert.equal(connection.connected, true);
    assert.equal(connection.toolCount, 31);
    assert.equal(hub.tools().tools.length, 20);
    assert.equal(hub.tools().total, 31);
    const firstPage = hub.tools('', 0);
    assert.equal(firstPage.nextOffset, 20);
    assert.equal(firstPage.truncated, true);
    const secondPage = hub.tools('', firstPage.nextOffset);
    assert.equal(secondPage.tools.length, 11);
    assert.equal(secondPage.total, 31);
    assert.equal(secondPage.nextOffset, null);
    assert.equal(secondPage.truncated, false);
    const allNames = [...firstPage.tools, ...secondPage.tools].map(tool => tool.name);
    assert.deepEqual(allNames, Array.from({ length: 31 }, (_, index) => index ? `echo_${index}` : 'echo'), 'Every admitted tool must be reachable exactly once in stable catalog order');
    assert.equal(new Set(allNames).size, 31);
    assert.deepEqual(hub.tools('', 20), secondPage, 'Repeated pages must preserve stable ordering');
    assert.deepEqual(hub.tools('echo', 20).tools, secondPage.tools, 'Pagination must apply after search ranking');
    for (const offset of [31, 12800]) {
      const beyondEnd = hub.tools('', offset);
      assert.deepEqual(beyondEnd.tools, []);
      assert.equal(beyondEnd.total, 31);
      assert.equal(beyondEnd.nextOffset, null);
      assert.equal(beyondEnd.truncated, false);
    }
    for (const offset of [-1, 0.5, NaN, Infinity, '0', null, 12801, Number.MAX_SAFE_INTEGER]) assert.throws(() => hub.tools('', offset), /offset/i);
    assert.equal(hub.tools('echo_30').tools[0].name, 'echo_30');
    assert.equal(hub.tools('nonexistent').total, 0);
    const firstCall = await hub.call('fixture', 'echo', { text: 'hello fixture', mode: 'cwd' });
    assert.equal(firstCall.content[0].text, 'hello fixture');
    assert.equal(firstCall.structuredContent.cwd, await realpath(dir), 'The spawned process must actually run in the config directory');
    const unchangedCall = await hub.call('fixture', 'echo', { text: 'unchanged notification completes', mode: 'unchanged' });
    assert.equal(unchangedCall.content[0].text, 'unchanged notification completes');
    assert.equal(unchangedCall.structuredContent.calls, firstCall.structuredContent.calls + 1, 'An unchanged notification must neither cancel nor repeat a sent call');
    const approvedCall = await hub.call('fixture', 'echo', { text: 'approved hash' }, configHash);
    assert.equal(approvedCall.content[0].text, 'approved hash');
    await assert.rejects(hub.call('fixture', 'echo', { text: 'wrong hash' }, 'wrong-hash'), /approval|configuration|hash/i);
    await save({ mcpServers: { fixture: { ...entry, env: { FIXTURE_SECRET: 'edited-private-value' } } } });
    const editedHash = (await hub.describe()).servers[0].configHash;
    await assert.rejects(hub.call('fixture', 'echo', { text: 'stale config' }, configHash), /approval|configuration|hash/i);
    await assert.rejects(hub.call('fixture', 'echo', { text: 'stale connection' }, editedHash), /approval|configuration|hash/i);
    await save({mcpServers:{}});
    const orphan=(await hub.describe()).servers.find(s=>s.id==='fixture');
    assert(orphan?.connected && orphan.configRemoved, 'A live connection removed from config must remain visible for disconnect');
    assert(!orphan.configHash, 'Removed config must not provide a reconnect approval hash');
    const manualCall = await hub.call('fixture', 'echo', { text: 'manual approval remains separate' });
    assert.equal(manualCall.structuredContent.calls, approvedCall.structuredContent.calls + 1, 'Wrong/stale config hashes must dispatch zero calls; absent hash preserves manual calls');
    await save({ mcpServers: { fixture: entry } });
    for (const args of [{}, { text: 42 }, { text: 'hello', extra: true }]) await assert.rejects(hub.call('fixture', 'echo', args), /schema|arguments/i);
    const afterInvalid = await hub.call('fixture', 'echo', { text: 'still valid' });
    assert.equal(afterInvalid.structuredContent.calls, manualCall.structuredContent.calls + 1, 'Invalid arguments must never reach tools/call');
    await assert.rejects(hub.call('fixture', 'echo', { text: '', mode: 'bad-output' }), /output schema/i);
    const envResult = await hub.call('fixture', 'echo', { text: '', mode: 'env' });
    assert.equal(envResult.structuredContent.instanceTokenInherited, false);
    assert.equal(envResult.structuredContent.arbitraryEnvInherited, false);
    assert.equal((await hub.call('fixture', 'echo', { text: '', mode: 'error' })).isError, true);
    assert(!JSON.stringify(await hub.call('fixture', 'echo', { text: secret })).includes(secret));
    await assert.rejects(hub.call('fixture', 'echo', { text: '', mode: 'throw' }), error => /Fixture error/.test(error.message) && !error.message.includes(secret));
    await assert.rejects(hub.call('fixture', 'unknown', {}), /unknown|not available/i);
    await assert.rejects(hub.call('fixture', 'echo', []), /object/i);
    await assert.rejects(hub.call('fixture', 'echo', { text: 'x'.repeat(65537) }), /64|large/i);
    const large = await hub.call('fixture', 'echo', { text: '', mode: 'large' });
    assert.equal(large.truncated, true);
    assert(Buffer.byteLength(JSON.stringify(large)) <= 65536);
    const screenshot = await hub.call('fixture', 'echo', { text: '', mode: 'image-png' });
    assert(screenshot.image === `data:image/png;base64,${PNG_IMAGE}`, 'A screenshot larger than the text cap must reach the native frontend as an image');
    const { image: screenshotImage, ...screenshotText } = screenshot;
    assert.equal(screenshotText.images.returned, 1);
    assert.equal(screenshotText.images.omitted, 0);
    assert.equal(screenshotText.truncated, false);
    assert(screenshotImage.length <= 3500000);
    assert(Buffer.byteLength(JSON.stringify(screenshotText)) <= 65536);
    assert(!JSON.stringify(screenshotText).includes(PNG_IMAGE.slice(0, 80)));
    assert(!JSON.stringify(screenshotText).includes(secret));
    assert.equal((await hub.call('fixture', 'echo', { text: '', mode: 'image-jpeg' })).image, `data:image/jpeg;base64,${JPEG_SIGNATURE_SAMPLE}`);
    await assert.rejects(hub.call('fixture', 'echo', { text: '', mode: 'image-invalid-base64' }), /Invalid Base64/i, 'Malformed base64 must be rejected by the SDK before any image can be forwarded');
    const invalidImages = await hub.call('fixture', 'echo', { text: '', mode: 'image-invalid' });
    assert.equal(invalidImages.image, undefined);
    assert.deepEqual(invalidImages.images, { returned: 0, omitted: 4, reasons: { unsupportedMime: 1, invalidData: 2, tooLarge: 1 } });
    assert(!JSON.stringify(invalidImages).includes(PNG_IMAGE.slice(0, 80)));
    assert(!JSON.stringify(invalidImages).includes('%%%invalid%%%'));
    const multipleImages = await hub.call('fixture', 'echo', { text: '', mode: 'image-multiple' });
    assert(multipleImages.image === `data:image/png;base64,${PNG_IMAGE}`);
    assert.deepEqual(multipleImages.images, { returned: 1, omitted: 1, reasons: { additionalImage: 1 } });
    const structuredImage = await hub.call('fixture', 'echo', { text: '', mode: 'image-structured' });
    assert(structuredImage.image === `data:image/png;base64,${PNG_IMAGE}`);
    assert.equal(structuredImage.truncated, true);
    assert.equal(structuredImage.omittedBinaryContent, 2);
    const { image: _structuredImage, ...structuredText } = structuredImage;
    assert(Buffer.byteLength(JSON.stringify(structuredText)) <= 65536);
    assert(!JSON.stringify(structuredText).includes(PNG_IMAGE.slice(0, 80)), 'Oversized structured content must not leak binary data into the text fallback');
    const cancelled = assert.rejects(hub.call('fixture', 'echo', { text: '', mode: 'wait' }), /completion is unknown/i);
    await hub.disconnect('fixture');
    await cancelled;
    assert.equal(hub.tools().total, 0);
    await assert.rejects(hub.call('fixture', 'echo', {}), /connect/i);
    const stoppedBeforeStart = assert.rejects(hub.connect('fixture', configHash), /stopped/i);
    await hub.stop();
    await stoppedBeforeStart;
    await hub.connect('fixture', configHash);
    const stoppedAutoCall = assert.rejects(hub.call('fixture', 'echo', { text: 'stop before automatic dispatch' }, configHash), /approval|connect|stopped/i);
    await hub.stop();
    await stoppedAutoCall;
    assert.equal(hub.tools().total, 0);
    await hub.connect('fixture', configHash);
    const disconnectedAutoCall = assert.rejects(hub.call('fixture', 'echo', { text: 'disconnect before automatic dispatch' }, configHash), /approval|connect/i);
    await hub.disconnect('fixture');
    await disconnectedAutoCall;
    await hub.connect('fixture', configHash);
    assert.equal((await hub.call('fixture', 'echo', { text: 'after stop' })).content[0].text, 'after stop');
    const changedCall = await hub.call('fixture', 'echo', { text: 'changed notification still returns sent-call evidence', mode: 'invalidate' });
    assert.equal(changedCall.content[0].text, 'changed notification still returns sent-call evidence');
    assert.match(changedCall.connectionWarning, /catalog.*changed/i);
    assert.equal(hub.tools().total, 0, 'Catalog changes invalidate the approved connection');
    await assert.rejects(hub.call('fixture', 'echo', { text: 'stale' }), /connect|catalog.*changed/i);
    assert.match((await hub.describe()).servers[0].statusReason, /catalog.*changed/i);
    for (const change of ['add-tool', 'remove-tool']) {
      await hub.connect('fixture', configHash);
      const changedTools = await hub.call('fixture', 'echo', { text: change, mode: change });
      assert.match(changedTools.connectionWarning, /catalog.*changed/i);
      assert.equal(hub.tools().total, 0, 'New or removed tools require a new approved connection');
    }
    await hub.connect('fixture', configHash);
    const stoppedRefreshCall = assert.rejects(hub.call('fixture', 'echo', { text: 'stop during refresh', mode: 'unchanged-slow' }), /cancel|completion is unknown/i);
    let refreshing = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      refreshing = (await hub.describe()).servers[0].catalogRefreshing;
      if (refreshing) break;
      await delay(2);
    }
    assert(refreshing, 'Fixture must enter catalog verification before Stop');
    await hub.stop();
    await stoppedRefreshCall;
    await delay(80);
    assert.equal(hub.tools().total, 0, 'Finishing a stale catalog refresh must not restore a stopped connection');
    await assert.rejects(hub.call('fixture', 'echo', { text: 'no later dispatch' }), /connect/i);
    await save({ mcpServers: { fixture: { ...entry, args: [...entry.args, 'unsupported'] } } });
    await assert.rejects(hub.connect('fixture', (await hub.describe()).servers[0].configHash), /schema|ref/i);
    assert.equal(hub.tools().total, 0);
    await save({ mcpServers: { fixture: { ...entry, args: [...entry.args, 'dialect2020'] } } });
    await hub.connect('fixture', (await hub.describe()).servers[0].configHash);
    assert.equal((await hub.call('fixture', 'echo', { text: '2020-12' })).content[0].text, '2020-12');
    await assert.rejects(hub.call('fixture', 'echo', { text: 42 }), /schema|arguments/i);
    await assert.rejects(hub.call('fixture', 'echo', { text: '', mode: 'bad-output' }), /output schema/i);
    await hub.disconnect('fixture');
    await save({ mcpServers: { fixture: { ...entry, args: [...entry.args, 'implicit2020'] } } });
    await hub.connect('fixture', (await hub.describe()).servers[0].configHash);
    assert.equal((await hub.call('fixture', 'echo', { text: 'implicit 2020-12' })).content[0].text, 'implicit 2020-12');
    await assert.rejects(hub.call('fixture', 'echo', { text: 'blocked', extra: true }), /schema|arguments/i);
    await hub.disconnect('fixture');
    const explicitCwd = await mkdtemp(path.join(dir, 'explicit-cwd-'));
    await save({ mcpServers: { fixture: { ...entry, cwd: explicitCwd } } });
    const explicitServer = (await hub.describe()).servers[0];
    assert.equal(explicitServer.cwd, explicitCwd);
    await hub.connect('fixture', explicitServer.configHash);
    assert.equal((await hub.call('fixture', 'echo', { text: '', mode: 'cwd' })).structuredContent.cwd, await realpath(explicitCwd), 'Explicit configured cwd must be preserved');
    await hub.disconnect('fixture');
    await save({ mcpServers: { fixture: { ...entry, args: [...entry.args, 'many'] } } });
    const many = await hub.connect('fixture', (await hub.describe()).servers[0].configHash);
    assert.equal(many.toolCount, 200);
    assert.equal(many.truncated, true);
    const limitedLastPage = hub.tools('', 180);
    assert.equal(limitedLastPage.tools.length, 20);
    assert.equal(limitedLastPage.nextOffset, null);
    assert.equal(limitedLastPage.truncated, true, 'The last admitted page must still report a server catalog truncated at its admission limit');
    await hub.disconnect('fixture');
    await save({ mcpServers: {
      browser: { ...entry, args: [...entry.args, 'search-browser'] },
      files: { ...entry, args: [...entry.args, 'search-files'] },
    } });
    for (const server of (await hub.describe()).servers) await hub.connect(server.id, server.configHash);
    assert.equal(hub.tools('Find browser tools that can navigate to a page').tools[0]?.name, 'browser_navigate');
    assert.equal(hub.tools('Find tools to read text files in a folder').tools[0]?.name, 'read_text_file');
    assert.equal(hub.tools('browser_navigate').tools[0]?.name, 'browser_navigate');
    assert.deepEqual(hub.tools('file').tools.map(t => t.name), ['read_text_file', 'write_file'], 'Tied search results retain their catalog order');
    const noMatch = hub.tools('zzzz_nonexistent_capability');
    assert.equal(noMatch.total, 0); assert.deepEqual(noMatch.tools, []);
    assert.deepEqual(noMatch.servers.map(s => [s.id, s.connected, s.toolCount]), [['browser', true, 2], ['files', true, 2]], 'Zero matches must still expose actual connected-server status');
    await hub.stop();
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'synthetic-session', enableJsonResponse: true });
    const httpFixture = await makeFixture();
    await httpFixture.connect(httpTransport);
    let redirectTargetHits = 0;
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(307, { Location: '/redirect-target' }); return res.end(); }
      if (req.url === '/redirect-target') { redirectTargetHits++; res.writeHead(500); return res.end(); }
      assert.equal(req.headers.authorization, 'Bearer synthetic-fixture-header');
      httpTransport.handleRequest(req, res).catch(() => { res.writeHead(500); res.end(); });
    });
    httpServer.listen(0, '127.0.0.1'); await once(httpServer, 'listening');
    const origin = `http://127.0.0.1:${httpServer.address().port}`;
    try {
      await save({ mcpServers: { http: { url: `${origin}/mcp`, headers: { Authorization: 'Bearer synthetic-fixture-header' } } } });
      await hub.connect('http', (await hub.describe()).servers[0].configHash);
      assert.equal((await hub.call('http', 'echo', { text: 'local HTTP fixture' })).content[0].text, 'local HTTP fixture');
      await hub.disconnect('http');
      await save({ mcpServers: { redirect: { url: `${origin}/redirect` } } });
      await assert.rejects(hub.connect('redirect', (await hub.describe()).servers[0].configHash), /connect/i);
      assert.equal(redirectTargetHits, 0, 'HTTP redirects must not be followed');
    } finally {
      await hub.disconnect('http');
      await httpFixture.close();
      httpServer.closeAllConnections();
      await new Promise(resolve => httpServer.close(resolve));
    }
    if (process.argv.includes('--bundled')) {
      const serverFiles = [
        ['filesystem', './node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', dir],
        ['browser', './node_modules/@playwright/mcp/cli.js', '--headless', '--isolated'],
      ];
      for (const [id, file, ...args] of serverFiles) {
        await save({ mcpServers: { [id]: { command: process.execPath, args: [...nodeFlags,fileURLToPath(new URL(file, import.meta.url)), ...args] } } });
        const result = await hub.connect(id, (await hub.describe()).servers[0].configHash);
        assert(result.toolCount > 0);
        console.log(`Bundled ${id}: initialized and listed ${result.toolCount} tools; no tool calls.`);
        await hub.disconnect(id);
      }
    }
    await save({ mcpServers: { forbidden: { url: 'http://example.com/mcp' } } });
    await assert.rejects(hub.describe(), /HTTPS|localhost|127\.0\.0\.1/i);
    await writeFile(configPath, 'x'.repeat(262145));
    await assert.rejects(hub.describe(), /256|large/i);
    await writeFile(configPath, `{ "secret": "${secret}`);
    await assert.rejects(hub.describe(), error => /JSON/.test(error.message) && !error.message.includes(secret));
    console.log('MCP check passed: SDK stdio/HTTP, draft-07/2020-12 schemas, all-page output validation, config-bound automatic calls, input validation before dispatch, stale catalog invalidation, environment isolation, stop/reconnect, redirects, caps, redaction, cancellation, cleanup.');
  } finally {
    if (originalInstanceToken === undefined) delete process.env.QWEN_LOCAL_INSTANCE_TOKEN; else process.env.QWEN_LOCAL_INSTANCE_TOKEN = originalInstanceToken;
    if (originalSentinel === undefined) delete process.env.QWEN_MCP_PRIVATE_SENTINEL; else process.env.QWEN_MCP_PRIVATE_SENTINEL = originalSentinel;
    await hub.close();
    await rm(dir, { recursive: true, force: true });
  }
}
