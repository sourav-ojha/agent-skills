// factory driver run control (Task 8a): local config refusal, usage recording, feature and day budgets.
// Unit tests of enforceBudget, then integration through the shared harness (factory-world.mjs: fake claude, fake gh, local origin).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCRIPTS, BASE_CONFIG, world, readiness, good, ready, builderRuns } from './factory-world.mjs';

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
