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

export function joinTokens(records, turns) {
  const out = (records || []).map((r) => ({ ...r, tokens_in: 0, tokens_out: 0, cache_create: 0, cache_read: 0, turns: 0, status: 'ok' }));
  const ws = out.map(win);
  for (const t of turns || []) {
    const hits = [];
    out.forEach((r, i) => { const [a, b] = ws[i]; if (r.project === t.project && t.ts >= a && t.ts <= b) hits.push(r); });
    for (const r of hits) {
      r.tokens_in += num(t.tokens?.in); r.tokens_out += num(t.tokens?.out);
      r.cache_create += num(t.tokens?.cache_create); r.cache_read += num(t.tokens?.cache_read);
      r.turns++;
      if (hits.length > 1) r.status = 'ambiguous';
    }
  }
  return out;
}

// Share of turns (from projects that have records) that fall inside at least one record window.
export function coverage(records, turns) {
  const projects = new Set((records || []).map((r) => r.project));
  const rs = (records || []).map((r) => ({ project: r.project, w: win(r) }));
  let total = 0; let attributed = 0;
  for (const t of turns || []) {
    if (!projects.has(t.project)) continue;
    total++;
    if (rs.some((r) => r.project === t.project && t.ts >= r.w[0] && t.ts <= r.w[1])) attributed++;
  }
  return { total, attributed, ratio: total ? attributed / total : 1 };
}
