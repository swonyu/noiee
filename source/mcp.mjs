import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BoundedStdioTransport, boundedResponse } from './mcp-transport.mjs';
import { ToolListChangedNotificationSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {MCPRecoveryState} from './mcp-recovery.mjs';

const CONFIG_LIMIT = 256 * 1024, ARG_LIMIT = 64 * 1024, RESULT_LIMIT = 64 * 1024;
const IMAGE_LIMIT = 3500000;
const TOOL_LIMIT = 200, PAGE_LIMIT = 200, CONNECT_MS = 15000, CALL_MS = 60000;
const PREPARED_MS = 300000;
const plain = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = value => typeof value === 'string' && !value.includes('\0');
const privateFlag = /(?:password|passwd|secret|token|api[-_]?key|authorization|credential)/i;

function callInput(value) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'arguments,name,server' ||
      typeof value.server !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value.server) ||
      !string(value.name) || !value.name || value.name.length > 256) throw new Error('Invalid MCP call input.');
  return value;
}

function callArguments(args) {
  if (!plain(args)) throw new Error('MCP tool arguments must be a plain object.');
  let encoded;
  try { encoded = JSON.stringify(args, (_key, value) => {
    if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) throw new Error();
    return value;
  }); } catch { throw new Error('MCP tool arguments must contain valid JSON values.'); }
  if (Buffer.byteLength(encoded) > ARG_LIMIT) throw new Error('MCP tool arguments must be no larger than 64 KiB.');
  return JSON.parse(encoded);
}

function freezeJSON(value) {
  const pending = [value];
  while (pending.length) {const item = pending.pop();if (item && typeof item === 'object') {pending.push(...Object.values(item));Object.freeze(item);}}
  return value;
}

function requireNotAborted(signal) {
  if (signal?.aborted) throw new Error('MCP tool request was cancelled before dispatch. No tool call was sent.');
}

function redact(text, secrets) {
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text;
}

function safeValue(value, secrets) {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => safeValue(item, secrets));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), safeValue(item, secrets)]));
  return value;
}

export function relocateBundledPreset(value, resources = import.meta.dirname) {
  // ponytail: relocate only our two shipped presets; custom server paths remain explicit user configuration.
  if (!resources.endsWith('.app/Contents/Resources') || !plain(value) || value.url !== undefined ||
      !['/opt/homebrew/bin/node', '/usr/local/bin/node'].includes(value.command) ||
      !plain(value.env ?? {}) || Object.keys(value.env ?? {}).length || !Array.isArray(value.args)) return value;
  const args = value.args, browser = '/node_modules/@playwright/mcp/cli.js', files = '/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js';
  const suffix = args.length === 4 && args.slice(1).join('\0') === '--isolated\0--browser\0chrome' ? browser
    : args.length === 2 && typeof args[1] === 'string' && path.isAbsolute(args[1]) ? files : null;
  if (!suffix || !['Qwen Local.app', 'Saleh Uncensored.app', 'Noiee.app'].some(name => args[0] === path.join(homedir(), 'Applications', name, 'Contents', 'Resources') + suffix)) return value;
  return { ...value, args: [resources + suffix, ...args.slice(1)] };
}

function serverConfig(id, value, defaultCwd) {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id) || !plain(value)) throw new Error('MCP server IDs must use 1–100 letters, numbers, dots, underscores or hyphens, with an object configuration.');
  const env = value.env ?? {}, headers = value.headers ?? {};
  for (const [label, dict] of [['env', env], ['headers', headers]]) {
    if (!plain(dict) || Object.entries(dict).some(([key, val]) => !key || !string(key) || !string(val))) throw new Error(`MCP server ${id}: ${label} must contain string values.`);
  }
  // Only ordinary mode/log settings are public; unknown environment keys remain confidential.
  const secrets = [...Object.entries(env).filter(([key]) => !['MODE', 'NODE_ENV', 'LOG_LEVEL'].includes(key)).map(([, value]) => value), ...Object.values(headers)].filter(Boolean);
  let metadata, params;
  if (value.command !== undefined && value.url === undefined) {
    if (!string(value.command) || !value.command.trim() || value.command.length > 4096 || !Array.isArray(value.args ?? []) || (value.args ?? []).some(arg => !string(arg))) throw new Error(`MCP server ${id}: provide a command and an array of string args.`);
    if (Object.keys(env).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new Error(`MCP server ${id}: environment variable names are invalid.`);
    if (Object.keys(headers).length) throw new Error(`MCP server ${id}: headers are only supported for HTTP servers.`);
    const args = value.args ?? [];
    args.forEach((arg, index) => {
      if (privateFlag.test(arg.split('=')[0]) && arg.startsWith('-')) {
        const secret = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[index + 1];
        if (secret) secrets.push(secret);
      }
    });
    const cwd=value.cwd ?? defaultCwd;
    if(typeof cwd!=='string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error(`MCP server ${id}: cwd must be an absolute directory path.`);
    params = { command: value.command, args, env, cwd, stderr: 'ignore' };
    metadata = { id, transport: 'stdio', command: value.command, args, cwd, envKeys: Object.keys(env).sort() };
  } else if (value.url !== undefined && value.command === undefined) {
    let url;
    try { url = new URL(value.url); } catch { throw new Error(`MCP server ${id}: provide a valid URL.`); }
    if (typeof value.url !== 'string' || url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error(`MCP server ${id}: use HTTPS or HTTP on localhost/127.0.0.1, without URL credentials or fragments.`);
    if (value.args !== undefined || Object.keys(env).length) throw new Error(`MCP server ${id}: args and env are only supported for stdio servers.`);
    try { new Headers(headers); } catch { throw new Error(`MCP server ${id}: HTTP headers are invalid.`); }
    const displayURL = new URL(url);
    for (const val of url.searchParams.values()) if (val) secrets.push(val);
    for (const key of new Set(displayURL.searchParams.keys())) displayURL.searchParams.set(key, '[redacted]');
    params = { url, headers };
    metadata = { id, transport: 'http', url: displayURL.toString(), headerKeys: Object.keys(headers).sort() };
  } else throw new Error(`MCP server ${id}: configure exactly one command or URL.`);
  if (secrets.some(secret => id.includes(secret))) throw new Error('MCP server ID contains a configured credential; rename it before connecting.');
  return { params, metadata, secrets: [...new Set(secrets)].sort((a, b) => b.length - a.length) };
}

function boundedResult(result, secrets) {
  let image, imageCount = 0, omitted = 0, binaryOmitted = 0;
  const reasons = {}, content = [];
  const omitImage = reason => { omitted++; reasons[reason] = (reasons[reason] ?? 0) + 1; };
  for (const item of result.content ?? []) {
    if (item.type === 'image') {
      imageCount++;
      if (!['image/png', 'image/jpeg'].includes(item.mimeType)) { omitImage('unsupportedMime'); continue; }
      const prefix = `data:${item.mimeType};base64,`, data = item.data;
      if (typeof data === 'string' && prefix.length + data.length > IMAGE_LIMIT) { omitImage('tooLarge'); continue; }
      if (typeof data !== 'string' || !data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) { omitImage('invalidData'); continue; }
      const bytes = Buffer.from(data, 'base64');
      // Validate canonical encoding and format signatures; pixel decoding stays with the image consumer.
      const signature = item.mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : bytes.length >= 5 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
      if (!signature || bytes.toString('base64') !== data) { omitImage('invalidData'); continue; }
      if (image) { omitImage('additionalImage'); continue; }
      image = prefix + data;
    } else if (item.type === 'audio' || (item.type === 'resource' && item.resource?.blob !== undefined)) binaryOmitted++;
    else content.push(item);
  }
  const clean = safeValue({ ...result, content }, secrets);
  delete clean.image; delete clean.images; // Only validated MCP image blocks may populate the native image field.
  const metadata = {
    ...(imageCount ? { images: { returned: image ? 1 : 0, omitted, reasons } } : {}),
    ...(binaryOmitted ? { omittedBinaryContent: binaryOmitted } : {}),
    isError: Boolean(result.isError),
  };
  let output = { ...clean, ...metadata, truncated: false };
  if (Buffer.byteLength(JSON.stringify(output)) > RESULT_LIMIT) {
    // Never stringify oversized structured/binary data into the text fallback.
    const text = clean.content.filter(item => item.type === 'text').map(item => item.text).join('\n') || '[Oversized structured or non-text result omitted.]';
    output = { content: [{ type: 'text', text: `${text.slice(0, 10000)}\n[Result truncated at 64 KiB.]` }], ...metadata, ...(typeof clean.connectionWarning === 'string' ? { connectionWarning: clean.connectionWarning.slice(0, 500) } : {}), truncated: true };
  }
  return { ...output, ...(image ? { image } : {}) };
}

function schemaCompiler() {
  const options = { strict: true, strictRequired: false, allowUnionTypes: true, allErrors: false };
  const draft7 = new Ajv(options), draft2020 = new Ajv2020(options);
  addFormats(draft7); addFormats(draft2020);
  return schema => {
    // Offline, synchronous validation only; unsupported schemas fail before a session becomes callable.
    JSON.stringify(schema, (key, value) => {
      if (['$ref', '$dynamicRef', '$recursiveRef', '$async'].includes(key)) throw new Error('Tool schema references and asynchronous validation are not supported.');
      return value;
    });
    const dialect = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : schema.$schema;
    let ajv;
    if (dialect === undefined || dialect === 'https://json-schema.org/draft/2020-12/schema') ajv = draft2020;
    else if (dialect === 'http://json-schema.org/draft-07/schema') ajv = draft7;
    else throw new Error('Tool schema uses an unsupported JSON Schema dialect. Supported: draft-07 and 2020-12.');
    try { return ajv.compile(schema); }
    catch { throw new Error('Tool schema is invalid or uses unsupported JSON Schema features.'); }
  };
}

async function readCatalog(client, options, cacheMetadata = false) {
  const tools = [], names = new Set(), cursors = new Set();
  let cursor;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const params = cursor ? { cursor } : {};
    // Refresh through public request so the SDK cannot replace pinned output validators mid-call.
    const result = cacheMetadata ? await client.listTools(params, options) : await client.request({ method: 'tools/list', params }, ListToolsResultSchema, options);
    for (const tool of result.tools) {
      if (tools.length === TOOL_LIMIT) return { tools, truncated: true };
      if (names.has(tool.name)) throw new Error('Server returned duplicate tool names.');
      if (tool.name.length > 256 || Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 16384 || (tool.outputSchema && Buffer.byteLength(JSON.stringify(tool.outputSchema)) > 16384)) throw new Error('Server tool metadata exceeds the supported name or 16 KiB schema limit.');
      names.add(tool.name); tools.push(tool);
    }
    if (!result.nextCursor) return { tools, truncated: false };
    if (tools.length === TOOL_LIMIT || page === PAGE_LIMIT - 1) return { tools, truncated: true };
    if (cursors.has(result.nextCursor)) throw new Error('Server repeated a pagination cursor.');
    cursors.add(result.nextCursor); cursor = result.nextCursor;
  }
}

const sortedCatalog = tools => tools.slice().sort((a, b) => a.name.localeCompare(b.name));
const searchWords = text => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const searchFillers = new Set('a an and are be can could find for from how i in is it me my of on or please search that the this to tool tools use with would you your'.split(' '));
function toolSearchScore(tool, query, tokens) {
  if (!tokens.length) return 1;
  const name = tool.name.toLowerCase(), text = `${tool.server} ${tool.name} ${tool.description}`.toLowerCase();
  const nameWords = new Set(searchWords(name)), serverWords = new Set(searchWords(tool.server)), descriptionWords = new Set(searchWords(tool.description));
  return (name === query ? 1000 : 0) + (text.includes(query) ? 100 : 0) + tokens.reduce((score, token) => score + (nameWords.has(token) ? 20 : 0) + (serverWords.has(token) ? 10 : 0) + (descriptionWords.has(token) ? 1 : 0), 0);
}

/** Transport boundary only. Native code MUST approve each connect and each call before invoking these methods. */
export class MCPHub {
  #connections = new Map();
  #hashKey = randomBytes(32);
  #closed = false;
  #stopEpoch = 0;
  #statusReasons = new Map();
  #prepared = new WeakMap();
  #recovery;#recoveryWork;#recoveryHalted=false;#recoveryStatus=new Map();#suppressed=new Set();
  #managedFetch;

  constructor(configPath = path.join(homedir(), 'Library', 'Application Support', 'Qwen Local', 'mcp.json'),options={}) {
    this.configPath = configPath;
    if(!plain(options)||Object.keys(options).some(key=>!['recoveryDirectory','fault','managedFetch'].includes(key))||options.recoveryDirectory!==undefined&&typeof options.recoveryDirectory!=='string'||options.fault!==undefined&&typeof options.fault!=='function'||options.managedFetch!==undefined&&typeof options.managedFetch!=='function')throw Error('Invalid trusted MCP recovery options.');
    if(options.recoveryDirectory!==undefined)this.#recovery=new MCPRecoveryState(options.recoveryDirectory,options.fault);
    this.#managedFetch=options.managedFetch;
  }

  #beginWork(id, connection) {
    let settle;const done=new Promise(resolve=>settle=resolve);connection.work.add(done);
    return ()=>{connection.work.delete(done);settle();if(connection.closeWork)void this.#drain(id,connection).catch(()=>{});};
  }

  #drain(id, connection) {
    if(connection.drainWork)return connection.drainWork;
    const closing=connection.transport.close(); // Fence admission synchronously, before the first await.
    connection.drainWork=Promise.resolve().then(async()=>{
      await Promise.allSettled([closing,...connection.work]);
      await closing; // A failed close stays owned, including after SDK onclose.
      if(this.#connections.get(id)===connection)this.#connections.delete(id);
    });
    void connection.drainWork.catch(()=>{});return connection.drainWork;
  }

  async #config() {
    const configured=await this.#userConfig();
    if(!this.#managedFetch)return configured;
    if(configured.has('managed-fetch'))throw Error('The managed-fetch MCP ID is reserved; a user configuration collision must be resolved before connecting.');
    const config=await this.#managedFetch();
    if(config)configured.set('managed-fetch',{
      ...serverConfig('managed-fetch',config,path.dirname(path.resolve(this.configPath))),
      configuration:config,
      configHash:createHmac('sha256',this.#hashKey).update('managed-fetch').update('\0').update(JSON.stringify(config)).digest('hex'),
    });
    return configured;
  }

  async #userConfig() {
    let file;
    try { file = await open(this.configPath, constants.O_RDONLY | constants.O_NONBLOCK); }
    catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw new Error(`Cannot read MCP config (${error.code || 'filesystem error'}). Check the file permissions.`);
    }
    let value;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > CONFIG_LIMIT) throw new Error('MCP config must be a regular file no larger than 256 KiB.');
      const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > CONFIG_LIMIT) throw new Error('MCP config must be no larger than 256 KiB.');
      try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
      catch { throw new Error('Invalid JSON in MCP config.'); }
    } finally { await file.close(); }
    if (!plain(value) || !plain(value.mcpServers)) throw new Error('MCP config must contain an mcpServers object.');
    if (Object.keys(value.mcpServers).length > 64) throw new Error('MCP config supports up to 64 servers.');
    return new Map(Object.entries(value.mcpServers).map(([id, saved]) => {
      const config = relocateBundledPreset(saved);
      return [id, {
        ...serverConfig(id, config, path.dirname(path.resolve(this.configPath))),
        configuration:config,
        configHash: createHmac('sha256', this.#hashKey).update(id).update('\0').update(JSON.stringify(config)).digest('hex'),
      }];
    }));
  }

  async describe() {
    const config = await this.#config();
    const missing = [...this.#connections].filter(([id]) => !config.has(id)).map(([id, connection]) => ({id, connected: Boolean(connection.ready || connection.refreshing && !connection.invalidReason), configRemoved:true, catalogRefreshing:Boolean(connection.refreshing), statusReason:connection.invalidReason}));
    for(const [id,recoveryState]of this.#recoveryStatus)if(!config.has(id)&&!missing.some(row=>row.id===id))missing.push({id,connected:false,configRemoved:true,recoveryState});
    return { configPath: this.configPath, ...(this.#recovery?.failed?{recoveryUnavailable:true}:{}), servers: [...config].map(([id, entry]) => ({
      ...safeValue(entry.metadata, entry.secrets), configHash: entry.configHash,
      connected: Boolean(this.#connections.get(id)?.ready || (this.#connections.get(id)?.refreshing && !this.#connections.get(id)?.invalidReason)),
      configChanged: Boolean(this.#connections.get(id)?.ready && this.#connections.get(id).configHash !== entry.configHash),
      catalogRefreshing: Boolean(this.#connections.get(id)?.refreshing),
      ...(this.#recoveryStatus.has(id)?{recoveryState:this.#recoveryStatus.get(id)}:{}),
      ...(this.#connections.get(id)?.invalidReason ? {statusReason:this.#connections.get(id).invalidReason} : this.#statusReasons.has(id) ? { statusReason: this.#statusReasons.get(id) } : {}),
    })).concat(missing) };
  }

  connect(id,expectedConfigHash){this.#suppressed.delete(id);return this.#connect(id,expectedConfigHash);}
  async #connect(id, expectedConfigHash,desired=null) {
    if (this.#closed) throw new Error('MCP hub is closed.');
    const stopEpoch = this.#stopEpoch;
    if(this.#recovery)await this.#recovery.openBoot();
    const entry = (await this.#config()).get(id);
    if (this.#closed) throw new Error('MCP hub is closed.');
    if (stopEpoch !== this.#stopEpoch||this.#suppressed.has(id)) throw new Error('MCP connection was stopped. Approve connecting again.');
    if (!entry) throw new Error('Unknown MCP server. Add it to mcp.json first.');
    if (typeof expectedConfigHash !== 'string' || entry.configHash !== expectedConfigHash) throw new Error('MCP configuration changed or approval is missing. Review the server and approve connecting again.');
    if (this.#connections.has(id)) throw new Error('MCP server is already connected or connecting. Disconnect it before connecting again.');
    const controller = new AbortController();
    const compileSchema = schemaCompiler();
    const client = new Client({ name: 'Noiee', version: '1.0.0' }, { capabilities: {}, jsonSchemaValidator: {
      getValidator: schema => {
        const validate = compileSchema(schema);
        return value => validate(value) ? { valid: true, data: value } : { valid: false, errorMessage: 'Structured content does not match the tool output schema.' };
      },
    } });
    const onOversize = error => {
      if (connection.wireError) return;
      connection.wireError = error; connection.ready = false;
      this.#statusReasons.set(id, error.message);
      controller.abort(error);
      void client.close().catch(() => {});
    };
    const transport = entry.metadata.transport === 'stdio' ? new BoundedStdioTransport(entry.params, onOversize) : new StreamableHTTPClientTransport(entry.params.url, {
      requestInit: { headers: entry.params.headers, redirect: 'error' },
      fetch: async (url, init) => boundedResponse(await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) }), onOversize),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const connection = { client, transport, controller, configHash: entry.configHash, tools: new Map(), validators: new Map(), outputValidators: new Map(), ready: false, truncated: false, secrets: entry.secrets, catalogVersion: 0, activeCalls: 0, omittedTools: 0, disconnectRequested: false, work:new Set() };
    const closeTransport=transport.close.bind(transport);
    transport.close=()=>{
      if(connection.closeWork)return connection.closeWork;
      connection.ready=false;connection.invalidReason ??= 'MCP connection closure is pending.';
      connection.closeWork=Promise.resolve().then(closeTransport);
      void connection.closeWork.catch(()=>{connection.invalidReason='MCP connection closure is unconfirmed; retained for inspection.';});
      controller.abort();return connection.closeWork;
    };
    // The SDK can call close without awaiting it, or clear its transport on onclose.
    client.close=()=>transport.close();
    this.#connections.set(id, connection);
    this.#statusReasons.delete(id);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      if (this.#connections.get(id) !== connection || connection.closeWork) return;
      connection.catalogVersion++;
      if (!connection.catalog || connection.invalidReason) return;
      connection.ready = false;
      if (!connection.refreshing) { const finish=this.#beginWork(id,connection);connection.refreshing = this.#refreshCatalog(id, connection).finally(() => { connection.refreshing = null;finish(); }); }
      return connection.refreshing;
    });
    client.onclose = () => { connection.ready=false;void this.#drain(id,connection).catch(()=>{}); };
    client.onerror = () => {}; // Request failures are reported by the awaited operation; never log server/config data.
    const timer = setTimeout(() => controller.abort(new Error('MCP connection timed out.')), CONNECT_MS);
    const options = { signal: controller.signal, timeout: CONNECT_MS, maxTotalTimeout: CONNECT_MS };
    const finish=this.#beginWork(id,connection);
    try {
      if(id==='managed-fetch'&&this.#managedFetch){
        const current=(await this.#config()).get(id);
        if(!current||current.configHash!==entry.configHash)throw Error('Managed Fetch changed, is unavailable or was disabled before transport admission.');
        if(this.#closed||stopEpoch!==this.#stopEpoch||controller.signal.aborted)throw Error('Managed Fetch connection was stopped before transport admission.');
      }
      await client.connect(transport, options);
      const catalogVersion = connection.catalogVersion;
      const { tools: allTools, truncated } = await readCatalog(client, options, true);
      if (catalogVersion !== connection.catalogVersion) throw new Error('Tool catalog changed while connecting. Approve a new connection.');
      connection.truncated = truncated;
      connection.catalog = sortedCatalog(allTools);
      for (const tool of allTools) {
        const metadata = { name: tool.name, inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) };
        if (!isDeepStrictEqual(metadata, safeValue(metadata, entry.secrets))) { connection.omittedTools++; continue; }
        connection.validators.set(tool.name, compileSchema(tool.inputSchema));
        connection.tools.set(tool.name, { server: id, name: tool.name, description: redact(tool.description ?? '', entry.secrets).slice(0, 4000), inputSchema: tool.inputSchema });
      }
      // SDK 1.29 listTools replaces its output cache per page; keep every admitted tool's validator here.
      for (const tool of allTools) if (connection.tools.has(tool.name) && tool.outputSchema) connection.outputValidators.set(tool.name, compileSchema(tool.outputSchema));
      if (controller.signal.aborted || this.#connections.get(id) !== connection) throw new Error('MCP connection was cancelled.');
      const current=()=>!this.#closed&&stopEpoch===this.#stopEpoch&&!this.#suppressed.has(id)&&!controller.signal.aborted&&this.#connections.get(id)===connection;
      if(this.#recovery){
        const row={id,transport:entry.metadata.transport,config:this.#recovery.fingerprint('config',{id,transport:entry.metadata.transport,params:entry.params,configuration:entry.configuration}),catalog:this.#recovery.fingerprint('catalog',allTools.slice().sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0))};
        const fresh=(await this.#config()).get(id);if(!fresh||fresh.configHash!==entry.configHash||!current())throw Error('MCP configuration changed or connection was stopped.');
        if(desired&&(truncated||connection.omittedTools||row.config!==desired.config||row.catalog!==desired.catalog||row.transport!==desired.transport))throw Error('Saved MCP configuration or catalog changed. Use explicit Connect.');
        if(!desired){if(truncated||connection.omittedTools){await this.#recovery.forget(id);this.#recoveryStatus.set(id,'not eligible');}else if(!await this.#recovery.remember(row,current))throw Error('MCP connection was stopped before remembering it.');}
        if(!current())throw Error('MCP connection was stopped.');
        if(!truncated&&!connection.omittedTools)this.#recoveryStatus.set(id,'verified');
      }
      connection.ready = true;
      if (connection.omittedTools) connection.catalogWarning = `${connection.omittedTools} tool(s) omitted because configured credentials appear in executable metadata.`;
      return { server: id, connected: true, toolCount: connection.tools.size, truncated: connection.truncated, ...(connection.catalogWarning ? { omittedTools: connection.omittedTools, catalogWarning: connection.catalogWarning } : {}) };
    } catch (error) {
      controller.abort();
      await client.close().catch(() => {});
      throw new Error(`Could not connect MCP server ${id}: ${redact(String((connection.wireError ?? error).message), entry.secrets).slice(0, 2000)} Check the command or server connection, then approve a new attempt.`);
    } finally { clearTimeout(timer);finish(); }
  }

  async #refreshCatalog(id, connection) {
    const signal = AbortSignal.any([connection.controller.signal, AbortSignal.timeout(CONNECT_MS)]);
    let reason;
    try {
      for (let pass = 0; pass < 3; pass++) {
        const version = connection.catalogVersion;
        const current = await readCatalog(connection.client, { signal, timeout: CONNECT_MS, maxTotalTimeout: CONNECT_MS });
        if (this.#connections.get(id) !== connection || connection.controller.signal.aborted || this.#closed) return;
        if (signal.aborted) throw new Error('Catalog verification timed out.');
        if (connection.truncated || current.truncated || !isDeepStrictEqual(connection.catalog, sortedCatalog(current.tools))) {
          reason = 'MCP tool catalog changed or exceeds verification limits. Reconnect to review it; further calls are blocked.';
          break;
        }
        if (version === connection.catalogVersion) { connection.ready = true; return; }
      }
      reason ??= 'MCP tool catalog kept changing during verification. Reconnect before further calls.';
    } catch {
      if (this.#connections.get(id) !== connection) return;
      reason = connection.wireError?.message ?? 'MCP tool catalog could not be verified. Reconnect before further calls.';
    }
    if (this.#connections.get(id) !== connection) return;
    connection.invalidReason = reason;
    this.#statusReasons.set(id, reason);
    // Keep already sent calls alive long enough to collect their actual result; never admit new calls.
    if (!connection.activeCalls) await connection.client.close().catch(() => {});
  }

  // Trusted snapshot only: the owner must retain this hub and its selected sessions.
  async completeCatalog(selection) {
    if (!Array.isArray(selection) || selection.length < 1 || selection.length > 64 || Reflect.ownKeys(selection).length !== selection.length + 1) throw new Error('Invalid MCP catalog selection; choose 1 to 64 unique reviewed servers.');
    const ids = new Set(), selected = [];
    for (let index = 0; index < selection.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(selection, String(index));
      if (!entry || !Object.hasOwn(entry, 'value')) throw new Error('Invalid MCP catalog selection.');
      const row = entry.value;
      if (!plain(row) || Reflect.ownKeys(row).length !== 2) throw new Error('Invalid MCP catalog selection.');
      const fields = Object.getOwnPropertyDescriptors(row), id = fields.id?.value, configHash = fields.configHash?.value;
      if (!fields.id || !fields.configHash || !Object.hasOwn(fields.id, 'value') || !Object.hasOwn(fields.configHash, 'value') ||
          typeof id !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(id) || typeof configHash !== 'string' || !/^[a-f0-9]{64}$/.test(configHash) || ids.has(id)) throw new Error('Invalid MCP catalog selection.');
      ids.add(id);selected.push({id, configHash});
    }
    const stopEpoch = this.#stopEpoch, records = selected.map(({id, configHash}) => {
      const connection = this.#connections.get(id);
      return {id, configHash, connection, catalog: connection?.catalog, catalogVersion: connection?.catalogVersion};
    });
    const check = () => {
      if (this.#closed || this.#stopEpoch !== stopEpoch) throw new Error('MCP catalog snapshot was stopped or closed.');
      let count = 0;
      for (const record of records) {
        const {id, configHash, connection, catalog, catalogVersion} = record;
        if (!connection || this.#connections.get(id) !== connection || !connection.ready || connection.refreshing || connection.invalidReason ||
            connection.closeWork || connection.controller.signal.aborted || connection.configHash !== configHash ||
            connection.catalog !== catalog || connection.catalogVersion !== catalogVersion || connection.truncated || connection.omittedTools) throw new Error('MCP catalog is unavailable, incomplete, or its configuration, connection or catalog changed. Review the selected connections again.');
        count += connection.tools.size;
      }
      // Bound allocation before cloning; the Coding registry applies its schema and byte limits.
      if (count > 128) throw new Error('Complete MCP catalog tool limit exceeded (128).');
    };
    check();
    const finishes = records.map(({id, connection}) => this.#beginWork(id, connection));
    try {
      const config = await this.#config();
      check();
      if (records.some(({id, configHash}) => config.get(id)?.configHash !== configHash)) throw new Error('MCP catalog configuration changed. Review the selected connections again.');
      return freezeJSON(structuredClone(records.flatMap(({connection}) => [...connection.tools.values()])));
    } finally {for (const finish of finishes) finish();}
  }

  tools(query = '', offset = 0) {
    if (typeof query !== 'string' || query.length > 500) throw new Error('Tool search must be text no longer than 500 characters.');
    if (!Number.isInteger(offset) || offset < 0 || offset > 64 * TOOL_LIMIT) throw new Error('Tool search offset must be an integer from 0 to 12800.');
    const matched = [], needle = query.trim().toLowerCase();
    const tokens = [...new Set(searchWords(needle))].filter(word => !searchFillers.has(word));
    for (const connection of this.#connections.values()) if (connection.ready) {
      for (const tool of connection.tools.values()) {
        const score = toolSearchScore(tool, needle, tokens);
        if (score) matched.push({ tool, score });
      }
    }
    matched.sort((a, b) => b.score - a.score);
    const servers = [...this.#connections].map(([id, connection]) => ({ id, connected: Boolean(connection.ready || (connection.refreshing && !connection.invalidReason)), status: connection.invalidReason ? 'reconnect required' : connection.refreshing ? 'verifying catalog' : connection.ready ? 'ready' : 'connecting', toolCount: connection.tools.size, ...(connection.catalogWarning ? { omittedTools: connection.omittedTools, catalogWarning: connection.catalogWarning } : {}) }));
    const tools = matched.slice(offset, offset + 20).map(match => structuredClone(match.tool));
    const nextOffset = offset + tools.length < matched.length ? offset + tools.length : null;
    return { tools, total: matched.length, nextOffset, truncated: nextOffset !== null || [...this.#connections.values()].some(connection => connection.truncated), servers };
  }

  #callTarget(server, name, args) {
    const connection = this.#connections.get(server);
    if(this.#closed||connection?.closeWork)throw new Error('MCP connection is closing or closed. No tool call was sent.');
    if (!connection?.ready) throw new Error(connection?.invalidReason || this.#statusReasons.get(server) || (connection?.refreshing ? 'MCP tool catalog is being verified. No tool call was sent.' : 'MCP server is not connected. Approve connecting it first.'));
    if (typeof name !== 'string' || !connection.tools.has(name)) throw new Error('Unknown MCP tool. Search the connected tools before calling.');
    const input = callArguments(args), validate = connection.validators.get(name);
    if (!validate(input)) throw new Error('MCP tool arguments do not match the connected tool input schema. Check required fields, types and allowed properties. No tool call was sent.');
    return {connection, input};
  }

  #checkPrepared(record, current) {
    const {connection, server, name} = record;
    if (this.#closed || Date.now() >= record.expiresAt || this.#connections.get(server) !== connection ||
        !connection.ready || connection.closeWork || connection.controller.signal.aborted ||
        connection.configHash !== record.configHash || current?.configHash !== record.configHash ||
        connection.catalogVersion !== record.catalogVersion || connection.catalog !== record.catalog ||
        connection.tools.get(name) !== record.tool || connection.validators.get(name) !== record.validator ||
        connection.outputValidators.get(name) !== record.outputValidator) {
      throw new Error('Prepared MCP call expired or its configuration, connection or catalog changed. Review it again. No tool call was sent.');
    }
  }

  // This descriptor is display data, not native approval. The coordinator keeps
  // the exact object server-side; copied/serialized objects carry no authority.
  async prepareCall(value) {
    const {server, name, arguments: args} = callInput(value), {connection, input} = this.#callTarget(server, name, args);
    if (!isDeepStrictEqual(input, safeValue(input, connection.secrets))) throw new Error('MCP call arguments contain configured credentials. No approval descriptor was created.');
    const record = {server, name, input, connection, configHash: connection.configHash, catalogVersion: connection.catalogVersion,
      catalog: connection.catalog, tool: connection.tools.get(name), validator: connection.validators.get(name),
      outputValidator: connection.outputValidators.get(name), expiresAt: Date.now() + PREPARED_MS, used: false};
    const finish = this.#beginWork(server, connection);
    try {
      this.#checkPrepared(record, (await this.#config()).get(server));
      const descriptor = freezeJSON({id: randomBytes(24).toString('hex'), server, name, arguments: input});
      this.#prepared.set(descriptor, record);return descriptor;
    } finally {finish();}
  }

  // Legacy call(server, name, args, expectedConfigHash) remains unchanged.
  // New callers may use call({server,name,arguments}, {signal,prepared}).
  async call(server, name, args, expectedConfigHash) {
    let callerSignal, prepared;
    if (plain(server)) {
      const value = callInput(server), options = name ?? {};
      if (arguments.length > 2 || !plain(options) || Object.keys(options).some(key => !['signal', 'prepared'].includes(key))) throw new Error('Invalid MCP call options.');
      if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('Invalid MCP caller AbortSignal.');
      callerSignal = options.signal;prepared = options.prepared;
      ({server, name, arguments: args} = value);
    }
    const {connection, input} = this.#callTarget(server, name, args);
    let record;
    if (prepared !== undefined) {
      record = this.#prepared.get(prepared);
      if (!record || record.used || record.server !== server || record.name !== name || !isDeepStrictEqual(record.input, input)) throw new Error('Prepared MCP call is invalid, already used or does not match the exact reviewed arguments. No tool call was sent.');
      record.used = true; // Consume before any await; concurrent replies cannot replay it.
    }
    requireNotAborted(callerSignal);
    const finish=this.#beginWork(server,connection);
    try {
    let current;
    if(server==='managed-fetch'&&this.#managedFetch&&!record&&expectedConfigHash===undefined){
      current=(await this.#config()).get(server);
      if(current?.configHash!==connection.configHash)throw Error('Managed Fetch changed or was disabled. No tool call was sent.');
    }
    if (record) {
      current = (await this.#config()).get(server);
      requireNotAborted(callerSignal);this.#checkPrepared(record, current);
    }
    if (expectedConfigHash !== undefined) {
      if (typeof expectedConfigHash !== 'string' || connection.configHash !== expectedConfigHash) throw new Error('MCP approval no longer matches the connected configuration. No tool call was sent.');
      const current = (await this.#config()).get(server);
      if (this.#closed || this.#connections.get(server) !== connection || !connection.ready || connection.controller.signal.aborted || connection.configHash !== expectedConfigHash || current?.configHash !== expectedConfigHash) throw new Error('MCP approval no longer matches the active connection or current configuration. Reconnect before using automatic calls. No tool call was sent.');
    }
    requireNotAborted(callerSignal);
    if (record) this.#checkPrepared(record, current);
    const deadline = AbortSignal.timeout(CALL_MS);
    const signal = AbortSignal.any([connection.controller.signal, deadline, ...(callerSignal ? [callerSignal] : [])]);
    connection.activeCalls++;
    try {
      requireNotAborted(signal);
      const result = await connection.client.callTool({ name, arguments: input }, undefined, { signal, timeout: CALL_MS, maxTotalTimeout: CALL_MS });
      requireNotAborted(signal); // The reply must be validated before any connection failure.
      const refreshing = connection.refreshing;
      if (refreshing) await refreshing;
      // A later catalog failure cannot erase this known reply. Explicit cancellation
      // still withholds it; validation and result limits below remain unchanged.
      if (callerSignal?.aborted || deadline.aborted || this.#closed || connection.disconnectRequested ||
          signal.aborted && !(refreshing && connection.invalidReason)) throw new Error('MCP result arrived after cancellation.');
      const validateOutput = connection.outputValidators.get(name);
      if (validateOutput && ((!result.structuredContent && !result.isError) || (result.structuredContent && !validateOutput(result.structuredContent)))) throw new Error('Structured content does not match the connected tool output schema.');
      return boundedResult({ ...result, ...(connection.invalidReason ? { connectionWarning: connection.invalidReason } : {}) }, connection.secrets);
    } catch (error) {
      if (connection.wireError) { await connection.client.close().catch(() => {}); throw connection.wireError; }
      if (signal.aborted || error.code === -32001) throw new Error('MCP tool request timed out or was cancelled. Its action may still have happened; completion is unknown. Check the target before approving any retry.');
      throw new Error(`MCP tool failed: ${redact(String(error.message), connection.secrets).slice(0, 2000)} Completion is unconfirmed; no retry was made.`);
    } finally {
      connection.activeCalls--;
      if (connection.invalidReason && !connection.activeCalls && this.#connections.get(server) === connection) await connection.client.close().catch(() => {});
    }
    } finally { finish(); }
  }

  async #disconnect(id) {
    const connection = this.#connections.get(id);
    if (connection) { connection.disconnectRequested = true; await this.#drain(id,connection); }
    return { server: id, connected: false };
  }

  async disconnect(id){
    if(typeof id!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(id))throw Error('Invalid MCP server ID.');
    this.#suppressed.add(id);if(this.#recovery)this.#recoveryStatus.set(id,'stopped');
    const outcomes=await Promise.allSettled([this.#disconnect(id),this.#recovery?.forget(id)]);
    if(outcomes.some(row=>row.status==='rejected'))throw Error('MCP disconnect or durable suppression is unconfirmed.');
    return{server:id,connected:false};
  }
  recover(assertReady,{automatic=true}={}){
    if(!this.#recovery||this.#recoveryHalted)return Promise.resolve({available:false});
    return this.#recoveryWork??=this.#recover(assertReady,automatic);
  }
  async #recover(assertReady,automatic){
    if(typeof assertReady!=='function'||typeof automatic!=='boolean')throw Error('Invalid trusted MCP recovery gate.');
    const epoch=this.#stopEpoch,{eligible,rows}=await this.#recovery.openBoot();
    for(const row of rows){
      if(this.#closed||this.#recoveryHalted||epoch!==this.#stopEpoch)break;
      if(this.#suppressed.has(row.id))continue;
      this.#recoveryStatus.set(row.id,!automatic?'awaiting native Connect':!eligible?'inspection required':'checking');
      if(!automatic||!eligible)continue;
      try{
        await assertReady();if(this.#closed||epoch!==this.#stopEpoch)break;
        if(this.#suppressed.has(row.id))continue;
        const entry=(await this.#config()).get(row.id);
        if(!entry||entry.metadata.transport!==row.transport||this.#recovery.fingerprint('config',{id:row.id,transport:entry.metadata.transport,params:entry.params,configuration:entry.configuration})!==row.config)throw Error('Configuration changed');
        if(this.#closed||epoch!==this.#stopEpoch)break;
        if(this.#suppressed.has(row.id))continue;
        this.#recoveryStatus.set(row.id,'reconnecting');await this.#connect(row.id,entry.configHash,row);
      }catch{if(!this.#closed&&epoch===this.#stopEpoch&&!this.#suppressed.has(row.id))this.#recoveryStatus.set(row.id,'blocked; use explicit Connect');}
    }
    return{available:true};
  }
  async stop(reason='owner-stop') {
    if(!['owner-stop','page-departure','shutdown-drain','shutdown-close'].includes(reason))throw Error('Invalid internal MCP stop reason.');
    this.#stopEpoch++;
    this.#recoveryHalted=true;
    this.#statusReasons.clear();
    for(const id of this.#recoveryStatus.keys())this.#recoveryStatus.set(id,reason==='owner-stop'?'stopped':'disconnected');
    const outcomes = await Promise.allSettled([...this.#connections.keys()].map(id => this.#disconnect(id)).concat([this.#recoveryWork,reason==='owner-stop'?this.#recovery?.forget():undefined]));
    if (outcomes.some(result => result.status === 'rejected')) throw new Error('An MCP connection could not be closed cleanly.');
    return { stopped: true };
  }

  async close() {
    this.#closed = true;
    await this.stop('shutdown-close');await this.#recovery?.close();return{stopped:true};
  }
}
