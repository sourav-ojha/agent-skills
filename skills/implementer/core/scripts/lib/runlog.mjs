// Run log: one metadata-only JSON line per helper command, for later analysis of how a skill performed.
// Never throws, never blocks the run. Off with SKILL_RUNLOG=off. Lives in <project>/.skill-runs/ (self-ignoring).
// Keep this file identical in every skill that has helpers (a test enforces it).
import fs from 'node:fs';
import path from 'node:path';

const NOTE_KEYS = new Set(['unclear', 'skipped', 'improvised', 'suggest']); // agent self-report: short free text, exported redacted
const clean = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

export function logEvent(dir, skill, run, fields) {
  try {
    if (process.env.SKILL_RUNLOG === 'off') return;
    const rec = { ts: new Date().toISOString(), skill, run };
    if (process.env.SKILL_PARENT_RUN) rec.parent = clean(process.env.SKILL_PARENT_RUN, 80);
    for (const [k, v] of Object.entries(fields || {})) {
      if (typeof v === 'number' || typeof v === 'boolean') rec[k] = v;
      else if (typeof v === 'string') rec[k] = clean(v, NOTE_KEYS.has(k) ? 500 : 200);
    }
    const d = path.join(path.resolve(dir), '.skill-runs');
    fs.mkdirSync(d, { recursive: true });
    const ig = path.join(d, '.gitignore');
    if (!fs.existsSync(ig)) fs.writeFileSync(ig, '*\n');
    fs.appendFileSync(path.join(d, `${skill}.jsonl`), JSON.stringify(rec) + '\n');
  } catch { /* logging must never break a run */ }
}

export const runId = (skill, key) => clean(process.env.SKILL_RUN_ID || `${skill}:${key}`, 80);
