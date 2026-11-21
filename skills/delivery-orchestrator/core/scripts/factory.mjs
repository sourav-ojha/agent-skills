#!/usr/bin/env node
// Factory driver CLI (Phase 1a). Zero dependencies. See docs/factory/specs/phase-1-verification-gate.md (P1.0, P1.1).
// usage: node factory.mjs scenarios [--only IDS] [--approve ID --by NAME] [--dir D]
//        node factory.mjs run [--only IDS] [--limit N] [--dir D]
// exit codes: 0 done, 1 refused or error (nothing unsafe happened), 2 stopped or a feature needs a person.
//
// Layout (all derived from FACTORY_HOME, taken from the driver's environment):
//   FACTORY_HOME/clones/<repo-key>     the DRIVER clone: deliver runs here (--dir), merges and verification worktrees start here.
//                                      Owned by the driver user; the builder never works in it and cannot write FACTORY_HOME.
//   FACTORY_HOME/queues/<repo-key>.json the queue (DELIVER_QUEUE).
//   <FACTORY_HOME>-builder/<repo-key>  the BUILDER clone (a plain clone, not a linked worktree), outside FACTORY_HOME because the
//                                      builder settings deny every read and write of FACTORY_HOME. Commits move between the two clones
//                                      as git bundles made and applied by the driver (never a fetch from the builder's repository).
// Terminal output: states, IDs and counts only (never spec, scenario, prompt or builder text).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factoryHome, repoKey } from './lib/factoryhome.mjs';
import { gitSafeOpts, gitEnv, verifyGitConfig, checkRepoMetadata, checkNoReplaceRefs, checkNoHooks, checkNetworkArgs, GIT_SAFE_FLAGS } from './lib/gitsafe.mjs';
import { parseConfig, CONFIG_PATH, remoteHost } from './lib/config.mjs';
import { FEATURE_ID, ACTIVE, transition, frontmatter, discover, buildQueue, runStop } from './lib/queue.mjs';
import { specFromBase, extractCriteria, criteriaHash, MAX_LINE } from './lib/criteria.mjs';
import { loadScenarios, saveScenarios, lintScenarios, isCurrentApproved, approve, newCanary, checkRepoKey, scenariosHash } from './lib/scenarios.mjs';
import { runSession, materialiseSettings, renderPrompt, defaultHome, readBuilderResult } from './lib/sessions.mjs';
import { sessionResult, nextAction, resumeAction, canHold, MAX_RESUMES } from './lib/driver.mjs';
import { acquire, inspect, LockError } from './lib/lock.mjs';
import { verifyFeature, scanSurvivors, survivorPids, symptomBrief, postVerified } from './lib/verify.mjs';
import { portOf, portInUse } from './lib/proc.mjs';
import { makeRunTemp } from './lib/sandbox.mjs';
import { readVerdict, verdictMatches } from './lib/verdict.mjs';
import { checkDiff, classify, holdReason } from './lib/antigaming.mjs';
import { requiredStatusChecks } from './lib/readiness.mjs';
import { readJson, writeJsonAtomic } from './lib/factoryhome.mjs';
import { loadLocalConfig } from './lib/localconfig.mjs';
import { CLASSIFIER_STATUS } from './lib/limits.mjs';
import { addUsage, dayUsage, featureUsage, UsageError } from './lib/usage.mjs';
import { checkBudget } from './lib/budget.mjs';
import { addAttention, listAttention, resolveAttention } from './lib/attention.mjs';
import { loadProbeResult, whyUnproven, HARD_STOPS, builderSettingsSha, PROBE_RUN } from './lib/hardstops.mjs';
import { routeInterruption } from './lib/interrupt.mjs';
import { readRun, updateRun, RunStateError } from './lib/runstate.mjs';
import { notify } from './lib/notify.mjs';

const SELF = fileURLToPath(import.meta.url);
export const DELIVER = path.join(path.dirname(SELF), 'deliver.mjs');
const SHA = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const validRef = (s) => typeof s === 'string' && REF.test(s) && !s.includes('..') && !s.endsWith('.lock') && !s.endsWith('/');
export const OR = (b) => `refs/remotes/origin/${b}`;
const SPEC_MAX = 256 * 1024;
const BY = /^[\w.@-]{1,64}$/;

// A refusal: printed with its fix text, exit 1.
export class Refusal extends Error { constructor(msg, fix) { super(msg); this.fix = fix || null; } }
// Something from a dead or escaped session may still be running in the builder clone: no git call there, the run stops.
class Leftover extends Error {}
class Unsafe extends Error {}
// The WIP commit of an interrupted session failed (e.g. a .git/index.lock left by the killed session): the run stops, f.interrupted
// stays set and neither branch is touched, so the next run continues from the builder clone instead of a reset rebuild.
class WipFailed extends Error {}
const refuse = (msg, fix) => { throw new Refusal(msg, fix); };

// ---- argv -----------------------------------------------------------------------------------------------------------------------
const BOOL = new Set(['continue', 'now', 'json']);
export function parseArgs(argv) {
  const opt = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); if (BOOL.has(k)) opt[k] = true; else { if (argv[i + 1] === undefined) throw new Refusal(`--${k} needs a value`); opt[k] = argv[++i]; } } else pos.push(a);
  }
  return { cmd: pos[0], opt, rest: pos.slice(1) };
}
const idList = (v) => {
  if (v === undefined) return [];
  const ids = String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!FEATURE_ID.test(id)) refuse(`--only has an invalid feature id (#${ids.indexOf(id) + 1})`, 'pass ids like FEATURE-001,FEATURE-002');
  return ids;
};

// ---- process helpers ------------------------------------------------------------------------------------------------------------
const run = (bin, args, { cwd, env, timeout, input } = {}) => {
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
};
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };

// The network git the driver uses for its own clones (clone, fetch): the gitSafe neutralising flags, GIT_* scrubbed, the URL and
// option allowlist of gitSafe (checkNetworkArgs), and for https on the configured host the account token through gh (gitSafe itself
// blanks every credential helper, so a private https remote could not be fetched with it). Run only after the clone's config passed
// the preflight (repo-config insteadOf, hooks, sshCommand, proxies are then impossible).
// Test seams (never set by the CLI): extraEnv (a per-process url.insteadOf to a local bare repo) and allowFile (that local transport).
export function makeNetGit({ host, ghEnv = {}, extraEnv = {}, allowFile = false } = {}) {
  return (cwd, args, { remotes = new Set() } = {}) => {
    checkNetworkArgs(args, { remotes });
    const flags = [];
    for (let i = 0; i < GIT_SAFE_FLAGS.length; i += 2) {
      if (allowFile && GIT_SAFE_FLAGS[i + 1].startsWith('protocol.file.allow=')) continue;
      flags.push(GIT_SAFE_FLAGS[i], GIT_SAFE_FLAGS[i + 1]);
    }
    // Always offered for https on the pinned host (with GH_TOKEN of the configured account when one is set, else gh's own login):
    // the driver must be able to clone a private https repository before it has read the base config.
    const cred = host ? ['-c', `credential.https://${host}.helper=!gh auth git-credential`] : [];
    const r = spawnSync('git', [...flags, ...cred, ...args], { cwd, env: { ...gitEnv(), ...ghEnv, ...extraEnv }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.signal) return { code: 1, out: '', err: 'git was interrupted' };
    return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
  };
}

// ---- context ----------------------------------------------------------------------------------------------------------------------
// FACTORY_HOME: absolute (resolved), a real directory owned by this user, not group/world writable. Created 0700 when missing.
function homeDir(env) {
  const fh = path.resolve(env.FACTORY_HOME || path.join(os.homedir(), '.factory'));
  try { fs.lstatSync(fh); } catch { fs.mkdirSync(fh, { recursive: true, mode: 0o700 }); }
  const st = fs.lstatSync(fh);
  if (st.isSymbolicLink() || !st.isDirectory()) refuse('FACTORY_HOME is not a plain directory (a symlink or a file)', 'point FACTORY_HOME at a real directory you own');
  if (st.uid !== process.getuid()) refuse('FACTORY_HOME is owned by another user', 'use a FACTORY_HOME owned by the user that runs the factory');
  if (st.mode & 0o022) refuse('FACTORY_HOME is group or world writable', 'chmod 700 your FACTORY_HOME');
  return fs.realpathSync(fh);
}
const within = (p, d) => p === d || p.startsWith(d + path.sep);
// A private directory directly under a checked parent; refuses symlinks and other owners.
export function privateDir(dir) {
  try { fs.lstatSync(dir); } catch { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) refuse('a factory directory is a symlink, not a directory, or owned by another user', 'remove it by hand and run again');
  return dir;
}

const urlPath = (u) => { const m = /^(?:(?:https|ssh):\/\/[^/]+\/|[A-Za-z0-9._-]+@[^:/]+:)(.+?)(?:\.git)?\/?$/i.exec(String(u)); return m ? m[1] : null; };
// Rebuilt from the pin, never copied from config: https://<host>/<owner>/<repo>.git, or ssh://<user>@<host>/<owner>/<repo>.git
// (gitSafe's clone accepts URL forms only, never scp-style).
export const pinnedUrl = (host, repo, like) => (/^https:/i.test(like) ? `https://${host}/${repo}.git` : `ssh://${(/^(?:ssh:\/\/)?([A-Za-z0-9._-]+)@/.exec(like) || [, 'git'])[1]}@${host}/${repo}.git`);

// Which repository: the checkout in --dir (default: cwd) says, through gh and its origin URL. Only the identity is taken from it.
function identify(ctx, dir) {
  const v = ctx.gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd: dir });
  const o = v.code === 0 ? json(v.out) : null;
  const repo = o?.nameWithOwner;
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/').some((x) => x === '.' || x === '..')) refuse('could not identify the GitHub repository (gh repo view)', 'run from a checkout of the repository with gh logged in, or pass --dir <checkout>');
  let url;
  try { url = gitSafeOpts(dir, ['remote', 'get-url', 'origin'], { verified: true }).out.trim(); } catch { url = ''; }
  const host = remoteHost(url);
  if (!host || !urlPath(url) || urlPath(url).toLowerCase() !== repo.toLowerCase()) refuse('the checkout\'s origin is not the repository gh reports', 'fix the origin remote or "gh repo set-default"');
  const key = repoKey(repo);
  try { checkRepoKey(key); } catch { refuse('this repository name cannot be stored safely (a name containing "__" is not supported)', 'rename the repository or run the delivery-orchestrator interactively'); }
  const def = o?.defaultBranchRef?.name;
  return { repo, host: host.toLowerCase(), url: pinnedUrl(host.toLowerCase(), repo, url), key, defaultBranch: validRef(def) ? def : null };
}

// The driver clone's trust preflight, run BEFORE every fetch and before deliver runs there: a plain clone (.git a directory, the
// common dir its own), owned by this user, the gitsafe config allowlist, no planted grafts/shallow/alternates/commit-graph/
// config.worktree, no replace refs, no hooks, and origin resolving to exactly the pinned URL with no pushurl.
export function preflight(dir, url) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw new Error('the clone is a symlink, not a directory, or owned by another user');
  const g = fs.lstatSync(path.join(dir, '.git'));
  if (g.isSymbolicLink() || !g.isDirectory() || g.uid !== process.getuid()) throw new Error('the clone\'s .git is not a plain directory owned by this user');
  const { remotes } = verifyGitConfig(dir);
  checkRepoMetadata(dir); checkNoReplaceRefs(dir); checkNoHooks(dir);
  const common = gitSafeOpts(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { verified: true });
  if (common.code !== 0 || fs.realpathSync(common.out.trim()) !== fs.realpathSync(path.join(dir, '.git'))) throw new Error('the clone\'s common dir is not its own .git');
  const u = gitSafeOpts(dir, ['remote', 'get-url', '--all', 'origin'], { verified: true });
  const urls = u.code === 0 ? u.out.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  if (urls.length !== 1 || urls[0] !== url) throw new Error('origin is not exactly the pinned repository URL');
  const p = gitSafeOpts(dir, ['config', '--get-all', 'remote.origin.pushurl'], { verified: true });
  if (p.code !== 1 || p.out.trim()) throw new Error('origin has a pushurl');
  return { remotes };
}

// Creates (plain clone, never --shared/--reference) or updates a clone at <parent>/<key>, then checks it. Driver-owned settings:
// identity (deliver's stash needs one), gc.auto 0 (a plain gc would write a commit-graph, which the merge gate refuses).
export function ensureClone(ctx, parent, key) {
  privateDir(parent);
  const dir = path.join(parent, key);
  let fresh = false;
  if (!fs.existsSync(dir)) {
    const c = ctx.netGit(parent, ['clone', ctx.id.url, key]);
    if (c.code !== 0) refuse('cloning the repository failed', /^https:/.test(ctx.id.url) ? `log in with "gh auth login --hostname ${ctx.id.host}" (and set github.account in ${CONFIG_PATH} when gh has several accounts): https remotes are cloned with that login` : 'check that your ssh key can reach the repository');
    fresh = true;
    for (const [k, v] of [['user.name', 'factory-driver'], ['user.email', 'factory-driver@localhost'], ['gc.auto', '0']]) {
      if (gitSafeOpts(dir, ['config', k, v]).code !== 0) refuse('configuring the new clone failed');
    }
  }
  let remotes;
  try { ({ remotes } = preflight(dir, ctx.id.url)); } catch (e) { refuse(`the clone at FACTORY_HOME is not trusted: ${e.message}`, 'remove the clone directory by hand; the next run makes a fresh one'); }
  const f = ctx.netGit(dir, ['fetch', '--prune', '--no-tags', 'origin'], { remotes });
  if (f.code !== 0) refuse('fetching origin failed', 'check network access to the repository');
  try { checkRepoMetadata(dir); } catch (e) { refuse(`the clone is not trusted after the fetch: ${e.message}`, 'remove the clone directory by hand'); }
  return { dir, fresh };
}

// Policy from origin/<base>, read with gitSafe (replace refs ignored). null = unreadable or invalid (never defaults for a present file).
export function baseConfig(git, base) {
  if (git('rev-parse', '--verify', '--quiet', `${OR(base)}^{commit}`).code !== 0) return null;
  const t = git('ls-tree', '--full-tree', '-z', OR(base), '--', CONFIG_PATH);
  if (t.code !== 0) return null;
  if (t.out === '') return parseConfig(undefined).config;
  const m = /^100(?:644|755) blob ([0-9a-f]{40,64})\t/.exec(t.out);
  if (!m) return null;
  const s = git('cat-file', 'blob', m[1]);
  if (s.code !== 0 || s.out.length > 1024 * 1024) return null;
  try { const pr = parseConfig(JSON.parse(s.out)); return pr.errors.length ? null : pr.config; } catch { return null; }
}

// The feature specs on origin/<base> (features_dir from the base config): [{ id, rel, status, delivery, deps }].
export function baseSpecs(git, base, featuresDir) {
  const dir = String(featuresDir).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!dir || dir.split('/').some((x) => !x || x === '.' || x === '..') || /[\0\n:\\*?[]/.test(dir)) throw new Error('features_dir is not a normalised path');
  const r = git('ls-tree', '-z', '--name-only', '--full-tree', OR(base), '--', `${dir}/`);
  if (r.code !== 0) throw new Error('cannot list the feature specs');
  const out = [];
  for (const rel of r.out.split('\0').filter(Boolean)) {
    const m = /^(FEATURE-\d+)\.md$/.exec(rel.slice(dir.length + 1));
    if (!rel.startsWith(`${dir}/`) || !m) continue;
    const s = specFromBase(git, base, rel);
    if (!s.ok || s.text.length > SPEC_MAX) continue;
    const fm = frontmatter(s.text);
    out.push({ id: m[1], rel, text: s.text, status: (fm.status || '').toLowerCase(), delivery: (fm.delivery || 'none').toLowerCase() });
    if (out.length > 5000) throw new Error('too many specs');
  }
  return out;
}
const tooBig = (t) => t.length > SPEC_MAX || t.split('\n').some((l) => l.length > MAX_LINE);

// The criteria a feature's scenarios are bound to, recomputed from the base spec: { criteria, hash } or null (unreadable / too big).
export function baseCriteria(git, base, rel) {
  const s = specFromBase(git, base, rel);
  if (!s.ok || tooBig(s.text)) return null;
  const criteria = extractCriteria(s.text);
  return { criteria, hash: criteriaHash(criteria.sections) };
}

// Current approved scenarios: the stored doc RE-LINTED against the criteria on origin/<base> now, and approved for exactly its
// content (isCurrentApproved binds the approval to scenarios_hash). The `approved` field alone is never trusted. mode is the base
// config's verification.scenario_approval: under "human" an approval by "auto" does not count.
export function scenarioState(key, id, bc, mode) {
  if (!bc || !bc.criteria.ok) return { ok: false, why: 'criteria' };
  let doc;
  try { doc = loadScenarios(key, id); } catch { return { ok: false, why: 'corrupt' }; }
  if (!doc) return { ok: false, why: 'missing' };
  if (doc.feature !== id) return { ok: false, why: 'corrupt' };
  const lint = lintScenarios(doc, bc.criteria, bc.hash);
  if (!lint.ok) return { ok: false, why: 'lint', problems: lint.problems, doc };
  if (!isCurrentApproved(doc, bc.hash, mode)) return { ok: false, why: 'unapproved', doc };
  return { ok: true, doc };
}

// The driver's wall clock (budget day, waits). Tests inject a fake one through deps.clock.
const REAL_CLOCK = Object.freeze({ now: () => Date.now(), sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }) });
export function makeContext({ argv, deps: given = {} }) {
  const deps = { ...given, clock: given.clock || REAL_CLOCK };
  const env = deps.env || process.env;
  const out = deps.out || ((line) => process.stdout.write(`${line}\n`));
  const ghEnv = {};
  const ctx = {
    env, out, deps, ghEnv,
    gh: (args, { cwd } = {}) => run('gh', args, { cwd: cwd || ctx.D || process.cwd(), env: { ...env, ...ghEnv } }),
  };
  ctx.args = parseArgs(argv);
  return ctx;
}

// gh token of the configured account, held in memory (never printed or written), offered only to that host.
function useAccount(ctx, account, host) {
  for (const k of ['GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) delete ctx.ghEnv[k];
  if (!account) return;
  const t = run('gh', ['auth', 'token', '--user', account, '--hostname', host], { env: ctx.env });
  if (t.code !== 0 || !t.out.trim()) refuse(`gh has no login for the configured account on ${host}`, `run "gh auth login --hostname ${host}" for that account`);
  Object.assign(ctx.ghEnv, host === 'github.com' ? { GH_TOKEN: t.out.trim() } : { GH_ENTERPRISE_TOKEN: t.out.trim(), GH_HOST: host });
}

// Lock, driver clone, fetch, base policy. Shared by `scenarios` and `run`.
export function prepare(ctx) {
  const { opt } = ctx.args;
  ctx.fh = homeDir(ctx.env);
  // The per-user run-control config (FACTORY_HOME/config.json). Any error refuses: its returned config is never used then (a
  // refused wait_for_reset: true still comes back true). The classifier gate: wait_for_reset needs a validated classifier.
  // CLASSIFIER_STATUS becomes 'real' once the classifier is validated against a captured limit event; until then only the test
  // seam deps.classifierReal lets config.json turn wait_for_reset on.
  const lc = loadLocalConfig(ctx.fh, { classifierReal: ctx.deps.classifierReal === true || CLASSIFIER_STATUS === 'real' });
  if (lc.errors.length) refuse(`the local config is invalid: ${lc.errors.join('; ')}`, `fix ${path.join(ctx.fh, 'config.json')} (or remove it to use the defaults)`);
  ctx.local = lc.config;
  const dir = path.resolve(opt.dir || process.cwd());
  ctx.id = identify(ctx, dir);
  ctx.key = ctx.id.key;
  try { ctx.lock = acquire(ctx.key, { home: ctx.fh, ...(ctx.deps.lockSys ? { sys: ctx.deps.lockSys } : {}), ...(ctx.deps.register ? { register: ctx.deps.register } : {}) }); } catch (e) {
    if (e instanceof LockError && e.code === 'LOCK_HELD') refuse('another factory run holds the lock for this repository', 'wait for it to finish (or stop it); a lock of a dead process is cleared automatically');
    if (e instanceof LockError) refuse(`the factory lock cannot be used (${e.code})`, 'see the lock file under FACTORY_HOME/locks; remove it by hand only if no factory run is alive');
    throw e;
  }
  ctx.netGit = ctx.deps.netGit || makeNetGit({ host: ctx.id.host, ghEnv: ctx.ghEnv, ...(ctx.deps.netGitOpts || {}) });
  // Credentials for the first clone/fetch, before the base config can be read: the account named in the checkout's config
  // (untrusted: it only picks which of your gh logins is offered, to the pinned host only). The base config's account replaces
  // it right after the fetch; a mismatch is refused below.
  const boot = bootAccount(dir);
  if (boot) useAccount(ctx, boot, ctx.id.host);
  const cl = ensureClone(ctx, path.join(ctx.fh, 'clones'), ctx.key);
  ctx.D = cl.dir;
  ctx.git = (...a) => gitSafeOpts(ctx.D, a);
  // The base: the person (--base) or the config committed on the default branch, never a working copy.
  const def = ctx.id.defaultBranch;
  const defCfg = def ? baseConfig(ctx.git, def) : null;
  const base = opt.base || defCfg?.base || def;
  if (!validRef(base)) refuse('could not determine the base branch', 'set "base" in the config on the default branch or pass --base');
  ctx.base = base;
  ctx.policy = baseConfig(ctx.git, base);
  if (!ctx.policy) refuse(`${CONFIG_PATH} on origin/${base} is missing its ref or is invalid`, `fix ${CONFIG_PATH} on ${base}`);
  if (ctx.policy.github.host.toLowerCase() !== ctx.id.host) refuse('github.host in the base config is not the origin host', 'set github.host to the host of origin');
  // Only where the checkout's account was actually used to authenticate: the first clone of an https remote.
  if (cl.fresh && /^https:/.test(ctx.id.url) && (ctx.policy.github.account || null) !== (boot || null)) refuse('github.account in the checkout differs from the one in the base config', `update the checkout (${CONFIG_PATH}) to the copy on ${base}`);
  useAccount(ctx, ctx.policy.github.account, ctx.policy.github.host);
  return ctx;
}
function bootAccount(dir) {
  try {
    const p = path.join(dir, CONFIG_PATH);
    if (!fs.lstatSync(p).isFile()) return null;
    const { config, errors } = parseConfig(JSON.parse(fs.readFileSync(p, 'utf8')));
    return errors.length ? null : config.github.account;
  } catch { return null; }
}

// ---- scenarios ----------------------------------------------------------------------------------------------------------------------
const ITEM = (x) => `- ${x.id}: ${x.text}`;
export function specSections(criteria) {
  const parts = [];
  if (criteria.ac.length) parts.push('### Acceptance criteria', ...criteria.ac.map(ITEM));
  if (criteria.ec.length) parts.push('', '### Edge cases', ...criteria.ec.map(ITEM));
  if (criteria.er.length) parts.push('', '### Error and failure scenarios', ...criteria.er.map(ITEM));
  if (criteria.contract.length) parts.push('', '### HTTP contract', ...criteria.contract.map((c) => `- \`${c.method} ${c.path}\``));
  else parts.push('', '### HTTP contract', '(none: use UI scenarios only)');
  return parts.join('\n');
}

// The author's reply: one JSON object { scenarios: [...] } (a single surrounding code fence is tolerated). null when not that.
export function parseAuthorReply(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) return null;
  let t = text.trim();
  const fence = /^```(?:json)?\n([\s\S]*)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  const o = json(t);
  if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.scenarios) || Object.keys(o).length !== 1) return null;
  return o.scenarios;
}

function usageEntry(role, r) {
  const cost = r?.costUsd;
  return { role, id: r?.sessionId ?? null, in: r?.usage?.in ?? 0, out: r?.usage?.out ?? 0, cache_create: r?.usage?.cache_create ?? 0, cache_read: r?.usage?.cache_read ?? 0, turns: r?.turns ?? 0, cost_usd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null };
}

// ---- budgets ----------------------------------------------------------------------------------------------------------------------
// The daily usage store is read-modify-write without a lock of its own: only the driver that holds this repository's lock writes it.
function recordUsage(ctx, entry) {
  if (!ctx.lock?.owned()) throw new Error('the factory lock is no longer ours');
  addUsage(ctx.fh, ctx.key, new Date(ctx.deps.clock.now()), entry);
}
const capOk = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
// The feature caps: the raised cap of the feature (f.budget_cap, set by --raise-budget) or the base policy's budgets.feature. A
// malformed cap throws: a budget never fails open.
export function featureCaps(ctx, f) {
  const raised = f && f.budget_cap !== undefined && f.budget_cap !== null;
  const caps = raised ? f.budget_cap : ctx.policy?.budgets?.feature;
  if (!caps || typeof caps !== 'object' || !capOk(caps.tokens) || !capOk(caps.turns)) throw new Error(`the ${raised ? `raised budget cap of ${f.id}` : 'feature budget cap'} is malformed`);
  return { tokens: caps.tokens, turns: caps.turns };
}
// Called before every builder and author session. Detects only (the caller's `interrupt` action holds or stops): null, or the
// session result { step: 'session', kind: 'budget', scope: 'feature' | 'day', dim, used, cap }. Author sessions have no queue
// feature and are checked against the day cap only. A corrupt usage store throws UsageError.
export function enforceBudget(ctx, f, role) {
  let caps = featureCaps(ctx, role === 'author' ? null : f);
  const dayCap = ctx.local?.budgets ? ctx.local.budgets.day_tokens : undefined;
  if (dayCap !== null && !capOk(dayCap)) throw new Error('the day budget cap is malformed');
  const feat = role !== 'author' && f ? featureUsage(f) : null;
  if (!feat) caps = { tokens: Infinity, turns: Infinity };
  const day = dayCap === null ? { tokens: 0, turns: 0 } : dayUsage(ctx.fh, new Date(ctx.deps.clock.now()));
  const r = checkBudget({ feature: feat || { tokens: 0, turns: 0 }, caps, day, dayCap });
  return r.ok ? null : { step: 'session', kind: 'budget', scope: r.scope, dim: r.dim, used: r.used, cap: r.cap };
}
// Fail closed at start: an unreadable or corrupt daily usage file refuses the command before any session.
function usagePreflight(ctx) {
  try { dayUsage(ctx.fh, new Date(ctx.deps.clock.now())); } catch (e) {
    if (e instanceof UsageError) refuse(e.message, 'fix or remove that file by hand (it is the daily token record), then run again');
    throw e;
  }
}

// ---- interruptions: waiting, run state, notifications ------------------------------------------------------------------------------
const isoAt = (ms) => new Date(ms).toISOString();
// The stop flag FACTORY_HOME/stop/<repo-key>, written by `factory stop` as { at, now }. stopRequested -> { now } | null: any file there
// is a stop (an empty or unreadable one is a graceful stop: a stop is never missed because its content cannot be read).
const STOP_FLAG = (ctx) => path.join(ctx.fh, 'stop', ctx.key);
export function stopRequested(ctx) {
  const file = STOP_FLAG(ctx);
  try { fs.lstatSync(file); } catch { return null; }
  let o = null;
  try { o = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { o = null; }
  return { now: o?.now === true };
}
const STOP_POLL_MS = 5000; // the stop flag is checked this often during sessions and the CI wait
const KILL_GRACE_MS = 10000; // SIGTERM to a session's (or deliver's) process group, SIGKILL after this
// runSession options of every session: the stop flag (graceful or --now) ends it, polled every 5 s.
const sessionStop = (ctx) => ({ shouldAbort: () => stopRequested(ctx) !== null, abortPollMs: STOP_POLL_MS, killGraceMs: KILL_GRACE_MS });
const alivePid = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
// After a stop: the processes still running IN the builder clone, the builder run dirs, the driver clone or the verification work
// dirs (their cwd is inside one) or started in one of THIS driver's sandboxes (TMPDIR/HOME inside this repository's builder run dir
// or a verification run temp this driver created, ctx.runTemps; never FACTORY_HOME/tmp as a whole: it holds every repository's run
// temps, and another repository's driver may be verifying right now) get SIGTERM, then
// SIGKILL after 10 s if a fresh scan still finds them (a pid that exited and was reused meanwhile is not signalled). A process that
// only mentions those paths in its argv or environment (an editor, `git -C <clone>`, a shell) is never killed: the broad detection
// (noLiveBuilder, the next start's sweep) refuses to continue instead. Then the app ports of the base config must be free. Never this
// process or its parent. Best effort: what is left is reported.
export async function killLeftovers(ctx) {
  const markers = [ctx.bRoot && path.join(ctx.bRoot, ctx.key), ctx.bRoot && builderRun(ctx), ctx.D, ctx.fh && ctx.key && path.join(ctx.fh, 'work', ctx.key)].filter(Boolean);
  const real = (d) => { try { return fs.realpathSync(d); } catch { return d; } }; // /tmp vs /private/tmp on macOS
  const sandbox = [...new Set([ctx.bRoot && builderRun(ctx), ...(ctx.runTemps || [])].filter(Boolean).map(real))];
  const scan = ctx.deps.survivorPids || survivorPids;
  const killable = () => new Set([...(scan(markers, { sandbox }).killable || [])].filter((p) => p !== process.pid && p !== process.ppid));
  const pids = [...killable()];
  if (pids.length) {
    for (const p of pids) try { process.kill(p, 'SIGTERM'); } catch { /* gone */ }
    const end = Date.now() + KILL_GRACE_MS;
    while (pids.some(alivePid) && Date.now() < end) await new Promise((r) => { setTimeout(r, 100); });
    const still = pids.filter(alivePid);
    if (still.length) { const now = killable(); for (const p of still.filter((x) => now.has(x))) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    ctx.out(`stop: ${pids.length} leftover process(es) ended`);
  }
  const app = ctx.policy?.app || {};
  for (const u of [...new Set([app.ready?.url, app.base_url].filter(Boolean))]) {
    let port; try { port = portOf(u); } catch { continue; }
    let busy = true;
    for (let i = 0; i < 20 && busy; i++) { busy = await (ctx.deps.portInUse || portInUse)(port, new URL(u).hostname); if (busy) await new Promise((r) => { setTimeout(r, 100); }); }
    if (busy) ctx.out(`warning: app port ${port} is still in use after the stop`);
  }
}
// The verification seams with makeRunTemp recorded: each run temp this driver creates goes on ctx.runTemps (the stop sweep's env roots).
export function verifySeamsFor(ctx) {
  const given = ctx.deps.verifySeams || {};
  const make = given.makeRunTemp || makeRunTemp;
  return { ...given, makeRunTemp: (...a) => { const d = make(...a); (ctx.runTemps ||= []).push(d); return d; } };
}
// How long this feature (or author spec) already waited for a usage limit, and how many rate retries it used. Per feature: a new
// feature starts at zero, and a session that ends normally resets it.
function waitState(ctx, id) {
  if (ctx.waits?.id !== id) ctx.waits = { id, ms: 0, rate: 0 };
  return ctx.waits;
}
// routeInterruption for a session's usage-limit result, as { do: 'stop', reason } | { do: 'switch_model', model } |
// { do: 'wait', until, estimated, commit() } (a rate retry is a short wait; commit() books the wait once it ended).
function routeLimit(ctx, r, ws) {
  // Already on the fallback model: switching again would loop on the same limit.
  if (r.limit === 'model' && ctx.modelOverride && ctx.modelOverride === ctx.local?.fallback_model) return { do: 'stop', reason: 'model limit: the fallback model is limited too' };
  const now = ctx.deps.clock.now();
  const x = routeInterruption({ limit: r.limit, resetAt: r.resetAt, nowMs: now, local: ctx.local, waitedMs: ws.ms, rateAttempt: ws.rate });
  if (x.do === 'stop' || x.do === 'switch_model') return x;
  if (x.do === 'retry') return { do: 'wait', until: now + x.afterS * 1000, estimated: false, commit: () => { ws.rate++; } };
  if (x.do === 'wait') return { do: 'wait', until: x.untilMs, estimated: x.estimated === true, commit: () => { ws.ms += x.untilMs - now; } };
  return { do: 'stop', reason: 'unknown interruption route' };
}
function nextMidnight(ctx) { const d = new Date(ctx.deps.clock.now()); d.setHours(24, 0, 0, 0); return d.getTime(); }
// Notifications carry the repo key, the event and a count only. Never fatal: a notification is a courtesy.
function tell(ctx, event) {
  let count = 0;
  try {
    const fs0 = ctx.queueFile && fs.existsSync(ctx.queueFile) ? readQueue(ctx).features : [];
    count = event === 'finished' ? fs0.filter((f) => f.state === 'merged').length : fs0.filter((f) => !TERMINAL.includes(f.state)).length;
  } catch { count = 0; }
  try { (ctx.deps.notify || notify)(event, { key: ctx.key, count }); } catch { /* best effort */ }
}
// caffeinate -i -w <driver pid>: prevents idle sleep while the driver waits (not a closed lid). argv only, detached from stdio.
function keepAwake(ctx) {
  if (ctx.local?.keep_awake !== true || (ctx.deps.platform || process.platform) !== 'darwin') return null;
  const argv = ['caffeinate', '-i', '-w', String(process.pid)];
  if (ctx.deps.keepAwake) return ctx.deps.keepAwake(argv);
  try {
    const c = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
    c.on('error', () => { /* no caffeinate: the wall-clock check still holds */ });
    c.unref();
    return { kill: () => { try { c.kill(); } catch { /* gone */ } } };
  } catch { return null; }
}
// waitUntil(ctx, untilMs, pause?) -> 'done' | 'stopped'. Sleeps in slices of at most 30 s and re-reads the wall clock after each,
// so a laptop sleep or clock jump ends the wait at the next slice and never stretches it; the slept time is also bounded by the
// planned wait, so a clock that never gets there cannot hold the run forever. Each slice: the stop flag, the lock, the run state
// (status paused with pause { kind, limit?, reset_at, estimated }). Done: back to running.
export async function waitUntil(ctx, untilMs, pause = {}) {
  const clock = ctx.deps.clock;
  const planned = Math.max(0, untilMs - clock.now());
  const patch = { status: 'paused', pause: { kind: pause.kind || 'usage_limit', ...(pause.limit ? { limit: pause.limit } : {}), reset_at: isoAt(untilMs), estimated: pause.estimated === true } };
  let slept = 0;
  const awake = keepAwake(ctx);
  try {
    for (;;) {
      if (stopRequested(ctx)) { runPatch(ctx, patch); return 'stopped'; }
      if (ctx.lock && !ctx.lock.owned()) throw new Error('the factory lock is no longer ours');
      const left = Math.min(untilMs - clock.now(), planned - slept);
      if (left <= 0) break;
      runPatch(ctx, patch);
      const ms = Math.min(30000, left);
      await clock.sleep(ms);
      slept += ms;
    }
  } finally { try { awake?.kill(); } catch { /* gone */ } }
  runPatch(ctx, { status: 'running', pause: null });
  return 'done';
}
// The run state of a wait. `factory run` owns the run state (errors propagate). `factory scenarios` (ctx.scenarioRun) writes only the
// state of its own waits, never over a run's stopped or paused state (ctx.scenarioRun.keep), and never fails because of it.
function runPatch(ctx, patch) {
  if (!ctx.scenarioRun) { updateRun(ctx.fh, ctx.key, patch); return; }
  if (ctx.scenarioRun.keep) return;
  try { updateRun(ctx.fh, ctx.key, patch); ctx.scenarioRun.wrote = true; } catch { /* the terminal lines are the record */ }
}
// A wait with its terminal line and the paused notification.
async function pauseFor(ctx, untilMs, pause) {
  ctx.out(`paused: ${pause.kind}${pause.limit ? ` ${pause.limit}` : ''} until ${isoAt(untilMs)}${pause.estimated ? ' (estimated)' : ''}`);
  tell(ctx, 'paused');
  return waitUntil(ctx, untilMs, pause);
}

// One author session: an empty directory under FACTORY_HOME/run/, no tools, the spec items passed by the driver.
async function authorOne(ctx, spec, bc) {
  const budget = enforceBudget(ctx, null, 'author');
  if (budget) return { status: 'error', kind: 'budget', budget };
  const canary = newCanary();
  const prompt = renderPrompt('scenario-author', { FEATURE_ID: spec.id, CANARY: canary, SPEC_SECTIONS: specSections(bc.criteria) });
  const runRoot = privateDir(path.join(privateDir(path.join(ctx.fh, 'run')), 'author'));
  const cwd = fs.mkdtempSync(path.join(runRoot, `${spec.id}-`));
  const home = ctx.deps.home || defaultHome(ctx.env);
  let r; let pgid = null;
  try {
    const settingsFile = materialiseSettings('author', { factoryHome: ctx.fh, home });
    const v = ctx.policy.verification;
    r = await (ctx.deps.runSession || runSession)({
      role: 'author', cwd, prompt, settingsFile, maxTurns: v.max_turns.author, timeoutS: v.session_timeout_s.author,
      ...(ctx.modelOverride || v.model.author ? { model: ctx.modelOverride || v.model.author } : {}), home, baseEnv: ctx.env,
      ...sessionStop(ctx),
      onSpawn: (x) => { try { ctx.lock.recordGroup(x.pgid); pgid = x.pgid; } catch { /* recorded best effort */ } },
    });
  } catch (e) {
    return { status: 'error', kind: e?.code === 'settings_unsafe' ? 'settings_unsafe' : 'environment' };
  } finally {
    // As for the builder session: the ended session's group leaves the lock (a later start would otherwise treat it as an orphan).
    if (pgid) try { ctx.lock.forgetGroup(pgid); } catch { /* kept: killed on the next start */ }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  if (r) recordUsage(ctx, usageEntry('author', r));
  const s = sessionResult(r, { status: 'done' });
  if (s.kind !== 'done') return { status: 'error', kind: s.kind, limit: s.limit, resetAt: s.resetAt, usage: usageEntry('author', r) };
  if (ctx.waits?.id === `author:${spec.id}`) ctx.waits = null;
  const scenarios = parseAuthorReply(r.result);
  if (!scenarios) return { status: 'invalid', problems: ['the author reply is not one JSON object with a scenarios array'], usage: usageEntry('author', r) };
  const doc = { feature: spec.id, criteria_hash: bc.hash, canary, scenarios };
  const lint = lintScenarios(doc, bc.criteria, bc.hash);
  if (!lint.ok) return { status: 'invalid', problems: lint.problems, usage: usageEntry('author', r) };
  return { status: 'ok', doc, usage: usageEntry('author', r) };
}

export async function cmdScenarios(ctx) {
  const { opt } = ctx.args;
  if (opt.approve !== undefined) return approveCmd(ctx, opt.approve, opt.by);
  const only = idList(opt.only);
  // A pending stop stops authoring too (its sessions would be aborted at once); only `factory run --continue` clears the flag.
  if (stopRequested(ctx)) refuse('a stop was requested for this repository (factory stop)', 'run "factory run --continue" to clear the stop and continue the run, then author scenarios');
  usagePreflight(ctx);
  // Run state: scenarios writes only the state of its own waits, and never over a stopped or paused run (Task 9).
  let prior = null;
  try { prior = readRun(ctx.fh, ctx.key); } catch { prior = { status: 'unreadable' }; }
  ctx.scenarioRun = { keep: !!prior && prior.status !== 'finished', wrote: false };
  const endRun = (status) => { if (ctx.scenarioRun.wrote) runPatch(ctx, { status, pause: null, ended_at: isoAt(ctx.deps.clock.now()) }); };
  const specs = baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir);
  for (const id of only) if (!specs.some((s) => s.id === id)) refuse(`--only names ${id}, which has no spec on origin/${ctx.base}`);
  const pick = specs.filter((s) => (only.length ? only.includes(s.id) : s.status === 'ready' && s.delivery !== 'complete'));
  const mode = ctx.policy.verification.scenario_approval;
  const counts = { stored: 0, current: 0, awaiting_approval: 0, invalid: 0, criteria_errors: 0, failed: 0 };
  let code = 0;
  for (let i = 0; i < pick.length; i++) {
    const spec = pick[i];
    const bc = baseCriteria(ctx.git, ctx.base, spec.rel);
    if (!bc || !bc.criteria.ok) { counts.criteria_errors++; ctx.out(`${spec.id} criteria: ${bc ? bc.criteria.errors.length : 1} error(s) in the base spec; fix the spec first`); code = 1; continue; }
    const now = scenarioState(ctx.key, spec.id, bc, mode);
    if (now.ok) { counts.current++; ctx.out(`${spec.id} scenarios: current and approved`); continue; }
    if (now.why === 'unapproved') { counts.awaiting_approval++; ctx.out(`${spec.id} scenarios: current, awaiting approval (factory scenarios --approve ${spec.id} --by <name>)`); continue; }
    const r = await authorOne(ctx, spec, bc);
    if (r.status === 'error') {
      ctx.out(`${spec.id} author session: ${r.kind}`);
      // Interrupted author sessions are restarted from scratch (no partial context) after the same wait; a stop ends the command.
      if (r.kind === 'usage_limit' || r.kind === 'budget') {
        if (await authorInterrupt(ctx, spec, r) === 'retry') { i--; continue; }
        endRun('stopped');
        return 2;
      }
      if (r.kind === 'stopped') { ctx.out('stopped: stop'); endRun('stopped'); return 2; } // factory stop during the author session
      counts.failed++;
      code = 1; continue;
    }
    if (r.status === 'invalid') { counts.invalid++; ctx.out(`${spec.id} scenarios rejected: ${r.problems.length} problem(s)`); for (const p of r.problems.slice(0, 50)) ctx.out(`  ${p}`); code = 1; continue; }
    const doc = mode === 'auto' ? approve(r.doc, 'auto') : r.doc;
    saveScenarios(ctx.key, spec.id, doc);
    if (mode === 'auto') { counts.stored++; ctx.out(`${spec.id} scenarios: stored (${doc.scenarios.length}), approved: auto`); } else { counts.awaiting_approval++; ctx.out(`${spec.id} scenarios: stored (${doc.scenarios.length}), awaiting approval (factory scenarios --approve ${spec.id} --by <name>)`); }
  }
  ctx.out(`scenarios: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  endRun('finished');
  return code;
}

// An author session hit by a usage limit or the day cap: 'retry' (after the wait, a model switch) or 'stop' (printed here).
async function authorInterrupt(ctx, spec, r) {
  const stopA = (kind, reason) => {
    ctx.out(`stopped: ${kind}`);
    ctx.out(`${kind === 'usage_limit' ? 'usage limit' : 'reason'}: ${clean(reason, 200)}`);
    addAttention(ctx.fh, ctx.key, { id: spec.id, kind, severity: 'high', what: clean(reason, 200), run: 'factory scenarios' });
    return 'stop';
  };
  if (r.kind === 'budget') {
    if (ctx.local.wait_for_reset !== true) return stopA('day_budget', 'the daily token cap is reached');
    return await pauseFor(ctx, nextMidnight(ctx), { kind: 'day_budget' }) === 'stopped' ? stopA('stop', 'a stop was requested during the wait') : 'retry';
  }
  const ws = waitState(ctx, `author:${spec.id}`);
  const route = routeLimit(ctx, r, ws);
  if (route.do === 'stop') return stopA('usage_limit', route.reason);
  if (route.do === 'switch_model') { ctx.modelOverride = route.model; ctx.out(`${spec.id} model limit: the next session uses fallback_model`); return 'retry'; }
  const res = await pauseFor(ctx, route.until, { kind: 'usage_limit', limit: r.limit, estimated: !!route.estimated });
  if (res === 'stopped') return stopA('stop', 'a stop was requested during the wait');
  route.commit();
  return 'retry';
}

function approveCmd(ctx, id, by) {
  if (!FEATURE_ID.test(String(id))) refuse('--approve needs a feature id like FEATURE-001');
  if (typeof by !== 'string' || !BY.test(by)) refuse('--approve needs --by <name> (1-64 characters of letters, digits, _ . @ -)');
  if (by === 'auto') refuse('--by auto is reserved for automatic approval (scenario_approval "auto"); give your own name');
  const spec = baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir).find((s) => s.id === id);
  if (!spec) refuse(`${id} has no spec on origin/${ctx.base}`);
  const bc = baseCriteria(ctx.git, ctx.base, spec.rel);
  const st = scenarioState(ctx.key, id, bc, ctx.policy.verification.scenario_approval);
  if (st.ok) { ctx.out(`${id} scenarios: already approved`); return 0; }
  if (st.why !== 'unapproved') refuse(`${id} has no current scenarios to approve (${st.why}${st.problems ? `: ${st.problems.length} problem(s)` : ''})`, `run "factory scenarios --only ${id}" first`);
  const { approved: _drop, ...doc } = st.doc;
  saveScenarios(ctx.key, id, approve(doc, by));
  ctx.out(`${id} scenarios: approved`);
  return 0;
}

// ---- run: start checks ----------------------------------------------------------------------------------------------------------------
const VERIFIED = 'factory/verified';
export function startChecks(ctx) {
  const p = ctx.policy; const fixes = []; const why = [];
  const need = (bad, w, fix) => { if (bad) { why.push(w); fixes.push(fix); } };
  need(p.verification.required !== true, 'verification.required is not true', `set "verification": { "required": true } in ${CONFIG_PATH} and merge it to ${ctx.base}`);
  need(!p.readiness || p.readiness.min_level < 4, 'the base config does not require readiness level 4', `set "readiness": { "min_level": 4 } in ${CONFIG_PATH} on ${ctx.base} (deliver init then re-checks the stored result)`);
  const rd = readJson(path.join(ctx.fh, 'readiness', `${ctx.key}.json`));
  const level = rd && Number.isInteger(rd.level) ? rd.level : null;
  need(!(level >= 4) || rd.base !== ctx.base, `the stored readiness result is ${level === null ? 'missing' : `level ${level}`}${rd && rd.base !== ctx.base ? ' for another base' : ''}, level 4 is required`, 'run "deliver readiness" in a checkout of the base branch and fix what it lists');
  need(p.local_checks.length > 0, 'local_checks are configured, and deliver built runs them outside the untrusted-code sandbox', 'run those checks in CI (checks.required) for factory runs, and set local_checks to []');
  const prot = requiredStatusChecks({ gh: (...a) => { const r = ctx.gh(a); return { code: r.code, out: r.out.trim(), err: r.err.trim() }; }, repo: ctx.id.repo, base: ctx.base });
  need(p.checks.required.some((n) => n.toLowerCase() === VERIFIED), `checks.required names ${VERIFIED}, which is posted only after CI passed`, `remove "${VERIFIED}" from checks.required (branch protection requires it at merge)`);
  need(prot.state !== 'found' || !prot.names.includes(VERIFIED), `branch protection on ${ctx.base} does not require the ${VERIFIED} status`, `require the "${VERIFIED}" status check in branch protection (or a ruleset) on ${ctx.base}; this needs a public repository or a plan with protected private branches`);
  if (why.length) refuse(`factory run needs: ${why.join('; ')}`, fixes);
  ctx.out(`warning: ${VERIFIED} is a plain commit status: anyone with status write access can post it; only a required check bound to an expected source (a GitHub App) prevents that`);
}

// Features without current approved scenarios (re-linted against the base criteria), as "<ID> (<why>)".
function missingScenarios(ctx, ids) {
  const specs = new Map(baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir).map((s) => [s.id, s]));
  const bad = [];
  for (const id of ids) {
    const s = specs.get(id);
    const st = s ? scenarioState(ctx.key, id, baseCriteria(ctx.git, ctx.base, s.rel), ctx.policy.verification.scenario_approval) : { ok: false, why: 'no base spec' };
    if (!st.ok) bad.push(`${id} (${st.why})`);
  }
  return bad;
}

// ---- run: queue, deliver, attention -------------------------------------------------------------------------------------------------
function readQueue(ctx) {
  const st = fs.lstatSync(ctx.queueFile);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('the queue file is not a regular file');
  const q = JSON.parse(fs.readFileSync(ctx.queueFile, 'utf8'));
  if (!q || !Array.isArray(q.features)) throw new Error('the queue file is invalid');
  return q;
}
const saveQueue = (ctx, q) => writeJsonAtomic(ctx.queueFile, q);
// Read-modify-write of one feature (after deliver saved its own changes).
function update(ctx, id, fn) { const q = readQueue(ctx); const f = q.features.find((x) => x.id === id); fn(f, q); saveQueue(ctx, q); return f; }

// deliver as a subprocess in the driver clone, the clone preflighted first (deliver's own git is plain git). FACTORY_DRIVER_PID
// lets the driver's own calls past deliver's interactive guard (a convenience guard against a person racing the driver, not a
// security control: anyone can set it).
const deliverEnv = (ctx) => ({ ...ctx.env, FACTORY_HOME: ctx.fh, DELIVER_QUEUE: ctx.queueFile, FACTORY_DRIVER_PID: String(process.pid) });
function deliver(ctx, ...args) {
  preflight(ctx.D, ctx.id.url);
  if (!ctx.lock.owned()) throw new Error('the factory lock is no longer ours');
  const r = run(process.execPath, [DELIVER, ...args, '--dir', ctx.D], { cwd: ctx.D, env: deliverEnv(ctx), timeout: 6 * 3600 * 1000 });
  return { code: r.code, json: json(r.out) };
}
// deliver for a long wait (the CI wait): spawned in its own process group (recorded in the lock, so a crashed driver's next start
// kills it), the stop flag polled every 5 s. A --now stop sends SIGTERM to the group and SIGKILL 10 s later -> { stopped: true }; a
// graceful stop lets it finish (the run stops before the next step). Otherwise { code, json } as deliver().
function deliverWatch(ctx, ...args) {
  preflight(ctx.D, ctx.id.url);
  if (!ctx.lock.owned()) throw new Error('the factory lock is no longer ours');
  return new Promise((resolve) => {
    let c;
    try { c = spawn(process.execPath, [DELIVER, ...args, '--dir', ctx.D], { cwd: ctx.D, env: deliverEnv(ctx), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { resolve({ code: 1, json: null }); return; }
    let out = ''; let stopped = false; let killT = null; let settled = false;
    const group = (sig) => { try { process.kill(-c.pid, sig); } catch { /* gone */ } };
    if (c.pid) try { ctx.lock.recordGroup(c.pid); } catch { /* recorded best effort */ }
    c.stdout.on('data', (d) => { if (out.length < 16 * 1024 * 1024) out += d; });
    c.stderr.on('data', () => { /* drained: deliver's errors are not driver output */ });
    const poll = setInterval(() => {
      if (stopped || stopRequested(ctx)?.now !== true) return;
      stopped = true;
      group('SIGTERM');
      killT = setTimeout(() => group('SIGKILL'), KILL_GRACE_MS);
    }, STOP_POLL_MS);
    const cap = setTimeout(() => group('SIGKILL'), 6 * 3600 * 1000);
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearInterval(poll); clearTimeout(cap); if (killT) clearTimeout(killT);
      // A killed wait: nothing of its group outlives the step (only while the group still has members: an empty pgid may be reused).
      if (stopped) { let members = false; try { process.kill(-c.pid, 0); members = true; } catch (e) { members = e?.code === 'EPERM'; } if (members) group('SIGKILL'); }
      if (c.pid) try { ctx.lock.forgetGroup(c.pid); } catch { /* kept: killed on the next start */ }
      resolve(stopped ? { stopped: true } : { code: code ?? 1, json: json(out) });
    };
    c.on('error', () => done(1));
    c.on('close', (code) => done(code));
  });
}
function attention(ctx, id, state, kind) {
  const once = `${id}\u0000${state}`;
  if ((ctx.attended ||= new Set()).has(once)) return;
  ctx.attended.add(once);
  ctx.attention++;
  ctx.out(`attention: ${id} ${state}${kind ? ` (${kind})` : ''}`);
  try {
    const dir = privateDir(path.join(ctx.fh, 'attention'));
    fs.appendFileSync(path.join(dir, `${ctx.key}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), feature: id, state, kind: kind || null })}\n`, { mode: 0o600 });
  } catch { /* the terminal line is the record of last resort */ }
}

// ---- run: builder clone -----------------------------------------------------------------------------------------------------------------
function builderRoot(ctx) {
  const root = path.resolve(ctx.deps.builderHome || ctx.env.FACTORY_BUILDER_HOME || `${ctx.fh}-builder`);
  const bad = (r) => within(r, ctx.fh) || within(ctx.fh, r);
  if (bad(root)) refuse('the builder directory must be outside FACTORY_HOME and must not contain it', 'unset FACTORY_BUILDER_HOME or point it elsewhere');
  privateDir(root);
  const real = fs.realpathSync(root);
  if (bad(real)) refuse('the builder directory resolves into FACTORY_HOME', 'point FACTORY_BUILDER_HOME at a real directory outside FACTORY_HOME');
  return real;
}
const survivors = (ctx, markers) => (ctx.deps.survivors || scanSurvivors)(markers);
// Every time, whether or not this process has touched the builder clone yet (a restart resuming at pr_open/ci_passed included).
const builderRun = (ctx) => path.join(ctx.bRoot, 'run', ctx.key);
function noLiveBuilder(ctx) { if (survivors(ctx, [path.join(ctx.bRoot, ctx.key), builderRun(ctx)]) > 0) throw new Leftover('a process from a builder session is still running'); }
const bExists = (ctx) => fs.existsSync(path.join(ctx.bRoot, ctx.key));
function ensureBuilder(ctx) {
  if (ctx.B) return ctx.B;
  const dir = path.join(ctx.bRoot, ctx.key);
  if (!fs.existsSync(dir)) {
    if (ctx.netGit(ctx.bRoot, ['clone', ctx.id.url, ctx.key]).code !== 0) throw new Error('cloning the builder clone failed');
    for (const [k, v] of [['user.name', 'factory-builder'], ['user.email', 'factory-builder@localhost'], ['gc.auto', '0']]) if (gitSafeOpts(dir, ['config', k, v]).code !== 0) throw new Error('configuring the builder clone failed');
  }
  const st = fs.lstatSync(dir); const g = fs.lstatSync(path.join(dir, '.git'));
  if (st.isSymbolicLink() || !st.isDirectory() || g.isSymbolicLink() || !g.isDirectory() || st.uid !== process.getuid()) throw new Error('the builder clone is not a plain clone owned by this user');
  ctx.B = dir;
  noLiveBuilder(ctx);
  // .implementation/ and .delivery/ are never committed (the builder's result and PR body), as in the driver clone.
  const info = path.join(dir, '.git', 'info');
  const ist = (() => { try { return fs.lstatSync(info); } catch { return null; } })();
  if (ist && (ist.isSymbolicLink() || !ist.isDirectory())) throw new Error('the builder clone .git/info is not a directory');
  if (!ist) fs.mkdirSync(info, { mode: 0o755 });
  const ex = path.join(info, 'exclude');
  const cur = (() => { try { const x = fs.lstatSync(ex); if (!x.isFile()) throw new Error('the builder clone exclude file is not a regular file'); return fs.readFileSync(ex, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } })();
  const add = ['.delivery/', '.implementation/'].filter((l) => !cur.split('\n').includes(l));
  if (add.length) fs.appendFileSync(ex, `${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  return dir;
}
const bGit = (ctx) => (...a) => gitSafeOpts(ctx.B, a);
function headOf(git, branch) { const r = git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`); const s = r.out.trim(); return r.code === 0 && SHA.test(s) ? s : null; }
const hasCommit = (git, sha) => SHA.test(String(sha)) && git('cat-file', '-e', `${sha}^{commit}`).code === 0;
const must = (r, what) => { if (r.code !== 0) throw new Error(`${what} failed`); return r; };
// Moves the commits of refs/heads/<branch> (at `sha`) from one clone to the other as a bundle file in FACTORY_HOME/tmp, made and
// applied by the driver with gitSafe. Never a fetch from the builder's repository (its config, hooks and upload-pack never run).
function transfer(ctx, from, to, branch, sha, exclude) {
  if (hasCommit(to, sha)) return;
  const file = path.join(privateDir(path.join(ctx.fh, 'tmp')), `xfer-${crypto.randomBytes(8).toString('hex')}.bundle`);
  try {
    const args = ['bundle', 'create', file, `refs/heads/${branch}`];
    if (exclude && exclude !== sha && hasCommit(to, exclude)) args.push(`^${exclude}`);
    must(from(...args), 'bundle create');
    must(to('bundle', 'unbundle', file), 'bundle unbundle');
    if (!hasCommit(to, sha)) throw new Error('the bundle did not carry the commit');
  } finally { fs.rmSync(file, { force: true }); }
}
// A builder-writable path component that is a symlink is unlinked (never followed); returns the real directory.
export function realSubdir(base, ...parts) {
  let d = base;
  for (const p of parts) {
    d = path.join(d, p);
    let st = null; try { st = fs.lstatSync(d); } catch { /* absent */ }
    if (st && !st.isDirectory()) { fs.unlinkSync(d); st = null; }
    if (!st) fs.mkdirSync(d, { mode: 0o755 });
  }
  return d;
}
function writeFresh(file, text) { try { fs.unlinkSync(file); } catch { /* absent */ } fs.writeFileSync(file, text, { flag: 'wx', mode: 0o644 }); }
// A builder-written file, read without following links: regular, one link, bounded. null otherwise.
export function readBuilderFile(file, max) {
  let fd;
  try {
    const lst = fs.lstatSync(file);
    if (!lst.isFile() || lst.nlink !== 1 || lst.size > max) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.ino !== lst.ino || st.nlink !== 1 || st.size > max) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// The driver clone's branch -> the builder clone (checked out, untracked non-ignored files removed, stale result deleted).
function toBuilder(ctx, f) {
  const dHead = headOf(ctx.git, f.branch);
  if (!dHead) throw new Error('the feature branch is missing in the driver clone');
  ensureBuilder(ctx); noLiveBuilder(ctx);
  const g = bGit(ctx);
  transfer(ctx, ctx.git, g, f.branch, dHead, f.base_sha);
  must(g('checkout', '-q', '-f', '-B', f.branch, dHead), 'checkout in the builder clone');
  must(g('clean', '-q', '-f', '-d'), 'clean in the builder clone');
  // Never let an earlier session's result stand for this one (the resume rule "ahead + done" reads it).
  const dir = realSubdir(ctx.B, '.implementation', f.id);
  fs.rmSync(path.join(dir, 'result.json'), { force: true });
  return dHead;
}
// The builder clone's branch -> the driver clone (checked out there for deliver). Returns the head, or null without a branch.
function toDriver(ctx, f) {
  if (!bExists(ctx)) return headOf(ctx.git, f.branch);
  ensureBuilder(ctx); noLiveBuilder(ctx);
  const bHead = headOf(bGit(ctx), f.branch);
  if (!bHead) return headOf(ctx.git, f.branch);
  transfer(ctx, bGit(ctx), ctx.git, f.branch, bHead, headOf(ctx.git, f.branch) || f.base_sha);
  // Checked on the commit BEFORE it is checked out in the driver clone: deliver (unsandboxed) writes .delivery/ and
  // .skill-runs/ there, so a committed symlink or file in those places could redirect its writes or overwrite run records.
  if (protectedEntries(ctx.git, bHead)) throw new Unsafe('the branch commits .delivery, .implementation or .skill-runs');
  const before = recordIds(ctx.D);
  must(ctx.git('checkout', '-q', '-f', '-B', f.branch, bHead), 'checkout in the driver clone');
  must(ctx.git('clean', '-q', '-f', '-d'), 'clean in the driver clone');
  if (recordIds(ctx.D) !== before) throw new Unsafe('the checkout replaced the run records');
  for (const n of DRIVER_OWNED) { try { if (fs.lstatSync(path.join(ctx.D, n)).isSymbolicLink()) throw new Unsafe('a driver-owned path is a symlink after checkout'); } catch (e) { if (e instanceof Unsafe) throw e; } }
  return bHead;
}
// Top-level names the driver and deliver write in the driver clone; a branch may not track anything there (any case: a
// case-insensitive volume maps .DELIVERY onto .delivery).
const DRIVER_OWNED = ['.delivery', '.implementation', '.skill-runs'];
function protectedEntries(git, sha) {
  const r = git('ls-tree', '--full-tree', '-z', sha);
  if (r.code !== 0) return true;
  return r.out.split('\0').filter(Boolean).some((l) => {
    const name = l.slice(l.indexOf('\t') + 1); // -z: never quoted; non-UTF-8 bytes decode to U+FFFD (also refused)
    // APFS folds case, Unicode case variants (U+017F folds to "s") and normalisation forms, so any dot entry that is not plain
    // printable ASCII may alias a driver-owned name: refused outright, with the exact (lower-cased) names.
    return DRIVER_OWNED.includes(name.toLowerCase()) || (name.startsWith('.') && /[^\x21-\x7e]/.test(name));
  });
}
// dev:ino of the run-record dir and file in the driver clone ('' when absent): compared around a checkout as a second layer.
const recordIds = (dir) => ['.skill-runs', '.skill-runs/factory-runs.jsonl'].map((p) => { try { const st = fs.lstatSync(path.join(dir, p)); return `${st.dev}:${st.ino}:${st.isSymbolicLink()}`; } catch { return ''; } }).join('|');
// A branch that would make the driver clone unsafe is blocked (building and fixing cannot wait for a person): the driver
// clone goes back to the base first, so deliver never runs on that tree.
function blockUnsafe(ctx, f) {
  must(ctx.git('checkout', '-q', '-f', '-B', ctx.base, OR(ctx.base)), 'checkout of the base branch');
  must(ctx.git('clean', '-q', '-f', '-d'), 'clean of the driver clone');
  deliver(ctx, 'block', f.id, '--reason', 'the branch tracks .delivery, .implementation or .skill-runs (or a symlink there): a person reviews it');
  return null;
}

// ---- run: builder sessions ------------------------------------------------------------------------------------------------------------
const specRel = (ctx, f) => {
  const rel = path.relative(ctx.D, String(f.file || '')).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.posix.basename(rel) !== `${f.id}.md` || /[\0\n]/.test(rel)) throw new Error('the feature spec path is not inside the driver clone');
  return rel;
};
const RESULT_TEXT = (id) => `At the end write .implementation/${id}/result.json: {"status":"done","summary":"..."} or {"status":"blocked","question":"..."}. Commit your work on the checked-out branch (never push, never open a pull request).`;
// Briefs (spec "Builder result"): build = id + spec path; CI fix = check names + bounded tail; symptom fix = the symptom brief only.
// An interrupted step (act.continue) gets the continue brief appended: feature id, step, continue from the branch and the ledger.
// Never `claude --resume`: the continued session starts fresh from what is committed.
function briefFor(ctx, f, act) {
  const b = baseBrief(ctx, f, act);
  if (act.continue) b.prompt = `${b.prompt}\n${renderPrompt('continue-brief', { FEATURE_ID: f.id, STEP: STEP_OF[f.state] || 'build' }).trim()}`;
  return b;
}
function baseBrief(ctx, f, act) {
  const rel = specRel(ctx, f);
  const head = `${f.id}: specification ${rel}.`;
  switch (act.brief) {
    case 'build': return { prompt: `Build ${head} Use the implementer skill, unattended. Put a short pull request description in .delivery/pr-${f.id}.md. ${RESULT_TEXT(f.id)}` };
    case 'local_fix': {
      const lines = (Array.isArray(f.local_failing) ? f.local_failing : []).slice(0, 10).map((x) => `- local check ${clean(x.name, 80)} failed: ${clean(x.tail, 400)}`);
      return { prompt: `Fix the local checks of ${head} Read the fix brief .implementation/${f.id}/fix-brief.md (implementer --fix-brief). ${RESULT_TEXT(f.id)}`, file: ['Local checks failed:', ...lines].join('\n') };
    }
    case 'antigaming_fix': {
      const ids = (act.ids || []).join(', ') || 'G2/G3';
      return { prompt: `Fix ${head} Anti-gaming checks ${ids} fired on the branch: remove added test skips or focused tests (G2) and stub markers in non-test code (G3), then commit. ${RESULT_TEXT(f.id)}`, file: `Anti-gaming checks fired: ${ids}` };
    }
    case 'ci_fix': {
      const names = (Array.isArray(f.ci_failing) ? f.ci_failing : []).slice(0, 20).map((n) => clean(n, 80)).filter(Boolean);
      const body = [`CI checks failing on the pull request: ${names.join(', ') || '(names not reported)'}`];
      return { prompt: `Fix CI for ${head} Read the fix brief .implementation/${f.id}/fix-brief.md (implementer --fix-brief). ${RESULT_TEXT(f.id)}`, file: body.join('\n') };
    }
    case 'symptom_fix': {
      const lines = symptomLines(ctx, f);
      return { prompt: `Fix ${head} Hidden verification failed:\n${lines.join('\n')}\nThe fix brief is .implementation/${f.id}/fix-brief.md (implementer --fix-brief). ${RESULT_TEXT(f.id)}`, file: lines.join('\n') };
    }
    default: throw new Error('unknown brief');
  }
}
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+', 'g');
function clean(s, max) { return String(s ?? '').replace(UNSAFE, ' ').trim().slice(0, max); }
// Task 9's symptom brief from the stored verdict (criterion IDs and one fixed sentence per line; nothing from the scenarios).
function symptomLines(ctx, f) {
  let lines = [];
  try {
    const doc = SHA.test(String(f.verdict_sha)) ? readVerdict(ctx.key, f.id, f.verdict_sha) : null;
    const sc = loadScenarios(ctx.key, f.id);
    if (doc && sc) lines = symptomBrief(doc.results.filter((r) => r.status !== 'pass' || r.flaky), sc, sc.canary);
  } catch { lines = []; }
  return lines.length ? lines : ['behaviour does not satisfy the acceptance criteria'];
}
const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
function tierOf(ctx, f) {
  const t = json(readBuilderFile(path.join(ctx.B || path.join(ctx.bRoot, ctx.key), '.implementation', f.id.toLowerCase(), 'tasks.json'), 64 * 1024) || 'null')?.tier;
  return t in RANK && RANK[t] > RANK.T2 ? t : 'T2'; // the ledger can only raise the tier
}

async function builderSession(ctx, f, act) {
  // Before anything touches the branch or the counters: a budget hit starts no session (the interrupt action holds or stops).
  const budget = enforceBudget(ctx, f, 'builder');
  if (budget) return budget;
  if (act.continue) {
    // An interrupted step continues from the builder clone's branch (its WIP commit included): moved to the driver clone first,
    // so toBuilder below checks out exactly that head. Never a reset.
    // Uncommitted edits still in the builder clone (an earlier WIP commit failed) are committed first: toBuilder's forced
    // checkout would otherwise drop them.
    if (bExists(ctx)) {
      keepWork(ctx, f, typeof f.interrupted?.kind === 'string' ? f.interrupted.kind : 'other');
      try { toDriver(ctx, f); } catch (e) { if (e instanceof Unsafe) return blockUnsafe(ctx, f); throw e; }
    }
  } else if (act.brief === 'build') { // a fresh build (or a reset on resume) starts from the base commit in both clones
    must(ctx.git('checkout', '-q', '-f', '-B', f.branch, f.base_sha), 'reset of the feature branch');
  }
  if (act.brief === 'antigaming_fix') update(ctx, f.id, (x) => { x.ag_fix_attempts = (x.ag_fix_attempts ?? 0) + 1; });
  toBuilder(ctx, f);
  const brief = briefFor(ctx, f, act);
  const dir = realSubdir(ctx.B, '.implementation', f.id);
  if (brief.file !== undefined) writeFresh(path.join(dir, 'fix-brief.md'), `${brief.file}\n`); else fs.rmSync(path.join(dir, 'fix-brief.md'), { force: true });
  privateDir(path.join(ctx.bRoot, 'run'));
  const runDir = fs.mkdtempSync(path.join(privateDir(builderRun(ctx)), `${f.id}-`));
  const tmpDir = path.join(runDir, 'tmp'); fs.mkdirSync(tmpDir, { mode: 0o700 });
  const home = ctx.deps.home || defaultHome(ctx.env);
  const v = ctx.policy.verification;
  let r; let pgid = null;
  try {
    let settingsFile;
    try { settingsFile = materialiseSettings('builder', { factoryHome: ctx.fh, repoDir: ctx.B, home, runDir }); } catch (e) { if (e?.code === 'settings_unsafe') return { step: 'session', kind: 'settings_unsafe', keys: ['settings'] }; throw e; }
    r = await (ctx.deps.runSession || runSession)({
      role: 'builder', cwd: ctx.B, prompt: brief.prompt, settingsFile, maxTurns: v.max_turns.builder, timeoutS: v.session_timeout_s.builder,
      ...(ctx.modelOverride || v.model.builder ? { model: ctx.modelOverride || v.model.builder } : {}), home, tmpDir, baseEnv: ctx.env,
      ...sessionStop(ctx),
      onSpawn: (x) => { pgid = x.pgid; ctx.lock.recordGroup(x.pgid); },
    });
  } finally { if (pgid) try { ctx.lock.forgetGroup(pgid); } catch { /* kept: killed on the next start */ } }
  // A stopped session's group is gone; what it started outside the group (a setsid daemon, an app) goes too before the checks.
  if (r?.failure?.kind === 'stopped') await killLeftovers(ctx);
  const entry = usageEntry('builder', r);
  update(ctx, f.id, (x) => { (x.sessions ||= []).push(entry); });
  recordUsage(ctx, entry);
  noLiveBuilder(ctx);
  fs.rmSync(runDir, { recursive: true, force: true });
  const res = sessionResult(r, readBuilderResult(ctx.B, f.id));
  // A session that ended without an interruption ends the interrupted step: the record and the crash-resume count of an
  // interrupted feature go, and so does the wait already spent on it.
  if (!INTERRUPT_KINDS.has(res.kind)) {
    update(ctx, f.id, (x) => { delete x.interrupted; if (x.interrupted_resumes !== undefined) x.interrupted_resumes = 0; });
    if (ctx.waits?.id === f.id) ctx.waits = null;
  }
  return res;
}
const INTERRUPT_KINDS = new Set(['usage_limit', 'timeout', 'stopped', 'budget']);
const STEP_OF = { building: 'build', fixing: 'fix' };

// wipCommit(ctx, f, kind) -> { committed, head }: the interrupted session's uncommitted work, committed on the feature branch in the
// builder clone with the hook-free gitSafe wrapper as "wip(<ID>): interrupted (<kind>)". Driver-owned paths (.implementation,
// .delivery, .skill-runs) are never staged; with nothing else to stage there is no commit (and no error). Only after noLiveBuilder.
// A builder that left HEAD on another branch gets no commit (its edits are not on the feature branch to keep).
export function wipCommit(ctx, f, kind) {
  if (!bExists(ctx)) return { committed: false, head: null };
  ensureBuilder(ctx); noLiveBuilder(ctx);
  const g = bGit(ctx);
  const head = headOf(g, f.branch);
  const sym = g('symbolic-ref', '-q', 'HEAD');
  if (!head || sym.code !== 0 || sym.out.trim() !== `refs/heads/${f.branch}`) return { committed: false, head };
  const spec = ['--', '.', ...DRIVER_OWNED.map((n) => `:(exclude)${n}`)];
  // add -A -- . (an exclude pathspec on add fails on the ignored .implementation/); the excludes apply to the check and the commit.
  must(g('add', '-A', '--', '.'), 'staging the interrupted work');
  const d = g('diff', '--cached', '--quiet', ...spec);
  if (d.code === 0) return { committed: false, head };
  if (d.code !== 1) throw new Error('checking the staged interrupted work failed');
  // The pathspec again on the commit: a path the builder itself staged under .implementation/ is not committed either.
  must(g('commit', '-q', '--no-verify', '-m', `wip(${f.id}): interrupted (${/^[a-z_]{1,32}$/.test(String(kind)) ? kind : 'other'})`, ...spec), 'the WIP commit');
  g('reset', '-q', '--', ...DRIVER_OWNED); // unstage driver-owned paths `add -A` picked up (never committed); failure tolerated
  return { committed: true, head: headOf(g, f.branch) };
}
// wipCommit for the interruption paths: any failure but a live builder process is a WipFailed (the run stops, nothing is reset).
function keepWork(ctx, f, kind) {
  try { return wipCommit(ctx, f, kind); } catch (e) { if (e instanceof Leftover) throw e; throw new WipFailed(e?.message || 'the WIP commit failed'); }
}

// ---- run: steps -----------------------------------------------------------------------------------------------------------------------
function specPaths(ctx, own) {
  return [...new Set([...baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir).map((s) => s.rel), own])];
}
function stepBuilt(ctx, f) {
  let head;
  try { head = toDriver(ctx, f); } catch (e) { if (e instanceof Unsafe) return blockUnsafe(ctx, f); throw e; }
  if (!head) return { step: 'built', kind: 'error' };
  // Anti-gaming at built: every built run overwrites the hold (a hold of an earlier built sha never carries over).
  let hits;
  try { hits = checkDiff({ git: (...a) => gitSafeOpts(ctx.D, a), baseRef: OR(ctx.base), headSha: head, config: ctx.policy, specPaths: specPaths(ctx, specRel(ctx, f)) }); } catch { update(ctx, f.id, (x) => { delete x.antigaming_hold; }); return { step: 'built', kind: 'error' }; }
  const cls = classify(hits, 'built');
  const ids = holdReason(hits)?.ids || [];
  update(ctx, f.id, (x) => {
    delete x.antigaming_hold;
    if (ids.length) x.antigaming = [...new Set([...(x.antigaming || []), ...ids])].sort();
    if (cls === 'hold') x.antigaming_hold = { sha: head, ids };
  });
  if (cls === 'fix') return { step: 'antigaming', kind: 'fix', ids };
  const d = deliver(ctx, 'built', f.id, '--tier', tierOf(ctx, f));
  if (d.code === 0) return { step: 'built', kind: 'ok' };
  if (d.code === 2 && d.json?.result === 'local_check_failed' && d.json?.state === 'building') {
    update(ctx, f.id, (x) => { x.local_failing = (d.json.failing || []).slice(0, 10).map((y) => ({ name: clean(y.name, 80), tail: clean(y.tail, 400) })); });
    return { step: 'built', kind: 'local_check_failed' };
  }
  return d.code === 2 ? null : { step: 'built', kind: 'error' };
}
function stepPr(ctx, f) {
  const text = ctx.B ? readBuilderFile(path.join(ctx.B, '.delivery', `pr-${f.id}.md`), 60000) : null;
  const dir = realSubdir(ctx.D, '.delivery');
  const file = path.join(dir, `pr-${f.id}.md`);
  writeFresh(file, text && text.trim() ? text : `Factory delivery of ${f.id}. Hidden verification runs before merge.\n`);
  const title = clean(`${f.id}: ${f.title || ''}`, 120);
  const d = deliver(ctx, 'pr', f.id, '--title', title, '--body-file', file);
  return d.code === 0 ? { step: 'pr', kind: 'ok' } : { step: 'pr', kind: 'error' };
}
async function stepCi(ctx, f, act) {
  if (act.reopen && (f.state === 'ci_passed' || f.state === 'verified')) update(ctx, f.id, (x) => transition(x, 'pr_open', 'head moved or verdict stale: CI and verification again'));
  const d = await deliverWatch(ctx, 'ci', f.id, ...(ctx.deps.ciArgs || []));
  if (d.stopped) return { step: 'ci', kind: 'stopped' };
  const res = d.json?.result;
  if (d.code === 0 && (res === 'passed' || res === 'unverified-allowed')) return { step: 'ci', kind: res };
  if (d.code === 2) {
    const st = readQueue(ctx).features.find((x) => x.id === f.id).state;
    if (st === 'blocked') return null;
    if (res === 'failed') { update(ctx, f.id, (x) => { x.ci_failing = (d.json.failing || []).map((c) => clean(c.name, 80)).slice(0, 20); }); return { step: 'ci', kind: 'failed' }; }
    if (res === 'timeout' || res === 'unconfirmed') return { step: 'ci', kind: res };
  }
  return { step: 'ci', kind: 'error' };
}
function stepFix(ctx, f, act) {
  if (act.do === 'fix_verify' && f.state === 'ci_passed') update(ctx, f.id, (x) => transition(x, 'verify_failed', 'hidden verification failed'));
  const d = deliver(ctx, 'fix', f.id);
  if (d.code === 0) return { step: 'fix', kind: 'ok' };
  return d.code === 2 ? null : { step: 'fix', kind: 'error' };
}
function stepPush(ctx, f) {
  try { toDriver(ctx, f); } catch (e) { if (e instanceof Unsafe) return blockUnsafe(ctx, f); throw e; }
  const d = deliver(ctx, 'push', f.id);
  return d.code === 0 ? { step: 'push', kind: 'ok' } : { step: 'push', kind: 'error' };
}
async function stepVerify(ctx, f) {
  noLiveBuilder(ctx); // spec P1.2: no builder process may still run when verification starts
  const spec = baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir).find((s) => s.id === f.id);
  const bc = spec ? baseCriteria(ctx.git, ctx.base, spec.rel) : null;
  const st = scenarioState(ctx.key, f.id, bc, ctx.policy.verification.scenario_approval);
  if (!st.ok || !SHA.test(String(f.ci_sha))) return { step: 'verify', kind: 'threw' };
  const t0 = Date.now();
  let r = null; let threw = false;
  try {
    r = await (ctx.deps.verifyFeature || verifyFeature)({ repoKey: ctx.key, id: f.id, sha: f.ci_sha, baseRef: OR(ctx.base), config: ctx.policy, scenarios: st.doc, criteriaHash: bc.hash, git: (...a) => gitSafeOpts(ctx.D, a) }, verifySeamsFor(ctx));
  } catch { threw = true; }
  const ok = !threw && (r?.verdict === 'pass' || r?.verdict === 'fail');
  const failedIds = ok && r.verdict === 'fail' ? (r.doc?.results || []).filter((x) => x.status !== 'pass' || x.flaky).flatMap((x) => x.covers) : [];
  update(ctx, f.id, (x) => {
    x.verify_runs = (x.verify_runs ?? 0) + 1; x.verify_ms = (x.verify_ms ?? 0) + (Date.now() - t0);
    if (ok) { x.verdict = r.verdict; x.verdict_sha = f.ci_sha; }
    if (failedIds.length) x.gap_criteria = [...new Set([...(x.gap_criteria || []), ...failedIds])].sort(); // CI passed, verification failed
  });
  if (!ok) return { step: 'verify', kind: 'threw' };
  return { step: 'verify', kind: r.verdict };
}
function stepVerified(ctx, q, f) {
  try {
    const doc = readVerdict(ctx.key, f.id, f.ci_sha);
    if (!doc || doc.verdict !== 'pass' || repoKey(q.repo) !== ctx.key) return { step: 'verified', kind: 'error' };
    // repoKey from q.repo: the same derivation deliver merge uses for the verdict it checks.
    postVerified({ gh: (...a) => ctx.gh(a), repo: q.repo, sha: f.ci_sha, n: doc.results.length, pr: f.pr.number, doc, repoKey: repoKey(q.repo), id: f.id });
  } catch { return { step: 'verified', kind: 'error' }; }
  update(ctx, f.id, (x) => transition(x, 'verified'));
  return { step: 'verified', kind: 'ok' };
}
function stepMerge(ctx, f) {
  const d = deliver(ctx, 'merge', f.id);
  if (d.code === 0) return { step: 'merge', kind: 'merged' };
  if (d.code === 2) {
    if (d.json?.result === 'stale' || d.json?.result === 'updated') return { step: 'merge', kind: d.json.result };
    const st = readQueue(ctx).features.find((x) => x.id === f.id).state;
    if (st === 'awaiting_human') return { step: 'merge', kind: 'held' };
    return null;
  }
  return { step: 'merge', kind: 'error' };
}

// ---- run: resume facts --------------------------------------------------------------------------------------------------------------
async function resumeFacts(ctx, f) {
  const facts = { orphans_alive: ctx.orphansAlive, leftover_worktrees: ctx.leftovers, resumes: Number.isInteger(f.resumes) ? f.resumes : 0 };
  if (f.state === 'building' || f.state === 'fixing') {
    if (!bExists(ctx)) return { ...facts, branch_exists: false, dirty: false, result: 'absent', head: null };
    try { ensureBuilder(ctx); } catch (e) { if (e instanceof Leftover) return { ...facts, orphans_alive: facts.orphans_alive + 1 }; throw e; }
    const g = bGit(ctx);
    const head = headOf(g, f.branch);
    const ahead = head && SHA.test(String(f.base_sha)) ? Number(g('rev-list', '--count', `${f.base_sha}..${head}`).out.trim()) : 0;
    // deliver built's clean-tree check, exactly: .implementation/ and .delivery/ never count.
    const st = g('status', '--porcelain', '--', '.', ':(exclude).implementation', ':(exclude).delivery');
    const file = path.join(ctx.B, '.implementation', f.id, 'result.json');
    const present = (() => { try { fs.lstatSync(file); return true; } catch { return false; } })();
    return { ...facts, branch_exists: !!head, head, ahead: Number.isInteger(ahead) ? ahead : 0, dirty: st.code !== 0 || st.out.trim() !== '', result: present ? readBuilderResult(ctx.B, f.id).status : 'absent' };
  }
  if (f.state === 'built') { const head = headOf(ctx.git, f.branch); return { ...facts, branch_exists: !!head, head }; }
  if (['pr_open', 'ci_passed', 'verified'].includes(f.state)) {
    const v = f.pr ? ctx.gh(['pr', 'view', String(f.pr.number), '--json', 'state,headRefOid']) : { code: 1 };
    const o = v.code === 0 ? json(v.out) : null;
    const prHead = o && o.state === 'OPEN' && SHA.test(String(o.headRefOid)) ? o.headRefOid : null;
    const out = { ...facts, pr_exists: !!prHead, pr_head: prHead };
    if (f.state !== 'pr_open') out.verdict = prHead ? verdictFact(ctx, f, prHead) : 'absent';
    return out;
  }
  return facts;
}
function verdictFact(ctx, f, sha) {
  const vd = readVerdict(ctx.key, f.id, sha);
  if (!vd) return 'absent';
  const spec = baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir).find((s) => s.id === f.id);
  const bc = spec ? baseCriteria(ctx.git, ctx.base, spec.rel) : null;
  let doc; try { doc = loadScenarios(ctx.key, f.id); } catch { doc = null; }
  if (!bc || !doc) return 'mismatch';
  const want = { sha, scenariosHash: scenariosHash(doc), criteriaHash: bc.hash };
  if (verdictMatches(vd, want)) return 'pass';
  return vd.verdict === 'fail' && vd.scenarios_hash === want.scenariosHash && vd.criteria_hash === want.criteriaHash ? 'fail' : 'mismatch';
}

// ---- run: start sweeps --------------------------------------------------------------------------------------------------------------
// Orphan process groups from the dead holder are killed; FACTORY_HOME/trash is emptied; leftover verification worktrees of this
// repository and kept run temps are removed only when no process still carries their path (otherwise they count as leftovers and the
// run stops). Run temps are shared by all repositories, so they are swept only when no other factory lock exists.
function sweep(ctx) {
  try { ctx.lock.killOrphans(); } catch { /* counted below */ }
  ctx.orphansAlive = ctx.lock.orphans().length;
  const plain = (d) => { try { const st = fs.lstatSync(d); return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid(); } catch { return false; } };
  const trash = path.join(ctx.fh, 'trash');
  if (plain(trash)) for (const n of fs.readdirSync(trash)) fs.rmSync(path.join(trash, n), { recursive: true, force: true });
  let left = 0;
  const work = path.join(ctx.fh, 'work', ctx.key);
  if (plain(work)) {
    let moved = false;
    for (const n of fs.readdirSync(work)) {
      const d = path.join(work, n);
      if (survivors(ctx, [d]) > 0) { left++; continue; }
      const q = path.join(privateDir(trash), crypto.randomBytes(12).toString('hex'));
      try { fs.renameSync(d, q); moved = true; fs.rmSync(q, { recursive: true, force: true }); } catch { left++; }
    }
    if (moved && ctx.git('worktree', 'prune').code !== 0) left++;
  }
  const tmp = path.join(ctx.fh, 'tmp');
  const others = (() => { try { return fs.readdirSync(path.join(ctx.fh, 'locks')).filter((n) => n.endsWith('.lock') && n !== `${ctx.key}.lock`).length; } catch { return 0; } })();
  if (plain(tmp) && others === 0) for (const n of fs.readdirSync(tmp)) { const d = path.join(tmp, n); if (survivors(ctx, [d]) > 0) left++; else fs.rmSync(d, { recursive: true, force: true }); }
  ctx.leftovers = left;
}

// ---- run: the loop ------------------------------------------------------------------------------------------------------------------
const TERMINAL = ['merged', 'skipped', 'blocked'];
// P2.2: a hard stop proven only by the isolation probe is unproven until a saved probe result ($FACTORY_HOME/probes/last.json)
// for these builder settings, this FACTORY_HOME and (secrets) every credential class shows its routes denied. Each unproven row
// is printed with the reason and recorded as one attention row; the run is not blocked by it.
function reportHardStops(ctx) {
  const result = loadProbeResult(ctx.fh);
  const opts = { factoryHome: ctx.fh, builderSha: builderSettingsSha(), home: defaultHome(ctx.env) };
  const rows = HARD_STOPS.map((r) => ({ ...r, why: whyUnproven(r, result, opts) })).filter((r) => r.why !== null);
  for (const r of rows) ctx.out(`unproven hard stop: ${r.id} ${r.name} (${r.why})`);
  const item = { id: 'probe', kind: 'unproven_hardstop' };
  const what = `unproven hard stops: ${rows.map((r) => r.id).join(', ')}`;
  if (rows.length && listAttention(ctx.fh, ctx.key).some((i) => i.id === item.id && i.kind === item.kind && i.what === what)) return;
  resolveAttention(ctx.fh, ctx.key, item); // the row always names the current set
  if (rows.length) addAttention(ctx.fh, ctx.key, { ...item, severity: 'medium', what, run: PROBE_RUN });
}

export async function cmdRun(ctx) {
  const { opt } = ctx.args;
  const only = idList(opt.only);
  if (opt.limit !== undefined && !(Number.isInteger(Number(opt.limit)) && Number(opt.limit) >= 1 && Number(opt.limit) <= 1000)) refuse('--limit must be an integer 1-1000');
  // A stop flag left by `factory stop` (the run it stopped, or one that was not running) is never cleared silently.
  if (stopRequested(ctx) && !opt.continue) refuse('a stop was requested for this repository (factory stop)', 'run "factory run --continue" to clear the stop and continue the same run');
  startChecks(ctx);
  if (ctx.local.budgets.day_tokens === null) ctx.out('warning: no daily token cap is set (budgets.day_tokens in ~/.factory/config.json)');
  reportHardStops(ctx);
  usagePreflight(ctx);
  let saved;
  try { saved = readRun(ctx.fh, ctx.key); } catch (e) { if (e instanceof RunStateError) refuse(e.message, 'fix or remove that file by hand (it is the run state), then run again'); throw e; }
  ctx.queueFile = path.join(privateDir(path.join(ctx.fh, 'queues')), `${ctx.key}.json`);
  ctx.bRoot = builderRoot(ctx);
  ctx.attention = 0;
  sweep(ctx);
  let q = fs.existsSync(ctx.queueFile) ? readQueue(ctx) : null;
  if (q && (q.repo !== ctx.id.repo || q.base !== ctx.base)) refuse('the stored queue is for another repository or base', `DELIVER_QUEUE=${ctx.queueFile} node deliver.mjs reset --yes`);
  const resuming = q && q.features.some((f) => !['merged', 'skipped'].includes(f.state));
  // Before anything is written (no checkout, no deliver init): a raise needs a run in progress.
  if (opt['raise-budget'] !== undefined && !resuming) refuse('--raise-budget needs a run in progress: no feature is held for a budget');
  const alive = ctx.orphansAlive > 0 || ctx.leftovers > 0;
  const aliveWhy = `processes or worktrees from an earlier run are still alive (${ctx.orphansAlive} process group(s), ${ctx.leftovers} directory(ies))`;
  const aliveFix = 'stop them (see FACTORY_HOME/work and FACTORY_HOME/tmp), then run again';
  if (!resuming && alive) refuse(aliveWhy, aliveFix);
  // A queue in progress, whatever its states (queued, blocked and awaiting_human included): nothing runs (no deliver next, no
  // session) while something from the earlier run may still act. The run stops with the feature states left as they are.
  if (resuming && alive) {
    const active = q.features.find((f) => ACTIVE.includes(f.state));
    if (active) attention(ctx, active.id, active.state, 'leftovers');
    ctx.out(`stopped: leftovers: ${aliveWhy}`);
    ctx.out(`fix: ${aliveFix}`);
    return finish(ctx, 2);
  }
  if (!resuming) {
    must(ctx.git('checkout', '-q', '-f', '-B', ctx.base, OR(ctx.base)), 'checkout of the base branch');
    must(ctx.git('clean', '-q', '-f', '-d'), 'clean of the driver clone');
    let picked;
    try { picked = buildQueue(discover(path.join(ctx.D, ctx.policy.features_dir)), { only, limit: opt.limit ? Number(opt.limit) : 0 }); } catch (e) { refuse(`the feature queue cannot be built: ${e.message.slice(0, 120)}`); }
    const bad = missingScenarios(ctx, picked.map((f) => f.id));
    if (bad.length) refuse(`features without current approved scenarios: ${bad.join(', ')}`, 'run "factory scenarios" (and approve them when scenario_approval is human)');
    const d = deliver(ctx, 'init', ...(only.length ? ['--only', only.join(',')] : []), ...(opt.limit ? ['--limit', String(opt.limit)] : []));
    if (d.code !== 0) refuse('deliver init refused (readiness gate, config or repository checks)', `run "DELIVER_QUEUE=${ctx.queueFile} node deliver.mjs init --dir ${ctx.D} --dry-run" to see why`);
    if (!fs.existsSync(ctx.queueFile)) { ctx.out('no feature is ready'); return 0; }
  } else {
    if (only.length || opt.limit) ctx.out('note: a run is in progress; --only and --limit apply to a new run only');
    // Every refusal comes before the raise changes anything: the raised feature is checked as the active feature it will become.
    const raise = opt['raise-budget'] !== undefined ? planRaise(ctx, opt['raise-budget']) : null;
    for (const f of q.features.filter((x) => !TERMINAL.includes(x.state))) {
      try { featureCaps(ctx, f); } catch (e) { refuse(`${e.message}`, `fix budget_cap of ${f.id} in ${ctx.queueFile} (or run "factory run --raise-budget ${f.id}")`); }
    }
    const bad = missingScenarios(ctx, q.features.filter((f) => f.state === 'queued' || ACTIVE.includes(f.state) || f.id === raise?.id).map((f) => f.id));
    if (bad.length) refuse(`features without current approved scenarios: ${bad.join(', ')}`, 'run "factory scenarios" (and approve them), then run again');
    if (raise) applyRaise(ctx, raise);
  }
  if (opt.continue && fs.existsSync(STOP_FLAG(ctx))) { fs.rmSync(STOP_FLAG(ctx), { force: true }); ctx.out('continue: the stop request is cleared'); }
  updateRun(ctx.fh, ctx.key, { status: 'running', pause: null, reason: null, current: null, started_at: isoAt(ctx.deps.clock.now()), pid: process.pid });
  // A run stopped during a wait continues by finishing that wait (its saved reset time) before the interrupted step runs again, so
  // the first continued session does not hit the same limit.
  const until = opt.continue && saved && ['stopped', 'paused'].includes(saved.status) ? Date.parse(saved.pause?.reset_at) : NaN;
  if (Number.isFinite(until) && until > ctx.deps.clock.now()) {
    const p = saved.pause;
    if (await pauseFor(ctx, until, { kind: typeof p.kind === 'string' ? p.kind : 'usage_limit', ...(typeof p.limit === 'string' ? { limit: p.limit } : {}), estimated: p.estimated === true }) === 'stopped') {
      return finish(ctx, stopRun(ctx, null, 'stop', 'a stop was requested during the wait').end);
    }
  }
  return loop(ctx);
}

// --raise-budget ID[=TOKENS]: a feature parked by its budget (awaiting_human, hold kind budget) gets a raised cap (f.budget_cap) and
// goes back to the step it was parked in (deliver unhold --to <budget_hold.from>), marked interrupted, so the run continues it from
// the branch. Bare ID: the base policy's caps once more (the first raise doubles them); ID=N: the token cap is N, turns unchanged.
// planRaise only checks (it refuses, with the queue unchanged, for any other feature or a cap that would not help); applyRaise writes.
function planRaise(ctx, spec) {
  const m = /^(FEATURE-\d+)(?:=([1-9]\d{0,11}))?$/.exec(String(spec));
  if (!m) refuse('--raise-budget takes FEATURE-ID or FEATURE-ID=TOKENS (a positive integer)');
  const f = readQueue(ctx).features.find((x) => x.id === m[1]);
  if (!f) refuse(`${m[1]} is not in the queue`);
  if (f.state !== 'awaiting_human' || f.hold_kind !== 'budget') refuse(`${f.id} is not held for a budget (state ${f.state}${f.hold_kind ? `, hold ${clean(f.hold_kind, 32)}` : ''})`, 'only a feature parked by its budget can be raised (factory status lists them)');
  const from = f.budget_hold?.from;
  if (from !== 'building' && from !== 'fixing') refuse(`${f.id} has no building or fixing budget hold recorded`);
  let orig; let cur;
  try { orig = featureCaps(ctx, null); cur = featureCaps(ctx, f); } catch (e) { refuse(e.message, `fix the budget caps (budgets.feature in ${CONFIG_PATH}, budget_cap of ${f.id})`); }
  const caps = m[2] !== undefined ? { tokens: Number(m[2]), turns: cur.turns } : { tokens: cur.tokens + orig.tokens, turns: cur.turns + orig.turns };
  const used = featureUsage(f);
  const what = `the raised cap of ${f.id} (tokens ${caps.tokens}, turns ${caps.turns}) is not above what it used (tokens ${used.tokens}, turns ${used.turns})`;
  // =N changes tokens only: when turns is the spent dimension only the bare form (which raises both) can help.
  if (caps.turns <= used.turns) refuse(what, `raise both caps: factory run --raise-budget ${f.id}`);
  if (caps.tokens <= used.tokens) refuse(what, `pass a larger cap: factory run --raise-budget ${f.id}=<tokens>, or factory run --raise-budget ${f.id}`);
  return { id: f.id, from, caps };
}
function applyRaise(ctx, { id, from, caps }) {
  const d = deliver(ctx, 'unhold', id, '--to', from);
  if (d.code !== 0 || readQueue(ctx).features.find((x) => x.id === id)?.state !== from) refuse(`deliver unhold ${id} failed`, `run "DELIVER_QUEUE=${ctx.queueFile} node deliver.mjs status" to see the feature`);
  update(ctx, id, (x) => { x.budget_cap = caps; });
  try { resolveAttention(ctx.fh, ctx.key, { id, kind: 'budget' }); } catch { /* the row stays: harmless */ }
  ctx.out(`${id} budget raised: tokens ${caps.tokens}, turns ${caps.turns}; continuing at ${from}`);
}

async function loop(ctx) {
  let cur = null; let last = null; let replay = null;
  ctx.resumed = new Set();
  for (let guard = 0; guard < 100000; guard++) {
    const q = readQueue(ctx);
    const runInfo = { max_fix_rounds: q.max_fix_rounds, stop: runStop(q) };
    let f = cur ? q.features.find((x) => x.id === cur) : null;
    let act;
    if (f && replay) { act = replay; replay = null; } else if (!f) {
      const active = q.features.find((x) => ACTIVE.includes(x.state));
      if (active) { // a feature left active by an earlier (crashed or stopped) run: the restart rules decide, once
        f = active; cur = f.id; last = null;
        let facts;
        try { facts = await resumeFacts(ctx, f); } catch (e) {
          attention(ctx, f.id, f.state, e instanceof Leftover ? 'leftovers' : 'resume_error');
          ctx.out(`stopped: ${e instanceof Leftover ? 'leftovers' : 'resume_error'}`);
          return finish(ctx, 2);
        }
        // An interrupted step (f.interrupted) is not a crash and is not counted in f.resumes (resumeAction does not cap it). A
        // driver that keeps dying while it continues one would loop forever, so those resumes have their own count and cap.
        const interrupted = Object.hasOwn(STEP_OF, f.state) && f.interrupted !== undefined && f.interrupted !== null;
        const ir = Number.isInteger(f.interrupted_resumes) && f.interrupted_resumes >= 0 ? f.interrupted_resumes : 0;
        act = interrupted && ir >= MAX_RESUMES
          ? { do: 'hold', kind: 'resume_loop', reason: `the interrupted step was resumed ${ir} times already: a person looks at it`, attention: true }
          : resumeAction(f, facts, runInfo);
        // Counted before the resumed work starts; a run that then ends through finish() (any stop, hold or end: not a crash)
        // takes it back. Only runs that die (no finish) accumulate. The resume_loop stop itself neither counts nor resets.
        if (act.kind !== 'resume_loop') {
          update(ctx, f.id, (x) => { if (interrupted) x.interrupted_resumes = ir + 1; else x.resumes = (Number.isInteger(x.resumes) ? x.resumes : 0) + 1; });
          ctx.resumed.add(f.id);
        }
      } else act = runInfo.stop ? { do: 'stop', kind: 'run_stop', reason: runInfo.stop } : { do: 'next' };
    } else act = nextAction(f, last, runInfo);
    if (act.do === 'next' && f && f.state !== 'queued') { cur = null; last = null; continue; }
    // The stop flag, before every step: the step that just ran (a driver-only step, a CI wait a graceful stop let finish) is done,
    // nothing new starts. An interruption still runs first (it keeps the stopped session's work), and so does a stop.
    if (act.do !== 'interrupt' && act.do !== 'stop' && stopRequested(ctx)) {
      await killLeftovers(ctx);
      const res = stopRun(ctx, f, 'stop', 'a stop was requested');
      return finish(ctx, res.end);
    }
    ctx.out(`${f ? `${f.id} ${f.state}` : 'queue'} -> ${act.do}${act.brief ? ` (${act.brief})` : ''}`);
    try { updateRun(ctx.fh, ctx.key, { current: { feature: f ? f.id : null, state: f ? f.state : null, action: act.do } }); } catch { /* status only */ }
    let res;
    try { res = await execute(ctx, q, f, act, last); } catch (e) {
      const kind = e instanceof Leftover ? 'leftovers' : e instanceof WipFailed ? 'wip_failed' : 'error';
      if (f) attention(ctx, f.id, f.state, kind);
      if (f && kind === 'wip_failed') {
        try { addAttention(ctx.fh, ctx.key, { id: f.id, kind, severity: 'high', what: 'the WIP commit of the interrupted session failed: the work is uncommitted in the builder clone', run: 'factory run --continue' }); } catch { /* the jsonl row and the terminal line remain */ }
      }
      ctx.out(`stopped: ${kind}`);
      ctx.stopReason = kind;
      return finish(ctx, 2);
    }
    // A feature that deliver itself blocked or parked (fix rounds, CI budget, merge conflict, a merge hold) gets its line too.
    if (f && res.end === undefined) {
      const now = readQueue(ctx).features.find((x) => x.id === f.id)?.state;
      if (now !== f.state && (now === 'blocked' || now === 'awaiting_human')) attention(ctx, f.id, now, act.do);
    }
    // A timed-out session is counted before the next decision, so the third timeout blocks the feature (decide: f.timeouts >= 3).
    if (f && res.last?.step === 'session' && res.last.kind === 'timeout') update(ctx, f.id, (x) => { if (x.timeouts === undefined || (Number.isInteger(x.timeouts) && x.timeouts >= 0)) x.timeouts = (x.timeouts ?? 0) + 1; });
    ctx.prevAct = act;
    ctx.deps.afterAction?.(act.do);
    if (res.end !== undefined) return finish(ctx, res.end);
    if (res.replay) { replay = res.replay; last = null; continue; }
    if (res.cur !== undefined) cur = res.cur;
    last = res.last ?? null;
  }
  ctx.out('stopped: too many steps');
  return finish(ctx, 2);
}

async function execute(ctx, q, f, act, last = null) {
  switch (act.do) {
    case 'next': {
      const d = deliver(ctx, 'next');
      if (d.code !== 0) { ctx.out('stopped: deliver next failed'); return { end: 2 }; }
      if (d.json?.done) return { end: 0 };
      return { cur: d.json?.feature?.id ?? null, last: { step: 'next', kind: 'ok' } };
    }
    case 'build': return { last: await builderSession(ctx, f, act) };
    case 'built': return { last: stepBuilt(ctx, f) };
    case 'pr': return { last: stepPr(ctx, f) };
    case 'ci': return { last: await stepCi(ctx, f, act) };
    case 'fix_ci': case 'fix_verify': return { last: stepFix(ctx, f, act) };
    case 'push': return { last: stepPush(ctx, f) };
    case 'verify': return { last: await stepVerify(ctx, f) };
    case 'verified': return { last: stepVerified(ctx, q, f) };
    case 'merge': return { last: stepMerge(ctx, f) };
    case 'block': {
      const d = deliver(ctx, 'block', f.id, '--reason', clean(act.reason || 'blocked', 200));
      attention(ctx, f.id, 'blocked', 'block');
      return d.code === 0 ? { cur: null } : { end: 2 };
    }
    case 'hold': {
      if (f.state === 'awaiting_human') { attention(ctx, f.id, f.state, act.kind); return { cur: null }; }
      if (!canHold(f.state)) { attention(ctx, f.id, f.state, act.kind); ctx.out(`stopped: ${f.id} needs a person (${act.kind})`); return { end: 2 }; }
      const extra = act.kind === 'antigaming' && act.sha && act.ids?.length ? ['--sha', act.sha, '--ids', act.ids.join(',')] : [];
      const d = deliver(ctx, 'hold', f.id, '--reason', clean(act.reason || 'held for a person', 200), '--kind', /^[a-z_]{1,32}$/.test(String(act.kind)) ? act.kind : 'driver', ...extra);
      const held = (d.code === 2 || d.code === 0) && readQueue(ctx).features.find((x) => x.id === f.id)?.state === 'awaiting_human';
      if (!held) { attention(ctx, f.id, f.state, 'hold_failed'); ctx.out(`stopped: ${f.id} could not be parked (${act.kind})`); return { end: 2 }; }
      attention(ctx, f.id, 'awaiting_human', act.kind);
      return { cur: null };
    }
    case 'stop':
      if (f && act.attention) attention(ctx, f.id, f.state, act.kind);
      ctx.out(`stopped: ${act.kind}${act.resetAt ? ` (resets ${act.resetAt})` : ''}`);
      ctx.stopReason = clean(`${act.kind}${act.reason ? `: ${act.reason}` : ''}`, 200);
      return { end: 2 };
    case 'interrupt': return handleInterrupt(ctx, f, act, last);
    default: throw new Error('unknown action');
  }
}

// handleInterrupt(ctx, f, act, last) -> { last } | { cur } | { end } | { replay }: an interrupted session (decision table action
// `interrupt`). For a builder state (building, fixing), after noLiveBuilder: the WIP commit, then f.interrupted { kind, step,
// session_id, head, ts } is set BEFORE any wait, so a stop or a crash during the wait still continues the step later. Then per kind:
//   stop: the run ends stopped. timeout: the step continues at once (f.timeouts was counted by the loop; the third one blocks).
//   usage_limit: routeInterruption decides wait (session, weekly), retry (rate), switch_model (model, once) or stop.
//   budget: feature scope holds (budgetInterrupt); day scope waits for local midnight with wait_for_reset, else stops.
// After a wait the step continues ({ last: null }: the decision table gives the continue brief) and f.interruptions gets
// { kind, step, minutes_waited, method: 'continue_brief' }. Other states keep their work as it is (no WIP commit) and run their
// step again after the wait; a terminal state starts nothing.
export async function handleInterrupt(ctx, f, act, last) {
  if (act.kind === 'budget' && act.scope !== 'day') return budgetInterrupt(ctx, f, act, last);
  const kind = act.kind === 'usage_limit' ? act.limit : act.kind === 'budget' ? 'day_budget' : act.kind;
  const step = f ? STEP_OF[f.state] : undefined;
  if (act.kind === 'budget' && f) update(ctx, f.id, (x) => { x.budget_hit = true; }); // sticky: the record of a continued feature still says it hit a budget
  if (act.kind === 'stop') await killLeftovers(ctx); // before noLiveBuilder: what the stopped session left running goes first
  if (step && act.kind !== 'budget') { // a day-budget hit refused the session before it started: nothing to commit
    noLiveBuilder(ctx);
    // Recorded BEFORE the WIP commit: if the commit fails the run stops (WipFailed) and a restart still continues the step
    // (no reset rebuild); the head is the branch head before the commit, updated after it.
    const before = bExists(ctx) ? (ensureBuilder(ctx), headOf(bGit(ctx), f.branch)) : null;
    const sid = (readQueue(ctx).features.find((x) => x.id === f.id)?.sessions || []).at(-1)?.id ?? null;
    update(ctx, f.id, (x) => { x.interrupted = { kind, step, session_id: typeof sid === 'string' ? sid : null, head: before, ts: isoAt(ctx.deps.clock.now()) }; });
    const w = keepWork(ctx, f, kind);
    if (w.committed) {
      update(ctx, f.id, (x) => { if (x.interrupted) x.interrupted.head = w.head; });
      ctx.out(`${f.id} interrupted (${kind}): work kept in a WIP commit`);
    }
  }
  if (act.kind === 'stop') return stopRun(ctx, f, 'stop', 'a stop was requested');
  if (f && TERMINAL.includes(f.state)) return { cur: null };
  const resumed = (ms) => {
    if (step) update(ctx, f.id, (x) => { (x.interruptions ||= []).push({ kind, step, minutes_waited: Math.round(ms / 60000), method: 'continue_brief' }); });
    return { last: null };
  };
  if (act.kind === 'timeout') return resumed(0);
  if (act.kind === 'budget') { // day scope
    if (ctx.local.wait_for_reset !== true) return stopRun(ctx, f, 'day_budget', 'the daily token cap is reached');
    if (await pauseFor(ctx, nextMidnight(ctx), { kind: 'day_budget' }) === 'stopped') return stopRun(ctx, f, 'stop', 'a stop was requested during the wait');
    // The refused session never started: the same action runs again on the new day.
    return ctx.prevAct ? { replay: ctx.prevAct } : { last: null };
  }
  if (act.kind !== 'usage_limit') throw new Error('unknown interruption');
  const ws = waitState(ctx, f.id);
  const route = routeLimit(ctx, act, ws);
  if (route.do === 'stop') return stopRun(ctx, f, 'usage_limit', route.reason);
  if (route.do === 'switch_model') { ctx.modelOverride = route.model; ctx.out(`${f.id} model limit: the next session uses fallback_model`); return resumed(0); }
  const start = ctx.deps.clock.now();
  if (await pauseFor(ctx, route.until, { kind: 'usage_limit', limit: act.limit, estimated: route.estimated }) === 'stopped') return stopRun(ctx, f, 'stop', 'a stop was requested during the wait');
  route.commit();
  return resumed(route.until - start);
}
// The run ends stopped: the terminal lines, the attention event and row (with the command that continues the run).
function stopRun(ctx, f, kind, reason) {
  if (kind === 'stop' && f) update(ctx, f.id, (x) => { x.stopped_by_user = true; }); // sticky, like budget_hit: survives the continue
  ctx.out(`stopped: ${kind}`);
  ctx.stopReason = clean(`${kind}: ${reason}`, 200);
  ctx.out(`${kind === 'usage_limit' ? 'usage limit' : 'reason'}: ${clean(reason, 200)}`);
  if (f) attention(ctx, f.id, f.state, kind);
  addAttention(ctx.fh, ctx.key, { id: f?.id || 'run', kind: kind === 'stop' ? 'stopped' : kind, severity: 'high', what: clean(reason, 200), run: 'factory run --continue' });
  return { end: 2 };
}

// A budget hit (enforceBudget's result, routed by the decision table). Feature: the feature is parked (deliver hold --kind budget,
// from building or fixing only) with its work on the branch, an attention row names the command that raises the cap, and the run
// moves on to the next feature (a hold is not a block: the circuit breaker does not count it). Day: handleInterrupt.
function budgetInterrupt(ctx, f, act, last) {
  const b = last?.kind === 'budget' ? last : {};
  const what = clean(`feature budget reached: ${b.dim ?? 'tokens'} ${Number.isFinite(b.used) ? b.used : '?'} of ${Number.isFinite(b.cap) ? b.cap : '?'}`, 200);
  const d = deliver(ctx, 'hold', f.id, '--reason', what, '--kind', 'budget');
  const held = (d.code === 0 || d.code === 2) && readQueue(ctx).features.find((x) => x.id === f.id)?.state === 'awaiting_human';
  if (!held) { attention(ctx, f.id, f.state, 'hold_failed'); ctx.out(`stopped: ${f.id} could not be parked (budget)`); return { end: 2 }; }
  attention(ctx, f.id, 'awaiting_human', 'budget');
  addAttention(ctx.fh, ctx.key, { id: f.id, kind: 'budget', severity: 'high', what, run: `factory run --raise-budget ${f.id}` });
  return { cur: null };
}

// A run that reaches finish() ended cleanly (a stop, hold, block or the end of the queue): the features it resumed are not crash
// loops, so their resume count goes back to 0 (terminal features keep it as a record). Only a driver that dies keeps the count.
// The run state ends finished (the queue is done, exit 0 or 2 for a feature that needs a person) or stopped, with a notification.
function finish(ctx, code) {
  try {
    for (const id of ctx.resumed || []) update(ctx, id, (x) => { if (x && !TERMINAL.includes(x.state)) { x.resumes = 0; if (x.interrupted_resumes !== undefined) x.interrupted_resumes = 0; } });
  } catch { /* the count stays: the next run may hold resume_loop */ }
  const status = code === 0 ? 'finished' : 'stopped';
  try { updateRun(ctx.fh, ctx.key, { status, reason: status === 'stopped' ? (ctx.stopReason || 'stopped') : null, ended_at: isoAt(ctx.deps.clock.now()) }); } catch { /* the terminal lines are the record */ }
  tell(ctx, status);
  try {
    const q = readQueue(ctx);
    const by = {};
    for (const f of q.features) by[f.state] = (by[f.state] || 0) + 1;
    ctx.out(`features: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}${ctx.attention ? `; attention ${ctx.attention}` : ''}`);
    if (code === 0 && (by.blocked || by.awaiting_human)) return 2; // finished, but a feature needs a person
  } catch { /* no queue */ }
  return code;
}

// ---- stop and status (no lock, no clone) --------------------------------------------------------------------------------------------
// Which repository and where its files are: FACTORY_HOME and the identity of the checkout in --dir. Never the lock, never the clone.
function prepareLight(ctx) {
  ctx.fh = homeDir(ctx.env);
  ctx.id = identify(ctx, path.resolve(ctx.args.opt.dir || process.cwd()));
  ctx.key = ctx.id.key;
  ctx.queueFile = path.join(ctx.fh, 'queues', `${ctx.key}.json`);
  return ctx;
}
const lockState = (ctx) => { try { return inspect(ctx.key, { home: ctx.fh, ...(ctx.deps.lockSys ? { sys: ctx.deps.lockSys } : {}) }); } catch { return { state: 'unreadable', pid: null }; } };

// factory stop [--now]: writes the stop flag { at, now }. A running driver sees it before its next step, every 5 s during a session
// (the session is interrupted and its work kept in a WIP commit) and during waits; --now also ends the CI wait. A verification run
// in progress always finishes. The flag stays until `factory run --continue`; the run ends with status stopped.
export function cmdStop(ctx) {
  const now = ctx.args.opt.now === true;
  const file = STOP_FLAG(ctx);
  privateDir(path.join(ctx.fh, 'stop'));
  const prev = stopRequested(ctx);
  writeJsonAtomic(file, { at: new Date().toISOString(), now: now || prev?.now === true });
  ctx.out(`stop requested for ${ctx.id.repo} (${now || prev?.now ? 'now' : 'graceful'})`);
  const lk = lockState(ctx);
  if (lk.state === 'live') ctx.out(`the factory run (pid ${lk.pid}) stops ${now ? 'at once (a verification run in progress finishes first)' : 'after its current step; a running session is interrupted and its work kept'}`);
  else ctx.out('note: no factory run is active for this repository; the next run needs --continue');
  return 0;
}

// The facts `factory status` reports, all read-only: run state, queue, usage against caps, attention, lock and stop flag.
export function statusFacts(ctx) {
  const err = (e) => clean(String(e?.message || e), 160).replace(/(?:\/[^\s/:'"]+)+\/?/g, '<path>');
  const out = { repo: ctx.id.repo, run: null, pause: null, next_resume: null, stop_requested: stopRequested(ctx), lock: lockState(ctx).state, features: [], counts: {}, day: null, attention: 0, errors: [] };
  try {
    const r = readRun(ctx.fh, ctx.key);
    if (r) {
      out.run = { status: r.status ?? null, reason: r.reason ?? null, current: r.current ?? null, started_at: r.started_at ?? null, ended_at: r.ended_at ?? null };
      out.pause = r.pause ?? null;
      out.next_resume = r.pause && ['paused', 'stopped'].includes(r.status) && typeof r.pause.reset_at === 'string' ? r.pause.reset_at : null;
    }
  } catch (e) { out.errors.push(`run state: ${err(e)}`); }
  let q = null;
  try { if (fs.existsSync(ctx.queueFile)) q = readQueue(ctx); } catch (e) { out.errors.push(`queue: ${err(e)}`); }
  for (const f of q?.features || []) {
    let caps = null;
    try { caps = featureCaps({ policy: q.policy }, f); } catch { caps = null; }
    out.features.push({ id: f.id, state: f.state, hold_kind: f.hold_kind ?? null, usage: featureUsage(f), caps });
    out.counts[f.state] = (out.counts[f.state] || 0) + 1;
  }
  let dayCap = null;
  try {
    const lc = loadLocalConfig(ctx.fh, { classifierReal: ctx.deps.classifierReal === true || CLASSIFIER_STATUS === 'real' });
    if (lc.errors.length) out.errors.push(`local config: ${lc.errors.length} error(s)`); else dayCap = lc.config.budgets.day_tokens;
  } catch (e) { out.errors.push(`local config: ${err(e)}`); }
  try { out.day = { ...dayUsage(ctx.fh, new Date(ctx.deps.clock.now())), cap: dayCap }; } catch (e) { out.errors.push(`usage: ${err(e)}`); }
  try { out.attention = listAttention(ctx.fh, ctx.key).length; } catch (e) { out.errors.push(`attention: ${err(e)}`); }
  return out;
}
export function cmdStatus(ctx) {
  const s = statusFacts(ctx);
  if (ctx.args.opt.json === true) { ctx.out(JSON.stringify(s, null, 2)); return 0; }
  const cap = (n) => (n === null || n === undefined ? '-' : n);
  ctx.out(`repo: ${s.repo}`);
  ctx.out(`run: ${s.run?.status ?? 'none'}`);
  if (s.run?.reason) ctx.out(`reason: ${s.run.reason}`);
  if (s.run?.current) ctx.out(`current: ${s.run.current.feature ? `${s.run.current.feature} ${s.run.current.state}` : 'queue'} -> ${s.run.current.action}`);
  if (s.next_resume) ctx.out(`next resume: ${s.next_resume}`);
  ctx.out(`lock: ${s.lock}${s.stop_requested ? `; stop requested (${s.stop_requested.now ? 'now' : 'graceful'})` : ''}`);
  for (const f of s.features) ctx.out(`${f.id} ${f.state}${f.hold_kind ? ` (${f.hold_kind})` : ''} tokens ${f.usage.tokens}/${cap(f.caps?.tokens)} turns ${f.usage.turns}/${cap(f.caps?.turns)}`);
  if (s.day) ctx.out(`day: tokens ${s.day.tokens}/${cap(s.day.cap)}`);
  ctx.out(`attention: ${s.attention}`);
  for (const e of s.errors) ctx.out(`warning: ${e}`);
  return 0;
}

// ---- entry -------------------------------------------------------------------------------------------------------------------------
const HELP = `usage: factory scenarios [--only IDS] [--approve ID --by NAME] [--dir D] [--base B]
       factory run [--only IDS] [--limit N] [--continue] [--raise-budget ID[=TOKENS]] [--dir D] [--base B]
       factory stop [--now] [--dir D]       stop the running factory run (graceful: after the current step; --now: also the CI wait)
       factory status [--json] [--dir D]    run state, features, usage against caps, next resume time, attention`;
export const COMMANDS = { scenarios: cmdScenarios, run: cmdRun, stop: cmdStop, status: cmdStatus };
const NO_LOCK = new Set(['stop', 'status']); // they identify the repository but take no lock and never touch the clone

export async function main(argv, deps = {}) {
  let ctx;
  try {
    ctx = makeContext({ argv, deps });
    const { cmd } = ctx.args;
    if (!cmd || cmd === 'help') { ctx.out(HELP); return cmd ? 0 : 1; }
    if (!COMMANDS[cmd]) refuse(`unknown command "${String(cmd).slice(0, 20)}"`, HELP);
    if (NO_LOCK.has(cmd)) prepareLight(ctx); else prepare(ctx);
    return await COMMANDS[cmd](ctx);
  } catch (e) {
    const out = ctx?.out || ((l) => process.stdout.write(`${l}\n`));
    if (e instanceof Refusal) { out(`refused: ${e.message}`); for (const x of [].concat(e.fix || [])) out(`fix: ${x}`); return 1; }
    out(`error: ${String(e?.message || e).split('\n')[0].replace(/(?:[A-Za-z]:)?(?:\/[^\s/:'"]+)+\/?/g, '<path>').replace(/[^\s'"]*\/[^\s'"]*/g, '<path>').slice(0, 200)}`);
    return 1;
  } finally { try { ctx?.lock?.release(); } catch { /* released on exit */ } }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) process.exitCode = await main(process.argv.slice(2));
