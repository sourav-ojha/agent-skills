import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';
import { validatePlan, nextBatch, startTask, finishTask, passTask, blockTask, reopenTask, unblockTask, mapCriterion, ownsOverlap, deliveryReport } from '../../skills/implementer/core/scripts/lib/ledger.mjs';

const IMPL = path.join(REPO, 'skills/implementer/core/scripts/impl.mjs');
const task = (id, o = {}) => ({
  id, title: id, deps: [], files: [`src/${id}.js`], verify: 'npm test',
  criteria: [{ id: `${id}-c1`, text: 'Given x When y Then z', tests: ['t'] }],
  status: 'pending', passes: false, evidence: null, ...o,
});
const plan = (...tasks) => ({ name: 'p', tier: 'T2', tasks });

test('AC1 plan rejects cycle, unknown dependency, task without criteria', () => {
  const bad = {
    cycle: plan(task('A', { deps: ['B'] }), task('B', { deps: ['A'] })),
    unknown: plan(task('A', { deps: ['Z'] })),
    nocrit: plan(task('A', { criteria: [] })),
  };
  for (const [k, p] of Object.entries(bad)) assert.ok(validatePlan(p).length > 0, k);
  assert.deepEqual(validatePlan(plan(task('A'), task('B', { deps: ['A'] }))), []);
});

test('AC2 nextBatch: ready only, disjoint files (prefix-aware), capped, in-progress excluded', () => {
  const p = plan(
    task('A', { files: ['src/'] }), task('B', { files: ['src/b.js'] }),
    task('C', { files: ['lib/c.js'] }), task('D', { files: ['lib/d.js'] }),
    task('E', { deps: ['A'], files: ['e.js'] }),
  );
  assert.deepEqual(nextBatch(p), ['A', 'C', 'D']); // B overlaps A by prefix, E not ready
  assert.deepEqual(nextBatch(p, 2), ['A', 'C']);
  p.tasks[2].status = 'in_progress'; // C holds lib/c.js
  assert.deepEqual(nextBatch(p), ['A', 'D']);
});

test('AC3 start refuses unmet deps and file conflicts; finish leaves passes false', () => {
  const p = plan(task('A'), task('B', { deps: ['A'] }), task('C', { files: ['src/'] }));
  assert.throws(() => startTask(p, 'B'), /dependenc/i);
  startTask(p, 'A');
  assert.throws(() => startTask(p, 'C'), /conflict|owned/i);
  finishTask(p, 'A');
  assert.equal(p.tasks[0].status, 'done');
  assert.equal(p.tasks[0].passes, false);
});

test('AC4 pass needs exit 0 evidence and criteria mapped to tests or noTest', () => {
  const p = plan(task('A'), task('B', { criteria: [{ id: 'c', text: 't', tests: [] }] }), task('C', { criteria: [{ id: 'c', text: 't', tests: [], noTest: 'docs only' }] }));
  for (const id of ['A', 'B', 'C']) { startTask(p, id); finishTask(p, id); }
  assert.throws(() => passTask(p, 'A', { cmd: 'npm test', exit: 1 }), /exit/i);
  assert.throws(() => passTask(p, 'B', { cmd: 'npm test', exit: 0 }), /criteri/i);
  passTask(p, 'A', { cmd: 'npm test', exit: 0 });
  passTask(p, 'C', { cmd: 'npm test', exit: 0 });
  assert.equal(p.tasks[0].passes, true);
  assert.equal(p.tasks[0].evidence.cmd, 'npm test');
  assert.equal(p.tasks[2].passes, true);
});

test('AC5 CLI end to end: persist, ruling log, replan guard, corrupt ledger, unsafe name', () => {
  const dir = tmpDir('impl-');
  const run = (...a) => { const r = spawnSync('node', [IMPL, ...a, '--dir', dir], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  assert.equal(run('init', '--name', 'x', '--tier', 'T2').code, 0);
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ tasks: [task('A')] }));
  assert.equal(run('plan', '--name', 'x', '--file', path.join(dir, 'plan.json')).code, 0);
  assert.equal(run('start', 'A', '--name', 'x').code, 0);
  assert.notEqual(run('plan', '--name', 'x', '--file', path.join(dir, 'plan.json')).code, 0); // progress would be erased
  assert.equal(run('finish', 'A', '--name', 'x').code, 0);
  assert.equal(run('pass', 'A', '--name', 'x', '--cmd', 'npm test', '--exit', '0').code, 0);
  assert.match(run('status', '--name', 'x').out, /1\/1 passed/);
  assert.equal(run('ruling', '--name', 'x', '--what', 'w', '--why', 'y', '--cost', 'c').code, 0);
  assert.match(fs.readFileSync(path.join(dir, '.implementation/x/log.md'), 'utf8'), /Ruling: w/);
  assert.notEqual(run('init', '--name', '../evil').code, 0);
  fs.writeFileSync(path.join(dir, '.implementation/x/tasks.json'), '{nope');
  assert.match(run('status', '--name', 'x').out, /invalid|corrupt|parse/i);
});

test('AC3 files stay held while QA rework is pending; reopen and block/unblock recover', () => {
  const p = plan(task('A', { files: ['src/'] }), task('B', { files: ['src/b.js'] }));
  startTask(p, 'A'); finishTask(p, 'A');
  assert.deepEqual(nextBatch(p), []); // A is done but not passed: its files are still held
  reopenTask(p, 'A');
  assert.equal(p.tasks[0].status, 'in_progress');
  blockTask(p, 'A', 'stuck');
  assert.equal(p.tasks[0].status, 'blocked');
  unblockTask(p, 'A');
  assert.equal(p.tasks[0].status, 'pending');
  startTask(p, 'A'); finishTask(p, 'A');
  passTask(p, 'A', { cmd: 'npm test', exit: 0 });
  assert.throws(() => blockTask(p, 'A', 'x'), /passed/i); // a passed task cannot be blocked
});

test('AC4 map records criteria->tests so pass can succeed; overlap needs no trailing slash', () => {
  const p = plan(task('A', { criteria: [{ id: 'c1', text: 't', tests: [] }, { id: 'c2', text: 't', tests: [] }] }));
  startTask(p, 'A'); finishTask(p, 'A');
  assert.throws(() => passTask(p, 'A', { cmd: 'x', exit: 0 }), /criteri/i);
  mapCriterion(p, 'A', 'c1', { tests: ['t1'] });
  mapCriterion(p, 'A', 'c2', { noTest: 'docs' });
  passTask(p, 'A', { cmd: 'x', exit: 0 });
  assert.equal(p.tasks[0].passes, true);
  assert.equal(ownsOverlap(['src'], ['src/b.js']), true);
  assert.equal(ownsOverlap(['src'], ['src-old/b.js']), false);
});

test('AC1 CLI: plan file cannot preset status or passes; non-object ledger and empty --exit are refused', () => {
  const dir = tmpDir('impl-');
  const run = (...a) => { const r = spawnSync('node', [IMPL, ...a, '--dir', dir], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
  run('init', '--name', 'x', '--tier', 'T2');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ tasks: [task('A', { status: 'done', passes: true, evidence: { cmd: 'fake' } })] }));
  run('plan', '--name', 'x', '--file', path.join(dir, 'plan.json'));
  assert.match(run('status', '--name', 'x').out, /0\/1 passed/);
  run('start', 'A', '--name', 'x'); run('finish', 'A', '--name', 'x');
  assert.notEqual(run('pass', 'A', '--name', 'x', '--cmd', 'c', '--exit', '').code, 0);
  assert.equal(run('map', 'A', '--name', 'x', '--criterion', 'A-c1', '--tests', 'a,b').code, 0);
  fs.writeFileSync(path.join(dir, '.implementation/x/tasks.json'), 'null');
  const r = run('status', '--name', 'x');
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /TypeError|at /);
});

test('AC8 deliveryReport separates delivered from pending criteria; only passed tasks count as delivered', () => {
  const p = plan(task('A'), task('B', { deps: ['A'] }));
  assert.equal(deliveryReport(p).state, 'none');
  startTask(p, 'A'); finishTask(p, 'A'); passTask(p, 'A', { cmd: 'npm test', exit: 0 });
  const part = deliveryReport(p);
  assert.equal(part.state, 'partial');
  assert.deepEqual(part.delivered.map((c) => c.id), ['A-c1']);
  assert.deepEqual(part.pending.map((c) => c.id), ['B-c1']);
  startTask(p, 'B'); finishTask(p, 'B'); passTask(p, 'B', { cmd: 'npm test', exit: 0 });
  assert.equal(deliveryReport(p).state, 'complete');
});

test('AC8 CLI report prints a delivery table and state', () => {
  const dir = tmpDir('impl-');
  const run = (...a) => spawnSync('node', [IMPL, ...a, '--dir', dir], { encoding: 'utf8' });
  run('init', '--name', 'r', '--tier', 'T2');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ tasks: [task('A')] }));
  run('plan', '--name', 'r', '--file', path.join(dir, 'plan.json'));
  const out = run('report', '--name', 'r').stdout;
  assert.match(out, /state: none/);
  assert.match(out, /pending: A-c1/);
});
