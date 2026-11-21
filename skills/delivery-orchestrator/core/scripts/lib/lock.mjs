// Per-repo driver lock: FACTORY_HOME/locks/<owner>__<repo>.lock. Zero dependencies.
// The lock names its holder by pid AND process start identity, so a recycled pid is never mistaken for the holder. The start is
// a tagged string: on Linux "proc:<ticks>" (field 22 of /proc/<pid>/stat, clock ticks since boot: a wall-clock step does not
// move it, while `ps lstart` there is derived from the boot time and does); elsewhere "ps:<lstart>" (`ps -o lstart=` with
// TZ=UTC0 and the C locale; on macOS it is the start time stored at fork). Starts compare exactly within one source; a recorded
// start from another source cannot be verified and counts as live. A lock is stale only when that exact pid+start pair is
// provably gone; a live or unverifiable pair holds it; a lock that cannot be read or parsed is HELD (fail closed: a person
// removes it). It also records the process groups the holder starts, so a later driver can stop what a killed one left running.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { factoryHome } from './factoryhome.mjs';
import { checkRepoKey } from './scenarios.mjs';
import { registerCleanup } from './proc.mjs';

const MAX_BYTES = 64 * 1024;
const MAX_GROUPS = 1000;
const MAX_PID = 2 ** 31 - 1;
const TOKEN = /^[0-9a-f]{32}$/;
const DOC_KEYS = ['v', 'pid', 'start', 'token', 'groups', 'orphans'];
const GROUP_KEYS = ['pgid', 'start'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LSTART = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (0?[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d) (\d{4})$/;
const PS_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' });

export class LockError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// "Thu Nov  5 10:11:12 2026" -> "Thu Nov 5 10:11:12 2026" (spaces collapsed, day unpadded); anything else -> null.
export function normStart(text) {
  const m = LSTART.exec(String(text ?? '').trim().replace(/\s+/g, ' '));
  return m ? `${m[1]} ${m[2]} ${Number(m[3])} ${m[4]}:${m[5]}:${m[6]} ${m[7]}` : null;
}
// Seconds since the epoch of a normalised lstart (ps ran with TZ=UTC0), for ordering only.
export function startSecs(s) {
  const m = LSTART.exec(String(s ?? ''));
  return m ? Date.UTC(Number(m[7]), MONTHS.indexOf(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000 : null;
}
const TICKS = /^proc:(0|[1-9]\d{0,19})$/;
// A tagged start identity: "ps:<normalised lstart>" or "proc:<ticks since boot>".
export const validStart = (s) => typeof s === 'string' && (TICKS.test(s) || (s.startsWith('ps:') && normStart(s.slice(3)) === s.slice(3)));
const tagOf = (s) => s.slice(0, s.indexOf(':'));
// Ordering of two starts: -1 | 0 | 1, or null when they come from different sources (not comparable).
export function startCmp(a, b) {
  if (!validStart(a) || !validStart(b) || tagOf(a) !== tagOf(b)) return null;
  const [x, y] = tagOf(a) === 'proc' ? [BigInt(a.slice(5)), BigInt(b.slice(5))] : [startSecs(a.slice(3)), startSecs(b.slice(3))];
  return x < y ? -1 : x > y ? 1 : 0;
}

// Confirms that a process the table did not show is really gone: signal 0 fails with ESRCH only for a pid that does not exist.
const provablyGone = (pid, kill) => { try { kill(pid, 0); return false; } catch (e) { return e?.code === 'ESRCH'; } };
const cannot = (what) => new LockError('LOCK_PS', `cannot read the process table: ${what}`);

const PS_BIN = ['/bin/ps', '/usr/bin/ps'].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
const runPs = (args) => {
  if (!PS_BIN) throw cannot('ps not found in /bin or /usr/bin');
  const r = spawnSync(PS_BIN, args, { encoding: 'utf8', env: PS_ENV, timeout: 10000, maxBuffer: 16 * 1024 * 1024, shell: false });
  if (r.error) throw cannot(r.error.code || r.error.message);
  return r;
};

// ps backend. startOf: "ps:<lstart>" of `pid`; null only when ps printed nothing (stdout and stderr empty, non-zero exit) AND
// signal 0 says ESRCH; throws LOCK_PS whenever it cannot tell. run/kill are seams for tests.
export function psSystem({ run = runPs, kill = (pid, sig) => process.kill(pid, sig) } = {}) {
  return Object.freeze({
    source: 'ps',
    startOf(pid) {
      const r = run(['-o', 'lstart=', '-p', String(pid)]);
      const out = String(r.stdout ?? '').trim();
      const err = String(r.stderr ?? '').trim();
      if (r.status !== 0 && out === '' && err === '') {
        if (provablyGone(pid, kill)) return null;
        throw cannot(`ps did not list pid ${pid}, but it may still exist`);
      }
      const s = r.status === 0 && err === '' ? normStart(out) : null;
      if (!s) throw cannot(`unreadable start time of pid ${pid}`);
      return `ps:${s}`;
    },
    table() {
      const r = run(['-A', '-o', 'pid=,pgid=,lstart=']);
      if (r.status !== 0) throw cannot('ps -A failed');
      const rows = [];
      for (const line of String(r.stdout).split('\n')) {
        if (!line.trim()) continue;
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        const start = m && normStart(m[3]);
        if (!start) throw cannot('unparsable process list');
        rows.push({ pid: Number(m[1]), pgid: Number(m[2]), start: `ps:${start}` });
      }
      return rows;
    },
    kill(pid, signal) { kill(pid, signal); },
  });
}

// /proc/<pid>/stat: "pid (comm) state ppid pgrp ... starttime(22) ...". comm may hold spaces and parentheses, so the fields are
// split after the LAST ')'. -> { pgid, start: "proc:<ticks>" } or null when the text is not a stat line.
export function parseProcStat(text) {
  const s = String(text ?? '');
  const i = s.lastIndexOf(')');
  if (i < 0 || !/^\d+ \(/.test(s)) return null;
  const f = s.slice(i + 1).trim().split(/\s+/); // f[0] is field 3 (state), so field N is f[N - 3]
  const pgid = f[2]; const ticks = f[19];
  if (!/^\d{1,10}$/.test(pgid ?? '') || !/^(0|[1-9]\d{0,19})$/.test(ticks ?? '')) return null;
  return { pgid: Number(pgid), start: `proc:${ticks}` };
}

// /proc backend (Linux). read/list/kill are seams for tests.
export function procSystem({ read = (p) => fs.readFileSync(p, 'utf8'), list = () => fs.readdirSync('/proc'), kill = (pid, sig) => process.kill(pid, sig) } = {}) {
  const stat = (pid) => { // parsed stat, null when the file is absent (ENOENT/ESRCH), throws when unreadable
    let text;
    try { text = read(`/proc/${pid}/stat`); } catch (e) { if (e?.code === 'ENOENT' || e?.code === 'ESRCH') return null; throw cannot(`/proc/${pid}/stat: ${e?.code || e?.message}`); }
    const p = parseProcStat(text);
    if (!p) throw cannot(`unparsable /proc/${pid}/stat`);
    return p;
  };
  return Object.freeze({
    source: 'proc',
    startOf(pid) {
      const p = stat(pid);
      if (p) return p.start;
      if (provablyGone(pid, kill)) return null;
      throw cannot(`/proc/${pid} is missing, but the pid may still exist`);
    },
    table() {
      const rows = [];
      for (const name of list()) {
        if (!/^\d+$/.test(name)) continue;
        const p = stat(Number(name));
        if (p) rows.push({ pid: Number(name), pgid: p.pgid, start: p.start }); // gone between listing and reading: skipped
      }
      return rows;
    },
    kill(pid, signal) { kill(pid, signal); },
  });
}

// The real process table for this platform.
export const SYSTEM = process.platform === 'linux' ? procSystem() : psSystem();

const isPid = (n) => Number.isInteger(n) && n > 1 && n <= MAX_PID;
const plain = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype
  && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const validGroup = (g) => plain(g, GROUP_KEYS) && isPid(g.pgid) && (g.start === null || validStart(g.start));
const validGroups = (a) => Array.isArray(a) && a.length <= MAX_GROUPS && a.every(validGroup);
export function validLock(doc) {
  return plain(doc, DOC_KEYS) && doc.v === 1 && isPid(doc.pid) && validStart(doc.start)
    && typeof doc.token === 'string' && TOKEN.test(doc.token) && validGroups(doc.groups) && validGroups(doc.orphans);
}

const lockDir = (home) => path.join(home, 'locks');
// The longest name created in locks/ is "<key>.lock.takeover" or "<key>.lock.new-<32 hex>"; most filesystems cap a name at 255 bytes.
const MAX_KEY_BYTES = 255 - Buffer.byteLength('.lock.new-') - 32;
function checkKey(repoKey) {
  checkRepoKey(repoKey);
  if (Buffer.byteLength(repoKey) > MAX_KEY_BYTES) throw new LockError('LOCK_UNSAFE', `refusing the lock: repo key longer than ${MAX_KEY_BYTES} bytes`);
}
export const lockPath = (repoKey, { home = factoryHome() } = {}) => { checkKey(repoKey); return path.join(lockDir(path.resolve(home)), `${repoKey}.lock`); };

// FACTORY_HOME and locks/ are created 0700. Each must be a real directory (not a symlink) owned by this user; locks/ must not be
// group/world-writable either.
function realDir(dir, what, { strictMode }) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${what} ${dir} is not a directory (a symlink?)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${what} ${dir} is owned by another user`);
  if (strictMode && (st.mode & 0o022)) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${what} ${dir} is writable by other users (chmod 700 it)`);
}
function ensureDir(home) {
  const dir = lockDir(home);
  try {
    if (fs.existsSync(home) || isLinkPath(home)) realDir(home, 'FACTORY_HOME', { strictMode: false }); // before creating anything in it
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    realDir(home, 'FACTORY_HOME', { strictMode: false });
    realDir(dir, 'the locks directory', { strictMode: true });
  } catch (e) {
    if (e instanceof LockError) throw e;
    throw new LockError('LOCK_UNSAFE', `refusing the lock: ${dir} cannot be created or checked (${e.code || e.message})`);
  }
  return dir;
}
const isLinkPath = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// { state: 'absent' } | { state: 'ok', doc } | { state: 'bad' } (unreadable or invalid) | throws LOCK_UNSAFE (not a regular file).
function readLock(file) {
  let fd = null;
  try {
    let lst;
    try { lst = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return { state: 'absent' }; return { state: 'bad' }; }
    if (lst.isSymbolicLink() || !lst.isFile()) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${file} is not a regular file (a symlink?); remove it by hand`);
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch (e) {
      if (e.code === 'ENOENT') return { state: 'absent' };
      if (e.code === 'ELOOP') throw new LockError('LOCK_UNSAFE', `refusing the lock: ${file} is a symlink; remove it by hand`);
      return { state: 'bad' };
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${file} is not a regular file; remove it by hand`);
    if (st.size > MAX_BYTES) return { state: 'bad' };
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0; let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, n)) > 0) n += r;
    if (n > MAX_BYTES) return { state: 'bad' };
    let doc;
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n))); } catch { return { state: 'bad' }; }
    return validLock(doc) ? { state: 'ok', doc } : { state: 'bad' };
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

const writeNew = (file, doc) => {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(doc)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const rmQuiet = (p) => { try { fs.unlinkSync(p); } catch { /* gone */ } };
const held = (file, doc) => new LockError('LOCK_HELD', `another factory run holds ${file} (pid ${doc.pid}, started ${doc.start}); wait for it to finish`);
const unreadable = (file) => new LockError('LOCK_UNREADABLE', `the lock ${file} cannot be read or is not a valid lock; it is treated as held. Make sure no factory run is active, then remove it by hand`);

const dedupe = (groups) => { const m = new Map(); for (const g of groups) m.set(g.pgid, g); return [...m.values()].slice(-MAX_GROUPS); };

// acquire(repoKey, { home?, sys? }) -> handle. Throws LockError: LOCK_HELD | LOCK_UNREADABLE | LOCK_UNSAFE | LOCK_PS.
// Creating: the content is written to a private file first and hard-linked to the lock path (link fails if the path exists), so
// a lock file is never seen half-written. Taking over a stale lock: the taker first creates the takeover marker <lock>.takeover
// the same way (only one taker at a time), re-reads the lock and checks it is still the very lock judged stale (its token: the
// dead holder cannot change it), then renames its new lock over it. The lock path is never empty during a takeover, so a fresh
// create cannot slip in. The stale lock's groups and orphans become this lock's orphans. A marker left by a taker that died
// mid-takeover, or one that cannot be read, is fail-closed: a person removes it. The exit/signal cleanup is registered before any
// file is created, so an interrupted acquire leaves no marker or temp file of its own behind (`register` is a test seam).
//   holder liveness: 'live' (same start) | 'gone' (no such pid, or same source and a different start: recycled) |
//   'unverifiable' (the recorded start comes from another source than this system's): only 'gone' is stale.
export function holderState(holder, sys) {
  const now = sys.startOf(holder.pid); // throws when it cannot tell: fail closed (held)
  if (now === null) return 'gone';
  if (tagOf(now) !== tagOf(holder.start)) return 'unverifiable';
  return now === holder.start ? 'live' : 'gone';
}
// inspect(repoKey, { home?, sys? }) -> { state: 'absent' | 'live' | 'stale' | 'unreadable', pid }: who holds the lock, read-only (it
// never creates, takes over or removes anything). live: the recorded pid+start is alive, or cannot be verified (another start source,
// or the process table cannot be read): held, as acquire() would treat it. stale: that exact pid+start is provably gone. unreadable:
// not a valid lock (or not a regular file). For `factory status` and the interactive deliver guard.
export function inspect(repoKey, { home = factoryHome(), sys = SYSTEM } = {}) {
  checkKey(repoKey);
  const file = path.join(lockDir(path.resolve(String(home))), `${repoKey}.lock`);
  let r;
  try { r = readLock(file); } catch { return { state: 'unreadable', pid: null }; }
  if (r.state === 'absent') return { state: 'absent', pid: null };
  if (r.state !== 'ok') return { state: 'unreadable', pid: null };
  let h;
  try { h = holderState(r.doc, sys); } catch { h = 'unverifiable'; }
  return { state: h === 'gone' ? 'stale' : 'live', pid: r.doc.pid };
}

export function acquire(repoKey, { home = factoryHome(), sys = SYSTEM, register = registerCleanup } = {}) {
  checkKey(repoKey);
  const absHome = path.resolve(String(home));
  const dir = ensureDir(absHome);
  const file = path.join(dir, `${repoKey}.lock`);
  const pid = process.pid;
  const start = sys.startOf(pid);
  if (!validStart(start)) throw new LockError('LOCK_PS', 'cannot read this process\'s start time');
  const token = crypto.randomBytes(16).toString('hex');
  const newPath = `${file}.new-${token}`;
  const marker = `${file}.takeover`;
  const tmpPath = `${file}.tmp-${token}`;
  const mine = (d) => d.token === token && d.pid === pid && d.start === start;
  const ownsFile = (p) => { try { const r = readLock(p); return r.state === 'ok' && mine(r.doc); } catch { return false; } };
  let released = false;
  // Removes only what this acquire created: its temp files, the takeover marker when it is ours, the lock when it is ours.
  const release = () => {
    if (released) return false;
    released = true;
    unregister();
    rmQuiet(newPath); rmQuiet(tmpPath);
    if (ownsFile(marker)) rmQuiet(marker);
    if (!ownsFile(file)) return false; // never remove someone else's lock
    rmQuiet(file);
    return true;
  };
  const unregister = register(() => { release(); });
  const fresh = (orphans) => ({ v: 1, pid, start, token, groups: [], orphans });
  // Writes `doc` privately and hard-links it to `target`: true when created, false when `target` already exists.
  const create = (target, doc) => {
    writeNew(newPath, doc);
    try { fs.linkSync(newPath, target); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally { rmQuiet(newPath); }
  };

  try {
    for (let attempt = 0, done = false; !done; attempt++) {
      if (attempt >= 5) throw new LockError('LOCK_HELD', `the lock ${file} keeps changing; another factory run is starting`);
      if (create(file, fresh([]))) break;

      const cur = readLock(file);
      if (cur.state === 'absent') continue; // released meanwhile: try the create again
      if (cur.state === 'bad') throw unreadable(file);
      const holder = cur.doc;
      const state = holderState(holder, sys);
      if (state === 'live') throw held(file, holder);
      if (state === 'unverifiable') throw new LockError('LOCK_HELD', `the lock ${file} names pid ${holder.pid} with a start time from another source (${tagOf(holder.start)}); it cannot be verified and is treated as held. Make sure no factory run is active, then remove it by hand`);
      // Stale: the pid is gone, or it is a different process now (recycled pid). Take the takeover marker.
      if (!create(marker, fresh([]))) {
        const m = readLock(marker);
        if (m.state === 'absent') continue;
        if (m.state === 'ok' && holderState(m.doc, sys) !== 'gone') throw new LockError('LOCK_HELD', `another factory run (pid ${m.doc.pid}) is taking over the stale lock ${file}`);
        throw new LockError('LOCK_UNREADABLE', `a takeover of ${file} was interrupted: ${marker} is left behind. Make sure no factory run is active, then remove ${marker} by hand`);
      }
      try {
        const again = readLock(file);
        if (again.state !== 'ok' || again.doc.token !== holder.token) continue; // changed meanwhile: look again
        writeNew(newPath, fresh(dedupe([...holder.orphans, ...holder.groups])));
        fs.renameSync(newPath, file);
        done = true;
      } finally { rmQuiet(newPath); rmQuiet(marker); }
    }
  } catch (e) { release(); throw e; }

  const current = () => {
    const r = readLock(file);
    if (r.state !== 'ok' || !mine(r.doc)) throw new LockError('LOCK_LOST', `this run no longer holds ${file}`);
    return r.doc;
  };
  const update = (fn) => {
    const next = fn(current());
    rmQuiet(tmpPath);
    try {
      writeNew(tmpPath, next);
      current(); // still ours right before the swap
      fs.renameSync(tmpPath, file);
    } catch (e) { rmQuiet(tmpPath); throw e; }
    return next;
  };

  return {
    file,
    pid,
    start,
    owned() { try { current(); return true; } catch { return false; } },
    // Process groups left by the previous (dead) holder, as { pgid, start }: start is the leader's start time when recorded.
    orphans() { return current().orphans.map((g) => ({ ...g })); },
    recordGroup(pgid) {
      if (!isPid(pgid)) throw new TypeError('pgid must be an integer > 1');
      let s = null;
      try { s = sys.startOf(pgid); } catch { s = null; }
      update((d) => ({ ...d, groups: dedupe([...d.groups, { pgid, start: s }]) }));
    },
    forgetGroup(pgid) {
      update((d) => ({ ...d, groups: d.groups.filter((g) => g.pgid !== pgid) }));
    },
    // Signals each orphan group only when it is provably the recorded group and not this process's own: returns
    // [{ pgid, outcome }] with outcome killed | gone | reused | self | unverified | failed. `failed` and `unverified` ones stay
    // recorded (a later call retries them until they are gone); the others are not this lock's to signal.
    killOrphans({ signal = 'SIGKILL' } = {}) {
      const list = current().orphans;
      if (!list.length) return [];
      const rows = sys.table();
      const self = rows.find((r) => r.pid === pid);
      if (!self) throw new LockError('LOCK_PS', 'this process is not in the process table');
      const out = list.map((o) => ({ pgid: o.pgid, outcome: orphanOutcome(o, rows, self, sys, signal) }));
      const keep = new Set(out.filter((x) => x.outcome === 'failed' || x.outcome === 'unverified').map((x) => x.pgid));
      update((d) => ({ ...d, orphans: d.orphans.filter((g) => keep.has(g.pgid)) }));
      return out;
    },
    release,
  };
}

// pgid reuse: a pgid names a group only while some member lives; once empty, the number can be reused by an unrelated process.
// So a group is signalled only when its leader (pid == pgid) is alive with exactly the recorded start time, or, leaderless, when
// no member is older than the recorded leader start (a member of the original group cannot predate its leader). Residual risk:
// a reused, leaderless group whose members all started after the recorded leader is indistinguishable and would be signalled.
// A recorded start from another source than the table's cannot be compared: 'unverified', never signalled.
function orphanOutcome(o, rows, self, sys, signal) {
  if (o.pgid === self.pid || o.pgid === self.pgid) return 'self';
  const members = rows.filter((r) => r.pgid === o.pgid);
  if (!members.length) return 'gone';
  if (members.some((m) => m.pid === self.pid)) return 'self';
  if (o.start === null) return 'unverified';
  const leader = members.find((m) => m.pid === o.pgid);
  const order = members.map((m) => startCmp(m.start, o.start));
  if (order.some((c) => c === null)) return 'unverified';
  if (leader) { if (leader.start !== o.start) return 'reused'; } else if (order.some((c) => c < 0)) return 'reused';
  try { sys.kill(-o.pgid, signal); return 'killed'; } catch (e) { return e?.code === 'ESRCH' ? 'gone' : 'failed'; }
}
