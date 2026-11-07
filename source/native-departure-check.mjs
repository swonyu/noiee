// Execute actual native JavaScript with a disposable document stand-in; no app or store access.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('./App.swift', import.meta.url), 'utf8');
const asyncBridge = app.includes('webView.callAsyncJavaScript(');
function script(name, token, finishing = false, pagehide = true) {
  const section = app.slice(app.indexOf(`    private func ${name}(`));
  return section.match(/"""\n([\s\S]*?)\n        """/)[1]
    .replaceAll(String.raw`\(token)`, token)
    .replaceAll(String.raw`\(startupPageID)`, 'fixture-startup')
    .replaceAll(String.raw`\(finishing ? "true" : "false")`, String(finishing))
    .replaceAll(String.raw`\(pagehide ? "true" : "false")`, String(pagehide));
}
function fixture({inert = false, startup = false} = {}) {
  const body = {inert, dataset: {salehStartup: 'fixture-startup'}, childElementCount: 0, textContent: 'Opening your local workspace…'};
  const document = {body}, location = {href: startup ? 'about:blank' : 'http://127.0.0.1:8787/'};
  const window = {salehSaveBeforeLeave: () => true, events: [], dispatchEvent(event) {this.events.push(event.type);}};
  const context = vm.createContext({window, document, location, Event: class {constructor(type) {this.type = type;}}});
  return {body, document, location, window,
    async save(token = 'fixture-token', finishing = false, pagehide = true) {
      const code = script('departureScript', token, finishing, pagehide);
      return await vm.runInContext(asyncBridge ? `(async () => {${code}\n})()` : code, context);
    },
    replacePage() {context.document = {body};},
    release(token = 'fixture-token') {vm.runInContext(script('releaseDepartureScript', token), context);},
  };
}
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}

{
  const f = fixture(), first = deferred(); let settled = false;
  f.window.salehSaveBeforeLeave = () => first.promise;
  const saving = f.save().then(value => {settled = true; return value;});
  await Promise.resolve();
  assert.equal(f.body.inert, true, 'The original body must be held before the first pending save yields');
  assert.equal(f.window.__salehDraftDeparture?.body, f.body);
  assert.equal(settled, false, 'A pending Promise cannot admit departure');
  assert.equal(await f.save('other-token'), false, 'Another departure cannot replace the pending hold');
  f.release('other-token'); assert.equal(f.body.inert, true);
  first.resolve(true); assert.equal(await saving, true); assert.equal(f.window.events.length, 0);
  const final = deferred(); settled = false; f.window.salehSaveBeforeLeave = () => final.promise;
  const finishing = f.save('fixture-token', true).then(value => {settled = true; return value;});
  await Promise.resolve(); assert.equal(settled, false); assert.equal(f.window.events.length, 0);
  final.resolve(true); assert.equal(await finishing, true); assert.deepEqual(f.window.events, ['pagehide']);
  f.release(); assert.equal(f.body.inert, false); assert.equal(f.window.__salehDraftDeparture, undefined);
}
for (const finishing of [false, true]) for (const outcome of [false, undefined, 1, 'true', {}, 'reject']) {
  const f = fixture({inert: finishing}), wait = deferred();
  if (finishing) assert.equal(await f.save(), true);
  f.window.salehSaveBeforeLeave = () => wait.promise;
  const saving = f.save('fixture-token', finishing);
  await Promise.resolve(); assert.equal(f.body.inert, true); assert.deepEqual(f.window.events, []);
  if (outcome === 'reject') {wait.reject(Error('Injected durable-save failure')); await assert.rejects(saving, /Injected durable-save failure/);}
  else {wait.resolve(outcome); assert.equal(await saving, false, 'Only exact resolved true admits departure');}
  assert.equal(f.body.inert, finishing, 'Failure restores the recorded inert state');
  assert.equal(f.window.__salehDraftDeparture, undefined);
  assert.deepEqual(f.window.events, []);
}
for (const finishing of [false, true]) for (const changed of ['body', 'page', 'token', 'hold', 'href', 'late-edit']) {
  const f = fixture(), wait = deferred();
  if (finishing) assert.equal(await f.save(), true);
  f.window.salehSaveBeforeLeave = () => wait.promise;
  const saving = f.save('fixture-token', finishing); await Promise.resolve();
  if (changed === 'body') f.document.body = {inert: false};
  if (changed === 'page') f.replacePage();
  if (changed === 'token') f.window.__salehDraftDeparture.token = 'other-token';
  if (changed === 'hold') f.window.__salehDraftDeparture = {token: 'other-token', body: f.body, inert: true};
  if (changed === 'href') f.location.href += '#changed-page';
  wait.resolve(changed !== 'late-edit');
  assert.equal(await saving, false, `${changed} during ${finishing ? 'final' : 'initial'} save must retain the window`);
  assert.equal(f.body.inert, false, 'Failure restores the original held body, even after replacement');
  assert.deepEqual(f.window.events, []);
  if (changed === 'token' || changed === 'hold') assert.equal(f.window.__salehDraftDeparture.token, 'other-token', 'Failure cannot delete a different token');
}
{
  const f = fixture({inert: true}); assert.equal(await f.save(), true);
  assert.equal(await f.save('fixture-token', true, false), true); assert.deepEqual(f.window.events, []);
  f.release(); assert.equal(f.body.inert, true, 'Reload release retains the prior inert state');
}
for (const startup of [false, true]) {
  const f = fixture({startup}); delete f.window.salehSaveBeforeLeave;
  assert.equal(await f.save(), startup, 'Missing saver is permitted only for the exact native startup page');
  if (startup) {assert.equal(await f.save('fixture-token', true), true); f.release();}
  assert.equal(f.body.inert, false);
}
for (const change of [f => {f.body.dataset.salehStartup = 'foreign';}, f => {f.body.childElementCount = 1;}, f => {f.body.textContent += 'changed';}]) {
  const f = fixture({startup: true}); delete f.window.salehSaveBeforeLeave; change(f);
  assert.equal(await f.save(), false); assert.equal(f.body.inert, false);
}
assert.equal(asyncBridge, true, 'WebKit must use its Promise-aware callAsyncJavaScript API');
console.log('PASS: actual native departure scripts await both flushes; pending/failing/nonboolean saves, changed body/token/hold/page, late edits, startup exception, pagehide and exact inert restoration');
