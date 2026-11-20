// factory probe: isolation probe reports per-route denied|leaked|error and never prints file contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const SCRIPT = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'probe.mjs');
const { runProbe, ROUTES } = await import(SCRIPT);
const TOKEN = 'probe-token-' + 'a1b2c3d4e5f6a7b8';
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-probe-')); t.after(() => { try { fs.chmodSync(path.join(d, 'target', '.probe-sentinel'), 0o600); } catch { /* absent */ } fs.rmSync(d, { recursive: true, force: true }); }); return d; };
const fixture = (t) => {
  const d = tmp(t);
  const target = path.join(d, 'target'); const wt = path.join(d, 'wt'); const work = path.join(d, 'work');
  for (const x of [target, wt, work]) fs.mkdirSync(x);
  fs.writeFileSync(path.join(target, '.probe-sentinel'), TOKEN + '\n');
  return { d, target, wt, work };
};
const byRoute = (r) => Object.fromEntries(r.routes.map((x) => [x.route, x]));
const opts = (f, extra = {}) => ({ target: f.target, writeTarget: f.wt, workdir: f.work, token: TOKEN, timeoutMs: 3000, ...extra });

test('route list covers the spec routes', () => {
  for (const r of ['fs.readFile', 'cat', 'cp', 'find', 'tar', 'mdfind', 'qlmanage', 'node -e', 'python -c', 'git -C', 'hardlink', 'symlink', 'write']) assert.ok(ROUTES.includes(r), r);
});

test('unsandboxed: every shell route that can run reports leaked', (t) => {
  const f = fixture(t);
  const r = byRoute(runProbe(opts(f)));
  for (const route of ['fs.readFile', 'cat', 'cp', 'find', 'tar', 'node -e', 'git -C', 'hardlink', 'symlink', 'write']) {
    assert.equal(r[route].result, 'leaked', `${route}: ${r[route].detail}`);
  }
  if (r['python -c'].detail !== 'tool missing') assert.equal(r['python -c'].result, 'leaked');
  for (const route of ['mdfind', 'qlmanage']) assert.ok(['denied', 'leaked', 'error'].includes(r[route].result));
});

test('unreadable sentinel: read routes report denied', (t) => {
  const f = fixture(t);
  fs.chmodSync(path.join(f.target, '.probe-sentinel'), 0o000);
  if (process.getuid && process.getuid() === 0) return;
  const r = byRoute(runProbe(opts(f)));
  for (const route of ['fs.readFile', 'cat', 'cp', 'tar', 'node -e', 'hardlink', 'symlink']) assert.equal(r[route].result, 'denied', `${route}: ${r[route].detail}`);
});

test('write route: denied when the target is read-only, leaked when writable; always cleaned up', (t) => {
  const f = fixture(t);
  let r = byRoute(runProbe(opts(f)));
  assert.equal(r.write.result, 'leaked');
  assert.deepEqual(fs.readdirSync(f.wt), []);
  assert.deepEqual(fs.readdirSync(f.work), []);
  if (process.getuid && process.getuid() === 0) return;
  fs.chmodSync(f.wt, 0o500);
  try { r = byRoute(runProbe(opts(f))); } finally { fs.chmodSync(f.wt, 0o700); }
  assert.equal(r.write.result, 'denied');
});

test('missing tool is an error with detail "tool missing"', (t) => {
  const f = fixture(t);
  const r = byRoute(runProbe(opts(f, { bin: { python: '/nonexistent/python-xyz', tar: '/nonexistent/tar-xyz' } })));
  assert.deepEqual([r['python -c'].result, r['python -c'].detail], ['error', 'tool missing']);
  assert.deepEqual([r.tar.result, r.tar.detail], ['error', 'tool missing']);
});

test('no token and no readable sentinel: routes error, none leak', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.target, '.probe-sentinel'));
  const r = runProbe(opts(f, { token: '' }));
  assert.ok(r.routes.filter((x) => x.route !== 'write').every((x) => x.result !== 'leaked'));
});

test('CLI --json: shape, exit code, and the token and file contents never appear in output', (t) => {
  const f = fixture(t);
  const run = spawnSync('node', [SCRIPT, '--target', f.target, '--write-target', f.wt, '--workdir', f.work, '--json'], { encoding: 'utf8', env: { ...process.env, PROBE_TOKEN: TOKEN }, timeout: 120000 });
  assert.equal(run.status, 1, run.stderr); // leaks found
  assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));
  const j = JSON.parse(run.stdout);
  assert.ok(Array.isArray(j.routes));
  for (const x of j.routes) { assert.ok(['denied', 'leaked', 'error'].includes(x.result)); assert.equal(typeof x.detail, 'string'); assert.deepEqual(Object.keys(x).sort(), ['detail', 'result', 'route']); }
});

test('CLI text output and usage error', (t) => {
  const f = fixture(t);
  const run = spawnSync('node', [SCRIPT, '--target', f.target, '--write-target', f.wt, '--workdir', f.work], { encoding: 'utf8', env: { ...process.env, PROBE_TOKEN: TOKEN }, timeout: 120000 });
  assert.ok(/fs\.readFile\s+leaked/.test(run.stdout));
  assert.ok(!run.stdout.includes(TOKEN));
  const bad = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

const cli = (f, extra = [], env = { PROBE_TOKEN: TOKEN }) => spawnSync('node', [SCRIPT, '--target', f.target, '--write-target', f.wt, '--workdir', f.work, '--json', ...extra], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });

test('missing target dir: reads denied, with a "proves nothing" warning', (t) => {
  const f = fixture(t);
  const bad = { ...f, target: path.join(f.d, 'nope', 'deeper') };
  const run = cli(bad);
  const j = JSON.parse(run.stdout);
  assert.ok(j.warnings.some((w) => /parent directory of --target/.test(w)));
  assert.ok(j.warnings.some((w) => /proves nothing without a control run/.test(w)));
  assert.ok(j.routes.filter((x) => x.route !== 'write' && !x.detail.startsWith('not configured') && !['mdfind', 'qlmanage', 'python -c'].includes(x.route)).every((x) => x.result === 'denied'));
  assert.match(run.stderr, /proves nothing/);
});

test('wrong token: nothing leaks and the all-denied warning shows', (t) => {
  const f = fixture(t);
  const j = JSON.parse(cli(f, [], { PROBE_TOKEN: 'not-the-token' }).stdout);
  assert.ok(j.routes.filter((x) => x.route !== 'write').every((x) => x.result !== 'leaked'));
  assert.ok(j.token_sha256 && j.token_sha256 !== JSON.parse(cli(f).stdout).token_sha256);
});

test('--control: mismatch exits 3; match exits per result; token never in output', (t) => {
  const f = fixture(t);
  const ctlFile = path.join(f.d, 'control.json');
  const ctl = cli(f); fs.writeFileSync(ctlFile, ctl.stdout);
  assert.ok(!ctl.stdout.includes(TOKEN));
  assert.equal(JSON.parse(ctl.stdout).token_sha256.length, 64);
  // match (still unsandboxed, so leaks -> exit 1, control accepted)
  const ok = cli(f, ['--control', ctlFile]); assert.equal(ok.status, 1); assert.equal(JSON.parse(ok.stdout).control, 'accepted');
  // different token
  const bad = cli(f, ['--control', ctlFile], { PROBE_TOKEN: 'other' }); assert.equal(bad.status, 3); assert.match(bad.stderr, /token differs/);
  // different target
  const other = { ...f, target: f.work };
  assert.equal(cli(other, ['--control', ctlFile]).status, 3);
  // control run that did not leak (e.g. recorded against a typo'd target)
  const j = JSON.parse(ctl.stdout); j.routes.find((r) => r.route === 'cat').result = 'denied'; fs.writeFileSync(ctlFile, JSON.stringify(j));
  const weak = cli(f, ['--control', ctlFile]); assert.equal(weak.status, 3); assert.match(weak.stderr, /did not leak via cat/);
  // unreadable control file
  assert.equal(cli(f, ['--control', path.join(f.d, 'absent.json')]).status, 3);
});

test('--control: empty, partial or malformed routes are rejected with exit 3, never a crash', (t) => {
  const f = fixture(t);
  const ctlFile = path.join(f.d, 'control.json');
  const good = JSON.parse(cli(f).stdout);
  const variants = {
    empty: { ...good, routes: [] },
    missing: { ...good, routes: good.routes.filter((r) => r.route !== 'cat') },
    nullEntry: { ...good, routes: [null, ...good.routes] },
    stringEntry: { ...good, routes: ['cat', ...good.routes.slice(1)] },
    noResult: { ...good, routes: good.routes.map((r) => (r.route === 'cat' ? { route: 'cat' } : r)) },
  };
  for (const [name, c] of Object.entries(variants)) {
    fs.writeFileSync(ctlFile, JSON.stringify(c));
    const r = cli(f, ['--control', ctlFile]);
    assert.equal(r.status, 3, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /control rejected/);
  }
  fs.writeFileSync(ctlFile, JSON.stringify(good));
  assert.equal(cli(f, ['--control', ctlFile]).status, 1); // the genuine control is still accepted
});

test('--control accepted and everything denied: exit 0', (t) => {
  if (process.getuid && process.getuid() === 0) return;
  const f = fixture(t);
  const ctlFile = path.join(f.d, 'control.json'); fs.writeFileSync(ctlFile, cli(f).stdout);
  fs.chmodSync(path.join(f.target, '.probe-sentinel'), 0o000); fs.chmodSync(f.wt, 0o500);
  try {
    const run = cli(f, ['--control', ctlFile]);
    const j = JSON.parse(run.stdout);
    assert.equal(j.control, 'accepted');
    // find/git/python read via child processes; all should be denied now. mdfind/qlmanage may vary.
    const hard = j.routes.filter((x) => !['mdfind', 'qlmanage'].includes(x.route));
    assert.ok(hard.every((x) => x.result === 'denied' || x.detail === 'tool missing' || x.detail.startsWith('not configured')), JSON.stringify(hard));
    if (!j.routes.some((x) => x.result === 'leaked' || x.result === 'error')) assert.equal(run.status, 0);
  } finally { fs.chmodSync(f.wt, 0o700); }
});

// ---- Phase 2 (P2.2) routes: FACTORY_HOME state writes and an outbound connect through Bash --------------------------------------
const HOME_ROUTES = ['write stop/', 'write runs/', 'write usage/', 'write verdicts/', 'write records/', 'write config.json'];
const stubHome = (f) => { const h = path.join(f.d, 'fhome'); fs.mkdirSync(h, { mode: 0o700 }); for (const s of ['stop', 'runs', 'usage', 'verdicts', 'records']) fs.mkdirSync(path.join(h, s), { mode: 0o700 }); fs.writeFileSync(path.join(h, 'config.json'), '{"keep":true}\n'); return h; };
const lockHome = (h, mode) => { for (const s of ['stop', 'runs', 'usage', 'verdicts', 'records']) fs.chmodSync(path.join(h, s), mode); fs.chmodSync(path.join(h, 'config.json'), mode === 0o500 ? 0o400 : 0o600); fs.chmodSync(h, mode); };

test('P2.2 routes are in ROUTES', () => {
  for (const r of [...HOME_ROUTES, 'net bash']) assert.ok(ROUTES.includes(r), r);
});

test('FACTORY_HOME routes: leaked when writable, denied against a read-only stub home; config.json content is never changed; always cleaned up', (t) => {
  const f = fixture(t);
  const h = stubHome(f);
  let r = byRoute(runProbe(opts(f, { factoryHome: h })));
  for (const route of HOME_ROUTES) assert.equal(r[route].result, 'leaked', `${route}: ${r[route].detail}`);
  for (const s of ['stop', 'runs', 'usage', 'verdicts', 'records']) assert.deepEqual(fs.readdirSync(path.join(h, s)), [], s);
  assert.equal(fs.readFileSync(path.join(h, 'config.json'), 'utf8'), '{"keep":true}\n');
  if (process.getuid && process.getuid() === 0) return;
  lockHome(h, 0o500);
  try { r = byRoute(runProbe(opts(f, { factoryHome: h }))); } finally { lockHome(h, 0o700); }
  for (const route of HOME_ROUTES) assert.equal(r[route].result, 'denied', `${route}: ${r[route].detail}`);
  assert.deepEqual(fs.readdirSync(h).sort(), ['config.json', 'records', 'runs', 'stop', 'usage', 'verdicts']);
});

test('FACTORY_HOME routes: a missing subdirectory or config.json is created (leaked) and removed again; read-only home denies', (t) => {
  const f = fixture(t);
  const h = path.join(f.d, 'bare-home'); fs.mkdirSync(h, { mode: 0o700 });
  let r = byRoute(runProbe(opts(f, { factoryHome: h })));
  for (const route of HOME_ROUTES) assert.equal(r[route].result, 'leaked', `${route}: ${r[route].detail}`);
  assert.deepEqual(fs.readdirSync(h), [], 'nothing left behind');
  if (process.getuid && process.getuid() === 0) return;
  fs.chmodSync(h, 0o500);
  try { r = byRoute(runProbe(opts(f, { factoryHome: h }))); } finally { fs.chmodSync(h, 0o700); }
  for (const route of HOME_ROUTES) assert.equal(r[route].result, 'denied', `${route}: ${r[route].detail}`);
});

test('not configured: FACTORY_HOME and net routes report error "not configured", never denied', (t) => {
  const f = fixture(t);
  const r = byRoute(runProbe(opts(f)));
  for (const route of [...HOME_ROUTES, 'net bash']) assert.deepEqual([r[route].result, r[route].detail.startsWith('not configured')], ['error', true], route);
});

test('net bash: a connect to a reserved documentation address (192.0.2.1) does not succeed -> denied; a listening local stub -> leaked', async (t) => {
  const f = fixture(t);
  const r = byRoute(runProbe(opts(f, { netHost: '192.0.2.1:9', netTimeoutMs: 1500 })));
  assert.equal(r['net bash'].result, 'denied', r['net bash'].detail);
  const net = await import('node:net');
  const srv = net.createServer(); await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => srv.close());
  // The kernel completes the handshake from the listen backlog while spawnSync blocks this process.
  const l = byRoute(runProbe(opts(f, { netHost: `127.0.0.1:${srv.address().port}`, netTimeoutMs: 3000 })));
  assert.equal(l['net bash'].result, 'leaked', l['net bash'].detail);
  const bad = byRoute(runProbe(opts(f, { netHost: '192.0.2.1:9', netTimeoutMs: 1500, bin: { bash: '/nonexistent/bash-xyz' } })));
  assert.deepEqual([bad['net bash'].result, bad['net bash'].detail], ['error', 'tool missing']);
});

test('CLI --net-host: malformed or local hosts are a usage error (exit 2)', (t) => {
  const f = fixture(t);
  for (const h of ['localhost:80', '127.0.0.1:80', '[::1]:80', '::1', 'example.com', 'a;b:80', '192.0.2.1:0', '192.0.2.1:99999', '$(x):80']) {
    assert.equal(cli(f, ['--net-host', h]).status, 2, h);
  }
});

test('--control: an unconfigured route in both runs is exempt; a control run that did not connect rejects net bash', (t) => {
  const f = fixture(t);
  const ctlFile = path.join(f.d, 'control.json');
  const ctl = cli(f); fs.writeFileSync(ctlFile, ctl.stdout);
  assert.equal(JSON.parse(cli(f, ['--control', ctlFile]).stdout).control, 'accepted');
  const h = stubHome(f);
  // control without --factory-home, this run with it: configuration differs -> rejected
  const diff = cli(f, ['--factory-home', h, '--control', ctlFile]);
  assert.equal(diff.status, 3); assert.match(diff.stderr, /factory-home differs/);
  // a control run whose connect timed out (the documentation address never answers) proves nothing for net bash
  const n = cli(f, ['--net-host', '192.0.2.1:9', '--net-timeout-ms', '1500']); fs.writeFileSync(ctlFile, n.stdout);
  const nn = cli(f, ['--net-host', '192.0.2.1:9', '--net-timeout-ms', '1500', '--control', ctlFile]);
  assert.equal(nn.status, 3); assert.match(nn.stderr, /did not leak via net bash/);
});

// ---- --save ---------------------------------------------------------------------------------------------------------------------
const saveEnv = (fh) => ({ PROBE_TOKEN: TOKEN, FACTORY_HOME: fh });
test('--save: writes $FACTORY_HOME/probes/last.json privately ({ ts, routes }); without an accepted control a denied route is saved as error', (t) => {
  const f = fixture(t);
  const fh = path.join(f.d, 'factory'); fs.mkdirSync(fh, { mode: 0o700 });
  const run = cli(f, ['--save', '--net-host', '192.0.2.1:9', '--net-timeout-ms', '1500'], saveEnv(fh));
  assert.equal(run.status, 1, run.stderr); // unsandboxed: leaks
  const dir = path.join(fh, 'probes'); const file = path.join(dir, 'last.json');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['routes', 'ts']);
  assert.ok(!Number.isNaN(Date.parse(saved.ts)));
  assert.deepEqual(Object.keys(saved.routes).sort(), [...ROUTES].sort());
  for (const v of Object.values(saved.routes)) assert.ok(['denied', 'leaked', 'error'].includes(v));
  assert.equal(saved.routes.cat, 'leaked');
  assert.equal(saved.routes['net bash'], 'error', 'a denied result without an accepted control run is not saved as proof');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN));
  assert.deepEqual(fs.readdirSync(dir), ['last.json'], 'atomic: no temp file left');
});

test('--save: an accepted control keeps denied results; --from re-saves an earlier --json result (rechecked against --control)', (t) => {
  if (process.getuid && process.getuid() === 0) return;
  const f = fixture(t);
  const fh = path.join(f.d, 'factory'); fs.mkdirSync(fh, { mode: 0o700 });
  const ctlFile = path.join(f.d, 'control.json'); fs.writeFileSync(ctlFile, cli(f).stdout);
  fs.chmodSync(path.join(f.target, '.probe-sentinel'), 0o000);
  const resFile = path.join(f.d, 'result.json');
  try { fs.writeFileSync(resFile, cli(f, ['--control', ctlFile]).stdout); } finally { fs.chmodSync(path.join(f.target, '.probe-sentinel'), 0o600); }
  const s = spawnSync('node', [SCRIPT, '--from', resFile, '--control', ctlFile, '--save'], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: fh }, timeout: 60000 });
  assert.ok([0, 1, 2].includes(s.status), s.stderr);
  const saved = JSON.parse(fs.readFileSync(path.join(fh, 'probes', 'last.json'), 'utf8'));
  assert.equal(saved.routes.cat, 'denied');
  assert.equal(saved.routes['net bash'], 'error', 'not configured');
  // without --control, --from saves no denied result as proof
  const s2 = spawnSync('node', [SCRIPT, '--from', resFile, '--save'], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: fh }, timeout: 60000 });
  assert.notEqual(s2.status, 3, s2.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fh, 'probes', 'last.json'), 'utf8')).routes.cat, 'error');
  // a malformed --from file is a usage error and saves nothing new
  fs.writeFileSync(resFile, '{"routes": 5}');
  const before = fs.readFileSync(path.join(fh, 'probes', 'last.json'), 'utf8');
  assert.equal(spawnSync('node', [SCRIPT, '--from', resFile, '--save'], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: fh } }).status, 2);
  assert.equal(fs.readFileSync(path.join(fh, 'probes', 'last.json'), 'utf8'), before);
});

test('--save: refuses a symlinked probes directory or result file (exit 2) and writes nothing through it', (t) => {
  const f = fixture(t);
  const fh = path.join(f.d, 'factory'); fs.mkdirSync(fh, { mode: 0o700 });
  const elsewhere = path.join(f.d, 'elsewhere'); fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(fh, 'probes'));
  const run = cli(f, ['--save'], saveEnv(fh));
  assert.equal(run.status, 2); assert.match(run.stderr, /symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.rmSync(path.join(fh, 'probes'));
  fs.mkdirSync(path.join(fh, 'probes'), { mode: 0o700 });
  fs.symlinkSync(path.join(elsewhere, 'x.json'), path.join(fh, 'probes', 'last.json'));
  const run2 = cli(f, ['--save'], saveEnv(fh));
  assert.equal(run2.status, 2); assert.match(run2.stderr, /symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
