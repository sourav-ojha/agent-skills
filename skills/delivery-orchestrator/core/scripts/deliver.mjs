#!/usr/bin/env node
// Queue and PR helper for the delivery-orchestrator skill. Zero dependencies; git and gh are run without a shell.
// usage: node deliver.mjs <init|next|built|pr|ci|fix|push|merge|retry|block|skip|status|reset> [FEATURE-ID] [--dir D] [flags]
// exit codes: 0 ok, 1 error (nothing changed), 2 outcome that needs the agent or a person (blocked, CI failed, awaiting human)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { logEvent, runId } from './lib/runlog.mjs';
import { FEATURE_ID, TRANSITIONS, transition, frontmatter, discover, buildQueue, pickNext, runStop, slugify, touchesCi, summarize } from './lib/queue.mjs';

const BOOL = new Set(['merge', 'no-ci', 'merge-t3', 'dry-run', 'yes', 'json']);
const argv = process.argv.slice(2);
const opt = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = BOOL.has(k) ? true : argv[++i]; } else pos.push(argv[i]);
}
const [cmd, arg] = pos;
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
const emit = (o) => console.log(JSON.stringify(o, null, 2));
const outcome = (o) => { emit(o); process.exitCode = 2; };

const HELP = `commands: init [--features-dir D] [--only IDS] [--limit N] [--base B] [--merge --note "<user's words>"] [--checks A,B] [--no-ci] [--merge-t3] [--max-fix-rounds N] [--max-failures N] [--ci-budget S] [--dry-run]
  next | built ID [--tier T] | pr ID --title T --body-file .delivery/F | ci ID [--timeout S] [--interval S] [--grace S] | fix ID | push ID | merge ID [--settle S]
  retry ID [--no-ci] [--checks A,B] | block ID --reason R | skip ID --reason R | status [--json] | reset --yes   (all take --dir D)`;
if (!cmd || cmd === 'help') { console.log(HELP); process.exit(0); }

const root = path.resolve(opt.dir || '.');
const dirState = path.join(root, '.delivery');
const file = path.join(dirState, 'queue.json');
const t0 = Date.now();
const extra = {};
process.on('exit', (code) => { if (cmd !== 'status') logEvent(root, 'delivery-orchestrator', runId('deliver', 'run'), { event: cmd, ok: code === 0, ms: Date.now() - t0, ...extra }); });

// ---- process helpers (no shell, fixed argv) --------------------------------------------------------------------------
let REPO = null; // owner/name: every gh pr call is pinned to it so git (origin) and gh cannot point at different repositories
const run = (bin, args) => { const r = spawnSync(bin, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); return { code: r.status ?? 1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }; };
const git = (...a) => run('git', a);
const gh = (...a) => run('gh', REPO && a[0] === 'pr' ? [...a, '--repo', REPO] : a);
const must = (r, what) => { if (r.code !== 0) die(`${what} failed: ${(r.err || r.out).split('\n')[0].slice(0, 200)}`); return r.out; };
const sleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]+', 'g');
const flat = (s, max = 200) => String(s ?? '').replace(UNSAFE, ' ').trim().slice(0, max);
const ghJson = (args, what) => { const r = gh(...args); if (r.code !== 0) die(`${what} failed: ${(r.err || r.out).split('\n')[0].slice(0, 200)}`); try { return JSON.parse(r.out); } catch { die(`${what}: gh returned non-JSON output`); } };
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/; // never starts with "-": a value can not be read as a git option
const SHA = /^[0-9a-f]{40}$/;
const validRef = (s) => typeof s === 'string' && REF.test(s) && !s.includes('..');

// ---- state -----------------------------------------------------------------------------------------------------------
function load() {
  if (!fs.existsSync(file)) die('no run in progress here; use init first');
  let q;
  try { q = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`queue file is invalid JSON (${e.message}); reset and re-init (merged PRs are on GitHub)`); }
  if (!q || !Array.isArray(q.features)) die('queue file is invalid: expected a features array');
  // The file is writable by anything in the worktree: re-validate every value that reaches git or gh.
  if (!validRef(q.base) || !/^[\w.-]+\/[\w.-]+$/.test(q.repo || '') || !Array.isArray(q.checks)) die('queue file is invalid (base, repo or checks); reset and re-init');
  for (const f of q.features) {
    if (!FEATURE_ID.test(f.id) || !(f.state in TRANSITIONS) || (f.branch && !validRef(f.branch)) || (f.ci_sha && !SHA.test(f.ci_sha)) || (f.built_sha && !SHA.test(f.built_sha)) || (f.pr && !Number.isInteger(f.pr.number))) die(`queue file has an invalid entry for ${f.id}; reset and re-init`);
  }
  REPO = q.repo;
  return q;
}
function save(q) {
  fs.mkdirSync(dirState, { recursive: true });
  const ign = path.join(dirState, '.gitignore');
  if (!fs.existsSync(ign)) fs.writeFileSync(ign, '*\n');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n');
  fs.renameSync(tmp, file);
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
    try { const v = JSON.parse(r.out); if (v.state === 'MERGED') { transition(f, 'merged', 'merged by a person'); f.merged_sha = v.mergeCommit?.oid || null; } } catch { /* ignore */ }
  }
}

function block(q, f, reason) {
  transition(f, 'blocked', flat(reason));
  if (!clean()) git('stash', 'push', '-u', '-m', `delivery-orchestrator: partial work on ${f.id}`);
  git('checkout', q.base);
  save(q);
}

// ---- commands --------------------------------------------------------------------------------------------------------
const C = {};

C.init = () => {
  if (fs.existsSync(file)) { const q = load(); if (q.features.some((f) => !['merged', 'skipped'].includes(f.state))) die('a run is in progress; use status, or reset --yes to discard its state'); }
  const top = git('rev-parse', '--show-toplevel');
  if (top.code !== 0) die('not a git repository');
  if (fs.realpathSync(top.out) !== fs.realpathSync(root)) die(`run from the repository root (${top.out}); --dir points at a subfolder`);
  const repo = ghJson(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], 'gh repo view (is gh installed and logged in, and is there a GitHub remote?)');
  const origin = git('config', '--get', 'remote.origin.url').out.toLowerCase().replace(/\.git$/, '');
  if (!origin.endsWith(`/${repo.nameWithOwner.toLowerCase()}`) && !origin.endsWith(`:${repo.nameWithOwner.toLowerCase()}`)) die(`git's origin (${flat(origin, 100)}) is not the repository gh targets (${repo.nameWithOwner}); fix it, for example with "gh repo set-default"`);
  const base = opt.base || repo.defaultBranchRef?.name;
  if (!validRef(base)) die('could not determine a valid base branch; pass --base');
  if (!clean()) die('the working tree is not clean; commit or stash your changes first');
  if (opt.merge && !flat(opt.note)) die('--merge needs --note "<the user\'s own words authorising merges>"');
  const featuresDir = path.resolve(root, opt['features-dir'] || '.product/features');
  const only = parseList(opt.only);
  for (const id of only) if (!FEATURE_ID.test(id)) die(`--only has invalid id "${id}"`);
  let features;
  try { features = buildQueue(discover(featuresDir), { only, limit: opt.limit ? Number(opt.limit) : 0 }); } catch (e) { die(e.message); }
  const num = (v, d, lo, hi) => { const n = v === undefined ? d : Number(v); if (!Number.isInteger(n) || n < lo || n > hi) die(`value ${JSON.stringify(v)} must be an integer ${lo}-${hi}`); return n; };
  const q = {
    version: 2, created: new Date().toISOString(), repo: repo.nameWithOwner, base, features_dir: path.relative(root, featuresDir) || '.',
    merge: !!opt.merge, no_ci: !!opt['no-ci'], merge_t3: !!opt['merge-t3'], checks: parseList(opt.checks), authorised_by: opt.merge ? flat(opt.note, 300) : null,
    max_fix_rounds: num(opt['max-fix-rounds'], 2, 0, 5), max_failures: num(opt['max-failures'], 2, 1, 10), ci_budget_s: num(opt['ci-budget'], 1800, 1, 86400), features,
  };
  if (opt['dry-run'] || !features.length) return emit({ dry_run: !!opt['dry-run'], queue: features.map((f) => ({ id: f.id, title: f.title, deps: f.deps })), note: features.length ? 'nothing written' : 'no feature with status: ready (and not already delivered) in the features directory' });
  save(q);
  const ex = git('rev-parse', '--git-path', 'info/exclude').out;
  if (ex) { const ep = path.resolve(root, ex); const cur = fs.existsSync(ep) ? fs.readFileSync(ep, 'utf8') : ''; const add = ['.delivery/', '.implementation/'].filter((l) => !cur.split('\n').includes(l)); if (add.length) { fs.mkdirSync(path.dirname(ep), { recursive: true }); fs.appendFileSync(ep, `${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`); } }
  extra.count = features.length;
  emit({ initialised: true, base, repo: q.repo, merge: q.merge, no_ci: q.no_ci, checks: q.checks, queue: features.map((f) => ({ id: f.id, title: f.title, deps: f.deps })) });
};

C.next = () => {
  const q = load();
  refresh(q);
  const stop = runStop(q);
  const { item: f, resume } = pickNext(q);
  save(q);
  if (f && resume) { extra.feature = f.id; return emit({ resume: true, feature: pub(f), base: q.base }); }
  if (stop || !f) return emit({ done: true, reason: stop || 'queue finished', summary: counts(q) });
  if (!clean()) die('the working tree is not clean; resolve it before starting the next feature');
  must(git('fetch', 'origin'), 'git fetch');
  must(git('checkout', q.base), `git checkout ${q.base}`);
  if (git('merge', '--ff-only', `origin/${q.base}`).code !== 0) die(`local ${q.base} has diverged from origin/${q.base}; fix it by hand, then run next again`);
  const branch = `feat/${f.id.toLowerCase()}-${slugify(f.title)}`;
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).code === 0) {
    // A crash between creating the branch and saving state leaves a branch at the base tip: reuse it. Anything else is someone's work.
    if (git('rev-parse', `refs/heads/${branch}`).out !== git('rev-parse', 'HEAD').out) die(`branch ${branch} already exists locally with other commits; delete or rename it, then run next again`);
    must(git('checkout', branch), 'git checkout');
  } else must(git('checkout', '-b', branch), 'git checkout -b');
  f.branch = branch;
  transition(f, 'building');
  save(q);
  extra.feature = f.id;
  emit({ resume: false, feature: pub(f), base: q.base, ledger_name: f.id.toLowerCase() });
};

const RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };
C.built = () => {
  const q = load(); const f = item(q);
  need(f, 'building', 'built');
  if (branchNow() !== f.branch) die(`expected to be on ${f.branch}, on ${branchNow()}`);
  if (!clean()) die('uncommitted changes remain; commit them (or discard) before reporting built');
  const ahead = Number(git('rev-list', '--count', `origin/${q.base}..HEAD`).out);
  if (!(ahead >= 1)) { block(q, f, 'no commits on the feature branch'); return outcome({ id: f.id, state: f.state, reason: f.reason }); }
  const delivery = (frontmatter(fs.readFileSync(f.file, 'utf8')).delivery || 'none').toLowerCase();
  if (delivery !== 'complete') { block(q, f, `spec delivery is "${delivery}", not complete`); return outcome({ id: f.id, state: f.state, reason: f.reason }); }
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
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-renames', `origin/${q.base}...${rev}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return ['(could not list the changed files)'];
  return touchesCi(r.stdout.split('\0').filter(Boolean));
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
  must(git('push', '-u', 'origin', f.branch), 'git push');
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

C.ci = () => {
  const q = load(); const f = item(q);
  need(f, 'pr_open');
  const timeout = Number(opt.timeout ?? 1800) * 1000, interval = Number(opt.interval ?? 20) * 1000, grace = Number(opt.grace ?? 90) * 1000;
  if (![timeout, interval, grace].every((n) => Number.isFinite(n) && n >= 0)) die('--timeout, --interval and --grace are seconds (numbers >= 0)');
  const start = Date.now();
  let unstable = 0;
  for (;;) {
    // Head and checks are read around each other: checks of an older commit are never stamped onto a newer head.
    const before = headOf(f.pr.number);
    const checks = checksOf(f.pr.number);
    const required = requiredOf(f.pr.number);
    const sha = headOf(f.pr.number);
    if (sha !== before) { if (++unstable > 5) die('the PR head keeps changing; stop pushing to it and run ci again'); continue; }
    const needed = q.checks.length ? q.checks : required;
    const by = new Map(checks.map((c) => [lc(c.name), c.bucket]));
    const failed = checks.filter((c) => ['fail', 'cancel'].includes(c.bucket));
    const pending = checks.some((c) => c.bucket === 'pending');
    const elapsed = Date.now() - start;
    const verified = (how, names) => { f.pr.head_sha = sha; f.ci_sha = sha; f.ci = how; f.ci_checks = names; transition(f, 'ci_passed'); save(q); return emit({ id: f.id, result: how === 'verified' ? 'passed' : 'unverified-allowed', checks: names, sha, ...(how === 'verified' ? {} : { note: 'no required or allowlisted check exists; proceeding because the run was started with --no-ci' }) }); };

    if (failed.length) {
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
  f.ci_waited_s = (f.ci_waited_s || 0) + Math.round(elapsed / 1000);
  if (f.ci_waited_s >= q.ci_budget_s) { block(q, f, `CI did not finish within ${q.ci_budget_s}s`); return outcome({ id: f.id, result: 'timeout', state: f.state, reason: f.reason }); }
  save(q);
  return outcome({ id: f.id, result: 'timeout', waited_total_s: f.ci_waited_s, budget_s: q.ci_budget_s, ...more });
}
function stopRun(q, f, why) {
  q.stop = why;
  transition(f, 'awaiting_human', flat(why, 160)); save(q);
  return outcome({ id: f.id, result: 'unconfirmed', stop: why });
}

C.fix = () => {
  const q = load(); const f = item(q);
  need(f, 'ci_failed');
  if (f.fix_rounds >= q.max_fix_rounds) { block(q, f, `CI still failing after ${f.fix_rounds} fix round(s)`); return outcome({ id: f.id, state: f.state, reason: f.reason }); }
  if (!clean()) die('the working tree is not clean');
  if (branchNow() !== f.branch) must(git('checkout', f.branch), 'git checkout');
  // GitHub may have added commits (an "update branch" merge): start from the remote tip so the fix can be pushed without force.
  must(git('fetch', 'origin', f.branch), 'git fetch');
  if (git('merge', '--ff-only', `origin/${f.branch}`).code !== 0) die(`local ${f.branch} and origin/${f.branch} have diverged; resolve it by hand`);
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
  must(git('push', 'origin', f.branch), 'git push'); // never forced
  f.pr.head_sha = head;
  f.ci_files = ciFiles(q, 'HEAD');
  transition(f, 'pr_open');
  save(q);
  emit({ id: f.id, state: f.state, sha: head, ci_files_touched: f.ci_files });
};

C.merge = () => {
  const q = load(); const f = item(q);
  need(f, 'ci_passed');
  const hold = (why) => { transition(f, 'awaiting_human', flat(why, 200)); save(q); return outcome({ id: f.id, state: f.state, reason: flat(why, 200), pr: f.pr }); };
  const view = () => ghJson(['pr', 'view', String(f.pr.number), '--json', 'state,isDraft,mergeStateStatus,headRefOid,headRefName,baseRefName,mergeCommit,autoMergeRequest,isCrossRepository'], 'gh pr view');
  let v = view();
  if (v.isCrossRepository || v.headRefName !== f.branch || v.baseRefName !== q.base) die(`PR #${f.pr.number} is ${v.headRefName} -> ${v.baseRefName}${v.isCrossRepository ? ' (from a fork)' : ''}, expected ${f.branch} -> ${q.base} in this repository`);
  if (v.state === 'MERGED' && v.headRefOid === f.ci_sha) return merged(q, f, v.mergeCommit?.oid, ['GitHub had already merged this PR (an earlier run was interrupted)']);
  if (!q.merge) return hold('merging was not authorised for this run (init without --merge): the PR is ready for you');
  must(git('fetch', 'origin'), 'git fetch');
  if (git('cat-file', '-e', `${f.ci_sha}^{commit}`).code !== 0) must(git('fetch', 'origin', f.branch), 'git fetch');
  const ci = [...new Set([...(f.ci_files || []), ...ciFiles(q, f.ci_sha)])]; // recomputed on the verified commit, renames included
  if (f.tier === 'T3' && !q.merge_t3) return hold('T3 work (auth, data, migrations or public API) needs a person to review before merge');
  if (ci.length) return hold(`the change touches CI or ownership files (${ci.slice(0, 3).join(', ')}): a person must review it`);
  if (v.state !== 'OPEN' || v.isDraft) die(`PR #${f.pr.number} is ${v.isDraft ? 'a draft' : v.state}`);
  if (v.headRefOid !== f.ci_sha) { transition(f, 'pr_open'); save(q); return outcome({ id: f.id, result: 'stale', reason: 'the PR head changed after CI passed: wait for CI again', next: 'ci' }); }
  // Do not trust the state file for "CI passed": ask GitHub again about this exact commit.
  const needed = q.checks.length ? q.checks : requiredOf(f.pr.number);
  const now = new Map(checksOf(f.pr.number).map((c) => [lc(c.name), c.bucket]));
  const bad = [...now.values()].some((b) => ['fail', 'cancel', 'pending'].includes(b)) || needed.some((n) => now.get(lc(n)) !== 'pass');
  if (f.ci === 'verified' && (!needed.length || bad)) return hold('GitHub no longer shows the required checks passing on this commit: a person decides');
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
  git('push', 'origin', '--delete', f.branch); // best effort: many repos delete merged branches themselves
  if (git('checkout', q.base).code !== 0 || git('fetch', 'origin').code !== 0 || git('merge', '--ff-only', `origin/${q.base}`).code !== 0) warn.push(`could not fast-forward local ${q.base}; fix it before the next feature`);
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${f.branch}`).code === 0) git('branch', '-D', f.branch);
  save(q);
  emit({ id: f.id, state: 'merged', pr: f.pr.url, merged_sha: f.merged_sha, ...(warn.length ? { warnings: warn } : {}) });
}

C.retry = () => { // a feature held for a CI reason goes back to waiting for CI, with the run's CI policy changed on purpose
  const q = load(); const f = item(q);
  need(f, 'awaiting_human');
  if (!f.pr) die(`${f.id} has no PR`);
  const v = ghJson(['pr', 'view', String(f.pr.number), '--json', 'state'], 'gh pr view');
  if (v.state !== 'OPEN') die(`PR #${f.pr.number} is ${v.state}`);
  if (opt['no-ci']) q.no_ci = true;
  if (opt.checks) q.checks = parseList(opt.checks);
  q.stop = null;
  transition(f, 'pr_open', 'retry');
  save(q);
  emit({ id: f.id, state: f.state, no_ci: q.no_ci, checks: q.checks, next: 'ci' });
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
  const out = { repo: q.repo, base: q.base, merge: q.merge, no_ci: q.no_ci, checks: q.checks, stop: stop || null, summary: counts(q), features: q.features.map(pub) };
  if (opt.json) return emit(out);
  for (const f of q.features) console.log(`${f.id}  ${f.state.padEnd(15)} ${f.pr ? f.pr.url : ''}${f.reason ? `  (${f.reason})` : ''}`);
  if (stop) console.log(`STOPPED: ${stop}`);
};

C.reset = () => {
  if (!opt.yes) die('reset discards the run state (merged PRs stay merged on GitHub); pass --yes');
  fs.rmSync(file, { force: true });
  emit({ reset: true });
};

// ---- helpers ---------------------------------------------------------------------------------------------------------
const pub = (f) => ({ id: f.id, title: f.title, spec: path.relative(root, f.file), state: f.state, branch: f.branch, tier: f.tier, pr: f.pr?.url, fix_rounds: f.fix_rounds, reason: f.reason, merged_sha: f.merged_sha, ci: f.ci });
const counts = (q) => Object.fromEntries(Object.entries(summarize(q)).map(([k, v]) => [k, v.map((f) => f.id)]));

if (!C[cmd]) die(`unknown command "${cmd}". ${HELP}`);
try { C[cmd](); } catch (e) { die(e.message); }
