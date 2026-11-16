import test from 'node:test';
import assert from 'node:assert/strict';
import { lintEvidence } from '../../skills/product-intelligence/core/scripts/lib/evidence.mjs';
import { computeScore, computeTier, parseRatings } from '../../skills/product-intelligence/core/scripts/lib/score.mjs';
import { loadConfig } from '../../skills/product-intelligence/core/scripts/lib/config.mjs';
import { splitFrontmatter, setFrontmatter } from '../../skills/product-intelligence/core/scripts/lib/fm.mjs';

const today = '2026-11-16';
const lint = (s) => lintEvidence(s, { file: 't.md', today, maxAgeDays: 180 });
const { config } = loadConfig(null);

test('evidence: valid tags of every class pass', () => {
  const r = lint(`a [E: fact; high; https://example.com/x; 2026-11-01]
b [E: fact; high; repo:src/a.js:3]
c [E: inference; medium; ref:a; 2026-11-01]
d [E: hypothesis; low; n/a]
e [E: assumption; low; n/a]
f [E: unknown; low; user:searched twice]`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.tags.length, 6);
});

test('evidence: rejects unsupported certainty', () => {
  assert.match(lint('x [E: hypothesis; high; n/a]').errors[0], /hypothesis must have low/);
  assert.match(lint('x [E: inference; high; ref:a]').errors[0], /inference cannot be high/);
  assert.match(lint('x [E: assumption; high; n/a]').errors[0], /assumption cannot be high/);
});

test('evidence: fact needs a real source', () => {
  assert.match(lint('x [E: fact; high; n/a]').errors[0], /requires a source/);
  assert.match(lint('x [E: fact; high; trust me]').errors[0], /fact source must be/);
});

test('evidence: URL sources need valid, non-future, public accessed dates', () => {
  assert.match(lint('x [E: fact; high; https://example.com/a]').errors[0], /needs an accessed date/);
  assert.match(lint('x [E: fact; high; https://example.com/a; 2026-13-40]').errors[0], /invalid accessed date/);
  assert.match(lint('x [E: fact; high; https://example.com/a; 2027-01-01]').errors[0], /in the future/);
  assert.match(lint('x [E: fact; high; http://localhost:3000/a; 2026-11-01]').errors[0], /public/);
  assert.match(lint('x [E: fact; high; https://; 2026-11-01]').errors[0], /invalid URL|fact source/);
});

test('evidence: stale sources warn, malformed tags error', () => {
  const r = lint('x [E: fact; high; https://example.com/a; 2025-01-01]');
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings[0], /days ago/);
  assert.match(lint('x [E: fact high repo:a]').errors[0], /malformed/);
  assert.match(lint('x [E: guess; low; n/a]').errors[0], /unknown evidence class/);
});

test('score: default weights reproduce a known score', () => {
  const r = computeScore(parseRatings('user_value=5, strategic_alignment=5, market_opportunity=4, competitive_differentiation=3, business_impact=3, implementation_feasibility=4'), config);
  assert.equal(r.score, 83);
  assert.equal(computeScore(parseRatings('user_value=5,strategic_alignment=5,market_opportunity=5,competitive_differentiation=5,business_impact=5,implementation_feasibility=5'), config).score, 100);
  assert.equal(computeScore(parseRatings('user_value=1,strategic_alignment=1,market_opportunity=1,competitive_differentiation=1,business_impact=1,implementation_feasibility=1'), config).score, 20);
});

test('score: invalid ratings are rejected, not guessed', () => {
  assert.ok(computeScore({ user_value: 5 }, config).errors.some((e) => e.includes('missing rating')));
  const all = Object.fromEntries(Object.keys(config.scoring.criteria).map((k) => [k, 3]));
  assert.ok(computeScore({ ...all, user_value: 9 }, config).errors.some((e) => e.includes('1-5')));
  assert.ok(computeScore({ ...all, bogus: 3 }, config).errors.some((e) => e.includes('unknown criterion')));
});

test('score: configurable weights change the result and are normalized', () => {
  const custom = structuredClone(config);
  custom.scoring.criteria = { user_value: 1, implementation_feasibility: 1 };
  assert.equal(computeScore({ user_value: 5, implementation_feasibility: 1 }, custom).score, 60);
});

test('tier: high score with weak evidence is not a recommendation', () => {
  assert.equal(computeTier(90, 'High', config), 'Recommend');
  assert.equal(computeTier(90, 'Medium', config), 'Recommend');
  assert.equal(computeTier(90, 'Low', config), 'Needs evidence');
  assert.equal(computeTier(60, 'Low', config), 'Needs evidence');
  assert.equal(computeTier(60, 'High', config), 'Consider');
  assert.equal(computeTier(30, 'High', config), 'Backlog');
});

test('frontmatter: round trip keeps body and unknown keys', () => {
  const src = '---\na: 1\nb: "x: y"\n---\nbody\n';
  assert.equal(splitFrontmatter(src).data.b, 'x: y');
  const out = setFrontmatter(src, { a: 2, c: 'new' });
  const { data, body } = splitFrontmatter(out);
  assert.deepEqual([data.a, data.b, data.c, body], ['2', 'x: y', 'new', 'body\n']);
});
