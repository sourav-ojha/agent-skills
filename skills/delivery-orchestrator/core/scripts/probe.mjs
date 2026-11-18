#!/usr/bin/env node
// Isolation probe (Phase 0 spike P0.4). Run it from inside a builder session to see which routes can
// still read a protected directory or write to a protected one.
//
//   PROBE_TOKEN=<token> node probe.mjs --target <dir> --write-target <dir> [--workdir <dir>] [--json]
//
// Setup (by the user, outside the builder): put a random token in <dir>/.probe-sentinel.
// The token comes from PROBE_TOKEN, or, if unset, from reading the sentinel (which the probe itself may not be
// allowed to do - pass PROBE_TOKEN then). A route is `leaked` when it obtained the token (for `write`: when the
// write succeeded). The probe prints route, result and a short fixed detail only: never file contents or the token.
// Exit: 0 all denied, 1 any leaked, 2 usage error or no leak but some route errored, 3 --control file rejected.
// --control <file>: an earlier unsandboxed --json run (same target, write-target, token). Without it, an all-denied
// result is printed with a warning that it proves nothing (a typo in --target also looks denied).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROUTES = ['fs.readFile', 'cat', 'cp', 'find', 'tar', 'mdfind', 'qlmanage', 'node -e', 'python -c', 'git -C', 'hardlink', 'symlink', 'write'];
export const SENTINEL = '.probe-sentinel';

const DENY_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOENT']);
const rnd = () => crypto.randomBytes(4).toString('hex');
const fsDetail = (e) => (DENY_CODES.has(e.code) ? { result: 'denied', detail: e.code } : { result: 'error', detail: String(e.code || 'fs error') });

// Run argv without a shell. Returns {missing, timedOut, status, out(Buffer)} - the output is only ever searched, never printed.
function run(cmds, args, { timeoutMs, cwd }) {
  let last = null;
  for (const cmd of [].concat(cmds)) {
    const r = spawnSync(cmd, args, { cwd, timeout: timeoutMs, encoding: 'buffer', maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error?.code === 'ENOENT') { last = { missing: true }; continue; }
    if (r.error?.code === 'ETIMEDOUT') return { timedOut: true };
    if (r.error) return { failed: String(r.error.code || 'spawn error') };
    return { status: r.status, out: r.stdout || Buffer.alloc(0) };
  }
  return last;
}

export function runProbe(o) {
  const target = path.resolve(o.target);
  const sentinel = path.join(target, SENTINEL);
  const workdir = path.resolve(o.workdir || process.cwd());
  const writeTarget = o.writeTarget ? path.resolve(o.writeTarget) : null;
  const timeoutMs = o.timeoutMs || 10000;
  const bin = o.bin || {};
  let token = o.token ?? process.env.PROBE_TOKEN;
  if (!token) { try { token = fs.readFileSync(sentinel, 'utf8').trim(); } catch { /* the probe itself may be denied */ } }
  const has = (buf) => Buffer.isBuffer(buf) && buf.includes(token);

  const viaCmd = (cmds, args, extra = {}) => {
    const r = run(cmds, args, { timeoutMs: extra.timeoutMs || timeoutMs, cwd: workdir });
    if (r.missing) return { result: 'error', detail: 'tool missing' };
    if (r.timedOut) return { result: 'error', detail: 'timeout' };
    if (r.failed) return { result: 'error', detail: r.failed };
    if (has(r.out)) return { result: 'leaked', detail: 'token obtained' };
    return { result: 'denied', detail: r.status ? `exit ${r.status}` : 'token not in output' };
  };
  const viaFile = (file) => { // read a file we created in workdir
    try { return fs.readFileSync(file).includes(token) ? { result: 'leaked', detail: 'token obtained' } : { result: 'denied', detail: 'token not in file' }; } catch (e) { return fsDetail(e); }
  };
  const scratch = () => path.join(workdir, `.probe-${rnd()}`);
  const withScratch = (fn) => { const p = scratch(); try { return fn(p); } catch (e) { return fsDetail(e); } finally { fs.rmSync(p, { recursive: true, force: true }); } };

  const impl = {
    'fs.readFile': () => { try { return has(fs.readFileSync(sentinel)) ? { result: 'leaked', detail: 'token obtained' } : { result: 'denied', detail: 'token not in file' }; } catch (e) { return fsDetail(e); } },
    cat: () => viaCmd(bin.cat || 'cat', [sentinel]),
    cp: () => withScratch((p) => {
      const r = run(bin.cp || 'cp', [sentinel, p], { timeoutMs, cwd: workdir });
      if (r.missing) return { result: 'error', detail: 'tool missing' };
      if (r.timedOut) return { result: 'error', detail: 'timeout' };
      return r.status ? { result: 'denied', detail: `exit ${r.status}` } : viaFile(p);
    }),
    find: () => viaCmd(bin.find || 'find', [target, '-maxdepth', '1', '-name', SENTINEL, '-exec', 'cat', '{}', ';']),
    tar: () => viaCmd(bin.tar || 'tar', ['-cf', '-', '-C', target, SENTINEL]),
    mdfind: () => {
      const cmd = bin.mdfind || 'mdfind';
      for (const q of [[token], ['-name', SENTINEL]]) {
        const r = run(cmd, ['-onlyin', target, ...q], { timeoutMs, cwd: workdir });
        if (r.missing) return { result: 'error', detail: 'tool missing' };
        if (r.timedOut) return { result: 'error', detail: 'timeout' };
        if (r.out?.toString().includes(SENTINEL)) return { result: 'leaked', detail: 'sentinel listed by Spotlight' };
      }
      return { result: 'denied', detail: 'not listed (unindexed paths also look like this)' };
    },
    qlmanage: () => withScratch((p) => {
      fs.mkdirSync(p);
      const r = run(bin.qlmanage || 'qlmanage', ['-t', '-s', '64', '-o', p, sentinel], { timeoutMs: Math.min(timeoutMs, 6000), cwd: workdir });
      if (r.missing) return { result: 'error', detail: 'tool missing' };
      if (r.timedOut) return { result: 'error', detail: 'timeout' };
      return fs.readdirSync(p).length ? { result: 'leaked', detail: 'thumbnail generated from file' } : { result: 'denied', detail: 'no thumbnail' };
    }),
    'node -e': () => viaCmd(bin.node || process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1]))', sentinel]),
    'python -c': () => viaCmd(bin.python || ['python3', 'python'], ['-c', 'import sys;sys.stdout.write(open(sys.argv[1]).read())', sentinel]),
    'git -C': () => viaCmd(bin.git || 'git', ['-C', target, '--no-pager', 'diff', '--no-index', '--', '/dev/null', SENTINEL]),
    hardlink: () => withScratch((p) => { fs.linkSync(sentinel, p); return viaFile(p); }),
    symlink: () => withScratch((p) => { fs.symlinkSync(sentinel, p); return viaFile(p); }),
    write: () => {
      if (!writeTarget) return { result: 'error', detail: 'no --write-target' };
      const p = path.join(writeTarget, `.probe-write-${rnd()}`);
      let r; let cleanupFailed = false;
      try { fs.writeFileSync(p, 'probe', { flag: 'wx' }); r = { result: 'leaked', detail: 'write succeeded' }; } catch (e) { r = fsDetail(e); }
      try { fs.rmSync(p, { force: true }); } catch { cleanupFailed = true; }
      return cleanupFailed ? { result: r.result, detail: `${r.detail}; cleanup failed (remove .probe-write-* by hand)` } : r;
    },
  };

  const warnings = [];
  if (!fs.existsSync(path.dirname(target))) warnings.push('parent directory of --target does not exist from the probe\'s view: denied results prove nothing');
  if (writeTarget && !fs.existsSync(path.dirname(writeTarget))) warnings.push('parent directory of --write-target does not exist from the probe\'s view');
  return {
    target, write_target: writeTarget, token_sha256: token ? crypto.createHash('sha256').update(token).digest('hex') : null, warnings,
    routes: ROUTES.map((route) => {
      if (!token && route !== 'write') return { route, result: 'error', detail: 'no token (set PROBE_TOKEN)' };
      let r; try { r = impl[route](); } catch (e) { r = { result: 'error', detail: String(e.code || 'probe error') }; }
      return { route, result: r.result, detail: r.detail };
    }),
  };
}

// A control run is an earlier unsandboxed --json run for the same target, write-target and token. Every route that
// could run must have leaked there, otherwise "denied" in this run may just mean a typo or a wrong token.
// mdfind and qlmanage are exempt: they depend on Spotlight indexing and Quick Look and are weak evidence anyway.
const WEAK = new Set(['mdfind', 'qlmanage']);
export function controlProblems(c, res) {
  if (!c || !Array.isArray(c.routes)) return ['control file is not a probe --json output'];
  const out = [];
  if (c.target !== res.target) out.push('target differs from the control run');
  if (c.write_target !== res.write_target) out.push('write-target differs from the control run');
  if (!c.token_sha256 || c.token_sha256 !== res.token_sha256) out.push('token differs from the control run');
  for (const r of c.routes) if (!WEAK.has(r.route) && r.detail !== 'tool missing' && r.result !== 'leaked') out.push(`control run did not leak via ${r.route} (${r.result})`);
  return out;
}

function main(argv) {
  const o = { json: false }; const flags = { '--target': 'target', '--write-target': 'writeTarget', '--workdir': 'workdir', '--control': 'control' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = true;
    else if (flags[argv[i]] && argv[i + 1] !== undefined) o[flags[argv[i]]] = argv[++i];
    else { process.stderr.write(`unknown or incomplete argument: ${argv[i]}\n`); return 2; }
  }
  if (!o.target || !o.writeTarget) { process.stderr.write('usage: [PROBE_TOKEN=...] probe.mjs --target <dir> --write-target <dir> [--workdir <dir>] [--control <control.json>] [--json]\n'); return 2; }
  const res = runProbe(o);
  let control = null;
  if (o.control) {
    let c; try { c = JSON.parse(fs.readFileSync(o.control, 'utf8')); } catch { c = null; }
    const problems = controlProblems(c, res);
    if (problems.length) { for (const p of problems) res.warnings.push(`control rejected: ${p}`); control = 'rejected'; } else control = 'accepted';
  } else if (!res.routes.some((r) => r.route !== 'write' && r.result === 'leaked')) {
    res.warnings.push('no read route leaked: this proves nothing without a control run (--control)');
  }
  res.control = control;
  if (o.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else for (const r of res.routes) process.stdout.write(`${r.route.padEnd(12)} ${r.result.padEnd(7)} ${r.detail}\n`);
  for (const w of res.warnings) process.stderr.write(`WARNING: ${w}\n`);
  if (control === 'rejected') return 3;
  if (res.routes.some((r) => r.result === 'leaked')) return 1;
  return res.routes.some((r) => r.result === 'error') ? 2 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
