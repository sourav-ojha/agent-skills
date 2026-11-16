// Regression tests for the third independent review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SKILL, PI, REPO, TODAY, projectFrom, pi, validateJson, edit, hasError, tmpDir } from './helpers.mjs';

const lib = (f) => import(path.join(SKILL, 'core', 'scripts', 'lib', f));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const OPPS = '.product/opportunities.md';
const PROD = '.product/PRODUCT.md';
const CONF = '.product/config.json';

// ---- H-A: tty mode must accept a real person at a real terminal ------------------------------------------------------
const PTY = `
import os, pty, sys, select, time
pid, fd = pty.fork()
if pid == 0:
    os.execvpe('node', ['node'] + sys.argv[2:], os.environ)
answer = sys.argv[1].encode() + b'\\n'
buf = b''; sent = False; end = time.time() + 30
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try: data = os.read(fd, 4096)
        except OSError: break
        if not data: break
        buf += data
        if b'to confirm' in buf and not sent:
            os.write(fd, answer); sent = True
_, status = os.waitpid(pid, 0)
print(os.WEXITSTATUS(status)); sys.stdout.write(buf.decode('utf8', 'replace'))
`;
const havePty = spawnSync('python3', ['-c', 'import pty, select']).status === 0;

function viaPty(dir, answer, args) {
  const r = spawnSync('python3', ['-c', PTY, answer, PI, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, PI_TODAY: TODAY } });
  const [code, ...rest] = r.stdout.split('\n');
  return { code: Number(code), out: rest.join('\n') };
}

test('H-A: tty mode accepts "yes" from a real terminal and records the decision; anything else is refused', { skip: !havePty && 'python3 pty not available' }, () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, CONF), JSON.stringify({ gates: { human_confirmation: 'tty' } }));
  const no = viaPty(dir, 'no', ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']);
  assert.notEqual(no.code, 0, no.out);
  assert.match(read(dir, OPPS), /\| OPP-002 \| Per-organization rate limits \| Proposed/);
  const yes = viaPty(dir, 'yes', ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']);
  assert.equal(yes.code, 0, yes.out);
  assert.match(read(dir, OPPS), /\| OPP-002 \| Per-organization rate limits \| Approved/);
  assert.deepEqual(validateJson(dir).errors, []);
  assert.ok(yes.out.includes('Type "yes" to confirm'));
});

test('H-A: reopen/confirm/approve also work from a real terminal', { skip: !havePty && 'python3 pty not available' }, () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, CONF), JSON.stringify({ gates: { human_confirmation: 'tty' } }));
  assert.equal(viaPty(dir, 'yes', ['confirm-product', '--by', 'Ann', '--note', 'user: fine']).code, 0);
  assert.equal(viaPty(dir, 'yes', ['reopen-product', '--by', 'Ann']).code, 0);
  assert.equal(viaPty(dir, 'yes', ['approve-product', '--by', 'Ann']).code, 0);
  assert.deepEqual(validateJson(dir).errors, []);
});

// ---- H-B: decide must not launder a damaged log -----------------------------------------------------------------------
test('H-B: decide refuses to append to a log that fails its integrity check', () => {
  const dir = projectFrom('b');
  edit(dir, OPPS, (t) => t.replace(/^\| 2026-11-16 \| OPP-004 \| defer .*\n/m, '').replace('| Deferred | 63', '| Proposed | 63'));
  assert.ok(hasError(validateJson(dir), 'decision_count'));
  const before = read(dir, OPPS);
  const r = pi(dir, ['decide', 'OPP-002', 'reject', '--by', 'Ann', '--note', 'user: no']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /integrity check/);
  assert.equal(read(dir, OPPS), before);
  assert.ok(hasError(validateJson(dir), 'decision_count'));
});

// ---- H-C: approval is bound to the approved content -------------------------------------------------------------------
test('H-C: rewriting an approved opportunity (title, scores or details) is detected', () => {
  const t1 = projectFrom('b');
  edit(t1, OPPS, (t) => t.replaceAll('Signed outbound webhooks', 'Paid cloud sync with accounts'));
  assert.ok(hasError(validateJson(t1), 'OPP-001: its title, scores or detail block changed after the user approved it'));

  const t2 = projectFrom('b');
  edit(t2, OPPS, (t) => t.replace(/(### OPP-001[^\n]*\n)/, '$1\n- **Added later:** also needs billing and accounts.\n'));
  assert.ok(hasError(validateJson(t2), 'OPP-001: its title, scores or detail block changed'));

  const t3 = projectFrom('b');
  edit(t3, OPPS, (t) => t.replace('| Ready for Implementation | 83 | High | Recommend | S |', '| Ready for Implementation | 83 | High | Recommend | XL |'));
  assert.ok(hasError(validateJson(t3), 'OPP-001: its title, scores or detail block changed'));
});

test('H-C: normal lifecycle moves after approval (spec link, Ready, dates, status) do not break the seal', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']).code, 0);
  assert.equal(pi(dir, ['new-feature', 'OPP-002']).code, 0);
  const errs = validateJson(dir).errors.filter((e) => e.includes('OPP-002') && e.includes('changed after'));
  assert.deepEqual(errs, []);
  assert.match(read(dir, OPPS), /\| OPP-002 \|[^\n]*\| (aaaaaaaaaaaa|[0-9a-f]{12}) \| [0-9a-f]{12} \|/);
});

test('H-C: re-proposing after a modification gets a fresh approval digest', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['decide', 'OPP-001', 'modify', '--by', 'Ann', '--note', 'user: tweak']).code, 0);
  edit(dir, OPPS, (t) => t.replace(/(### OPP-001[^\n]*\n)/, '$1\n- **Revised:** scoped to v2 events only.\n'));
  assert.equal(pi(dir, ['transition', 'OPP-001', 'Proposed']).code, 0);
  assert.equal(pi(dir, ['decide', 'OPP-001', 'approve', '--by', 'Ann', '--note', 'user: ok now']).code, 0);
  assert.deepEqual(validateJson(dir).errors.filter((e) => e.includes('changed after')), []);
});

// ---- M-A: reversed approvals must not leave the project broken ----------------------------------------------------------
test('M-A: a superseded spec with placeholders or [BLOCKING] items does not fail validation', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']).code, 0);
  assert.equal(pi(dir, ['new-feature', 'OPP-002']).code, 0);
  assert.equal(pi(dir, ['decide', 'OPP-002', 'reject', '--by', 'Ann', '--note', 'user: changed my mind']).code, 0);
  assert.match(read(dir, '.product/features/FEATURE-002.md'), /status: superseded/);
  assert.deepEqual(validateJson(dir).errors, []);

  const dir2 = projectFrom('b');
  edit(dir2, '.product/features/FEATURE-001.md', (t) => t.replace('status: ready', 'status: draft') + '\n[BLOCKING] unanswered question\n');
  assert.equal(pi(dir2, ['decide', 'OPP-001', 'defer', '--by', 'Ann', '--note', 'user: later']).code, 0);
  assert.deepEqual(validateJson(dir2).errors, []);
});

// ---- M-B: baseline must be approved and unmodified for specs and the Ready transition -----------------------------------
test('M-B: new-feature and Ready refuse a modified or reopened baseline', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['decide', 'OPP-002', 'approve', '--by', 'Ann', '--note', 'user: yes']).code, 0);
  edit(dir, PROD, (t) => t.replace('Reliable, observable', 'Changed, observable'));
  assert.match(pi(dir, ['new-feature', 'OPP-002']).err, /modified after approval/);

  const dir2 = projectFrom('b');
  edit(dir2, OPPS, (t) => t.replace('| Ready for Implementation | 83', '| Approved | 83'));
  edit(dir2, PROD, (t) => t.replace('Reliable, observable', 'Changed, observable'));
  assert.match(pi(dir2, ['transition', 'OPP-001', 'Ready for Implementation']).err, /modified after approval/);

  const dir3 = projectFrom('b');
  edit(dir3, OPPS, (t) => t.replace('| Ready for Implementation | 83', '| Approved | 83'));
  assert.equal(pi(dir3, ['transition', 'OPP-001', 'Ready for Implementation']).code, 0);
});

// ---- M-C: distinct sources are canonical ---------------------------------------------------------------------------------
function rewriteOpp1Facts(dir, srcs) {
  edit(dir, OPPS, (t) => {
    const start = t.indexOf('### OPP-001');
    const end = t.indexOf('### OPP-002');
    let i = 0;
    const block = t.slice(start, end).replace(/\[E: fact; (high|medium|low); [^\]]*\]/g, (m, c) => `[E: fact; ${c === 'low' ? 'low' : 'high'}; ${srcs[i++ % srcs.length]}]`);
    return t.slice(0, start) + block + t.slice(end);
  });
}

test('M-C: aliases of one source, our own artifacts, and URL variants do not add up to High confidence', async () => {
  const cases = [
    ['repo:README.md:1', 'repo:./README.md:2'],
    ['repo:README.md:1', 'repo:docs/../README.md:2'],
    ['repo:.product/PRODUCT.md', 'repo:.product/opportunities.md'],
    ['https://example.com/a 2026-11-16', 'https://example.com/a/'],
    ['https://example.com/a', 'HTTPS://EXAMPLE.COM/a#frag'],
  ];
  for (const srcs of cases) {
    const dir = projectFrom('b');
    rewriteOpp1Facts(dir, srcs.map((s) => s.replace(' 2026-11-16', '') + (s.startsWith('http') ? '; 2026-11-16' : '')));
    const res = validateJson(dir);
    assert.ok(res.errors.some((e) => /OPP-001: confidence High exceeds/.test(e)), JSON.stringify(srcs) + ' -> ' + JSON.stringify(res.errors));
  }
  const { sourceKey } = await lib('evidence.mjs');
  const dir = projectFrom('b');
  assert.equal(sourceKey(dir, 'repo:README.md:1'), sourceKey(dir, 'repo:./README.md:9'));
  assert.equal(sourceKey(dir, 'repo:.git/config'), null);
  assert.notEqual(sourceKey(dir, 'https://example.com/a'), sourceKey(dir, 'https://example.com/b'));
});

// ---- M-D: docs/CLI ----------------------------------------------------------------------------------------------------------
test('M-D: snapshot is part of every run, and --discard is documented', () => {
  assert.match(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'), /## Start of every run[\s\S]*`pi snapshot`[\s\S]*## /);
  assert.match(pi(tmpDir(), ['help']).out, /--discard/);
  assert.match(fs.readFileSync(path.join(SKILL, 'references/orchestration.md'), 'utf8'), /At the start of every run that reads the repository/);
});

// ---- Lows --------------------------------------------------------------------------------------------------------------------
test('L1: Revision History rows hidden after a gap are reported', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t + '\n| 1 | 2026-11-16 | Ann | reviewed | Correction: the audience is enterprise IT |\n');
  assert.ok(hasError(validateJson(dir), 'Revision History table row(s) appear after a gap'));
});

test('L2: last_reviewed must match the newest history row', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t.replace(/^last_reviewed: .*$/m, 'last_reviewed: 2026-11-17'));
  assert.ok(hasError(validateJson(dir), 'last_reviewed (2026-11-17) does not match'));
});

test('L3: unusual --by names are either refused or round-trip cleanly', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['reopen-product', '--by', 'Ann']).code, 0);
  assert.equal(pi(dir, ['approve-product', '--by', "'Ann'"]).code, 0);
  assert.deepEqual(validateJson(dir).errors, []);
  const d2 = projectFrom('b');
  assert.match(pi(d2, ['reopen-product', '--by', 'Ann Lee']).err, /--by must be/);
  const d3 = projectFrom('b');
  assert.equal(pi(d3, ['reopen-product', '--by', 'Ann']).code, 0);
  assert.equal(pi(d3, ['approve-product', '--by', "O'Neil: #1"]).code, 0);
  assert.deepEqual(validateJson(d3).errors, []);
});

test('L4: retargeting a tracked symlink is a change', () => {
  const dir = projectFrom('b');
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'one.txt'), 'same');
  fs.writeFileSync(path.join(dir, 'two.txt'), 'same');
  fs.symlinkSync('one.txt', path.join(dir, 'link.txt'));
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'x');
  assert.equal(pi(dir, ['snapshot']).code, 0);
  fs.rmSync(path.join(dir, 'link.txt'));
  fs.symlinkSync('two.txt', path.join(dir, 'link.txt'));
  const r = pi(dir, ['verify-clean']);
  assert.equal(r.code, 2);
  assert.deepEqual(JSON.parse(r.out).modified, ['link.txt']);
});

test('L5: the registry template validates as created (last_research: never is allowed)', () => {
  const dir = tmpDir();
  assert.equal(pi(dir, ['init', '--registry']).code, 0);
  const res = validateJson(dir);
  assert.ok(!res.errors.some((e) => e.includes('last_research')), JSON.stringify(res.errors));
});

test('L6: a bad --note is rejected before the human is asked to confirm', () => {
  const dir = projectFrom('b');
  fs.writeFileSync(path.join(dir, CONF), JSON.stringify({ gates: { human_confirmation: 'tty' } }));
  for (const c of ['reopen-product', 'confirm-product']) {
    const r = pi(dir, [c, '--by', 'Ann', '--note', 'x\u001by']);
    assert.match(r.err, /control characters/, c);
    assert.doesNotMatch(r.err, /interactive terminal/, c);
  }
});

test('L8: wiping the Decision Log and its counters leaves a trace (decision_count is required)', () => {
  const dir = projectFrom('b');
  edit(dir, OPPS, (t) => t.replace(/^\| 2026-11-16 \| OPP-\d+ \| (approve|reject|defer) .*\n/gm, '').replace(/^decision_(count|head):.*\n/gm, ''));
  assert.ok(hasError(validateJson(dir), 'missing frontmatter "decision_count"'));
});

// ---- Gaps the review found in earlier tests (each check below was removable without any test failing) --------------------
test('gap: transition to Proposed is refused while the baseline is reopened', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['decide', 'OPP-002', 'research', '--by', 'Ann', '--note', 'user: more']).code, 0);
  assert.equal(pi(dir, ['reopen-product', '--by', 'Ann']).code, 0);
  const r = pi(dir, ['transition', 'OPP-002', 'Proposed']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /not approved/);
});

test('gap: confirm-product refuses a reopened (draft) baseline', () => {
  const dir = projectFrom('b');
  assert.equal(pi(dir, ['reopen-product', '--by', 'Ann']).code, 0);
  assert.match(pi(dir, ['confirm-product', '--by', 'Ann']).err, /not approved/);
});

test('gap: an approved baseline whose history shows a later reopen is an error', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t + '| 1 | 2026-11-16 | Ann | reopened | edit requested |\n');
  assert.ok(hasError(validateJson(dir), 'reopened after the last approval'));
});

test('gap: a history row with the wrong number of columns is malformed on its own', () => {
  const dir = projectFrom('b');
  edit(dir, PROD, (t) => t + '| 1 | 2026-11-16 | Ann | reviewed |\n');
  assert.ok(hasError(validateJson(dir), 'Revision History row 2 is malformed'));
});

test('repo docs: package script and changelog mention the new Content column', () => {
  assert.ok(fs.existsSync(path.join(REPO, 'CHANGELOG.md')));
  assert.match(fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8'), /Content/);
});
