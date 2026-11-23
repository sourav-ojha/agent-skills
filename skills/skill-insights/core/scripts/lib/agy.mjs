// Parse one Antigravity CLI (agy) conversation into the same normalised entries as transcripts.mjs. Pure; no I/O.
// agy keeps a conversation as a SQLite file whose `steps` rows hold protobuf (no published schema). Field numbers below were
// read off real conversations: step metadata 1/8 = created/completed time {seconds, nanos}, 4 = tool call {id, name, args JSON},
// 9 = model usage {2 input, 3 output, 4 cache write, 5 cache read} on model-response steps (step_type 15).
// Message text is never kept. rows: [{ status, error, metadata, payload }] ordered by step index.
import crypto from 'node:crypto';
import { decode, first, sub, str, int } from './proto.mjs';
const SKILL_PATH = /\/skills\/([^/]+)\/(.*)$/;
const READERS = new Set(['read_file', 'view_file']);
const WRITERS = new Set(['write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file']);
const PATH_KEYS = ['Path', 'AbsolutePath', 'TargetFile'];
const STEP_ERROR = 7; // other non-3 statuses (cancelled, interrupted) are not tool failures
// A shell command that probably changes files. Which file is unknown, so it only clears the "read and not edited since" memory.
const SHELL_WRITE = /(?:^|[^>&0-9])>>?\s*(?!&|\/dev\/null)\S|\bsed\s+(?:-[A-Za-z]*i|--in-place)|\bperl\s+-[A-Za-z]*i|\btee\b|\bpatch\b|\bgit\s+(?:apply|checkout|restore|reset|merge|rebase|pull|stash|cherry-pick|revert)\b|\b(?:mv|cp|rm)\s|--(?:write|fix)\b|\bgofmt\s+-w\b/;
const fileKey = (f) => crypto.createHash('sha1').update(f).digest('hex').slice(0, 12);
const ms = (t) => { const s = int(t, 1); return s === undefined ? NaN : s * 1000 + Math.floor((int(t, 2) ?? 0) / 1e6); };

export function parseAgySteps(rows) {
  const entries = [];
  let skippedSteps = 0;
  let active = null; // skill whose SKILL.md was read last: reading it again is a repeated read, not a new run
  for (const r of rows) {
    const md = r.metadata ? decode(r.metadata) : null;
    if (!md) { skippedSteps++; continue; }
    const created = ms(sub(md, 1)); const done = ms(sub(md, 8));
    const ts = Number.isNaN(created) ? done : created;
    if (Number.isNaN(ts)) { skippedSteps++; continue; }
    const call = sub(md, 4);
    if (call) {
      const name = str(call, 2) ?? '?'; const id = str(call, 1);
      let args = {};
      try { const a = JSON.parse(str(call, 3) ?? '{}'); if (a && typeof a === 'object') args = a; } catch { /* keep {} */ }
      const file = PATH_KEYS.map((k) => args[k]).find((v) => typeof v === 'string');
      const isRead = READERS.has(name); const isWrite = WRITERS.has(name);
      const sk = file && isRead ? file.match(SKILL_PATH) : null;
      const key = file && (isRead || isWrite) ? fileKey(file) : null;
      const tid = id ? { tid: id } : {};
      if (sk && sk[2] === 'SKILL.md' && sk[1] !== active) { active = sk[1]; entries.push({ ts, skill: sk[1], ...tid, ...(key ? { fileKey: key } : {}) }); }
      else if (sk) entries.push({ ts, read: { skill: sk[1], file }, ...tid, ...(key ? { fileKey: key } : {}) });
      else {
        const shellWrite = name === 'run_command' && typeof args.CommandLine === 'string' && SHELL_WRITE.test(args.CommandLine);
        entries.push({ ts, tool: name, ...tid, ...(key ? { fileKey: key, ...(isRead ? {} : { wrote: true }) } : {}), ...(shellWrite ? { wroteAny: true } : {}) });
      }
      const end = Number.isNaN(done) ? ts : done;
      const payload = r.payload ? decode(r.payload) : null;
      const own = payload ? first(payload, 5) : null;
      const bytes = r.payload ? Math.max(0, r.payload.length - (own ? own.length : 0)) : 0;
      entries.push({ ts: end, bytes, ...tid, ...(r.status === STEP_ERROR || r.error ? { error: true } : {}) });
      continue;
    }
    const u = sub(md, 9);
    if (u && (int(u, 2) !== undefined || int(u, 3) !== undefined)) entries.push({ ts: Number.isNaN(done) ? ts : done, usage: { in: int(u, 2) ?? 0, out: int(u, 3) ?? 0, cacheRead: int(u, 5) ?? 0, cacheWrite: int(u, 4) ?? 0 } });
  }
  entries.sort((a, b) => a.ts - b.ts); // stable: a step's own order is kept for equal timestamps
  return { entries, skippedLines: skippedSteps };
}
