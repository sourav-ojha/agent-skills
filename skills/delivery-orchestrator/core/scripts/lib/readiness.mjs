// Readiness checks C1-C8 (+ advisory A1), level computation and fix items. See docs/factory/specs/phase-0-foundations.md (P0.1).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseConfig, CONFIG_PATH } from './config.mjs';
import { CI_PATHS } from './queue.mjs';
import { allowEnv, runCmd, startApp, stopApp, portOf, hostOf, portInUse, waitReady, registerCleanup } from './proc.mjs';

export const CHECKS = [
  { id: 'C1', level: 1, runsCommands: false },
  { id: 'C2', level: 1, runsCommands: false },
  { id: 'C3', level: 2, runsCommands: true },
  { id: 'C4', level: 2, runsCommands: false },
  { id: 'C5', level: 3, runsCommands: false },
  { id: 'C6', level: 4, runsCommands: true },
  { id: 'C7', level: 4, runsCommands: true },
  { id: 'C8', level: 4, runsCommands: true },
  { id: 'A1', level: 0, runsCommands: false }, // advisory: never part of the level
];

export const SECRET_PATTERNS = [/^\.env$/, /^\.env\..+$/, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/, /\.p12$/];

// Highest L such that every check at levels 1..L passed. Missing, skip, fail and unstable all count as not passing.
export function computeLevel(results) {
  const status = new Map(results.map((r) => [r.id, r.status]));
  let level = 0;
  for (let l = 1; l <= 4; l++) {
    const need = CHECKS.filter((c) => c.level === l);
    if (need.every((c) => status.get(c.id) === 'pass')) level = l; else break;
  }
  return level;
}

const HELP = {
  C1: { change: `${CONFIG_PATH}`, help: `Create or fix ${CONFIG_PATH}, commit it and merge it to the base branch so the reviewed copy is the one in force.` },
  C2: { change: 'Node.js version and `gh auth login`', help: 'Install Node 20 or newer and log in with `gh auth login` as the account set in github.account.' },
  C3: { change: 'tests.setup / tests.all / tests.timeout_s', help: 'Make the setup and test commands succeed from a clean checkout of the base branch within the timeout, using only the environment from env_example.' },
  C4: { change: 'git-tracked files, .gitignore, app.logs_dir, app.env_example', help: 'Remove tracked secret files (keep only the env example file), add them to .gitignore, and make sure app.logs_dir is git-ignored.' },
  C5: { change: 'a CI workflow file and checks.required (or branch protection)', help: 'Commit a CI configuration on the base branch and list the required checks in checks.required or in branch protection.' },
  C6: { change: 'app.setup / app.start / app.stop / app.ready', help: 'Make the app start from a clean checkout with env_example only, become ready within app.ready.timeout_s, and leave nothing listening on its port after stop.' },
  C7: { change: 'app.logs_dir', help: 'Make the running app write log files under app.logs_dir.' },
  C8: { change: 'app.seed / app.env_example', help: 'Make app.seed exit 0 from a clean checkout, or declare no seed and let the app start with env_example alone.' },
  A1: { change: 'GitHub branch protection or rulesets for the base branch', help: 'Advisory: enable branch protection or a ruleset on the base branch that lists required status checks. Not available on every plan.' },
};
export function fixItem(id, result) {
  const h = HELP[id] || { change: 'unknown', help: 'No help text for this check.' };
  return { id, what: result?.reason ?? '', change: h.change, help: h.help };
}

// ---- git / gh helpers -------------------------------------------------------------------------------------------------
const exec = (bin, args, cwd, env) => {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: env ?? process.env });
  return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

// A detached worktree of `sha` in a private temp dir. remove() is idempotent; callers must call it in finally.
export function gitWorktree(root, sha) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wt-'));
  const dir = path.join(tmp, 'wt');
  const r = exec('git', ['worktree', 'add', '--detach', dir, sha], root);
  if (r.code !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`git worktree add failed: ${r.err}`); }
  // Registered with proc's cleanup set so SIGINT/SIGTERM/exit remove the worktree too (the callback is synchronous).
  let unregister = () => {};
  const remove = () => {
    unregister();
    exec('git', ['worktree', 'remove', '--force', dir], root);
    exec('git', ['worktree', 'prune'], root);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  unregister = registerCleanup(remove);
  return { dir, remove };
}

export function makeCtx({ root, config, base, git, gh, repo, worktree, accountError } = {}) {
  const g = git ?? ((...a) => exec('git', a, root));
  let ghEnv;
  const h = gh ?? ((...a) => {
    if (ghEnv === undefined) {
      const acct = config?.github?.account;
      const t = acct ? exec('gh', ['auth', 'token', '--user', acct], root) : { code: 1 };
      ghEnv = t.code === 0 && t.out ? { ...process.env, GH_TOKEN: t.out } : process.env;
    }
    return exec('gh', a, root, ghEnv);
  });
  return { root, config, base: base ?? config?.base, git: g, gh: h, repo, worktree: worktree ?? ((sha) => gitWorktree(root, sha)), accountError };
}

const res = (status, reason = '') => ({ status, reason });
const fileText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const baseRef = (ctx) => `refs/remotes/origin/${ctx.base}`; // fully qualified: a local ref named origin/<base> cannot shadow it
const baseSha = (ctx) => { const r = ctx.git('rev-parse', '--verify', `${baseRef(ctx)}^{commit}`); return r.code === 0 ? r.out : null; };
const repoName = (ctx) => {
  if (ctx.repo) return ctx.repo;
  const r = ctx.gh('repo', 'view', '--json', 'nameWithOwner');
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out).nameWithOwner; } catch { return r.out || null; }
};

// ---- non-command checks -----------------------------------------------------------------------------------------------
function c1(ctx) {
  const raw = fileText(path.join(ctx.root, CONFIG_PATH));
  if (raw === null) return res('fail', `${CONFIG_PATH} is missing`);
  let json;
  try { json = JSON.parse(raw); } catch (e) { return res('fail', `${CONFIG_PATH} is not valid JSON: ${e.message}`); }
  const { errors } = parseConfig(json);
  if (errors.length) return res('fail', `${CONFIG_PATH}: ${errors.join('; ')}`);
  const onBase = ctx.git('show', `${baseRef(ctx)}:${CONFIG_PATH}`);
  if (onBase.code !== 0) return res('fail', `${CONFIG_PATH} is not on ${baseRef(ctx)}`);
  let theirs;
  try { theirs = JSON.parse(onBase.out); } catch { return res('fail', `${CONFIG_PATH} on ${baseRef(ctx)} is not valid JSON`); }
  if (JSON.stringify(theirs) !== JSON.stringify(json)) return res('fail', `${CONFIG_PATH} differs from the copy on ${baseRef(ctx)}`);
  return res('pass', 'config valid and equal to the base branch copy');
}

function c2(ctx) {
  if (ctx.accountError) return res('fail', ctx.accountError);
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) return res('fail', `Node ${process.versions.node}: need 20 or newer`);
  const r = ctx.gh('api', 'user', '--jq', '.login');
  if (r.code !== 0) return res('fail', 'gh is not logged in');
  const want = ctx.config?.github?.account;
  if (want && r.out.toLowerCase() !== want.toLowerCase()) return res('fail', `gh is logged in as a different account than github.account (${want})`);
  return res('pass', 'node and gh ok');
}

// Evaluated on the base tip (same sha as the other checks), never on the working checkout.
async function c4(ctx) {
  const sha = baseSha(ctx);
  if (!sha) return res('fail', `cannot resolve ${baseRef(ctx)}`);
  const ls = ctx.git('ls-tree', '-r', '--name-only', sha);
  if (ls.code !== 0) return res('fail', `cannot list files on ${baseRef(ctx)}`);
  const example = ctx.config?.app?.env_example ? path.posix.normalize(ctx.config.app.env_example) : null;
  const bad = ls.out.split('\n').filter(Boolean).filter((f) => f !== example && SECRET_PATTERNS.some((re) => re.test(path.posix.basename(f))));
  if (bad.length) return res('fail', `secret-like files tracked on ${baseRef(ctx)}: ${bad.slice(0, 10).join(', ')}`);
  const logs = ctx.config?.app?.logs_dir;
  if (logs) {
    const probe = path.posix.join(logs.replace(/\\/g, '/'), '.readiness-probe');
    const wt = await ctx.worktree(sha); // the base's own .gitignore applies there
    try {
      if (exec('git', ['check-ignore', '-q', '--', probe], wt.dir).code !== 0) return res('fail', `logs_dir ${logs} is not git-ignored on ${baseRef(ctx)}`);
    } finally { wt.remove(); }
  }
  return res('pass', `no tracked secrets on ${baseRef(ctx)}`);
}

// Required status check names from branch protection / rulesets JSON (either shape).
function requiredFrom(protection, rules) {
  const names = [];
  const rs = protection?.required_status_checks;
  if (rs) { for (const c of rs.contexts || []) names.push(c); for (const c of rs.checks || []) names.push(c.context); }
  if (Array.isArray(rules)) for (const r of rules) if (r?.type === 'required_status_checks') for (const c of r.parameters?.required_status_checks || []) names.push(c.context);
  return names.filter(Boolean);
}
const notFound = (r) => r.code !== 0 && /HTTP 404|Not Found/i.test(`${r.err} ${r.out}`);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function protection(ctx) {
  const repo = repoName(ctx);
  if (!repo) return { state: 'unknown', reason: 'could not determine the repository', names: [] };
  const a = ctx.gh('api', `repos/${repo}/branches/${ctx.base}/protection`);
  const b = ctx.gh('api', `repos/${repo}/rules/branches/${ctx.base}`);
  if (notFound(a) && notFound(b)) return { state: 'none', reason: `no branch protection or rulesets on ${ctx.base}`, names: [] };
  const okA = a.code === 0, okB = b.code === 0;
  if (!okA && !okB) return { state: 'unknown', reason: 'could not read branch protection (plan or token)', names: [] };
  return { state: 'found', names: requiredFrom(okA ? parse(a.out) : null, okB ? parse(b.out) : null) };
}

function c5(ctx) {
  const ls = ctx.git('ls-tree', '-r', '--name-only', baseRef(ctx));
  if (ls.code !== 0) return res('fail', `cannot list files on ${baseRef(ctx)}`);
  const isCodeowners = (f) => /(^|\/)CODEOWNERS$/i.test(f); // CODEOWNERS is in CI_PATHS but is not a CI configuration
  const files = ls.out.split('\n').filter((f) => !isCodeowners(f) && CI_PATHS.some((re) => re.test(f)));
  if (!files.length) return res('fail', `no CI configuration on ${baseRef(ctx)} (CODEOWNERS does not count)`);
  if (ctx.config?.checks?.required?.length) return res('pass', `CI config (${files[0]}) and checks.required set`);
  const p = protection(ctx);
  if (p.state === 'found' && p.names.length) return res('pass', `CI config and required checks in branch protection: ${p.names.join(', ')}`);
  return res('fail', 'CI config exists but no required checks: set checks.required or require checks in branch protection');
}

function a1(ctx) {
  const p = protection(ctx);
  if (p.state === 'none') return res('fail', p.reason);
  if (p.state === 'unknown') return res('unknown', p.reason);
  return p.names.length ? res('pass', `required checks: ${p.names.join(', ')}`) : res('fail', 'protection exists but lists no required checks');
}

// ---- command checks ---------------------------------------------------------------------------------------------------
const cmdFail = (what, r) => `${what} ${r.timedOut ? 'timed out' : `exited ${r.code}`}${r.tail ? `\n${r.tail}` : ''}`;
const envFor = (dir, config) => allowEnv(config?.app?.env_example ? fileText(path.join(dir, config.app.env_example)) : null);

async function c3Attempt(ctx, sha) {
  const t = ctx.config.tests;
  const wt = await ctx.worktree(sha);
  try {
    const env = envFor(wt.dir, ctx.config);
    const t0 = Date.now();
    if (t.setup) { const r = await runCmd(t.setup, { cwd: wt.dir, env, timeoutS: t.timeout_s }); if (r.code !== 0 || r.timedOut) return res('fail', cmdFail('tests.setup', r)); }
    const r = await runCmd(t.all, { cwd: wt.dir, env, timeoutS: t.timeout_s });
    if (r.code !== 0 || r.timedOut) return res('fail', cmdFail('tests.all', r));
    return res('pass', `tests passed in ${Math.round((Date.now() - t0) / 1000)}s`);
  } finally { wt.remove(); }
}

const snapshot = (dir) => {
  const m = new Map();
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else try { m.set(p, fs.statSync(p).size); } catch { /* gone */ } } };
  walk(dir);
  return m;
};

// One attempt at C6/C7/C8 in a fresh worktree. `final` marks failures a retry cannot be trusted to change (port conflicts, leaks).
async function appAttempt(ctx, sha) {
  const { app } = ctx.config;
  const out = {};
  const port = app.ready?.url ? portOf(app.ready.url) : app.base_url ? portOf(app.base_url) : null;
  const host = app.ready?.url ? hostOf(app.ready.url) : app.base_url ? hostOf(app.base_url) : 'localhost';
  if (port !== null && await portInUse(port, host)) {
    const r = { ...res('fail', `port in use: ${port} is already listening before start`), final: true };
    return { C6: r, C7: app.logs_dir ? { ...r, reason: 'not run: port in use' } : res('skip', 'app.logs_dir is not configured'), C8: app.seed ? { ...r, reason: 'not run: port in use' } : r };
  }
  const wt = await ctx.worktree(sha);
  let running = null, env;
  try {
    env = envFor(wt.dir, ctx.config);
    if (app.setup) {
      const r = await runCmd(app.setup, { cwd: wt.dir, env, timeoutS: 900 });
      if (r.code !== 0 || r.timedOut) { const f = res('fail', cmdFail('app.setup', r)); return { C6: f, C7: { ...f, reason: 'not run: app.setup failed' }, C8: { ...f, reason: 'not run: app.setup failed' } }; }
    }
    if (app.seed) {
      const r = await runCmd(app.seed, { cwd: wt.dir, env, timeoutS: 600 });
      out.C8 = r.code === 0 && !r.timedOut ? res('pass', 'app.seed exited 0') : res('fail', cmdFail('app.seed', r));
    }
    const logsDir = app.logs_dir ? path.join(wt.dir, app.logs_dir) : null;
    const before = logsDir ? snapshot(logsDir) : null;
    running = startApp(app.start, { cwd: wt.dir, env });
    const ready = await waitReady(app.ready, running);
    let grew = false;
    if (logsDir) for (const [f, n] of snapshot(logsDir)) if (!before.has(f) || n > before.get(f)) grew = true;
    const tail = running.output().split('\n').slice(-40).join('\n');
    await stopApp(running, { stopArgv: app.stop, cwd: wt.dir, env });
    running = null;
    if (!ready) out.C6 = res('fail', `app did not become ready within ${app.ready.timeout_s}s${tail ? `\n${tail}` : ''}`);
    else if (port !== null && await portInUse(port, host)) out.C6 = { ...res('fail', `a process is still listening on port ${port} after stop`), final: true };
    else out.C6 = res('pass', 'app became ready and stopped cleanly');
    out.C7 = res('skip', 'app.logs_dir is not configured');
    if (logsDir) out.C7 = grew ? res('pass', `log files written under ${app.logs_dir}`) : res('fail', `no file under ${app.logs_dir} was created or grew while the app ran`);
    if (!out.C8) out.C8 = out.C6.status === 'pass' ? res('pass', 'no seed declared; app ready with env_example alone') : res('fail', 'no seed declared and the app did not start with env_example alone');
    return out;
  } finally {
    if (running) await stopApp(running, { stopArgv: app.stop, cwd: wt.dir, env }).catch(() => {});
    wt.remove();
  }
}

// Fail then pass is unstable; fail twice is fail. `final` failures are not retried.
function merge(first, second) {
  if (first.status !== 'fail' || first.final) return first;
  if (!second) return first;
  if (second.status === 'pass') return res('unstable', `failed once then passed: ${first.reason}`);
  return second;
}

export async function runChecks(ctx, { only } = {}) {
  const want = (id) => !only || only.includes(id);
  const results = [];
  const timed = async (id, fn) => { const t0 = Date.now(); let r; try { r = await fn(); } catch (e) { r = res('fail', `check crashed: ${e.message}`); } const { final, ...rest } = r; results.push({ id, ...rest, ms: Date.now() - t0 }); };
  const sync = { C1: c1, C2: c2, C4: c4, C5: c5, A1: a1 };
  for (const id of ['C1', 'C2']) if (want(id)) await timed(id, () => sync[id](ctx));
  const sha = ['C3', 'C6', 'C7', 'C8'].some(want) ? baseSha(ctx) : null;
  const noBase = () => res('fail', `cannot resolve ${baseRef(ctx)}`);
  if (want('C3')) {
    await timed('C3', async () => {
      if (!ctx.config?.tests?.all) return res('skip', 'tests.all is not configured');
      if (!sha) return noBase();
      const first = await c3Attempt(ctx, sha);
      return first.status === 'fail' ? merge(first, await c3Attempt(ctx, sha)) : first;
    });
  }
  for (const id of ['C4', 'C5']) if (want(id)) await timed(id, () => sync[id](ctx));
  if (['C6', 'C7', 'C8'].some(want)) {
    const app = ctx.config?.app || {};
    const t0 = Date.now();
    let r = {};
    if (app.start && app.ready) {
      if (!sha) r = { C6: noBase(), C7: noBase(), C8: noBase() };
      else {
        try {
          const a = await appAttempt(ctx, sha);
          const bad = Object.values(a).some((x) => x.status === 'fail' && !x.final);
          const b = bad ? await appAttempt(ctx, sha) : null;
          for (const id of ['C6', 'C7', 'C8']) r[id] = merge(a[id], b?.[id]);
        } catch (e) { r = Object.fromEntries(['C6', 'C7', 'C8'].map((id) => [id, res('fail', `check crashed: ${e.message}`)])); }
      }
    } else {
      r.C6 = res('skip', 'app.start and app.ready are not both configured');
      r.C7 = res('skip', 'app.start and app.ready are not both configured');
    }
    if (!r.C7) r.C7 = res('skip', 'app.logs_dir is not configured');
    if (!r.C8) r.C8 = res('skip', 'no seed declared and no app to start');
    const ms = Date.now() - t0;
    for (const id of ['C6', 'C7', 'C8']) if (want(id)) { const { final, ...rest } = r[id]; results.push({ id, ...rest, ms }); }
  }
  if (want('A1')) await timed('A1', () => a1(ctx));
  return results;
}
