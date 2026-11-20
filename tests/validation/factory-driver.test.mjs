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

test('Driver actions: ci_passed | usage limit | stays ci_passed, interrupted handling (Phase 2)', () => {
  const a = D.nextAction(feat('ci_passed'), S('usage_limit', { limit: 'session', resetAt: '2026-11-20T15:00:00.000Z' }), RUN);
  assert.deepEqual(a, { do: 'interrupt', kind: 'usage_limit', limit: 'session', resetAt: '2026-11-20T15:00:00.000Z' });
  for (const st of ['building', 'fixing']) assert.equal(D.nextAction(feat(st, { history: hist('ci_failed', 'fixing') }), S('usage_limit', { limit: 'rate' }), RUN).do, 'interrupt', st);
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

test('Driver actions: interruptions (usage limit, timeout) go to interrupted handling (Phase 2); a session without a result stops the run', () => {
  assert.equal(D.nextAction(feat('building'), S('usage_limit', { limit: 'session' }), RUN).do, 'interrupt');
  assert.deepEqual(D.nextAction(feat('building'), S('timeout'), RUN), { do: 'interrupt', kind: 'timeout' });
  for (const k of ['no_result', 'other']) {
    const a = D.nextAction(feat('building'), S(k), RUN);
    assert.equal(a.do, 'stop', k); assert.equal(a.kind, 'interrupted', k);
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
  for (const k of ['session', 'weekly', 'model', 'rate']) assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: k, resetAt: at } }, { status: 'done' }), { step: 'session', kind: 'usage_limit', limit: k, resetAt: at });
  for (const bad of ['R', '2026-13-45T99:00:00Z', 'tomorrow', 5, {}, null, undefined, '2026-11-20T15:00:00.000Z<script>'])
    assert.deepEqual(D.sessionResult({ ok: false, failure: { kind: 'session', resetAt: bad } }), { step: 'session', kind: 'usage_limit', limit: 'session', resetAt: null }, String(bad));
  assert.equal(D.nextAction(feat('building'), S('usage_limit', { limit: 'session', resetAt: 'not a date' }), RUN).resetAt, null);
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
  for (const result of ['absent', 'blocked', undefined]) assert.deepEqual(D.resumeAction(f, { ...FACTS, head: SHA_A, result }, RUN), { do: 'build', brief: 'ci_fix' }, `result ${result}: a session that did not finish is not pushed`);
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

// ================================================================================================================================
// Task 11b: factory CLI (scenarios, run), run records. Integration through tests/fixtures/factory-harness.mjs (test seams only) with
// the fake claude (mode "factory") and the fake gh. The origin is a local bare repo reached through a per-process url.insteadOf.
// ================================================================================================================================
import { spawnSync } from 'node:child_process';
const SCRIPTS = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts');
const HARNESS = path.join(REPO, 'tests', 'fixtures', 'factory-harness.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const FAKE_CLAUDE = path.join(REPO, 'tests', 'fixtures', 'fake-claude', 'claude');
const FX = await import(pathToFileURL(path.join(SCRIPTS, 'factory.mjs')).href);
const SC = await import(pathToFileURL(path.join(LIB, 'scenarios.mjs')).href);
const RR = await import(pathToFileURL(path.join(LIB, 'runrecord.mjs')).href);
const VD = await import(pathToFileURL(path.join(LIB, 'verdict.mjs')).href);

const fspec = (id, title) => `---\ntype: feature-spec\nid: ${id}\nopportunity: OPP-001\nstatus: ready\n---\n# ${title}\n\n## Acceptance criteria\n\n| ID | Criterion |\n|---|---|\n| AC-1 | Given items When listing Then they are returned |\n\n## Edge cases\n\n- EC-1: an empty list returns an empty array\n\n## HTTP contract\n\n- \`GET /api/items\`\n- \`POST /api/items\`\n`;
const HIDDEN = 'hidden-alpha-item';
const AUTHOR_OK = JSON.stringify({ scenarios: [
  { id: 'S-1', covers: ['AC-1'], kind: 'api', setup: [{ method: 'POST', path: '/api/items', body: { name: `${HIDDEN} {{CANARY}}` } }], request: { method: 'GET', path: '/api/items' }, assert: [{ status: 200 }, { json_path: '$.items[*].name', contains: `${HIDDEN} {{CANARY}}` }] },
  { id: 'S-2', covers: ['EC-1'], kind: 'api', request: { method: 'GET', path: '/api/items' }, assert: [{ status: 200 }] },
] });
const BASE_CONFIG = { protected_branches: [], merge: { mode: 'squash' }, checks: { required: ['ci'] }, readiness: { min_level: 4 }, verification: { required: true } };

// A bare origin with two ready API features, a fake gh (protection requiring factory/verified), the fake claude as `claude`.
function world(t, { config = BASE_CONFIG, specs = { 'FEATURE-001': 'Items one', 'FEATURE-002': 'Items two' }, fake = {}, gh = {}, test = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-run-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git'), work = path.join(root, 'work'), bin = path.join(root, 'bin'), home = path.join(root, 'home'), fhome = path.join(root, 'fhome');
  for (const d of [bin, home, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(fhome, { mode: 0o700 });
  fs.copyFileSync(FAKE_GH, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  fs.symlinkSync(FAKE_CLAUDE, path.join(bin, 'claude'));
  const rw = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:o/r.git', GIT_CONFIG_KEY_1: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_1: 'ssh://git@github.com/o/r.git' };
  const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...rw, HOME: home } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  sh(work, 'config', 'user.email', 't@x'); sh(work, 'config', 'user.name', 't');
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  for (const [id, title] of Object.entries(specs)) fs.writeFileSync(path.join(work, `.product/features/${id}.md`), fspec(id, title));
  fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify(config, null, 2));
  fs.mkdirSync(path.join(work, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(work, '.github/workflows/ci.yml'), 'name: ci\n');
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'checkout', '-q', '-b', 'main'); sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]], protection: { required_status_checks: { contexts: ['ci', 'factory/verified'] } }, enforceProtection: true, ...gh }));
  const log = path.join(root, 'claude.log');
  fs.writeFileSync(path.join(bin, 'fake.json'), JSON.stringify({ mode: 'factory', log, author: { 'FEATURE-001': AUTHOR_OK, 'FEATURE-002': AUTHOR_OK }, ...fake }));
  const env = { ...process.env, ...rw, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: fhome, FACTORY_TEST: JSON.stringify(test) };
  delete env.FACTORY_BUILDER_HOME;
  const factory = (args, extra = {}) => { const r = spawnSync(process.execPath, [HARNESS, ...args, '--dir', work], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 240000 }); return { code: r.status, out: r.stdout, err: r.stderr, signal: r.signal }; };
  const ghState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const setGh = (fn) => { const s = ghState(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  const setFake = (fn) => { const p = path.join(bin, 'fake.json'); const s = JSON.parse(fs.readFileSync(p, 'utf8')); fn(s); fs.writeFileSync(p, JSON.stringify(s)); };
  const sessions = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const queueFile = path.join(fhome, 'queues', 'o__r.json');
  const queue = () => JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const clone = path.join(fhome, 'clones', 'o__r');
  const records = () => { const f = path.join(clone, '.skill-runs', 'factory-runs.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const inHome = (fn) => { const prev = process.env.FACTORY_HOME; process.env.FACTORY_HOME = fhome; try { return fn(); } finally { if (prev === undefined) delete process.env.FACTORY_HOME; else process.env.FACTORY_HOME = prev; } };
  return { root, origin, work, bin, home, fhome, env, sh, factory, ghState, setGh, setFake, sessions, queue, queueFile, clone, records, inHome, builder: path.join(`${fhome}-builder`, 'o__r') };
}
const noText = (s, extra = []) => { for (const x of [HIDDEN, 'fx-', '/api/items', ...extra]) assert.ok(!String(s).includes(x), `leaks ${x}: ${String(s).slice(0, 400)}`); };

test('factory scenarios: authors, lints and stores approved (auto) scenarios per ready feature; output has IDs and counts only', (t) => {
  const w = world(t);
  const r = w.factory(['scenarios']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 scenarios: stored \(2\), approved: auto/);
  assert.match(r.out, /FEATURE-002 scenarios: stored \(2\), approved: auto/);
  noText(r.out + r.err);
  const doc = w.inHome(() => SC.loadScenarios('o__r', 'FEATURE-001'));
  assert.match(doc.canary, /^fx-[0-9a-f]{6}$/);
  assert.ok(JSON.stringify(doc.scenarios).includes(doc.canary), 'the canary from the prompt is in the scenario data');
  assert.equal(doc.approved.by, 'auto');
  assert.equal(doc.approved.scenarios_hash, SC.scenariosHash(doc));
  const authors = w.sessions().filter((s) => s.argv.includes('--tools'));
  assert.equal(authors.length, 2);
  for (const a of authors) { assert.ok(a.argv.includes('--no-session-persistence')); assert.ok(a.cwd.startsWith(path.join(w.fhome, 'run', 'author')), 'author runs in an empty dir under FACTORY_HOME/run'); }
  const again = w.factory(['scenarios']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /FEATURE-001 scenarios: current and approved/);
  assert.equal(w.sessions().filter((s) => s.argv.includes('--tools')).length, 2, 'current scenarios are not re-authored');
});

test('factory scenarios: human approval stores unapproved; --approve ID --by NAME approves after a re-lint; a tampered doc is not current', (t) => {
  const w = world(t, { config: { ...BASE_CONFIG, verification: { required: true, scenario_approval: 'human' } } });
  const r = w.factory(['scenarios', '--only', 'FEATURE-001']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 scenarios: stored \(2\), awaiting approval/);
  assert.equal(w.inHome(() => SC.loadScenarios('o__r', 'FEATURE-001')).approved, undefined);
  assert.equal(w.factory(['scenarios', '--approve', 'FEATURE-001']).code, 1, '--by is required');
  const au = w.factory(['scenarios', '--approve', 'FEATURE-001', '--by', 'auto']);
  assert.equal(au.code, 1); assert.match(au.out, /--by auto is reserved/);
  const a = w.factory(['scenarios', '--approve', 'FEATURE-001', '--by', 'alice']);
  assert.equal(a.code, 0, a.out + a.err);
  const doc = w.inHome(() => SC.loadScenarios('o__r', 'FEATURE-001'));
  assert.equal(doc.approved.by, 'alice');
  // Tamper: keep the approval, change the content -> not current (approval bound to scenarios_hash), and --approve re-lints.
  const forged = { ...doc, scenarios: doc.scenarios.slice(0, 1) };
  w.inHome(() => SC.saveScenarios('o__r', 'FEATURE-001', forged));
  const s2 = w.factory(['scenarios', '--only', 'FEATURE-001']);
  assert.match(s2.out, /FEATURE-001 scenarios: stored|awaiting approval/, 'a doc whose approval does not match its content is re-authored');
  const after = w.inHome(() => SC.loadScenarios('o__r', 'FEATURE-001'));
  assert.equal(after.scenarios.length, 2);
  assert.equal(after.approved, undefined);
  // An "auto" approval written into the store is not an approval under "human": still awaiting one, and run refuses.
  w.inHome(() => SC.saveScenarios('o__r', 'FEATURE-001', SC.approve(after, 'auto')));
  assert.match(w.factory(['scenarios', '--only', 'FEATURE-001']).out, /FEATURE-001 scenarios: current, awaiting approval/);
});

test('factory scenarios: a reply that fails the coverage lint is rejected with IDs and counts only and nothing is stored', (t) => {
  const bad = JSON.stringify({ scenarios: [{ id: 'S-1', covers: ['AC-1'], kind: 'api', request: { method: 'GET', path: '/api/secret-route' }, assert: [{ status: 200 }] }] });
  const w = world(t, { fake: { author: { 'FEATURE-001': bad } } });
  const r = w.factory(['scenarios', '--only', 'FEATURE-001']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FEATURE-001 scenarios rejected: \d+ problem\(s\)/);
  assert.match(r.out, /EC-1 is not covered/);
  noText(r.out, ['secret-route']);
  assert.equal(w.inHome(() => SC.loadScenarios('o__r', 'FEATURE-001')), null);
  const notJson = world(t, { fake: { author: { 'FEATURE-001': 'here are your scenarios: ...' } } });
  const n = notJson.factory(['scenarios', '--only', 'FEATURE-001']);
  assert.equal(n.code, 1); assert.match(n.out, /1 problem/);
});

test('factory scenarios: a usage limit stops with exit 2; the lock held by another run refuses', (t) => {
  const w = world(t, { fake: { author: { 'FEATURE-001': ['usage'] } } });
  const r = w.factory(['scenarios', '--only', 'FEATURE-001']);
  assert.equal(r.code, 2, r.out + r.err); assert.match(r.out, /usage limit/);
  fs.mkdirSync(path.join(w.fhome, 'locks'), { recursive: true, mode: 0o700 });
  const held = L.acquire('o__r', { home: w.fhome });
  t.after(() => held.release());
  const x = w.factory(['scenarios']);
  assert.equal(x.code, 1); assert.match(x.out, /refused: another factory run holds the lock/); assert.match(x.out, /^fix: /m);
  held.release();
  // The driver clone is preflighted before every fetch: a planted hook (or config outside the allowlist) refuses the run.
  const hook = path.join(w.clone, '.git', 'hooks', 'reference-transaction');
  fs.writeFileSync(hook, `#!/bin/sh\ntouch "${path.join(w.root, 'HOOK-RAN')}"\n`, { mode: 0o755 });
  const y = w.factory(['scenarios']);
  assert.equal(y.code, 1, y.out); assert.match(y.out, /refused: the clone at FACTORY_HOME is not trusted: git repository not safe: a hook is installed/);
  assert.equal(fs.existsSync(path.join(w.root, 'HOOK-RAN')), false, 'the hook never ran');
  fs.rmSync(hook);
  spawnSync('git', ['config', 'core.pager', 'less'], { cwd: w.clone });
  assert.match(w.factory(['scenarios']).out, /not trusted: git config not allowed: core\.pager/);
});

test('factory scenarios: each author session\'s process group is forgotten in the lock once it ends (no stale group)', (t) => {
  const w = world(t);
  w.setFake((s) => { s.lockFile = path.join(w.fhome, 'locks', 'o__r.lock'); });
  const r = w.factory(['scenarios']);
  assert.equal(r.code, 0, r.out + r.err);
  const authors = w.sessions().filter((s) => s.argv.includes('--tools'));
  assert.equal(authors.length, 2);
  assert.ok(Array.isArray(authors[1].lockGroups), 'the lock was readable from the second session');
  assert.ok(!authors[1].lockGroups.some((g) => g.pgid === authors[0].pid), `the first author's group is still recorded: ${JSON.stringify(authors[1].lockGroups)}`);
});

test('scenarioState: the approved flag alone is never trusted (re-lint against the base criteria, approval bound to content)', (t) => {
  const w = world(t);
  assert.equal(w.factory(['scenarios', '--only', 'FEATURE-001']).code, 0);
  const git = (...a) => spawnSync('git', a, { cwd: w.clone, encoding: 'utf8' });
  const g = (...a) => { const r = git(...a); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const bc = FX.baseCriteria(g, 'main', '.product/features/FEATURE-001.md');
  assert.equal(w.inHome(() => FX.scenarioState('o__r', 'FEATURE-001', bc)).ok, true);
  const doc = w.inHome(() => SC.loadScenarios('o__r', 'FEATURE-001'));
  for (const [what, d] of [
    ['approval of other content', { ...doc, scenarios: [doc.scenarios[0], { ...doc.scenarios[1], assert: [{ status: 201 }] }] }],
    ['stale criteria hash', SC.approve({ ...doc, approved: undefined, criteria_hash: `sha256:${'0'.repeat(64)}` }, 'auto')],
    ['lint failure re-approved', SC.approve({ ...doc, approved: undefined, scenarios: doc.scenarios.slice(0, 1) }, 'auto')],
    ['wrong feature', SC.approve({ ...doc, approved: undefined, feature: 'FEATURE-002' }, 'auto')],
  ]) {
    w.inHome(() => fs.writeFileSync(SC.scenarioPath('o__r', 'FEATURE-001'), JSON.stringify(d)));
    assert.equal(w.inHome(() => FX.scenarioState('o__r', 'FEATURE-001', bc)).ok, false, what);
  }
  // The approval mode is enforced at use: an "auto" approval is not current when the base config says "human".
  w.inHome(() => fs.writeFileSync(SC.scenarioPath('o__r', 'FEATURE-001'), JSON.stringify(doc)));
  assert.equal(doc.approved.by, 'auto');
  assert.equal(w.inHome(() => FX.scenarioState('o__r', 'FEATURE-001', bc, 'auto')).ok, true);
  const h = w.inHome(() => FX.scenarioState('o__r', 'FEATURE-001', bc, 'human'));
  assert.equal(h.ok, false); assert.equal(h.why, 'unapproved');
});

test('run record: verification fields and session usage are IDs and counts only; forged values are dropped', () => {
  const f = { id: 'FEATURE-001', state: 'merged', verify_runs: 2, verify_ms: 1234, verdict: 'pass', verdict_sha: 'a'.repeat(40), gap_criteria: ['AC-1', 'EC-2', 'AC-1', 'not an id', 'S-1'], antigaming: ['G4', 'G9', 'x'], override_note: 'because the refactor is fine', sessions: [{ role: 'builder', id: '00000000-0000-4000-8000-000000000001', in: 1, out: 2, cache_create: 3, cache_read: 4, turns: 5, prompt: 'secret' }, { role: 'nobody', id: 'x' }, { role: 'author', id: 'bad id!', in: -1, out: 'x' }] };
  const r = RR.buildRecord({ q: {}, f, run: 'r1', project: 'p', skills: {} });
  assert.equal(r.verify_runs, 2); assert.equal(r.verify_ms, 1234); assert.equal(r.verdict, 'pass'); assert.equal(r.verdict_sha, 'a'.repeat(40));
  assert.deepEqual(r.gap_criteria, ['AC-1', 'EC-2']); assert.deepEqual(r.antigaming, ['G4']);
  assert.equal(r.override_note, true, 'override_note is a boolean only');
  assert.deepEqual(r.sessions, [{ role: 'builder', id: '00000000-0000-4000-8000-000000000001', in: 1, out: 2, cache_create: 3, cache_read: 4, turns: 5 }, { role: 'author', id: null, in: 0, out: 0, cache_create: 0, cache_read: 0, turns: 0 }]);
  assert.ok(!JSON.stringify(r).includes('refactor') && !JSON.stringify(r).includes('secret'));
  const empty = RR.buildRecord({ q: {}, f: { id: 'FEATURE-002', state: 'blocked', verdict: 'maybe', verdict_sha: 'zz', verify_runs: -3, sessions: 'x' }, run: 'r', project: 'p', skills: {} });
  assert.deepEqual([empty.verify_runs, empty.verify_ms, empty.verdict, empty.verdict_sha, empty.gap_criteria, empty.antigaming, empty.override_note, empty.sessions], [0, 0, null, null, [], [], false, []]);
});

// ---- factory run --------------------------------------------------------------------------------------------------------------------
const crypto = await import('node:crypto');
// A stored readiness result at level 4 for the config now on origin/main (deliver init's gate re-checks C1, C2, C4 and C5).
function readiness(w, level = 4) {
  const raw = fs.readFileSync(path.join(w.work, '.product/delivery.json'));
  const doc = { helper_version: '0.1.0', base: 'main', base_sha: w.sh(w.work, 'rev-parse', 'HEAD'), config_hash: `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`, level,
    results: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'].map((id) => ({ id, status: 'pass', reason: '' })), fixes: [], at: new Date().toISOString() };
  fs.mkdirSync(path.join(w.fhome, 'readiness'), { recursive: true });
  fs.writeFileSync(path.join(w.fhome, 'readiness', 'o__r.json'), JSON.stringify(doc));
}
const good = (id, extra = {}) => ({ files: { [`src/${id}.txt`]: 'good\n', ...extra }, spec_complete: true, commit: true, pr_body: `Implements ${id}.\n` });
const ready = (t, opts = {}) => { const w = world(t, opts); readiness(w); const s = w.factory(['scenarios']); assert.equal(s.code, 0, s.out + s.err); return w; };
const builderRuns = (w, id) => w.sessions().filter((s) => !s.argv.includes('--tools') && s.argv[s.argv.indexOf('-p') + 1].includes(id));
const promptOf = (s) => s.argv[s.argv.indexOf('-p') + 1];
const verifyCalls = (w) => { const f = path.join(w.fhome, 'verify-calls.log'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []; };

test('factory run: two API features delivered end to end; factory/verified posted on the merged head before the merge', (t) => {
  const w = ready(t, { fake: { plan: { 'FEATURE-001': [good('FEATURE-001')], 'FEATURE-002': [good('FEATURE-002')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  noText(r.out + r.err, [w.root]);
  const q = w.queue();
  assert.deepEqual(q.features.map((f) => f.state), ['merged', 'merged']);
  const gh = w.ghState();
  for (const f of q.features) {
    const st = (gh.statuses[f.ci_sha] || []).find((s) => s.context === 'factory/verified');
    assert.equal(st?.state, 'success', `${f.id}: factory/verified on the merged head`);
    const merge = gh.calls.find((c) => c[0] === 'pr' && c[1] === 'merge' && c[2] === String(f.pr.number));
    assert.equal(merge[merge.indexOf('--match-head-commit') + 1], f.ci_sha, 'the verified sha is the one merged');
    assert.equal(gh.prs[f.pr.number - 1].state, 'MERGED');
    assert.match(gh.prs[f.pr.number - 1].body, /^Verified: 2\/2 scenarios at [0-9a-f]{7}$/m);
    assert.equal(builderRuns(w, f.id).length, 1);
  }
  // The builder ran in the builder clone (outside FACTORY_HOME), never in the driver clone.
  for (const s of w.sessions().filter((x) => !x.argv.includes('--tools'))) { assert.equal(s.cwd, w.builder); assert.ok(!s.cwd.startsWith(w.fhome + path.sep)); }
  assert.ok(fs.existsSync(path.join(w.clone, '.git')) && fs.statSync(path.join(w.clone, '.git')).isDirectory());
  assert.match(r.out, /features: merged 2/);
});

test('factory run: a wrong build fails verification; the symptom-fix session gets only the brief; fixed; merged; run record fields', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), files: { 'src/FEATURE-001.txt': 'wrong\n' } }, { files: { 'src/FEATURE-001.txt': 'good\n' }, commit: true }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  const f = w.queue().features[0];
  assert.equal(f.state, 'merged');
  assert.equal(f.fix_rounds, 1);
  assert.deepEqual(verifyCalls(w).map((l) => l.split(' ')[2]), ['fail', 'pass']);
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2);
  const fixPrompt = promptOf(runs[1]);
  assert.match(fixPrompt, /AC-1: an endpoint returned an unexpected status or body/);
  assert.match(fixPrompt, /EC-1: an endpoint returned an unexpected status or body/);
  const doc = w.inHome(() => SC.loadScenarios('o__r', 'FEATURE-001'));
  for (const s of [fixPrompt, fs.readFileSync(path.join(w.builder, '.implementation', 'FEATURE-001', 'fix-brief.md'), 'utf8')]) {
    for (const x of [doc.canary, HIDDEN, '/api/items', 'S-1', 'S-2', w.fhome, 'status": 200', 'json_path']) assert.ok(!s.includes(x), `the symptom brief leaks ${x}`);
  }
  const rec = w.records().filter((x) => x.feature === 'FEATURE-001').pop();
  assert.equal(rec.outcome, 'merged');
  assert.equal(rec.verify_runs, 2); assert.ok(Number.isInteger(rec.verify_ms));
  assert.equal(rec.verdict, 'pass'); assert.equal(rec.verdict_sha, f.ci_sha);
  assert.deepEqual(rec.gap_criteria, ['AC-1', 'EC-1']);
  assert.deepEqual(rec.antigaming, []); assert.equal(rec.override_note, false);
  assert.equal(rec.sessions.length, 2);
  assert.deepEqual(rec.sessions[0], { role: 'builder', id: '00000000-0000-4000-8000-000000000001', in: 120, out: 45, cache_create: 300, cache_read: 9000, turns: 2 });
  const raw = fs.readFileSync(path.join(w.clone, '.skill-runs', 'factory-runs.jsonl'), 'utf8');
  for (const x of [doc.canary, HIDDEN, '/api/items', 'json_path', w.root]) assert.ok(!raw.includes(x), `the run record leaks ${x}`);
});

test('factory run: a blocked builder blocks the feature with an attention line (the question stays in the queue); start sweeps', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ status: 'blocked', question: 'Postgres or SQLite?' }] } } });
  // Leftovers of a dead run: a verification worktree of this repo, a trash entry and a kept run temp (no process uses them).
  for (const d of [['work', 'o__r', `FEATURE-009-${'a'.repeat(40)}`, 'src'], ['trash', 'q1'], ['tmp', 'r1']]) fs.mkdirSync(path.join(w.fhome, ...d), { recursive: true });
  const r = w.factory(['run']);
  for (const d of [['work', 'o__r', `FEATURE-009-${'a'.repeat(40)}`], ['trash', 'q1'], ['tmp', 'r1']]) assert.equal(fs.existsSync(path.join(w.fhome, ...d)), false, d.join('/'));
  assert.equal(r.code, 2, `a blocked feature finishes with exit 2: ${r.out}${r.err}`);
  assert.match(r.out, /^attention: FEATURE-001 blocked \(block\)$/m);
  assert.ok(!r.out.includes('Postgres'), 'builder text is not printed');
  const f = w.queue().features[0];
  assert.equal(f.state, 'blocked'); assert.match(f.reason, /Postgres or SQLite/);
  assert.equal(verifyCalls(w).length, 0);
  const att = fs.readFileSync(path.join(w.fhome, 'attention', 'o__r.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(att.map((a) => [a.feature, a.state, a.kind]), [['FEATURE-001', 'blocked', 'block']]);
});

test('factory run: a config-injection PR (.claude/settings.json) is held by G4 at pr_open, bound to the sha; never verified or merged', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001', { '.claude/settings.json': '{"hooks":{"Stop":[]}}\n' })] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err); // finished with a feature that needs a person
  assert.match(r.out, /attention: FEATURE-001 awaiting_human \(antigaming\)/);
  const f = w.queue().features[0];
  assert.equal(f.state, 'awaiting_human'); assert.equal(f.hold_kind, 'antigaming');
  assert.deepEqual(f.hold_ids, ['G4']); assert.equal(f.hold_sha, f.pr.head_sha); assert.equal(f.antigaming_hold.sha, f.built_sha);
  assert.deepEqual(f.antigaming, ['G4']);
  assert.equal(verifyCalls(w).length, 0, 'held before verification');
  assert.ok(!w.ghState().calls.some((c) => c[0] === 'pr' && c[1] === 'merge'));
  const rec = w.records().pop();
  assert.equal(rec.outcome, 'awaiting_human'); assert.deepEqual(rec.antigaming, ['G4']);
});

test('factory run: a second run is refused while the lock is held', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const held = L.acquire('o__r', { home: w.fhome });
  t.after(() => held.release());
  const r = w.factory(['run']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /refused: another factory run holds the lock/);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 0);
});

test('factory run: killed after built, the restart resumes at pr without a second build session', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const k = w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'built' }) });
  assert.equal(k.signal, 'SIGKILL', k.out + k.err);
  assert.equal(w.queue().features[0].state, 'built');
  assert.ok(fs.existsSync(path.join(w.fhome, 'locks', 'o__r.lock')), 'the dead driver left its lock');
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 built -> pr/);
  const f = w.queue().features[0];
  assert.equal(f.state, 'merged'); assert.equal(f.resumes, 1);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1, 'no second build session');
});

test('factory run: clean stops (usage limit) do not count as crashes; a fifth run still resumes the build', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ status: 'usage' }] } } });
  for (let i = 0; i < 5; i++) {
    const r = w.factory(['run']);
    assert.equal(r.code, 2, `run ${i + 1}: ${r.out}${r.err}`);
    assert.match(r.out, /stopped: usage_limit/, `run ${i + 1}`);
    assert.ok(!/resume_loop/.test(r.out), `run ${i + 1} is not a resume loop: ${r.out}`);
    if (i > 0) assert.match(r.out, /FEATURE-001 building -> build/, `run ${i + 1} resumed the build`);
    const f = w.queue().features[0];
    assert.equal(f.state, 'building'); assert.equal(f.resumes ?? 0, 0, `run ${i + 1}: a run that ended cleanly resets the count`);
  }
  assert.equal(builderRuns(w, 'FEATURE-001').length, 5);
});

test('factory run: real crashes still count: after three crashed resumes the feature stops as resume_loop, and stays stopped', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ status: 'none' }] } } });
  const kill = { FACTORY_TEST: JSON.stringify({ killAfter: 'build' }) };
  for (let i = 0; i < 4; i++) assert.equal(w.factory(['run'], kill).signal, 'SIGKILL', `crash ${i + 1}`);
  assert.equal(w.queue().features[0].resumes, 3);
  for (let i = 0; i < 2; i++) {
    const r = w.factory(['run']);
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, /^attention: FEATURE-001 building \(resume_loop\)$/m);
    assert.match(r.out, /stopped: FEATURE-001 needs a person \(resume_loop\)/);
    assert.equal(w.queue().features[0].resumes, 3, 'the resume_loop stop does not reset the count');
  }
  assert.equal(builderRuns(w, 'FEATURE-001').length, 4, 'no build session after the cap');
});

test('factory run: refusals with fix text (protection, verification.required, readiness, missing scenarios); nothing starts', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, gh: { protection: { required_status_checks: { contexts: ['ci'] } } }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /refused: .*branch protection on main does not require the factory\/verified status/);
  assert.match(r.out, /^fix: require the "factory\/verified" status check in branch protection/m);
  w.setGh((s) => { delete s.protection; });
  assert.match(w.factory(['run']).out, /does not require the factory\/verified/);
  const n = world(t, { config: { ...BASE_CONFIG, verification: { required: false }, readiness: null, local_checks: [{ name: 'unit', command: ['true'], timeout_s: 10 }] }, specs: { 'FEATURE-001': 'Items one' } });
  const x = n.factory(['run']);
  assert.equal(x.code, 1);
  assert.match(x.out, /local_checks are configured/); assert.match(x.out, /^fix: run those checks in CI/m);
  const v = world(t, { config: { ...BASE_CONFIG, checks: { required: ['ci', 'factory/verified'] } }, specs: { 'FEATURE-001': 'Items one' } });
  readiness(v);
  assert.match(v.factory(['run']).out, /checks\.required names factory\/verified/);
  assert.match(x.out, /verification\.required is not true/); assert.match(x.out, /readiness level 4/); assert.match(x.out, /stored readiness result is missing/);
  assert.ok((x.out.match(/^fix: /gm) || []).length >= 3, 'one fix line per problem');
  const s = world(t, { specs: { 'FEATURE-001': 'Items one' } });
  readiness(s);
  const y = s.factory(['run']);
  assert.equal(y.code, 1, y.out);
  assert.match(y.out, /features without current approved scenarios: FEATURE-001 \(missing\)/);
  assert.equal(fs.existsSync(s.queueFile), false, 'no queue was created');
  readiness(s, 3);
  assert.match(s.factory(['run']).out, /level 3/);
  for (const v of [w, n, s]) assert.equal(v.sessions().filter((e) => !e.argv.includes('--tools')).length, 0);
});

test('factory run: G2 at built gets one builder fix attempt (antigaming_fix brief), then blocks when it still fires', (t) => {
  const only = { 'test/items.test.js': "it.only('lists', () => {});\n" };
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001', only), { status: 'done' }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err); // finished with a feature that needs a person
  const runs = builderRuns(w, 'FEATURE-001');
  assert.equal(runs.length, 2);
  assert.match(promptOf(runs[1]), /Anti-gaming checks G2 fired/);
  const f = w.queue().features[0];
  assert.equal(f.state, 'blocked'); assert.match(f.reason, /G2 still fire after a builder fix attempt/);
  assert.equal(f.ag_fix_attempts, 1);
  assert.match(r.out, /attention: FEATURE-001 blocked/);
  assert.equal(w.ghState().prs.length, 0, 'no PR for a G2/G3 build');
});

test('factory run: with no checks.required, CI waits only for CI (not factory/verified); merge needs factory/verified on the head', (t) => {
  const w = ready(t, { config: { ...BASE_CONFIG, checks: { required: [] } }, specs: { 'FEATURE-001': 'Items one' }, gh: { required: [{ name: 'ci', bucket: 'pass' }, { name: 'factory/verified', bucket: 'pending' }], statusesAsChecks: true }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(w.queue().features[0].state, 'merged');
});

test('deliver hold is a driver command: refused for a queue outside FACTORY_HOME; held states only', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ status: 'blocked' }] } } });
  assert.equal(w.factory(['run']).code, 2);
  const out = path.join(w.root, 'q.json'); fs.copyFileSync(w.queueFile, out);
  const d = (q, ...a) => spawnSync(process.execPath, [path.join(SCRIPTS, 'deliver.mjs'), ...a, '--dir', w.clone], { encoding: 'utf8', env: { ...w.env, DELIVER_QUEUE: q } });
  const x = d(out, 'hold', 'FEATURE-001', '--reason', 'r');
  assert.equal(x.status, 1); assert.match(x.stderr, /factory driver command/);
  const y = d(w.queueFile, 'hold', 'FEATURE-001', '--reason', 'r');
  assert.equal(y.status, 1); assert.match(y.stderr, /"blocked", which cannot wait for a person/);
});

test('factory run: a session that writes no result never reuses the previous one (result.json deleted before every session)', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), files: { 'src/FEATURE-001.txt': 'wrong\n' } }, { files: { 'src/FEATURE-001.txt': 'good\n' }, commit: true, status: 'none' }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err); // finished with a feature that needs a person
  const f = w.queue().features[0];
  assert.equal(f.state, 'blocked', 'no result = blocked (no_result), not the stale "done" of the first session');
  assert.match(f.reason, /no_result/);
  assert.equal(verifyCalls(w).length, 1);
});

test('factory run: a process escaping the builder session (own session, cwd in the clone) stops the run before any git call there', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), escape_ms: 20000 }] } } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /attention: FEATURE-001 building \(leftovers\)/); assert.match(r.out, /stopped: leftovers/);
  assert.equal(w.queue().features[0].state, 'building', 'state left as it is');
});

test('factory run: verification that throws holds (no fix round used); the builder dir may not be inside FACTORY_HOME', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), files: { 'src/FEATURE-001.txt': 'throw\n' } }] } } });
  const bad = w.factory(['run'], { FACTORY_BUILDER_HOME: path.join(w.fhome, 'b') });
  assert.equal(bad.code, 1); assert.match(bad.out, /refused: the builder directory must be outside FACTORY_HOME/);
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err); // finished with a feature that needs a person
  const f = w.queue().features[0];
  assert.equal(f.state, 'awaiting_human'); assert.equal(f.hold_kind, 'verification'); assert.equal(f.fix_rounds, 0);
  assert.equal(f.verify_runs, 1); assert.equal(f.verdict, undefined);
  assert.equal(builderRuns(w, 'FEATURE-001').length, 1);
});

test('factory run: on resume, features whose scenarios are no longer current are refused before anything runs', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  assert.equal(w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'built' }) }).signal, 'SIGKILL');
  const sp = path.join(w.fhome, 'scenarios', 'o__r', 'FEATURE-001.json');
  const saved = fs.readFileSync(sp);
  fs.writeFileSync(sp, JSON.stringify({ ...JSON.parse(saved), scenarios: [] }));
  const r = w.factory(['run']);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /features without current approved scenarios: FEATURE-001 \(lint\)/);
  assert.equal(w.queue().features[0].state, 'built');
  fs.writeFileSync(sp, saved);
  // Queue tamper: a queue for another repository is refused; a queue file swapped for a symlink is never read.
  const qsaved = fs.readFileSync(w.queueFile);
  fs.writeFileSync(w.queueFile, JSON.stringify({ ...JSON.parse(qsaved), repo: 'evil/r' }));
  const a = w.factory(['run']); assert.equal(a.code, 1); assert.match(a.out, /refused: the stored queue is for another repository/);
  const elsewhere = path.join(w.root, 'q-elsewhere.json'); fs.writeFileSync(elsewhere, qsaved); fs.rmSync(w.queueFile); fs.symlinkSync(elsewhere, w.queueFile);
  const b = w.factory(['run']); assert.equal(b.code, 1); assert.match(b.out, /error: the queue file is not a regular file/);
  fs.rmSync(w.queueFile); fs.writeFileSync(w.queueFile, qsaved, { mode: 0o600 });
  assert.equal(w.factory(['run']).code, 0);
  assert.equal(w.queue().features[0].state, 'merged');
});

test('factory run: killed after a build session that left the tree dirty, the restart resets and rebuilds (dirty = deliver built\'s check)', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), dirty_file: 'stray.txt' }, good('FEATURE-001')] } } });
  assert.equal(w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'build' }) }).signal, 'SIGKILL');
  assert.equal(w.queue().features[0].state, 'building');
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 building -> build \(build\)/);
  assert.equal(w.queue().features[0].state, 'merged');
  assert.equal(builderRuns(w, 'FEATURE-001').length, 2, 'a dirty tree is reset and rebuilt, never reported built');
  assert.equal(fs.existsSync(path.join(w.builder, 'stray.txt')), false, 'clean -fd removed the stray file');
});

// ---- review round 1 -----------------------------------------------------------------------------------------------------------------
const sleeper = (cwd, ms = 60000) => { fs.mkdirSync(cwd, { recursive: true }); const c = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { cwd, detached: true, stdio: 'ignore' }); c.unref(); return c; };

test('I-1: a branch tracking .delivery (symlink) or .skill-runs is blocked before checkout in the driver clone; no link target is created', (t) => {
  const w = ready(t, { fake: { plan: {} } });
  const pwned = path.join(w.root, 'PWNED');
  w.setFake((s) => { s.plan = {
    'FEATURE-001': [{ ...good('FEATURE-001'), symlinks: { '.delivery/.gitignore': pwned }, force_add: ['.delivery/.gitignore'] }],
    'FEATURE-002': [{ ...good('FEATURE-002', { '.Skill-Runs/factory-runs.jsonl': '{"forged":true}\n' }) }],
  }; });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.equal(fs.existsSync(pwned), false, 'the dangling link target was never created');
  assert.deepEqual(w.queue().features.map((f) => f.state), ['blocked', 'blocked']);
  for (const f of w.queue().features) assert.match(f.reason, /tracks \.delivery, \.implementation or \.skill-runs/);
  assert.match(r.out, /attention: FEATURE-001 blocked/); assert.match(r.out, /attention: FEATURE-002 blocked/);
  for (const p of ['.delivery', '.delivery/.gitignore']) { let st = null; try { st = fs.lstatSync(path.join(w.clone, p)); } catch { /* absent */ } assert.ok(!st || !st.isSymbolicLink(), `${p} in the driver clone is not a link`); }
  assert.ok(!fs.readFileSync(path.join(w.clone, '.skill-runs', 'factory-runs.jsonl'), 'utf8').includes('forged'), 'run records not overwritten');
  assert.equal(w.ghState().prs.length, 0);
});

test('I-1 (b): deliver never writes .delivery/.gitignore through a planted (dangling) symlink', (t) => {
  const w = world(t, { specs: { 'FEATURE-001': 'Items one' } });
  readiness(w);
  const target = path.join(w.root, 'CREATED');
  fs.mkdirSync(path.join(w.work, '.delivery')); fs.symlinkSync(target, path.join(w.work, '.delivery', '.gitignore'));
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'deliver.mjs'), 'init', '--dir', w.work], { encoding: 'utf8', env: w.env });
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /\.delivery\/\.gitignore is a symlink/);
  assert.equal(fs.existsSync(target), false);
  fs.rmSync(path.join(w.work, '.delivery'), { recursive: true }); fs.symlinkSync(path.join(w.root, 'elsewhere'), path.join(w.work, '.delivery'));
  const r2 = spawnSync(process.execPath, [path.join(SCRIPTS, 'deliver.mjs'), 'init', '--dir', w.work], { encoding: 'utf8', env: w.env });
  assert.equal(r2.status, 1); assert.match(r2.stderr, /\.delivery is a symlink/); assert.equal(fs.existsSync(path.join(w.root, 'elsewhere')), false);
});

test('I-2/I-4: a restart at ci_passed scans the builder clone before verification; another repo\'s live builder run dir does not matter', async (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const other = sleeper(path.join(`${w.fhome}-builder`, 'run', 'a__b', 'x'));
  t.after(() => { try { process.kill(other.pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.equal(w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'ci' }) }).signal, 'SIGKILL');
  assert.equal(w.queue().features[0].state, 'ci_passed');
  const live = sleeper(w.builder);
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err); assert.match(r.out, /stopped: leftovers/);
  assert.equal(verifyCalls(w).length, 0, 'no verification while a builder process lives');
  process.kill(live.pid, 'SIGKILL');
  await new Promise((res) => setTimeout(res, 300));
  const ok = w.factory(['run']);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /FEATURE-001 ci_passed -> verify/);
  assert.equal(w.queue().features[0].state, 'merged');
});

test('restarts: fixing resumes the fix session without a second deliver fix; verified resumes at merge without re-verifying', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [{ ...good('FEATURE-001'), files: { 'src/FEATURE-001.txt': 'wrong\n' } }, { files: { 'src/FEATURE-001.txt': 'good\n' }, commit: true }] } } });
  assert.equal(w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'fix_verify' }) }).signal, 'SIGKILL');
  assert.equal(w.queue().features[0].state, 'fixing');
  assert.equal(w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'verified' }) }).signal, 'SIGKILL');
  const f1 = w.queue().features[0];
  assert.equal(f1.state, 'verified'); assert.equal(f1.fix_rounds, 1, 'the fix round was not counted twice');
  assert.equal(builderRuns(w, 'FEATURE-001').length, 2);
  const r = w.factory(['run']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 verified -> merge/);
  assert.equal(w.queue().features[0].state, 'merged');
  assert.deepEqual(verifyCalls(w).map((l) => l.split(' ')[2]), ['fail', 'pass'], 'the stored pass verdict was reused, not re-run');
});

test('a fresh run refuses while a leftover verification worktree is still in use', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const dir = path.join(w.fhome, 'work', 'o__r', `FEATURE-001-${'b'.repeat(40)}`);
  const p = sleeper(dir);
  t.after(() => { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } });
  const r = w.factory(['run']);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /still alive \(0 process group\(s\), 1 directory/);
  assert.ok(fs.existsSync(dir), 'a worktree in use is never removed');
  assert.equal(fs.existsSync(w.queueFile), false);
});

test('a queue in progress with only queued (and blocked) features stops on leftovers before deliver next or any session', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one', 'FEATURE-002': 'Items two' }, fake: { plan: { 'FEATURE-001': [{ status: 'blocked' }], 'FEATURE-002': [good('FEATURE-002')] } } });
  assert.equal(w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'block' }) }).signal, 'SIGKILL');
  assert.deepEqual(w.queue().features.map((f) => f.state), ['blocked', 'queued']);
  const dir = path.join(w.fhome, 'work', 'o__r', `FEATURE-002-${'c'.repeat(40)}`);
  const p = sleeper(dir);
  t.after(() => { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /stopped: leftovers: processes or worktrees from an earlier run are still alive \(0 process group\(s\), 1 directory/);
  assert.match(r.out, /fix: stop them/);
  assert.doesNotMatch(r.out, /-> next/);
  assert.equal(builderRuns(w, 'FEATURE-002').length, 0, 'no builder session started');
  assert.deepEqual(w.queue().features.map((f) => f.state), ['blocked', 'queued'], 'states left as they are');
  assert.ok(fs.existsSync(dir), 'a worktree in use is never removed');
});

test('a relative FACTORY_HOME reaches deliver resolved (the queue counts as under FACTORY_HOME at merge)', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  const r = w.factory(['run'], { FACTORY_HOME: path.relative(process.cwd(), w.fhome) });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(w.queue().features[0].state, 'merged');
});

test('makeNetGit: the https credential helper is offered before any account token is known (private https clone)', (t) => {
  const d = tmp(t); const log = path.join(d, 'argv.json');
  fs.writeFileSync(path.join(d, 'git'), `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${log}" "$@"\n`, { mode: 0o755 });
  const prev = process.env.PATH; process.env.PATH = `${d}:${prev}`;
  try { FX.makeNetGit({ host: 'github.com' })(d, ['clone', 'https://github.com/o/r.git', 'r']); } finally { process.env.PATH = prev; }
  const argv = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.ok(argv.includes('credential.https://github.com.helper=!gh auth git-credential'), JSON.stringify(argv));
  assert.ok(argv.includes('credential.helper='), 'every other helper is blanked first');
});

test('resume: a builder clone git refuses to read (planted nested .git) -> attention and exit 2, state left as it is', (t) => {
  const w = ready(t, { specs: { 'FEATURE-001': 'Items one' }, fake: { plan: { 'FEATURE-001': [good('FEATURE-001')] } } });
  assert.equal(w.factory(['run'], { FACTORY_TEST: JSON.stringify({ killAfter: 'build' }) }).signal, 'SIGKILL');
  fs.mkdirSync(path.join(w.builder, 'vendor', 'x', '.git'), { recursive: true });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.out, /attention: FEATURE-001 building \(resume_error\)/); assert.match(r.out, /stopped: resume_error/);
  assert.equal(w.queue().features[0].state, 'building');
  assert.ok(!r.out.includes(w.root), 'no paths printed');
});

// ---- review round 2 -----------------------------------------------------------------------------------------------------------------
test('I-5: dot entries that may alias a driver-owned name on APFS (U+017F, zero-width, NFD) are blocked; the run records stay untouched', (t) => {
  const names = { 'FEATURE-001': '.ſkill-runs', 'FEATURE-002': '.skill-runſ', 'FEATURE-003': '.​delivery', 'FEATURE-004': '.délivery' };
  const specs = Object.fromEntries(Object.keys(names).map((id, i) => [id, `Items ${i + 1}`]));
  const w = ready(t, { specs, config: { ...BASE_CONFIG, limits: { max_failures: 10 } }, fake: { plan: {}, author: Object.fromEntries(Object.keys(names).map((id) => [id, AUTHOR_OK])) } });
  w.setFake((s) => { s.plan = Object.fromEntries(Object.entries(names).map(([id, n]) => [id, [good(id, { [`${n}/factory-runs.jsonl`]: '{"forged":true}\n' })]])); });
  const r = w.factory(['run']);
  assert.equal(r.code, 2, r.out + r.err);
  assert.deepEqual(w.queue().features.map((f) => f.state), ['blocked', 'blocked', 'blocked', 'blocked']);
  for (const f of w.queue().features) assert.match(f.reason, /tracks \.delivery, \.implementation or \.skill-runs/);
  const recs = fs.readFileSync(path.join(w.clone, '.skill-runs', 'factory-runs.jsonl'), 'utf8');
  assert.ok(!recs.includes('forged'));
  assert.equal(recs.trim().split('\n').length, 4, 'one blocked record per feature, none lost');
  assert.equal(w.ghState().prs.length, 0);
});

test('I-4 residual: the survivor scan matches whole paths (a repo named o/r does not see the builder of o/r2)', async (t) => {
  const d = tmp(t);
  const VF = await import(pathToFileURL(path.join(LIB, 'verify.mjs')).href);
  const k = path.join(d, 'run', 'o__r');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', `${k}2/FEATURE-1-x/tmp`], { detached: true, stdio: 'ignore', cwd: d }); other.unref();
  t.after(() => { try { process.kill(other.pid, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(VF.scanSurvivors([k]), 0, 'a sibling path with the same prefix is not a survivor');
  assert.ok(VF.scanSurvivors([`${k}2`]) >= 1, 'the exact path still matches');
  const mine = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', `${k}/FEATURE-1-x/tmp`], { detached: true, stdio: 'ignore', cwd: d }); mine.unref();
  t.after(() => { try { process.kill(mine.pid, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise((res) => setTimeout(res, 200));
  assert.ok(VF.scanSurvivors([k]) >= 1, 'a path below the marker matches');
});

test('N-1: a checkout whose github.account differs from the base config is ignored for an ssh remote (enforced only for a first https clone)', (t) => {
  const w = world(t, { specs: { 'FEATURE-001': 'Items one' } });
  fs.writeFileSync(path.join(w.work, '.product/delivery.json'), JSON.stringify({ ...BASE_CONFIG, github: { account: 'work' } }));
  const r = w.factory(['scenarios']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /FEATURE-001 scenarios: stored/);
});
