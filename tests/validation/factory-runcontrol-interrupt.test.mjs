// factory phase 2 run control: interruption routing (limit kinds, waiting, rate retries) and the driver's interrupt decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO } from './helpers.mjs';

const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const I = await import(pathToFileURL(path.join(LIB, 'interrupt.mjs')).href);
const D = await import(pathToFileURL(path.join(LIB, 'driver.mjs')).href);

const H = 3600000;
const NOW = Date.parse('2026-11-21T10:00:00.000Z');
const LOCAL = { wait_for_reset: true, max_wait_h: 6, max_wait_weekly_h: 0, keep_awake: true, fallback_model: null, budgets: { day_tokens: null } };
const local = (over = {}) => ({ ...LOCAL, ...over });
const iso = (ms) => new Date(ms).toISOString();

test('routeInterruption: RATE_RETRY_S is 1, 2 and 4 minutes', () => {
  assert.deepEqual([...I.RATE_RETRY_S], [60, 120, 240]);
});

test('routeInterruption: session with wait_for_reset off stops', () => {
  const r = I.routeInterruption({ limit: 'session', resetAt: iso(NOW + H), nowMs: NOW, local: local({ wait_for_reset: false }) });
  assert.equal(r.do, 'stop'); assert.match(r.reason, /wait_for_reset/);
});

test('routeInterruption: session first wait ends at resetAt plus 2 minutes, not estimated', () => {
  const r = I.routeInterruption({ limit: 'session', resetAt: iso(NOW + H), nowMs: NOW, local: local() });
  assert.deepEqual(r, { do: 'wait', untilMs: NOW + H + 120000, estimated: false });
});

test('routeInterruption: session with no or a malformed resetAt waits now plus 5 hours, estimated', () => {
  for (const resetAt of [null, undefined, 'tomorrow', 5]) {
    const r = I.routeInterruption({ limit: 'session', resetAt, nowMs: NOW, local: local() });
    assert.deepEqual(r, { do: 'wait', untilMs: NOW + 5 * H, estimated: true }, String(resetAt));
  }
});

test('routeInterruption: a later session wait (waitedMs > 0) lasts 10 minutes', () => {
  const r = I.routeInterruption({ limit: 'session', resetAt: iso(NOW + H), nowMs: NOW, local: local(), waitedMs: 60000 });
  assert.deepEqual(r, { do: 'wait', untilMs: NOW + 600000, estimated: false });
});

test('routeInterruption: session stops when the total wait would exceed max_wait_h', () => {
  const first = I.routeInterruption({ limit: 'session', resetAt: iso(NOW + 2 * H), nowMs: NOW, local: local({ max_wait_h: 1 }) });
  assert.equal(first.do, 'stop'); assert.match(first.reason, /max_wait_h/);
  const later = I.routeInterruption({ limit: 'session', resetAt: null, nowMs: NOW, local: local({ max_wait_h: 1 }), waitedMs: H - 300000 });
  assert.equal(later.do, 'stop', 'waited 55 min + 10 min > 1 h');
  const fits = I.routeInterruption({ limit: 'session', resetAt: null, nowMs: NOW, local: local({ max_wait_h: 1 }), waitedMs: H - 600000 });
  assert.equal(fits.do, 'wait', 'exactly max_wait_h still fits');
  assert.equal(I.routeInterruption({ limit: 'session', resetAt: null, nowMs: NOW, local: local() }).do, 'wait', '5 h estimate fits the 6 h default');
});

test('routeInterruption: weekly stops by default; waits when max_wait_weekly_h covers the reset', () => {
  const def = I.routeInterruption({ limit: 'weekly', resetAt: iso(NOW + 10 * H), nowMs: NOW, local: local() });
  assert.equal(def.do, 'stop'); assert.match(def.reason, /weekly/);
  const w = I.routeInterruption({ limit: 'weekly', resetAt: iso(NOW + 10 * H), nowMs: NOW, local: local({ max_wait_weekly_h: 24 }) });
  assert.deepEqual(w, { do: 'wait', untilMs: NOW + 10 * H + 120000, estimated: false });
  assert.equal(I.routeInterruption({ limit: 'weekly', resetAt: iso(NOW + 30 * H), nowMs: NOW, local: local({ max_wait_weekly_h: 24 }) }).do, 'stop', 'beyond max_wait_weekly_h');
});

test('routeInterruption: model switches to fallback_model when set, else stops', () => {
  assert.deepEqual(I.routeInterruption({ limit: 'model', resetAt: null, nowMs: NOW, local: local({ fallback_model: 'claude-sonnet' }) }), { do: 'switch_model', model: 'claude-sonnet' });
  const s = I.routeInterruption({ limit: 'model', resetAt: null, nowMs: NOW, local: local() });
  assert.equal(s.do, 'stop'); assert.match(s.reason, /fallback_model/);
});

test('routeInterruption: rate retries after 60, 120 and 240 s, then stops as "other"', () => {
  for (const [rateAttempt, afterS] of [[0, 60], [1, 120], [2, 240]])
    assert.deepEqual(I.routeInterruption({ limit: 'rate', resetAt: null, nowMs: NOW, local: local(), rateAttempt }), { do: 'retry', afterS }, String(rateAttempt));
  const s = I.routeInterruption({ limit: 'rate', resetAt: null, nowMs: NOW, local: local(), rateAttempt: 3 });
  assert.equal(s.do, 'stop'); assert.match(s.reason, /other/);
});

test('routeInterruption: unknown limit, missing local config or bad numbers stop (fail closed)', () => {
  assert.equal(I.routeInterruption({ limit: 'zzz', resetAt: null, nowMs: NOW, local: local() }).do, 'stop');
  assert.equal(I.routeInterruption({ limit: 'session', resetAt: null, nowMs: NOW, local: null }).do, 'stop');
  assert.equal(I.routeInterruption({ limit: 'session', resetAt: null, nowMs: NaN, local: local() }).do, 'stop');
  assert.equal(I.routeInterruption({ limit: 'session', resetAt: null, nowMs: NOW, local: local(), waitedMs: -1 }).do, 'stop');
  assert.equal(I.routeInterruption({ limit: 'rate', resetAt: null, nowMs: NOW, local: local(), rateAttempt: 1.5 }).do, 'stop');
});

// Driver: Phase 2 amends Phase 1's table: limit, budget, stop and timeout go to interrupted handling.
const RUN = { max_fix_rounds: 2, stop: null };
const hist = (...states) => states.map((state) => ({ ts: '2026-11-20T00:00:00.000Z', state }));
const feat = (state, over = {}) => ({ id: 'FEATURE-001', state, fix_rounds: 0, history: hist(state), ...over });
const S = (kind, extra = {}) => ({ step: 'session', kind, ...extra });
const SHA_A = 'a'.repeat(40);
const FACTS = { branch_exists: true, ahead: 2, dirty: false, head: SHA_A, result: 'absent', pr_exists: true, pr_head: SHA_A, verdict: 'pass', orphans_alive: 0, leftover_worktrees: 0, resumes: 0 };
const INT = (step) => ({ kind: 'session', step, session_id: 's1', head: SHA_A, ts: '2026-11-21T10:00:00.000Z' });

test('driver: ACTIONS has interrupt; RESULTS.session has stopped and budget', () => {
  assert.ok(D.ACTIONS.includes('interrupt'));
  assert.ok(D.RESULTS.session.includes('stopped')); assert.ok(D.RESULTS.session.includes('budget'));
});

test('driver: sessionResult keeps the limit kind', () => {
  const at = '2026-11-20T15:00:00.000Z';
  for (const k of ['session', 'weekly', 'model', 'rate'])
    assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: k, resetAt: at } }), { step: 'session', kind: 'usage_limit', limit: k, resetAt: at }, k);
});

test('driver: a usage_limit result interrupts and carries limit and resetAt', () => {
  const at = '2026-11-20T15:00:00.000Z';
  for (const st of ['building', 'fixing', 'ci_passed']) {
    const a = D.nextAction(feat(st, { history: hist('ci_failed', st) }), S('usage_limit', { limit: 'weekly', resetAt: at }), RUN);
    assert.deepEqual(a, { do: 'interrupt', kind: 'usage_limit', limit: 'weekly', resetAt: at }, st);
  }
  assert.equal(D.nextAction(feat('building'), S('usage_limit', { limit: 'session', resetAt: 'nope' }), RUN).resetAt, null);
  for (const limit of [undefined, 'zzz', 5]) assert.equal(D.nextAction(feat('building'), S('usage_limit', { limit }), RUN).do, 'hold', `unknown limit ${limit}`);
});

test('driver: timeout interrupts while f.timeouts < 3; the third blocks', () => {
  for (const timeouts of [undefined, 0, 1, 2]) assert.deepEqual(D.nextAction(feat('building', { timeouts }), S('timeout'), RUN), { do: 'interrupt', kind: 'timeout' }, String(timeouts));
  const b = D.nextAction(feat('building', { timeouts: 3 }), S('timeout'), RUN);
  assert.equal(b.do, 'block'); assert.match(b.reason, /timed out 3 times/);
  for (const timeouts of [-1, '1', 1.5]) assert.equal(D.nextAction(feat('building', { timeouts }), S('timeout'), RUN).do, 'hold', String(timeouts));
});

test('driver: stopped and budget session results interrupt; no_result and other still stop', () => {
  assert.deepEqual(D.nextAction(feat('building'), S('stopped'), RUN), { do: 'interrupt', kind: 'stop' });
  for (const scope of ['feature', 'day']) assert.deepEqual(D.nextAction(feat('building'), S('budget', { scope }), RUN), { do: 'interrupt', kind: 'budget', scope });
  assert.equal(D.nextAction(feat('building'), S('budget', { scope: 'zzz' }), RUN).do, 'hold', 'unknown budget scope');
  for (const k of ['no_result', 'other']) {
    const a = D.nextAction(feat('building'), S(k), RUN);
    assert.equal(a.do, 'stop', k); assert.equal(a.kind, 'interrupted', k);
  }
});

test('driver: building or fixing with f.interrupted and no result continues the step with the continue brief', () => {
  assert.deepEqual(D.nextAction(feat('building', { interrupted: INT('build') }), null, RUN), { do: 'build', brief: 'build', continue: true });
  const fx = feat('fixing', { history: hist('pr_open', 'ci_failed', 'fixing'), interrupted: INT('fix') });
  assert.deepEqual(D.nextAction(fx, null, RUN), { do: 'build', brief: 'ci_fix', continue: true });
  const sx = feat('fixing', { history: hist('ci_passed', 'verify_failed', 'fixing'), interrupted: { kind: 'budget', step: 'fix', ts: '2026-11-21T10:00:00.000Z' } });
  assert.deepEqual(D.nextAction(sx, null, RUN), { do: 'build', brief: 'symptom_fix', continue: true });
  assert.deepEqual(D.nextAction(feat('building'), null, RUN), { do: 'build', brief: 'build' }, 'no interruption: a normal build');
  assert.deepEqual(D.nextAction(feat('building', { interrupted: null }), null, RUN), { do: 'build', brief: 'build' });
  assert.equal(D.nextAction(feat('building', { interrupted: INT('fix') }), null, RUN).do, 'hold', 'step does not match the state');
  assert.equal(D.nextAction(feat('building', { interrupted: 'yes' }), null, RUN).do, 'hold', 'malformed record');
});

test('driver: resumeAction for an interrupted building feature continues without a reset; the resume cap does not apply', () => {
  const f = feat('building', { interrupted: INT('build') });
  assert.deepEqual(D.resumeAction(f, { ...FACTS, dirty: true }, RUN), { do: 'build', brief: 'build', continue: true });
  assert.deepEqual(D.resumeAction(f, { ...FACTS, result: 'done' }, RUN), { do: 'built' }, 'done + ahead + clean still goes to built');
  assert.deepEqual(D.resumeAction(f, { ...FACTS, dirty: true, resumes: 99 }, RUN), { do: 'build', brief: 'build', continue: true }, 'not held as resume_loop');
  assert.equal(D.resumeAction(feat('building'), { ...FACTS, resumes: 99 }, RUN).kind, 'resume_loop', 'a crashed feature is still capped');
  assert.deepEqual(D.resumeAction(feat('building'), { ...FACTS, dirty: true }, RUN), { do: 'build', brief: 'build', reset: true }, 'no interruption: the crash rule');
});

test('driver: resumeAction for an interrupted fixing feature continues with the fix brief', () => {
  const f = feat('fixing', { history: hist('pr_open', 'ci_failed', 'fixing'), pr: { head_sha: SHA_A }, interrupted: INT('fix') });
  assert.deepEqual(D.resumeAction(f, { ...FACTS, dirty: true, resumes: 99 }, RUN), { do: 'build', brief: 'ci_fix', continue: true });
});
