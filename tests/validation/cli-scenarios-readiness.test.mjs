// cli scenarios: readiness C9, computeLevel's cliOnly option, fixItem and the factory start check (Task 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const FAKE_GH = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const c = await import(path.join(SK, 'config.mjs'));
const rd = await import(path.join(SK, 'readiness.mjs'));
const fc = await import(path.join(SK, 'factorycheck.mjs'));

const res = (id, status) => ({ id, status });
const pass = (ids) => ids.map((id) => res(id, 'pass'));
const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

function mkRepo(config, files = {}) {
  const root = tmpDir('c9-');
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(work, '.product'), { recursive: true });
  fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), body); }
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const trees = [];
  const worktree = (sha) => { const w = rd.gitWorktree(work, sha); trees.push(w); return w; };
  const gh = () => ({ code: 0, out: '', err: '' });
  const ctx = rd.makeCtx({ root: work, config: c.parseConfig(config).config, base: 'main', gh, repo: 'o/r', worktree });
  return { ctx, trees, cleanup: () => { for (const t of trees) t.remove(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const c9 = async (config, files) => {
  const r = mkRepo(config, files);
  try { const out = (await rd.runChecks(r.ctx, { only: ['C9'] })).find((x) => x.id === 'C9'); assert.ok(r.trees.every((t) => !fs.existsSync(t.dir))); return out; } finally { r.cleanup(); }
};

test('CHECKS: C9 is a level 4 check that runs commands', () => {
  assert.deepEqual(rd.CHECKS.find((x) => x.id === 'C9'), { id: 'C9', level: 4, runsCommands: true });
});

test('computeLevel: cli-only reaches 4 with C6-C8 skipped only when C9 passes and cliOnly is set', () => {
  const base = pass(['C1', 'C2', 'C3', 'C4', 'C5', 'C9']);
  const skipped = [...base, res('C6', 'skip'), res('C7', 'skip'), res('C8', 'skip')];
  assert.equal(rd.computeLevel(skipped, { cliOnly: true }), 4);
  assert.equal(rd.computeLevel(skipped), 3);
  assert.equal(rd.computeLevel(skipped, { cliOnly: false }), 3);
  const failed = skipped.map((r) => (r.id === 'C9' ? res('C9', 'fail') : r));
  assert.equal(rd.computeLevel(failed, { cliOnly: true }), 3);
  assert.equal(rd.computeLevel(failed), 3);
});

test('computeLevel: with app.start and app.cli both set, C6 to C9 must all pass', () => {
  const all = pass(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9']);
  assert.equal(rd.computeLevel(all), 4);
  assert.equal(rd.computeLevel(all.map((r) => (r.id === 'C9' ? res('C9', 'fail') : r))), 3);
  assert.equal(rd.computeLevel(all.map((r) => (r.id === 'C7' ? res('C7', 'skip') : r))), 3);
  assert.equal(rd.computeLevel(all.map((r) => (r.id === 'C9' ? res('C9', 'unstable') : r)), { cliOnly: true }), 3);
});

test('computeLevel: a result without C9 (no app.cli) still reaches 4', () => {
  assert.equal(rd.computeLevel(pass(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'])), 4);
  assert.equal(rd.computeLevel([...pass(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']), res('C9', 'skip')]), 4);
  // a missing C9 never makes skipped app checks pass
  assert.equal(rd.computeLevel([...pass(['C1', 'C2', 'C3', 'C4', 'C5']), res('C6', 'skip'), res('C7', 'skip'), res('C8', 'skip')], { cliOnly: true }), 3);
});

test('C9: a command that exits (any code) passes', async () => {
  const x = await c9({ app: { cli: { command: ['node', '-e', 'process.exit(2)'], timeout_s: 10 } } });
  assert.equal(x.status, 'pass', x.reason);
});

test('C9: runs app.setup first, in the worktree, with ./ elements resolved there', async () => {
  const x = await c9({ app: { setup: ['node', '-e', 'require("fs").writeFileSync("built.txt","x")'], cli: { command: ['node', './cli.js'], timeout_s: 10 } } },
    { 'cli.js': 'const fs=require("fs");const p=require("path").join(__dirname,"built.txt");process.exit(fs.existsSync(p)&&fs.readdirSync(".").length===0?0:3)' });
  assert.equal(x.status, 'pass', x.reason);
});

test('C9: a failing app.setup fails', async () => {
  const x = await c9({ app: { setup: ['node', '-e', 'process.exit(1)'], cli: { command: ['node', '-e', '0'], timeout_s: 10 } } });
  assert.equal(x.status, 'fail'); assert.match(x.reason, /app\.setup/);
});

test('C9: a command that outlives timeout_s fails', async () => {
  const x = await c9({ app: { cli: { command: ['node', '-e', 'setTimeout(()=>{},30000)'], timeout_s: 1 } } });
  assert.equal(x.status, 'fail'); assert.match(x.reason, /did not exit/);
});

test('C9: a missing binary fails', async () => {
  const x = await c9({ app: { cli: { command: ['no-such-binary-c9-xyz'], timeout_s: 5 } } });
  assert.equal(x.status, 'fail');
});

test('C9: a process left running after the command exits fails', async () => {
  const code = 'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},20000)"],{detached:true,stdio:"ignore"}).unref()';
  const x = await c9({ app: { cli: { command: ['node', '-e', code], timeout_s: 5 } } });
  assert.equal(x.status, 'fail'); assert.match(x.reason, /still running/);
  const left = spawnSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes('setTimeout(()=>{},20000)'));
  for (const l of left) assert.fail(`survivor left behind: ${l}`);
});

test('C9: skips when app.cli is not configured', async () => {
  const x = await c9({ app: {} });
  assert.equal(x.status, 'skip'); assert.match(x.reason, /app\.cli/);
});

test('fixItem C9 names app.cli', () => {
  const f = rd.fixItem('C9', { reason: 'why' });
  assert.equal(f.id, 'C9'); assert.equal(f.what, 'why');
  assert.match(`${f.change} ${f.help}`, /app\.cli/);
});

test('factorycheck: app.cli with no app.start meets the factory run requirements', () => {
  const policy = (app) => c.parseConfig({ verification: { required: true }, readiness: { min_level: 4 }, app }).config;
  const ids = (p) => fc.fileProblems(p).map((x) => x.id);
  const cli = { cli: { command: ['node', './src/cli.ts'] } };
  assert.deepEqual(ids(policy(cli)), []);
  assert.ok(ids(policy({})).includes('app_start'));
  assert.ok(ids(policy({ start: ['npm', 'run', 'dev'] })).includes('app_base_url'));
  // a startable app still needs its own base_url and ready
  assert.ok(ids(policy({ ...cli, start: ['npm', 'run', 'dev'] })).includes('app_base_url'));
});
