// factory scenarios: spec criteria extraction (AC/EC/ER IDs, HTTP contract), criteria hash, spec read from origin/<base>.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const cr = await import(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', 'criteria.mjs'));

const SPEC = `---
id: FEATURE-001
status: draft
---

# Projects

## 9. Technical considerations

Anything here.

## 10. Acceptance criteria

| ID | Covers | Criterion |
|---|---|---|
| AC-1 | FR-1 | **Given** a user **When** they list projects **Then** they see them |
| AC-2 | FR-2 | **Given** none **When** listing **Then** empty state |

## 11. Edge cases

- EC-1: a project with a 300 char name is truncated
- EC-2: two projects with the same name are allowed

## 12. Error and failure scenarios

- ER-1: db down \u2192 503 with a retry message

## HTTP contract

- \`GET /api/projects?limit=5\`
\`POST /api/projects\`

## 13. Security and privacy considerations

Nothing.

## 19. Implementation handoff

Status: in progress.
`;

test('extractCriteria: ids, texts and contract', () => {
  const c = cr.extractCriteria(SPEC);
  assert.deepEqual(c.ac.map((x) => x.id), ['AC-1', 'AC-2']);
  assert.match(c.ac[0].text, /Given.*Then.*see them/);
  assert.deepEqual(c.ec.map((x) => x.id), ['EC-1', 'EC-2']);
  assert.match(c.ec[0].text, /300 char/);
  assert.deepEqual(c.er.map((x) => x.id), ['ER-1']);
  assert.match(c.er[0].text, /503/);
  assert.deepEqual(c.contract, [{ method: 'GET', path: '/api/projects' }, { method: 'POST', path: '/api/projects' }]);
});

test('extractCriteria: old specs without EC/ER/contract yield empty arrays', () => {
  const old = SPEC.replace(/- EC-\d.*\n/g, '- a plain edge case\n').replace(/- ER-1.*\n/, '- plain failure\n').replace(/## HTTP contract[\s\S]*?(?=## 13)/, '');
  const c = cr.extractCriteria(old);
  assert.deepEqual(c.ec, []); assert.deepEqual(c.er, []); assert.deepEqual(c.contract, []);
  assert.equal(c.ac.length, 2);
});

const hh = (t) => cr.criteriaHash(cr.extractCriteria(t).sections);
const DLOG = '\n## Delivery log\n\n| Date | Delivered |\n|---|---|\n| 2026-11-17 | AC-1 |\n';

test('criteriaHash: only status/delivery frontmatter and the Delivery log are mutable', () => {
  const base = hh(SPEC);
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  const withLog = SPEC + DLOG;
  assert.equal(hh(withLog), base, 'a delivery log does not change the hash');
  assert.equal(hh(withLog.replace('2026-11-17 | AC-1', '2026-12-01 | AC-1, AC-2').replace('| Date', '| Day')), base);
  assert.equal(hh(SPEC.replace('status: draft', 'status: implemented\ndelivery: complete')), base, 'allowlisted frontmatter keys');
  assert.equal(hh(SPEC.replace('status: draft', 'status:   ready  ')), base);
  assert.equal(hh(SPEC.replace(/\n/g, '\r\n')), base, 'CRLF == LF');
  assert.equal(hh(SPEC.replace(/\n/g, '\r')), base, 'CR == LF');
  assert.equal(hh('\ufeff' + SPEC), base, 'BOM');
  assert.equal(hh(SPEC.replace('Nothing.', 'Nothing.  \t ')), base, 'trailing whitespace');
  assert.equal(hh(SPEC.replace('## 9.', '\n\n\n## 9.')), base, 'blank runs collapse');
  // everything else is hashed, including prose in other sections, frontmatter ids, and criteria text
  for (const [a, b] of [['Nothing.', 'Something else.'], ['Anything here.', 'Anything there.'], ['id: FEATURE-001', 'id: FEATURE-002'], ['Status: in progress.', 'Status: done.'],
    ['see them', 'see none'], ['300 char', '200 char'], ['503', '500'], ['POST /api/projects', 'PUT /api/projects'], ['## 10.', '## 10 '], ['  ', ' ']]) {
    if (!SPEC.includes(a)) continue;
    assert.notEqual(hh(SPEC.replace(a, b)), base, `${a} -> ${b}`);
  }
  assert.notEqual(hh(SPEC + '\nextra prose\n'), base);
  assert.notEqual(hh(SPEC.replace('- EC-2:', '    - EC-2:')), base, 'indentation is preserved');
  // an edit that merely moves a heading after the delivery log marker is still hashed
  assert.notEqual(hh(SPEC + DLOG + '## 20. Late section\n\nnew criteria\n'), base);
});

test('mutableRegions: raw line patterns, positive Delivery-log grammar, end exclusive', () => {
  const t = '---\nid: F\nstatus: draft\ndelivery: none\nstatus_note: keep\n---\n# T\n\n## Delivery log\n| r |\n\n| r2 |\n\n';
  assert.deepEqual(cr.mutableRegions(t), [{ start: 2, end: 3 }, { start: 3, end: 4 }, { start: 8, end: 14 }]);
  assert.deepEqual(cr.mutableRegions(t + '## Next\nx\n'), [{ start: 2, end: 3 }, { start: 3, end: 4 }], 'log not last: nothing of it excluded');
  assert.deepEqual(cr.mutableRegions('# T\n\nstatus: draft\n'), []);
  assert.deepEqual(cr.mutableRegions('---\nstatus: draft\n# never closed\n'), [], 'unterminated frontmatter: nothing excluded');
  assert.deepEqual(cr.mutableRegions('---\nstatus: draft\n...\n'), [{ start: 1, end: 2 }], 'YAML "..." closes frontmatter');
  assert.deepEqual(cr.mutableRegions('## Delivery log \n| row |\n'), [{ start: 0, end: 3 }]);
  assert.deepEqual(cr.mutableRegions('## Delivery log\u00a0\n| row |\n'), [], 'only ASCII whitespace after the heading');
  assert.deepEqual(cr.mutableRegions('## Delivery log\n```\n## fake\n```\n| r |\n'), [], 'a non-table, non-blank line after the heading: nothing excluded');
  assert.deepEqual(cr.mutableRegions('\ufeff## Delivery log\r\n| r |\r\n'), [{ start: 0, end: 3 }], 'indexes refer to normalised lines (toLines)');
  assert.equal(cr.toLines('a\r\nb\rc').length, 3);
});

test('frontmatter allowlist: duplicate keys and out-of-enum values are hashed and reported', () => {
  const base = '---\nid: F\nstatus: ready\n---\n# T\n';
  assert.deepEqual(cr.mutableRegions(base), [{ start: 2, end: 3 }]);
  for (const fm of ['status: ready\nstatus: x', 'status: ready\nstatus: ready', 'status: >\n  AC-1 withdrawn', 'status: validated', 'delivery: AC-1 withdrawn', 'status: ready # note']) {
    const t = base.replace('status: ready', fm);
    assert.deepEqual(cr.mutableRegions(t), [], fm);
    assert.notEqual(hh(t), hh(base), fm);
    assert.equal(ex(t).ok, false, fm);
  }
  assert.equal(hh(base.replace('ready', '"implemented"')), hh(base));
  assert.equal(hh(base.replace('status: ready', 'status: ready\ndelivery: partial')), hh(base));
});

test('U+FFFD is an extraction error; hash stays deterministic', () => {
  const t = IAC + '## 11. Edge cases\n\n- EC-1: caf\ufffd\n';
  assert.match(errs(t), /U\+FFFD/);
  assert.equal(hh(t), hh(t));
});

// Delivery-log end delimiter attacks: each must change the hash (the added text is outside the table-row grammar).
const ABASE = '---\nid: F\nstatus: ready\n---\n# Feature\n\n## 10. Acceptance criteria\n\n| ID | Criterion |\n|---|---|\n| AC-1 | Given a user When they list Then they see them |\n\n## 11. Edge cases\n\n- EC-1: empty list returns []\n\n## HTTP contract\n\n- `GET /api/projects`\n';
const ALOG = '\n## Delivery log\n\n| Date | Delivered |\n|---|---|\n| 2026-11-17 | AC-1, AC-2 |\n';
test('delivery log: table rows, new rows and CRLF stay equal', () => {
  const b = hh(ABASE);
  assert.equal(hh(ABASE + ALOG), b);
  assert.equal(hh(ABASE + ALOG + '| 2026-12-01 | AC-3 |\n'), b);
  assert.equal(hh((ABASE + ALOG).replace(/\n/g, '\r\n')), b);
  assert.equal(ex(ABASE + ALOG).ok, true, 'real close-out rows may list AC ids in later cells');
});
const AATT = {
  'A1 indented h2': '\n ## 13. Amended acceptance criteria\n\nAC-1 is withdrawn.\n',
  'A1 3sp h2': '\n   ## 13. Amendments\n\nAC-1 is withdrawn.\n',
  'A2 ##<tab>': '\n##\t13. Amendments\n\nAC-1 is withdrawn.\n',
  'A3 setext -': '\nAmendments\n----------\n\nAC-1 is withdrawn.\n',
  'A3 setext =': '\nAmendments\n==========\n\nAC-1 is withdrawn.\n',
  'A4 h1': '\n# Amendments\n\nAC-1 is withdrawn.\n',
  'A5 html h2': '\n<h2>Amendments</h2>\n\nAC-1 is withdrawn.\n',
  'A5b bare ##': '\n##\n\nAC-1 is withdrawn.\n',
  'A7 indented tracked AC': '\n ## 10. Acceptance criteria\n\n| ID | Criterion |\n|---|---|\n| AC-1 | Given x When y Then everything deleted |\n',
  'A8 indented EC': '\n ## 11. Edge cases\n\n- EC-2: delete all\n',
  'A9 indented contract': '\n ## HTTP contract\n\n- `DELETE /api/projects`\n',
  'prose right after rows': '\nThe endpoint now deletes everything.\n',
};
for (const [name, add] of Object.entries(AATT)) {
  test(`delivery log attack: ${name}`, () => assert.notEqual(hh(ABASE + ALOG + add), hh(ABASE)));
}
test('delivery log attack A13: inserting an empty log before section 11', () => {
  // a bare heading line hides nothing (the region ends immediately at the next heading), so criteria are unchanged
  const bare = ABASE.replace('## 11. Edge cases', '## Delivery log\n## 11. Edge cases');
  assert.deepEqual(ex(bare).ec, ex(ABASE).ec); assert.deepEqual(ex(bare).ac, ex(ABASE).ac);
  assert.notEqual(hh(ABASE.replace('## 11. Edge cases', '## Delivery log\n\n**Amendment:** AC-1 withdrawn.\n\n## 11. Edge cases')), hh(ABASE));
});
test('delivery log: second heading is hashed and reported; criteria id as a row key is an error', () => {
  assert.match(errs(ABASE + ALOG + '\n## Delivery log\n\n| a |\n'), /more than one "## Delivery log"/);
  assert.notEqual(hh(ABASE + ALOG + '\n## Delivery log\n\n| a |\n'), hh(ABASE));
  assert.match(errs(ABASE + ALOG + '| AC-9 | forged |\n'), /Delivery log row starts with a criteria id/);
  // a fenced example of the heading in the base spec exposes only the table rows after it
  const fenced = ABASE.replace('# Feature\n', '# Feature\n\n```\n## Delivery log\n```\n\nThe service MUST never delete data.\n');
  assert.notEqual(hh(fenced.replace('MUST never', 'MAY')), hh(fenced));
});

// ---- round 5: the Delivery log must end the file; strict frontmatter; ASCII-only blank lines --------------------------------
// Base spec with a multi-line comment inside section 10 (round-4 attack): the builder inserts a log heading plus rows after the
// comment opener; `|-->` closes the comment, the amendment table renders inside section 10, `| <!--` hides the rest.
const CBASE = ABASE.replace('## 10. Acceptance criteria\n', '## 10. Acceptance criteria\n\n<!--\nreviewer note: keep AC-1 strict\n-->\n');
const CATTACK = '## Delivery log\n|-->\n\n| Amendment | Criterion |\n|---|---|\n| supersedes AC-1 | Given a user When they list Then all projects are deleted |\n\n| <!--\n';
test('round-4 attack: log rows that close and reopen a base comment change the hash', () => {
  const head = CBASE.replace('<!--\n', '<!--\n' + CATTACK);
  assert.notEqual(hh(head), hh(CBASE));
  assert.equal(ex(head).ok, false);
  assert.match(errs(head), /Delivery log is not the last block/);
  // prose rows work the same way
  const prose = CBASE.replace('<!--\n', '<!--\n## Delivery log\n|-->\n\n| AC-1 now means: all projects are deleted\n\n| <!--\n');
  assert.notEqual(hh(prose), hh(CBASE));
});
test('delivery log must be last: anything after its rows is hashed and reported', () => {
  const t = ABASE + ALOG + '\nThe endpoint now deletes everything.\n';
  assert.deepEqual(cr.mutableRegions(t), [{ start: 2, end: 3 }]);
  assert.notEqual(hh(t), hh(ABASE));
  assert.match(errs(t), /Delivery log is not the last block/);
  assert.equal(ex(ABASE + ALOG + '\n\n\n').ok, true, 'trailing blank lines are fine');
});
test('delivery log: the heading must follow a blank line and must not sit inside an open fence or HTML block', () => {
  // an HTML block (types 6/7) without a blank line swallows the heading and rows as raw text
  const div = ABASE + '\n<div>\nnote';
  assert.notEqual(hh(div + '\n## Delivery log\n| AC-1 is withdrawn |\n'), hh(div));
  assert.match(errs(div + '\n## Delivery log\n| x |\n'), /blank line/);
  // type-1 block left open in the base (<pre> ends only at </pre>, not at a blank line)
  const pre = ABASE + '\n<pre>\nsample\n';
  assert.notEqual(hh(pre + '\n## Delivery log\n| AC-1 is withdrawn |\n'), hh(pre));
  // unclosed fence in the base
  const fence = ABASE + '\n```\nsample\n';
  assert.notEqual(hh(fence + '\n## Delivery log\n| AC-1 is withdrawn |\n'), hh(fence));
  // closed blocks before the log are fine
  assert.equal(hh(CBASE + ALOG), hh(CBASE), 'closed multi-line comment');
  assert.equal(ex(CBASE + ALOG).ok, true);
  assert.equal(hh(ABASE + '\n<pre>\nx\n</pre>\n' + ALOG), hh(ABASE + '\n<pre>\nx\n</pre>\n'));
  assert.equal(hh(ABASE + '\n```\nx\n```\n' + ALOG), hh(ABASE + '\n```\nx\n```\n'));
});
test('delivery log: only ASCII space/tab lines count as blank; table rows need 0-3 spaces of indent', () => {
  for (const ws of ['\u00a0', '\u3000', '\u2003', '\f']) {
    const t = ABASE + ALOG + ws + '\n| 2026-12-01 | AC-2 |\n';
    assert.deepEqual(cr.mutableRegions(t), [{ start: 2, end: 3 }], JSON.stringify(ws));
    assert.notEqual(hh(t), hh(ABASE), JSON.stringify(ws));
  }
  assert.equal(hh(ABASE + ALOG + ' \t\n| 2026-12-01 | AC-2 |\n'), hh(ABASE));
  assert.notEqual(hh(ABASE + ALOG + '    | indented code |\n'), hh(ABASE));
});
test('frontmatter: only when line 0 is exactly --- and line 1 is a key line', () => {
  // a spec that starts with a horizontal rule: "delivery: complete" + "---" is a visible setext heading, so it is hashed
  const hr = '---\n\ndelivery: none\n---\n# T\n';
  assert.deepEqual(cr.mutableRegions(hr), []);
  assert.notEqual(hh(hr.replace('none', 'complete')), hh(hr));
  assert.deepEqual(cr.mutableRegions('---\n# T\nstatus: draft\n---\n'), []);
  assert.deepEqual(cr.mutableRegions('---\nid: F\nstatus: draft\n---\n'), [{ start: 2, end: 3 }]);
  // a frontmatter that product-intelligence's reader would not see the same way is reported (still excluded)
  assert.match(errs('---\nid: F\nstatus: draft\n...\n' + IAC), /product-intelligence/);
  assert.match(errs('\uFEFF---\nid: F\nstatus: draft\n---\n' + IAC), /product-intelligence/);
  assert.equal(ex('---\nid: F\nstatus: draft\n---\n' + IAC).ok, true);
});

// Integrity table: pairs whose rendered criteria differ must hash differently, whatever the parser thinks.
const IAC = '## 10. Acceptance criteria\n\n| ID | C |\n|---|---|\n| AC-1 | Given x When y Then z |\n\n';
const hiddenEc = (pre, post) => (txt) => IAC + '## 13. Notes\n\n' + pre + '\n\n## 11. Edge cases\n\n- EC-1: ' + txt + '\n\n' + post + '\n';
const ctr = (pre, post) => (p) => IAC + '## 13. Notes\n\n' + pre + '\n\n## HTTP contract\n\n- `' + p + '`\n\n' + post + '\n';
const htmlfence = (t) => IAC + '## 13. Notes\n\n<div>\n```\n</div>\n\n## 11. Edge cases\n\n- EC-1: ' + t + '\n\n<div>\n```\n</div>\n';
const nos = (t) => IAC + '## 11. Edge cases\n\n- EC-1: foo\n##x\n  ' + t + '\n';
const nb = (t) => IAC + '## 11. Edge cases\n\n- EC-1: ' + t + '\n';
const INTEGRITY = {
  'comment trick <!-->': [hiddenEc('<!-->', '<!-- -->')('foo'), hiddenEc('<!-->', '<!-- -->')('DELETE ALL')],
  'comment trick <!--->': [hiddenEc('<!--->', '<!-- -->')('foo'), hiddenEc('<!--->', '<!-- -->')('DELETE ALL')],
  'indented code comment': [hiddenEc('Example:\n\n    <!--', '    -->')('foo'), hiddenEc('Example:\n\n    <!--', '    -->')('DELETE ALL')],
  'escaped comment opener': [hiddenEc('Use \\<!-- markers.', 'see above -->')('foo'), hiddenEc('Use \\<!-- markers.', 'see above -->')('DELETE ALL')],
  'inline unterminated comment': [hiddenEc('Text <!-- open', 'x -->')('foo'), hiddenEc('Text <!-- open', 'x -->')('DELETE ALL')],
  'hidden contract section': [ctr('<!-->', '<!-- -->')('GET /a'), ctr('<!-->', '<!-- -->')('DELETE /a')],
  'fence inside HTML block': [htmlfence('foo'), htmlfence('DELETE ALL')],
  '##x is not a heading': [nos('and keeps data'), nos('and deletes data')],
  'NBSP heading': [IAC + '## 11. Edge\u00a0cases\n\n1. EC-1: foo\n', IAC + '## 11. Edge\u00a0cases\n\n1. EC-1: bar\n'],
  'U+2003 heading': [IAC + '## 11. Edge\u2003cases\n\n- EC-1: foo\n', IAC + '## 11. Edge\u2003cases\n\n- EC-1: bar\n'],
  'Cyrillic lookalike heading': [IAC + '## 11. \u0415dge cases\n\n- EC-1: foo\n', IAC + '## 11. \u0415dge cases\n\n- EC-1: bar\n'],
  'indented-code section lookalike': [IAC.trimEnd() + '\n\n## 11. Edge cases\n- EC-1: foo\n', IAC.trimEnd() + '\n\n    ## 11. Edge cases\n    - EC-1: foo\n'],
  'contract DELETE vs GET': [ctr('', '')('GET /a'), ctr('', '')('DELETE /a')],
  'text added anywhere': [nb('foo'), nb('foo') + '\nnew prose\n'],
  'text added before criteria': [nb('foo'), 'Intro.\n\n' + nb('foo')],
  'tab vs spaces indentation': [nb('foo\n    bar'), nb('foo\n\tbar')],
  'mid-line tab vs space': [nb('a b'), nb('a\tb')],
  'NFC vs NFD': [nb('caf\u00e9'), nb('cafe\u0301')],
  'Cyrillic confusable in content': [nb('pay'), nb('p\u0430y')],
  'NUL in content': [nb('a\0b'), nb('ab')],
  'blank line ends lazy continuation': [nb('foo') + 'bar\n', nb('foo') + '\nbar\n'],
  'JSON-ambiguity attempt': [nb('a",""b'), nb('a') + '"",b\n'],
};
for (const [name, [a, b]] of Object.entries(INTEGRITY)) {
  test(`integrity: differs - ${name}`, () => assert.notEqual(hh(a), hh(b)));
}

test('extraction: `##x` is not a heading; unicode-space / lookalike tracked titles are errors', () => {
  assert.equal(ex(IAC + '##Edge cases\n\n- EC-1: x\n').ec.length, 0);
  assert.match(errs(IAC + '##Edge cases\n\n- EC-1: x\n'), /EC item outside/);
  for (const t of ['11. Edge\u00a0cases', '11. Edge\u2003cases', '11. \u0415dge cases', '11. Edge cases\u00a0', '11. \uff25dge cases']) bad(IAC + '## 9b. N\n\n## ' + t + '\n\ntext\n', /imitates tracked section/);
});

test('extraction: <!--> and <!---> are closed comments', () => {
  for (const o of ['<!-->', '<!--->']) {
    const c = ex(IAC + '## 11. Edge cases\n\n' + o + '\n- EC-1: foo\n');
    assert.equal(c.ok, true, o); assert.equal(c.ec.length, 1, o);
  }
});

test('extraction: broadened ID backstop and unextracted ID items', () => {
  for (const item of ['1. EC-1: x', '+ EC-1: x', '- `EC-1`: x', '- &#69;C-1: x', 'EC-1: x', '| EC-1 | x |', '1) EC-1 x', '* **EC-1** x']) {
    bad(IAC + '## 13. Notes\n\n' + item + '\n', /EC item outside/);
  }
  for (const item of ['+ EC-2: y', '1. EC-2: y', '- `EC-2`: y', '- &#69;C-2: y']) {
    bad(IAC + '## 11. Edge cases\n\n- EC-1: x\n' + item + '\n', /unextracted EC ID/);
  }
  bad(IAC.replace('| AC-1 |', '| `AC-1` |'), /unextracted AC ID/);
  bad(IAC + '## 11. Edge cases\n\n1. ER-1: wrong section\n', /ER item outside/);
  assert.equal(ex(IAC + '## 11. Edge cases\n\n- EC-1: x\n\nEC-1 is referenced in prose.\n').ok, true, 'no marker and no punctuation: prose');
  bad(IAC + '## 13. Notes\n\n+ `POST /x`\n', /contract line outside/);
  bad(IAC + '## 13. Notes\n\n| `POST /x` | a |\n', /contract line outside/);
});

test('extraction: multi-line setext tracked title is an error', () => {
  bad(IAC + 'Edge\ncases\n-----\n\ntext\n', /multi-line setext/);
});

const git = (cwd) => (...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '').trim(), err: r.stderr || '' }; };
const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

function mkRepo() {
  const root = tmpDir('crit-'); const origin = path.join(root, 'o.git'); const w = path.join(root, 'w');
  sh(root, 'init', '--bare', '-b', 'main', origin);
  sh(root, 'clone', origin, w);
  sh(w, 'config', 'user.email', 't@t'); sh(w, 'config', 'user.name', 't'); sh(w, 'checkout', '-b', 'main');
  fs.mkdirSync(path.join(w, 'docs')); fs.writeFileSync(path.join(w, 'docs', 's.md'), 'REAL\n');
  sh(w, 'add', '.'); sh(w, 'commit', '-m', 'a'); sh(w, 'push', 'origin', 'main'); sh(w, 'fetch', 'origin');
  return w;
}

test('specFromBase: qualified ref; local origin/<base> tag or branch cannot shadow; failure reasons are distinct', () => {
  const w = mkRepo();
  fs.writeFileSync(path.join(w, 'docs', 's.md'), 'FAKE\n'); sh(w, 'commit', '-am', 'b');
  sh(w, 'tag', 'origin/main'); sh(w, 'branch', 'origin/main');
  const g = git(w);
  const r = cr.specFromBase(g, 'main', 'docs/s.md');
  assert.equal(r.ok, true); assert.equal(r.text.trim(), 'REAL');
  assert.deepEqual(cr.specFromBase(g, 'main', 'docs/missing.md'), { ok: false, reason: 'path_missing' });
  assert.deepEqual(cr.specFromBase(g, 'main', 'docs'), { ok: false, reason: 'not_a_file' });
  assert.deepEqual(cr.specFromBase(g, 'nobranch', 'docs/s.md'), { ok: false, reason: 'ref_missing' });
  assert.deepEqual(cr.specFromBase(() => ({ code: null, out: '', err: 'spawn' }), 'main', 'x'), { ok: false, reason: 'git_error' });
  assert.deepEqual(cr.specFromBase(() => ({ code: 128, out: '', err: 'boom' }), 'main', 'x'), { ok: false, reason: 'git_error' });
});

// ---- fail-closed parsing -------------------------------------------------------------------------------------------------
const ex = (t) => cr.extractCriteria(t);
const errs = (t) => ex(t).errors.join(' | ');

test('template-shaped SPEC parses ok', () => { assert.deepEqual(ex(SPEC).errors, []); assert.equal(ex(SPEC).ok, true); });

test('prefix-collision headings are not tracked; the real section still is', () => {
  const t = SPEC.replace('## 11. Edge cases', '## Edge cases in the importer\n\nprose\n\n## 11. Edge cases').replace('## HTTP contract', '## HTTP contract changes\n\nprose\n\n## HTTP contract');
  const c = ex(t);
  assert.deepEqual(c.ec.map((x) => x.id), ['EC-1', 'EC-2']);
  assert.equal(c.contract.length, 2); assert.equal(c.ok, true);
});

test('duplicate tracked heading is an error and both occurrences are hashed', () => {
  const t = SPEC + '\n## Edge cases\n\n- EC-3: sneaky\n';
  const c = ex(t);
  assert.equal(c.ok, false); assert.match(errs(t), /duplicate tracked heading/);
  assert.ok(c.sections.includes('sneaky'));
});

test('odd number formats and indented headings are recognised', () => {
  const t = SPEC.replace('## 10. Acceptance criteria', '## 10 Acceptance criteria').replace('## 11. Edge cases', '  ## 11) Edge cases').replace('## 12. Error', '## 12) Error');
  const c = ex(t);
  assert.equal(c.ok, true); assert.equal(c.ac.length, 2); assert.equal(c.ec.length, 2); assert.equal(c.er.length, 1);
  assert.equal(ex(SPEC.replace('## 12. Error and failure scenarios', '## 12. Failure scenarios')).er.length, 1);
});

test('setext tracked heading is an error', () => {
  const t = SPEC.replace('## 11. Edge cases', 'Edge cases\n----------');
  assert.match(errs(t), /setext/);
  assert.match(errs(SPEC.replace('## 10. Acceptance criteria', '10. Acceptance criteria\n=====')), /setext/);
});

test('fenced ## inside a tracked section neither ends it nor is parsed', () => {
  const t = SPEC.replace('- EC-2:', '```md\n## 13. Security\n- EC-9: in fence\n```\n- EC-2:');
  const c = ex(t);
  assert.deepEqual(c.ec.map((x) => x.id), ['EC-1', 'EC-2']);
  assert.ok(c.sections.includes('in fence') && c.sections.includes('## 13. Security'));
  assert.equal(c.ok, true);
  // a comment opener inside a fence or inline code is not a comment
  const t2 = SPEC.replace('- EC-2:', '```\n<!--\n```\n- EC-2:');
  assert.deepEqual(ex(t2).ec.map((x) => x.id), ['EC-1', 'EC-2']);
  const t3 = SPEC.replace('- EC-1:', '- EC-1: uses `<!--` literally\n- EC-8:');
  assert.ok(ex(t3).ec.some((x) => x.id === 'EC-2'));
});

test('a heading inside a comment starts no section but is hashed with the enclosing one', () => {
  const t = SPEC.replace('- EC-1:', '<!--\n## 12. Error and failure scenarios\n-->\n- EC-1:');
  const c = ex(t);
  assert.equal(c.ok, true); assert.deepEqual(c.ec.map((x) => x.id), ['EC-1', 'EC-2']);
  assert.ok(c.sections.includes('<!--') && c.sections.includes('## 12. Error and failure scenarios') && c.sections.includes('-->'));
  assert.notEqual(cr.criteriaHash(c.sections), cr.criteriaHash(ex(SPEC).sections));
  // commented-out IDs are not parsed
  assert.deepEqual(ex(SPEC.replace('- EC-2:', '<!-- - EC-7: hidden -->\n- EC-2:')).ec.map((x) => x.id), ['EC-1', 'EC-2']);
});

test('CRLF specs parse and hash like LF specs', () => {
  const crlf = SPEC.replace(/\n/g, '\r\n');
  assert.equal(ex(crlf).ok, true);
  assert.equal(ex(crlf).sections, ex(SPEC).sections);
});

test('contract as the last section; multiple per line; {id} kept; placeholder and prose are errors', () => {
  const head = SPEC.slice(0, SPEC.indexOf('## HTTP contract'));
  const c = ex(head + '## HTTP contract\n\n- `GET /api/projects/{id}` and `DELETE /api/projects/{id}?force=1`\n');
  assert.equal(c.ok, true);
  assert.deepEqual(c.contract, [{ method: 'GET', path: '/api/projects/{id}' }, { method: 'DELETE', path: '/api/projects/{id}' }]);
  assert.match(errs(SPEC.replace('`POST /api/projects`', '`POST /api/{{resource}}`')), /placeholder/);
  assert.match(errs(SPEC.replace('`POST /api/projects`', 'some prose')), /does not parse/);
});

test('missing AC section / no AC rows are errors', () => {
  assert.match(errs(SPEC.replace('## 10. Acceptance criteria', '## 10. Done when')), /missing "Acceptance criteria"/);
  assert.match(errs(SPEC.replace(/\| AC-\d.*\n/g, '')), /no parseable AC/);
  assert.equal(ex('# nothing\n').ok, false);
});

test('duplicate and non-canonical ids are errors; bold AC ids accepted', () => {
  assert.match(errs(SPEC.replace('| AC-2 |', '| AC-1 |')), /duplicate AC id "AC-1"/);
  assert.match(errs(SPEC.replace('| AC-2 |', '| AC-02 |')), /non-canonical id "AC-02"/);
  assert.match(errs(SPEC.replace('| AC-2 |', '| ac-2 |')), /non-canonical id "ac-2"/);
  assert.match(errs(SPEC.replace('EC-2:', 'EC-01:')), /non-canonical id "EC-01"/);
  assert.match(errs(SPEC.replace('EC-2:', 'EC-1:')), /duplicate EC id/);
  const b = ex(SPEC.replace('| AC-2 |', '| **AC-2** |'));
  assert.equal(b.ok, true); assert.deepEqual(b.ac.map((x) => x.id), ['AC-1', 'AC-2']);
});

// ---- round 2: near-miss headings, unclosed constructs, hash encoding, reviewer bypass table -----------------------------------
const AC = '## 10. Acceptance criteria\n\n| ID | C |\n|---|---|\n| AC-1 | Given x When y Then z |\n\n';
const bad = (t, re) => { const c = ex(t); assert.equal(c.ok, false, 'expected !ok'); assert.match(c.errors.join(' | '), re); };

test('near-miss tracked headings are errors (emphasis, colon, comment, zero-width, level, blockquote, suffix)', () => {
  const body = '\n\n- EC-1: foo\n';
  for (const h of ['## 11. **Edge cases**', '## 11. Edge cases:', '## 11. Edge cases <!-- n -->', '## 11. Edge\u200b cases', '## \u00a0Edge cases',
    '# Edge cases', '### Edge cases', '#### Edge cases', '> ## Edge cases', '## 11. Edge cases (optional)', '## 11. Edge cases - later', '## _Edge cases_']) {
    bad(AC + '## 9b. Notes\n\n' + h + body, /imitates tracked section|outside its tracked/);
  }
  bad(AC.replace('## 10.', '### 10.') + '## 11. Edge cases' + body, /imitates tracked section "acceptance criteria"/);
  // canonical heading with closing hashes stays fine; an unrelated longer title is not a near miss
  assert.equal(ex(AC + '## 11. Edge cases ##' + body).ok, true);
  assert.equal(ex(AC + '## 11. Edge cases in the importer' + body.replace('EC-1: foo', 'x')).ok, true);
});

test('backstop: ID-shaped and contract lines outside their tracked section are errors', () => {
  bad(AC + '## 13. Security\n\n- EC-5: hidden\n', /EC item outside/);
  bad('- EC-5: before any heading\n' + AC, /EC item outside/);
  bad(AC + '## 13. Security\n\n- `POST /x`\n', /contract line outside/);
  bad(AC + '## 11. Edge cases\n\n- `POST /x`\n', /contract line outside/);
  assert.equal(ex(AC + '## 13. Security\n\nThe client calls `GET /x` here.\n').ok, true, 'prose mentions are fine');
});

test('unclosed fence / comment at EOF are errors; they no longer swallow later sections silently', () => {
  bad(AC + '## 13. Security\n\n```\n## HTTP contract\n\n- `POST /x`\n', /unclosed code fence/);
  bad(AC + '## 13. Security\n\n<!-- todo\n## HTTP contract\n\n- `POST /x`\n', /unclosed HTML comment/);
  bad(AC.replace('| AC-1', '```\n| AC-1') + '## 11. Edge cases\n\n- EC-1: foo\n', /unclosed code fence/);
});

test('CommonMark fences: backtick info string with a backtick is not a fence; closer must match char and length', () => {
  const e = ex(AC + '## 11. Edge cases\n\n```a`b\n- EC-1: foo\n- EC-2: bar\n');
  assert.equal(e.ok, true); assert.equal(e.ec.length, 2);
  const e2 = ex(AC + '## 11. Edge cases\n\n````\n```\n## 13. X\n- EC-9: q\n````\n- EC-1: foo\n');
  assert.equal(e2.ok, true); assert.deepEqual(e2.ec.map((x) => x.id), ['EC-1']);
  const e3 = ex(AC + '## 11. Edge cases\n\n~~~\n```\n~~~\n- EC-1: foo\n');
  assert.equal(e3.ok, true); assert.deepEqual(e3.ec.map((x) => x.id), ['EC-1']);
});

test('hash encoding: indented code block does not hash like a real section', () => {
  const real = ex(AC.trimEnd() + '\n\n## 11. Edge cases\n- EC-1: foo\n');
  const code = ex(AC.trimEnd() + '\n\n    ## 11. Edge cases\n    - EC-1: foo\n');
  assert.notEqual(cr.criteriaHash(real.sections), cr.criteriaHash(code.sections));
  assert.deepEqual(code.ec, []);
});

test('BOM is stripped; CR-only newlines parse; long lines are an error and fast', () => {
  const t = AC + '## 11. Edge cases\n\n- EC-1: foo\n';
  assert.equal(ex('\uFEFF' + t).ok, true);
  assert.equal(ex('\uFEFF' + t).sections, ex(t).sections);
  assert.equal(ex(t.replace(/\n/g, '\r')).ok, true);
  const t0 = Date.now();
  bad('## a' + ' \t'.repeat(40000) + 'x\n' + t, /longer than/);
  bad('## ' + ' '.repeat(20000) + 'x\n' + t, /longer than/);
  assert.ok(Date.now() - t0 < 1000);
});

test('specFromBase: base validation and non-regular entries', () => {
  const w = mkRepo(); const g = git(w);
  for (const b of ['main~1', 'main^{commit}', 'a..b', '-x', 'main:x', '', 'a b', 'x/']) assert.deepEqual(cr.specFromBase(g, b, 'docs/s.md'), { ok: false, reason: 'invalid_base' }, b);
  fs.symlinkSync('s.md', path.join(w, 'docs', 'link.md')); sh(w, 'add', '.'); sh(w, 'commit', '-m', 'l'); sh(w, 'push', 'origin', 'main'); sh(w, 'fetch', 'origin');
  assert.deepEqual(cr.specFromBase(g, 'main', 'docs/link.md'), { ok: false, reason: 'not_a_file' });
  assert.equal(cr.specFromBase(g, 'main', 'docs/s.md').ok, true);
});
