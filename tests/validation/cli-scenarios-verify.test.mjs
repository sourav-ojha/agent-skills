// `cli` scenarios in the existing verifier (verify.mjs): kind dispatch (scenarioPlan), `verifiable`, the cli run phase (read-only
// worktree, fresh case folder per run, no network, survivor scan after every invocation), `./` command resolution and the symptom brief.
// Most tests use fake sandbox seams (like factory-verify.test.mjs); one test runs the real sandbox when it is available here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const lib = (f) => import(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', f));
const VF = await lib('verify.mjs');
const V = await lib('verdict.mjs');
const SC = await lib('scenarios.mjs');
const SBX = await lib('sandbox.mjs');
const GS = await lib('gitsafe.mjs');
const CFG = await lib('config.mjs');

const SBX_AVAIL = SBX.sandboxAvailable();
const SBX_SKIP = SBX_AVAIL.ok ? false : `real sandbox unavailable here (${SBX_AVAIL.reason})`;
if (SBX_SKIP) console.log(`# cli-scenarios-verify: SKIPPING the real-sandbox test: ${SBX_SKIP}`);

const CANARY = 'fx-c1c1c1';
const VCH = `sha256:${'4'.repeat(64)}`;
const VERDICT_KEYS = ['at', 'criteria_hash', 'feature', 'results', 'scenarios_hash', 'sha', 'verdict'];
const ok = (o = {}) => ({ code: 0, signal: null, timedOut: false, overflow: false, stdout: 'hello from cli\n', stderr: '', ...o });

const cscenarios = (over = {}) => ({
  feature: 'FEATURE-001', criteria_hash: VCH, canary: CANARY,
  scenarios: [
    { id: 'S-1', covers: ['AC-1'], kind: 'cli', run: { args: ['about'] }, assert: [{ exit: 0 }, { stdout: { contains: 'hello' } }] },
    { id: 'S-2', covers: ['AC-2', 'EC-1'], kind: 'cli', setup: { files: [{ path: 'in.txt', text: 'x' }], runs: [{ args: ['init'], stdin: 'yes' }] },
      run: { args: ['about', '--json'], stdin: 'in' }, assert: [{ exit: 0 }] },
  ],
  ...over,
});
const apiScenario = { id: 'S-9', covers: ['AC-9'], kind: 'api', request: { method: 'GET', path: '/api/items' }, assert: [{ status: 200 }] };
const uiScenario = { id: 'S-8', covers: ['AC-8'], kind: 'ui', steps: ['a'], expect: ['b'] };

const CLI_SRC = `import fs from 'node:fs';
const [cmd] = process.argv.slice(2);
if (cmd === 'about') console.log('hello from cli');
else if (cmd === 'write-case') { fs.writeFileSync('out.txt', 'ok'); console.log('wrote'); }
else if (cmd === 'write-wt') { try { fs.writeFileSync(new URL('../written.txt', import.meta.url), 'x'); console.log('wrote'); } catch (e) { console.log('denied:' + e.code); } }
else if (cmd === 'write-wt-strict') fs.writeFileSync(new URL('../written.txt', import.meta.url), 'x');
else if (cmd === 'env') console.log(JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, ci: process.env.CI, nc: process.env.NO_COLOR, cwd: process.cwd(), port: process.env.PORT ?? null }));
else if (cmd === 'remember') {
  const marks = [process.env.HOME + '/.mem', process.env.TMPDIR + '/.mem'];
  const seen = marks.filter((m) => fs.existsSync(m));
  for (const m of marks) fs.writeFileSync(m, 'x');
  console.log(seen.length ? 'carried' : 'fresh');
}
else process.exit(2);
`;

const rawGit = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', env: GS.gitEnv() });

// FACTORY_HOME + a factory clone: a base commit (refs/remotes/origin/main) and one feature commit (`files` and `links` on top).
function cworld(t, { files = {}, links = {}, app = {}, scenarios } = {}) {
  const root = fs.realpathSync(tmpDir('cli-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fh = path.join(root, 'fh'); fs.mkdirSync(fh);
  const prev = process.env.FACTORY_HOME; process.env.FACTORY_HOME = fh;
  t.after(() => { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; });
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'cli.mjs'), 'console.log("outside code")\n');
  const clone = path.join(root, 'clone'); fs.mkdirSync(clone);
  const g = (...a) => { const r = rawGit(clone, ...a); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@x'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(clone, 'bin'));
  fs.writeFileSync(path.join(clone, 'bin', 'cli.mjs'), CLI_SRC);
  fs.writeFileSync(path.join(clone, '.env.example'), 'FOO=base\n');
  g('add', '-A'); g('commit', '-q', '-m', 'base'); g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(clone, '.env.example'), 'FOO=feature\n');
  for (const [p, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(clone, p)), { recursive: true }); fs.writeFileSync(path.join(clone, p), body); }
  for (const [p, target] of Object.entries(links)) {
    const at = path.join(clone, p);
    fs.rmSync(at, { recursive: true, force: true }); fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target === 'OUTSIDE' ? outside : target, at);
  }
  g('add', '-A'); g('commit', '-q', '-m', 'feature'); const sha = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  const { config, errors } = CFG.parseConfig({ base: 'main', app: { cli: { command: ['node', './bin/cli.mjs'], timeout_s: 5 }, env_example: '.env.example', ...app } });
  assert.deepEqual(errors, []);
  const log = [];
  const git = (...a) => { if (a[0] === 'worktree') log.push(['git', a[1]]); return GS.gitSafeOpts(clone, a); };
  const fhReal = fs.realpathSync(fh);
  const wt = path.join(fhReal, 'work', 'o__r', `FEATURE-001-${sha}`);
  const tmpRoot = path.join(fhReal, 'tmp');
  const args = (over = {}) => ({ repoKey: 'o__r', id: 'FEATURE-001', sha, baseRef: 'refs/remotes/origin/main', config, scenarios: scenarios ?? cscenarios(), criteriaHash: VCH, git, ...over });
  return { root, fh, fhReal, clone, outside, sha, config, log, git, wt, tmpRoot, args };
}

// Fake sandbox: every call is logged. `respond(argv, opts, n)` gives the capture result (n counts captures from 0).
const mustNot = (name) => () => { throw new Error(`seam ${name} must not be called for a cli set`); };
function cseams(log, { respond = () => ok(), ...over } = {}) {
  let n = 0;
  return {
    sandboxAvailable: () => ({ ok: true }),
    sandboxProfile: (o) => { log.push(['profile', o]); return `(version 1)\n; net ${JSON.stringify(o.network)}\n`; },
    runSandboxed: async (argv, o) => { log.push(['setup', argv, o]); return { code: 0, timedOut: false }; },
    runSandboxedCapture: async (argv, o) => { log.push(['cap', argv, o, fs.readdirSync(o.cwd)]); return respond(argv, o, n++); },
    startSandboxed: mustNot('startSandboxed'), stopApp: mustNot('stopApp'), waitReady: mustNot('waitReady'), runApiScenario: mustNot('runApiScenario'),
    alive: () => false,
    portInUse: async () => { log.push(['port']); return false; },
    survivors: async (m) => { log.push(['scan', m]); return 0; },
    ...over,
  };
}
const of = (log, k) => log.filter((e) => e[0] === k);
const mainCaps = (log) => of(log, 'cap').filter((e) => e[1].at(-1) !== 'init');

// ---- the happy path ------------------------------------------------------------------------------------------------------------
test('a cli set with only app.cli verifies: no port check, no app start/stop, two runs per scenario in different case folders', async (t) => {
  const w = cworld(t);
  assert.equal(w.config.app.start, null); assert.equal(w.config.app.base_url, null); assert.equal(w.config.app.ready, null);
  const r = await VF.verifyFeature(w.args(), cseams(w.log));
  assert.equal(r.verdict, 'pass', JSON.stringify(r.doc?.results));
  assert.deepEqual(r.doc.results, [{ id: 'S-1', covers: ['AC-1'], status: 'pass', flaky: false }, { id: 'S-2', covers: ['AC-2', 'EC-1'], status: 'pass', flaky: false }]);
  assert.deepEqual(r.brief, []);
  assert.deepEqual(r.families, {});
  assert.deepEqual(Object.keys(r.doc).sort(), VERDICT_KEYS);
  assert.deepEqual(V.readVerdict('o__r', 'FEATURE-001', w.sha), r.doc);
  assert.equal(r.doc.scenarios_hash, SC.scenariosHash(cscenarios()));
  assert.equal(of(w.log, 'port').length, 0, 'no port check for a cli set');
  // 2 scenarios x 2 runs, plus S-2's setup run before each of its 2 runs
  assert.equal(of(w.log, 'cap').length, 6);
  const cases = mainCaps(w.log).map((e) => e[2].cwd);
  assert.equal(cases.length, 4); assert.equal(new Set(cases).size, 4, 'a fresh case folder per run');
  for (const d of cases) assert.ok(d.startsWith(w.tmpRoot + path.sep), 'case folder inside the run temp');
  // S-2: the setup run and the command share the run's case folder; the setup file is there
  const s2 = of(w.log, 'cap').slice(2, 4);
  assert.deepEqual(s2.map((e) => e[1].slice(2)), [['init'], ['about', '--json']]);
  assert.equal(s2[0][2].cwd, s2[1][2].cwd); assert.deepEqual(s2[0][3], ['in.txt']);
  assert.deepEqual([s2[0][2].stdin, s2[1][2].stdin], ['yes', 'in']);
  assert.ok(!fs.existsSync(w.wt), 'worktree removed');
  assert.deepEqual(fs.readdirSync(w.tmpRoot), [], 'run temp removed');
});

test('run phase: worktree read-only, case folder writable, network none, cwd the case folder, CI/NO_COLOR, HOME/TMPDIR in the run temp, ./ resolved into the worktree', async (t) => {
  const w = cworld(t, { app: { setup: ['npm', 'ci'] } });
  const r = await VF.verifyFeature(w.args(), cseams(w.log));
  assert.equal(r.verdict, 'pass');
  const profiles = of(w.log, 'profile').map((e) => e[1]);
  assert.equal(profiles[0].network, 'registries'); assert.deepEqual(profiles[0].writable, [w.wt], 'app.setup keeps a writable worktree');
  const runProfiles = profiles.slice(1);
  assert.equal(runProfiles.length, 4, 'one profile per run');
  for (const p of runProfiles) {
    assert.equal(p.network, 'none');
    assert.ok(!p.writable.includes(w.wt), 'worktree is NOT writable in the run phase');
    assert.ok(p.writable.every((d) => d.startsWith(w.tmpRoot + path.sep)), 'only the case folder (inside the run temp) is writable');
    assert.deepEqual(p.readOnly, [w.wt], 'worktree mounted read-only');
    assert.ok(p.tmpDir.startsWith(w.tmpRoot + path.sep));
  }
  assert.deepEqual(new Set(runProfiles.map((p) => p.writable[0])), new Set(mainCaps(w.log).map((e) => e[2].cwd)), 'the writable dir is the run\'s case folder');
  assert.equal(new Set(runProfiles.map((p) => p.tmpDir)).size, 4, 'a fresh run temp per run');
  for (const p of runProfiles) {
    assert.equal(p.writable[0], path.join(p.tmpDir, 'case'), 'the case folder lives in its own run temp');
    for (const q of runProfiles) if (q !== p) {
      for (const root of [...p.writable, p.tmpDir]) assert.ok(!q.tmpDir.startsWith(root + path.sep) && q.tmpDir !== root && !root.startsWith(q.tmpDir + path.sep), 'no other run\'s folder is reachable');
    }
  }
  const setup = of(w.log, 'setup');
  assert.equal(setup.length, 1, 'app.setup runs once'); assert.deepEqual(setup[0][1], ['npm', 'ci']); assert.equal(setup[0][2].cwd, w.wt);
  for (const [, argv, o, listing] of of(w.log, 'cap')) {
    assert.deepEqual(argv.slice(0, 2), ['node', path.join(w.wt, 'bin', 'cli.mjs')], './ element resolved to the worktree; others as written');
    assert.equal(o.env.CI, '1'); assert.equal(o.env.NO_COLOR, '1'); assert.equal(o.env.FOO, 'base', 'env example read from the base ref');
    assert.equal(o.env.PORT, undefined); assert.equal(o.env.HOST, undefined);
    assert.equal(o.tmpDir, o.env.TMPDIR); assert.ok(o.env.TMPDIR.startsWith(w.tmpRoot + path.sep));
    assert.ok(o.env.HOME.startsWith(o.env.TMPDIR + path.sep), 'HOME inside the run temp');
    assert.ok(!o.cwd.startsWith(w.wt), 'cwd is not the worktree');
    assert.ok(o.timeoutS >= 1 && o.timeoutS <= 5, 'timeout from app.cli.timeout_s');
    assert.ok(Array.isArray(listing));
  }
  for (const e of mainCaps(w.log).filter((x) => x[1][2] === 'about' && x[1].length === 3)) assert.deepEqual(e[3], [], 'S-1 starts in an empty case folder');
});

test('the survivor scan runs after EVERY sandboxed cli invocation (setup runs included), before the next one starts', async (t) => {
  const w = cworld(t);
  await VF.verifyFeature(w.args(), cseams(w.log));
  const seq = w.log.filter((e) => e[0] === 'cap' || e[0] === 'scan');
  for (let i = 0; i < seq.length; i++) {
    if (seq[i][0] !== 'cap') continue;
    assert.equal(seq[i + 1]?.[0], 'scan', `invocation #${i} is followed by a scan before anything else runs`);
    const markers = seq[i + 1][1];
    assert.ok(markers.includes(w.wt) && markers.some((m) => m.startsWith(w.tmpRoot + path.sep)), 'scan markers: worktree and run temp');
  }
});

test('a surviving process after a cli invocation is an escape: nothing else runs, no verdict, worktree and run temp left in place', async (t) => {
  const w = cworld(t);
  let scans = 0;
  const e = await VF.verifyFeature(w.args(), cseams(w.log, { survivors: async (m) => { w.log.push(['scan', m]); return ++scans === 2 ? 1 : 0; } })).catch((x) => x);
  assert.ok(e instanceof Error); assert.match(e.message, /still running/);
  assert.equal(of(w.log, 'cap').length, 2, 'no invocation after the scan that found a survivor');
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.sha), null, 'no verdict');
  assert.ok(fs.existsSync(w.wt), 'worktree left in place'); assert.match(e.cleanupError, /left in place/);
  assert.equal(fs.readdirSync(w.tmpRoot).length, 1, 'run temp kept');
  assert.deepEqual(of(w.log, 'git').map((x) => x[1]), ['add'], 'no git call after the escape');
});

test('a survivor after a scenario setup run stops that run: the command itself never starts', async (t) => {
  const w = cworld(t, { scenarios: cscenarios({ scenarios: [cscenarios().scenarios[1]] }) });
  const e = await VF.verifyFeature(w.args(), cseams(w.log, { survivors: async (m) => { w.log.push(['scan', m]); return 1; } })).catch((x) => x);
  assert.match(e?.message, /still running/);
  assert.deepEqual(of(w.log, 'cap').map((x) => x[1].slice(2)), [['init']], 'only the setup run was invoked');
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.sha), null);
  assert.ok(fs.existsSync(w.wt));
});

test('a failing survivor scan (ps broke) during a cli run is fail-closed: no pass, no verdict', async (t) => {
  const w = cworld(t);
  const e = await VF.verifyFeature(w.args(), cseams(w.log, { survivors: async () => { throw new Error('ps broke'); } })).catch((x) => x);
  assert.ok(e instanceof Error); assert.equal(of(w.log, 'cap').length, 1);
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.sha), null);
});

test('a throw from the cli runner ends in the fail-closed path: no pass, no verdict; an invalid assertion shape is refused before any phase', async (t) => {
  const w = cworld(t);
  const e = await VF.verifyFeature(w.args(), cseams(w.log, { runCliScenario: async () => { throw new Error('boom-runner'); } })).catch((x) => x);
  assert.match(e?.message, /boom-runner/);
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.sha), null);
  assert.ok(!fs.existsSync(w.wt), 'nothing escaped: the worktree is removed');
  const w2 = cworld(t);
  const bad = cscenarios({ scenarios: [{ ...cscenarios().scenarios[0], assert: [{ exit: 0 }, { bogus: 1 }] }] });
  await assert.rejects(VF.verifyFeature(w2.args({ scenarios: bad }), cseams(w2.log)), /scenario #1: invalid cli assertions/);
  const noExit = cscenarios({ scenarios: [{ ...cscenarios().scenarios[0], assert: [{ stdout: { contains: 'x' } }] }] });
  await assert.rejects(VF.verifyFeature(w2.args({ scenarios: noExit }), cseams(w2.log)), /scenario #1: invalid cli assertions/);
  assert.deepEqual(w2.log, [], 'refused before the worktree or any phase');
});

test('no state carries between runs or scenarios: each run has its own HOME and TMPDIR; carried state never makes a pass', async (t) => {
  const doc = cscenarios({ scenarios: [
    { id: 'S-1', covers: ['AC-1'], kind: 'cli', run: { args: ['remember'] }, assert: [{ exit: 0 }, { stdout: { equals: 'fresh' } }] },
    { id: 'S-2', covers: ['AC-2'], kind: 'cli', run: { args: ['remember'] }, assert: [{ exit: 0 }, { stdout: { equals: 'fresh' } }] },
    { id: 'S-3', covers: ['AC-3'], kind: 'cli', run: { args: ['remember'] }, assert: [{ exit: 0 }, { stdout: { equals: 'carried' } }] },
  ] });
  const w = cworld(t, { scenarios: doc });
  // a fake CLI that remembers: it writes under $HOME and $TMPDIR and reports whether an earlier invocation's files were there
  const respond = (_a, o) => {
    const marks = [path.join(o.env.HOME, '.tool', 'config'), path.join(o.env.TMPDIR, 'cache.txt')];
    const seen = marks.some((m) => fs.existsSync(m));
    for (const m of marks) { fs.mkdirSync(path.dirname(m), { recursive: true }); fs.writeFileSync(m, 'x'); }
    return ok({ stdout: seen ? 'carried' : 'fresh' });
  };
  const r = await VF.verifyFeature(w.args(), cseams(w.log, { respond }));
  assert.deepEqual(r.doc.results.map((x) => [x.id, x.status, x.flaky]), [['S-1', 'pass', false], ['S-2', 'pass', false], ['S-3', 'fail', false]]);
  assert.equal(r.verdict, 'fail', 'a scenario that passes only on carried state does not pass');
  assert.deepEqual(r.families, { 'S-3': 'stdout' });
  const homes = of(w.log, 'cap').map((e) => e[2].env.HOME);
  assert.equal(new Set(homes).size, 6, 'a fresh HOME per run');
});

// ---- results -------------------------------------------------------------------------------------------------------------------
test('two disagreeing runs are fail + flaky; a hung command or an overflow is blocked, never pass', async (t) => {
  const one = cscenarios({ scenarios: [cscenarios().scenarios[0]] });
  const w = cworld(t, { scenarios: one });
  const r = await VF.verifyFeature(w.args(), cseams(w.log, { respond: (_a, _o, n) => ok({ stdout: n === 0 ? 'hello\n' : 'bye\n' }) }));
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.doc.results, [{ id: 'S-1', covers: ['AC-1'], status: 'fail', flaky: true }]);
  assert.deepEqual(r.families, { 'S-1': 'stdout' });
  for (const [name, res] of [['timeout', ok({ code: null, signal: 'SIGKILL', timedOut: true })], ['overflow', ok({ overflow: true })]]) {
    const w2 = cworld(t, { scenarios: one });
    const r2 = await VF.verifyFeature(w2.args(), cseams(w2.log, { respond: () => res }));
    assert.equal(r2.verdict, 'fail', name);
    assert.deepEqual(r2.doc.results, [{ id: 'S-1', covers: ['AC-1'], status: 'blocked', flaky: false }], name);
    assert.deepEqual(r2.families, { 'S-1': 'run' }, name);
  }
  const w3 = cworld(t, { scenarios: one, app: { setup: ['npm', 'ci'] } });
  const r3 = await VF.verifyFeature(w3.args(), cseams(w3.log, { runSandboxed: async () => ({ code: 1, timedOut: false }) }));
  assert.deepEqual(r3.doc.results, [{ id: 'S-1', covers: ['AC-1'], status: 'blocked', flaky: false }], 'a failed app.setup blocks');
  assert.deepEqual(r3.families, { 'S-1': 'setup' });
  // a family word outside the fixed set never reaches the result; a reused verdict has no families
  const w4 = cworld(t, { scenarios: one });
  const r4 = await VF.verifyFeature(w4.args(), cseams(w4.log, { runCliScenario: async () => ({ status: 'fail', failed: 'PROGRAM-OUTPUT-fx' }) }));
  assert.deepEqual(r4.families, {}); assert.ok(!JSON.stringify(r4).includes('PROGRAM-OUTPUT-fx'));
  const w5 = cworld(t, { scenarios: one });
  await VF.verifyFeature(w5.args(), cseams(w5.log));
  const again = await VF.verifyFeature(w5.args(), cseams(w5.log, { runSandboxedCapture: mustNot('runSandboxedCapture') }));
  assert.equal(again.reused, true); assert.deepEqual(again.families, {});
  assert.equal(of(w3.log, 'cap').length, 0);
});

test('the symptom brief of a failing cli scenario: criterion IDs and the failed family word only; never args, expected values or output', async (t) => {
  const leaky = cscenarios({ scenarios: [{ id: 'S-1', covers: ['AC-1', 'EC-2'], kind: 'cli', setup: { files: [{ path: 'data/seed-fx.txt', text: 'SETUP-TEXT-fx' }] },
    run: { args: ['about', 'SECRET-ARG-fx'], stdin: 'STDIN-fx' }, assert: [{ exit: 0 }, { stdout: { equals: 'EXPECTED-VALUE-fx' } }] }] });
  const w = cworld(t, { scenarios: leaky });
  const r = await VF.verifyFeature(w.args(), cseams(w.log, { respond: () => ok({ stdout: 'PROGRAM-OUTPUT-fx', stderr: 'PROGRAM-ERR-fx' }) }));
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.brief, [`AC-1, EC-2: ${VF.CLI_SYMPTOM} (stdout)`]);
  assert.deepEqual(r.families, { 'S-1': 'stdout' }, 'the family word for the driver, keyed by scenario id');
  const text = JSON.stringify(r);
  for (const s of ['SECRET-ARG-fx', 'EXPECTED-VALUE-fx', 'PROGRAM-OUTPUT-fx', 'PROGRAM-ERR-fx', 'SETUP-TEXT-fx', 'STDIN-fx', 'seed-fx', CANARY, 'S-1']) {
    assert.ok(!JSON.stringify(r.brief).includes(s), `brief leaks ${s}`);
    if (s !== 'S-1') assert.ok(!text.includes(s), `result leaks ${s}`);
  }
  for (const fam of VF.CLI_FAMILIES) assert.deepEqual(VF.symptomBrief([{ covers: ['AC-1'], status: 'fail', failed: fam }], leaky, CANARY), [`AC-1: ${VF.CLI_SYMPTOM} (${fam})`]);
  assert.deepEqual(VF.CLI_FAMILIES, ['exit', 'stdout', 'stderr', 'file', 'run', 'setup']);
  // a family word outside the fixed set is never printed; a stored result (no family) still gets the cli sentence
  for (const failed of ['PROGRAM-OUTPUT-fx', '../x', 'Exit', undefined, 7]) {
    assert.deepEqual(VF.symptomBrief([{ covers: ['AC-1'], status: 'fail', failed }], leaky, CANARY), [`AC-1: ${VF.CLI_SYMPTOM}`], String(failed));
  }
  // a line that would contain a scenario string falls back to the fixed fallback
  const clash = cscenarios({ scenarios: [{ ...leaky.scenarios[0], run: { args: [VF.CLI_SYMPTOM.split(' ').slice(1, 3).join(' ')] } }] });
  assert.deepEqual(VF.symptomBrief([{ covers: ['AC-1'], status: 'fail', failed: 'exit' }], clash, CANARY), ['behaviour does not satisfy AC-1']);
  // api briefs are unchanged
  assert.deepEqual(VF.symptomBrief([{ covers: ['AC-1'], status: 'fail', failed: 'exit' }], { scenarios: [apiScenario] }, CANARY), ['AC-1: an endpoint returned an unexpected status or body']);
});

// ---- ./ resolution -------------------------------------------------------------------------------------------------------------
test('a ./ command element escaping the worktree through a committed symlink is refused before any phase', async (t) => {
  const w = cworld(t, { links: { bin: 'OUTSIDE' }, app: { setup: ['npm', 'ci'] } });
  const e = await VF.verifyFeature(w.args(), cseams(w.log)).catch((x) => x);
  assert.ok(e instanceof Error); assert.match(e.message, /app\.cli\.command.*outside the verification worktree/);
  assert.ok(!e.message.includes(w.outside), 'no path in the message');
  assert.equal(of(w.log, 'setup').length, 0, 'app.setup never ran'); assert.equal(of(w.log, 'cap').length, 0);
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.sha), null);
  assert.ok(!fs.existsSync(w.wt), 'nothing ran: the worktree is removed');
});

test('a ./ element turned into an outside symlink by app.setup is refused after setup, before any cli run', async (t) => {
  const w = cworld(t, { app: { setup: ['npm', 'ci'], cli: { command: ['node', './node_modules/tool/cli.mjs'], timeout_s: 5 } } });
  const e = await VF.verifyFeature(w.args(), cseams(w.log, { runSandboxed: async (argv, o) => { w.log.push(['setup']); fs.symlinkSync(w.outside, path.join(o.cwd, 'node_modules')); return { code: 0, timedOut: false }; } })).catch((x) => x);
  assert.match(e?.message, /outside the verification worktree/);
  assert.equal(of(w.log, 'setup').length, 1); assert.equal(of(w.log, 'cap').length, 0);
  assert.equal(V.readVerdict('o__r', 'FEATURE-001', w.sha), null);
});

test('a ./ element with .., an absolute element or a dangling symlink is refused; a symlink staying inside is resolved to its real path', async (t) => {
  const w = cworld(t);
  for (const command of [['node', './bin/../../x'], ['node', './a/../b'], ['/usr/bin/node', './bin/cli.mjs'], []]) {
    const config = { ...w.config, app: { ...w.config.app, cli: { command, timeout_s: 5 } } };
    await assert.rejects(VF.verifyFeature(w.args({ config }), cseams(w.log)), /app\.cli/, JSON.stringify(command));
  }
  assert.deepEqual(w.log, [], 'refused before the worktree');
  const w2 = cworld(t, { links: { 'bin/gone.mjs': '/nonexistent-target-fx/x.mjs' }, app: { cli: { command: ['node', './bin/gone.mjs'], timeout_s: 5 } } });
  await assert.rejects(VF.verifyFeature(w2.args(), cseams(w2.log)), /outside the verification worktree/);
  assert.equal(of(w2.log, 'cap').length, 0);
  const w3 = cworld(t, { files: { 'bin/real.mjs': CLI_SRC }, links: { 'bin/link.mjs': 'real.mjs' }, app: { cli: { command: ['node', './bin/link.mjs', '--flag'], timeout_s: 5 } } });
  const r = await VF.verifyFeature(w3.args(), cseams(w3.log));
  assert.equal(r.verdict, 'pass');
  for (const e of of(w3.log, 'cap')) assert.deepEqual(e[1].slice(0, 3), ['node', path.join(w3.wt, 'bin', 'real.mjs'), '--flag']);
});

// ---- refusals ------------------------------------------------------------------------------------------------------------------
test('refusals before anything runs: mixed kinds, ui, a cli set without app.cli, an api set without app.start, empty and unknown kinds', async (t) => {
  const w = cworld(t);
  const noCli = { ...w.config, app: { ...w.config.app, cli: null } };
  for (const [over, re] of [
    [{ scenarios: cscenarios({ scenarios: [...cscenarios().scenarios, apiScenario] }) }, /mixes/],
    [{ scenarios: cscenarios({ scenarios: [...cscenarios().scenarios, uiScenario] }) }, /UI scenarios need the Phase 1b evaluator/],
    [{ scenarios: cscenarios({ scenarios: [apiScenario, uiScenario] }) }, /UI scenarios/],
    [{ config: noCli }, /app\.cli is required/],
    [{ config: { ...w.config, app: { ...w.config.app, cli: { command: ['node', './bin/cli.mjs'], timeout_s: 0 } } } }, /app\.cli\.timeout_s/],
    [{ scenarios: cscenarios({ scenarios: [apiScenario] }) }, /app\.start is required/],
    [{ scenarios: cscenarios({ scenarios: [] }) }, /no runnable scenarios/],
    [{ scenarios: cscenarios({ scenarios: [{ ...cscenarios().scenarios[0], kind: 'shell' }] }) }, /no runnable scenarios/],
    [{ scenarios: cscenarios({ scenarios: [{ ...cscenarios().scenarios[0], covers: ['nope'] }] }) }, /scenario #1: invalid covers/],
    [{ scenarios: cscenarios({ criteria_hash: `sha256:${'9'.repeat(64)}` }) }, /criteria_hash is not current/],
  ]) await assert.rejects(VF.verifyFeature(w.args(over), cseams(w.log)), re, JSON.stringify(over).slice(0, 90));
  assert.deepEqual(w.log, []);
});

test('scenarioPlan: kind and list; throws for ui, mixed, unknown, empty, over the limit', () => {
  assert.deepEqual(VF.scenarioPlan(cscenarios(), VCH), { kind: 'cli', list: cscenarios().scenarios });
  assert.deepEqual(VF.scenarioPlan(cscenarios({ scenarios: [apiScenario] }), VCH), { kind: 'api', list: [apiScenario] });
  assert.throws(() => VF.scenarioPlan(cscenarios({ scenarios: [apiScenario, ...cscenarios().scenarios] }), VCH), /mixes/);
  assert.throws(() => VF.scenarioPlan(cscenarios({ scenarios: [uiScenario] }), VCH), /Phase 1b/);
  assert.throws(() => VF.scenarioPlan(cscenarios({ scenarios: [] }), VCH), /no runnable/);
  assert.throws(() => VF.scenarioPlan(null, VCH), /no scenarios array/);
  const many = cscenarios({ scenarios: Array.from({ length: 1001 }, (_, i) => ({ ...cscenarios().scenarios[0], id: `S-${i + 1}` })) });
  assert.throws(() => VF.scenarioPlan(many, VCH), /more than 1000/);
});

test('verifiable: each why value, and ok, without throwing', () => {
  const base = CFG.parseConfig({ app: { cli: { command: ['node', './bin/cli.mjs'] } } }).config;
  const api = CFG.parseConfig({ app: { start: ['node', 's.mjs'], base_url: 'http://127.0.0.1:4100', ready: { url: 'http://127.0.0.1:4100/h' } } }).config;
  assert.deepEqual(VF.verifiable(cscenarios(), base), { ok: true });
  assert.deepEqual(VF.verifiable(cscenarios({ scenarios: [apiScenario] }), api), { ok: true });
  assert.deepEqual(VF.verifiable(cscenarios({ scenarios: [uiScenario] }), base), { ok: false, why: 'ui scenarios' });
  assert.deepEqual(VF.verifiable(cscenarios({ scenarios: [...cscenarios().scenarios, uiScenario] }), base), { ok: false, why: 'ui scenarios' });
  assert.deepEqual(VF.verifiable(cscenarios({ scenarios: [...cscenarios().scenarios, apiScenario] }), { app: { ...api.app, cli: base.app.cli } }), { ok: false, why: 'mixed kinds' });
  assert.deepEqual(VF.verifiable(cscenarios(), api), { ok: false, why: 'needs app.cli' });
  assert.deepEqual(VF.verifiable(cscenarios(), { app: { cli: { command: ['/usr/bin/node', 'x'], timeout_s: 5 } } }), { ok: false, why: 'needs app.cli' });
  assert.deepEqual(VF.verifiable(cscenarios(), { app: { cli: { command: ['node', './a/../../x'], timeout_s: 5 } } }), { ok: false, why: 'needs app.cli' });
  assert.deepEqual(VF.verifiable(cscenarios({ scenarios: [apiScenario] }), base), { ok: false, why: 'needs app.start' });
  assert.deepEqual(VF.verifiable(cscenarios({ scenarios: [apiScenario] }), { app: { ...api.app, base_url: 'http://example.com:80' } }), { ok: false, why: 'needs app.start' });
  assert.deepEqual(VF.verifiable(cscenarios({ scenarios: [apiScenario] }), { app: { ...api.app, ready: { url: 'http://127.0.0.1:4101/h' } } }), { ok: false, why: 'needs app.start' });
  for (const doc of [null, undefined, {}, { scenarios: [] }, { scenarios: [{ kind: 'shell' }] }, 'x']) assert.deepEqual(VF.verifiable(doc, base), { ok: false, why: 'no scenarios' }, JSON.stringify(doc));
  assert.deepEqual(VF.verifiable(cscenarios(), undefined), { ok: false, why: 'needs app.cli' });
});

test('the api path is unchanged: an api set with app.start verifies as before (port checks, app start and stop)', async (t) => {
  const w = cworld(t, { scenarios: cscenarios({ scenarios: [apiScenario] }), app: { cli: null, start: ['node', 'server.mjs'], base_url: 'http://127.0.0.1:4123', ready: { url: 'http://127.0.0.1:4123/health' } } });
  const r = await VF.verifyFeature(w.args(), cseams(w.log, {
    startSandboxed: (argv, o) => { w.log.push(['start', argv, o]); return { pid: 0, pgid: 0, up: true }; },
    stopApp: async (app) => { w.log.push(['stop']); app.up = false; },
    alive: (app) => app.up, waitReady: async () => true,
    runApiScenario: async (sc, base) => { w.log.push(['api', sc.id, base]); return { status: 'pass' }; },
    runSandboxedCapture: mustNot('runSandboxedCapture'),
  }));
  assert.equal(r.verdict, 'pass');
  assert.equal(of(w.log, 'start').length, 2); assert.equal(of(w.log, 'stop').length, 2);
  assert.ok(of(w.log, 'port').length >= 4, 'port checks still run for api');
  const profiles = of(w.log, 'profile').map((e) => e[1]);
  assert.deepEqual(profiles.map((p) => p.network), ['registries', { localhostPort: 4123 }]);
  for (const p of profiles) { assert.deepEqual(p.writable, [w.wt]); assert.equal(p.readOnly, undefined); }
  assert.equal(of(w.log, 'start')[0][2].env.PORT, '4123');
  assert.equal('families' in r, false, 'the api result shape is unchanged');
});

// ---- the sandbox profile -------------------------------------------------------------------------------------------------------
test('sandboxProfile readOnly: read allowed, never written; must be under FACTORY_HOME; not inside a writable path', (t) => {
  const root = fs.realpathSync(tmpDir('cli-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fh = path.join(root, 'fh');
  const wt = path.join(fh, 'work', 'o__r', 'FEATURE-1-x'); fs.mkdirSync(wt, { recursive: true });
  const tmp = SBX.makeRunTemp(fh);
  t.after(() => SBX.removeRunTemp(tmp));
  const kase = path.join(tmp, 'case-1'); fs.mkdirSync(kase);
  const p = SBX.sandboxProfile({ writable: [kase], readOnly: [wt], tmpDir: tmp, network: 'none', factoryHome: fh });
  assert.ok(p.includes(`(allow file-read* (subpath "${wt}"))`), 'worktree readable');
  const rw = p.split('\n').filter((l) => l.includes('file-write*') && l.startsWith('(allow'));
  assert.ok(rw.length > 0 && rw.every((l) => !l.includes(`"${wt}"`)), 'worktree never in a write allow');
  assert.ok(rw.some((l) => l.includes(`"${kase}"`)), 'case folder writable');
  assert.ok(p.includes('(deny network*)'));
  const outside = path.join(root, 'elsewhere'); fs.mkdirSync(outside);
  assert.throws(() => SBX.sandboxProfile({ readOnly: [outside], tmpDir: tmp, network: 'none', factoryHome: fh }), /must be inside/);
  assert.throws(() => SBX.sandboxProfile({ writable: [wt], readOnly: [path.join(wt)], tmpDir: tmp, network: 'none', factoryHome: fh }), /inside a writable path/);
  assert.throws(() => SBX.sandboxProfile({ readOnly: '/x', network: 'none', factoryHome: fh }), /arrays/);
});

// ---- real sandbox --------------------------------------------------------------------------------------------------------------
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
test('real sandbox: output and file checks pass; writing into the worktree is denied (and fails a scenario that needs it); env as pinned', { skip: SBX_SKIP }, async (t) => {
  const w = cworld(t, { scenarios: { feature: 'FEATURE-001', criteria_hash: VCH, canary: CANARY, scenarios: [] } });
  const tmpRe = `^${reEsc(w.tmpRoot)}/[0-9a-f]+/run-[0-9a-f]+`;
  const doc = cscenarios({ scenarios: [
    { id: 'S-1', covers: ['AC-1'], kind: 'cli', run: { args: ['about'] }, assert: [{ exit: 0 }, { stdout: { equals: 'hello from cli\n' } }, { stderr: { equals: '' } }] },
    { id: 'S-2', covers: ['AC-2'], kind: 'cli', run: { args: ['write-case'] }, assert: [{ exit: 0 }, { file: 'out.txt', equals: 'ok' }] },
    { id: 'S-3', covers: ['AC-3'], kind: 'cli', run: { args: ['write-wt'] }, assert: [{ exit: 0 }, { stdout: { contains: 'denied:EPERM' } }] },
    { id: 'S-4', covers: ['AC-4'], kind: 'cli', run: { args: ['write-wt-strict'] }, assert: [{ exit: 0 }] },
    { id: 'S-5', covers: ['AC-5'], kind: 'cli', run: { args: ['env'] }, assert: [{ exit: 0 }, { stdout: { json_path: '$.ci', equals: '1' } }, { stdout: { json_path: '$.nc', equals: '1' } },
      { stdout: { json_path: '$.home', matches: `${tmpRe}/home$` } }, { stdout: { json_path: '$.tmp', matches: `${tmpRe}$` } }, { stdout: { json_path: '$.cwd', matches: `${tmpRe}/case$` } }] },
    { id: 'S-6', covers: ['AC-6'], kind: 'cli', setup: { runs: [{ args: ['remember'] }] }, run: { args: ['remember'] }, assert: [{ exit: 0 }, { stdout: { equals: 'carried\n' } }] },
    { id: 'S-7', covers: ['AC-7'], kind: 'cli', run: { args: ['remember'] }, assert: [{ exit: 0 }, { stdout: { equals: 'fresh\n' } }] },
  ] });
  const r = await VF.verifyFeature(w.args({ scenarios: doc }));
  assert.deepEqual(r.doc.results.map((x) => [x.id, x.status, x.flaky]), [['S-1', 'pass', false], ['S-2', 'pass', false], ['S-3', 'pass', false], ['S-4', 'fail', false], ['S-5', 'pass', false], ['S-6', 'pass', false], ['S-7', 'pass', false]]);
  assert.deepEqual(r.brief, [`AC-4: ${VF.CLI_SYMPTOM} (exit)`]);
  assert.deepEqual(r.families, { 'S-4': 'exit' });
  assert.ok(!fs.existsSync(w.wt), 'worktree removed');
});
