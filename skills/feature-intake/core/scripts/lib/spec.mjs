// Intake spec rules: frontmatter shape, the shared spec contract (headings, AC/EC/ER grammar, trailing Delivery log) and the
// mechanical readiness rules R1-R8. Deterministic: it never interprets prose. Zero dependencies.
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
  }
  errors.push(...headingErrors(body));
  const layout = specRegions(text).problems;
  errors.push(...layout.map((p) => `layout: ${p}`));
  const cr = extractCriteria(text);
  for (const e of cr.errors) if (!layout.includes(e)) errors.push(`criteria: ${e}`);
  if (['ready', 'implemented', 'validated'].includes(fm.status) && String(text).includes('{{')) errors.push(`status is ${fm.status} but unfilled {{placeholders}} remain`);
  return { errors, warnings };
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
  const blocking = ((section(body, 'Assumptions and unresolved decisions') || '').match(/\[BLOCKING\]/g) || []).length;
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
  return { ok: failures.length === 0, failures };
}

// Hash of the spec content with the Approval history section removed (and the factory's mutable regions excluded).
export function contentHash(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const s = lines.findIndex((l) => isH2(l) && h2Title(l).startsWith('approval history'));
  if (s === -1) return criteriaHash(canonicalSpec(lines.join('\n')));
  let e = lines.findIndex((l, i) => i > s && isH2(l));
  if (e === -1) e = lines.length;
  return criteriaHash(canonicalSpec([...lines.slice(0, s), ...lines.slice(e)].join('\n')));
}
