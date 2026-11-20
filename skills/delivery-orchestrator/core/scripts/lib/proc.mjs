// Process runner: argv-only commands (never a shell), allowlisted environment, process-group start/stop, readiness polling.
import { spawn } from 'node:child_process';
import net from 'node:net';

const ALLOWED = ['PATH', 'HOME', 'LANG', 'TMPDIR'];
const TAIL_LINES = 40;
const MAX_BUF = 256 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Patterns copied from skill-insights redactText (no cross-skill import). Line structure is kept so a log tail stays readable.
export function redact(text) {
  return String(text)
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[\w.@~+-]+[\\/])+[\w.@~+-]*/g, '<path>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth)\s*[=:]\s*\S+/gi, '<secret>')
    .replace(/\b(?:AKIA|ASIA|AIza|ghp_|gho_|ghs_|xox[baprs]-|sk-)[\w-]{8,}/g, '<token>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>');
}

// Only PATH/HOME/LANG/TMPDIR from base, NODE_ENV=test, CI=1, plus KEY=VALUE lines of an env example file.
export function allowEnv(envExampleText, base = process.env) {
  const env = {};
  for (const k of ALLOWED) if (base[k] !== undefined) env[k] = String(base[k]);
  for (const raw of String(envExampleText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  // Pinned keys win over anything the env example declares.
  for (const k of ALLOWED) if (base[k] !== undefined) env[k] = String(base[k]);
  env.NODE_ENV = 'test';
  env.CI = '1';
  return env;
}

const lastLines = (s) => redact(s.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1).slice(-TAIL_LINES).join('\n'));
const append = (buf, chunk) => { buf += chunk; return buf.length > MAX_BUF ? buf.slice(-MAX_BUF) : buf; };
const killGroup = (pgid, sig) => { try { process.kill(-pgid, sig); return true; } catch { return false; } };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Live process groups. Anything still registered is SIGKILLed when this process exits or is signalled.
const live = new Set();
// Cleanup callbacks (e.g. temp worktree removal) run on exit or signal too. Each must be synchronous and idempotent.
const cleanups = new Set();
let hooked = false;
const killAll = () => {
  for (const g of live) killGroup(g, 'SIGKILL');
  live.clear();
  for (const fn of [...cleanups]) { cleanups.delete(fn); try { fn(); } catch { /* best effort */ } }
};
export function registerCleanup(fn) { cleanups.add(fn); hookOnce(); return () => cleanups.delete(fn); }
export const pendingCleanups = () => cleanups.size;
export const runCleanups = killAll;
function track(pgid) {
  live.add(pgid);
  hookOnce();
}
function hookOnce() {
  if (hooked) return;
  hooked = true;
  process.on('exit', killAll);
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => { killAll(); process.exit(128 + n); });
}
const untrackIfDead = (pgid) => { if (!groupAlive(pgid)) live.delete(pgid); };

export function runCmd(argv, { cwd, env, timeoutS = 900 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', timedOut = false, done = false, timer;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, timedOut, ms: Date.now() - t0, tail: lastLines(out) }); };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: env ?? allowEnv(null), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { out = String(e.message); return finish(null); }
    child.stdout.on('data', (d) => { out = append(out, d); });
    child.stderr.on('data', (d) => { out = append(out, d); });
    child.on('error', (e) => { out = append(out, String(e.message)); finish(null); });
    // Resolve on 'exit', not 'close': a background child holding the pipes must not keep us waiting for the timeout.
    child.on('exit', (code) => {
      killGroup(child.pid, 'SIGKILL'); // sweep anything the command left behind in its process group
      untrackIfDead(child.pid);
      let settled = false;
      const end = () => { if (settled) return; settled = true; child.stdout.destroy(); child.stderr.destroy(); finish(code); };
      child.once('close', end); // pipes close quickly once the group is dead; keep what they still hold
      setTimeout(end, 500).unref();
    });
    if (child.pid) track(child.pid);
    timer = setTimeout(() => { timedOut = true; killGroup(child.pid, 'SIGKILL'); }, timeoutS * 1000);
  });
}

export function startApp(argv, { cwd, env } = {}) {
  let out = '';
  const child = spawn(argv[0], argv.slice(1), { cwd, env: env ?? allowEnv(null), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out = append(out, d); });
  child.stderr.on('data', (d) => { out = append(out, d); });
  child.on('error', (e) => { out = append(out, String(e.message)); });
  if (child.pid) track(child.pid);
  return { pid: child.pid, pgid: child.pid, output: () => redact(out) };
}

export async function stopApp(app, { stopArgv, cwd, env, graceMs = 10000 } = {}) {
  if (stopArgv && stopArgv.length) await runCmd(stopArgv, { cwd, env, timeoutS: Math.max(1, Math.ceil(graceMs / 1000)) });
  if (!app?.pgid) return;
  if (!groupAlive(app.pgid)) { live.delete(app.pgid); return; }
  killGroup(app.pgid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && groupAlive(app.pgid)) await sleep(100);
  if (groupAlive(app.pgid)) {
    killGroup(app.pgid, 'SIGKILL');
    const end = Date.now() + 2000;
    while (Date.now() < end && groupAlive(app.pgid)) await sleep(50);
  }
  untrackIfDead(app.pgid);
}

export function portOf(url) {
  const u = new URL(url);
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
}

// Fail closed: only a refused connection, or a loopback address this host does not have (no IPv6: EADDRNOTAVAIL / EAFNOSUPPORT, and
// for ::1 only ENETUNREACH / EHOSTUNREACH), means free. A timeout or any other error counts as in use (e.g. a listener that never
// accepts). The timeout is deferred with setImmediate: after an event-loop stall the timer phase runs before the poll phase, so an
// ECONNREFUSED already queued must win over the timeout (the first settle wins).
const FREE_CODES = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT']);
const V6_FREE_CODES = new Set(['ENETUNREACH', 'EHOSTUNREACH']);
export const freeError = (code, host) => FREE_CODES.has(code) || (host === '::1' && V6_FREE_CODES.has(code));
const probe = (port, host) => new Promise((resolve) => {
  let settled = false;
  const s = net.connect({ port, host });
  const end = (v) => { if (settled) return; settled = true; s.destroy(); resolve(v); };
  s.setTimeout(1000, () => setImmediate(() => end(true)));
  s.on('connect', () => end(true));
  s.on('error', (e) => end(!freeError(e.code, host)));
});

// `localhost` (the default) is checked on both loopbacks: dev servers may bind only ::1 (Vite on macOS).
export async function portInUse(port, host = 'localhost') {
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host.replace(/^\[|\]$/g, '')];
  return (await Promise.all(hosts.map((h) => probe(port, h)))).some(Boolean);
}

export const hostOf = (url) => new URL(url).hostname;

export async function waitReady(ready, app) {
  const deadline = Date.now() + (ready?.timeout_s ?? 60) * 1000;
  const re = ready?.log_pattern ? new RegExp(ready.log_pattern) : null;
  while (Date.now() < deadline) {
    if (re && re.test(app.output())) return true;
    if (ready?.url) {
      try {
        const res = await fetch(ready.url, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
        if (res.status >= 200 && res.status < 300) return true;
      } catch { /* not up yet */ }
    }
    if (!re && !ready?.url) return false;
    await sleep(500);
  }
  return false;
}
