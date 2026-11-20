#!/usr/bin/env node
// skill-insights: read-only analysis of Claude Code session transcripts. Zero dependencies. Never prints paths or message text.
// usage: node si.mjs <inventory|runs|report|export|runs-factory> [--projects-dir D] [--skills-dir D ...] [--since YYYY-MM-DD] [--skill NAME] [--json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseSession } from './lib/transcripts.mjs';
import { windows, inventory, dedupeSessions } from './lib/analyze.mjs';
import { parseRunLog, summarizeRuns } from './lib/runs.mjs';
import { joinTokens, coverage, latestPerFeature } from './lib/factory.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = { skillsDir: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opt.json = true;
  else if (a === '--no-notes') opt.noNotes = true;
  else if (a === '--skills-dir') opt.skillsDir.push(argv[++i]);
  else if (a.startsWith('--')) opt[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
}
const die = (m) => { console.error(`si: ${m}`); process.exit(1); };
if (!['inventory', 'runs', 'report', 'export', 'runs-factory'].includes(cmd)) die('usage: si.mjs <inventory|runs|report|export|runs-factory> [--projects-dir D] [--skills-dir D ...] [--since YYYY-MM-DD] [--skill NAME] [--dir PROJECT] [--out FILE] [--no-notes] [--json]\n  runs-factory [--dir PROJECT | --repo OWNER/NAME] [--out FILE]   join <PROJECT>/.skill-runs/factory-runs.jsonl, or (driver mode) $FACTORY_HOME/records/<owner>__<repo>.jsonl, (latest per feature) to transcript tokens, subagents included');
const home = os.homedir();
const projectsDir = path.resolve(opt.projectsDir || path.join(home, '.claude', 'projects'));
const skillDirs = (opt.skillsDir.length ? opt.skillsDir : [path.join(home, '.claude', 'skills')]).map((d) => path.resolve(d));
if (cmd !== 'export' && cmd !== 'runs-factory' && !fs.existsSync(projectsDir)) die('projects dir not found (use --projects-dir)');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6);

function loadSessions(onlyDir, { subagents = false } = {}) {
  const out = [];
  for (const p of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!p.isDirectory() || (onlyDir && p.name !== onlyDir)) continue;
    const dir = path.join(projectsDir, p.name);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      let text;
      try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      const s = parseSession(text);
      if (!s.entries.length) continue;
      const date = new Date(s.entries[0].ts).toISOString().slice(0, 10);
      if (opt.since && date < opt.since) continue;
      out.push({ project: hash(p.name), sessionId: hash(f), date, ...s });
    }
    if (!subagents) continue;
    // Subagent transcripts live at <project>/<session-id>/subagents/agent-*.jsonl; tag them with the parent project hash.
    for (const sd of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!sd.isDirectory()) continue;
      const sub = path.join(dir, sd.name, 'subagents');
      let names; try { names = fs.readdirSync(sub); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.jsonl')) continue;
        let text; try { text = fs.readFileSync(path.join(sub, f), 'utf8'); } catch { continue; }
        const s = parseSession(text);
        if (!s.entries.length) continue;
        out.push({ project: hash(p.name), sessionId: hash(`${sd.name}/${f}`), date: new Date(s.entries[0].ts).toISOString().slice(0, 10), subagent: true, ...s });
      }
    }
  }
  return dedupeSessions(out);
}
function installed() {
  const names = new Set();
  for (const d of skillDirs) {
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && fs.existsSync(path.join(d, e.name, 'SKILL.md'))) names.add(e.name);
  }
  return [...names].sort();
}
const match = (skill) => !opt.skill || skill === opt.skill || skill.split(':').pop() === opt.skill;
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const min = (ms) => (ms / 60000).toFixed(1);

function runRows(sessions) {
  const rows = [];
  for (const s of sessions) {
    for (const w of windows(s)) {
      if (w.skill === '(none)' && opt.skill !== '(none)') continue;
      if (!match(w.skill)) continue;
      rows.push({ skill: w.skill, project: s.project, session: s.sessionId, date: s.date, tokens: w.tokens, wallMin: Number(min(w.wallMs)), toolCalls: w.toolCalls, toolErrors: w.toolErrors, filesRead: new Set(w.reads).size, repeatedReads: w.repeatedReads, fileReads: w.fileReads, repeatedFileReads: w.repeatedFileReads, largestResultBytes: w.largestResults[0] || 0 });
    }
  }
  return rows;
}

// Print, or write to --out (never through a symlink, owner-only).
function emit(text, protect) {
  if (!opt.out) { console.log(text); return; }
  const f = path.resolve(opt.out);
  if (protect) { let a, b = null; try { a = fs.realpathSync(protect); } catch { a = null; } try { b = path.join(fs.realpathSync(path.dirname(f)), path.basename(f)); } catch { /* dir missing */ } if (a && b && a === b) die('--out is the source run log; refusing to overwrite it'); }
  try { if (fs.lstatSync(f).isSymbolicLink()) die('--out is a symlink; refusing to write through it'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(f, text + '\n', { mode: 0o600 });
  console.log(`wrote ${path.basename(f)}`);
}

function exportBundle() {
  const dir = path.resolve(opt.dir || '.');
  const rl = path.join(dir, '.skill-runs');
  const files = fs.existsSync(rl) ? fs.readdirSync(rl).filter((f) => f.endsWith('.jsonl')) : [];
  if (!files.length) { console.log('no run logs found in this project (.skill-runs is empty). Run a skill first, then export.'); return; }
  const events = files.flatMap((f) => parseRunLog(fs.readFileSync(path.join(rl, f), 'utf8')).events);
  const runs = summarizeRuns(events, { notes: !opt.noNotes });
  // Transcript cost for this project only: transcript folders are the project path with non-alphanumerics replaced by "-".
  const mine = dir.replace(/[^A-Za-z0-9]/g, '-');
  const cost = fs.existsSync(path.join(projectsDir, mine))
    ? loadSessions(mine).flatMap((s) => windows(s).filter((w) => w.skill !== '(none)').map((w) => ({ skill: w.skill, date: s.date, tokens: w.tokens, wallMin: Number(min(w.wallMs)), toolErrors: w.toolErrors, repeatedReads: w.repeatedReads })))
    : [];
  if (opt.json) { emit(JSON.stringify({ runs, cost }, null, 2)); return; }
  const L = ['# Skill run bundle (redacted)', '', 'Metadata-only run logs plus agent self-report. No prompts, code, paths or emails. Review it, then bring it to the skill author (use --no-notes to leave out the agent self-report).', '', '## Runs', ''];
  for (const r of runs) {
    L.push(`### ${r.skill} (${r.run})`, `- window: ${r.start} .. ${r.end}; commands: ${r.commands}; failed commands: ${r.failedCommands.join(', ') || 'none'}; waits (CI still running, re-run needed): ${r.waitingCommands}`);
    if (r.skill === 'implementer') L.push(`- tier: ${r.tier || '?'}; input spec: ${r.spec || 'idea'}; tasks passed: ${r.passed}; fix rounds: ${r.fixRounds}; blocked: ${r.blocked}; rulings: ${r.rulings}; delivery: ${r.delivery || 'not reported'}`);
    else L.push(`- opportunities touched: ${r.ids.join(', ') || 'none'}; validate runs: ${r.validate.map((v) => `${v.errors}E/${v.warnings}W`).join(', ') || 'none'}`);
    for (const n of r.notes) for (const [k, v] of Object.entries(n)) L.push(`- ${k}: ${v}`);
    L.push('');
  }
  if (cost.length) {
    L.push('## Transcript cost for these skills', '', '| Skill | Date | In | Out | Cache-read | Min | Tool errors | Repeated reads |', '|---|---|---|---|---|---|---|---|');
    for (const c of cost) L.push(`| ${c.skill} | ${c.date} | ${k(c.tokens.in)} | ${k(c.tokens.out)} | ${k(c.tokens.cacheRead)} | ${c.wallMin} | ${c.toolErrors} | ${c.repeatedReads} |`);
  }
  emit(L.join('\n'));
}

function runsFactory() {
  let log, folders, source, missing;
  if (opt.repo !== undefined) {
    // Driver-mode records: $FACTORY_HOME/records/<owner>__<repo>.jsonl. The record carries only the project hash, so the transcript
    // folders are the ones in the projects dir whose name hashes to a project in the records.
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(opt.repo)) || String(opt.repo).split('/').some((x) => x.startsWith('.'))) die('--repo must be OWNER/NAME');
    const fh = process.env.FACTORY_HOME || path.join(home, '.factory');
    log = path.join(fh, 'records', `${String(opt.repo).replace(/\//g, '__')}.jsonl`);
    source = 'FACTORY_HOME/records/' + path.basename(log);
    missing = `no factory run records found (${source} is missing). Run \`factory run\` first.`;
    try { if (fs.lstatSync(log).isSymbolicLink() || fs.lstatSync(path.dirname(log)).isSymbolicLink()) die('the records file or its directory is a symlink; refusing to read it'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  } else {
    let dir = path.resolve(opt.dir || '.');
    try { dir = fs.realpathSync(dir); } catch { /* keep resolved path */ }
    log = path.join(dir, '.skill-runs', 'factory-runs.jsonl');
    missing = 'no factory run records found (.skill-runs/factory-runs.jsonl is missing). Run `deliver.mjs run` first.';
    // The record's project hash is sha1 of the real path with non-alphanumerics as "-"; transcripts live in the folder of that name.
    folders = [dir.replace(/[^A-Za-z0-9]/g, '-')];
  }
  if (!fs.existsSync(log)) { console.log(missing); return; }
  const parsed = [];
  for (const l of fs.readFileSync(log, 'utf8').split('\n')) { if (!l.trim()) continue; try { parsed.push(JSON.parse(l)); } catch { /* skip */ } }
  const records = latestPerFeature(parsed).filter((r) => Number.isFinite(Date.parse(r.ts_start)) && Number.isFinite(Date.parse(r.ts_end)));
  if (!folders) {
    const want = new Set(records.map((r) => r.project));
    folders = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && want.has(hash(e.name))).map((e) => e.name) : [];
  }
  const turns = [];
  const haveFolder = folders.some((f) => fs.existsSync(path.join(projectsDir, f)));
  if (!haveFolder) console.log('no transcript folder found for this project: token columns and attribution coverage are unavailable');
  for (const folder of folders) {
    if (!fs.existsSync(path.join(projectsDir, folder))) continue;
    for (const s of loadSessions(folder, { subagents: true })) {
      for (const e of s.entries) if (e.usage) turns.push({ project: s.project, ts: e.ts, tokens: { in: e.usage.in, out: e.usage.out, cache_create: e.usage.cacheWrite, cache_read: e.usage.cacheRead } });
    }
  }
  const rows = joinTokens(records, turns);
  const cov = coverage(records, turns);
  if (opt.out) emit(rows.map((r) => JSON.stringify(r)).join('\n'), log);
  else {
    console.log('feature | tier | outcome | turns | in | out | cache-create | cache-read | status');
    for (const r of rows) console.log(`${r.feature} | ${r.tier ?? '-'} | ${r.outcome} | ${r.turns} | ${k(r.tokens_in)} | ${k(r.tokens_out)} | ${k(r.cache_create)} | ${k(r.cache_read)} | ${r.status}${r.ambiguous_turns ? ` (${r.ambiguous_turns} shared turn(s), ${k(r.ambiguous_tokens)} tokens)` : ''}`);
  }
  const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
  for (const c of cov) console.log(`attribution run ${c.run}: ${pct(c.ratio_tokens)} of tokens, ${pct(c.ratio_turns)} of ${c.turns_total} turn(s) in the run window fall inside a feature window`);
  if (rows.some((r) => r.status === 'ambiguous')) console.log('note: ambiguous rows share turns with another feature; their tokens are counted in each row, so do not sum ambiguous rows');
}

if (cmd === 'export') { exportBundle(); process.exit(0); }
if (cmd === 'runs-factory') { runsFactory(); process.exit(0); }
const sessions = loadSessions();
if (!sessions.length) { console.log('no sessions found (0 sessions in range)'); process.exit(0); }

if (cmd === 'inventory') {
  const inv = inventory(sessions, installed());
  if (opt.json) console.log(JSON.stringify(inv, null, 2));
  else {
    console.log(`${sessions.length} session(s)\nskill | invocations | sessions | projects | last used`);
    for (const u of inv.used) console.log(`${u.skill} | ${u.invocations} | ${u.sessions} | ${u.projects} | ${u.lastUsed}`);
    console.log(`\ninstalled but never used in range: ${inv.unused.join(', ') || '(none)'}`);
  }
} else if (cmd === 'runs') {
  const rows = runRows(sessions);
  if (opt.json) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`${r.date} ${r.project}/${r.session} ${r.skill}: in ${k(r.tokens.in)} out ${k(r.tokens.out)} cache-read ${k(r.tokens.cacheRead)} | ${r.wallMin} min | tools ${r.toolCalls} errors ${r.toolErrors} | skill files read ${r.filesRead} repeated ${r.repeatedReads} | file reads ${r.fileReads} repeated ${r.repeatedFileReads} | largest result ${k(r.largestResultBytes)}B`);
} else {
  const inv = inventory(sessions, installed());
  const rows = runRows(sessions);
  const by = new Map();
  for (const r of rows) { const a = by.get(r.skill) || []; a.push(r); by.set(r.skill, a); }
  const lines = [`# Skill insights (${sessions.length} sessions)`, '', '> Attribution is approximate: a skill owns activity from its invocation until the next skill invocation. Idle gaps over 10 min are excluded.', '', '## Usage', '', '| Skill | Invocations | Sessions | Projects | Last used |', '|---|---|---|---|---|'];
  for (const u of inv.used) lines.push(`| ${u.skill} | ${u.invocations} | ${u.sessions} | ${u.projects} | ${u.lastUsed} |`);
  lines.push('', `Installed but never used in range: ${inv.unused.join(', ') || '(none)'}`, '', '## Cost and friction per skill', '', '| Skill | Runs | Avg in | Avg out | Avg cache-read | Total min | Tool errors | Repeated skill-file reads | Repeated file reads | Largest result |', '|---|---|---|---|---|---|---|---|---|---|');
  const flags = [];
  const total = (rs) => rs.reduce((t, r) => t + r.wallMin, 0);
  let ranked = [...by.entries()].sort((a, b) => total(b[1]) - total(a[1]));
  const top = Number(opt.top);
  if (Number.isInteger(top) && top > 0) ranked = ranked.slice(0, top);
  for (const [skill, rs] of ranked) {
    const n = rs.length; const avg = (f) => Math.round(rs.reduce((t, r) => t + f(r), 0) / n);
    const errs = rs.reduce((t, r) => t + r.toolErrors, 0); const rep = rs.reduce((t, r) => t + r.repeatedReads, 0); const repF = rs.reduce((t, r) => t + r.repeatedFileReads, 0);
    const big = Math.max(...rs.map((r) => r.largestResultBytes));
    lines.push(`| ${skill} | ${n} | ${k(avg((r) => r.tokens.in))} | ${k(avg((r) => r.tokens.out))} | ${k(avg((r) => r.tokens.cacheRead))} | ${rs.reduce((t, r) => t + r.wallMin, 0).toFixed(1)} | ${errs} | ${rep} | ${repF} | ${k(big)}B |`);
    if (errs / n >= 2) flags.push(`${skill}: ${(errs / n).toFixed(1)} tool errors per run`);
    if (repF / n >= 3) flags.push(`${skill}: ${repF} file(s) re-read without an edit in between (${(repF / n).toFixed(1)} per run)`);
    if (rep > 0) flags.push(`${skill}: ${rep} repeated read(s) of the same skill file`);
    if (big > 100_000) flags.push(`${skill}: a single tool result of ${k(big)}B (large outputs inflate every later turn)`);
  }
  lines.push('', '## Flags', '', ...(flags.length ? flags.map((f) => `- ${f}`) : ['- none']));
  console.log(lines.join('\n'));
}
