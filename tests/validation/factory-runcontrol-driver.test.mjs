// factory driver run control (Task 8a): local config refusal, usage recording, feature and day budgets.
// Unit tests of enforceBudget, then integration through the shared harness (factory-world.mjs: fake claude, fake gh, local origin).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPTS, BASE_CONFIG, AUTHOR_OK, world, readiness, good, ready, builderRuns, promptOf } from './factory-world.mjs';

const FX = await import(pathToFileURL(path.join(SCRIPTS, 'factory.mjs')).href);
const D = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'driver.mjs')).href);
const U = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'usage.mjs')).href);

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const DAY = U.localDay(new Date(NOW));
const tmp = (t) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-rc-'))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const usageFile = (fh, key = 'o__r') => path.join(fh, 'usage', DAY, `${key}.json`);
const seedUsage = (fh, key, tokens) => { fs.mkdirSync(path.join(fh, 'usage', DAY), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(fh, 'usage'), 0o700); fs.writeFileSync(usageFile(fh, key), JSON.stringify({ tokens, cache_read: 0, turns: 0 })); };
const readUsage = (fh) => JSON.parse(fs.readFileSync(usageFile(fh), 'utf8'));
const S1 = (tokens) => ({ role: 'builder', in: tokens, out: 0, cache_create: 0, cache_read: 0, turns: 2 });

// ---- enforceBudget (unit) ------------------------------------------------------------------------------------------------------------
function ctxFor(t, { feature = { tokens: 10000, turns: 50 }, day = null } = {}) {
  return { fh: tmp(t), key: 'o__r', policy: { budgets: { feature } }, local: { budgets: { day_tokens: day } }, deps: { clock: { now: () => NOW, sleep: async () => {} } } };
}

test('enforceBudget: null under the caps; a feature counter at or over its cap returns the budget result (tokens before turns)', (t) => {
  const ctx = ctxFor(t);
  assert.equal(FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [S1(9999)] }, 'builder'), null);
  assert.deepEqual(FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [S1(10000)] }, 'builder'), { step: 'session', kind: 'budget', scope: 'feature', dim: 'tokens', used: 10000, cap: 10000 });
  assert.deepEqual(FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: Array.from({ length: 25 }, () => S1(1)) }, 'builder'), { step: 'session', kind: 'budget', scope: 'feature', dim: 'turns', used: 50, cap: 50 });
  // The driver decision table turns it into the interrupt action (Task 6).
  const r = FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [S1(20000)] }, 'builder');
  assert.deepEqual({ ...D.nextAction({ id: 'FEATURE-001', state: 'building', history: [] }, r, { max_fix_rounds: 2, stop: null }) }, { do: 'interrupt', kind: 'budget', scope: 'feature' });
});

test('enforceBudget: a raised cap (f.budget_cap) replaces the policy caps', (t) => {
  const ctx = ctxFor(t);
  const f = { id: 'FEATURE-001', sessions: [S1(15000)], budget_cap: { tokens: 20000, turns: 100 } };
  assert.equal(FX.enforceBudget(ctx, f, 'builder'), null);
  assert.equal(FX.enforceBudget(ctx, { ...f, sessions: [S1(20000)] }, 'builder').cap, 20000);
});

test('enforceBudget: day cap from the local config counts every repository of the local day; null = no day cap', (t) => {
  const ctx = ctxFor(t, { day: 10000 });
  assert.equal(FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [] }, 'builder'), null);
  seedUsage(ctx.fh, 'other__repo', 6000); seedUsage(ctx.fh, 'o__r', 4000);
  assert.deepEqual(FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [] }, 'builder'), { step: 'session', kind: 'budget', scope: 'day', dim: 'tokens', used: 10000, cap: 10000 });
  assert.equal(FX.enforceBudget(ctx, null, 'author').scope, 'day', 'an author session (no queue feature) is checked against the day cap');
  ctx.local.budgets.day_tokens = null;
  assert.equal(FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [] }, 'builder'), null);
  // A feature hit is reported before a day hit.
  ctx.local.budgets.day_tokens = 10000;
  assert.equal(FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [S1(10000)] }, 'builder').scope, 'feature');
});

test('enforceBudget: a malformed cap throws (never fails open); a corrupt usage file throws UsageError', (t) => {
  for (const [what, feature, day, f] of [
    ['policy tokens NaN', { tokens: NaN, turns: 50 }, null, {}],
    ['policy turns missing', { tokens: 10000 }, null, {}],
    ['policy tokens a string', { tokens: '10000', turns: 50 }, null, {}],
    ['raised cap a string', { tokens: 10000, turns: 50 }, null, { budget_cap: { tokens: 'x', turns: 50 } }],
    ['raised cap not an object', { tokens: 10000, turns: 50 }, null, { budget_cap: 5 }],
    ['day cap Infinity', { tokens: 10000, turns: 50 }, Infinity, {}],
    ['day cap negative', { tokens: 10000, turns: 50 }, -1, {}],
  ]) {
    const ctx = ctxFor(t, { feature, day });
    assert.throws(() => FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [], ...f }, 'builder'), /budget cap/, what);
  }
  const ctx = ctxFor(t, { day: 10000 });
  seedUsage(ctx.fh, 'o__r', 1);
  fs.writeFileSync(usageFile(ctx.fh), '{bad');
  assert.throws(() => FX.enforceBudget(ctx, { id: 'FEATURE-001', sessions: [] }, 'builder'), (e) => e instanceof U.UsageError);
});

// ---- integration -----------------------------------------------------------------------------------------------------------------------
const writeLocal = (w, doc) => fs.writeFileSync(path.join(w.fhome, 'config.json'), JSON.stringify(doc));
const G2 = { 'test/items.test.js': "it.only('lists', () => {});\n" };
const FEATURE_CAP = { ...BASE_CONFIG, budgets: { feature: { tokens: 10000, turns: 400 } } };
// One fake session = in + 45 out + 300 cache_create; tokens: 9655 makes it exactly 10000.

test('feature cap: reached exactly after a session -> the next session never starts; awaiting_human (budget) with the work on its branch, an attention row with the run command; the breaker is untouched and the next feature merges', (t) => {
  const w = ready(t, { config: FEATURE_CAP, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001', G2), tokens: 9655 }, { status: 'done' }], 'FEATURE-002': [good('FEATURE-002')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err); // finished, but a feature needs a person
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1, 'the anti-gaming fix session was refused by the budget');
  const [f1, f2] = w.queue().features;
  assert.equal(f1.state, 'awaiting_human'); assert.equal(f1.hold_kind, 'budget'); assert.deepEqual(f1.budget_hold, { from: 'building' });
  assert.match(f1.reason, /feature budget reached: tokens 10000 of 10000/);
  assert.equal(f2.state, 'merged', 'the circuit breaker is not tripped: the next independent feature still runs');
  assert.match(r.out, /^attention: FEATURE-001 awaiting_human \(budget\)$/m);
  // The work is on the branch (driver clone), committed.
  const files = w.sh(w.clone, 'diff', '--name-only', `${f1.base_sha}..${f1.branch}`).split('\n');
  assert.ok(files.includes('src/FEATURE-001.txt'), files.join(','));
  const md = fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.md'), 'utf8');
  assert.match(md, /budget:FEATURE-001/); assert.match(md, /`factory run --raise-budget FEATURE-001`/);
  const items = JSON.parse(fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.json'), 'utf8'));
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.severity, i.run]), [['FEATURE-001', 'budget', 'high', 'factory run --raise-budget FEATURE-001']]);
  assert.match(r.out, /^warning: no daily token cap is set \(budgets\.day_tokens in ~\/\.factory\/config\.json\)$/m);
});

test('feature cap: one token under the cap the next session still runs', (t) => {
  const w = ready(t, { config: FEATURE_CAP, specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001', G2), tokens: 9654 }, { status: 'done' }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 2);
  assert.equal(w.queue().features[0].state, 'blocked', 'G2 still fires after the fix attempt (not a budget hold)');
});

test('day cap: reached (all repositories of the local day) -> stopped: day_budget, exit 2, no builder session; author sessions stop too', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  writeLocal(w, { budgets: { day_tokens: 10000 } });
  seedUsage(w.fhome, 'other__repo', 10000);
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: day_budget$/m);
  assert.ok(!/warning: no daily token cap/.test(r.out));
  assert.equal(builderRuns(w, 'FEATURE-001').length, 0);
  assert.equal(w.queue().features[0].state, 'building', 'the feature is left as it is');

  const a = world(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW } });
  writeLocal(a, { budgets: { day_tokens: 10000 } });
  seedUsage(a.fhome, 'o__r', 10000);
  const s = a.factory(['scenarios']);
  assert.equal(s.code, 2, s.out + s.err);
  assert.match(s.out, /^stopped: day_budget$/m);
  assert.equal(a.sessions().length, 0, 'no author session started');
});

test('a corrupt usage file refuses factory run before any session (and before the queue is made)', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  fs.writeFileSync(usageFile(w.fhome), '{bad');
  const r = w.factory(['run']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^refused: .*usage file .*o__r\.json/m);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 0);
  assert.equal(fs.existsSync(w.queueFile), false);
});

test('local config: an unknown key or wait_for_reset true (classifier fixtures only) refuses run and scenarios, naming config.json', (t) => {
  const w = world(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  readiness(w);
  for (const [doc, re] of [[{ bogus: 1 }, /unknown key "bogus"/], [{ budgets: { day_tokens: 10000, week: 1 } }, /unknown key "budgets\.week"/], [{ wait_for_reset: true }, /fixtures only/], ['{', /not valid JSON/]]) {
    fs.writeFileSync(path.join(w.fhome, 'config.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
    for (const cmd of ['run', 'scenarios']) {
      const r = w.factory([cmd]);
      assert.equal(r.code, 1, `${cmd} ${JSON.stringify(doc)}: ${r.out}${r.err}`);
      assert.match(r.out, /^refused: .*config\.json/m);
      assert.match(r.out, re);
    }
  }
  assert.equal(w.sessions().length, 0, 'no session started');
  fs.rmSync(path.join(w.fhome, 'config.json'));
  assert.equal(w.factory(['scenarios']).code, 0, 'an absent config.json is the defaults');
});

test('usage: every author and builder session (failed and interrupted ones too) is added to usage/<local day>/<key>.json; sessions carry cost_usd', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ status: 'usage' }, { status: 'none' }] } } });
  assert.deepEqual(readUsage(w.fhome), { tokens: 465, cache_read: 9000, turns: 2 }, 'the author session');
  const r1 = w.factory(['run']);
  assert.equal(r1.code, 2, r1.out + r1.err); assert.match(r1.out, /stopped: usage_limit/);
  assert.deepEqual(readUsage(w.fhome), { tokens: 930, cache_read: 18000, turns: 4 }, 'the interrupted builder session');
  const r2 = w.factory(['run']);
  assert.equal(r2.code, 2, r2.out + r2.err); assert.match(r2.out, /FEATURE-001 building -> block/); // no result.json: the builder failed
  assert.deepEqual(readUsage(w.fhome), { tokens: 1395, cache_read: 27000, turns: 6 }, 'the failed builder session');
  const f = w.queue().features[0];
  assert.equal(f.sessions.length, 2);
  for (const s of f.sessions) assert.equal(s.cost_usd, 0.0123);
});

test('a malformed raised cap (f.budget_cap) in a queue in progress refuses the run before any session', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ status: 'usage' }] } } });
  assert.equal(w.factory(['run']).code, 2);
  const q = w.queue(); q.features[0].budget_cap = { tokens: 'lots', turns: 10 }; fs.writeFileSync(w.queueFile, JSON.stringify(q));
  const r = w.factory(['run']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^refused: the raised budget cap of FEATURE-001 is malformed$/m);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1, 'no second session');
});

// ---- Task 8b: interruptions, WIP commits, waiting, notifications, run state -------------------------------------------------------------
const H = 3600000;
const SID = '00000000-0000-4000-8000-000000000001';
const RESET_S = (NOW + H) / 1000; // the classifier's reset time: one hour after the fake clock's start
const iso = (ms) => new Date(ms).toISOString();
const limited = (extra = {}) => ({ status: 'usage', limit: 'session', resets_at: RESET_S, ...extra });
const T = (extra = {}) => ({ now: NOW, classifierReal: true, ...extra });
const WAIT_ON = { wait_for_reset: true };
const lines = (w, name) => { const f = path.join(w.fhome, name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };
const sleeps = (w) => lines(w, 'sleeps.log').map(Number);
const runState = (w) => JSON.parse(fs.readFileSync(path.join(w.fhome, 'runs', 'o__r.json'), 'utf8'));
const attentionItems = (w) => JSON.parse(fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.json'), 'utf8'));
const subjects = (w, branch) => w.sh(w.builder, 'log', '--format=%s', branch).split('\n');
const CONTINUE = /continue from the current branch and the `\.implementation\/FEATURE-001\/` ledger; finish with `result\.json`/;
const steps = (out) => out.split('\n').filter((l) => /^FEATURE-001 \w+ -> /.test(l)).map((l) => l.replace(/^FEATURE-001 \w+ -> /, ''));

test('waitUntil: 30 s slices against the wall clock; a +3 h jump inside one slice ends the wait at the next slice; a clock that never reaches the end stops after the planned time; the stop flag ends it', async (t) => {
  const mk = ({ jump = 0, frozen = false } = {}) => {
    let now = NOW; const slept = [];
    const ctx = { fh: tmp(t), key: 'o__r', local: { keep_awake: false }, lock: { owned: () => true }, deps: { clock: { now: () => now, sleep: async (ms) => { slept.push(ms); if (!frozen) now += ms; if (slept.length === 1) now += jump; } } } };
    return { ctx, slept };
  };
  const a = mk({ jump: 3 * H });
  assert.equal(await FX.waitUntil(a.ctx, NOW + H, { kind: 'usage_limit' }), 'done');
  assert.deepEqual(a.slept, [30000], 'the jump ends the wait at the next slice');
  const b = mk();
  assert.equal(await FX.waitUntil(b.ctx, NOW + 75000, { kind: 'usage_limit' }), 'done');
  assert.deepEqual(b.slept, [30000, 30000, 15000]);
  const c = mk({ frozen: true });
  assert.equal(await FX.waitUntil(c.ctx, NOW + 5 * 60000, { kind: 'usage_limit' }), 'done');
  assert.equal(c.slept.reduce((x, y) => x + y, 0), 5 * 60000, 'bounded by the planned wait even when the clock never gets there');
  const d = mk();
  fs.mkdirSync(path.join(d.ctx.fh, 'stop'), { recursive: true }); fs.writeFileSync(path.join(d.ctx.fh, 'stop', 'o__r'), '');
  assert.equal(await FX.waitUntil(d.ctx, NOW + H, { kind: 'usage_limit' }), 'stopped');
  assert.deepEqual(d.slept, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.ctx.fh, 'runs', 'o__r.json'), 'utf8')).status, 'paused');
});

test('mid-build limit with uncommitted edits: WIP commit "wip(FEATURE-001): interrupted (session)" holds the edits, the run waits (fake clock), the continue session sees the edits and the brief text, and the feature merges; fix_rounds stays 0', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: T(), fake: { plan: { 'FEATURE-001': [{ ...limited(), files: { 'src/FEATURE-001.wip': 'half done\n' } }, { ...good('FEATURE-001'), require_files: ['src/FEATURE-001.wip'] }] } } });
  writeLocal(w, WAIT_ON);
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  const f = w.queue().features[0];
  assert.equal(f.state, 'merged'); assert.equal(f.fix_rounds, 0);
  assert.equal(f.interrupted, undefined, 'cleared when the continued session ended normally');
  assert.deepEqual(f.interruptions, [{ kind: 'session', step: 'build', minutes_waited: 62, method: 'continue_brief' }]);
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2);
  assert.doesNotMatch(promptOf(runs[0]), CONTINUE);
  assert.match(promptOf(runs[1]), CONTINUE); assert.match(promptOf(runs[1]), /FEATURE-001/); assert.match(promptOf(runs[1]), /\bbuild\b/);
  const subs = subjects(w, f.branch);
  assert.ok(subs.includes('wip(FEATURE-001): interrupted (session)'), subs.join(' | '));
  const wip = w.sh(w.builder, 'log', '--format=%H', '--grep', '^wip(FEATURE-001)', f.branch).split('\n')[0];
  assert.deepEqual(w.sh(w.builder, 'show', '--name-only', '--format=', wip).split('\n'), ['src/FEATURE-001.wip'], 'only the edits: no .implementation');
  assert.match(r.out, new RegExp(`^paused: usage_limit session until ${iso(NOW + H + 120000).replace(/\./g, '\\.')}$`, 'm'));
  assert.equal(sleeps(w).reduce((x, y) => x + y, 0), 62 * 60000);
  assert.ok(sleeps(w).every((ms) => ms <= 30000));
  assert.deepEqual(lines(w, 'notify.log').map((l) => l.split(' ')[0]), ['paused', 'finished']);
  assert.deepEqual(lines(w, 'awake.log'), [`caffeinate -i -w ${lines(w, 'awake.log')[0].split(' ').pop()}`, 'killed']);
  assert.equal(runState(w).status, 'finished');
});

test('mid-fix limit (ci_fix): WIP commit, wait, continued fix session; no fix round consumed; push only after the continued session reports done', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: T(), gh: { checkQueue: [[{ name: 'ci', bucket: 'fail', link: 'x' }], [{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]] },
    fake: { plan: { 'FEATURE-001': [good('FEATURE-001'), { ...limited(), files: { 'src/fix.wip': 'half\n' } }, { files: { 'src/fix.txt': 'fixed\n' }, commit: true, require_files: ['src/fix.wip'] }] } } });
  writeLocal(w, WAIT_ON);
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  const f = w.queue().features[0];
  assert.equal(f.state, 'merged');
  assert.equal(f.fix_rounds, 1, 'one CI failure, one fix round; the interruption used none');
  assert.deepEqual(steps(r.out).filter((s) => /ci_fix|push|interrupt/.test(s)), ['fix_ci (ci_fix)', 'build (ci_fix)', 'interrupt', 'build (ci_fix)', 'push']);
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 3);
  assert.match(promptOf(runs[2]), CONTINUE); assert.match(promptOf(runs[2]), /\bfix\b/);
  assert.ok(subjects(w, f.branch).includes('wip(FEATURE-001): interrupted (session)'));
  assert.deepEqual(f.interruptions.map((i) => [i.kind, i.step]), [['session', 'fix']]);
});

test('limit with only .implementation/ changes: no WIP commit, no error; wait_for_reset off: stops (usage_limit), feature left building with interrupted set, attention row names factory run --continue', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...limited(), files: { '.implementation/FEATURE-001/notes.md': 'ledger\n' } }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: usage_limit$/m); assert.doesNotMatch(r.out, /error/);
  const f = w.queue().features[0];
  assert.equal(f.state, 'building');
  assert.ok(!subjects(w, f.branch).some((s) => s.startsWith('wip(')), 'no empty WIP commit');
  assert.deepEqual({ ...f.interrupted, ts: undefined }, { kind: 'session', step: 'build', session_id: SID, head: f.base_sha, ts: undefined });
  assert.match(f.interrupted.ts, /^\d{4}-\d\d-\d\dT/);
  const items = attentionItems(w);
  assert.deepEqual(items.map((i) => [i.id, i.kind, i.severity, i.run]), [['FEATURE-001', 'usage_limit', 'high', 'factory run --continue']]);
  assert.match(fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.md'), 'utf8'), /`factory run --continue`/);
  assert.deepEqual(lines(w, 'notify.log').map((l) => l.split(' ')[0]), ['stopped']);
  assert.equal(runState(w).status, 'stopped');
});

test('resetAt unknown: run state shows paused estimated true until now + 5 h; the stop flag ends the wait and the run (status stopped)', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: T() });
  // The session creates the stop flag (a stale flag before the run would refuse it: Task 9).
  w.setFake((s) => { s.plan = { 'FEATURE-001': [limited({ resets_at: null, touch: path.join(w.fhome, 'stop', 'o__r') })] }; });
  writeLocal(w, WAIT_ON);
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, new RegExp(`^paused: usage_limit session until ${iso(NOW + 5 * H).replace(/\./g, '\\.')} \\(estimated\\)$`, 'm'));
  assert.match(r.out, /^stopped: stop$/m);
  const st = runState(w);
  assert.equal(st.status, 'stopped');
  assert.deepEqual(st.pause, { kind: 'usage_limit', limit: 'session', reset_at: iso(NOW + 5 * H), estimated: true });
  assert.equal(w.queue().features[0].interrupted.kind, 'session');
});

test('a clock that never reaches the reset: each wait is bounded by its planned time and the run stops at max_wait_h', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: T({ frozen: true }), fake: { plan: { 'FEATURE-001': [limited()] } } });
  writeLocal(w, { wait_for_reset: true, max_wait_h: 1.5 });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: usage_limit$/m); assert.match(r.out, /max_wait_h/);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 4);
  assert.deepEqual(w.queue().features[0].interruptions.map((i) => i.minutes_waited), [62, 10, 10]);
  assert.equal(sleeps(w).reduce((x, y) => x + y, 0), 82 * 60000);
});

test('a +3 h clock jump inside one sleep: the wait ends at the next slice, not 3 h later', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: T({ jump: { at: 1, ms: 3 * H } }), fake: { plan: { 'FEATURE-001': [limited(), good('FEATURE-001')] } } });
  writeLocal(w, WAIT_ON);
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(sleeps(w), [30000]);
  assert.equal(w.queue().features[0].state, 'merged');
});

test('weekly and model limits stop and notify (injected notify records "stopped"); model with fallback_model passes --model to the next session', (t) => {
  for (const limit of ['weekly', 'model']) {
    const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [limited({ limit })] } } });
    const r = w.factory(['run']);
    assert.equal(r.code, 2, `${limit}: ${r.out}${r.err}`);
    assert.match(r.out, /^stopped: usage_limit$/m, limit);
    assert.deepEqual(lines(w, 'notify.log').map((l) => l.split(' ')[0]), ['stopped'], limit);
    assert.equal(w.queue().features[0].interrupted.kind, limit);
    assert.equal(attentionItems(w)[0].run, 'factory run --continue');
  }
  const m = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [limited({ limit: 'model' }), good('FEATURE-001')] } } });
  writeLocal(m, { fallback_model: 'claude-fallback' });
  const r = m.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  const runs = builderRuns(m, 'FEATURE-001');
  assert.equal(runs.length, 2);
  assert.ok(!runs[0].argv.includes('--model'));
  assert.equal(runs[1].argv[runs[1].argv.indexOf('--model') + 1], 'claude-fallback');
  assert.match(promptOf(runs[1]), CONTINUE);
  assert.deepEqual(m.queue().features[0].interruptions, [{ kind: 'model', step: 'build', minutes_waited: 0, method: 'continue_brief' }]);
});

test('model limit on the fallback model too: the run stops instead of switching again', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [limited({ limit: 'model' })] } } });
  writeLocal(w, { fallback_model: 'claude-fallback' });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: usage_limit$/m); assert.match(r.out, /fallback/);
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2);
  assert.equal(runs[1].argv[runs[1].argv.indexOf('--model') + 1], 'claude-fallback');
});

test('rate: three retries at 60, 120 and 240 s on the fake clock, then stops', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [limited({ limit: 'rate' })] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: usage_limit$/m); assert.match(r.out, /rate limit/);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 4);
  assert.deepEqual(w.queue().features[0].interruptions.map((i) => i.minutes_waited), [1, 2, 4]);
  assert.equal(sleeps(w).reduce((x, y) => x + y, 0), 420000);
});

test('timeout interrupt: the first two continue from the branch (counted in f.timeouts first); the third blocks the feature', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW, timeoutS: 1 }, fake: { plan: { 'FEATURE-001': [{ sleep_ms: 5000, status: 'none', files: { 'src/a.txt': 'a\n' } }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  const f = w.queue().features[0];
  assert.equal(f.state, 'blocked'); assert.equal(f.timeouts, 3);
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 3);
  assert.match(promptOf(runs[1]), CONTINUE); assert.match(promptOf(runs[2]), CONTINUE);
  assert.deepEqual(steps(r.out), ['build (build)', 'interrupt', 'build (build)', 'interrupt', 'build (build)', 'block']);
});

test('day cap with wait_for_reset: paused kind day_budget until the next local midnight on the fake clock, then the run resumes and merges', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: T(), fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  writeLocal(w, { wait_for_reset: true, budgets: { day_tokens: 10000 } });
  seedUsage(w.fhome, 'other__repo', 10000);
  const midnight = new Date(NOW); midnight.setHours(24, 0, 0, 0);
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`^paused: day_budget until ${iso(midnight.getTime()).replace(/\./g, '\\.')}$`, 'm'));
  assert.equal(sleeps(w).reduce((x, y) => x + y, 0), midnight.getTime() - NOW);
  assert.equal(w.queue().features[0].state, 'merged');
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1);
  assert.deepEqual(lines(w, 'notify.log').map((l) => l.split(' ')[0]), ['paused', 'finished']);
});

test('day cap stop (wait_for_reset off): attention row names factory run --continue; a restarted run loses no work (branch and edits survive)', (t) => {
  const AG = { files: { 'test/items.test.js': "it('lists', () => {});\n" }, commit: true };
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001', G2), tokens: 9655 }, AG] } } });
  writeLocal(w, { budgets: { day_tokens: 10000 } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: day_budget$/m);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1, 'the anti-gaming fix session was refused by the day cap');
  const f = w.queue().features[0];
  assert.equal(f.state, 'building'); assert.equal(f.interrupted, undefined);
  assert.ok(w.sh(w.builder, 'show', `${f.branch}:src/FEATURE-001.txt`).includes('good'), 'the work is on the branch');
  assert.deepEqual(attentionItems(w).map((i) => [i.kind, i.severity, i.run]), [['day_budget', 'high', 'factory run --continue']]);
  writeLocal(w, { budgets: { day_tokens: 1000000 } });
  const r2 = w.factory(['run']);
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.match(r2.out, /FEATURE-001 building -> built/);
  assert.equal(w.queue().features[0].state, 'merged');
  assert.equal(builderRuns(w, 'FEATURE-001').length, 2);
});

test('interrupted-resume loop cap: a driver that keeps dying while continuing an interrupted feature is held (resume_loop) after three resumes; f.resumes is not used', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [limited()] } } });
  assert.equal(w.factory(['run']).code, 2);
  assert.ok(w.queue().features[0].interrupted);
  const kill = { FACTORY_TEST: JSON.stringify({ now: NOW, killAfter: 'build' }) };
  for (let i = 0; i < 3; i++) assert.equal(w.factory(['run'], kill).signal, 'SIGKILL', `crash ${i + 1}`);
  let f = w.queue().features[0];
  assert.equal(f.interrupted_resumes, 3); assert.equal(f.resumes ?? 0, 0);
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /resume_loop/);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 4, 'no session after the cap');
  f = w.queue().features[0];
  assert.equal(f.state, 'building'); assert.equal(f.interrupted_resumes, 3);
});

test('factory scenarios: an author session hit by a session limit is restarted from scratch after the wait; a stop ends the command cleanly', (t) => {
  const w = world(t, { specs: { 'FEATURE-001': 'Items one' }, test: T(), fake: { author: { 'FEATURE-001': ['usage', AUTHOR_OK] } } });
  writeLocal(w, WAIT_ON);
  const r = w.factory(['scenarios']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^paused: usage_limit session until /m);
  assert.match(r.out, /FEATURE-001 scenarios: stored/);
  assert.equal(w.sessions().length, 2);
  assert.equal(runState(w).status, 'finished', 'scenarios ends the run state after its wait');
  assert.equal(readUsage(w.fhome).tokens, 930, 'the interrupted author session is recorded too');
  const s = world(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { author: { 'FEATURE-001': ['usage'] } } });
  const x = s.factory(['scenarios']);
  assert.equal(x.code, 2, x.out + x.err);
  assert.match(x.out, /^stopped: usage_limit$/m);
  assert.equal(fs.existsSync(path.join(s.fhome, 'runs', 'o__r.json')), false, 'scenarios writes only the run state of its own waits (Task 9)');
});

test('a failing WIP commit (.git/index.lock left behind) stops the run as wip_failed with interrupted set; the next run continues without a reset and the edits survive', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...limited(), files: { 'src/FEATURE-001.wip': 'half done\n' }, index_lock: true }, { ...good('FEATURE-001'), require_files: ['src/FEATURE-001.wip'] }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: wip_failed$/m);
  let f = w.queue().features[0];
  assert.equal(f.state, 'building');
  assert.equal(f.interrupted.kind, 'session'); assert.equal(f.interrupted.head, f.base_sha);
  assert.ok(fs.existsSync(path.join(w.builder, 'src', 'FEATURE-001.wip')), 'the edit is still in the builder clone');
  assert.deepEqual(attentionItems(w).map((i) => [i.id, i.kind, i.severity]), [['FEATURE-001', 'wip_failed', 'high']]);
  fs.rmSync(path.join(w.builder, '.git', 'index.lock'));
  const r2 = w.factory(['run']);
  assert.equal(r2.code, 0, r2.out + r2.err);
  f = w.queue().features[0];
  assert.equal(f.state, 'merged');
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2, 'no rebuild from scratch');
  assert.match(promptOf(runs[1]), CONTINUE);
  assert.ok(subjects(w, f.branch).includes('wip(FEATURE-001): interrupted (session)'));
});

test('wipCommit leaves no driver-owned path staged in the builder clone', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...limited(), files: { 'src/x.wip': 'x\n', '.skill-runs/r.jsonl': '{}\n' } }] } } });
  assert.equal(w.factory(['run']).code, 2);
  const f = w.queue().features[0];
  assert.deepEqual(w.sh(w.builder, 'show', '--name-only', '--format=', f.branch).split('\n'), ['src/x.wip']);
  assert.equal(w.sh(w.builder, 'diff', '--cached', '--name-only'), '', 'nothing left staged');
});
