#!/usr/bin/env node
// Helper for the growth-strategy skill. Zero dependencies. Owns .growth/ state, evidence rules and the approval gates.
// usage: node gs.mjs <command> [args] [--dir D]
import fs from 'node:fs';
import path from 'node:path';
import { CORE_DIR, loadConfig } from './lib/config.mjs';
import { logEvent, runId } from './lib/runlog.mjs';
import { ARTS, PHASES, MD_FILES, paths, ensureDir, assertNoLink, writeFile, exists, load, save, emptyGrowth, baselineHash, planHash, nextId, normKw, keywordsCsv, parseCsv, today, daysBetween, sha256, BASELINE_KEYS } from './lib/state.mjs';
import { checkSource, checkKeyword, checkItem, checkReview, validateAll, sourceIndex, IMPORTED } from './lib/evidence.mjs';
import { validateSchema } from './lib/config.mjs';
import { RECORDS } from './lib/state.mjs';

const HELP = `commands:
  init                                        create .growth/ (state files, artifact templates, .gitignore)
  status                                      phases, review, items and the next step
  config                                      effective configuration
  baseline set --file F                       set the product and growth baseline (JSON; see templates/baseline.json)
  approve-baseline --by NAME --note "<user's words>"     Gate 1: only after the user approved the baseline in chat
  add sources|keywords|items --file F [--update]          add records (JSON array); evidence rules are enforced
  phase done audit|research|plan              mark a phase complete (needs an approved baseline and finished artifacts)
  review start                                print the plan hash the reviewer must echo in its report
  review record --file R --mode independent --reviewer NAME | --mode self --reason "..."
  decide GRO-001[,GRO-002] approve|reject|defer|research --by NAME --note "<user's words>"   Gate 2
  supersede GRO-001 --with GRO-007 --by NAME --note "..."
  roadmap                                     write roadmap.md from approved items only
  handoff                                     write handoff/GRO-NNN.md specs for approved implementer items (once each)
  sync                                        mark handed-off items done when the implementer recorded delivery
  refresh [start --note "..."]                list stale research and data; start reopens the phases, keeps decisions
  import gsc --file queries.csv [--period YYYY-MM] [--geo G]   Search Console query export (aggregates only)
  export keywords [--out F]                   CSV of keywords.json
  validate [--json] | retro [--unclear T] [--skipped T] [--improvised T] [--suggest T]
(all accept --dir D; default is the current directory)`;

const argv = process.argv.slice(2);
const opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) opt[argv[i].slice(2)] = true; else { opt[argv[i].slice(2)] = n; i++; } } else pos.push(argv[i]); }
const [cmd, ...rest] = pos;
const die = (m) => { console.error(`error: ${m}`); process.exit(1); };
if (!cmd || cmd === 'help') { console.log(HELP); process.exit(0); }
const dir = path.resolve(opt.dir || '.');
const p = paths(dir);
const t0 = Date.now(), extra = {};
process.on('exit', (code) => { if (!['status', 'config', 'help', 'validate'].includes(cmd)) logEvent(dir, 'growth-strategy', runId('growth-strategy', 'growth'), { event: [cmd, rest[0]].filter(Boolean).join(' '), ok: code === 0, ms: Date.now() - t0, ...extra }); });

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const str = (k, max, what) => {
  const v = opt[k];
  if (v === undefined || v === true || !String(v).trim()) die(`--${k} is required: ${what}`);
  if (UNSAFE.test(v)) die(`--${k} must be one line without control characters`);
  if (String(v).length > max) die(`--${k} is longer than ${max} characters`);
  return String(v).trim();
};
const who = () => ({ by: str('by', 80, 'the name of the person who decided'), note: str('note', 500, '"<the user\'s own words>" from this conversation') });
const readInput = (f) => { if (!f || f === true) die('--file is required'); try { return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); } catch (e) { die(`cannot read ${f}: ${e.message}`); } };
const config = () => { const c = loadConfig(dir); if (c.errors.length) die(`invalid .growth/config.json:\n  ${c.errors.join('\n  ')}`); return c.config; };
// Before any write: refuse planted symlinks anywhere we might write, so a failed command leaves nothing half-written.
const guard = () => { if (fs.existsSync(p.base)) ensureDir(p.base); for (const f of [p.growth, p.sources, p.keywords, p.items, p.decisions, p.roadmap, p.csv, p.reviews, p.handoff]) assertNoLink(f); };
const STATE_KEYS = ['status', 'superseded_by', 'performance'];

function logDecision(s, target, decision, by, note) {
  const at = new Date().toISOString();
  s.growth.decisions.push({ at, target, decision, by, note });
  const head = fs.existsSync(p.decisions) ? '' : '# Decision log\n\nAppend-only record of the user\'s decisions (written by the helper).\n\n| When | Target | Decision | By | Note (user\'s words) |\n|---|---|---|---|---|\n';
  writeFile(p.decisions, `${head}| ${at.slice(0, 16).replace('T', ' ')} | ${target} | ${decision} | ${by.replace(/\|/g, '/')} | ${note.replace(/\|/g, '/')} |\n`, 'append');
}

function baselineState(g) {
  if (g.baseline.status !== 'approved') return 'draft';
  return g.baseline.content_hash === baselineHash(g.baseline) ? 'approved' : 'changed';
}
function requireBaseline(s) {
  const st = baselineState(s.growth);
  if (st === 'draft') die('the baseline is not approved: show it to the user and run approve-baseline after their OK');
  if (st === 'changed') die('the baseline changed after approval (hash mismatch): set it again with baseline set and get it re-approved');
}
const phaseState = (g, ph) => (g.phases[ph]?.stale ? 'stale' : g.phases[ph]?.done_at ? 'done' : 'pending');
const latestReview = (s) => s.growth.reviews.at(-1) || null;

function cmdInit() {
  if (exists(dir)) die('.growth/ is already initialised (use status)');
  ensureDir(p.base); ensureDir(p.reviews); ensureDir(p.handoff);
  guard();
  const s = { p, growth: emptyGrowth(), sources: [], keywords: [], items: [] };
  save(s);
  for (const f of MD_FILES) if (!fs.existsSync(p.md(f))) writeFile(p.md(f), fs.readFileSync(path.join(CORE_DIR, '..', 'templates', f), 'utf8'), 'create');
  if (!fs.existsSync(p.gitignore)) writeFile(p.gitignore, '# raw analytics and Search Console exports stay local\nperformance/\n', 'create');
  const ctx = fs.existsSync(path.join(dir, '.product', 'PRODUCT.md')) ? ' Found .product/PRODUCT.md: use it as baseline input (read-only).' : '';
  console.log(`initialised .growth/ (baseline draft).${ctx} Next: fill the baseline (templates/baseline.json shape), baseline set --file, then the user approves.`);
}

function cmdBaselineSet() {
  const s = load(dir); guard();
  const b = readInput(opt.file);
  const e = validateSchema(b, { $ref: '#/$defs/baseline' }, 'baseline', RECORDS);
  if (e.length) die(e.join('\n'));
  if (Object.values(b).flat().some((v) => typeof v === 'string' && UNSAFE.test(v))) die('baseline: text fields must be one line without control characters');
  const was = baselineState(s.growth);
  const unchanged = was === 'approved' && baselineHash(b) === s.growth.baseline.content_hash;
  s.growth.baseline = unchanged ? { ...s.growth.baseline, ...b } : { ...Object.fromEntries(BASELINE_KEYS.filter((k) => k in b).map((k) => [k, b[k]])), status: 'draft' };
  if (was !== 'draft' && !unchanged) {
    logDecision(s, 'baseline', 'reopened', 'helper', 'baseline content changed; needs the user\'s approval again');
    for (const ph of PHASES) if (s.growth.phases[ph]?.done_at) s.growth.phases[ph].stale = true; // research was done for another baseline
  }
  save(s, ['growth']);
  console.log(unchanged ? 'baseline unchanged (still approved)' : 'baseline saved as draft: show it to the user; approve-baseline after their OK');
}

function cmdApproveBaseline() {
  const s = load(dir); guard();
  const { by, note } = who();
  const b = s.growth.baseline;
  const e = validateSchema(Object.fromEntries(BASELINE_KEYS.filter((k) => k in b).map((k) => [k, b[k]])), { $ref: '#/$defs/baseline' }, 'baseline', RECORDS);
  if (e.length) die(`baseline is incomplete:\n${e.join('\n')}`);
  Object.assign(b, { status: 'approved', content_hash: baselineHash(b), approved_by: by, approved_at: today(), approved_note: note });
  logDecision(s, 'baseline', 'approve', by, note);
  save(s, ['growth']);
  console.log(`baseline approved by ${by}`);
}

function cmdAdd(kind) {
  if (!['sources', 'keywords', 'items'].includes(kind)) die('add needs sources, keywords or items');
  const s = load(dir); guard();
  const input = readInput(opt.file);
  const list = Array.isArray(input) ? input : input?.[kind];
  if (!Array.isArray(list) || !list.length) die(`--file must hold a non-empty JSON array of ${kind}`);
  const errs = [], out = [];
  if (kind === 'sources') {
    const taken = new Map(s.sources.map((x) => [x.id, x]));
    for (const [i, raw] of list.entries()) {
      const src = { ...raw };
      if (src.url === undefined) delete src.url;
      if (IMPORTED.includes(src.type)) { errs.push(`sources[${i}]: ${src.type} sources are created only by gs import (measured data needs the real export file)`); continue; }
      if (src.ref?.startsWith('file:') && !src.sha256) {
        const f = path.resolve(dir, src.ref.slice(5));
        if (f.startsWith(dir + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) src.sha256 = sha256(fs.readFileSync(f));
      }
      if (src.id && taken.has(src.id)) { if (JSON.stringify(taken.get(src.id)) !== JSON.stringify(src)) errs.push(`sources[${i}]: id ${src.id} is taken by a different source`); continue; }
      if (!src.id) src.id = nextId([...s.sources, ...out], 'S');
      errs.push(...checkSource(src, `sources[${i}]`));
      taken.set(src.id, src); out.push(src);
    }
    if (errs.length) die(errs.join('\n'));
    s.sources.push(...out);
    save(s, ['sources']);
    for (const x of out) console.log(`${x.id} ${x.title}`);
    extra.added = out.length; return;
  }
  const byId = sourceIndex(s);
  if (kind === 'keywords') {
    const index = new Map(s.keywords.map((k, i) => [normKw(k), i]));
    const seen = new Set();
    for (const [i, k] of list.entries()) {
      for (const f of STATE_KEYS) if (f in (k || {})) errs.push(`keywords[${i}]: "${f}" is helper-owned`);
      errs.push(...checkKeyword(k, byId, `keywords[${i}]`));
      if (errs.length) continue;
      const key = normKw(k);
      if (seen.has(key)) { errs.push(`keywords[${i}]: duplicate keyword "${k.keyword}" in the input`); continue; }
      seen.add(key);
      if (index.has(key) && !opt.update) errs.push(`keywords[${i}]: duplicate keyword "${k.keyword}" (${k.geo}) already tracked; pass --update to replace it`);
    }
    if (errs.length) die(errs.join('\n'));
    let added = 0, updated = 0;
    for (const k of list) {
      const key = normKw(k);
      if (index.has(key)) { const old = s.keywords[index.get(key)]; s.keywords[index.get(key)] = old.performance ? { ...k, performance: old.performance } : k; updated++; }
      else { index.set(key, s.keywords.length); s.keywords.push(k); added++; }
    }
    save(s, ['keywords']);
    extra.added = added; console.log(`keywords: added ${added}, updated ${updated}`); return;
  }
  // items
  const byItem = new Map(s.items.map((x, i) => [x.id, i]));
  const staged = [];
  for (const [i, raw] of list.entries()) {
    for (const f of STATE_KEYS) if (f in (raw || {})) errs.push(`items[${i}]: "${f}" is helper-owned (decisions go through decide)`);
    const it = { ...raw };
    if (!it.id) it.id = nextId([...s.items, ...staged], 'GRO');
    if (staged.some((x) => x.id === it.id)) { errs.push(`items[${i}]: duplicate id ${it.id} in the input`); continue; }
    errs.push(...checkItem(it, byId, `items[${i}]`));
    if (byItem.has(it.id)) {
      const old = s.items[byItem.get(it.id)];
      if (old.status !== 'proposed') errs.push(`items[${i}]: ${it.id} is already decided (${old.status}); add a new item and supersede it instead of editing`);
    }
    staged.push(it);
  }
  if (errs.length) die(errs.join('\n'));
  for (const it of staged) {
    if (byItem.has(it.id)) s.items[byItem.get(it.id)] = { ...it, status: 'proposed' };
    else { byItem.set(it.id, s.items.length); s.items.push({ ...it, status: 'proposed' }); }
  }
  save(s, ['items']);
  extra.added = staged.length; console.log(`items: ${staged.map((x) => x.id).join(', ')} (proposed)`);
}

function cmdPhaseDone(ph) {
  if (!PHASES.includes(ph)) die('phase done needs audit, research or plan');
  const s = load(dir); guard();
  requireBaseline(s);
  const spec = ARTS.phases[ph];
  const missing = spec.needs.filter((n) => phaseState(s.growth, n) !== 'done');
  if (missing.length) die(`${ph} needs the ${spec.needs.join(' and ')} phases done first (missing: ${missing.join(', ')})`);
  const errs = [];
  for (const f of spec.markdown) {
    if (!fs.existsSync(p.md(f))) { errs.push(`${f} is missing`); continue; }
    const t = fs.readFileSync(p.md(f), 'utf8');
    if (t.includes('{{')) errs.push(`${f} still has template placeholders ({{...}})`);
    for (const sec of ARTS.markdown[f]) if (!new RegExp(`^## ${sec}\\s*$`, 'm').test(t)) errs.push(`${f}: missing section "## ${sec}"`);
  }
  for (const r of spec.records || []) if (!s[r].length) errs.push(`${r}.json is empty`);
  const v = validateAll(s, config());
  errs.push(...v.errors);
  if (errs.length) die(`cannot mark ${ph} done:\n${errs.join('\n')}`);
  s.growth.phases[ph] = { ...s.growth.phases[ph], done_at: today(), stale: false, baseline_hash: s.growth.baseline.content_hash };
  save(s, ['growth']);
  console.log(`${ph}: done${v.warnings.length ? ` (${v.warnings.length} warning(s); run validate)` : ''}`);
}

function cmdReviewRecord() {
  const s = load(dir); guard();
  requireBaseline(s);
  if (phaseState(s.growth, 'plan') !== 'done') die('review needs the plan phase done first (phase done plan)');
  const mode = opt.mode;
  if (!['independent', 'self'].includes(mode)) die('--mode must be independent (a separate reviewer agent ran) or self');
  const reviewer = mode === 'independent' ? str('reviewer', 80, 'the separate agent that reviewed (for example gs-growth-reviewer)') : 'self';
  const reason = mode === 'self' ? str('reason', 300, 'why no independent reviewer could run') : undefined;
  const r = readInput(opt.file);
  const e = checkReview(r, s);
  if (e.length) die(e.join('\n'));
  const current = planHash(s);
  if (r.plan_hash !== current) die('the report reviewed a different plan (plan_hash does not match): run review start, give the hash to the reviewer, and review the current plan');
  ensureDir(p.reviews);
  const id = nextId(s.growth.reviews, 'R');
  const rec = { id, at: new Date().toISOString(), mode, reviewer, ...(reason ? { reason } : {}), plan_hash: current, verdict: r.verdict, checked_sources: r.checked_sources || [], findings: r.findings };
  const text = JSON.stringify(rec, null, 2) + '\n';
  writeFile(path.join(p.reviews, `${id}.json`), text, 'create');
  const count = (sev) => r.findings.filter((f) => f.severity === sev).length;
  const { findings, checked_sources, ...summary } = rec;
  s.growth.reviews.push({ ...summary, file_sha256: sha256(text), counts: { Critical: count('Critical'), High: count('High'), Medium: count('Medium'), Low: count('Low') } });
  save(s, ['growth']);
  extra.mode = mode; extra.findings = r.findings.length;
  console.log(`${id}: ${mode === 'self' ? 'self-review (not independent)' : `independent review by ${reviewer}`}, ${r.verdict}, ${r.findings.length} finding(s)`);
}

function cmdReviewStart() {
  const s = load(dir);
  requireBaseline(s);
  if (phaseState(s.growth, 'plan') !== 'done') die('review needs the plan phase done first (phase done plan)');
  console.log(`plan hash: ${planHash(s)}\nGive this to the reviewer; its JSON report must include "plan_hash" with this value. Any plan edit before review record changes it.`);
}

// A review counts only if its file is the one recorded (sha256) and agrees with the summary in growth.json.
function reviewFile(r) {
  if (!/^R-\d{3,}$/.test(String(r.id))) die(`invalid review id ${JSON.stringify(r.id)} in growth.json`);
  const f = path.join(p.reviews, `${r.id}.json`);
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch { die(`review file ${r.id}.json is missing: record the review again`); }
  const full = JSON.parse(text);
  if (sha256(text) !== r.file_sha256 || full.plan_hash !== r.plan_hash || full.mode !== r.mode) die(`review file ${r.id}.json was changed after it was recorded: record the review again`);
  return full;
}

function cmdDecide() {
  const decision = rest[rest.length - 1];
  const MAP = { approve: 'approved', reject: 'rejected', defer: 'deferred', research: 'needs-research' };
  const ids = rest.slice(0, -1).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  if (!ids.length || !MAP[decision]) die('usage: decide GRO-001[,GRO-002] approve|reject|defer|research --by NAME --note "<user\'s words>"');
  const { by, note } = who();
  const s = load(dir); guard();
  requireBaseline(s);
  const rev = latestReview(s);
  if (!rev) die('no review recorded: run the independent growth-reviewer and review record before any decision');
  if (rev.plan_hash !== planHash(s)) die('the plan changed since the last review: review it again (review record) before deciding');
  const stale = PHASES.filter((ph) => phaseState(s.growth, ph) !== 'done');
  if (stale.length) die(`phases not done (${stale.join(', ')}): finish the refresh and review the plan again before deciding`);
  if (rev.mode !== 'independent' && config().gates.require_independent_review) die('decisions need an independent review (a separate reviewer agent); only the user can turn this off in .growth/config.json: {"gates": {"require_independent_review": false}}');
  // Findings from every review of this exact plan count: a second, cleaner review cannot wash out a Critical finding.
  const current = s.growth.reviews.filter((r) => r.plan_hash === rev.plan_hash).map(reviewFile);
  const all = current.flatMap((r) => r.findings);
  const failed = current.some((r) => r.verdict === 'FAIL');
  const planLevel = all.filter((f) => !f.item && ['Critical', 'High'].includes(f.severity));
  for (const id of ids) {
    const it = s.items.find((x) => x.id === id);
    if (!it) die(`unknown item ${id}`);
    if (['handed-off', 'done', 'superseded'].includes(it.status)) die(`${id} is ${it.status}; it cannot be decided again`);
    const blocking = all.filter((f) => f.item === id && ['Critical', 'High'].includes(f.severity));
    if (decision === 'approve' && blocking.length) die(`${id} has ${blocking.map((f) => f.severity).join('/')} review finding(s); fix the plan and review again, or reject or defer it`);
    if (decision === 'approve' && (failed || planLevel.length)) die(`the review ${failed ? 'verdict is FAIL' : 'has plan-level Critical/High findings'}; fix the plan and review again before approving anything`);
  }
  for (const id of ids) { s.items.find((x) => x.id === id).status = MAP[decision]; logDecision(s, id, decision, by, note); }
  save(s, ['growth', 'items']);
  extra.decision = decision; extra.decided = ids.length;
  console.log(`${decision}: ${ids.join(', ')}`);
}

function cmdSupersede() {
  const old = rest[0], nu = opt.with;
  const { by, note } = who();
  const s = load(dir); guard();
  const a = s.items.find((x) => x.id === old), b = s.items.find((x) => x.id === nu);
  if (!a) die(`unknown item ${old}`);
  if (!b || nu === old) die('--with must name another existing item');
  if (!['proposed', 'approved'].includes(b.status)) die(`--with ${nu} is ${b.status}; the replacement must be proposed or approved`);
  if (['done', 'superseded'].includes(a.status)) die(`${old} is ${a.status}`);
  Object.assign(a, { status: 'superseded', superseded_by: nu });
  logDecision(s, old, 'supersede', by, `${note} (by ${nu})`);
  save(s, ['growth', 'items']);
  console.log(`${old} superseded by ${nu}; earlier decisions stay in the log`);
}

const reviewLine = (s) => {
  const r = latestReview(s);
  if (!r) return 'none';
  const cur = r.plan_hash === planHash(s) ? 'current' : 'out of date: the plan changed after it';
  return r.mode === 'independent' ? `independent (${r.reviewer}, ${r.id}, ${r.verdict}; ${cur})` : `self-review (not independent): ${r.reason} (${r.id}, ${r.verdict}; ${cur})`;
};

function cmdRoadmap() {
  const s = load(dir); guard();
  { const v = validateAll(s, config()); if (v.errors.length) die(`fix validation errors first (gs validate):\n${v.errors.join('\n')}`); }
  const cfg = config();
  const src = sourceIndex(s);
  const cite = (i) => i.sources.map((id) => (src.get(id)?.url ? `[${id}](${src.get(id).url})` : id)).join(', ') || 'none';
  const row = (i) => `| ${i.id} | ${i.type} | ${i.title.replace(/\|/g, '/')} | ${i.owner} | ${i.effort} | ${i.impact} | ${i.evidence}, ${i.confidence} | ${i.status} | ${cite(i)} |`;
  const head = '| ID | Type | Item | Owner | Effort | Impact | Evidence | Status | Sources |\n|---|---|---|---|---|---|---|---|---|';
  const live = s.items.filter((i) => ['approved', 'handed-off', 'done'].includes(i.status));
  const out = [`# ${cfg.roadmap.days}-day growth roadmap: ${s.growth.baseline.name || 'unnamed'}`, '',
    `Generated ${today()} by the growth-strategy helper from approved items only. Review: ${reviewLine(s)}.`,
    'Impact is a qualitative judgment, not a traffic forecast. Owner `human` items are tasks for a person (posting, submissions, outreach); nothing here is done automatically.', ''];
  for (const w of ['weeks 1-4', 'weeks 5-8', 'weeks 9-13']) {
    const rows = live.filter((i) => i.window === w);
    out.push(`## ${w[0].toUpperCase()}${w.slice(1)}`, '', rows.length ? `${head}\n${rows.map(row).join('\n')}` : '_No approved items._', '');
  }
  if (live.length) {
    out.push('## Item details', '');
    for (const i of live) out.push(`### ${i.id}: ${i.title}`, '', `${i.rationale}`, '', `Owner: ${i.owner}. ${i.owner === 'human' ? 'Done when:' : 'Acceptance:'}`, ...(i.acceptance || []).map((a) => `- ${a}`), ...(i.risks.length ? ['', 'Risks:', ...i.risks.map((r) => `- ${r}`)] : []), '');
  }
  const pending = s.items.filter((i) => ['proposed', 'deferred', 'needs-research'].includes(i.status));
  out.push('## Not approved (recommendations only)', '', pending.length ? `${head}\n${pending.map(row).join('\n')}` : '_None._', '');
  const closed = s.items.filter((i) => ['rejected', 'superseded'].includes(i.status));
  if (closed.length) out.push('## Rejected or superseded', '', `${head}\n${closed.map(row).join('\n')}`, '');
  writeFile(p.roadmap, out.join('\n'));
  console.log(`wrote .growth/roadmap.md (${live.length} approved item(s), ${pending.length} not approved)`);
}

function cmdHandoff() {
  const s = load(dir); guard();
  { const v = validateAll(s, config()); if (v.errors.length) die(`fix validation errors first (gs validate):\n${v.errors.join('\n')}`); }
  ensureDir(p.handoff);
  const src = sourceIndex(s);
  const made = [];
  for (const it of s.items.filter((i) => i.status === 'approved' && i.owner === 'implementer')) {
    const file = path.join(p.handoff, `${it.id}.md`);
    if (!/^GRO-\d{3,}$/.test(it.id) || path.dirname(file) !== p.handoff) die(`invalid item id ${it.id}`);
    if (!fs.existsSync(file)) {
      const body = ['---', `id: ${it.id}`, 'status: ready', 'source: growth-strategy', `item: ${it.id}`, `type: ${it.type}`, '---', '', `# ${it.id}: ${it.title}`, '',
        '## Goal', `${it.rationale} Approved growth roadmap item (${it.window}).`, '',
        '## Acceptance criteria', ...it.acceptance.map((a, n) => `- AC${n + 1}: ${a}`), '',
        '## Non-goals', '- Nothing beyond this item. No publishing, posting, directory submissions, account creation or ads changes unless an acceptance criterion says so.', '',
        '## Constraints and assumptions', `- Evidence: ${it.evidence}, ${it.confidence} confidence. Sources: ${it.sources.map((id) => `${id} ${src.get(id)?.url || src.get(id)?.ref || ''}`.trim()).join('; ') || 'none'}.`,
        ...(it.keywords.length ? [`- Target keywords: ${it.keywords.join(', ')}.`] : []), ...it.risks.map((r) => `- Risk: ${r}`),
        ...(it.needs_design ? ['- Design is open: explore it with the brainstorming skill before implementing.'] : []), '',
        '## Open questions', '- None recorded by growth-strategy.', '',
        '## Measurement', '- After release, compare the target pages in Search Console and the measurement plan (.growth/measurement-plan.md) at the next refresh.', ''].join('\n');
      writeFile(file, body, 'create');
      made.push(it.id);
    }
    it.status = 'handed-off';
  }
  save(s, ['items']);
  extra.handoffs = made.length;
  console.log(made.length ? `wrote ${made.map((x) => `.growth/handoff/${x}.md`).join(', ')}: give each to the implementer` : 'no new handoff specs (approve implementer-owned items first, or they exist already)');
}

function cmdSync() {
  const s = load(dir); guard();
  const done = [];
  for (const it of s.items.filter((i) => i.status === 'handed-off')) {
    const file = path.join(p.handoff, `${it.id}.md`);
    if (!fs.existsSync(file)) continue;
    const fm = (fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
    if (/^delivery:\s*complete\s*$/m.test(fm) || /^status:\s*implemented\s*$/m.test(fm)) { it.status = 'done'; done.push(it.id); }
  }
  save(s, ['items']);
  console.log(done.length ? `done: ${done.join(', ')}` : 'no handed-off item has a recorded delivery yet');
}

function staleReport(s, cfg) {
  const t = today();
  const old = (d, max) => d && daysBetween(d, t) > max;
  return {
    sources: s.sources.filter((x) => old(x.accessed, cfg.freshness.source_max_age_days)).map((x) => x.id),
    keywords: s.keywords.filter((k) => old(k.researched, cfg.freshness.keyword_max_age_days)).map((k) => k.keyword),
    phases: PHASES.filter((ph) => s.growth.phases[ph]?.stale || old(s.growth.phases[ph]?.done_at, cfg.freshness.phase_refresh_days)),
  };
}

function cmdRefresh() {
  const s = load(dir);
  const cfg = config();
  const st = staleReport(s, cfg);
  if (rest[0] === 'start') {
    guard();
    const note = str('note', 300, 'why this refresh runs');
    s.growth.refreshes.push({ at: today(), note, stale_sources: st.sources, stale_keywords: st.keywords.length });
    for (const ph of PHASES) if (s.growth.phases[ph]?.done_at) s.growth.phases[ph].stale = true;
    save(s, ['growth']);
    console.log('refresh started: phases reopened (decisions and approved items are kept). Re-research only what is stale, then phase done again; changed plans need a new review.');
    return;
  }
  const perf = s.growth.performance.at(-1);
  console.log([`stale sources: ${st.sources.join(', ') || '-'}`, `stale keywords: ${st.keywords.join(', ') || '-'}`, `phases older than ${cfg.freshness.phase_refresh_days} days: ${st.phases.join(', ') || '-'}`,
    `needs-research items: ${s.items.filter((i) => i.status === 'needs-research').map((i) => i.id).join(', ') || '-'}`,
    `latest performance import: ${perf ? `${perf.period} (${perf.totals.matched} tracked keyword(s) matched)` : 'none (export Search Console queries and run import gsc)'}`,
    'next: refresh start --note "...", then re-run only the stale research'].join('\n'));
}

function cmdImportGsc() {
  if (rest[0] !== 'gsc') die('import supports: gsc');
  const s = load(dir); guard();
  if (!opt.file || opt.file === true) die('--file is required (Search Console > Performance > Export > Queries.csv)');
  const file = path.resolve(opt.file);
  let buf; try { buf = fs.readFileSync(file); } catch (e) { die(`cannot read ${opt.file}: ${e.message}`); }
  const rows = parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
  const head = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iq = col('top queries', 'query', 'queries'), ic = col('clicks'), ii = col('impressions'), ir = col('ctr'), ip = col('position');
  if ([iq, ic, ii, ir, ip].some((x) => x < 0)) die('not a Search Console queries CSV export (needs columns: Top queries, Clicks, Impressions, CTR, Position)');
  const period = opt.period && opt.period !== true ? String(opt.period) : today().slice(0, 7);
  if (!/^\d{4}-\d{2}(-\d{2})?( to \d{4}-\d{2}-\d{2})?$/.test(period)) die('--period must look like 2026-11 or 2026-10-01 to 2026-10-28');
  const hash = sha256(buf);
  const rel = file.startsWith(dir + path.sep) ? path.relative(dir, file).split(path.sep).join('/') : path.basename(file);
  let srcRec = s.sources.find((x) => x.type === 'gsc' && x.sha256 === hash);
  if (!srcRec) { srcRec = { id: nextId(s.sources, 'S'), type: 'gsc', ref: `file:${rel}`, title: `Search Console queries export ${period}`.slice(0, 200), accessed: today(), sha256: hash }; s.sources.push(srcRec); }
  const num = (v) => { const n = Number(String(v).replace(/[%,\s]/g, '')); return Number.isFinite(n) ? n : 0; };
  const geo = opt.geo && opt.geo !== true ? String(opt.geo).toLowerCase() : null;
  const byText = new Map();
  for (const k of s.keywords) { if (geo && String(k.geo).toLowerCase() !== geo) continue; const n = String(k.keyword).toLowerCase().replace(/\s+/g, ' ').trim(); byText.set(n, [...(byText.get(n) || []), k]); }
  const totals = { rows: 0, clicks: 0, impressions: 0, matched: 0 };
  let ambiguous = 0;
  for (const r of rows.slice(1)) {
    totals.rows++; totals.clicks += num(r[ic]); totals.impressions += num(r[ii]);
    const ks = byText.get(String(r[iq] || '').toLowerCase().replace(/\s+/g, ' ').trim());
    if (!ks) continue; // untracked queries are never copied: they can contain personal data
    if (ks.length > 1) { ambiguous++; continue; } // same keyword tracked for several geos: pass --geo with a country-filtered export
    const k = ks[0];
    const ctr = String(r[ir]).includes('%') ? num(r[ir]) / 100 : num(r[ir]);
    k.performance = { period, clicks: num(r[ic]), impressions: num(r[ii]), ctr: Math.round(ctr * 10000) / 10000, position: num(r[ip]), source: srcRec.id };
    totals.matched++;
  }
  s.growth.performance.push({ at: today(), period, source: srcRec.id, totals });
  save(s);
  extra.matched = totals.matched;
  console.log(`imported ${totals.rows} row(s) for ${period} as ${srcRec.id}; ${totals.matched} tracked keyword(s) updated${ambiguous ? `, ${ambiguous} skipped (tracked for several geos: re-export filtered by country and pass --geo)` : ''}. Keep raw exports in .growth/performance/ (git-ignored).`);
}

function cmdExport() {
  if (rest[0] !== 'keywords') die('export supports: keywords');
  const s = load(dir); guard();
  const out = opt.out && opt.out !== true ? path.resolve(opt.out) : p.csv;
  writeFile(out, keywordsCsv(s.keywords));
  console.log(`wrote ${path.relative(process.cwd(), out) || out} (${s.keywords.length} keyword(s))`);
}

function cmdStatus() {
  if (!exists(dir)) { console.log('no .growth/ here.\nnext: run init'); return; }
  const s = load(dir);
  const g = s.growth, bs = baselineState(g);
  const count = (st) => s.items.filter((i) => i.status === st).length;
  console.log(`growth-strategy: ${g.baseline.name || '(baseline not set)'}`);
  console.log(`baseline: ${bs === 'changed' ? 'changed after approval (re-approval needed)' : bs}`);
  console.log(`phases: ${PHASES.map((ph) => `${ph}: ${phaseState(g, ph)}`).join(', ')}`);
  console.log(`review: ${reviewLine(s).replace(/^self-review/, 'self')}`);
  console.log(`keywords: ${s.keywords.length}; sources: ${s.sources.length}; items: ${['proposed', 'approved', 'deferred', 'needs-research', 'rejected', 'handed-off', 'done', 'superseded'].map((st) => `${st} ${count(st)}`).join(', ')}`);
  const rev = latestReview(s);
  let next;
  if (bs !== 'approved') next = 'fill the baseline (baseline set), show it to the user, and run approve-baseline after their OK';
  else if (['audit', 'research'].some((ph) => phaseState(g, ph) !== 'done')) next = `audit and research (in parallel where possible), then phase done for: ${['audit', 'research'].filter((ph) => phaseState(g, ph) !== 'done').join(', ')}`;
  else if (phaseState(g, 'plan') !== 'done') next = 'plan: consolidate research into items and the plan files, then phase done plan';
  else if (!rev || rev.plan_hash !== planHash(s)) next = 'independent review with the growth-reviewer, then review record';
  else if (count('proposed')) next = 'present the plan and the review; the user decides each item (decide ... --by --note)';
  else if (s.items.some((i) => i.status === 'approved' && i.owner === 'implementer')) next = 'roadmap, then handoff for the implementer items';
  else if (count('handed-off')) next = 'sync after the implementer records delivery; refresh when research goes stale';
  else next = 'roadmap; refresh when research or performance data goes stale';
  console.log(`next: ${next}`);
}

function cmdValidate() {
  const s = load(dir);
  const v = validateAll(s, config());
  if (opt.json) console.log(JSON.stringify(v, null, 2));
  else { for (const e of v.errors) console.log(`ERROR ${e}`); for (const w of v.warnings) console.log(`warning ${w}`); console.log(`${v.errors.length} error(s), ${v.warnings.length} warning(s)`); }
  if (v.errors.length) process.exitCode = 1;
}

try {
  if (cmd === 'init') cmdInit();
  else if (cmd === 'status') cmdStatus();
  else if (cmd === 'config') console.log(JSON.stringify(config(), null, 2));
  else if (cmd === 'baseline' && rest[0] === 'set') cmdBaselineSet();
  else if (cmd === 'approve-baseline') cmdApproveBaseline();
  else if (cmd === 'add') cmdAdd(rest[0]);
  else if (cmd === 'phase' && rest[0] === 'done') cmdPhaseDone(rest[1]);
  else if (cmd === 'review' && rest[0] === 'start') cmdReviewStart();
  else if (cmd === 'review' && rest[0] === 'record') cmdReviewRecord();
  else if (cmd === 'decide') cmdDecide();
  else if (cmd === 'supersede') cmdSupersede();
  else if (cmd === 'roadmap') cmdRoadmap();
  else if (cmd === 'handoff') cmdHandoff();
  else if (cmd === 'sync') cmdSync();
  else if (cmd === 'refresh') cmdRefresh();
  else if (cmd === 'import') cmdImportGsc();
  else if (cmd === 'export') cmdExport();
  else if (cmd === 'validate') cmdValidate();
  else if (cmd === 'retro') {
    const notes = Object.fromEntries(['unclear', 'skipped', 'improvised', 'suggest'].filter((k) => opt[k] && opt[k] !== true).map((k) => [k, opt[k]]));
    if (!Object.keys(notes).length) die('retro needs at least one of --unclear, --skipped, --improvised, --suggest');
    Object.assign(extra, notes); console.log('retro logged');
  } else die(`unknown command\n${HELP}`);
} catch (e) { die(e.message); }
