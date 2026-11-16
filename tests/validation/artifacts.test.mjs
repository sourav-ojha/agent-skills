import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectFrom, validateJson, edit, hasError, pi } from './helpers.mjs';

for (const s of ['a', 'b']) {
  test(`scenario ${s}: reference artifacts validate with zero errors and warnings`, () => {
    const res = validateJson(projectFrom(s));
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
  });
}

test('scenario B: adapts to a complex product (multi-service, conflict recorded, review mode honest)', () => {
  const dir = projectFrom('b');
  const product = fs.readFileSync(path.join(dir, '.product/PRODUCT.md'), 'utf8');
  for (const svc of ['gateway', 'worker', 'dashboard']) assert.match(product, new RegExp(svc, 'i'));
  assert.match(product, /Conflicting evidence[\s\S]*SOC 2/);
  const opp = fs.readFileSync(path.join(dir, '.product/opportunities.md'), 'utf8');
  assert.match(opp, /review_mode: self-review/);
  assert.match(opp, /review_note:/);
});

test('scenario A: prompt injection in the repository is recorded, never obeyed', () => {
  const dir = projectFrom('a');
  const product = fs.readFileSync(path.join(dir, '.product/PRODUCT.md'), 'utf8');
  assert.match(product, /untrusted data and ignored/);
  const st = JSON.parse(pi(dir, ['status']).out);
  assert.equal(st.product.status, 'approved');
  assert.equal(st.product.approved_at, '2026-11-16');
});

test('failure: missing product context', () => {
  const dir = projectFrom('a');
  fs.rmSync(path.join(dir, '.product/PRODUCT.md'));
  assert.ok(hasError(validateJson(dir), 'PRODUCT.md is missing'));
});

test('failure: opportunities for a never-approved product', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/PRODUCT.md', (t) => t.replace(/^approved_at:.*\n/m, '').replace(/^status: approved/m, 'status: draft'));
  assert.ok(hasError(validateJson(dir), 'never approved by the user'));
});

test('failure: silently editing an approved product baseline is detected', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/PRODUCT.md', (t) => t.replace('resizes and compresses one image', 'resizes, compresses and watermarks one image'));
  assert.ok(hasError(validateJson(dir), 'modified after approval'));
});

test('failure: revision history edits do not break the hash', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/PRODUCT.md', (t) => t + '| 1 | 2026-11-16 | Fixture Owner | reviewed | extra row |\n');
  assert.deepEqual(validateJson(dir).errors, []);
});

test('failure: feature spec for an unapproved opportunity', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace('| Ready for Implementation | 83', '| Proposed | 83'));
  const res = validateJson(dir);
  assert.ok(hasError(res, 'specs may only exist for approved opportunities'));
});

test('failure: approval without a logged user decision', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.split('\n').filter((l) => !/\| OPP-001 \| approve \|/.test(l)).join('\n'));
  assert.ok(hasError(validateJson(dir), 'no "approve" entry in the Decision Log'));
});

test('weak evidence: high score at Low confidence cannot be labelled Recommend', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace('| Deferred | 70 | Low | Needs evidence |', '| Deferred | 70 | Low | Recommend |'));
  assert.ok(hasError(validateJson(dir), 'tier "Recommend" != "Needs evidence"'));
});

test('weak evidence: scores must be reproducible from ratings', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace('| Proposed | 83 |', '| Proposed | 95 |').replace('| Ready for Implementation | 83 |', '| Ready for Implementation | 95 |'));
  assert.ok(hasError(validateJson(dir), 'recomputed 83'));
});

test('weak evidence: opportunity without any evidence tag is rejected', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => {
    const i = t.indexOf('### OPP-002');
    const j = t.indexOf('### OPP-003');
    return t.slice(0, i) + t.slice(i, j).replace(/\[E:[^\]]*\]/g, '') + t.slice(j);
  });
  assert.ok(hasError(validateJson(dir), 'OPP-002: no evidence tags'));
});

test('no meaningful competitors: "None found" is valid only with a recorded search', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace(/None found — searched: "image optimization CDN".*\n/, 'None found\n'));
  assert.ok(hasError(validateJson(dir), '"None found" for "Adjacent products and markets" must record what was searched'));
});

test('no meaningful competitors: an empty category is an error, not silence', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace(/### Emerging products\n\nNone found.*\n/, '### Emerging products\n\n'));
  assert.ok(hasError(validateJson(dir), 'category "Emerging products" is empty'));
});

test('no worthwhile opportunities: valid with an evidenced conclusion', () => {
  const dir = projectFrom('a');
  fs.rmSync(path.join(dir, '.product/features'), { recursive: true });
  edit(dir, '.product/opportunities.md', (t) => {
    const reg = t.replace(/^\| OPP-\d+ .*\n/gm, '').replace(/^\| 2026-11-16 \| OPP-.*\n/gm, '');
    const noDetails = reg.slice(0, reg.indexOf('## Opportunity Details'));
    return noDetails.replace('review_mode: independent', 'review_mode: independent\nconclusion: no-actionable-opportunities').replace(/^decision_(count|head):.*\n/gm, '').replace('conclusion: no-actionable-opportunities', 'conclusion: no-actionable-opportunities\ndecision_count: 0')
      + '## Opportunity Details\n\n## Conclusion\n\nNo opportunity cleared the bar: the product already covers the evidenced job and competitor gaps are parity-only [E: inference; medium; ref:Market Landscape; 2026-11-16]. New evidence of batch demand would change this.\n';
  });
  const res = validateJson(dir);
  assert.deepEqual(res.errors, []);
});

test('no worthwhile opportunities: conclusion without evidence is rejected', () => {
  const dir = projectFrom('a');
  fs.rmSync(path.join(dir, '.product/features'), { recursive: true });
  edit(dir, '.product/opportunities.md', (t) => {
    const reg = t.replace(/^\| OPP-\d+ .*\n/gm, '');
    return reg.slice(0, reg.indexOf('## Opportunity Details')).replace('review_mode: independent', 'review_mode: independent\nconclusion: no-actionable-opportunities') + '## Conclusion\n\nNothing worth doing.\n';
  });
  assert.ok(hasError(validateJson(dir), 'needs evidence tags'));
});

test('unavailable sub-agent: self-review needs a reason; pending review blocks proposals', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace('review_mode: independent', 'review_mode: self-review'));
  assert.ok(hasError(validateJson(dir), 'review_note'));
  edit(dir, '.product/opportunities.md', (t) => t.replace('review_mode: self-review', 'review_mode: pending'));
  assert.ok(hasError(validateJson(dir), 'review_mode is still "pending"'));
});

test('invalid or outdated sources are caught inside artifacts', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace('https://example.com/tinypix; 2026-11-16', 'https://example.com/tinypix; 2027-03-01'));
  assert.ok(hasError(validateJson(dir), 'in the future'));
  const dir2 = projectFrom('a');
  edit(dir2, '.product/opportunities.md', (t) => t.replace('https://example.com/tinypix; 2026-11-16', 'https://example.com/tinypix; 2025-01-10'));
  const res = validateJson(dir2);
  assert.deepEqual(res.errors, []);
  assert.ok(res.warnings.some((w) => w.includes('refresh before relying')));
});

test('stale research triggers a refresh warning', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/opportunities.md', (t) => t.replace('last_research: 2026-11-16', 'last_research: 2026-08-01'));
  assert.ok(validateJson(dir).warnings.some((w) => w.includes('consider "refresh"')));
});

test('feature spec quality: placeholders, non-testable criteria and blocking items', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/features/FEATURE-001.md', (t) => t.replace(/\*\*Given\*\*/g, 'Provided'));
  assert.ok(hasError(validateJson(dir), 'Given/When/Then'));
  const d2 = projectFrom('a');
  edit(d2, '.product/features/FEATURE-001.md', (t) => t.replace('## 14. Out of scope', '## 14. Out of scope\n\n{{todo}}'));
  assert.ok(hasError(validateJson(d2), 'placeholder'));
  const d3 = projectFrom('a');
  edit(d3, '.product/features/FEATURE-001.md', (t) => t.replace('- Is analytics acceptable', '- [BLOCKING] Is analytics acceptable'));
  assert.ok(hasError(validateJson(d3), '[BLOCKING]'));
  const d4 = projectFrom('a');
  edit(d4, '.product/features/FEATURE-001.md', (t) => t.replace('## 12. Error and failure scenarios', '## 12. Oops'));
  assert.ok(hasError(validateJson(d4), 'missing section "Error and failure scenarios"'));
});

test('invalid project config is reported', () => {
  const dir = projectFrom('a');
  fs.writeFileSync(path.join(dir, '.product/config.json'), JSON.stringify({ scoring: { criteria: { user_value: -1 } }, bogus: true }));
  const res = validateJson(dir);
  assert.ok(hasError(res, 'unknown key "bogus"'));
  assert.ok(hasError(res, 'minimum'));
});

test('uninitialized project is not an error', () => {
  const dir = projectFrom('a');
  fs.rmSync(path.join(dir, '.product'), { recursive: true });
  assert.deepEqual(validateJson(dir).errors, []);
});
