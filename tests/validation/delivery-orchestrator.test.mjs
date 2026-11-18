// delivery-orchestrator: queue logic and the deliver.mjs helper, against a real git repo with a bare origin and a fake gh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator');
const DELIVER = path.join(SK, 'core', 'scripts', 'deliver.mjs');
const FAKE = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const q = await import(path.join(SK, 'core', 'scripts', 'lib', 'queue.mjs'));

const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

function spec(id, { status = 'ready', delivery, deps, title = `Feature ${id}` } = {}) {
  return `---\ntype: feature-spec\nid: ${id}\nopportunity: OPP-001\nstatus: ${status}\n${delivery ? `delivery: ${delivery}\n` : ''}${deps ? `depends_on: ${deps}\n` : ''}---\n# ${title}\n\nbody\n`;
}

// A work clone of a bare origin, a fake gh on PATH, and the given specs committed to main.
function setup(specs = { 'FEATURE-001': {} }, { config = { protected_branches: [] }, base = null } = {}) {
  const root = tmpDir('deliver-');
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  for (const [k, v] of [['user.email', 't@x'], ['user.name', 't']]) sh(work, 'config', k, v);
  sh(work, 'config', `url.${origin}.insteadOf`, 'git@github.com:o/r.git'); // origin looks like the GitHub repo gh targets, but pushes go to the local bare repo
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  for (const [id, o] of Object.entries(specs)) fs.writeFileSync(path.join(work, `.product/features/${id}.md`), spec(id, o));
  if (config) fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'checkout', '-q', '-b', 'main');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  if (base) { sh(work, 'checkout', '-q', '-b', base); sh(work, 'push', '-q', '-u', 'origin', base); sh(work, 'checkout', '-q', 'main'); }
  const state = path.join(root, 'gh-state.json');
  const gs = { origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]] };
  fs.writeFileSync(state, JSON.stringify(gs));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(root, 'fhome') };
  const d = (...a) => { const r = spawnSync('node', [DELIVER, ...a, '--dir', work], { encoding: 'utf8', env }); let json; try { json = JSON.parse(r.stdout); } catch { /* not json */ } return { code: r.status, out: r.stdout, err: r.stderr, json }; };
  const gh = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const setGh = (fn) => { const s = gh(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  return { root, origin, work, d, gh, setGh };
}

// What the implementer would leave behind: commits on the feature branch and a spec that says delivery: complete.
function build(env, id, { delivery = 'complete', file = `src/${id}.txt`, tier = 'T2' } = {}) {
  const spc = path.join(env.work, `.product/features/${id}.md`);
  fs.mkdirSync(path.dirname(path.join(env.work, file)), { recursive: true });
  fs.writeFileSync(path.join(env.work, file), `${id}\n`);
  fs.writeFileSync(spc, fs.readFileSync(spc, 'utf8').replace(/^status: ready/m, 'status: implemented').replace(/^---\n/, `---\ndelivery: ${delivery}\n`));
  sh(env.work, 'add', '-A'); sh(env.work, 'commit', '-q', '-m', `feat: ${id}`);
  return tier;
}
const body = (env) => { fs.mkdirSync(path.join(env.work, '.delivery'), { recursive: true }); const f = path.join(env.work, '.delivery', 'pr-body.md'); fs.writeFileSync(f, 'body\n'); return f; };
const FAST = ['--interval', '0', '--grace', '0', '--timeout', '1'];

function ship(env, id, { tier = 'T2', build: b = {} } = {}) {
  const n = env.d('next'); assert.equal(n.json.feature.id, id, n.out + n.err);
  build(env, id, b);
  assert.equal(env.d('built', id, '--tier', tier).code, 0);
  assert.equal(env.d('pr', id, '--title', `feat: ${id} thing`, '--body-file', body(env)).code, 0);
  return env.d('ci', id, ...FAST);
}

// ---- queue unit tests ----------------------------------------------------------------------------------------------
test('queue: only ready, undelivered specs; dependency order; clear errors for cycles and missing dependencies', () => {
  const specs = [
    { id: 'FEATURE-003', status: 'ready', delivery: 'none', deps: ['FEATURE-001'] },
    { id: 'FEATURE-001', status: 'ready', delivery: 'none', deps: [] },
    { id: 'FEATURE-002', status: 'draft', delivery: 'none', deps: [] },
    { id: 'FEATURE-004', status: 'ready', delivery: 'complete', deps: [] },
    { id: 'FEATURE-005', status: 'implemented', delivery: 'complete', deps: [] },
  ].map((s) => ({ file: `${s.id}.md`, title: s.id, ...s }));
  assert.deepEqual(q.buildQueue(specs).map((f) => f.id), ['FEATURE-001', 'FEATURE-003']);
  assert.deepEqual(q.buildQueue(specs, { limit: 1 }).map((f) => f.id), ['FEATURE-001']);
  const bad = (deps) => [{ id: 'FEATURE-001', status: 'ready', delivery: 'none', deps, file: 'x', title: 't' }, { id: 'FEATURE-002', status: 'ready', delivery: 'none', deps: ['FEATURE-001'], file: 'y', title: 'u' }];
  assert.throws(() => q.buildQueue(bad(['FEATURE-002'])), /cycle/);
  assert.throws(() => q.buildQueue([{ id: 'FEATURE-001', status: 'ready', delivery: 'none', deps: ['FEATURE-009'], file: 'x', title: 't' }]), /neither in this queue nor implemented/);
  assert.throws(() => q.buildQueue(specs, { only: ['FEATURE-099'] }), /not in the features directory/);
  assert.ok(q.buildQueue(specs.concat([{ id: 'FEATURE-006', status: 'ready', delivery: 'none', deps: ['FEATURE-005'], file: 'z', title: 'z' }])).some((f) => f.id === 'FEATURE-006'), 'an implemented dependency is satisfied');
});

test('queue: states cannot jump (queued -> merged is refused)', () => {
  const f = { id: 'FEATURE-001', state: 'queued', history: [] };
  assert.throws(() => q.transition(f, 'merged'), /cannot go from "queued" to "merged"/);
  q.transition(f, 'building'); q.transition(f, 'built'); q.transition(f, 'pr_open');
  assert.equal(f.state, 'pr_open');
  assert.throws(() => q.transition({ state: 'merged', id: 'x' }, 'queued'), /cannot go/);
});

test('queue: CI and ownership files are flagged', () => {
  assert.deepEqual(q.touchesCi(['src/a.js', '.github/workflows/ci.yml', 'CODEOWNERS', 'docs/CODEOWNERS', 'docs/.github-note.md']), ['.github/workflows/ci.yml', 'CODEOWNERS', 'docs/CODEOWNERS']);
});

// ---- init ----------------------------------------------------------------------------------------------------------
test('init: dry run lists the queue and writes nothing; refuses a dirty tree; --merge needs the user\'s words', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-001' }, 'FEATURE-003': { status: 'draft' } });
  const dry = e.d('init', '--dry-run');
  assert.deepEqual(dry.json.queue.map((f) => f.id), ['FEATURE-001', 'FEATURE-002']);
  assert.ok(!fs.existsSync(path.join(e.work, '.delivery')));
  assert.match(e.d('init', '--merge').err, /--note/);
  fs.writeFileSync(path.join(e.work, 'dirty.txt'), 'x');
  assert.match(e.d('init').err, /not clean/);
  fs.rmSync(path.join(e.work, 'dirty.txt'));
  assert.equal(e.d('init', '--merge', '--note', 'yes, merge them').code, 0);
  assert.equal(fs.readFileSync(path.join(e.work, '.delivery/.gitignore'), 'utf8'), '*\n');
  assert.equal(sh(e.work, 'status', '--porcelain'), '', 'the state folder is self-ignoring');
  assert.match(e.d('init').err, /run is in progress/);
});

test('init: nothing ready is reported, not an error', () => {
  const e = setup({ 'FEATURE-001': { status: 'draft' } });
  const r = e.d('init');
  assert.equal(r.code, 0);
  assert.match(r.json.note, /no feature with status: ready/);
});

// ---- the happy path -------------------------------------------------------------------------------------------------
test('pipeline: two dependent features go branch -> PR -> CI -> squash merge -> next, one at a time', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-001' } });
  assert.equal(e.d('init', '--merge', '--note', 'merge them all').code, 0);

  const r1 = ship(e, 'FEATURE-001');
  assert.equal(r1.json.result, 'passed', r1.err);
  const m1 = e.d('merge', 'FEATURE-001');
  assert.equal(m1.code, 0, m1.err + m1.out);
  assert.equal(m1.json.state, 'merged');
  assert.equal(sh(e.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'back on the base branch');
  assert.equal(sh(e.work, 'rev-parse', 'HEAD'), sh(e.origin, 'rev-parse', 'main'), 'local base fast-forwarded to the squash commit');
  assert.match(sh(e.work, 'log', '-1', '--format=%s'), /^feat: FEATURE-001 thing \(#1\)$/);
  assert.equal(sh(e.work, 'rev-list', '--count', 'main'), '2', 'init + ONE squash commit, not the branch history');

  const r2 = ship(e, 'FEATURE-002');
  assert.equal(r2.json.result, 'passed');
  assert.equal(e.d('merge', 'FEATURE-002').json.state, 'merged');
  const done = e.d('next');
  assert.equal(done.json.done, true);
  assert.deepEqual(done.json.summary.merged, ['FEATURE-001', 'FEATURE-002']);

  const calls = e.gh().calls.map((c) => c.join(' '));
  const merges = calls.filter((c) => c.startsWith('pr merge'));
  assert.equal(merges.length, 2);
  for (const m of merges) { assert.match(m, /--squash/); assert.match(m, /--match-head-commit [0-9a-f]{40}/); assert.doesNotMatch(m, /--admin|--auto/); }
  assert.ok(calls.some((c) => c.startsWith('pr checks')), 'CI was consulted before merging');
});

test('pipeline: a feature never starts before the one it depends on has merged', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-001' } });
  e.d('init', '--merge', '--note', 'ok');
  assert.equal(e.d('next').json.feature.id, 'FEATURE-001');
  const again = e.d('next'); // resume, not start the next feature
  assert.equal(again.json.resume, true);
  assert.equal(again.json.feature.id, 'FEATURE-001');
});

// ---- built ---------------------------------------------------------------------------------------------------------
test('built: partial delivery or no commits blocks the feature and leaves the base checked out', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': {} });
  e.d('init', '--merge', '--note', 'ok');
  e.d('next');
  assert.equal(e.d('built', 'FEATURE-001', '--tier', 'T1').code, 2);
  assert.match(e.d('status', '--json').json.features[0].reason, /no commits/);
  assert.equal(sh(e.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  e.d('next'); build(e, 'FEATURE-002', { delivery: 'partial' });
  const r = e.d('built', 'FEATURE-002', '--tier', 'T1');
  assert.equal(r.code, 2);
  assert.match(r.json.reason, /delivery is "partial"/);
});

test('built: the tier comes from the implementer ledger when present; a missing tier is an error', () => {
  const e = setup();
  e.d('init'); e.d('next'); build(e, 'FEATURE-001');
  assert.match(e.d('built', 'FEATURE-001').err, /need the implementer tier/);
  fs.mkdirSync(path.join(e.work, '.implementation/feature-001'), { recursive: true });
  fs.writeFileSync(path.join(e.work, '.implementation/feature-001/tasks.json'), JSON.stringify({ tier: 'T3', tasks: [] }));
  assert.equal(e.d('built', 'FEATURE-001', '--tier', 'T0').json.tier, 'T3', 'the ledger wins over the flag');
});

// ---- CI ------------------------------------------------------------------------------------------------------------
test('CI failure: fix round, push, re-check, merge; fix rounds are capped and the cap blocks the feature', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-001' } });
  e.d('init', '--merge', '--note', 'ok', '--max-fix-rounds', '1');
  e.setGh((s) => { s.checkQueue = [[{ name: 'unit', bucket: 'fail', link: 'http://ci/9' }]]; });
  const r = ship(e, 'FEATURE-001');
  assert.equal(r.code, 2);
  assert.equal(r.json.result, 'failed');
  assert.equal(r.json.failing[0].name, 'unit');
  assert.equal(r.json.fix_allowed, true);
  assert.equal(e.d('fix', 'FEATURE-001').json.round, 1);
  assert.match(e.d('push', 'FEATURE-001').err, /no new commit/);
  fs.writeFileSync(path.join(e.work, 'src/fix.txt'), 'fix\n'); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'fix: ci');
  assert.equal(e.d('push', 'FEATURE-001').code, 0);
  const capped = e.d('ci', 'FEATURE-001', ...FAST); // still failing and no rounds left: blocked by the helper itself
  assert.equal(capped.code, 2);
  assert.equal(capped.json.state, 'blocked');
  assert.match(capped.json.reason, /still failing after 1 fix round/);
  assert.equal(sh(e.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  const nxt = e.d('next'); // FEATURE-002 depends on the blocked one: skipped with a reason, never built on a missing base
  assert.equal(nxt.json.done, true);
  assert.match(e.d('status', '--json').json.features[1].reason, /dependency FEATURE-001 is blocked/);
  assert.equal(e.gh().prs[0].state, 'OPEN', 'nothing merged');
});

test('CI pending then passing is waited for', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'pending' }], [{ name: 'ci', bucket: 'pending' }], [{ name: 'ci', bucket: 'pass' }]]; });
  e.d('next'); build(e, 'FEATURE-001'); e.d('built', 'FEATURE-001', '--tier', 'T2'); e.d('pr', 'FEATURE-001', '--title', 'feat: thing here', '--body-file', body(e));
  const r = e.d('ci', 'FEATURE-001', '--interval', '0', '--grace', '0', '--timeout', '60');
  assert.equal(r.json.result, 'passed');
});

test('CI that never finishes times out without merging', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'pending' }]]; });
  e.d('next'); build(e, 'FEATURE-001'); e.d('built', 'FEATURE-001', '--tier', 'T2'); e.d('pr', 'FEATURE-001', '--title', 'feat: thing here', '--body-file', body(e));
  const r = e.d('ci', 'FEATURE-001', '--interval', '0.2', '--grace', '0', '--timeout', '0.5');
  assert.equal(r.json.result, 'timeout');
  assert.equal(r.code, 2);
  assert.match(e.d('merge', 'FEATURE-001').err, /needs ci_passed/);
});

test('no CI at all: the run stops instead of merging unverified; --no-ci allows it explicitly', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': {} });
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.noChecks = true; s.required = []; });
  const r = ship(e, 'FEATURE-001');
  assert.equal(r.json.result, 'unconfirmed');
  assert.match(r.json.stop, /no CI checks/);
  assert.equal(e.d('next').json.done, true, 'the whole run stops, not just this feature');

  const e2 = setup();
  e2.d('init', '--merge', '--note', 'ok', '--no-ci');
  e2.setGh((s) => { s.noChecks = true; s.required = []; });
  assert.equal(ship(e2, 'FEATURE-001').json.result, 'unverified-allowed');
  assert.equal(e2.d('merge', 'FEATURE-001').json.state, 'merged');
});

// ---- merge guards --------------------------------------------------------------------------------------------------
test('merge guards: not authorised, T3, and CI-file changes all hold the PR for a person', () => {
  const noMerge = setup();
  noMerge.d('init');
  ship(noMerge, 'FEATURE-001');
  const a = noMerge.d('merge', 'FEATURE-001');
  assert.equal(a.code, 2);
  assert.match(a.json.reason, /not authorised/);
  assert.equal(noMerge.gh().prs[0].state, 'OPEN');

  const t3 = setup();
  t3.d('init', '--merge', '--note', 'ok');
  ship(t3, 'FEATURE-001', { tier: 'T3' });
  assert.match(t3.d('merge', 'FEATURE-001').json.reason, /T3 work/);

  const ci = setup();
  ci.d('init', '--merge', '--note', 'ok');
  ship(ci, 'FEATURE-001', { build: { file: '.github/workflows/ci.yml' } });
  assert.match(ci.d('merge', 'FEATURE-001').json.reason, /CI or ownership files/);

  const t3ok = setup();
  t3ok.d('init', '--merge', '--note', 'ok', '--merge-t3');
  ship(t3ok, 'FEATURE-001', { tier: 'T3' });
  assert.equal(t3ok.d('merge', 'FEATURE-001').json.state, 'merged');
});

test('merge guards: head changed after CI is stale; behind updates the branch; conflict blocks; branch protection holds', () => {
  const stale = setup();
  stale.d('init', '--merge', '--note', 'ok');
  ship(stale, 'FEATURE-001');
  fs.writeFileSync(path.join(stale.work, 'late.txt'), 'late\n'); sh(stale.work, 'add', '-A'); sh(stale.work, 'commit', '-q', '-m', 'late'); sh(stale.work, 'push', '-q', 'origin', 'feat/feature-001-feature-feature-001');
  const s = stale.d('merge', 'FEATURE-001');
  assert.equal(s.json.result, 'stale');
  assert.equal(stale.d('status', '--json').json.features[0].state, 'pr_open');

  const behind = setup();
  behind.d('init', '--merge', '--note', 'ok');
  ship(behind, 'FEATURE-001');
  behind.setGh((g) => { g.prs[0].mergeState = 'BEHIND'; });
  const b = behind.d('merge', 'FEATURE-001');
  assert.equal(b.json.next, 'ci');
  assert.ok(behind.gh().calls.some((c) => c[1] === 'update-branch'));

  const dirty = setup();
  dirty.d('init', '--merge', '--note', 'ok');
  ship(dirty, 'FEATURE-001');
  dirty.setGh((g) => { g.prs[0].mergeState = 'DIRTY'; });
  assert.match(dirty.d('merge', 'FEATURE-001').json.reason, /merge conflict/);

  const blocked = setup();
  blocked.d('init', '--merge', '--note', 'ok');
  ship(blocked, 'FEATURE-001');
  blocked.setGh((g) => { g.prs[0].mergeState = 'BLOCKED'; });
  assert.match(blocked.d('merge', 'FEATURE-001').json.reason, /"BLOCKED"/);
  assert.equal(blocked.gh().prs[0].state, 'OPEN');
});

test('a PR merged by hand unblocks its dependents on the next run', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-001' } });
  e.d('init');
  ship(e, 'FEATURE-001');
  assert.equal(e.d('merge', 'FEATURE-001').code, 2); // not authorised: awaiting a person
  e.d('next'); // FEATURE-002 is skipped while 001 is not merged
  assert.equal(e.d('status', '--json').json.features[1].state, 'skipped');
});

// ---- failures, safety ----------------------------------------------------------------------------------------------
test('circuit breaker: two blocked features in a row stop the run', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': {}, 'FEATURE-003': {} });
  e.d('init');
  e.d('next'); e.d('block', 'FEATURE-001', '--reason', 'cannot build');
  e.d('next'); e.d('block', 'FEATURE-002', '--reason', 'cannot build');
  const n = e.d('next');
  assert.equal(n.json.done, true);
  assert.match(n.json.reason, /circuit breaker/);
});

test('block stashes uncommitted work (nothing is destroyed) and returns to the base branch', () => {
  const e = setup();
  e.d('init'); e.d('next');
  fs.writeFileSync(path.join(e.work, 'wip.txt'), 'partial\n');
  const b = e.d('block', 'FEATURE-001', '--reason', 'stuck');
  assert.equal(b.code, 0);
  assert.equal(sh(e.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.match(sh(e.work, 'stash', 'list'), /partial work on FEATURE-001/);
});

test('safety: control characters and shell syntax in titles and reasons are data; bad ids, bodies outside the project and existing branches are refused', () => {
  const e = setup();
  e.d('init'); e.d('next'); build(e, 'FEATURE-001'); e.d('built', 'FEATURE-001', '--tier', 'T2');
  assert.match(e.d('pr', 'FEATURE-001', '--title', 'ab', '--body-file', body(e)).err, /--title/);
  const outside = path.join(os.tmpdir(), `outside-${process.pid}.md`); fs.writeFileSync(outside, 'x');
  assert.match(e.d('pr', 'FEATURE-001', '--title', 'feat: fine title', '--body-file', outside).err, /inside \.delivery/);
  assert.match(e.d('pr', 'FEATURE-001', '--title', 'feat: fine title', '--body-file', path.join(e.work, 'README.md')).err, /inside \.delivery/);
  const evil = path.join(e.root, 'pwned');
  const ok = e.d('pr', 'FEATURE-001', '--title', `feat: x $(touch ${evil}) \`touch ${evil}\`\u001b[31m red`, '--body-file', body(e));
  assert.equal(ok.code, 0, ok.err);
  assert.ok(!fs.existsSync(evil), 'no shell is involved');
  assert.doesNotMatch(e.gh().prs[0].title, /\u001b/);
  assert.match(e.d('built', '../../etc/passwd').err, /need a feature id/);
  assert.match(e.d('block', 'FEATURE-999', '--reason', 'x').err, /not in this run's queue/);

  const dup = setup();
  dup.d('init');
  sh(dup.work, 'checkout', '-q', '-b', 'feat/feature-001-feature-feature-001'); fs.writeFileSync(path.join(dup.work, 'x.txt'), 'x'); sh(dup.work, 'add', '-A'); sh(dup.work, 'commit', '-q', '-m', 'someone else'); sh(dup.work, 'checkout', '-q', 'main');
  assert.match(dup.d('next').err, /already exists locally with other commits/);
  const same = setup();
  same.d('init');
  sh(same.work, 'branch', 'feat/feature-001-feature-feature-001'); // crash after creating the branch, before saving state: reuse it
  assert.equal(same.d('next').json.feature.branch, 'feat/feature-001-feature-feature-001');
});

test('state transitions are enforced by the CLI: no merge without a PR, no PR before built', () => {
  const e = setup();
  e.d('init'); e.d('next');
  assert.match(e.d('pr', 'FEATURE-001', '--title', 'feat: thing here', '--body-file', body(e)).err, /needs built/);
  assert.match(e.d('merge', 'FEATURE-001').err, /needs ci_passed/);
  assert.match(e.d('ci', 'FEATURE-001').err, /needs pr_open/);
});

test('reset discards state only with --yes; a corrupt state file gives a clear error', () => {
  const e = setup();
  e.d('init');
  assert.match(e.d('reset').err, /--yes/);
  fs.writeFileSync(path.join(e.work, '.delivery/queue.json'), '{nope');
  assert.match(e.d('status').err, /invalid JSON/);
  assert.equal(e.d('reset', '--yes').code, 0);
  assert.match(e.d('status').err, /no run in progress/);
});

test('the runlog copies in every skill with helpers stay identical', () => {
  const read = (s) => fs.readFileSync(path.join(REPO, 'skills', s, 'core/scripts/lib/runlog.mjs'), 'utf8');
  assert.equal(read('delivery-orchestrator'), read('implementer'));
});

// ---- review round: regression tests ----------------------------------------------------------------------------------
function prReady(e, id = 'FEATURE-001', opts = {}) { // up to a PR, CI not yet checked
  e.d('next'); build(e, id, opts.build); e.d('built', id, '--tier', opts.tier || 'T2');
  return e.d('pr', id, '--title', `feat: ${id} thing`, '--body-file', body(e));
}

test('H1 a passing check that is not required or named is not proof of tests: the run stops and lists what ran', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.required = []; s.checkQueue = [[{ name: 'GitGuardian Security Checks', bucket: 'pass' }]]; });
  const r = ship(e, 'FEATURE-001');
  assert.equal(r.json.result, 'unconfirmed');
  assert.match(r.json.stop, /GitGuardian Security Checks.*none is required/);
  assert.equal(e.d('next').json.done, true);
  assert.equal(e.gh().prs[0].state, 'OPEN');
  // naming the check that runs the tests lets the same PR proceed
  e.setGh((s) => { s.checkQueue = [[{ name: 'GitGuardian Security Checks', bucket: 'pass' }, { name: 'unit-tests', bucket: 'pass' }]]; });
  assert.equal(e.d('retry', 'FEATURE-001', '--checks', 'unit-tests').code, 0);
  assert.equal(e.d('ci', 'FEATURE-001', ...FAST).json.result, 'passed');
  assert.equal(e.d('merge', 'FEATURE-001').json.state, 'merged');
});

test('H1 a required check that has not been reported yet is waited for, not skipped over by a fast scanner passing', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.required = [{ name: 'unit-tests', bucket: 'pending' }]; s.checkQueue = [[{ name: 'lint', bucket: 'pass' }], [{ name: 'lint', bucket: 'pass' }, { name: 'unit-tests', bucket: 'pending' }], [{ name: 'lint', bucket: 'pass' }, { name: 'unit-tests', bucket: 'pass' }]]; });
  prReady(e);
  const r = e.d('ci', 'FEATURE-001', '--interval', '0', '--grace', '0', '--timeout', '30');
  assert.equal(r.json.result, 'passed');
  assert.deepEqual(r.json.checks, ['unit-tests']);
});

test('H2 a CI fix round that edits workflow files is held, and so is a rename out of .github', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'fail', link: 'x' }]]; });
  ship(e, 'FEATURE-001');
  e.d('fix', 'FEATURE-001');
  fs.mkdirSync(path.join(e.work, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(e.work, '.github/workflows/ci.yml'), 'on: push\n'); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'fix: drop the failing step');
  assert.equal(e.d('push', 'FEATURE-001').json.ci_files_touched[0], '.github/workflows/ci.yml');
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'pass' }]]; });
  assert.equal(e.d('ci', 'FEATURE-001', ...FAST).json.result, 'passed');
  assert.match(e.d('merge', 'FEATURE-001').json.reason, /CI or ownership files/);

  const rn = setup();
  fs.mkdirSync(path.join(rn.work, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(rn.work, '.github/workflows/ci.yml'), 'on: push\n'); sh(rn.work, 'add', '-A'); sh(rn.work, 'commit', '-q', '-m', 'ci'); sh(rn.work, 'push', '-q', 'origin', 'main');
  rn.d('init', '--merge', '--note', 'ok'); rn.d('next');
  sh(rn.work, 'mv', '.github/workflows/ci.yml', 'old-ci.yml');
  build(rn, 'FEATURE-001');
  assert.deepEqual(rn.d('built', 'FEATURE-001', '--tier', 'T2').json.ci_files_touched, ['.github/workflows/ci.yml'], 'the old path of a rename counts');
});

test('H2 commits added after built are refused at pr until built is run again', () => {
  const e = setup();
  e.d('init'); e.d('next'); build(e, 'FEATURE-001'); e.d('built', 'FEATURE-001', '--tier', 'T2');
  fs.writeFileSync(path.join(e.work, 'late.txt'), 'x'); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'late');
  assert.match(e.d('pr', 'FEATURE-001', '--title', 'feat: thing here', '--body-file', body(e)).err, /after "built"/);
  assert.equal(e.d('built', 'FEATURE-001', '--tier', 'T2').code, 0);
  assert.equal(e.d('pr', 'FEATURE-001', '--title', 'feat: thing here', '--body-file', body(e)).code, 0);
});

test('H3 a push that lands while checks are read is never stamped as verified: ci re-reads until the head is stable', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  prReady(e);
  e.setGh((s) => { s.bump = 1; });
  const r = e.d('ci', 'FEATURE-001', ...FAST);
  assert.equal(r.json.result, 'passed', r.err);
  assert.equal(r.json.sha, sh(e.origin, 'rev-parse', 'refs/heads/feat/feature-001-feature-feature-001'), 'verified sha is the current head');
  e.setGh((s) => { s.bump = 99; });
  const loop = e.d('ci', 'FEATURE-001', ...FAST);
  assert.equal(loop.code, 1);
});

test('M1 after GitHub updates the branch, the next fix starts from the remote tip and pushes without force', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  e.setGh((g) => { g.prs[0].mergeState = 'BEHIND'; });
  assert.equal(e.d('merge', 'FEATURE-001').json.result, 'updated');
  e.setGh((g) => { g.checkQueue = [[{ name: 'ci', bucket: 'fail', link: 'x' }]]; });
  assert.equal(e.d('ci', 'FEATURE-001', ...FAST).json.result, 'failed');
  assert.equal(e.d('fix', 'FEATURE-001').code, 0, 'fast-forwarded to the remote merge commit');
  fs.writeFileSync(path.join(e.work, 'fix.txt'), 'f'); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'fix');
  assert.equal(e.d('push', 'FEATURE-001').code, 0);
  assert.ok(!e.gh().calls.some((c) => c.includes('--force') || c.includes('-f')));
});

test('M2 a merge that GitHub completed before a crash is recorded, not stuck', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  e.d('merge', 'FEATURE-001'); // merged
  const qf = path.join(e.work, '.delivery/queue.json');
  const st = JSON.parse(fs.readFileSync(qf, 'utf8'));
  st.features[0].state = 'ci_passed'; st.features[0].merged_sha = null; // as if the process died before saving
  fs.writeFileSync(qf, JSON.stringify(st));
  sh(e.work, 'checkout', '-q', '-b', 'feat/feature-001-feature-feature-001'); // the branch the crashed run would still be on
  const r = e.d('merge', 'FEATURE-001');
  assert.equal(r.json.state, 'merged', r.err);
  assert.match(r.json.warnings[0], /already merged/);
  assert.equal(sh(e.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('M3 a merge queue or auto-merge is switched off and the PR is held for a person', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  e.setGh((s) => { s.mergeQueue = true; });
  const r = e.d('merge', 'FEATURE-001');
  assert.match(r.json.reason, /queued the merge or enabled auto-merge/);
  assert.ok(e.gh().calls.some((c) => c.includes('--disable-auto')));
  assert.equal(e.gh().prs[0].state, 'OPEN');

  const pre = setup();
  pre.d('init', '--merge', '--note', 'ok');
  ship(pre, 'FEATURE-001');
  pre.setGh((s) => { s.prs[0].autoMerge = true; });
  assert.match(pre.d('merge', 'FEATURE-001').json.reason, /auto-merge or a merge queue is already enabled/);
});

test('M4 a transient UNKNOWN merge state is retried; UNSTABLE is held', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  e.setGh((s) => { s.prs[0].mergeStates = ['UNKNOWN', 'UNKNOWN', 'CLEAN']; });
  assert.equal(e.d('merge', 'FEATURE-001', '--settle', '0').json.state, 'merged');
  const u = setup();
  u.d('init', '--merge', '--note', 'ok');
  ship(u, 'FEATURE-001');
  u.setGh((s) => { s.prs[0].mergeState = 'UNSTABLE'; });
  assert.match(u.d('merge', 'FEATURE-001').json.reason, /non-required check is failing/);
});

test('M5 a fork PR with the same branch name is ignored; we open our own', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.cross = [{ number: 99, url: 'https://github.com/evil/r/pull/99', isCrossRepository: true, head: 'feat/feature-001-feature-feature-001' }]; });
  const r = ship(e, 'FEATURE-001');
  assert.equal(r.json.result, 'passed');
  assert.equal(e.d('status', '--json').json.features[0].pr, 'https://github.com/o/r/pull/1');
});

test('M6 the implementer ledger can raise the tier but never lower what the orchestrator passed', () => {
  const e = setup();
  e.d('init'); e.d('next'); build(e, 'FEATURE-001');
  fs.mkdirSync(path.join(e.work, '.implementation/feature-001'), { recursive: true });
  fs.writeFileSync(path.join(e.work, '.implementation/feature-001/tasks.json'), JSON.stringify({ tier: 'T1', tasks: [] }));
  assert.equal(e.d('built', 'FEATURE-001', '--tier', 'T3').json.tier, 'T3');
});

test('L1 retry sends a held feature back to CI after the policy is changed on purpose', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.noChecks = true; s.required = []; });
  ship(e, 'FEATURE-001');
  assert.equal(e.d('next').json.done, true);
  e.setGh((s) => { s.noChecks = false; });
  assert.equal(e.d('retry', 'FEATURE-001', '--no-ci').code, 0);
  assert.equal(e.d('next').json.resume, true, 'the run is no longer stopped');
});

test('L3 quoted frontmatter values are understood', () => {
  const e = setup();
  e.d('init'); e.d('next'); build(e, 'FEATURE-001');
  const f = path.join(e.work, '.product/features/FEATURE-001.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('delivery: complete', 'delivery: "complete"')); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'q');
  assert.equal(e.d('built', 'FEATURE-001', '--tier', 'T2').code, 0);
});

test('L4 a tampered queue file cannot smuggle a git option or a bad sha', () => {
  const e = setup();
  e.d('init');
  const qf = path.join(e.work, '.delivery/queue.json');
  const st = JSON.parse(fs.readFileSync(qf, 'utf8'));
  st.base = '--upload-pack=touch /tmp/x'; fs.writeFileSync(qf, JSON.stringify(st));
  assert.match(e.d('status').err, /queue file is invalid/);
  st.base = 'main'; st.features[0].ci_sha = 'not-a-sha'; fs.writeFileSync(qf, JSON.stringify(st));
  assert.match(e.d('status').err, /invalid entry for FEATURE-001/);
});

test('L5 init refuses when git origin and gh point at different repositories; gh calls are pinned with --repo', () => {
  const e = setup();
  sh(e.work, 'remote', 'set-url', 'origin', 'git@github.com:someone/else.git');
  assert.match(e.d('init').err, /not the repository gh targets/);
  sh(e.work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  e.d('init');
  ship(e, 'FEATURE-001');
  assert.ok(e.gh().calls.filter((c) => c[0] === 'pr').every((c) => c.includes('--repo') && c[c.indexOf('--repo') + 1] === 'o/r'));
});

test('L6 gh exiting non-zero after the merge went through is verified on GitHub, not trusted', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  e.setGh((s) => { s.mergeNonzeroAfter = true; });
  const r = e.d('merge', 'FEATURE-001');
  assert.equal(r.json.state, 'merged');
  assert.match(r.json.warnings[0], /verified on GitHub/);
});

test('L8 init must run at the repository root', () => {
  const e = setup();
  fs.mkdirSync(path.join(e.work, 'sub'));
  const r = spawnSync('node', [DELIVER, 'init', '--dir', path.join(e.work, 'sub')], { encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });
  assert.match(r.stderr, /run from the repository root|features directory not found/);
});

test('L9 failing CI with no fix rounds left blocks the feature by itself; the CI wait budget is enforced across calls', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok', '--max-fix-rounds', '0');
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'fail', link: 'x' }]]; });
  const r = ship(e, 'FEATURE-001');
  assert.equal(r.json.state, 'blocked');
  assert.equal(r.json.fix_allowed, false);

  const b = setup();
  b.d('init', '--merge', '--note', 'ok', '--ci-budget', '1');
  b.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'pending' }]]; });
  prReady(b);
  const t = b.d('ci', 'FEATURE-001', '--interval', '0.3', '--grace', '0', '--timeout', '1');
  assert.equal(t.json.result, 'timeout');
  assert.equal(t.json.state, 'blocked');
  assert.match(t.json.reason, /did not finish within 1s/);
});

test('L9 a feature held three times for BEHIND is handed to a person, not looped', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  let last;
  for (let i = 0; i < 3; i++) {
    e.setGh((g) => { g.prs[0].mergeState = 'BEHIND'; });
    last = e.d('merge', 'FEATURE-001');
    if (i < 2) { assert.equal(last.json.result, 'updated'); e.d('ci', 'FEATURE-001', ...FAST); }
  }
  assert.match(last.json.reason, /base keeps moving/);
});

test('SEC a workflow file with an unusual name is still caught (git does not quote paths here)', () => {
  const e = setup();
  e.d('init'); e.d('next');
  build(e, 'FEATURE-001', { file: '.github/workflows/caf\u00e9 \u201cci\u201d.yml' });
  assert.deepEqual(e.d('built', 'FEATURE-001', '--tier', 'T2').json.ci_files_touched, ['.github/workflows/caf\u00e9 \u201cci\u201d.yml']);
});

test('SEC merge asks GitHub again: a forged "CI passed" in the state file does not merge a commit whose checks fail', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'fail', link: 'x' }]]; });
  const r = e.d('merge', 'FEATURE-001');
  assert.match(r.json.reason, /does not show the required checks passing/);
  assert.equal(e.gh().prs[0].state, 'OPEN');
  const forged = setup();
  forged.d('init', '--merge', '--note', 'ok');
  ship(forged, 'FEATURE-001');
  forged.setGh((s) => { s.required = []; });
  assert.match(forged.d('merge', 'FEATURE-001').json.reason, /does not show the required checks passing/, 'a verified entry with no required or named checks is refused');
});

// ---- project config (.product/delivery.json) -----------------------------------------------------------------------
test('CFG default: with no config file, main and prod-like branches are protected: PRs are opened but never merged', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: null });
  const init = e.d('init', '--merge', '--note', 'merge please');
  assert.equal(init.json.protected_base, true);
  assert.equal(init.json.merge, false);
  assert.match(init.json.warnings[0], /never merge into it/);
  ship(e, 'FEATURE-001');
  const m = e.d('merge', 'FEATURE-001');
  assert.match(m.json.reason, /protected branch/);
  assert.equal(e.gh().prs[0].state, 'OPEN');
  assert.ok(!e.gh().calls.some((c) => c[1] === 'merge'), 'gh pr merge was never called');
});

test('CFG base branch: features start from the latest base and the PR and merge go to it, not to main', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { base: 'develop', protected_branches: ['main'], merge: { mode: 'squash' } }, base: 'develop' });
  // base moves on after the repo was set up: the feature must start from the new tip
  sh(e.work, 'checkout', '-q', 'develop'); fs.writeFileSync(path.join(e.work, 'newer.txt'), 'n'); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'newer base'); sh(e.work, 'push', '-q', 'origin', 'develop'); sh(e.work, 'reset', '-q', '--hard', 'HEAD~1'); sh(e.work, 'checkout', '-q', 'main');
  const init = e.d('init');
  assert.equal(init.json.base, 'develop');
  assert.equal(init.json.merge, true, 'merge.mode squash in the project config is the standing authorisation');
  const n = e.d('next');
  assert.equal(sh(e.work, 'rev-parse', 'HEAD'), sh(e.origin, 'rev-parse', 'refs/heads/develop'), 'branch starts at the latest origin/develop');
  build(e, 'FEATURE-001'); e.d('built', 'FEATURE-001', '--tier', 'T2');
  e.d('pr', 'FEATURE-001', '--title', 'feat: thing here', '--body-file', body(e));
  assert.equal(e.gh().prs[0].base, 'develop');
  assert.equal(e.d('ci', 'FEATURE-001', ...FAST).json.result, 'passed');
  assert.equal(e.d('merge', 'FEATURE-001').json.state, 'merged');
  assert.match(sh(e.origin, 'log', '-1', '--format=%s', 'develop'), /thing here \(#1\)/);
  assert.equal(sh(e.origin, 'log', '-1', '--format=%s', 'main'), 'init', 'main untouched');
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.work, '.delivery/queue.json'), 'utf8')).authorised_by, 'project config .product/delivery.json');
});

test('CFG a protected pattern also covers release branches; --base cannot get around it', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: ['release/*'], base: 'release/1.0' } });
  sh(e.work, 'branch', 'release/1.0'); sh(e.work, 'push', '-q', 'origin', 'release/1.0');
  assert.equal(e.d('init', '--merge', '--note', 'ok').json.protected_base, true);
});

test('CFG validation: unknown keys, wrong types and unsafe values are refused with the path of the problem', () => {
  const bad = setup({ 'FEATURE-001': {} }, { config: { protected_branchs: ['main'], merge: { mode: 'yolo' }, local_checks: [{ name: 'x', command: 'npm test' }], limits: { max_fix_rounds: 99 }, base: '--evil' } });
  const r = bad.d('init');
  assert.equal(r.code, 1);
  for (const m of [/unknown key "protected_branchs"/, /merge\.mode/, /local_checks\[0\]\.command/, /limits\.max_fix_rounds/, /base: a branch name/]) assert.match(r.err, m);
  const cfg = bad.d('config');
  assert.equal(cfg.code, 1);
  assert.ok(cfg.json.errors.length >= 5);
});

test('CFG config command: effective values without a file, --write creates the template once', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: null });
  const c = e.d('config');
  assert.equal(c.json.file, null);
  assert.deepEqual(c.json.effective.protected_branches, ['main', 'master', 'prod', 'production', 'release/*', 'release-*']);
  assert.equal(e.d('config', '--write').code, 0);
  assert.ok(fs.existsSync(path.join(e.work, '.product/delivery.json')));
  assert.match(e.d('config', '--write').err, /already exists/);
  assert.equal(e.d('config').json.errors.length, 0, 'the template is valid');
});

test('CFG the config must be committed and identical to the copy on the base branch', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: null });
  fs.writeFileSync(path.join(e.work, '.product/delivery.json'), JSON.stringify({ protected_branches: [] }));
  assert.match(e.d('init').err, /not committed/);
  sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'local only config');
  assert.match(e.d('init').err, /differs from the copy on origin\/main|has .* but this checkout/);
  sh(e.work, 'push', '-q', 'origin', 'main');
  assert.equal(e.d('init', '--dry-run').code, 0);

  const stale = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [] } });
  sh(stale.work, 'rm', '-q', '.product/delivery.json'); sh(stale.work, 'commit', '-q', '-m', 'drop');
  assert.match(stale.d('init').err, /origin\/main has .*delivery\.json but this checkout does not/);
});

test('CFG a feature that changes the config file is held for a person', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [] } });
  e.d('init', '--merge', '--note', 'ok');
  e.d('next'); build(e, 'FEATURE-001');
  fs.writeFileSync(path.join(e.work, '.product/delivery.json'), JSON.stringify({ protected_branches: [], merge: { mode: 'squash' } })); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'relax policy');
  assert.deepEqual(e.d('built', 'FEATURE-001', '--tier', 'T2').json.ci_files_touched, ['.product/delivery.json']);
});

test('CFG hold_paths: files under a configured path need a person (for example migrations)', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], hold_paths: ['migrations/', '**/*.sql'] } });
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001', { build: { file: 'migrations/001_users.sql' } });
  assert.match(e.d('merge', 'FEATURE-001').json.reason, /CI or ownership files \(migrations\/001_users\.sql\)/);
});

test('CFG github account: its token is used for every gh call, never written to state; wrong or missing logins and read-only access are refused', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], github: { account: 'work' } } });
  assert.equal(e.d('init', '--merge', '--note', 'ok').json.account, 'work');
  ship(e, 'FEATURE-001');
  const g = e.gh();
  const prCalls = g.calls.map((c, i) => [c, g.tokens[i]]).filter(([c]) => c[0] === 'pr' || (c[0] === 'repo'));
  assert.ok(prCalls.length > 3 && prCalls.every(([, t]) => t === 'tok-work'), 'every gh call used the configured account');
  assert.ok(!fs.readFileSync(path.join(e.work, '.delivery/queue.json'), 'utf8').includes('tok-work'), 'no token in the state file');

  const missing = setup({ 'FEATURE-001': {} }, { config: { github: { account: 'ghost' } } });
  assert.match(missing.d('init').err, /no login for "ghost"/);

  const wrong = setup({ 'FEATURE-001': {} }, { config: { github: { account: 'work' } } });
  wrong.setGh((s) => { s.loginOverride = 'someone-else'; });
  assert.match(wrong.d('init').err, /resolves to "someone-else"/);

  const ro = setup({ 'FEATURE-001': {} }, { config: { github: { account: 'personal' } } });
  ro.setGh((s) => { s.permission = 'READ'; });
  assert.match(ro.d('init').err, /"READ" permission.*WRITE or higher/);
});

test('CFG checks: ignored suites (no e2e here) neither fail nor hold CI; required ones must pass', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], checks: { required: ['unit'], ignored: ['e2e*'] } } });
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.checkQueue = [[{ name: 'unit', bucket: 'pass' }, { name: 'e2e-chrome', bucket: 'fail', link: 'x' }, { name: 'e2e-smoke', bucket: 'pending' }]]; });
  const r = ship(e, 'FEATURE-001');
  assert.equal(r.json.result, 'passed');
  assert.deepEqual(r.json.checks, ['unit']);
  assert.equal(e.d('merge', 'FEATURE-001').json.state, 'merged');

  const strict = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], checks: { required: ['unit'] } } });
  strict.d('init');
  strict.setGh((s) => { s.checkQueue = [[{ name: 'unit', bucket: 'pass' }, { name: 'e2e-chrome', bucket: 'fail', link: 'x' }]]; });
  assert.equal(ship(strict, 'FEATURE-001').json.result, 'failed', 'a failing check that is not ignored still fails');
});

test('CFG local_checks: the orchestrator runs them itself; failure keeps the feature in building until fixed, and is capped', () => {
  const cmd = ['node', '-e', "process.exit(require('fs').existsSync('ok.flag') ? 0 : 3)"];
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], local_checks: [{ name: 'unit tests', command: cmd }] } });
  e.d('init');
  assert.deepEqual(e.d('next').json.local_checks, ['unit tests']);
  build(e, 'FEATURE-001');
  const f1 = e.d('built', 'FEATURE-001', '--tier', 'T2');
  assert.equal(f1.code, 2);
  assert.equal(f1.json.result, 'local_check_failed');
  assert.equal(f1.json.failing[0].exit, 3);
  assert.equal(e.d('status', '--json').json.features[0].state, 'building');
  fs.writeFileSync(path.join(e.work, 'ok.flag'), '1'); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'make it pass');
  assert.equal(e.d('built', 'FEATURE-001', '--tier', 'T2').code, 0);

  const cap = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], limits: { max_fix_rounds: 0 }, local_checks: [{ name: 'unit tests', command: cmd }] } });
  cap.d('init'); cap.d('next'); build(cap, 'FEATURE-001');
  assert.equal(cap.d('built', 'FEATURE-001', '--tier', 'T2').json.state, 'building');
  const second = cap.d('built', 'FEATURE-001', '--tier', 'T2');
  assert.equal(second.json.state, 'blocked');
  assert.match(second.json.reason, /still failing after 2 attempts/);
});

test('CFG branch_prefix, implementer_notes and limits come from the config; flags override limits', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], branch_prefix: 'delivery/', implementer_notes: 'No e2e infra: unit and integration tests only.', limits: { max_fix_rounds: 1 } } });
  e.d('init');
  const n = e.d('next');
  assert.match(n.json.feature.branch, /^delivery\/feature-001-/);
  assert.equal(n.json.guidance, 'No e2e infra: unit and integration tests only.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.work, '.delivery/queue.json'), 'utf8')).max_fix_rounds, 1);
  e.d('reset', '--yes');
  e.d('block', 'FEATURE-001', '--reason', 'x');
  sh(e.work, 'checkout', '-q', 'main');
  assert.equal(e.d('init', '--max-fix-rounds', '3').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.work, '.delivery/queue.json'), 'utf8')).max_fix_rounds, 3);
});

test('SEC the live CI re-check cannot be switched off by editing "ci" in the state file', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  const qf = path.join(e.work, '.delivery/queue.json');
  const st = JSON.parse(fs.readFileSync(qf, 'utf8'));
  st.features[0].ci = 'unverified';
  fs.writeFileSync(qf, JSON.stringify(st));
  e.setGh((s) => { s.required = []; s.checkQueue = [[{ name: 'ci', bucket: 'fail', link: 'x' }]]; });
  assert.match(e.d('merge', 'FEATURE-001').json.reason, /does not show the required checks passing/);
  const again = JSON.parse(fs.readFileSync(qf, 'utf8')); again.features[0].state = 'ci_passed'; fs.writeFileSync(qf, JSON.stringify(again)); // as if the hold had not happened
  e.setGh((s) => { s.checkQueue = [[{ name: 'lint', bucket: 'pass' }]]; });
  assert.match(e.d('merge', 'FEATURE-001').json.reason, /does not show the required checks passing/, 'no required or named checks and no --no-ci: refused even if the file says unverified');
  assert.equal(e.gh().prs[0].state, 'OPEN');
});

test('SEC the account token is only offered to the configured host: remote URL parsing', async () => {
  const { remoteHost, isHttps } = await import(path.join(SK, 'core', 'scripts', 'lib', 'config.mjs'));
  assert.equal(remoteHost('https://github.com/o/r.git'), 'github.com');
  assert.equal(remoteHost('git@github.com:o/r.git'), 'github.com');
  assert.equal(remoteHost('ssh://git@GitHub.com/o/r.git'), 'github.com');
  assert.equal(remoteHost('https://github.com@evil.example/o/r.git'), 'evil.example', 'userinfo tricks do not fool the host');
  assert.equal(remoteHost('https://github.com.evil.example/o/r.git'), 'github.com.evil.example');
  assert.equal(remoteHost('/tmp/some/local/repo.git'), null);
  assert.equal(isHttps('https://github.com/o/r.git'), true);
  assert.equal(isHttps('git@github.com:o/r.git'), false);
  assert.equal(isHttps('http://github.com/o/r.git'), false);
});

test('SEC init refuses an origin on a different host than github.host, so the token cannot be sent elsewhere', () => {
  const e = setup({ 'FEATURE-001': {} }, { config: { protected_branches: [], github: { account: 'work' } } });
  sh(e.work, 'remote', 'set-url', 'origin', 'https://github.com.evil.example/o/r.git');
  assert.match(e.d('init').err, /origin points at host "github\.com\.evil\.example" but github\.host is "github\.com"/);
  sh(e.work, 'remote', 'set-url', 'origin', 'git@ghe.example.com:o/r.git');
  assert.match(e.d('init').err, /github\.host is "github\.com"/);
});
