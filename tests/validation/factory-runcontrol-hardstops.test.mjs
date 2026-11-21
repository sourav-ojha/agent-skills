// factory hard stops (Phase 2, P2.2): the matrix, each row's proof, and unproven-row reporting at `factory run` start.
// Hard stop hs-delivery-config is proven here: `.product/delivery.json` is a G4 protected path and a builder diff raising a
// budget in it is held (built and merge stage).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO, tmpDir } from './helpers.mjs';
import { SCRIPTS, BASE_CONFIG, ready, good, provingProbe } from './factory-world.mjs';

const HS = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'hardstops.mjs')).href);
const ag = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'antigaming.mjs')).href);
const S = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'sessions.mjs')).href);
const { ROUTES } = await import(pathToFileURL(path.join(SCRIPTS, 'probe.mjs')).href);
const BUILDER = JSON.parse(fs.readFileSync(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'settings', 'builder.json'), 'utf8'));

const probeRows = HS.HARD_STOPS.filter((r) => r.proof.kind === 'probe');
const routesOf = (row) => HS.proofRoutes(row);
// A proving result for a fake home and FACTORY_HOME, and the matching options (as reportHardStops passes them).
const HOME = '/Users/probe-user'; const FH = '/Users/probe-user/.factory';
const OPTS = { home: HOME, factoryHome: FH, builderSha: HS.builderSettingsSha() };
const allDenied = () => provingProbe({ home: HOME, fhome: FH });

// ---- the matrix ---------------------------------------------------------------------------------------------------------------
test('HARD_STOPS: seven P2.2 rows with unique ids, a mechanism and a test or probe proof', () => {
  assert.equal(HS.HARD_STOPS.length, 7);
  assert.deepEqual(HS.HARD_STOPS.map((r) => r.id), ['hs-secrets', 'hs-network', 'hs-destructive-data', 'hs-merge-gate', 'hs-delivery-config', 'hs-factory-state', 'hs-run-history']);
  for (const r of HS.HARD_STOPS) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'mechanism', 'name', 'proof'], r.id);
    assert.ok(typeof r.name === 'string' && r.name && typeof r.mechanism === 'string' && r.mechanism.length > 20, r.id);
    assert.ok(['test', 'probe'].includes(r.proof.kind), r.id);
  }
  assert.ok(Object.isFrozen(HS.HARD_STOPS));
});

test('every test-proof ref names a test file that exists and has a test whose title starts with the row id', () => {
  const refs = HS.HARD_STOPS.filter((r) => r.proof.kind === 'test');
  assert.ok(refs.length >= 3);
  for (const r of refs) {
    assert.match(r.proof.ref, /^[\w.-]+\.test\.mjs$/, r.id);
    const file = path.join(REPO, 'tests', 'validation', r.proof.ref);
    assert.ok(fs.existsSync(file), `${r.id}: ${r.proof.ref} is missing`);
    const title = new RegExp(`^\\s*(?:test|it)\\(\\s*(['"\`])${r.id}:`, 'm');
    assert.match(fs.readFileSync(file, 'utf8'), title, `${r.id}: no test( / it( title in ${r.proof.ref} starts with the row id`);
  }
});

test('every probe-proof route is a real probe route', () => {
  assert.ok(probeRows.length >= 3);
  for (const r of probeRows) for (const route of routesOf(r)) assert.ok(ROUTES.includes(route), `${r.id}: ${route}`);
  // the new routes: FACTORY_HOME state and the outbound connect through Bash
  for (const route of ['write stop/', 'write runs/', 'write usage/', 'write records/', 'write config.json', 'net bash']) assert.ok(probeRows.some((r) => routesOf(r).includes(route)), route);
});

// ---- hs-network: static half (the tool layer) -----------------------------------------------------------------------------------
test('hs-network: (static tool half) the builder settings deny WebFetch and WebSearch, project MCP servers are off and buildArgv passes --strict-mcp-config', () => {
  for (const tool of ['WebFetch', 'WebSearch']) assert.ok(BUILDER.permissions.deny.includes(tool), tool);
  assert.equal(BUILDER.enableAllProjectMcpServers, false);
  assert.deepEqual(BUILDER.sandbox.network.allowedDomains, []);
  const argv = S.buildArgv({ role: 'builder', prompt: 'x', settingsFile: '/s.json', maxTurns: 5 });
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.ok(!argv.includes('--mcp-config'), 'no MCP server is configured for the builder');
});

// ---- hs-delivery-config -------------------------------------------------------------------------------------------------------
function repo(files) {
  const root = tmpDir('hardstops-');
  const origin = path.join(root, 'origin.git'); const work = path.join(root, 'work');
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 't'], ['commit.gpgsign', 'false']]) sh(work, 'config', k, v);
  sh(work, 'remote', 'add', 'origin', origin);
  const write = (fs_) => { for (const [p, c] of Object.entries(fs_)) { fs.mkdirSync(path.dirname(path.join(work, p)), { recursive: true }); fs.writeFileSync(path.join(work, p), c); } };
  write(files); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'base'); sh(work, 'push', '-q', 'origin', 'main'); sh(work, 'fetch', '-q', 'origin');
  sh(work, 'checkout', '-q', '-b', 'feat');
  const git = (...a) => { const r = spawnSync('git', a, { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { root, git, change: (fs_) => { write(fs_); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'change'); return sh(work, 'rev-parse', 'HEAD'); } };
}

test('hs-delivery-config: .product/delivery.json is a G4 protected path; a builder diff raising the feature budget is held', (t) => {
  assert.equal(ag.isProtectedPath('.product/delivery.json'), true);
  assert.equal(ag.isProtectedPath('.PRODUCT/Delivery.json'), true, 'case-insensitive');
  const cfg = (tokens) => `${JSON.stringify({ ...BASE_CONFIG, budgets: { feature: { tokens, turns: 400 } } }, null, 2)}\n`;
  const fx = repo({ '.product/delivery.json': cfg(3000000), 'src/a.js': 'x\n' });
  t.after(() => fs.rmSync(fx.root, { recursive: true, force: true }));
  const head = fx.change({ '.product/delivery.json': cfg(900000000), 'src/a.js': 'y\n' });
  const hits = ag.checkDiff({ git: fx.git, baseRef: 'refs/remotes/origin/main', headSha: head, config: {}, specPaths: [] });
  assert.deepEqual(hits.find((h) => h.id === 'G4')?.files, ['.product/delivery.json']);
  assert.equal(ag.classify(hits, 'built'), 'hold');
  assert.equal(ag.classify(hits, 'merge'), 'hold');
  assert.deepEqual(ag.holdReason(hits), { kind: 'antigaming', ids: ['G4'] });
});

// ---- unprovenRows ---------------------------------------------------------------------------------------------------------------
const ids = (rows) => rows.map((r) => r.id);
test('unprovenRows: null (no saved result) returns every probe row; a proving result returns none; one leaked route returns its row', () => {
  assert.deepEqual(ids(HS.unprovenRows(null, OPTS)), ids(probeRows));
  assert.deepEqual(ids(HS.unprovenRows(allDenied(), OPTS)), []);
  const one = allDenied(); one.routes['write records/'] = 'leaked';
  assert.deepEqual(ids(HS.unprovenRows(one, OPTS)), ['hs-run-history']);
  assert.equal(HS.whyUnproven(HS.HARD_STOPS.find((r) => r.id === 'hs-run-history'), one, OPTS), 'not denied: write records/');
  const err = allDenied(); err.routes['net bash'] = 'error';
  assert.deepEqual(ids(HS.unprovenRows(err, OPTS)), ['hs-network']);
  const missing = allDenied(); delete missing.routes['write stop/'];
  assert.deepEqual(ids(HS.unprovenRows(missing, OPTS)), ['hs-factory-state'], 'a route absent from the saved result is unproven');
  for (const bad of [{}, { routes: null }, { routes: [] }, { routes: {} }, 'x', 5]) assert.deepEqual(ids(HS.unprovenRows(bad, OPTS)), ids(probeRows), JSON.stringify(bad));
  assert.ok(HS.unprovenRows(null, OPTS).every((r) => r.proof.kind === 'probe'), 'test-proof rows are never reported');
});

test('hs-secrets: one probed directory never proves the row; every credential class as a saved target does', () => {
  assert.deepEqual(HS.HARD_STOPS.find((r) => r.id === 'hs-secrets').proof.targets, ['.ssh', '.aws', '.config/gh', '.netrc']);
  const sec = HS.HARD_STOPS.find((r) => r.id === 'hs-secrets');
  const onlySsh = allDenied(); onlySsh.targets = onlySsh.targets.filter((t) => t.target === `${HOME}/.ssh`);
  assert.deepEqual(ids(HS.unprovenRows(onlySsh, OPTS)), ['hs-secrets']);
  assert.equal(HS.whyUnproven(sec, onlySsh, OPTS), 'targets not proven: ~/.aws, ~/.config/gh, ~/.netrc');
  assert.equal(HS.whyUnproven(sec, allDenied(), OPTS), null, 'all four classes: proven');
  const leakAws = allDenied(); leakAws.targets.find((t) => t.target === `${HOME}/.aws`).routes['node -e'] = 'leaked';
  assert.equal(HS.whyUnproven(sec, leakAws, OPTS), 'targets not proven: ~/.aws');
  const gapGh = allDenied(); delete gapGh.targets.find((t) => t.target === `${HOME}/.config/gh`).routes.tar;
  assert.equal(HS.whyUnproven(sec, gapGh, OPTS), 'targets not proven: ~/.config/gh', 'a read route missing for a target is unproven');
  const elsewhere = allDenied(); for (const t of elsewhere.targets) t.target = t.target.replace(HOME, '/tmp/other');
  assert.equal(HS.whyUnproven(sec, elsewhere, OPTS), 'targets not proven: ~/.ssh, ~/.aws, ~/.config/gh, ~/.netrc', 'targets under another home prove nothing');
  const flat = allDenied(); flat.routes = { ...flat.routes, ...Object.fromEntries(HS.READ_ROUTES.map((r) => [r, 'denied'])) }; flat.targets = [];
  assert.equal(HS.whyUnproven(sec, flat, OPTS)?.startsWith('targets not proven'), true, 'top-level read routes are not target evidence');
});

test('evidence: FACTORY_HOME rows need the real FACTORY_HOME; a result for other builder settings (or none recorded) proves no probe row', () => {
  const other = allDenied(); other.factory_home = '/tmp/stub-home';
  assert.deepEqual(ids(HS.unprovenRows(other, OPTS)), ['hs-factory-state', 'hs-run-history']);
  assert.equal(HS.whyUnproven(HS.HARD_STOPS.find((r) => r.id === 'hs-factory-state'), other, OPTS), 'the saved probe ran against another FACTORY_HOME');
  const none = allDenied(); delete none.factory_home;
  assert.deepEqual(ids(HS.unprovenRows(none, OPTS)), ['hs-factory-state', 'hs-run-history']);
  const stale = allDenied(); stale.builder_settings_sha256 = 'f'.repeat(64);
  assert.deepEqual(ids(HS.unprovenRows(stale, OPTS)), ids(probeRows));
  assert.equal(HS.whyUnproven(probeRows[0], stale, OPTS), 'the saved probe result is for other builder settings');
  const noSha = allDenied(); delete noSha.builder_settings_sha256;
  assert.deepEqual(ids(HS.unprovenRows(noSha, OPTS)), ids(probeRows));
  assert.deepEqual(ids(HS.unprovenRows(allDenied(), { ...OPTS, builderSha: '0'.repeat(64) })), ids(probeRows), 'builder.json changed since the save');
  assert.match(HS.builderSettingsSha(), /^[0-9a-f]{64}$/);
});

test('FACTORY_HOME match is by real path (a symlink to the real FACTORY_HOME counts)', () => {
  const d = tmpDir('hardstops-real-');
  try {
    const realHome = path.join(d, 'factory'); fs.mkdirSync(realHome); fs.symlinkSync(realHome, path.join(d, 'link'));
    const res = provingProbe({ home: HOME, fhome: path.join(d, 'link') });
    assert.deepEqual(ids(HS.unprovenRows(res, { ...OPTS, factoryHome: realHome })), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('loadProbeResult: absent, corrupt or symlinked -> null; a regular private file is read', () => {
  const home = tmpDir('hardstops-home-');
  try {
    assert.equal(HS.loadProbeResult(home), null);
    fs.mkdirSync(path.join(home, 'probes'), { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'probes', 'last.json'), '{bad');
    assert.equal(HS.loadProbeResult(home), null);
    fs.writeFileSync(path.join(home, 'probes', 'last.json'), JSON.stringify(allDenied()));
    assert.deepEqual(HS.loadProbeResult(home), allDenied());
    const elsewhere = tmpDir('hardstops-link-');
    fs.writeFileSync(path.join(elsewhere, 'last.json'), JSON.stringify(allDenied()));
    fs.rmSync(path.join(home, 'probes'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home, 'probes'));
    assert.equal(HS.loadProbeResult(home), null, 'a symlinked probes directory is not trusted');
    fs.rmSync(path.join(home, 'probes'));
    fs.mkdirSync(path.join(home, 'probes'), { mode: 0o700 });
    fs.symlinkSync(path.join(elsewhere, 'last.json'), path.join(home, 'probes', 'last.json'));
    assert.equal(HS.loadProbeResult(home), null, 'a symlinked result file is not trusted');
    fs.rmSync(elsewhere, { recursive: true, force: true });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- factory run --------------------------------------------------------------------------------------------------------------
const attentionItems = (w) => { const f = path.join(w.fhome, 'attention', 'o__r.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : []; };

test('factory run with no saved probe result: prints every probe-proof row as unproven, adds one attention row, and still runs', (t) => {
  const w = ready(t, { probe: null, specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  for (const row of probeRows) assert.match(r.out, new RegExp(`^unproven hard stop: ${row.id} ${row.name} \\(no saved probe result\\)$`, 'm'), row.id);
  for (const row of HS.HARD_STOPS.filter((x) => x.proof.kind === 'test')) assert.ok(!r.out.includes(`unproven hard stop: ${row.id}`), row.id);
  assert.equal(w.queue().features[0].state, 'merged', 'the warning does not block the run');
  const items = attentionItems(w).filter((i) => i.kind === 'unproven_hardstop');
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'medium');
  assert.equal(items[0].run, HS.PROBE_RUN);
  assert.match(items[0].run, /probe\.mjs .*--save/);
  for (const row of probeRows) assert.ok(items[0].what.includes(row.id), row.id);
});

test('factory run with a saved result: only the leaked row is printed; all denied prints nothing and clears the attention row', (t) => {
  const w = ready(t, { probe: (p) => { p.routes['write records/'] = 'leaked'; return p; }, specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(r.out.split('\n').filter((l) => l.startsWith('unproven hard stop:')), ['unproven hard stop: hs-run-history editing the run history (not denied: write records/)']);
  assert.equal(attentionItems(w).filter((i) => i.kind === 'unproven_hardstop').length, 1);
  fs.writeFileSync(path.join(w.fhome, 'probes', 'last.json'), JSON.stringify(provingProbe({ home: w.home, fhome: w.fhome })));
  const again = w.factory(['run']);
  assert.ok(!again.out.includes('unproven hard stop:'), again.out);
  assert.equal(attentionItems(w).filter((i) => i.kind === 'unproven_hardstop').length, 0, 'a proven matrix resolves the attention row');
});
