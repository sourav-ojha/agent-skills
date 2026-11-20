#!/usr/bin/env node
// Queue and PR helper for the delivery-orchestrator skill. Zero dependencies; git and gh are run without a shell.
// usage: node deliver.mjs <init|next|built|pr|ci|fix|push|merge|retry|block|skip|status|reset> [FEATURE-ID] [--dir D] [flags]
// exit codes: 0 ok, 1 error (nothing changed), 2 outcome that needs the agent or a person (blocked, CI failed, awaiting human)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logEvent, runId } from './lib/runlog.mjs';
import { FEATURE_ID, TRANSITIONS, transition as transitionState, frontmatter, discover, buildQueue, pickNext, runStop, slugify, touchesCi, summarize, overrideValid } from './lib/queue.mjs';
import { parseConfig, CONFIG_PATH, isProtectedBranch, matchesAny, remoteHost, isHttps } from './lib/config.mjs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { appendRecord, buildRecord, projectHash, skillStamps } from './lib/runrecord.mjs';
import { factoryHome, repoKey, writeJsonAtomic, readJson } from './lib/factoryhome.mjs';
import { readVerdict, verdictMatches } from './lib/verdict.mjs';
import { specFromBase, extractCriteria, criteriaHash, MAX_LINE } from './lib/criteria.mjs';
import { loadScenarios, scenariosHash, isCurrentApproved } from './lib/scenarios.mjs';
import { checkDiff, classify, holdReason } from './lib/antigaming.mjs';
import { gitSafeOpts, verifyGitConfig, checkRepoMetadata, checkNoReplaceRefs, checkNoHooks, GIT_SAFE_FLAGS } from './lib/gitsafe.mjs';
import { runChecks, makeCtx, computeLevel, fixItem, CHECKS } from './lib/readiness.mjs';
import { inspect } from './lib/lock.mjs';

const BOOL = new Set(['merge', 'no-ci', 'merge-t3', 'dry-run', 'yes', 'json', 'write']);
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = BOOL.has(k) ? true : argv[++i]; } else pos.push(argv[i]);
}
const [cmd, arg] = pos;
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const emit = (o) => { if (o && typeof o.result === 'string') extra.result = o.result; console.log(JSON.stringify(o, null, 2)); }; // the run log records the outcome word, so a CI wait is not mistaken for a failure
const outcome = (o) => { emit(o); process.exitCode = 2; };

const HELP = `commands: init [--features-dir D] [--only IDS] [--limit N] [--base B] [--merge --note "<user's words>"] [--checks A,B] [--no-ci] [--merge-t3] [--max-fix-rounds N] [--max-failures N] [--ci-budget S] [--dry-run]
  next | built ID [--tier T] | pr ID --title T --body-file .delivery/F | ci ID [--timeout S] [--interval S] [--grace S] | fix ID | push ID | merge ID [--settle S]
  retry ID [--no-ci] [--checks A,B] | block ID --reason R | skip ID --reason R | status [--json] | reset --yes
  hold ID --reason R [--kind K [--sha S --ids G1,G4]]   (factory driver only: a queue under FACTORY_HOME; from building/fixing only --kind budget)
  unhold ID --to building|fixing   (factory driver only: resumes a budget hold)
  readiness [--repeat N] [--json]   check the project against the factory readiness levels (writes $FACTORY_HOME/readiness/<repo>.json)
  config [--write]   show and validate the project policy (.product/delivery.json); --write creates it from the template   (all take --dir D)`;
if (!cmd || cmd === 'help') { console.log(HELP); process.exit(0); }

const root = path.resolve(opt.dir || '.');
const dirState = path.join(root, '.delivery');
// DELIVER_QUEUE (absolute path) relocates the queue file; PR body files still live under <root>/.delivery/.
const queueOverride = process.env.DELIVER_QUEUE || '';
if (queueOverride && !path.isAbsolute(queueOverride)) die('DELIVER_QUEUE must be an absolute path');
const file = queueOverride ? path.normalize(queueOverride) : path.join(dirState, 'queue.json');
const t0 = Date.now();
const extra = {};
process.on('exit', (code) => { if (cmd !== 'status') logEvent(root, 'delivery-orchestrator', runId('deliver', 'run'), { event: cmd, ok: code === 0, ms: Date.now() - t0, ...extra }); });

// ---- process helpers (no shell, fixed argv) --------------------------------------------------------------------------
let REPO = null; // owner/name: every gh pr call is pinned to it so git (origin) and gh cannot point at different repositories
let GH_ENV = {}; // the configured account's token, held in memory only (never written to the state file or printed)
const run = (bin, args, env) => { const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }); return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const git = (...a) => run('git', a);
const gh = (...a) => run('gh', REPO && a[0] === 'pr' ? [...a, '--repo', REPO] : a, GH_ENV);
// Network git (fetch, push, ls-remote): with a configured account and an https remote, credentials come from that account's token. SSH remotes use your SSH key.
let GH_HOSTNAME = null;
// The token is only ever offered to the configured host: both the fetch and the push URL (after any insteadOf rewriting) must be https on exactly that host.
const tokenSafeRemote = () => { const f = git('remote', 'get-url', 'origin').out, p = git('remote', 'get-url', '--push', 'origin').out; return !!GH_HOSTNAME && [f, p].every((u) => isHttps(u) && remoteHost(u) === GH_HOSTNAME); };
const gitNet = (...a) => (GH_ENV.GH_TOKEN || GH_ENV.GH_ENTERPRISE_TOKEN) && tokenSafeRemote()
  ? run('git', ['-c', 'credential.helper=', '-c', `credential.https://${GH_HOSTNAME}.helper=!gh auth git-credential`, ...a], GH_ENV) : git(...a);
// soft: return the problem as a string (and leave the default gh credentials in place) instead of exiting.
function useAccount(account, host, { soft = false } = {}) {
  if (!account) return null;
  const fail = (m) => { if (soft) return m; die(m); };
  const t = run('gh', ['auth', 'token', '--user', account, '--hostname', host]);
  if (t.code !== 0 || !t.out) return fail(`gh has no login for "${account}" on ${host}; run "gh auth login --hostname ${host}" for that account`);
  const env = host === 'github.com' ? { GH_TOKEN: t.out } : { GH_ENTERPRISE_TOKEN: t.out, GH_HOST: host };
  const who = run('gh', ['api', 'user', '--jq', '.login'], env);
  if (who.code !== 0 || who.out.toLowerCase() !== account.toLowerCase()) return fail(`the token for "${account}" resolves to "${flat(who.out, 40)}": check "gh auth status"`);
  GH_HOSTNAME = host.toLowerCase();
  GH_ENV = env;
  return null;
}
const must = (r, what) => { if (r.code !== 0) die(`${what} failed: ${(r.err || r.out).split('\n')[0].slice(0, 200)}`); return r.out; };
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+', 'g');
const flat = (s, max = 200) => String(s ?? '').replace(UNSAFE, ' ').trim().slice(0, max);
const ghJson = (args, what) => { const r = gh(...args); if (r.code !== 0) die(`${what} failed: ${(r.err || r.out).split('\n')[0].slice(0, 200)}`); try { return JSON.parse(r.out); } catch { die(`${what}: gh returned non-JSON output`); } };
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // never starts with "-": a value can not be read as a git option
const SHA = /^[0-9a-f]{40}$/;
const validRef = (s) => typeof s === 'string' && REF.test(s) && !s.includes('..');
// Always the remote-tracking ref, fully qualified: a local tag or branch named "origin/<x>" must never shadow it.
const OR = (b) => `refs/remotes/origin/${b}`;

// ---- factory guard ----------------------------------------------------------------------------------------------------
// While a factory run holds this repository (its lock is live) or a `factory stop` is pending (the stop flag), interactive commands
// that change anything are refused: a person racing the driver would corrupt its queue or branches. The driver's own calls carry
// FACTORY_DRIVER_PID = the lock holder's pid. A convenience guard, not a security control (anyone can set the variable). Read-only
// commands (status, config, readiness --json, help) always run.
const READ_ONLY = cmd === 'status' || cmd === 'config' || (cmd === 'readiness' && opt.json === true);
function factoryGuard(nameWithOwner) {
  if (READ_ONLY) return;
  let key;
  try { key = repoKey(nameWithOwner); if (!/^[A-Za-z0-9._-]+$/.test(key)) return; } catch { return; }
  const home = factoryHome();
  let lock;
  try { lock = inspect(key, { home }); } catch { lock = { state: 'absent', pid: null }; }
  const me = Number(process.env.FACTORY_DRIVER_PID);
  if (lock.state === 'live' && Number.isInteger(me) && me === lock.pid) return; // the driver itself
  if (lock.state === 'live') die('a factory run holds this repository; run factory stop first');
  let flag = false;
  try { fs.lstatSync(path.join(home, 'stop', key)); flag = true; } catch { flag = false; }
  if (flag) die('a factory stop is pending for this repository; continue the run with "factory run --continue" (or let it finish) first');
}

// ---- run records ------------------------------------------------------------------------------------------------------
// A record per transition into merged, skipped, blocked or awaiting_human. Snapshots are taken at the transition and written
// by save(), so a record exists only for a state that was persisted. queue.mjs stays pure; this is the only writer.
const RECORDED = new Set(['merged', 'skipped', 'blocked', 'awaiting_human']);
let curQ = null;
const pending = [];
// A feature waiting for a person is not working: its record window ends when it entered awaiting_human (f.ts_wait), so a later
// refresh/skip/merge of it does not stretch the window over other features' runs (which would make the token join ambiguous).
const note = (f, from, at) => {
  if (!curQ || !RECORDED.has(f.state)) return;
  const waited = from === 'awaiting_human' && Number.isFinite(Date.parse(f.ts_wait)) ? Date.parse(f.ts_wait) : null;
  pending.push({ f: JSON.parse(JSON.stringify(f)), at: waited ?? at ?? Date.now() });
};
const transition = (f, to, reason) => {
  const from = f.state;
  transitionState(f, to, reason);
  const now = new Date();
  if (to === 'awaiting_human') f.ts_wait = now.toISOString();
  note(f, from, now.getTime()); // one clock reading, so the record's end equals ts_wait exactly
  return f;
};
let stamps;
function flushRecords() {
  if (!pending.length) return;
  let project; try { project = projectHash(fs.realpathSync(root)); } catch { project = projectHash(root); }
  stamps ??= skillStamps(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  for (const { f, at } of pending.splice(0)) appendRecord(root, buildRecord({ q: curQ, f, run: curQ.run_id || runId('deliver', 'run'), project, skills: stamps, now: at }));
}
let ciStart = 0;
const tallyCi = (f) => { f.ci_runs = (f.ci_runs || 0) + 1; f.ci_wait_ms = (f.ci_wait_ms || 0) + (Date.now() - ciStart); };

// ---- state -----------------------------------------------------------------------------------------------------------
function load() {
  if (queueOverride) for (const p of [file, path.dirname(file)]) { try { if (fs.lstatSync(p).isSymbolicLink()) die(`refusing to use a symlinked queue path (${p})`); } catch { /* absent */ } }
  if (!fs.existsSync(file)) die('no run in progress here; use init first');
  let q;
  try { q = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`queue file is invalid JSON (${e.message}); reset and re-init (merged PRs are on GitHub)`); }
  if (!q || !Array.isArray(q.features)) die('queue file is invalid: expected a features array');
  // The file is writable by anything in the worktree: re-validate every value that reaches git or gh.
  if (!validRef(q.base) || !/^[\w.-]+\/[\w.-]+$/.test(q.repo || '') || !Array.isArray(q.checks)) die('queue file is invalid (base, repo or checks); reset and re-init');
  const pol = parseConfig(q.policy);
  if (!q.policy || pol.errors.length) die(`queue file has no valid policy (${pol.errors[0] || 'missing'}); reset and re-init`);
  for (const f of q.features) {
    if (!FEATURE_ID.test(f.id) || !(f.state in TRANSITIONS) || (f.branch && !validRef(f.branch)) || (f.ci_sha && !SHA.test(f.ci_sha)) || (f.built_sha && !SHA.test(f.built_sha)) || (f.pr && !Number.isInteger(f.pr.number))) die(`queue file has an invalid entry for ${f.id}; reset and re-init`);
  }
  REPO = q.repo;
  factoryGuard(q.repo);
  curQ = q;
  useAccount(q.policy.github.account, q.policy.github.host);
  return q;
}
// .delivery/ and its .gitignore are created without following links: a branch can commit a symlink there (a dangling
// .delivery/.gitignore link would otherwise make this write create its target anywhere the user can write).
const NOFOLLOW_CREATE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
function stateDir() {
  let st = null; try { st = fs.lstatSync(dirState); } catch { /* absent */ }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) die('.delivery is a symlink or not a directory; remove it and run again');
  if (!st) fs.mkdirSync(dirState);
  const ign = path.join(dirState, '.gitignore');
  let fd;
  try { fd = fs.openSync(ign, NOFOLLOW_CREATE, 0o644); fs.writeSync(fd, '*\n'); } catch (e) {
    if (e.code !== 'EEXIST') die(`cannot write .delivery/.gitignore (${e.code})`);
    if (fs.lstatSync(ign).isSymbolicLink()) die('.delivery/.gitignore is a symlink; remove it and run again');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function save(q) {
  stateDir();
  if (queueOverride) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeJsonAtomic(file, q); } catch (e) { die(`cannot write the queue file: ${e.message}`); }
  } else {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n', { flag: 'wx' }); // O_EXCL: never through a planted link
    fs.renameSync(tmp, file);
  }
  curQ = q;
  flushRecords();
}
function item(q, id = arg) {
  if (!FEATURE_ID.test(id || '')) die(`need a feature id like FEATURE-001, got ${JSON.stringify(id)}`);
  const f = q.features.find((x) => x.id === id);
  if (!f) die(`${id} is not in this run's queue`);
  extra.feature = id;
  return f;
}
const need = (f, ...states) => { if (!states.includes(f.state)) die(`${f.id} is "${f.state}"; this command needs ${states.join(' or ')}`); };
// The skill's own scratch folders never count as a dirty tree. init requires --dir to be the repository root.
const clean = () => git('status', '--porcelain', '--', '.', ':(exclude).implementation', ':(exclude).delivery').out === '';
const branchNow = () => git('rev-parse', '--abbrev-ref', 'HEAD').out;
const parseList = (v) => (v ? String(v).split(',').map((s) => flat(s, 80)).filter(Boolean) : []);

// A PR that a person merged by hand unblocks its dependents.
function refresh(q) {
  for (const f of q.features) {
    if (f.state !== 'awaiting_human' || !f.pr) continue;
    const r = gh('pr', 'view', String(f.pr.number), '--json', 'state,mergeCommit');
    if (r.code !== 0) continue;
    try { const v = JSON.parse(r.out); if (v.state === 'MERGED') { f.merged_sha = v.mergeCommit?.oid || null; transition(f, 'merged', 'merged by a person'); } } catch { /* ignore */ }
  }
}

function block(q, f, reason) {
  extra.blocked = true; // the run log must not file a command that blocked the feature (e.g. an exhausted CI budget, result 'timeout') as a wait
  transition(f, 'blocked', flat(reason));
  if (!clean()) git('stash', 'push', '-u', '-m', `delivery-orchestrator: partial work on ${f.id}`);
  git('checkout', q.base);
  save(q);
}

// ---- commands --------------------------------------------------------------------------------------------------------
const C = {};

// Policy file: committed, and identical on the base branch, so the rules in force are the ones that were reviewed and merged there.
function readConfigFile() {
  const p = path.join(root, CONFIG_PATH);
  if (!fs.existsSync(p)) return undefined;
  if (git('ls-files', '--error-unmatch', '--', CONFIG_PATH).code !== 0) die(`${CONFIG_PATH} exists but is not committed; commit it (and merge it to the base branch) first`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`${CONFIG_PATH} is not valid JSON: ${e.message}`); }
}

C.config = () => {
  const p = path.join(root, CONFIG_PATH);
  if (opt.write) {
    if (fs.existsSync(p)) die(`${CONFIG_PATH} already exists; edit it instead`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'delivery.json'), p);
    return emit({ written: CONFIG_PATH, next: 'edit the account, base, checks and local_checks for this project, commit it, and merge it to the base branch' });
  }
  let raw;
  if (fs.existsSync(p)) { try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`${CONFIG_PATH} is not valid JSON: ${e.message}`); } }
  const { config, errors } = parseConfig(raw);
  emit({ file: raw === undefined ? null : CONFIG_PATH, errors, effective: config });
  if (errors.length) process.exitCode = 1;
};

// Merging runs in an opted-in project need a fresh readiness result for the config now on origin/<base>.
// The cheap checks (C1, C2, C4, C5) are re-run and merged over the stored results before the level is recomputed.
async function readinessGate(config, nameWithOwner, base) {
  const { min_level: min, max_age_days: maxAge } = config.readiness;
  const where = path.join(factoryHome(), 'readiness', `${repoKey(nameWithOwner)}.json`);
  const doc = readJson(where);
  const fixList = (r) => (r.length ? `\n${r.map((f) => `  - ${f.id}: ${flat(f.what, 160)} -> ${flat(f.help, 200)}`).join('\n')}` : '');
  if (!doc || !Array.isArray(doc.results) || !Number.isInteger(doc.level)) return { refuse: `readiness is required to merge (readiness.min_level ${min}) but there is no usable result for ${nameWithOwner}: run "deliver readiness" first` };
  const at = Date.parse(doc.at);
  if (Number.isFinite(at) && at - Date.now() > 86400000) return { refuse: `the readiness result is dated in the future (${flat(doc.at, 40)}): clock skew or an edited file; run "deliver readiness" again` };
  if (!Number.isFinite(at) || Date.now() - at > maxAge * 86400000) return { refuse: `the readiness result is older than ${maxAge} days (or undated): run "deliver readiness" again` };
  if (doc.base !== base) return { refuse: `the readiness result was computed for base "${flat(doc.base ?? '(unrecorded)', 60)}" but this run's base is "${base}": run "deliver readiness" again for that base` };
  if (!doc.config_hash || doc.config_hash !== baseConfigHash(base)) return { refuse: `config changed since readiness check (${CONFIG_PATH} on origin/${base} is not the one that was checked): run "deliver readiness" again` };
  const ctx = makeCtx({ root, config, base, git, gh, repo: nameWithOwner });
  const fresh = await runChecks(ctx, { only: ['C1', 'C2', 'C4', 'C5'] });
  const freshIds = new Set(fresh.map((r) => r.id));
  const merged = [...doc.results.filter((r) => !freshIds.has(r.id)), ...fresh];
  const level = Math.min(computeLevel(merged), doc.level); // the re-run can only lower the stored level, never raise it
  if (level < min) {
    const st = new Map(merged.map((r) => [r.id, r]));
    const fixes = CHECKS.filter((c) => c.level > 0 && st.get(c.id)?.status !== 'pass').map((c) => fixItem(c.id, st.get(c.id)));
    return { refuse: `readiness level ${level} is below the required ${min}; fix these and run "deliver readiness" again:${fixList(fixes)}` };
  }
  return { level };
}

// sha256 of the raw bytes of the config file on origin/<base> (null when absent); shared by `readiness` and the init gate.
function baseConfigHash(base) {
  const shown = spawnSync('git', ['show', `${OR(base)}:${CONFIG_PATH}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return shown.status === 0 ? `sha256:${crypto.createHash('sha256').update(shown.stdout).digest('hex')}` : null;
}

// The policy in force is the config committed on origin/<base> right now, never the queue's copy (the builder can edit that).
// Read through gitSafe (GIT_* scrubbed, GIT_NO_REPLACE_OBJECTS, neutralising -c flags, raw exit codes): a planted refs/replace/* or
// repo config in this checkout cannot swap the blob that decides verification.required. Only rev-parse / ls-tree / cat-file run here,
// none of which runs a config-defined program, so the per-call config listing is skipped (verified: true) for interactive checkouts.
// `at`: read from this commit (merge passes the sha it just fetched) instead of the local tracking ref.
const og = (...a) => { try { return gitSafeOpts(root, a, { verified: true }); } catch { return { code: 1, out: '', err: '' }; } };
function baseConfigNow(base, at = OR(base)) {
  // Fail closed: a ref that does not resolve is not "no config". Defaults apply only when the ref resolves and the file is genuinely absent.
  if (og('rev-parse', '--verify', '--quiet', `${at}^{commit}`).code !== 0) return null;
  // "Absent" only when ls-tree succeeds and lists nothing; any other failure, or anything but a regular file, is unreadable (null).
  const t = og('ls-tree', '--full-tree', '-z', at, '--', CONFIG_PATH);
  if (t.code !== 0) return null;
  if (t.out === '') return parseConfig(undefined).config;
  const m = /^100(?:644|755) blob ([0-9a-f]{40,64})\t/.exec(t.out);
  if (!m) return null;
  const s = og('cat-file', 'blob', m[1]);
  if (s.code !== 0 || s.out.length > 1024 * 1024) return null;
  try { const pr = parseConfig(JSON.parse(s.out)); return pr.errors.length ? null : pr.config; } catch { return null; }
}

C.init = async () => {
  if (fs.existsSync(file)) { const q = load(); if (q.features.some((f) => !['merged', 'skipped'].includes(f.state))) die('a run is in progress; use status, or reset --yes to discard its state'); }
  const top = git('rev-parse', '--show-toplevel');
  if (top.code !== 0) die('not a git repository');
  if (fs.realpathSync(top.out) !== fs.realpathSync(root)) die(`run from the repository root (${top.out}); --dir points at a subfolder`);
  const raw = readConfigFile();
  if (!clean()) die('the working tree is not clean; commit or stash your changes first');
  const { config, errors } = parseConfig(raw);
  if (errors.length) die(`${CONFIG_PATH}: ${errors.join('; ')}`);
  useAccount(config.github.account, config.github.host);
  const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,viewerPermission'], 'gh repo view (is gh installed and logged in, and is there a GitHub remote?)');
  factoryGuard(repo.nameWithOwner);
  if (!['WRITE', 'MAINTAIN', 'ADMIN'].includes(repo.viewerPermission)) die(`the GitHub account in use has "${repo.viewerPermission}" permission on ${repo.nameWithOwner}; it needs WRITE or higher${config.github.account ? '' : ' (set github.account in the config if gh has several accounts)'}`);
  const url = git('config', '--get', 'remote.origin.url').out;
  const originHost = remoteHost(url);
  if (originHost !== config.github.host.toLowerCase()) die(`git's origin points at host "${flat(originHost || url, 60)}" but github.host is "${config.github.host}": set github.host in the config (for GitHub Enterprise) or fix the remote`);
  const origin = url.toLowerCase().replace(/\.git$/, '');
  if (!origin.endsWith(`/${repo.nameWithOwner.toLowerCase()}`) && !origin.endsWith(`:${repo.nameWithOwner.toLowerCase()}`)) die(`git's origin (${flat(origin, 100)}) is not the repository gh targets (${repo.nameWithOwner}); fix it, for example with "gh repo set-default"`);
  const base = opt.base || config.base || repo.defaultBranchRef?.name;
  if (!validRef(base)) die('could not determine a valid base branch; set "base" in the config or pass --base');
  must(gitNet('fetch', 'origin'), 'git fetch');
  if (gitNet('ls-remote', '--exit-code', '--heads', 'origin', base).code !== 0) die(`the base branch "${base}" does not exist on origin`);
  // The policy in force must be the one on the base branch (reviewed and merged there), not a local edit.
  const onBase = git('show', `${OR(base)}:${CONFIG_PATH}`);
  if (raw === undefined && onBase.code === 0) die(`origin/${base} has ${CONFIG_PATH} but this checkout does not: update your checkout first`);
  if (raw !== undefined) {
    let theirs; try { theirs = JSON.parse(onBase.out); } catch { /* handled below */ }
    if (onBase.code !== 0 || JSON.stringify(theirs) !== JSON.stringify(raw)) die(`${CONFIG_PATH} differs from the copy on origin/${base}: merge the config to ${base} first so the rules in force are the reviewed ones`);
  }
  if (opt.merge && !flat(opt.note)) die('--merge needs --note "<the user\'s own words authorising merges>"');
  const protectedBase = isProtectedBranch(base, config.protected_branches);
  // An explicit autonomy.level L0 means "never merge": --merge cannot override it. Legacy pr-only configs (no autonomy key) still honour --merge.
  const mergeIgnored = !!opt.merge && config.autonomy.explicit && config.autonomy.level === 'L0';
  const wantsMerge = (!!opt.merge && !mergeIgnored) || config.merge.mode === 'squash';
  const featuresDir = path.resolve(root, opt['features-dir'] || config.features_dir);
  if (!(featuresDir + path.sep).startsWith(fs.realpathSync(root) + path.sep) && !(featuresDir + path.sep).startsWith(root + path.sep)) die('--features-dir must be inside the repository');
  const only = parseList(opt.only);
  for (const id of only) if (!FEATURE_ID.test(id)) die(`--only has invalid id "${id}"`);
  let features;
  try { features = buildQueue(discover(featuresDir), { only, limit: opt.limit ? Number(opt.limit) : 0 }); } catch (e) { die(e.message); }
  const num = (v, d, lo, hi) => { const n = v === undefined ? d : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) die(`value ${JSON.stringify(v)} must be an integer ${lo}-${hi}`); return n; };
  config.base = base;
  const q = {
    version: 3, created: new Date().toISOString(), repo: repo.nameWithOwner, base, features_dir: path.relative(root, featuresDir) || '.',
    protected_base: protectedBase, merge: wantsMerge && !protectedBase, merge_mode: wantsMerge ? 'squash' : 'pr-only',
    no_ci: !!opt['no-ci'] || config.checks.allow_without_ci, merge_t3: !!opt['merge-t3'] || config.merge.allow_tier3,
    checks: opt.checks ? parseList(opt.checks) : config.checks.required,
    authorised_by: wantsMerge ? (opt.merge && !mergeIgnored ? flat(opt.note, 300) : `project config ${CONFIG_PATH}`) : null,
    max_fix_rounds: num(opt['max-fix-rounds'], config.limits.max_fix_rounds, 0, 5), max_failures: num(opt['max-failures'], config.limits.max_failures, 1, 10), ci_budget_s: num(opt['ci-budget'], config.limits.ci_budget_s, 1, 86400),
    // stored in the committed shape (parseConfig re-validates it on every load): autonomy appears only when the config wrote it
    policy: { ...config, autonomy: config.autonomy.explicit ? { level: config.autonomy.level } : undefined }, features,
    run_id: `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`, // one id per init: records of separate runs never share a (run, feature) key
  };
  const summary = { base, repo: q.repo, account: config.github.account || '(gh default)', merge: q.merge, protected_base: protectedBase, no_ci: q.no_ci, checks: q.checks, ignored_checks: config.checks.ignored, local_checks: config.local_checks.map((c) => c.name), hold_paths: config.hold_paths, git_auth: /^https:/i.test(url) ? 'https (uses the configured account)' : 'ssh/other (git uses your own key; the account setting applies to gh only)' };
  const warnings = [];
  if (mergeIgnored) warnings.push(`--merge ignored: ${CONFIG_PATH} sets autonomy.level "L0" (PRs only); set autonomy.level "L1" in the config and merge it to ${base} to allow merging`);
  if (protectedBase) warnings.push(`"${base}" matches protected_branches: PRs will be opened and checked but this skill will never merge into it`);
  if (!q.merge && !protectedBase) warnings.push('merging is off for this run (config merge.mode is "pr-only" and --merge was not given)');
  if (q.merge && config.readiness) {
    const g = await readinessGate(config, repo.nameWithOwner, base);
    if (g.refuse) die(g.refuse);
    q.readiness_level = g.level;
  } else {
    q.readiness_level = null;
    const stored = readJson(path.join(factoryHome(), 'readiness', `${repoKey(repo.nameWithOwner)}.json`));
    if (stored && Number.isInteger(stored.level) && stored.level < 3) warnings.push(`stored readiness level is ${stored.level} (below 3); run "deliver readiness" to see the fix list`);
  }
  if (opt['dry-run'] || !features.length) return emit({ dry_run: !!opt['dry-run'], ...summary, warnings, queue: features.map((f) => ({ id: f.id, title: f.title, deps: f.deps })), note: features.length ? 'nothing written' : 'no feature with status: ready (and not already delivered) in the features directory' });
  save(q);
  const ex = git('rev-parse', '--git-path', 'info/exclude').out;
  if (ex) { const ep = path.resolve(root, ex); const cur = fs.existsSync(ep) ? fs.readFileSync(ep, 'utf8') : ''; const add = ['.delivery/', '.implementation/'].filter((l) => !cur.split('\n').includes(l)); if (add.length) { fs.mkdirSync(path.dirname(ep), { recursive: true }); fs.appendFileSync(ep, `${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`); } }
  extra.count = features.length;
  emit({ initialised: true, ...summary, warnings, queue: features.map((f) => ({ id: f.id, title: f.title, deps: f.deps })) });
};


const HELPER_VERSION = '0.1.0';
C.readiness = async () => {
  const top = git('rev-parse', '--show-toplevel');
  if (top.code !== 0) die('not a git repository');
  if (fs.realpathSync(top.out) !== fs.realpathSync(root)) die(`run from the repository root (${top.out}); --dir points at a subfolder`);
  const repeat = opt.repeat === undefined ? 1 : Number(opt.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) die('--repeat must be an integer 1-5');
  let raw;
  const p = path.join(root, CONFIG_PATH);
  if (fs.existsSync(p)) { try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { raw = undefined; } }
  let parsed = parseConfig(raw);
  if (parsed.errors.length) parsed = parseConfig(undefined); // C1 reports the errors; the other checks run on defaults
  const config = parsed.config;
  // The working-copy config is untrusted: it is used only to pick credentials for the fetch below.
  let accountError = useAccount(config.github.account, config.github.host, { soft: true }); // C2 reports it; the run continues on gh's default login
  const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], 'gh repo view (is gh installed and logged in, and is there a GitHub remote?)');
  factoryGuard(repo.nameWithOwner);
  must(gitNet('fetch', 'origin'), 'git fetch');
  const committedConfig = (ref) => {
    const s = git('show', `${OR(ref)}:${CONFIG_PATH}`);
    if (s.code !== 0) return null;
    try { const pr = parseConfig(JSON.parse(s.out)); return pr.errors.length ? null : pr.config; } catch { return null; } // C1 reports it
  };
  // The base comes from the person (--base) or from the config committed on the default branch, never from the working copy:
  // otherwise an unreviewed edit could point readiness at any branch on origin and run that branch's commands.
  const def = repo.defaultBranchRef?.name;
  const defConfig = validRef(def) ? committedConfig(def) : null;
  const base = opt.base || defConfig?.base || def;
  if (!validRef(base)) die('could not determine a valid base branch; set "base" in the config on the default branch or pass --base');
  const sha = git('rev-parse', '--verify', `${OR(base)}^{commit}`);
  if (sha.code !== 0 || !SHA.test(sha.out)) die(`cannot resolve origin/${base}`);
  const configHash = baseConfigHash(base);
  // Commands (tests, app, seed) and every other setting come only from the reviewed copy on origin/<base>.
  // C1 still compares the working copy with it and fails when they differ.
  const reviewed = committedConfig(base);
  const runConfig = reviewed || parseConfig(undefined).config;
  if ((runConfig.github.account || null) !== (config.github.account || null) || runConfig.github.host !== config.github.host) {
    GH_ENV = {}; GH_HOSTNAME = null; // drop the bootstrap credentials; use the reviewed account (or gh's default)
    accountError = useAccount(runConfig.github.account, runConfig.github.host, { soft: true });
  }
  const ctx = makeCtx({ root, config: runConfig, base, git, gh, repo: repo.nameWithOwner, accountError });
  let results = await runChecks(ctx);
  for (let i = 1; i < repeat; i++) {
    const again = new Map((await runChecks(ctx)).map((r) => [r.id, r]));
    results = results.map((r) => (again.get(r.id)?.status === r.status ? r : { ...r, status: 'unstable', reason: `status differed between repeated runs (${r.status} then ${again.get(r.id)?.status}): ${r.reason}` }));
  }
  const level = computeLevel(results);
  const status = new Map(results.map((r) => [r.id, r]));
  const fixes = CHECKS.filter((c) => c.level > 0 && status.get(c.id)?.status !== 'pass').map((c) => fixItem(c.id, status.get(c.id)));
  const doc = { helper_version: HELPER_VERSION, base, base_sha: sha.out, config_hash: configHash, level, results, fixes, at: new Date().toISOString() };
  const where = path.join(factoryHome(), 'readiness', `${repoKey(repo.nameWithOwner)}.json`);
  writeJsonAtomic(where, doc);
  const min = runConfig.readiness?.min_level ?? 1;
  extra.level = level;
  if (opt.json) emit({ ...doc, file: where, min_level: min });
  else {
    console.log(`readiness level ${level} (required ${min}) for ${repo.nameWithOwner} at ${base} ${sha.out.slice(0, 8)}`);
    for (const r of results) console.log(`  ${r.id} ${r.status}${r.reason ? `: ${flat(r.reason, 160)}` : ''}`);
    console.log(`${fixes.length} fix item${fixes.length === 1 ? '' : 's'}; saved to ${where}`);
  }
  if (level < min) process.exitCode = 2;
};

C.next = () => {
  const q = load();
  refresh(q);
  const stop = runStop(q);
  const before = new Map(q.features.map((x) => [x.id, x.state]));
  const { item: f, resume } = pickNext(q);
  for (const x of q.features) if (before.get(x.id) !== x.state) note(x); // dependency skips are made inside queue.mjs
  save(q);
  if (f && resume) { extra.feature = f.id; return emit({ resume: true, feature: pub(f), base: q.base }); }
  if (stop || !f) return emit({ done: true, reason: stop || 'queue finished', summary: counts(q) });
  if (!clean()) die('the working tree is not clean; resolve it before starting the next feature');
  must(gitNet('fetch', 'origin'), 'git fetch');
  must(git('checkout', q.base), `git checkout ${q.base}`);
  if (git('merge', '--ff-only', OR(q.base)).code !== 0) die(`local ${q.base} has diverged from origin/${q.base}; fix it by hand, then run next again`);
  const branch = `${q.policy.branch_prefix}${f.id.toLowerCase()}-${slugify(f.title)}`;
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).code === 0) {
    // A crash between creating the branch and saving state leaves a branch at the base tip: reuse it. Anything else is someone's work.
    if (git('rev-parse', `refs/heads/${branch}`).out !== git('rev-parse', 'HEAD').out) die(`branch ${branch} already exists locally with other commits; delete or rename it, then run next again`);
    must(git('checkout', branch), 'git checkout');
  } else must(git('checkout', '-b', branch), 'git checkout -b');
  f.branch = branch;
  f.base_sha = git('rev-parse', 'HEAD').out;
  f.ts_start ||= new Date().toISOString();
  transition(f, 'building');
  save(q);
  extra.feature = f.id;
  emit({ resume: false, feature: pub(f), base: q.base, ledger_name: f.id.toLowerCase(), guidance: q.policy.implementer_notes || undefined, local_checks: q.policy.local_checks.map((c) => c.name) });
};

const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
// The spec on the feature branch is implementer-written: read without following a link (a committed symlink to /dev/zero or a FIFO
// would hang or exhaust memory), a regular file of at most SPEC_MAX bytes, or refused (nothing changed).
function readSpec(file) {
  const rel = flat(path.relative(root, String(file)), 120);
  let fd;
  try {
    const lst = fs.lstatSync(file);
    if (!lst.isFile()) die(`spec file ${rel} is not a regular file (a symlink or special file is never read)`);
    if (lst.size > SPEC_MAX) die(`spec file ${rel} is larger than ${SPEC_MAX} bytes`);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.ino !== lst.ino || st.dev !== lst.dev) die(`spec file ${rel} is not a regular file (changed while read)`);
    if (st.size > SPEC_MAX) die(`spec file ${rel} is larger than ${SPEC_MAX} bytes`);
    return fs.readFileSync(fd, 'utf8');
  } catch (e) {
    if (e?.code === 'ELOOP') die(`spec file ${rel} is not a regular file (a symlink or special file is never read)`);
    if (e?.code) die(`spec file ${rel} cannot be read (${e.code})`);
    throw e;
  } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}
C.built = () => {
  const q = load(); const f = item(q);
  need(f, 'building', 'built');
  if (branchNow() !== f.branch) die(`expected to be on ${f.branch}, on ${branchNow()}`);
  if (!clean()) die('uncommitted changes remain; commit them (or discard) before reporting built');
  const ahead = Number(git('rev-list', '--count', `${OR(q.base)}..HEAD`).out);
  if (!(ahead >= 1)) { block(q, f, 'no commits on the feature branch'); return outcome({ id: f.id, state: f.state, reason: f.reason }); }
  const delivery = (frontmatter(readSpec(f.file)).delivery || 'none').toLowerCase();
  if (delivery !== 'complete') { block(q, f, `spec delivery is "${delivery}", not complete`); return outcome({ id: f.id, state: f.state, reason: f.reason }); }
  // Project-defined checks the orchestrator runs itself (argv, no shell), so "tests passed" does not rest on the implementer's word.
  const failing = [];
  f.local = [];
  for (const c of q.policy.local_checks) {
    const r = spawnSync(c.command[0], c.command.slice(1), { cwd: root, encoding: 'utf8', timeout: c.timeout_s * 1000, maxBuffer: 16 * 1024 * 1024 });
    const ok = r.status === 0 && !r.error;
    f.local.push({ name: c.name, ok });
    if (!ok) failing.push({ name: c.name, exit: r.status ?? (r.error?.code || 'error'), tail: flat(`${r.stderr || ''} ${r.stdout || ''}`.slice(-600), 400) });
  }
  if (failing.length) {
    f.local_attempts = (f.local_attempts || 0) + 1;
    if (f.local_attempts > q.max_fix_rounds + 1) { block(q, f, `local check "${failing[0].name}" still failing after ${f.local_attempts} attempts`); return outcome({ id: f.id, result: 'local_check_failed', state: f.state, reason: f.reason, failing }); }
    save(q);
    return outcome({ id: f.id, result: 'local_check_failed', state: f.state, failing, attempts: f.local_attempts, next: 'fix the failure, commit, then run built again' });
  }
  // The implementer's ledger can only raise the tier, never lower what the orchestrator was told.
  const ledger = path.join(root, '.implementation', f.id.toLowerCase(), 'tasks.json');
  const tiers = [opt.tier];
  if (fs.existsSync(ledger)) { try { tiers.push(JSON.parse(fs.readFileSync(ledger, 'utf8')).tier); } catch { /* ignore */ } }
  const known = tiers.filter((t) => t in RANK);
  if (!known.length) die('need the implementer tier: pass --tier T0|T1|T2|T3 (or keep the ledger under .implementation/<feature-id>/)');
  f.tier = known.sort((a, b) => RANK[b] - RANK[a])[0];
  f.built_sha = git('rev-parse', 'HEAD').out;
  f.ci_files = ciFiles(q, 'HEAD');
  if (f.state === 'building') transition(f, 'built');
  save(q);
  emit({ id: f.id, state: f.state, tier: f.tier, commits: ahead, sha: f.built_sha, ci_files_touched: f.ci_files });
};
// -z: NUL-separated, never quoted or escaped, so a path with unusual characters cannot hide from the pattern list. A failing diff holds the merge.
const ciFiles = (q, rev) => {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', `${OR(q.base)}...${rev}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return ['(could not list the changed files)'];
  const files = r.stdout.split('\0').filter(Boolean);
  const policy = files.filter((x) => x.toLowerCase() === CONFIG_PATH || matchesAny(x, q.policy.hold_paths)); // the config itself, and paths the project wants a person to review
  return [...new Set([...touchesCi(files), ...policy])];
};

C.pr = () => {
  const q = load(); const f = item(q);
  need(f, 'built');
  const title = flat(opt.title, 120);
  if (title.length < 5) die('--title is required (5-120 characters)');
  const state = fs.existsSync(dirState) ? fs.realpathSync(dirState) : '';
  const bodyPath = opt['body-file'] && fs.existsSync(path.resolve(root, opt['body-file'])) ? fs.realpathSync(path.resolve(root, opt['body-file'])) : '';
  if (!bodyPath || !state || !bodyPath.startsWith(state + path.sep) || !fs.statSync(bodyPath).isFile() || fs.statSync(bodyPath).size > 60000) die('--body-file must be a file inside .delivery/ (up to 60 KB)');
  if (branchNow() !== f.branch) die(`expected to be on ${f.branch}, on ${branchNow()}`);
  if (git('rev-parse', 'HEAD').out !== f.built_sha) die('the branch has commits after "built" was recorded; run built again so the new commits are checked');
  must(gitNet('push', '-u', 'origin', f.branch), 'git push');
  const open = ghJson(['pr', 'list', '--head', f.branch, '--state', 'open', '--json', 'number,url,isCrossRepository'], 'gh pr list').filter((p) => !p.isCrossRepository);
  let number = open[0]?.number;
  if (!number) {
    const url = must(gh('pr', 'create', '--base', q.base, '--head', f.branch, '--title', title, '--body-file', bodyPath), 'gh pr create');
    number = Number((url.match(/\/pull\/(\d+)/) || [])[1]);
    if (!number) die('gh pr create did not print a pull request URL');
  }
  const v = ghJson(['pr', 'view', String(number), '--json', 'number,url,headRefOid,headRefName,isCrossRepository'], 'gh pr view');
  if (v.isCrossRepository || v.headRefName !== f.branch) die(`PR #${number} is not from ${f.branch} in this repository`);
  f.pr = { number: v.number, url: v.url, head_sha: v.headRefOid };
  transition(f, 'pr_open');
  save(q);
  emit({ id: f.id, state: f.state, pr: f.pr });
};

function checksOf(n) {
  const r = gh('pr', 'checks', String(n), '--json', 'name,bucket,link,state');
  try { return JSON.parse(r.out); } catch { /* fall through */ }
  if (/no checks reported/i.test(`${r.err} ${r.out}`)) return [];
  die(`gh pr checks failed: ${(r.err || r.out).split('\n')[0].slice(0, 200)}`);
}
function requiredOf(n) { // checks the base branch's protection requires; empty when none are configured
  const r = gh('pr', 'checks', String(n), '--required', '--json', 'name,bucket');
  try { const a = JSON.parse(r.out); return Array.isArray(a) ? a.map((c) => flat(c.name, 80)) : []; } catch { return []; }
}
const headOf = (n) => ghJson(['pr', 'view', String(n), '--json', 'headRefOid'], 'gh pr view').headRefOid;
const lc = (s) => String(s).toLowerCase();
const isIgnored = (q, name) => matchesAny(name, q.policy.checks.ignored); // e.g. a project without real e2e can list its flaky or absent suites

C.ci = () => {
  const q = load(); const f = item(q);
  need(f, 'pr_open');
  const timeout = Number(opt.timeout ?? 1800) * 1000, interval = Number(opt.interval ?? 20) * 1000, grace = Number(opt.grace ?? 90) * 1000;
  if (![timeout, interval, grace].every((n) => Number.isFinite(n) && n >= 0)) die('--timeout, --interval and --grace are seconds (numbers >= 0)');
  const start = Date.now();
  ciStart = start;
  let unstable = 0;
  for (;;) {
    // Head and checks are read around each other: checks of an older commit are never stamped onto a newer head.
    const before = headOf(f.pr.number);
    const checks = checksOf(f.pr.number).filter((c) => !isIgnored(q, c.name));
    // factory/verified is posted by the factory driver AFTER CI passed (verification runs on the CI-passed sha): waiting for it here
    // would never end. It is still required at merge (branch protection), where it must be on the commit.
    const required = requiredOf(f.pr.number).filter((n) => !isIgnored(q, n) && lc(n) !== 'factory/verified');
    const sha = headOf(f.pr.number);
    if (sha !== before) { if (++unstable > 5) die('the PR head keeps changing; stop pushing to it and run ci again'); continue; }
    const needed = q.checks.length ? q.checks : required;
    const by = new Map(checks.map((c) => [lc(c.name), c.bucket]));
    const failed = checks.filter((c) => ['fail', 'cancel'].includes(c.bucket));
    const pending = checks.some((c) => c.bucket === 'pending');
    const elapsed = Date.now() - start;
    const verified = (how, names) => { tallyCi(f); f.pr.head_sha = sha; f.ci_sha = sha; f.ci = how; f.ci_checks = names; transition(f, 'ci_passed'); save(q); return emit({ id: f.id, result: how === 'verified' ? 'passed' : 'unverified-allowed', checks: names, sha, ...(how === 'verified' ? {} : { note: 'no required or allowlisted check exists; proceeding because the run was started with --no-ci' }) }); };

    if (failed.length) {
      tallyCi(f);
      f.pr.head_sha = sha;
      transition(f, 'ci_failed', `failed: ${failed.map((c) => flat(c.name, 60)).join(', ')}`.slice(0, 200));
      const failing = failed.map((c) => ({ name: flat(c.name, 80), link: flat(c.link, 300) }));
      if (f.fix_rounds >= q.max_fix_rounds) { block(q, f, `CI still failing after ${f.fix_rounds} fix round(s)`); return outcome({ id: f.id, result: 'failed', state: f.state, reason: f.reason, failing, fix_allowed: false }); }
      save(q);
      return outcome({ id: f.id, result: 'failed', failing, fix_rounds_used: f.fix_rounds, fix_allowed: true });
    }
    if (needed.length) { // a named check must exist and pass: a lint or secret scanner passing proves nothing about the tests
      const missing = needed.filter((n) => !by.has(lc(n)));
      const notPassed = needed.filter((n) => by.has(lc(n)) && by.get(lc(n)) !== 'pass');
      if (!missing.length && !notPassed.length && !pending) return verified('verified', needed);
      if (elapsed >= timeout) return waited(q, f, elapsed, { pending: [...missing.map((n) => `${n} (not reported)`), ...notPassed] });
    } else if (!pending) {
      if (!checks.length || !checks.some((c) => c.bucket === 'pass')) { // nothing ran
        if (elapsed >= grace) {
          if (q.no_ci) return verified('unverified', []);
          return stopRun(q, f, 'no CI checks were reported, so nothing verifies the merge. Add CI, or run retry with --no-ci to merge on local test evidence.');
        }
      } else { // checks exist and passed, but none is required by branch protection or named in --checks
        if (q.no_ci) return verified('unverified', checks.map((c) => flat(c.name, 80)));
        return stopRun(q, f, `checks passed (${checks.map((c) => flat(c.name, 40)).join(', ')}) but none is required by branch protection or named in --checks, so it is unclear any of them runs the tests. Run retry with --checks "<name of the test check>" (or protect the base branch with required checks, or --no-ci).`);
      }
    } else if (elapsed >= timeout) return waited(q, f, elapsed, { pending: checks.filter((c) => c.bucket === 'pending').map((c) => flat(c.name, 80)) });
    sleep(interval);
  }
};
function waited(q, f, elapsed, more) {
  tallyCi(f);
  f.ci_waited_s = (f.ci_waited_s || 0) + Math.round(elapsed / 1000);
  if (f.ci_waited_s >= q.ci_budget_s) { block(q, f, `CI did not finish within ${q.ci_budget_s}s`); return outcome({ id: f.id, result: 'timeout', state: f.state, reason: f.reason }); }
  save(q);
  return outcome({ id: f.id, result: 'timeout', waited_total_s: f.ci_waited_s, budget_s: q.ci_budget_s, ...more });
}
function stopRun(q, f, why) {
  tallyCi(f);
  q.stop = why;
  transition(f, 'awaiting_human', flat(why, 160)); save(q);
  return outcome({ id: f.id, result: 'unconfirmed', stop: why });
}

C.fix = () => {
  const q = load(); const f = item(q);
  need(f, 'ci_failed', 'verify_failed');
  if (f.fix_rounds >= q.max_fix_rounds) { block(q, f, `${f.state === 'verify_failed' ? 'verification' : 'CI'} still failing after ${f.fix_rounds} fix round(s)`); return outcome({ id: f.id, state: f.state, reason: f.reason }); }
  if (!clean()) die('the working tree is not clean');
  if (branchNow() !== f.branch) must(git('checkout', f.branch), 'git checkout');
  // GitHub may have added commits (an "update branch" merge): start from the remote tip so the fix can be pushed without force.
  must(gitNet('fetch', 'origin', f.branch), 'git fetch');
  if (git('merge', '--ff-only', OR(f.branch)).code !== 0) die(`local ${f.branch} and origin/${f.branch} have diverged; resolve it by hand`);
  f.fix_rounds++;
  transition(f, 'fixing');
  save(q);
  emit({ id: f.id, round: f.fix_rounds, of: q.max_fix_rounds });
};

C.push = () => {
  const q = load(); const f = item(q);
  need(f, 'fixing');
  if (branchNow() !== f.branch) die(`expected to be on ${f.branch}, on ${branchNow()}`);
  if (!clean()) die('uncommitted changes remain; commit the fix first');
  const head = git('rev-parse', 'HEAD').out;
  if (head === f.pr.head_sha) die('no new commit since CI failed; fix and commit first');
  must(gitNet('push', 'origin', f.branch), 'git push'); // never forced
  f.pr.head_sha = head;
  f.ci_files = ciFiles(q, 'HEAD');
  transition(f, 'pr_open');
  save(q);
  emit({ id: f.id, state: f.state, sha: head, ci_files_touched: f.ci_files });
};

// ---- verdict gate (merge) ----------------------------------------------------------------------------------------------
// Raw, hardened git for the gate: stdout untrimmed, real exit codes (checkDiff needs both), GIT_* scrubbed, neutralising -c flags,
// --no-ext-diff/--no-textconv on diffs, a timeout; signals, timeouts and overflows throw. Every command is read-only on objects and
// refs (rev-parse, merge-base, ls-tree, cat-file, diff between two shas). `verified: true` skips the per-call config listing: the gate
// runs gatePreflight() once first on the same cwd (config allowlist + planted repository metadata), as gitsafe requires.
const rawGit = (...a) => gitSafeOpts(root, a, { verified: true });
// Throws unless the checkout's config passes the gitsafe allowlist, no grafts / shallow / alternates / commit-graph / config.worktree
// exist, and there is no refs/replace/* ref.
// PRECONDITION (safety.md): merge with a verdict gate runs in a driver-owned clone the builder cannot write to.
const gatePreflight = () => { verifyGitConfig(root); checkRepoMetadata(root); checkNoReplaceRefs(root); };
// The queue file is trusted only as a private regular file under FACTORY_HOME (by realpath: a sibling "fhome-x" or a link out does
// not count), outside the repository, with FACTORY_HOME neither the repository nor an ancestor of it; one link, ours, not
// group/other writable.
const within = (p, d) => p === d || p.startsWith(d + path.sep);
const queueInHome = () => {
  try {
    const h = fs.realpathSync(factoryHome()), r = fs.realpathSync(root), q = fs.realpathSync(file);
    // The one repository allowed under FACTORY_HOME is the driver's own clone of this queue's repo (clones/<repo-key>), which
    // the builder cannot write (it works in a separate clone outside FACTORY_HOME).
    let driverClone = false;
    try { driverClone = !!curQ && fs.realpathSync(path.join(h, 'clones', repoKey(curQ.repo))) === r; } catch { driverClone = false; }
    if (!q.startsWith(h + path.sep) || within(q, r) || (within(r, h) && !driverClone)) return false;
    const st = fs.lstatSync(q);
    return st.isFile() && st.nlink === 1 && st.uid === process.getuid() && (st.mode & 0o022) === 0;
  } catch { return false; }
};
const SPEC_MAX = 256 * 1024;
const PART_OK = (p) => p.split('/').every((x) => x !== '' && x !== '.' && x !== '..');
const specTooBig = (t) => t.length > SPEC_MAX || t.split('\n').some((l) => l.length > MAX_LINE); // never parse a hostile size
// The feature's spec, repo-relative: must be <...>/<ID>.md inside the repository (the queue's absolute path is only a pointer).
function specRel(f) {
  const rel = path.relative(root, String(f.file || '')).split(path.sep).join('/');
  if (!rel || path.isAbsolute(rel) || !PART_OK(rel) || /[\0\n:\\]/.test(rel) || path.posix.basename(rel) !== `${f.id}.md`) throw new Error('feature spec path is not a normalised repo-relative path');
  return rel;
}
// G5 covers every feature spec in the base config's features_dir on origin/<base>, plus this feature's spec.
function specList(base, featuresDir, own) {
  const dir = String(featuresDir).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!dir || !PART_OK(dir) || /[\0\n:\\*?[]/.test(dir)) throw new Error('features_dir is not a normalised repo-relative path');
  const r = rawGit('ls-tree', '-z', '--name-only', '--full-tree', OR(base), '--', `${dir}/`);
  if (r.code !== 0) throw new Error('ls-tree failed');
  const names = r.out.split('\0').filter((n) => n.startsWith(`${dir}/`) && /^FEATURE-\d+\.md$/.test(n.slice(dir.length + 1)));
  if (names.length > 5000) throw new Error('too many specs');
  return [...new Set([...names, own])];
}
// null when the merge may go on; otherwise { why, kind } with a category reason only (never scenario text, ids or paths).
function verdictGate(q, f, bc, headSha) {
  const G = (why, kind = 'verification') => ({ why, kind });
  const rk = repoKey(q.repo);
  let crHash, rel;
  try {
    rel = specRel(f);
    const s = specFromBase(rawGit, q.base, rel);
    if (!s.ok) return G(`verification gate: the feature spec on origin/${q.base} cannot be read (${s.reason}): the criteria_hash cannot be recomputed`);
    if (specTooBig(s.text)) return G(`verification gate: the feature spec on origin/${q.base} is too large to hash safely`);
    crHash = criteriaHash(extractCriteria(s.text).sections);
  } catch { return G('verification gate: the criteria_hash could not be recomputed from the base spec'); }
  const vd = readVerdict(rk, f.id, headSha); // fail-closed: null unless a shape-valid file for exactly this feature and sha
  if (!vd) return G(`verification gate: no valid verification verdict for commit ${headSha.slice(0, 8)}: a person reviews it, or verify again`);
  let doc, scHash;
  try { doc = loadScenarios(rk, f.id); if (doc) scHash = scenariosHash(doc); } catch { doc = null; }
  if (!doc || doc.feature !== f.id || typeof scHash !== 'string') return G('verification gate: the stored scenarios are missing or unreadable, so the verdict cannot be bound to them');
  if (!verdictMatches(vd, { sha: headSha, scenariosHash: scHash, criteriaHash: crHash })) {
    const what = vd.verdict !== 'pass' ? 'the verdict for this commit is not a pass'
      : vd.scenarios_hash !== scHash ? 'the scenarios changed after verification (scenarios_hash mismatch)'
        : vd.criteria_hash !== crHash ? 'the spec criteria changed after verification (criteria_hash mismatch)' : 'the verdict does not match this commit';
    return G(`verification gate: ${what}; verify again`);
  }
  // The base config's approval mode applies here too: under "human", an "auto" approval does not count.
  if (!isCurrentApproved(doc, crHash, bc?.verification?.scenario_approval ?? 'human')) return G('verification gate: the stored scenarios are not approved for the current criteria');
  let hits;
  try {
    hits = checkDiff({ git: rawGit, baseRef: OR(q.base), headSha, config: bc, specPaths: specList(q.base, bc.features_dir, rel) });
    if (classify(hits, 'merge') === 'clean') return null;
  } catch { return { ...G('anti-gaming checks could not run on the merge commit (fail-closed): a person reviews it', 'antigaming'), ids: [] }; }
  // A person's override (retry --note at a terminal) counts only for this exact head and only for the G-ids it was given for,
  // and only from a queue the builder cannot write.
  const ids = holdReason(hits).ids;
  if (queueInHome() && overrideValid(f, headSha, ids)) return null;
  return { ...G(`anti-gaming check ${ids.join(', ')} hit on the merge commit: a person reviews it (deliver retry ${f.id} --note at a terminal overrides it for this commit)`, 'antigaming'), ids };
}

// Fetch for merge: an EXPLICIT refspec (a planted remote.origin.fetch cannot leave a stale or forged tracking ref in place).
// origin must resolve (`remote get-url --all`, i.e. after repo-config insteadOf rewriting) to EXACTLY one URL that is the pinned
// repository: host equal to the configured GitHub host, path equal to q.repo. Driver mode (after the preflight) additionally
// refuses any remote.origin.pushurl, and fetches from a URL REBUILT from the pinned host + q.repo (scheme and ssh user follow the
// checked origin, so the configured credentials still apply), never from the named remote; the fetch is hardened with the gitSafe
// neutralising flags (hooks off, ext:: off, plain ssh, no redirects, no submodules, no gc/maintenance, no commit-graph) on top of
// gitNet. protocol.file and the credential flags are left to gitNet (gitNet supplies the account token). Interactive mode keeps the
// named-remote gitNet fetch through your own config (env and global-config rewrites are yours and are not seen by this check).
const HARD = (() => { const out = []; for (let i = 0; i < GIT_SAFE_FLAGS.length; i += 2) if (!/^(protocol\.file\.allow|credential\.helper|core\.askPass)=/.test(GIT_SAFE_FLAGS[i + 1])) out.push(GIT_SAFE_FLAGS[i], GIT_SAFE_FLAGS[i + 1]); return out; })();
const urlPath = (u) => { const m = /^(?:(?:https|ssh):\/\/[^/]+\/|[A-Za-z0-9._-]+@[^:/]+:)(.+?)(?:\.git)?\/?$/i.exec(String(u)); return m ? m[1].toLowerCase() : null; };
const pinHost = (q) => (GH_HOSTNAME || q.policy?.github?.host || 'github.com').toLowerCase();
// The single URL origin resolves to, when it is the pinned repository; otherwise null.
function originUrl(q, driver) {
  const r = og('remote', 'get-url', '--all', 'origin');
  const urls = r.code === 0 ? r.out.split('\n').map((x) => x.trim()).filter(Boolean) : [];
  if (urls.length !== 1) return null;
  const url = urls[0];
  if (remoteHost(url) !== pinHost(q) || urlPath(url) !== String(q.repo).toLowerCase()) return null;
  if (driver) { const p = og('config', '--get-all', 'remote.origin.pushurl'); if (p.code !== 1 || p.out.trim()) return null; } // 1 = key absent
  return url;
}
// Rebuilt from the pin, never copied from config: https://<host>/<owner>/<repo>.git, or <user>@<host>:<owner>/<repo>.git for ssh.
const pinnedUrl = (q, url) => (/^https:/i.test(url) ? `https://${pinHost(q)}/${q.repo}.git` : `${(/^(?:ssh:\/\/)?([A-Za-z0-9._-]+)@/.exec(url) || [, 'git'])[1]}@${pinHost(q)}:${q.repo}.git`);
const fetchRef = (q, url, branch, driver) => (driver ? gitNet(...HARD, 'fetch', pinnedUrl(q, url), `+refs/heads/${branch}:${OR(branch)}`) : gitNet('fetch', 'origin', `+refs/heads/${branch}:${OR(branch)}`));
// The files of the change that need a person, computed with gitSafe (no replace objects, raw output); throws on any git failure.
function ciFilesAt(pq, rev) {
  const mb = rawGit('merge-base', OR(pq.base), rev);
  const base = mb.code === 0 ? mb.out.trim() : '';
  if (!SHA.test(base) || !SHA.test(rev)) throw new Error('merge-base failed');
  const r = rawGit('-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', base, rev);
  if (r.code !== 0) throw new Error('diff failed');
  const files = r.out.split('\0').filter(Boolean);
  const policy = files.filter((x) => x.toLowerCase() === CONFIG_PATH || matchesAny(x, pq.policy.hold_paths));
  return [...new Set([...touchesCi(files), ...policy])];
}

C.merge = () => {
  const q = load(); const f = item(q);
  need(f, 'ci_passed', 'verified');
  // kind: 'verification' (plain retry re-runs CI and verification) or 'antigaming' (retry needs a person at a terminal, --note).
  // An anti-gaming hold records the held commit and G-ids: retry --note can only override exactly those (see C.retry).
  const hold = (why, kind, at) => { if (kind || f.hold_kind) f.hold_kind = kind || null; if (at) { f.hold_sha = at.sha; f.hold_ids = at.ids; } transition(f, 'awaiting_human', flat(why, 200)); save(q); return outcome({ id: f.id, state: f.state, reason: flat(why, 200), pr: f.pr, ...(kind ? { hold_kind: kind } : {}) }); };
  // Driver mode (a trusted queue, or the local copy of the base config already asks for verification): the checkout must pass the
  // preflight and have no hooks BEFORE the fetch, which then runs hardened. The stale local config only picks the mode; never policy.
  const driver = queueInHome() || !!baseConfigNow(q.base)?.verification.required;
  if (driver) { try { gatePreflight(); checkNoHooks(root); } catch { return hold('verification gate: this checkout is not a trusted clone (git config outside the allowlist, a hook, or planted grafts, shallow, alternates, commit-graph, config.worktree or replace refs): run merge from the driver-owned clone', 'verification'); } }
  const oUrl = originUrl(q, driver);
  if (!oUrl) return hold(`origin's URL is not ${q.repo} on ${pinHost(q)} (it must resolve to exactly one URL${driver ? ', with no pushurl' : ''}): the base branch and its policy cannot be fetched from a trusted remote`, 'verification');
  if (fetchRef(q, oUrl, q.base, driver).code !== 0) return hold(`${CONFIG_PATH} on origin/${q.base} cannot be read: fetching refs/heads/${q.base} from origin failed`, 'verification');
  // The policy is read from exactly the commit just fetched, and the tracking ref every later check uses must point at it.
  const fh = og('rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'), tr = og('rev-parse', '--verify', '--quiet', `${OR(q.base)}^{commit}`);
  const baseSha = fh.code === 0 ? fh.out.trim() : '';
  if (!SHA.test(baseSha) || tr.code !== 0 || tr.out.trim() !== baseSha) return hold(`${CONFIG_PATH} on origin/${q.base} cannot be read: the tracking ref does not match the commit just fetched`, 'verification');
  const view = () => ghJson(['pr', 'view', String(f.pr.number), '--json', 'state,isDraft,mergeStateStatus,headRefOid,headRefName,baseRefName,mergeCommit,autoMergeRequest,isCrossRepository'], 'gh pr view');
  let v = view();
  if (v.isCrossRepository || v.headRefName !== f.branch || v.baseRefName !== q.base) die(`PR #${f.pr.number} is ${v.headRefName} -> ${v.baseRefName}${v.isCrossRepository ? ' (from a fork)' : ''}, expected ${f.branch} -> ${q.base} in this repository`);
  if (v.state === 'MERGED' && v.headRefOid === f.ci_sha) return merged(q, f, v.mergeCommit?.oid, ['GitHub had already merged this PR (an earlier run was interrupted)']);
  // Policy in force is the config on origin/<base> now, for every state (checked after the already-merged recovery so a hand-merged
  // PR still resolves). The queue's `policy` copy is never consulted below: a forged copy has no effect.
  const bc = baseConfigNow(q.base, baseSha);
  if (!bc) return hold(`${CONFIG_PATH} on origin/${q.base} cannot be read (missing ref or invalid): not assuming defaults; fix it, then retry`, 'verification');
  const required = bc.verification.required;
  if (required && f.state === 'ci_passed') die(`verification is required by ${CONFIG_PATH} on origin/${q.base}: ${f.id} must be verified before it can merge`);
  const pq = { ...q, policy: bc }; // base policy for ciFiles / isIgnored
  // Verified mode: the queue holds the override fields and the run flags, so it must live where the builder cannot write (FACTORY_HOME).
  if (required && !queueInHome()) return hold(`verification is required but the queue file is not under FACTORY_HOME (it may be builder-writable): run merges through the factory driver`, 'verification');
  if (q.protected_base || isProtectedBranch(q.base, bc.protected_branches)) return hold(`"${q.base}" is a protected branch in this project's config (protected_branches): this skill never merges into it. The PR is ready for a person`);
  if (!q.merge) return hold('merging was not authorised for this run (config merge.mode is "pr-only" and --merge was not given): the PR is ready for you');
  if (og('cat-file', '-e', `${f.ci_sha}^{commit}`).code !== 0) must(fetchRef(q, oUrl, f.branch, driver), 'git fetch');
  let ci = null; // recomputed on the verified commit with gitSafe, renames included; a git failure holds (after the gate, below)
  try { ci = [...new Set([...(f.ci_files || []), ...ciFilesAt(pq, f.ci_sha)])]; } catch { /* ci stays null */ }
  // T3 needs the opt-in AND a matching passing verdict, in every mode; with verification required every feature needs the verdict.
  if (f.tier === 'T3' && !q.merge_t3) return hold('T3 work (auth, data, migrations or public API) needs a person to review before merge');
  if (required || f.tier === 'T3') {
    if (required && (v.state !== 'OPEN' || v.isDraft)) die(`PR #${f.pr.number} is ${v.isDraft ? 'a draft' : v.state}`);
    // Required: the verdict must be for the PR head as GitHub reports it now, and that must be the commit CI passed on.
    const headSha = required ? v.headRefOid : f.ci_sha;
    if (required && !(SHA.test(String(headSha)) && headSha === f.ci_sha)) return hold(`the PR head moved after verification (or cannot be resolved): ${f.id} is verified for ${String(f.ci_sha).slice(0, 8)} only; retry to run CI and verification again`, 'verification');
    try { gatePreflight(); } catch { return hold('verification gate: this checkout is not a trusted clone (git config outside the allowlist, or planted grafts, shallow, alternates or config.worktree), so no verdict can be checked here: run merge from the driver-owned clone', 'verification'); }
    let g;
    try { g = verdictGate(q, f, bc, headSha); } catch { g = { why: 'verification gate: the verdict could not be checked (fail-closed)', kind: 'verification' }; }
    if (g) return hold(`${f.tier === 'T3' && !required ? 'T3 work: ' : ''}${g.why}`, g.kind, g.kind === 'antigaming' ? { sha: headSha, ids: g.ids || [] } : null);
  }
  if (!ci) return hold('the changed files could not be listed on the verified commit (fail-closed): a person reviews it', 'verification');
  if (ci.length) return hold(`the change touches CI or ownership files (${ci.slice(0, 3).join(', ')}): a person must review it`);
  if (v.state !== 'OPEN' || v.isDraft) die(`PR #${f.pr.number} is ${v.isDraft ? 'a draft' : v.state}`);
  if (v.headRefOid !== f.ci_sha) { transition(f, 'pr_open'); save(q); return outcome({ id: f.id, result: 'stale', reason: 'the PR head changed after CI passed: wait for CI again', next: 'ci' }); }
  // Do not trust the state file for "CI passed": ask GitHub again about this exact commit, whatever the file says.
  const needed = q.checks.length ? q.checks : requiredOf(f.pr.number).filter((n) => !isIgnored(pq, n));
  const now = new Map(checksOf(f.pr.number).filter((c) => !isIgnored(pq, c.name)).map((c) => [lc(c.name), c.bucket]));
  const bad = [...now.values()].some((x) => ['fail', 'cancel', 'pending'].includes(x)) || needed.some((n) => now.get(lc(n)) !== 'pass');
  if (bad || (!needed.length && !q.no_ci)) return hold('GitHub does not show the required checks passing on this commit: a person decides');
  if (v.autoMergeRequest) return hold('auto-merge or a merge queue is already enabled on this PR: a person decides');
  for (let i = 0; v.mergeStateStatus === 'UNKNOWN' && i < 5; i++) { sleep(Number(opt.settle ?? 2) * 1000); v = view(); } // GitHub computes this lazily
  if (v.mergeStateStatus === 'BEHIND') {
    f.update_rounds = (f.update_rounds || 0) + 1;
    if (f.update_rounds > 2) return hold('the base keeps moving: the branch was updated twice already');
    must(gh('pr', 'update-branch', String(f.pr.number)), 'gh pr update-branch'); transition(f, 'pr_open'); save(q);
    return outcome({ id: f.id, result: 'updated', reason: 'the branch was behind the base and was updated on GitHub: wait for CI again', next: 'ci' });
  }
  if (v.mergeStateStatus === 'DIRTY') { block(q, f, 'merge conflict with the base branch'); return outcome({ id: f.id, state: f.state, reason: f.reason }); }
  if (v.mergeStateStatus === 'UNSTABLE') return hold('a non-required check is failing: a person decides');
  if (!['CLEAN', 'HAS_HOOKS'].includes(v.mergeStateStatus)) return hold(`GitHub reports the PR is "${v.mergeStateStatus}" (required reviews, required checks or branch protection): a person must act`);
  const m = gh('pr', 'merge', String(f.pr.number), '--squash', '--match-head-commit', f.ci_sha);
  const after = view();
  if (after.state === 'MERGED') return merged(q, f, after.mergeCommit?.oid, m.code === 0 ? [] : ['gh reported an error after the merge went through; verified on GitHub']);
  if (after.autoMergeRequest) { gh('pr', 'merge', String(f.pr.number), '--disable-auto'); return hold('GitHub queued the merge or enabled auto-merge instead of merging now; auto-merge was switched off. A person decides'); }
  return hold(m.code !== 0 ? `gh pr merge refused: ${flat(m.err || m.out, 160)}` : `gh pr merge returned success but the PR is "${after.state}"`);
};
function merged(q, f, sha, warn = []) {
  f.merged_sha = sha || null;
  transition(f, 'merged');
  gitNet('push', 'origin', '--delete', f.branch); // best effort: many repos delete merged branches themselves
  if (git('checkout', q.base).code !== 0 || gitNet('fetch', 'origin').code !== 0 || git('merge', '--ff-only', OR(q.base)).code !== 0) warn.push(`could not fast-forward local ${q.base}; fix it before the next feature`);
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${f.branch}`).code === 0) git('branch', '-D', f.branch);
  save(q);
  emit({ id: f.id, state: 'merged', pr: f.pr.url, merged_sha: f.merged_sha, ...(warn.length ? { warnings: warn } : {}) });
}

C.retry = () => { // a feature held for a CI reason goes back to waiting for CI, with the run's CI policy changed on purpose
  const q = load(); const f = item(q);
  need(f, 'awaiting_human');
  if (!f.pr) die(`${f.id} has no PR`);
  const anti = f.hold_kind === 'antigaming';
  const note = flat(opt.note, 500);
  if (anti) {
    // A human decision: needs a real terminal (no env var or flag can stand in for one; the builder controls its own environment).
    if (!(process.stdin.isTTY && process.stdout.isTTY)) die(`${f.id} is held by an anti-gaming rule: only a person at an interactive terminal can override it`);
    if (!note || note.startsWith('--')) die(`${f.id} is held by an anti-gaming rule: retry needs --note "<why this is acceptable>"; it is recorded on the feature`);
  }
  const v = ghJson(['pr', 'view', String(f.pr.number), '--json', 'state,headRefOid'], 'gh pr view');
  if (v.state !== 'OPEN') die(`PR #${f.pr.number} is ${v.state}`);
  if (anti) { // valid only for the commit that was held and only for the G-ids it was held for: see overrideValid
    const held = f.hold_sha || f.ci_sha;
    if (!SHA.test(String(held))) die(`${f.id} has no held commit recorded; an override cannot be bound to one`);
    if (v.headRefOid !== held) die(`${f.id}: the PR head moved since the hold (held ${held.slice(0, 8)}, now ${flat(v.headRefOid, 40).slice(0, 8)}): an override covers only the held commit; the new commits need CI, verification and the anti-gaming checks again`);
    const ids = Array.isArray(f.hold_ids) ? f.hold_ids.filter((x) => /^G[1-5]$/.test(x)) : [];
    console.error(`override for ${f.id}: commit ${held}, anti-gaming checks ${ids.length ? ids.join(', ') : '(none recorded: nothing will be waived)'}`);
    f.override_note = note; f.override_sha = held; f.override_ids = ids; f.hold_kind = null;
  }
  if (opt['no-ci']) q.no_ci = true;
  if (opt.checks) q.checks = parseList(opt.checks);
  q.stop = null;
  f.hold_kind = null; delete f.budget_hold;
  transition(f, 'pr_open', 'retry');
  save(q);
  emit({ id: f.id, state: f.state, no_ci: q.no_ci, checks: q.checks, next: 'ci' });
};

// The factory driver parks a feature for a person (an anti-gaming hit at built, a verification that could not reach a verdict, ...),
// so the transition goes through save() and gets its run record. Only from a trusted queue (under FACTORY_HOME). An anti-gaming hold
// records the held commit and the G-ids, so `retry --note` can override exactly those.
C.hold = () => {
  const q = load(); const f = item(q);
  if (!queueInHome()) die('hold is a factory driver command: the queue file must be a private file under FACTORY_HOME');
  if (!(TRANSITIONS[f.state] || []).includes('awaiting_human')) die(`${f.id} is "${f.state}", which cannot wait for a person`);
  const reason = flat(opt.reason);
  if (!reason) die('--reason is required');
  const kind = opt.kind === undefined ? null : String(opt.kind);
  if (kind !== null && !/^[a-z_]{1,32}$/.test(kind)) die('--kind must be 1-32 characters of a-z and _');
  // A running step (building, fixing) can only be parked by the run-control budget; every other hold there is the driver's attention-and-stop path.
  if ((f.state === 'building' || f.state === 'fixing') && kind !== 'budget') die(`${f.id} is "${f.state}", which cannot wait for a person`);
  if (kind === 'budget') {
    if (f.state !== 'building' && f.state !== 'fixing') die(`${f.id} is "${f.state}", which cannot be held for a budget (only building and fixing)`);
    f.budget_hold = { from: f.state };
  }
  if (kind === 'antigaming') {
    const ids = parseList(opt.ids).filter((x) => /^G[1-5]$/.test(x));
    if (!SHA.test(String(opt.sha || '')) || !ids.length) die('an anti-gaming hold needs --sha <40-hex> and --ids G1..G5');
    f.hold_sha = opt.sha; f.hold_ids = [...new Set(ids)].sort();
  }
  f.hold_kind = kind;
  transition(f, 'awaiting_human', reason);
  save(q);
  outcome({ id: f.id, state: f.state, hold_kind: kind });
};

// Resumes a budget hold: back to the step it was parked in, marked interrupted so the driver restarts that step.
C.unhold = () => {
  const q = load(); const f = item(q);
  if (!queueInHome()) die('unhold is a factory driver command: the queue file must be a private file under FACTORY_HOME');
  if (f.state !== 'awaiting_human' || f.hold_kind !== 'budget') die(`${f.id} is not held for a budget (state "${f.state}", hold_kind ${JSON.stringify(f.hold_kind ?? null)})`);
  const to = opt.to;
  if (to !== 'building' && to !== 'fixing') die('--to must be building or fixing');
  const from = f.budget_hold?.from;
  if (from !== 'building' && from !== 'fixing') die(`${f.id} has no building or fixing budget hold recorded`);
  if (to !== from) die(`${f.id} was held from "${from}": --to must be ${from}`);
  delete f.budget_hold; f.hold_kind = null;
  f.interrupted = { kind: 'budget', step: to === 'building' ? 'build' : 'fix', ts: new Date().toISOString() };
  transition(f, to, 'budget hold released');
  save(q);
  emit({ id: f.id, state: f.state, interrupted: f.interrupted });
};

C.block = () => {
  const q = load(); const f = item(q);
  if (!flat(opt.reason)) die('--reason is required');
  if (['merged', 'skipped', 'blocked'].includes(f.state)) die(`${f.id} is already ${f.state}`);
  if (f.state === 'queued' || f.state === 'awaiting_human') { transition(f, f.state === 'queued' ? 'blocked' : 'skipped', flat(opt.reason)); save(q); return emit({ id: f.id, state: f.state }); }
  block(q, f, opt.reason);
  emit({ id: f.id, state: f.state, note: 'uncommitted work was stashed; the base branch is checked out' });
};
C.skip = () => {
  const q = load(); const f = item(q);
  if (!flat(opt.reason)) die('--reason is required');
  if (['queued', 'blocked', 'awaiting_human'].includes(f.state)) transition(f, 'skipped', flat(opt.reason));
  else die(`${f.id} is "${f.state}"; block it first`);
  save(q);
  emit({ id: f.id, state: f.state });
};

C.status = () => {
  const q = load();
  refresh(q); save(q);
  const stop = runStop(q);
  const out = { repo: q.repo, base: q.base, protected_base: q.protected_base, merge: q.merge, no_ci: q.no_ci, checks: q.checks, stop: stop || null, summary: counts(q), features: q.features.map(pub) };
  if (opt.json) return emit(out);
  for (const f of q.features) console.log(`${f.id}  ${f.state.padEnd(15)} ${f.pr ? f.pr.url : ''}${f.reason ? `  (${f.reason})` : ''}`);
  if (stop) console.log(`STOPPED: ${stop}`);
};

C.reset = () => {
  if (!opt.yes) die('reset discards the run state (merged PRs stay merged on GitHub); pass --yes');
  const old = readJson(file);
  if (old && typeof old.repo === 'string') factoryGuard(old.repo);
  fs.rmSync(file, { force: true });
  emit({ reset: true });
};

// ---- helpers ---------------------------------------------------------------------------------------------------------
const pub = (f) => ({ id: f.id, title: f.title, spec: path.relative(root, f.file), state: f.state, branch: f.branch, tier: f.tier, pr: f.pr?.url, fix_rounds: f.fix_rounds, reason: f.reason, merged_sha: f.merged_sha, ci: f.ci });
const counts = (q) => Object.fromEntries(Object.entries(summarize(q)).map(([k, v]) => [k, v.map((f) => f.id)]));

if (!C[cmd]) die(`unknown command "${cmd}". ${HELP}`);
try { await C[cmd](); } catch (e) { die(e.message); }
