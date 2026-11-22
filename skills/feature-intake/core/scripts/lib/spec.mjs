// Intake spec rules: frontmatter shape, the shared spec contract (headings, AC/EC/ER grammar, trailing Delivery log) and the
// mechanical readiness rules R1-R9. Deterministic: it never interprets prose. Zero dependencies.
import { extractCriteria, specRegions, canonicalSpec, criteriaHash } from './criteria.mjs';

export const REQUIRED_HEADINGS = [
  'Context and problem statement', 'Objective and expected behavior', 'Existing implementation analysis', 'Scope and non-goals',
  'Functional and technical requirements', 'Acceptance criteria', 'Edge cases', 'Error and failure scenarios',
  'Technical considerations', 'Security and performance', 'Testing and verification', 'Assumptions and unresolved decisions',
  'Approval history',
];
export const STATUSES = ['draft', 'ready', 'implemented', 'validated', 'superseded'];
export const RISKS = ['low', 'elevated', 'high'];
export const DELIVERIES = ['none', 'partial', 'complete'];
export const FEATURE_ID = /^FEATURE-\d+$/;
const REQUIRED_KEYS = ['type', 'id', 'title', 'status', 'origin', 'risk', 'depends_on', 'delivery', 'source_sha'];
const KEY_LINE = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/; // same key grammar as the delivery queue's reader
const QUOTED = /^(["'])(.*)\1$/;

// Same as the delivery queue's parseDeps: brackets stripped, comma or space separated.
export function parseDeps(v) {
  if (!v) return [];
  return String(v).replace(/^\[|\]$/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

// A depends_on path from `start` back to itself in `graph` (Map id -> dependency ids), e.g. [A, B, A], or null. Ids that are
// not in the graph (missing or superseded specs) end a path.
export function dependencyCycle(graph, start) {
  const stack = [start]; const seen = new Set([start]);
  const walk = (id) => {
    for (const d of graph.get(id) || []) {
      if (d === start) return [...stack, start];
      if (seen.has(d) || !graph.has(d)) continue;
      seen.add(d); stack.push(d);
      const c = walk(d);
      if (c) return c;
      stack.pop();
    }
    return null;
  };
  return walk(start);
}

export function parseSpec(text) {
  const t = String(text).replace(/\r\n/g, '\n');
  const fm = {}; const problems = [];
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(t);
  if (!m) return { fm, body: t, problems: ['no frontmatter: the file must start with a "---" line and close the block with another "---" line'] };
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) { problems.push(`nested or indented frontmatter line (use one top-level "key: value" per line): "${line}"`); continue; }
    const kv = KEY_LINE.exec(line);
    if (!kv) { problems.push(`frontmatter line is not "key: value": "${line}"`); continue; }
    const raw = kv[2].trim();
    if (!QUOTED.test(raw) && /\s#/.test(raw)) problems.push(`inline comment in a frontmatter value (readers keep everything after the colon): "${line}"`);
    if (Object.hasOwn(fm, kv[1])) { problems.push(`duplicate frontmatter key "${kv[1]}": "${line}"`); continue; }
    fm[kv[1]] = raw.replace(QUOTED, '$2');
  }
  return { fm, body: t.slice(m[0].length), problems };
}

// Headings are matched as product-intelligence's validator does: "## ", optional "N." prefix, case-insensitive prefix match.
const isH2 = (l) => /^##\s+/.test(l);
const h2Title = (l) => l.replace(/^##\s+(?:\d+\.\s*)?/, '').trim().toLowerCase();

function section(body, name) {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => isH2(l) && h2Title(l).startsWith(name.toLowerCase()));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (isH2(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end).join('\n');
}

function headingErrors(body) {
  const errors = [];
  const found = body.split('\n').filter(isH2).map(h2Title);
  let cursor = -1;
  for (const req of REQUIRED_HEADINGS) {
    const r = req.toLowerCase();
    const idx = found.findIndex((h, i) => i > cursor && h.startsWith(r));
    if (idx === -1) errors.push(`missing section "${req}"${found.some((h) => h.startsWith(r)) ? ' (present but out of order)' : ''}`);
    else cursor = idx;
  }
  return errors;
}

export function validateSpec(text, ctx = {}) {
  const errors = []; const warnings = [];
  const { fm, body, problems } = parseSpec(text);
  errors.push(...problems);
  for (const k of REQUIRED_KEYS) if (!Object.hasOwn(fm, k)) errors.push(`missing frontmatter key "${k}"`);
  const has = (k) => Object.hasOwn(fm, k);
  if (has('type') && fm.type !== 'feature-spec') errors.push(`type is "${fm.type}", expected feature-spec`);
  if (has('id') && !/^FEATURE-\d{3,}$/.test(fm.id)) errors.push(`id "${fm.id}" is not FEATURE-NNN`);
  if (ctx.id && has('id') && fm.id !== ctx.id) errors.push(`id "${fm.id}" does not match the file name ${ctx.id}.md`);
  if (has('title') && !fm.title) errors.push('title is empty');
  if (has('origin') && fm.origin !== 'intake') errors.push(`origin is "${fm.origin}"; fi validates only origin: intake specs`);
  if (has('status') && !STATUSES.includes(fm.status)) errors.push(`status "${fm.status}" is not one of ${STATUSES.join(', ')}`);
  if (has('risk') && !RISKS.includes(fm.risk)) errors.push(`risk "${fm.risk}" is not one of ${RISKS.join(', ')}`);
  if (has('delivery') && !DELIVERIES.includes(fm.delivery)) errors.push(`delivery "${fm.delivery}" is not one of ${DELIVERIES.join(', ')}`);
  if (has('source_sha') && !/^(none|sha256:[0-9a-f]{64})$/.test(fm.source_sha)) errors.push(`source_sha "${fm.source_sha}" is not "none" or sha256:<64 hex>`);
  if (has('opportunity') && fm.opportunity !== 'none') errors.push(`an intake spec must not name an opportunity (found "${fm.opportunity}"); product-intelligence specs come from pi handoff`);
  for (const d of parseDeps(fm.depends_on)) {
    if (!FEATURE_ID.test(d)) errors.push(`depends_on has invalid id "${d}"`);
    else if (d === fm.id) errors.push(`depends_on names the spec itself (${d})`);
    else if (ctx.specs && !ctx.specs.has(d)) errors.push(`depends_on names ${d}, which does not exist`);
    else if (ctx.specs && ['draft', 'ready'].includes(fm.status) && ctx.specs.get(d).status === 'draft') warnings.push(`depends_on ${d} is still a draft; the delivery queue refuses a ready spec whose dependency is not ready or implemented, so approve ${d} first`);
  }
  if (ctx.specs && fm.status !== 'superseded' && FEATURE_ID.test(fm.id || '')) {
    const graph = new Map([...ctx.specs].filter(([, s]) => s.status !== 'superseded').map(([d, s]) => [d, parseDeps(s.fm?.depends_on)]));
    graph.set(fm.id, parseDeps(fm.depends_on));
    const c = dependencyCycle(graph, fm.id);
    if (c) errors.push(`dependency cycle ${c.join(' -> ')}; the delivery queue cannot order these specs`);
  }
  errors.push(...headingErrors(body));
  const layout = specRegions(text).problems;
  errors.push(...layout.map((p) => `layout: ${p}`));
  const cr = extractCriteria(text);
  for (const e of cr.errors) if (!layout.includes(e)) errors.push(`criteria: ${e}`);
  if (has('superseded_by')) {
    for (const d of parseDeps(fm.superseded_by)) {
      if (!FEATURE_ID.test(d)) errors.push(`superseded_by has invalid id "${d}"`);
      else if (d === fm.id) errors.push(`superseded_by names the spec itself (${d})`);
      else if (ctx.specs && !ctx.specs.has(d)) errors.push(`superseded_by names ${d}, which does not exist`);
    }
  }
  if (has('parent')) {
    const t = traceCheck(body, fm, cr, ctx);
    errors.push(...t.errors);
    const empty = t.empty.map((a) => `Traces: parent criterion ${fm.parent} ${a} has no child criterion yet`);
    if (fm.status === 'draft') warnings.push(...empty); else errors.push(...empty);
  }
  if (['ready', 'implemented', 'validated'].includes(fm.status) && String(text).includes('{{')) errors.push(`status is ${fm.status} but unfilled {{placeholders}} remain`);
  if (['ready', 'implemented', 'validated'].includes(fm.status)) {
    const rows = historyRows(text); const approval = lastApproval(text);
    if (!approval) errors.push(`ready without approval record: status is ${fm.status} but the Approval history has no approve row (run fi approve)`);
    else if (rows.at(-1).action !== 'approve') errors.push(`ready without approval record: status is ${fm.status} but the last Approval history row is "${rows.at(-1).action}" (run fi approve)`);
    else if (approval.hash !== contentHash(text)) errors.push(`modified_since_approval: the spec changed after it was approved on ${approval.at} by ${approval.by} (run fi reopen, edit, then fi approve)`);
  }
  return { errors, warnings };
}

// ---- Traces (split children) ----------------------------------------------------------------------------------------------
// `## Traces` rows are `| <parent id> AC-n | <child AC ids, comma separated> |`. The parent id prefixes the first cell because a
// row starting with a bare AC id outside Acceptance criteria is a contract error for the factory's extractor.
export const TRACES_HEADER = ['| Parent criterion | Child criterion |', '|------------------|-----------------|'];
const TRACE_PARENT = /^(FEATURE-\d+)\s+(AC-\d+)$/;

// Errors for a spec with `parent:`, plus the parent AC ids whose child cell is still empty (an error or a warning by status).
function traceCheck(body, fm, cr, ctx) {
  const errors = []; const empty = [];
  if (!FEATURE_ID.test(fm.parent)) return { errors: [`parent "${fm.parent}" is not a FEATURE id`], empty };
  if (fm.parent === fm.id) return { errors: [`parent names the spec itself (${fm.parent})`], empty };
  const sec = section(body, 'Traces');
  if (sec === null) return { errors: [`a spec with parent: ${fm.parent} needs a "## Traces" section mapping every parent criterion`], empty };
  const own = new Set(cr.ac.map((a) => a.id));
  const mapped = new Set();
  for (const line of sec.split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]*$/.test(line) || line.trim() === TRACES_HEADER[0]) continue;
    const [p = '', c = ''] = cells(line);
    const m = TRACE_PARENT.exec(p);
    if (!m) { errors.push(`Traces row does not start with "${fm.parent} AC-<n>": ${line.trim().slice(0, 80)}`); continue; }
    if (m[1] !== fm.parent) { errors.push(`Traces row names ${m[1]}, not the parent ${fm.parent}: ${line.trim().slice(0, 80)}`); continue; }
    mapped.add(m[2]);
    const kids = c.split(/[,\s]+/).filter(Boolean);
    if (!kids.length) { empty.push(m[2]); continue; }
    for (const k of kids) if (!own.has(k)) errors.push(`Traces maps ${fm.parent} ${m[2]} to ${k}, which is not an acceptance criterion of this spec`);
  }
  if (ctx.specs) {
    const parent = ctx.specs.get(fm.parent);
    if (!parent) errors.push(`parent ${fm.parent} does not exist`);
    else {
      const pac = extractCriteria(parent.text).ac.map((a) => a.id);
      for (const a of pac) if (!mapped.has(a)) errors.push(`Traces misses parent criterion ${fm.parent} ${a}`);
      for (const a of mapped) if (!pac.includes(a)) errors.push(`Traces names ${fm.parent} ${a}, which is not a criterion of the parent`);
    }
  }
  return { errors, empty };
}

// Mechanical readiness for approval. Never sets a status; only the user's approval does.
export function readiness(text, ctx = {}) {
  const failures = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const ph = lines.findIndex((l) => l.includes('{{'));
  if (ph !== -1) failures.push(`R1 unfilled placeholder on line ${ph + 1}: ${lines[ph].trim().slice(0, 80)}`);
  const cr = extractCriteria(text);
  if (!cr.ok || !cr.ac.length) failures.push(`R2 acceptance criteria do not extract cleanly: ${cr.errors[0] || 'no AC-<n> rows'}`);
  const { fm, body } = parseSpec(text);
  const reqIds = [...new Set((section(body, 'Functional and technical requirements') || '').match(/\b(?:FR|TR)-\d+\b/g) || [])];
  const acText = cr.ac.map((a) => a.text).join(' ');
  const uncovered = reqIds.filter((id) => !new RegExp(`\\b${id}\\b`).test(acText));
  if (uncovered.length) failures.push(`R3 requirement(s) not covered by any AC row: ${uncovered.join(', ')}`);
  const blocking = ((section(body, 'Assumptions and unresolved decisions') || '').match(/\[BLOCKING\]/gi) || []).length;
  if (blocking) failures.push(`R4 ${blocking} [BLOCKING] decision(s) unresolved in Assumptions and unresolved decisions`);
  const scope = (section(body, 'Scope and non-goals') || '').split('\n');
  const ng = scope.findIndex((l) => /^\W*non-goals?\b/i.test(l));
  const ngText = ng === -1 ? '' : [scope[ng].replace(/^\W*non-goals?\b[\s:*_]*/i, ''), ...scope.slice(ng + 1)].join('\n').trim();
  if (!ngText) failures.push('R5 Scope and non-goals has no non-empty "Non-goals" part');
  if (!/`[^`\n]+`/.test(section(body, 'Testing and verification') || '')) failures.push('R6 Testing and verification names no backticked command');
  if (fm.risk === 'high' && !/^\s*Lens:\s*\S/m.test(section(body, 'Security and performance') || '')) failures.push('R7 risk: high needs a line starting "Lens:" in Security and performance');
  for (const d of parseDeps(fm.depends_on)) {
    const dep = ctx.specs?.get(d);
    if (!dep) failures.push(`R8 dependency ${d} does not exist`);
    else if (dep.status === 'superseded') failures.push(`R8 dependency ${d} is superseded`);
  }
  if (Object.hasOwn(fm, 'parent')) {
    const { empty } = traceCheck(body, fm, cr, ctx);
    if (empty.length) failures.push(`R9 Traces has no child criterion for parent criterion(s) ${empty.join(', ')}`);
  }
  return { ok: failures.length === 0, failures };
}

// Hash of the spec with ONLY the Approval history data rows removed (the rows historyRows returns), so appending a row never
// changes it. Everything else is hashed: the `## Approval history` heading, the table header and separator, and any other
// text in or after that section. The factory's mutable regions (`status`/`delivery` lines, trailing `## Delivery log`) are
// excluded as canonicalSpec does. Anyone who can write the file can still forge an approve row with a recomputed hash; the
// factory's criteria_hash (which covers the history rows too) is the second line of defence.
export function contentHash(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const rows = new Set(historyRowIndexes(lines));
  return criteriaHash(canonicalSpec(lines.filter((_, i) => !rows.has(i)).join('\n')));
}

// ---- Approval history ----------------------------------------------------------------------------------------------------
const HISTORY_HEADER = ['| Date | Action | By | Note | Content hash |', '|------|--------|----|------|--------------|'];

// Table cells, split on unescaped "|" and unescaped ("\|" -> "|", "\\" -> "\").
function cells(line) {
  const out = []; let cur = '';
  const t = line.trim().replace(/^\|/, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && i + 1 < t.length) { cur += t[++i]; continue; }
    if (t[i] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += t[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// One table cell from free text: control characters and newlines become spaces, "\" and "|" are escaped.
export const historyCell = (s, max = 300) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max).replace(/[\\|]/g, '\\$&');

function historyBounds(lines) {
  const s = lines.findIndex((l) => isH2(l) && h2Title(l).startsWith('approval history'));
  if (s === -1) return null;
  let e = lines.findIndex((l, i) => i > s && isH2(l));
  if (e === -1) e = lines.length;
  return { s, e };
}

const isHistoryRow = (l) => /^\s*\|/.test(l) && /^\d{4}-\d\d-\d\d$/.test(cells(l)[0] || '') && cells(l).length >= 5;
// Line indexes of the Approval history data rows (table rows whose first cell is a date).
function historyRowIndexes(lines) {
  const b = historyBounds(lines);
  if (!b) return [];
  const out = [];
  for (let i = b.s + 1; i < b.e; i++) if (isHistoryRow(lines[i])) out.push(i);
  return out;
}

// Data rows of the Approval history table, in file order: { date, action, by, note, hash }.
function historyRows(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  return historyRowIndexes(lines).map((i) => cells(lines[i])).map(([date, action, by, note, hash]) => ({ date, action, by, note, hash }));
}

// The last `approve` row, or null.
export function lastApproval(text) {
  const row = historyRows(text).filter((r) => r.action === 'approve').at(-1);
  return row ? { at: row.date, by: row.by, hash: row.hash } : null;
}

// The text with a table header in its Approval history section when the section exists but has no table rows yet (the header
// is hashed by contentHash, so approve adds it before hashing). Otherwise the text unchanged.
export function ensureHistoryTable(text) {
  const lines = String(text).split('\n');
  const b = historyBounds(lines.map((l) => l.replace(/\r$/, '')));
  if (!b) return String(text);
  for (let i = b.s + 1; i < b.e; i++) if (/^\s*\|/.test(lines[i])) return String(text);
  lines.splice(b.s + 1, 0, '', ...HISTORY_HEADER);
  return lines.join('\n');
}

// Insert one row at the end of the Approval history table; every other byte is unchanged. A missing section is created
// before a `## Delivery log`, else at the end. Row values are written as given (escape free text with historyCell).
export function appendHistory(text, row) {
  const line = `| ${row.date} | ${row.action} | ${row.by} | ${row.note} | ${row.hash} |`;
  const lines = String(text).split('\n');
  const b = historyBounds(lines.map((l) => l.replace(/\r$/, '')));
  if (b) {
    let last = -1;
    for (let i = b.s + 1; i < b.e; i++) if (/^\s*\|/.test(lines[i])) last = i;
    if (last === -1) lines.splice(b.s + 1, 0, '', ...HISTORY_HEADER, line);
    else lines.splice(last + 1, 0, line);
    return lines.join('\n');
  }
  const block = ['## Approval history', '', ...HISTORY_HEADER, line, ''];
  const log = lines.findIndex((l) => /^## Delivery log[ \t]*\r?$/.test(l));
  if (log !== -1) { lines.splice(log, 0, ...block); return lines.join('\n'); }
  const t = String(text);
  const sep = t === '' || t.endsWith('\n\n') ? '' : t.endsWith('\n') ? '\n' : '\n\n';
  return t + sep + block.join('\n');
}
