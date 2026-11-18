// factory verification gate (Phase 1a): config `verification` keys and the relocatable queue file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator');
const c = await import(path.join(SK, 'core', 'scripts', 'lib', 'config.mjs'));
const DELIVER = path.join(SK, 'core', 'scripts', 'deliver.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');

test('verification: defaults', () => {
  assert.deepEqual(c.defaults().verification, { required: false, scenario_approval: 'auto', session_timeout_s: { builder: 1800, author: 900 }, max_turns: { builder: 200, author: 40 }, model: { builder: null, author: null }, test_globs: [] });
  assert.deepEqual(c.parseConfig({}).config.verification, c.defaults().verification);
  assert.deepEqual(c.parseConfig({ verification: {} }).errors, []);
});
test('verification: valid values parse and merge over defaults', () => {
  const { config, errors } = c.parseConfig({ verification: { required: true, scenario_approval: 'human', session_timeout_s: { builder: 60 }, max_turns: { author: 1000 }, model: { builder: 'opus' }, test_globs: ['tests/**/*.test.mjs'] } });
  assert.deepEqual(errors, []);
  assert.equal(config.verification.required, true);
  assert.equal(config.verification.scenario_approval, 'human');
  assert.deepEqual(config.verification.session_timeout_s, { builder: 60, author: 900 });
  assert.deepEqual(config.verification.max_turns, { builder: 200, author: 1000 });
  assert.deepEqual(config.verification.model, { builder: 'opus', author: null });
  assert.deepEqual(config.verification.test_globs, ['tests/**/*.test.mjs']);
});
test('verification: rejects bad values and unknown keys', () => {
  for (const v of [
    'x', [], { required: 'yes' }, { scenario_approval: 'maybe' }, { foo: 1 }, { evaluator: {} },
    { session_timeout_s: { builder: 59 } }, { session_timeout_s: { author: 7201 } }, { session_timeout_s: { builder: 1.5 } }, { session_timeout_s: 5 }, { session_timeout_s: { other: 100 } },
    { max_turns: { builder: 4 } }, { max_turns: { author: 1001 } },
    { model: { builder: 5 } }, { model: { builder: 'a b' } },
    { test_globs: 'x' }, { test_globs: Array.from({ length: 51 }, (_, i) => `t${i}`) }, { test_globs: [1] },
  ]) assert.ok(c.parseConfig({ verification: v }).errors.length, JSON.stringify(v));
  assert.ok(c.parseConfig({ verification: null }).errors.length);
});
test('verification stays absent from the shipped template', () => {
  assert.equal('verification' in JSON.parse(fs.readFileSync(path.join(SK, 'templates', 'delivery.json'), 'utf8')), false);
});

function repo() {
  const root = tmpDir('verify-');
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE_GH, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  sh(work, 'config', `url.${origin}.insteadOf`, 'git@github.com:o/r.git');
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  fs.writeFileSync(path.join(work, '.product/features/FEATURE-001.md'), '---\ntype: feature-spec\nid: FEATURE-001\nopportunity: OPP-001\nstatus: ready\n---\n# One\n\nbody\n');
  fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify({ protected_branches: [] }));
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'checkout', '-q', '-b', 'main'); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [] }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(root, 'fhome') };
  const d = (extra, ...a) => { const r = spawnSync('node', [DELIVER, ...a, '--dir', work], { encoding: 'utf8', env: { ...env, ...extra } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { root, work, d };
}

test('DELIVER_QUEUE relocates the queue file; default stays in .delivery/', () => {
  const r = repo();
  const q = path.join(r.root, 'elsewhere', 'deep', 'queue.json');
  const x = r.d({ DELIVER_QUEUE: q }, 'init');
  assert.equal(x.code, 0, x.out + x.err);
  assert.ok(fs.existsSync(q));
  assert.equal(fs.existsSync(path.join(r.work, '.delivery', 'queue.json')), false);
  assert.equal(fs.statSync(path.dirname(q)).mode & 0o077, 0, 'parent dir is private');
  assert.equal(JSON.parse(fs.readFileSync(q, 'utf8')).features[0].id, 'FEATURE-001');
  const s = r.d({ DELIVER_QUEUE: q }, 'status', '--json');
  assert.equal(s.code, 0, s.out + s.err);
  assert.equal(r.d({}, 'status').code, 1, 'without the override there is no run');
  assert.equal(r.d({ DELIVER_QUEUE: q }, 'reset', '--yes').code, 0);
  assert.equal(fs.existsSync(q), false);
  assert.equal(r.d({}, 'init').code, 0);
  assert.ok(fs.existsSync(path.join(r.work, '.delivery', 'queue.json')));
  fs.rmSync(r.root, { recursive: true, force: true });
});
test('DELIVER_QUEUE must be absolute and not a symlink (file or folder)', () => {
  const r = repo();
  assert.match(r.d({ DELIVER_QUEUE: 'rel/queue.json' }, 'status').err, /absolute/);
  const real = path.join(r.root, 'real'); fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(r.root, 'linkdir'));
  const a = r.d({ DELIVER_QUEUE: path.join(r.root, 'linkdir', 'queue.json') }, 'init');
  assert.notEqual(a.code, 0); assert.match(a.err, /symlink/);
  assert.equal(fs.existsSync(path.join(real, 'queue.json')), false);
  fs.writeFileSync(path.join(real, 'target.json'), '{}');
  fs.symlinkSync(path.join(real, 'target.json'), path.join(r.root, 'q.json'));
  const b = r.d({ DELIVER_QUEUE: path.join(r.root, 'q.json') }, 'init');
  assert.notEqual(b.code, 0); assert.match(b.err, /symlink/);
  assert.equal(fs.readFileSync(path.join(real, 'target.json'), 'utf8'), '{}');
  fs.rmSync(r.root, { recursive: true, force: true });
});

// ---- Task 2: states, fix from verify_failed, T3 verdict rule, retry --note -------------------------------------------
const Q = await import(path.join(SK, 'core', 'scripts', 'lib', 'queue.mjs'));
const J = (x) => { try { return JSON.parse(x.out); } catch { return undefined; } };

test('queue: verification transitions allowed, others refused', () => {
  const ok = [['ci_passed', 'verified'], ['ci_passed', 'verify_failed'], ['verify_failed', 'fixing'], ['verify_failed', 'blocked'], ['verified', 'merged'], ['verified', 'pr_open'], ['verified', 'awaiting_human'], ['verified', 'blocked']];
  for (const [a, b] of ok) assert.doesNotThrow(() => Q.transition({ id: 'FEATURE-001', state: a, history: [] }, b), `${a} -> ${b}`);
  for (const [a, b] of [['verify_failed', 'merged'], ['verify_failed', 'verified'], ['pr_open', 'verified'], ['verified', 'ci_passed']]) assert.throws(() => Q.transition({ id: 'FEATURE-001', state: a, history: [] }, b), /cannot go/, `${a} -> ${b}`);
  assert.ok(Q.ACTIVE.includes('verified') && Q.ACTIVE.includes('verify_failed'));
});

// Ship FEATURE-001 to ci_passed with the real helper, then let the test edit the queue file directly.
function shipped(extra = {}, { tier = 'T2', config, init = ['--merge', '--note', 'ok'] } = {}) {
  const r = repo();
  const sh = (...a) => { const x = spawnSync('git', a, { cwd: r.work, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr); };
  if (config) { fs.writeFileSync(path.join(r.work, '.product/delivery.json'), JSON.stringify(config)); sh('add', '-A'); sh('commit', '-q', '-m', 'cfg'); sh('push', '-q', 'origin', 'main'); }
  { const i = r.d(extra, 'init', ...init); assert.equal(i.code, 0, i.out + i.err); }
  assert.equal(J(r.d(extra, 'next')).feature.id, 'FEATURE-001');
  const spc = path.join(r.work, '.product/features/FEATURE-001.md');
  fs.mkdirSync(path.join(r.work, 'src'), { recursive: true }); fs.writeFileSync(path.join(r.work, 'src/a.txt'), 'a\n');
  fs.writeFileSync(spc, fs.readFileSync(spc, 'utf8').replace(/^status: ready/m, 'status: implemented').replace(/^---\n/, '---\ndelivery: complete\n'));
  sh('add', '-A'); sh('commit', '-q', '-m', 'feat');
  assert.equal(r.d(extra, 'built', 'FEATURE-001', '--tier', tier).code, 0);
  fs.mkdirSync(path.join(r.work, '.delivery'), { recursive: true }); fs.writeFileSync(path.join(r.work, '.delivery/pr-body.md'), 'b\n');
  { const p = r.d(extra, 'pr', 'FEATURE-001', '--title', 'feat: thing', '--body-file', path.join(r.work, '.delivery/pr-body.md')); assert.equal(p.code, 0, p.out + p.err); }
  { const g = JSON.parse(fs.readFileSync(path.join(r.root, 'gh.json'), 'utf8')); g.checkQueue = [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]]; fs.writeFileSync(path.join(r.root, 'gh.json'), JSON.stringify(g)); }
  const ci = r.d(extra, 'ci', 'FEATURE-001', '--interval', '0', '--grace', '0', '--timeout', '1');
  assert.equal(J(ci).result, 'passed', ci.out + ci.err);
  const qf = path.join(r.work, '.delivery', 'queue.json');
  r.edit = (fn) => { const q = JSON.parse(fs.readFileSync(qf, 'utf8')); fn(q.features[0], q); fs.writeFileSync(qf, JSON.stringify(q)); };
  r.feat = () => JSON.parse(fs.readFileSync(qf, 'utf8')).features[0];
  return r;
}

test('fix accepts verify_failed and shares max_fix_rounds', () => {
  const r = shipped();
  r.edit((f) => { f.state = 'verify_failed'; });
  const x = r.d({}, 'fix', 'FEATURE-001');
  assert.equal(x.code, 0, x.err);
  assert.equal(r.feat().state, 'fixing');
  assert.equal(r.feat().fix_rounds, 1);
  const r2 = shipped();
  r2.edit((f, q) => { f.state = 'verify_failed'; f.fix_rounds = q.max_fix_rounds; });
  r2.d({}, 'fix', 'FEATURE-001');
  assert.equal(r2.feat().state, 'blocked');
  fs.rmSync(r.root, { recursive: true, force: true }); fs.rmSync(r2.root, { recursive: true, force: true });
});

test('merge accepts verified; ci_passed is accepted unless the base config requires verification', () => {
  const r = shipped();
  r.edit((f) => { f.state = 'verified'; });
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m).state, 'merged', m.out + m.err);

  const req = shipped({}, { config: { protected_branches: [], verification: { required: true } } });
  const a = req.d({}, 'merge', 'FEATURE-001');
  assert.notEqual(a.code, 0); assert.match(a.err, /verification/);
  assert.equal(req.feat().state, 'ci_passed');
  req.edit((f, q) => { q.policy = { ...(q.policy || {}), verification: { required: false } }; }); // the builder-editable queue copy must not matter
  assert.match(req.d({}, 'merge', 'FEATURE-001').err, /verification/);
  req.edit((f) => { f.state = 'verified'; });
  assert.equal(J(req.d({}, 'merge', 'FEATURE-001')).state, 'merged');
  fs.rmSync(r.root, { recursive: true, force: true }); fs.rmSync(req.root, { recursive: true, force: true });
});

test('T3 with --merge-t3 and no passing verdict holds for a person', () => {
  const r = shipped({}, { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'] });
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(m.code, 2);
  assert.equal(J(m).state, 'awaiting_human');
  assert.match(J(m).reason, /verdict/);
  fs.rmSync(r.root, { recursive: true, force: true });
  // The passing-verdict path is exercised in Task 8, once lib/verdict.mjs can read a real verdict file.
});

test('retry --note: anti-gaming holds need a note, which is recorded; CI holds are unchanged', () => {
  const r = shipped();
  r.edit((f) => { f.state = 'awaiting_human'; f.hold_kind = 'antigaming'; f.reason = 'G1'; });
  const a = r.d({}, 'retry', 'FEATURE-001');
  assert.notEqual(a.code, 0); assert.match(a.err, /--note/);
  assert.equal(r.feat().state, 'awaiting_human');
  const b = r.d({}, 'retry', 'FEATURE-001', '--note', 'reviewed the diff, the test change is intended');
  assert.equal(b.code, 0, b.err);
  assert.equal(r.feat().state, 'pr_open');
  assert.equal(r.feat().override_note, 'reviewed the diff, the test change is intended');
  assert.ok(!r.feat().hold_kind);
  r.edit((f) => { f.state = 'awaiting_human'; f.hold_kind = null; });
  assert.equal(r.d({}, 'retry', 'FEATURE-001').code, 0, 'a plain hold retries without a note');
  fs.rmSync(r.root, { recursive: true, force: true });
});
