// Factory Phase 2 (run control) exit criteria: one test per criterion of docs/factory/specs/phase-2-run-control.md ("Exit criteria"),
// named E1..E9. Integration through the shared harness (factory-world.mjs: fake claude, fake gh, local origin, the factory harness as a
// child process that can be SIGKILLed). Ruling 3 of the plan: a usage limit cannot happen during the CI wait or verification (no
// `claude` runs there), so injection points 3 and 4 are tested as a driver kill during those steps.
// The usage-limit classifier is fixtures only (lib/limits.mjs CLASSIFIER_STATUS): E1 and E2 run on fake-claude limit events.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO } from './helpers.mjs';
import {
  SCRIPTS, BASE_CONFIG, world, readiness, good, ready, builderRuns, promptOf, verifyCalls,
  bg, until, sleep, deliverI, freePort, fhLines, runState, writeLocal, attentionItems, lockDoc, alive, testProofProblem,
} from './factory-world.mjs';

const VF = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'verify.mjs')).href);
const P = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'proc.mjs')).href);
const U = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'usage.mjs')).href);
const HS = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'hardstops.mjs')).href);
const LIM = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'limits.mjs')).href);

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const ONE = { 'FEATURE-001': 'Items one' };
const T = (extra = {}) => ({ now: NOW, classifierReal: true, ...extra });
const limited = (extra = {}) => ({ status: 'usage', limit: 'session', resets_at: (NOW + H) / 1000, ...extra });
const CONTINUE = /continue from the current branch and the `\.implementation\/FEATURE-001\/` ledger; finish with `result\.json`/;
const FIXTURES_ONLY = /^note: the usage-limit classifier is fixtures only/m;
const steps = (out) => out.split('\n').filter((l) => /^FEATURE-001 \w+ -> /.test(l)).map((l) => l.replace(/^FEATURE-001 \w+ -> /, ''));
const subjects = (w, repo, ref) => w.sh(repo, 'log', '--format=%s', ref).split('\n');
const notified = (w) => fhLines(w, 'notify.log').map((l) => l.split(' ')[0]);
const FEATURE_CAP = { ...BASE_CONFIG, budgets: { feature: { tokens: 10000, turns: 400 } } };
const G2 = { 'test/items.test.js': "it.only('lists', () => {});\n" };
const AG_FIX = { files: { 'test/items.test.js': "it('lists', () => {});\n" }, commit: true };

// After the merge the base has the squash commit only: no WIP commit reaches it, and the edit the WIP commit held is in it.
function squashedOnBase(w, file) {
  const base = subjects(w, w.origin, 'main');
  assert.equal(base.length, 2, base.join(' | '));
  assert.match(base[0], /\(#1\)$/, 'the squash commit');
  assert.equal(base[1], 'init');
  assert.ok(!base.some((s) => s.startsWith('wip(')), 'no WIP commit on the base');
  assert.ok(w.sh(w.origin, 'show', `main:${file}`).length > 0, `${file} (held by the WIP commit) is in the squash commit`);
}

// ---- E1 -----------------------------------------------------------------------------------------------------------------------------
test('E1 limit mid-build and mid-fix: pause, resume, finish, no lost commits or edits (git log has the WIP commit squashed away after merge), fix_rounds unchanged', (t) => {
  // Injection point 1: mid-build.
  const b = ready(t, { specs: ONE, test: T(), fake: { plan: { 'FEATURE-001': [{ ...limited(), files: { 'src/FEATURE-001.wip': 'half done\n' } }, { ...good('FEATURE-001'), require_files: ['src/FEATURE-001.wip'] }] } } });
  writeLocal(b, { wait_for_reset: true });
  const r = b.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^paused: usage_limit session until /m);
  let f = b.queue().features[0];
  assert.equal(f.state, 'merged'); assert.equal(f.fix_rounds, 0, 'the interruption used no fix round');
  assert.deepEqual(f.interruptions, [{ kind: 'session', step: 'build', minutes_waited: 62, method: 'continue_brief' }]);
  let runs = builderRuns(b, 'FEATURE-001');
  assert.equal(runs.length, 2); assert.match(promptOf(runs[1]), CONTINUE);
  assert.ok(subjects(b, b.builder, f.branch).includes('wip(FEATURE-001): interrupted (session)'), 'the WIP commit held the edit on the branch');
  squashedOnBase(b, 'src/FEATURE-001.wip');
  assert.deepEqual(notified(b), ['paused', 'finished']);

  // Injection point 2: mid-fix (a CI fix session).
  const x = ready(t, { specs: ONE, test: T(), gh: { checkQueue: [[{ name: 'ci', bucket: 'fail', link: 'x' }], [{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]] },
    fake: { plan: { 'FEATURE-001': [good('FEATURE-001'), { ...limited(), files: { 'src/fix.wip': 'half\n' } }, { files: { 'src/fix.txt': 'fixed\n' }, commit: true, require_files: ['src/fix.wip'] }] } } });
  writeLocal(x, { wait_for_reset: true });
  const s = x.factory(['run']);
  assert.equal(s.code, 0, s.out + s.err);
  f = x.queue().features[0];
  assert.equal(f.state, 'merged');
  assert.equal(f.fix_rounds, 1, 'one CI failure is one fix round; the interruption used none');
  assert.deepEqual(steps(s.out).filter((l) => /ci_fix|push|interrupt/.test(l)), ['fix_ci (ci_fix)', 'build (ci_fix)', 'interrupt', 'build (ci_fix)', 'push']);
  runs = builderRuns(x, 'FEATURE-001');
  assert.equal(runs.length, 3); assert.match(promptOf(runs[2]), CONTINUE); assert.match(promptOf(runs[2]), /\bfix\b/);
  assert.deepEqual(f.interruptions.map((i) => [i.kind, i.step]), [['session', 'fix']]);
  squashedOnBase(x, 'src/fix.wip');
  assert.ok(x.sh(x.origin, 'show', 'main:src/fix.txt').includes('fixed'));
});

test('E1 driver killed (SIGKILL) during the CI wait and during verification: rerun continues from the same state with the PR and verdict intact', async (t) => {
  // Injection point 3: the CI wait. The driver is killed while deliver ci (its own process group, recorded in the lock) polls.
  const w = ready(t, { specs: ONE, test: { ciArgs: ['--interval', '1', '--grace', '0', '--timeout', '900'] }, gh: { checkQueue: [[{ name: 'ci', bucket: 'pending', link: 'x', state: 'PENDING' }]] }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const run = bg(w, ['run']);
  await until(() => /^FEATURE-001 pr_open -> ci$/m.test(run.out()) && (lockDoc(w)?.groups || []).length > 0, 'the CI wait');
  const ciGroup = lockDoc(w).groups[0].pgid;
  assert.ok(alive(ciGroup), 'deliver ci is polling');
  run.child.kill('SIGKILL');
  assert.equal((await run.done).signal, 'SIGKILL');
  const pr = w.queue().features[0].pr;
  assert.equal(w.queue().features[0].state, 'pr_open', 'the same state');
  assert.ok(alive(ciGroup), 'the orphaned deliver ci outlived the driver');
  // The rerun kills the orphan at start (before CI can pass, so the orphan cannot record a result), then waits for CI itself.
  const again = bg(w, ['run'], { FACTORY_TEST: JSON.stringify({ ciArgs: ['--interval', '1', '--grace', '0', '--timeout', '900'] }) });
  await until(() => !alive(ciGroup), 'the orphaned deliver ci to be killed', 30000);
  w.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]]; });
  const r = await again.done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out.split('\n').find((l) => / -> /.test(l)), /^FEATURE-001 pr_open -> ci$/, 'continues from the CI wait');
  let f = w.queue().features[0];
  assert.equal(f.state, 'merged'); assert.equal(f.pr.number, pr.number, 'the same PR');
  assert.equal(w.ghState().prs.length, 1, 'no second PR');
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1, 'no new build session'); assert.equal(f.fix_rounds, 0);

  // Injection point 4: verification. (a) killed while the verification runs: the rerun verifies again on the same PR;
  // (b) killed right after the verdict was stored: the rerun uses that verdict (no second verification run).
  const v = ready(t, { specs: ONE, test: { verify: { delayMs: 60000 } }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const vr = bg(v, ['run'], { FACTORY_TEST: JSON.stringify({ verify: { delayMs: 60000 } }) });
  await until(() => /^FEATURE-001 ci_passed -> verify$/m.test(vr.out()), 'the verification');
  await sleep(300);
  vr.child.kill('SIGKILL');
  assert.equal((await vr.done).signal, 'SIGKILL');
  f = v.queue().features[0];
  assert.equal(f.state, 'ci_passed'); assert.equal(verifyCalls(v).length, 0, 'killed before a verdict');
  const prV = f.pr;
  const k = v.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'verify' }) });
  assert.equal(k.signal, 'SIGKILL', k.out + k.err);
  assert.match(k.out, /^FEATURE-001 ci_passed -> verify$/m, 'the rerun verifies the same head again');
  f = v.queue().features[0];
  assert.equal(f.state, 'ci_passed'); assert.equal(f.verdict, 'pass'); assert.equal(f.pr.number, prV.number);
  assert.deepEqual(verifyCalls(v).map((l) => l.split(' ')[2]), ['pass']);
  const z = v.factory(['run']);
  assert.equal(z.code, 0, z.out + z.err);
  assert.match(z.out.split('\n').find((l) => / -> /.test(l)), /^FEATURE-001 ci_passed -> verified$/, 'the stored verdict is used');
  f = v.queue().features[0];
  assert.equal(f.state, 'merged'); assert.equal(f.pr.number, prV.number); assert.equal(v.ghState().prs.length, 1);
  assert.equal(verifyCalls(v).length, 1, 'the verdict was intact: no second verification run');
  assert.equal(builderRuns(v, 'FEATURE-001').length, 1); assert.equal(f.fix_rounds, 0);
});

// ---- E2 -----------------------------------------------------------------------------------------------------------------------------
test('E2 weekly and model stop and notify; wait_for_reset off stops; day cap pauses and resumes after local midnight (fake clock)', (t) => {
  for (const limit of ['weekly', 'model', 'session']) { // session: wait_for_reset is off (the default)
    const w = ready(t, { specs: ONE, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [limited({ limit, files: { 'src/FEATURE-001.wip': 'w\n' } })] } } });
    const r = w.factory(['run']);
    assert.equal(r.code, 2, `${limit}: ${r.out}${r.err}`);
    assert.match(r.out, /^stopped: usage_limit$/m, limit);
    assert.deepEqual(notified(w), ['stopped'], `${limit}: the injected notify recorded the stop`);
    assert.equal(runState(w).status, 'stopped');
    const f = w.queue().features[0];
    assert.equal(f.state, 'building'); assert.equal(f.interrupted.kind, limit);
    assert.ok(subjects(w, w.builder, f.branch).includes(`wip(FEATURE-001): interrupted (${limit})`), `${limit}: the work is kept`);
    assert.deepEqual(attentionItems(w).map((i) => [i.kind, i.run]), [['usage_limit', 'factory run --continue']]);
    assert.equal(fhLines(w, 'sleeps.log').length, 0, `${limit}: no wait`);
  }
  // Day cap with wait_for_reset (the classifier seam lets the local config turn it on).
  const d = ready(t, { specs: ONE, test: T(), fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  writeLocal(d, { wait_for_reset: true, budgets: { day_tokens: 10000 } });
  const day = U.localDay(new Date(NOW));
  fs.mkdirSync(path.join(d.fhome, 'usage', day), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(d.fhome, 'usage'), 0o700);
  fs.writeFileSync(path.join(d.fhome, 'usage', day, 'other__repo.json'), JSON.stringify({ tokens: 10000, cache_read: 0, turns: 0 }));
  const midnight = new Date(NOW); midnight.setHours(24, 0, 0, 0);
  const r = d.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`^paused: day_budget until ${iso(midnight.getTime()).replace(/\./g, '\\.')}$`, 'm'));
  assert.equal(fhLines(d, 'sleeps.log').map(Number).reduce((a, c) => a + c, 0), midnight.getTime() - NOW, 'waited until local midnight');
  assert.equal(builderRuns(d, 'FEATURE-001').length, 1, 'the refused session ran on the new day');
  assert.equal(d.queue().features[0].state, 'merged');
  assert.deepEqual(notified(d), ['paused', 'finished']);
});

test('E2 fixtures only: while the classifier is fixtures only, wait_for_reset is refused and a limit stop says so (run and scenarios)', (t) => {
  assert.equal(LIM.CLASSIFIER_STATUS, 'fixtures_only', 'no real usage-limit capture exists yet: E1 and E2 are proven on fixtures only');
  const w = ready(t, { specs: ONE, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [limited()] } } });
  writeLocal(w, { wait_for_reset: true });
  const refused = w.factory(['run']);
  assert.equal(refused.code, 1, refused.out + refused.err);
  assert.match(refused.out, /^refused: .*wait_for_reset: true is refused: the usage-limit classifier is fixtures only/m);
  fs.rmSync(path.join(w.fhome, 'config.json'));
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: usage_limit$/m);
  assert.match(r.out, FIXTURES_ONLY);
  const s = world(t, { specs: ONE, test: { now: NOW }, fake: { author: { 'FEATURE-001': ['usage'] } } });
  const x = s.factory(['scenarios']);
  assert.equal(x.code, 2, x.out + x.err);
  assert.match(x.out, /^stopped: usage_limit$/m);
  assert.match(x.out, FIXTURES_ONLY);
  // With the classifier validated (the test seam) the note is not printed.
  const v = ready(t, { specs: ONE, test: { now: NOW, classifierReal: true }, fake: { plan: { 'FEATURE-001': [limited()] } } });
  const y = v.factory(['run']);
  assert.equal(y.code, 2, y.out + y.err);
  assert.doesNotMatch(y.out, FIXTURES_ONLY);
});

// ---- E3 -----------------------------------------------------------------------------------------------------------------------------
test('E3 driver killed during a session and during a wait: next start kills the orphan group, no session or app process remains, the run continues', async (t) => {
  // During a session: the session (and the app it started, in the session's process group) outlive the SIGKILLed driver.
  const port = await freePort();
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/x.wip': 'x\n' }, app_port: port, linger_ms: 120000 }, good('FEATURE-001')] } } });
  const run = bg(w, ['run']);
  await until(async () => builderRuns(w, 'FEATURE-001').length === 1 && await P.portInUse(port, '127.0.0.1'), 'the session and its app');
  const session = builderRuns(w, 'FEATURE-001')[0].pid;
  assert.deepEqual(lockDoc(w).groups.map((g) => g.pgid), [session], 'the session group is recorded in the lock');
  run.child.kill('SIGKILL');
  assert.equal((await run.done).signal, 'SIGKILL');
  await sleep(300);
  assert.ok(alive(session), 'the session outlived the driver (an orphan)');
  assert.equal(await P.portInUse(port, '127.0.0.1'), true, 'its app still listens');
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(alive(session), false, 'the next start killed the orphan session group');
  assert.equal(await P.portInUse(port, '127.0.0.1'), false, 'the app port is free');
  assert.equal(VF.scanSurvivors([w.builder, w.clone, path.join(w.fhome, 'work', 'o__r')]), 0, 'no session or app process remains');
  assert.deepEqual(lockDoc(w), null, 'the finished run released its lock (no orphan left recorded)');
  assert.match(r.out, /^FEATURE-001 building -> build \(build\)$/m, 'the run continued with the feature');
  assert.equal(w.queue().features[0].state, 'merged');

  // During a wait (real clock, a reset an hour away): nothing of the session is left; the next start continues the step.
  const x = world(t, { specs: ONE, test: { classifierReal: true } });
  x.setFake((s) => { s.plan = { 'FEATURE-001': [{ status: 'usage', limit: 'session', resets_at: Math.floor(Date.now() / 1000) + 3600, files: { 'src/FEATURE-001.wip': 'w\n' } }, { ...good('FEATURE-001'), require_files: ['src/FEATURE-001.wip'] }] }; });
  readiness(x);
  assert.equal(x.factory(['scenarios']).code, 0);
  writeLocal(x, { wait_for_reset: true });
  const wr = bg(x, ['run']);
  await until(() => /^paused: usage_limit session until /m.test(wr.out()) && runState(x).status === 'paused', 'the wait');
  wr.child.kill('SIGKILL');
  assert.equal((await wr.done).signal, 'SIGKILL');
  assert.deepEqual(lockDoc(x).groups, [], 'no process group was running during the wait');
  assert.equal(runState(x).status, 'paused');
  const y = x.factory(['run']);
  assert.equal(y.code, 0, y.out + y.err);
  assert.equal(VF.scanSurvivors([x.builder, x.clone, path.join(x.fhome, 'work', 'o__r')]), 0);
  const f = x.queue().features[0];
  assert.equal(f.state, 'merged');
  const runs = builderRuns(x, 'FEATURE-001');
  assert.equal(runs.length, 2, 'continued, not rebuilt'); assert.match(promptOf(runs[1]), CONTINUE);
  assert.equal(runState(x).status, 'finished');
});

// ---- E4 -----------------------------------------------------------------------------------------------------------------------------
test('E4 stop --now halts within 60 s, ports free, --continue resumes correctly', async (t) => {
  const port = await freePort();
  const config = { ...BASE_CONFIG, app: { start: ['node', 'server.js'], ready: { url: `http://127.0.0.1:${port}/health`, timeout_s: 5 } } };
  const w = ready(t, { config, specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/FEATURE-001.wip': 'half\n' }, escape_ms: 120000, escape_port: port, linger_ms: 120000 }, { ...good('FEATURE-001'), require_files: ['src/FEATURE-001.wip'] }] } } });
  const run = bg(w, ['run']);
  await until(async () => builderRuns(w, 'FEATURE-001').length === 1 && await P.portInUse(port, '127.0.0.1'), 'the session and its escaped app');
  const t0 = Date.now();
  const s = w.factory(['stop', '--now']);
  assert.equal(s.code, 0, s.out + s.err);
  const r = await run.done;
  const ms = Date.now() - t0;
  assert.ok(ms < 60000, `halted ${ms} ms after the stop`);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /^stopped: stop$/m);
  assert.equal(await P.portInUse(port, '127.0.0.1'), false, 'the app port is free');
  assert.equal(VF.scanSurvivors([w.builder, w.clone, path.join(w.fhome, 'work', 'o__r')]), 0, 'no survivor');
  assert.equal(runState(w).status, 'stopped');
  const f = w.queue().features[0];
  assert.equal(f.interrupted.kind, 'stop');
  assert.ok(subjects(w, w.builder, f.branch).includes('wip(FEATURE-001): interrupted (stop)'));
  assert.equal(w.factory(['run']).code, 1, 'the flag refuses a plain run');
  const c = w.factory(['run', '--continue']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /^continue: the stop request is cleared$/m);
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2, 'one continued session'); assert.match(promptOf(runs[1]), CONTINUE);
  assert.equal(w.queue().features[0].state, 'merged');
  squashedOnBase(w, 'src/FEATURE-001.wip');
});

// ---- E5 -----------------------------------------------------------------------------------------------------------------------------
test('E5 feature cap holds with the work committed; --raise-budget continues it', (t) => {
  // limits.max_failures 1: a budget hold counted as a failure would trip the breaker and FEATURE-002 would never run.
  const w = ready(t, { config: { ...FEATURE_CAP, limits: { max_failures: 1 } }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001', G2), tokens: 9655 }, AG_FIX], 'FEATURE-002': [good('FEATURE-002')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  let [f1, f2] = w.queue().features;
  assert.equal(f1.state, 'awaiting_human'); assert.equal(f1.hold_kind, 'budget'); assert.deepEqual(f1.budget_hold, { from: 'building' });
  assert.equal(f2.state, 'merged', 'the next independent feature still runs and merges (the breaker is not tripped)');
  assert.ok(w.sh(w.clone, 'diff', '--name-only', `${f1.base_sha}..${f1.branch}`).split('\n').includes('src/FEATURE-001.txt'), 'the work is committed on the branch');
  assert.equal(w.sh(w.builder, 'status', '--porcelain', '--', 'src'), '', 'nothing of it is left uncommitted');
  assert.deepEqual(attentionItems(w).filter((i) => i.kind === 'budget').map((i) => i.run), ['factory run --raise-budget FEATURE-001']);
  const c = w.factory(['run', '--raise-budget', 'FEATURE-001']);
  assert.equal(c.code, 0, c.out + c.err);
  [f1] = w.queue().features;
  assert.equal(f1.state, 'merged'); assert.deepEqual(f1.budget_cap, { tokens: 20000, turns: 800 });
  assert.match(c.out, /^FEATURE-001 building -> built$/m, 'continued from the branch, not rebuilt');
  assert.equal(builderRuns(w, 'FEATURE-001').length, 2);
  assert.ok(!attentionItems(w).some((i) => i.kind === 'budget'), 'the budget row is resolved');
});

test('E5 feature cap hit by a ci_fix session: held from fixing, --raise-budget returns it to fixing and the continued session pushes only after done', (t) => {
  const w = ready(t, { config: FEATURE_CAP, specs: ONE, test: { now: NOW }, gh: { checkQueue: [[{ name: 'ci', bucket: 'fail', link: 'x' }], [{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]] },
    fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), tokens: 9655 }, { files: { 'src/fix.txt': 'fixed\n' }, commit: true }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.deepEqual(steps(r.out).slice(-3), ['fix_ci (ci_fix)', 'build (ci_fix)', 'interrupt'], 'the fix session was refused at its start (budget interrupt)');
  let f = w.queue().features[0];
  assert.equal(f.state, 'awaiting_human'); assert.equal(f.hold_kind, 'budget'); assert.deepEqual(f.budget_hold, { from: 'fixing' });
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1, 'no fix session ran');
  const heldHead = f.pr.head_sha;
  const c = w.factory(['run', '--raise-budget', 'FEATURE-001']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, /^FEATURE-001 budget raised: tokens 20000, turns 800; continuing at fixing$/m);
  const after = steps(c.out);
  assert.deepEqual(after.slice(0, 2), ['build (ci_fix)', 'push'], 'the continued fix session first, then the push');
  f = w.queue().features[0];
  assert.equal(f.state, 'merged');
  assert.notEqual(f.pr.head_sha, heldHead, 'the fix was pushed');
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2); assert.match(promptOf(runs[1]), /\bfix\b/);
  assert.equal(f.fix_rounds, 1, 'the CI failure is the only fix round');
  assert.ok(w.sh(w.origin, 'show', 'main:src/fix.txt').includes('fixed'));
});

// ---- E6 -----------------------------------------------------------------------------------------------------------------------------
test('E6 second driver refused; interactive deliver refused under the lock and the flag', async (t) => {
  const GUARD = /a factory run holds this repository; run factory stop first/;
  const FLAG = /a factory stop is pending for this repository/;
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/a.wip': 'a\n' }, linger_ms: 120000 }, good('FEATURE-001')] } } });
  const run = bg(w, ['run']);
  await until(() => builderRuns(w, 'FEATURE-001').length === 1, 'the builder session');
  assert.equal(w.queue().features[0].state, 'building', 'the driver\'s own deliver calls (init, next) passed under its lock');
  const second = w.factory(['run']);
  assert.equal(second.code, 1, second.out + second.err);
  assert.match(second.out, /^refused: another factory run holds the lock for this repository$/m);
  for (const args of [['next'], ['ci', 'FEATURE-001'], ['merge', 'FEATURE-001']]) {
    const d = deliverI(w, args);
    assert.equal(d.code, 1, `${args[0]}: ${d.out}${d.err}`); assert.match(d.err, GUARD, args[0]);
  }
  const asDriver = deliverI(w, ['ci', 'FEATURE-001'], { FACTORY_DRIVER_PID: String(run.child.pid) });
  assert.doesNotMatch(asDriver.err, GUARD, 'the driver pid passes the guard');
  assert.equal(deliverI(w, ['status', '--json']).code, 0); assert.equal(deliverI(w, ['config']).code, 0);
  assert.equal(JSON.parse(w.factory(['status', '--json']).out).lock, 'live');
  assert.equal(w.factory(['stop']).code, 0);
  assert.equal((await run.done).code, 2);
  for (const args of [['next'], ['ci', 'FEATURE-001'], ['merge', 'FEATURE-001']]) {
    const d = deliverI(w, args);
    assert.equal(d.code, 1, `${args[0]}: ${d.out}${d.err}`); assert.match(d.err, FLAG, args[0]);
  }
  assert.equal(deliverI(w, ['status']).code, 0); assert.equal(deliverI(w, ['config']).code, 0); assert.equal(w.factory(['status']).code, 0);
  const c = w.factory(['run', '--continue']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.equal(w.queue().features[0].state, 'merged');
});

// ---- E7 -----------------------------------------------------------------------------------------------------------------------------
test('E7 a builder PR that edits .product/delivery.json is held (antigaming at built or merge)', (t) => {
  const raised = `${JSON.stringify({ ...FEATURE_CAP, budgets: { feature: { tokens: 900000000, turns: 5000 } } }, null, 2)}\n`;
  const w = ready(t, { config: FEATURE_CAP, specs: ONE, fake: { plan: { 'FEATURE-001': [good('FEATURE-001', { '.product/delivery.json': raised })] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^attention: FEATURE-001 awaiting_human \(antigaming\)$/m);
  const f = w.queue().features[0];
  assert.equal(f.state, 'awaiting_human'); assert.equal(f.hold_kind, 'antigaming');
  assert.deepEqual(f.hold_ids, ['G4']); assert.deepEqual(f.antigaming, ['G4']);
  assert.equal(f.antigaming_hold.sha, f.built_sha, 'G4 fired at built, bound to that sha');
  assert.ok(w.sh(w.clone, 'diff', '--name-only', `${f.base_sha}..${f.branch}`).split('\n').includes('.product/delivery.json'));
  assert.equal(verifyCalls(w).length, 0, 'never verified');
  assert.ok(!w.ghState().calls.some((c) => c[0] === 'pr' && c[1] === 'merge'), 'never merged');
  assert.deepEqual(JSON.parse(w.sh(w.origin, 'show', 'main:.product/delivery.json')).budgets, FEATURE_CAP.budgets, 'the base config is unchanged');
});

// ---- E8 -----------------------------------------------------------------------------------------------------------------------------
test('E8 every HARD_STOPS row has a passing test or probe or is printed as unproven', (t) => {
  assert.deepEqual(HS.HARD_STOPS.map((r) => r.id), ['hs-secrets', 'hs-network', 'hs-destructive-data', 'hs-merge-gate', 'hs-delivery-config', 'hs-factory-state', 'hs-run-history']);
  const testRows = HS.HARD_STOPS.filter((r) => r.proof.kind === 'test');
  const probeRows = HS.HARD_STOPS.filter((r) => r.proof.kind === 'probe');
  assert.equal(testRows.length + probeRows.length, HS.HARD_STOPS.length, 'every row is proven by a test or a probe');
  // A test proof: the ref names an existing test whose title starts with the row id, and that test passes (run as its own
  // node --test process: without NODE_TEST_CONTEXT, which would make it report to this runner instead of printing TAP).
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  for (const row of testRows) {
    assert.equal(testProofProblem(row), null, row.id);
    const x = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${row.id}:`, path.join(REPO, 'tests', 'validation', row.proof.ref)], { encoding: 'utf8', timeout: 240000, env: childEnv });
    assert.equal(x.status, 0, `${row.id}: ${x.stdout.slice(-2000)}`);
    assert.ok(Number((/^# pass (\d+)$/m.exec(x.stdout) || [])[1]) >= 1, `${row.id}: its test ran and passed`);
    assert.match(x.stdout, /^# fail 0$/m, row.id);
  }
  // A probe proof with no saved probe result: every probe row is printed as unproven (and test rows never are).
  const w = ready(t, { probe: null, specs: ONE, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  const printed = r.out.split('\n').filter((l) => l.startsWith('unproven hard stop:'));
  assert.deepEqual(printed.map((l) => l.split(' ')[3]), probeRows.map((p) => p.id));
  for (const row of probeRows) assert.ok(printed.includes(`unproven hard stop: ${row.id} ${row.name} (no saved probe result)`), row.id);
  // With a saved proving result (the harness default) nothing is printed: each probe row is proven.
  const p = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const y = p.factory(['run']);
  assert.equal(y.code, 0, y.out + y.err);
  assert.ok(!y.out.includes('unproven hard stop:'), y.out);
});

// ---- E9 -----------------------------------------------------------------------------------------------------------------------------
test('E9 SKILL.md under 500 lines', () => {
  const text = fs.readFileSync(path.join(REPO, 'skills', 'delivery-orchestrator', 'SKILL.md'), 'utf8');
  const n = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  assert.ok(n < 500, `${n} lines`);
});
