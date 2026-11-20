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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factoryHome, repoKey } from './lib/factoryhome.mjs';
import { gitSafeOpts, gitEnv, verifyGitConfig, checkRepoMetadata, checkNoReplaceRefs, checkNoHooks, checkNetworkArgs, GIT_SAFE_FLAGS } from './lib/gitsafe.mjs';
import { parseConfig, CONFIG_PATH, remoteHost } from './lib/config.mjs';
import { FEATURE_ID, ACTIVE, transition, frontmatter, discover, buildQueue, runStop } from './lib/queue.mjs';
import { specFromBase, extractCriteria, criteriaHash, MAX_LINE } from './lib/criteria.mjs';
import { loadScenarios, saveScenarios, lintScenarios, isCurrentApproved, approve, newCanary, checkRepoKey, scenariosHash } from './lib/scenarios.mjs';
import { runSession, materialiseSettings, renderPrompt, defaultHome, readBuilderResult } from './lib/sessions.mjs';
import { sessionResult, nextAction, resumeAction, canHold } from './lib/driver.mjs';
import { acquire, LockError } from './lib/lock.mjs';
import { verifyFeature, scanSurvivors, symptomBrief, postVerified } from './lib/verify.mjs';
import { readVerdict, verdictMatches } from './lib/verdict.mjs';
import { checkDiff, classify, holdReason } from './lib/antigaming.mjs';
import { requiredStatusChecks } from './lib/readiness.mjs';
import { readJson, writeJsonAtomic } from './lib/factoryhome.mjs';

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
const refuse = (msg, fix) => { throw new Refusal(msg, fix); };

// ---- argv -----------------------------------------------------------------------------------------------------------------------
const BOOL = new Set([]);
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
    const cred = host && (ghEnv.GH_TOKEN || ghEnv.GH_ENTERPRISE_TOKEN) ? ['-c', `credential.https://${host}.helper=!gh auth git-credential`] : [];
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
    if (c.code !== 0) refuse('cloning the repository failed', 'check that the driver can reach the repository (ssh key or gh login)');
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
// content (isCurrentApproved binds the approval to scenarios_hash). The `approved` field alone is never trusted.
export function scenarioState(key, id, bc) {
  if (!bc || !bc.criteria.ok) return { ok: false, why: 'criteria' };
  let doc;
  try { doc = loadScenarios(key, id); } catch { return { ok: false, why: 'corrupt' }; }
  if (!doc) return { ok: false, why: 'missing' };
  if (doc.feature !== id) return { ok: false, why: 'corrupt' };
  const lint = lintScenarios(doc, bc.criteria, bc.hash);
  if (!lint.ok) return { ok: false, why: 'lint', problems: lint.problems, doc };
  if (!isCurrentApproved(doc, bc.hash)) return { ok: false, why: 'unapproved', doc };
  return { ok: true, doc };
}

export function makeContext({ argv, deps = {} }) {
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
  if (!account) return;
  const t = run('gh', ['auth', 'token', '--user', account, '--hostname', host], { env: ctx.env });
  if (t.code !== 0 || !t.out.trim()) refuse(`gh has no login for the configured account on ${host}`, `run "gh auth login --hostname ${host}" for that account`);
  Object.assign(ctx.ghEnv, host === 'github.com' ? { GH_TOKEN: t.out.trim() } : { GH_ENTERPRISE_TOKEN: t.out.trim(), GH_HOST: host });
}

// Lock, driver clone, fetch, base policy. Shared by `scenarios` and `run`.
export function prepare(ctx) {
  const { opt } = ctx.args;
  ctx.fh = homeDir(ctx.env);
  const dir = path.resolve(opt.dir || process.cwd());
  ctx.id = identify(ctx, dir);
  ctx.key = ctx.id.key;
  try { ctx.lock = acquire(ctx.key, { home: ctx.fh, ...(ctx.deps.lockSys ? { sys: ctx.deps.lockSys } : {}), ...(ctx.deps.register ? { register: ctx.deps.register } : {}) }); } catch (e) {
    if (e instanceof LockError && e.code === 'LOCK_HELD') refuse('another factory run holds the lock for this repository', 'wait for it to finish (or stop it); a lock of a dead process is cleared automatically');
    if (e instanceof LockError) refuse(`the factory lock cannot be used (${e.code})`, 'see the lock file under FACTORY_HOME/locks; remove it by hand only if no factory run is alive');
    throw e;
  }
  ctx.netGit = ctx.deps.netGit || makeNetGit({ host: ctx.id.host, ghEnv: ctx.ghEnv, ...(ctx.deps.netGitOpts || {}) });
  ctx.D = ensureClone(ctx, path.join(ctx.fh, 'clones'), ctx.key).dir;
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
  useAccount(ctx, ctx.policy.github.account, ctx.policy.github.host);
  return ctx;
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
  return { role, id: r?.sessionId ?? null, in: r?.usage?.in ?? 0, out: r?.usage?.out ?? 0, cache_create: r?.usage?.cache_create ?? 0, cache_read: r?.usage?.cache_read ?? 0, turns: r?.turns ?? 0 };
}

// One author session: an empty directory under FACTORY_HOME/run/, no tools, the spec items passed by the driver.
async function authorOne(ctx, spec, bc) {
  const canary = newCanary();
  const prompt = renderPrompt('scenario-author', { FEATURE_ID: spec.id, CANARY: canary, SPEC_SECTIONS: specSections(bc.criteria) });
  const runRoot = privateDir(path.join(privateDir(path.join(ctx.fh, 'run')), 'author'));
  const cwd = fs.mkdtempSync(path.join(runRoot, `${spec.id}-`));
  const home = ctx.deps.home || defaultHome(ctx.env);
  let r;
  try {
    const settingsFile = materialiseSettings('author', { factoryHome: ctx.fh, home });
    const v = ctx.policy.verification;
    r = await (ctx.deps.runSession || runSession)({
      role: 'author', cwd, prompt, settingsFile, maxTurns: v.max_turns.author, timeoutS: v.session_timeout_s.author,
      ...(v.model.author ? { model: v.model.author } : {}), home, baseEnv: ctx.env,
      onSpawn: ({ pgid }) => { try { ctx.lock.recordGroup(pgid); } catch { /* recorded best effort */ } },
    });
  } catch (e) {
    return { status: 'error', kind: e?.code === 'settings_unsafe' ? 'settings_unsafe' : 'environment' };
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  const s = sessionResult(r, { status: 'done' });
  if (s.kind !== 'done') return { status: 'error', kind: s.kind, usage: usageEntry('author', r) };
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
  const specs = baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir);
  for (const id of only) if (!specs.some((s) => s.id === id)) refuse(`--only names ${id}, which has no spec on origin/${ctx.base}`);
  const pick = specs.filter((s) => (only.length ? only.includes(s.id) : s.status === 'ready' && s.delivery !== 'complete'));
  const mode = ctx.policy.verification.scenario_approval;
  const counts = { stored: 0, current: 0, awaiting_approval: 0, invalid: 0, criteria_errors: 0, failed: 0 };
  let code = 0;
  for (const spec of pick) {
    const bc = baseCriteria(ctx.git, ctx.base, spec.rel);
    if (!bc || !bc.criteria.ok) { counts.criteria_errors++; ctx.out(`${spec.id} criteria: ${bc ? bc.criteria.errors.length : 1} error(s) in the base spec; fix the spec first`); code = 1; continue; }
    const now = scenarioState(ctx.key, spec.id, bc);
    if (now.ok) { counts.current++; ctx.out(`${spec.id} scenarios: current and approved`); continue; }
    if (now.why === 'unapproved') { counts.awaiting_approval++; ctx.out(`${spec.id} scenarios: current, awaiting approval (factory scenarios --approve ${spec.id} --by <name>)`); continue; }
    const r = await authorOne(ctx, spec, bc);
    if (r.status === 'error') {
      counts.failed++;
      ctx.out(`${spec.id} author session: ${r.kind}`);
      if (r.kind === 'usage_limit') { ctx.out('usage limit reached: stopping; run again later'); return 2; }
      code = 1; continue;
    }
    if (r.status === 'invalid') { counts.invalid++; ctx.out(`${spec.id} scenarios rejected: ${r.problems.length} problem(s)`); for (const p of r.problems.slice(0, 50)) ctx.out(`  ${p}`); code = 1; continue; }
    const doc = mode === 'auto' ? approve(r.doc, 'auto') : r.doc;
    saveScenarios(ctx.key, spec.id, doc);
    if (mode === 'auto') { counts.stored++; ctx.out(`${spec.id} scenarios: stored (${doc.scenarios.length}), approved: auto`); } else { counts.awaiting_approval++; ctx.out(`${spec.id} scenarios: stored (${doc.scenarios.length}), awaiting approval (factory scenarios --approve ${spec.id} --by <name>)`); }
  }
  ctx.out(`scenarios: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return code;
}

function approveCmd(ctx, id, by) {
  if (!FEATURE_ID.test(String(id))) refuse('--approve needs a feature id like FEATURE-001');
  if (typeof by !== 'string' || !BY.test(by)) refuse('--approve needs --by <name> (1-64 characters of letters, digits, _ . @ -)');
  const spec = baseSpecs(ctx.git, ctx.base, ctx.policy.features_dir).find((s) => s.id === id);
  if (!spec) refuse(`${id} has no spec on origin/${ctx.base}`);
  const bc = baseCriteria(ctx.git, ctx.base, spec.rel);
  const st = scenarioState(ctx.key, id, bc);
  if (st.ok) { ctx.out(`${id} scenarios: already approved`); return 0; }
  if (st.why !== 'unapproved') refuse(`${id} has no current scenarios to approve (${st.why}${st.problems ? `: ${st.problems.length} problem(s)` : ''})`, `run "factory scenarios --only ${id}" first`);
  const { approved: _drop, ...doc } = st.doc;
  saveScenarios(ctx.key, id, approve(doc, by));
  ctx.out(`${id} scenarios: approved`);
  return 0;
}

// ---- entry -------------------------------------------------------------------------------------------------------------------------
const HELP = `usage: factory scenarios [--only IDS] [--approve ID --by NAME] [--dir D] [--base B]
       factory run [--only IDS] [--limit N] [--dir D] [--base B]`;
export const COMMANDS = { scenarios: cmdScenarios };

export async function main(argv, deps = {}) {
  let ctx;
  try {
    ctx = makeContext({ argv, deps });
    const { cmd } = ctx.args;
    if (!cmd || cmd === 'help') { ctx.out(HELP); return cmd ? 0 : 1; }
    if (!COMMANDS[cmd]) refuse(`unknown command "${String(cmd).slice(0, 20)}"`, HELP);
    prepare(ctx);
    return await COMMANDS[cmd](ctx);
  } catch (e) {
    const out = ctx?.out || ((l) => process.stdout.write(`${l}\n`));
    if (e instanceof Refusal) { out(`refused: ${e.message}`); for (const x of [].concat(e.fix || [])) out(`fix: ${x}`); return 1; }
    out(`error: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
    return 1;
  } finally { try { ctx?.lock?.release(); } catch { /* released on exit */ } }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) process.exitCode = await main(process.argv.slice(2));
