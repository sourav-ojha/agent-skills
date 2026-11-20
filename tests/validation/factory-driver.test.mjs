// factory driver: per-repo lock (pid + start time, process groups, stale takeover) and the pure driver decision table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO } from './helpers.mjs';

const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const L = await import(pathToFileURL(path.join(LIB, 'lock.mjs')).href);
const D = await import(pathToFileURL(path.join(LIB, 'driver.mjs')).href);

const KEY = 'acme__widgets';
const tmp = (t) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-driver-'))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const lockFile = (home) => path.join(home, 'locks', `${KEY}.lock`);
const readDoc = (home) => JSON.parse(fs.readFileSync(lockFile(home), 'utf8'));
const writeLock = (home, doc) => { fs.mkdirSync(path.join(home, 'locks'), { recursive: true, mode: 0o700 }); fs.writeFileSync(lockFile(home), JSON.stringify(doc), { mode: 0o600 }); };
const START = 'ps:Thu Nov 20 10:11:12 2026';
const TOK = 'a'.repeat(32);
const lockDoc = (over = {}) => ({ v: 1, pid: 4242, start: START, token: TOK, groups: [], orphans: [], ...over });
const errCode = (code) => (e) => e instanceof L.LockError && e.code === code;

// A fake process table: { pid: start } plus rows { pid, pgid, start }; kills are recorded.
function fakeSys({ starts = {}, rows = [], killFails = {} } = {}) {
  const killed = [];
  return {
    killed,
    startOf(pid) { if (starts[pid] === 'throw') throw new L.LockError('LOCK_PS', 'x'); return Object.hasOwn(starts, pid) ? starts[pid] : null; },
    table() { return rows; },
    kill(pid, sig) { if (killFails[-pid]) { const e = new Error('x'); e.code = killFails[-pid]; throw e; } killed.push([pid, sig]); },
  };
}
const selfSys = (extra = {}) => fakeSys({ ...extra, starts: { [process.pid]: 'ps:Fri Nov 21 09:00:00 2026', ...(extra.starts || {}) } });

// Child process that takes the lock. mode: hold (waits for stdin to close), try (exits at once), exit (exits without release).
const CHILD = `
const [lib, home, key, mode] = process.argv.slice(2);
const L = await import(lib);
try {
  const h = L.acquire(key, { home });
  process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, orphans: h.orphans() }) + '\\n');
  if (mode === 'hold') { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
  else if (mode === 'linger') setTimeout(() => process.exit(0), 1500);
  else process.exit(0);
} catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: e.code || String(e.message) }) + '\\n'); process.exit(3); }
`;
function child(t, home, mode) {
  const dir = tmp(t);
  const script = path.join(dir, 'child.mjs');
  fs.writeFileSync(script, CHILD);
  const c = spawn(process.execPath, [script, pathToFileURL(path.join(LIB, 'lock.mjs')).href, home, KEY, mode], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } });
  const first = new Promise((resolve) => { let buf = ''; c.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i !== -1) resolve(JSON.parse(buf.slice(0, i))); }); });
  const exited = new Promise((resolve) => c.on('exit', (code, sig) => resolve({ code, sig })));
  return { c, first, exited };
}
// A real, now-dead pid with the start time it had while alive.
async function deadPid() {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  const start = L.SYSTEM.startOf(c.pid);
  const gone = new Promise((r) => c.on('exit', r));
  c.kill('SIGKILL');
  await gone;
  return { pid: c.pid, start };
}

// ---------------------------------------------------------------------------------------------------------------- lock

test('lock: normStart parses ps lstart robustly and rejects anything else', () => {
  assert.equal(L.normStart('Thu Nov  5 10:11:12 2026\n'), 'Thu Nov 5 10:11:12 2026');
  assert.equal(L.normStart('  Thu Nov 05 10:11:12 2026 '), 'Thu Nov 5 10:11:12 2026');
  assert.equal(L.normStart('Thu Nov 20 10:11:12 2026'), 'Thu Nov 20 10:11:12 2026');
  for (const bad of ['', 'Thu Nov 20 10:11:12', 'Thu Nov 20 25:11:12 2026', 'Thx Nov 20 10:11:12 2026', 'Thu Nov 32 10:11:12 2026', 'Thu Nov 20 10:11:12 2026 x', null, undefined, '12345'])
    assert.equal(L.normStart(bad), null, String(bad));
  assert.ok(L.startSecs('Thu Nov 20 10:11:13 2026') - L.startSecs('Thu Nov 20 10:11:12 2026') === 1);
  assert.equal(L.startSecs('junk'), null);
});

test('lock: real ps start time of this process is readable and stable', () => {
  const a = L.SYSTEM.startOf(process.pid);
  assert.ok(L.validStart(a) && a.startsWith(`${L.SYSTEM.source}:`), a);
  assert.equal(L.SYSTEM.startOf(process.pid), a);
  const rows = L.SYSTEM.table();
  assert.ok(rows.some((r) => r.pid === process.pid && r.start === a));
});

test('lock: acquire creates a 0600 lock holding pid, start time, a random token and no groups', (t) => {
  const home = tmp(t);
  const h = L.acquire(KEY, { home });
  t.after(() => h.release());
  const st = fs.lstatSync(lockFile(home));
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(path.join(home, 'locks')).mode & 0o777, 0o700);
  const doc = readDoc(home);
  assert.equal(doc.pid, process.pid);
  assert.equal(doc.start, L.SYSTEM.startOf(process.pid));
  assert.match(doc.token, /^[0-9a-f]{32}$/);
  assert.deepEqual(doc.groups, []);
  assert.deepEqual(h.orphans(), []);
  assert.ok(L.validLock(doc));
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), [`${KEY}.lock`]);
});

test('lock: an unreadable start time of this very process refuses the lock without creating anything', (t) => {
  const home = tmp(t);
  for (const bad of ['garbage', 'Thu Nov 20 10:11:12 2026', '', 42]) {
    assert.throws(() => L.acquire(KEY, { home, sys: fakeSys({ starts: { [process.pid]: bad } }) }), errCode('LOCK_PS'), String(bad));
    assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), []);
  }
});

test('lock: invalid repo keys are refused before touching the filesystem', (t) => {
  const home = tmp(t);
  for (const k of ['acme/widgets', '..__x', 'a__b__c', '', 'acme__', '__w', 'a b__c']) assert.throws(() => L.acquire(k, { home }), /invalid repo key/, k);
  assert.equal(fs.existsSync(path.join(home, 'locks')), false);
});

test('lock: a second process is refused while the first holds the lock (concurrent acquire)', async (t) => {
  const home = tmp(t);
  const a = child(t, home, 'hold');
  assert.equal((await a.first).ok, true);
  const b = child(t, home, 'try');
  assert.deepEqual(await b.first, { ok: false, code: 'LOCK_HELD' });
  assert.throws(() => L.acquire(KEY, { home }), errCode('LOCK_HELD'));
  a.c.stdin.end();
  await a.exited;
  assert.equal(fs.existsSync(lockFile(home)), false, 'released on exit');
  const h = L.acquire(KEY, { home });
  h.release();
});

test('lock: of eight processes started together exactly one gets the lock', async (t) => {
  const home = tmp(t);
  const kids = Array.from({ length: 8 }, () => child(t, home, 'linger'));
  const res = await Promise.all(kids.map((k) => k.first));
  assert.equal(res.filter((r) => r.ok).length, 1, JSON.stringify(res));
  assert.ok(res.filter((r) => !r.ok).every((r) => r.code === 'LOCK_HELD'));
  await Promise.all(kids.map((k) => k.exited));
});

test('lock: a stale lock (holder pid gone) is taken over and its process groups are returned as orphans', async (t) => {
  const home = tmp(t);
  const dead = await deadPid();
  const groups = [{ pgid: 777001, start: START }, { pgid: 777002, start: null }];
  writeLock(home, lockDoc({ pid: dead.pid, start: dead.start, groups, orphans: [{ pgid: 777003, start: START }] }));
  const h = L.acquire(KEY, { home });
  t.after(() => h.release());
  assert.deepEqual(h.orphans().map((g) => g.pgid).sort(), [777001, 777002, 777003]);
  const doc = readDoc(home);
  assert.equal(doc.pid, process.pid);
  assert.notEqual(doc.token, TOK);
  assert.deepEqual(doc.groups, []);
  assert.equal(doc.orphans.length, 3, 'orphans stay recorded until killOrphans handles them');
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), [`${KEY}.lock`], 'no aside or temp file left');
});

test('lock: eight processes racing for one stale lock: exactly one takes it over', async (t) => {
  const home = tmp(t);
  const dead = await deadPid();
  writeLock(home, lockDoc({ pid: dead.pid, start: dead.start, groups: [{ pgid: 777009, start: START }] }));
  const kids = Array.from({ length: 8 }, () => child(t, home, 'linger'));
  const res = await Promise.all(kids.map((k) => k.first));
  const won = res.filter((r) => r.ok);
  assert.equal(won.length, 1, JSON.stringify(res));
  assert.deepEqual(won[0].orphans, [{ pgid: 777009, start: START }]);
  assert.ok(res.filter((r) => !r.ok).every((r) => r.code === 'LOCK_HELD'), JSON.stringify(res));
  await Promise.all(kids.map((k) => k.exited));
});

test('lock: takeover marker: a live taker holds it (refused); one left by a dead taker or garbled is fail-closed; the stale lock is untouched', (t) => {
  const home = tmp(t);
  const marker = `${lockFile(home)}.takeover`;
  const stale = lockDoc({ pid: 4242, groups: [{ pgid: 810, start: START }] });
  for (const [content, code, re] of [
    [JSON.stringify(lockDoc({ pid: 4343, token: 'e'.repeat(32) })), 'LOCK_HELD', /taking over/], // taker alive
    [JSON.stringify(lockDoc({ pid: 4343, token: 'e'.repeat(32), start: 'proc:77' })), 'LOCK_HELD', /taking over/], // taker start from another source: unverifiable
    [JSON.stringify(lockDoc({ pid: 4444, token: 'e'.repeat(32) })), 'LOCK_UNREADABLE', /remove .*takeover by hand/], // taker died mid-takeover
    ['{garbled', 'LOCK_UNREADABLE', /remove .*takeover by hand/],
  ]) {
    writeLock(home, stale);
    fs.writeFileSync(marker, content);
    assert.throws(() => L.acquire(KEY, { home, sys: selfSys({ starts: { 4242: null, 4343: START, 4444: null } }) }), (e) => errCode(code)(e) && re.test(e.message), code);
    assert.deepEqual(readDoc(home), stale);
    assert.equal(fs.readFileSync(marker, 'utf8'), content, 'marker untouched');
  }
  fs.rmSync(marker);
  fs.symlinkSync(path.join(home, 'elsewhere'), marker);
  assert.throws(() => L.acquire(KEY, { home, sys: selfSys({ starts: { 4242: null } }) }), errCode('LOCK_UNSAFE'));
  assert.equal(fs.existsSync(path.join(home, 'elsewhere')), false);
  fs.rmSync(marker);
  const h = L.acquire(KEY, { home, sys: selfSys({ starts: { 4242: null } }) });
  assert.deepEqual(h.orphans(), [{ pgid: 810, start: START }]);
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), [`${KEY}.lock`], 'marker removed after the takeover');
  h.release();
});

test('lock: a stale lock replaced by a live one while it is being judged is not moved (takeover checks it is the same lock)', (t) => {
  const home = tmp(t);
  writeLock(home, lockDoc({ pid: 4242 }));
  const live = lockDoc({ pid: 4343, token: 'd'.repeat(32), start: START });
  const sys = selfSys({ starts: { 4343: START } });
  const startOf = sys.startOf;
  sys.startOf = (pid) => {
    if (pid === 4242) { fs.renameSync(lockFile(home), `${lockFile(home)}.x`); fs.writeFileSync(lockFile(home), JSON.stringify(live)); fs.rmSync(`${lockFile(home)}.x`); return null; }
    return startOf(pid);
  };
  assert.throws(() => L.acquire(KEY, { home, sys }), errCode('LOCK_HELD'));
  assert.deepEqual(readDoc(home), live, 'the live lock stays in place');
});

test('lock: a recycled pid (same pid, different start time) is stale', (t) => {
  const home = tmp(t);
  writeLock(home, lockDoc({ pid: 4242, start: START, groups: [{ pgid: 5151, start: START }] }));
  const sys = selfSys({ starts: { 4242: 'ps:Fri Nov 21 10:11:12 2026' } });
  const h = L.acquire(KEY, { home, sys });
  t.after(() => h.release());
  assert.deepEqual(h.orphans(), [{ pgid: 5151, start: START }]);
});

test('lock: a live pid with the matching start time holds the lock (seam and real parent process)', (t) => {
  const home = tmp(t);
  writeLock(home, lockDoc());
  const before = fs.readFileSync(lockFile(home), 'utf8');
  assert.throws(() => L.acquire(KEY, { home, sys: selfSys({ starts: { 4242: START } }) }), errCode('LOCK_HELD'));
  assert.equal(fs.readFileSync(lockFile(home), 'utf8'), before);
  writeLock(home, lockDoc({ pid: process.ppid, start: L.SYSTEM.startOf(process.ppid) }));
  assert.throws(() => L.acquire(KEY, { home }), errCode('LOCK_HELD'));
});

test('lock: when the holder\'s start time cannot be read the lock is held (fail closed)', (t) => {
  const home = tmp(t);
  writeLock(home, lockDoc());
  assert.throws(() => L.acquire(KEY, { home, sys: selfSys({ starts: { 4242: 'throw' } }) }), errCode('LOCK_PS'));
  assert.deepEqual(readDoc(home), lockDoc());
});

test('lock: a garbled or invalid lock is HELD, not stale, and is left untouched', (t) => {
  const home = tmp(t);
  const variants = ['', '{', 'null', '[]', '"x"', JSON.stringify({ ...lockDoc(), extra: 1 }), JSON.stringify({ ...lockDoc(), v: 2 }),
    JSON.stringify(lockDoc({ start: 'yesterday' })), JSON.stringify(lockDoc({ start: 'xx:Thu Nov 20 10:11:12 2026' })), JSON.stringify(lockDoc({ start: 'Thu Nov 20 10:11:12 2026' })), JSON.stringify(lockDoc({ start: 'proc:-1' })), JSON.stringify(lockDoc({ start: 'proc:01' })), JSON.stringify(lockDoc({ token: 'short' })), JSON.stringify(lockDoc({ pid: 1 })),
    JSON.stringify(lockDoc({ pid: '4242' })), JSON.stringify(lockDoc({ groups: [{ pgid: 0, start: null }] })), JSON.stringify(lockDoc({ groups: 'x' })),
    JSON.stringify(lockDoc({ orphans: [{ pgid: 5, start: 'x' }] })), JSON.stringify(lockDoc({ groups: [{ pgid: 5 }] })), Buffer.from([0xff, 0xfe, 0x7b]), 'x'.repeat(70 * 1024)];
  for (const v of variants) {
    writeLock(home, '');
    fs.writeFileSync(lockFile(home), v);
    assert.throws(() => L.acquire(KEY, { home, sys: selfSys() }), (e) => errCode('LOCK_UNREADABLE')(e) && /remove it by hand/.test(e.message), String(v).slice(0, 40));
    assert.deepEqual(fs.readFileSync(lockFile(home)), Buffer.from(v));
  }
});

test('lock: a symlinked lock file (live or dangling) is refused and its target untouched', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, 'locks'), { mode: 0o700 });
  const target = path.join(tmp(t), 'victim');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, lockFile(home));
  assert.throws(() => L.acquire(KEY, { home }), errCode('LOCK_UNSAFE'));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  fs.unlinkSync(lockFile(home));
  fs.symlinkSync(path.join(home, 'nowhere'), lockFile(home));
  assert.throws(() => L.acquire(KEY, { home }), errCode('LOCK_UNSAFE'));
  assert.equal(fs.existsSync(path.join(home, 'nowhere')), false, 'O_EXCL never follows the link');
  fs.unlinkSync(lockFile(home));
  fs.mkdirSync(lockFile(home));
  assert.throws(() => L.acquire(KEY, { home }), errCode('LOCK_UNSAFE'), 'a directory is not a lock');
});

test('lock: Linux start identity comes from /proc/<pid>/stat field 22, split after the LAST ")"', () => {
  const tail = (pgrp, ticks) => `S 1 ${pgrp} ${pgrp} 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 1000 10 18446744073709551615`;
  assert.deepEqual(L.parseProcStat(`1234 (node) ${tail(1234, 98765)}`), { pgid: 1234, start: 'proc:98765' });
  assert.deepEqual(L.parseProcStat(`1234 (a) b (c)) ) ${tail(77, 5)}`), { pgid: 77, start: 'proc:5' }, 'comm with spaces and parens');
  assert.deepEqual(L.parseProcStat(`1234 (x 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20) ${tail(9, 42)}`), { pgid: 9, start: 'proc:42' }, 'comm with digits');
  for (const bad of ['', 'garbage', '1234 node S 1', `1234 (n) S 1`, `x (n) ${tail(1, 2)}`, `1234 (n) ${tail('x', 2)}`, `1234 (n) ${tail(1, '-3')}`, null])
    assert.equal(L.parseProcStat(bad), null, String(bad));
});

test('lock: a wall-clock step on Linux does not make a live holder stale (ticks since boot are compared, not lstart)', (t) => {
  const home = tmp(t);
  const stat = (pid, ticks) => `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`;
  // The clock was stepped by a day since the holder started: ps lstart would now print another date, the ticks did not move.
  const table = { 4242: stat(4242, 555000), [process.pid]: stat(process.pid, 900000) };
  const read = (p) => { const pid = p.split('/')[2]; if (table[pid]) return table[pid]; const e = new Error('x'); e.code = 'ENOENT'; throw e; };
  const kill = () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; };
  const sys = L.procSystem({ read, list: () => Object.keys(table), kill });
  writeLock(home, lockDoc({ pid: 4242, start: 'proc:555000' }));
  assert.throws(() => L.acquire(KEY, { home, sys, register: () => () => {} }), errCode('LOCK_HELD'));
  writeLock(home, lockDoc({ pid: 4242, start: 'proc:555001' })); // same pid, other ticks: recycled
  const h = L.acquire(KEY, { home, sys, register: () => () => {} });
  assert.equal(readDoc(home).start, 'proc:900000', 'the source tag is recorded in the lock');
  h.release();
  writeLock(home, lockDoc({ pid: 4242, start: START })); // recorded by ps, checked by /proc: cannot be verified -> held
  assert.throws(() => L.acquire(KEY, { home, sys, register: () => () => {} }), (e) => errCode('LOCK_HELD')(e) && /another source/.test(e.message));
  writeLock(home, lockDoc({ pid: 4242, start: 'proc:555000' })); // and the other way round
  assert.throws(() => L.acquire(KEY, { home, sys: selfSys({ starts: { 4242: 'ps:Fri Nov 21 10:11:12 2026' } }) }), errCode('LOCK_HELD'));
  assert.equal(L.startCmp('proc:9', 'proc:10'), -1);
  assert.equal(L.startCmp('proc:10', START), null);
});

test('lock: "no such process" needs proof: empty ps output and stderr, then signal 0 must say ESRCH (otherwise LOCK_PS)', () => {
  const err = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const run = (status, stdout = '', stderr = '') => () => ({ status, stdout, stderr });
  assert.equal(L.psSystem({ run: run(1), kill: err('ESRCH') }).startOf(4242), null);
  for (const [r, k] of [[run(1), err('EPERM')], [run(1), () => {}], [run(1, '', 'ps: bad pid'), err('ESRCH')], [run(0, 'garbage'), err('ESRCH')], [run(0, 'Thu Nov 20 10:11:12 2026', 'warn'), err('ESRCH')], [run(2, 'x'), err('ESRCH')]])
    assert.throws(() => L.psSystem({ run: r, kill: k }).startOf(4242), errCode('LOCK_PS'));
  assert.equal(L.psSystem({ run: run(0, ' Thu Nov  5 10:11:12 2026\n'), kill: err('ESRCH') }).startOf(4242), 'ps:Thu Nov 5 10:11:12 2026');
  const enoent = () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; };
  assert.equal(L.procSystem({ read: enoent, kill: err('ESRCH') }).startOf(4242), null);
  assert.throws(() => L.procSystem({ read: enoent, kill: err('EPERM') }).startOf(4242), errCode('LOCK_PS'));
  assert.throws(() => L.procSystem({ read: err('EACCES'), kill: err('ESRCH') }).startOf(4242), errCode('LOCK_PS'));
  assert.throws(() => L.procSystem({ read: () => 'junk', kill: err('ESRCH') }).startOf(4242), errCode('LOCK_PS'));
  assert.deepEqual(L.procSystem({ read: (p) => { if (p.includes('/9/')) return enoent(); return `${p.split('/')[2]} (n) S 1 5 5 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 7 0 0`; }, list: () => ['5', '9', 'self', 'net'] }).table(),
    [{ pid: 5, pgid: 5, start: 'proc:7' }], 'a pid gone between listing and reading is skipped; non-numeric entries ignored');
});

test('lock: FACTORY_HOME is resolved to an absolute path and must be a real directory owned by this user; long keys refused cleanly', (t) => {
  const home = tmp(t);
  const rel = path.relative(process.cwd(), home);
  const h = L.acquire(KEY, { home: rel });
  assert.equal(h.file, lockFile(home));
  assert.ok(path.isAbsolute(h.file));
  h.release();
  const link = path.join(tmp(t), 'home-link');
  fs.symlinkSync(home, link);
  const target = tmp(t);
  fs.rmSync(link); fs.symlinkSync(target, link);
  assert.throws(() => L.acquire(KEY, { home: link }), (e) => errCode('LOCK_UNSAFE')(e) && /FACTORY_HOME/.test(e.message));
  assert.deepEqual(fs.readdirSync(target), [], 'nothing created through the link');
  const file = path.join(tmp(t), 'a-file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => L.acquire(KEY, { home: file }), errCode('LOCK_UNSAFE'));
  assert.throws(() => L.acquire(KEY, { home: path.join(file, 'sub') }), errCode('LOCK_UNSAFE'), 'ENOTDIR wrapped');
  const long = `${'a'.repeat(110)}__${'b'.repeat(110)}`;
  assert.throws(() => L.acquire(long, { home }), (e) => errCode('LOCK_UNSAFE')(e) && /repo key longer/.test(e.message));
  assert.throws(() => L.lockPath(long, { home }), errCode('LOCK_UNSAFE'));
  const ok = `${'a'.repeat(100)}__${'b'.repeat(100)}`;
  const h2 = L.acquire(ok, { home });
  h2.release();
});

test('lock: the exit/signal cleanup is registered before any file is created and removes only what this acquire made', (t) => {
  const home = tmp(t);
  writeLock(home, lockDoc({ pid: 4242, groups: [{ pgid: 810, start: START }] }));
  let cleanup = null; let filesAtRegister = null;
  const register = (fn) => { cleanup = fn; filesAtRegister = fs.readdirSync(path.join(home, 'locks')); return () => { cleanup = null; }; };
  const sys = selfSys({ starts: { 4242: null } });
  const realStart = sys.startOf;
  let calls = 0;
  sys.startOf = (pid) => { // a signal arriving in the middle of the takeover: the handler runs the cleanup, then the process exits
    if (pid === 4242 && ++calls === 1) { fs.writeFileSync(`${lockFile(home)}.takeover`, JSON.stringify(lockDoc({ pid: process.pid, start: realStart(process.pid), token: 'f'.repeat(32) }))); }
    return realStart(pid);
  };
  assert.throws(() => L.acquire(KEY, { home, sys, register }), errCode('LOCK_HELD'), 'the planted marker names this process as a live taker');
  assert.deepEqual(filesAtRegister, [`${KEY}.lock`], 'registered before the first temp file');
  assert.equal(cleanup, null, 'an acquire that throws unregisters its cleanup');
  assert.ok(fs.existsSync(`${lockFile(home)}.takeover`), 'a marker with another token is not ours to remove');
  fs.rmSync(`${lockFile(home)}.takeover`);
  assert.deepEqual(readDoc(home).token, TOK, 'the stale lock is untouched');
  // A successful acquire: the registered cleanup (what SIGINT/SIGTERM/exit run) removes the lock and leaves nothing behind.
  const h = L.acquire(KEY, { home, sys: selfSys({ starts: { 4242: null } }), register });
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), []);
  assert.equal(h.release(), false, 'already released');
  L.acquire(KEY, { home, register });
  fs.writeFileSync(`${lockFile(home)}.takeover`, fs.readFileSync(lockFile(home))); // a marker carrying this acquire's token
  cleanup();
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), [], 'its own marker is removed too');
});

test('lock: an unsafe locks directory (symlink, group/world-writable) is refused', (t) => {
  const home = tmp(t);
  const elsewhere = tmp(t);
  fs.symlinkSync(elsewhere, path.join(home, 'locks'));
  assert.throws(() => L.acquire(KEY, { home }), errCode('LOCK_UNSAFE'));
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  const home2 = tmp(t);
  fs.mkdirSync(path.join(home2, 'locks'), { mode: 0o700 });
  fs.chmodSync(path.join(home2, 'locks'), 0o777);
  assert.throws(() => L.acquire(KEY, { home: home2 }), errCode('LOCK_UNSAFE'));
});

test('lock: release removes only a lock this process owns (pid + start + token)', (t) => {
  const home = tmp(t);
  const h = L.acquire(KEY, { home });
  assert.equal(h.owned(), true);
  const mine = readDoc(home);
  writeLock(home, { ...mine, token: 'b'.repeat(32) }); // someone else's lock now sits at the path
  assert.equal(h.owned(), false);
  assert.equal(h.release(), false);
  assert.equal(readDoc(home).token, 'b'.repeat(32));
  assert.throws(() => L.acquire(KEY, { home }), errCode('LOCK_HELD'), 'this process holds the other lock (same pid and start)');
  fs.rmSync(lockFile(home), { force: true });
  const h3 = L.acquire(KEY, { home });
  assert.equal(h3.release(), true);
  assert.equal(fs.existsSync(lockFile(home)), false);
  assert.equal(h3.release(), false, 'idempotent');
});

test('lock: released through the proc cleanup registry on normal exit; a SIGKILLed holder leaves a stale lock', async (t) => {
  const home = tmp(t);
  const a = child(t, home, 'exit');
  assert.equal((await a.first).ok, true);
  await a.exited;
  assert.equal(fs.existsSync(lockFile(home)), false);
  const b = child(t, home, 'hold');
  assert.equal((await b.first).ok, true);
  b.c.kill('SIGKILL');
  await b.exited;
  assert.equal(readDoc(home).pid, b.c.pid, 'left behind');
  const h = L.acquire(KEY, { home });
  assert.equal(readDoc(home).pid, process.pid);
  h.release();
});

test('lock: recordGroup/forgetGroup update the groups list atomically and refuse once the lock is lost', (t) => {
  const home = tmp(t);
  const sys = selfSys({ starts: { 600: START } });
  const h = L.acquire(KEY, { home, sys });
  t.after(() => h.release());
  h.recordGroup(600);
  h.recordGroup(601);
  h.recordGroup(600);
  assert.deepEqual(readDoc(home).groups, [{ pgid: 600, start: START }, { pgid: 601, start: null }]);
  h.forgetGroup(601);
  assert.deepEqual(readDoc(home).groups, [{ pgid: 600, start: START }]);
  assert.ok(L.validLock(readDoc(home)));
  assert.deepEqual(fs.readdirSync(path.join(home, 'locks')), [`${KEY}.lock`], 'no temp file left');
  for (const bad of [0, 1, -5, 1.5, '600', null]) assert.throws(() => h.recordGroup(bad), TypeError);
  writeLock(home, { ...readDoc(home), token: 'c'.repeat(32) });
  assert.throws(() => h.recordGroup(602), errCode('LOCK_LOST'));
  assert.equal(readDoc(home).token, 'c'.repeat(32));
});

test('lock: killOrphans signals only provably-recorded groups that are not this process\'s own', (t) => {
  const home = tmp(t);
  const me = process.pid;
  const orphans = [
    { pgid: 700, start: START }, // leader alive, start matches -> killed
    { pgid: 701, start: START }, // leader alive, different start -> reused
    { pgid: 702, start: START }, // no members -> gone
    { pgid: 703, start: null }, // start never recorded -> unverified
    { pgid: 704, start: START }, // leaderless, members younger -> killed
    { pgid: 705, start: START }, // leaderless, a member older than the recorded leader -> reused
    { pgid: 706, start: START }, // this process's own group -> self
    { pgid: 707, start: START }, // kill fails with EPERM -> failed (kept)
    { pgid: 709, start: 'proc:123' }, // recorded by /proc, table from ps: not comparable -> unverified (kept)
  ];
  writeLock(home, lockDoc({ pid: 4242, groups: [], orphans }));
  const rows = [
    { pid: me, pgid: 706, start: 'ps:Fri Nov 21 09:00:00 2026' },
    { pid: 700, pgid: 700, start: START }, { pid: 7001, pgid: 700, start: START },
    { pid: 701, pgid: 701, start: 'ps:Sat Nov 22 10:00:00 2026' },
    { pid: 703, pgid: 703, start: START },
    { pid: 7041, pgid: 704, start: 'ps:Thu Nov 20 10:11:13 2026' },
    { pid: 7051, pgid: 705, start: 'ps:Wed Nov 19 10:11:12 2026' },
    { pid: 707, pgid: 707, start: START },
    { pid: 709, pgid: 709, start: START },
  ];
  const sys = fakeSys({ starts: { [me]: 'ps:Fri Nov 21 09:00:00 2026', 4242: null }, rows, killFails: { 707: 'EPERM' } });
  const h = L.acquire(KEY, { home, sys });
  t.after(() => h.release());
  const got = Object.fromEntries(h.killOrphans({ signal: 'SIGTERM' }).map((x) => [x.pgid, x.outcome]));
  assert.deepEqual(got, { 700: 'killed', 701: 'reused', 702: 'gone', 703: 'unverified', 704: 'killed', 705: 'reused', 706: 'self', 707: 'failed', 709: 'unverified' });
  assert.deepEqual(sys.killed, [[-700, 'SIGTERM'], [-704, 'SIGTERM']]);
  assert.deepEqual(h.orphans(), [{ pgid: 703, start: null }, { pgid: 707, start: START }, { pgid: 709, start: 'proc:123' }], 'failed and unverified ones stay recorded');
  assert.deepEqual(h.killOrphans(), [{ pgid: 703, outcome: 'unverified' }, { pgid: 707, outcome: 'failed' }, { pgid: 709, outcome: 'unverified' }], 'retried on the next call');
});

test('lock: killOrphans never signals a group containing this process, and refuses when this process is not listed', (t) => {
  const home = tmp(t);
  const me = process.pid;
  const myStart = 'ps:Fri Nov 21 09:00:00 2026';
  writeLock(home, lockDoc({ orphans: [{ pgid: 900, start: START }] }));
  const sys = fakeSys({ starts: { [me]: myStart }, rows: [{ pid: 900, pgid: 900, start: START }, { pid: me, pgid: 900, start: myStart }] });
  const h = L.acquire(KEY, { home, sys });
  assert.deepEqual(h.killOrphans(), [{ pgid: 900, outcome: 'self' }]);
  assert.deepEqual(sys.killed, []);
  h.release();
  writeLock(home, lockDoc({ orphans: [{ pgid: 901, start: START }] }));
  const sys2 = fakeSys({ starts: { [me]: myStart }, rows: [{ pid: 901, pgid: 901, start: START }] });
  const h2 = L.acquire(KEY, { home, sys: sys2 });
  assert.throws(() => h2.killOrphans(), errCode('LOCK_PS'));
  assert.deepEqual(sys2.killed, []);
  h2.release();
});

test('lock: killOrphans kills a real orphaned process group left by a dead holder', async (t) => {
  const home = tmp(t);
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-orphan.pid, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise((r) => setTimeout(r, 150));
  const dead = await deadPid();
  writeLock(home, lockDoc({ pid: dead.pid, start: dead.start, groups: [{ pgid: orphan.pid, start: L.SYSTEM.startOf(orphan.pid) }] }));
  const h = L.acquire(KEY, { home });
  t.after(() => h.release());
  const gone = new Promise((r) => orphan.on('exit', (code, sig) => r(sig)));
  assert.deepEqual(h.killOrphans(), [{ pgid: orphan.pid, outcome: 'killed' }]);
  assert.equal(await gone, 'SIGKILL');
  assert.deepEqual(h.orphans(), []);
});

// ---------------------------------------------------------------------------------------------------------------- driver

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const RUN = { max_fix_rounds: 2, stop: null };
const hist = (...states) => states.map((state) => ({ ts: '2026-11-20T00:00:00.000Z', state }));
const feat = (state, over = {}) => ({ id: 'FEATURE-001', state, fix_rounds: 0, history: hist(state), ...over });
const S = (kind, extra = {}) => ({ step: 'session', kind, ...extra });
const R = (step, kind, extra = {}) => ({ step, kind, ...extra });

// One test per row of the spec's "Driver actions" table (docs/factory/specs/phase-1-verification-gate.md). The feature is in the
// state the queue holds when the driver decides, i.e. after `deliver` (or the driver) applied the step's own transition.
test('Driver actions: queued | — | deliver next, then builder session (build)', () => {
  assert.deepEqual(D.nextAction(feat('queued'), null, RUN), { do: 'next' });
  assert.deepEqual(D.nextAction(feat('building'), null, RUN), { do: 'build', brief: 'build' });
  assert.deepEqual(D.nextAction(feat('building'), R('next', 'ok'), RUN), { do: 'build', brief: 'build' });
});

test('Driver actions: building | builder done | anti-gaming at built, local checks, deliver built', () => {
  assert.deepEqual(D.nextAction(feat('building'), S('done'), RUN), { do: 'built' });
});

test('Driver actions: building | builder blocked | deliver block with the question; attention entry', () => {
  const a = D.nextAction(feat('building'), S('blocked', { question: 'Which database should the cache use?' }), RUN);
  assert.equal(a.do, 'block');
  assert.equal(a.attention, true);
  assert.match(a.reason, /Which database should the cache use\?/);
  assert.equal(D.nextAction(feat('building'), S('blocked', { question: 'q'.repeat(5000) }), RUN).reason.length <= 200, true);
  assert.match(D.nextAction(feat('building'), S('blocked'), RUN).reason, /no_question/);
  // Builder result: max turns counts as blocked with reason no_result.
  const m = D.nextAction(feat('building'), S('max_turns'), RUN);
  assert.equal(m.do, 'block'); assert.match(m.reason, /no_result/);
  assert.equal(D.nextAction(feat('fixing', { history: hist('ci_failed', 'fixing') }), S('blocked', { question: 'x' }), RUN).do, 'block');
});

test('Driver actions: building | local_check_failed (exit 2) | builder session (CI-fix brief from local check), up to local_attempts', () => {
  assert.deepEqual(D.nextAction(feat('building', { local_attempts: 1 }), R('built', 'local_check_failed'), RUN), { do: 'build', brief: 'local_fix' });
  assert.deepEqual(D.nextAction(feat('building', { local_attempts: 3 }), R('built', 'local_check_failed'), RUN), { do: 'build', brief: 'local_fix' });
  const over = D.nextAction(feat('building', { local_attempts: 4 }), R('built', 'local_check_failed'), RUN);
  assert.equal(over.do, 'block');
  assert.equal(D.nextAction(feat('blocked'), R('built', 'local_check_failed'), RUN).do, 'next', 'deliver built already blocked it');
  assert.equal(D.nextAction(feat('building', { local_attempts: 1 }), R('built', 'local_check_failed'), {}).do, 'hold', 'no limits: fail closed');
});

test('Driver actions: built | — | deliver pr with the builder\'s .delivery/pr-<ID>.md', () => {
  assert.deepEqual(D.nextAction(feat('built'), null, RUN), { do: 'pr' });
  assert.deepEqual(D.nextAction(feat('built'), R('built', 'ok'), RUN), { do: 'pr' });
});

test('Driver actions: pr_open | ci passed | -> verification', () => {
  assert.deepEqual(D.nextAction(feat('pr_open'), R('pr', 'ok'), RUN), { do: 'ci' });
  assert.deepEqual(D.nextAction(feat('ci_passed'), R('ci', 'passed'), RUN), { do: 'verify' });
  assert.deepEqual(D.nextAction(feat('ci_passed'), R('ci', 'unverified-allowed'), RUN), { do: 'verify' });
  assert.equal(D.nextAction(feat('pr_open'), R('ci', 'passed'), RUN).do, 'hold', 'ci passed but the queue still says pr_open: inconsistent');
});

test('Driver actions: pr_open | ci failed (exit 2) | deliver fix, builder session (CI fix), deliver push', () => {
  assert.deepEqual(D.nextAction(feat('ci_failed', { fix_rounds: 1 }), R('ci', 'failed'), RUN), { do: 'fix_ci', brief: 'ci_fix' });
  const fixing = feat('fixing', { fix_rounds: 1, history: hist('pr_open', 'ci_failed', 'fixing') });
  assert.deepEqual(D.nextAction(fixing, S('done'), RUN), { do: 'push' });
  assert.deepEqual(D.nextAction(feat('pr_open'), R('push', 'ok'), RUN), { do: 'ci' });
});

test('Driver actions: pr_open | ci timeout | wait again within the CI budget', () => {
  const a = D.nextAction(feat('pr_open'), R('ci', 'timeout'), RUN);
  assert.equal(a.do, 'ci'); assert.match(a.reason, /wait/);
  assert.equal(D.nextAction(feat('blocked'), R('ci', 'timeout'), RUN).do, 'next', 'budget spent: deliver blocked it');
});

test('Driver actions: pr_open | ci unconfirmed (no required check reported) | awaiting_human; attention entry; run stops', () => {
  const a = D.nextAction(feat('awaiting_human'), R('ci', 'unconfirmed'), { ...RUN, stop: 'no CI checks were reported' });
  assert.equal(a.kind, 'ci_unconfirmed');
  assert.equal(a.do, 'stop'); assert.equal(a.attention, true); assert.match(a.reason, /no CI checks/);
  assert.equal(D.nextAction(feat('awaiting_human'), R('ci', 'unconfirmed'), RUN).do, 'stop');
});

test('Driver actions: ci_passed | verification pass | post factory/verified status, gh pr edit, -> verified', () => {
  assert.deepEqual(D.nextAction(feat('ci_passed'), R('verify', 'pass'), RUN), { do: 'verified' });
  assert.deepEqual(D.nextAction(feat('verified'), R('verified', 'ok'), RUN), { do: 'merge' });
  const v = D.nextAction(feat('verified'), null, RUN);
  assert.equal(v.do, 'hold', 'verified with no result never merges directly: the restart rules re-check the verdict'); assert.equal(v.kind, 'inconsistent');
  assert.equal(D.nextAction(feat('ci_passed'), R('verified', 'error'), RUN).do, 'hold');
});

test('Driver actions: ci_passed | verification fail | -> verify_failed; deliver fix, builder session (symptom fix), deliver push', () => {
  assert.deepEqual(D.nextAction(feat('ci_passed', { fix_rounds: 1 }), R('verify', 'fail'), RUN), { do: 'fix_verify', brief: 'symptom_fix' });
  assert.deepEqual(D.nextAction(feat('verify_failed', { fix_rounds: 1 }), R('verify', 'fail'), RUN), { do: 'fix_verify', brief: 'symptom_fix' });
  const fixing = feat('fixing', { fix_rounds: 2, history: hist('ci_passed', 'verify_failed', 'fixing') });
  assert.deepEqual(D.nextAction(fixing, S('done'), RUN), { do: 'push' });
  assert.deepEqual(D.nextAction(fixing, null, RUN), { do: 'build', brief: 'symptom_fix' });
});

test('Driver actions: ci_passed | usage limit | stays ci_passed, run paused', () => {
  const a = D.nextAction(feat('ci_passed'), S('usage_limit', { resetAt: '2026-11-20T15:00:00.000Z' }), RUN);
  assert.deepEqual(a, { do: 'stop', kind: 'usage_limit', reason: 'usage limit reached: the run stops and every state is left as it is', resetAt: '2026-11-20T15:00:00.000Z' });
  for (const st of ['building', 'fixing']) assert.equal(D.nextAction(feat(st, { history: hist('ci_failed', 'fixing') }), S('usage_limit'), RUN).do, 'stop', st);
});

test('Driver actions: verified | merge stale / updated / behind | back to pr_open, CI and verification again', () => {
  for (const k of ['stale', 'updated']) assert.deepEqual(D.nextAction(feat('pr_open'), R('merge', k), RUN), { do: 'ci' }, k);
  assert.equal(D.nextAction(feat('verified'), R('merge', 'stale'), RUN).do, 'hold', 'stale must have moved the feature to pr_open');
});

test('Driver actions: verified | merge held | awaiting_human, attention entry', () => {
  const a = D.nextAction(feat('awaiting_human', { hold_kind: 'antigaming', reason: 'G1 hit' }), R('merge', 'held'), RUN);
  assert.equal(a.do, 'hold'); assert.equal(a.kind, 'antigaming'); assert.equal(a.attention, true);
  assert.equal(D.nextAction(feat('awaiting_human'), R('merge', 'held'), RUN).kind, 'merge');
  assert.equal(D.nextAction(feat('merged'), R('merge', 'merged'), RUN).do, 'next');
  assert.equal(D.nextAction(feat('blocked'), R('merge', 'blocked'), RUN).do, 'next');
});

test('Driver actions: any | fix rounds exhausted | deliver block', () => {
  for (const [st, last] of [['ci_failed', R('ci', 'failed')], ['ci_passed', R('verify', 'fail')], ['verify_failed', R('verify', 'fail')], ['ci_failed', null], ['verify_failed', null]]) {
    const a = D.nextAction(feat(st, { fix_rounds: 2 }), last, RUN);
    assert.equal(a.do, 'block', st); assert.match(a.reason, /2 fix round/);
  }
  assert.equal(D.nextAction(feat('ci_failed', { fix_rounds: 0 }), R('ci', 'failed'), { max_fix_rounds: 0 }).do, 'block');
  assert.equal(D.nextAction(feat('ci_failed', { fix_rounds: 1 }), R('ci', 'failed'), RUN).do, 'fix_ci');
  for (const bad of [{}, { max_fix_rounds: -1 }, { max_fix_rounds: 1.5 }, { max_fix_rounds: '2' }, undefined])
    assert.equal(D.nextAction(feat('ci_failed', { fix_rounds: 0 }), R('ci', 'failed'), bad).do, 'hold', JSON.stringify(bad));
  for (const fr of [undefined, -1, '1', 1.5]) assert.equal(D.nextAction(feat('ci_failed', { fix_rounds: fr }), R('ci', 'failed'), RUN).do, 'hold', String(fr));
});

test('Driver actions: all exit-2 results are handled; only the ones marked "stop" end the run', () => {
  const exit2 = [[feat('building'), R('built', 'local_check_failed')], [feat('ci_failed'), R('ci', 'failed')], [feat('pr_open'), R('ci', 'timeout')]];
  for (const [f, r] of exit2) assert.notEqual(D.nextAction(f, r, RUN).do, 'stop', `${f.state} ${r.kind}`);
  assert.equal(D.nextAction(feat('awaiting_human'), R('ci', 'unconfirmed'), RUN).do, 'stop');
});

test('Driver actions: interruptions (usage limit, timeout) of a session stop the run and leave the branch as it is (until Phase 2)', () => {
  for (const k of ['usage_limit', 'timeout', 'no_result', 'other']) {
    const a = D.nextAction(feat('building'), S(k), RUN);
    assert.equal(a.do, 'stop', k); assert.ok(['usage_limit', 'interrupted'].includes(a.kind), k);
  }
});

test('Driver actions: settings_unsafe and spawn failures hold with the reason category, never the raw keys', () => {
  const a = D.nextAction(feat('building'), S('settings_unsafe', { keys: ['hooks', 'env.SECRET_TOKEN', 'permissions.allow', 'settings.json (inside the session cwd or tmpDir)'] }), RUN);
  assert.equal(a.do, 'hold'); assert.equal(a.kind, 'settings_unsafe'); assert.equal(a.attention, true);
  assert.match(a.reason, /hooks/); assert.match(a.reason, /env/); assert.doesNotMatch(a.reason, /SECRET_TOKEN/); assert.doesNotMatch(a.reason, /allow/);
  for (const k of ['spawn_failed', 'unsafe_binary']) { const b = D.nextAction(feat('building'), S(k), RUN); assert.equal(b.do, 'hold'); assert.equal(b.kind, 'environment'); }
});

test('Driver actions: a verification throw (busy port, app will not exit, escaped listener, UI scenario) holds; no fix round is used', () => {
  const a = D.nextAction(feat('ci_passed', { fix_rounds: 0 }), R('verify', 'threw'), RUN);
  assert.equal(a.do, 'hold'); assert.equal(a.kind, 'verification'); assert.equal(a.attention, true);
  assert.equal(D.canHold('ci_passed'), true);
});

test('Driver actions: anti-gaming at built: G2/G3 get one builder fix attempt, then block', () => {
  assert.deepEqual(D.nextAction(feat('building'), R('antigaming', 'fix', { ids: ['G2'] }), RUN), { do: 'build', brief: 'antigaming_fix', ids: ['G2'] });
  const b = D.nextAction(feat('building', { ag_fix_attempts: 1 }), R('antigaming', 'fix', { ids: ['G3', 'G2'] }), RUN);
  assert.equal(b.do, 'block'); assert.match(b.reason, /G2, G3/);
  assert.equal(D.nextAction(feat('building', { ag_fix_attempts: 'x' }), R('antigaming', 'fix', { ids: ['G2'] }), RUN).do, 'hold');
  assert.equal(D.nextAction(feat('building'), R('antigaming', 'hold', { ids: ['G1'] }), RUN).do, 'hold', 'G1/G4/G5 continue to PR inside the built step');
});

test('Driver actions: anti-gaming G1/G4/G5 at built: continue to PR, then hold at pr_open until a person overrides that exact sha', () => {
  const f = feat('pr_open', { antigaming_hold: { sha: SHA_A, ids: ['G1', 'G4'] } });
  const a = D.nextAction(f, R('pr', 'ok'), RUN);
  assert.deepEqual(a, { do: 'hold', kind: 'antigaming', reason: 'anti-gaming checks G1, G4 fired at built: a person reviews the PR (deliver retry --note)', ids: ['G1', 'G4'], sha: SHA_A, attention: true });
  const ok = { ...f, override_note: 'refactor approved', override_sha: SHA_A, override_ids: ['G1', 'G4'] };
  assert.deepEqual(D.nextAction(ok, null, RUN), { do: 'ci' });
  assert.equal(D.nextAction({ ...ok, override_sha: SHA_B }, null, RUN).do, 'hold', 'override bound to the held sha');
  assert.equal(D.nextAction({ ...ok, override_ids: ['G1'] }, null, RUN).do, 'hold', 'override bound to the G-ids');
  for (const bad of [{ sha: 'x', ids: ['G1'] }, { sha: SHA_A, ids: [] }, { sha: SHA_A, ids: ['G9'] }, 'G1', []]) assert.equal(D.nextAction(feat('pr_open', { antigaming_hold: bad }), null, RUN).do, 'hold', JSON.stringify(bad));
});

test('Driver actions: unknown state or unknown result holds (fail closed)', () => {
  for (const st of ['garbage', '', undefined, 'constructor', '__proto__', 'toString']) assert.equal(D.nextAction({ id: 'FEATURE-001', state: st }, null, RUN).do, 'hold', String(st));
  assert.equal(D.nextAction(null, null, RUN).do, 'hold');
  for (const r of [R('session', 'weird'), R('nope', 'ok'), { kind: 'done' }, 'done', 5, [], R('ci', 'constructor'), R('__proto__', 'ok')]) {
    const a = D.nextAction(feat('building'), r, RUN);
    assert.equal(a.do, 'hold', JSON.stringify(r)); assert.equal(a.kind, 'unknown_result', JSON.stringify(r));
  }
  for (const st of ['awaiting_human', 'merged', 'blocked', 'ci_passed']) assert.equal(D.nextAction(feat(st), S('done'), RUN).do, 'hold', `session result in ${st}`);
  for (const r of [R('ci', 'passed'), R('merge', 'merged'), R('verify', 'pass')]) assert.equal(D.nextAction(feat('queued'), r, RUN).do, 'hold', `queued ${r.step}`);
  for (const step of ['built', 'pr', 'ci', 'push', 'fix', 'merge', 'next', 'block', 'verified']) {
    const a = D.nextAction(feat('pr_open'), R(step, 'error'), RUN);
    assert.equal(a.do, 'hold', step); assert.equal(a.kind, 'error');
  }
  assert.equal(D.nextAction(feat('queued'), S('done'), RUN).do, 'hold', 'a session result for a queued feature is inconsistent');
  assert.equal(D.nextAction(feat('verified'), S('done'), RUN).do, 'hold');
  assert.equal(D.nextAction(feat('fixing', { history: hist('fixing') }), S('done'), RUN).do, 'hold', 'fix kind unknown');
});

test('Driver actions: the run stop (circuit breaker or stop flag) turns "next" into "stop"', () => {
  for (const st of ['queued', 'merged', 'blocked', 'skipped', 'awaiting_human']) {
    const a = D.nextAction(feat(st), null, { ...RUN, stop: 'circuit breaker: 2 features blocked in a row' });
    assert.equal(a.do, 'stop', st); assert.match(a.reason, /circuit breaker/);
    assert.equal(D.nextAction(feat(st), null, RUN).do, 'next', st);
  }
});

test('driver: sessionResult normalises runSession + readBuilderResult into a driver result', () => {
  const ok = { ok: true, failure: null };
  assert.deepEqual(D.sessionResult(ok, { status: 'done', summary: 's' }), { step: 'session', kind: 'done' });
  assert.deepEqual(D.sessionResult(ok, { status: 'blocked', question: 'q?' }), { step: 'session', kind: 'blocked', question: 'q?' });
  assert.deepEqual(D.sessionResult(ok, { status: 'blocked', question: 'no_result' }), { step: 'session', kind: 'blocked', question: 'no_result' });
  assert.deepEqual(D.sessionResult(ok, null), { step: 'session', kind: 'blocked', question: 'no_result' });
  const at = '2026-11-20T15:00:00.000Z';
  for (const k of ['session', 'weekly', 'model', 'rate']) assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: k, resetAt: at } }, { status: 'done' }), { step: 'session', kind: 'usage_limit', resetAt: at });
  for (const bad of ['R', '2026-13-45T99:00:00Z', 'tomorrow', 5, {}, null, undefined, '2026-11-20T15:00:00.000Z<script>'])
    assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: 'session', resetAt: bad } }), { step: 'session', kind: 'usage_limit', resetAt: null }, String(bad));
  assert.equal(D.nextAction(feat('building'), S('usage_limit', { resetAt: 'not a date' }), RUN).resetAt, null);
  for (const k of ['max_turns', 'timeout', 'no_result', 'other', 'spawn_failed', 'unsafe_binary']) assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: k } }, { status: 'done' }), { step: 'session', kind: k }, k);
  assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: 'settings_unsafe', keys: ['hooks'] } }), { step: 'session', kind: 'settings_unsafe', keys: ['hooks'] });
  assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: 'brand_new' } }), { step: 'session', kind: 'other' });
  assert.deepEqual(D.sessionResult({ ok: false, failure: null }), { step: 'session', kind: 'other' });
  assert.deepEqual(D.sessionResult(null), { step: 'session', kind: 'other' });
});

test('driver: fixKind reads the state before the last "fixing" from the history; canHold follows TRANSITIONS', () => {
  assert.equal(D.fixKind(feat('fixing', { history: hist('pr_open', 'ci_failed', 'fixing') })), 'ci_fix');
  assert.equal(D.fixKind(feat('fixing', { history: hist('ci_failed', 'fixing', 'pr_open', 'ci_passed', 'verify_failed', 'fixing') })), 'symptom_fix');
  assert.equal(D.fixKind(feat('fixing', { history: hist('fixing') })), null);
  assert.equal(D.fixKind(feat('fixing', { history: 'x' })), null);
  for (const st of ['pr_open', 'ci_passed', 'verified']) assert.equal(D.canHold(st), true, st);
  for (const st of ['queued', 'building', 'built', 'ci_failed', 'fixing', 'verify_failed', 'awaiting_human', 'blocked', 'merged', 'skipped', 'garbage', '__proto__']) assert.equal(D.canHold(st), false, st);
});

test('driver: every action returned is in ACTIONS', () => {
  const states = ['queued', 'building', 'built', 'pr_open', 'ci_passed', 'ci_failed', 'fixing', 'verified', 'verify_failed', 'awaiting_human', 'blocked', 'skipped', 'merged', 'zzz'];
  const results = [null, ...Object.entries(D.RESULTS).flatMap(([step, kinds]) => kinds.map((k) => R(step, k, { ids: ['G2'] })))];
  for (const st of states) for (const r of results) for (const run of [RUN, {}]) {
    const f = feat(st, { history: hist('ci_failed', st) });
    const a = D.nextAction(f, r, run);
    assert.ok(D.ACTIONS.includes(a.do), `${st} ${JSON.stringify(r)} -> ${a.do}`);
    if (a.do === 'hold' || a.do === 'stop' || a.do === 'block') assert.equal(typeof a.reason, 'string');
    const b = D.resumeAction(f, {}, run);
    assert.ok(D.ACTIONS.includes(b.do), `resume ${st} -> ${b.do}`);
  }
});

// One test per Crash-and-resume rule.
const BASE = { orphans_alive: 0, leftover_worktrees: 0, resumes: 0 };
const FACTS = { branch_exists: true, ahead: 2, dirty: false, head: SHA_A, result: 'done', pr_exists: true, pr_head: SHA_A, verdict: 'pass', ...BASE };

test('Crash and resume: building: commits ahead of base and result.json says done -> continue at built', () => {
  assert.deepEqual(D.resumeAction(feat('building'), FACTS, RUN), { do: 'built' });
});

test('Crash and resume: building: otherwise reset the branch to base and start a fresh build session', () => {
  for (const over of [{ ahead: 0 }, { result: 'absent' }, { branch_exists: false }, { dirty: true }]) {
    assert.deepEqual(D.resumeAction(feat('building'), { ...FACTS, ...over }, RUN), { do: 'build', brief: 'build', reset: true }, JSON.stringify(over));
  }
  for (const over of [{ ahead: -1 }, { ahead: '2' }, { result: 'maybe' }, { dirty: 'no' }, { branch_exists: undefined }]) assert.equal(D.resumeAction(feat('building'), { ...FACTS, ...over }, RUN).do, 'hold', JSON.stringify(over));
});

test('Crash and resume: building: a builder result "blocked" already written -> block (the "builder blocked" row), not a rebuild', () => {
  for (const over of [{}, { ahead: 0 }, { dirty: true }]) {
    const a = D.resumeAction(feat('building'), { ...FACTS, result: 'blocked', ...over }, RUN);
    assert.equal(a.do, 'block', JSON.stringify(over)); assert.equal(a.attention, true);
  }
});

test('Crash and resume: a feature resumed too many times holds instead of looping (default 3, run.max_resumes overrides)', () => {
  const cp = feat('ci_passed', { ci_sha: SHA_A });
  for (const st of ['building', 'fixing', 'ci_passed', 'verified', 'pr_open', 'built']) {
    const f = feat(st, { ci_sha: SHA_A, built_sha: SHA_A, history: hist('ci_failed', 'fixing'), pr: { head_sha: SHA_A } });
    const a = D.resumeAction(f, { ...FACTS, resumes: 3 }, RUN);
    assert.equal(a.do, 'hold', st); assert.equal(a.kind, 'resume_loop', st);
    assert.notEqual(D.resumeAction(f, { ...FACTS, resumes: 2 }, RUN).kind, 'resume_loop', st);
  }
  assert.equal(D.resumeAction(cp, { ...FACTS, resumes: 1 }, { ...RUN, max_resumes: 1 }).kind, 'resume_loop');
  assert.equal(D.resumeAction(cp, FACTS, { ...RUN, max_resumes: -1 }).kind, 'limits');
  assert.deepEqual(D.resumeAction(feat('merged'), { ...BASE, resumes: 9 }, RUN), { do: 'next' }, 'terminal states are not capped');
});

test('Crash and resume: fixing: the head moved since the last CI run -> deliver push', () => {
  const f = feat('fixing', { history: hist('ci_failed', 'fixing'), pr: { number: 7, head_sha: SHA_B } });
  assert.deepEqual(D.resumeAction(f, { ...FACTS, head: SHA_A }, RUN), { do: 'push' });
});

test('Crash and resume: fixing: otherwise run a new fix session', () => {
  const f = feat('fixing', { history: hist('ci_failed', 'fixing'), pr: { number: 7, head_sha: SHA_A } });
  assert.deepEqual(D.resumeAction(f, { ...FACTS, head: SHA_A }, RUN), { do: 'build', brief: 'ci_fix' });
  assert.deepEqual(D.resumeAction({ ...f, history: hist('verify_failed', 'fixing') }, { ...FACTS, head: SHA_A }, RUN), { do: 'build', brief: 'symptom_fix' });
  assert.deepEqual(D.resumeAction({ ...f, pr: { head_sha: SHA_B } }, { ...FACTS, head: SHA_A, dirty: true }, RUN), { do: 'build', brief: 'ci_fix' }, 'dirty: push would refuse');
  for (const over of [{ head: null }, { branch_exists: false }, { head: 'x' }]) assert.equal(D.resumeAction(f, { ...FACTS, ...over }, RUN).do, 'hold', JSON.stringify(over));
  assert.equal(D.resumeAction({ ...f, pr: undefined }, FACTS, RUN).do, 'hold');
  assert.equal(D.resumeAction({ ...f, history: hist('fixing') }, FACTS, RUN).do, 'hold');
});

test('Crash and resume: ci_passed, verified: re-check the stored verdict against the current head; re-verify if absent or mismatched', () => {
  const cp = feat('ci_passed', { ci_sha: SHA_A, fix_rounds: 0 });
  assert.deepEqual(D.resumeAction(cp, FACTS, RUN), { do: 'verified' }, 'a matching pass verdict: post it');
  for (const v of ['absent', 'mismatch']) assert.deepEqual(D.resumeAction(cp, { ...FACTS, verdict: v }, RUN), { do: 'verify' }, v);
  assert.deepEqual(D.resumeAction(cp, { ...FACTS, verdict: 'fail' }, RUN), { do: 'fix_verify', brief: 'symptom_fix' }, 'a matching fail verdict is not re-rolled');
  assert.equal(D.resumeAction({ ...cp, fix_rounds: 2 }, { ...FACTS, verdict: 'fail' }, RUN).do, 'block');
  const moved = D.resumeAction(cp, { ...FACTS, pr_head: SHA_B }, RUN);
  assert.equal(moved.do, 'ci'); assert.equal(moved.reopen, true);
  const vd = feat('verified', { ci_sha: SHA_A });
  assert.deepEqual(D.resumeAction(vd, FACTS, RUN), { do: 'merge' });
  for (const v of ['absent', 'mismatch', 'fail']) { const a = D.resumeAction(vd, { ...FACTS, verdict: v }, RUN); assert.equal(a.do, 'ci', v); assert.equal(a.reopen, true, v); }
  assert.equal(D.resumeAction(vd, { ...FACTS, pr_head: SHA_B }, RUN).reopen, true);
  for (const over of [{ verdict: 'maybe' }, { verdict: undefined }, { pr_head: undefined }, { pr_exists: false }]) assert.equal(D.resumeAction(cp, { ...FACTS, ...over }, RUN).do, 'hold', JSON.stringify(over));
  assert.equal(D.resumeAction({ ...cp, ci_sha: undefined }, FACTS, RUN).do, 'hold');
});

test('Crash and resume: leftover evaluation worktrees and app process groups from the lock are removed first', () => {
  for (const over of [{ orphans_alive: 1 }, { leftover_worktrees: 2 }]) {
    for (const st of ['building', 'ci_passed', 'queued']) {
      const a = D.resumeAction(feat(st, { ci_sha: SHA_A }), { ...FACTS, ...over }, RUN);
      assert.equal(a.do, 'stop', `${st} ${JSON.stringify(over)}`); assert.equal(a.kind, 'leftovers');
    }
  }
  for (const over of [{ orphans_alive: -1 }, { leftover_worktrees: '0' }, { resumes: 1.5 }]) assert.equal(D.resumeAction(feat('queued'), { ...FACTS, ...over }, RUN).do, 'hold');
  for (const k of ['orphans_alive', 'leftover_worktrees', 'resumes']) { // required: missing never reads as zero
    const facts = { ...FACTS }; delete facts[k];
    for (const st of ['queued', 'building', 'merged']) {
      const a = D.resumeAction(feat(st), facts, RUN);
      assert.equal(a.do, 'hold', `${st} without ${k}`); assert.equal(a.kind, 'unknown_result', `${st} without ${k}`);
    }
    assert.equal(D.resumeAction(feat('building'), { ...facts, [k]: undefined }, RUN).do, 'hold', `${k} undefined`);
  }
});

test('Crash and resume: other states resume as the table says', () => {
  assert.deepEqual(D.resumeAction(feat('queued'), BASE, RUN), { do: 'next' });
  assert.deepEqual(D.resumeAction(feat('built', { built_sha: SHA_A }), FACTS, RUN), { do: 'pr' });
  assert.equal(D.resumeAction(feat('built', { built_sha: SHA_B }), FACTS, RUN).do, 'hold', 'commits after built');
  assert.deepEqual(D.resumeAction(feat('pr_open'), FACTS, RUN), { do: 'ci' });
  assert.equal(D.resumeAction(feat('pr_open'), { ...FACTS, pr_exists: false }, RUN).do, 'hold');
  assert.equal(D.resumeAction(feat('pr_open', { antigaming_hold: { sha: SHA_A, ids: ['G4'] } }), FACTS, RUN).kind, 'antigaming');
  assert.deepEqual(D.resumeAction(feat('ci_failed', { fix_rounds: 0 }), FACTS, RUN), { do: 'fix_ci', brief: 'ci_fix' });
  assert.deepEqual(D.resumeAction(feat('verify_failed', { fix_rounds: 0 }), FACTS, RUN), { do: 'fix_verify', brief: 'symptom_fix' });
  for (const st of ['awaiting_human', 'blocked', 'skipped', 'merged']) assert.deepEqual(D.resumeAction(feat(st), BASE, RUN), { do: 'next' }, st);
  assert.equal(D.resumeAction(feat('nope'), FACTS, RUN).do, 'hold');
  assert.equal(D.resumeAction(feat('building'), null, RUN).do, 'hold');
});

test('driver: returned actions are frozen; anti-gaming results are only "fix" (G1/G4/G5 travel in f.antigaming_hold)', () => {
  const a = D.nextAction(feat('pr_open', { antigaming_hold: { sha: SHA_A, ids: ['G1'] } }), null, RUN);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.ids));
  assert.throws(() => { 'use strict'; a.do = 'merge'; }, TypeError);
  assert.ok(Object.isFrozen(D.resumeAction(feat('queued'), BASE, RUN)));
  assert.deepEqual([...D.RESULTS.antigaming], ['fix']);
  for (const k of ['clean', 'hold']) assert.equal(D.nextAction(feat('building'), R('antigaming', k), RUN).kind, 'unknown_result', k);
});

test('driver: pure: inputs are never mutated', () => {
  const f = feat('ci_failed', { fix_rounds: 1, history: hist('pr_open', 'ci_failed') });
  const snap = JSON.stringify(f);
  const r = R('ci', 'failed');
  D.nextAction(f, r, RUN); D.resumeAction(f, FACTS, RUN);
  assert.equal(JSON.stringify(f), snap);
  assert.deepEqual(r, R('ci', 'failed'));
});
