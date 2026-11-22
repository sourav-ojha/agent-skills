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
import { parseSpec, validateSpec, readiness, parseDeps, RISKS, FEATURE_ID } from './lib/spec.mjs';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'feature-specification.md');
const USAGE = `Feature Intake helper
usage: node fi.mjs <command> [--dir <project>] [--json]

  new --title T [--risk low|elevated|high] [--source FILE|-] [--depends-on FEATURE-001,FEATURE-002]
                    allocate the next FEATURE-NNN and write a draft skeleton (same --source twice returns the existing id)
  validate ID|FILE  check frontmatter and the spec contract (exit 1 when invalid)
  check ID|FILE     validate, then the readiness rules R1-R8 (exit 2 when valid but not ready)
  status            list every spec: id, status, delivery, risk, title`;

function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
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

function setFrontmatter(text, updates) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) die('template has no frontmatter; reinstall the skill');
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
  const used = [...fs.readdirSync(fdir).map((f) => /^FEATURE-(\d+)\.md$/.exec(f)?.[1]).filter(Boolean).map(Number), ...registryFeatures()];
  let n = Math.max(0, ...used) + 1;
  for (let tries = 0; ; tries++, n++) {
    const id = `FEATURE-${String(n).padStart(3, '0')}`;
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
  const { id, text } = resolveSpec(rest[0]);
  const specs = loadSpecs();
  const v = validateSpec(text, { id, specs });
  extra.errors = v.errors.length;
  if (v.errors.length) {
    if (flags.json) out({ id: id || null, valid: false, ready: false, ...v, failures: [] });
    else report(id, v);
    process.exitCode = 1;
    return;
  }
  const r = readiness(text, { id, specs });
  extra.ready = r.ok; extra.failures = r.failures.length;
  if (flags.json) out({ id: id || null, valid: true, ready: r.ok, failures: r.failures, warnings: v.warnings });
  else {
    for (const f of r.failures) console.log(`not ready  ${f}`);
    console.log(r.ok ? `${id || 'spec'}: ready to approve` : `${id || 'spec'}: ${r.failures.length} readiness rule(s) unmet`);
  }
  if (!r.ok) process.exitCode = 2;
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

const commands = { new: cmdNew, validate: cmdValidate, check: cmdCheck, status: cmdStatus };
if (!cmd || cmd === 'help' || !Object.hasOwn(commands, cmd)) {
  console.log(USAGE);
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
const t0 = Date.now();
const today = new Date().toLocaleDateString('sv-SE');
// ok = the command did its job: `check` exiting 2 (valid, not ready) is a successful answer, not a failure.
process.on('exit', (code) => logEvent(dir, 'feature-intake', runId('fi', today), { event: cmd, ok: code !== 1, ms: Date.now() - t0, ...extra }));
try { commands[cmd](); } catch (e) { die(e.message); }
