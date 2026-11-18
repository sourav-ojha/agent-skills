// factory proc: allowlisted env, argv-only commands, process-group start/stop, readiness polling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const p = await import(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', 'proc.mjs'));
const FX = path.join(REPO, 'tests', 'fixtures', 'factory-apps');
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-proc-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
const launch = async (t, name, extra = {}, cwd = tmp(t)) => {
  const port = await freePort();
  const env = { ...p.allowEnv(null), PORT: String(port), ...extra };
  const app = p.startApp(['node', path.join(FX, name + '.mjs')], { cwd, env });
  t.after(async () => { await p.stopApp(app, { cwd, env, graceMs: 200 }); });
  return { app, port, cwd, env };
};

test('allowEnv: drops secrets, keeps allowlist, parses env_example', () => {
  const e = p.allowEnv(null, { ...process.env, GH_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y' });
  assert.equal(e.GH_TOKEN, undefined); assert.equal(e.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(e.PATH, process.env.PATH); assert.equal(e.NODE_ENV, 'test'); assert.equal(e.CI, '1');
  const f = p.allowEnv('# c\n\nFOO=bar\nURL=http://x/?a=b\n', { PATH: '/bin' });
  assert.equal(f.FOO, 'bar'); assert.equal(f.URL, 'http://x/?a=b'); assert.equal(f.PATH, '/bin');
  assert.deepEqual(Object.keys(f).sort(), ['CI', 'FOO', 'NODE_ENV', 'PATH', 'URL']);
});

test('runCmd: child does not see non-allowlisted env', async () => {
  const r = await p.runCmd(['node', '-e', 'console.log(process.env.GH_TOKEN||"none")'], { env: p.allowEnv(null, { ...process.env, GH_TOKEN: 'x' }), timeoutS: 20 });
  assert.equal(r.code, 0); assert.equal(r.tail.trim(), 'none');
});

test('runCmd: no shell interpretation of arguments', async (t) => {
  const cwd = tmp(t);
  const r = await p.runCmd(['echo', '$(touch pwned)'], { cwd, timeoutS: 10 });
  assert.equal(r.code, 0); assert.match(r.tail, /\$\(touch pwned\)/);
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
});

test('runCmd: timeout, spawn failure, tail limited to 40 lines', async () => {
  const r = await p.runCmd(['node', '-e', 'setTimeout(()=>{},30000)'], { timeoutS: 1 });
  assert.equal(r.timedOut, true); assert.ok(r.ms >= 900 && r.ms < 8000);
  const bad = await p.runCmd(['definitely-not-a-binary-xyz'], { timeoutS: 5 });
  assert.notEqual(bad.code, 0); assert.equal(bad.timedOut, false);
  const many = await p.runCmd(['node', '-e', 'for(let i=0;i<100;i++)console.log("line"+i)'], { timeoutS: 10 });
  const lines = many.tail.split('\n').filter(Boolean);
  assert.equal(lines.length, 40); assert.equal(lines.at(-1), 'line99');
});

test('redact: tokens, emails and secret assignments are removed, newlines kept', () => {
  const tok = 'ghp_' + 'a'.repeat(36);
  assert.ok(!p.redact('token ' + tok).includes(tok));
  assert.ok(!p.redact('mail me@example.com').includes('me@example.com'));
  assert.ok(!p.redact('password=hunter2').includes('hunter2'));
  assert.equal(p.redact('a\nb').split('\n').length, 2);
});

test('portOf / portInUse', async () => {
  assert.equal(p.portOf('http://localhost:3123/health'), 3123);
  assert.equal(p.portOf('http://localhost/x'), 80); assert.equal(p.portOf('https://localhost/x'), 443);
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  assert.equal(await p.portInUse(port), true);
  await new Promise((r) => s.close(r));
  assert.equal(await p.portInUse(port), false);
});

test('startApp + waitReady(url) true, stopApp frees the port', async (t) => {
  const { app, port } = await launch(t, 'ready');
  assert.ok(app.pid > 0); assert.equal(app.pgid, app.pid);
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${port}/health`, timeout_s: 15 }, app), true);
  await p.stopApp(app, { graceMs: 2000 });
  assert.equal(await p.portInUse(port), false);
});

test('waitReady(log_pattern) uses app output', async (t) => {
  const { app } = await launch(t, 'ready');
  assert.equal(await p.waitReady({ log_pattern: 'listening on \\d+', timeout_s: 15 }, app), true);
  assert.match(app.output(), /listening on/);
});

test('waitReady false when never healthy or pattern never appears', async (t) => {
  const a = await launch(t, 'never');
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${a.port}/health`, timeout_s: 2 }, a.app), false);
  const b = await launch(t, 'nolog');
  assert.equal(await p.waitReady({ log_pattern: 'never-printed', timeout_s: 2 }, b.app), false);
});

test('flaky fixture: ready on odd starts only', async (t) => {
  const cwd = tmp(t); const counter = path.join(cwd, 'count');
  const a = await launch(t, 'flaky', { COUNTER_FILE: counter }, cwd);
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${a.port}/`, timeout_s: 10 }, a.app), true);
  await p.stopApp(a.app, { graceMs: 2000 });
  const b = await launch(t, 'flaky', { COUNTER_FILE: counter }, cwd);
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${b.port}/`, timeout_s: 2 }, b.app), false);
});

test('stopApp: stop command is run when given', async (t) => {
  const { app, port, cwd, env } = await launch(t, 'ready');
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${port}/health`, timeout_s: 15 }, app), true);
  const marker = path.join(cwd, 'stopped');
  await p.stopApp(app, { stopArgv: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'1')`], cwd, env, graceMs: 2000 });
  assert.ok(fs.existsSync(marker));
  assert.equal(await p.portInUse(port), false);
});

test('stopApp kills a SIGTERM-ignoring app within 11s', async (t) => {
  const { app, port } = await launch(t, 'stubborn');
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${port}/`, timeout_s: 15 }, app), true);
  const t0 = Date.now();
  await p.stopApp(app, {});
  assert.ok(Date.now() - t0 < 11000, 'took ' + (Date.now() - t0));
  assert.equal(await p.portInUse(port), false);
});

test('detached fixture: grandchild keeps the port after the parent exits', async (t) => {
  const cwd = tmp(t); const pidFile = path.join(cwd, 'child.pid');
  const { port } = await launch(t, 'detached', { CHILD_PID_FILE: pidFile }, cwd);
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} });
  const until = Date.now() + 10000;
  while (Date.now() < until && !(await p.portInUse(port))) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await p.portInUse(port), true);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('waitReady: 302 is not ready, only 2xx', async (t) => {
  const { app, port } = await launch(t, 'ready');
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${port}/health`, timeout_s: 15 }, app), true);
  assert.equal(await p.waitReady({ url: `http://127.0.0.1:${port}/redirect`, timeout_s: 2 }, app), false);
});

test('stopApp kills a same-group grandchild', async (t) => {
  const cwd = tmp(t); const pidFile = path.join(cwd, 'gc.pid');
  const { app, port } = await launch(t, 'family', { CHILD_PID_FILE: pidFile }, cwd);
  assert.equal(await waitFor(() => p.portInUse(port)), true);
  const gc = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(gc, 'SIGKILL'); } catch {} });
  assert.ok(alive(gc));
  await p.stopApp(app, { graceMs: 3000 });
  assert.equal(await waitFor(() => !alive(gc), 3000), true);
  assert.equal(await p.portInUse(port), false);
});

test('runCmd timeout kills a same-group grandchild', async (t) => {
  const cwd = tmp(t); const pidFile = path.join(cwd, 'gc.pid'); const port = await freePort();
  const r = await p.runCmd(['node', path.join(FX, 'family.mjs')], { cwd, env: { ...p.allowEnv(null), PORT: String(port), CHILD_PID_FILE: pidFile }, timeoutS: 2 });
  assert.equal(r.timedOut, true);
  const gc = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => { try { process.kill(gc, 'SIGKILL'); } catch {} });
  assert.equal(await waitFor(() => !alive(gc), 3000), true);
  assert.equal(await p.portInUse(port), false);
});

test('app is killed when the orchestrator receives SIGTERM', async (t) => {
  const { spawn } = await import('node:child_process');
  const port = await freePort();
  const orch = spawn(process.execPath, [path.join(FX, 'orchestrator.mjs')], { env: { ...p.allowEnv(null), PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { orch.kill('SIGKILL'); });
  await new Promise((res) => orch.stdout.on('data', (d) => /started/.test(String(d)) && res()));
  assert.equal(await waitFor(() => p.portInUse(port)), true);
  const exited = new Promise((res) => orch.on('exit', (code, sig) => res({ code, sig })));
  orch.kill('SIGTERM');
  const ex = await exited;
  assert.equal(ex.code, 143);
  assert.equal(await waitFor(async () => !(await p.portInUse(port)), 5000), true);
});
