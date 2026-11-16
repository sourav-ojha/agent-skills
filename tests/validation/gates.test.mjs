import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectFrom, pi, validateJson, edit, tmpDir, FIXTURES } from './helpers.mjs';

test('gate 1: approve-product refuses placeholders and requires --by', () => {
  const dir = tmpDir();
  assert.equal(pi(dir, ['init']).code, 0);
  const noBy = pi(dir, ['approve-product']);
  assert.notEqual(noBy.code, 0);
  assert.match(noBy.err, /--by/);
  const ph = pi(dir, ['approve-product', '--by', 'Ann']);
  assert.notEqual(ph.code, 0);
  assert.match(ph.err, /placeholder-like text/);
});

test('gate 1: full approve → edit → reopen → re-approve cycle with history', () => {
  const dir = projectFrom('a');
  assert.match(pi(dir, ['approve-product', '--by', 'Ann']).err, /already approved/);
  assert.equal(pi(dir, ['reopen-product', '--by', 'Ann', '--note', 'owner corrected audience']).code, 0);
  edit(dir, '.product/PRODUCT.md', (t) => t.replace('Casual users', 'Casual and mobile users'));
  assert.equal(pi(dir, ['approve-product', '--by', 'Ann']).code, 0);
  const t = fs.readFileSync(path.join(dir, '.product/PRODUCT.md'), 'utf8');
  assert.match(t, /^revision: 2$/m);
  assert.match(t, /\| 2 \| 2026-11-16 \| Ann \| re-approved/);
  assert.match(t, /\| 1 \| 2026-11-16 \| Ann \| reopened/);
  assert.deepEqual(validateJson(dir).errors, []);
});

test('gate 2: decisions need a human name and a reason, and only apply to Proposed items', () => {
  const dir = projectFrom('b');
  assert.match(pi(dir, ['decide', 'OPP-002', 'approve']).err, /--by/);
  assert.match(pi(dir, ['decide', 'OPP-002', 'reject', '--by', 'Ann']).err, /--note/);
  assert.match(pi(dir, ['decide', 'OPP-003', 'approve', '--by', 'Ann']).err, /cannot move it to "Approved"/);
  assert.match(pi(dir, ['decide', 'OPP-002', 'maybe', '--by', 'Ann']).err, /unknown decision/);
  const ok = pi(dir, ['decide', 'OPP-002', 'defer', '--by', 'Ann', '--note', 'user: later']);
  assert.equal(ok.code, 0);
  assert.deepEqual(validateJson(dir).errors, []);
});

test('gate 2: the agent cannot approve, reject or defer through transition', () => {
  const dir = projectFrom('b');
  const r = pi(dir, ['transition', 'OPP-002', 'Approved']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /explicit user decision/);
  assert.match(pi(dir, ['transition', 'OPP-003', 'Under Evaluation']).err, /not an agent transition/);
});

test('gate 2: rejected ideas are only reopened by a user decision with a note', () => {
  const dir = projectFrom('b');
  assert.match(pi(dir, ['decide', 'OPP-003', 'research', '--by', 'Ann']).err, /--note/);
  const r = pi(dir, ['decide', 'OPP-003', 'research', '--by', 'Ann', '--note', 'new evidence']);
  assert.equal(r.code, 0);
  assert.match(fs.readFileSync(path.join(dir, '.product/opportunities.md'), 'utf8'), /\| OPP-003 \| Delivery log CSV export \| Under Evaluation/);
});

test('gate 3: no spec for unapproved, deferred or rejected opportunities', () => {
  const dir = projectFrom('b');
  for (const id of ['OPP-002', 'OPP-003', 'OPP-004']) {
    const r = pi(dir, ['new-feature', id]);
    assert.notEqual(r.code, 0, id);
    assert.match(r.err, /only for opportunities the user has approved/);
  }
});

test('gate 3: approved opportunity gets the next FEATURE id and a draft that is not yet valid', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']).code, 0);
  const r = pi(dir, ['new-feature', 'OPP-002']);
  assert.equal(r.code, 0);
  assert.match(r.out, /FEATURE-002/);
  const res = validateJson(dir);
  assert.ok(res.errors.some((e) => e.includes('FEATURE-002.md') && e.includes('placeholder')), 'template must not pass as a finished spec');
  assert.match(pi(dir, ['transition', 'OPP-002', 'Ready for Implementation']).err, /cannot mark ready/);
});

test('gate 3: features require an approved product baseline', () => {
  const dir = projectFrom('b');
  pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'ok']);
  assert.equal(pi(dir, ['reopen-product', '--by', 'Ann']).code, 0);
  assert.match(pi(dir, ['new-feature', 'OPP-002']).err, /not approved/);
});

test('review gate: cannot propose while review is pending', () => {
  const dir = projectFrom('b');
  edit(dir, '.product/opportunities.md', (t) => t.replace('review_mode: self-review', 'review_mode: pending'));
  edit(dir, '.product/opportunities.md', (t) => t.replace('| OPP-004 | Payload search in delivery logs | Deferred |', '| OPP-004 | Payload search in delivery logs | Under Evaluation |'));
  assert.match(pi(dir, ['transition', 'OPP-004', 'Proposed']).err, /review_mode is "pending"/);
});

test('status reports next step through the workflow', () => {
  const dir = tmpDir();
  assert.equal(JSON.parse(pi(dir, ['status']).out).next, 'init');
  pi(dir, ['init']);
  assert.match(JSON.parse(pi(dir, ['status']).out).next, /await product approval/);
  const b = projectFrom('b');
  assert.match(JSON.parse(pi(b, ['status']).out).next, /await user decision/);
  const a = projectFrom('a');
  assert.match(JSON.parse(pi(a, ['status']).out).next, /opportunities/);
});

test('score command reproduces tiering and rejects bad input', () => {
  const dir = tmpDir();
  const ok = JSON.parse(pi(dir, ['score', '--ratings', 'user_value=5,strategic_alignment=5,market_opportunity=5,competitive_differentiation=5,business_impact=5,implementation_feasibility=5', '--confidence', 'Low']).out);
  assert.equal(ok.score, 100);
  assert.equal(ok.tier, 'Needs evidence');
  assert.notEqual(pi(dir, ['score', '--ratings', 'user_value=7']).code, 0);
});

test('custom weights in .product/config.json flow through score', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, '.product'));
  fs.writeFileSync(path.join(dir, '.product/config.json'), JSON.stringify({ scoring: { criteria: { user_value: 1, implementation_feasibility: 1 } } }));
  const cfg = JSON.parse(pi(dir, ['config']).out);
  assert.ok(cfg.config.scoring.criteria.user_value === 1);
  assert.equal(JSON.parse(pi(dir, ['score', '--ratings', 'user_value=5,implementation_feasibility=1', '--confidence', 'High']).out).score, 60);
});
