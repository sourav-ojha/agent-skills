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
class Unsafe extends Error {}
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
    const st = s ? scenarioState(ctx.key, id, baseCriteria(ctx.git, ctx.base, s.rel)) : { ok: false, why: 'no base spec' };
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

// deliver as a subprocess in the driver clone, the clone preflighted first (deliver's own git is plain git).
function deliver(ctx, ...args) {
  preflight(ctx.D, ctx.id.url);
  if (!ctx.lock.owned()) throw new Error('the factory lock is no longer ours');
  const r = run(process.execPath, [DELIVER, ...args, '--dir', ctx.D], { cwd: ctx.D, env: { ...ctx.env, DELIVER_QUEUE: ctx.queueFile }, timeout: 6 * 3600 * 1000 });
  return { code: r.code, json: json(r.out) };
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
function briefFor(ctx, f, act) {
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
  if (act.brief === 'build') { // a fresh build (or a reset on resume) starts from the base commit in both clones
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
      ...(v.model.builder ? { model: v.model.builder } : {}), home, tmpDir, baseEnv: ctx.env,
      onSpawn: (x) => { pgid = x.pgid; ctx.lock.recordGroup(x.pgid); },
    });
  } finally { if (pgid) try { ctx.lock.forgetGroup(pgid); } catch { /* kept: killed on the next start */ } }
  update(ctx, f.id, (x) => { (x.sessions ||= []).push(usageEntry('builder', r)); });
  noLiveBuilder(ctx);
  fs.rmSync(runDir, { recursive: true, force: true });
  return sessionResult(r, readBuilderResult(ctx.B, f.id));
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
function stepCi(ctx, f, act) {
  if (act.reopen && (f.state === 'ci_passed' || f.state === 'verified')) update(ctx, f.id, (x) => transition(x, 'pr_open', 'head moved or verdict stale: CI and verification again'));
  const d = deliver(ctx, 'ci', f.id, ...(ctx.deps.ciArgs || []));
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
  const st = scenarioState(ctx.key, f.id, bc);
  if (!st.ok || !SHA.test(String(f.ci_sha))) return { step: 'verify', kind: 'threw' };
  const t0 = Date.now();
  let r = null; let threw = false;
  try {
    r = await (ctx.deps.verifyFeature || verifyFeature)({ repoKey: ctx.key, id: f.id, sha: f.ci_sha, baseRef: OR(ctx.base), config: ctx.policy, scenarios: st.doc, criteriaHash: bc.hash, git: (...a) => gitSafeOpts(ctx.D, a) }, ctx.deps.verifySeams);
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
export async function cmdRun(ctx) {
  const { opt } = ctx.args;
  const only = idList(opt.only);
  if (opt.limit !== undefined && !(Number.isInteger(Number(opt.limit)) && Number(opt.limit) >= 1 && Number(opt.limit) <= 1000)) refuse('--limit must be an integer 1-1000');
  startChecks(ctx);
  ctx.queueFile = path.join(privateDir(path.join(ctx.fh, 'queues')), `${ctx.key}.json`);
  ctx.bRoot = builderRoot(ctx);
  ctx.attention = 0;
  sweep(ctx);
  let q = fs.existsSync(ctx.queueFile) ? readQueue(ctx) : null;
  if (q && (q.repo !== ctx.id.repo || q.base !== ctx.base)) refuse('the stored queue is for another repository or base', `DELIVER_QUEUE=${ctx.queueFile} node deliver.mjs reset --yes`);
  const resuming = q && q.features.some((f) => !['merged', 'skipped'].includes(f.state));
  if (!resuming && (ctx.orphansAlive > 0 || ctx.leftovers > 0)) refuse(`processes or worktrees from an earlier run are still alive (${ctx.orphansAlive} process group(s), ${ctx.leftovers} directory(ies))`, 'stop them (see FACTORY_HOME/work and FACTORY_HOME/tmp), then run again');
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
    const bad = missingScenarios(ctx, q.features.filter((f) => f.state === 'queued' || ACTIVE.includes(f.state)).map((f) => f.id));
    if (bad.length) refuse(`features without current approved scenarios: ${bad.join(', ')}`, 'run "factory scenarios" (and approve them), then run again');
  }
  return loop(ctx);
}

async function loop(ctx) {
  let cur = null; let last = null;
  for (let guard = 0; guard < 100000; guard++) {
    const q = readQueue(ctx);
    const runInfo = { max_fix_rounds: q.max_fix_rounds, stop: runStop(q) };
    let f = cur ? q.features.find((x) => x.id === cur) : null;
    let act;
    if (!f) {
      const active = q.features.find((x) => ACTIVE.includes(x.state));
      if (active) { // a feature left active by an earlier (crashed or stopped) run: the restart rules decide, once
        f = active; cur = f.id; last = null;
        let facts;
        try { facts = await resumeFacts(ctx, f); } catch (e) {
          attention(ctx, f.id, f.state, e instanceof Leftover ? 'leftovers' : 'resume_error');
          ctx.out(`stopped: ${e instanceof Leftover ? 'leftovers' : 'resume_error'}`);
          return finish(ctx, 2);
        }
        act = resumeAction(f, facts, runInfo);
        update(ctx, f.id, (x) => { x.resumes = (Number.isInteger(x.resumes) ? x.resumes : 0) + 1; });
      } else act = runInfo.stop ? { do: 'stop', kind: 'run_stop', reason: runInfo.stop } : { do: 'next' };
    } else act = nextAction(f, last, runInfo);
    if (act.do === 'next' && f && f.state !== 'queued') { cur = null; last = null; continue; }
    ctx.out(`${f ? `${f.id} ${f.state}` : 'queue'} -> ${act.do}${act.brief ? ` (${act.brief})` : ''}`);
    let res;
    try { res = await execute(ctx, q, f, act); } catch (e) {
      const kind = e instanceof Leftover ? 'leftovers' : 'error';
      if (f) attention(ctx, f.id, f.state, kind);
      ctx.out(`stopped: ${kind}`);
      return finish(ctx, 2);
    }
    // A feature that deliver itself blocked or parked (fix rounds, CI budget, merge conflict, a merge hold) gets its line too.
    if (f && res.end === undefined) {
      const now = readQueue(ctx).features.find((x) => x.id === f.id)?.state;
      if (now !== f.state && (now === 'blocked' || now === 'awaiting_human')) attention(ctx, f.id, now, act.do);
    }
    ctx.deps.afterAction?.(act.do);
    if (res.end !== undefined) return finish(ctx, res.end);
    if (res.cur !== undefined) cur = res.cur;
    last = res.last ?? null;
  }
  ctx.out('stopped: too many steps');
  return finish(ctx, 2);
}

async function execute(ctx, q, f, act) {
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
    case 'ci': return { last: stepCi(ctx, f, act) };
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
      return { end: 2 };
    default: throw new Error('unknown action');
  }
}

function finish(ctx, code) {
  try {
    const q = readQueue(ctx);
    const by = {};
    for (const f of q.features) by[f.state] = (by[f.state] || 0) + 1;
    ctx.out(`features: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}${ctx.attention ? `; attention ${ctx.attention}` : ''}`);
    if (code === 0 && (by.blocked || by.awaiting_human)) return 2; // finished, but a feature needs a person
  } catch { /* no queue */ }
  return code;
}

// ---- entry -------------------------------------------------------------------------------------------------------------------------
const HELP = `usage: factory scenarios [--only IDS] [--approve ID --by NAME] [--dir D] [--base B]
       factory run [--only IDS] [--limit N] [--dir D] [--base B]`;
export const COMMANDS = { scenarios: cmdScenarios, run: cmdRun };

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
    out(`error: ${String(e?.message || e).split('\n')[0].replace(/(?:[A-Za-z]:)?(?:\/[^\s/:'"]+)+\/?/g, '<path>').replace(/[^\s'"]*\/[^\s'"]*/g, '<path>').slice(0, 200)}`);
    return 1;
  } finally { try { ctx?.lock?.release(); } catch { /* released on exit */ } }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SELF) process.exitCode = await main(process.argv.slice(2));
