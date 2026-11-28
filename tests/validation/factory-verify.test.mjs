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

// The test origin is a local bare repo reached through url.<path>.insteadOf. That rewrite is passed per process (GIT_CONFIG_COUNT),
// never written to the repo config: the merge gate requires a config that passes the gitsafe allowlist (as a driver clone would).
const GENV = new Map();
const genv = (cwd) => ({ ...process.env, ...(GENV.get(cwd) || {}) });
function repo() {
  const root = tmpDir('verify-');
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: genv(cwd) }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE_GH, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  const rw = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:o/r.git' };
  GENV.set(work, rw);
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  fs.writeFileSync(path.join(work, '.product/features/FEATURE-001.md'), '---\ntype: feature-spec\nid: FEATURE-001\nopportunity: OPP-001\nstatus: ready\n---\n# One\n\nbody\n');
  fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify({ protected_branches: [] }));
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'checkout', '-q', '-b', 'main'); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [] }));
  const env = { ...process.env, ...rw, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(root, 'fhome') };
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
function shipped(extra = {}, { tier = 'T2', config, init = ['--merge', '--note', 'ok'], files = {}, queueInHome = false, baseFiles = {}, specAppend = '' } = {}) {
  const r = repo();
  if (queueInHome) extra = { ...extra, DELIVER_QUEUE: path.join(r.root, 'fhome', 'queues', 'o__r.json') };
  r.env = extra;
  const sh = (...a) => { const x = spawnSync('git', a, { cwd: r.work, encoding: 'utf8', env: genv(r.work) }); if (x.status !== 0) throw new Error(x.stderr); };
  for (const [p, body] of Object.entries(baseFiles)) { fs.mkdirSync(path.dirname(path.join(r.work, p)), { recursive: true }); fs.writeFileSync(path.join(r.work, p), body); }
  if (config) fs.writeFileSync(path.join(r.work, '.product/delivery.json'), JSON.stringify(config));
  if (config || Object.keys(baseFiles).length) { sh('add', '-A'); sh('commit', '-q', '-m', 'cfg'); sh('push', '-q', 'origin', 'main'); }
  { const i = r.d(extra, 'init', ...init); assert.equal(i.code, 0, i.out + i.err); }
  assert.equal(J(r.d(extra, 'next')).feature.id, 'FEATURE-001');
  const spc = path.join(r.work, '.product/features/FEATURE-001.md');
  fs.mkdirSync(path.join(r.work, 'src'), { recursive: true }); fs.writeFileSync(path.join(r.work, 'src/a.txt'), 'a\n');
  for (const [p, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(r.work, p)), { recursive: true }); fs.writeFileSync(path.join(r.work, p), body); }
  fs.writeFileSync(spc, fs.readFileSync(spc, 'utf8').replace(/^status: ready/m, 'status: implemented').replace(/^---\n/, '---\ndelivery: complete\n') + specAppend);
  sh('add', '-A'); sh('commit', '-q', '-m', 'feat');
  assert.equal(r.d(extra, 'built', 'FEATURE-001', '--tier', tier).code, 0);
  fs.mkdirSync(path.join(r.work, '.delivery'), { recursive: true }); fs.writeFileSync(path.join(r.work, '.delivery/pr-body.md'), 'b\n');
  { const p = r.d(extra, 'pr', 'FEATURE-001', '--title', 'feat: thing', '--body-file', path.join(r.work, '.delivery/pr-body.md')); assert.equal(p.code, 0, p.out + p.err); }
  { const g = JSON.parse(fs.readFileSync(path.join(r.root, 'gh.json'), 'utf8')); g.checkQueue = [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]]; fs.writeFileSync(path.join(r.root, 'gh.json'), JSON.stringify(g)); }
  const ci = r.d(extra, 'ci', 'FEATURE-001', '--interval', '0', '--grace', '0', '--timeout', '1');
  assert.equal(J(ci).result, 'passed', ci.out + ci.err);
  const qf = extra.DELIVER_QUEUE || path.join(r.work, '.delivery', 'queue.json');
  r.edit =(fn) => { const q = JSON.parse(fs.readFileSync(qf, 'utf8')); fn(q.features[0], q); fs.writeFileSync(qf, JSON.stringify(q)); };
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
  const held = req.d({}, 'merge', 'FEATURE-001'); // Task 10: verified alone is not enough (no trusted queue, no verdict)
  assert.equal(held.code, 2, held.out + held.err); assert.equal(J(held).state, 'awaiting_human');
  fs.rmSync(r.root, { recursive: true, force: true }); fs.rmSync(req.root, { recursive: true, force: true });
});

test('T3 with --merge-t3 and no passing verdict holds for a person', () => {
  const r = shipped({}, { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'] });
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(m.code, 2);
  assert.equal(J(m).state, 'awaiting_human');
  assert.match(J(m).reason, /verdict/);
  fs.rmSync(r.root, { recursive: true, force: true });
  // The passing-verdict path is exercised by the Task 8 test further down.
});

test('retry --note: anti-gaming holds are refused without a terminal; CI holds are unchanged', () => {
  const r = shipped();
  r.edit((f) => { f.state = 'awaiting_human'; f.hold_kind = 'antigaming'; f.reason = 'G1'; });
  for (const a of [[], ['--note', 'looked fine to me']]) { // no env var or flag can stand in for a terminal
    const x = r.d({ CI: '', TERM: 'xterm', DELIVER_TTY: '1' }, 'retry', 'FEATURE-001', ...a);
    assert.notEqual(x.code, 0); assert.match(x.err, /interactive terminal/);
  }
  assert.equal(r.feat().state, 'awaiting_human');
  assert.ok(!r.feat().override_note);
  r.edit((f) => { f.state = 'awaiting_human'; f.hold_kind = null; });
  assert.equal(r.d({}, 'retry', 'FEATURE-001').code, 0, 'a plain hold retries without a note or a terminal');
  fs.rmSync(r.root, { recursive: true, force: true });
});

// Run deliver.mjs under a real pseudo-terminal via script(1); null when script is unavailable.
function underTty(r, ...args) {
  const devnull = () => [fs.openSync('/dev/null', 'r'), 'pipe', 'pipe']; // script(1) needs a non-socket stdin
  const has = spawnSync('script', process.platform === 'darwin' ? ['-q', '/dev/null', 'true'] : ['-qec', 'true', '/dev/null'], { encoding: 'utf8', stdio: devnull() });
  if (has.error || has.status !== 0) return null;
  const argv = [DELIVER, ...args, '--dir', r.work];
  const env = { ...genv(r.work), PATH: `${path.join(r.root, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: path.join(r.root, 'gh.json'), SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(r.root, 'fhome') };
  const x = process.platform === 'darwin'
    ? spawnSync('script', ['-q', '/dev/null', 'node', ...argv], { encoding: 'utf8', env, stdio: devnull() })
    : spawnSync('script', ['-qec', ['node', ...argv].map((a) => `'${a}'`).join(' '), '/dev/null'], { encoding: 'utf8', env, stdio: devnull() });
  return { code: x.status, out: x.stdout, err: x.stderr };
}

test('retry --note under a real terminal: needs a note, records it bound to the head sha, returns to pr_open', (t) => {
  const r = shipped();
  r.edit((f) => { f.state = 'awaiting_human'; f.hold_kind = 'antigaming'; f.reason = 'G1'; f.hold_sha = f.ci_sha; f.hold_ids = ['G1', 'bogus']; });
  const a = underTty(r, 'retry', 'FEATURE-001');
  if (!a) { t.skip('script(1) is not available: cannot allocate a pseudo-terminal'); fs.rmSync(r.root, { recursive: true, force: true }); return; }
  assert.notEqual(a.code, 0, a.out); assert.match(a.out + a.err, /--note/);
  assert.equal(r.feat().state, 'awaiting_human');
  const flag = underTty(r, 'retry', 'FEATURE-001', '--note', '--no-ci');
  assert.notEqual(flag.code, 0, 'a flag swallowed as the note value is refused');
  const b = underTty(r, 'retry', 'FEATURE-001', '--note', 'reviewed the diff, the test change is intended');
  assert.equal(b.code, 0, b.out + b.err);
  const f = r.feat();
  assert.match(b.out + b.err, new RegExp(`override for FEATURE-001: commit ${f.ci_sha}, anti-gaming checks G1`), 'the held sha and ids are shown at the terminal');
  assert.equal(f.state, 'pr_open');
  assert.equal(f.override_note, 'reviewed the diff, the test change is intended');
  assert.equal(f.override_sha, f.ci_sha, 'bound to the held commit');
  assert.deepEqual(f.override_ids, ['G1'], 'only the held G-ids (junk dropped)');
  assert.ok(Q.overrideValid(f, f.ci_sha, ['G1']));
  assert.equal(Q.overrideValid(f, f.ci_sha, ['G1', 'G4']), false, 'a new G-id is not covered');
  assert.ok(!f.hold_kind);
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('overrideValid: only for the exact head sha the override was given on, and only for its G-ids', () => {
  const f = { override_note: 'ok', override_sha: 'abc', override_ids: ['G1', 'G4'] };
  assert.equal(Q.overrideValid(f, 'abc', ['G1']), true);
  assert.equal(Q.overrideValid(f, 'abc', ['G4', 'G1']), true);
  assert.equal(Q.overrideValid(f, 'abc', ['G1', 'G5']), false, 'G5 was not reviewed');
  assert.equal(Q.overrideValid(f, 'abc'), false, 'hit ids are required');
  assert.equal(Q.overrideValid({ override_note: 'ok', override_sha: 'abc' }, 'abc', ['G1']), false, 'no recorded ids');
  assert.equal(Q.overrideValid(f, 'abd', ['G1']), false, 'a later push voids it');
  assert.equal(Q.overrideValid(f, undefined, ['G1']), false);
  assert.equal(Q.overrideValid({ override_sha: 'abc', override_ids: ['G1'] }, 'abc', ['G1']), false, 'no note');
  assert.equal(Q.overrideValid({ override_note: 'ok', override_ids: ['G1'] }, 'abc', ['G1']), false, 'no sha');
  assert.equal(Q.overrideValid(null, 'abc', ['G1']), false);
});

test('merge reads the base config fail-closed: missing ref and invalid JSON refuse; a genuinely absent file means defaults', () => {
  const git = (cwd, ...a) => { const x = spawnSync('git', a, { cwd, encoding: 'utf8', env: genv(cwd) }); if (x.status !== 0) throw new Error(x.stderr); return x.stdout.trim(); };
  const pushCfg = (r, content) => {
    const br = git(r.work, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(r.work, 'checkout', '-q', 'main');
    if (content === null) git(r.work, 'rm', '-q', '.product/delivery.json'); else fs.writeFileSync(path.join(r.work, '.product/delivery.json'), content);
    git(r.work, 'commit', '-q', '-am', 'cfg'); git(r.work, 'push', '-q', 'origin', 'main'); git(r.work, 'checkout', '-q', br);
  };
  const bad = shipped();
  pushCfg(bad, '{ not json');
  const a = bad.d({}, 'merge', 'FEATURE-001'); // Task 10: an unreadable base config holds (never default-open)
  assert.equal(a.code, 2, a.out + a.err); assert.match(J(a).reason, /cannot be read/);
  assert.equal(bad.feat().state, 'awaiting_human');

  const noRef = shipped();
  const origin = path.join(noRef.root, 'origin.git');
  git(origin, 'update-ref', '-d', 'refs/heads/main'); git(noRef.work, 'update-ref', '-d', 'refs/remotes/origin/main');
  const b = noRef.d({}, 'merge', 'FEATURE-001');
  assert.equal(b.code, 2, b.out + b.err); assert.match(J(b).reason, /cannot be read/);
  assert.equal(noRef.feat().state, 'awaiting_human');
  assert.ok(!JSON.parse(fs.readFileSync(path.join(noRef.root, 'gh.json'), 'utf8')).calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), 'never merged');

  const none = shipped();
  pushCfg(none, null);
  const c = none.d({}, 'merge', 'FEATURE-001');
  assert.doesNotMatch(c.err, /cannot be read|verification is required/, 'no config file: defaults, merge proceeds to its normal checks');
  for (const r of [bad, noRef, none]) fs.rmSync(r.root, { recursive: true, force: true });
});

test('a hand-merged ci_passed feature resolves to merged even when verification is required', () => {
  const r = shipped({}, { config: { protected_branches: [], verification: { required: true } } });
  const sha = r.feat().ci_sha;
  const gp = path.join(r.root, 'gh.json');
  const g = JSON.parse(fs.readFileSync(gp, 'utf8')); Object.assign(g.prs[0], { state: 'MERGED', headSha: sha, mergeSha: sha }); fs.writeFileSync(gp, JSON.stringify(g));
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m)?.state, 'merged', m.out + m.err + ` (ci_sha ${sha})`);
  fs.rmSync(r.root, { recursive: true, force: true });
});

// ---- Task 8: API check engine (apicheck.mjs) and verdict files (verdict.mjs) ---------------------------------------
import http from 'node:http';
const A = await import(path.join(SK, 'core', 'scripts', 'lib', 'apicheck.mjs'));
const V = await import(path.join(SK, 'core', 'scripts', 'lib', 'verdict.mjs'));
const SC = await import(path.join(SK, 'core', 'scripts', 'lib', 'scenarios.mjs'));

const SECRET_PATH = '/api/secret-path-fx-1a2b3c';
const SECRET_HDR = 'header-value-fx-9z9z9z';
const SECRET_BODY = 'body-value-fx-4d5e6f';

// Tiny fixture app on 127.0.0.1:0. Records every request it sees.
async function fixtureServer() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const json = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    const u = req.url;
    if (u === SECRET_PATH || u === '/api/items') return json(200, { items: [{ name: 'Alpha' }, { name: SECRET_BODY }], total: 2, msg: 'hello world', tags: ['x', 'y'] }, { 'x-thing': SECRET_HDR });
    if (u === '/api/setup-ok' && req.method === 'POST') return json(201, { ok: true });
    if (u === '/api/setup-fail') return json(500, { err: 'boom' });
    if (u === '/api/redirect-out') { res.writeHead(302, { location: `${srv.otherOrigin}/stolen` }); return res.end(); }
    if (u === '/api/redirect-in') { res.writeHead(301, { location: '/api/items' }); return res.end(); }
    if (u === '/api/big') { res.writeHead(200, { 'content-type': 'application/json' }); const chunk = Buffer.alloc(64 * 1024, 0x61); let n = 0; const w = () => { while (n < 200) { n++; if (!res.write(chunk)) return res.once('drain', w); } res.end(); }; res.on('error', () => {}); return w(); }
    if (u === '/api/slow') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"a":'); return; } // never finishes
    if (u === '/api/hang') return; // never answers
    if (u === '/api/err') return json(500, { error: 'boom' });
    if (u === '/api/empty') return json(200, { items: [], meta: {} });
    if (u === '/api/huge-array') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(`{"a":[${Array(300000).fill('0').join(',')}]}`); }
    if (u === '/api/long') return json(200, { s: 'a'.repeat(70 * 1024), short: 'aaa' });
    if (u === '/api/redos') return json(200, { s: `${'a'.repeat(40)}!` });
    if (u === '/api/proto') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"__proto__":{"polluted":"yes"},"a":{"b":1},"arr":[1,2,3]}'); }
    if (u === '/api/notjson') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('not json'); }
    if (u === '/api/echo-headers') return json(200, { host: req.headers.host, auth: req.headers['x-auth'] ?? null });
    return json(404, { err: 'nope' });
  });
  const other = http.createServer((req, res) => { seen.push({ other: true, url: req.url }); res.end('stolen'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  srv.otherOrigin = `http://127.0.0.1:${other.address().port}`;
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, seen, close: () => { srv.closeAllConnections(); other.closeAllConnections(); srv.close(); other.close(); } };
}
const scen = (request, assert, setup) => ({ id: 'S-1', covers: ['AC-1'], kind: 'api', request, assert, ...(setup ? { setup } : {}) });
const GET = (p) => ({ method: 'GET', path: p });

test('jsonPath: $, .key, [n], [*] only; everything else is unsupported', () => {
  const o = { a: { b: [10, 20, { c: 'x' }] }, items: [{ n: 1 }, { n: 2 }], m: { p: 1, q: 2 } };
  assert.deepEqual(A.jsonPath(o, '$'), [o]);
  assert.deepEqual(A.jsonPath(o, '$.a.b[1]'), [20]);
  assert.deepEqual(A.jsonPath({}, `$${'.a'.repeat(32)}`), [], '32 segments is the limit');
  assert.deepEqual(A.jsonPath(o, '$.a.b[2].c'), ['x']);
  assert.deepEqual(A.jsonPath(o, '$.items[*].n'), [1, 2]);
  assert.deepEqual(A.jsonPath(o, '$.m[*]'), [1, 2]);
  assert.deepEqual(A.jsonPath(o, '$.missing'), []);
  assert.deepEqual(A.jsonPath(o, '$.a.b[9]'), []);
  assert.deepEqual(A.jsonPath(o, '$.items.n'), [], '.key does not apply to arrays');
  assert.deepEqual(A.jsonPath(o, '$.items.length'), [], 'no array length via .key');
  assert.deepEqual(A.jsonPath(o, '$.a[0]'), [], '[n] does not apply to objects');
  assert.deepEqual(A.jsonPath(o, '$.msg.toString'), [], 'inherited members are not reachable');
  for (const bad of [`$${'.a'.repeat(33)}`, `$.${'a'.repeat(300)}`, '$.a[1234567]', '', 'a', '$..a', '$.a[?(@.b)]', '$["a"]', '$.a[-1]', '$.a[0:2]', '$.a.*', '$.', '$.a b', '$.a[1', 'x.$', '$.a()', `$${'.a'.repeat(100)}`, '$.a[1e3]', '$.a[01]x']) {
    assert.throws(() => A.jsonPath(o, bad), /unsupported json_path/, JSON.stringify(bad));
  }
  for (const k of ['__proto__', 'constructor', 'prototype']) assert.throws(() => A.jsonPath(o, `$.a.${k}`), /unsupported json_path/, k);
  const parsed = JSON.parse('{"__proto__":{"polluted":"yes"}}');
  assert.throws(() => A.jsonPath(parsed, '$.__proto__.polluted'), /unsupported json_path/);
  assert.equal({}.polluted, undefined);
});

test('runApiScenario: each assertion kind passes and fails; failed names the kind only', async () => {
  const s = await fixtureServer();
  try {
    const cases = [
      [{ status: 200 }, { status: 201 }, 'status'],
      [{ header: 'X-Thing', equals: SECRET_HDR }, { header: 'x-thing', equals: 'other' }, 'header'],
      [{ header: 'x-thing', matches: '^header-value-fx-[0-9a-z]+$' }, { header: 'x-thing', matches: '^nope' }, 'header'],
      [{ header: 'x-thing', equals: SECRET_HDR }, { header: 'x-absent', equals: SECRET_HDR }, 'header'],
      [{ json_path: '$.total', equals: 2 }, { json_path: '$.total', equals: 3 }, 'json_path'],
      [{ json_path: '$.items[*].name', contains: 'Alpha' }, { json_path: '$.items[*].name', contains: 'Gamma' }, 'json_path'],
      [{ json_path: '$.msg', contains: 'world' }, { json_path: '$.msg', contains: 'mars' }, 'json_path'],
      [{ json_path: '$.tags', contains: 'y' }, { json_path: '$.tags', contains: 'z' }, 'json_path'],
      [{ json_path: '$.items[*].name', not_contains: 'Gamma' }, { json_path: '$.items[*].name', not_contains: SECRET_BODY }, 'json_path'],
      [{ json_path: '$.items[*]', count: 2 }, { json_path: '$.items[*]', count: 3 }, 'json_path'],
      [{ json_path: '$.items', count: 2 }, { json_path: '$.items', count: 1 }, 'json_path'],
      [{ json_path: '$.items[0].name', matches: '^Al' }, { json_path: '$.items[0].name', matches: '^Be' }, 'json_path'],
      [{ json_path: '$.items[0]', equals: { name: 'Alpha' } }, { json_path: '$.items[0]', equals: { name: 'Alpha', x: 1 } }, 'json_path'],
      [{ json_path: '$.total', equals: 2 }, { json_path: '$.nothing', equals: 2 }, 'json_path'],
    ];
    for (const [good, bad, kind] of cases) {
      const p = await A.runApiScenario(scen(GET(SECRET_PATH), [{ status: 200 }, good]), s.base);
      assert.deepEqual(p, { status: 'pass' }, JSON.stringify(good));
      const f = await A.runApiScenario(scen(GET(SECRET_PATH), [good, bad]), s.base);
      assert.equal(f.status, 'fail', JSON.stringify(bad));
      assert.equal(f.failed, kind);
      for (const leak of [SECRET_PATH, 'secret-path', SECRET_HDR, SECRET_BODY, 'Alpha', 'hello', 'x-thing']) assert.ok(!f.failed.includes(leak), `failed leaks ${leak}`);
    }
    const nj = await A.runApiScenario(scen(GET('/api/notjson'), [{ status: 200 }, { json_path: '$', equals: 'not json' }]), s.base);
    assert.deepEqual(nj, { status: 'fail', failed: 'json_path' }, 'a non-JSON body fails json_path assertions');
  } finally { s.close(); }
});

test('runApiScenario: setup runs first; a non-2xx or unreachable setup is blocked', async () => {
  const s = await fixtureServer();
  try {
    const ok = await A.runApiScenario(scen(GET('/api/items'), [{ status: 200 }], [{ method: 'POST', path: '/api/setup-ok', body: { name: SECRET_BODY } }]), s.base);
    assert.deepEqual(ok, { status: 'pass' });
    const order = s.seen.map((x) => x.url);
    assert.deepEqual(order.slice(-2), ['/api/setup-ok', '/api/items']);
    const hits = () => s.seen.filter((x) => x.url === SECRET_PATH).length;
    const before = hits();
    const bad = await A.runApiScenario(scen(GET(SECRET_PATH), [{ status: 200 }], [{ method: 'POST', path: '/api/setup-fail' }]), s.base);
    assert.deepEqual(bad, { status: 'blocked', failed: 'setup' });
    assert.equal(hits(), before, 'request not sent after a failed setup');
    const redirSetup = await A.runApiScenario(scen(GET(SECRET_PATH), [{ status: 200 }], [{ method: 'GET', path: '/api/redirect-in' }]), s.base);
    assert.deepEqual(redirSetup, { status: 'blocked', failed: 'setup' }, 'a 3xx setup is not 2xx');
    assert.equal(hits(), before);
    const down = await A.runApiScenario(scen(GET('/api/items'), [{ status: 200 }], [{ method: 'POST', path: '/api/setup-ok' }]), 'http://127.0.0.1:1');
    assert.deepEqual(down, { status: 'blocked', failed: 'setup' });
    const reqDown = await A.runApiScenario(scen(GET('/api/items'), [{ status: 200 }]), 'http://127.0.0.1:1');
    assert.deepEqual(reqDown, { status: 'blocked', failed: 'request' });
  } finally { s.close(); }
});

test('runApiScenario: unsupported json_path and unrecognised assertions throw before any request', async () => {
  const s = await fixtureServer();
  try {
    const before = s.seen.length;
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$..name', equals: 1 }]), s.base), /unsupported json_path/);
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$.a.__proto__', equals: 1 }]), s.base), /unsupported json_path/);
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), [{ body: 'x' }]), s.base), /assertion/);
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$.total', count: -1 }]), s.base), /assertion/);
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$.total', matches: 5 }]), s.base), /assertion/);
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$.total', matches: 'a'.repeat(1000) }]), s.base), /assertion/);
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), []), s.base), /assertion/);
    assert.equal(s.seen.length, before);
  } finally { s.close(); }
});

test('runApiScenario: only http://localhost or 127.0.0.1 base URLs', async () => {
  for (const b of ['https://127.0.0.1:1', 'http://example.com', 'http://10.0.0.1:80', 'http://[::1]:80', 'http://user:pw@127.0.0.1:1', 'http://127.0.0.1:1/api', 'http://127.0.0.1:1/?x=1', 'http://127.0.0.1:1/#x', 'http://:pw@127.0.0.1:1', 'file:///etc/passwd', 'http://localhost.evil.com', 'nope', 'http://127.0.0.1.nip.io:1']) {
    await assert.rejects(A.runApiScenario(scen(GET('/x'), [{ status: 200 }]), b), /base URL/, b);
  }
});

test('runApiScenario: request paths and headers are restricted (no host tricks, no CR/LF, no Host override)', async () => {
  const s = await fixtureServer();
  try {
    const before = s.seen.length;
    for (const p of ['//evil.com/x', '/a//b', 'http://evil.com/', 'api/items', '/a\r\nX: y', '/a\nb', '/a\\b', '/a b', '/\u0000', '', 42, `/${'a'.repeat(5000)}`]) {
      const r = await A.runApiScenario(scen(GET(p), [{ status: 200 }]), s.base);
      assert.deepEqual(r, { status: 'blocked', failed: 'request' }, JSON.stringify(p));
      const st = await A.runApiScenario(scen(GET('/api/items'), [{ status: 200 }], [{ method: 'POST', path: p }]), s.base);
      assert.deepEqual(st, { status: 'blocked', failed: 'setup' }, JSON.stringify(p));
    }
    for (const h of [{ Host: 'evil.com' }, { host: 'evil.com' }, { 'x-a': 'v\r\nInjected: 1' }, { 'x-a': 'v\nb' }, { 'bad header': 'v' }, { 'x-a': 5 }, { 'content-length': '1' }, { 'transfer-encoding': 'chunked' }, { connection: 'close' }]) {
      const r = await A.runApiScenario(scen({ method: 'GET', path: '/api/echo-headers', headers: h }, [{ status: 200 }]), s.base);
      assert.deepEqual(r, { status: 'blocked', failed: 'request' }, JSON.stringify(h));
    }
    for (const m of ['TRACE', 'CONNECT', 'get ', 'G\r\nET', undefined]) {
      assert.deepEqual(await A.runApiScenario(scen({ method: m, path: '/api/items' }, [{ status: 200 }]), s.base), { status: 'blocked', failed: 'request' }, String(m));
    }
    assert.equal(s.seen.length, before, 'nothing reached the app');
    // the same refusals with a fetch that accepts anything: our checks, not undici's, must refuse
    let calls = 0; const spy = async () => { calls++; return new Response('{}', { status: 200 }); };
    for (const p of ['/a//b', '/a b', '/a\r\nX: y', '/\u00e9', '/a#frag']) await A.runApiScenario(scen(GET(p), [{ status: 200 }]), s.base, { fetchImpl: spy });
    for (const h of [{ 'bad header': 'v' }, { 'x:a': 'v' }, { 'x\u00e9': 'v' }, { Host: 'evil.com' }, { 'x-a': 'v\r\nInjected: 1' }, { 'x-a': 'v\u0000' }, { 'content-length': '1' }, { 'Transfer-Encoding': 'chunked' }, { 'proxy-x': '1' }, { 'x-a': 'a', 'X-A': 'b' }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x-h${i}`, 'v'])), ['x']]) {
      await A.runApiScenario(scen({ method: 'GET', path: '/x', headers: h }, [{ status: 200 }]), s.base, { fetchImpl: spy });
    }
    for (const m of ['TRACE', 'CONNECT', 'get']) await A.runApiScenario(scen({ method: m, path: '/x' }, [{ status: 200 }]), s.base, { fetchImpl: spy });
    await A.runApiScenario(scen({ method: 'GET', path: '/x', body: { a: 1 } }, [{ status: 200 }]), s.base, { fetchImpl: spy });
    await A.runApiScenario(scen({ method: 'POST', path: '/x', body: 'x'.repeat(300 * 1024) }, [{ status: 200 }]), s.base, { fetchImpl: spy });
    await A.runApiScenario(scen(GET('/x'), [{ status: 200 }], Array.from({ length: 21 }, () => GET('/x'))), s.base, { fetchImpl: spy });
    assert.equal(calls, 0, 'refused before fetch');
    const ok = await A.runApiScenario(scen({ method: 'GET', path: '/api/echo-headers', headers: { 'X-Auth': 'tok' } }, [{ json_path: '$.auth', equals: 'tok' }, { json_path: '$.host', matches: '^127\\.0\\.0\\.1:\\d+$' }]), s.base);
    assert.deepEqual(ok, { status: 'pass' });
  } finally { s.close(); }
});

test('runApiScenario: redirects are not followed (3xx is the response)', async () => {
  const s = await fixtureServer();
  try {
    const out = await A.runApiScenario(scen(GET('/api/redirect-out'), [{ status: 302 }]), s.base);
    assert.deepEqual(out, { status: 'pass' });
    const in_ = await A.runApiScenario(scen(GET('/api/redirect-in'), [{ status: 200 }]), s.base);
    assert.deepEqual(in_, { status: 'fail', failed: 'status' });
    assert.equal(s.seen.filter((x) => x.other).length, 0, 'other origin never contacted');
    assert.equal(s.seen.filter((x) => x.url === '/api/items').length, 0, 'same-origin redirect not followed either');
    let init;
    await A.runApiScenario(scen(GET('/x'), [{ status: 200 }]), 'http://localhost:1', { fetchImpl: async (u, i) => { init = i; return new Response('{}', { status: 200 }); } });
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
  } finally { s.close(); }
});

test('runApiScenario: oversized bodies are capped; slow servers time out as blocked', async () => {
  const s = await fixtureServer();
  try {
    const t0 = Date.now();
    const big = await A.runApiScenario(scen(GET('/api/big'), [{ status: 200 }, { json_path: '$', equals: 1 }]), s.base, { maxBodyBytes: 256 * 1024 });
    assert.deepEqual(big, { status: 'blocked', failed: 'response' });
    const big2 = await A.runApiScenario(scen(GET('/api/big'), [{ status: 200 }]), s.base, { maxBodyBytes: 256 * 1024 });
    assert.deepEqual(big2, { status: 'blocked', failed: 'response' }, 'the body is always read under the cap');
    const slow = await A.runApiScenario(scen(GET('/api/slow'), [{ status: 200 }]), s.base, { timeoutMs: 300 });
    assert.deepEqual(slow, { status: 'blocked', failed: 'request' });
    const hang = await A.runApiScenario(scen(GET('/api/hang'), [{ status: 200 }]), s.base, { timeoutMs: 300 });
    assert.deepEqual(hang, { status: 'blocked', failed: 'request' });
    const hangSetup = await A.runApiScenario(scen(GET('/api/items'), [{ status: 200 }], [{ method: 'GET', path: '/api/hang' }]), s.base, { timeoutMs: 300 });
    assert.deepEqual(hangSetup, { status: 'blocked', failed: 'setup' });
    assert.ok(Date.now() - t0 < 5000, 'bounded');
    const lying = await A.runApiScenario(scen(GET('/x'), [{ status: 200 }]), s.base, { maxBodyBytes: 1024, fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': '99999999' } }) });
    assert.deepEqual(lying, { status: 'blocked', failed: 'response' }, 'a declared oversize body is refused before reading');
  } finally { s.close(); }
});

test('runApiScenario: a ReDoS-shaped pattern is bounded and blocked, not hung', async () => {
  const s = await fixtureServer();
  try {
    const t0 = Date.now();
    const r = await A.runApiScenario(scen(GET('/api/redos'), [{ json_path: '$.s', matches: '^(a+)+$' }]), s.base, { regexTimeoutMs: 200 });
    assert.deepEqual(r, { status: 'blocked', failed: 'json_path' });
    assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}ms`);
    const h = await A.runApiScenario(scen(GET('/api/items'), [{ header: 'x-thing', matches: '(.*a){20}$' }]), s.base, { regexTimeoutMs: 200 });
    assert.notEqual(h.status, 'pass');
    const long = await A.runApiScenario(scen(GET('/api/long'), [{ json_path: '$.s', matches: '^a+$' }]), s.base);
    assert.deepEqual(long, { status: 'fail', failed: 'json_path' }, 'subjects over the cap fail; never truncated');
    assert.deepEqual(await A.runApiScenario(scen(GET('/api/long'), [{ json_path: '$.short', matches: '^a+$' }]), s.base), { status: 'pass' });
    assert.deepEqual(await A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$.total', matches: '^2$' }]), s.base), { status: 'fail', failed: 'json_path' }, 'matches is for strings only');
    assert.deepEqual(await A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$.nothing', matches: '.*' }]), s.base), { status: 'fail', failed: 'json_path' }, 'no match is not a pass');
    await assert.rejects(A.runApiScenario(scen(GET('/api/items'), [{ header: 'x-thing', matches: 'a'.repeat(300) }]), s.base), /assertion/);
    const inv = await A.runApiScenario(scen(GET('/api/items'), [{ json_path: '$.msg', matches: '(' }]), s.base);
    assert.deepEqual(inv, { status: 'blocked', failed: 'json_path' }, 'an invalid regex is blocked, not thrown');
  } finally { s.close(); }
});

test('runApiScenario: prototype keys in the response are not traversable', async () => {
  const s = await fixtureServer();
  try {
    await assert.rejects(A.runApiScenario(scen(GET('/api/proto'), [{ json_path: '$.__proto__.polluted', equals: 'yes' }]), s.base), /unsupported json_path/);
    for (const jp of ['$.a.toString', '$.arr.length', '$.a.hasOwnProperty']) { // inherited members never resolve
      assert.deepEqual(await A.runApiScenario(scen(GET('/api/proto'), [{ json_path: jp, count: 0 }]), s.base), { status: 'fail', failed: 'json_path' }, jp);
      assert.deepEqual(await A.runApiScenario(scen(GET('/api/proto'), [{ json_path: jp, contains: 'function' }]), s.base), { status: 'fail', failed: 'json_path' }, jp);
    }
    assert.deepEqual(await A.runApiScenario(scen(GET('/api/proto'), [{ json_path: '$.a.b', equals: 1 }]), s.base), { status: 'pass' });
    assert.equal({}.polluted, undefined);
  } finally { s.close(); }
});

// ---- verdict files ----
const SHA = 'a'.repeat(40);
const SH = `sha256:${'1'.repeat(64)}`; const CH = `sha256:${'2'.repeat(64)}`;
const vdoc = (over = {}) => ({ feature: 'FEATURE-001', sha: SHA, scenarios_hash: SH, criteria_hash: CH, results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: false }, { id: 'S-2', covers: ['AC-2', 'EC-1'], status: 'pass', flaky: false }], verdict: 'pass', at: '2026-11-19T10:00:00.000Z', ...over });
function withHome(fn) {
  const prev = process.env.FACTORY_HOME; const home = tmpDir('verdict-');
  process.env.FACTORY_HOME = home;
  try { return fn(home); } finally { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; fs.rmSync(home, { recursive: true, force: true }); }
}

test('round 1: not_contains and count need the path to resolve (no vacuous passes on typos or error bodies)', async () => {
  const s = await fixtureServer();
  try {
    const r = (p, a) => A.runApiScenario(scen(GET(p), a), s.base);
    assert.deepEqual(await r('/api/err', [{ json_path: '$.items[*].name', not_contains: 'Alpha' }]), { status: 'fail', failed: 'json_path' }, '500 error body');
    assert.deepEqual(await r('/api/err', [{ json_path: '$.items', count: 0 }]), { status: 'fail', failed: 'json_path' });
    assert.deepEqual(await r('/api/items', [{ json_path: '$.itmes', count: 0 }]), { status: 'fail', failed: 'json_path' }, 'typo key');
    assert.deepEqual(await r('/api/items', [{ json_path: '$.itmes[*].name', not_contains: 'Alpha' }]), { status: 'fail', failed: 'json_path' });
    assert.deepEqual(await r('/api/items', [{ json_path: '$.items[*].nmae', not_contains: 'Alpha' }]), { status: 'fail', failed: 'json_path' }, 'typo leaf');
    assert.deepEqual(await r('/api/items', [{ json_path: '$.items[5].name', not_contains: 'Alpha' }]), { status: 'fail', failed: 'json_path' }, 'missing index');
    assert.deepEqual(await r('/api/items', [{ json_path: '$.msg[*]', count: 0 }]), { status: 'fail', failed: 'json_path' }, '[*] over a non-container');
    // legitimate empties still pass
    assert.deepEqual(await r('/api/empty', [{ json_path: '$.items[*].name', not_contains: 'Alpha' }, { json_path: '$.items', count: 0 }, { json_path: '$.items[*]', count: 0 }, { json_path: '$.meta[*]', count: 0 }]), { status: 'pass' });
    assert.deepEqual(await r('/api/items', [{ json_path: '$.items[*].name', not_contains: 'Gamma' }, { json_path: '$.items[*].name', count: 2 }]), { status: 'pass' });
  } finally { s.close(); }
});

test('round 1: localhost is pinned to 127.0.0.1; an impostor on [::1] is never reached', async (t) => {
  const real = http.createServer((q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"who":"real"}'); });
  await new Promise((r) => real.listen(0, '127.0.0.1', r));
  const port = real.address().port;
  let impostorHits = 0;
  const imp = http.createServer((q, res) => { impostorHits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"who":"impostor"}'); });
  const v6 = await new Promise((r) => { imp.once('error', () => r(false)); imp.listen(port, '::1', () => r(true)); });
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await A.runApiScenario(scen(GET('/x'), [{ status: 200 }, { json_path: '$.who', equals: 'real' }]), `http://localhost:${port}`), { status: 'pass' });
    }
    assert.equal(impostorHits, 0);
    if (!v6) t.diagnostic('IPv6 loopback unavailable: impostor not started');
    let used;
    await A.runApiScenario(scen(GET('/y'), [{ status: 200 }]), 'http://localhost:4321', { fetchImpl: async (u) => { used = u; return new Response('{}'); } });
    assert.equal(used, 'http://127.0.0.1:4321/y');
    await A.runApiScenario(scen(GET('/y'), [{ status: 200 }]), 'http://LOCALHOST', { fetchImpl: async (u) => { used = u; return new Response('{}'); } });
    assert.equal(used, 'http://127.0.0.1/y');
    await assert.rejects(A.runApiScenario(scen(GET('/x'), [{ status: 200 }]), `http://[::1]:${port}`), /base URL/);
  } finally { real.close(); if (v6) imp.close(); }
});

test('round 1: header names __proto__ / sec-* are refused; large [*] arrays are handled', async () => {
  const s = await fixtureServer();
  try {
    let calls = 0; const spy = async () => { calls++; return new Response('{}'); };
    for (const h of [JSON.parse('{"__proto__":"x"}'), JSON.parse('{"x-a":"1","__proto__":"x"}'), { 'sec-fetch-site': 'none' }, { 'Sec-X': '1' }, { constructor: 'x' }, { prototype: 'x' }]) {
      assert.deepEqual(await A.runApiScenario(scen({ method: 'GET', path: '/x', headers: h }, [{ status: 200 }]), s.base, { fetchImpl: spy }), { status: 'blocked', failed: 'request' }, JSON.stringify(h));
    }
    assert.equal(calls, 0);
    assert.deepEqual(await A.runApiScenario(scen(GET('/api/huge-array'), [{ json_path: '$.a[*]', count: 300000 }, { json_path: '$.a[*]', not_contains: 1 }]), s.base), { status: 'pass' });
  } finally { s.close(); }
});

test('validAssertion refuses empty-string contains and matches', () => {
  for (const a of [{ json_path: '$.a', contains: '' }, { json_path: '$.a', matches: '' }, { header: 'x', matches: '' }, { json_path: '$.a', matches: 5 }]) assert.equal(SC.validAssertion(a), false, JSON.stringify(a));
  for (const a of [{ json_path: '$.a', not_contains: '' }, { json_path: '$.a', equals: '' }, { header: 'x', equals: '' }, { json_path: '$.a', contains: 0 }]) assert.equal(SC.validAssertion(a), true, JSON.stringify(a));
});

test('verdictPath validates repo key, feature id and sha', () => withHome((home) => {
  assert.equal(V.verdictPath('o__r', 'FEATURE-001', SHA), path.join(home, 'verdicts', 'o__r', `FEATURE-001.${SHA}.json`));
  for (const [k, id, sha] of [['o/r', 'FEATURE-001', SHA], ['o__r__x', 'FEATURE-001', SHA], ['..__r', 'FEATURE-001', SHA], ['o__r', '../FEATURE-001', SHA], ['o__r', 'FEATURE-x', SHA], ['o__r', `FEATURE-${'1'.repeat(80)}`, SHA], ['o__r', 'FEATURE-001', 'A'.repeat(40)], ['o__r', 'FEATURE-001', 'a'.repeat(39)], ['o__r', 'FEATURE-001', 'a'.repeat(64)], ['o__r', 'FEATURE-001', '../x']]) {
    assert.throws(() => V.verdictPath(k, id, sha), /invalid/, `${k} ${id} ${sha}`);
  }
}));

test('verdict round-trip; readVerdict is fail-closed on missing, tampered, symlinked or oversized files', () => withHome((home) => {
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', SHA), null, 'missing');
  const file = V.writeVerdict('o__r', vdoc());
  assert.equal(file, V.verdictPath('o__r', 'FEATURE-001', SHA));
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
  assert.deepEqual(V.readVerdict('o__r', 'FEATURE-001', SHA), vdoc());
  assert.equal(V.readVerdict('o__r', 'FEATURE-002', SHA), null);
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', 'b'.repeat(40)), null);
  for (const bad of [[1, 2], 'x', '../evil']) assert.equal(V.readVerdict(bad, 'FEATURE-001', SHA), null, 'invalid args never throw');

  const put = (obj) => fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  const tampered = [
    '{not json', '[]', 'null', '"x"',
    vdoc({ sha: 'b'.repeat(40) }), vdoc({ feature: 'FEATURE-002' }), vdoc({ verdict: 'PASS' }), vdoc({ verdict: 'blocked' }),
    vdoc({ scenarios_hash: 'sha256:xyz' }), vdoc({ criteria_hash: 5 }), vdoc({ at: 'yesterday' }), vdoc({ at: 'x'.repeat(100) }), vdoc({ extra: 1 }),
    vdoc({ results: [] }), vdoc({ results: 'x' }), vdoc({ results: [{ id: 'S-1', covers: ['AC-1'], status: 'ok', flaky: false }] }),
    vdoc({ results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: 'no' }] }), vdoc({ results: [{ id: 'S-1', covers: [], status: 'pass', flaky: false }] }),
    vdoc({ results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: false, evil: 1 }] }), vdoc({ results: [{ id: 'x'.repeat(200), covers: ['AC-1'], status: 'pass', flaky: false }] }),
    vdoc({ results: [{ id: 'S-1', covers: ['nope'], status: 'pass', flaky: false }] }),
    vdoc({ results: Array.from({ length: 1001 }, (_, i) => ({ id: `S-${i % 9999}`, covers: ['AC-1'], status: 'pass', flaky: false })) }),
    vdoc({ results: [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: false }] }), // verdict pass with a failing result is inconsistent
    vdoc({ results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: true }] }),
    vdoc({ verdict: 'fail', results: [{ id: 'S-1', covers: ['AC-1'], status: 'ok', flaky: false }] }), // enums hold for fail verdicts too
    vdoc({ verdict: 'fail', results: [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: 'no' }] }),
  ];
  for (const t of tampered) { put(t); assert.equal(V.readVerdict('o__r', 'FEATURE-001', SHA), null, JSON.stringify(t).slice(0, 120)); }
  put(vdoc()); assert.ok(V.readVerdict('o__r', 'FEATURE-001', SHA));
  put(`${JSON.stringify(vdoc())}${' '.repeat(300 * 1024)}`); assert.equal(V.readVerdict('o__r', 'FEATURE-001', SHA), null, 'oversize');

  fs.rmSync(file); const elsewhere = path.join(home, 'elsewhere.json'); fs.writeFileSync(elsewhere, JSON.stringify(vdoc()));
  fs.symlinkSync(elsewhere, file); assert.equal(V.readVerdict('o__r', 'FEATURE-001', SHA), null, 'symlinked file');
  assert.throws(() => V.writeVerdict('o__r', vdoc()), /symlink/);
  fs.rmSync(file); fs.mkdirSync(file); assert.equal(V.readVerdict('o__r', 'FEATURE-001', SHA), null, 'directory'); fs.rmSync(file, { recursive: true });

  const realDir = path.join(home, 'realdir'); fs.mkdirSync(realDir); fs.writeFileSync(path.join(realDir, `FEATURE-001.${SHA}.json`), JSON.stringify(vdoc()));
  fs.rmSync(path.join(home, 'verdicts', 'o__r'), { recursive: true }); fs.symlinkSync(realDir, path.join(home, 'verdicts', 'o__r'));
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', SHA), null, 'symlinked repo dir');
  assert.throws(() => V.writeVerdict('o__r', vdoc()), /symlink/);
  fs.rmSync(path.join(home, 'verdicts'), { recursive: true }); fs.mkdirSync(path.join(home, 'vreal', 'o__r'), { recursive: true }); fs.symlinkSync(path.join(home, 'vreal'), path.join(home, 'verdicts'));
  fs.writeFileSync(path.join(home, 'vreal', 'o__r', `FEATURE-001.${SHA}.json`), JSON.stringify(vdoc()));
  assert.throws(() => V.writeVerdict('o__r', vdoc()), /symlink/);
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', SHA), null, 'symlinked verdicts root');
}));

test('writeVerdict refuses docs readVerdict would reject', () => withHome(() => {
  for (const bad of [vdoc({ results: [] }), vdoc({ verdict: 'maybe' }), vdoc({ sha: 'xyz' }), vdoc({ feature: '../x' }), vdoc({ extra: true }), null]) assert.throws(() => V.writeVerdict('o__r', bad), /invalid verdict/);
  assert.throws(() => V.writeVerdict('o/r', vdoc()), /invalid/);
  const fail = vdoc({ verdict: 'fail', results: [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: true }, { id: 'S-2', covers: ['ER-3'], status: 'blocked', flaky: false }] });
  V.writeVerdict('o__r', fail);
  assert.deepEqual(V.readVerdict('o__r', 'FEATURE-001', SHA), fail);
}));

test('verdictMatches: exact sha and both hashes, pass verdict, every result passing and not flaky', () => {
  const want = { sha: SHA, scenariosHash: SH, criteriaHash: CH };
  assert.equal(V.verdictMatches(vdoc(), want), true);
  assert.equal(V.verdictMatches(vdoc(), { ...want, sha: 'b'.repeat(40) }), false);
  assert.equal(V.verdictMatches(vdoc(), { ...want, sha: SHA.slice(0, 8) }), false);
  assert.equal(V.verdictMatches(vdoc(), { ...want, scenariosHash: CH }), false);
  assert.equal(V.verdictMatches(vdoc(), { ...want, criteriaHash: SH }), false);
  assert.equal(V.verdictMatches(vdoc(), { ...want, criteriaHash: undefined }), false);
  assert.equal(V.verdictMatches(vdoc(), { sha: SHA }), false);
  assert.equal(V.verdictMatches(vdoc({ verdict: 'fail' }), want), false);
  assert.equal(V.verdictMatches(vdoc({ results: [] }), want), false);
  assert.equal(V.verdictMatches(vdoc({ results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: true }] }), want), false);
  assert.equal(V.verdictMatches(vdoc({ results: [{ id: 'S-1', covers: ['AC-1'], status: 'blocked', flaky: false }] }), want), false);
  assert.equal(V.verdictMatches(vdoc({ extra: 1 }), want), false, 'shape-invalid docs never match');
  assert.equal(V.verdictMatches(null, want), false);
  assert.equal(V.verdictMatches(Object.assign(Object.create(null), vdoc()), want), false, 'only plain JSON objects');
  assert.equal(V.verdictMatches(vdoc(), null), false);
});

// ---- Task 10 helpers: what the driver stores after a passing verification (scenarios + verdict), with real hashes -----------
const CR = await import(path.join(SK, 'core', 'scripts', 'lib', 'criteria.mjs'));
const AG = await import(path.join(SK, 'core', 'scripts', 'lib', 'antigaming.mjs'));
const inHome = (r, fn) => { const prev = process.env.FACTORY_HOME; process.env.FACTORY_HOME = path.join(r.root, 'fhome'); try { return fn(); } finally { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; } };
const HIDDEN_PATH = '/api/hidden-route-fx-77aa11';
const baseSpec = (r) => spawnSync('git', ['show', 'refs/remotes/origin/main:.product/features/FEATURE-001.md'], { cwd: r.work, encoding: 'utf8' }).stdout;
function arm(r, { verdict = {}, sha = r.feat().ci_sha } = {}) {
  const ch = CR.criteriaHash(CR.extractCriteria(baseSpec(r)).sections);
  const doc = SC.approve({ feature: 'FEATURE-001', criteria_hash: ch, canary: 'fx-a1b2c3', scenarios: [{ id: 'S-1', covers: ['AC-1'], kind: 'api', request: { method: 'GET', path: HIDDEN_PATH }, assert: [{ status: 200 }] }] }, 'tester');
  inHome(r, () => { SC.saveScenarios('o__r', 'FEATURE-001', doc); V.writeVerdict('o__r', vdoc({ sha, scenarios_hash: SC.scenariosHash(doc), criteria_hash: ch, ...verdict })); });
  return { ch, sh: SC.scenariosHash(doc), doc };
}
const ghCalls = (r) => JSON.parse(fs.readFileSync(path.join(r.root, 'gh.json'), 'utf8')).calls;
const mergeCalled = (r) => ghCalls(r).some((c) => c[0] === 'pr' && c[1] === 'merge');

test('T3 with --merge-t3 merges with a real passing verdict bound to the recomputed hashes; a mismatched, failing or tampered verdict holds', () => {
  const T3 = { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'] };
  const ok = shipped({}, T3);
  arm(ok);
  const m = ok.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m)?.state, 'merged', m.out + m.err);

  const other = shipped({}, T3);
  arm(other, { sha: SHA }); // a verdict for another commit only
  const o = other.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(o).state, 'awaiting_human'); assert.match(J(o).reason, /verdict/); assert.equal(mergeCalled(other), false);

  const failing = shipped({}, T3);
  arm(failing, { verdict: { verdict: 'fail', results: [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: false }] } });
  const f = failing.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(f).state, 'awaiting_human'); assert.match(J(f).reason, /verdict/);

  const tamper = shipped({}, T3);
  arm(tamper);
  const tf = path.join(tamper.root, 'fhome', 'verdicts', 'o__r', `FEATURE-001.${tamper.feat().ci_sha}.json`);
  fs.writeFileSync(tf, fs.readFileSync(tf, 'utf8').replace('"flaky": false', '"flaky": true'));
  assert.equal(J(tamper.d({}, 'merge', 'FEATURE-001')).state, 'awaiting_human');

  // Task 10: the T3 path binds the hashes too (verification.required is false here). The old sha-only binding merged these.
  const scen = shipped({}, T3);
  arm(scen, { verdict: { scenarios_hash: `sha256:${'9'.repeat(64)}` } });
  const s = scen.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(s).state, 'awaiting_human', s.out + s.err); assert.match(J(s).reason, /scenarios_hash/); assert.equal(mergeCalled(scen), false);
  const crit = shipped({}, T3);
  arm(crit, { verdict: { criteria_hash: `sha256:${'8'.repeat(64)}` } });
  const c = crit.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(c).state, 'awaiting_human'); assert.match(J(c).reason, /criteria_hash/);
  for (const r of [ok, other, failing, tamper, scen, crit]) fs.rmSync(r.root, { recursive: true, force: true });
});

// ---- Task 9: verification step, symptom brief, factory/verified status --------------------------------------------------------
import os from 'node:os';
import net from 'node:net';
const VF = await import(path.join(SK, 'core', 'scripts', 'lib', 'verify.mjs'));
const GS = await import(path.join(SK, 'core', 'scripts', 'lib', 'gitsafe.mjs'));
const SBX = await import(path.join(SK, 'core', 'scripts', 'lib', 'sandbox.mjs'));
const PR = await import(path.join(SK, 'core', 'scripts', 'lib', 'proc.mjs'));

const SBX_AVAIL = SBX.sandboxAvailable();
const SBX_SKIP = SBX_AVAIL.ok ? false : `real sandbox unavailable here (${SBX_AVAIL.reason}); only the seam-based verification tests ran`;
if (SBX_SKIP) console.log(`# factory-verify: SKIPPING real-sandbox verification tests: ${SBX_SKIP}`);

const CANARY = 'fx-c0ffee';
const VCH = `sha256:${'3'.repeat(64)}`;
// postVerified args for a doc, with that doc stored as the verdict file (docs writeVerdict rejects are simply not stored).
const withStored = (doc) => { try { V.writeVerdict('o__r', doc); } catch { /* invalid on purpose */ } return { doc, repoKey: 'o__r', id: 'FEATURE-001' }; };

const NOTE_PATH = `/api/notes/secret-${CANARY}`;
const NOTE_DATA = `Secret note ${CANARY}`;
const vscenarios = (over = {}) => ({
  feature: 'FEATURE-001', criteria_hash: VCH, canary: CANARY,
  scenarios: [
    { id: 'S-1', covers: ['AC-1'], kind: 'api', request: { method: 'GET', path: '/api/items' }, assert: [{ status: 200 }, { json_path: '$.items', count: 0 }] },
    { id: 'S-2', covers: ['AC-2', 'EC-1'], kind: 'api', setup: [{ method: 'POST', path: '/api/notes', body: { name: NOTE_DATA } }],
      request: { method: 'GET', path: NOTE_PATH }, assert: [{ status: 200 }, { json_path: '$.name', equals: `secret-${CANARY}` }] },
  ],
  ...over,
});
const LEAK_STRINGS = [CANARY, NOTE_PATH, NOTE_DATA, '/api/notes', '/api/items', 'secret-', 'S-1', 'S-2', '$.name', '$.items'];

// The fixture app: /api/items is right; /api/notes/<x> is right only in the good build (the bad build answers 500).
const appSource = (good) => `import http from 'node:http';
const json = (s, c, o) => { s.writeHead(c, { 'content-type': 'application/json' }); s.end(JSON.stringify(o)); };
http.createServer((q, s) => {
  if (q.url === '/health') return json(s, 200, { ok: true });
  if (q.url === '/api/items') return json(s, 200, { items: [] });
  if (q.method === 'POST' && q.url === '/api/notes') return json(s, 201, { ok: true });
  if (q.url.startsWith('/api/notes/')) return ${good ? "json(s, 200, { name: decodeURIComponent(q.url.split('/').pop()) })" : "json(s, 500, { name: 'oops' })"};
  json(s, 404, {});
}).listen(Number(process.env.PORT), process.env.HOST);
`;
const vfreePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
const rawGit = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: GS.gitEnv() });

// FACTORY_HOME + a factory clone with a base commit (refs/remotes/origin/main) and a bad and a good feature commit on top.
async function vworld(t) {
  const root = fs.realpathSync(tmpDir('factory-verify-'));
  t.after(() => { try { fs.chmodSync(path.join(root, 'fh', 'work', 'o__r'), 0o700); } catch { /* absent */ } fs.rmSync(root, { recursive: true, force: true }); });
  const fh = path.join(root, 'fh'); fs.mkdirSync(fh);
  const prev = process.env.FACTORY_HOME; process.env.FACTORY_HOME = fh;
  t.after(() => { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; });
  const clone = path.join(root, 'clone'); fs.mkdirSync(clone);
  const g = (...a) => { const r = rawGit(clone, ...a); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@x'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(clone, 'server.mjs'), appSource(false));
  fs.writeFileSync(path.join(clone, '.env.example'), 'FOO=base\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base'); g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(clone, '.env.example'), 'FOO=feature\n');
  fs.mkdirSync(path.join(clone, '.product'));
  fs.writeFileSync(path.join(clone, '.product', 'delivery.json'), JSON.stringify({ app: { start: ['node', '-e', 'evil()'] } }));
  g('add', '-A'); g('commit', '-q', '-m', 'bad feature'); const bad = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(clone, 'server.mjs'), appSource(true));
  g('add', '-A'); g('commit', '-q', '-m', 'good feature'); const good = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  const port = await vfreePort();
  const { config, errors } = c.parseConfig({ base: 'main', app: {
    setup: ['node', '-e', "require('fs').writeFileSync('setup-ran.txt','1')"], seed: ['node', '-e', 'process.exit(0)'], start: ['node', 'server.mjs'],
    base_url: `http://127.0.0.1:${port}`, ready: { url: `http://localhost:${port}/health`, timeout_s: 20 }, env_example: '.env.example' } });
  assert.deepEqual(errors, []);
  const log = [];
  const git = (...a) => { if (a[0] === 'worktree') log.push(['git', a[1]]); return GS.gitSafeOpts(clone, a); };
  const wtOf = (sha) => path.join(fs.realpathSync(fh), 'work', 'o__r', `FEATURE-001-${sha}`);
  const worktrees = () => rawGit(clone, 'worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
  const args = (over = {}) => ({ repoKey: 'o__r', id: 'FEATURE-001', sha: bad, baseRef: 'refs/remotes/origin/main', config, scenarios: vscenarios(), criteriaHash: VCH, git, ...over });
  return { root, fh, clone, bad, good, port, config, log, git, wtOf, worktrees, args };
}

// Seams standing in for the sandbox and the app (no real processes): every call is logged so order can be asserted.
function vseams(log, over = {}) {
  return {
    sandboxAvailable: () => ({ ok: true }),
    sandboxProfile: ({ network, writable, tmpDir: tmp }) => { log.push(['profile', network, writable, tmp]); return `(version 1)\n; net ${JSON.stringify(network)}\n`; },
    runSandboxed: async (argv, o) => { log.push(['run', argv, o.profile, o.env, o.cwd]); return { code: 0, timedOut: false }; },
    startSandboxed: (argv, o) => { log.push(['start', argv, o.profile, o.env, o.cwd]); return { pid: 0, pgid: 0, up: true, output: () => '' }; },
    stopApp: async (app, o) => { log.push(['stop', o?.stopArgv]); app.up = false; },
    alive: (app) => app.up,
    waitReady: async (ready) => { log.push(['ready', ready]); return true; },
    portInUse: async () => false,
    survivors: async () => 0,
    runApiScenario: async (sc, base) => { log.push(['api', sc.id, base]); return { status: 'pass' }; },
    ...over,
  };
}
const kinds = (log) => log.map((e) => e[0] === 'git' ? `git ${e[1]}` : e[0]);
const throwing = () => new Proxy({}, { get: (_, k) => () => { throw new Error(`seam ${String(k)} must not be called`); } });

test('verifyFeature (real sandbox): a wrong endpoint fails with only its covers in the brief; the app is stopped and the worktree removed', { skip: SBX_SKIP }, async (t) => {
  const w = await vworld(t);
  const r = await VF.verifyFeature(w.args());
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reused, false);
  assert.deepEqual(r.doc.results, [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: false }, { id: 'S-2', covers: ['AC-2', 'EC-1'], status: 'fail', flaky: false }]);
  assert.deepEqual(r.brief, ['AC-2, EC-1: an endpoint returned an unexpected status or body']);
  const text = JSON.stringify(r.brief);
  for (const s of LEAK_STRINGS) assert.ok(!text.includes(s), `brief leaks ${s}`);
  assert.deepEqual(V.readVerdict('o__r', 'FEATURE-001', w.bad), r.doc);
  assert.equal(r.doc.scenarios_hash, SC.scenariosHash(vscenarios())); assert.equal(r.doc.criteria_hash, VCH);
  assert.ok(!fs.existsSync(w.wtOf(w.bad)), 'worktree removed');
  assert.equal(w.worktrees(), 1, 'only the clone itself is registered');
  assert.equal(await PR.portInUse(w.port), false, 'nothing listens after verification');
  assert.deepEqual(fs.readdirSync(path.join(w.fh, 'tmp')), [], 'run temp removed');
  assert.deepEqual(kinds(w.log), ['git add', 'git prune']);
  assert.deepEqual(fs.readdirSync(path.join(w.fh, 'trash')), [], 'quarantined worktree deleted');

  const ok = await VF.verifyFeature(w.args({ sha: w.good }));
  assert.equal(ok.verdict, 'pass', JSON.stringify(ok.doc.results));
  assert.deepEqual(ok.brief, []);
  assert.ok(V.verdictMatches(V.readVerdict('o__r', 'FEATURE-001', w.good), { sha: w.good, scenariosHash: SC.scenariosHash(vscenarios()), criteriaHash: VCH }));
  const again = await VF.verifyFeature(w.args({ sha: w.good }), throwing());
  assert.equal(again.reused, true); assert.equal(again.verdict, 'pass'); assert.deepEqual(again.doc, ok.doc);
  assert.equal(await PR.portInUse(w.port), false);
});

test('verifyFeature: commands come from the base config, env from the base env example, networks per phase, app on 127.0.0.1', async (t) => {
  const w = await vworld(t);
  const r = await VF.verifyFeature(w.args(), vseams(w.log));
  assert.equal(r.verdict, 'pass');
  const wt = w.wtOf(w.bad);
  const profiles = w.log.filter((e) => e[0] === 'profile');
  assert.deepEqual(profiles.map((e) => e[1]), ['registries', { localhostPort: w.port }]);
  for (const p of profiles) { assert.deepEqual(p[2], [wt]); assert.ok(p[3].startsWith(path.join(fs.realpathSync(w.fh), 'tmp') + path.sep)); }
  const runs = w.log.filter((e) => e[0] === 'run');
  assert.deepEqual(runs[0][1], w.config.app.setup); assert.match(runs[0][2], /"registries"/);
  const seeds = runs.slice(1);
  assert.equal(seeds.length, 4, 'seed before each of 2 runs x 2 scenarios');
  for (const s of seeds) { assert.deepEqual(s[1], w.config.app.seed); assert.match(s[2], /localhostPort/); }
  const starts = w.log.filter((e) => e[0] === 'start');
  assert.equal(starts.length, 4);
  for (const s of starts) {
    assert.deepEqual(s[1], ['node', 'server.mjs']); assert.match(s[2], /localhostPort/); assert.equal(s[4], wt);
    assert.equal(s[3].HOST, '127.0.0.1'); assert.equal(s[3].PORT, String(w.port)); assert.equal(s[3].FOO, 'base', 'env example read from the base, not the feature branch');
  }
  for (const e of w.log.filter((x) => x[0] === 'ready')) assert.equal(e[1].url, `http://127.0.0.1:${w.port}/health`, 'localhost ready URL pinned to 127.0.0.1');
  for (const e of w.log.filter((x) => x[0] === 'stop')) assert.equal(e[1], undefined, 'app.stop is never run unsandboxed');
  assert.deepEqual(kinds(w.log).filter((k) => ['start', 'stop', 'api'].includes(k)), ['start', 'api', 'stop', 'start', 'api', 'stop', 'start', 'api', 'stop', 'start', 'api', 'stop']);
  assert.ok(kinds(w.log).lastIndexOf('stop') < kinds(w.log).indexOf('git prune'), 'app stopped before the worktree is touched');
});

test('verifyFeature: a configured app.stop runs sandboxed on the app port, before the process-group stop', async (t) => {
  const w = await vworld(t);
  const config = { ...w.config, app: { ...w.config.app, stop: ['node', '-e', 'stop()'] } };
  await VF.verifyFeature(w.args({ config }), vseams(w.log));
  const i = w.log.findIndex((e) => e[0] === 'run' && e[1][2] === 'stop()');
  assert.ok(i > 0); assert.match(w.log[i][2], /localhostPort/); assert.equal(w.log[i + 1][0], 'stop');
});

test('verifyFeature: both runs must pass; disagreement is fail + flaky; blocked never passes', async (t) => {
  const w = await vworld(t);
  const seq = { 'S-1': ['pass', 'fail'], 'S-2': ['blocked', 'blocked'] };
  const r = await VF.verifyFeature(w.args(), vseams(w.log, { runApiScenario: async (sc) => ({ status: seq[sc.id].shift() }) }));
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.doc.results, [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: true }, { id: 'S-2', covers: ['AC-2', 'EC-1'], status: 'blocked', flaky: false }]);
  assert.deepEqual(r.brief, ['AC-1: an endpoint returned an unexpected status or body', 'AC-2, EC-1: an endpoint returned an unexpected status or body']);

  const w2 = await vworld(t);
  const r2 = await VF.verifyFeature(w2.args(), vseams(w2.log, { waitReady: async () => false }));
  assert.equal(r2.verdict, 'fail'); assert.ok(r2.doc.results.every((x) => x.status === 'blocked'));
  assert.ok(!w2.log.some((e) => e[0] === 'api'), 'no request when the app never became ready');

  const w3 = await vworld(t);
  const r3 = await VF.verifyFeature(w3.args(), vseams(w3.log, { runSandboxed: async (argv) => ({ code: argv === w3.config.app.setup ? 1 : 0, timedOut: false }) }));
  assert.equal(r3.verdict, 'fail'); assert.ok(r3.doc.results.every((x) => x.status === 'blocked' && !x.flaky));
  assert.ok(!w3.log.some((e) => e[0] === 'start'), 'app not started after a failed setup');

  const w4 = await vworld(t); // the app dies during the request (an impostor may have answered): a pass is not trusted
  let n = 0;
  const r4 = await VF.verifyFeature(w4.args(), vseams(w4.log, { alive: (app) => app.up && !(app.checked = (app.checked ?? 0) + 1, n++, app.checked > 1) }));
  assert.equal(r4.verdict, 'fail'); assert.ok(n > 0); assert.ok(r4.doc.results.every((x) => x.status === 'blocked'));

  const w5 = await vworld(t);
  const r5 = await VF.verifyFeature(w5.args(), vseams(w5.log, { runSandboxed: async (argv) => ({ code: argv === w5.config.app.seed ? 3 : 0, timedOut: false }) }));
  assert.ok(r5.doc.results.every((x) => x.status === 'blocked')); assert.ok(!w5.log.some((e) => e[0] === 'start'));
});

test('verifyFeature: the app is always stopped and the worktree removed on thrown errors (stop before removal)', async (t) => {
  for (const [name, over] of [
    ['request', { runApiScenario: async () => { throw new Error('boom-request'); } }],
    ['ready', { waitReady: async () => { throw new Error('boom-ready'); } }],
    ['setup', { runSandboxed: async () => { throw new Error('boom-setup'); } }],
    ['start', { startSandboxed: () => { throw new Error('boom-start'); } }],
  ]) {
    const w = await vworld(t);
    await assert.rejects(VF.verifyFeature(w.args(), vseams(w.log, over)), new RegExp(`boom-${name}`));
    const k = kinds(w.log);
    if (k.includes('start')) assert.ok(k.indexOf('stop') > k.indexOf('start') && k.indexOf('stop') < k.indexOf('git prune'), `${name}: ${k}`);
    assert.ok(k.includes('git prune') && !k.includes('git remove'), name);
    assert.ok(!fs.existsSync(w.wtOf(w.bad)), name); assert.equal(w.worktrees(), 1, name);
    assert.deepEqual(fs.readdirSync(path.join(w.fh, 'tmp')), [], `${name}: run temp removed`);
    assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.bad), null, `${name}: no verdict on a crash`);
  }
});

test('verifyFeature: an app that will not exit leaves the worktree in place (no git call while it may run); removal failure never masks the error', async (t) => {
  const w = await vworld(t);
  const e = await VF.verifyFeature(w.args(), vseams(w.log, { stopApp: async () => {}, alive: () => true })).catch((x) => x);
  assert.match(e.message, /did not exit/);
  assert.ok(!kinds(w.log).some((k) => k.startsWith('git ') && k !== 'git add'), 'no worktree git command while the app may still run');
  assert.match(e.cleanupError, /left in place/);

  if (process.getuid?.() === 0) return;
  const w2 = await vworld(t);
  const parent = path.dirname(w2.wtOf(w2.bad));
  const e2 = await VF.verifyFeature(w2.args(), vseams(w2.log, { runApiScenario: async () => { fs.chmodSync(parent, 0o500); throw new Error('boom-original'); } })).catch((x) => x);
  fs.chmodSync(parent, 0o700);
  assert.match(e2.message, /boom-original/);
  assert.match(e2.cleanupError, /could not be moved to the trash: it was left in place/);
  assert.ok(fs.existsSync(w2.wtOf(w2.bad)), 'never deleted in place when the quarantine move fails');
  assert.ok(!kinds(w2.log).includes('git prune'), 'no prune while the tree is still registered in place');
});

test('verifyFeature: refuses when something already listens on the port (127.0.0.1 or ::1), and when it is still listening after stop', async (t) => {
  const w = await vworld(t);
  const s4 = net.createServer(); await new Promise((r) => s4.listen(w.port, '127.0.0.1', r));
  await assert.rejects(VF.verifyFeature(w.args(), vseams(w.log, { portInUse: PR.portInUse })), /port \d+ is already in use/);
  await new Promise((r) => s4.close(r));
  assert.deepEqual(w.log, [], 'nothing created or run'); assert.ok(!fs.existsSync(path.join(w.fh, 'work')));

  const s6 = net.createServer();
  const v6 = await new Promise((r) => { s6.once('error', () => r(false)); s6.listen(w.port, '::1', () => r(true)); });
  if (v6) {
    await assert.rejects(VF.verifyFeature(w.args(), vseams(w.log, { portInUse: PR.portInUse })), /port \d+ is already in use/);
    await new Promise((r) => s6.close(r));
    assert.deepEqual(w.log, []);
  } else t.diagnostic('::1 unavailable: IPv6 impostor check skipped');

  const w2 = await vworld(t);
  let busy = false;
  const e = await VF.verifyFeature(w2.args(), vseams(w2.log, { stopApp: async (app) => { app.up = false; busy = true; }, portInUse: async () => busy })).catch((x) => x);
  assert.match(e.message, /still running or listening/);
  // an escaped listener is a sandboxed process that may still touch the worktree: no git command runs there, the dir stays
  assert.match(e.cleanupError, /left in place/);
  assert.ok(!kinds(w2.log).includes('git prune')); assert.ok(fs.existsSync(w2.wtOf(w2.bad)));
  assert.equal(fs.readdirSync(path.join(w2.fh, 'tmp')).length, 1, 'run temp left in place too');
});

test('verifyFeature: refuses without the sandbox, before creating anything', async (t) => {
  const w = await vworld(t);
  await assert.rejects(VF.verifyFeature(w.args(), vseams(w.log, { sandboxAvailable: () => ({ ok: false, reason: 'sandbox-exec is macOS only' }) })), /sandbox unavailable \(sandbox-exec is macOS only\)/);
  assert.deepEqual(w.log, []); assert.ok(!fs.existsSync(path.join(w.fh, 'work')));
});

test('verifyFeature: a matching pass verdict is reused without running; a stale or failing one is not', async (t) => {
  const w = await vworld(t);
  const doc = { feature: 'FEATURE-001', sha: w.bad, scenarios_hash: SC.scenariosHash(vscenarios()), criteria_hash: VCH, results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: false }, { id: 'S-2', covers: ['AC-2', 'EC-1'], status: 'pass', flaky: false }], verdict: 'pass', at: new Date().toISOString() };
  V.writeVerdict('o__r', doc);
  const r = await VF.verifyFeature(w.args(), throwing());
  assert.deepEqual(r, { verdict: 'pass', doc, brief: [], reused: true });
  // scenario content changed -> hash differs -> runs again
  const changed = vscenarios(); changed.scenarios[0].assert.push({ json_path: '$.items', not_contains: 'x' });
  const r2 = await VF.verifyFeature(w.args({ scenarios: changed }), vseams(w.log));
  assert.equal(r2.reused, false); assert.ok(w.log.some((e) => e[0] === 'api'));
  // a fail verdict for the same hashes is never reused
  V.writeVerdict('o__r', { ...doc, scenarios_hash: SC.scenariosHash(changed), verdict: 'fail', results: [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: false }] });
  w.log.length = 0;
  const r3 = await VF.verifyFeature(w.args({ scenarios: changed }), vseams(w.log));
  assert.equal(r3.reused, false); assert.ok(w.log.some((e) => e[0] === 'api'));
});

test('verifyFeature: input validation (ids, sha, base ref, config, UI scenarios, stale criteria hash)', async (t) => {
  const w = await vworld(t);
  const app = w.config.app;
  for (const [over, re] of [
    [{ repoKey: 'o/r' }, /repo key/], [{ id: '../x' }, /feature id/], [{ sha: 'A'.repeat(40) }, /sha/], [{ baseRef: 'origin/main' }, /base ref/],
    [{ baseRef: 'refs/remotes/origin/../x' }, /base ref/], [{ git: null }, /git/], [{ criteriaHash: 'x' }, /criteria hash/],
    [{ scenarios: vscenarios({ criteria_hash: `sha256:${'9'.repeat(64)}` }) }, /criteria_hash is not current/],
    [{ scenarios: vscenarios({ scenarios: [] }) }, /no api scenarios/],
    [{ scenarios: vscenarios({ scenarios: [...vscenarios().scenarios, { id: 'S-3', covers: ['AC-3'], kind: 'ui', steps: ['a'], expect: ['b'] }] }) }, /UI scenarios/],
    [{ scenarios: vscenarios({ scenarios: [{ ...vscenarios().scenarios[0], covers: ['nope'] }] }) }, /covers/],
    [{ config: { ...w.config, app: { ...app, base_url: null } } }, /base_url/],
    [{ config: { ...w.config, app: { ...app, base_url: 'http://example.com:80' } } }, /base_url/],
    [{ config: { ...w.config, app: { ...app, start: null } } }, /app.start/],
    [{ config: { ...w.config, app: { ...app, ready: null } } }, /app.ready/],
    [{ config: { ...w.config, app: { ...app, ready: { url: `http://127.0.0.1:${w.port + 1}/health`, timeout_s: 5 } } } }, /same port/],
    [{ sha: 'b'.repeat(40) }, /not a commit/],
  ]) await assert.rejects(VF.verifyFeature(w.args(over), vseams(w.log)), re, JSON.stringify(over).slice(0, 80));
  assert.ok(!w.log.some((e) => ['run', 'start'].includes(e[0])));
});

test('symptomBrief: criterion IDs and the fixed sentence only; never ids, paths, data, the canary, quotes or URLs (Review Focus 2)', () => {
  const sc = vscenarios();
  const failures = [
    { id: 'S-2', covers: ['AC-2', 'EC-1'], status: 'fail', flaky: false },
    { id: 'S-9', covers: ['AC-2', 'EC-1', 'AC-2'], status: 'blocked', flaky: false },
    { id: NOTE_PATH, covers: ['AC-3', NOTE_PATH, `AC-4 ${CANARY}`, 'S-1', 'ac-5', 'AC-0', 'AC-12345', '"AC-6"', 'AC-7\n', ' ER-1', 'http://x/AC-8', { toString: () => 'AC-9' }, 'ER-2'], status: 'fail', flaky: false },
    { id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: false },
    { id: 'S-5', covers: ['EC-3'], status: 'pass', flaky: true },
    { covers: [NOTE_DATA], status: 'fail' }, null, 'AC-1', { status: 'fail' },
  ];
  const brief = VF.symptomBrief(failures, sc, CANARY);
  assert.deepEqual(brief, [
    'AC-2, EC-1: an endpoint returned an unexpected status or body',
    'AC-3, ER-2: an endpoint returned an unexpected status or body',
    'EC-3: an endpoint returned an unexpected status or body',
  ]);
  const text = brief.join('\n');
  for (const s of [...LEAK_STRINGS, 'S-5', 'S-9', 'http', '"', "'", '`', '/']) assert.ok(!text.includes(s), `brief leaks ${s}`);
  for (const l of brief) assert.match(l, /^(?:(?:AC|EC|ER)-[1-9]\d{0,3})(?:, (?:AC|EC|ER)-[1-9]\d{0,3})*: an endpoint returned an unexpected status or body$/);
  assert.deepEqual(VF.symptomBrief(failures, sc.scenarios, CANARY), brief, 'scenarios as a doc or an array');
  for (const junk of [undefined, null, 'x', {}, [null]]) assert.deepEqual(VF.symptomBrief(junk, sc, CANARY), []);
});

test('symptomBrief: a scenario string that overlaps the fixed sentence falls back, then drops; caps hold', () => {
  const sc = vscenarios(); sc.scenarios[0].request.body = { note: 'an unexpected status' };
  assert.deepEqual(VF.symptomBrief([{ covers: ['AC-1'], status: 'fail' }], sc, CANARY), ['behaviour does not satisfy AC-1']);
  sc.scenarios[0].request.body.other = 'does not satisfy';
  assert.deepEqual(VF.symptomBrief([{ covers: ['AC-1'], status: 'fail' }], sc, CANARY), []);
  const many = Array.from({ length: 300 }, (_, i) => ({ covers: [`AC-${i + 1}`], status: 'fail' }));
  const b = VF.symptomBrief(many, vscenarios(), CANARY);
  assert.equal(b.length, 50);
  const wide = VF.symptomBrief([{ covers: Array.from({ length: 60 }, (_, i) => `EC-${i + 1}`), status: 'fail' }], vscenarios(), CANARY);
  assert.equal(wide.length, 1); assert.equal(wide[0].split(', ').length, 20); assert.ok(wide[0].length <= 300);
  // a canary that is not a string, or scenarios that are junk, do not crash and do not loosen the ID filter
  assert.deepEqual(VF.symptomBrief([{ covers: ['AC-1', 'zz'], status: 'fail' }], 'junk', 42), ['AC-1: an endpoint returned an unexpected status or body']);
});

const pdoc = (sha, n) => ({ feature: 'FEATURE-001', sha, scenarios_hash: SH, criteria_hash: CH, results: Array.from({ length: n }, (_, i) => ({ id: `S-${i + 1}`, covers: ['AC-1'], status: 'pass', flaky: false })), verdict: 'pass', at: '2026-11-19T10:00:00.000Z' });

// Fake gh as a function (argv only), state in a JSON file; the PR's head comes from a real repo.
function ghWorld(t, body = 'Adds notes.\n\nCloses FEATURE-001.') {
  const root = fs.realpathSync(tmpDir('factory-ghv-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin'); fs.mkdirSync(origin);
  const g = (...a) => rawGit(origin, ...a).stdout.trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@x'); g('config', 'user.name', 't'); g('commit', '-q', '--allow-empty', '-m', 'base');
  g('checkout', '-q', '-b', 'feat/notes'); g('commit', '-q', '--allow-empty', '-m', 'feat'); const sha = g('rev-parse', 'HEAD'); g('checkout', '-q', 'main');
  const prevFh = process.env.FACTORY_HOME; process.env.FACTORY_HOME = path.join(root, 'fh');
  t.after(() => { if (prevFh === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prevFh; });
  const sp = path.join(root, 'state.json');
  fs.writeFileSync(sp, JSON.stringify({ calls: [], origin, prs: [{ number: 7, head: 'feat/notes', base: 'main', state: 'OPEN', draft: false, mergeState: 'CLEAN', url: 'https://github.com/o/r/pull/7', body }] }));
  const gh = (...a) => { const r = spawnSync(process.execPath, [FAKE_GH, ...a], { encoding: 'utf8', env: { ...process.env, FAKE_GH_STATE: sp } }); return { code: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' }; };
  const state = () => JSON.parse(fs.readFileSync(sp, 'utf8'));
  return { gh, sha, state, sp };
}

test('postVerified: factory/verified success on the exact sha, PR body line with the count only, idempotent', (t) => {
  const w = ghWorld(t);
  const r = VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, ...withStored(pdoc(w.sha, 2)) });
  assert.equal(r.line, `Verified: 2/2 scenarios at ${w.sha.slice(0, 7)}`);
  const st = w.state();
  assert.deepEqual(st.statuses[w.sha], [{ state: 'success', context: 'factory/verified', description: VF.VERIFIED_DESCRIPTION }]);
  const post = st.calls.find((c) => c.includes('POST'));
  assert.deepEqual(post.slice(0, 4), ['api', '-X', 'POST', `repos/o/r/statuses/${w.sha}`]);
  assert.equal(st.prs[0].body, `Adds notes.\n\nCloses FEATURE-001.\n\nVerified: 2/2 scenarios at ${w.sha.slice(0, 7)}`);
  const edit = st.calls.find((c) => c[0] === 'pr' && c[1] === 'edit');
  assert.equal(edit[2], '7'); assert.ok(edit.includes('--body-file'));
  assert.ok(!fs.existsSync(edit[edit.indexOf('--body-file') + 1]), 'body file removed');
  const all = JSON.stringify(st);
  for (const s of LEAK_STRINGS) assert.ok(!all.includes(s), `gh traffic leaks ${s}`);
  // again with a new count: the Verified line is replaced, never duplicated; the rest of the body is kept
  VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 3, pr: 7, ...withStored(pdoc(w.sha, 3)) });
  assert.equal(w.state().prs[0].body, `Adds notes.\n\nCloses FEATURE-001.\n\nVerified: 3/3 scenarios at ${w.sha.slice(0, 7)}`);
  const edits = w.state().calls.filter((c) => c[0] === 'pr' && c[1] === 'edit').length;
  VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 3, pr: 7, ...withStored(pdoc(w.sha, 3)) });
  assert.equal(w.state().calls.filter((c) => c[0] === 'pr' && c[1] === 'edit').length, edits, 'unchanged body is not re-edited');
});

test('postVerified: validates inputs before any gh call; refuses a moved PR head; gh failures throw', (t) => {
  const w = ghWorld(t, '');
  for (const bad of [{ sha: 'A'.repeat(40) }, { sha: w.sha.slice(0, 39) }, { n: 0 }, { n: 1.5 }, { n: '2' }, { repo: 'o' }, { repo: 'o/r/x' }, { repo: '-o/r' }, { pr: 0 }, { pr: '7' }, { gh: null }]) {
    assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, ...withStored(pdoc(w.sha, 2)), ...bad }), /invalid/, JSON.stringify(bad));
  }
  assert.equal(w.state().calls.length, 0);
  assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: 'c'.repeat(40), n: 2, pr: 7, ...withStored(pdoc('c'.repeat(40), 2)) }), /PR head/);
  assert.ok(!w.state().calls.some((c) => c[1] === 'edit'));
  const r = VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 1, pr: 7, ...withStored(pdoc(w.sha, 1)) });
  assert.equal(w.state().prs[0].body, r.line, 'empty body gets just the line');
  const failing = (...a) => (a[0] === 'api' ? { code: 1, out: '', err: 'HTTP 403' } : w.gh(...a));
  assert.throws(() => VF.postVerified({ gh: failing, repo: 'o/r', sha: w.sha, n: 1, pr: 7, ...withStored(pdoc(w.sha, 1)) }), /factory\/verified/);
});

test('withVerifiedLine replaces every existing Verified line in place and keeps the rest', () => {
  const L = 'Verified: 4/4 scenarios at abcdef1';
  assert.equal(VF.withVerifiedLine('A\nVerified: 1/1 scenarios at 1234567\nB\nVerified: 2/2 scenarios at 7654321', L), `A\n${L}\nB`);
  assert.equal(VF.withVerifiedLine('A\r\nB', L), `A\r\nB\n\n${L}`);
  assert.equal(VF.withVerifiedLine('', L), L);
  assert.equal(VF.withVerifiedLine('Not Verified: 1/1 scenarios at 1234567', L), `Not Verified: 1/1 scenarios at 1234567\n\n${L}`);
});

test('verifyFeature: a leftover worktree dir is cleared first; a symlinked work dir is refused; an unknown status never passes', async (t) => {
  const w = await vworld(t);
  fs.mkdirSync(w.wtOf(w.bad), { recursive: true }); fs.writeFileSync(path.join(w.wtOf(w.bad), 'planted.txt'), 'x');
  const r = await VF.verifyFeature(w.args(), vseams(w.log, { runApiScenario: async () => ({ status: 'PASS' }) }));
  assert.equal(r.verdict, 'fail'); assert.ok(r.doc.results.every((x) => x.status === 'blocked'));
  assert.ok(!fs.existsSync(w.wtOf(w.bad))); assert.equal(w.worktrees(), 1);

  const w2 = await vworld(t);
  const elsewhere = path.join(w2.root, 'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(w2.fh, 'work'));
  await assert.rejects(VF.verifyFeature(w2.args(), vseams(w2.log)), /symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('symptomBrief: object keys inside request bodies are data too; schema keys are not', () => {
  const sc = vscenarios(); sc.scenarios[1].setup[0].body = { 'an unexpected status': 1 };
  assert.deepEqual(VF.symptomBrief([{ covers: ['AC-2'], status: 'fail' }], sc, CANARY), ['behaviour does not satisfy AC-2']);
  const hdr = vscenarios(); hdr.scenarios[0].request.headers = { 'status or body': 'v' }; // a header NAME that is a substring of the fixed sentence
  assert.deepEqual(VF.symptomBrief([{ covers: ['AC-2'], status: 'fail' }], hdr, CANARY), ['behaviour does not satisfy AC-2']);
});

test('postVerified: a status that does not show up after posting throws before the body edit', (t) => {
  const w = ghWorld(t);
  const gh = (...a) => (a[0] === 'api' && a[1].endsWith('/status') ? { code: 0, out: JSON.stringify({ statuses: [{ context: 'factory/verified', state: 'pending' }] }), err: '' } : w.gh(...a));
  assert.throws(() => VF.postVerified({ gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, ...withStored(pdoc(w.sha, 2)) }), /not visible/);
  assert.ok(!w.state().calls.some((c) => c[1] === 'edit'));
});

test('postVerified: a failing pr edit throws', (t) => {
  const w = ghWorld(t);
  const gh = (...a) => (a[0] === 'pr' && a[1] === 'edit' ? { code: 1, out: '', err: 'HTTP 422' } : w.gh(...a));
  assert.throws(() => VF.postVerified({ gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, ...withStored(pdoc(w.sha, 2)) }), /pr edit #7 failed/);
});

// ---- Task 9 fix round 1 ------------------------------------------------------------------------------------------------------
const noGitAfterAdd = (log) => !kinds(log).some((k) => k.startsWith('git ') && k !== 'git add');

test('I-1: a listener left by any sandboxed phase (setup, seed exiting 0 or non-zero, app) is an escape: throw, worktree + run temp kept, no git', async (t) => {
  const cases = [
    ['setup', (w, busy) => ({ runSandboxed: async (argv) => { if (argv === w.config.app.setup) busy.on = true; return { code: 1, timedOut: false }; } })],
    ['seed exit 0', (w, busy) => ({ runSandboxed: async (argv) => { if (argv === w.config.app.seed) busy.on = true; return { code: 0, timedOut: false }; } })],
    ['seed exit 3', (w, busy) => ({ runSandboxed: async (argv) => { if (argv === w.config.app.seed) busy.on = true; return { code: argv === w.config.app.seed ? 3 : 0, timedOut: false }; } })],
    ['seed throws', (w, busy) => ({ runSandboxed: async (argv) => { if (argv === w.config.app.seed) { busy.on = true; throw new Error('seed crashed'); } return { code: 0, timedOut: false }; } })],
    ['seed timeout', (w, busy) => ({ runSandboxed: async (argv) => { if (argv === w.config.app.seed) busy.on = true; return argv === w.config.app.seed ? { code: null, timedOut: true } : { code: 0, timedOut: false }; } })],
  ];
  for (const [name, make] of cases) for (const host of ['127.0.0.1', '::1']) {
    const w = await vworld(t);
    const busy = { on: false };
    const hosts = [];
    const e = await VF.verifyFeature(w.args(), vseams(w.log, { ...make(w, busy), portInUse: async (_p, h) => { hosts.push(h); return busy.on && h === host; } })).catch((x) => x);
    assert.ok(e instanceof Error, `${name}/${host}: must throw`);
    assert.match(e.message, /still running or listening/, `${name}/${host}: ${e.message}`);
    assert.match(e.cleanupError, /left in place/, name);
    assert.ok(fs.existsSync(w.wtOf(w.bad)), name); assert.ok(noGitAfterAdd(w.log), `${name}: ${kinds(w.log)}`);
    assert.equal(fs.readdirSync(path.join(w.fh, 'tmp')).length, 1, `${name}: run temp kept`);
    assert.ok(!w.log.some((x) => x[0] === 'start'), `${name}: app never started after the escape`);
    assert.ok(hosts.includes('127.0.0.1') && hosts.includes('::1'), 'both loopbacks probed');
    assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.bad), null);
  }
});

test('I-1: a surviving non-listening process after setup / seed / app stop, or at the final sweep, is an escape', async (t) => {
  for (const [name, when] of [['setup', 1], ['seed', 2], ['app stop', 3]]) {
    const w = await vworld(t);
    let n = 0; const seen = [];
    const e = await VF.verifyFeature(w.args(), vseams(w.log, { survivors: async (m) => { seen.push(m); return ++n === when ? 1 : 0; } })).catch((x) => x);
    assert.match(e?.message ?? '', /still running or listening/, name);
    assert.ok(fs.existsSync(w.wtOf(w.bad)) && noGitAfterAdd(w.log), name);
    assert.deepEqual(seen[0], [w.wtOf(w.bad), fs.readdirSync(path.join(w.fh, 'tmp')).map((d) => path.join(fs.realpathSync(w.fh), 'tmp', d))[0]], 'markers: worktree and run temp');
  }
  // a phase that crashes is still followed by a sweep: the original error is kept, the worktree stays
  const w = await vworld(t);
  let sweeps = 0;
  const e = await VF.verifyFeature(w.args(), vseams(w.log, { runApiScenario: async () => { throw new Error('boom-api'); }, survivors: async () => (++sweeps >= 3 ? 1 : 0) })).catch((x) => x);
  assert.match(e.message, /boom-api/); assert.match(e.cleanupError, /left in place/); assert.ok(noGitAfterAdd(w.log));
  // the final sweep alone (every phase check clean) still blocks removal and turns a result into an error
  const w2 = await vworld(t);
  let k = 0; const total = 1 + 2 * 2 * 2; // setup + (seed + app) x 2 runs x 2 scenarios
  const e2 = await VF.verifyFeature(w2.args(), vseams(w2.log, { survivors: async () => (++k > total ? 1 : 0) })).catch((x) => x);
  assert.match(e2?.message ?? '', /still running or listening/); assert.ok(noGitAfterAdd(w2.log));
});

test('M-3: without a seed, the port is checked immediately before every start', async (t) => {
  const w = await vworld(t);
  const config = { ...w.config, app: { ...w.config.app, seed: null, setup: null } };
  let n = 0; // calls 1-2: the up-front check on 127.0.0.1 and ::1; call 3: right before the first start
  const e = await VF.verifyFeature(w.args({ config }), vseams(w.log, { portInUse: async () => ++n === 3 })).catch((x) => x);
  assert.match(e.message, /in use right before the app start/);
  assert.ok(!w.log.some((x) => x[0] === 'start')); assert.ok(noGitAfterAdd(w.log));
});

test('I-2: removal quarantines the worktree first; a symlink planted inside is unlinked, never followed', async (t) => {
  const w = await vworld(t);
  const outside = path.join(w.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep.txt'), 'KEEP');
  let planted = false;
  const plant = () => { if (planted) return; planted = true; const wt = w.wtOf(w.bad); fs.rmSync(path.join(wt, '.product'), { recursive: true, force: true }); fs.symlinkSync(outside, path.join(wt, '.product')); fs.symlinkSync(outside, path.join(wt, 'link')); };
  const r = await VF.verifyFeature(w.args(), vseams(w.log, { runApiScenario: async () => { plant(); return { status: 'pass' }; } }));
  assert.equal(r.verdict, 'pass');
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'KEEP');
  assert.ok(!fs.existsSync(w.wtOf(w.bad))); assert.deepEqual(fs.readdirSync(path.join(w.fh, 'trash')), []);
  assert.deepEqual(kinds(w.log).filter((k) => k.startsWith('git ')), ['git add', 'git prune']); assert.equal(w.worktrees(), 1, 'prune dropped the registration');
  // a symlinked trash dir is refused: the worktree stays where it is
  const w2 = await vworld(t);
  const elsewhere = path.join(w2.root, 'elsewhere'); fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, path.join(w2.fh, 'trash'));
  const r2 = await VF.verifyFeature(w2.args(), vseams(w2.log));
  assert.match(r2.cleanupError, /left in place/); assert.ok(fs.existsSync(w2.wtOf(w2.bad))); assert.deepEqual(fs.readdirSync(elsewhere), []);
  // and the leftover clear refuses the same way (throws before any run)
  w2.log.length = 0;
  const changed = vscenarios(); changed.scenarios[0].assert.push({ json_path: '$.items', not_contains: 'y' }); // no verdict reuse
  await assert.rejects(VF.verifyFeature(w2.args({ scenarios: changed }), vseams(w2.log)), /leftover worktree: .*left in place/);
  assert.ok(!w2.log.some((x) => x[0] === 'run'));
});

test('M-7: more than 1000 scenarios refused up front; the wall-clock budget throws after cleanup', async (t) => {
  const w = await vworld(t);
  const many = vscenarios({ scenarios: Array.from({ length: 1001 }, (_, i) => ({ ...vscenarios().scenarios[0], id: `S-${i + 1}` })) });
  await assert.rejects(VF.verifyFeature(w.args({ scenarios: many }), vseams(w.log)), /more than 1000 scenarios/);
  assert.deepEqual(w.log, []);
  for (const b of [0, 1.5, 86401, '60']) await assert.rejects(VF.verifyFeature(w.args({ budgetS: b }), vseams(w.log)), /invalid budget/);
  let clock = 1_000_000; let calls = 0;
  const r = VF.verifyFeature(w.args({ budgetS: 100 }), vseams(w.log, { now: () => clock, runApiScenario: async () => { calls++; clock += 60_000; return { status: "pass" }; } }));
  await assert.rejects(r, /exceeded its time budget/);
  assert.equal(calls, 2, `stopped at the first check after the budget ran out: ${kinds(w.log)}`);
  assert.ok(!fs.existsSync(w.wtOf(w.bad))); assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.bad), null);
  const timeouts = w.log.filter((e) => e[0] === 'run').map((e) => e[0]);
  assert.ok(timeouts.length > 0);
});

test('M-2: validation errors name scenarios by index, never by id', async (t) => {
  const w = await vworld(t);
  const bad = vscenarios({ scenarios: [vscenarios().scenarios[0], { ...vscenarios().scenarios[1], id: 'S-77', covers: ['nope'] }] });
  const e = await VF.verifyFeature(w.args({ scenarios: bad }), vseams(w.log)).catch((x) => x);
  assert.match(e.message, /scenario #2: invalid covers/); assert.ok(!e.message.includes('S-77'));
});

test('M-4: brief lines are sorted by their covers, whatever the result order', () => {
  const f = [{ covers: ['EC-2'], status: 'fail' }, { covers: ['AC-3'], status: 'fail' }, { covers: ['AC-1', 'ER-1'], status: 'fail' }];
  const a = VF.symptomBrief(f, vscenarios(), CANARY);
  assert.deepEqual(a.map((l) => l.split(':')[0]), ['AC-1, ER-1', 'AC-3', 'EC-2']);
  assert.deepEqual(VF.symptomBrief([...f].reverse(), vscenarios(), CANARY), a);
});

test('M-1: portInUse fails closed (a timeout or an unexpected error counts as in use); refused means free', async () => {
  assert.equal(await PR.portInUse(await vfreePort(), '127.0.0.1'), false);
  assert.equal(await PR.portInUse(9, '192.0.2.1'), true, 'TEST-NET address: timeout or unreachable is not "free"');
});

test('M-5: postVerified needs a consistent pass verdict for this sha with exactly n results', (t) => {
  const w = ghWorld(t);
  for (const doc of [undefined, { ...pdoc(w.sha, 2), verdict: 'fail', results: [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: false }] }, pdoc('d'.repeat(40), 2),
    { ...pdoc(w.sha, 2), results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: true }, { id: 'S-2', covers: ['AC-1'], status: 'pass', flaky: false }] }, { ...pdoc(w.sha, 2), extra: 1 }]) {
    assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, doc }), /invalid verdict/);
  }
  assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 3, pr: 7, ...withStored(pdoc(w.sha, 2)) }), /invalid scenario count/);
  assert.equal(w.state().calls.length, 0);
});

test('I-1 (real sandbox): a seed that exits non-zero after leaving a setsid daemon (listening or not) is caught; the worktree stays', { skip: SBX_SKIP }, async (t) => {
  for (const listen of [true, false]) {
    const w = await vworld(t);
    // the seed writes the daemon's pid into the worktree so the test can kill it afterwards
    const seed = ['node', '-e', `const cp=require('child_process');const c=cp.spawn(process.execPath,['-e',${JSON.stringify(`${listen ? "require('http').createServer(()=>{}).listen(+process.env.PORT,'::1');" : ''}setTimeout(()=>{},120000)`)}],{detached:true,stdio:'ignore',env:process.env});require('fs').writeFileSync('daemon.pid',String(c.pid));c.unref();process.exit(4)`];
    const config = { ...w.config, app: { ...w.config.app, seed } };
    const e = await VF.verifyFeature(w.args({ config })).catch((x) => x);
    const pidFile = path.join(w.wtOf(w.bad), 'daemon.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    assert.ok(e instanceof Error, `listen=${listen}: must throw`);
    assert.match(e.message, /app\.seed is still running or listening/, `listen=${listen}: ${e.message}`);
    assert.ok(pid, 'daemon started and the worktree was kept'); assert.match(e.cleanupError, /left in place/);
    assert.ok(noGitAfterAdd(w.log), `listen=${listen}: ${kinds(w.log)}`);
  }
});

test('round 1 mutants: a failing sweep is fail-closed; a leftover with a live process is refused, not cleared', async (t) => {
  const w = await vworld(t);
  const e = await VF.verifyFeature(w.args(), vseams(w.log, { survivors: async () => { throw new Error('ps broke'); } })).catch((x) => x);
  assert.ok(e instanceof Error); assert.match(e.cleanupError, /left in place/); assert.ok(noGitAfterAdd(w.log));
  const w2 = await vworld(t);
  fs.mkdirSync(w2.wtOf(w2.bad), { recursive: true });
  await assert.rejects(VF.verifyFeature(w2.args(), vseams(w2.log, { survivors: async (m) => (m.length === 1 ? 1 : 0) })), /earlier run is still running there/);
  assert.ok(fs.existsSync(w2.wtOf(w2.bad))); assert.ok(!w2.log.some((x) => x[0] === 'git'));
});

test('scanSurvivors finds a process by its environment (ps -E) and by its cwd (lsof), each on its own', { skip: process.platform !== 'darwin' && 'macOS only' }, async (t) => {
  const marker = fs.realpathSync(tmpDir('factory-sweep-')); t.after(() => fs.rmSync(marker, { recursive: true, force: true }));
  const other = fs.realpathSync(tmpDir('factory-sweep-other-')); t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.equal(VF.scanSurvivors([marker]), 0);
  const { spawn } = await import('node:child_process');
  const run = (opts) => { const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore', ...opts }); t.after(() => c.kill('SIGKILL')); return c; };
  const byEnv = run({ cwd: other, env: { PATH: process.env.PATH, TMPDIR: marker } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(VF.scanSurvivors([marker]), 1, 'found by environment');
  byEnv.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 300));
  run({ cwd: marker, env: { PATH: process.env.PATH } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(VF.scanSurvivors([marker]), 1, 'found by cwd');
});

test('M-1: an error other than refused (unresolvable host) also counts as in use', async () => {
  assert.equal(await PR.portInUse(80, 'nonexistent.invalid'), true);
});

// ---- Task 9 fix round 2 ------------------------------------------------------------------------------------------------------
test('I-A: a closed port stays free even when the event loop stalls past the probe timeout', async () => {
  const port = await vfreePort();
  for (const host of ['127.0.0.1', 'localhost']) {
    const p = PR.portInUse(port, host);
    const t0 = Date.now(); while (Date.now() - t0 < 1300) { /* deliberate event-loop stall */ }
    assert.equal(await p, false, host);
  }
  const s = net.createServer(); await new Promise((r) => s.listen(port, '127.0.0.1', r));
  const p = PR.portInUse(port, '127.0.0.1');
  const t0 = Date.now(); while (Date.now() - t0 < 1300) { /* stall */ }
  assert.equal(await p, true, 'a real listener is still found after a stall');
  await new Promise((r) => s.close(r));
});

test('I-B: an escape or an app that will not exit keeps the run temp AND drops its on-exit delete; a clean run removes both', async (t) => {
  for (const [name, over] of [
    ['escape', () => { let busy = false; return { stopApp: async (app) => { app.up = false; busy = true; }, portInUse: async () => busy }; }],
    ['app will not exit', () => ({ stopApp: async () => {}, alive: () => true })],
  ]) {
    const w = await vworld(t);
    const n0 = PR.pendingCleanups();
    const e = await VF.verifyFeature(w.args(), vseams(w.log, over())).catch((x) => x);
    assert.ok(e instanceof Error, name);
    assert.equal(PR.pendingCleanups(), n0, `${name}: no on-exit delete left registered`);
    const tmps = fs.readdirSync(path.join(w.fh, 'tmp'));
    assert.equal(tmps.length, 1, `${name}: run temp kept`);
    PR.runCleanups(); // what the driver's exit would run
    assert.ok(fs.existsSync(path.join(w.fh, 'tmp', tmps[0])), `${name}: still there after the exit hooks`);
  }
  const w = await vworld(t);
  const n0 = PR.pendingCleanups();
  await VF.verifyFeature(w.args(), vseams(w.log));
  assert.equal(PR.pendingCleanups(), n0); assert.deepEqual(fs.readdirSync(path.join(w.fh, 'tmp')), []);
});

test('I-C: the escape sweep runs before the verdict is written; a later escape deletes the written verdict; neither is reused', async (t) => {
  const phases = 1 + 2 * 2 * 2; // setup + (seed + app) x 2 runs x 2 scenarios
  for (const [name, at] of [['before writing', phases + 1], ['after writing', phases + 2]]) {
    const w = await vworld(t);
    let n = 0; let wrote = null;
    const e = await VF.verifyFeature(w.args(), vseams(w.log, { survivors: async () => { if (n === phases + 1) wrote = V.readVerdict('o__r', 'FEATURE-001', w.bad); return ++n === at ? 1 : 0; } })).catch((x) => x);
    assert.match(e?.message ?? '', /still running or listening/, name);
    if (name === 'after writing') assert.ok(wrote, 'the verdict had been written before the last sweep');
    else assert.equal(wrote, null, 'nothing written before the in-run sweep');
    assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.bad), null, `${name}: no stored verdict`);
  }
  // and a clean second call over the same FACTORY_HOME runs instead of reusing
  const w = await vworld(t);
  let n = 0;
  await VF.verifyFeature(w.args(), vseams(w.log, { survivors: async () => (++n === phases + 2 ? 1 : 0) })).catch(() => {});
  // the escape left the worktree; clear it the way a person would before re-verifying
  fs.rmSync(w.wtOf(w.bad), { recursive: true, force: true }); rawGit(w.clone, 'worktree', 'prune');
  w.log.length = 0;
  const r = await VF.verifyFeature(w.args(), vseams(w.log));
  assert.equal(r.reused, false); assert.ok(w.log.some((e) => e[0] === 'api'));
});

test('M-f: a failing git worktree prune is surfaced as its own error (the result is attached); it never masks an earlier error', async (t) => {
  const w = await vworld(t);
  const git = (...a) => (a[0] === 'worktree' && a[1] === 'prune' ? (w.log.push(['git', 'prune']), { code: 1, out: '', err: 'locked' }) : w.git(...a));
  const e = await VF.verifyFeature(w.args({ git }), vseams(w.log)).catch((x) => x);
  assert.match(e.message, /git worktree prune failed/); assert.equal(e.result?.verdict, 'pass');
  assert.ok(!fs.existsSync(w.wtOf(w.bad)), 'the tree itself was quarantined and deleted');
  const w2 = await vworld(t);
  const git2 = (...a) => (a[0] === 'worktree' && a[1] === 'prune' ? { code: 1, out: '', err: 'locked' } : w2.git(...a));
  const e2 = await VF.verifyFeature(w2.args({ git: git2 }), vseams(w2.log, { runApiScenario: async () => { throw new Error('boom-first'); } })).catch((x) => x);
  assert.match(e2.message, /boom-first/); assert.match(e2.cleanupError, /prune failed/);
});

test('M-c: postVerified requires the stored verdict file for (repoKey, id, sha) to match the doc', (t) => {
  const w = ghWorld(t);
  const doc = pdoc(w.sha, 2);
  assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, doc, repoKey: 'o__r', id: 'FEATURE-001' }), /stored verdict|verdict file/, 'nothing stored');
  V.writeVerdict('o__r', { ...doc, results: [{ id: 'S-1', covers: ['AC-2'], status: 'pass', flaky: false }, doc.results[1]] });
  assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, doc, repoKey: 'o__r', id: 'FEATURE-001' }), /verdict file/, 'different results');
  V.writeVerdict('o__r', { ...doc, criteria_hash: `sha256:${'7'.repeat(64)}` });
  assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, doc, repoKey: 'o__r', id: 'FEATURE-001' }), /verdict file/, 'different hash');
  V.writeVerdict('o__r', doc);
  for (const bad of [{ repoKey: 'o/r' }, { id: 'FEATURE-002' }, { id: undefined }]) assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, doc, repoKey: 'o__r', id: 'FEATURE-001', ...bad }), /invalid/);
  assert.equal(w.state().calls.length, 0);
  assert.equal(VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, doc, repoKey: 'o__r', id: 'FEATURE-001' }).edited, true);
});

test('I-A: only refused / no-such-address errors mean free; unreachable means free on ::1 only', () => {
  for (const c of ['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']) { assert.equal(PR.freeError(c, '127.0.0.1'), true, c); assert.equal(PR.freeError(c, '::1'), true, c); }
  for (const c of ['ENETUNREACH', 'EHOSTUNREACH']) { assert.equal(PR.freeError(c, '::1'), true, c); assert.equal(PR.freeError(c, '127.0.0.1'), false, c); }
  for (const c of ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', undefined]) assert.equal(PR.freeError(c, '127.0.0.1'), false, String(c));
});

// ---- Task 9 fix round 3 ------------------------------------------------------------------------------------------------------
test('round 3: a pass verdict that cannot be deleted after a late escape is overwritten with fail; if that fails too it is reported and never reusable', async (t) => {
  const phases = 1 + 2 * 2 * 2 + 1; // setup + (seed + app) x 2 x 2 + the in-run sweep; the next call is the final sweep
  const late = () => { let n = 0; return async () => (++n === phases + 1 ? 1 : 0); };
  const w = await vworld(t);
  const e = await VF.verifyFeature(w.args(), vseams(w.log, { survivors: late(), rmVerdict: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } })).catch((x) => x);
  assert.match(e.message, /still running or listening/);
  const left = V.readVerdict('o__r', 'FEATURE-001', w.bad);
  assert.equal(left?.verdict, 'fail', 'overwritten with a fail verdict');
  assert.ok(left.results.every((r) => r.status !== 'pass'));
  assert.doesNotMatch(e.cleanupError, /stored verdict/);

  const w2 = await vworld(t);
  const e2 = await VF.verifyFeature(w2.args(), vseams(w2.log, { survivors: late(), rmVerdict: (file) => { fs.rmSync(file); fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'x'), 'x'); } })).catch((x) => x);
  assert.match(e2.cleanupError, /stored verdict could not be removed/);
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', w2.bad), null, 'what remains reads as no verdict');
  assert.throws(() => VF.postVerified({ gh: () => { throw new Error('gh must not run'); }, repo: 'o/r', sha: w2.bad, n: 2, pr: 7, doc: { feature: 'FEATURE-001', sha: w2.bad, scenarios_hash: SC.scenariosHash(vscenarios()), criteria_hash: VCH, results: [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: false }, { id: 'S-2', covers: ['AC-2', 'EC-1'], status: 'pass', flaky: false }], verdict: 'pass', at: new Date().toISOString() }, repoKey: 'o__r', id: 'FEATURE-001' }), /verdict file/);
});

test('round 3: postVerified requires repoKey to be derived from repo', (t) => {
  const w = ghWorld(t);
  const a = withStored(pdoc(w.sha, 2));
  for (const repoKey of ['x__r', 'o__x', 'O__r']) {
    V.writeVerdict(repoKey, a.doc);
    assert.throws(() => VF.postVerified({ gh: w.gh, repo: 'o/r', sha: w.sha, n: 2, pr: 7, ...a, repoKey }), /invalid repo key/, repoKey);
  }
  assert.equal(w.state().calls.length, 0);
});

test('round 3: a failed prune and an undeletable quarantined tree are both reported', async (t) => {
  if (process.getuid?.() === 0) return;
  const w = await vworld(t);
  const trash = path.join(fs.realpathSync(w.fh), 'trash');
  const locked = [];
  const git = (...a) => {
    if (a[0] === 'worktree' && a[1] === 'prune') {
      for (const q of fs.existsSync(trash) ? fs.readdirSync(trash) : []) { const d = path.join(trash, q); fs.chmodSync(d, 0o500); locked.push(d); }
      return { code: 1, out: '', err: 'locked' };
    }
    return w.git(...a);
  };
  const e = await VF.verifyFeature(w.args({ git }), vseams(w.log)).catch((x) => x);
  for (const d of locked) fs.chmodSync(d, 0o700); // before vworld's cleanup removes the root
  assert.ok(locked.length > 0, 'the quarantine existed when prune ran');
  assert.match(e.message, /git worktree prune failed/);
  assert.match(e.message, /quarantined verification worktree could not be deleted/);
});

// ---- Task 10: verdict-bound merge when the base config requires verification ---------------------------------------------------
const REQ = { protected_branches: [], verification: { required: true } };
const vship = (opts = {}) => shipped({}, { config: REQ, queueInHome: true, ...opts });
const g = (cwd, ...a) => { const x = spawnSync('git', a, { cwd, encoding: 'utf8', env: genv(cwd) }); if (x.status !== 0) throw new Error(`git ${a.join(' ')}: ${x.stderr}`); return x.stdout.trim(); };
const rm = (...rs) => { for (const r of rs) fs.rmSync(r.root, { recursive: true, force: true }); };
const merge = (r) => r.d(r.env, 'merge', 'FEATURE-001');
// A hold reason must name a category only: never the hidden scenario path, id, canary or the scenario file location.
const noLeak = (reason) => { for (const s of [HIDDEN_PATH, 'S-1', 'fx-a1b2c3', 'o__r', 'FEATURE-001.json', 'fhome', 'hidden-route']) assert.ok(!String(reason).includes(s), `reason leaks ${s}: ${reason}`); };

test('T10 happy path: verified state, trusted queue, passing verdict for the exact head with recomputed hashes, clean anti-gaming -> merged', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  const m = merge(r);
  assert.equal(J(m)?.state, 'merged', m.out + m.err);
  const call = ghCalls(r).find((c) => c[0] === 'pr' && c[1] === 'merge');
  assert.equal(call[call.indexOf('--match-head-commit') + 1], r.feat().ci_sha, 'only the verified sha can be merged');
  rm(r);
});

test('T10: a push after verification (head moved) holds; it is never merged and never silently sent back as stale', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  fs.writeFileSync(path.join(r.work, 'src/b.txt'), 'late\n'); g(r.work, 'add', '-A'); g(r.work, 'commit', '-q', '-m', 'late push'); g(r.work, 'push', '-q', 'origin', 'HEAD');
  const m = merge(r);
  assert.equal(m.code, 2, m.out + m.err);
  assert.equal(J(m).state, 'awaiting_human'); assert.match(J(m).reason, /head moved after verification/);
  assert.equal(r.feat().hold_kind, 'verification');
  assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10: scenarios changed after verification hold with a category reason (no scenario text, id or path)', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  const { doc } = arm(r);
  const changed = SC.approve({ ...doc, approved: undefined, scenarios: [{ ...doc.scenarios[0], assert: [{ status: 201 }] }] }, 'tester');
  inHome(r, () => SC.saveScenarios('o__r', 'FEATURE-001', changed));
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /scenarios_hash mismatch/); noLeak(J(m).reason);
  assert.equal(mergeCalled(r), false);
  // and with the scenario file gone, or corrupt, it also holds
  for (const body of [null, '{ not json']) {
    r.edit((f) => { f.state = 'verified'; });
    const sp = path.join(r.root, 'fhome', 'scenarios', 'o__r', 'FEATURE-001.json');
    if (body === null) fs.rmSync(sp); else fs.writeFileSync(sp, body);
    const x = merge(r);
    assert.equal(J(x).state, 'awaiting_human', x.out + x.err); noLeak(J(x).reason); assert.equal(mergeCalled(r), false);
  }
  rm(r);
});

test('T10: spec criteria changed on origin/<base> after verification hold (criteria_hash recomputed from the base spec now)', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  const br = g(r.work, 'rev-parse', '--abbrev-ref', 'HEAD');
  g(r.work, 'checkout', '-q', 'main'); g(r.work, 'pull', '-q', 'origin', 'main');
  fs.appendFileSync(path.join(r.work, '.product/features/FEATURE-001.md'), '\nA new acceptance criterion.\n');
  g(r.work, 'commit', '-q', '-am', 'tighten criteria'); g(r.work, 'push', '-q', 'origin', 'main'); g(r.work, 'checkout', '-q', br);
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /criteria_hash mismatch/); noLeak(J(m).reason);
  assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10: a G4 change on the merge sha holds as anti-gaming; only an override bound to that exact head (overrideValid) lets it through', () => {
  const r = vship({ files: { '.gitattributes': '*.txt text\n' } });
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /G4/); assert.doesNotMatch(J(m).reason, /gitattributes/);
  assert.equal(r.feat().hold_kind, 'antigaming'); assert.equal(mergeCalled(r), false);
  const head = r.feat().ci_sha;
  assert.equal(r.feat().hold_sha, head); assert.deepEqual(r.feat().hold_ids, ['G4']);
  // an override for another commit (a later push voided it) does not count
  r.edit((f) => { f.state = 'verified'; f.hold_kind = null; f.override_note = 'reviewed'; f.override_sha = 'b'.repeat(40); f.override_ids = ['G4']; });
  assert.equal(J(merge(r)).state, 'awaiting_human'); assert.equal(mergeCalled(r), false);
  // a note without a sha, or a sha without a note, does not count either
  r.edit((f) => { f.state = 'verified'; f.override_note = ''; f.override_sha = head; });
  assert.equal(J(merge(r)).state, 'awaiting_human'); assert.equal(mergeCalled(r), false);
  // an override for this head but for other G-ids does not cover G4
  r.edit((f) => { f.state = 'verified'; f.override_note = 'reviewed'; f.override_sha = head; f.override_ids = ['G1']; });
  assert.equal(J(merge(r)).state, 'awaiting_human'); assert.equal(mergeCalled(r), false);
  // the person's override for this exact head and G4 (what retry --note records at a terminal), in the trusted queue: merges
  r.edit((f) => { f.state = 'verified'; f.override_note = 'reviewed the attributes change'; f.override_sha = head; f.override_ids = ['G4']; });
  const ok = merge(r);
  assert.equal(J(ok)?.state, 'merged', ok.out + ok.err);
  rm(r);
});

test('T10: a forged queue policy (verification.required=false) has no effect: the base config still requires a verdict', () => {
  const r = vship();
  r.edit((f, q) => { q.policy.verification = { ...q.policy.verification, required: false }; });
  const a = merge(r); // ci_passed is refused outright
  assert.equal(a.code, 1); assert.match(a.err, /verification is required/); assert.equal(r.feat().state, 'ci_passed');
  r.edit((f) => { f.state = 'verified'; });
  const b = merge(r); // verified but no verdict
  assert.equal(J(b).state, 'awaiting_human', b.out + b.err); assert.match(J(b).reason, /verdict/);
  assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10: base config required:false -> ci_passed merges exactly as before (no verdict, in-repo queue)', () => {
  const r = shipped();
  assert.equal(r.feat().state, 'ci_passed');
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m)?.state, 'merged', m.out + m.err);
  assert.ok(!('hold_kind' in r.feat()));
  rm(r);
});

test('T10: in verified mode a queue file outside FACTORY_HOME holds, even with a valid verdict (its override fields are builder-writable)', () => {
  const r = shipped({}, { config: REQ });
  r.edit((f) => { f.state = 'verified'; f.override_note = 'forged'; f.override_sha = f.ci_sha; f.override_ids = ['G1', 'G2', 'G3', 'G4', 'G5']; });
  arm(r);
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /FACTORY_HOME/);
  assert.equal(mergeCalled(r), false);
  // a queue reached through a symlink into FACTORY_HOME is refused by load(); a queue under a sibling dir named like FACTORY_HOME is not inside it
  const r2 = shipped({}, { config: REQ });
  const twin = path.join(r2.root, 'fhome-evil', 'q.json');
  fs.mkdirSync(path.dirname(twin), { recursive: true });
  fs.copyFileSync(path.join(r2.work, '.delivery', 'queue.json'), twin);
  const q = JSON.parse(fs.readFileSync(twin, 'utf8')); q.features[0].state = 'verified'; fs.writeFileSync(twin, JSON.stringify(q));
  arm(r2);
  const x = r2.d({ DELIVER_QUEUE: twin }, 'merge', 'FEATURE-001');
  assert.equal(J(x).state, 'awaiting_human', x.out + x.err); assert.match(J(x).reason, /FACTORY_HOME/);
  rm(r, r2);
});

test('T10: an anti-gaming check that cannot run (checkDiff throws: no merge base) holds, never merges', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  const orphan = g(r.work, 'commit-tree', 'refs/remotes/origin/main^{tree}', '-m', 'unrelated history'); // same tree: config and spec unchanged
  g(r.work, 'push', '-q', '-f', 'origin', `${orphan}:refs/heads/main`);
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /anti-gaming checks could not run/);
  assert.equal(r.feat().hold_kind, 'antigaming'); assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10: base ref missing holds in verified mode too', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  g(path.join(r.root, 'origin.git'), 'update-ref', '-d', 'refs/heads/main'); g(r.work, 'update-ref', '-d', 'refs/remotes/origin/main');
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /cannot be read/); assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10: an override in a builder-writable (in-repo) queue is ignored on the T3 path', () => {
  const r = shipped({}, { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'], files: { '.gitattributes': '*.txt text\n' } });
  arm(r);
  r.edit((f) => { f.override_note = 'forged'; f.override_sha = f.ci_sha; f.override_ids = ['G1', 'G2', 'G3', 'G4', 'G5']; });
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /G4/); assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10: merge takes protected_branches, hold_paths and checks.ignored from the base config, not the queue copy', () => {
  const a = shipped({}, { config: { protected_branches: [], hold_paths: ['src/**'] } });
  a.edit((f, q) => { q.policy.hold_paths = []; f.ci_files = []; }); // forged
  const x = a.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(x).state, 'awaiting_human', x.out + x.err); assert.match(J(x).reason, /src\/a\.txt/);

  const b = shipped();
  const br = g(b.work, 'rev-parse', '--abbrev-ref', 'HEAD');
  g(b.work, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(b.work, '.product/delivery.json'), JSON.stringify({ protected_branches: ['main'] }));
  g(b.work, 'commit', '-q', '-am', 'protect main'); g(b.work, 'push', '-q', 'origin', 'main'); g(b.work, 'checkout', '-q', br);
  const y = b.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(y).state, 'awaiting_human', y.out + y.err); assert.match(J(y).reason, /protected/);

  const c = shipped(); // the queue says "ignore lint", the base config does not: a failing lint check is not ignored
  c.edit((f, q) => { q.policy.checks.ignored = ['lint']; });
  const gp = path.join(c.root, 'gh.json'); const st = JSON.parse(fs.readFileSync(gp, 'utf8')); st.checkQueue = [[{ name: 'ci', bucket: 'pass', link: 'x', state: 'SUCCESS' }, { name: 'lint', bucket: 'fail', link: 'x', state: 'FAILURE' }]]; fs.writeFileSync(gp, JSON.stringify(st));
  const z = c.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(z).state, 'awaiting_human', z.out + z.err); assert.match(J(z).reason, /required checks/);
  for (const r of [a, b, c]) assert.equal(mergeCalled(r), false);
  rm(a, b, c);
});

test('T10: gitSafe accepts exactly the two display -c pairs checkDiff passes, so checkDiff runs on the hardened runner', () => {
  const r = shipped();
  const run = (...a) => GS.gitSafeOpts(r.work, a, { verified: true });
  const hits = AG.checkDiff({ git: run, baseRef: 'refs/remotes/origin/main', headSha: r.feat().ci_sha, specPaths: ['.product/features/FEATURE-001.md'] });
  assert.deepEqual(hits, []);
  for (const kv of ['core.quotePath=true', 'diff.suppressBlankEmpty=true', 'core.pager=less', 'diff.external=x']) assert.throws(() => run('-c', kv, 'rev-parse', 'HEAD'), /not allowed/, kv);
  rm(r);
});

test('T10: G5 at merge covers the feature spec and every other spec in features_dir on origin/<base>', () => {
  const own = vship({ specAppend: '\nA weaker criterion slipped in by the builder.\n' });
  own.edit((f) => { f.state = 'verified'; });
  arm(own); // criteria_hash is from the BASE spec, so only G5 can catch the head edit
  const a = merge(own);
  assert.equal(J(a).state, 'awaiting_human', a.out + a.err); assert.match(J(a).reason, /G5/); assert.equal(mergeCalled(own), false);
  const other = vship({ baseFiles: { '.product/features/FEATURE-002.md': '---\nid: FEATURE-002\nstatus: draft\n---\n# Two\n\nAC text\n' }, files: { '.product/features/FEATURE-002.md': '---\nid: FEATURE-002\nstatus: draft\n---\n# Two\n\nweaker\n' } });
  other.edit((f) => { f.state = 'verified'; });
  arm(other);
  const b = merge(other);
  assert.equal(J(b).state, 'awaiting_human', b.out + b.err); assert.match(J(b).reason, /G5/); assert.equal(mergeCalled(other), false);
  rm(own, other);
});

test('T10: scenarios that are not approved for the current criteria hold even when the hashes match (approval is not hashed)', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  const { doc } = arm(r);
  const { approved: _drop, ...unapproved } = doc;
  inHome(r, () => SC.saveScenarios('o__r', 'FEATURE-001', unapproved));
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /not approved/); noLeak(J(m).reason);
  assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10: with scenario_approval "human" on the base, scenarios approved by "auto" hold at merge; a named approver merges', () => {
  const HUMAN = { ...REQ, verification: { required: true, scenario_approval: 'human' } };
  const r = vship({ config: HUMAN });
  r.edit((f) => { f.state = 'verified'; });
  const { doc } = arm(r);
  const { approved: _drop, ...plain } = doc;
  inHome(r, () => SC.saveScenarios('o__r', 'FEATURE-001', SC.approve(plain, 'auto')));
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /not approved/); noLeak(J(m).reason);
  assert.equal(mergeCalled(r), false);
  const ok = vship({ config: HUMAN });
  ok.edit((f) => { f.state = 'verified'; });
  arm(ok); // approved by "tester"
  assert.equal(J(merge(ok))?.state, 'merged');
  rm(r, ok);
});

test('T10: a base spec over the parse guard (a line longer than MAX_LINE) holds without parsing, even with a matching verdict', () => {
  const r = vship({ baseFiles: { '.product/features/FEATURE-001.md': `---\ntype: feature-spec\nid: FEATURE-001\nopportunity: OPP-001\nstatus: ready\n---\n# One\n\n${'x'.repeat(CR.MAX_LINE + 1)}\n` } });
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  const m = merge(r);
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /too large/); assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10 self-attack probes: no merge through a broken pipe, a forged spec path, a hostile scenario doc or a symlinked queue folder', () => {
  // (a) a valid override never waives an anti-gaming check that could not run
  const a = vship();
  a.edit((f) => { f.state = 'verified'; f.override_note = 'reviewed'; f.override_sha = f.ci_sha; f.override_ids = ['G1', 'G2', 'G3', 'G4', 'G5']; });
  arm(a);
  g(a.work, 'push', '-q', '-f', 'origin', `${g(a.work, 'commit-tree', 'refs/remotes/origin/main^{tree}', '-m', 'x')}:refs/heads/main`);
  assert.match(J(merge(a)).reason, /could not run/); assert.equal(mergeCalled(a), false);
  // (b) a queue entry whose spec path leaves the repository (or names another feature's spec) holds, it does not crash or merge
  for (const file of ['/etc/FEATURE-001.md', path.join(a.work, '..', 'FEATURE-001.md'), path.join(a.work, '.product/features/FEATURE-002.md')]) {
    const b = vship();
    b.edit((f) => { f.state = 'verified'; });
    arm(b);
    b.edit((f) => { f.file = file; });
    const x = merge(b);
    assert.equal(J(x)?.state, 'awaiting_human', `${file}: ${x.out}${x.err}`); assert.equal(mergeCalled(b), false);
    rm(b);
  }
  // (c) a scenario doc nested past the hash depth limit holds (scenariosHash throws), never crashes into a merge
  const c = vship();
  c.edit((f) => { f.state = 'verified'; });
  const { doc } = arm(c);
  let deep = {}; const top = deep; for (let i = 0; i < 60; i++) { deep.x = {}; deep = deep.x; }
  fs.writeFileSync(path.join(c.root, 'fhome', 'scenarios', 'o__r', 'FEATURE-001.json'), JSON.stringify({ ...doc, extra: top }));
  const y = merge(c);
  assert.equal(J(y).state, 'awaiting_human', y.out + y.err); assert.match(J(y).reason, /scenarios/); assert.equal(mergeCalled(c), false);
  // (d) a queue folder inside FACTORY_HOME that is a symlink to a builder-writable folder is refused outright
  const d = vship();
  d.edit((f) => { f.state = 'verified'; });
  arm(d);
  const qf = d.env.DELIVER_QUEUE; const out = path.join(d.work, 'qdir');
  fs.mkdirSync(out); fs.renameSync(qf, path.join(out, 'o__r.json')); fs.rmSync(path.dirname(qf), { recursive: true }); fs.symlinkSync(out, path.dirname(qf));
  const z = merge(d);
  assert.notEqual(z.code, 0); assert.match(z.err, /symlink/); assert.equal(mergeCalled(d), false);
  // (e) ... and a deeper symlinked ancestor resolves outside FACTORY_HOME: held as untrusted
  const e = vship();
  e.edit((f) => { f.state = 'verified'; });
  arm(e);
  const eq = e.env.DELIVER_QUEUE; const outside = path.join(e.work, 'deep'); const link = path.join(e.root, 'fhome', 'lnk');
  fs.mkdirSync(path.join(outside, 'queues'), { recursive: true }); fs.renameSync(eq, path.join(outside, 'queues', 'o__r.json')); fs.symlinkSync(outside, link);
  const w = e.d({ DELIVER_QUEUE: path.join(link, 'queues', 'o__r.json') }, 'merge', 'FEATURE-001');
  assert.equal(J(w)?.state, 'awaiting_human', w.out + w.err); assert.match(J(w).reason, /FACTORY_HOME/); assert.equal(mergeCalled(e), false);
  rm(a, c, d, e);
});

test('T10: T3 without the opt-in holds even with a matching passing verdict', () => {
  const r = shipped({}, { tier: 'T3' });
  arm(r);
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m).state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /T3 work/); assert.equal(mergeCalled(r), false);
  rm(r);
});

// ---- Task 10 fix round 1 ------------------------------------------------------------------------------------------------------------
const gitDirOf = (r) => path.join(r.work, '.git');

test('T10 r1 I-1: planted grafts, shallow or alternates, or a config key outside the gitsafe allowlist, hold before any gate git call', () => {
  const plants = {
    grafts: (r) => { const base = g(r.work, 'rev-parse', 'refs/remotes/origin/main'); fs.writeFileSync(path.join(gitDirOf(r), 'info', 'grafts'), `${base} ${r.feat().ci_sha}\n`); },
    shallow: (r) => fs.writeFileSync(path.join(gitDirOf(r), 'shallow'), `${g(r.work, 'rev-parse', 'refs/remotes/origin/main')}\n`),
    alternates: (r) => { fs.mkdirSync(path.join(gitDirOf(r), 'objects', 'info'), { recursive: true }); fs.writeFileSync(path.join(gitDirOf(r), 'objects', 'info', 'alternates'), `${path.join(r.root, 'origin.git', 'objects')}\n`); },
    config: (r) => g(r.work, 'config', 'core.pager', 'cat'),
  };
  for (const [name, plant] of Object.entries(plants)) {
    const r = vship({ files: { '.gitattributes': '*.txt text\n' } }); // a G4 hit the graft would otherwise hide (merge-base = head, empty diff)
    r.edit((f) => { f.state = 'verified'; });
    arm(r);
    plant(r);
    const m = merge(r);
    assert.equal(J(m)?.state, 'awaiting_human', `${name}: ${m.out}${m.err}`); assert.match(J(m).reason, /not a trusted clone/, name);
    assert.equal(mergeCalled(r), false, name);
    rm(r);
  }
});

test('T10 r1 I-1: checkWorktreeSafe (and so every worktree-touching gitSafe call) refuses grafts and shallow', () => {
  const r = shipped();
  fs.writeFileSync(path.join(gitDirOf(r), 'info', 'grafts'), '');
  assert.throws(() => GS.gitSafe(r.work, 'status'), /^Error: git worktree not safe: info\/grafts present$/);
  assert.throws(() => GS.checkRepoMetadata(r.work), /info\/grafts/);
  fs.rmSync(path.join(gitDirOf(r), 'info', 'grafts'));
  fs.writeFileSync(path.join(gitDirOf(r), 'shallow'), '');
  assert.throws(() => GS.gitSafe(r.work, 'status'), /^Error: git worktree not safe: shallow present$/);
  fs.rmSync(path.join(gitDirOf(r), 'shallow'));
  assert.doesNotThrow(() => GS.checkRepoMetadata(r.work));
  assert.equal(GS.touchesWorktree(['diff', '--raw', 'a'.repeat(40), 'b'.repeat(40), '--']), false, 'two full ids + -- is an object read');
  assert.equal(GS.touchesWorktree(['diff', 'a'.repeat(40), '--', 'x']), true);
  assert.equal(GS.touchesWorktree(['diff', 'HEAD~1', 'HEAD', '--', 'x']), true, 'only full ids or refs/... names');
  rm(r);
});

test('T10 r1 I-2: retry --note refuses when the head moved since the hold, and binds to the held sha', (t) => {
  const r = shipped();
  r.edit((f) => { f.state = 'awaiting_human'; f.hold_kind = 'antigaming'; f.reason = 'G4'; f.hold_sha = f.ci_sha; f.hold_ids = ['G4']; });
  fs.writeFileSync(path.join(r.work, 'src/c.txt'), 'after the hold\n'); g(r.work, 'add', '-A'); g(r.work, 'commit', '-q', '-m', 'sneak'); g(r.work, 'push', '-q', 'origin', 'HEAD');
  const x = underTty(r, 'retry', 'FEATURE-001', '--note', 'looked at it');
  if (!x) { t.skip('script(1) is not available'); rm(r); return; }
  assert.notEqual(x.code, 0); assert.match(x.out + x.err, /head moved since the hold/);
  const f = r.feat();
  assert.equal(f.state, 'awaiting_human'); assert.ok(!f.override_note); assert.equal(f.hold_kind, 'antigaming');
  rm(r);
});

test('T10 r1 M-1: base config "absent" only when ls-tree lists nothing; a non-file at the config path holds', () => {
  const r = shipped();
  const br = g(r.work, 'rev-parse', '--abbrev-ref', 'HEAD');
  g(r.work, 'checkout', '-q', 'main'); g(r.work, 'rm', '-q', '.product/delivery.json');
  fs.mkdirSync(path.join(r.work, '.product/delivery.json')); fs.writeFileSync(path.join(r.work, '.product/delivery.json/x'), '{}');
  g(r.work, 'add', '-A'); g(r.work, 'commit', '-q', '-m', 'dir'); g(r.work, 'push', '-q', 'origin', 'main'); g(r.work, 'checkout', '-q', br);
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m)?.state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /cannot be read/); assert.equal(mergeCalled(r), false);
  rm(r);
});

test('T10 r1 M-2: the queue is untrusted when FACTORY_HOME is an ancestor of the repo, or the file is shared-writable or hard-linked', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  const q = r.env.DELIVER_QUEUE;
  const anc = path.join(r.root, 'queues', 'o__r.json'); fs.mkdirSync(path.dirname(anc), { recursive: true, mode: 0o700 }); fs.copyFileSync(q, anc);
  const a = r.d({ ...r.env, DELIVER_QUEUE: anc, FACTORY_HOME: r.root }, 'merge', 'FEATURE-001'); // FACTORY_HOME contains the repo
  assert.match(J(a).reason, /FACTORY_HOME/, a.out + a.err);
  r.edit((f) => { f.state = 'verified'; });
  fs.chmodSync(q, 0o664);
  assert.match(J(merge(r)).reason, /FACTORY_HOME/, 'group-writable');
  fs.chmodSync(q, 0o600);
  r.edit((f) => { f.state = 'verified'; });
  const hl = path.join(r.root, 'fhome', 'queues', 'link.json'); fs.linkSync(q, hl);
  assert.match(J(merge(r)).reason, /FACTORY_HOME/, 'hard-linked');
  fs.rmSync(hl);
  r.edit((f) => { f.state = 'verified'; });
  const inRepo = path.join(r.work, '.fh'); fs.mkdirSync(path.join(inRepo, 'queues'), { recursive: true, mode: 0o700 }); fs.copyFileSync(q, path.join(inRepo, 'queues', 'o__r.json'));
  const ir = r.d({ ...r.env, DELIVER_QUEUE: path.join(inRepo, 'queues', 'o__r.json'), FACTORY_HOME: inRepo }, 'merge', 'FEATURE-001'); // FACTORY_HOME inside the repo
  assert.match(J(ir).reason, /FACTORY_HOME/, ir.out + ir.err);
  fs.rmSync(inRepo, { recursive: true });
  r.edit((f) => { f.state = 'verified'; });
  const ok = merge(r);
  assert.equal(J(ok)?.state, 'merged', `control: ${ok.out}${ok.err}`);
  rm(r);
});

test('T10 r1 M-6: a passing gate does not bypass the later holds (failing GitHub check, ci/hold_paths files, BLOCKED)', () => {
  const ck = vship();
  ck.edit((f) => { f.state = 'verified'; }); arm(ck);
  { const gp = path.join(ck.root, 'gh.json'); const st = JSON.parse(fs.readFileSync(gp, 'utf8')); st.checkQueue = [[{ name: 'ci', bucket: 'fail', link: 'x', state: 'FAILURE' }]]; fs.writeFileSync(gp, JSON.stringify(st)); }
  assert.match(J(merge(ck)).reason, /required checks/);
  const hp = vship({ config: { ...REQ, hold_paths: ['src/**'] } });
  hp.edit((f) => { f.state = 'verified'; }); arm(hp);
  assert.match(J(merge(hp)).reason, /CI or ownership files/);
  const bl = vship();
  bl.edit((f) => { f.state = 'verified'; }); arm(bl);
  { const gp = path.join(bl.root, 'gh.json'); const st = JSON.parse(fs.readFileSync(gp, 'utf8')); st.prs[0].mergeState = 'BLOCKED'; fs.writeFileSync(gp, JSON.stringify(st)); }
  assert.match(J(merge(bl)).reason, /BLOCKED/);
  for (const r of [ck, hp, bl]) assert.equal(mergeCalled(r), false);
  rm(ck, hp, bl);
});

test('T10 r1: checkRepoMetadata looks in the common dir too (a linked worktree has its own git dir)', () => {
  const r = shipped();
  const wt = path.join(r.root, 'linked');
  g(r.work, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  assert.doesNotThrow(() => GS.checkRepoMetadata(wt));
  fs.writeFileSync(path.join(gitDirOf(r), 'info', 'grafts'), ''); // the common dir's grafts apply to every worktree
  assert.throws(() => GS.checkRepoMetadata(wt), /info\/grafts/);
  rm(r);
});

test('T10 r1 M-1: a symlink at the config path on origin/<base> is unreadable, even if its target text is valid JSON', () => {
  const r = shipped();
  const br = g(r.work, 'rev-parse', '--abbrev-ref', 'HEAD');
  g(r.work, 'checkout', '-q', 'main'); g(r.work, 'rm', '-q', '.product/delivery.json');
  fs.symlinkSync('{"protected_branches":[]}', path.join(r.work, '.product/delivery.json'));
  g(r.work, 'add', '-A'); g(r.work, 'commit', '-q', '-m', 'link'); g(r.work, 'push', '-q', 'origin', 'main'); g(r.work, 'checkout', '-q', br);
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m)?.state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /cannot be read/); assert.equal(mergeCalled(r), false);
  rm(r);
});

// ---- Task 10 fix round 2 ------------------------------------------------------------------------------------------------------------
// git replace <real config blob> <forged blob>: plain git in this checkout would now read the forged policy.
const forgeConfig = (r, cfg) => {
  const real = g(r.work, 'rev-parse', 'refs/remotes/origin/main:.product/delivery.json');
  const tmp = path.join(r.root, 'forged.json'); fs.writeFileSync(tmp, JSON.stringify(cfg));
  const fake = g(r.work, 'hash-object', '-w', tmp);
  g(r.work, 'replace', '-f', real, fake);
  assert.match(g(r.work, 'show', 'refs/remotes/origin/main:.product/delivery.json'), /"required":false/, 'control: plain git sees the forged policy');
};

test('T10 r2: a refs/replace-forged base config (required:false) is ignored by the policy read; the preflight refuses refs/replace', () => {
  const a = vship();
  forgeConfig(a, { protected_branches: [], verification: { required: false } });
  const x = merge(a); // ci_passed: the policy read ignores the replace ref, so this is driver mode, and the pre-fetch preflight refuses
  assert.equal(J(x)?.state, 'awaiting_human', x.out + x.err); assert.match(J(x).reason, /not a trusted clone/); assert.equal(mergeCalled(a), false);
  a.edit((f) => { f.state = 'verified'; });
  arm(a);
  const y = merge(a);
  assert.equal(J(y)?.state, 'awaiting_human', y.out + y.err); assert.match(J(y).reason, /not a trusted clone/); assert.equal(mergeCalled(a), false);
  assert.throws(() => GS.checkNoReplaceRefs(a.work), /refs\/replace present/);
  assert.doesNotThrow(() => GS.checkRepoMetadata(a.work), 'ordinary gitSafe calls ignore replace refs instead (GIT_NO_REPLACE_OBJECTS)');
  g(a.work, 'pack-refs', '--all'); // packed replace refs are found too
  assert.ok(!fs.existsSync(path.join(gitDirOf(a), 'refs', 'replace', g(a.work, 'rev-parse', 'refs/remotes/origin/main:.product/delivery.json'))), 'control: the replace ref is packed now');
  assert.throws(() => GS.checkNoReplaceRefs(a.work), /refs\/replace present/);
  g(a.work, 'replace', '-d', g(a.work, 'rev-parse', 'refs/remotes/origin/main:.product/delivery.json'));
  assert.doesNotThrow(() => GS.checkNoReplaceRefs(a.work));
  rm(a);
});

test('T10 r2: commit-graphs are never read or written by gitSafe, and a planted one is refused (an empty commit-graphs dir is not)', () => {
  for (const kv of ['core.commitGraph=false', 'gc.writeCommitGraph=false', 'fetch.writeCommitGraph=false']) assert.ok(GS.GIT_SAFE_FLAGS.includes(kv), kv);
  const r = vship();
  for (const kv of ['core.commitGraph=false', 'gc.writeCommitGraph=false', 'fetch.writeCommitGraph=false']) assert.equal(GS.gitSafeOpts(r.work, ['-c', kv, 'rev-parse', 'HEAD'], { verified: true }).code, 0, `caller may pass ${kv}`);
  assert.throws(() => GS.gitSafeOpts(r.work, ['-c', 'core.commitGraph=true', 'rev-parse', 'HEAD'], { verified: true }), /not allowed/);
  r.edit((f) => { f.state = 'verified'; });
  arm(r);
  g(r.work, 'commit-graph', 'write', '--reachable');
  assert.ok(fs.existsSync(path.join(gitDirOf(r), 'objects', 'info', 'commit-graph')));
  assert.throws(() => GS.checkRepoMetadata(r.work), /objects\/info\/commit-graph present/);
  assert.throws(() => GS.gitSafe(r.work, 'status'), /commit-graph present/);
  const m = merge(r);
  assert.equal(J(m)?.state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /not a trusted clone/); assert.equal(mergeCalled(r), false);
  fs.rmSync(path.join(gitDirOf(r), 'objects', 'info', 'commit-graph'));
  const cgs = path.join(gitDirOf(r), 'objects', 'info', 'commit-graphs');
  fs.mkdirSync(cgs);
  assert.doesNotThrow(() => GS.checkRepoMetadata(r.work), 'an empty commit-graphs directory holds no graph');
  fs.writeFileSync(path.join(cgs, 'commit-graph-chain'), 'x\n');
  assert.throws(() => GS.checkRepoMetadata(r.work), /commit-graphs present/, 'a chain file inside it is refused');
  fs.rmSync(cgs, { recursive: true });
  fs.symlinkSync(os.tmpdir(), cgs);
  assert.throws(() => GS.checkRepoMetadata(r.work), /commit-graphs present/, 'a symlink in its place is refused');
  rm(r);
});

// ---- Task 10 fix round 3 ------------------------------------------------------------------------------------------------------------
test('T10 r3: a planted origin/<base> (required:false) that `git fetch origin` would never refresh does not decide the policy', () => {
  const r = vship();
  const br = g(r.work, 'rev-parse', '--abbrev-ref', 'HEAD');
  g(r.work, 'checkout', '-q', '-b', 'evil', 'refs/remotes/origin/main');
  fs.writeFileSync(path.join(r.work, '.product/delivery.json'), JSON.stringify({ protected_branches: [], verification: { required: false } }));
  g(r.work, 'commit', '-q', '-am', 'forged policy'); const evil = g(r.work, 'rev-parse', 'HEAD');
  g(r.work, 'checkout', '-q', br);
  g(r.work, 'update-ref', 'refs/remotes/origin/main', evil);
  g(r.work, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/elsewhere');
  g(r.work, 'fetch', '-q', 'origin');
  assert.equal(g(r.work, 'rev-parse', 'refs/remotes/origin/main'), evil, 'control: a plain fetch leaves the planted ref');
  const x = merge(r); // ci_passed: refused, because the REAL base requires verification
  assert.equal(x.code, 1, x.out + x.err); assert.match(x.err, /verification is required/);
  assert.notEqual(g(r.work, 'rev-parse', 'refs/remotes/origin/main'), evil, 'the explicit refspec refreshed the tracking ref');
  rm(r);
});

test('T10 r3: origin must be exactly the pinned repository, in every mode', () => {
  for (const url of ['git@github.com:evil/o/r.git', 'https://github.com/evil/o/r', 'git@example.com:o/r.git']) {
    const r = shipped(); // required:false, interactive (in-repo queue)
    g(r.work, 'remote', 'set-url', 'origin', url);
    const m = r.d({}, 'merge', 'FEATURE-001');
    assert.equal(J(m)?.state, 'awaiting_human', `${url}: ${m.out}${m.err}`); assert.match(J(m).reason, /origin's URL is not o\/r/); assert.equal(mergeCalled(r), false);
    rm(r);
  }
});

test('T10 r3: driver mode refuses an installed hook before the fetch runs it', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; }); arm(r);
  const marker = path.join(r.root, 'HOOK-RAN');
  fs.writeFileSync(path.join(gitDirOf(r), 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const m = merge(r);
  assert.equal(J(m)?.state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /not a trusted clone/);
  assert.equal(fs.existsSync(marker), false, 'the planted hook never ran'); assert.equal(mergeCalled(r), false);
  assert.throws(() => GS.checkNoHooks(r.work), /a hook is installed/);
  fs.rmSync(path.join(gitDirOf(r), 'hooks', 'reference-transaction'));
  assert.doesNotThrow(() => GS.checkNoHooks(r.work), 'git\'s own *.sample files are fine');
  // ... and a stale local base config that requires verification also selects driver mode (in-repo queue)
  const s = shipped({}, { config: REQ });
  s.edit((f) => { f.state = 'verified'; });
  const mk2 = path.join(s.root, 'HOOK2'); fs.writeFileSync(path.join(gitDirOf(s), 'hooks', 'reference-transaction'), `#!/bin/sh\ntouch "${mk2}"\n`, { mode: 0o755 });
  const y = s.d({}, 'merge', 'FEATURE-001');
  assert.match(J(y).reason, /not a trusted clone/, y.out + y.err); assert.equal(fs.existsSync(mk2), false);
  rm(r, s);
});

test('T10 r3: gitEnv blocks lazy fetches', () => {
  assert.equal(GS.gitEnv({}).GIT_NO_LAZY_FETCH, '1');
});

test('T10 r3: when the changed files cannot be listed (no merge base) a non-gated merge holds instead of treating the list as empty', () => {
  const r = shipped(); // required:false, T2: no verdict gate runs
  g(r.work, 'push', '-q', '-f', 'origin', `${g(r.work, 'commit-tree', 'refs/remotes/origin/main^{tree}', '-m', 'unrelated')}:refs/heads/main`);
  const m = r.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m)?.state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, /changed files could not be listed/); assert.equal(mergeCalled(r), false);
  rm(r);
});

// ---- Task 10 fix round 4 ------------------------------------------------------------------------------------------------------------
test('T10 r4: origin must resolve (after rewriting) to exactly one URL; driver mode also refuses pushurl and repo-config insteadOf', () => {
  const holds = (r, re, env = {}) => { const m = r.d({ ...r.env, ...env }, 'merge', 'FEATURE-001'); assert.equal(J(m)?.state, 'awaiting_human', m.out + m.err); assert.match(J(m).reason, re); assert.equal(mergeCalled(r), false); };
  // two url values (both the pinned one): the fetch would use the first, a later reader another
  const two = shipped(); g(two.work, 'config', '--add', 'remote.origin.url', 'git@github.com:o/r.git'); holds(two, /exactly one URL/);
  const twoD = vship(); twoD.edit((f) => { f.state = 'verified'; }); g(twoD.work, 'config', '--add', 'remote.origin.url', 'git@github.com:o/r.git'); holds(twoD, /exactly one URL/);
  // a pushurl in driver mode
  const push = vship(); push.edit((f) => { f.state = 'verified'; }); arm(push); g(push.work, 'config', 'remote.origin.pushurl', 'git@github.com:o/r.git'); holds(push, /no pushurl/);
  // a repo-config insteadOf rewriting origin to another host: interactive -> get-url sees the rewritten URL; driver -> the allowlist refuses url.*
  const rw = shipped(); g(rw.work, 'config', 'url.git@example.com:o/r.git.insteadOf', 'git@github.com:o/r.git');
  assert.equal(GS.gitSafeOpts(rw.work, ['remote', 'get-url', '--all', 'origin'], { verified: true }).out.trim(), 'git@example.com:o/r.git', 'control: get-url applies the rewrite');
  holds(rw, /origin's URL is not o\/r/);
  const rwD = vship(); rwD.edit((f) => { f.state = 'verified'; }); arm(rwD); g(rwD.work, 'config', 'url.git@example.com:o/r.git.insteadOf', 'git@github.com:o/r.git');
  holds(rwD, /not a trusted clone/);
  assert.throws(() => GS.verifyGitConfig(rwD.work), /git config not allowed: url\./);
  assert.equal(GS.touchesWorktree(['remote', 'get-url', '--all', 'origin']), false);
  rm(two, twoD, push, rw, rwD);
});

test('T10 r4: the driver fetch goes to a URL rebuilt from the pin, not to the configured remote', () => {
  const r = vship();
  r.edit((f) => { f.state = 'verified'; }); arm(r);
  // origin is another spelling of the pin (passes the check). Only the REBUILT url (git@github.com:o/r.git) is rewritten to the test
  // origin by the per-process insteadOf; `fetch origin` would go to ssh://git@github.com/o/r.git itself and fail.
  g(r.work, 'remote', 'set-url', 'origin', 'ssh://git@github.com/o/r.git');
  const m = merge(r);
  assert.equal(J(m)?.state, 'merged', m.out + m.err);
  rm(r);
});
