// Verification step (Phase 1a): runs a feature's hidden API scenarios against its app, built from the exact PR head sha, inside the
// untrusted-code sandbox; writes the verdict; turns failures into the builder-facing symptom brief; posts `factory/verified`.
// Zero dependencies.
//
// Trust rules (see docs/factory/specs/phase-1-verification-gate.md, P1.2):
// - Every command comes from the BASE config passed in (`config`), never from the feature branch; the env example is read from
//   `baseRef` in the factory clone (git cat-file), not from the worktree. The app gets HOST=127.0.0.1 and PORT=<base_url port>.
// - Nothing from the feature branch runs outside the sandbox: no sandbox, no verification. app.setup gets registry network;
//   app.seed, app.start and app.stop get only the app's port on localhost (spec: run phase). Stopping is a process-group kill.
// - The port must be free on BOTH 127.0.0.1 and ::1 before every start and after every stop (impostor / leaked listener).
// - Git on the verification worktree: only `worktree add` / `worktree remove` / `worktree prune`, all run from the factory clone,
//   and never while a sandboxed process from this run may still be alive (Task 6 rulings). Removal runs even on errors.
// - Each scenario runs twice from a fresh seed and app start; it passes only if both runs pass. Disagreement is `fail` + flaky.
// - The symptom brief carries criterion IDs and one fixed sentence only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sbx from './sandbox.mjs';
import * as proc from './proc.mjs';
import { runApiScenario } from './apicheck.mjs';
import { readVerdict, writeVerdict, verdictMatches } from './verdict.mjs';
import { checkRepoKey, scenariosHash, CRIT_ID, SCEN_ID } from './scenarios.mjs';
import { isLocalUrl } from './config.mjs';
import { FEATURE_ID } from './queue.mjs';
import { factoryHome } from './factoryhome.mjs';

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const BASE_REF = /^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SETUP_TIMEOUT_S = 900;
const SEED_TIMEOUT_S = 600;
const STOP_TIMEOUT_S = 30;
const STOP_GRACE_MS = 10000;
const ENV_EXAMPLE_MAX = 64 * 1024;
const RUNS = 2;
const STATUSES = new Set(['pass', 'fail', 'blocked']);

// Process group still alive (EPERM means it exists but is not ours to signal: treat as alive).
const groupAlive = (app) => {
  if (!app?.pgid) return false;
  try { process.kill(-app.pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Every side effect goes through these, so tests can stand in for the sandbox and the app.
const DEFAULT_SEAMS = {
  sandboxAvailable: () => sbx.sandboxAvailable(),
  sandboxProfile: sbx.sandboxProfile,
  makeRunTemp: sbx.makeRunTemp,
  removeRunTemp: sbx.removeRunTemp,
  runSandboxed: sbx.runSandboxed,
  startSandboxed: sbx.startSandboxed,
  stopApp: proc.stopApp,
  waitReady: proc.waitReady,
  portInUse: proc.portInUse,
  runApiScenario,
  alive: groupAlive,
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
  if (doc.criteria_hash !== criteriaHash) throw new Error('scenario doc criteria_hash is not current');
  if (doc.scenarios.some((s) => s?.kind === 'ui')) throw new Error('UI scenarios need the Phase 1b evaluator: refusing to verify this feature in 1a');
  const list = doc.scenarios.filter((s) => s?.kind === 'api');
  if (!list.length || list.length !== doc.scenarios.length) throw new Error('scenario doc has no api scenarios (or entries of unknown kind)');
  for (const [i, s] of list.entries()) {
    if (typeof s.id !== 'string' || !SCEN_ID.test(s.id)) throw new Error(`scenario #${i + 1}: invalid id`);
    if (!Array.isArray(s.covers) || !s.covers.length || s.covers.length > 50 || !s.covers.every((x) => typeof x === 'string' && CRIT_ID.test(x))) throw new Error(`scenario ${s.id}: invalid covers`);
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

// Returns null, or a message (no paths) when the worktree is still on disk afterwards. Only run once nothing sandboxed is alive.
function removeWorktree(git, dir) {
  try { git('worktree', 'remove', '--force', dir); } catch { /* fall through to rm + prune */ }
  if (exists(dir)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* reported below */ } }
  try { git('worktree', 'prune'); } catch { /* reported below if the dir is still there */ }
  return exists(dir) ? 'the verification worktree could not be removed' : null;
}

const combine = (runs) => {
  const flaky = runs.some((r) => r !== runs[0]);
  return { status: flaky ? 'fail' : runs[0], flaky };
};

// verifyFeature({ repoKey, id, sha, baseRef, config, scenarios, criteriaHash, git }, seams?) -> { verdict, doc, brief, reused[, cleanupError] }
//   git: (...args) => { code, out, err }, bound to the factory clone (gitSafe). config: the BASE config. scenarios: the stored doc.
// Throws (after stopping the app and removing the worktree) on refusals and crashes; a thrown error may carry `cleanupError`.
export async function verifyFeature({ repoKey, id, sha, baseRef, config, scenarios, criteriaHash, git } = {}, seams = {}) {
  const s = { ...DEFAULT_SEAMS, ...seams };
  checkRepoKey(repoKey);
  if (typeof id !== 'string' || id.length > 64 || !FEATURE_ID.test(id)) throw new Error('invalid feature id (expected FEATURE-<n>)');
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('invalid sha (expected 40 lowercase hex characters)');
  if (typeof baseRef !== 'string' || !BASE_REF.test(baseRef) || baseRef.split('/').some((p) => p === '..' || p === '.')) throw new Error('invalid base ref (expected refs/remotes/origin/<branch>)');
  if (typeof git !== 'function') throw new Error('invalid git runner (expected a function bound to the factory clone)');
  if (typeof criteriaHash !== 'string' || !HASH.test(criteriaHash)) throw new Error('invalid criteria hash');
  const list = apiScenarios(scenarios, criteriaHash);
  const plan = appPlan(config);
  const scHash = scenariosHash(scenarios);

  const prior = readVerdict(repoKey, id, sha);
  if (prior && verdictMatches(prior, { sha, scenariosHash: scHash, criteriaHash })) return { verdict: 'pass', doc: prior, brief: [], reused: true };

  const avail = s.sandboxAvailable();
  if (!avail?.ok) throw new Error(`untrusted-code sandbox unavailable (${avail?.reason ?? 'unknown'}); refusing to verify: there is no unsandboxed fallback`);
  if (await s.portInUse(plan.port, 'localhost')) throw new Error(`port ${plan.port} is already in use (127.0.0.1 or ::1): refusing to verify while another process listens there`);
  if (git('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`).code !== 0) throw new Error('base ref cannot be resolved in the factory clone');
  if (git('cat-file', '-e', `${sha}^{commit}`).code !== 0) throw new Error('sha is not a commit in the factory clone');
  const env = appEnv(git, baseRef, plan);

  const wt = workDir(repoKey, id, sha);
  if (exists(wt)) { const left = removeWorktree(git, wt); if (left) throw new Error(`a leftover ${left.replace(/^the /, '')}`); }

  let tmp = null, running = null, escaped = false, failure = null, outcome = null;
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
      if (await s.portInUse(plan.port, 'localhost')) throw new Error(`port ${plan.port} is in use before the app start`);
      if (plan.seed) {
        const r = await s.runSandboxed(plan.seed, { cwd: wt, env, timeoutS: SEED_TIMEOUT_S, profile: runProfile, tmpDir: tmp });
        if (r?.code !== 0 || r?.timedOut) return 'blocked';
      }
      let status = 'blocked';
      running = s.startSandboxed(plan.start, { cwd: wt, env, profile: runProfile, tmpDir: tmp });
      try {
        if (await s.waitReady(plan.ready, running) && s.alive(running)) {
          const r = await s.runApiScenario(sc, plan.baseUrl);
          status = STATUSES.has(r?.status) ? r.status : 'blocked';
          if (!s.alive(running)) status = 'blocked'; // the app died: whoever answered may not have been the app
        }
      } finally { await stopRunning(runProfile); }
      if (await s.portInUse(plan.port, 'localhost')) {
        escaped = true; // most likely a sandboxed process that left the app's process group (setsid): it may still touch the worktree
        throw new Error(`a process is still listening on port ${plan.port} after the app was stopped`);
      }
      return status;
    };

    let setupOk = true;
    if (plan.setup) {
      const r = await s.runSandboxed(plan.setup, { cwd: wt, env, timeoutS: SETUP_TIMEOUT_S, profile: setupProfile, tmpDir: tmp });
      setupOk = r?.code === 0 && !r?.timedOut;
    }
    const results = [];
    for (const sc of list) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) runs.push(setupOk ? await oneRun(sc) : 'blocked');
      results.push({ id: sc.id, covers: [...sc.covers], ...combine(runs) });
    }
    const verdict = results.length > 0 && results.every((r) => r.status === 'pass' && !r.flaky) ? 'pass' : 'fail';
    const doc = { feature: id, sha, scenarios_hash: scHash, criteria_hash: criteriaHash, results, verdict, at: new Date().toISOString() };
    writeVerdict(repoKey, doc);
    const brief = verdict === 'pass' ? [] : symptomBrief(results.filter((r) => r.status !== 'pass' || r.flaky), scenarios, scenarios.canary);
    outcome = { verdict, doc, brief, reused: false };
  } catch (e) {
    failure = e;
    if (running) { try { await stopRunning(); } catch { /* still alive: the worktree stays (below) */ } }
  }

  // No git call on the worktree while a sandboxed process from this run may still be alive.
  const cleanupError = running ? 'the app did not exit: the verification worktree was left in place'
    : escaped ? 'a process from the run is still listening: the verification worktree was left in place'
      : removeWorktree(git, wt);
  if (tmp && !running && !escaped) { try { s.removeRunTemp(tmp); } catch { /* removed on process exit */ } }
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
  const stack = list.filter((x) => x && typeof x === 'object').flatMap((sc) => [sc.setup, sc.request, sc.assert, sc.steps, sc.expect].map((v) => [v, false]));
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
// A line that would contain any scenario string falls back to `behaviour does not satisfy <IDs>`, else it is dropped. Deduped, capped.
export function symptomBrief(failures, scenarios, canary) {
  if (!Array.isArray(failures)) return [];
  const list = Array.isArray(scenarios) ? scenarios : Array.isArray(scenarios?.scenarios) ? scenarios.scenarios : [];
  const forbidden = scenarioStrings(list, canary);
  if (!forbidden) return [];
  const safeId = (x) => typeof x === 'string' && x.length <= 7 && CRIT_ID.test(x);
  const clean = (line) => line.length <= MAX_LINE && LINE_SHAPE.test(line) && ![...forbidden].some((f) => line.includes(f));
  const lines = [];
  for (const f of failures) {
    if (!f || typeof f !== 'object' || (f.status === 'pass' && f.flaky !== true)) continue;
    const ids = [...new Set((Array.isArray(f.covers) ? f.covers : []).filter(safeId))].slice(0, MAX_IDS);
    if (!ids.length) continue;
    const head = ids.join(', ');
    const line = [`${head}: ${API_SYMPTOM}`, `${FALLBACK} ${head}`].find(clean);
    if (line && !lines.includes(line)) lines.push(line);
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
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

// postVerified({ gh, repo, sha, n, pr }): commit status factory/verified=success on `sha`, then the PR body line
// `Verified: N/N scenarios at <short sha>` (a count only). gh: (...args) => { code, out, err }, argv only.
// `pr` (the PR number) is required: the body edit needs it, and the PR head must still be `sha`.
export function postVerified({ gh, repo, sha, n, pr } = {}) {
  if (typeof gh !== 'function') throw new Error('invalid gh runner');
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) throw new Error('invalid repo (expected owner/name)');
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new Error('invalid sha (expected 40 lowercase hex characters)');
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('invalid scenario count');
  if (!Number.isInteger(pr) || pr < 1) throw new Error('invalid PR number');

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
