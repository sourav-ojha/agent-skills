// factory readiness: config keys app / tests / readiness (strict parsing, local-only URLs, argv commands).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator');
const c = await import(path.join(SK, 'core', 'scripts', 'lib', 'config.mjs'));

test('config: app/tests/readiness parse with defaults', () => {
  const { config, errors } = c.parseConfig({ app: { start: ['npm','run','dev'], ready: { url: 'http://localhost:3000/health', timeout_s: 120 } }, tests: { all: ['npm','test'] }, readiness: { min_level: 4 } });
  assert.deepEqual(errors, []);
  assert.equal(config.readiness.min_level, 4); assert.equal(config.readiness.max_age_days, 14);
  assert.equal(config.tests.timeout_s, 900);
  assert.deepEqual(config.app.start, ['npm','run','dev']);
  assert.equal(config.app.ready.timeout_s, 120);
});
test('config: defaults for app/tests/readiness', () => {
  const d = c.defaults();
  assert.deepEqual(d.app, { setup: null, start: null, stop: null, base_url: null, ready: null, logs_dir: null, seed: null, env_example: null });
  assert.deepEqual(d.tests, { setup: null, all: null, timeout_s: 900 });
  assert.equal(d.readiness, null);
});
test('config: readiness absent means not opted in', () => assert.equal(c.parseConfig({}).config.readiness, null));
test('config: rejects non-local ready url, shell strings, unknown keys, bad bounds', () => {
  for (const raw of [
    { app: { ready: { url: 'http://example.com:80/' } } },
    { app: { start: 'npm run dev' } },
    { app: { foo: 1 } },
    { app: { ready: { url: 'http://localhost:3000', log_pattern: 'x' } } },  // exactly one of url / log_pattern
    { app: { ready: { timeout_s: 10 } } },
    { app: { ready: { log_pattern: '(' } } },
    { app: { base_url: 'https://localhost:3000' } },
    { app: { logs_dir: '../x' } }, { app: { env_example: '/etc/passwd' } },
    { readiness: { min_level: 5 } }, { readiness: { max_age_days: 0 } },
    { tests: { timeout_s: 4000 } },
  ]) assert.ok(c.parseConfig(raw).errors.length, JSON.stringify(raw));
});
test('config: ready accepts log_pattern and base_url/logs_dir', () => {
  const { config, errors } = c.parseConfig({ app: { base_url: 'http://127.0.0.1:8080', logs_dir: '.logs', ready: { log_pattern: 'listening on \\d+' } } });
  assert.deepEqual(errors, []);
  assert.equal(config.app.ready.timeout_s, 120);
  assert.equal(config.app.ready.log_pattern, 'listening on \\d+');
});
test('isLocalUrl: only http localhost / 127.0.0.1 with a port', () => {
  for (const u of ['http://localhost:3000', 'http://127.0.0.1:8080/health']) assert.equal(c.isLocalUrl(u), true, u);
  for (const u of ['http://localhost', 'https://localhost:3000', 'http://example.com:80', ['http://localhost:3000', 'evil.com'].join('@'), 'http://localhost.evil.com:3000', '']) assert.equal(c.isLocalUrl(u), false, u);
});

// ---- readiness checks (Task 3) -----------------------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpDir } from './helpers.mjs';

const FIX = path.join(REPO, 'tests', 'fixtures', 'factory-apps');
const FAKE_GH = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const rd = await import(path.join(SK, 'core', 'scripts', 'lib', 'readiness.mjs'));
const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const res = (id, status) => ({ id, status });
const ALL = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];

// A work clone with a bare origin; `files` are committed on main and pushed. Returns a ctx over the real git, a fake gh, and a tracked worktree list.
function mkRepo({ files = {}, config, gh = {} } = {}) {
  const root = tmpDir('rd-');
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  const all = { ...files };
  if (config) all['.product/delivery.json'] = JSON.stringify(config, null, 2);
  for (const [f, body] of Object.entries(all)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), body); }
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ calls: [], ...gh }));
  const run = (...a) => { const r = spawnSync('node', [FAKE_GH, ...a], { encoding: 'utf8', env: { ...process.env, FAKE_GH_STATE: state } }); return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
  const trees = [];
  const worktree = (sha) => { const w = rd.gitWorktree(work, sha); trees.push(w); return w; };
  const parsed = config ? c.parseConfig(config).config : c.defaults();
  const ctx = rd.makeCtx({ root: work, config: parsed, base: 'main', gh: run, repo: 'o/r', worktree });
  return { ctx, work, root, trees, cleanup: () => { for (const t of trees) t.remove(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const only = async (r, ...ids) => Object.fromEntries((await rd.runChecks(r.ctx, { only: ids })).map((x) => [x.id, x]));

test('readiness: CHECKS table and computeLevel', () => {
  assert.deepEqual(rd.CHECKS.map((x) => x.id), [...ALL, 'A1']);
  assert.deepEqual(rd.CHECKS.filter((x) => x.runsCommands).map((x) => x.id), ['C3', 'C6', 'C7', 'C8']);
  assert.equal(rd.CHECKS.find((x) => x.id === 'A1').level, 0);
  const allPass = ALL.map((id) => res(id, 'pass'));
  const with_ = (id, status) => allPass.map((r) => (r.id === id ? res(id, status) : r));
  assert.equal(rd.computeLevel(allPass), 4);
  assert.equal(rd.computeLevel(with_('C3', 'fail')), 1);
  assert.equal(rd.computeLevel(with_('C1', 'skip')), 0);
  assert.equal(rd.computeLevel(with_('C6', 'unstable')), 3);
  assert.equal(rd.computeLevel([...allPass, res('A1', 'fail')]), 4);
  assert.equal(rd.computeLevel([]), 0);
});

test('readiness: fixItem is static help without inferred values', () => {
  for (const id of [...ALL, 'A1']) { const f = rd.fixItem(id, { reason: 'why' }); assert.equal(f.id, id); assert.equal(f.what, 'why'); assert.ok(f.change && f.help); }
});

test('C1: fails when the config file is missing, passes when it equals origin', async () => {
  const bare = mkRepo();
  const miss = await only(bare, 'C1');
  assert.equal(miss.C1.status, 'fail'); assert.match(miss.C1.reason, /missing/);
  bare.cleanup();
  const ok = mkRepo({ config: { base: 'main' } });
  assert.equal((await only(ok, 'C1')).C1.status, 'pass');
  fs.writeFileSync(path.join(ok.work, '.product/delivery.json'), JSON.stringify({ base: 'main', branch_prefix: 'x/' }));
  assert.equal((await only(ok, 'C1')).C1.status, 'fail');
  ok.cleanup();
});

test('C2: node and gh login', async () => {
  const r = mkRepo({ config: { base: 'main' } });
  assert.equal((await only(r, 'C2')).C2.status, 'pass');
  r.cleanup();
});

test('C4: tracked .env fails; configured .env.example passes; unignored logs_dir fails', async () => {
  const cfg = { app: { env_example: '.env.example', logs_dir: 'logs/' } };
  const bad = mkRepo({ files: { '.env': 'A=1\n', '.gitignore': 'logs/\n' }, config: cfg });
  const b = await only(bad, 'C4'); assert.equal(b.C4.status, 'fail'); assert.match(b.C4.reason, /\.env/);
  bad.cleanup();
  const good = mkRepo({ files: { '.env.example': 'A=1\n', '.gitignore': 'logs/\n' }, config: cfg });
  assert.equal((await only(good, 'C4')).C4.status, 'pass');
  good.cleanup();
  const noig = mkRepo({ files: { '.env.example': 'A=1\n' }, config: cfg });
  const n = await only(noig, 'C4'); assert.equal(n.C4.status, 'fail'); assert.match(n.C4.reason, /not git-ignored/);
  noig.cleanup();
  const pem = mkRepo({ files: { 'keys/server.pem': 'x', 'id_rsa': 'x' }, config: { base: 'main' } });
  assert.equal((await only(pem, 'C4')).C4.status, 'fail');
  pem.cleanup();
});

test('C4: evaluated on origin/<base>, not the working checkout', async () => {
  // base tracks .env; the local checkout deleted it (uncommitted) and has an unignored-logs change -> still fail
  const a = mkRepo({ files: { '.env': 'A=1\n' }, config: { base: 'main' } });
  fs.rmSync(path.join(a.work, '.env'));
  sh(a.work, 'rm', '-q', '--cached', '.env');
  assert.equal((await only(a, 'C4')).C4.status, 'fail');
  a.cleanup();
  // a local-only tracked .env (not on base) and a local-only .gitignore do not fail/pass C4
  const b = mkRepo({ files: { '.gitignore': 'logs/\n' }, config: { app: { logs_dir: 'logs/' } } });
  fs.writeFileSync(path.join(b.work, '.env'), 'A=1\n'); sh(b.work, 'add', '-f', '.env');
  assert.equal((await only(b, 'C4')).C4.status, 'pass');
  fs.writeFileSync(path.join(b.work, '.gitignore'), ''); // local edit dropping the ignore must not matter
  assert.equal((await only(b, 'C4')).C4.status, 'pass');
  b.cleanup();
  const c2 = mkRepo({ config: { app: { logs_dir: 'logs/' } } }); // base does not ignore logs
  fs.writeFileSync(path.join(c2.work, '.gitignore'), 'logs/\n'); // local-only ignore must not rescue it
  assert.equal((await only(c2, 'C4')).C4.status, 'fail');
  c2.cleanup();
});

test('C5: CODEOWNERS alone fails; CI workflow plus checks.required passes; protection can supply required checks', async () => {
  const co = mkRepo({ files: { '.github/CODEOWNERS': '* @me\n' }, config: { checks: { required: ['test'] } } });
  assert.equal((await only(co, 'C5')).C5.status, 'fail');
  co.cleanup();
  const ok = mkRepo({ files: { '.github/workflows/ci.yml': 'on: push\n' }, config: { checks: { required: ['test'] } } });
  assert.equal((await only(ok, 'C5')).C5.status, 'pass');
  ok.cleanup();
  const none = mkRepo({ files: { '.github/workflows/ci.yml': 'on: push\n' }, config: { base: 'main' } });
  assert.equal((await only(none, 'C5')).C5.status, 'fail');
  none.cleanup();
  const prot = mkRepo({ files: { '.github/workflows/ci.yml': 'on: push\n' }, config: { base: 'main' }, gh: { protection: { required_status_checks: { contexts: ['test'] } } } });
  assert.equal((await only(prot, 'C5')).C5.status, 'pass');
  prot.cleanup();
});

test('A1: 404 on both fails; protection or rules with required checks pass; other errors are unknown', async () => {
  const none = mkRepo({ config: { base: 'main' } });
  assert.equal((await only(none, 'A1')).A1.status, 'fail');
  none.cleanup();
  const p = mkRepo({ config: { base: 'main' }, gh: { protection: { required_status_checks: { contexts: ['test'], checks: [] } } } });
  assert.equal((await only(p, 'A1')).A1.status, 'pass');
  p.cleanup();
  const r = mkRepo({ config: { base: 'main' }, gh: { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }] } });
  assert.equal((await only(r, 'A1')).A1.status, 'pass');
  r.cleanup();
  const e = mkRepo({ config: { base: 'main' } });
  e.ctx.gh = () => ({ code: 1, out: '', err: 'HTTP 403 forbidden' });
  assert.equal((await only(e, 'A1')).A1.status, 'unknown');
  e.cleanup();
});

// A repo whose app is one of the fixtures, on its own free port. Extra env goes in .env.example (the only env source besides the allowlist).
async function appRepo(fixture, { env = {}, app = {}, logs = true, seed } = {}) {
  const port = await freePort();
  const envText = [`PORT=${port}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join('\n') + '\n';
  const cfg = { app: { start: ['node', path.join(FIX, `${fixture}.mjs`)], ready: { url: `http://127.0.0.1:${port}/health`, timeout_s: 3 }, env_example: '.env.example', ...(logs ? { logs_dir: 'logs/' } : {}), ...(seed ? { seed } : {}), ...app } };
  const r = mkRepo({ files: { '.env.example': envText, '.gitignore': 'logs/\n' }, config: cfg });
  r.port = port;
  return r;
}

test('C6/C7/C8: healthy fixture passes, worktrees are removed', async () => {
  const r = await appRepo('ready');
  const x = await only(r, 'C6', 'C7', 'C8');
  assert.equal(x.C6.status, 'pass', x.C6.reason); assert.equal(x.C7.status, 'pass', x.C7.reason); assert.equal(x.C8.status, 'pass', x.C8.reason);
  assert.ok(r.trees.length >= 1 && r.trees.every((t) => !fs.existsSync(t.dir)));
  assert.doesNotMatch(sh(r.work, 'worktree', 'list'), /factory-wt/);
  r.cleanup();
});

test('C6: app that never becomes healthy fails', async () => {
  const r = await appRepo('never');
  r.ctx.config.app.ready.timeout_s = 1;
  const x = await only(r, 'C6');
  assert.equal(x.C6.status, 'fail'); assert.match(x.C6.reason, /did not become ready/);
  r.cleanup();
});

test('C6: pre-occupied port fails with "port in use" and starts nothing', async () => {
  const r = await appRepo('ready');
  const srv = net.createServer(); await new Promise((ok) => srv.listen(r.port, '127.0.0.1', ok));
  try {
    const x = await only(r, 'C6');
    assert.equal(x.C6.status, 'fail'); assert.match(x.C6.reason, /port in use/); assert.ok(x.C6.reason.includes(String(r.port)));
  } finally { srv.close(); r.cleanup(); }
});

test('C6: a process that survives stop on the port fails naming the port', async () => {
  const pidFile = path.join(tmpDir('rd-pid-'), 'pid');
  const r = await appRepo('detached', { env: { CHILD_PID_FILE: pidFile } });
  try {
    const x = await only(r, 'C6');
    assert.equal(x.C6.status, 'fail'); assert.ok(x.C6.reason.includes(String(r.port)), x.C6.reason); assert.match(x.C6.reason, /still listening/);
  } finally {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    r.cleanup();
  }
});

test('C7: app that writes no log fails; C8 with a failing seed fails', async () => {
  const r = await appRepo('nolog');
  const x = await only(r, 'C6', 'C7');
  assert.equal(x.C6.status, 'pass', x.C6.reason);
  assert.equal(x.C7.status, 'fail'); assert.match(x.C7.reason, /logs/);
  r.cleanup();
  const s = await appRepo('ready', { seed: ['node', '-e', 'process.exit(3)'] });
  const y = await only(s, 'C8'); assert.equal(y.C8.status, 'fail'); assert.match(y.C8.reason, /app\.seed/);
  s.cleanup();
});

test('C6: flaky app (fail then pass) is unstable', async () => {
  const counter = path.join(tmpDir('rd-cnt-'), 'n'); fs.writeFileSync(counter, '1'); // next start is #2 (503), then #3 (200)
  const r = await appRepo('flaky', { env: { COUNTER_FILE: counter }, logs: false });
  r.ctx.config.app.ready.timeout_s = 1;
  const x = await only(r, 'C6');
  assert.equal(x.C6.status, 'unstable', x.C6.reason);
  r.cleanup();
});

test('C3: passing tests pass; a failing command redacts its tail and has fix help', async () => {
  const ok = mkRepo({ config: { tests: { all: ['node', '-e', 'process.exit(0)'] } } });
  assert.equal((await only(ok, 'C3')).C3.status, 'pass');
  ok.cleanup();
  const token = 'ghp_' + 'a'.repeat(30);
  const bad = mkRepo({ config: { tests: { all: ['node', '-e', `console.log('token=${token}'); console.log('GITHUB ${token}'); process.exit(1)`] } } });
  const x = await only(bad, 'C3');
  assert.equal(x.C3.status, 'fail'); assert.doesNotMatch(x.C3.reason, /ghp_a/); assert.match(x.C3.reason, /<(secret|token)>/);
  const f = rd.fixItem('C3', x.C3); assert.ok(f.help); assert.doesNotMatch(JSON.stringify(f), /ghp_a/);
  bad.cleanup();
});

test('C3: command checks run with the allowlisted environment only', async () => {
  process.env.READINESS_LEAK_TEST = 'leaked';
  const r = mkRepo({ config: { tests: { all: ['node', '-e', 'process.exit(process.env.READINESS_LEAK_TEST === undefined && process.env.CI === "1" ? 0 : 1)'] } } });
  try { assert.equal((await only(r, 'C3')).C3.status, 'pass'); } finally { delete process.env.READINESS_LEAK_TEST; r.cleanup(); }
});

test('unconfigured command checks skip', async () => {
  const r = mkRepo({ config: { base: 'main' } });
  const x = await only(r, 'C3', 'C6', 'C7', 'C8');
  for (const id of ['C3', 'C6', 'C7', 'C8']) assert.equal(x[id].status, 'skip', id);
  r.cleanup();
});

// ---- deliver readiness command (Task 4) --------------------------------------------------------------------------------
const DELIVER = path.join(SK, 'core', 'scripts', 'deliver.mjs');
async function cliRepo({ config = {}, files = {} } = {}) {
  const port = await freePort();
  const root = tmpDir('rdcli-');
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin'), home = path.join(root, 'fhome');
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE_GH, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  sh(work, 'config', `url.${origin}.insteadOf`, 'git@github.com:o/r.git');
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  const cfg = { checks: { required: ['test'] }, tests: { all: ['node', '-e', 'process.exit(0)'] }, app: { start: ['node', path.join(FIX, 'ready.mjs')], ready: { url: `http://127.0.0.1:${port}/health`, timeout_s: 5 }, env_example: '.env.example', logs_dir: 'logs/' }, readiness: { min_level: 4 }, ...config };
  const all = { '.env.example': `PORT=${port}\n`, '.gitignore': 'logs/\n', '.github/workflows/ci.yml': 'on: push\n', '.product/delivery.json': JSON.stringify(cfg, null, 2), 'README.md': 'hi\n', ...files };
  for (const [f, body] of Object.entries(all)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), body); }
  sh(work, 'checkout', '-q', '-b', 'main');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [] }));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: home, GH_TOKEN: 'secret-token-value-123' };
  const d = (...a) => { const r = spawnSync('node', [DELIVER, ...a, '--dir', work], { encoding: 'utf8', env }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { root, work, home, d, file: path.join(home, 'readiness', 'o__r.json') };
}

test('deliver readiness: ready fixture reaches level 4, stores the result, no env values', async () => {
  const r = await cliRepo();
  const x = r.d('readiness');
  assert.equal(x.code, 0, x.out + x.err);
  assert.match(x.out, /level 4/);
  const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(doc.level, 4);
  assert.equal(doc.base_sha, sh(r.work, 'rev-parse', 'origin/main'));
  assert.equal(doc.config_hash, `sha256:${createHash('sha256').update(fs.readFileSync(path.join(r.work, '.product/delivery.json'))).digest('hex')}`);
  assert.ok(doc.helper_version && doc.at && Array.isArray(doc.fixes));
  assert.doesNotMatch(fs.readFileSync(r.file, 'utf8') + x.out + x.err, /secret-token-value-123/);
  fs.rmSync(r.root, { recursive: true, force: true });
});
test('deliver readiness: --repeat 2 gives identical statuses', async () => {
  const r = await cliRepo();
  const a = r.d('readiness'); assert.equal(a.code, 0, a.out + a.err);
  const one = JSON.parse(fs.readFileSync(r.file, 'utf8')).results.map((z) => [z.id, z.status]);
  const b = r.d('readiness', '--repeat', '2', '--json'); assert.equal(b.code, 0, b.out + b.err);
  assert.deepEqual(JSON.parse(b.out).results.map((z) => [z.id, z.status]), one);
  fs.rmSync(r.root, { recursive: true, force: true });
});
test('deliver readiness: below min_level exits 2 with fix items', async () => {
  const r = await cliRepo({ config: { tests: { all: ['node', '-e', 'process.exit(1)'] } } });
  const x = r.d('readiness');
  assert.equal(x.code, 2, x.out + x.err);
  const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.ok(doc.level < 4 && doc.fixes.some((f) => f.id === 'C3'));
  fs.rmSync(r.root, { recursive: true, force: true });
});

test('deliver readiness: a failing test command that prints its environment leaks no secret', async () => {
  const r = await cliRepo({ config: { tests: { all: ['node', '-e', 'console.log(JSON.stringify(process.env)); console.error(process.env.GH_TOKEN, process.env.MY_SECRET_SENTINEL); process.exit(1)'] } } });
  const env = { MY_SECRET_SENTINEL: 'sentinel-value-987' };
  const run = spawnSync('node', [DELIVER, 'readiness', '--dir', r.work], { encoding: 'utf8', env: { ...process.env, ...env, PATH: `${path.join(r.root, 'bin')}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: path.join(r.root, 'gh.json'), SKILL_RUNLOG: 'off', FACTORY_HOME: r.home, GH_TOKEN: 'secret-token-value-123' } });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  const doc = fs.readFileSync(r.file, 'utf8');
  assert.match(doc, /"id": "C3"/); assert.match(doc, /"status": "fail"/);
  for (const s of ['secret-token-value-123', 'sentinel-value-987']) for (const t of [doc, run.stdout, run.stderr]) assert.ok(!t.includes(s), `leaked ${s}`);
  fs.rmSync(r.root, { recursive: true, force: true });
});

// ---- factoryhome.mjs ---------------------------------------------------------------------------------------------------
const fh = await import(path.join(SK, 'core', 'scripts', 'lib', 'factoryhome.mjs'));
test('factoryhome: repoKey and factoryHome', () => {
  assert.equal(fh.repoKey('a/b'), 'a__b');
  const saved = process.env.FACTORY_HOME;
  try {
    process.env.FACTORY_HOME = '/x/y'; assert.equal(fh.factoryHome(), '/x/y');
    delete process.env.FACTORY_HOME; assert.equal(fh.factoryHome(), path.join(os.homedir(), '.factory'));
  } finally { if (saved === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = saved; }
});
test('factoryhome: readJson returns null for missing or invalid files', () => {
  const d = tmpDir('fh-');
  assert.equal(fh.readJson(path.join(d, 'nope.json')), null);
  fs.writeFileSync(path.join(d, 'bad.json'), '{x');
  assert.equal(fh.readJson(path.join(d, 'bad.json')), null);
  fs.writeFileSync(path.join(d, 'ok.json'), '{"a":1}');
  assert.deepEqual(fh.readJson(path.join(d, 'ok.json')), { a: 1 });
  fs.rmSync(d, { recursive: true, force: true });
});
test('factoryhome: writeJsonAtomic writes, refuses symlinked dir and target, and leaves no tmp file on failure', () => {
  const d = tmpDir('fh-');
  const good = path.join(d, 'sub', 'a.json');
  fh.writeJsonAtomic(good, { v: 1 });
  assert.deepEqual(fh.readJson(good), { v: 1 });
  const real = path.join(d, 'real'); fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(d, 'linkdir'));
  assert.throws(() => fh.writeJsonAtomic(path.join(d, 'linkdir', 'a.json'), {}), /symlink/);
  assert.deepEqual(fs.readdirSync(real), []);
  const victim = path.join(d, 'victim.txt'); fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(d, 'sub', 'link.json'));
  assert.throws(() => fh.writeJsonAtomic(path.join(d, 'sub', 'link.json'), {}), /symlink/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  // forced rename failure: the target is a directory
  fs.mkdirSync(path.join(d, 'sub', 'dirtarget'));
  assert.throws(() => fh.writeJsonAtomic(path.join(d, 'sub', 'dirtarget'), {}));
  assert.deepEqual(fs.readdirSync(path.join(d, 'sub')).filter((n) => n.includes('.tmp-')), []);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---- deliver init readiness gate (Task 5) ------------------------------------------------------------------------------
const featureMd = '---\nid: FEATURE-001\ntitle: One\nstatus: ready\n---\nbody\n';
async function gateRepo(config = {}, opts = {}) {
  const r = await cliRepo({ config: { protected_branches: ['release/*'], ...config }, files: { '.product/features/FEATURE-001.md': featureMd, ...(opts.files || {}) } });
  return r;
}
const initArgs = ['init', '--merge', '--note', 'ok to merge'];
const rewriteFile = (r, fn) => { const d = JSON.parse(fs.readFileSync(r.file, 'utf8')); fn(d); fs.writeFileSync(r.file, JSON.stringify(d)); };
const done = (r) => fs.rmSync(r.root, { recursive: true, force: true });

test('init gate: opted in + merge + no readiness file is refused', async () => {
  const r = await gateRepo();
  const x = r.d(...initArgs);
  assert.equal(x.code, 1, x.out + x.err);
  assert.match(x.err, /deliver readiness/);
  done(r);
});
test('init gate: passes and stores readiness_level', async () => {
  const r = await gateRepo();
  assert.equal(r.d('readiness').code, 0);
  const x = r.d(...initArgs);
  assert.equal(x.code, 0, x.out + x.err);
  const q = JSON.parse(fs.readFileSync(path.join(r.work, '.delivery', 'queue.json'), 'utf8'));
  assert.equal(q.readiness_level, 4);
  done(r);
});
test('init gate: stale readiness file (15 days) is refused', async () => {
  const r = await gateRepo();
  assert.equal(r.d('readiness').code, 0);
  rewriteFile(r, (d) => { d.at = new Date(Date.now() - 15 * 86400000).toISOString(); });
  const x = r.d(...initArgs);
  assert.equal(x.code, 1, x.out + x.err);
  assert.match(x.err, /older than|stale/i);
  done(r);
});
test('init gate: config edited after the check is refused', async () => {
  const r = await gateRepo();
  assert.equal(r.d('readiness').code, 0);
  rewriteFile(r, (d) => { d.config_hash = 'sha256:' + '0'.repeat(64); });
  const x = r.d(...initArgs);
  assert.equal(x.code, 1, x.out + x.err);
  assert.match(x.err, /config changed since readiness check/);
  done(r);
});
test('init gate: a tracked .env added afterwards lowers the level and refuses', async () => {
  const r = await gateRepo();
  assert.equal(r.d('readiness').code, 0);
  fs.writeFileSync(path.join(r.work, '.env'), 'X=1\n');
  sh(r.work, 'add', '-f', '.env'); sh(r.work, 'commit', '-q', '-m', 'env'); sh(r.work, 'push', '-q', 'origin', 'main');
  const x = r.d(...initArgs);
  assert.equal(x.code, 1, x.out + x.err);
  assert.match(x.err, /below the required 4/);
  assert.match(x.err, /C4/);
  done(r);
});
test('init gate: merge.mode pr-only is not gated and warns when the stored level is below 3', async () => {
  const r = await gateRepo({ merge: { mode: 'pr-only', allow_tier3: false } });
  const nogate = r.d('init');
  assert.equal(nogate.code, 0, nogate.out + nogate.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.work, '.delivery', 'queue.json'), 'utf8')).readiness_level, null);
  assert.equal(r.d('reset', '--yes').code, 0);
  fs.mkdirSync(path.dirname(r.file), { recursive: true });
  fs.writeFileSync(r.file, JSON.stringify({ level: 2, at: new Date().toISOString(), results: [], config_hash: null }));
  const x = r.d('init', '--dry-run');
  assert.equal(x.code, 0, x.out + x.err);
  assert.match(JSON.parse(x.out).warnings.join('\n'), /readiness level is 2/);
  done(r);
});
