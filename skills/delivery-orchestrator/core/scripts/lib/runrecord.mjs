// Factory run records: one metadata-only JSON line per feature outcome, in <project>/.skill-runs/factory-runs.jsonl.
// No prompts, code, paths or command output. Records carry kind "factory-run" and no "event" key, so skill-insights'
// skill-event export ignores them. The no-follow append is copied from runlog.mjs (which must stay byte-identical across skills).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The hash skill-insights computes from a transcript folder name (the project path with non-alphanumerics as "-").
export const projectHash = (absPath) => crypto.createHash('sha1').update(String(absPath).replace(/[^A-Za-z0-9]/g, '-')).digest('hex').slice(0, 6);

// metadata.version from SKILL.md frontmatter, plus a sha256 prefix of the file (the version string alone does not change between edits).
export function skillStamp(skillDir) {
  const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const fm = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  let version = null;
  if (fm) {
    let inMeta = false;
    for (const line of fm[1].split('\n')) {
      if (/^metadata:\s*$/.test(line)) { inMeta = true; continue; }
      if (inMeta && /^\S/.test(line)) inMeta = false;
      const m = inMeta && line.match(/^\s+version:\s*["']?([^"'\s]+)["']?\s*$/);
      if (m) { version = m[1].slice(0, 40); break; }
    }
  }
  return { version, sha: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12) };
}

// delivery-orchestrator and implementer stamps; a skill that cannot be found or read is left out.
export function skillStamps(selfDir) {
  const out = {};
  for (const [name, dir] of [['delivery-orchestrator', selfDir], ['implementer', path.join(path.dirname(selfDir), 'implementer')]]) {
    try { out[name] = skillStamp(dir); } catch { /* not installed beside this skill */ }
  }
  return out;
}

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
function appendNoFollow(file, text, onlyIfNew) {
  const F = fs.constants;
  const flags = F.O_WRONLY | F.O_CREAT | (onlyIfNew ? F.O_EXCL : F.O_APPEND) | (F.O_NOFOLLOW || 0);
  let fd;
  try { fd = fs.openSync(file, flags, 0o600); } catch (e) { if (onlyIfNew && e.code === 'EEXIST') return; throw e; }
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}

// Records are written even with SKILL_RUNLOG=off: they are a separate store from the runlog.
// A crash after the queue rename but before the flush loses that record by design (no phantom records for unsaved state).
// Never throws, never writes through a symlink.
export function appendRecord(root, rec) {
  try {
    const d = path.join(path.resolve(root), '.skill-runs');
    const plainDir = () => { const st = fs.lstatSync(d); return st.isDirectory() && !st.isSymbolicLink(); };
    if (fs.existsSync(d) || isLink(d)) { if (!plainDir()) return; } else { fs.mkdirSync(d, { recursive: true }); if (!plainDir()) return; }
    appendNoFollow(path.join(d, '.gitignore'), '*\n', true);
    appendNoFollow(path.join(d, 'factory-runs.jsonl'), JSON.stringify(rec) + '\n', false);
  } catch { /* records must never break a run */ }
}

// Driver mode: append to an explicit file (FACTORY_HOME/records/<repo-key>.jsonl). The parent is a private directory (0700) that is
// not a symlink and is owned by this user; the file is opened O_NOFOLLOW. Never throws; returns whether the record was written.
export function appendRecordTo(file, rec) {
  try {
    const f = path.resolve(file), d = path.dirname(f);
    if (!fs.existsSync(d) && !isLink(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(d);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if ((st.mode & 0o077) !== 0) fs.chmodSync(d, 0o700);
    if (isLink(f)) return false;
    appendNoFollow(f, JSON.stringify(rec) + '\n', false);
    return true;
  } catch { return false; }
}

// Last record per (run, feature); a feature can have several (awaiting_human, then merged).
export function latestPerFeature(lines) {
  const by = new Map();
  for (const r of lines || []) if (r && r.kind === 'factory-run') by.set(`${r.run}\u0000${r.feature}`, r);
  return [...by.values()];
}

// A reason is kept as a short category: cut at the first ':' (what follows may be command output or agent free text), 80 characters, no URL or path.
const scrub = (s) => (s == null ? null : String(s).split(':')[0].replace(/https?:\/\/\S+/gi, '<url>').replace(/(?:[A-Za-z]:\\|\/)(?:[\w.@~+-]+[\\/])+[\w.@~+-]*/g, '<path>').replace(/\s+/g, ' ').trim().slice(0, 80));

// Verification fields the factory driver sets on the queue feature (P1.4 Run record). IDs and counts only: every value is
// re-validated here because the queue is state, so a malformed or forged entry is dropped rather than copied into a record.
const count = (v) => (Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : 0);
const SHA = /^[0-9a-f]{40}$/;
const CRIT = /^(AC|EC|ER)-[1-9]\d{0,3}$/;
const GID = /^G[1-5]$/;
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
const ROLES = ['builder', 'author', 'evaluator'];
const idList = (v, re, max) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && re.test(x)))].sort().slice(0, max) : []);
const session = (s) => (s && typeof s === 'object' && ROLES.includes(s.role) ? {
  role: s.role, id: typeof s.id === 'string' && SESSION_ID.test(s.id) ? s.id : null,
  in: count(s.in), out: count(s.out), cache_create: count(s.cache_create), cache_read: count(s.cache_read), turns: count(s.turns),
} : null);
export function verificationFields(f) {
  return {
    verify_runs: count(f.verify_runs), verify_ms: count(f.verify_ms),
    verdict: f.verdict === 'pass' || f.verdict === 'fail' ? f.verdict : null,
    verdict_sha: typeof f.verdict_sha === 'string' && SHA.test(f.verdict_sha) ? f.verdict_sha : null,
    gap_criteria: idList(f.gap_criteria, CRIT, 200), antigaming: idList(f.antigaming, GID, 5),
    override_note: typeof f.override_note === 'string' && f.override_note.length > 0,
    sessions: (Array.isArray(f.sessions) ? f.sessions.slice(0, 200) : []).map(session).filter(Boolean),
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
// Per-role sums from the sessions (already validated), the budget hit, the interruptions and whether the person stopped the feature.
const INT_KIND = /^[a-z_]{1,32}$/;
const STEP = /^[a-z_]{1,32}$/;
export function usageFields(f) {
  const tokens = {}, turns = {}, cost = {};
  let anyCost = false;
  for (const x of verificationFields(f).sessions) {
    tokens[x.role] = (tokens[x.role] || 0) + x.in + x.out + x.cache_create + x.cache_read;
    turns[x.role] = (turns[x.role] || 0) + x.turns;
  }
  const raw = (Array.isArray(f.sessions) ? f.sessions.slice(0, 200) : []).filter((s) => s && typeof s === 'object' && ROLES.includes(s.role));
  for (const s of raw) { const c = num(s.cost_usd); if (c !== null) { cost[s.role] = Math.round(((cost[s.role] || 0) + c) * 1e6) / 1e6; anyCost = true; } }
  const ints = (Array.isArray(f.interruptions) ? f.interruptions.slice(0, 100) : []).filter((x) => x && typeof x === 'object' && typeof x.kind === 'string' && INT_KIND.test(x.kind)).map((x) => ({
    kind: x.kind, step: typeof x.step === 'string' && STEP.test(x.step) ? x.step : null, minutes_waited: count(x.minutes_waited),
    method: typeof x.method === 'string' && STEP.test(x.method) ? x.method : null,
  }));
  const latest = ints.at(-1)?.kind ?? (typeof f.interrupted?.kind === 'string' ? f.interrupted.kind : null);
  const out = {
    tokens_by_role: tokens, turns_by_role: turns,
    budget_hit: !!(f.budget_hold || f.hold_kind === 'budget' || ints.some((x) => x.kind === 'budget') || f.interrupted?.kind === 'budget'),
    interruptions: ints, stopped_by_user: latest === 'stop' || f.interrupted?.kind === 'stop',
  };
  if (anyCost) out.cost_usd_by_role = cost;
  return out;
}

export function buildRecord({ q, f, run, project, skills, now = Date.now() }) {
  const start = f.ts_start ? Date.parse(f.ts_start) : NaN;
  return {
    kind: 'factory-run', run, feature: f.id, tier: f.tier ?? null, outcome: f.state, reason: scrub(f.reason),
    ts_start: f.ts_start ?? null, ts_end: new Date(now).toISOString(), wall_ms: Number.isFinite(start) ? Math.max(0, now - start) : null,
    fix_rounds: f.fix_rounds ?? 0, ci_runs: f.ci_runs ?? 0, ci_wait_ms: f.ci_wait_ms ?? 0,
    pr: f.pr?.number ?? null, base_sha: f.base_sha ?? null, merge_sha: f.merged_sha ?? null,
    readiness_level: q.readiness_level ?? null, skills, project,
    ...verificationFields(f), ...usageFields(f),
  };
}
