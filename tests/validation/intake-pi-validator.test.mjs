import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, projectFrom, validateJson, edit, hasError } from './helpers.mjs';

const baseline = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected', 'pi-validate-baseline.json'), 'utf8'));
const minimal = fs.readFileSync(path.join(FIXTURES, 'intake', 'valid-minimal.md'), 'utf8').replace('FEATURE-001', 'FEATURE-099');

function withIntake(text = minimal) {
  const dir = projectFrom('a');
  fs.writeFileSync(path.join(dir, '.product', 'features', 'FEATURE-099.md'), text);
  return dir;
}

test('pi fixtures validate identically to the baseline', () => {
  for (const s of ['a', 'b']) {
    const r = validateJson(projectFrom(s));
    assert.deepEqual({ errors: r.errors, warnings: r.warnings }, baseline[s]);
  }
});

test('intake spec without an opportunity passes pi validate', () => {
  const before = validateJson(projectFrom('a')).errors.length;
  const res = validateJson(withIntake());
  assert.equal(res.errors.length, before, res.errors.join('\n'));
});

test('intake spec naming an opportunity errors', () => {
  const res = validateJson(withIntake(minimal.replace('origin: intake', 'origin: intake\nopportunity: OPP-001')));
  assert.ok(hasError(res, 'origin: intake'), res.errors.join('\n'));
});

test('unknown origin errors', () => {
  const res = validateJson(withIntake(minimal.replace('origin: intake', 'origin: bogus')));
  assert.ok(hasError(res, 'unknown origin "bogus"'), res.errors.join('\n'));
});

test('pi spec with a missing opportunity still errors', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/features/FEATURE-001.md', (t) => t.replace(/^opportunity:.*\n/m, ''));
  const res = validateJson(dir);
  assert.ok(hasError(res, 'missing frontmatter "opportunity"'));
  assert.ok(hasError(res, 'opportunity "undefined" not in registry'));
});

test('intake spec is not subject to the 19-section check', () => {
  const res = validateJson(withIntake());
  assert.ok(!res.errors.some((e) => e.includes('FEATURE-099') && /section/i.test(e)), res.errors.join('\n'));
});
