// Ledger for experience-audit: findings, decisions, fix specs, re-audit. Zero dependencies.
// State fields (status, decided_by, ...) are owned by the helper; a finding file can never preset them.
import fs from 'node:fs';
import path from 'node:path';
import { shortHash } from './checks.mjs';

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
export const EFFORTS = ['S', 'M', 'L'];
export const KINDS = ['measured', 'rule', 'judgment', 'needs-data', 'needs-human-check'];
export const CATEGORIES = ['layout', 'navigation', 'seo', 'a11y', 'performance', 'copy', 'data'];
export const STATUSES = ['open', 'approved', 'rejected', 'deferred', 'needs-evidence', 'verified'];
export const DECISIONS = { approve: 'approved', reject: 'rejected', defer: 'deferred', evidence: 'needs-evidence' };
const SEV_W = { Critical: 5, High: 4, Medium: 3, Low: 2, Info: 0 };
const EFF_W = { S: 1, M: 2, L: 3 };
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const INPUT_KEYS = ['rule', 'route', 'selector', 'category', 'kind', 'severity', 'effort', 'title', 'group', 'evidence', 'proposed_fix', 'acceptance', 'retest', 'passes', 'viewports'];
const GWT = /given\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;

export const paths = (dir) => {
  const base = path.join(path.resolve(dir), '.experience');
  return { base, file: path.join(base, 'findings.json'), decisions: path.join(base, 'decisions.md'), fixes: path.join(base, 'fixes'), evidence: path.join(base, 'evidence'), report: path.join(base, 'report.md') };
};

export function emptyLedger(env) { return { version: 1, created: new Date().toISOString().slice(0, 10), environment: env || 'staging', coverage: { routes: [], viewports: [], states: [], not_covered: [] }, runs: [], findings: [], fixes: [] }; }

export function load(dir) {
  const p = paths(dir);
  if (!fs.existsSync(p.file)) throw new Error(`no audit at ${p.file}; run init first`);
  let l;
  try { l = JSON.parse(fs.readFileSync(p.file, 'utf8')); } catch (e) { throw new Error(`ledger is invalid JSON (${e.message}); restore it from git or re-audit`); }
  if (!l || !Array.isArray(l.findings)) throw new Error('ledger is invalid: expected an object with a findings array');
  return l;
}
export function save(dir, l) {
  const p = paths(dir);
  fs.mkdirSync(p.base, { recursive: true });
  const tmp = `${p.file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2) + '\n');
  fs.renameSync(tmp, p.file);
}

export const findingId = (f) => `F-${shortHash(`${f.rule}|${f.route}|${f.selector || ''}`)}`;
const flat = (x) => String(x).replace(/\s+/g, ' ').trim();

// Returns a list of problems with an incoming finding (empty = acceptable).
export function checkFinding(f, { dir, cap } = {}) {
  const e = [];
  const need = (k) => { if (f[k] === undefined || f[k] === null || f[k] === '') e.push(`missing ${k}`); };
  for (const k of ['rule', 'route', 'category', 'kind', 'severity', 'title', 'group', 'evidence']) need(k);
  if (e.length) return e;
  for (const k of Object.keys(f)) if (!INPUT_KEYS.includes(k)) e.push(`unknown or helper-owned field "${k}"`);
  if (!KINDS.includes(f.kind)) e.push(`kind must be one of ${KINDS.join(', ')}`);
  if (!SEVERITIES.includes(f.severity)) e.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!CATEGORIES.includes(f.category)) e.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (f.effort !== undefined && !EFFORTS.includes(f.effort)) e.push(`effort must be one of ${EFFORTS.join(', ')}`);
  if (!/^\/|^https?:\/\//.test(f.route)) e.push('route must start with "/" or be an absolute URL');
  for (const k of ['rule', 'route', 'selector', 'title', 'group', 'proposed_fix']) if (typeof f[k] === 'string' && UNSAFE.test(f[k])) e.push(`${k} contains control characters`);
  if (typeof f.title === 'string' && f.title.length > 200) e.push('title is longer than 200 characters');
  if (typeof f.evidence !== 'object' || Array.isArray(f.evidence)) return [...e, 'evidence must be an object'];
  const ev = f.evidence;
  const info = f.severity === 'Info';
  if (f.kind === 'measured') { if (!ev.tool) e.push('measured evidence needs evidence.tool'); if (ev.value === undefined || ev.value === '') e.push('measured evidence needs evidence.value'); }
  if (f.kind === 'rule') { if (!ev.cite) e.push('rule evidence needs evidence.cite (the standard or documentation)'); if (ev.value === undefined || ev.value === '') e.push('rule evidence needs evidence.value (what the page shows)'); }
  if (f.kind === 'judgment') {
    if (!['Medium', 'Low', 'Info'].includes(f.severity)) e.push('judgment findings are capped at Medium: they are opinion until measured');
    if (!ev.crop) e.push('judgment evidence needs evidence.crop (an element screenshot under .experience/evidence/)');
    else {
      if (/(^|[\\/])\.\.([\\/]|$)/.test(ev.crop) || path.isAbsolute(ev.crop)) e.push('evidence.crop must be a relative path inside .experience/evidence/');
      else if (dir && cap !== false && !fs.existsSync(path.join(paths(dir).evidence, path.basename(ev.crop)))) e.push(`evidence.crop file not found in .experience/evidence/: ${path.basename(ev.crop)}`);
    }
    if (!ev.numbers || typeof ev.numbers !== 'object' || !Object.keys(ev.numbers).length) e.push('judgment evidence needs evidence.numbers (the measurements that prompted it)');
    const p = f.passes;
    if (!p || !(p.seen >= 2) || !(p.of >= 3) || p.seen > p.of) e.push('judgment findings must be seen in at least 2 of at least 3 independent passes (passes: {seen, of})');
  }
  if (f.kind === 'needs-data') { if (!ev.what_to_pull) e.push('needs-data evidence needs evidence.what_to_pull'); if (!info) e.push('needs-data findings are Info'); }
  if (f.kind === 'needs-human-check' && !info) e.push('needs-human-check findings are Info');
  if (!info) {
    if (typeof f.proposed_fix !== 'string' || !f.proposed_fix.trim()) e.push('missing proposed_fix');
    if (!f.effort) e.push('missing effort');
    if (!Array.isArray(f.acceptance) || !f.acceptance.length || !f.acceptance.every((a) => typeof a === 'string' && GWT.test(a))) e.push('acceptance must be a list of Given/When/Then strings');
  }
  return e;
}

// Add or merge findings. Same id => merge (viewport list grows, evidence refreshed), never a duplicate.
export function addFindings(l, list, { dir, run } = {}) {
  const added = [], merged = [];
  for (const raw of list) {
    const errs = checkFinding(raw, { dir });
    if (errs.length) throw new Error(`invalid finding "${flat(raw.title || raw.rule || '?').slice(0, 80)}": ${errs.join('; ')}`);
    const id = findingId(raw);
    const vp = raw.evidence?.viewport ?? raw.viewports?.[0];
    const cur = l.findings.find((x) => x.id === id);
    if (cur) {
      cur.viewports = [...new Set([...(cur.viewports || []), ...(vp !== undefined ? [vp] : []), ...(raw.viewports || [])])];
      cur.evidence = raw.evidence; cur.title = flat(raw.title); cur.severity = raw.severity;
      if (cur.status === 'verified') { cur.status = 'open'; cur.regressed = true; }
      if (run) cur.seen_in = [...new Set([...(cur.seen_in || []), run])];
      merged.push(id);
    } else {
      const f = { id, ...raw, title: flat(raw.title), retest: raw.retest || raw.rule, viewports: [...new Set([...(raw.viewports || []), ...(vp !== undefined ? [vp] : [])])], status: 'open', decided_by: null, decision_note: null, first_seen: new Date().toISOString().slice(0, 10), seen_in: run ? [run] : [] };
      if (!f.effort) f.effort = 'S';
      l.findings.push(f); added.push(id);
    }
  }
  return { added, merged };
}

const rankOf = (f) => (SEV_W[f.severity] || 0) / (EFF_W[f.effort] || 1);
export function rank(l, top = 25) {
  const open = l.findings.filter((f) => !['rejected', 'verified'].includes(f.status));
  const sorted = open.slice().sort((a, b) => rankOf(b) - rankOf(a) || SEV_W[b.severity] - SEV_W[a.severity] || a.id.localeCompare(b.id));
  const actionable = sorted.filter((f) => f.severity !== 'Info');
  return { top: actionable.slice(0, top), rest: actionable.slice(top), info: sorted.filter((f) => f.severity === 'Info') };
}

export function groups(l) {
  const m = new Map();
  for (const f of l.findings.filter((x) => x.severity !== 'Info' && !['rejected', 'verified'].includes(x.status))) m.set(f.group, [...(m.get(f.group) || []), f]);
  return [...m].map(([group, findings]) => ({ group, findings, score: Math.max(...findings.map(rankOf)), severity: findings.map((f) => f.severity).sort((a, b) => SEV_W[b] - SEV_W[a])[0] })).sort((a, b) => b.score - a.score || a.group.localeCompare(b.group));
}

export function checkBy(by) {
  if (!by || by === true) throw new Error('--by "<name>" is required: record who decided (the human user)');
  const s = String(by).trim();
  if (UNSAFE.test(s) || !/^[^|"\\]{1,80}$/.test(s)) throw new Error('--by must be 1-80 characters without "|", quotes, backslashes or control characters');
  return s;
}
export function checkNote(note) {
  if (!note || note === true) throw new Error('--note "<the user\'s words>" is required: it records what the human actually said');
  const s = String(note).trim();
  if (UNSAFE.test(s)) throw new Error('--note must not contain control characters');
  return s.slice(0, 400);
}

// ids: finding ids or "group:<name>". Appends to decisions.md (append-only) and sets status.
export function decide(l, dir, targets, decision, by, note) {
  const status = DECISIONS[decision];
  if (!status) throw new Error(`unknown decision "${decision}" (use ${Object.keys(DECISIONS).join('|')})`);
  const ids = [];
  for (const t of targets) {
    if (t.startsWith('group:')) { const g = t.slice(6); const fs_ = l.findings.filter((f) => f.group === g && f.severity !== 'Info'); if (!fs_.length) throw new Error(`no findings in group "${g}"`); ids.push(...fs_.map((f) => f.id)); }
    else { if (!l.findings.find((f) => f.id === t)) throw new Error(`unknown finding ${t}`); ids.push(t); }
  }
  const uniq = [...new Set(ids)];
  for (const id of uniq) {
    const f = l.findings.find((x) => x.id === id);
    if (f.severity === 'Info') throw new Error(`${id} is Info (needs data or a human check): it is not decided, it is read`);
    if (f.status === 'verified') throw new Error(`${id} is already verified fixed`);
    f.status = status; f.decided_by = by; f.decision_note = note; f.decided = new Date().toISOString().slice(0, 10);
  }
  const p = paths(dir);
  fs.mkdirSync(p.base, { recursive: true });
  if (!fs.existsSync(p.decisions)) fs.writeFileSync(p.decisions, '# Decisions (append-only)\n\n| Date | Decision | By | Findings | Note |\n|---|---|---|---|---|\n');
  fs.appendFileSync(p.decisions, `| ${new Date().toISOString().slice(0, 10)} | ${decision} | ${by} | ${uniq.join(', ')} | ${flat(note).replace(/\|/g, '/')} |\n`);
  return uniq;
}

// FIX specs for approved groups, consumable by the implementer (acceptance criteria + re-test). Never overwrites.
export function writeFixes(l, dir) {
  const p = paths(dir);
  fs.mkdirSync(p.fixes, { recursive: true });
  const made = [];
  const byGroup = new Map();
  for (const f of l.findings.filter((x) => x.status === 'approved')) byGroup.set(f.group, [...(byGroup.get(f.group) || []), f]);
  for (const [group, fs_] of byGroup) {
    let fx = l.fixes.find((x) => x.group === group);
    if (!fx) { fx = { id: `FIX-${String(l.fixes.length + 1).padStart(3, '0')}`, group, findings: [] }; l.fixes.push(fx); }
    const file = path.join(p.fixes, `${fx.id}.md`);
    fx.findings = [...new Set([...fx.findings, ...fs_.map((f) => f.id)])];
    if (fs.existsSync(file)) continue;
    const crit = [...new Set(fs_.flatMap((f) => f.acceptance || []))];
    const body = [
      '---', `id: ${fx.id}`, 'status: ready', 'source: experience-audit', `group: ${JSON.stringify(group)}`, `findings: [${fx.findings.join(', ')}]`, '---', '',
      `# ${fx.id}: ${fs_[0].title.replace(/\s*\(candidate\)$/, '')}`, '',
      '## Goal', `Resolve the approved audit findings in group \`${group}\` without changing anything else.`, '',
      '## Findings', ...fs_.map((f) => `- **${f.id}** (${f.severity}, effort ${f.effort}, ${f.kind}) ${f.title}\n  - Route: ${f.route}; selector: \`${f.selector || 'n/a'}\`; viewports: ${(f.viewports || []).join(', ') || 'n/a'}\n  - Evidence: \`${JSON.stringify(f.evidence.value ?? f.evidence).slice(0, 300)}\`\n  - Proposed fix: ${f.proposed_fix}`), '',
      '## Acceptance criteria', ...crit.map((c, i) => `${i + 1}. ${c}`), '',
      '## Re-test', `Run the audit again for the routes above (\`reaudit\`). Rules to re-run: ${[...new Set(fs_.map((f) => f.retest))].join(', ')}. A finding is closed only when its probe no longer reports it.`, '',
      '## Non-goals', 'No redesign beyond the findings. No changes to unrelated pages or components.', '',
    ].join('\n');
    fs.writeFileSync(file, body); made.push(fx.id);
  }
  return made;
}

// Close a re-audit run: previously known findings on covered routes/rules that did not reappear are verified fixed.
export function closeRun(l, { run, routes, rules }) {
  const verified = [], regressed = [];
  for (const f of l.findings) {
    if (f.regressed && (f.seen_in || []).includes(run)) regressed.push(f.id);
    if (f.status === 'verified' || (f.seen_in || []).includes(run)) continue;
    if (routes.includes(f.route) && rules.includes(f.retest)) { f.status = 'verified'; f.verified_in = run; verified.push(f.id); }
  }
  l.runs.push({ id: run, date: new Date().toISOString().slice(0, 10), routes, rules, verified: verified.length, regressed: regressed.length });
  return { verified, regressed };
}

export function validateLedger(l, dir) {
  const e = [];
  if (l.version !== 1) e.push('unsupported ledger version');
  const ids = new Set();
  for (const f of l.findings) {
    if (ids.has(f.id)) e.push(`duplicate finding id ${f.id}`); ids.add(f.id);
    if (f.id !== findingId(f)) e.push(`${f.id}: id does not match rule/route/selector (edited by hand)`);
    if (!STATUSES.includes(f.status)) e.push(`${f.id}: bad status "${f.status}"`);
    const { id, status, decided_by, decision_note, decided, first_seen, seen_in, regressed, verified_in, ...input } = f;
    const errs = checkFinding(input, { dir, cap: false });
    for (const m of errs) e.push(`${f.id}: ${m}`);
    if (['approved', 'rejected', 'deferred', 'needs-evidence'].includes(f.status) && (!f.decided_by || !f.decision_note)) e.push(`${f.id}: status ${f.status} without decided_by/decision_note`);
  }
  for (const fx of l.fixes || []) for (const id of fx.findings) if (!ids.has(id)) e.push(`${fx.id}: unknown finding ${id}`);
  if (dir) {
    const p = paths(dir);
    for (const f of l.findings) if (f.evidence?.crop && /(^|[\\/])\.\.([\\/]|$)/.test(f.evidence.crop)) e.push(`${f.id}: crop path escapes the evidence folder`);
    for (const fx of l.fixes || []) if (!fs.existsSync(path.join(p.fixes, `${fx.id}.md`))) e.push(`${fx.id}: fix spec file is missing`);
  }
  return e;
}

export function reportMarkdown(l, top) {
  const { top: t, rest, info } = rank(l, top);
  const cnt = (s) => l.findings.filter((f) => f.status === s).length;
  const lines = [`# Experience audit report`, '', `Environment: ${l.environment}. Findings: ${l.findings.length} (open ${cnt('open')}, approved ${cnt('approved')}, deferred ${cnt('deferred')}, rejected ${cnt('rejected')}, needs evidence ${cnt('needs-evidence')}, verified fixed ${cnt('verified')}).`, ''];
  const c = l.coverage || {};
  lines.push('## Coverage', `- Routes: ${(c.routes || []).join(', ') || 'none recorded'}`, `- Viewports: ${(c.viewports || []).join(', ') || 'none recorded'}`, `- States: ${(c.states || []).join(', ') || 'none recorded'}`, `- Not covered: ${(c.not_covered || []).join('; ') || 'nothing declared'}`, '', 'Absence of a finding means "not found in this coverage", not "no problem".', '');
  lines.push(`## Top ${t.length} by severity / effort`, '', '| ID | Severity | Effort | Kind | Group | Finding | Route |', '|---|---|---|---|---|---|---|');
  for (const f of t) lines.push(`| ${f.id} | ${f.severity} | ${f.effort} | ${f.kind === 'judgment' ? 'judgment (opinion)' : f.kind} | ${f.group} | ${f.title.replace(/\|/g, '/')} | ${f.route} |`);
  if (rest.length) lines.push('', `${rest.length} more below the cutoff: ${rest.map((f) => f.id).join(', ')}.`);
  const g = groups(l);
  if (g.length) { lines.push('', '## Root-cause groups (one fix can clear several findings)', ''); for (const x of g) lines.push(`- **${x.group}**: ${x.findings.length} finding(s), worst ${x.severity}: ${x.findings.map((f) => f.id).join(', ')}`); }
  const nd = info.filter((f) => f.kind === 'needs-data'), nh = info.filter((f) => f.kind === 'needs-human-check'), ni = info.filter((f) => !['needs-data', 'needs-human-check'].includes(f.kind));
  if (nd.length) { lines.push('', '## Needs data (you pull this; the audit does not guess)', ''); for (const f of nd) lines.push(`- ${f.title}: ${f.evidence.what_to_pull}`); }
  if (nh.length) { lines.push('', '## Needs a human check (automated tools could not decide)', ''); for (const f of nh) lines.push(`- ${f.title}`); }
  if (ni.length) { lines.push('', '## Notes', ''); for (const f of ni) lines.push(`- ${f.title}`); }
  lines.push('', '## Decision sheet', 'Reply per finding or group: approve, reject, defer, or evidence (needs more evidence). Example: "approve group:nav:footer, reject F-1a2b3c4d".', '');
  return lines.join('\n');
}
