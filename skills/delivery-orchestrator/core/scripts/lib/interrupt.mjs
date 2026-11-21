// Interruption routing for usage limits (docs/factory/specs/phase-2-run-control.md, P2.4): pure, no I/O, no clock of its own.
// The caller (factory.mjs) passes the limit kind from the classifier, the reset time, the current time, the parsed local config
// (localconfig.mjs) and how long it already waited for this step. Anything unknown stops: fail closed.
export const RATE_RETRY_S = Object.freeze([60, 120, 240]); // `rate`: retry after 1, 2 and 4 minutes, then treat as `other`

const H = 3600000;
const AFTER_RESET_MS = 120000; // the first retry is at reset_at plus 2 minutes
const LATER_WAIT_MS = 600000; // a limit hit again: wait 10 minutes and retry
const ESTIMATE_MS = 5 * H; // reset time unknown: now plus 5 hours, marked estimated
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const stop = (reason) => ({ do: 'stop', reason });
const resetMs = (v) => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
const okNum = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

// One wait for `session` or `weekly`, bounded by maxH hours in total.
function wait(resetAt, nowMs, waitedMs, maxH, what) {
  let untilMs; let estimated = false;
  if (waitedMs > 0) untilMs = nowMs + LATER_WAIT_MS;
  else {
    const r = resetMs(resetAt);
    if (r === null) { untilMs = nowMs + ESTIMATE_MS; estimated = true; } else untilMs = Math.max(nowMs, r + AFTER_RESET_MS);
  }
  if (waitedMs + (untilMs - nowMs) > maxH * H) return stop(`${what} limit: the wait would pass ${what === 'weekly' ? 'max_wait_weekly_h' : 'max_wait_h'} (${maxH} h)`);
  return { do: 'wait', untilMs, estimated };
}

// routeInterruption({ limit, resetAt, nowMs, local, waitedMs, rateAttempt }) ->
//   { do: 'wait', untilMs, estimated } | { do: 'retry', afterS } | { do: 'switch_model', model } | { do: 'stop', reason }
export function routeInterruption({ limit, resetAt, nowMs, local, waitedMs = 0, rateAttempt = 0 } = {}) {
  if (!local || typeof local !== 'object') return stop('local run-control config unknown');
  if (!okNum(nowMs) || !okNum(waitedMs)) return stop('wait clock unknown');
  switch (limit) {
    case 'session':
      if (local.wait_for_reset !== true) return stop('session limit: wait_for_reset is off');
      if (!okNum(local.max_wait_h)) return stop('session limit: max_wait_h unknown');
      return wait(resetAt, nowMs, waitedMs, local.max_wait_h, 'session');
    case 'weekly': // needs wait_for_reset too, so the classifier gate (fixtures only: no waiting) covers weekly waits as well
      if (local.wait_for_reset !== true) return stop('weekly limit: wait_for_reset is off');
      if (!okNum(local.max_wait_weekly_h) || !(local.max_wait_weekly_h > 0)) return stop('weekly limit: waiting is off (max_wait_weekly_h is 0)');
      return wait(resetAt, nowMs, waitedMs, local.max_wait_weekly_h, 'weekly');
    case 'model':
      if (typeof local.fallback_model === 'string' && local.fallback_model) return { do: 'switch_model', model: local.fallback_model };
      return stop('model limit: no fallback_model configured');
    case 'rate':
      if (!Number.isInteger(rateAttempt) || rateAttempt < 0) return stop('rate limit: retry counter unknown');
      if (rateAttempt < RATE_RETRY_S.length) return { do: 'retry', afterS: RATE_RETRY_S[rateAttempt] };
      return stop(`rate limit: still throttled after ${RATE_RETRY_S.length} retries: treated as other`);
    default:
      return stop('unknown usage-limit kind');
  }
}
