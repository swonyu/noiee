// Inert artifact transport. Never imports, evaluates, probes, installs, or executes bytes.
import {lookup as systemLookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';

export const EXTERNAL_ARTIFACT_MAX_BYTES = 1024 * 1024;
const MAX_HEADERS = 4096;
const keysAre = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export function parseExternalArtifactInstall(input) {
  if (!keysAre(input, ['action', 'url', 'sha256', 'purpose']) || input.action !== 'install') throw Error('Invalid external install request');
  const {url, sha256, purpose} = input;
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw Error('Invalid SHA-256');
  if (typeof purpose !== 'string' || !/^[\x20-\x7e]{1,500}$/.test(purpose) || !purpose.trim()) throw Error('Invalid purpose');
  // Intentionally narrow: immutable GitHub raw single-file modules, no URL normalization.
  if (typeof url !== 'string' || url.length > 2048 || !/^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/[a-f0-9]{40}\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(url)) throw Error('Unsupported artifact URL');
  const parsed = new URL(url);
  if (parsed.href !== url || parsed.pathname.split('/').some(p => p === '.' || p === '..')) throw Error('Noncanonical artifact URL');
  return {action: 'install', url, sha256, purpose};
}

export function isPublicArtifactAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%') || address.includes('.')) return false;
  // Conservative IPv6 allowlist: GitHub's public 2606:50c0::/32 only.
  // No mapped, compatible, transition, documentation, reserved or local ranges.
  const parts = address.toLowerCase().split(':');
  return parseInt(parts[0], 16) === 0x2606 && parseInt(parts[1], 16) === 0x50c0;
}
function addressIdentity(address) {
  if (isIP(address) === 4) return address;
  if (isIP(address) === 6) return new URL(`https://[${address}]/`).hostname;
  return null;
}
function checkBytes(bytes, sha256) {
  if (!bytes.length || bytes.length > EXTERNAL_ARTIFACT_MAX_BYTES || bytes.includes(0)) throw Error('Invalid artifact size or NUL byte');
  new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('Artifact SHA-256 mismatch');
}
export function validateExternalArtifactResult(result, proposed) {
  const input = parseExternalArtifactInstall(proposed);
  if (!keysAre(result, ['version','url','sha256','bytes','base64','sourceTrust']) || result.version !== 1 || result.url !== input.url || result.sha256 !== input.sha256 || result.sourceTrust !== 'unreviewed-external' || !Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > EXTERNAL_ARTIFACT_MAX_BYTES || typeof result.base64 !== 'string' || result.base64.length > Math.ceil(EXTERNAL_ARTIFACT_MAX_BYTES / 3) * 4) throw Error('Invalid artifact response');
  const bytes = Buffer.from(result.base64, 'base64');
  if (bytes.length !== result.bytes || bytes.toString('base64') !== result.base64) throw Error('Invalid artifact encoding');
  checkBytes(bytes, input.sha256);
  return result;
}

// Injection is for trusted offline tests only; never populate these options from wire input.
export function createExternalArtifactDownloader({lookup = systemLookup, request = httpsRequest, timeoutMs = 20000} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw Error('Invalid download timeout');
  return function download(proposed, {signal} = {}) {
    const input = parseExternalArtifactInstall(proposed);
    return new Promise((resolve, reject) => {
      let settled = false, req, response;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) { response?.destroy(); req?.destroy(); reject(error); }
        else resolve(value);
      };
      const abort = () => finish(Error('Artifact download aborted'));
      const timer = setTimeout(() => finish(Error('Artifact download timed out')), timeoutMs);
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) { abort(); return; }
      (async () => {
        const answers = await lookup('raw.githubusercontent.com', {all: true, verbatim: true});
        if (settled) return;
        if (!Array.isArray(answers) || answers.length < 1 || answers.length > 8 || answers.some(a => !a || !isPublicArtifactAddress(a.address) || isIP(a.address) !== a.family)) throw Error('Untrusted artifact DNS answers');
        const selected = answers[0];
        const pinnedLookup = (hostname, options, callback) => {
          if (typeof options === 'function') { callback = options; options = {}; }
          if (hostname !== 'raw.githubusercontent.com') { callback(Error('Unexpected lookup hostname')); return; }
          callback(null, ...(options?.all ? [[{address: selected.address, family: selected.family}]] : [selected.address, selected.family]));
        };
        req = request(input.url, {method: 'GET', agent: false, lookup: pinnedLookup, servername: 'raw.githubusercontent.com', rejectUnauthorized: true, maxHeaderSize: MAX_HEADERS}, res => {
          response = res;
          if (settled) { res.destroy(); return; }
          res.on('error', error => finish(error));
          res.on('aborted', () => finish(Error('Artifact response aborted')));
          try {
            if (!res.socket || !res.socket.encrypted || res.socket.authorized !== true || addressIdentity(res.socket.remoteAddress) !== addressIdentity(selected.address)) throw Error('Artifact peer does not match pinned TLS address');
            if (res.statusCode !== 200) throw Error('Artifact response must be HTTP 200; redirects forbidden');
            const raw = res.rawHeaders;
            if (!Array.isArray(raw) || raw.length % 2 || raw.some(v => typeof v !== 'string') || raw.reduce((n,v) => n + Buffer.byteLength(v) + 2, 0) + 64 > MAX_HEADERS) throw Error('Artifact headers too large');
            const headers = new Map();
            for (let i = 0; i < raw.length; i += 2) { const key = raw[i].toLowerCase(); if (headers.has(key) && ['content-length','content-encoding','transfer-encoding'].includes(key)) throw Error('Duplicate framing header'); headers.set(key, raw[i+1]); }
            if (headers.has('content-encoding') && headers.get('content-encoding').toLowerCase() !== 'identity') throw Error('Encoded artifact forbidden');
            if (headers.has('transfer-encoding') && headers.get('transfer-encoding').toLowerCase() !== 'chunked') throw Error('Unexpected transfer encoding');
            if (headers.has('transfer-encoding') && headers.has('content-length')) throw Error('Ambiguous artifact framing');
            let expected = null;
            if (headers.has('content-length')) { const length = headers.get('content-length'); if (!/^(0|[1-9][0-9]{0,6})$/.test(length) || Number(length) < 1 || Number(length) > EXTERNAL_ARTIFACT_MAX_BYTES) throw Error('Invalid artifact Content-Length'); expected = Number(length); }
            const chunks = []; let size = 0;
            res.on('data', chunk => {
              if (settled) return;
              if (!Buffer.isBuffer(chunk)) { finish(Error('Unexpected artifact stream encoding')); return; }
              size += chunk.length;
              if (size > EXTERNAL_ARTIFACT_MAX_BYTES || (expected !== null && size > expected)) { finish(Error('Artifact exceeds byte limit')); return; }
              chunks.push(chunk);
            });
            res.on('end', () => {
              if (settled) return;
              try {
                if (res.complete !== true || (expected !== null && size !== expected)) throw Error('Incomplete artifact response');
                const bytes = Buffer.concat(chunks, size); checkBytes(bytes, input.sha256);
                finish(null, {version:1, url:input.url, sha256:input.sha256, bytes:size, base64:bytes.toString('base64'), sourceTrust:'unreviewed-external'});
              } catch (error) { finish(error); }
            });
            res.on('close', () => { if (!settled) finish(Error('Artifact response closed early')); });
          } catch (error) { finish(error); }
        });
        req.on('error', error => finish(error));
        if (settled) req.destroy(); else req.end();
      })().catch(error => finish(error));
    });
  };
}
export const downloadExternalArtifact = createExternalArtifactDownloader();
