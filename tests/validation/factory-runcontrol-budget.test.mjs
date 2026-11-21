// factory phase 2 run control: daily usage store and runaway-guard budget checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpDir } from './helpers.mjs';

const L = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const u = await import(path.join(L, 'usage.mjs'));
const b = await import(path.join(L, 'budget.mjs'));
const e = (i, o, cc = 0, cr = 0, t = 1) => ({ in: i, out: o, cache_create: cc, cache_read: cr, turns: t });

test('localDay uses local time', () => {
  assert.equal(u.localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(u.localDay(new Date(2026, 0, 6, 0, 0)), '2026-01-06');
});
test('tokensOf excludes cache reads', () => {
  assert.equal(u.tokensOf(e(1, 2, 3, 1000)), 6);
});
test('addUsage accumulates; repos sum; new day starts at zero', () => {
  const home = tmpDir();
  const d1 = new Date(2026, 0, 5, 10);
  u.addUsage(home, 'a__b', d1, e(10, 5, 5, 99, 2));
  u.addUsage(home, 'a__b', d1, e(1, 1, 0, 0, 1));
  u.addUsage(home, 'c__d', d1, e(100, 0, 0, 0, 4));
  assert.deepEqual(u.dayUsage(home, d1), { tokens: 122, turns: 7 });
  assert.deepEqual(u.dayUsage(home, new Date(2026, 0, 6, 10)), { tokens: 0, turns: 0 });
  const dir = path.join(home, 'usage', '2026-01-05');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'a__b.json')).mode & 0o777, 0o600);
});
test('a corrupt or non-object usage file throws UsageError naming the file', () => {
  const home = tmpDir();
  const d = new Date(2026, 0, 5, 10);
  u.addUsage(home, 'a__b', d, e(1, 1));
  const f = path.join(home, 'usage', '2026-01-05', 'bad.json');
  for (const body of ['{not json', '[1]', '{"tokens":"x"}']) {
    fs.writeFileSync(f, body);
    assert.throws(() => u.dayUsage(home, d), (x) => x instanceof u.UsageError && x.message.includes('bad.json'));
    assert.throws(() => u.addUsage(home, 'bad', d, e(1, 1)), u.UsageError);
  }
});
test('a symlinked usage directory is refused', () => {
  const home = tmpDir();
  const other = tmpDir();
  fs.symlinkSync(other, path.join(home, 'usage'));
  assert.throws(() => u.addUsage(home, 'a__b', new Date(), e(1, 1)), u.UsageError);
});
test('featureUsage sums sessions and ignores malformed counts', () => {
  const f = { sessions: [e(10, 5, 5, 50, 3), { in: -4, out: 'x', cache_create: null, turns: -1 }, null, e(1, 0, 0, 0, 2)] };
  assert.deepEqual(u.featureUsage(f), { tokens: 21, turns: 5 });
  assert.deepEqual(u.featureUsage({}), { tokens: 0, turns: 0 });
});
test('checkBudget: below, at cap, turns, feature before day, null day cap', () => {
  const caps = { tokens: 100, turns: 10 };
  const day = { tokens: 0, turns: 0 };
  assert.deepEqual(b.checkBudget({ feature: { tokens: 99, turns: 9 }, caps, day, dayCap: null }), { ok: true });
  assert.deepEqual(b.checkBudget({ feature: { tokens: 100, turns: 1 }, caps, day, dayCap: null }), { ok: false, scope: 'feature', dim: 'tokens', used: 100, cap: 100 });
  assert.deepEqual(b.checkBudget({ feature: { tokens: 1, turns: 10 }, caps, day, dayCap: null }), { ok: false, scope: 'feature', dim: 'turns', used: 10, cap: 10 });
  assert.equal(b.checkBudget({ feature: { tokens: 200, turns: 1 }, caps, day: { tokens: 500, turns: 0 }, dayCap: 400 }).scope, 'feature');
  assert.deepEqual(b.checkBudget({ feature: { tokens: 1, turns: 1 }, caps, day: { tokens: 400, turns: 0 }, dayCap: 400 }), { ok: false, scope: 'day', dim: 'tokens', used: 400, cap: 400 });
  assert.deepEqual(b.checkBudget({ feature: { tokens: 1, turns: 1 }, caps, day: { tokens: 1e12, turns: 0 }, dayCap: null }), { ok: true });
});
