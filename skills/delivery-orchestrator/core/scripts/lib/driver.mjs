// Factory driver decision table: pure functions, no I/O. Implements the "Driver actions" table and the "Crash and resume" rules of
// docs/factory/specs/phase-1-verification-gate.md, as amended by phase-2-run-control.md P2.4 (interrupted is not crashed). The caller (factory.mjs) executes the returned action and feeds the step's
// result back in. The feature passed in is in the state the queue holds when the decision is made, i.e. after `deliver` (or the
// driver) applied the last step's own transition. Anything unknown (state, result, fact, limit) holds: fail closed.
import { TRANSITIONS, ACTIVE, overrideValid } from './queue.mjs';

export const ACTIONS = Object.freeze(['next', 'build', 'built', 'pr', 'ci', 'fix_ci', 'verify', 'verified', 'fix_verify', 'push', 'merge', 'block', 'hold', 'stop', 'interrupt']);
export const BRIEFS = Object.freeze(['build', 'local_fix', 'antigaming_fix', 'ci_fix', 'symptom_fix']);
// Every step result the driver understands, as { step, kind }. `error`: the deliver command died (exit 1) or the step failed.
export const RESULTS = Object.freeze({
  // stopped: the run's stop flag ended the session; budget: a runaway-guard cap ({ scope: 'feature' | 'day' }) ended or refused it.
  session: Object.freeze(['done', 'blocked', 'usage_limit', 'max_turns', 'timeout', 'no_result', 'other', 'settings_unsafe', 'spawn_failed', 'unsafe_binary', 'stopped', 'budget']),
  antigaming: Object.freeze(['fix']), // G2/G3 at built; G1/G4/G5 continue inside the built step (f.antigaming_hold), clean ones are not reported
  next: Object.freeze(['ok', 'error']),
  built: Object.freeze(['ok', 'local_check_failed', 'error']),
  pr: Object.freeze(['ok', 'error']),
  // stopped: `factory stop --now` ended the CI wait (the deliver ci child was killed); the feature stays in pr_open.
  ci: Object.freeze(['passed', 'unverified-allowed', 'failed', 'timeout', 'unconfirmed', 'error', 'stopped']),
  fix: Object.freeze(['ok', 'error']),
  push: Object.freeze(['ok', 'error']),
  verify: Object.freeze(['pass', 'fail', 'threw']),
  verified: Object.freeze(['ok', 'error']),
  merge: Object.freeze(['merged', 'stale', 'updated', 'held', 'blocked', 'error']),
  block: Object.freeze(['ok', 'error']),
});
export const AG_FIX_ATTEMPTS = 1; // P1.3: G2/G3 at built get one "builder fix attempt"
export const MAX_RESUMES = 3; // default cap on restarts of one feature (run.max_resumes overrides)
export const MAX_TIMEOUTS = 3; // a step whose session timed out this many times (f.timeouts) blocks instead of continuing
const BUDGET_SCOPES = new Set(['feature', 'day']);

const USAGE_KINDS = new Set(['session', 'weekly', 'model', 'rate']); // limits.mjs classifyFailure kinds
const SHA = /^[0-9a-f]{40}$/;
const G_ID = /^G[1-5]$/;
const own = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const knownState = (s) => typeof s === 'string' && Object.hasOwn(TRANSITIONS, s);
const isCount = (n) => Number.isInteger(n) && n >= 0;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const isoOrNull = (v) => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const cut = (s, n = 200) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const hold = (kind, reason, extra = {}) => ({ do: 'hold', kind, reason: cut(reason), ...extra, attention: true });
const stop = (kind, reason, extra = {}) => ({ do: 'stop', kind, reason: cut(reason), ...extra });
const block = (reason) => ({ do: 'block', reason: cut(reason), attention: true });
const next = (run) => (typeof run?.stop === 'string' && run.stop ? stop('run_stop', run.stop) : { do: 'next' });

// Can the driver's `hold` action park this state in awaiting_human? On a state that cannot (queued, built, ci_failed,
// verify_failed, and building/fixing) the caller writes the attention entry and stops the run, leaving the state.
// building and fixing have the edge only for a run-control budget hold, which is not a driver `hold` action.
const BUDGET_ONLY = new Set(['building', 'fixing']);
export const canHold = (state) => knownState(state) && !BUDGET_ONLY.has(state) && TRANSITIONS[state].includes('awaiting_human');

// The fix brief of a `fixing` feature, from the state it was in before its last "fixing" history entry.
export function fixKind(f) {
  const h = Array.isArray(f?.history) ? f.history : [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i]?.state !== 'fixing') continue;
    const prev = h[i - 1]?.state;
    // awaiting_human -> fixing is only deliver unhold (a released budget hold): the same fix step, so its kind is the kind of the
    // fixing entry the hold was taken from.
    if (prev === 'awaiting_human' && h[i - 2]?.state === 'fixing') continue;
    return prev === 'ci_failed' ? 'ci_fix' : prev === 'verify_failed' ? 'symptom_fix' : null;
  }
  return null;
}

// runSession() result + readBuilderResult() -> { step: 'session', kind, question?, keys?, limit?, resetAt? }.
// A usage limit keeps the classifier's kind as `limit` (session, weekly, model, rate) for routeInterruption (interrupt.mjs).
export function sessionResult(run, builder) {
  const r = { step: 'session' };
  if (!run || run.ok !== true) {
    const k = run?.failure?.kind;
    if (USAGE_KINDS.has(k)) return { ...r, kind: 'usage_limit', limit: k, resetAt: isoOrNull(run.failure.resetAt) };
    if (k === 'settings_unsafe') return { ...r, kind: k, keys: Array.isArray(run.failure.keys) ? [...run.failure.keys] : [] };
    return { ...r, kind: typeof k === 'string' && RESULTS.session.includes(k) && !['done', 'blocked', 'usage_limit', 'budget'].includes(k) ? k : 'other' };
  }
  if (builder?.status === 'done') return { ...r, kind: 'done' };
  return { ...r, kind: 'blocked', question: typeof builder?.question === 'string' && builder.question ? builder.question : 'no_result' };
}

const validResult = (last) => last === null || (own(last, 'step') && own(last, 'kind') && typeof last.step === 'string'
  && Object.hasOwn(RESULTS, last.step) && RESULTS[last.step].includes(last.kind));
const is = (last, step, ...kinds) => last !== null && last.step === step && kinds.includes(last.kind);

// The settings lint names user-settings keys; only their top-level category is repeated (no env names, no values).
function categories(keys) {
  const out = new Set();
  for (const k of Array.isArray(keys) ? keys : []) {
    const c = String(k).split(/[.\s(]/)[0].replace(/[^A-Za-z0-9_-]/g, '');
    if (c) out.add(c.slice(0, 32));
    if (out.size >= 6) break;
  }
  return [...out];
}

// Fix-round budget: null when the run's limit or the feature's counter is unknown (the caller holds).
function roundsLeft(f, run) {
  const max = run?.max_fix_rounds;
  if (!isCount(max) || !isCount(f.fix_rounds)) return null;
  return f.fix_rounds < max;
}
function fixOrBlock(f, run, what) {
  const left = roundsLeft(f, run);
  if (left === null) return hold('limits', 'fix-round limit or counter unknown: not starting a fix round');
  if (!left) return block(`${what} still failing after ${f.fix_rounds} fix round(s)`);
  return what === 'CI' ? { do: 'fix_ci', brief: 'ci_fix' } : { do: 'fix_verify', brief: 'symptom_fix' };
}

// Anti-gaming G1/G4/G5 fired at built: the PR is opened, then held at pr_open until a person overrides exactly that sha and those ids.
function agHold(f) {
  if (!own(f, 'antigaming_hold') || f.antigaming_hold === undefined || f.antigaming_hold === null) return null;
  const h = f.antigaming_hold;
  const ok = h && typeof h === 'object' && !Array.isArray(h) && typeof h.sha === 'string' && SHA.test(h.sha) && Array.isArray(h.ids) && h.ids.length > 0 && h.ids.every((x) => typeof x === 'string' && G_ID.test(x));
  if (!ok) return hold('antigaming', 'anti-gaming hold record is malformed: a person reviews the PR');
  if (overrideValid(f, h.sha, h.ids)) return null;
  const ids = [...new Set(h.ids)].sort();
  return hold('antigaming', `anti-gaming checks ${ids.join(', ')} fired at built: a person reviews the PR (deliver retry --note)`, { ids, sha: h.sha });
}
const ci = (f, extra = {}) => agHold(f) ?? { do: 'ci', ...extra };

// The interrupted-step record (f.interrupted, set by the driver or by `deliver unhold`): 'none' when absent, 'bad' when it is
// malformed or names a step that is not this state's (building <-> build, fixing <-> fix), else the step. An interrupted step is
// not a crash: it continues with the continue brief, uses no fix round and does not count toward the resume cap.
const STEP_OF = { building: 'build', fixing: 'fix' };
function interruptedStep(f) {
  if (!own(f, 'interrupted') || f.interrupted === undefined || f.interrupted === null) return 'none';
  const i = f.interrupted;
  if (typeof i !== 'object' || Array.isArray(i) || i.step !== STEP_OF[f.state]) return 'bad';
  return i.step;
}
const badInterrupted = (f) => hold('inconsistent', `the interrupted-step record does not fit a feature in "${f.state}"`);

// nextAction(feature, lastResult, run?) -> { do, reason?, kind?, brief?, ids?, sha?, resetAt?, attention? }
//   lastResult: null (nothing ran yet in this state) or { step, kind, ... } from RESULTS (see sessionResult for sessions).
//   run: { max_fix_rounds, stop } from the queue: max_fix_rounds is q.max_fix_rounds, stop is runStop(q) (stop flag or breaker).
function decide(f, lastResult, run) {
  if (!f || typeof f !== 'object' || !knownState(f.state)) return hold('unknown_state', `unknown feature state "${cut(f?.state ?? '', 40)}"`);
  if (!validResult(lastResult)) return hold('unknown_result', 'unknown step result');
  const last = lastResult;
  const st = f.state;

  // Interruptions and environment failures of any session, in any state. Phase 2 amends Phase 1's table: limit, budget, stop and
  // timeout go to interrupted handling (the caller's `interrupt` action keeps the work and decides wait/retry/stop); a session that
  // ended without a result (other, no_result) still stops the run, never waits.
  if (last?.step === 'session') {
    if (last.kind === 'usage_limit') {
      if (!USAGE_KINDS.has(last.limit)) return hold('unknown_result', 'a usage limit of an unknown kind');
      return { do: 'interrupt', kind: 'usage_limit', limit: last.limit, resetAt: isoOrNull(last.resetAt) };
    }
    if (last.kind === 'timeout') {
      const n = f.timeouts ?? 0;
      if (!isCount(n)) return hold('limits', 'session timeout counter unknown');
      if (n >= MAX_TIMEOUTS) return block(`the session timed out ${n} times`);
      return { do: 'interrupt', kind: 'timeout' };
    }
    if (last.kind === 'stopped') return { do: 'interrupt', kind: 'stop' };
    if (last.kind === 'budget') {
      if (!BUDGET_SCOPES.has(last.scope)) return hold('unknown_result', 'a budget result of an unknown scope');
      return { do: 'interrupt', kind: 'budget', scope: last.scope };
    }
    // The driver kept its work (WIP commit, f.interrupted) before deciding: the run stops without waiting, the next run continues.
    if (['no_result', 'other'].includes(last.kind)) return stop('interrupted', 'the session ended without a result: its work is kept on the branch and the run stops');
    if (last.kind === 'settings_unsafe') return hold('settings_unsafe', `user Claude settings are unsafe for unattended sessions (${categories(last.keys).join(', ') || 'unknown'}): fix them, then run again`);
    if (last.kind === 'spawn_failed' || last.kind === 'unsafe_binary') return hold('environment', last.kind === 'spawn_failed' ? 'the claude binary could not be started' : 'the claude binary resolves inside the session working directory');
    if (st !== 'building' && st !== 'fixing') return hold('inconsistent', `a builder session result for a feature in "${st}"`);
  }
  // A stopped CI wait (stop --now) is an interruption too: the run stops and the feature continues from CI next time.
  if (last?.step === 'ci' && last.kind === 'stopped') return { do: 'interrupt', kind: 'stop' };
  if (last && last.kind === 'error') return hold('error', `the ${last.step} step failed: a person looks at it`);

  switch (st) {
    case 'queued':
      return last === null ? next(run) : hold('inconsistent', `a ${last.step} result for a queued feature`);

    case 'building': {
      const ist = interruptedStep(f);
      if (ist === 'bad') return badInterrupted(f);
      if (last === null && ist !== 'none') return { do: 'build', brief: 'build', continue: true };
      if (last === null || is(last, 'next', 'ok')) return { do: 'build', brief: 'build' };
      if (is(last, 'session', 'done')) return { do: 'built' };
      if (is(last, 'session', 'blocked')) return block(`builder blocked: ${last.question || 'no_question'}`);
      if (is(last, 'session', 'max_turns')) return block('builder blocked: no_result (max turns)');
      if (is(last, 'antigaming', 'fix')) {
        const n = f.ag_fix_attempts ?? 0;
        if (!isCount(n)) return hold('limits', 'anti-gaming fix attempt counter unknown');
        const ids = Array.isArray(last.ids) ? [...new Set(last.ids.filter((x) => typeof x === 'string' && G_ID.test(x)))].sort() : [];
        if (n >= AG_FIX_ATTEMPTS) return block(`anti-gaming checks ${ids.join(', ') || 'G2/G3'} still fire after a builder fix attempt`);
        return { do: 'build', brief: 'antigaming_fix', ids };
      }
      if (is(last, 'built', 'local_check_failed')) {
        const max = run?.max_fix_rounds; const n = f.local_attempts ?? 0;
        if (!isCount(max) || !isCount(n)) return hold('limits', 'local-check attempt limit or counter unknown');
        if (n > max + 1) return block(`local checks still failing after ${n} attempts`);
        return { do: 'build', brief: 'local_fix' };
      }
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a building feature`);
    }

    case 'built':
      if (last === null || is(last, 'built', 'ok')) return { do: 'pr' };
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a built feature`);

    case 'pr_open':
      if (last === null || is(last, 'pr', 'ok') || is(last, 'push', 'ok') || is(last, 'merge', 'stale', 'updated')) return ci(f);
      if (is(last, 'ci', 'timeout')) return ci(f, { reason: 'CI still running: wait again within the CI budget' });
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a feature in pr_open`);

    case 'ci_failed':
      if (last === null || is(last, 'ci', 'failed')) return fixOrBlock(f, run, 'CI');
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a feature in ci_failed`);

    case 'fixing': {
      const brief = fixKind(f);
      if (!brief) return hold('inconsistent', 'fixing, but the history does not say whether CI or verification failed');
      const ist = interruptedStep(f);
      if (ist === 'bad') return badInterrupted(f);
      if (last === null && ist !== 'none') return { do: 'build', brief, continue: true };
      if (last === null || is(last, 'fix', 'ok')) return { do: 'build', brief };
      if (is(last, 'session', 'done')) return { do: 'push' };
      if (is(last, 'session', 'blocked')) return block(`builder blocked: ${last.question || 'no_question'}`);
      if (is(last, 'session', 'max_turns')) return block('builder blocked: no_result (max turns)');
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a fixing feature`);
    }

    case 'ci_passed':
      if (last === null || is(last, 'ci', 'passed', 'unverified-allowed')) return { do: 'verify' };
      if (is(last, 'verify', 'pass')) return { do: 'verified' };
      if (is(last, 'verify', 'fail')) return fixOrBlock(f, run, 'verification');
      if (is(last, 'verify', 'threw')) return hold('verification', 'verification could not run to a verdict (busy port, app did not exit, escaped process or unsupported scenario): no fix round used');
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a feature in ci_passed`);

    case 'verify_failed':
      if (last === null || is(last, 'verify', 'fail')) return fixOrBlock(f, run, 'verification');
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a feature in verify_failed`);

    case 'verified':
      // Only straight after posting the status: with no result (a restart or a fresh pick) the verdict must be re-checked
      // against the PR head first, which is resumeAction's rule.
      if (is(last, 'verified', 'ok')) return { do: 'merge' };
      if (last === null) return hold('inconsistent', 'verified with no step result: resume through the restart rules (verdict re-checked against the PR head)');
      return hold('inconsistent', `a ${last.step} ${last.kind} result for a verified feature`);

    case 'awaiting_human':
      if (is(last, 'ci', 'unconfirmed')) return stop('ci_unconfirmed', typeof run?.stop === 'string' && run.stop ? run.stop : 'CI is unconfirmed: no required check reported', { attention: true });
      if (is(last, 'merge', 'held')) return hold(typeof f.hold_kind === 'string' && f.hold_kind ? cut(f.hold_kind, 32) : 'merge', f.reason ? `merge held: ${f.reason}` : 'merge held for a person');
      return next(run);

    default: // blocked, skipped, merged: nothing more for this feature
      return next(run);
  }
}

// Facts the caller gathers on restart (all optional; one a rule needs and that is missing or malformed holds):
//   branch_exists: bool, ahead: commits of the feature branch ahead of origin/<base>, dirty: bool (clone working tree),
//   head: 40-hex sha of the local feature branch, result: 'done' | 'blocked' | 'absent' (readBuilderResult; absent = no file),
//   pr_exists: bool, pr_head: 40-hex sha GitHub reports for the PR head,
//   verdict: 'pass' | 'fail' | 'absent' | 'mismatch' (stored verdict for pr_head checked against the current hashes),
//   orphans_alive: process groups from the old lock still alive after killOrphans, leftover_worktrees: evaluation worktrees left,
//   resumes: how many times this feature was already resumed after a crash. These last three are REQUIRED for every state.
// A building or fixing feature with f.interrupted ended its step knowingly (limit, budget, stop, timeout): it is not a crash, so
// the resume cap does not apply and the step continues from the branch (continue: true) instead of a reset rebuild.
const FACT_TYPES = {
  branch_exists: (v) => typeof v === 'boolean', dirty: (v) => typeof v === 'boolean', pr_exists: (v) => typeof v === 'boolean',
  ahead: isCount, orphans_alive: isCount, leftover_worktrees: isCount, resumes: isCount,
  head: (v) => v === null || (typeof v === 'string' && SHA.test(v)), pr_head: (v) => v === null || (typeof v === 'string' && SHA.test(v)),
  result: (v) => ['done', 'blocked', 'absent'].includes(v), verdict: (v) => ['pass', 'fail', 'absent', 'mismatch'].includes(v),
};
const need = (facts, ...keys) => keys.every((k) => own(facts, k) && FACT_TYPES[k](facts[k]));

// resumeAction(feature, facts, run?) -> same shape as nextAction; adds `reset: true` (reset the branch to base first),
// `reopen: true` (ci_passed/verified -> pr_open first, then CI and verification again) and `continue: true` (interrupted step).
function resume(f, facts, run) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return hold('unknown_result', 'no restart facts');
  if (!f || typeof f !== 'object' || !knownState(f.state)) return hold('unknown_state', `unknown feature state "${cut(f?.state ?? '', 40)}"`);
  for (const k of Object.keys(FACT_TYPES)) if (own(facts, k) && facts[k] !== undefined && !FACT_TYPES[k](facts[k])) return hold('unknown_result', `restart fact ${k} is malformed`);
  // Leftovers from the lock first: nothing resumes while a process or worktree from the dead run may still act.
  if (!need(facts, 'orphans_alive', 'leftover_worktrees', 'resumes')) return hold('unknown_result', 'restart facts orphans_alive, leftover_worktrees and resumes are required');
  const maxResumes = run?.max_resumes === undefined ? MAX_RESUMES : run.max_resumes;
  if (!isCount(maxResumes)) return hold('limits', 'resume limit unknown');
  if (facts.orphans_alive > 0 || facts.leftover_worktrees > 0) return stop('leftovers', 'process groups or evaluation worktrees from the earlier run are still present: remove them first', { attention: true });

  const ist = Object.hasOwn(STEP_OF, f.state) ? interruptedStep(f) : 'none';
  if (ist === 'bad') return badInterrupted(f);
  // A feature that keeps crashing the driver is not resumed forever (an interrupted step is not a crash).
  if (ACTIVE.includes(f.state) && ist === 'none' && facts.resumes >= maxResumes) return hold('resume_loop', `resumed ${facts.resumes} times already: a person looks at it`);

  switch (f.state) {
    case 'building':
      if (!need(facts, 'branch_exists', 'result', 'dirty')) return hold('unknown_result', 'restart facts for building are missing');
      if (facts.branch_exists && need(facts, 'ahead') && facts.ahead >= 1 && facts.result === 'done' && !facts.dirty) return { do: 'built' };
      if (facts.branch_exists && !need(facts, 'ahead')) return hold('unknown_result', 'restart fact ahead is missing');
      if (facts.result === 'blocked') return block('builder blocked (result found after a restart)'); // the "builder blocked" row
      // Interrupted: keep the branch (WIP commit included) and continue; with no branch left there is nothing to continue from.
      if (ist !== 'none' && facts.branch_exists) return { do: 'build', brief: 'build', continue: true };
      return { do: 'build', brief: 'build', reset: true };

    case 'built':
      if (!need(facts, 'branch_exists', 'head') || !facts.branch_exists || !facts.head) return hold('unknown_result', 'the feature branch cannot be found');
      if (facts.head !== f.built_sha) return hold('inconsistent', 'the branch has commits after built was recorded');
      return { do: 'pr' };

    case 'pr_open':
      if (!need(facts, 'pr_exists') || !facts.pr_exists) return hold('inconsistent', 'the pull request cannot be found');
      return ci(f);

    case 'fixing': {
      const brief = fixKind(f);
      if (!brief) return hold('inconsistent', 'fixing, but the history does not say whether CI or verification failed');
      if (!need(facts, 'branch_exists', 'head', 'dirty') || !facts.branch_exists || !facts.head) return hold('unknown_result', 'the feature branch cannot be found');
      const ciHead = f.pr?.head_sha;
      if (typeof ciHead !== 'string' || !SHA.test(ciHead)) return hold('inconsistent', 'the head of the last CI run is not recorded');
      // A moved head is pushed only when the fix session finished (result done): a crash mid-session leaves partial commits.
      if (facts.head !== ciHead && !facts.dirty && facts.result === 'done') return { do: 'push' };
      return ist !== 'none' ? { do: 'build', brief, continue: true } : { do: 'build', brief };
    }

    case 'ci_passed':
    case 'verified': {
      if (!need(facts, 'pr_exists', 'pr_head', 'verdict') || !facts.pr_exists || !facts.pr_head) return hold('unknown_result', 'the pull request head or the stored verdict cannot be checked');
      if (typeof f.ci_sha !== 'string' || !SHA.test(f.ci_sha)) return hold('inconsistent', 'the commit CI passed on is not recorded');
      if (facts.pr_head !== f.ci_sha) return agHold(f) ?? { do: 'ci', reopen: true, reason: 'the PR head moved after CI passed: CI and verification again' };
      if (f.state === 'verified') return facts.verdict === 'pass' ? { do: 'merge' } : agHold(f) ?? { do: 'ci', reopen: true, reason: 'the stored verdict is absent or does not match: CI and verification again' };
      if (facts.verdict === 'pass') return { do: 'verified' };
      if (facts.verdict === 'fail') return fixOrBlock(f, run, 'verification');
      return { do: 'verify' };
    }

    default: // queued, ci_failed, verify_failed, awaiting_human, blocked, skipped, merged: as from a fresh start
      return decide(f, null, run);
  }
}

// Returned actions are frozen (their arrays too): the caller cannot change a decision after the fact.
const frozen = (a) => { for (const v of Object.values(a)) if (Array.isArray(v)) Object.freeze(v); return Object.freeze(a); };
export const nextAction = (f, lastResult = null, run = {}) => frozen({ ...decide(f, lastResult, run) });
export const resumeAction = (f, facts, run = {}) => frozen({ ...resume(f, facts, run) });
