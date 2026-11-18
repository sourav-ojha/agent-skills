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
  env.NODE_ENV = 'test';
  env.CI = '1';
  for (const raw of String(envExampleText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const lastLines = (s) => redact(s.split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1).slice(-TAIL_LINES).join('\n'));
const append = (buf, chunk) => { buf += chunk; return buf.length > MAX_BUF ? buf.slice(-MAX_BUF) : buf; };
const killGroup = (pgid, sig) => { try { process.kill(-pgid, sig); return true; } catch { return false; } };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

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
    child.on('close', (code) => finish(code));
    timer = setTimeout(() => { timedOut = true; killGroup(child.pid, 'SIGKILL'); }, timeoutS * 1000);
  });
}

export function startApp(argv, { cwd, env } = {}) {
  let out = '';
  const child = spawn(argv[0], argv.slice(1), { cwd, env: env ?? allowEnv(null), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { out = append(out, d); });
  child.stderr.on('data', (d) => { out = append(out, d); });
  child.on('error', (e) => { out = append(out, String(e.message)); });
  return { pid: child.pid, pgid: child.pid, output: () => redact(out) };
}

export async function stopApp(app, { stopArgv, cwd, env, graceMs = 10000 } = {}) {
  if (stopArgv && stopArgv.length) await runCmd(stopArgv, { cwd, env, timeoutS: Math.max(1, Math.ceil(graceMs / 1000)) });
  if (!app?.pgid || !groupAlive(app.pgid)) return;
  killGroup(app.pgid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (Date.now() < until && groupAlive(app.pgid)) await sleep(100);
  if (groupAlive(app.pgid)) {
    killGroup(app.pgid, 'SIGKILL');
    const end = Date.now() + 2000;
    while (Date.now() < end && groupAlive(app.pgid)) await sleep(50);
  }
}

export function portOf(url) {
  const u = new URL(url);
  return u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
}

export function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const end = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1000, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

export async function waitReady(ready, app) {
  const deadline = Date.now() + (ready?.timeout_s ?? 60) * 1000;
  const re = ready?.log_pattern ? new RegExp(ready.log_pattern) : null;
  while (Date.now() < deadline) {
    if (re && re.test(app.output())) return true;
    if (ready?.url) {
      try {
        const res = await fetch(ready.url, { signal: AbortSignal.timeout(2000) });
        if (res.status >= 200 && res.status < 400) return true;
      } catch { /* not up yet */ }
    }
    if (!re && !ready?.url) return false;
    await sleep(500);
  }
  return false;
}
