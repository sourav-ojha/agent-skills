// Per-repo driver lock: FACTORY_HOME/locks/<owner>__<repo>.lock. Zero dependencies.
// The lock names its holder by pid AND process start time (`ps -o lstart=`, run with TZ=UTC0 and the C locale so the text is
// stable), so a recycled pid is never mistaken for the holder. A lock is stale only when that exact pid+start pair is gone;
// a live pair holds it; a lock that cannot be read or parsed is HELD (fail closed: a person removes it). It also records the
// process groups the holder starts, so a later driver can stop what a killed one left running.
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
// Seconds since the epoch of a normalised start (ps ran with TZ=UTC0), for ordering only.
export function startSecs(s) {
  const m = LSTART.exec(String(s ?? ''));
  return m ? Date.UTC(Number(m[7]), MONTHS.indexOf(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) / 1000 : null;
}

const PS_BIN = ['/bin/ps', '/usr/bin/ps'].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) ?? null;
const ps = (args) => {
  if (!PS_BIN) throw new LockError('LOCK_PS', 'cannot read the process table: ps not found in /bin or /usr/bin');
  const r = spawnSync(PS_BIN, args, { encoding: 'utf8', env: PS_ENV, timeout: 10000, maxBuffer: 16 * 1024 * 1024, shell: false });
  if (r.error) throw new LockError('LOCK_PS', `cannot read the process table: ${r.error.code || r.error.message}`);
  return r;
};

// Real process table. startOf: the normalised start of `pid`, null when no such process exists; throws when it cannot tell.
// table: every process as { pid, pgid, start }. kill: process.kill.
export const SYSTEM = Object.freeze({
  startOf(pid) {
    const r = ps(['-o', 'lstart=', '-p', String(pid)]);
    const out = String(r.stdout ?? '').trim();
    if (r.status !== 0 && out === '') return null;
    const s = r.status === 0 ? normStart(out) : null;
    if (!s) throw new LockError('LOCK_PS', `cannot read the start time of pid ${pid}`);
    return s;
  },
  table() {
    const r = ps(['-A', '-o', 'pid=,pgid=,lstart=']);
    if (r.status !== 0) throw new LockError('LOCK_PS', 'cannot list processes');
    const rows = [];
    for (const line of String(r.stdout).split('\n')) {
      if (!line.trim()) continue;
      const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      const start = m && normStart(m[3]);
      if (!start) throw new LockError('LOCK_PS', 'cannot parse the process list');
      rows.push({ pid: Number(m[1]), pgid: Number(m[2]), start });
    }
    return rows;
  },
  kill(pid, signal) { process.kill(pid, signal); },
});

const isPid = (n) => Number.isInteger(n) && n > 1 && n <= MAX_PID;
const plain = (o, keys) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype
  && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const validGroup = (g) => plain(g, GROUP_KEYS) && isPid(g.pgid) && (g.start === null || (typeof g.start === 'string' && normStart(g.start) === g.start));
const validGroups = (a) => Array.isArray(a) && a.length <= MAX_GROUPS && a.every(validGroup);
export function validLock(doc) {
  return plain(doc, DOC_KEYS) && doc.v === 1 && isPid(doc.pid) && typeof doc.start === 'string' && normStart(doc.start) === doc.start
    && typeof doc.token === 'string' && TOKEN.test(doc.token) && validGroups(doc.groups) && validGroups(doc.orphans);
}

const lockDir = (home) => path.join(home, 'locks');
export const lockPath = (repoKey, { home = factoryHome() } = {}) => { checkRepoKey(repoKey); return path.join(lockDir(home), `${repoKey}.lock`); };

// The locks directory: created 0700; must be a real directory (not a symlink), owned by this user, not group/world-writable.
function ensureDir(home) {
  const dir = lockDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${dir} is not a directory (a symlink?)`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${dir} is owned by another user`);
  if (st.mode & 0o022) throw new LockError('LOCK_UNSAFE', `refusing the lock: ${dir} is writable by other users (chmod 700 it)`);
  return dir;
}

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
// mid-takeover, or one that cannot be read, is fail-closed: a person removes it.
export function acquire(repoKey, { home = factoryHome(), sys = SYSTEM } = {}) {
  checkRepoKey(repoKey);
  const dir = ensureDir(home);
  const file = path.join(dir, `${repoKey}.lock`);
  const pid = process.pid;
  const start = sys.startOf(pid);
  if (!start) throw new LockError('LOCK_PS', 'cannot read this process\'s start time');
  const token = crypto.randomBytes(16).toString('hex');
  const newPath = `${file}.new-${token}`;
  const marker = `${file}.takeover`;
  const fresh = (orphans) => ({ v: 1, pid, start, token, groups: [], orphans });
  // Writes `doc` privately and hard-links it to `target`: true when created, false when `target` already exists.
  const create = (target, doc) => {
    writeNew(newPath, doc);
    try { fs.linkSync(newPath, target); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally { rmQuiet(newPath); }
  };

  for (let attempt = 0, done = false; !done; attempt++) {
    if (attempt >= 5) throw new LockError('LOCK_HELD', `the lock ${file} keeps changing; another factory run is starting`);
    if (create(file, fresh([]))) break;

    const cur = readLock(file);
    if (cur.state === 'absent') continue; // released meanwhile: try the create again
    if (cur.state === 'bad') throw unreadable(file);
    const holder = cur.doc;
    const now = sys.startOf(holder.pid); // throws when it cannot tell: fail closed (held)
    if (now !== null && now === holder.start) throw held(file, holder);
    // Stale: the pid is gone, or it is a different process now (recycled pid). Take the takeover marker.
    if (!create(marker, fresh([]))) {
      const m = readLock(marker);
      if (m.state === 'absent') continue;
      if (m.state === 'ok' && sys.startOf(m.doc.pid) === m.doc.start) throw new LockError('LOCK_HELD', `another factory run (pid ${m.doc.pid}) is taking over the stale lock ${file}`);
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

  const tmpPath = `${file}.tmp-${token}`;
  const mine = (d) => d.token === token && d.pid === pid && d.start === start;
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
  let released = false;
  let unregister = () => {};
  const release = () => {
    if (released) return false;
    released = true;
    unregister();
    rmQuiet(tmpPath);
    let r;
    try { r = readLock(file); } catch { return false; }
    if (r.state !== 'ok' || !mine(r.doc)) return false; // never remove someone else's lock
    rmQuiet(file);
    return true;
  };
  unregister = registerCleanup(() => { release(); });

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
    // [{ pgid, outcome }] with outcome killed | gone | reused | self | unverified | failed. Only `failed` ones stay recorded.
    killOrphans({ signal = 'SIGKILL' } = {}) {
      const list = current().orphans;
      if (!list.length) return [];
      const rows = sys.table();
      const self = rows.find((r) => r.pid === pid);
      if (!self) throw new LockError('LOCK_PS', 'this process is not in the process table');
      const out = list.map((o) => ({ pgid: o.pgid, outcome: orphanOutcome(o, rows, self, sys, signal) }));
      const keep = new Set(out.filter((x) => x.outcome === 'failed').map((x) => x.pgid));
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
function orphanOutcome(o, rows, self, sys, signal) {
  if (o.pgid === self.pid || o.pgid === self.pgid) return 'self';
  const members = rows.filter((r) => r.pgid === o.pgid);
  if (!members.length) return 'gone';
  if (members.some((m) => m.pid === self.pid)) return 'self';
  if (o.start === null) return 'unverified';
  const leader = members.find((m) => m.pid === o.pgid);
  if (leader) { if (leader.start !== o.start) return 'reused'; } else {
    const t0 = startSecs(o.start);
    if (t0 === null || members.some((m) => { const t = startSecs(m.start); return t === null || t < t0; })) return 'reused';
  }
  try { sys.kill(-o.pgid, signal); return 'killed'; } catch (e) { return e?.code === 'ESRCH' ? 'gone' : 'failed'; }
}
