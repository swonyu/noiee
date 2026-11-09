import { spawn } from 'node:child_process';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

// Raw stdio record / HTTP body / SSE event ceiling, before SDK JSON parsing.
// Separate from the 64 KiB displayed text and 3.5M-character image ceilings.
export const MCP_WIRE_LIMIT = 8 * 1024 * 1024;
const wireError = () => new Error('MCP response exceeded the 8 MiB wire-message limit. The connection was closed; completion is unknown. Check the target before approving any retry.');

// SDK 1.29 has no public pre-parse stdio hook. Keep its public transport contract,
// environment allowlist and message validation, using stdlib process/byte handling.
export class BoundedStdioTransport {
  #child;
  #buffer = Buffer.alloc(0);
  #size = 0;
  #closing;
  #trusted; #started=false;
  constructor(params, onOversize, trusted) { this.params = params; this.onOversize = onOversize; this.#trusted=trusted; }
  async start() {
    if (this.#started || this.#closing) throw new Error('MCP transport already started or closed.');
    this.#started=true;
    const consume=this.#trusted?.beforeStart ? await this.#trusted.beforeStart() : null;
    if(this.#closing)throw Error('MCP transport closed before spawn.');
    await new Promise((resolve, reject) => {
      const snapshot=consume?.(); // Private one-shot grant, synchronously adjacent to spawn.
      if(this.#trusted?.sourceSnapshot&&(!Buffer.isBuffer(snapshot)||snapshot.length<1||snapshot.length>1024*1024))throw Error('Missing bounded private external source snapshot.');
      const child = this.#child = spawn(this.params.command, this.params.args, {
        env: this.#trusted?.cleanEnvironment ? {...this.params.env} : { ...getDefaultEnvironment(), ...this.params.env }, cwd: this.params.cwd,
        stdio: this.#trusted?.sourceSnapshot ? ['pipe', 'pipe', 'ignore', 'pipe'] : ['pipe', 'pipe', 'ignore'], shell: false,
      });
      child.once('spawn', resolve);
      child.on('error', error => { reject(error); this.onerror?.(error); });
      child.once('close', () => { if (this.#child === child) { this.#child = undefined; this.onclose?.(); } });
      if(this.#trusted?.sourceSnapshot){
        child.stdio[3].on('error',error=>{reject(error);this.onerror?.(error);});
        child.stdio[3].end(snapshot);
      }
      child.stdin.on('error', error => this.onerror?.(error));
      child.stdout.on('error', error => this.onerror?.(error));
      child.stdout.on('data', chunk => {
        if (this.#closing) return;
        let start = 0;
        while (start < chunk.length && !this.#closing) {
          const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
          const size = this.#size + end - start;
          if (size > MCP_WIRE_LIMIT) { child.stdout.destroy(); this.onOversize(wireError()); return; }
          if (size > this.#buffer.length) {
            const buffer = Buffer.allocUnsafe(Math.min(MCP_WIRE_LIMIT, Math.max(size, 4096, this.#buffer.length * 2)));
            this.#buffer.copy(buffer, 0, 0, this.#size); this.#buffer = buffer;
          }
          chunk.copy(this.#buffer, this.#size, start, end); this.#size = size;
          if (newline < 0) break;
          const line = this.#buffer.toString('utf8', 0, this.#size).replace(/\r$/, '');
          this.#buffer = Buffer.alloc(0); this.#size = 0;
          try { this.onmessage?.(deserializeMessage(line)); } catch (error) { this.onerror?.(error); }
          start = newline + 1;
        }
      });
    });
  }
  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.#child || this.#closing) return reject(new Error('MCP transport is disconnected.'));
      this.#child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
    });
  }
  close() {
    return this.#closing ??= (async () => {
      this.#buffer = Buffer.alloc(0); this.#size = 0;
      const child = this.#child;
      if (!child) return;
      let observed=child.exitCode !== null || child.signalCode !== null;
      const exited = observed ? Promise.resolve(true)
        : new Promise(resolve => { const done=()=>resolve(true);child.once('exit',done);child.once('close',done); });
      const wait = async () => {let timer;try{return await Promise.race([exited,new Promise(resolve=>timer=setTimeout(()=>resolve(false),2000))]);}finally{clearTimeout(timer);}};
      try {
        child.stdin.end();
        observed=await wait();
        if (!observed) { child.kill('SIGTERM'); observed=await wait(); }
        if (!observed) { child.kill('SIGKILL'); observed=await wait(); }
        if (!observed) throw new Error('MCP provider exit is unconfirmed; cleanup ownership is retained.');
      } finally {
        // A descendant may inherit stdout after the provider exits. Close our
        // pipe ends and notify the SDK once; never wait for that descendant.
        child.stdin.destroy(); child.stdout.destroy(); child.stdio[3]?.destroy(); child.stdio?.[3]?.destroy();
        if(observed){child.unref();if (this.#child === child) { this.#child = undefined; this.onclose?.(); }}
      }
    })();
  }
}

export function boundedResponse(response, onOversize) {
  if (!response.body) return response;
  const sse = response.ok && response.headers.get('content-type')?.includes('text/event-stream');
  let size = 0, lineHasBytes = false, previousCR = false;
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (sse) {
        // Count raw bytes until a blank SSE line, including incomplete lines and
        // unknown fields. CR, LF and split CRLF delimiters precede the SDK parser.
        for (const byte of chunk) {
          if (++size > MCP_WIRE_LIMIT) { const error = wireError(); onOversize(error); throw error; }
          if (byte === 10 && previousCR) { previousCR = false; continue; }
          previousCR = byte === 13;
          if (byte === 10 || byte === 13) { if (!lineHasBytes) size = 0; lineHasBytes = false; }
          else lineHasBytes = true;
        }
      } else if ((size += chunk.byteLength) > MCP_WIRE_LIMIT) { const error = wireError(); onOversize(error); throw error; }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
