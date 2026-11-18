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

test('specFromBase: reads qualified remote-tracking ref; local origin/<base> tag or branch cannot shadow it', () => {
  const root = tmpDir('crit-'); const origin = path.join(root, 'o.git'); const w = path.join(root, 'w');
  sh(root, 'init', '--bare', '-b', 'main', origin);
  sh(root, 'clone', origin, w);
  sh(w, 'config', 'user.email', 't@t'); sh(w, 'config', 'user.name', 't'); sh(w, 'checkout', '-b', 'main');
  fs.mkdirSync(path.join(w, 'docs')); fs.writeFileSync(path.join(w, 'docs', 's.md'), 'REAL\n');
  sh(w, 'add', '.'); sh(w, 'commit', '-m', 'a'); sh(w, 'push', 'origin', 'main'); sh(w, 'fetch', 'origin');
  fs.writeFileSync(path.join(w, 'docs', 's.md'), 'FAKE\n'); sh(w, 'commit', '-am', 'b');
  sh(w, 'tag', 'origin/main'); sh(w, 'branch', 'origin/main');
  const g = git(w);
  assert.equal(cr.specFromBase(g, 'main', 'docs/s.md').trim(), 'REAL');
  assert.equal(cr.specFromBase(g, 'main', 'docs/missing.md'), null);
  assert.equal(cr.specFromBase(g, 'nobranch', 'docs/s.md'), null);
});
