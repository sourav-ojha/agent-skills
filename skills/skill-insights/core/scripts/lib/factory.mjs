// Join factory run records (<project>/.skill-runs/factory-runs.jsonl) to transcript token turns. Pure; no I/O.
// A turn belongs to a record when it is from the same project hash and its timestamp is inside [ts_start, ts_end].
// A turn that falls inside several records' windows is counted in each and marks them all 'ambiguous'.

// Latest record per (run, feature): a feature can be written more than once (e.g. failed, then merged).
export function latestPerFeature(lines) {
  const by = new Map();
  for (const r of lines || []) if (r && r.kind === 'factory-run') by.set(`${r.run}\u0000${r.feature}`, r);
  return [...by.values()];
}

const win = (r) => [Date.parse(r.ts_start), Date.parse(r.ts_end)];
const num = (n) => (Number.isFinite(n) ? n : 0);
const total = (t) => num(t.tokens?.in) + num(t.tokens?.out) + num(t.tokens?.cache_create) + num(t.tokens?.cache_read);

export function joinTokens(records, turns) {
  const out = (records || []).map((r) => ({ ...r, tokens_in: 0, tokens_out: 0, cache_create: 0, cache_read: 0, turns: 0, ambiguous_turns: 0, ambiguous_tokens: 0, status: 'ok' }));
  const ws = out.map(win);
  for (const t of turns || []) {
    const hits = [];
    out.forEach((r, i) => { const [a, b] = ws[i]; if (r.project === t.project && t.ts >= a && t.ts <= b) hits.push(r); });
    for (const r of hits) {
      r.tokens_in += num(t.tokens?.in); r.tokens_out += num(t.tokens?.out);
      r.cache_create += num(t.tokens?.cache_create); r.cache_read += num(t.tokens?.cache_read);
      r.turns++;
      if (hits.length > 1) { r.status = 'ambiguous'; r.ambiguous_turns++; r.ambiguous_tokens += total(t); }
    }
  }
  return out;
}

// Coverage per run. Run window = [min ts_start, max ts_end] over the run's records. Of the turns inside it (same project as
// the run's records), what share (by tokens, and by turns) falls inside at least one feature window. Each turn counts once.
export function coverage(records, turns) {
  const runs = new Map();
  for (const r of records || []) { const a = runs.get(r.run) || []; a.push(r); runs.set(r.run, a); }
  const out = [];
  for (const [run, rs] of runs) {
    const ws = rs.map((r) => ({ project: r.project, w: win(r) })).filter((x) => x.w.every(Number.isFinite));
    if (!ws.length) continue;
    const lo = Math.min(...ws.map((x) => x.w[0])); const hi = Math.max(...ws.map((x) => x.w[1]));
    const projects = new Set(ws.map((x) => x.project));
    const c = { run, turns_total: 0, turns_attributed: 0, tokens_total: 0, tokens_attributed: 0 };
    for (const t of turns || []) {
      if (!projects.has(t.project) || t.ts < lo || t.ts > hi) continue;
      const n = total(t);
      c.turns_total++; c.tokens_total += n;
      if (ws.some((x) => x.project === t.project && t.ts >= x.w[0] && t.ts <= x.w[1])) { c.turns_attributed++; c.tokens_attributed += n; }
    }
    out.push({ ...c, ratio_tokens: c.tokens_total ? c.tokens_attributed / c.tokens_total : 1, ratio_turns: c.turns_total ? c.turns_attributed / c.turns_total : 1 });
  }
  return out;
}
