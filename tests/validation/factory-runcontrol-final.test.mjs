// factory run control: fixes from the final Phase 2 review. A session that ends without a result (kind other or no_result) keeps its
// work and continues; a pending stop flag never locks the repository out; the stop kill sweep leaves processes with a controlling
// terminal alone; a WIP commit skipped because HEAD left the feature branch says so; deliver retry refuses a budget hold; status
// says when the driver is not running. Integration through the shared harness (factory-world.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SCRIPTS, BASE_CONFIG, world, readiness, ready, good, builderRuns, promptOf, bg, until, deliverI, attentionItems,
} from './factory-world.mjs';

const VF = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'verify.mjs')).href);
const RS = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'runstate.mjs')).href);
const CFG = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'config.mjs')).href);

const ONE = { 'FEATURE-001': 'Items one' };
const CONTINUE = /continue from the current branch and the `\.implementation\/FEATURE-001\/` ledger; finish with `result\.json`/;
const flagFile = (w) => path.join(w.fhome, 'stop', 'o__r');
const subjects = (w, ref) => w.sh(w.builder, 'log', '--format=%s', ref).split('\n');

// ---- I2: a session that ends as other or no_result keeps its work -----------------------------------------------------------------
for (const [status, kind] of [['error', 'other'], ['exit', 'no_result']]) {
  test(`a builder session that ends as ${kind} keeps its work in a WIP commit, stops with an interrupted row, and the next run continues the step`, (t) => {
    const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/x.wip': 'x\n' }, status }, { ...good('FEATURE-001'), require_files: ['src/x.wip'] }] } } });
    const r = w.factory(['run']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /^stopped: interrupted$/m);
    const f = w.queue().features[0];
    assert.equal(f.state, 'building');
    assert.equal(f.interrupted?.kind, kind);
    assert.equal(f.interrupted?.step, 'build');
    assert.ok(subjects(w, f.branch).includes(`wip(FEATURE-001): interrupted (${kind})`), 'the work is in a WIP commit');
    const row = attentionItems(w).find((i) => i.kind === 'interrupted');
    assert.ok(row, JSON.stringify(attentionItems(w)));
    assert.equal(row.severity, 'high'); assert.equal(row.run, 'factory run --continue'); assert.equal(row.id, 'FEATURE-001');
    assert.doesNotMatch(row.what, /Items one|FEATURE-001/, 'fixed text only');
    const c = w.factory(['run', '--continue']);
    assert.equal(c.code, 0, c.out + c.err);
    assert.match(c.out.split('\n').find((l) => / -> /.test(l)), /^FEATURE-001 building -> build \(build\)$/);
    const runs = builderRuns(w, 'FEATURE-001');
    assert.equal(runs.length, 2);
    assert.match(promptOf(runs[1]), CONTINUE, 'the second session gets the continue brief');
    assert.equal(w.queue().features[0].state, 'merged', 'the continued session saw src/x.wip (require_files)');
    assert.ok(!attentionItems(w).some((i) => i.kind === 'interrupted'), 'the row is resolved by the next run');
  });
}

// ---- I3: a pending stop flag never locks the repository out -------------------------------------------------------------------------
test('factory scenarios clears a stop flag left with no run active (and says so), then authors', (t) => {
  const w = world(t, { specs: ONE });
  readiness(w);
  assert.equal(w.factory(['stop']).code, 0);
  assert.ok(fs.existsSync(flagFile(w)));
  const s = w.factory(['scenarios']);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /^scenarios: a stop request left with no run active is cleared$/m);
  assert.ok(!fs.existsSync(flagFile(w)), 'the flag is gone');
  assert.match(s.out, /^FEATURE-001 scenarios: stored/m);
});

test('a refused factory run --continue (no approved scenarios) still clears the stop flag; plain run without --continue still refuses under the flag', (t) => {
  const w = world(t, { specs: ONE });
  readiness(w);
  assert.equal(w.factory(['stop']).code, 0);
  const plain = w.factory(['run']);
  assert.equal(plain.code, 1, plain.out + plain.err);
  assert.match(plain.out, /^refused: a stop was requested for this repository \(factory stop\)$/m);
  assert.ok(fs.existsSync(flagFile(w)), 'plain run leaves the flag');
  const c = w.factory(['run', '--continue']);
  assert.equal(c.code, 1, c.out + c.err);
  assert.match(c.out, /^continue: the stop request is cleared$/m);
  assert.match(c.out, /^refused: features without current approved scenarios: FEATURE-001\b/m);
  assert.ok(!fs.existsSync(flagFile(w)), 'the flag is cleared before the refusal');
  assert.equal(w.factory(['scenarios']).code, 0, 'scenarios then runs');
});

test('factory scenarios while a run holds the lock is refused (LOCK_HELD) and leaves the live run\'s stop flag in place', async (t) => {
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/a.wip': 'a\n' }, linger_ms: 60000 }] } } });
  const run = bg(w, ['run']);
  await until(() => builderRuns(w, 'FEATURE-001').length === 1, 'the builder session');
  fs.mkdirSync(path.join(w.fhome, 'stop'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(flagFile(w), JSON.stringify({ at: new Date().toISOString(), now: false })); // a stop the run has not seen yet
  const s = w.factory(['scenarios']);
  assert.equal(s.code, 1, s.out + s.err);
  assert.match(s.out, /^refused: another factory run holds the lock for this repository$/m);
  assert.doesNotMatch(s.out, /stop request/);
  assert.ok(fs.existsSync(flagFile(w)), 'the live run\'s stop request is untouched');
  const r = await run.done;
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^stopped: stop$/m, 'the live run still stops');
});

// ---- I4: the stop kill sweep leaves a person's terminal processes alone ---------------------------------------------------------------
test('survivorSets: a process with its cwd in a marker is killable only without a controlling terminal; it is always detected', () => {
  const m = '/fh-builder/o__r';
  const ps = [
    '  101 S    ??       node session.js',
    '  102 Ss   s001     -zsh',
    '  103 S    ?        node app.js',
    '  104 S    pts/3    vim notes',
    '  105 S    s002     node x TMPDIR=/run/sbx/tmp',
    '  106 S    ??       code /fh-builder/o__r',
    '  107 Z    ??       zombie',
    '  108 S    -        node detached',
  ].join('\n');
  const lsof = ['p101', 'fcwd', `n${m}/src`, 'p102', 'fcwd', `n${m}`, 'p103', 'fcwd', `n${m}`, 'p104', 'fcwd', `n${m}/docs`, 'p108', 'fcwd', `n${m}`, 'p109', 'fcwd', '/elsewhere'].join('\n');
  const r = VF.survivorSets({ psText: ps, lsofText: lsof, markers: [m], sandbox: ['/run/sbx'], self: 1 });
  assert.deepEqual([...r.pids].sort(), [101, 102, 103, 104, 105, 106, 108]);
  assert.deepEqual([...r.killable].sort(), [101, 103, 105, 108], 'terminal shells and editors (102, 104) are not killed; a sandboxed process is, terminal or not; a mention (106) never');
});

test('survivorPids lists the tty column from the real ps (the scan works on this machine)', () => {
  const r = VF.survivorPids(['/no/such/marker/dir']);
  assert.equal(r.ok, true);
  assert.equal(r.pids.size, 0);
});

// ---- T8b ledger: a WIP commit skipped because HEAD left the feature branch -------------------------------------------------------
test('an interrupted builder that left HEAD off the feature branch gets no WIP commit: one line and a wip_skipped attention row', (t) => {
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ checkout: 'elsewhere', files: { 'src/x.wip': 'x\n' }, status: 'usage', limit: 'session', resets_at: null }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^FEATURE-001 interrupted: the builder left HEAD off the feature branch; no WIP commit was made$/m);
  const row = attentionItems(w).find((i) => i.kind === 'wip_skipped');
  assert.ok(row, JSON.stringify(attentionItems(w)));
  assert.equal(row.severity, 'high'); assert.equal(row.run, 'factory run --continue');
  assert.doesNotMatch(row.what, /elsewhere|Items one/);
});

// ---- M3: deliver retry refuses a budget hold -------------------------------------------------------------------------------------
test('interactive deliver retry refuses a feature held for its budget and names factory run --raise-budget', (t) => {
  const w = world(t, { specs: ONE });
  fs.mkdirSync(path.join(w.fhome, 'queues'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.queueFile, JSON.stringify({ repo: 'o/r', base: 'main', checks: [], policy: { ...CFG.parseConfig(BASE_CONFIG).config, autonomy: undefined }, max_fix_rounds: 2, features: [
    { id: 'FEATURE-001', state: 'awaiting_human', hold_kind: 'budget', budget_hold: { from: 'building' }, branch: 'feature/feature-001', pr: { number: 1, url: 'http://pr/1' }, history: [] },
  ] }), { mode: 0o600 });
  const d = deliverI(w, ['retry', 'FEATURE-001']);
  assert.equal(d.code, 1, d.out + d.err);
  assert.match(d.err, /FEATURE-001 is held for its budget: run "factory run --raise-budget FEATURE-001"/);
  assert.equal(JSON.parse(fs.readFileSync(w.queueFile, 'utf8')).features[0].state, 'awaiting_human');
});

// ---- M8: status says when the driver is not running -------------------------------------------------------------------------------
test('factory status: driver not running when the run state says running but no live lock holds the repository', (t) => {
  const w = world(t, { specs: ONE });
  w.inHome(() => RS.updateRun(w.fhome, 'o__r', { status: 'running', pid: 999999 }));
  const s = w.factory(['status']);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /^driver: not running$/m);
  const j = JSON.parse(w.factory(['status', '--json']).out);
  assert.equal(j.driver, 'not_running');
  w.inHome(() => RS.updateRun(w.fhome, 'o__r', { status: 'stopped' }));
  assert.doesNotMatch(w.factory(['status']).out, /^driver:/m, 'a stopped run needs no driver line');
  assert.equal(JSON.parse(w.factory(['status', '--json']).out).driver, 'not_running');
});

test('factory status: driver running under a live lock', async (t) => {
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/a.wip': 'a\n' }, linger_ms: 60000 }] } } });
  const run = bg(w, ['run']);
  await until(() => builderRuns(w, 'FEATURE-001').length === 1, 'the builder session');
  const j = JSON.parse(w.factory(['status', '--json']).out);
  assert.equal(j.driver, 'running');
  assert.doesNotMatch(w.factory(['status']).out, /^driver: not running$/m);
  assert.equal(w.factory(['stop']).code, 0);
  assert.equal((await run.done).code, 2);
});
