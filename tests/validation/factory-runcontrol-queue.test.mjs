// factory run control (Phase 2, task 5): budget holds park a building or fixing feature; unhold resumes it as an interrupted step.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator');
const DELIVER = path.join(SK, 'core', 'scripts', 'deliver.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const Q = await import(path.join(SK, 'core', 'scripts', 'lib', 'queue.mjs'));
const D = await import(path.join(SK, 'core', 'scripts', 'lib', 'driver.mjs'));

const EXPECTED = {
  queued: ['building', 'skipped', 'blocked'],
  building: ['built', 'blocked', 'awaiting_human'],
  built: ['pr_open', 'blocked'],
  pr_open: ['ci_passed', 'ci_failed', 'awaiting_human', 'blocked'],
  ci_failed: ['fixing', 'blocked'],
  verify_failed: ['fixing', 'blocked'],
  fixing: ['pr_open', 'blocked', 'awaiting_human'],
  ci_passed: ['merged', 'verified', 'verify_failed', 'pr_open', 'awaiting_human', 'blocked'],
  verified: ['merged', 'pr_open', 'awaiting_human', 'blocked'],
  awaiting_human: ['merged', 'skipped', 'pr_open', 'building', 'fixing'],
  blocked: ['skipped'],
  merged: [],
  skipped: [],
};

test('transitions: exactly the four new edges for budget holds, nothing else changed', () => {
  assert.deepEqual(Q.TRANSITIONS, EXPECTED);
});

test('driver canHold is unchanged: building and fixing still stop through the attention path', () => {
  for (const st of ['building', 'fixing']) assert.equal(D.canHold(st), false, st);
  for (const st of ['pr_open', 'ci_passed', 'verified']) assert.equal(D.canHold(st), true, st);
});

const GENV = {};
function repo() {
  const root = tmpDir('rcq-');
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GENV } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE_GH, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  const rw = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:o/r.git' };
  Object.assign(GENV, rw);
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  const spec = (id, deps) => `---\ntype: feature-spec\nid: ${id}\nopportunity: OPP-001\nstatus: ready\n${deps ? `depends_on: ${deps}\n` : ''}---\n# ${id}\n\nbody\n`;
  fs.writeFileSync(path.join(work, '.product/features/FEATURE-001.md'), spec('FEATURE-001'));
  fs.writeFileSync(path.join(work, '.product/features/FEATURE-002.md'), spec('FEATURE-002', 'FEATURE-001'));
  fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify({ protected_branches: [] }));
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'checkout', '-q', '-b', 'main'); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [] }));
  const env = { ...process.env, ...rw, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(root, 'fhome') };
  const qf = path.join(env.FACTORY_HOME, 'q', 'queue.json');
  const d = (queue, ...a) => { const r = spawnSync('node', [DELIVER, ...a, '--dir', work], { encoding: 'utf8', env: { ...env, DELIVER_QUEUE: queue } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const init = d(qf, 'init'); assert.equal(init.code, 0, init.out + init.err);
  const read = (f = qf) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const setState = (st, extra = {}, f = qf) => { const q = read(f); Object.assign(q.features[0], { state: st }, extra); fs.writeFileSync(f, JSON.stringify(q)); };
  return { root, work, qf, d, read, setState };
}

test('hold --kind budget parks a building or fixing feature and records where it came from', (t) => {
  const r = repo(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  for (const st of ['building', 'fixing']) {
    r.setState(st, { hold_kind: undefined, budget_hold: undefined });
    const x = r.d(r.qf, 'hold', 'FEATURE-001', '--reason', 'daily budget reached', '--kind', 'budget');
    assert.equal(x.code, 2, x.out + x.err);
    const f = r.read().features[0];
    assert.equal(f.state, 'awaiting_human'); assert.equal(f.hold_kind, 'budget'); assert.deepEqual(f.budget_hold, { from: st });
  }
});

test('hold with another kind (or none) from building or fixing is still refused', (t) => {
  const r = repo(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  for (const st of ['building', 'fixing']) for (const kind of ['antigaming', 'verification', null]) {
    r.setState(st);
    const x = r.d(r.qf, 'hold', 'FEATURE-001', '--reason', 'r', ...(kind ? ['--kind', kind, '--sha', 'a'.repeat(40), '--ids', 'G1'] : []));
    assert.equal(x.code, 1, `${st} ${kind}: ${x.out}${x.err}`); assert.match(x.err, /cannot wait for a person/);
    assert.equal(r.read().features[0].state, st);
  }
});

test('hold --kind budget is refused from every state but building and fixing, leaving the queue unchanged', (t) => {
  const r = repo(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  for (const st of ['queued', 'pr_open', 'ci_passed', 'verified']) {
    r.setState(st);
    const before = fs.readFileSync(r.qf, 'utf8');
    const x = r.d(r.qf, 'hold', 'FEATURE-001', '--reason', 'r', '--kind', 'budget');
    assert.equal(x.code, 1, `${st}: ${x.out}${x.err}`); assert.match(x.err, /cannot (wait for a person|be held for a budget)/);
    assert.equal(fs.readFileSync(r.qf, 'utf8'), before, st);
  }
});

test('unhold --to building|fixing resumes a budget hold as an interrupted step and clears the hold', (t) => {
  const r = repo(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  for (const [to, step] of [['building', 'build'], ['fixing', 'fix']]) {
    r.setState('awaiting_human', { hold_kind: 'budget', budget_hold: { from: to } });
    const x = r.d(r.qf, 'unhold', 'FEATURE-001', '--to', to);
    assert.equal(x.code, 0, x.out + x.err);
    const f = r.read().features[0];
    assert.equal(f.state, to); assert.equal(f.budget_hold, undefined); assert.equal(f.hold_kind, null);
    assert.equal(f.interrupted.kind, 'budget'); assert.equal(f.interrupted.step, step);
    assert.ok(!Number.isNaN(Date.parse(f.interrupted.ts)));
    assert.equal(f.history.at(-1).state, to);
  }
});

test('unhold refuses: non-budget hold, wrong state, bad --to, queue outside FACTORY_HOME', (t) => {
  const r = repo(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.setState('awaiting_human', { hold_kind: 'antigaming' });
  let x = r.d(r.qf, 'unhold', 'FEATURE-001', '--to', 'building');
  assert.equal(x.code, 1); assert.match(x.err, /budget/); assert.equal(r.read().features[0].state, 'awaiting_human');
  r.setState('awaiting_human', { hold_kind: null });
  assert.equal(r.d(r.qf, 'unhold', 'FEATURE-001', '--to', 'building').code, 1);
  r.setState('building', { hold_kind: 'budget' });
  assert.equal(r.d(r.qf, 'unhold', 'FEATURE-001', '--to', 'building').code, 1);
  r.setState('awaiting_human', { hold_kind: 'budget' });
  for (const to of ['pr_open', 'merged', undefined]) assert.equal(r.d(r.qf, 'unhold', 'FEATURE-001', ...(to ? ['--to', to] : [])).code, 1, String(to));
  // the target must be the state the feature was held from; a budget_hold from any other state is never resumed
  r.setState('awaiting_human', { hold_kind: 'budget', budget_hold: { from: 'building' } });
  let before = fs.readFileSync(r.qf, 'utf8');
  x = r.d(r.qf, 'unhold', 'FEATURE-001', '--to', 'fixing');
  assert.equal(x.code, 1); assert.match(x.err, /held from "building"/); assert.equal(fs.readFileSync(r.qf, 'utf8'), before);
  for (const from of ['pr_open', 'ci_passed', undefined]) for (const to of ['building', 'fixing']) {
    r.setState('awaiting_human', { hold_kind: 'budget', budget_hold: from ? { from } : undefined });
    before = fs.readFileSync(r.qf, 'utf8');
    x = r.d(r.qf, 'unhold', 'FEATURE-001', '--to', to);
    assert.equal(x.code, 1, `${from} ${to}`); assert.equal(fs.readFileSync(r.qf, 'utf8'), before);
  }
  r.setState('awaiting_human', { hold_kind: 'budget', budget_hold: { from: 'building' } });
  const out = path.join(r.root, 'q.json'); fs.copyFileSync(r.qf, out);
  x = r.d(out, 'unhold', 'FEATURE-001', '--to', 'building');
  assert.equal(x.code, 1); assert.match(x.err, /factory driver command/);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).features[0].state, 'awaiting_human');
});

test('pickNext skips the dependents of a budget-held feature', (t) => {
  const r = repo(); t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  r.setState('awaiting_human', { hold_kind: 'budget', budget_hold: { from: 'building' } });
  const q = r.read();
  const p = Q.pickNext(q);
  assert.equal(p.item, null);
  assert.equal(q.features[1].state, 'skipped');
});
