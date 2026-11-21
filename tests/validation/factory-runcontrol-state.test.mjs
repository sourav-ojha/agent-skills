// factory phase 2 run control: run state, attention view, notifications.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpDir } from './helpers.mjs';

const L = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const rs = await import(path.join(L, 'runstate.mjs'));
const at = await import(path.join(L, 'attention.mjs'));
const nt = await import(path.join(L, 'notify.mjs'));

test('updateRun merges, keeps other fields, stamps updated_at', () => {
  const home = tmpDir();
  assert.equal(rs.readRun(home, 'a__b'), null);
  rs.updateRun(home, 'a__b', { run_id: 'r1', status: 'running', step: 'verify', counters: { n: 1 } });
  const o = rs.updateRun(home, 'a__b', { status: 'paused', pause: { kind: 'limit', reset_at: 'x', estimated: true } });
  assert.equal(o.run_id, 'r1'); assert.equal(o.step, 'verify'); assert.equal(o.status, 'paused');
  assert.deepEqual(rs.readRun(home, 'a__b').counters, { n: 1 });
  assert.ok(o.updated_at);
  assert.equal(fs.statSync(path.join(home, 'runs')).mode & 0o777, 0o700);
});
test('invalid status and bad key throw', () => {
  const home = tmpDir();
  assert.throws(() => rs.updateRun(home, 'a__b', { status: 'bogus' }));
  assert.throws(() => rs.updateRun(home, '../x', { status: 'running' }));
});
test('corrupt run file makes readRun and updateRun throw', () => {
  const home = tmpDir();
  rs.updateRun(home, 'a__b', { status: 'running' });
  fs.writeFileSync(path.join(home, 'runs', 'a__b.json'), '{nope');
  assert.throws(() => rs.readRun(home, 'a__b'));
  assert.throws(() => rs.updateRun(home, 'a__b', { status: 'paused' }));
});
test('attention add, dedupe, resolve, render', () => {
  const home = tmpDir();
  const it = { id: 'f1', kind: 'review', severity: 'high', what: 'needs a | look', run: 'factory resume --key a__b' };
  at.addAttention(home, 'a__b', it);
  at.addAttention(home, 'a__b', { ...it, what: 'again' });
  assert.equal(at.listAttention(home, 'a__b').length, 1);
  const md = fs.readFileSync(path.join(home, 'attention', 'a__b.md'), 'utf8');
  assert.match(md, /Severity/); assert.ok(md.includes('factory resume --key a__b'));
  assert.equal(md.split('\n').filter((l) => l.includes('f1')).length, 1);
  assert.equal(at.resolveAttention(home, 'a__b', { id: 'f1', kind: 'review' }), true);
  assert.equal(at.resolveAttention(home, 'a__b', { id: 'f1', kind: 'review' }), false);
  assert.deepEqual(at.listAttention(home, 'a__b'), []);
  assert.ok(!fs.readFileSync(path.join(home, 'attention', 'a__b.md'), 'utf8').includes('f1'));
});
test('attention requires run, valid severity; corrupt state throws; jsonl untouched', () => {
  const home = tmpDir();
  assert.throws(() => at.addAttention(home, 'a__b', { id: 'x', kind: 'k', severity: 'high', what: 'w' }));
  assert.throws(() => at.addAttention(home, 'a__b', { id: 'x', kind: 'k', severity: 'low', what: 'w', run: 'r' }));
  fs.mkdirSync(path.join(home, 'attention'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, 'attention', 'a__b.jsonl'), 'LOG\n');
  at.addAttention(home, 'a__b', { id: 'x', kind: 'k', severity: 'medium', what: 'w', run: 'r' });
  assert.equal(fs.readFileSync(path.join(home, 'attention', 'a__b.jsonl'), 'utf8'), 'LOG\n');
  fs.writeFileSync(path.join(home, 'attention', 'a__b.json'), '[oops');
  assert.throws(() => at.listAttention(home, 'a__b'));
  assert.throws(() => at.addAttention(home, 'a__b', { id: 'y', kind: 'k', severity: 'high', what: 'w', run: 'r' }));
});
test('notify on darwin runs osascript by argv with key and count only', () => {
  const calls = [];
  const run = (...a) => { calls.push(a); return { status: 0 }; };
  const ok = nt.notify('paused', { key: 'a__b', count: 3, featureId: 'F-SECRET', title: 'Secret title' }, { run, platform: 'darwin' });
  assert.equal(ok, true); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript'); assert.deepEqual(calls[0][1].slice(0, 1), ['-e']);
  const text = calls[0][1][1];
  assert.ok(text.includes('a__b') && text.includes('3'));
  assert.ok(!/SECRET|Secret/.test(JSON.stringify(calls)));
});
test('notify off darwin is false without calling; bad key or event rejected', () => {
  let n = 0; const run = () => { n++; return { status: 0 }; };
  assert.equal(nt.notify('finished', { key: 'a__b', count: 1 }, { run, platform: 'linux' }), false);
  assert.equal(n, 0);
  assert.throws(() => nt.notify('paused', { key: 'a"b', count: 1 }, { run, platform: 'darwin' }));
  assert.throws(() => nt.notify('paused', { key: 'a\nb', count: 1 }, { run, platform: 'darwin' }));
  assert.throws(() => nt.notify('nope', { key: 'ab', count: 1 }, { run, platform: 'darwin' }));
  assert.equal(n, 0);
});
