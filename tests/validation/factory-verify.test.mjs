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
  const env = { ...process.env, PATH: `${path.join(r.root, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: path.join(r.root, 'gh.json'), SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(r.root, 'fhome') };
  const x = process.platform === 'darwin'
    ? spawnSync('script', ['-q', '/dev/null', 'node', ...argv], { encoding: 'utf8', env, stdio: devnull() })
    : spawnSync('script', ['-qec', ['node', ...argv].map((a) => `'${a}'`).join(' '), '/dev/null'], { encoding: 'utf8', env, stdio: devnull() });
  return { code: x.status, out: x.stdout, err: x.stderr };
}

test('retry --note under a real terminal: needs a note, records it bound to the head sha, returns to pr_open', (t) => {
  const r = shipped();
  r.edit((f) => { f.state = 'awaiting_human'; f.hold_kind = 'antigaming'; f.reason = 'G1'; });
  const a = underTty(r, 'retry', 'FEATURE-001');
  if (!a) { t.skip('script(1) is not available: cannot allocate a pseudo-terminal'); fs.rmSync(r.root, { recursive: true, force: true }); return; }
  assert.notEqual(a.code, 0, a.out); assert.match(a.out + a.err, /--note/);
  assert.equal(r.feat().state, 'awaiting_human');
  const flag = underTty(r, 'retry', 'FEATURE-001', '--note', '--no-ci');
  assert.notEqual(flag.code, 0, 'a flag swallowed as the note value is refused');
  const b = underTty(r, 'retry', 'FEATURE-001', '--note', 'reviewed the diff, the test change is intended');
  assert.equal(b.code, 0, b.out + b.err);
  const f = r.feat();
  assert.equal(f.state, 'pr_open');
  assert.equal(f.override_note, 'reviewed the diff, the test change is intended');
  assert.equal(f.override_sha, f.pr.head_sha);
  assert.ok(Q.overrideValid(f, f.pr.head_sha));
  assert.ok(!f.hold_kind);
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('overrideValid: only for the exact head sha the override was given on', () => {
  const f = { override_note: 'ok', override_sha: 'abc' };
  assert.equal(Q.overrideValid(f, 'abc'), true);
  assert.equal(Q.overrideValid(f, 'abd'), false, 'a later push voids it');
  assert.equal(Q.overrideValid(f, undefined), false);
  assert.equal(Q.overrideValid({ override_sha: 'abc' }, 'abc'), false, 'no note');
  assert.equal(Q.overrideValid({ override_note: 'ok' }, 'abc'), false, 'no sha');
  assert.equal(Q.overrideValid(null, 'abc'), false);
});

test('merge reads the base config fail-closed: missing ref and invalid JSON refuse; a genuinely absent file means defaults', () => {
  const git = (cwd, ...a) => { const x = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (x.status !== 0) throw new Error(x.stderr); return x.stdout.trim(); };
  const pushCfg = (r, content) => {
    const br = git(r.work, 'rev-parse', '--abbrev-ref', 'HEAD');
    git(r.work, 'checkout', '-q', 'main');
    if (content === null) git(r.work, 'rm', '-q', '.product/delivery.json'); else fs.writeFileSync(path.join(r.work, '.product/delivery.json'), content);
    git(r.work, 'commit', '-q', '-am', 'cfg'); git(r.work, 'push', '-q', 'origin', 'main'); git(r.work, 'checkout', '-q', br);
  };
  const bad = shipped();
  pushCfg(bad, '{ not json');
  const a = bad.d({}, 'merge', 'FEATURE-001');
  assert.notEqual(a.code, 0); assert.match(a.err, /cannot be read/);
  assert.equal(bad.feat().state, 'ci_passed');

  const noRef = shipped();
  const origin = path.join(noRef.root, 'origin.git');
  git(origin, 'update-ref', '-d', 'refs/heads/main'); git(noRef.work, 'update-ref', '-d', 'refs/remotes/origin/main');
  const b = noRef.d({}, 'merge', 'FEATURE-001');
  assert.notEqual(b.code, 0); assert.match(b.err, /cannot be read/, b.err);

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

test('T3 with --merge-t3 merges with a real passing verdict for the exact commit; a mismatched or failing verdict still holds', () => {
  const put = (r, doc) => { const prev = process.env.FACTORY_HOME; process.env.FACTORY_HOME = path.join(r.root, 'fhome'); try { V.writeVerdict('o__r', doc); } finally { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; } };
  const ok = shipped({}, { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'] });
  put(ok, vdoc({ sha: ok.feat().ci_sha }));
  const m = ok.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(m)?.state, 'merged', m.out + m.err);

  const other = shipped({}, { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'] });
  put(other, vdoc()); // sha aaaa..., not this commit
  const o = other.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(o).state, 'awaiting_human'); assert.match(J(o).reason, /verdict/);

  const failing = shipped({}, { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'] });
  put(failing, vdoc({ sha: failing.feat().ci_sha, verdict: 'fail', results: [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: false }] }));
  const f = failing.d({}, 'merge', 'FEATURE-001');
  assert.equal(J(f).state, 'awaiting_human'); assert.match(J(f).reason, /verdict/);

  const tamper = shipped({}, { tier: 'T3', init: ['--merge', '--note', 'ok', '--merge-t3'] });
  put(tamper, vdoc({ sha: tamper.feat().ci_sha }));
  const tf = path.join(tamper.root, 'fhome', 'verdicts', 'o__r', `FEATURE-001.${tamper.feat().ci_sha}.json`);
  fs.writeFileSync(tf, fs.readFileSync(tf, 'utf8').replace('"flaky": false', '"flaky": true'));
  assert.equal(J(tamper.d({}, 'merge', 'FEATURE-001')).state, 'awaiting_human');
  for (const r of [ok, other, failing, tamper]) fs.rmSync(r.root, { recursive: true, force: true });
});
