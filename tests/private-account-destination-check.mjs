// Pure policy/source checks, no listening socket or inference network request.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateLocalModelOrigin} from '../source/local-model-http.mjs';
import {bindLocalModelTransport} from '../source/local-models.mjs';
const read=name=>readFileSync(new URL('../source/'+name,import.meta.url),'utf8');
assert.equal(validateLocalModelOrigin('http://127.0.0.1:1234'),'http://127.0.0.1:1234');
for(const endpoint of ['https://provider.example','https://127.0.0.1:1234','http://localhost:1234','http://127.0.0.1.evil.example','http://127.0.0.1:1234/proxy','http://user:secret@127.0.0.1:1234','http://127.0.0.1:1234?cloud=1']) {
  assert.throws(()=>validateLocalModelOrigin(endpoint));
  assert.throws(()=>bindLocalModelTransport({upstream:endpoint}));
}
const bound=bindLocalModelTransport({upstream:'http://127.0.0.1:1234',fetchImpl:()=>{throw Error('Fixture must never fetch');}});
assert.equal(bound.upstream,'http://127.0.0.1:1234');
assert.equal(Object.isFrozen(bound),true);
assert.throws(()=>{bound.upstream='https://provider.example';});
assert.match(read('agent.mjs'),/bindLocalModelTransport\(/);
assert.match(read('local-model-http.mjs'),/url\.origin !== origin/);
assert.match(read('local-model-http.mjs'),/Local model redirects are unsupported/);
assert.match(read('GmailAccount.swift'),/destination=="local-agent-conversation-v1"/);
assert.match(read('GmailAccountUI.swift'),/Any future cloud destination needs separate native consent/);
for(const name of ['coding-engine.mjs','coding-local.mjs']) {
  // No Gmail connector is exposed to either separate Coding engine transport.
  assert.doesNotMatch(read(name),/gmail_messages|gmail_message_metadata|GmailAccountSession/);
}
console.log('PASS: local model destination validation, immutable origin, no cloud fallback/redirect, durable Gmail destination and separate Coding exposure. No network.');
