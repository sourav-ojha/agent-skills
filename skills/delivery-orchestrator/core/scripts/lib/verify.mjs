// Verification step (Phase 1a): runs a feature's hidden API scenarios against its app, built from the exact PR head sha, inside the
// untrusted-code sandbox; writes the verdict; turns failures into the builder-facing symptom brief; posts `factory/verified`.
// Zero dependencies.
//
// Trust rules (see docs/factory/specs/phase-1-verification-gate.md, P1.2):
// - Every command comes from the BASE config passed in (`config`), never from the feature branch; the env example is read from
//   `baseRef` in the factory clone (git cat-file), not from the worktree. The app gets HOST=127.0.0.1 and PORT=<base_url port>.
// - Nothing from the feature branch runs outside the sandbox: no sandbox, no verification. app.setup gets registry network;
//   app.seed, app.start and app.stop get only the app's port on localhost (spec: run phase). Stopping is a process-group kill.
// - After EVERY sandboxed phase (setup, seed, app stop; whatever its exit code, timeout or throw) nothing may listen on the app port
//   on 127.0.0.1 or ::1 and no process carrying the worktree / run-temp marker (argv, environment or cwd) may survive. Otherwise the
//   run is treated as ESCAPED: verification throws, and the worktree and run temp are left in place with no git call on them.
// - Git: only `worktree add` and `worktree prune`, run from the factory clone. Removal first rename(2)s the worktree into
//   FACTORY_HOME/trash/<random> (if that fails it stays in place), then prunes, then deletes the quarantined tree.
// - Bounded: at most MAX_SCENARIOS scenarios, and an overall wall-clock budget (budgetS) checked before every phase.
// - Each scenario runs twice from a fresh seed and app start; it passes only if both runs pass. Disagreement is `fail` + flaky.
// - The symptom brief carries criterion IDs and one fixed sentence only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as sbx from './sandbox.mjs';
import * as proc from './proc.mjs';
import { runApiScenario } from './apicheck.mjs';
import { readVerdict, writeVerdict, verdictMatches, validVerdict, verdictPath } from './verdict.mjs';
import { checkRepoKey, scenariosHash, CRIT_ID, SCEN_ID } from './scenarios.mjs';
import { isLocalUrl } from './config.mjs';
import { FEATURE_ID } from './queue.mjs';
import { factoryHome, repoKey as repoKeyOf } from './factoryhome.mjs';

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const BASE_REF = /^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SETUP_TIMEOUT_S = 900;
const SEED_TIMEOUT_S = 600;
const STOP_TIMEOUT_S = 30;
const STOP_GRACE_MS = 10000;
const ENV_EXAMPLE_MAX = 64 * 1024;
const RUNS = 2;
const MAX_SCENARIOS = 1000;
const DEFAULT_BUDGET_S = 7200;
const MAX_BUDGET_S = 86400;
const SWEEP_WAIT_MS = 3000;
const STATUSES = new Set(['pass', 'fail', 'blocked']);

// Process group still alive (EPERM means it exists but is not ours to signal: treat as alive).
const groupAlive = (app) => {
  if (!app?.pgid) return false;
  try { process.kill(-app.pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, root) => p === root || p.startsWith(`${root}/`);

// Number of live (non-zombie) processes other than this one whose argv or environment (ps -E) mentions a marker path, or whose cwd
// (lsof) is inside one. Every sandboxed process gets TMPDIR/HOME in the run temp and starts in the worktree, so a survivor of a
// phase (a setsid daemon included) normally shows one of them. Fails closed: a ps or lsof failure counts as a survivor.
// Residual: a process that clears its environment, rewrites its argv AND leaves the worktree cwd is not found.
// The marker as a whole path: followed by the end, "/" or whitespace (".../run/o__r" must not match ".../run/o__r2").
const mentions = (text, k) => { for (let i = text.indexOf(k); i !== -1; i = text.indexOf(k, i + 1)) { const c = text[i + k.length]; if (c === undefined || c === '/' || /\s/.test(c)) return true; } return false; };
export function scanSurvivors(markers) {
  const r = survivorPids(markers);
  return r.ok ? r.pids.size : Math.max(1, r.pids.size);
}
// The same scan, as { ok, pids, killable } (Sets of pids; ok false: ps or lsof failed, the sets hold what was found before that).
// pids is the broad detection set (argv/env mention or cwd). killable is the narrow set the stop path may signal: the cwd is inside
// a marker and the process has no controlling terminal, or the environment carries TMPDIR= or HOME= inside one of `sandbox` (the
// run temps a sandboxed process is started with). A process that only MENTIONS a marker (an editor, `git -C <clone>`, a shell with
// PWD/OLDPWD there) is never killable, and neither is one with a controlling terminal whose cwd is in a marker (a person's shell or
// editor opened in a clone: builder sessions and apps are started detached, without one); both stay in pids. Never this process.
export function survivorPids(markers, { sandbox = [] } = {}) {
  const ps = spawnSync('/bin/ps', ['-axwwE', '-o', 'pid=,stat=,tt=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 5000 });
  if (ps.status !== 0 || ps.error) return { ok: false, pids: new Set(), killable: new Set() };
  const lsof = spawnSync('/usr/sbin/lsof', ['-n', '-P', '-w', '-d', 'cwd', '-F', 'pn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 5000 });
  const lsofText = lsof.error || !lsof.stdout ? null : lsof.stdout;
  const r = survivorSets({ psText: ps.stdout, lsofText, markers, sandbox, self: process.pid });
  return { ok: lsofText !== null, pids: r.pids, killable: r.killable };
}
// No controlling terminal: `??` (macOS), `?` (Linux procps) or `-`.
const NO_TTY = new Set(['??', '?', '-']);
// survivorSets({ psText, lsofText, markers, sandbox, self }) -> { pids, killable }: the pure part of survivorPids. psText holds
// `ps -o pid=,stat=,tt=,command=` rows (command with -E's environment), lsofText `lsof -d cwd -F pn` output (null: lsof failed,
// only the ps part is used). Zombies and `self` are skipped.
export function survivorSets({ psText, lsofText, markers, sandbox = [], self = process.pid }) {
  const hits = new Set(); const kill = new Set(); const tty = new Map();
  // `ps -E` appends the environment to the argv with single spaces and no delimiter, so an argv word that looks like
  // " TMPDIR=<root>..." cannot be told apart from the real variable; such a process would be treated as sandboxed. Accepted: the
  // roots are this driver's own private run dirs, which nothing else has reason to name.
  const envIn = (text) => sandbox.some((k) => [' TMPDIR=', ' HOME='].some((v) => mentions(text, `${v}${k}`)));
  for (const line of String(psText ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s(.*)$/.exec(line);
    if (!m || m[2].startsWith('Z') || Number(m[1]) === self) continue;
    tty.set(m[1], m[3]);
    if (markers.some((k) => mentions(m[4], k))) hits.add(m[1]);
    if (envIn(m[4])) { hits.add(m[1]); kill.add(m[1]); }
  }
  const num = (set) => new Set([...set].map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== self));
  if (lsofText === null || lsofText === undefined) return { pids: num(hits), killable: num(kill) };
  let pid = null;
  for (const line of String(lsofText).split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('n') && pid && Number(pid) !== self && markers.some((k) => within(line.slice(1), k))) {
      hits.add(pid);
      // A pid ps did not list (it started after the ps call) has no known terminal: killable, like a detached session child.
      if (NO_TTY.has(tty.get(pid) ?? '?')) kill.add(pid);
    }
  }
  return { pids: num(hits), killable: num(kill) };
}
// Polls briefly: processes the phase's process-group kill just ended may still be listed for a moment.
async function sweepSurvivors(markers) {
  const until = Date.now() + SWEEP_WAIT_MS;
  for (;;) {
    const n = scanSurvivors(markers);
    if (n === 0 || Date.now() >= until) return n;
    await sleep(200);
  }
}

// Every side effect goes through these, so tests can stand in for the sandbox and the app.
const DEFAULT_SEAMS = {
  sandboxAvailable: () => sbx.sandboxAvailable(),
  sandboxProfile: sbx.sandboxProfile,
  makeRunTemp: sbx.makeRunTemp,
  removeRunTemp: sbx.removeRunTemp,
  keepRunTemp: sbx.keepRunTemp,
  runSandboxed: sbx.runSandboxed,
  startSandboxed: sbx.startSandboxed,
  stopApp: proc.stopApp,
  waitReady: proc.waitReady,
  portInUse: proc.portInUse,
  runApiScenario,
  alive: groupAlive,
  survivors: (markers) => sweepSurvivors(markers),
  rmVerdict: (file) => fs.rmSync(file, { force: true }),
  now: () => Date.now(),
};

const isArgv = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x !== '');
const pin127 = (url) => { const u = new URL(url); if (u.hostname === 'localhost') u.hostname = '127.0.0.1'; return u.toString(); };

// The app plan from the BASE config. Throws on anything the sandbox network rule cannot honour.
function appPlan(config) {
  const a = config?.app;
  if (!a || typeof a !== 'object') throw new Error('config.app is required for verification');
  if (!isArgv(a.start)) throw new Error('app.start is required for verification');
  for (const k of ['setup', 'seed', 'stop']) if (a[k] != null && !isArgv(a[k])) throw new Error(`app.${k} must be an argument list`);
  if (!isLocalUrl(a.base_url)) throw new Error('app.base_url must be http://localhost:<port> or http://127.0.0.1:<port> for verification');
  const port = proc.portOf(a.base_url);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('app.base_url has no usable port');
  const r = a.ready;
  if (!r || typeof r !== 'object' || (!r.url && !r.log_pattern)) throw new Error('app.ready is required for verification');
  let ready = { ...r };
  if (r.url !== undefined) {
    if (!isLocalUrl(r.url)) throw new Error('app.ready.url must be a local http URL');
    if (proc.portOf(r.url) !== port) throw new Error('app.ready.url must use the same port as app.base_url (the sandbox opens that port only)');
    ready = { ...r, url: pin127(r.url) }; // the driver's own readiness probe must not reach an impostor on ::1
  }
  return { setup: a.setup ?? null, seed: a.seed ?? null, stop: a.stop ?? null, start: a.start, baseUrl: a.base_url, port, ready, envExample: a.env_example ?? null };
}

// API scenarios of a doc bound to the current criteria. 1a cannot verify UI scenarios: refuse rather than pass or fail them.
function apiScenarios(doc, criteriaHash) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.scenarios)) throw new Error('scenario doc has no scenarios array');
  if (doc.scenarios.length > MAX_SCENARIOS) throw new Error(`scenario doc has more than ${MAX_SCENARIOS} scenarios`);
  if (doc.criteria_hash !== criteriaHash) throw new Error('scenario doc criteria_hash is not current');
  if (doc.scenarios.some((s) => s?.kind === 'ui')) throw new Error('UI scenarios need the Phase 1b evaluator: refusing to verify this feature in 1a');
  const list = doc.scenarios.filter((s) => s?.kind === 'api');
  if (!list.length || list.length !== doc.scenarios.length) throw new Error('scenario doc has no api scenarios (or entries of unknown kind)');
  for (const [i, s] of list.entries()) {
    if (typeof s.id !== 'string' || !SCEN_ID.test(s.id)) throw new Error(`scenario #${i + 1}: invalid id`);
    if (!Array.isArray(s.covers) || !s.covers.length || s.covers.length > 50 || !s.covers.every((x) => typeof x === 'string' && CRIT_ID.test(x))) throw new Error(`scenario #${i + 1}: invalid covers`);
  }
  return list;
}

// allowEnv over the env example read from the BASE ref (never the feature branch), then the pinned listen address.
function appEnv(git, baseRef, plan) {
  let text = null;
  if (plan.envExample) {
    const r = git('cat-file', '-p', `${baseRef}:${plan.envExample}`);
    if (r.code === 0 && typeof r.out === 'string' && r.out.length <= ENV_EXAMPLE_MAX) text = r.out;
  }
  return { ...proc.allowEnv(text), HOST: '127.0.0.1', PORT: String(plan.port) };
}

const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

// FACTORY_HOME/work/<repo-key>/<ID>-<sha> by realpath; refuses symlinked work dirs.
function workDir(repoKey, id, sha) {
  const work = path.join(sbx.canonical(factoryHome()), 'work');
  for (const d of [work, path.join(work, repoKey)]) {
    if (!exists(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(d);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('refusing to verify: a FACTORY_HOME work directory is a symlink');
  }
  return path.join(work, repoKey, `${id}-${sha}`);
}

// Quarantine-then-delete. Only call once nothing sandboxed from the run can be alive. Returns null, or { message, pruneFailed } (no paths).
//   1. rename(2) the worktree to FACTORY_HOME/trash/<random> (same volume, 0700); on failure it stays where it is (never rm in place);
//   2. `git worktree prune` from the clone (the only git call; it checks the registered path, now gone, and never reads the moved tree);
//   3. delete the quarantined tree (fs.rmSync unlinks symlinks, it does not follow them).
function removeWorktree(git, dir, trashRoot) {
  if (exists(dir)) {
    let q;
    try {
      const st = fs.lstatSync(trashRoot.parent);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('FACTORY_HOME is not a plain directory');
      if (!exists(trashRoot.dir)) fs.mkdirSync(trashRoot.dir, { mode: 0o700 });
      const t = fs.lstatSync(trashRoot.dir);
      if (t.isSymbolicLink() || !t.isDirectory()) throw new Error('trash is not a plain directory');
      q = path.join(trashRoot.dir, crypto.randomBytes(12).toString('hex'));
      fs.renameSync(dir, q);
    } catch { return { message: 'the verification worktree could not be moved to the trash: it was left in place', pruneFailed: false }; }
    const pruned = prune(git);
    try { fs.rmSync(q, { recursive: true, force: true }); } catch { /* reported below */ }
    const undeleted = exists(q) ? 'the quarantined verification worktree could not be deleted' : null;
    if (!pruned) return { message: undeleted ? `${PRUNE_FAILED}; ${undeleted}` : PRUNE_FAILED, pruneFailed: true };
    return undeleted ? { message: undeleted, pruneFailed: false } : null;
  }
  return prune(git) ? null : { message: PRUNE_FAILED, pruneFailed: true };
}
const PRUNE_FAILED = 'git worktree prune failed in the factory clone: a stale verification worktree registration remains';
const prune = (git) => { try { return git('worktree', 'prune')?.code === 0; } catch { return false; } };

const combine = (runs) => {
  const flaky = runs.some((r) => r !== runs[0]);
  return { status: flaky ? 'fail' : runs[0], flaky };
};

// verifyFeature({ repoKey, id, sha, baseRef, config, scenarios, criteriaHash, git, budgetS }, seams?) -> { verdict, doc, brief, reused[, cleanupError] }
//   git: (...args) => { code, out, err }, bound to the factory clone (gitSafe). config: the BASE config. scenarios: the stored doc.
//   budgetS: overall wall-clock budget in seconds (default 7200); exceeding it throws (after cleanup).
// Throws (after stopping the app and removing the worktree when that is safe) on refusals and crashes; a thrown error may carry
// `cleanupError`.
export async function verifyFeature({ repoKey, id, sha, baseRef, config, scenarios, criteriaHash, git, budgetS = DEFAULT_BUDGET_S } = {}, seams = {}) {
  const s = { ...DEFAULT_SEAMS, ...seams };
  checkRepoKey(repoKey);
  if (typeof id !== 'string' || id.length > 64 || !FEATURE_ID.test(id)) throw new Error('invalid feature id (expected FEATURE-<n>)');
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('invalid sha (expected 40 lowercase hex characters)');
  if (typeof baseRef !== 'string' || !BASE_REF.test(baseRef) || baseRef.split('/').some((p) => p === '..' || p === '.')) throw new Error('invalid base ref (expected refs/remotes/origin/<branch>)');
  if (typeof git !== 'function') throw new Error('invalid git runner (expected a function bound to the factory clone)');
  if (typeof criteriaHash !== 'string' || !HASH.test(criteriaHash)) throw new Error('invalid criteria hash');
  if (!Number.isInteger(budgetS) || budgetS < 1 || budgetS > MAX_BUDGET_S) throw new Error(`invalid budget (expected 1-${MAX_BUDGET_S} seconds)`);
  const list = apiScenarios(scenarios, criteriaHash);
  const plan = appPlan(config);
  const scHash = scenariosHash(scenarios);

  const prior = readVerdict(repoKey, id, sha);
  if (prior && verdictMatches(prior, { sha, scenariosHash: scHash, criteriaHash })) return { verdict: 'pass', doc: prior, brief: [], reused: true };

  const deadline = s.now() + budgetS * 1000;
  const leftS = () => Math.ceil((deadline - s.now()) / 1000);
  const checkBudget = () => { if (leftS() <= 0) throw new Error('verification exceeded its time budget'); };
  const listening = async () => (await s.portInUse(plan.port, '127.0.0.1')) || (await s.portInUse(plan.port, '::1'));

  const avail = s.sandboxAvailable();
  if (!avail?.ok) throw new Error(`untrusted-code sandbox unavailable (${avail?.reason ?? 'unknown'}); refusing to verify: there is no unsandboxed fallback`);
  if (await listening()) throw new Error(`port ${plan.port} is already in use (127.0.0.1 or ::1): refusing to verify while another process listens there`);
  if (git('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`).code !== 0) throw new Error('base ref cannot be resolved in the factory clone');
  if (git('cat-file', '-e', `${sha}^{commit}`).code !== 0) throw new Error('sha is not a commit in the factory clone');
  const env = appEnv(git, baseRef, plan);

  const wt = workDir(repoKey, id, sha);
  const fhReal = sbx.canonical(factoryHome());
  const trash = { parent: fhReal, dir: path.join(fhReal, 'trash') };
  if (exists(wt)) { // a crashed or escaped earlier run: only cleared when nothing from it is still alive
    if ((await s.survivors([wt])) > 0) throw new Error('leftover worktree: a process from an earlier run is still running there; refusing to verify');
    const left = removeWorktree(git, wt, trash);
    if (left) throw new Error(`leftover worktree: ${left.message}`);
  }

  let tmp = null, running = null, escaped = false, failure = null, outcome = null;
  // After a sandboxed phase: anything listening on either loopback, or any process still carrying this run's markers, is an escape.
  const afterPhase = async (phase) => {
    if (await listening() || (await s.survivors([wt, tmp].filter(Boolean))) > 0) {
      escaped = true;
      throw new Error(`a process from ${phase} is still running or listening on port ${plan.port} after it finished`);
    }
  };
  const stopRunning = async (profile) => {
    if (!running) return;
    if (plan.stop) { try { await s.runSandboxed(plan.stop, { cwd: wt, env, timeoutS: STOP_TIMEOUT_S, profile, tmpDir: tmp }); } catch { /* the group kill below is the real stop */ } }
    try { await s.stopApp(running, { graceMs: STOP_GRACE_MS }); } catch { /* checked below */ }
    if (s.alive(running)) throw new Error('the app process group did not exit after stop');
    running = null;
  };

  try {
    const add = git('worktree', 'add', '--detach', wt, sha);
    if (add.code !== 0) throw new Error('git worktree add failed for the verification worktree');
    tmp = s.makeRunTemp();
    const setupProfile = s.sandboxProfile({ writable: [wt], tmpDir: tmp, network: 'registries' });
    const runProfile = s.sandboxProfile({ writable: [wt], tmpDir: tmp, network: { localhostPort: plan.port } });

    const oneRun = async (sc) => {
      checkBudget();
      if (plan.seed) {
        let r;
        try { r = await s.runSandboxed(plan.seed, { cwd: wt, env, timeoutS: Math.min(SEED_TIMEOUT_S, leftS()), profile: runProfile, tmpDir: tmp }); } finally { await afterPhase('app.seed'); }
        if (r?.code !== 0 || r?.timedOut) return 'blocked';
      } else if (await listening()) { escaped = true; throw new Error(`port ${plan.port} is in use right before the app start`); }
      // With a seed, afterPhase('app.seed') above was the port check immediately before the start.
      let status = 'blocked';
      running = s.startSandboxed(plan.start, { cwd: wt, env, profile: runProfile, tmpDir: tmp });
      try {
        if (await s.waitReady(plan.ready, running) && s.alive(running)) {
          const r = await s.runApiScenario(sc, plan.baseUrl);
          status = STATUSES.has(r?.status) ? r.status : 'blocked';
          if (!s.alive(running)) status = 'blocked'; // the app died: whoever answered may not have been the app
        }
      } finally { await stopRunning(runProfile); }
      await afterPhase('the app');
      return status;
    };

    checkBudget();
    let setupOk = true;
    if (plan.setup) {
      let r;
      try { r = await s.runSandboxed(plan.setup, { cwd: wt, env, timeoutS: Math.min(SETUP_TIMEOUT_S, leftS()), profile: setupProfile, tmpDir: tmp }); } finally { await afterPhase('app.setup'); }
      setupOk = r?.code === 0 && !r?.timedOut;
    }
    const results = [];
    for (const sc of list) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(setupOk ? await oneRun(sc) : 'blocked');
      results.push({ id: sc.id, covers: [...sc.covers], ...combine(runs) });
    }
    checkBudget();
    await afterPhase('the run'); // before the verdict is written: an escape must never leave a stored (reusable) verdict
    const verdict = results.length > 0 && results.every((r) => r.status === 'pass' && !r.flaky) ? 'pass' : 'fail';
    const doc = { feature: id, sha, scenarios_hash: scHash, criteria_hash: criteriaHash, results, verdict, at: new Date().toISOString() };
    writeVerdict(repoKey, doc);
    const brief = verdict === 'pass' ? [] : symptomBrief(results.filter((r) => r.status !== 'pass' || r.flaky), scenarios, scenarios.canary);
    outcome = { verdict, doc, brief, reused: false };
  } catch (e) {
    failure = e;
    if (running) { try { await stopRunning(); } catch { /* still alive: the worktree stays (below) */ } }
  }

  // Final sweep whatever happened (a phase may have thrown before its own check): no git call on the worktree while a
  // sandboxed process from this run may still be alive or listening.
  if (tmp && !running && !escaped) {
    try { if (await listening() || (await s.survivors([wt, tmp])) > 0) escaped = true; } catch { escaped = true; }
  }
  const removal = running ? { message: 'the app did not exit: the verification worktree was left in place' }
    : escaped ? { message: 'a process from the run is still running or listening: the verification worktree was left in place' }
      : removeWorktree(git, wt, trash);
  let cleanupError = removal?.message ?? null;
  if (tmp) {
    // Kept on an escape: also drop proc's on-exit delete, or it would rm the dir on driver exit while the escaped process lives.
    if (running || escaped) { try { s.keepRunTemp(tmp); } catch { /* nothing registered */ } } else { try { s.removeRunTemp(tmp); } catch { /* removed on process exit */ } }
  }
  if (escaped && outcome) { // found only by the last sweep, after the verdict was written: that verdict must not be reused
    const file = verdictPath(repoKey, id, sha);
    try { s.rmVerdict(file); } catch { /* checked below */ }
    if (exists(file)) { // could not be deleted: overwrite it with a fail verdict (never reused, never posted)
      const d = outcome.doc;
      try { writeVerdict(repoKey, { ...d, verdict: 'fail', results: d.results.map((r) => ({ ...r, status: r.status === 'pass' ? 'fail' : r.status })) }); } catch {
        cleanupError = [cleanupError, 'stored verdict could not be removed'].filter(Boolean).join('; ');
      }
    }
    outcome = null;
  }
  if (escaped && !failure) failure = new Error('a process from the run is still running or listening after verification');
  if (removal?.pruneFailed && !failure) { failure = new Error(removal.message); failure.result = outcome; }
  if (failure) {
    if (cleanupError && failure && typeof failure === 'object') failure.cleanupError = cleanupError;
    throw failure;
  }
  if (cleanupError) outcome.cleanupError = cleanupError;
  return outcome;
}

// ---- symptom brief ---------------------------------------------------------------------------------------------------------------
export const API_SYMPTOM = 'an endpoint returned an unexpected status or body';
const FALLBACK = 'behaviour does not satisfy';
const MAX_LINES = 50;
const MAX_IDS = 20;
const MAX_LINE = 300;
const MIN_LEAF = 4; // shorter scenario strings ("GET", "1") would match the fixed text by accident; the output is IDs + fixed text anyway
const MAX_NODES = 100000;
const ID = String.raw`(?:AC|EC|ER)-[1-9]\d{0,3}`;
const LINE_SHAPE = new RegExp(`^(?:${ID}(?:, ${ID})*: ${API_SYMPTOM}|${FALLBACK} ${ID}(?:, ${ID})*)$`);

// Every string value in a scenario's setup, request, assertions, steps and expectations, plus the object keys inside request
// `body` / `headers` (data; elsewhere keys are schema words such as "status"). null when too large to check.
function scenarioStrings(list, canary) {
  const out = new Set();
  if (typeof canary === 'string' && canary) out.add(canary);
  const stack = list.filter((x) => x && typeof x === 'object').flatMap((sc) => [sc.setup, sc.request, sc.assert, sc.steps, sc.expect, sc.run].map((v) => [v, false]));
  let n = 0;
  while (stack.length) {
    const [v, data] = stack.pop();
    if (++n > MAX_NODES) return null;
    if (typeof v === 'string') { if (v.length >= MIN_LEAF) out.add(v); continue; }
    if (!v || typeof v !== 'object') continue;
    for (const [k, x] of Object.entries(v)) {
      if (data && !Array.isArray(v) && k.length >= MIN_LEAF) out.add(k);
      stack.push([x, data || (!Array.isArray(v) && (k === 'body' || k === 'headers'))]);
    }
  }
  return out;
}

// symptomBrief(failures, scenarios, canary) -> string[]: per failure `<covers IDs>: an endpoint returned an unexpected status or body`.
// Only covers entries that are exactly criterion IDs survive; scenario ids, paths, data, the canary, quotes and URLs never appear.
// A line that would contain any scenario string falls back to `behaviour does not satisfy <IDs>`, else it is dropped. Deduped, then
// sorted by the covers string (the order of scenarios or results is not a signal), then capped.
export function symptomBrief(failures, scenarios, canary) {
  if (!Array.isArray(failures)) return [];
  const list = Array.isArray(scenarios) ? scenarios : Array.isArray(scenarios?.scenarios) ? scenarios.scenarios : [];
  const forbidden = scenarioStrings(list, canary);
  if (!forbidden) return [];
  const safeId = (x) => typeof x === 'string' && x.length <= 7 && CRIT_ID.test(x);
  const clean = (line) => line.length <= MAX_LINE && LINE_SHAPE.test(line) && ![...forbidden].some((f) => line.includes(f));
  const lines = new Map(); // covers head -> line
  for (const f of failures.slice(0, MAX_SCENARIOS)) {
    if (!f || typeof f !== 'object' || (f.status === 'pass' && f.flaky !== true)) continue;
    const ids = [...new Set((Array.isArray(f.covers) ? f.covers : []).filter(safeId))].slice(0, MAX_IDS);
    if (!ids.length) continue;
    const head = ids.join(', ');
    const line = [`${head}: ${API_SYMPTOM}`, `${FALLBACK} ${head}`].find(clean);
    if (line && !lines.has(head)) lines.set(head, line);
  }
  return [...lines.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_LINES).map((k) => lines.get(k));
}

// ---- factory/verified ------------------------------------------------------------------------------------------------------------
export const VERIFIED_CONTEXT = 'factory/verified';
export const VERIFIED_DESCRIPTION = 'Hidden verification scenarios passed on this commit';
const VERIFIED_LINE = /^Verified: \d+\/\d+ scenarios at [0-9a-f]{7,40}\r?$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

export const verifiedLine = (n, sha) => `Verified: ${n}/${n} scenarios at ${sha.slice(0, 7)}`;

// Replaces the first existing Verified line in place (dropping any others) or appends one after a blank line. Idempotent.
export function withVerifiedLine(body, line) {
  const text = typeof body === 'string' ? body : '';
  const lines = text.split('\n');
  const at = lines.findIndex((l) => VERIFIED_LINE.test(l));
  if (at >= 0) return lines.flatMap((l, i) => (i === at ? [line] : VERIFIED_LINE.test(l) ? [] : [l])).join('\n');
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${line}` : line;
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// postVerified({ gh, repo, sha, n, pr, doc, repoKey, id }): commit status factory/verified=success on `sha`, then the PR body line
// `Verified: N/N scenarios at <short sha>` (a count only). gh: (...args) => { code, out, err }, argv only.
// `pr` (the PR number) is required: the body edit needs it, and the PR head must still be `sha`. `doc` is the verdict: it must be a
// consistent pass for exactly `sha` (verdictMatches against its own hashes) with exactly `n` results, and equal to the verdict file
// stored for (repoKey, id, sha) (same feature, sha, hashes and results).
export function postVerified({ gh, repo, sha, n, pr, doc, repoKey, id } = {}) {
  if (typeof gh !== 'function') throw new Error('invalid gh runner');
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) throw new Error('invalid repo (expected owner/name)');
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('invalid sha (expected 40 lowercase hex characters)');
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('invalid scenario count');
  if (!Number.isInteger(pr) || pr < 1) throw new Error('invalid PR number');
  if (!validVerdict(doc) || !verdictMatches(doc, { sha, scenariosHash: doc.scenarios_hash, criteriaHash: doc.criteria_hash })) throw new Error('invalid verdict: a passing verdict for this exact commit is required');
  if (doc.results.length !== n) throw new Error('invalid scenario count: it must equal the number of verdict results');
  checkRepoKey(repoKey);
  if (repoKeyOf(repo) !== repoKey) throw new Error('invalid repo key: it must be derived from repo (owner/name -> owner__name)');
  if (typeof id !== 'string' || !FEATURE_ID.test(id) || doc.feature !== id) throw new Error('invalid feature id: it must match the verdict');
  const stored = readVerdict(repoKey, id, sha);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!stored || stored.verdict !== 'pass' || !same([stored.feature, stored.sha, stored.scenarios_hash, stored.criteria_hash, stored.results], [doc.feature, doc.sha, doc.scenarios_hash, doc.criteria_hash, doc.results])) {
    throw new Error('invalid verdict: it does not match the verdict file stored for this commit');
  }

  const view = gh('pr', 'view', String(pr), '--json', 'body,headRefOid');
  const v = view.code === 0 ? parse(view.out) : null;
  if (!v || typeof v !== 'object') throw new Error(`gh pr view #${pr} failed`);
  if (v.headRefOid !== sha) throw new Error(`PR head of #${pr} is not the verified commit: not posting ${VERIFIED_CONTEXT}`);

  const post = gh('api', '-X', 'POST', `repos/${repo}/statuses/${sha}`, '-f', 'state=success', '-f', `context=${VERIFIED_CONTEXT}`, '-f', `description=${VERIFIED_DESCRIPTION}`);
  if (post.code !== 0) throw new Error(`posting the ${VERIFIED_CONTEXT} status failed`);
  const check = gh('api', `repos/${repo}/commits/${sha}/status`);
  const c = check.code === 0 ? parse(check.out) : null;
  if (!c || !Array.isArray(c.statuses) || !c.statuses.some((x) => x?.context === VERIFIED_CONTEXT && x?.state === 'success')) throw new Error(`the ${VERIFIED_CONTEXT} status is not visible on the commit after posting`);

  const line = verifiedLine(n, sha);
  const body = typeof v.body === 'string' ? v.body : '';
  const next = withVerifiedLine(body, line);
  if (next === body) return { line, edited: false };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-prbody-'));
  try {
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, next, { mode: 0o600, flag: 'wx' });
    const e = gh('pr', 'edit', String(pr), '--body-file', file);
    if (e.code !== 0) throw new Error(`gh pr edit #${pr} failed`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return { line, edited: true };
}
