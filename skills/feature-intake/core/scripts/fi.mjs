#!/usr/bin/env node
// Feature Intake helper CLI. Zero dependencies (Node 20+). Deterministic: it allocates IDs, writes the spec skeleton, validates
// the spec contract and checks readiness. It never interprets prose; the agent writes the content.
// Writes only <dir>/.product/features/ (plus the metadata-only run log in <dir>/.skill-runs/).
// Exit codes: 0 ok, 1 error or invalid (nothing changed), 2 valid but not ready (check).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logEvent, runId } from './lib/runlog.mjs';
import { parseSpec, validateSpec, readiness, parseDeps, contentHash, appendHistory, ensureHistoryTable, historyCell, dependencyCycle, RISKS, FEATURE_ID, TRACES_HEADER } from './lib/spec.mjs';
import { canonicalSpec, criteriaHash, extractCriteria } from './lib/criteria.mjs';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'feature-specification.md');
const USAGE = `Feature Intake helper
usage: node fi.mjs <command> [--dir <project>] [--json]

  new --title T [--risk low|elevated|high] [--source FILE|-] [--depends-on FEATURE-001,FEATURE-002]
                    allocate the next FEATURE-NNN and write a draft skeleton (same --source twice returns the existing id)
  validate ID|FILE  check frontmatter and the spec contract (exit 1 when invalid)
  check ID|FILE     validate, then the readiness rules R1-R9 (exit 2 when valid but not ready)
  approve ID --by NAME --note "<the user's words>"
                    draft that passes check -> ready; records who, the note and the content hash in the Approval history
  reopen ID --note "<why>" [--by NAME]
                    ready with delivery: none -> draft (to edit an approved spec); records a reopen row
  supersede ID --by NEW [--rewire]
                    draft or ready ID (delivery: none) -> superseded with superseded_by: NEW. Refuses while specs depend on
                    ID, listing them; --rewire points draft dependents at NEW (a ready dependent must be reopened first)
  split ID --into "Title A" "Title B" [...] [--rewire]
                    draft ID -> one draft child per title (parent: ID, a ## Traces table of the parent's criteria,
                    depends_on and risk copied), then ID superseded by the children. Same titles again return the children
  status            list every spec: id, status, delivery, risk, title`;

const BOOLEAN_FLAGS = new Set(['json', 'rewire']); // never take a value, so `--json FEATURE-001` keeps the id

function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--into') { // a list: every following token up to the next flag
      const list = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) list.push(argv[++i]);
      flags.into = list;
    } else if (BOOLEAN_FLAGS.has(a.slice(2))) {
      flags[a.slice(2)] = true;
    } else if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
      else { flags[a.slice(2)] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

function die(msg, code = 1) {
  console.error(`fi: ${msg}`);
  process.exit(code);
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = pos;
const dir = path.resolve(typeof flags.dir === 'string' ? flags.dir : '.');
const fdir = path.join(dir, '.product', 'features');
const extra = {}; // run-log metadata: ids and counts only, never content
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const read = (p) => fs.readFileSync(p, 'utf8');
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
// A frontmatter value the queue and pi read back unchanged: quoted when it would look like an inline comment or a quote.
const fmValue = (s) => (/\s#|^["']/.test(s) ? `"${s.replace(/"/g, "'")}"` : s);

const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Every FEATURE-NNN.md in the features folder, keyed by id (symlinks are never followed).
function loadSpecs() {
  const specs = new Map();
  if (!fs.existsSync(fdir)) return specs;
  for (const f of fs.readdirSync(fdir).sort()) {
    const m = /^(FEATURE-\d+)\.md$/.exec(f);
    const file = path.join(fdir, f);
    if (!m || isLink(file)) continue;
    const text = read(file);
    const { fm } = parseSpec(text);
    specs.set(m[1], { status: fm.status || '', fm, file, text });
  }
  return specs;
}

// FEATURE ids named in product-intelligence's registry (`## Registry` table, Feature column). Read-only.
function registryFeatures() {
  const p = path.join(dir, '.product', 'opportunities.md');
  if (!fs.existsSync(p) || isLink(p)) return [];
  const lines = read(p).replace(/\r\n/g, '\n').split('\n');
  const s = lines.findIndex((l) => /^##\s+Registry\s*$/i.test(l));
  if (s === -1) return [];
  let col = null; const ids = [];
  for (let i = s + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const l = lines[i].trim();
    if (!l.startsWith('|')) continue;
    const cells = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (col === null) { col = cells.findIndex((c) => c.toLowerCase() === 'feature'); if (col === -1) return []; continue; }
    for (const m of (cells[col] || '').matchAll(/FEATURE-(\d+)/g)) ids.push(Number(m[1]));
  }
  return ids;
}

// The next free FEATURE number: one past the highest spec file and product-intelligence registry entry.
function nextNumber() {
  const used = [...fs.readdirSync(fdir).map((f) => /^FEATURE-(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).map(Number), ...registryFeatures()];
  return Math.max(0, ...used) + 1;
}
const featureId = (n) => `FEATURE-${String(n).padStart(3, '0')}`;

// Throws (never exits) so a caller that already wrote something can undo it first. `name` is the file named in the error.
function setFrontmatter(text, updates, name = 'the spec template') {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) {
    if (/^---\r\n/.test(text)) throw new Error(`${name} has CRLF line endings, which are not supported for frontmatter edits; convert the file to LF line endings and rerun`);
    throw new Error(`${name} has no "---" frontmatter block that fi can edit`);
  }
  const rest = { ...updates };
  const lines = m[1].split('\n').map((l) => {
    const k = /^([A-Za-z_][\w-]*):/.exec(l)?.[1];
    if (!k || !Object.hasOwn(rest, k)) return l;
    const v = rest[k]; delete rest[k];
    return v === '' ? `${k}:` : `${k}: ${v}`;
  });
  for (const [k, v] of Object.entries(rest)) lines.push(`${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n${text.slice(m[0].length)}`;
}

function cmdNew() {
  const title = typeof flags.title === 'string' ? clean(flags.title) : '';
  if (!title) die('usage: new --title "<title>" [--risk low|elevated|high] [--source FILE|-] [--depends-on FEATURE-001,FEATURE-002]');
  if (title.includes('{{')) die('the title must not contain "{{" (it would read as an unfilled placeholder and the spec could never pass check)');
  const risk = flags.risk === undefined ? 'low' : flags.risk;
  if (!RISKS.includes(risk)) die(`--risk must be one of ${RISKS.join(', ')}`);
  if (flags['depends-on'] === true) die('--depends-on needs a comma-separated list of FEATURE ids');
  const deps = parseDeps(flags['depends-on']);
  const specs = loadSpecs();
  for (const d of deps) {
    if (!FEATURE_ID.test(d)) die(`--depends-on has invalid id "${d}"`);
    if (!specs.has(d)) die(`--depends-on names ${d}, which does not exist in .product/features/`);
  }
  let sourceSha = 'none'; let sourceRef = null;
  if (flags.source !== undefined) {
    if (flags.source === true) die('--source needs a file path, or - for standard input');
    let bytes;
    try { bytes = flags.source === '-' ? fs.readFileSync(0) : fs.readFileSync(path.resolve(flags.source)); } catch (e) { die(`cannot read --source: ${e.message}`); }
    if (!bytes.length) die(`--source is empty (0 bytes)${flags.source === '-' ? ' on standard input' : `: ${flags.source}`}; pass the source document, or leave --source out for an idea from chat`);
    sourceSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    sourceRef = flags.source === '-' ? 'stdin' : clean(path.basename(flags.source));
    for (const [id, s] of specs) {
      if (s.fm.source_sha === sourceSha) { extra.id = id; extra.existing = true; return out({ existing: true, id }); }
    }
  }
  let tpl;
  try { tpl = read(TEMPLATE); } catch (e) { die(`cannot read the spec template (${e.message}); reinstall the skill`); }
  // Create each level ourselves, checking for a link before and after, so nothing is ever created through a symlink.
  for (const d of [path.join(dir, '.product'), fdir]) {
    if (isLink(d)) die(`${path.relative(dir, d)} is a symbolic link; refusing to write through it`);
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') die(`cannot create ${path.relative(dir, d)}: ${e.message}`); }
    if (isLink(d) || !fs.statSync(d).isDirectory()) die(`${path.relative(dir, d)} is not a plain directory; refusing to write through it`);
  }
  let n = nextNumber();
  for (let tries = 0; ; tries++, n++) {
    const id = featureId(n);
    const text = setFrontmatter(tpl, { id, title: fmValue(title), risk, depends_on: deps.join(', '), source_sha: sourceSha, ...(sourceRef ? { source_ref: fmValue(sourceRef) } : {}) })
      .replace(/\{\{title\}\}/g, () => title);
    try {
      fs.writeFileSync(path.join(fdir, `${id}.md`), text, { flag: 'wx' }); // exclusive create: a concurrent run takes the next id
    } catch (e) {
      if (e.code === 'EEXIST' && tries < 1000) continue;
      die(`cannot create ${id}.md: ${e.message}`);
    }
    extra.id = id;
    return out({ id, path: `.product/features/${id}.md`, note: 'Draft skeleton. Fill every {{placeholder}} from the source and the codebase; run check until it reports ready.' });
  }
}

function resolveSpec(arg) {
  if (!arg || arg === true) die(`usage: ${cmd} FEATURE-NNN|FILE`);
  const file = FEATURE_ID.test(arg) ? path.join(fdir, `${arg}.md`) : path.resolve(arg);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die(`spec not found: ${arg}`);
  const id = /^(FEATURE-\d+)\.md$/.exec(path.basename(file))?.[1];
  if (id) extra.id = id;
  return { file, id, text: read(file) };
}

function report(id, v) {
  for (const e of v.errors) console.log(`ERROR   ${e}`);
  for (const w of v.warnings) console.log(`warning ${w}`);
  console.log(`${id || 'spec'}: ${v.errors.length} error(s), ${v.warnings.length} warning(s)`);
}

function cmdValidate() {
  const { id, text } = resolveSpec(rest[0]);
  const v = validateSpec(text, { id, specs: loadSpecs() });
  extra.errors = v.errors.length;
  if (flags.json) out({ id: id || null, valid: !v.errors.length, ...v });
  else report(id, v);
  if (v.errors.length) process.exitCode = 1;
}

function cmdCheck() {
  const { file, id, text } = resolveSpec(rest[0]);
  const specs = loadSpecs();
  const v = validateSpec(text, { id, specs });
  extra.errors = v.errors.length;
  if (v.errors.length) {
    if (flags.json) out({ id: id || null, valid: false, ready: false, ...v, failures: [] });
    else report(id, v);
    process.exitCode = 1;
    return;
  }
  if (/\r\n/.test(text)) v.warnings.push(`${id ? `${id}.md` : path.basename(file)} has CRLF line endings; approve, reopen, supersede and split need LF line endings (convert the file before running them)`);
  const r = readiness(text, { id, specs });
  extra.ready = r.ok; extra.failures = r.failures.length;
  if (flags.json) out({ id: id || null, valid: true, ready: r.ok, failures: r.failures, warnings: v.warnings });
  else {
    for (const w of v.warnings) console.log(`warning ${w}`);
    for (const f of r.failures) console.log(`not ready  ${f}`);
    console.log(r.ok ? `${id || 'spec'}: ready to approve` : `${id || 'spec'}: ${r.failures.length} readiness rule(s) unmet`);
  }
  if (!r.ok) process.exitCode = 2;
}

// approve / reopen / supersede / split: only a FEATURE id inside .product/features/, never through a symbolic link; written via a
// temp file + rename (new children: exclusive create).
function refuseLinks(id) {
  for (const p of [path.join(dir, '.product'), fdir, path.join(fdir, `${id}.md`)]) {
    if (isLink(p)) die(`${path.relative(dir, p)} is a symbolic link; refusing to write through it`);
  }
}
function resolveOwned() {
  const id = rest[0];
  if (typeof id !== 'string' || !FEATURE_ID.test(id)) die(`usage: ${cmd} FEATURE-NNN (a spec in .product/features/, not a file path)`);
  refuseLinks(id);
  return resolveSpec(id);
}
// Throws on failure (callers that must undo other writes catch it); writeOwned dies instead.
function replaceOwned(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } throw new Error(`cannot write ${path.basename(file)}: ${e.message}`); }
}
function writeOwned(file, text) {
  try { replaceOwned(file, text); } catch (e) { die(e.message); }
}
const historyDate = () => (/^\d{4}-\d\d-\d\d$/.test(process.env.FI_TODAY || '') ? process.env.FI_TODAY : new Date().toISOString().slice(0, 10));
const textFlag = (name, max) => (typeof flags[name] === 'string' ? historyCell(flags[name], max) : '');
const LOCKED = ['implemented', 'validated', 'superseded'];

function cmdApprove() {
  const by = textFlag('by', 100); const note = textFlag('note', 300);
  if (!by || !note) die('usage: approve FEATURE-NNN --by NAME --note "<the user\'s words>" (both required, non-empty)');
  const { file, id, text } = resolveOwned();
  const { fm } = parseSpec(text);
  if (fm.status === 'ready') die(`${id} is already ready; to change it run reopen, edit, then approve`);
  if (fm.status !== 'draft') die(`${id} is ${fm.status || 'missing a status'}; approve only runs on a draft${LOCKED.includes(fm.status) ? ` (a spec that is ${fm.status} is no longer edited)` : ''}`);
  const specs = loadSpecs();
  const v = validateSpec(text, { id, specs });
  if (v.errors.length) { report(id, v); die(`${id} is invalid; fix it before approving`); }
  const r = readiness(text, { id, specs });
  if (!r.ok) { for (const f of r.failures) console.log(`not ready  ${f}`); die(`${id} is not ready to approve (${r.failures.length} readiness rule(s) unmet)`); }
  // The table header is hashed, so a missing one is added before hashing; the new data row itself never changes the hash.
  const base = ensureHistoryTable(text);
  const hash = contentHash(base);
  const next = setFrontmatter(appendHistory(base, { date: historyDate(), action: 'approve', by, note, hash }), { status: 'ready' }, `${id}.md`);
  const after = validateSpec(next, { id, specs });
  if (after.errors.length) die(`internal: the approved spec would not validate (${after.errors[0]}); nothing written`);
  writeOwned(file, next);
  extra.status = 'ready';
  out({ id, status: 'ready', content_hash: hash, criteria_hash: criteriaHash(canonicalSpec(next)), note: 'Approved. Author hidden scenarios after this point: any later edit needs reopen and approve again.' });
}

function cmdReopen() {
  const note = textFlag('note', 300); const by = textFlag('by', 100) || '-';
  if (!note) die('usage: reopen FEATURE-NNN --note "<why>" [--by NAME] (--note required, non-empty)');
  const { file, id, text } = resolveOwned();
  const { fm } = parseSpec(text);
  if (fm.status !== 'ready') die(`${id} is ${fm.status || 'missing a status'}; reopen only runs on a ready spec${LOCKED.includes(fm.status) ? ` (a spec that is ${fm.status} is no longer edited)` : ''}`);
  if (fm.delivery !== 'none') die(`${id} has delivery: ${fm.delivery || '(missing)'}; reopen needs delivery: none (delivered work is not re-specified in place)`);
  const base = ensureHistoryTable(text);
  const hash = contentHash(base);
  writeOwned(file, setFrontmatter(appendHistory(base, { date: historyDate(), action: 'reopen', by, note, hash }), { status: 'draft' }, `${id}.md`));
  extra.status = 'draft';
  out({ id, status: 'draft', content_hash: hash, note: 'Reopened. Edit the spec, run check, then approve again.' });
}

// ---- supersede / split ----------------------------------------------------------------------------------------------------
function refuseDelivered(id, fm) {
  if (['implemented', 'validated'].includes(fm.status) || (fm.delivery || 'none') !== 'none') {
    die(`${id} is ${fm.status} with delivery: ${fm.delivery || '(missing)'}; delivered work is never superseded or split (put the change in a new FEATURE)`);
  }
}

// Specs (not superseded) whose depends_on names `id`. Without --rewire their existence refuses the command; with it every one
// must be a draft (editing depends_on changes a ready spec's content hash). Returns [[file, rewired text, dependent id], ...]
// built by `rewire(replacement)` once the replacement ids are known. Nothing is written here.
function dependents(specs, id, what) {
  const deps = [...specs].filter(([d, s]) => d !== id && s.status !== 'superseded' && parseDeps(s.fm.depends_on).includes(id));
  if (deps.length && !flags.rewire) die(`${id} has dependents: ${deps.map(([d]) => d).join(', ')}; rerun with --rewire to point their depends_on at ${what}, or edit them first`);
  const locked = deps.filter(([, s]) => s.status !== 'draft');
  if (locked.length) die(`--rewire edits draft dependents only; ${locked.map(([d, s]) => `${d} (${s.status})`).join(', ')} depend on ${id}: run fi reopen on each ready one first (a delivered dependent cannot be rewired)`);
  for (const [d] of deps) refuseLinks(d); // before anything is written
  // [[file, new text, id, new deps], ...]; throws on a file whose frontmatter cannot be edited.
  return (replacement) => deps.map(([d, s]) => {
    const next = [...new Set(parseDeps(s.fm.depends_on).flatMap((x) => (x === id ? replacement : [x])))].filter((x) => x !== d);
    return [s.file, setFrontmatter(s.text, { depends_on: next.join(', ') }, `${d}.md`), d, next];
  });
}

// Throws when the rewired graph has a dependency cycle through a changed spec. `drop` leaves the graph (it becomes
// superseded); `add` and `rewired` give new or changed edges. Only non-superseded specs count, as in validate.
function refuseCycles(specs, drop, add, rewired) {
  const graph = new Map([...specs].filter(([d, s]) => d !== drop && s.status !== 'superseded').map(([d, s]) => [d, parseDeps(s.fm.depends_on)]));
  for (const [d, deps] of add) graph.set(d, deps);
  for (const [, , d, deps] of rewired) graph.set(d, deps);
  for (const d of [...add.map(([x]) => x), ...rewired.map(([, , x]) => x)]) {
    const c = dependencyCycle(graph, d);
    if (c) throw new Error(`--rewire would create a dependency cycle ${c.join(' -> ')}; change the depends_on of these specs by hand first`);
  }
}

function cmdSupersede() {
  const by = flags.by;
  if (typeof by !== 'string' || !FEATURE_ID.test(by)) die('usage: supersede FEATURE-NNN --by FEATURE-NNN [--rewire]');
  const { file, id, text } = resolveOwned();
  const { fm } = parseSpec(text);
  refuseDelivered(id, fm);
  if (!['draft', 'ready'].includes(fm.status)) die(`${id} is ${fm.status || 'missing a status'}${fm.superseded_by ? ` by ${fm.superseded_by}` : ''}; supersede runs on a draft or ready spec`);
  if (by === id) die(`${id} cannot supersede itself`);
  const specs = loadSpecs();
  const target = specs.get(by);
  if (!target) die(`--by names ${by}, which does not exist in .product/features/`);
  if (target.status === 'superseded') die(`--by names ${by}, which is itself superseded; name the spec that replaced it`);
  const rewire = dependents(specs, id, by);
  // Every new text is built and checked in memory before the first write.
  let rewired; let parentText;
  try {
    rewired = rewire([by]);
    refuseCycles(specs, id, [], rewired);
    parentText = setFrontmatter(text, { status: 'superseded', superseded_by: by }, `${id}.md`);
  } catch (e) { die(`${e.message}; nothing changed`); }
  // Dependents first: if a later write fails they already point at the live spec, never at a superseded one.
  for (const [f, t] of rewired) writeOwned(f, t);
  writeOwned(file, parentText);
  extra.status = 'superseded'; extra.rewired = rewired.length;
  out({ id, status: 'superseded', superseded_by: by, rewired: rewired.map(([, , d]) => d) });
}

const fmRead = (v) => v.replace(/^(["'])(.*)\1$/, '$2'); // what parseSpec reads back from a value fmValue wrote

function cmdSplit() {
  const titles = (Array.isArray(flags.into) ? flags.into : []).map(clean);
  if (titles.length < 2 || titles.some((t) => !t)) die('usage: split FEATURE-NNN --into "Title A" "Title B" [...] [--rewire] (two or more non-empty titles)');
  if (new Set(titles).size !== titles.length) die('split titles must be distinct');
  const { file, id, text } = resolveOwned();
  const { fm } = parseSpec(text);
  refuseDelivered(id, fm);
  const specs = loadSpecs();
  if (fm.status === 'superseded') {
    // Idempotent re-run: the children are found by parent: ID and title; nothing is written.
    const found = titles.map((t) => [...specs].find(([, s]) => s.fm.parent === id && s.fm.title === fmRead(fmValue(t)))?.[0]);
    if (found.every(Boolean)) { extra.existing = true; return out({ existing: true, id, children: found }); }
    die(`${id} is already superseded${fm.superseded_by ? ` by ${fm.superseded_by}` : ''} and these titles do not match its children; split runs only on a draft`);
  }
  if (fm.status !== 'draft') die(`${id} is ${fm.status || 'missing a status'}; split runs only on a draft${fm.status === 'ready' ? ' (run fi reopen first)' : ''}`);
  const cr = extractCriteria(text);
  if (!cr.ok || !cr.ac.length) die(`${id}: acceptance criteria do not extract cleanly (${cr.errors[0] || 'no AC-<n> rows'}); fix them before splitting`);
  const rewire = dependents(specs, id, 'the children');
  let tpl;
  try { tpl = read(TEMPLATE); } catch (e) { die(`cannot read the spec template (${e.message}); reinstall the skill`); }
  const traces = ['## Traces', '', ...TRACES_HEADER, ...cr.ac.map((a) => `| ${id} ${a.id} |  |`), '', ''].join('\n');
  const childText = (cid, title) => {
    const t = setFrontmatter(tpl, { id: cid, title: fmValue(title), risk: fm.risk, depends_on: parseDeps(fm.depends_on).join(', '), source_sha: 'none', parent: id })
      .replace(/\{\{title\}\}/g, () => title);
    const at = t.search(/^## (?:\d+\.\s*)?Approval history/m);
    if (at === -1) die('template has no Approval history section; reinstall the skill');
    return t.slice(0, at) + traces + t.slice(at);
  };
  // Build and check every text in memory with the ids the children will most likely get, before the first create.
  const plan = (kids) => {
    const rewired = rewire(kids);
    refuseCycles(specs, id, kids.map((k) => [k, parseDeps(fm.depends_on)]), rewired);
    return { rewired, parentText: setFrontmatter(text, { status: 'superseded', superseded_by: kids.join(', ') }, `${id}.md`) };
  };
  const n0 = nextNumber();
  try {
    plan(titles.map((_, i) => featureId(n0 + i)));
    titles.forEach((t, i) => childText(featureId(n0 + i), t));
  } catch (e) { die(`${e.message}; nothing changed`); }
  const created = [];
  const undo = (msg) => {
    for (const f of created) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
    die(`${msg}; nothing changed (removed ${created.length} child spec(s) created by this run)`);
  };
  const children = [];
  let n = n0;
  for (const title of titles) {
    for (let tries = 0; ; tries++, n++) {
      const cid = featureId(n);
      const t = childText(cid, title);
      const v = validateSpec(t, { id: cid, specs });
      if (v.errors.length) undo(`internal: child ${cid} would not validate (${v.errors[0]})`);
      const f = path.join(fdir, `${cid}.md`);
      try {
        fs.writeFileSync(f, t, { flag: 'wx' }); // exclusive create: never overwrites, never follows a link
      } catch (e) {
        if (e.code === 'EEXIST' && tries < 1000) continue;
        undo(`cannot create ${cid}.md: ${e.message}`);
      }
      created.push(f); children.push(cid); n++;
      break;
    }
  }
  const done = [];
  let rewired = [];
  try {
    const p = plan(children); // the same as the check above unless a concurrent run took an id
    rewired = p.rewired;
    const parentText = p.parentText;
    for (const [f, t, d] of rewired) { replaceOwned(f, t); done.push(d); }
    replaceOwned(file, parentText);
  } catch (e) {
    for (const d of done) { try { replaceOwned(specs.get(d).file, specs.get(d).text); } catch { /* best effort */ } }
    undo(e.message);
  }
  extra.status = 'superseded'; extra.children = children.length; extra.rewired = rewired.length;
  out({ id, status: 'superseded', children, rewired: rewired.map(([, , d]) => d), note: 'Drafts created. Fill each child, map every parent criterion in its ## Traces table, run check, then approve.' });
}

function cmdStatus() {
  const rows = [...loadSpecs()].map(([id, s]) => ({
    id,
    title: s.fm.title || (s.text.match(/^#\s+(.+)$/m) || [, ''])[1].trim(),
    status: s.fm.status || '-',
    delivery: s.fm.delivery || '-',
    risk: s.fm.risk || '-',
    origin: s.fm.origin || '-',
  }));
  extra.specs = rows.length;
  if (flags.json) return out(rows);
  if (!rows.length) return out('no specs in .product/features/');
  for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(11)} delivery:${r.delivery.padEnd(8)} risk:${r.risk.padEnd(8)} ${r.title}`);
}

const commands = { new: cmdNew, validate: cmdValidate, check: cmdCheck, approve: cmdApprove, reopen: cmdReopen, supersede: cmdSupersede, split: cmdSplit, status: cmdStatus };
if (!cmd || cmd === 'help' || !Object.hasOwn(commands, cmd)) {
  console.log(USAGE);
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
const t0 = Date.now();
const today = new Date().toLocaleDateString('sv-SE');
// ok = the command did its job: `check` exiting 2 (valid, not ready) is a successful answer, not a failure.
process.on('exit', (code) => logEvent(dir, 'feature-intake', runId('fi', today), { event: cmd, ok: code !== 1, ms: Date.now() - t0, ...extra }));
try { commands[cmd](); } catch (e) { die(e.message); }
