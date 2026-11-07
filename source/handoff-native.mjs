import {nativeByteSizes} from './handoff-storage.mjs';
import { isDeepStrictEqual } from 'node:util';

// Pure validation of HandoffFiles.publish's receipt against an immutable plan.
// The caller must independently snapshot these expected states and scan namespaces
// before completing the transaction. A plausible receipt alone proves no IO.
const fail = message => { throw new Error(`Invalid handoff publication: ${message}`); };
const require = (condition, message) => { if (!condition) fail(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key);
const same = (a, b, message) => require(isDeepStrictEqual(a, b), message);
const identity = row => `${row.identity.dev}:${row.identity.ino}`;
const time = value => {
  if (typeof value !== 'string' || !/^-?(0|[1-9]\d{0,18}):(0|[1-9]\d{0,8})$/.test(value)) return false;
  const seconds = BigInt(value.split(':')[0]);
  return seconds >= -9223372036854775808n && seconds <= 9223372036854775807n;
};
const keys = (value, expected, message) => {
  require(record(value), message);
  same(Object.keys(value).sort(), [...expected].sort(), message);
};
const without = (row, excluded) => Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.includes(key)));

function rowMatches(actual, reviewed, message, newDirectory = false) {
  require(record(actual) && record(reviewed), message);
  require(own(actual, 'ctime') && time(actual.ctime), `${message}: ctime`);
  require(Number.isSafeInteger(actual.nlink) && actual.nlink > 0, `${message}: link count`);
  const excluded = ['ctime'];
  if (reviewed.kind === 'directory') excluded.push('nlink');
  if (newDirectory) excluded.push('identity');
  same(without(actual, excluded), without(reviewed, excluded), message);
  if (newDirectory) {
    keys(actual.identity, ['dev', 'ino'], `${message}: identity`);
    require(actual.identity.dev === reviewed.identity.dev && typeof actual.identity.ino === 'string' && /^[1-9]\d{0,19}$/.test(actual.identity.ino) && BigInt(actual.identity.ino) <= 18446744073709551615n, `${message}: identity`);
  }
}

function state(root, stamps, rootStamp) {
  require(record(root) && rootStamp.kind === 'directory', 'root descriptor');
  same(rootStamp.identity, { dev: root.dev, ino: root.ino }, 'root identity');
  require(Object.keys(stamps).length <= 20000, 'selected path limit');
  let bytes = 0;
  const groups = new Map();
  for (const [name, row] of Object.entries(stamps)) {
    require(row.identity.dev === root.dev && identity(row) !== identity(rootStamp), `entry identity: ${name}`);
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      require(own(stamps, parent) && stamps[parent].kind === 'directory', `missing directory: ${parent}`);
    }
    const group = groups.get(identity(row)) || [];
    group.push(row); groups.set(identity(row), group);
    for (const value of nativeByteSizes(row)) {
      require(Number.isSafeInteger(value) && value >= 0 && value <= 32 * 1024 * 1024, `entry byte limit: ${name}`);
      bytes += value;
      require(bytes <= 128 * 1024 * 1024, 'selected byte limit');
    }
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (first.kind === 'directory') require(group.length === 1, 'directory identity reused');
    else {
      require(first.nlink === group.length && (first.kind !== 'symlink' || group.length === 1), 'incomplete hardlink group');
      for (const row of group) same(row, first, 'hardlink aliases differ');
    }
  }
  return { root, stamps, rootStamp, bytes };
}

export function handoffPublishedState(plan, label, receipt) {
  require(['source', 'destination'].includes(label) && own(plan?.native, label) && own(plan?.stages, label), 'plan label');
  const original = plan.native[label], candidate = plan.stages[label];
  require(record(original.stamps) && record(candidate.stamps) && record(candidate.before), 'reviewed stamps');
  require(Array.isArray(candidate.install) && Array.isArray(candidate.remove), 'reviewed operations');
  const install = new Set(candidate.install), remove = new Set(candidate.remove);
  require(install.size === candidate.install.length && remove.size === candidate.remove.length && install.size + remove.size > 0, 'reviewed operation set');
  const captured = new Set([...remove, ...[...install].filter(name => own(candidate.before, name))]);
  for (const name of remove) require(!install.has(name) && own(candidate.before, name), `unreviewed removal: ${name}`);
  for (const name of install) require(own(candidate.stamps, name) && own(original.stamps, name) === own(candidate.before, name), `unreviewed install: ${name}`);
  for (const [name, row] of Object.entries(candidate.before)) {
    require(own(original.stamps, name), `missing original: ${name}`);
    same(row, original.stamps[name], `original changed: ${name}`);
    require(captured.has(name) || row.kind === 'directory', `uncaptured original leaf: ${name}`);
  }
  same(candidate.beforeRootStamp, original.rootStamp, 'original root changed');
  for (const [name, row] of Object.entries(candidate.stamps)) require(install.has(name) || (row.kind === 'directory' && own(candidate.before, name) && !captured.has(name)), `uninstalled staged leaf: ${name}`);
  keys(candidate.capture.stamps, [], 'capture was not empty');
  keys(receipt, ['live', 'capture', 'remainingStage', 'captured', 'liveRootStamp', 'remainingStageRootStamp', 'captureRootStamp'], 'receipt fields');
  keys(receipt.live, new Set([...Object.keys(candidate.before).filter(name => !captured.has(name)), ...install]), 'live path set');
  keys(receipt.captured, captured, 'captured path set');
  const slots = [...captured].map((_, i) => String(i).padStart(8, '0'));
  require(Object.values(receipt.captured).every(slot => typeof slot === 'string'), 'capture slots');
  same(Object.values(receipt.captured).sort(), slots, 'capture slots');
  keys(receipt.capture, slots, 'capture path set');
  const stageDirectories = Object.keys(candidate.stamps).filter(name => candidate.stamps[name].kind === 'directory');
  keys(receipt.remainingStage, stageDirectories, 'remaining stage path set');

  const knownIdentities = new Set([original.rootStamp, candidate.rootStamp, candidate.capture.rootStamp, ...Object.values(original.stamps), ...Object.values(candidate.stamps)].map(identity));
  for (const name of captured) rowMatches(receipt.capture[receipt.captured[name]], candidate.before[name], `captured original: ${name}`);
  for (const [name, row] of Object.entries(receipt.live)) {
    if (!install.has(name)) rowMatches(row, candidate.before[name], `retained ancestor: ${name}`);
    else {
      const reviewed = candidate.stamps[name], newDirectory = reviewed.kind === 'directory';
      rowMatches(row, reviewed, `installed entry: ${name}`, newDirectory);
      if (newDirectory) {
        require(!knownIdentities.has(identity(row)), `new directory identity reused: ${name}`);
        knownIdentities.add(identity(row));
      }
    }
  }
  for (const name of stageDirectories) rowMatches(receipt.remainingStage[name], candidate.stamps[name], `remaining stage directory: ${name}`);
  rowMatches(receipt.liveRootStamp, original.rootStamp, 'live root');
  rowMatches(receipt.remainingStageRootStamp, candidate.rootStamp, 'stage root');
  rowMatches(receipt.captureRootStamp, candidate.capture.rootStamp, 'capture root');

  // Object.fromEntries creates literal own properties for __proto__/constructor.
  // Unaffected rows retain exact original ctime; mutated rows retain receipt ctime.
  const live = Object.fromEntries([...Object.entries(original.stamps).filter(([name]) => !captured.has(name)), ...Object.entries(receipt.live)]);
  const result = {
    live: { ...state(original.root, live, receipt.liveRootStamp), ignored: original.ignored, omitted: original.omitted },
    stage: state(candidate.root, receipt.remainingStage, receipt.remainingStageRootStamp),
    capture: state(candidate.capture.root, receipt.capture, receipt.captureRootStamp),
  };
  const namespace = new Map();
  for (const [label, value] of Object.entries(result)) for (const row of [value.rootStamp, ...Object.values(value.stamps)]) {
    const id = identity(row);
    require(!namespace.has(id) || namespace.get(id) === label, 'inode shared between publication namespaces');
    namespace.set(id, label);
  }
  return result;
}
