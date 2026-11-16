// Regression tests for the independent review findings (gate forgery, injection, consistency).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectFrom, pi, validateJson, edit, hasError, tmpDir } from './helpers.mjs';
import { lintEvidence } from '../../skills/product-intelligence/core/scripts/lib/evidence.mjs';

const OPP = '.product/opportunities.md';

test('forgery: hand-editing a status to Approved is detected (no log entry)', () => {
  const dir = projectFrom('b');
  edit(dir, OPP, (t) => t.replace('| OPP-002 | Per-organization rate limits | Proposed |', '| OPP-002 | Per-organization rate limits | Approved |'));
  assert.ok(hasError(validateJson(dir), 'OPP-002: status Approved has no "approve" entry'));
});

test('forgery: a hand-written Decision Log row without a valid seal is detected', () => {
  const dir = projectFrom('b');
  edit(dir, OPP, (t) => t.replace('| OPP-002 | Per-organization rate limits | Proposed |', '| OPP-002 | Per-organization rate limits | Approved |')
    .replace(/(\| 2026-11-16 \| OPP-004 \| defer .*\|\n)/, '$1| 2026-11-16 | OPP-002 | approve | Ann | user: yes | 000000000000 |\n'));
  assert.ok(hasError(validateJson(dir), 'seal "000000000000" does not match'));
});

test('forgery: editing a logged decision, reordering, or deleting rows breaks the chain', () => {
  const dir = projectFrom('b');
  edit(dir, OPP, (t) => t.replace('user: no demand, skip', 'user: actually fine'));
  assert.ok(hasError(validateJson(dir), 'edited by hand or reordered'));
  const d2 = projectFrom('b');
  edit(d2, OPP, (t) => t.split('\n').filter((l) => !/\| OPP-003 \| reject/.test(l)).join('\n'));
  const r = validateJson(d2);
  assert.ok(hasError(r, 'no "reject" entry') || hasError(r, 'edited by hand'));
});

test('forgery: silently reviving a rejected idea or deleting its row is an error', () => {
  const dir = projectFrom('b');
  edit(dir, OPP, (t) => t.replace('| Delivery log CSV export | Rejected |', '| Delivery log CSV export | Under Evaluation |'));
  assert.ok(hasError(validateJson(dir), 'contradicts the latest logged decision "reject"'));
  const d2 = projectFrom('b');
  edit(d2, OPP, (t) => t.split('\n').filter((l) => !/^\| OPP-003 \|/.test(l)).join('\n'));
  assert.ok(hasError(validateJson(d2), 'Decision Log mentions OPP-003 but the registry has no such row'));
});

test('injection: --by and notes cannot add or forge Decision Log rows', () => {
  const dir = projectFrom('b');
  const evil = 'Ann | x |\n| 2026-11-16 | OPP-009 | approve | Owner';
  assert.match(pi(dir, ['decide', 'OPP-002', 'defer', '--by', evil, '--note', 'n']).err, /--by must be/);
  const r = pi(dir, ['decide', 'OPP-002', 'defer', '--by', 'Ann', '--note', 'a | b\n| 2026-11-16 | OPP-009 | approve | Owner | x |']);
  assert.equal(r.code, 0);
  const t = fs.readFileSync(path.join(dir, OPP), 'utf8');
  assert.ok(!/^\| 2026-11-16 \| OPP-009/m.test(t), 'no forged row');
  assert.deepEqual(validateJson(dir).errors, []);
});

test('injection: titles with pipes and $-patterns survive round trips', () => {
  const dir = projectFrom('b');
  edit(dir, OPP, (t) => t.replace('| Per-organization rate limits |', () => "| Rate \\| quota $' limits |"));
  assert.equal(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'ok']).code, 0);
  const r = pi(dir, ['new-feature', 'OPP-002']);
  assert.equal(r.code, 0, r.err);
  const spec = fs.readFileSync(path.join(dir, '.product/features/FEATURE-002.md'), 'utf8');
  assert.ok(spec.split('\n').length < 140, 'spec not duplicated by $ patterns');
  assert.match(spec, /# Rate \| quota \$' limits/);
  assert.ok(!hasError(validateJson(dir), 'invalid status'));
});

test('hash: prose smuggled under Revision History changes the approved baseline', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/PRODUCT.md', (t) => t + '\n### Addendum\nTarget audience is now large enterprises only.\n');
  const r = validateJson(dir);
  assert.ok(hasError(r, 'modified after approval'));
  assert.ok(hasError(r, 'may contain only its table'));
});

test('approve-product validates content first and refuses structurally invalid drafts', () => {
  const dir = projectFrom('a');
  assert.equal(pi(dir, ['reopen-product', '--by', 'Ann']).code, 0);
  edit(dir, '.product/PRODUCT.md', (t) => t.replace(/## 3\. Target audience[\s\S]*?(?=## 4\.)/, '').replace('Casual users', 'FIXME users'));
  const r = pi(dir, ['approve-product', '--by', 'Ann']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /placeholder-like|not valid/);
  assert.match(fs.readFileSync(path.join(dir, '.product/PRODUCT.md'), 'utf8'), /^status: draft$/m, 'file left as draft');
});

test('ready gate: a draft or blocked spec cannot be marked ready for implementation', () => {
  const dir = projectFrom('b');
  pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'ok']);
  pi(dir, ['new-feature', 'OPP-002']);
  // make the spec complete-looking but leave it status: draft
  fs.copyFileSync(path.join(dir, '.product/features/FEATURE-001.md'), path.join(dir, '.product/features/FEATURE-002.md'));
  edit(dir, '.product/features/FEATURE-002.md', (t) => t.replace('id: FEATURE-001', 'id: FEATURE-002').replace('opportunity: OPP-001', 'opportunity: OPP-002').replace('status: ready', 'status: draft'));
  const r = pi(dir, ['transition', 'OPP-002', 'Ready for Implementation']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /status "draft"/);
  edit(dir, '.product/features/FEATURE-002.md', (t) => t.replace('status: draft', 'status: ready').replace('## 18. Unresolved decisions\n', '## 18. Unresolved decisions\n\n- [BLOCKING] need a call'));
  assert.match(pi(dir, ['transition', 'OPP-002', 'Ready for Implementation']).err, /BLOCKING/);
});

test('ready gate: validator flags Ready opportunity whose spec is still draft', () => {
  const dir = projectFrom('a');
  edit(dir, '.product/features/FEATURE-001.md', (t) => t.replace('status: ready', 'status: draft'));
  assert.ok(hasError(validateJson(dir), 'spec is still status: draft'));
});

test('weak evidence: registry confidence cannot exceed what the cited evidence supports', () => {
  const dir = projectFrom('a');
  edit(dir, OPP, (t) => t.replace('| Deferred | 70 | Low | Needs evidence |', '| Deferred | 70 | High | Recommend |'));
  assert.ok(hasError(validateJson(dir), 'OPP-002: confidence High exceeds what the cited evidence supports'));
});

test('weak evidence: one unknown tag no longer satisfies a Proposed opportunity at Medium', () => {
  const dir = projectFrom('b');
  edit(dir, OPP, (t) => t.replace('| OPP-003 | Delivery log CSV export | Rejected | 50 | Low |', '| OPP-003 | Delivery log CSV export | Rejected | 50 | Medium |'));
  assert.ok(hasError(validateJson(dir), 'OPP-003: confidence Medium exceeds'));
});

test('decisions: every decision needs --note and a real value', () => {
  const dir = projectFrom('b');
  assert.match(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann']).err, /--note/);
  assert.match(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note']).err, /needs a value|required/);
});

test('snapshot: --tag cannot escape the snapshot directory', () => {
  const dir = projectFrom('a');
  const r = pi(dir, ['snapshot', '--tag', '../../escape']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /invalid snapshot tag/);
});

test('snapshot: edits to gitignored local files are caught', () => {
  const dir = projectFrom('a');
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'secret.local\n');
  fs.writeFileSync(path.join(dir, 'secret.local'), 'one');
  assert.equal(pi(dir, ['snapshot']).code, 0);
  fs.writeFileSync(path.join(dir, 'secret.local'), 'two');
  const r = pi(dir, ['verify-clean']);
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.out).modified, ['secret.local']);
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules/x.js'), 'ignored bulk dir');
  assert.deepEqual(JSON.parse(pi(dir, ['verify-clean']).out).added, []);
});

test('config: partial nested overrides keep sibling defaults; relaxed caps warn', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.product'));
  fs.writeFileSync(path.join(dir, '.product/config.json'), JSON.stringify({ scoring: { tiers: { recommend_min: 80 } } }));
  const cfg = JSON.parse(pi(dir, ['config']).out).config.scoring;
  assert.equal(cfg.tiers.recommend_min, 80);
  assert.equal(cfg.tiers.consider_min, 55);
  assert.equal(cfg.criteria.user_value, 0.25);
  const dir2 = projectFrom('a');
  fs.writeFileSync(path.join(dir2, '.product/config.json'), JSON.stringify({ scoring: { min_confidence_for_recommend: 'Low' } }));
  assert.ok(validateJson(dir2).warnings.some((x) => x.includes('relaxes the evidence cap')));
});

test('evidence: private and link-local hosts are not public sources; semicolons need encoding', () => {
  for (const host of ['10.0.0.5', '192.168.1.2', '172.20.0.1', '169.254.169.254', 'intranet.internal', 'printer.local']) {
    const r = lintEvidence(`x [E: fact; high; https://${host}/a; 2026-11-01]`, { today: '2026-11-16' });
    assert.ok(r.errors.some((e) => e.includes('public URL')), host);
  }
  assert.deepEqual(lintEvidence('x [E: fact; high; https://8.8.8.8/a; 2026-11-01]', { today: '2026-11-16' }).errors, []);
  assert.deepEqual(lintEvidence('x [E: fact; high; https://example.com/a%3Bb; 2026-11-01]', { today: '2026-11-16' }).errors, []);
});

test('evidence: search: is a valid source for negative results', () => {
  assert.deepEqual(lintEvidence('x [E: unknown; low; search:site, github releases]', { today: '2026-11-16' }).errors, []);
  assert.deepEqual(lintEvidence('x [E: fact; low; search:pricing page checked 2026-11-16]', { today: '2026-11-16' }).errors, []);
  assert.match(lintEvidence('x [E: fact; medium; search:pricing page checked 2026-11-16]', { today: '2026-11-16' }).errors[0], /cannot back a medium\/high-confidence fact/);
});

test('lifecycle: Deferred can only return through a user decision to Under Evaluation', () => {
  const dir = projectFrom('b');
  assert.match(pi(dir, ['transition', 'OPP-004', 'Proposed']).err, /not an agent transition/);
  assert.equal(pi(dir, ['decide', 'OPP-004', 'research', '--by', 'Ann', '--note', 'new evidence']).code, 0);
  assert.deepEqual(validateJson(dir).errors, []);
});
