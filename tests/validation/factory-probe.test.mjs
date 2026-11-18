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
  assert.ok(j.routes.filter((x) => x.route !== 'write' && !['mdfind', 'qlmanage', 'python -c'].includes(x.route)).every((x) => x.result === 'denied'));
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
    assert.ok(hard.every((x) => x.result === 'denied' || x.detail === 'tool missing'), JSON.stringify(hard));
    if (!j.routes.some((x) => x.result === 'leaked' || x.result === 'error')) assert.equal(run.status, 0);
  } finally { fs.chmodSync(f.wt, 0o700); }
});
