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

- ER-1: db down → 503 with a retry message

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

test('criteriaHash: stable across other sections, sensitive to criteria sections', () => {
  const h = (t) => cr.criteriaHash(cr.extractCriteria(t).sections);
  const base = h(SPEC);
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h(SPEC.replace('status: draft', 'status: ready').replace('Status: in progress.', 'Status: done.  ').replace('Nothing.', 'Something else.')), base);
  assert.equal(h(SPEC.replace('a user **When**', 'a user   **When**  ')), base, 'whitespace collapsed');
  assert.notEqual(h(SPEC.replace('see them', 'see none')), base);
  assert.notEqual(h(SPEC.replace('300 char', '200 char')), base);
  assert.notEqual(h(SPEC.replace('503', '500')), base);
  assert.notEqual(h(SPEC.replace('POST /api/projects', 'PUT /api/projects')), base);
  // moving content between sections changes the hash (headings are part of the text)
  const moved = SPEC.replace('- EC-2: two projects with the same name are allowed\n', '').replace('- ER-1:', '- EC-2: two projects with the same name are allowed\n- ER-1:');
  assert.notEqual(h(moved), base);
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
  assert.ok(!c.sections.includes('importer'));
});

test('duplicate tracked heading is an error and both occurrences are hashed', () => {
  const t = SPEC + '\n## Edge cases\n\n- EC-3: sneaky\n';
  const c = ex(t);
  assert.equal(c.ok, false); assert.match(errs(t), /duplicate tracked heading/);
  assert.ok(c.sections.includes('sneaky'));
});

test('odd number formats and indented headings are recognised', () => {
  const t = SPEC.replace('## 10. Acceptance criteria', '## 10 Acceptance criteria').replace('## 11. Edge cases', '  ## 11) Edge cases').replace('## 12. Error', '## §12 Error');
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
  assert.ok(c.sections.includes('<!--') && c.sections.includes('## 12. Error and failure scenarios\n-->'));
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
