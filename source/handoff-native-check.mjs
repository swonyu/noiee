import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { handoffPublishedState } from './handoff-native.mjs';

// Reads retained evidence only: no native helper, Git, or live checkout operations.
const evidencePath = process.argv[2] || '/private/var/folders/b1/tvm3jn711kq48mcrc1skxdn80000gn/T/saleh-handoff-stage-mUuYZU/mixed/stage-evidence.json';
const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
const plan = JSON.parse(await readFile(path.join(path.dirname(evidence.stages.destination.root.path), 'manifest.json'), 'utf8'));
assert.deepEqual(plan.stages, evidence.stages);
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
const bytes = rows => Object.values(rows).reduce((sum, row) => sum + (row.kind === 'file' ? row.bytes : row.kind === 'symlink' ? Buffer.from(row.targetBase64, 'base64').length : 0) + Object.values(row.xattrs).reduce((n, x) => n + x.bytes, 0), 0);

for (const label of ['source', 'destination']) check(`real ${label} receipt composes every namespace`, () => {
  const saved = structuredClone({ plan, receipt: evidence.published[label] });
  const receipt = evidence.published[label], stage = plan.stages[label], original = plan.native[label];
  const result = handoffPublishedState(plan, label, receipt);
  const removed = new Set(Object.keys(receipt.captured));
  const expectedLive = Object.fromEntries([...Object.entries(original.stamps).filter(([name]) => !removed.has(name)), ...Object.entries(receipt.live)]);
  assert.deepEqual(result, {
    live: { root: original.root, stamps: expectedLive, rootStamp: receipt.liveRootStamp, bytes: bytes(expectedLive), ignored: original.ignored, omitted: original.omitted },
    stage: { root: stage.root, stamps: receipt.remainingStage, rootStamp: receipt.remainingStageRootStamp, bytes: bytes(receipt.remainingStage) },
    capture: { root: stage.capture.root, stamps: receipt.capture, rootStamp: receipt.captureRootStamp, bytes: bytes(receipt.capture) },
  });
  assert(Object.hasOwn(result.live.stamps, '__proto__'));
  assert(Object.hasOwn(result.live.stamps, 'constructor'));
  assert.deepEqual(result.live.stamps.__proto__, original.stamps.__proto__);
  assert.deepEqual({ plan, receipt }, saved);
});

function rejected(name, mutate, label = 'destination') {
  check(name, () => {
    const p = structuredClone(plan), receipt = structuredClone(evidence.published[label]);
    mutate(receipt, p, label);
    assert.throws(() => handoffPublishedState(p, label, receipt), /Invalid handoff publication:/);
  });
}
rejected('extra receipt field', r => { r.extra = true; });
rejected('missing receipt field', r => { delete r.liveRootStamp; });
rejected('missing installed row', r => { delete r.live.binary; });
rejected('unexpected live row', r => { r.live.unrelated = r.live.binary; });
rejected('missing original capture mapping', r => { delete r.captured.binary; });
rejected('duplicate capture slot', r => { r.captured.binary = r.captured.text; });
rejected('noncontiguous capture slot', r => { const old = r.captured.binary; r.captured.binary = '99999999'; r.capture['99999999'] = r.capture[old]; delete r.capture[old]; });
rejected('extra capture row', r => { r.capture['99999999'] = r.capture[r.captured.binary]; });
rejected('swapped capture identities', r => { [r.captured.binary, r.captured.text] = [r.captured.text, r.captured.binary]; });
rejected('original bytes altered', r => { r.capture[r.captured.binary].sha256 = '0'.repeat(64); });
rejected('original metadata altered', r => { r.capture[r.captured.text].acl = 'changed'; });
rejected('installed inode replaced', r => { r.live.binary.identity.ino = '99999999'; });
rejected('installed byte count altered', r => { r.live.binary.bytes++; });
rejected('installed hash altered', r => { r.live.binary.sha256 = '0'.repeat(64); });
rejected('installed mode altered', r => { r.live.binary.mode ^= 1; });
rejected('installed extended attribute altered', r => { r.live.text.xattrs['user.handoff'].sha256 = '0'.repeat(64); });
rejected('installed birthtime altered', r => { r.live.binary.birthtime = '1:0'; });
rejected('installed mtime altered', r => { r.live.binary.mtime = '1:0'; });
rejected('installed symlink target altered', r => { r.live['changed-link'].targetBase64 = 'eA=='; });
rejected('extra stamp field', r => { r.live.binary.atime = '1:0'; });
rejected('invalid ctime', r => { r.live.binary.ctime = '1:1000000000'; });
rejected('ctime outside native signed seconds range', r => { r.live.binary.ctime = '9223372036854775808:0'; });
rejected('missing ctime', r => { delete r.live.binary.ctime; });
rejected('hardlink count altered', r => { r.live['linked-a'].nlink = 1; });
rejected('hardlink aliases disagree on final ctime', r => { r.live['linked-a'].ctime = '1:0'; });
rejected('new directory reuses staged inode', (r, p) => { r.live.empty.identity = p.stages.destination.stamps.empty.identity; });
rejected('new directory reuses existing unrelated inode', (r, p) => { r.live.empty.identity = p.native.destination.stamps['destination-empty'].identity; });
rejected('new directories share inode', r => { r.live.empty.identity = r.live['file-to-dir'].identity; });
rejected('new directory changes device', r => { r.live.empty.identity.dev = '99999999'; });
rejected('new directory identity has extra field', r => { r.live.empty.identity.extra = true; });
rejected('new directory inode outside native unsigned range', r => { r.live.empty.identity.ino = '18446744073709551616'; });
rejected('directory invalid nlink', r => { r.live.empty.nlink = 0; });
rejected('missing stage directory', r => { delete r.remainingStage.empty; });
rejected('unmoved stage leaf', (r, p) => { r.remainingStage.binary = p.stages.destination.stamps.binary; });
rejected('stage directory replaced', r => { r.remainingStage.empty.identity.ino = '99999999'; });
for (const field of ['liveRootStamp', 'remainingStageRootStamp', 'captureRootStamp']) {
  rejected(`${field} mtime changed`, r => { r[field].mtime = '1:0'; });
  rejected(`${field} inode changed`, r => { r[field].identity.ino = '99999999'; });
  rejected(`${field} metadata changed`, r => { r[field].flags ^= 1; });
}
rejected('before state differs from full native state', (_r, p) => { p.stages.destination.before.binary.mode ^= 1; });
rejected('before root differs from full native root', (_r, p) => { p.stages.destination.beforeRootStamp.mtime = '1:0'; });
rejected('occupied install omits original capture review', (r, p) => {
  delete p.stages.destination.before.binary;
  const slot = r.captured.binary; delete r.capture[slot]; delete r.captured.binary;
  const pairs = Object.entries(r.captured).map(([name, old], i) => [name, String(i).padStart(8, '0'), r.capture[old]]);
  r.captured = Object.fromEntries(pairs.map(([name, value]) => [name, value]));
  r.capture = Object.fromEntries(pairs.map(([, value, row]) => [value, row]));
});
check('unknown plan label', () => assert.throws(() => handoffPublishedState(plan, 'constructor', evidence.published.destination), /Invalid handoff publication:/));
check('empty publication is rejected like the native publish contract', () => {
  const p = structuredClone(plan), s = p.stages.destination;
  s.install = []; s.remove = []; s.before = {}; s.stamps = {}; s.bytes = 0;
  const r = { live: {}, capture: {}, remainingStage: {}, captured: {}, liveRootStamp: s.beforeRootStamp, remainingStageRootStamp: s.rootStamp, captureRootStamp: s.capture.rootStamp };
  assert.throws(() => handoffPublishedState(p, 'destination', r), /Invalid handoff publication: reviewed operation set/);
});

check('own special keys survive capture, install, and composition', () => {
  const p = structuredClone(plan), r = structuredClone(evidence.published.destination);
  const rename = name => ({ binary: '__proto__', text: 'constructor' }[name] || name);
  const swap = name => name === '__proto__' ? 'binary' : name === 'constructor' ? 'text' : rename(name);
  const remap = rows => Object.fromEntries(Object.entries(rows).map(([name, row]) => [swap(name), row]));
  p.native.destination.stamps = remap(p.native.destination.stamps);
  for (const field of ['before', 'stamps']) p.stages.destination[field] = remap(p.stages.destination[field]);
  for (const field of ['install', 'remove']) p.stages.destination[field] = p.stages.destination[field].map(swap);
  r.live = remap(r.live); r.captured = remap(r.captured); r.remainingStage = remap(r.remainingStage);
  const result = handoffPublishedState(p, 'destination', r);
  assert(Object.hasOwn(result.live.stamps, '__proto__'));
  assert(Object.hasOwn(result.live.stamps, 'constructor'));
  assert.deepEqual(result.live.stamps.__proto__, r.live.__proto__);
  assert.deepEqual(result.live.stamps.constructor, r.live.constructor);
});

check('retained ancestor gets actual final ctime without losing unrelated state', () => {
  const p = structuredClone(plan), r = structuredClone(evidence.published.destination), s = p.stages.destination;
  const move = rows => Object.fromEntries(Object.entries(rows).map(([name, row]) => [name === 'binary' ? 'parent/binary' : name, row]));
  p.native.destination.stamps = move(p.native.destination.stamps);
  s.before = move(s.before); s.stamps = move(s.stamps); s.install = s.install.map(name => name === 'binary' ? 'parent/binary' : name);
  r.live = move(r.live); r.captured = move(r.captured);
  const parent = { ...structuredClone(s.beforeRootStamp), identity: { dev: s.root.dev, ino: '99999991' } };
  const stagedParent = { ...structuredClone(parent), identity: { dev: s.root.dev, ino: '99999992' } };
  p.native.destination.stamps.parent = parent; s.before.parent = parent; s.stamps.parent = stagedParent;
  r.live.parent = { ...structuredClone(parent), ctime: '1:0', nlink: 3 };
  r.remainingStage.parent = { ...structuredClone(stagedParent), ctime: '2:0', nlink: 2 };
  const result = handoffPublishedState(p, 'destination', r);
  assert.equal(result.live.stamps.parent.ctime, '1:0');
  assert.deepEqual(result.live.stamps['destination-only'], p.native.destination.stamps['destination-only']);
  r.live.parent.mtime = '3:0';
  assert.throws(() => handoffPublishedState(p, 'destination', r), /Invalid handoff publication:/);
});
console.log(`PASS ${checks} checks; saved evidence ${evidencePath}`);
