// Regression tests for the second independent review (gate bypasses, source protection, evidence strength).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SKILL, projectFrom, pi, validateJson, edit, hasError, TODAY } from './helpers.mjs';

const lib = (f) => import(path.join(SKILL, 'core', 'scripts', 'lib', f));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const OPPS = '.product/opportunities.md';
const PROD = '.product/PRODUCT.md';

// ---- H1: truncating the Decision Log -------------------------------------------------------------------------------
test('H1: deleting the LAST Decision Log rows and reviving the status is detected', () => {
  const dir = projectFrom('b');
  edit(dir, OPPS, (t) => t.replace(/^\| 2026-11-16 \| OPP-004 \| defer .*\n/m, '').replace('| Deferred | 63', '| Proposed | 63'));
  assert.ok(hasError(validateJson(dir), 'decision_count'));
});

test('H1: deleting every Decision Log row is detected', () => {
  const dir = projectFrom('b');
  edit(dir, OPPS, (t) => t.replace(/^\| 2026-11-16 \| OPP-\d+ \| (approve|reject|defer) .*\n/gm, ''));
  assert.ok(hasError(validateJson(dir), 'logged decisions were deleted') || hasError(validateJson(dir), 'decision_count'));
});

test('H1: rows hidden behind a blank line are reported, not ignored', () => {
  const dir = projectFrom('b');
  edit(dir, OPPS, (t) => t.replace(/(\n)(\| 2026-11-16 \| OPP-004 \| defer )/, '$1\n$2'));
  const res = validateJson(dir);
  assert.ok(hasError(res, 'Decision Log: 1 table row(s) appear after a gap'));
});

test('H1: pi decide keeps the chain head in sync', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['decide', 'OPP-002', 'reject', '--by', 'Ann', '--note', 'user: no']).code, 0);
  const res = validateJson(dir);
  assert.deepEqual(res.errors, []);
  assert.match(read(dir, OPPS), /decision_count: 4/);
});

// ---- H2: source protection ----------------------------------------------------------------------------------------------
function gitRepo(dir, files) {
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  g('init', '-q');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  g('add', '-A');
  g('commit', '-q', '-m', 'x');
}

test('H2: tracked source inside build/, dist/ and target/ folders is still protected', () => {
  const dir = projectFrom('b');
  const files = { 'src/build/compile.js': 'a', 'tools/dist/index.js': 'b', 'crates/x/target/keep.rs': 'c' };
  gitRepo(dir, files);
  assert.equal(pi(dir, ['snapshot']).code, 0);
  for (const f of Object.keys(files)) fs.appendFileSync(path.join(dir, f), '\n// edit\n');
  const r = pi(dir, ['verify-clean']);
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.out).modified.sort(), Object.keys(files).sort());
});

test('H2: untracked output in bulk folders is ignored, permission changes are not', () => {
  const dir = projectFrom('b');
  gitRepo(dir, { 'src/app.js': 'x' });
  assert.equal(pi(dir, ['snapshot']).code, 0);
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build/out.js'), 'generated');
  fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'coverage/lcov.info'), 'x');
  assert.equal(pi(dir, ['verify-clean']).code, 0);
  fs.chmodSync(path.join(dir, 'src/app.js'), 0o755);
  const r = pi(dir, ['verify-clean']);
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.out).modified, ['src/app.js']);
});

// ---- H3: evidence strength ----------------------------------------------------------------------------------------------
function rewriteOpp1Facts(dir, srcs) {
  edit(dir, OPPS, (t) => {
    const start = t.indexOf('### OPP-001');
    const end = t.indexOf('### OPP-002');
    let i = 0;
    const block = t.slice(start, end).replace(/\[E: fact; (high|medium|low); [^\]]*\]/g, (m, c) => `[E: fact; ${c === 'low' ? 'low' : 'high'}; ${srcs[i++ % srcs.length]}]`);
    return t.slice(0, start) + block + t.slice(end);
  });
}

test('H3: ref:, search:, nonexistent repo files and one file cited twice do not support High confidence', () => {
  for (const srcs of [['ref:a reason', 'ref:another reason'], ['search:q1', 'search:q2'], ['repo:ghost.go:1', 'repo:ghost2.go:2'], ['repo:README.md:3', 'repo:README.md:4']]) {
    const dir = projectFrom('b');
    rewriteOpp1Facts(dir, srcs);
    const res = validateJson(dir);
    assert.ok(hasError(res, 'OPP-001') && res.errors.some((e) => /exceeds what the cited evidence supports|cannot back a medium/.test(e)), JSON.stringify(srcs) + ' -> ' + JSON.stringify(res.errors));
  }
});

test('H3: two different existing repo files do support High confidence', async () => {
  const dir = projectFrom('b');
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).slice(0, 2);
  assert.equal(files.length, 2);
  rewriteOpp1Facts(dir, files.map((f) => `repo:${f}:1`));
  assert.ok(!validateJson(dir).errors.some((e) => e.includes('exceeds what the cited evidence supports')));
});

test('H3: search:/ref: facts must be low confidence; missing repo paths warn', async () => {
  const { lintEvidence, repoSourceExists } = await lib('evidence.mjs');
  assert.equal(lintEvidence('[E: fact; high; ref:x; 2026-11-16]', { today: TODAY }).errors.length, 1);
  assert.equal(lintEvidence('[E: inference; medium; ref:x]', { today: TODAY }).errors.length, 0);
  const dir = projectFrom('b');
  assert.equal(repoSourceExists(dir, 'repo:README.md:3'), true);
  assert.equal(repoSourceExists(dir, 'repo:../outside.txt'), false);
  assert.equal(lintEvidence('[E: fact; medium; repo:ghost.md]', { today: TODAY, repoRoot: dir }).warnings.length, 1);
});

// ---- M1: optional interactive-terminal confirmation ----------------------------------------------------------------------
test('M1: gates.human_confirmation=tty makes every human gate refuse a shell without a terminal', () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, '.product/config.json'), JSON.stringify({ gates: { human_confirmation: 'tty' } }));
  const before = read(dir, OPPS);
  const d = pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']);
  assert.notEqual(d.code, 0);
  assert.match(d.err, /interactive terminal/);
  assert.equal(read(dir, OPPS), before);
  const prodBefore = read(dir, PROD);
  for (const c of ['reopen-product', 'confirm-product']) assert.notEqual(pi(dir, [c, '--by', 'Ann']).code, 0, c);
  assert.equal(read(dir, PROD), prodBefore);
  assert.deepEqual(validateJson(dir).errors, []);
});

test('M1: invalid gates config is rejected', () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, '.product/config.json'), JSON.stringify({ gates: { human_confirmation: 'never' } }));
  assert.ok(hasError(validateJson(dir), 'human_confirmation'));
});

// ---- M2: decisions need an approved baseline ----------------------------------------------------------------------------
test('M2: decide and propose are refused while PRODUCT.md is reopened or modified', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['reopen-product', '--by', 'Ann']).code, 0);
  const d = pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']);
  assert.notEqual(d.code, 0);
  assert.match(d.err, /not approved/);
  assert.match(read(dir, OPPS), /\| OPP-002 \| Per-organization rate limits \| Proposed/);

  const dir2 = projectFrom('b');
  edit(dir2, PROD, (t) => t.replace('Reliable, observable', 'Changed, observable'));
  assert.match(pi(dir2, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']).err, /modified after approval/);
});

test('M2: approved_at without a recorded approval is an error even on a draft', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t.replace(/^\| 1 \| 2026-11-16 \| Fixture Owner \| approved .*\n/m, '').replace('status: approved', 'status: draft'));
  assert.ok(hasError(validateJson(dir), 'no approval row'));
});

// ---- M3: forged approval metadata ------------------------------------------------------------------------------------------
test('M3: recomputing the hash and changing approved_by is detected', async () => {
  const { productHash } = await lib('product.mjs');
  const { setFrontmatter } = await lib('fm.mjs');
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => {
    const changed = t.replace('Reliable, observable', 'Changed, observable');
    return setFrontmatter(changed, { content_hash: productHash(changed), approved_by: 'Someone Else' });
  });
  const res = validateJson(dir);
  assert.deepEqual(res.errors.filter((e) => !e.includes('hash')).length, 1);
  assert.ok(hasError(res, 'approval metadata was edited by hand'));
});

test('M3: a forged approval row appended to the history is detected', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t + '| 2 | 2026-11-17 | CEO | approved | Target audience is now enterprise only |\n');
  assert.ok(hasError(validateJson(dir), 'approval metadata was edited by hand'));
});

test('M3: malformed or unknown history rows are errors', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t + '| x | whenever | me | blessed |\n');
  assert.ok(hasError(validateJson(dir), 'Revision History row 2 is malformed'));
});

// ---- M4: reversing an approval --------------------------------------------------------------------------------------------
test('M4: a user can reverse an approval; the spec is retired and revived on re-approval', () => {
  const dir = projectFrom('b');
  const spec = '.product/features/FEATURE-001.md';
  assert.equal(pi(dir, ['decide', 'OPP-001', 'reject', '--by', 'Ann', '--note', 'user: changed my mind']).code, 0);
  assert.match(read(dir, spec), /status: superseded/);
  assert.deepEqual(validateJson(dir).errors, []);
  assert.equal(pi(dir, ['decide', 'OPP-001', 'research', '--by', 'Ann', '--note', 'user: reconsider']).code, 0);
  assert.equal(pi(dir, ['transition', 'OPP-001', 'Proposed']).code, 0);
  assert.equal(pi(dir, ['decide', 'OPP-001', 'approve', '--by', 'Ann', '--note', 'user: yes again']).code, 0);
  assert.match(read(dir, spec), /status: draft/);
  assert.deepEqual(validateJson(dir).errors, []);
});

test('M4: a superseded spec cannot sit next to a live approval, and implemented work cannot be reversed', () => {
  const dir = projectFrom('b');
  edit(dir, '.product/features/FEATURE-001.md', (t) => t.replace('status: ready', 'status: superseded'));
  assert.ok(hasError(validateJson(dir), 'spec is superseded'));
  const dir2 = projectFrom('b');
  edit(dir2, OPPS, (t) => t.replace('| Ready for Implementation | 83', '| Implemented | 83'));
  assert.match(pi(dir2, ['decide', 'OPP-001', 'reject', '--by', 'Ann', '--note', 'x']).err, /cannot move it/);
});

// ---- M5: confirm without a new revision ----------------------------------------------------------------------------------------
test('M5: confirm-product clears the stale-review warning without bumping the revision', () => {
  const dir = projectFrom('b');
  const later = { PI_TODAY: '2027-03-16' };
  const stale = JSON.parse(pi(dir, ['validate', '--json'], { env: later }).out);
  assert.ok(stale.warnings.some((w) => w.includes('last reviewed')));
  const r = pi(dir, ['confirm-product', '--by', 'Fixture Owner', '--note', 'user: still accurate'], { env: later });
  assert.equal(r.code, 0, r.err);
  const after = JSON.parse(pi(dir, ['validate', '--json'], { env: later }).out);
  assert.deepEqual(after.errors, []);
  assert.ok(!after.warnings.some((w) => w.includes('last reviewed')));
  assert.match(read(dir, PROD), /^revision: 1$/m);
  assert.match(read(dir, PROD), /\| reviewed \|/);
});

test('M5: confirm-product refuses a modified or draft baseline', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t.replace('Reliable, observable', 'Changed, observable'));
  assert.match(pi(dir, ['confirm-product', '--by', 'Ann']).err, /modified after approval/);
});

// ---- Low findings ---------------------------------------------------------------------------------------------------------------
test('low: updateRow does not double-escape pipes', async () => {
  const { updateRow, parseRegistry } = await lib('registry.mjs');
  const t = updateRow(read(projectFrom('b'), OPPS), 'OPP-001', { title: 'a|b' });
  assert.equal(parseRegistry(t).rows[0].title, 'a|b');
  assert.equal(parseRegistry(updateRow(t, 'OPP-001', { updated: '2026-11-17' })).rows[0].title, 'a|b');
});

test('low: stray files in features/ are reported', () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, '.product/features/FEATURE-009.MD'), 'x');
  fs.mkdirSync(path.join(dir, '.product/features/extra'));
  fs.writeFileSync(path.join(dir, '.product/features/extra/FEATURE-010.md'), 'x');
  const res = validateJson(dir);
  assert.ok(hasError(res, 'features/FEATURE-009.MD: unexpected entry'));
  assert.ok(hasError(res, 'features/extra: unexpected entry'));
});

test('low: rubric changes warn, custom criteria with digits can be rated', async () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, '.product/config.json'), JSON.stringify({ scoring: { scale_max: 10, tiers: { consider_min: 40 } } }));
  const w = validateJson(dir).warnings.join('\n');
  assert.match(w, /scale_max/);
  assert.match(w, /consider_min/);
  const { parseRatings } = await lib('score.mjs');
  assert.deepEqual(parseRatings('ux2=4, user_value=5'), { ux2: 4, user_value: 5 });
});

test('low: private-host check covers CGNAT and single-label hosts', async () => {
  const { isPrivateHost } = await lib('evidence.mjs');
  for (const h of ['intranet', '100.64.1.1', '100.127.255.255', '10.0.0.1']) assert.equal(isPrivateHost(h), true, h);
  for (const h of ['example.com', '100.128.0.1', '8.8.8.8']) assert.equal(isPrivateHost(h), false, h);
});

test('low: names with quotes or backslashes are refused for --by', () => {
  const dir = projectFrom('b');
  assert.match(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'A"B', '--note', 'x']).err, /--by must be/);
});

// ---- confirmHuman hardening (security review of the tty gate) ----------------------------------------------------------------
test('tty gate: suggested command is shell-quoted, control characters in --note are refused, bad config fails closed', () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, '.product/config.json'), JSON.stringify({ gates: { human_confirmation: 'tty' } }));
  const r = pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', "it's $(touch pwned); ok"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.err.includes("'it'\\''s $(touch pwned); ok'"), r.err);

  const esc = pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'x\u001b[2Jy']);
  assert.match(esc.err, /control characters/);

  fs.writeFileSync(path.join(dir, '.product/config.json'), '{ not json');
  const bad = pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']);
  assert.notEqual(bad.code, 0);
  assert.match(read(dir, OPPS), /\| OPP-002 \| Per-organization rate limits \| Proposed/);
});
