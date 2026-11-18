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

const MAX_LINE = 10000;
const norm_ = norm;
// Collapse whitespace runs but keep the leading indentation width (tab = 4) as a prefix, so an indented code block that
// looks like a section does not hash like a real one.
function normKeepIndent(line) {
  const rest = norm_(line);
  if (!rest) return '';
  let w = 0;
  for (const ch of line) { if (ch === ' ') w++; else if (ch === '\t') w += 4; else break; }
  return `${w}:${rest}`;
}

function stripComments(t) {
  let out = ''; let i = 0;
  for (;;) {
    const j = t.indexOf('<!--', i);
    if (j === -1) return out + t.slice(i);
    out += t.slice(i, j);
    const k = t.indexOf('-->', j + 4);
    if (k === -1) return out;
    i = k + 3;
  }
}

function trimSpTab(t) {
  let a = 0; let b = t.length;
  while (a < b && (t[a] === ' ' || t[a] === '\t')) a++;
  while (b > a && (t[b - 1] === ' ' || t[b - 1] === '\t')) b--;
  return t.slice(a, b);
}

// ATX-ish heading (levels 1-6), parsed linearly. canonical = "## " plus space/tab (the only form the sections use).
function parseAtx(line) {
  const m = /^ {0,3}(#{1,6})/.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length);
  if (rest && rest[0] === '#') return null;
  let title = trimSpTab(rest);
  let e = title.length;
  while (e > 0 && title[e - 1] === '#') e--;
  if (e < title.length && (e === 0 || /\s/.test(title[e - 1]))) title = trimSpTab(title.slice(0, e));
  return { level: m[1].length, title, spaced: /^[ \t]/.test(rest) };
}

// Title with emphasis, comments, ALL non-ASCII, a trailing colon and the number prefix removed; lower-cased.
function looseTitle(t, keepNonAscii = false) {
  let x = stripComments(t).replace(/[*_`]/g, '');
  if (!keepNonAscii) x = x.replace(/[^\x00-\x7f]/g, '');
  x = norm(x.replace(/^[\d.)\s§-]*/, '')).toLowerCase();
  return x;
}

// Returns a tracked title this heading text imitates without being canonical, else null.
// NOTE: product-intelligence's validator matches section titles with startsWith, so "## 11. Edge cases (optional)" passes
// there while being ignored here; it is reported as an error here. The validator should be aligned in a follow-up.
function nearMiss(title) {
  const loose = looseTitle(title);
  if (TITLES[loose]) return loose;
  const kept = looseTitle(title, true);
  for (const t of Object.keys(TITLES)) {
    if (kept.startsWith(t)) {
      const rem = kept.slice(t.length);
      if (rem && rem.length <= 40 && /^\s*(\(.*\)|[:\-–—].*)$/.test(rem)) return t;
    }
  }
  return null;
}

const ID_LINE = /^\s*(?:[-*+]\s+|\|\s*)\**(AC|EC|ER)[-_ ]?\d+/i;
const CONTRACT_LINE = new RegExp('^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?`\\s*(?:' + METHODS + ')\\s+/', 'i');

function splitSections(text, errors) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const found = { ac: [], ec: [], er: [], contract: [] };
  const order = [];
  let fence = null; let inComment = false; let cur = null; let longLine = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE) {
      if (!longLine) errors.push(`line ${i + 1} is longer than ${MAX_LINE} characters`);
      longLine = true;
      if (cur) { cur.raw.push(line.slice(0, 200)); cur.vis.push(null); }
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const opens = f && !(f[1][0] === '`' && f[2].includes('`'));
    let vis; const startsInComment = inComment;
    if (fence) {
      if (opens && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*$/.test(f[2])) fence = null;
      vis = null;
    } else if (opens && !inComment) {
      fence = f[1]; vis = null;
    } else {
      const sc = scanLine(line, inComment); vis = sc.vis; inComment = sc.inComment;
    }
    if (vis !== null && !startsInComment) {
      let quoted = line; let inQuote = false;
      while (/^ {0,3}>/.test(quoted)) { quoted = quoted.replace(/^ {0,3}> ?/, ''); inQuote = true; }
      const h = parseAtx(quoted);
      if (h) {
        const key = !inQuote && h.level === 2 && h.spaced && /^[\x00-\x7f]*$/.test(h.title) ? trackedKey(h.title) : undefined;
        if (key) {
          if (found[key].length) errors.push(`duplicate tracked heading "${norm(line)}"`);
          cur = { key, heading: norm(line), raw: [], vis: [] }; found[key].push(cur); order.push(cur);
          continue;
        }
        const nm = nearMiss(h.title);
        if (nm) errors.push(`heading "${norm(line)}" imitates tracked section "${nm}" but is not a plain "## " heading; fix the heading`);
        else if (!inQuote && h.level === 2) cur = null;
      } else if (vis.trim() && !/^\s*[#|>]/.test(vis) && i + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1]) && (trackedKey(vis) || nearMiss(vis))) {
        errors.push(`unsupported heading style (setext) for "${norm(vis)}"; use "## " headings`);
      }
      // Backstop: ID-shaped or contract-shaped lines must sit in their own tracked section.
      const im = ID_LINE.exec(vis);
      if (im && (!cur || cur.key !== im[1].toLowerCase())) errors.push(`${im[1].toUpperCase()} item outside its tracked section: ${norm(vis).slice(0, 80)}`);
      if (CONTRACT_LINE.test(vis) && (!cur || cur.key !== 'contract')) errors.push(`HTTP contract line outside the "HTTP contract" section: ${norm(vis).slice(0, 80)}`);
    }
    if (cur) { cur.raw.push(line); cur.vis.push(vis); }
  }
  if (fence) errors.push('unclosed code fence at end of file');
  if (inComment) errors.push('unclosed HTML comment at end of file');
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

  const sections = JSON.stringify(order.map((s) => [s.heading, s.raw.map(normKeepIndent).filter(Boolean)]));
  return { ac, ec, er, contract, sections, errors, ok: errors.length === 0 };
}

export const criteriaHash = (sections) => `sha256:${createHash('sha256').update(String(sections)).digest('hex')}`;

// git: injected (...argv) => {code,out,err}. Fully qualified ref so a local tag/branch named origin/<base> cannot shadow it.
// Returns { ok:true, text } or { ok:false, reason: 'invalid_base'|'ref_missing'|'path_missing'|'not_a_file'|'git_error' }.
// Existence is decided from `git ls-tree` output (locale independent): empty = missing, a regular-file blob = readable.
export function specFromBase(git, base, specPath) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(String(base)) || String(base).includes('..') || String(base).endsWith('.lock') || String(base).endsWith('/')) return { ok: false, reason: 'invalid_base' };
  if (!specPath || /[\0\n:]/.test(String(specPath))) return { ok: false, reason: 'git_error' };
  const ref = `refs/remotes/origin/${base}`;
  const rv = git('rev-parse', '--verify', '--quiet', ref);
  if (rv.code === 1) return { ok: false, reason: 'ref_missing' };
  if (rv.code !== 0) return { ok: false, reason: 'git_error' };
  const t = git('ls-tree', '-z', ref, '--', specPath);
  if (t.code !== 0) return { ok: false, reason: 'git_error' };
  const entry = String(t.out).split('\0').filter(Boolean).map((l) => /^(\d+) (\w+) ([0-9a-f]{40,64})\t([\s\S]*)$/.exec(l)).find((m) => m && m[4] === specPath);
  if (!entry) return { ok: false, reason: 'path_missing' };
  if (entry[2] !== 'blob' || !/^100(644|755)$/.test(entry[1])) return { ok: false, reason: 'not_a_file' };
  const b = git('cat-file', 'blob', entry[3]);
  if (b.code !== 0) return { ok: false, reason: 'git_error' };
  return { ok: true, text: b.out };
}
