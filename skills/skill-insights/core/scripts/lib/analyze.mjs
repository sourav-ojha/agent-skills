// Attribute session activity to skill windows and summarise skill usage. Pure; no I/O.
const sum = (a, b) => ({ in: a.in + b.in, out: a.out + b.out, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const zero = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

// A window starts at a Skill invocation and ends at the next one (or session end). Entries before any skill are "(none)".
export function windows(session, { idleMs = 10 * 60_000 } = {}) {
  const out = [];
  let cur = null;
  let last = null;
  let seen = new Set(); // files read in this window and not edited since
  const open = (skill, inherited = false) => { cur = { skill, inherited, tokens: zero(), wallMs: 0, toolCalls: 0, toolErrors: 0, reads: [], repeatedReads: 0, fileReads: 0, repeatedFileReads: 0, largestResults: [] }; out.push(cur); last = null; seen = new Set(); };
  for (const e of session.entries) {
    if (e.skill) open(e.skill, !!e.inherited);
    else if (!cur) open('(none)');
    if (last !== null && e.ts >= last && e.ts - last <= idleMs) cur.wallMs += e.ts - last;
    last = e.ts;
    if (e.usage) cur.tokens = sum(cur.tokens, e.usage);
    if (e.tool || (e.skill && !e.inherited)) cur.toolCalls++;
    if (e.wroteAny) seen.clear();
    if (e.fileKey) {
      if (e.wrote) seen.delete(e.fileKey);
      else { cur.fileReads++; if (seen.has(e.fileKey)) cur.repeatedFileReads++; seen.add(e.fileKey); }
    }
    if (e.read) { cur.toolCalls++; if (cur.reads.includes(e.read.file)) cur.repeatedReads++; cur.reads.push(e.read.file); }
    if (e.error) cur.toolErrors++;
    if (e.bytes) cur.largestResults = [...cur.largestResults, e.bytes].sort((a, b) => b - a).slice(0, 3);
  }
  // Opened but never worked in: no model turn charged and nothing but the opening read. Typical when an agent reads several
  // SKILL.md files in a row to choose one. Such windows are reported apart from real runs.
  for (const w of out) w.surveyOnly = w.skill !== '(none)' && !w.inherited && w.tokens.in + w.tokens.out + w.tokens.cacheRead + w.tokens.cacheWrite === 0 && w.toolCalls <= 1;
  return out;
}

// sessions: [{ project, sessionId, date, entries }]. installed: skill names found on disk.
export function inventory(sessions, installed = []) {
  const m = new Map();
  const surveyed = new Map();
  for (const s of sessions) {
    for (const w of windows(s)) {
      if (w.skill === '(none)' || w.inherited) continue;
      if (w.surveyOnly) { surveyed.set(w.skill, (surveyed.get(w.skill) || 0) + 1); continue; }
      const r = m.get(w.skill) || { skill: w.skill, invocations: 0, sessionSet: new Set(), projectSet: new Set(), lastUsed: '' };
      r.invocations++; r.sessionSet.add(`${s.project}/${s.sessionId}`); r.projectSet.add(s.project);
      if (s.date > r.lastUsed) r.lastUsed = s.date;
      m.set(w.skill, r);
    }
  }
  const used = [...m.values()].map(({ sessionSet, projectSet, ...r }) => ({ ...r, sessions: sessionSet.size, projects: projectSet.size })).sort((a, b) => b.invocations - a.invocations);
  const seen = new Set(used.map((u) => u.skill).concat(used.map((u) => u.skill.split(':').pop())));
  return { used, unused: installed.filter((n) => !seen.has(n)), surveyOnly: [...surveyed.entries()].map(([skill, reads]) => ({ skill, reads })).sort((a, b) => b.reads - a.reads) };
}

// A resumed or forked session starts with a copy of its parent's transcript, so the same turns show up twice.
// Drop, within one project, any entry an earlier session already holds (same timestamp and content). The skill
// that was active at the fork point is kept as an inherited marker so the child's own work is not left unowned.
const sig = (e) => JSON.stringify([e.ts, e.skill, e.usage, e.tool, e.error, e.bytes, e.tid, e.fileKey, e.read && e.read.file]);
export function dedupeSessions(sessions) {
  const byProject = new Map();
  for (const s of sessions) { const a = byProject.get(s.project) || []; a.push(s); byProject.set(s.project, a); }
  const out = [];
  for (const group of byProject.values()) {
    group.sort((a, b) => (a.entries[0]?.ts ?? 0) - (b.entries[0]?.ts ?? 0) || a.entries.length - b.entries.length || String(a.sessionId).localeCompare(String(b.sessionId)));
    const seen = new Set();
    for (const s of group) {
      const keep = []; let skill = null; let dropped = 0;
      for (const e of s.entries) {
        if (seen.has(sig(e))) { dropped++; if (e.skill) skill = e.skill; continue; }
        keep.push(e);
      }
      for (const e of keep) seen.add(sig(e));
      if (!keep.length) continue;
      if (dropped && skill && !keep[0].skill) keep.unshift({ ts: keep[0].ts, skill, inherited: true });
      out.push({ ...s, entries: keep, dedupedEntries: dropped });
    }
  }
  return out;
}
