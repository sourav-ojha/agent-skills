// CLI scenario checks: run one `kind: "cli"` scenario in a fresh case folder and evaluate its assertions. Zero dependencies.
// Trust: the scenario is LLM-authored, the command is built from untrusted feature-branch code, and everything it prints or leaves in
// the case folder is hostile. So:
// - this module never spawns: the verifier supplies `ctx.run` (sandboxed, captured), and argv is always ctx.command + scenario args;
// - setup files are written only inside the case folder: each path is normalised (path.posix.normalize) and refused if it escapes or
//   is absolute; two paths that collide after normalisation or case-folding (macOS is case-insensitive), or a file that is also another's
//   directory, are refused before anything is written; parents are created one by one with every component lstat'ed (a symlink or
//   non-directory is refused) and the file is opened O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600, so nothing is written through a symlink;
// - a file assertion lstats every component; a symlink is resolved with realpath and must stay inside the real case folder (else the
//   assertion fails without reading it); only a regular file with one link (a hard link could alias a file outside) is opened, with
//   O_NOFOLLOW|O_NONBLOCK, checked again by fstat (same dev/ino), and read into a bounded buffer: over MAX_FILE_BYTES fails, invalid
//   UTF-8 fails, and a directory, FIFO, socket or device fails without ever being opened;
// - `failed` is a fixed family word only (exit, stdout, stderr, file, setup, run): never a path, output, pattern or argument, because
//   it can reach builder-visible output.
// Text and json_path checks are apicheck's textCheck: same limits, same strict json_path resolve, same 500 ms regex worker (a regex
// timeout makes the scenario `blocked`).
import fs from 'node:fs';
import path from 'node:path';
import { CLI_LIMITS, validCliAssertion, validCliInvocation, validRelPath } from './scenarios.mjs';
import { prepareTextCheck, textCheck } from './apicheck.mjs';

export const MAX_FILE_BYTES = 1024 * 1024;
const REGEX_TIMEOUT_MS = 500;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
const familyOf = (a) => ('exit' in a ? 'exit' : 'stdout' in a ? 'stdout' : 'stderr' in a ? 'stderr' : 'file');

// The normalised relative path, or null when it is not acceptable (escapes, absolute, the folder itself, bad characters).
function normRel(p) {
  if (!validRelPath(p)) return null;
  const n = path.posix.normalize(p);
  if (n === '.' || n === '..' || n.startsWith('../') || path.posix.isAbsolute(n) || !validRelPath(n)) return null;
  return n;
}
const foldKey = (n) => n.normalize('NFC').toLowerCase();


// Assertion shapes are validated before anything runs: an unrecognised one is a programming error (the lint refuses it first).
function prepareAssertions(list) {
  if (!Array.isArray(list) || list.length === 0 || list.length > CLI_LIMITS.maxAssertions) throw new Error('invalid assertion list');
  list.forEach((a, i) => {
    if (!validCliAssertion(a)) throw new Error(`invalid assertion #${i + 1}`);
    if ('stdout' in a || 'stderr' in a) prepareTextCheck(a.stdout ?? a.stderr);
    else if ('file' in a && !('exists' in a)) { const { file: _f, ...check } = a; prepareTextCheck(check); }
  });
  if (!list.some((a) => 'exit' in a)) throw new Error('a cli scenario needs an exit assertion');
  return list;
}

function checkCtx(ctx) {
  if (!isObj(ctx)) throw new Error('ctx is required');
  const { command, timeoutS, caseDir, run } = ctx;
  if (!Array.isArray(command) || command.length === 0 || command.some((x) => typeof x !== 'string' || x === '' || x.includes('\0'))) throw new Error('ctx.command must be a non-empty string array');
  if (typeof timeoutS !== 'number' || !(timeoutS > 0)) throw new Error('ctx.timeoutS must be a positive number');
  if (typeof run !== 'function') throw new Error('ctx.run must be a function');
  if (typeof caseDir !== 'string' || !path.isAbsolute(caseDir)) throw new Error('ctx.caseDir must be an absolute path');
  const real = fs.realpathSync.native(caseDir);
  if (!fs.lstatSync(real).isDirectory()) throw new Error('ctx.caseDir must be a directory');
  return real;
}

// ---- setup files -------------------------------------------------------------------------------------------------------------
// Returns the normalised entries, or null when the list is refused (shape, limits, escapes, collisions).
function planSetupFiles(files) {
  if (files === undefined) return [];
  if (!Array.isArray(files) || files.length > CLI_LIMITS.maxSetupFiles) return null;
  const out = [];
  for (const f of files) {
    if (!isObj(f) || !Object.keys(f).every((k) => k === 'path' || k === 'text') || typeof f.text !== 'string' || Buffer.byteLength(f.text) > CLI_LIMITS.maxFileTextBytes) return null;
    const rel = normRel(f.path);
    if (!rel) return null;
    out.push({ rel, key: foldKey(rel), text: f.text });
  }
  const keys = out.map((e) => e.key);
  if (new Set(keys).size !== keys.length) return null;
  if (keys.some((k) => keys.some((q) => q.startsWith(`${k}/`)))) return null;
  return out;
}

// Create each parent directory one component at a time (never through a symlink), then the file with O_EXCL|O_NOFOLLOW. Throws on any problem.
// Exported as a named test seam only.
export function writeSetupFile(realCase, rel, text) {
  const segs = rel.split('/');
  let cur = realCase;
  for (const seg of segs.slice(0, -1)) {
    const next = path.join(cur, seg);
    let st;
    try { st = fs.lstatSync(next); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(next, { mode: 0o700 });
      st = fs.lstatSync(next);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('setup parent is not a plain directory');
    cur = next;
  }
  if (!within(fs.realpathSync.native(cur), realCase)) throw new Error('setup parent left the case folder');
  const fd = fs.openSync(path.join(cur, segs.at(-1)), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
  } finally { fs.closeSync(fd); }
}

// ---- file assertions ---------------------------------------------------------------------------------------------------------
// { state: 'missing' } | { state: 'bad' } | { state: 'file', real, st }. 'bad' always fails the assertion, whatever its op.
// Exported as a named test seam only; runCliScenario is the interface.
export function resolveInCase(realCase, p) {
  const rel = normRel(p);
  if (!rel) return { state: 'bad' };
  const segs = rel.split('/');
  let cur = realCase; let st;
  for (let i = 0; i < segs.length; i++) {
    let next = path.join(cur, segs[i]);
    try { st = fs.lstatSync(next); } catch (e) { return { state: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'bad' }; }
    if (st.isSymbolicLink()) {
      // Resolving a link only stats its target; it is never opened unless the real path is inside the case folder.
      try { next = fs.realpathSync.native(next); } catch { return { state: 'bad' }; }
      if (!within(next, realCase)) return { state: 'bad' };
      try { st = fs.lstatSync(next); } catch { return { state: 'bad' }; }
    }
    if (i < segs.length - 1 && !st.isDirectory()) return { state: 'missing' };
    cur = next;
  }
  if (!st.isFile() || st.nlink !== 1) return { state: 'bad' };
  return { state: 'file', real: cur, st };
}

// UTF-8 text of a resolved regular file, or null (too large, swapped, unreadable, invalid UTF-8).
function readBounded({ real, st }) {
  let fd;
  try { fd = fs.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch { return null; }
  try {
    const f = fs.fstatSync(fd);
    if (!f.isFile() || f.dev !== st.dev || f.ino !== st.ino || f.nlink !== 1 || f.size > MAX_FILE_BYTES) return null;
    const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
    let n = 0;
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
      if (n > MAX_FILE_BYTES) return null;
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, n));
  } catch { return null; } finally { fs.closeSync(fd); }
}

// ---- runner --------------------------------------------------------------------------------------------------------------------
// A capture that may be judged: it finished on its own (or from a signal), inside its time and size limits.
const settled = (r) => isObj(r) && r.timedOut !== true && r.overflow !== true && (Number.isInteger(r.code) || (r.code === null && typeof r.signal === 'string' && r.signal !== ''));

export async function runCliScenario(scenario, ctx) {
  if (!isObj(scenario) || scenario.kind !== 'cli') throw new Error('not a cli scenario');
  const asserts = prepareAssertions(scenario.assert);
  const realCase = checkCtx(ctx);
  const blocked = (failed) => ({ status: 'blocked', failed });
  // Each run gets a fresh, empty case folder: anything already there (an earlier run, a planted link) could alter the result.
  if (fs.readdirSync(realCase).length !== 0) return blocked('setup');
  const invoke = async (r) => {
    try { return await ctx.run([...ctx.command, ...r.args], { stdin: r.stdin ?? '', timeoutS: ctx.timeoutS }); } catch { return null; }
  };

  // 1. setup: files, then runs in order. Any problem is `blocked` (the scenario could not be set up), never a fail.
  const setup = scenario.setup;
  if (setup !== undefined && (!isObj(setup) || !Object.keys(setup).every((k) => k === 'files' || k === 'runs'))) return blocked('setup');
  const files = planSetupFiles(setup?.files);
  if (!files) return blocked('setup');
  const runs = setup?.runs ?? [];
  if (!Array.isArray(runs) || runs.length > CLI_LIMITS.maxSetupRuns || !runs.every(validCliInvocation)) return blocked('setup');
  if (!validCliInvocation(scenario.run)) return blocked('run');
  for (const f of files) {
    try { writeSetupFile(realCase, f.rel, f.text); } catch { return blocked('setup'); }
  }
  for (const r of runs) {
    const res = await invoke(r);
    if (!settled(res) || res.code !== 0) return blocked('setup');
  }

  // 2. the command.
  const res = await invoke(scenario.run);
  if (!settled(res)) return blocked('run');

  // 3. assertions, in order: the first failing one decides.
  for (const a of asserts) {
    const family = familyOf(a);
    let ok;
    try {
      if (family === 'exit') ok = Number.isInteger(res.code) && res.code === a.exit;
      else if (family !== 'file') ok = await textCheck(res[family], a[family], { regexTimeoutMs: REGEX_TIMEOUT_MS });
      else {
        const { file, ...check } = a;
        const found = resolveInCase(realCase, file);
        if ('exists' in check) ok = found.state === (check.exists ? 'file' : 'missing');
        else if (found.state !== 'file') ok = false;
        else {
          const text = readBounded(found);
          ok = text !== null && await textCheck(text, check, { regexTimeoutMs: REGEX_TIMEOUT_MS });
        }
      }
    } catch { return blocked(family); }
    if (ok !== true) return { status: 'fail', failed: family };
  }
  return { status: 'pass' };
}
