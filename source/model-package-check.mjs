import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const script=await readFile(new URL('build-app.sh',import.meta.url),'utf8');
assert.match(script,/cp [^\n]*\blocal-models\.mjs\b[^\n]*Contents\/Resources/, 'native packaging includes the local model catalog');
console.log('PASS: native package contains shared local model catalog');
