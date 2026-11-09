// Fully offline synthetic transport tests. No network, downloaded code execution, or app access.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {parseExternalArtifactInstall, createExternalArtifactDownloader, validateExternalArtifactResult, isPublicArtifactAddress, EXTERNAL_ARTIFACT_MAX_BYTES} from './external-artifact-download.mjs';
const body = Buffer.from('globalThis.__externalArtifactExecuted = true; throw new Error("never execute");\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const input = {action:'install',url:`https://raw.githubusercontent.com/owner/repo/${'a'.repeat(40)}/tools/test.mjs`,sha256:hash(body),purpose:'Synthetic test only'};
assert.deepEqual(parseExternalArtifactInstall(input), input);
for (const patch of [{extra:true},{action:'run'},{sha256:'A'.repeat(64)},{purpose:''},{purpose:' '.repeat(10)},{purpose:'x'.repeat(501)},{purpose:'line\nbreak'},{purpose:'\u007f'},{purpose:'é'}]) assert.throws(() => parseExternalArtifactInstall({...input,...patch}));
for (const url of [input.url.replace('https:','http:'),input.url.replace('raw.githubusercontent.com','raw.githubusercontent.com.evil.test'),input.url.replace('raw.githubusercontent.com','raw.githubusercontent.com:443'),input.url.replace('raw.githubusercontent.com','u@raw.githubusercontent.com'),input.url.replace('raw.githubusercontent.com','RAW.githubusercontent.com'),input.url+'?x',input.url+'#x',input.url.replace('/tools/','/../'),input.url.replace('/tools/','/%2e/'),input.url.replace('/tools/','/foo\\bar/'),input.url.replace('a'.repeat(40),'main'),input.url.replace('.mjs','.zip'),input.url.replace('owner','öwner')]) assert.throws(() => parseExternalArtifactInstall({...input,url}));
for (const ip of ['0.1.2.3','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.16.1.1','192.0.2.1','192.168.1.1','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::1','::','::ffff:8.8.8.8','::ffff:808:808','fc00::1','fe80::1','2001:db8::1','2002:808:808::1','64:ff9b::808:808','3fff::1','3ffe::1','2000::1']) assert.equal(isPublicArtifactAddress(ip),false,ip);
assert(isPublicArtifactAddress('185.199.108.133')); assert(isPublicArtifactAddress('2606:50c0:8000::154'));
function fixture(config = {}) {
  let calls = 0, destroyed = 0, dnsCalls = 0, responseDestroyed = 0;
  const download = createExternalArtifactDownloader({timeoutMs:config.timeoutMs ?? 100, lookup:async (host,options) => { dnsCalls++; assert.equal(host,'raw.githubusercontent.com'); assert.equal(options.all,true); if(config.dnsError) throw Error('Synthetic DNS failure'); if(config.dnsWait) await delay(config.dnsWait); return config.answers ?? [{address:'185.199.108.133',family:4}]; }, request:(url,options,callback) => {
    calls++; if(config.requestError) throw Error('Synthetic request failure'); assert.equal(url,input.url); assert.equal(options.agent,false); assert.equal(options.servername,'raw.githubusercontent.com'); assert.equal(options.rejectUnauthorized,true); assert.equal(options.maxHeaderSize,4096); assert.equal(options.headers,undefined);
    options.lookup('raw.githubusercontent.com',{},(error,address,family) => {assert.equal(error,null); assert.equal(address,(config.answers ?? [{address:'185.199.108.133'}])[0].address); assert.equal(family,(config.answers ?? [{family:4}])[0].family);});
    const req = new EventEmitter(); req.destroy = () => {destroyed++;}; req.end = () => queueMicrotask(() => {
      if (config.requestWait) return;
      const res = new EventEmitter(); res.statusCode=config.status ?? 200; res.socket={encrypted:true,authorized:true,remoteAddress:config.remote ?? '185.199.108.133',...config.socket}; res.rawHeaders=config.headers ?? ['Content-Length',String((config.body ?? body).length)]; res.complete=config.complete ?? true; res.destroy=()=>{responseDestroyed++;}; callback(res);
      if (config.streamWait) return;
      for (const chunk of config.chunks ?? [config.body ?? body]) res.emit('data',chunk);
      if(config.close) res.emit('close'); else res.emit('end');
    }); return req;
  }});
  return {download, counts:()=>({calls,destroyed,dnsCalls,responseDestroyed})};
}
const good=fixture(); const result=await good.download(input); assert.equal(result.base64,body.toString('base64')); assert.equal(result.sourceTrust,'unreviewed-external'); assert.equal(validateExternalArtifactResult(result,input),result); assert.equal(globalThis.__externalArtifactExecuted,undefined); assert.equal(good.counts().calls,1);
for(const patch of [{extra:true},{bytes:0},{version:2},{sourceTrust:'trusted'},{base64:result.base64+'\n'},{sha256:'b'.repeat(64)},{url:input.url+'#x'}]) assert.throws(()=>validateExternalArtifactResult({...result,...patch},input));
const cases=[
 [{dnsError:true},/DNS failure/], [{requestError:true},/request failure/], [{answers:[]},/DNS/], [{answers:Array(9).fill({address:'8.8.8.8',family:4})},/DNS/], [{answers:[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]},/DNS/], [{answers:[{address:'8.8.8.8',family:6}]},/DNS/],
 [{remote:'127.0.0.1'},/peer/], [{remote:'185.199.109.133'},/peer/], [{socket:{authorized:false}},/peer/], [{socket:{encrypted:false}},/peer/], [{status:302},/redirects/], [{status:404},/200/],
 [{headers:['Content-Encoding','gzip']},/Encoded/], [{headers:['Transfer-Encoding','compress']},/transfer/], [{headers:['Content-Length','1','Content-Length','1']},/Duplicate/], [{headers:['Content-Length','1','Transfer-Encoding','chunked']},/Ambiguous/], [{headers:['X-Large','x'.repeat(4096)]},/headers/], [{headers:['Content-Length','1048577']},/Content-Length/], [{headers:['Content-Length','-1']},/Content-Length/], [{headers:['Content-Length','01']},/Content-Length/],
 [{headers:[],chunks:[Buffer.alloc(EXTERNAL_ARTIFACT_MAX_BYTES),Buffer.from('x')]},/limit/], [{headers:['Content-Length','1']},/limit/], [{headers:['Content-Length','999']},/Incomplete/], [{complete:false},/Incomplete/], [{close:true},/closed/], [{body:Buffer.from('mismatch')},/mismatch/], [{body:Buffer.from([0xc3,0x28])},/encoded|encoding/i], [{body:Buffer.from([0])},/NUL/], [{body:Buffer.alloc(0)},/Content-Length/], [{chunks:['not a buffer']},/stream/], [{requestWait:true,timeoutMs:5},/timed out/], [{streamWait:true,timeoutMs:5},/timed out/], [{dnsWait:15,timeoutMs:5},/timed out/]
];
for (const [config,pattern] of cases) { const f=fixture(config); await assert.rejects(f.download(input),pattern); assert(f.counts().calls<=1); if(config.dnsWait) {await delay(20);assert.equal(f.counts().calls,0);} }
for(const config of [{dnsWait:15},{requestWait:true},{streamWait:true}]) {const f=fixture(config);const controller=new AbortController();const pending=f.download(input,{signal:controller.signal});await delay(1);controller.abort();await assert.rejects(pending,/aborted/);await delay(20);assert(f.counts().calls<=1);if(config.dnsWait)assert.equal(f.counts().calls,0);else assert.equal(f.counts().destroyed,1);}
{const f=fixture();const controller=new AbortController();controller.abort();await assert.rejects(f.download(input,{signal:controller.signal}),/aborted/);assert.equal(f.counts().dnsCalls,0);}
{const f=fixture({headers:['Transfer-Encoding','chunked'],chunks:[body.subarray(0,5),body.subarray(5)]});assert.equal((await f.download(input)).sha256,input.sha256);}
{const f=fixture({answers:[{address:'2606:50c0:8000::154',family:6}],remote:'2606:50c0:8000:0:0:0:0:154'});assert.equal((await f.download(input)).sha256,input.sha256);}
{const bytes=Buffer.alloc(EXTERNAL_ARTIFACT_MAX_BYTES,0x61);const f=fixture({body:bytes});const result=await f.download({...input,sha256:hash(bytes)});assert.equal(result.bytes,EXTERNAL_ARTIFACT_MAX_BYTES);}
console.log('PASS strict external-artifact parser, DNS pinning, peer/TLS checks, bounded inert stream, timeout/abort, hash and response validation (offline only)');
