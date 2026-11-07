import http from 'node:http';
import {Readable} from 'node:stream';

export function validateLocalModelOrigin(value) {
  let url;try{url=new URL(value);}catch{throw Error('Local models require an HTTP loopback origin.');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Local models require an HTTP loopback origin without credentials or a path.');
  return url.origin;
}
// Deliberately supports only the app's serialized, same-origin model requests.
export function createLocalModelHTTPTransport(value) {
  const origin = validateLocalModelOrigin(value);
  return async function localModelHTTP(input, init) {
    if (typeof input !== 'string' || !init || typeof init !== 'object' || Array.isArray(init)) throw Error('Invalid local model HTTP request.');
    const url = new URL(input);
    if (input !== origin + url.pathname || url.origin !== origin || url.username || url.password || url.search || url.hash) throw Error('Local model request must use its captured loopback origin.');
    const inventory = init.method === 'GET' && url.pathname === '/api/v1/models';
    const inference = init.method === 'POST' && ['/v1/chat/completions','/v1/responses'].includes(url.pathname);
    if ((!inventory && !inference) || (inventory ? init.body !== undefined : typeof init.body !== 'string')) throw Error('Unsupported local model route, method or body.');
    if (init.redirect !== 'error' || !(init.signal instanceof AbortSignal) || Object.keys(init).some(key => !['method','redirect','signal','headers','body'].includes(key))) throw Error('Unsupported local model HTTP options.');
    const headers = new Headers(init.headers);
    headers.set('Accept-Encoding','identity');
    const signal = init.signal;
    signal.throwIfAborted();
    return new Promise((resolve,reject) => {
      let request, response, timer, settled = false, cleaned = false;
      const clearConnect = () => {if (timer !== undefined) {clearTimeout(timer);timer = undefined;}};
      const cleanup = () => {if (!cleaned) {cleaned = true;clearConnect();signal.removeEventListener('abort',abort);}};
      const fail = error => {
        if (!settled) {settled = true;reject(error);}
        cleanup();
        // Destroy the incoming stream first so its web bridge gets the exact reason.
        response?.destroy(error);
        request?.destroy(error);
      };
      const abort = () => fail(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) {abort();return;}
      timer = setTimeout(() => fail(Error('Local model connection timed out.')),10000);
      try {
        request = http.request(url,{method:init.method,headers:Object.fromEntries(headers),agent:false});
        request.on('error',error => fail(signal.aborted ? signal.reason : error));
        request.once('close',() => {if (!settled) fail(signal.aborted ? signal.reason : Error('Local model connection closed before response headers.'));});
        request.once('socket',socket => {if (socket.connecting) socket.once('connect',clearConnect);else clearConnect();});
        request.once('upgrade',(incoming,socket) => {
          incoming.on('error',() => {});
          incoming.destroy();socket.destroy();
          fail(Error('Local model HTTP upgrades are unsupported.'));
        });
        request.once('response',incoming => {
          response = incoming;
          clearConnect();
          // Retain this listener through destruction, including pre-body rejection.
          incoming.on('error',cleanup);
          incoming.once('end',cleanup);
          incoming.once('close',() => {cleanup();request.destroy();});
          if (signal.aborted) {abort();return;}
          if (incoming.statusCode >= 300 && incoming.statusCode < 400) {fail(Error('Local model redirects are unsupported.'));return;}
          const encoding = incoming.headers['content-encoding'];
          if (encoding && encoding.trim().toLowerCase() !== 'identity') {fail(Error('Unsupported local model content encoding.'));return;}
          try {
            const responseHeaders = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) responseHeaders.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
            const bodyless = incoming.statusCode === 204 || incoming.statusCode === 205;
            const result = new Response(bodyless ? null : Readable.toWeb(incoming),{status:incoming.statusCode,statusText:incoming.statusMessage,headers:responseHeaders});
            settled = true;resolve(result);
            if (bodyless) {incoming.destroy();request.destroy();cleanup();}
          } catch (error) {fail(error);}
        });
        if (cleaned) {request.destroy(signal.reason);return;}
        request.end(init.body);
      } catch (error) {fail(error);}
    });
  };
}
