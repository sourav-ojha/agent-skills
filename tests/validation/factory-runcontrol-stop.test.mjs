// factory run control (Task 9): stop, status, --continue, --raise-budget, the lock inspection and the interactive deliver guards.
// Integration through the shared harness (factory-world.mjs: fake claude, fake gh, local origin); runs that must be stopped while
// they work are spawned in the background and stopped with the real `factory stop` command.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO } from './helpers.mjs';
import { SCRIPTS, BASE_CONFIG, world, readiness, good, ready, builderRuns, promptOf } from './factory-world.mjs';

const L = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'lock.mjs')).href);
const VF = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'verify.mjs')).href);
const P = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'proc.mjs')).href);
const U = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'usage.mjs')).href);
const AT = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'attention.mjs')).href);
const D = await import(pathToFileURL(path.join(SCRIPTS, 'lib', 'driver.mjs')).href);
const FX = await import(pathToFileURL(path.join(SCRIPTS, 'factory.mjs')).href);

const HARNESS = path.join(REPO, 'tests', 'fixtures', 'factory-harness.mjs');
const DELIVER = path.join(SCRIPTS, 'deliver.mjs');
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const H = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const GUARD = /a factory run holds this repository; run factory stop first/;
const FLAG_GUARD = /a factory stop is pending for this repository/;
const CONTINUE = /continue from the current branch and the `\.implementation\/FEATURE-001\/` ledger; finish with `result\.json`/;
const ONE = { 'FEATURE-001': 'Items one' };

const flagFile = (w) => path.join(w.fhome, 'stop', 'o__r');
const runState = (w) => JSON.parse(fs.readFileSync(path.join(w.fhome, 'runs', 'o__r.json'), 'utf8'));
const subjects = (w, branch) => w.sh(w.builder, 'log', '--format=%s', branch).split('\n');
const lines = (w, name) => { const f = path.join(w.fhome, name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };
const writeLocal = (w, doc) => fs.writeFileSync(path.join(w.fhome, 'config.json'), JSON.stringify(doc));

// A factory command in the background: { child, done: Promise<{ code, signal, out }>, out() }.
function bg(w, args, extra = {}) {
  const child = spawn(process.execPath, [HARNESS, ...args, '--dir', w.work], { env: { ...w.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const done = new Promise((r) => { child.on('close', (code, signal) => r({ code, signal, out })); });
  return { child, done, out: () => out };
}
async function until(fn, what, ms = 90000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(100); }
}
// Interactive deliver (no FACTORY_DRIVER_PID unless given) on the factory queue in the driver clone.
const deliverI = (w, args, extra = {}) => { const r = spawnSync(process.execPath, [DELIVER, ...args, '--dir', w.clone], { encoding: 'utf8', env: { ...w.env, DELIVER_QUEUE: w.queueFile, ...extra } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

// ---- inspect (unit) ----------------------------------------------------------------------------------------------------------------------
test('inspect: absent, live (own pid), stale (dead pid with a different start), unreadable (garbage file) and it never modifies the lock', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-inspect-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(L.inspect('o__r', { home }), { state: 'absent', pid: null });
  assert.equal(fs.existsSync(path.join(home, 'locks', 'o__r.lock')), false, 'inspect creates nothing');
  const snap = () => { const f = path.join(home, 'locks', 'o__r.lock'); const st = fs.statSync(f); return { bytes: fs.readFileSync(f, 'utf8'), mtime: st.mtimeMs, ino: st.ino, dir: fs.readdirSync(path.join(home, 'locks')).sort() }; };
  // live: this process holds it.
  const h = L.acquire('o__r', { home });
  const before = snap();
  assert.deepEqual(L.inspect('o__r', { home }), { state: 'live', pid: process.pid });
  assert.deepEqual(snap(), before, 'a live lock is left exactly as it is');
  assert.equal(h.owned(), true);
  h.release();
  // stale: a valid lock naming a pid whose start time differs now (recycled or dead).
  const doc = { v: 1, pid: 424242, start: 'ps:Thu Nov 5 10:11:12 2026', token: 'a'.repeat(32), groups: [], orphans: [] };
  fs.writeFileSync(path.join(home, 'locks', 'o__r.lock'), JSON.stringify(doc));
  const sys = { source: 'ps', startOf: (pid) => (pid === 424242 ? 'ps:Fri Nov 6 10:11:12 2026' : null), table: () => [], kill: () => {} };
  const s0 = snap();
  assert.deepEqual(L.inspect('o__r', { home, sys }), { state: 'stale', pid: 424242 });
  assert.deepEqual(L.inspect('o__r', { home, sys: { ...sys, startOf: () => null } }), { state: 'stale', pid: 424242 }, 'no such pid');
  assert.deepEqual(L.inspect('o__r', { home, sys: { ...sys, startOf: () => doc.start } }), { state: 'live', pid: 424242 }, 'same start: live');
  assert.deepEqual(L.inspect('o__r', { home, sys: { ...sys, startOf: () => { throw new L.LockError('LOCK_PS', 'x'); } } }), { state: 'live', pid: 424242 }, 'cannot tell: held');
  assert.deepEqual(snap(), s0, 'a stale lock is not taken over or removed');
  // unreadable: garbage.
  fs.writeFileSync(path.join(home, 'locks', 'o__r.lock'), 'not a lock{');
  const s1 = snap();
  assert.deepEqual(L.inspect('o__r', { home }), { state: 'unreadable', pid: null });
  assert.deepEqual(snap(), s1);
});

test('driver: RESULTS.ci has stopped, and a stopped CI wait is routed to the stop interruption in pr_open', () => {
  assert.ok(D.RESULTS.ci.includes('stopped'));
  assert.deepEqual({ ...D.nextAction({ id: 'FEATURE-001', state: 'pr_open', history: [] }, { step: 'ci', kind: 'stopped' }, { max_fix_rounds: 2, stop: null }) }, { do: 'interrupt', kind: 'stop' });
});

test('the stop sweep env rule uses only the run temps this driver created: another repository\'s run temp under FACTORY_HOME/tmp is left alone', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sweep-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fh = path.join(root, 'fhome');
  for (const d of ['locks', 'tmp/0123456789abcdef01234567', 'tmp/fedcba9876543210fedcba98']) fs.mkdirSync(path.join(fh, d), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(fh, 'locks', 'x__y.lock'), '{}'); // another repository's driver is running
  const other = path.join(fh, 'tmp', '0123456789abcdef01234567');
  const mine = path.join(fh, 'tmp', 'fedcba9876543210fedcba98');
  // A run temp this driver created, recorded through the verification seam (as stepVerify passes it to verifyFeature).
  const ctx = { fh, key: 'o__r', bRoot: path.join(root, 'b'), D: path.join(root, 'clone'), policy: {}, deps: { verifySeams: { makeRunTemp: () => mine } }, out: () => {} };
  assert.equal(FX.verifySeamsFor(ctx).makeRunTemp(), mine);
  assert.deepEqual(ctx.runTemps, [mine]);
  const keep = 'setTimeout(() => {}, 120000)';
  const start = (tmp) => spawn(process.execPath, ['-e', keep], { cwd: os.tmpdir(), env: { ...process.env, TMPDIR: tmp }, stdio: 'ignore' });
  const theirs = start(other); const ours = start(mine);
  t.after(() => { for (const c of [theirs, ours]) try { c.kill('SIGKILL'); } catch { /* gone */ } });
  await until(() => VF.survivorPids([], { sandbox: [mine, other] }).killable.size >= 2, 'both processes listed', 10000);
  await FX.killLeftovers(ctx);
  await until(() => ours.exitCode !== null || ours.signalCode !== null, 'our sandboxed process to end', 15000);
  assert.equal(theirs.exitCode, null, 'the other repository\'s verification process survives');
  assert.doesNotThrow(() => process.kill(theirs.pid, 0));
  theirs.kill('SIGKILL');
});

// ---- the stop flag ---------------------------------------------------------------------------------------------------------------------------
test('stop writes the flag; run without --continue refuses with the fix line naming --continue; plain scenarios refuses and keeps it; run --continue removes the flag and carries on', (t) => {
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const s = w.factory(['stop']);
  assert.equal(s.code, 0, s.out + s.err);
  assert.match(s.out, /^stop requested for o\/r \(graceful\)$/m);
  assert.match(s.out, /no factory run is active/);
  const flag = JSON.parse(fs.readFileSync(flagFile(w), 'utf8'));
  assert.equal(flag.now, false); assert.match(flag.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(fs.existsSync(path.join(w.fhome, 'locks', 'o__r.lock')), false, 'stop takes no lock');
  const r = w.factory(['run']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^refused: a stop was requested for this repository/m);
  assert.match(r.out, /^fix: .*factory run --continue/m);
  assert.equal(fs.existsSync(w.queueFile), false, 'nothing ran');
  const sc = w.factory(['scenarios']);
  assert.equal(sc.code, 1, sc.out + sc.err);
  assert.match(sc.out, /^fix: .*factory run --continue/m);
  assert.ok(fs.existsSync(flagFile(w)), 'a plain factory scenarios does not clear the flag');
  const c = w.factory(['run', '--continue']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.equal(fs.existsSync(flagFile(w)), false, '--continue removed the flag');
  assert.equal(w.queue().features[0].state, 'merged');
});

test('graceful stop during a session aborts it, WIP-commits its edits, ends status stopped with exit 2 and starts no new session; run --continue continues the step', async (t) => {
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/FEATURE-001.wip': 'half\n' }, linger_ms: 60000 }, { ...good('FEATURE-001'), require_files: ['src/FEATURE-001.wip'] }] } } });
  const run = bg(w, ['run']);
  await until(() => builderRuns(w, 'FEATURE-001').length === 1 && fs.existsSync(path.join(w.builder, 'src', 'FEATURE-001.wip')), 'the builder session');
  const s = w.factory(['stop']);
  assert.equal(s.code, 0, s.out + s.err);
  assert.doesNotMatch(s.out, /no factory run is active/);
  const r = await run.done;
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^stopped: stop$/m);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1, 'no new session');
  const stoppedRows = JSON.parse(fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.json'), 'utf8'));
  assert.deepEqual(stoppedRows.map((i) => [i.id, i.kind, i.run]), [['FEATURE-001', 'stopped', 'factory run --continue']]);
  assert.equal(runState(w).status, 'stopped');
  assert.match(runState(w).reason, /stop/);
  const f = w.queue().features[0];
  assert.equal(f.state, 'building'); assert.equal(f.interrupted.kind, 'stop');
  assert.ok(subjects(w, f.branch).includes('wip(FEATURE-001): interrupted (stop)'), subjects(w, f.branch).join(' | '));
  const c = w.factory(['run', '--continue']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.equal(w.queue().features[0].state, 'merged');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.json'), 'utf8')), [], '--continue resolves the stopped row');
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2); assert.match(promptOf(runs[1]), CONTINUE);
  // The final record still says the person stopped it (sticky across the continue), and nothing else was flagged.
  const rec = w.records().filter((x) => x.feature === 'FEATURE-001').pop();
  assert.equal(rec.outcome, 'merged'); assert.equal(rec.stopped_by_user, true); assert.equal(rec.budget_hit, false);
});

test('after stop no process with the factory clone or work directory as cwd survives, and the app port from app.ready.url is free', async (t) => {
  const port = await freePort();
  const config = { ...BASE_CONFIG, app: { start: ['node', 'server.js'], ready: { url: `http://127.0.0.1:${port}/health`, timeout_s: 5 } } };
  const w = ready(t, { config, specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/x.wip': 'x\n' }, escape_ms: 120000, escape_port: port, linger_ms: 60000 }] } } });
  const run = bg(w, ['run']);
  await until(() => builderRuns(w, 'FEATURE-001').length === 1 && fs.existsSync(path.join(w.builder, 'src', 'x.wip')), 'the builder session');
  await until(() => VF.scanSurvivors([w.builder]) > 0, 'the escaped process', 10000);
  assert.equal(await P.portInUse(port, '127.0.0.1'), true, 'the escaped app listens');
  assert.equal(w.factory(['stop', '--now']).code, 0);
  const r = await run.done;
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^stopped: stop$/m);
  assert.equal(VF.scanSurvivors([w.builder, w.clone, path.join(w.fhome, 'work', 'o__r')]), 0, 'no survivor');
  assert.equal(await P.portInUse(port, '127.0.0.1'), false, 'the app port is free');
  assert.ok(subjects(w, w.queue().features[0].branch).includes('wip(FEATURE-001): interrupted (stop)'));
});

test('the stop kill sweep signals only processes whose cwd is in the clone (or started in a sandbox): one that only mentions the clone path in its argv survives (and detection still refuses to continue)', async (t) => {
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/x.wip': 'x\n' }, linger_ms: 60000 }] } } });
  const run = bg(w, ['run']);
  await until(() => builderRuns(w, 'FEATURE-001').length === 1 && fs.existsSync(path.join(w.builder, 'src', 'x.wip')), 'the builder session');
  const keep = 'setTimeout(() => {}, 120000)';
  const inClone = spawn(process.execPath, ['-e', keep], { cwd: w.builder, stdio: 'ignore' });
  const decoy = spawn(process.execPath, ['-e', keep, w.builder], { cwd: os.tmpdir(), stdio: 'ignore' }); // like `code <clone>`
  t.after(() => { for (const c of [inClone, decoy]) try { c.kill('SIGKILL'); } catch { /* gone */ } });
  const gone = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode !== null) r(true); else c.once('exit', () => r(true)); });
  await until(() => VF.scanSurvivors([w.builder]) >= 2, 'both processes listed', 10000);
  assert.equal(w.factory(['stop']).code, 0);
  const r = await run.done;
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^stopped: (leftovers|stop)$/m);
  assert.equal(await Promise.race([gone(inClone), sleep(15000).then(() => false)]), true, 'the process with its cwd in the clone was ended');
  assert.equal(decoy.exitCode, null, 'the decoy that only mentions the path is still running');
  assert.doesNotThrow(() => process.kill(decoy.pid, 0));
  assert.match(r.out, /^stopped: leftovers$/m, 'the broad detection still refuses to touch the branch while the decoy lives');
  decoy.kill('SIGKILL');
});

test('stop --now during the CI wait kills the deliver child within 15 s and the run ends stopped; the feature is still pr_open and the next run continues from CI', async (t) => {
  const w = ready(t, { specs: ONE, test: { ciArgs: ['--interval', '1', '--grace', '0', '--timeout', '900'] }, gh: { checkQueue: [[{ name: 'ci', bucket: 'pending', link: 'x', state: 'PENDING' }]] }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const run = bg(w, ['run']);
  await until(() => /^FEATURE-001 pr_open -> ci$/m.test(run.out()), 'the CI wait');
  await sleep(1500);
  const t0 = Date.now();
  assert.equal(w.factory(['stop', '--now']).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(flagFile(w), 'utf8')).now, true);
  const r = await run.done;
  const ms = Date.now() - t0;
  assert.ok(ms < 15000, `the run ended ${ms} ms after the stop`);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /^stopped: stop$/m);
  assert.equal(VF.scanSurvivors([w.clone]), 0, 'the deliver ci child is gone');
  assert.equal(w.queue().features[0].state, 'pr_open');
  assert.equal(runState(w).status, 'stopped');
  w.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]]; });
  const c = w.factory(['run', '--continue'], { FACTORY_TEST: JSON.stringify({}) });
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out.split('\n').find((l) => / -> /.test(l)), /^FEATURE-001 pr_open -> ci$/, 'continues from CI');
  assert.equal(w.queue().features[0].state, 'merged');
});

test('a second factory run is refused (LOCK_HELD); interactive deliver next/ci/merge refuse under a live lock and under the flag; the driver\'s own calls succeed; status and config are still allowed', async (t) => {
  const w = ready(t, { specs: ONE, fake: { plan: { 'FEATURE-001': [{ files: { 'src/a.wip': 'a\n' }, linger_ms: 60000 }, good('FEATURE-001')] } } });
  const run = bg(w, ['run']);
  await until(() => builderRuns(w, 'FEATURE-001').length === 1, 'the builder session');
  // The driver's own deliver calls (init, next) ran under its live lock: the feature is building.
  assert.equal(w.queue().features[0].state, 'building');
  const second = w.factory(['run']);
  assert.equal(second.code, 1, second.out + second.err);
  assert.match(second.out, /^refused: another factory run holds the lock for this repository$/m);
  for (const args of [['next'], ['ci', 'FEATURE-001'], ['merge', 'FEATURE-001']]) {
    const d = deliverI(w, args);
    assert.equal(d.code, 1, `${args[0]}: ${d.out}${d.err}`);
    assert.match(d.err, GUARD, args[0]);
  }
  const asDriver = deliverI(w, ['ci', 'FEATURE-001'], { FACTORY_DRIVER_PID: String(run.child.pid) });
  assert.doesNotMatch(asDriver.err, GUARD, 'the driver pid passes the guard');
  assert.match(asDriver.err, /building/, 'and reaches the command itself');
  assert.equal(deliverI(w, ['status', '--json']).code, 0, 'deliver status is allowed');
  assert.equal(deliverI(w, ['config']).code, 0, 'deliver config is allowed');
  const st = w.factory(['status', '--json']);
  assert.equal(st.code, 0, st.out + st.err);
  assert.equal(JSON.parse(st.out).lock, 'live');
  assert.equal(w.factory(['stop']).code, 0);
  assert.equal((await run.done).code, 2);
  // Under the flag (no live run now).
  for (const args of [['next'], ['ci', 'FEATURE-001'], ['merge', 'FEATURE-001']]) {
    const d = deliverI(w, args);
    assert.equal(d.code, 1, `${args[0]}: ${d.out}${d.err}`);
    assert.match(d.err, FLAG_GUARD, args[0]);
  }
  assert.equal(deliverI(w, ['status']).code, 0);
  assert.equal(w.factory(['status']).code, 0);
  const c = w.factory(['run', '--continue']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.equal(w.queue().features[0].state, 'merged');
});

// ---- --continue after a stop during a wait -------------------------------------------------------------------------------------------------
test('--continue after a stop during a usage-limit wait waits until the saved pause.reset_at before the interrupted step runs again', (t) => {
  const w = world(t, { specs: ONE, test: { now: NOW, classifierReal: true } });
  // The session itself creates the stop flag (a stop that arrives while the run is about to wait).
  w.setFake((s) => { s.plan = { 'FEATURE-001': [{ status: 'usage', limit: 'session', resets_at: (NOW + H) / 1000, files: { 'src/FEATURE-001.wip': 'w\n' }, touch: flagFile(w) }, { ...good('FEATURE-001'), require_files: ['src/FEATURE-001.wip'] }] }; });
  readiness(w);
  assert.equal(w.factory(['scenarios']).code, 0);
  writeLocal(w, { wait_for_reset: true });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /^stopped: stop$/m);
  const reset = iso(NOW + H + 120000);
  assert.equal(runState(w).pause.reset_at, reset);
  assert.deepEqual(lines(w, 'sleeps.log'), [], 'stopped before any sleep');
  const c = w.factory(['run', '--continue']);
  assert.equal(c.code, 0, c.out + c.err);
  assert.match(c.out, new RegExp(`^paused: usage_limit session until ${reset.replace(/\./g, '\\.')}$`, 'm'));
  assert.equal(lines(w, 'sleeps.log').map(Number).reduce((x, y) => x + y, 0), 62 * 60000, 'waited until the saved reset');
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2, 'one continued session, after the wait'); assert.match(promptOf(runs[1]), CONTINUE);
  assert.equal(w.queue().features[0].state, 'merged');
});

// ---- --raise-budget -------------------------------------------------------------------------------------------------------------------------
const FEATURE_CAP = { ...BASE_CONFIG, budgets: { feature: { tokens: 10000, turns: 400 } } };
const G2 = { 'test/items.test.js': "it.only('lists', () => {});\n" };
const AG_FIX = { files: { 'test/items.test.js': "it('lists', () => {});\n" }, commit: true };

test('--raise-budget FEATURE-001 on a budget-held feature doubles the caps, unholds it to its saved step and the run continues from the branch; on a feature that is not held it refuses and the queue is unchanged', (t) => {
  const w = ready(t, { config: FEATURE_CAP, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001', G2), tokens: 9655 }, AG_FIX], 'FEATURE-002': [good('FEATURE-002')] } } });
  assert.equal(w.factory(['run']).code, 2);
  let [f1, f2] = w.queue().features;
  assert.equal(f1.state, 'awaiting_human'); assert.equal(f1.hold_kind, 'budget'); assert.equal(f2.state, 'merged');
  const bytes = fs.readFileSync(w.queueFile, 'utf8');
  const no = w.factory(['run', '--raise-budget', 'FEATURE-002']);
  assert.equal(no.code, 1, no.out + no.err);
  assert.match(no.out, /^refused: FEATURE-002 is not held for a budget/m);
  assert.equal(fs.readFileSync(w.queueFile, 'utf8'), bytes, 'the queue is unchanged');
  const bad = w.factory(['run', '--raise-budget', 'FEATURE-001=lots']);
  assert.equal(bad.code, 1, bad.out); assert.equal(fs.readFileSync(w.queueFile, 'utf8'), bytes);
  const r = w.factory(['run', '--raise-budget', 'FEATURE-001']);
  assert.equal(r.code, 0, r.out + r.err);
  [f1] = w.queue().features;
  assert.deepEqual(f1.budget_cap, { tokens: 20000, turns: 800 });
  assert.equal(f1.state, 'merged');
  assert.equal(f1.budget_hold, undefined);
  const runs = builderRuns(w, 'FEATURE-001');
  // Continued from the branch, never reset: the first session's committed, done work resumes at built, and the anti-gaming fix
  // session the budget had refused now runs.
  assert.equal(runs.length, 2);
  assert.match(r.out, /^FEATURE-001 budget raised: tokens 20000, turns 800; continuing at building$/m);
  assert.match(r.out, /^FEATURE-001 building -> built$/m);
  assert.doesNotMatch(r.out, /-> build \(build\)/, 'no rebuild from the base');
  assert.match(promptOf(runs[1]), /Anti-gaming checks G2 fired/);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.json'), 'utf8')).some((i) => i.kind === 'budget' && i.id === 'FEATURE-001'), 'the budget attention row is resolved');
  // hold -> unhold -> continue -> merge: the final record still says the budget was hit; a feature that never hit one says false.
  const recs = w.records();
  const r1 = recs.filter((x) => x.feature === 'FEATURE-001').pop(), r2 = recs.filter((x) => x.feature === 'FEATURE-002').pop();
  assert.equal(r1.outcome, 'merged'); assert.equal(r1.budget_hit, true); assert.equal(r1.stopped_by_user, false);
  assert.equal(r2.budget_hit, false);
});

test('--raise-budget without a run in progress refuses before anything is written: no queue, no deliver init, the driver clone untouched', (t) => {
  const w = ready(t, { config: FEATURE_CAP, specs: ONE, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const a = w.factory(['run', '--raise-budget', 'FEATURE-001']);
  assert.equal(a.code, 1, a.out + a.err);
  assert.match(a.out, /^refused: --raise-budget needs a run in progress/m);
  assert.equal(fs.existsSync(w.queueFile), false, 'no queue was created');
  // The clone exists now (prepare); put it on another branch: a refused raise must not check out the base or clean it.
  w.sh(w.clone, 'checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(w.clone, 'untracked.txt'), 'x\n');
  const head = w.sh(w.clone, 'rev-parse', 'HEAD');
  const b = w.factory(['run', '--raise-budget', 'FEATURE-001']);
  assert.equal(b.code, 1, b.out + b.err);
  assert.equal(fs.existsSync(w.queueFile), false);
  assert.equal(w.sh(w.clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'side');
  assert.equal(w.sh(w.clone, 'rev-parse', 'HEAD'), head);
  assert.ok(fs.existsSync(path.join(w.clone, 'untracked.txt')), 'no clean');
  assert.equal(builderRuns(w, 'FEATURE-001').length, 0);
});

test('--raise-budget FEATURE-001=N sets the token cap to N', (t) => {
  const w = ready(t, { config: FEATURE_CAP, specs: ONE, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001', G2), tokens: 9655 }, AG_FIX] } } });
  assert.equal(w.factory(['run']).code, 2);
  const bytes = fs.readFileSync(w.queueFile, 'utf8');
  // A refusal after the raise was checked (missing scenarios) still leaves the feature held and unraised.
  const sc = path.join(w.fhome, 'scenarios', 'o__r', 'FEATURE-001.json');
  const scBytes = fs.readFileSync(sc);
  fs.rmSync(sc);
  const ms = w.factory(['run', '--raise-budget', 'FEATURE-001=50000']);
  assert.equal(ms.code, 1, ms.out + ms.err);
  assert.match(ms.out, /^refused: features without current approved scenarios: FEATURE-001/m);
  assert.equal(fs.readFileSync(w.queueFile, 'utf8'), bytes, 'still held, not raised');
  fs.writeFileSync(sc, scBytes);
  // =N when the turns cap is the spent dimension: the fix names the bare form (=N can never help there).
  const q = JSON.parse(bytes); q.features[0].budget_cap = { tokens: 10000, turns: 2 }; fs.writeFileSync(w.queueFile, JSON.stringify(q));
  const tn = w.factory(['run', '--raise-budget', 'FEATURE-001=50000']);
  assert.equal(tn.code, 1, tn.out + tn.err);
  assert.match(tn.out, /^refused: the raised cap of FEATURE-001 \(tokens 50000, turns 2\) is not above what it used/m);
  assert.match(tn.out, /^fix: raise both caps: factory run --raise-budget FEATURE-001$/m);
  fs.writeFileSync(w.queueFile, bytes);
  const r = w.factory(['run', '--raise-budget', 'FEATURE-001=50000']);
  assert.equal(r.code, 0, r.out + r.err);
  const f = w.queue().features[0];
  assert.deepEqual(f.budget_cap, { tokens: 50000, turns: 400 });
  assert.equal(f.state, 'merged');
});

// ---- status -------------------------------------------------------------------------------------------------------------------------------------
test('status --json fields and counts match a seeded queue, usage and attention', (t) => {
  const w = world(t, { specs: ONE });
  const reset = iso(Date.now() + 2 * H);
  fs.mkdirSync(path.join(w.fhome, 'queues'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.queueFile, JSON.stringify({ repo: 'o/r', base: 'main', policy: { budgets: { feature: { tokens: 10000, turns: 400 } } }, max_fix_rounds: 2, features: [
    { id: 'FEATURE-001', state: 'awaiting_human', hold_kind: 'budget', budget_cap: { tokens: 20000, turns: 800 }, sessions: [{ in: 100, out: 50, cache_create: 10, cache_read: 999, turns: 3 }, { in: 40, out: 0, cache_create: 0, turns: 1 }] },
    { id: 'FEATURE-002', state: 'building', sessions: [{ in: 7, out: 3, cache_create: 0, turns: 2 }] },
    { id: 'FEATURE-003', state: 'merged', sessions: [] },
  ] }));
  const day = U.localDay(new Date());
  fs.mkdirSync(path.join(w.fhome, 'usage', day), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(w.fhome, 'usage'), 0o700);
  fs.writeFileSync(path.join(w.fhome, 'usage', day, 'o__r.json'), JSON.stringify({ tokens: 1234, cache_read: 0, turns: 9 }));
  fs.writeFileSync(path.join(w.fhome, 'usage', day, 'x__y.json'), JSON.stringify({ tokens: 66, cache_read: 0, turns: 1 }));
  writeLocal(w, { budgets: { day_tokens: 50000 } });
  AT.addAttention(w.fhome, 'o__r', { id: 'FEATURE-001', kind: 'budget', severity: 'high', what: 'x', run: 'factory run --raise-budget FEATURE-001' });
  AT.addAttention(w.fhome, 'o__r', { id: 'run', kind: 'stopped', severity: 'high', what: 'y', run: 'factory run --continue' });
  fs.mkdirSync(path.join(w.fhome, 'runs'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(w.fhome, 'runs', 'o__r.json'), JSON.stringify({ status: 'paused', reason: null, current: { feature: 'FEATURE-002', state: 'building', action: 'build' }, pause: { kind: 'usage_limit', limit: 'session', reset_at: reset, estimated: false } }));
  const r = w.factory(['status', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  const s = JSON.parse(r.out);
  assert.equal(s.repo, 'o/r');
  assert.deepEqual(s.run, { status: 'paused', reason: null, current: { feature: 'FEATURE-002', state: 'building', action: 'build' }, started_at: null, ended_at: null });
  assert.equal(s.next_resume, reset);
  assert.deepEqual(s.pause, { kind: 'usage_limit', limit: 'session', reset_at: reset, estimated: false });
  assert.deepEqual(s.features, [
    { id: 'FEATURE-001', state: 'awaiting_human', hold_kind: 'budget', usage: { tokens: 200, turns: 4 }, caps: { tokens: 20000, turns: 800 } },
    { id: 'FEATURE-002', state: 'building', hold_kind: null, usage: { tokens: 10, turns: 2 }, caps: { tokens: 10000, turns: 400 } },
    { id: 'FEATURE-003', state: 'merged', hold_kind: null, usage: { tokens: 0, turns: 0 }, caps: { tokens: 10000, turns: 400 } },
  ]);
  assert.deepEqual(s.counts, { awaiting_human: 1, building: 1, merged: 1 });
  assert.deepEqual(s.day, { tokens: 1300, turns: 10, cap: 50000 });
  assert.equal(s.attention, 2);
  assert.equal(s.lock, 'absent');
  assert.equal(s.stop_requested, null);
  assert.equal(fs.existsSync(path.join(w.fhome, 'locks', 'o__r.lock')), false, 'status takes no lock');
  assert.equal(fs.existsSync(w.clone), false, 'status does not touch the clone');
  // The text form shows the same facts.
  const x = w.factory(['status']);
  assert.equal(x.code, 0, x.out + x.err);
  assert.match(x.out, /^run: paused$/m);
  assert.match(x.out, /^current: FEATURE-002 building -> build$/m);
  assert.match(x.out, new RegExp(`^next resume: ${reset.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(x.out, /^FEATURE-001 awaiting_human \(budget\) tokens 200\/20000 turns 4\/800$/m);
  assert.match(x.out, /^day: tokens 1300\/50000$/m);
  assert.match(x.out, /^attention: 2$/m);
});

test('a factory scenarios run after a stopped run leaves the stopped run state alone', (t) => {
  const w = ready(t, { specs: ONE, test: { now: NOW }, fake: { plan: { 'FEATURE-001': [{ status: 'usage', limit: 'weekly', resets_at: null }] } } });
  assert.equal(w.factory(['run']).code, 2);
  const before = runState(w);
  assert.equal(before.status, 'stopped');
  const s = w.factory(['scenarios']);
  assert.equal(s.code, 0, s.out + s.err);
  assert.deepEqual(runState(w), before, 'not overwritten by scenarios');
});
