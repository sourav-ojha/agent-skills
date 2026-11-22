// Pins the spec contract the delivery queue and the factory criteria extractor already enforce (existing behaviour, no new code).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, tmpDir } from './helpers.mjs';

const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const { discover, buildQueue } = await import(path.join(LIB, 'queue.mjs'));
const { extractCriteria, criteriaHash, canonicalSpec } = await import(path.join(LIB, 'criteria.mjs'));

const FIX = path.join(REPO, 'tests', 'fixtures', 'intake');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

// Copies a fixture into a fresh temp features dir as FEATURE-001.md; fixtures are never mutated.
function featuresDir(name) {
  const dir = tmpDir('intake-contract-');
  fs.copyFileSync(path.join(FIX, name), path.join(dir, 'FEATURE-001.md'));
  return dir;
}
const hash = (text) => criteriaHash(canonicalSpec(text));

test('valid minimal spec is queued', () => {
  const q = buildQueue(discover(featuresDir('valid-minimal.md')));
  assert.deepEqual(q.map((f) => f.id), ['FEATURE-001']);
  assert.equal(q[0].title, 'Health check endpoint');
});

test('valid minimal spec extracts criteria ok', () => {
  const r = extractCriteria(read('valid-minimal.md'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.ac.length, 1);
  assert.equal(r.ec.length, 1);
  assert.equal(r.er.length, 1);
  assert.deepEqual(r.contract, [{ method: 'GET', path: '/api/health' }]);
});

test('inline-comment status is NOT queued', () => {
  const specs = discover(featuresDir('inline-comment.md'));
  assert.equal(specs.length, 1);
  assert.equal(specs[0].status, 'ready   # draft | ready');
  assert.deepEqual(buildQueue(specs), []);
});

test('parenthesised or merged headings are NOT recognised', () => {
  const r = extractCriteria(read('numbered-paren-headings.md'));
  assert.ok(r.ok === false || r.ac.length === 0);
});

test('in_progress is not queueable', () => {
  const specs = discover(featuresDir('in-progress-status.md'));
  assert.equal(specs[0].status, 'in_progress');
  assert.deepEqual(buildQueue(specs), []);
});

test('criteria hash ignores status, delivery and a trailing Delivery log', () => {
  const a = read('valid-minimal.md');
  const b = a.replace(/^status: ready$/m, 'status: implemented').replace(/^delivery: none$/m, 'delivery: complete')
    + '\n## Delivery log\n\n| Date | Event |\n|------|-------|\n| 2026-11-22 | merged |\n';
  assert.equal(hash(a), hash(b));
  const changed = a.replace('receives HTTP 200', 'receives HTTP 201');
  assert.notEqual(changed, a);
  assert.notEqual(hash(a), hash(changed));
});

test('a Delivery log that is not the last block is hashed', () => {
  const a = read('valid-minimal.md');
  const log = '\n## Delivery log\n\n| Date | Event |\n|------|-------|\n| 2026-11-22 | merged |\n';
  const last = a + log;
  const notLast = a + log + '\n## Appendix\n\nExtra text.\n';
  assert.equal(hash(last), hash(a), 'sanity: a trailing log is excluded');
  assert.notEqual(hash(notLast), hash(a));
  assert.notEqual(hash(notLast), hash(last));
  assert.ok(extractCriteria(notLast).errors.some((e) => /not the last block/.test(e)));
});
