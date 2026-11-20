// Runaway-guard budget check: a counter at or above its cap stops the run. Feature is checked before day.
export function checkBudget({ feature, caps, day, dayCap }) {
  for (const dim of ['tokens', 'turns']) {
    if (feature[dim] >= caps[dim]) return { ok: false, scope: 'feature', dim, used: feature[dim], cap: caps[dim] };
  }
  if (dayCap !== null && dayCap !== undefined && day.tokens >= dayCap) return { ok: false, scope: 'day', dim: 'tokens', used: day.tokens, cap: dayCap };
  return { ok: true };
}
