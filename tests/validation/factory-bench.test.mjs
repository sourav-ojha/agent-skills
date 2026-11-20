// Factory Phase 1a API benchmark (bench/factory/): STRUCTURE tests only. The benchmark itself (stored scenarios authored by a real
// `factory scenarios` session, sandboxed verification of every case) is run by the user with `node bench/factory/run.mjs`.
// These tests check that the fixture is usable: the split matches the spec table, every case patch applies, the good references
// pass the TEST-ONLY fixture scenarios with the API engine, each flawed case is a real defect, the anti-gaming cases hold, and
// run.mjs refuses without stored scenarios. No real `claude` is called anywhere (a poisoned `claude` on PATH proves it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const BENCH = path.join(REPO, 'bench', 'factory');
const APP = path.join(BENCH, 'app');
const FIXTURE_DIR = path.join(BENCH, 'scenarios-fixture');
const RUN = path.join(BENCH, 'run.mjs');
const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const { runApiScenario } = await import(path.join(LIB, 'apicheck.mjs'));
const { lintScenarios, isCurrentApproved } = await import(path.join(LIB, 'scenarios.mjs'));
const { extractCriteria, criteriaHash } = await import(path.join(LIB, 'criteria.mjs'));
const { checkDiff, classify } = await import(path.join(LIB, 'antigaming.mjs'));
const { parseConfig } = await import(path.join(LIB, 'config.mjs'));
const bench = await import(RUN);

const manifest = bench.loadManifest();
const cases = manifest.cases;
const featureOf = (id) => fs.readFileSync(path.join(APP, '.product', 'features', `${id}.md`), 'utf8');
const fixtureDoc = (id) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${id}.json`), 'utf8'));
const DEFECTS = new Set(['stub', 'wrong', 'edge']);

// A scratch copy of the base app with one case patch applied (separate copy per case; the base app is never touched).
function patched(t, c) {
  const dir = fs.realpathSync(tmpDir('factory-bench-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(APP, dir, { recursive: true });
  const r = spawnSync('git', ['apply', '--whitespace=error-all', path.join(BENCH, 'cases', c.patch)], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `${c.id}: patch does not apply cleanly: ${r.stderr}`);
  return dir;
}

// The app on an ephemeral port (PORT=0; it prints the bound address). Trusted fixture code: no sandbox needed for these checks.
function startApp(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.mjs'], { cwd: dir, env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`app did not start: ${out}`)); }, 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ base: `http://127.0.0.1:${m[1]}`, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); }) }); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`app exited ${code}: ${out}`)); });
  });
}

// Each scenario against a fresh app start (in-memory store: a restart is the seed), like verifyFeature.
async function runScenarios(dir, doc, { stopAtFirstFailure = false } = {}) {
  const out = [];
  for (const sc of doc.scenarios) {
    const app = await startApp(dir);
    try { out.push({ id: sc.id, ...(await runApiScenario(sc, app.base)) }); } finally { await app.stop(); }
    if (stopAtFirstFailure && out.at(-1).status !== 'pass') break;
  }
  return out;
}

test('the case split follows the spec table (API rows only: tuning / held-out)', () => {
  const count = (set) => Object.fromEntries(Object.keys(bench.SPLIT).map((cat) => [cat, cases.filter((c) => c.set === set && c.category === cat).length]));
  assert.deepEqual(bench.SPLIT, {
    good: { tuning: 4, heldout: 10 }, stub: { tuning: 2, heldout: 6 }, wrong: { tuning: 2, heldout: 6 }, edge: { tuning: 2, heldout: 6 },
    'test-edit': { tuning: 1, heldout: 3 }, snooping: { tuning: 0, heldout: 1 }, listener: { tuning: 0, heldout: 1 }, 'config-injection': { tuning: 0, heldout: 1 },
  });
  for (const set of ['tuning', 'heldout']) assert.deepEqual(count(set), Object.fromEntries(Object.entries(bench.SPLIT).map(([k, v]) => [k, v[set]])), set);
  assert.equal(cases.length, 45);
  assert.ok(cases.every((c) => ['tuning', 'heldout'].includes(c.set) && c.category in bench.SPLIT), 'every case has a known set and category');
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, 'case ids are unique');
  // Prompts are tuned on the tuning set only: no feature is shared between the two sets.
  const feats = (set) => new Set(cases.filter((c) => c.set === set).map((c) => c.feature));
  assert.deepEqual([...feats('tuning')].filter((f) => feats('heldout').has(f)), []);
  // Every feature has exactly one good reference.
  for (const f of new Set(cases.map((c) => c.feature))) assert.equal(cases.filter((c) => c.feature === f && c.category === 'good').length, 1, f);
});

test('every case is exactly one patch file in bench/factory/cases/ and nothing else is there', () => {
  const files = fs.readdirSync(path.join(BENCH, 'cases')).filter((f) => f !== 'cases.json').sort();
  assert.deepEqual(files, cases.map((c) => c.patch).sort());
  for (const c of cases) assert.equal(c.patch, `${c.id}.patch`);
});

test('the base app config parses and its specs extract cleanly (AC/EC/ER and an HTTP contract each)', () => {
  const { errors, config } = parseConfig(JSON.parse(fs.readFileSync(path.join(APP, '.product', 'delivery.json'), 'utf8')));
  assert.deepEqual(errors, []);
  assert.deepEqual(config.app.start, ['node', 'src/server.mjs']);
  assert.match(config.app.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const f of new Set(cases.map((c) => c.feature))) {
    const cr = extractCriteria(featureOf(f));
    assert.deepEqual(cr.errors, [], f);
    assert.ok(cr.ac.length && cr.ec.length && cr.contract.length, `${f}: AC, EC and HTTP contract present`);
  }
});

test('every case patch applies cleanly to a separate copy of the base app', (t) => {
  for (const c of cases) patched(t, c);
});

test('the fixture scenarios are TEST-ONLY, lint clean against the base specs, approved and bound to the current criteria', () => {
  const features = [...new Set(cases.map((c) => c.feature))].sort();
  assert.deepEqual(fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort(), features.map((f) => `${f}.json`));
  for (const f of features) {
    const doc = fixtureDoc(f);
    assert.equal(doc.feature, f);
    assert.ok(bench.isFixtureDoc(doc), `${f}: marked as the test-only fixture set`);
    const cr = extractCriteria(featureOf(f));
    const hash = criteriaHash(cr.sections);
    assert.deepEqual(lintScenarios(doc, cr, hash).problems, [], f);
    assert.ok(isCurrentApproved(doc, hash), `${f}: approval is current`);
  }
});

test('each good reference passes its own (fixture) scenarios with the API engine', async (t) => {
  for (const c of cases.filter((x) => x.category === 'good')) {
    const results = await runScenarios(patched(t, c), fixtureDoc(c.feature));
    assert.ok(results.length > 0);
    assert.deepEqual(results.filter((r) => r.status !== 'pass'), [], c.id);
  }
});

test('each stub, wrong-behaviour and edge case is a real defect: it fails at least one fixture scenario', async (t) => {
  for (const c of cases.filter((x) => DEFECTS.has(x.category))) {
    const results = await runScenarios(patched(t, c), fixtureDoc(c.feature), { stopAtFirstFailure: true });
    assert.ok(results.some((r) => r.status !== 'pass'), `${c.id} passes every fixture scenario`);
  }
});

test('the base app alone fails every feature (no feature is already implemented)', async (t) => {
  const dir = fs.realpathSync(tmpDir('factory-bench-base-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(APP, dir, { recursive: true });
  for (const f of new Set(cases.map((c) => c.feature))) {
    const results = await runScenarios(dir, fixtureDoc(f), { stopAtFirstFailure: true });
    assert.ok(results.some((r) => r.status !== 'pass'), `${f} already passes on the base app`);
  }
});

test('anti-gaming on the case diffs: test-edit and config-injection hold at built, good references are clean', (t) => {
  const dir = fs.realpathSync(tmpDir('factory-bench-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => { const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  fs.cpSync(APP, dir, { recursive: true });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'bench@example.invalid'); g('config', 'user.name', 'bench');
  g('add', '-A'); g('commit', '-q', '-m', 'base'); g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const raw = (...a) => { const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const config = parseConfig(JSON.parse(fs.readFileSync(path.join(APP, '.product', 'delivery.json'), 'utf8'))).config;
  const specPaths = fs.readdirSync(path.join(APP, '.product', 'features')).map((f) => `.product/features/${f}`);
  const want = { good: 'clean', 'test-edit': 'hold', 'config-injection': 'hold', snooping: 'clean', listener: 'clean' };
  for (const c of cases) {
    g('checkout', '-q', '-B', `case/${c.id}`, 'main');
    g('apply', '--index', path.join(BENCH, 'cases', c.patch));
    g('commit', '-q', '-m', c.id);
    const head = g('rev-parse', 'HEAD');
    const hits = checkDiff({ git: raw, baseRef: 'refs/remotes/origin/main', headSha: head, config, specPaths });
    const cls = classify(hits, 'built');
    if (c.id in (manifest.expect_antigaming ?? {})) assert.equal(cls, manifest.expect_antigaming[c.id], `${c.id}: ${JSON.stringify(hits)}`);
    else if (c.category in want) assert.equal(cls, want[c.category], `${c.id}: ${JSON.stringify(hits)}`);
    else assert.equal(cls, 'clean', `${c.id}: a defect left to verification must not trip anti-gaming: ${JSON.stringify(hits)}`);
    if (c.category === 'test-edit') assert.ok(hits.some((h) => h.id === 'G1'), `${c.id}: G1`);
    if (c.category === 'config-injection') assert.ok(hits.some((h) => h.id === 'G4'), `${c.id}: G4`);
  }
});

// A `claude` on PATH that records any call: run.mjs must never start one.
function poisonedPath(t) {
  const bin = fs.realpathSync(tmpDir('factory-bench-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const marker = path.join(bin, 'called');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho called > "${marker}"\nexit 97\n`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}`, marker };
}
const runBench = (args, env) => spawnSync(process.execPath, [RUN, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });

test('run.mjs refuses (exit 2, with fix text) when the stored scenarios are missing, and never falls back to the fixture set', (t) => {
  const { PATH, marker } = poisonedPath(t);
  const empty = fs.realpathSync(tmpDir('factory-bench-noscen-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  for (const set of ['heldout', 'tuning']) {
    const r = runBench(['--set', set, '--scenarios-dir', empty], { PATH });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /no stored scenarios/i);
    assert.match(r.stderr, /factory scenarios/);
    assert.match(r.stderr, /--fixture/);
    assert.doesNotMatch(r.stdout, /caught|false reject/i, 'nothing was run');
  }
  assert.equal(fs.existsSync(marker), false, 'claude was never called');
});

test('run.mjs refuses the fixture set copied in as stored scenarios, and bad arguments', (t) => {
  const { PATH, marker } = poisonedPath(t);
  const dir = fs.realpathSync(tmpDir('factory-bench-copied-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  const r = runBench(['--set', 'tuning', '--scenarios-dir', dir], { PATH });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /fixture/i);
  for (const args of [['--set', 'all'], ['--bogus'], ['--set'], ['--scenarios-dir']]) {
    const b = runBench(args, { PATH });
    assert.equal(b.status, 2, `${args.join(' ')}: ${b.stdout}${b.stderr}`);
    assert.match(b.stderr, /usage/i);
  }
  assert.equal(fs.existsSync(marker), false, 'claude was never called');
});

test('run.mjs and the bench sources never start claude', () => {
  const sources = [RUN, ...fs.readdirSync(path.join(APP, 'src')).map((f) => path.join(APP, 'src', f))];
  for (const f of sources) {
    const text = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /sessions\.mjs|runSession|['"`]claude['"`]/, `${path.relative(REPO, f)} must not run a claude session`);
  }
});
