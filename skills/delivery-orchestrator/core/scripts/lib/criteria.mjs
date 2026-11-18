// Spec criteria extraction: AC table, EC / ER lists and the optional HTTP contract; a hash over those sections only.
//
// FAIL-CLOSED: scenarios are bound to criteriaHash(sections), so a parse that silently drops a section would let a spec
// edit slip past the anchor. extractCriteria therefore returns { errors, ok }. Consumers (the scenario lint, Task 4) MUST
// refuse to bind or accept scenarios when ok === false. criteriaHash stays a pure function of `sections`.
//
// Hash notes: `sections` holds, for every tracked section in document order, its normalised heading line (INCLUDING the
// section number, so renumbering a section invalidates bound scenarios - intended) and its whitespace-collapsed raw body,
// comments and code fences included. IDs and contract entries are parsed only from text outside comments and fences.
// Contract paths keep placeholders such as /api/projects/{id}; only the query string / fragment is stripped.
import { createHash } from 'node:crypto';

const TITLES = {
  'acceptance criteria': 'ac',
  'edge cases': 'ec',
  'error and failure scenarios': 'er',
  'failure scenarios': 'er',
  'http contract': 'contract',
};
const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const trackedKey = (title) => TITLES[norm(title.replace(/^[\d.)\s§-]*/, '')).toLowerCase()];

// Walk one line outside a fence: returns the visible text (comments removed, inline code respected) and the comment state after it.
function scanLine(line, inComment) {
  let vis = '';
  for (let i = 0; i < line.length;) {
    if (inComment) {
      const j = line.indexOf('-->', i);
      if (j === -1) return { vis, inComment: true };
      inComment = false; i = j + 3; continue;
    }
    if (line[i] === '`') {
      let n = 0; while (line[i + n] === '`') n++;
      const close = line.indexOf('`'.repeat(n), i + n);
      if (close !== -1) { vis += line.slice(i, close + n); i = close + n; continue; }
      vis += line.slice(i, i + n); i += n; continue;
    }
    if (line.startsWith('<!--', i)) { inComment = true; i += 4; continue; }
    vis += line[i++];
  }
  return { vis, inComment };
}

function splitSections(text, errors) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const found = { ac: [], ec: [], er: [], contract: [] };
  const order = [];
  let fence = null; let inComment = false; let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    let vis; let startsInComment = inComment;
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*$/.test(line.slice(f[0].length))) fence = null;
      vis = null;
    } else if (f && !inComment) {
      fence = f[1]; vis = null;
    } else {
      const s = scanLine(line, inComment); vis = s.vis; inComment = s.inComment;
    }
    if (!fence || vis !== null || cur) { /* fallthrough: boundary logic below */ }
    if (vis !== null && !startsInComment) {
      const h = /^ {0,3}##\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
      if (h && !/^#/.test(h[1])) {
        const key = trackedKey(h[1]);
        if (key) {
          if (found[key].length) errors.push(`duplicate tracked heading "${norm(line)}"`);
          cur = { heading: norm(line), raw: [], vis: [] }; found[key].push(cur); order.push(cur);
        } else cur = null;
        continue;
      }
      // setext heading: a title line followed by a line of only = or -
      if (vis.trim() && !/^\s*[#|>]/.test(vis) && i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1]) && trackedKey(vis)) {
        errors.push(`unsupported heading style (setext) for "${norm(vis)}"; use "## " headings`);
      }
    }
    if (cur) { cur.raw.push(line); cur.vis.push(vis); }
  }
  return { found, order };
}

export function extractCriteria(specText) {
  const errors = [];
  const { found, order } = splitSections(specText, errors);
  const vis = (k) => found[k].flatMap((s) => s.vis.filter((l) => l !== null && l.trim()));

  const ac = [];
  for (const line of vis('ac')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const id = (cells[0] ?? '').replace(/^\*+|\*+$/g, '').trim();
    if (/^ac[-_ ]?\d+$/i.test(id)) {
      if (!/^AC-[1-9]\d*$/.test(id)) errors.push(`non-canonical id "${id}" (expected AC-<n>)`);
      ac.push({ id, text: norm(cells.slice(1).join(' ')) });
    }
  }
  const list = (k, p) => {
    const out = [];
    const re = new RegExp(`^\\s*[-*]\\s+\\**(${p}[-_ ]?\\d+)\\**\\s*[:.)-]?\\s*(.*)$`, 'i');
    const canon = new RegExp(`^${p}-[1-9]\\d*$`);
    for (const line of vis(k)) {
      const m = re.exec(line);
      if (!m) continue;
      if (!canon.test(m[1])) errors.push(`non-canonical id "${m[1]}" (expected ${p}-<n>)`);
      out.push({ id: m[1], text: norm(m[2]) });
    }
    return out;
  };
  const ec = list('ec', 'EC');
  const er = list('er', 'ER');
  for (const [k, items] of [['AC', ac], ['EC', ec], ['ER', er]]) {
    const seen = new Set();
    for (const { id } of items) { if (seen.has(id)) errors.push(`duplicate ${k} id "${id}"`); seen.add(id); }
  }

  const contract = [];
  const re = new RegExp('`\\s*(' + METHODS + ')\\s+(/[^\\s`?#]*)[^`]*`', 'gi');
  for (const line of vis('contract')) {
    if (line.includes('{{')) { errors.push(`HTTP contract line has a template placeholder: ${norm(line)}`); continue; }
    let n = 0;
    for (const m of line.matchAll(re)) { contract.push({ method: m[1].toUpperCase(), path: m[2] }); n++; }
    if (!n) errors.push(`HTTP contract line does not parse as \`METHOD /path\`: ${norm(line)}`);
  }

  if (!found.ac.length) errors.push('missing "Acceptance criteria" section');
  else if (!ac.length) errors.push('Acceptance criteria section has no parseable AC-<n> rows');

  const sections = order.map((s) => [s.heading, ...s.raw.map(norm).filter(Boolean)].join('\n')).join('\n');
  return { ac, ec, er, contract, sections, errors, ok: errors.length === 0 };
}

export const criteriaHash = (sections) => `sha256:${createHash('sha256').update(String(sections)).digest('hex')}`;

// git: injected (...argv) => {code,out,err}. Fully qualified ref so a local tag/branch named origin/<base> cannot shadow it.
// Returns { ok:true, text } or { ok:false, reason: 'ref_missing'|'path_missing'|'not_a_file'|'git_error' }.
export function specFromBase(git, base, specPath) {
  const ref = `refs/remotes/origin/${base}`;
  const rv = git('rev-parse', '--verify', '--quiet', ref);
  if (rv.code === 1) return { ok: false, reason: 'ref_missing' };
  if (rv.code !== 0) return { ok: false, reason: 'git_error' };
  const t = git('cat-file', '-t', `${ref}:${specPath}`);
  if (t.code === null || t.code === undefined) return { ok: false, reason: 'git_error' };
  if (t.code !== 0) return { ok: false, reason: 'path_missing' };
  if (String(t.out).trim() !== 'blob') return { ok: false, reason: 'not_a_file' };
  const b = git('cat-file', 'blob', `${ref}:${specPath}`);
  if (b.code !== 0) return { ok: false, reason: 'git_error' };
  return { ok: true, text: b.out };
}
