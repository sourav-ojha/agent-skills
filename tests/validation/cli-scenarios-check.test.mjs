// `cli` scenario runner (clicheck.mjs), the shared text / json_path check (apicheck textCheck) and the captured process runner
// (proc runCapture, sandbox runSandboxedCapture). The runner never spawns: these tests hand it a fake `run` and a real temp case folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const lib = (f) => import(path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib', f));
const C = await lib('clicheck.mjs');
const A = await lib('apicheck.mjs');
const P = await lib('proc.mjs');
const S = await lib('sandbox.mjs');

const tmp = (t) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-check-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
// A fresh case folder plus a sibling "outside" folder holding a secret the runner must never read.
const dirs = (t) => {
  const root = tmp(t);
  const caseDir = path.join(root, 'case'); const outside = path.join(root, 'outside');
  fs.mkdirSync(caseDir); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE');
  return { root, caseDir, outside };
};
const ok = (o = {}) => ({ code: 0, signal: null, timedOut: false, overflow: false, stdout: '', stderr: '', ...o });
// Fake run: records every call; `respond(argv, opts, i)` returns the canned result (may write files into caseDir first).
const fakeRun = (respond = () => ok()) => {
  const calls = [];
  const run = async (argv, opts) => { calls.push({ argv, stdin: opts?.stdin }); return respond(argv, opts, calls.length - 1); };
  return { run, calls };
};
const CMD = ['node', './bin/tool.js'];
const scen = (o = {}) => ({ id: 'S-1', covers: ['AC-1'], kind: 'cli', run: { args: ['about', '--json'] }, assert: [{ exit: 0 }], ...o });
const go = (s, caseDir, run) => C.runCliScenario(s, { command: CMD, timeoutS: 5, caseDir, run });
const FIXED = new Set(['exit', 'stdout', 'stderr', 'file', 'setup', 'run']);
const fixedWord = (r) => { if (r.failed !== undefined) assert.ok(FIXED.has(r.failed), `failed is a fixed word: ${r.failed}`); };

// ---- pass ----------------------------------------------------------------------------------------------------------------------
test('pass: exit, stdout equals, stdout json_path, stderr empty, file exists, file json_path count on a file the run wrote', async (t) => {
  const { caseDir } = dirs(t);
  const { run, calls } = fakeRun(() => {
    fs.mkdirSync(path.join(caseDir, 'out'));
    fs.writeFileSync(path.join(caseDir, 'out', 'report.json'), JSON.stringify({ items: [1, 2, 3] }));
    fs.writeFileSync(path.join(caseDir, 'seo.config.yaml'), 'a: 1\n');
    return ok({ stdout: '{"name":"seo"}' });
  });
  const r = await go(scen({ run: { args: ['about', '--json'], stdin: 'hi' }, assert: [
    { exit: 0 },
    { stdout: { equals: '{"name":"seo"}' } },
    { stdout: { json_path: '$.name', equals: 'seo' } },
    { stderr: { equals: '' } },
    { file: 'seo.config.yaml', exists: true },
    { file: 'nope.txt', exists: false },
    { file: 'out/report.json', json_path: '$.items', count: 3 },
    { file: './out/report.json', contains: '"items"' },
  ] }), caseDir, run);
  assert.deepEqual(r, { status: 'pass' });
  assert.deepEqual(calls, [{ argv: [...CMD, 'about', '--json'], stdin: 'hi' }]);
});

test('pass: stdin defaults to the empty string', async (t) => {
  const { caseDir } = dirs(t);
  const { run, calls } = fakeRun();
  assert.deepEqual(await go(scen(), caseDir, run), { status: 'pass' });
  assert.equal(calls[0].stdin, '');
});

// ---- fail ----------------------------------------------------------------------------------------------------------------------
test('fail: wrong exit, stdout mismatch, json_path on non-JSON stdout, exists:false on an existing file, stderr; first failing decides', async (t) => {
  const { caseDir } = dirs(t);
  const out = (o) => fakeRun(() => ok(o)).run;
  assert.deepEqual(await go(scen({ assert: [{ exit: 1 }] }), caseDir, out({})), { status: 'fail', failed: 'exit' });
  assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, { stdout: { equals: 'x' } }] }), caseDir, out({ stdout: 'y' })), { status: 'fail', failed: 'stdout' });
  assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, { stdout: { json_path: '$.a', equals: 1 } }] }), caseDir, out({ stdout: 'not json' })), { status: 'fail', failed: 'stdout' });
  assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, { stderr: { not_contains: 'warn' } }] }), caseDir, out({ stderr: 'a warn' })), { status: 'fail', failed: 'stderr' });
  fs.writeFileSync(path.join(caseDir, 'there.txt'), 'x');
  assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, { file: 'there.txt', exists: false }] }), caseDir, out({})), { status: 'fail', failed: 'file' });
  assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, { file: 'missing.txt', equals: '' }] }), caseDir, out({})), { status: 'fail', failed: 'file' });
  // the first failing assertion names the family
  assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, { stderr: { equals: 'e' } }, { exit: 3 }] }), caseDir, out({})), { status: 'fail', failed: 'stderr' });
});

test('fail: a process killed by a signal has no exit code, so an exit assertion never passes', async (t) => {
  const { caseDir } = dirs(t);
  for (const exit of [0, 137, 9]) {
    const r = await go(scen({ assert: [{ exit }] }), caseDir, fakeRun(() => ok({ code: null, signal: 'SIGKILL' })).run);
    assert.deepEqual(r, { status: 'fail', failed: 'exit' });
  }
});

// ---- blocked -------------------------------------------------------------------------------------------------------------------
test('blocked: timedOut, overflow, spawn failure or a throwing run of the command is blocked run', async (t) => {
  const { caseDir } = dirs(t);
  for (const res of [ok({ code: null, signal: 'SIGKILL', timedOut: true }), ok({ code: 0, overflow: true }), ok({ code: null })]) {
    assert.deepEqual(await go(scen(), caseDir, fakeRun(() => res).run), { status: 'blocked', failed: 'run' }, JSON.stringify(res));
  }
  assert.deepEqual(await go(scen(), caseDir, async () => { throw new Error('spawn ENOENT /secret/path'); }), { status: 'blocked', failed: 'run' });
  assert.deepEqual(await go(scen(), caseDir, async () => null), { status: 'blocked', failed: 'run' });
});

test('blocked: a setup run that exits non-zero, times out, overflows or fails to spawn is blocked setup; the command never runs', async (t) => {
  const { caseDir } = dirs(t);
  for (const bad of [ok({ code: 2 }), ok({ code: null, timedOut: true }), ok({ overflow: true }), ok({ code: null }), ok({ code: null, signal: 'SIGTERM' })]) {
    const { run, calls } = fakeRun((argv, o, i) => (i === 0 ? bad : ok()));
    const r = await go(scen({ setup: { runs: [{ args: ['init'] }] } }), caseDir, run);
    assert.deepEqual(r, { status: 'blocked', failed: 'setup' }, JSON.stringify(bad));
    assert.equal(calls.length, 1, 'the main command did not run');
  }
});

test('blocked: a setup file write failure (existing directory, symlink at the path, symlinked parent, invalid path) is blocked setup', async (t) => {
  const { caseDir, outside } = dirs(t);
  const { run, calls } = fakeRun();
  fs.mkdirSync(path.join(caseDir, 'taken'));
  assert.deepEqual(await go(scen({ setup: { files: [{ path: 'taken', text: 'x' }] } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  fs.symlinkSync(path.join(outside, 'planted.txt'), path.join(caseDir, 'link.txt'));
  assert.deepEqual(await go(scen({ setup: { files: [{ path: 'link.txt', text: 'x' }] } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  assert.equal(fs.existsSync(path.join(outside, 'planted.txt')), false, 'never wrote through a symlink');
  fs.symlinkSync(outside, path.join(caseDir, 'outdir'));
  assert.deepEqual(await go(scen({ setup: { files: [{ path: 'outdir/x.txt', text: 'x' }] } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false, 'never wrote through a symlinked parent');
  fs.mkdirSync(path.join(caseDir, 'realdir'));
  fs.symlinkSync('realdir', path.join(caseDir, 'indir'));
  assert.deepEqual(await go(scen({ setup: { files: [{ path: 'indir/y.txt', text: 'x' }] } }), caseDir, run), { status: 'blocked', failed: 'setup' }, 'a parent symlink is refused even when it stays inside');
  assert.equal(fs.existsSync(path.join(caseDir, 'realdir', 'y.txt')), false);
  for (const p of ['../escape.txt', '/abs.txt', 'a/../../x', '.', 'a//b', 'a\\b', 'x\0y', '', 'a'.repeat(257)]) {
    assert.deepEqual(await go(scen({ setup: { files: [{ path: p, text: 'x' }] } }), caseDir, run), { status: 'blocked', failed: 'setup' }, JSON.stringify(p));
  }
  assert.deepEqual(await go(scen({ setup: { files: [{ path: 'big.txt', text: 'x'.repeat(256 * 1024 + 1) }] } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  assert.equal(calls.length, 0, 'nothing ran after a setup failure');
  assert.equal(fs.existsSync(path.join(path.dirname(caseDir), 'escape.txt')), false);
});

test('blocked: setup files that collide after normalisation or case-folding, or a file that is also a directory, are refused', async (t) => {
  const { caseDir } = dirs(t);
  const { run, calls } = fakeRun();
  for (const files of [
    [{ path: 'a.txt', text: '1' }, { path: './a.txt', text: '2' }],
    [{ path: 'dir/a.txt', text: '1' }, { path: 'dir/./a.txt', text: '2' }],
    [{ path: 'Config.yaml', text: '1' }, { path: 'config.YAML', text: '2' }],
    [{ path: 'Sites/x.yaml', text: '1' }, { path: 'sites', text: '2' }],
  ]) {
    const d = fs.mkdtempSync(path.join(caseDir, 'c'));
    assert.deepEqual(await go(scen({ setup: { files } }), d, run), { status: 'blocked', failed: 'setup' }, JSON.stringify(files));
    assert.deepEqual(fs.readdirSync(d), [], 'collisions are refused before anything is written');
  }
  assert.equal(calls.length, 0);
});

// ---- order -----------------------------------------------------------------------------------------------------------------------
test('order: setup.files are written (mode 0600, parents created) before setup.runs; runs execute in order with their own stdin', async (t) => {
  const { caseDir } = dirs(t);
  const seen = [];
  const { run, calls } = fakeRun((argv) => {
    seen.push(fs.readFileSync(path.join(caseDir, 'sites', 'x.yaml'), 'utf8'));
    if (argv.includes('init')) fs.writeFileSync(path.join(caseDir, 'seo.config.yaml'), 'ok');
    return ok({ stdout: argv.at(-1) });
  });
  const r = await go(scen({
    setup: { files: [{ path: 'sites/x.yaml', text: 'site: x\n' }, { path: './top.txt', text: 'T' }], runs: [{ args: ['init'], stdin: 'first' }, { args: ['add', 'x'] }] },
    run: { args: ['about'], stdin: 'main' },
    assert: [{ exit: 0 }, { stdout: { equals: 'about' } }, { file: 'seo.config.yaml', equals: 'ok' }, { file: 'top.txt', equals: 'T' }],
  }), caseDir, run);
  assert.deepEqual(r, { status: 'pass' });
  assert.deepEqual(calls, [
    { argv: [...CMD, 'init'], stdin: 'first' },
    { argv: [...CMD, 'add', 'x'], stdin: '' },
    { argv: [...CMD, 'about'], stdin: 'main' },
  ]);
  assert.deepEqual(seen, ['site: x\n', 'site: x\n', 'site: x\n']);
  assert.equal(fs.statSync(path.join(caseDir, 'sites', 'x.yaml')).mode & 0o777, 0o600);
});

// ---- file safety -------------------------------------------------------------------------------------------------------------
const leaks = (r) => JSON.stringify(r).includes('TOP-SECRET') || JSON.stringify(r).includes('outside');

test('file safety: a symlink (final or parent) whose realpath leaves the case folder fails file and is never read', async (t) => {
  const { caseDir, outside } = dirs(t);
  const { run } = fakeRun(() => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(caseDir, 'leak.txt'));
    fs.symlinkSync(outside, path.join(caseDir, 'outdir'));
    fs.symlinkSync(path.join(outside, 'nope'), path.join(caseDir, 'dangling'));
    fs.symlinkSync('../outside/secret.txt', path.join(caseDir, 'rel.txt'));
    return ok();
  });
  // Run once to plant the links; then evaluate many assertions against the same folder with a no-op run.
  await go(scen(), caseDir, run);
  const noop = fakeRun().run;
  for (const a of [
    { file: 'leak.txt', contains: 'TOP' }, { file: 'leak.txt', not_contains: 'TOP' }, { file: 'leak.txt', exists: true }, { file: 'leak.txt', exists: false },
    { file: 'outdir/secret.txt', equals: 'TOP-SECRET-OUTSIDE' }, { file: 'outdir/secret.txt', exists: true },
    { file: 'outdir/absent.txt', exists: false }, // must not probe a directory outside the case folder
    { file: 'dangling', exists: false }, { file: 'rel.txt', matches: 'SECRET' },
  ]) {
    const r = await go(scen({ assert: [{ exit: 0 }, a] }), caseDir, noop);
    assert.deepEqual(r, { status: 'fail', failed: 'file' }, JSON.stringify(a));
    assert.equal(leaks(r), false);
  }
});

test('file safety: a hard link to a file outside the case folder fails file and is never read', async (t) => {
  const { caseDir, outside } = dirs(t);
  fs.linkSync(path.join(outside, 'secret.txt'), path.join(caseDir, 'hard.txt'));
  for (const a of [{ file: 'hard.txt', contains: 'TOP' }, { file: 'hard.txt', exists: true }]) {
    const r = await go(scen({ assert: [{ exit: 0 }, a] }), caseDir, fakeRun().run);
    assert.deepEqual(r, { status: 'fail', failed: 'file' }, JSON.stringify(a));
  }
});

test('file safety: a symlink that stays inside the case folder is followed', async (t) => {
  const { caseDir } = dirs(t);
  fs.mkdirSync(path.join(caseDir, 'real'));
  fs.writeFileSync(path.join(caseDir, 'real', 'f.txt'), 'inside');
  fs.symlinkSync('real', path.join(caseDir, 'alias'));
  fs.symlinkSync('real/f.txt', path.join(caseDir, 'f-link'));
  const r = await go(scen({ assert: [{ exit: 0 }, { file: 'alias/f.txt', equals: 'inside' }, { file: 'f-link', exists: true }] }), caseDir, fakeRun().run);
  assert.deepEqual(r, { status: 'pass' });
});

test('file safety: .., absolute, NUL and over-long assertion paths fail file (defence in depth behind the lint)', async (t) => {
  const { caseDir } = dirs(t);
  for (const p of ['../outside/secret.txt', 'a/../../outside/secret.txt', '/etc/hosts', '.', 'x\0y', 'a'.repeat(257), 'a//b']) {
    for (const a of [{ file: p, exists: false }, { file: p, contains: 'x' }]) {
      const r = await go(scen({ assert: [{ exit: 0 }, a] }), caseDir, fakeRun().run).catch((e) => ({ threw: e.message }));
      // an unrecognised shape is a programming error (thrown before any run) or a file failure; never a pass
      if (r.threw) assert.ok(!r.threw.includes('secret') && !r.threw.includes('etc'), r.threw);
      else assert.deepEqual(r, { status: 'fail', failed: 'file' }, JSON.stringify(a));
    }
  }
});

test('file safety: a directory, a FIFO and a file over 1 MiB fail file; never blocks on the FIFO', async (t) => {
  const { caseDir } = dirs(t);
  fs.mkdirSync(path.join(caseDir, 'adir'));
  const big = path.join(caseDir, 'big.txt');
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x61));
  fs.writeFileSync(path.join(caseDir, 'edge.txt'), Buffer.alloc(1024 * 1024, 0x61));
  const noop = fakeRun().run;
  for (const a of [{ file: 'adir', exists: true }, { file: 'adir', exists: false }, { file: 'adir', contains: 'x' }, { file: 'big.txt', contains: 'a' }, { file: 'big.txt', not_contains: 'zzz' }]) {
    assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, a] }), caseDir, noop), { status: 'fail', failed: 'file' }, JSON.stringify(a));
  }
  assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, { file: 'edge.txt', not_contains: 'b' }, { file: 'big.txt', exists: true }] }), caseDir, noop), { status: 'pass' }, 'exactly 1 MiB is readable');
  const fifo = path.join(caseDir, 'pipe');
  const mk = spawnSync('mkfifo', [fifo]);
  if (mk.status !== 0) { t.diagnostic('mkfifo unavailable: FIFO case skipped'); return; }
  for (const a of [{ file: 'pipe', contains: 'x' }, { file: 'pipe', exists: true }]) {
    assert.deepEqual(await go(scen({ assert: [{ exit: 0 }, a] }), caseDir, noop), { status: 'fail', failed: 'file' }, JSON.stringify(a));
  }
});

test('file safety: invalid UTF-8 contents fail the text check', async (t) => {
  const { caseDir } = dirs(t);
  fs.writeFileSync(path.join(caseDir, 'bin.dat'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  const r = await go(scen({ assert: [{ exit: 0 }, { file: 'bin.dat', not_contains: 'zzz' }] }), caseDir, fakeRun().run);
  assert.deepEqual(r, { status: 'fail', failed: 'file' });
});

test('a regex that runs past the 500 ms worker limit blocks the scenario (not a fail)', async (t) => {
  const { caseDir } = dirs(t);
  const r = await go(scen({ assert: [{ exit: 0 }, { stdout: { matches: '^(a+)+$' } }] }), caseDir, fakeRun(() => ok({ stdout: `${'a'.repeat(40)}b` })).run);
  assert.deepEqual(r, { status: 'blocked', failed: 'stdout' });
});

test('invalid scenario or ctx shapes are refused before anything runs', async (t) => {
  const { caseDir } = dirs(t);
  const { run, calls } = fakeRun();
  await assert.rejects(go(scen({ kind: 'api' }), caseDir, run));
  await assert.rejects(go(scen({ assert: [] }), caseDir, run));
  await assert.rejects(go(scen({ assert: [{ stdout: { equals: '' } }] }), caseDir, run), 'needs an exit assertion');
  await assert.rejects(go(scen({ assert: [{ exit: 0 }, { stdout: { contains: '' } }] }), caseDir, run));
  await assert.rejects(go(scen({ assert: [{ exit: 0 }, { stdout: { json_path: '$..a', equals: 1 } }] }), caseDir, run));
  await assert.rejects(go(scen({ assert: [{ exit: 0 }, { stdout: { json_path: '$.a', count: -1 } }] }), caseDir, run));
  await assert.rejects(C.runCliScenario(scen(), { command: [], timeoutS: 5, caseDir, run }));
  await assert.rejects(C.runCliScenario(scen(), { command: CMD, timeoutS: 5, caseDir, run: null }));
  assert.equal(calls.length, 0);
  // run shape problems are blocked run (data, not programming)
  for (const r of [{ args: 'about' }, { args: ['a\0b'] }, { args: ['x'], stdin: 3 }, { args: Array(65).fill('x') }, { args: ['x'], stdin: 'x'.repeat(64 * 1024 + 1) }, { args: ['x'], extra: 1 }]) {
    assert.deepEqual(await go(scen({ run: r }), caseDir, run), { status: 'blocked', failed: 'run' }, JSON.stringify(r).slice(0, 80));
  }
  assert.deepEqual(await go(scen({ setup: { runs: [{ args: 'init' }] } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  assert.deepEqual(await go(scen({ setup: { runs: Array(11).fill({ args: [] }) } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  assert.deepEqual(await go(scen({ setup: { files: Array.from({ length: 51 }, (_, i) => ({ path: `f${i}`, text: '' })) } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  assert.deepEqual(await go(scen({ setup: { other: [] } }), caseDir, run), { status: 'blocked', failed: 'setup' });
  assert.equal(calls.length, 0);
});

test('failed is always a fixed word and no result carries output, paths or patterns', async (t) => {
  const { caseDir } = dirs(t);
  const SECRET = 'OUTPUT-SHOULD-NOT-LEAK';
  const res = [];
  for (const a of [{ exit: 4 }, { stdout: { matches: 'zzz' } }, { stderr: { contains: 'q' } }, { file: 'secret-path.txt', contains: 'x' }]) {
    const list = 'exit' in a ? [a] : [{ exit: 0 }, a];
    res.push(await go(scen({ assert: list }), caseDir, fakeRun(() => ok({ stdout: SECRET, stderr: SECRET })).run));
  }
  for (const r of res) { fixedWord(r); assert.deepEqual(Object.keys(r).sort(), r.failed ? ['failed', 'status'] : ['status']); assert.equal(JSON.stringify(r).includes(SECRET), false); }
});

// ---- textCheck -------------------------------------------------------------------------------------------------------------------
test('textCheck: whole-text ops, json_path ops, non-JSON fails, subject over 64 KiB fails, invalid shapes throw', async () => {
  const tc = A.textCheck;
  assert.equal(await tc('hello world', { equals: 'hello world' }), true);
  assert.equal(await tc('hello world', { equals: 'hello' }), false);
  assert.equal(await tc('hello world', { contains: 'lo w' }), true);
  assert.equal(await tc('hello world', { not_contains: 'xyz' }), true);
  assert.equal(await tc('hello world', { not_contains: 'world' }), false);
  assert.equal(await tc('hello world', { matches: '^hel+o\\b' }), true);
  assert.equal(await tc('hello world', { matches: '^world' }), false);
  assert.equal(await tc('a'.repeat(64 * 1024 + 1), { matches: 'a' }), false, 'over-long subject fails, never truncated');
  const j = JSON.stringify({ name: 'x', items: [1, 2, 3], tags: ['a', 'b'], nested: { k: 'value' } });
  assert.equal(await tc(j, { json_path: '$.name', equals: 'x' }), true);
  assert.equal(await tc(j, { json_path: '$.items', count: 3 }), true);
  assert.equal(await tc(j, { json_path: '$.items[*]', count: 3 }), true);
  assert.equal(await tc(j, { json_path: '$.tags', contains: 'a' }), true);
  assert.equal(await tc(j, { json_path: '$.tags', not_contains: 'z' }), true);
  assert.equal(await tc(j, { json_path: '$.missing', not_contains: 'z' }), false, 'unresolved not_contains never passes vacuously');
  assert.equal(await tc(j, { json_path: '$.missing', count: 0 }), false);
  assert.equal(await tc(j, { json_path: '$.nested.k', matches: '^val' }), true);
  assert.equal(await tc(j, { json_path: '$.items', equals: [1, 2, 3] }), true);
  assert.equal(await tc('not json', { json_path: '$.name', equals: 'x' }), false);
  assert.equal(await tc('', { json_path: '$', count: 0 }), false);
  await assert.rejects(tc('a', { equals: 'a', contains: 'a' }));
  await assert.rejects(tc('a', { contains: '' }));
  await assert.rejects(tc('a', { json_path: '$.__proto__', equals: 1 }));
  await assert.rejects(tc('{}', { json_path: '$.a', count: 1.5 }));
  await assert.rejects(tc('aaaa', { matches: '^(a+)+$' }, { regexTimeoutMs: 0 }), 'an exhausted budget is a timeout');
  const t0 = Date.now();
  await assert.rejects(tc(`${'a'.repeat(40)}b`, { matches: '^(a+)+$' }), 'default 500 ms worker limit');
  assert.ok(Date.now() - t0 < 1500);
});

// ---- runCapture (real processes, no sandbox) ----------------------------------------------------------------------------------
const NODE = process.execPath;
const env = { PATH: process.env.PATH };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('runCapture: separate stdout and stderr, stdin delivered then closed, exit code', async (t) => {
  const cwd = tmp(t);
  const r = await P.runCapture([NODE, '-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write("OUT:"+s);process.stderr.write("ERR\\u00e9");process.exit(7)})'],
    { cwd, env, timeoutS: 5, stdin: 'piped in' });
  assert.deepEqual(r, { code: 7, signal: null, timedOut: false, overflow: false, stdout: 'OUT:piped in', stderr: 'ERRé' });
});

test('runCapture: a command that never reads stdin (EPIPE) neither throws nor hangs', async (t) => {
  const cwd = tmp(t);
  const r = await P.runCapture([NODE, '-e', 'process.exit(0)'], { cwd, env, timeoutS: 5, stdin: 'x'.repeat(1024 * 1024) });
  assert.equal(r.code, 0); assert.equal(r.timedOut, false);
});

test('runCapture: a 100 ms timeout kills a sleeping child (timedOut) and reports the signal', async (t) => {
  const cwd = tmp(t);
  const t0 = Date.now();
  const r = await P.runCapture([NODE, '-e', 'setTimeout(()=>{},60000)'], { cwd, env, timeoutS: 0.1 });
  assert.equal(r.timedOut, true); assert.equal(r.code, null); assert.equal(r.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 < 1500);
});

test('runCapture: output beyond maxBytes sets overflow, keeps at most maxBytes and kills the flooding group', async (t) => {
  const cwd = tmp(t);
  const t0 = Date.now();
  const r = await P.runCapture([NODE, '-e', 'const b=Buffer.alloc(65536,120);(function w(){while(process.stdout.write(b));process.stdout.once("drain",w)})()'], { cwd, env, timeoutS: 10, maxBytes: 4096 });
  assert.equal(r.overflow, true); assert.equal(r.timedOut, false);
  assert.ok(r.stdout.length <= 4096, `capped: ${r.stdout.length}`);
  assert.ok(Date.now() - t0 < 1500, 'the flood did not run on');
  const e = await P.runCapture([NODE, '-e', 'process.stderr.write("y".repeat(5000))'], { cwd, env, timeoutS: 5, maxBytes: 4096 });
  assert.equal(e.overflow, true); assert.ok(e.stderr.length <= 4096);
  const exact = await P.runCapture([NODE, '-e', 'process.stdout.write("z".repeat(4096))'], { cwd, env, timeoutS: 5, maxBytes: 4096 });
  assert.equal(exact.overflow, false); assert.equal(exact.stdout.length, 4096);
});

test('runCapture: a backgrounded child is killed with the group when the command exits', async (t) => {
  const cwd = tmp(t);
  const pidFile = path.join(cwd, 'bg.pid');
  const r = await P.runCapture([NODE, '-e', `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`],
    { cwd, env, timeoutS: 5 });
  assert.equal(r.code, 0);
  const bg = Number(fs.readFileSync(pidFile, 'utf8'));
  const until = Date.now() + 1000;
  while (alive(bg) && Date.now() < until) await new Promise((res) => setTimeout(res, 20));
  assert.equal(alive(bg), false, 'background child was killed');
});

test('runCapture: a spawn failure resolves with code null and no signal', async (t) => {
  const cwd = tmp(t);
  const r = await P.runCapture([path.join(cwd, 'does-not-exist')], { cwd, env, timeoutS: 5 });
  assert.equal(r.code, null); assert.equal(r.signal, null); assert.equal(r.timedOut, false);
});

test('runSandboxedCapture: refuses without a sandbox (no unsandboxed fallback)', async () => {
  await assert.rejects(S.runSandboxedCapture(['/usr/bin/true'], { profile: '(version 1)(allow default)', sandbox: { platform: 'linux' } }), /no unsandboxed fallback/);
});
