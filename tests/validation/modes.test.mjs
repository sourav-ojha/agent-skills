// Run modes: widen / override / auto (delegated Gate 1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectFrom, pi, validateJson, edit } from './helpers.mjs';

const CONF = '.product/config.json';
const reopen = (dir) => assert.equal(pi(dir, ['reopen-product', '--by', 'Ann']).code, 0);

test('widen defaults are in the effective config and overridable', () => {
  const dir = projectFrom('a');
  const c = JSON.parse(pi(dir, ['config']).out);
  assert.equal(c.config.research.widen_competitor_multiplier, 2);
  assert.equal(c.config.research.widen_target_candidates, 10);
  assert.equal(c.config.gates.allow_delegated_approval, true);
  fs.writeFileSync(path.join(dir, CONF), JSON.stringify({ research: { widen_target_candidates: 15 } }));
  assert.equal(JSON.parse(pi(dir, ['config']).out).config.research.widen_target_candidates, 15);
  fs.writeFileSync(path.join(dir, CONF), JSON.stringify({ research: { widen_target_candidates: 0 } }));
  assert.ok(JSON.parse(pi(dir, ['config']).out).errors.length);
});

test('delegated approval is recorded as delegated and needs a confidence note', () => {
  const dir = projectFrom('a');
  reopen(dir);
  edit(dir, '.product/PRODUCT.md', (t) => t.replace('Casual users', 'Casual and mobile users'));
  assert.match(pi(dir, ['approve-product', '--by', 'claude-auto', '--delegated']).err, /--note/);
  const r = pi(dir, ['approve-product', '--by', 'claude-auto', '--delegated', '--note', 'all facts repo-backed; 2 assumptions queued']);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).delegated, true);
  const t = fs.readFileSync(path.join(dir, '.product/PRODUCT.md'), 'utf8');
  assert.match(t, /\| claude-auto \| re-approved \| delegated \(auto run\): all facts repo-backed/);
  assert.deepEqual(validateJson(dir).errors, []);
  const st = JSON.parse(pi(dir, ['status']).out);
  assert.equal(st.product.approved_by_delegation, true);
  assert.equal(st.product.approved_by, 'claude-auto');
});

test('a normal approval is not reported as delegated', () => {
  const dir = projectFrom('a');
  assert.equal(JSON.parse(pi(dir, ['status']).out).product.approved_by_delegation, false);
});

test('delegation can be switched off per project', () => {
  const dir = projectFrom('a');
  reopen(dir);
  fs.writeFileSync(path.join(dir, CONF), JSON.stringify({ gates: { allow_delegated_approval: false } }));
  assert.match(pi(dir, ['approve-product', '--by', 'claude-auto', '--delegated', '--note', 'x']).err, /allow_delegated_approval is false/);
});

test('tty mode still demands a person, even for a delegated approval', () => {
  const dir = projectFrom('a');
  reopen(dir);
  fs.writeFileSync(path.join(dir, CONF), JSON.stringify({ gates: { human_confirmation: 'tty' } }));
  assert.match(pi(dir, ['approve-product', '--by', 'claude-auto', '--delegated', '--note', 'x']).err, /interactive terminal/);
});

test('opportunity decisions and other gates can never be delegated', () => {
  const dir = projectFrom('b');
  for (const args of [['decide', 'OPP-002', 'approve', '--by', 'claude-auto', '--note', 'x'], ['reopen-product', '--by', 'x'], ['confirm-product', '--by', 'x']]) {
    const r = pi(dir, [...args, '--delegated']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--delegated applies only to approve-product/);
  }
  const log = fs.readFileSync(path.join(dir, '.product/opportunities.md'), 'utf8');
  assert.doesNotMatch(log, /claude-auto/);
});
