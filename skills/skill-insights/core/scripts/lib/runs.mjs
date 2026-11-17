// Summarise and redact skill run logs (.skill-runs/*.jsonl) for export. Pure; no I/O.
const NOTE_KEYS = ['unclear', 'skipped', 'improvised', 'suggest'];

// Free text from an agent is redacted again here: absolute paths, emails, long token-like strings.
export function redactText(s, max = 400) {
  return String(s)
    .replace(/(?:[A-Za-z]:\\|\/)(?:[\w.@~+-]+[\\/])+[\w.@~+-]*/g, '<path>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<token>')
    .slice(0, max);
}

export function parseRunLog(text) {
  const out = [];
  let skipped = 0;
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && typeof o === 'object' && o.run && o.event) out.push(o); else skipped++; } catch { skipped++; }
  }
  return { events: out, skipped };
}

export function summarizeRuns(events) {
  const by = new Map();
  for (const e of events) { const a = by.get(e.run) || []; a.push(e); by.set(e.run, a); }
  return [...by.entries()].map(([run, evs]) => {
    evs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const count = (name) => evs.filter((e) => e.event === name).length;
    const failed = evs.filter((e) => e.ok === false);
    const notes = evs.filter((e) => e.event === 'retro').map((e) => Object.fromEntries(NOTE_KEYS.filter((k) => e[k]).map((k) => [k, redactText(e[k])])));
    const init = evs.find((e) => e.event === 'init');
    return {
      run, skill: evs[0].skill, start: evs[0].ts, end: evs[evs.length - 1].ts, commands: evs.length,
      failedCommands: failed.map((e) => e.event), tier: init?.tier, spec: init?.spec,
      fixRounds: count('reopen'), blocked: count('block'), passed: count('pass') - failed.filter((e) => e.event === 'pass').length,
      rulings: count('ruling'), ids: [...new Set(evs.map((e) => e.opp).filter(Boolean))],
      validate: evs.filter((e) => e.event === 'validate').map((e) => ({ errors: e.errors, warnings: e.warnings })),
      delivery: evs.filter((e) => e.event === 'report').map((e) => e.state).pop(),
      notes,
    };
  });
}
