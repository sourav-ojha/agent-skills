// Spec criteria: (1) the INTEGRITY anchor and (2) best-effort extraction for scenario COVERAGE.
//
// (1) INTEGRITY. criteriaHash(sections) is sha256 over a canonical encoding of the WHOLE spec text except explicit mutable
// regions found with RAW LINE PATTERNS only (no Markdown model): see mutableRegions(). `sections` (kept under that name for
// consumers) is that canonical encoding: a JSON array of lines (CRLF/CR -> LF, BOM stripped, trailing spaces/tabs trimmed,
// leading indentation preserved, blank-line runs collapsed). Any base-spec edit outside the mutable regions, including
// prose, comments, renumbering or section moves, changes the hash and invalidates bound scenarios (intended). If anything
// fools the delimiters, MORE text is hashed (worst case a false "spec changed"), never less. The anchor does not depend on
// any parse of headings, fences or comments.
// Mutable regions: (a) frontmatter lines whose key is `status` or `delivery` (exactly what the implementer close-out writes:
// skills/implementer/references/close-out.md, and `pi transition` toggling status); (b) the `## Delivery log` section, only
// when it is the last block of the file (heading plus table rows to EOF; see specRegions).
// Accepted residuals (no wording can change): blank-line runs are collapsed and trailing spaces trimmed, so extra empty lines
// inside a code block or a two-space hard break are not hashed.
//
// (2) EXTRACTION (ids, contract, errors) only drives the scenario coverage lint. It is best-effort, NOT the integrity anchor.
// It is fail-closed on what it can see (errors/ok; consumers MUST refuse to bind scenarios when ok === false) but it does not
// model HTML blocks, so visible EC/ER/contract items hidden by HTML-block or comment tricks can be missed: a coverage gap
// only, never an integrity bypass (the hidden text is still hashed).
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
const trackedKey = (title) => TITLES[norm(title.replace(/^[\d.)\s\u00a7-]*/, '')).toLowerCase()];

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
    if (line.startsWith('<!--', i)) {
      const k = line.indexOf('-->', i + 2); // <!--> and <!---> are complete comments
      if (k === -1) { inComment = true; break; }
      i = k + 3; continue;
    }
    vis += line[i++];
  }
  return { vis, inComment };
}

export const MAX_LINE = 10000; // also the G5 pre-parse guard in antigaming.mjs (hostile head specs are refused before parsing)
// ---- integrity anchor ---------------------------------------------------------------------------------------------------
// Allowlisted frontmatter keys and the only values the close-out / `pi transition` write ("validated" is never written by the
// implementer). A key that is duplicated, or has any other value, is NOT excluded (so it is hashed) and is reported.
const MUTABLE_FM = { status: new Set(['draft', 'ready', 'implemented', 'superseded']), delivery: new Set(['none', 'partial', 'complete']) };
// Same normalisation the hash uses; region indexes refer to these lines (Task 5 G5 must diff against these too).
export const toLines = (text) => String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

const BLANK = /^[ \t]*$/; // ASCII space/tab only: a line of Unicode spaces or \f is NOT blank (it ends the log region)
const ROW = /^ {0,3}\|/; // 4+ spaces would be an indented code block
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// HTML block types 1-5 (CommonMark): they do not end at a blank line, only at their end marker.
const HTML_OPEN = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/], [/^ {0,3}<\?/, /\?>/], [/^ {0,3}<![A-Za-z]/, />/], [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];

// True when the text before line `end` leaves a construct open that would swallow the following lines (a fence, an HTML block
// of types 1-5, or an HTML comment as the extractor sees it). Deliberately over-detects: a false positive only hashes more.
function openConstructBefore(lines, end) {
  let fence = null; let html = null; let inComment = false;
  for (let i = 0; i < end; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*$/.test(f[2])) fence = null;
      continue;
    }
    if (html) {
      const m = html.exec(line);
      if (m) { html = null; inComment = scanLine(line.slice(m.index + m[0].length), false).inComment; }
      continue;
    }
    if (!inComment) {
      if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = f[1]; continue; }
      const blk = HTML_OPEN.find(([open, close]) => { const m = open.exec(line); return m && !close.test(line.slice(m[0].length)); });
      if (blk) { html = blk[1]; continue; }
    }
    inComment = scanLine(line, inComment).inComment;
  }
  return Boolean(fence || html || inComment);
}

// product-intelligence's reader (skills/product-intelligence/core/scripts/lib/fm.mjs splitFrontmatter): CRLF -> LF only, no BOM
// strip, opener exactly "---\n", closer the first "\n---" followed by "\n" or EOF. Returns the closing line index or -1.
function piFrontmatterClose(specText) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(String(specText).replace(/\r\n/g, '\n'));
  return m ? m[1].split('\n').length + 1 : -1;
}

// { lines, regions: [{start,end}] (0-based, end exclusive, indexes into `lines`), problems: string[] }.
// Frontmatter is recognised only when line 0 is exactly `---` and line 1 is a YAML key line (so a spec opening with a horizontal
// rule has none); it closes at the first `---` or `...` line.
// Delivery log = POSITIVE grammar that must END THE FILE (close-out.md appends it as the last section): the `## Delivery log`
// line (column 0, ASCII), preceded by a blank line, not inside an open fence / HTML block / comment, followed only by lines that
// are blank (ASCII space/tab) or table rows (/^ {0,3}\|/) up to EOF. If anything else follows, or the heading is not cleanly
// placed, NOTHING of the log is excluded (all of it is hashed) and a problem is reported.
// G5 (Task 5): consumers must compute regions from the HEAD file they are checking, or compare canonicalSpec(base) with
// canonicalSpec(head). Never reuse regions computed from the base file to mask lines of the head file.
export function specRegions(specText) {
  const lines = toLines(specText);
  const regions = []; const problems = [];
  if (lines.length > 1 && /^---[ \t]*$/.test(lines[0]) && /^[A-Za-z_][\w-]*:/.test(lines[1])) {
    const close = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
    if (close > 0 && piFrontmatterClose(specText) !== close) {
      problems.push('frontmatter is delimited differently from what product-intelligence reads (use exactly "---" lines, no BOM, no "..." close)');
    }
    if (close > 0) {
      const seen = {};
      for (let i = 1; i < close; i++) {
        const m = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(lines[i]);
        if (m && MUTABLE_FM[m[1]]) (seen[m[1]] ||= []).push({ i, v: m[2].replace(/^(["'])(.*)\1$/, '$2') });
      }
      for (const [k, occ] of Object.entries(seen)) {
        if (occ.length > 1) { problems.push(`duplicate frontmatter key "${k}" (not excluded from the hash)`); continue; }
        if (!MUTABLE_FM[k].has(occ[0].v)) { problems.push(`frontmatter "${k}: ${occ[0].v.slice(0, 40)}" is not a value the close-out writes (not excluded from the hash)`); continue; }
        regions.push({ start: occ[0].i, end: occ[0].i + 1 });
      }
      regions.sort((x, y) => x.start - y.start);
    }
  }
  const heads = [];
  for (let i = 0; i < lines.length; i++) if (/^## Delivery log[ \t]*$/.test(lines[i])) heads.push(i);
  if (heads.length > 1) problems.push('more than one "## Delivery log" heading (only the first is excluded from the hash)');
  if (heads.length) {
    const d = heads[0];
    let e = d + 1;
    while (e < lines.length && (BLANK.test(lines[e]) || ROW.test(lines[e]))) e++;
    if (e < lines.length) problems.push(`Delivery log is not the last block (line ${e + 1} is not a table row); the log is not excluded from the hash`);
    else if (d > 0 && !BLANK.test(lines[d - 1])) problems.push('"## Delivery log" must follow a blank line; the log is not excluded from the hash');
    else if (openConstructBefore(lines, d)) problems.push('"## Delivery log" sits inside an open code fence, HTML block or comment; the log is not excluded from the hash');
    else regions.push({ start: d, end: e });
    for (let i = d + 1; i < e; i++) {
      const first = lines[i].trim().replace(/^\|/, '').split('|')[0].replace(/[*_`\s]/g, '');
      if (/^(AC|EC|ER)[-_]?\d+$/i.test(first)) problems.push(`Delivery log row starts with a criteria id: ${lines[i].trim().slice(0, 60)}`);
    }
  }
  return { lines, regions, problems };
}

export const mutableRegions = (specText) => specRegions(specText).regions;

function trimEndSpTab(t) {
  let b = t.length;
  while (b > 0 && (t[b - 1] === ' ' || t[b - 1] === '\t')) b--;
  return t.slice(0, b);
}

export function canonicalSpec(specText) {
  const { lines, regions } = specRegions(specText);
  const skip = new Set();
  for (const r of regions) for (let i = r.start; i < r.end; i++) skip.add(i);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip.has(i)) continue;
    const l = trimEndSpTab(lines[i]);
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return JSON.stringify(out);
}

function stripComments(t) {
  let out = ''; let i = 0;
  for (;;) {
    const j = t.indexOf('<!--', i);
    if (j === -1) return out + t.slice(i);
    out += t.slice(i, j);
    const k = t.indexOf('-->', j + 2); // <!--> and <!---> are complete comments
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
  if (rest && !/^[ \t]/.test(rest)) return null; // "##x" is not a heading
  let title = trimSpTab(rest);
  let e = title.length;
  while (e > 0 && title[e - 1] === '#') e--;
  if (e < title.length && (e === 0 || /\s/.test(title[e - 1]))) title = trimSpTab(title.slice(0, e));
  return { level: m[1].length, title, spaced: /^[ \t]/.test(rest) };
}

const CONFUSABLES = { '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd', '\u0261': 'g', '\u03bf': 'o', '\u03bd': 'v', '\u03b9': 'i', '\u0415': 'e', '\u0410': 'a', '\u0421': 'c', '\u041e': 'o', '\u0420': 'p', '\u041d': 'h', '\u041a': 'k', '\u041c': 'm', '\u0422': 't', '\u0425': 'x', '\u0412': 'b' };
// ASCII skeleton of a title: NFKC, zero-width removed, Unicode spaces to ' ', common Cyrillic/Greek lookalikes folded.
function skeleton(t) {
  return String(t).normalize('NFKC').replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s/g, ' ')
    .replace(/[^\x00-\x7f]/g, (c) => CONFUSABLES[c] ?? c);
}

// Title with emphasis, comments, ALL non-ASCII, a trailing colon and the number prefix removed; lower-cased.
function looseTitle(t, keepNonAscii = false) {
  let x = stripComments(t).replace(/[*_`]/g, '');
  if (!keepNonAscii) x = x.replace(/[^\x00-\x7f]/g, '');
  x = norm(x.replace(/^[\d.)\s\u00a7-]*/, '')).toLowerCase();
  return x;
}

// Returns a tracked title this heading text imitates without being canonical, else null.
// NOTE: product-intelligence's validator matches section titles with startsWith, so "## 11. Edge cases (optional)" passes
// there while being ignored here; it is reported as an error here. The validator should be aligned in a follow-up.
function nearMiss(title) {
  const loose = looseTitle(title);
  if (TITLES[loose]) return loose;
  const sk = looseTitle(skeleton(title));
  if (TITLES[sk]) return sk;
  const kept = looseTitle(title, true);
  for (const t of Object.keys(TITLES)) {
    if (kept.startsWith(t)) {
      const rem = kept.slice(t.length);
      if (rem && rem.length <= 40 && /^\s*(\(.*\)|[:\-\u2013\u2014].*)$/.test(rem)) return t;
    }
  }
  return null;
}

// An ID-shaped line: optional list/table marker (-, *, +, 1., 1), |), optional emphasis/backticks, then AC/EC/ER-n. Without a
// marker it must be followed by : . or ) (a plain "EC-1: ..." paragraph line). Numeric entities are decoded first.
function idLike(vis) {
  const d = vis.replace(/&#(x?)([0-9a-f]{1,6});/gi, (m, x, n) => { const c = parseInt(n, x ? 16 : 10); return c < 0x110000 ? String.fromCodePoint(c) : m; });
  const m = /^\s*((?:[-*+]|\d+[.)])\s+|\|\s*)?[*_`\s]*(AC|EC|ER)[-_ ]?\d+(.?)/i.exec(d);
  if (!m) return null;
  return m[1] || /[:.)]/.test(m[3]) ? m[2].toLowerCase() : null;
}
const CONTRACT_LINE = new RegExp('^\\s*(?:(?:[-*+]|\\d+[.)])\\s+|\\|\\s*)?`\\s*(?:' + METHODS + ')\\s+/', 'i');
const UNDERLINE = /^ {0,3}(=+|-+)\s*$/;

function splitSections(text, errors) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
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
          cur = { key, heading: norm(line), raw: [], vis: [], idLike: 0 }; found[key].push(cur); order.push(cur);
          continue;
        }
        const nm = nearMiss(h.title);
        if (nm) errors.push(`heading "${norm(line)}" imitates tracked section "${nm}" but is not a plain "## " heading; fix the heading`);
        else if (!inQuote && h.level === 2) cur = null;
      } else if (vis.trim() && !/^\s*[#|>]/.test(vis)) {
        if (i + 1 < lines.length && UNDERLINE.test(lines[i + 1]) && (trackedKey(vis) || nearMiss(vis))) {
          errors.push(`unsupported heading style (setext) for "${norm(vis)}"; use "## " headings`);
        } else if (i + 2 < lines.length && lines[i + 1].trim() && !UNDERLINE.test(lines[i + 1]) && UNDERLINE.test(lines[i + 2])) {
          const joined = norm(`${vis} ${lines[i + 1]}`);
          if (trackedKey(joined) || nearMiss(joined)) errors.push(`unsupported heading style (multi-line setext) for "${joined}"; use "## " headings`);
        }
      }
      // Backstop: ID-shaped or contract-shaped lines must sit in their own tracked section.
      const kind = idLike(vis);
      if (kind) {
        if (!cur || cur.key !== kind) errors.push(`${kind.toUpperCase()} item outside its tracked section: ${norm(vis).slice(0, 80)}`);
        else cur.idLike++;
      }
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
  if (String(specText).includes('\ufffd')) errors.push('spec contains U+FFFD (invalid UTF-8 or a replacement character); fix the file encoding');
  errors.push(...specRegions(specText).problems);
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
  for (const [k, items] of [['ac', ac], ['ec', ec], ['er', er]]) {
    const seen = found[k].reduce((n, sct) => n + sct.idLike, 0);
    if (seen > items.length) errors.push(`${seen - items.length} unextracted ${k.toUpperCase()} ID item(s) in the ${k.toUpperCase()} section (use "- ${k.toUpperCase()}-<n>: ..." or a table row; no "+"/numbered/backticked items)`);
  }
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

  const sections = canonicalSpec(specText);
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
