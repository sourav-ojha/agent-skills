#!/usr/bin/env node
// Isolation probe (Phase 0 spike P0.4). Run it from inside a builder session to see which routes can
// still read a protected directory or write to a protected one.
//
//   PROBE_TOKEN=<token> node probe.mjs (--target <dir> | --target-file <file>) --write-target <dir> [--workdir <dir>] [--json]
//
// Setup (by the user, outside the builder): put a random token in <dir>/.probe-sentinel.
// The token comes from PROBE_TOKEN, or, if unset, from reading the sentinel (which the probe itself may not be
// allowed to do - pass PROBE_TOKEN then). A route is `leaked` when it obtained the token (for `write`: when the
// write succeeded). The probe prints route, result and a short fixed detail only: never file contents or the token.
// Exit: 0 all denied, 1 any leaked, 2 usage error or no leak but some route errored, 3 --control file rejected.
// --control <file>: an earlier unsandboxed --json run (same target, write-target, factory-home, net-host, token). Without it,
// an all-denied result is printed with a warning that it proves nothing (a typo in --target also looks denied).
//
// Phase 2 (P2.2) routes, each opt-in (unconfigured: `error`, detail "not configured ..."):
//   --factory-home <dir>   tries to write into stop/, runs/, usage/, verdicts/, records/ and config.json there (a file it
//                          creates and removes; config.json is only opened for writing, never changed).
//   --net-host <host:port> an outbound TCP connect through bash (/dev/tcp). Use a non-local host you are allowed to reach; a
//                          timeout, refusal or EPERM is `denied`, which proves something only when the --control run connected.
//                          Never point it at a production host. --net-timeout-ms (default 3000).
// --target-file <file>: probe one file (for example ~/.netrc) instead of <dir>/.probe-sentinel; PROBE_TOKEN must then be a
// distinctive substring of that file (it is never read from the file and never printed).
// --save: also writes $FACTORY_HOME/probes/last.json, private and atomic, that `factory run` reads:
//   { ts, builder_settings_sha256, factory_home, net_host, target, routes: { <write/home/net route>: r },
//     targets: [{ target, routes: { <read route>: r } }] }   with r one of denied|leaked|error.
// A route is saved `denied` only when an accepted control run leaked through that same route; otherwise `error` (unproven).
// Saving MERGES: each probed target is kept (one run per credential directory: ~/.ssh, ~/.aws, ~/.config/gh, ~/.netrc), and a
// run without --factory-home / --net-host keeps the earlier results of those routes. A result saved for another builder.json
// (sha256) is discarded. The builder cannot write FACTORY_HOME, so run the probe in the builder with --json > probe.json,
// inspect it, then outside it, yourself:
//   node probe.mjs --from probe.json --control control.json --save
// (--from re-reads that result instead of probing; the control is checked again.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { factoryHome, writeJsonAtomic } from './lib/factoryhome.mjs';
import { builderSettingsSha } from './lib/hardstops.mjs';

export const ROUTES = ['fs.readFile', 'cat', 'cp', 'find', 'tar', 'mdfind', 'qlmanage', 'node -e', 'python -c', 'git -C', 'hardlink', 'symlink', 'write',
  'write stop/', 'write runs/', 'write usage/', 'write verdicts/', 'write records/', 'write config.json', 'net bash'];
const HOME_SUBDIRS = { 'write stop/': 'stop', 'write runs/': 'runs', 'write usage/': 'usage', 'write verdicts/': 'verdicts', 'write records/': 'records' };
const NO_TOKEN = new Set(['write', ...Object.keys(HOME_SUBDIRS), 'write config.json', 'net bash']); // routes that do not read the sentinel
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
  // Directory mode: <target>/.probe-sentinel. File mode (targetFile): the file itself, found as <sdir>/<sname>.
  const target = path.resolve(o.targetFile || o.target);
  const sentinel = o.targetFile ? target : path.join(target, SENTINEL);
  const sdir = path.dirname(sentinel); const sname = path.basename(sentinel);
  const workdir = path.resolve(o.workdir || process.cwd());
  const writeTarget = o.writeTarget ? path.resolve(o.writeTarget) : null;
  const timeoutMs = o.timeoutMs || 10000;
  const bin = o.bin || {};
  const fhome = o.factoryHome ? path.resolve(o.factoryHome) : null;
  // netHost: { host, port } or "host:port" (the API accepts a local host for tests; the CLI refuses one).
  const netHost = typeof o.netHost === 'string' ? parseNetHost(o.netHost, { allowLocal: true }) : (o.netHost || null);
  if (o.netHost && !netHost) throw new Error('netHost must be host:port');
  let token = o.token ?? process.env.PROBE_TOKEN;
  if (!token && !o.targetFile) { try { token = fs.readFileSync(sentinel, 'utf8').trim(); } catch { /* the probe itself may be denied */ } }
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
    find: () => viaCmd(bin.find || 'find', [sdir, '-maxdepth', '1', '-name', sname, '-exec', 'cat', '{}', ';']),
    tar: () => viaCmd(bin.tar || 'tar', ['-cf', '-', '-C', sdir, sname]),
    mdfind: () => {
      const cmd = bin.mdfind || 'mdfind';
      for (const q of [[token], ['-name', sname]]) {
        const r = run(cmd, ['-onlyin', sdir, ...q], { timeoutMs, cwd: workdir });
        if (r.missing) return { result: 'error', detail: 'tool missing' };
        if (r.timedOut) return { result: 'error', detail: 'timeout' };
        if (r.out?.toString().includes(sname)) return { result: 'leaked', detail: 'sentinel listed by Spotlight' };
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
    'git -C': () => viaCmd(bin.git || 'git', ['-C', sdir, '--no-pager', 'diff', '--no-index', '--', '/dev/null', sname]),
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
    ...Object.fromEntries(Object.entries(HOME_SUBDIRS).map(([route, sub]) => [route, () => homeWrite(sub)])),
    'write config.json': () => {
      if (!fhome) return { result: 'error', detail: 'not configured (no --factory-home)' };
      const p = path.join(fhome, 'config.json');
      try { fs.closeSync(fs.openSync(p, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)); return { result: 'leaked', detail: 'opened for writing' }; } catch (e) {
        if (e.code !== 'ENOENT') return fsDetail(e);
      }
      let r; try { fs.writeFileSync(p, '', { flag: 'wx' }); r = { result: 'leaked', detail: 'created' }; } catch (e) { return fsDetail(e); }
      try { fs.rmSync(p, { force: true }); } catch { return { ...r, detail: 'created; cleanup failed (remove config.json by hand)' }; }
      return r;
    },
    'net bash': () => {
      if (!netHost) return { result: 'error', detail: 'not configured (no --net-host)' };
      const { host, port } = netHost;
      const r = run(bin.bash || 'bash', ['-c', 'exec 3<>"/dev/tcp/$1/$2"', 'probe', host, String(port)], { timeoutMs: o.netTimeoutMs || 3000, cwd: workdir });
      if (r.missing) return { result: 'error', detail: 'tool missing' };
      if (r.timedOut) return { result: 'denied', detail: 'timeout' };
      if (r.failed) return { result: 'error', detail: r.failed };
      return r.status === 0 ? { result: 'leaked', detail: 'connected' } : { result: 'denied', detail: `exit ${r.status}` };
    },
  };
  // Create a file in <factory-home>/<sub> (or the directory itself when it is missing), then remove what was created.
  function homeWrite(sub) {
    if (!fhome) return { result: 'error', detail: 'not configured (no --factory-home)' };
    const dir = path.join(fhome, sub); const p = path.join(dir, `.probe-write-${rnd()}`);
    let r; let made = null;
    try { fs.writeFileSync(p, 'probe', { flag: 'wx' }); r = { result: 'leaked', detail: 'write succeeded' }; made = p; } catch (e) {
      if (e.code !== 'ENOENT') return fsDetail(e);
      try { fs.mkdirSync(dir); r = { result: 'leaked', detail: 'directory created' }; made = dir; } catch (e2) { return fsDetail(e2); }
    }
    try { fs.rmSync(made, { recursive: made === dir, force: true }); } catch { return { ...r, detail: `${r.detail}; cleanup failed (remove ${made === dir ? sub : '.probe-write-*'} by hand)` }; }
    return r;
  }

  const warnings = [];
  if (!fs.existsSync(path.dirname(target))) warnings.push('parent directory of --target does not exist from the probe\'s view: denied results prove nothing');
  if (writeTarget && !fs.existsSync(path.dirname(writeTarget))) warnings.push('parent directory of --write-target does not exist from the probe\'s view');
  return {
    target, write_target: writeTarget, factory_home: fhome, net_host: netHost ? `${netHost.host}:${netHost.port}` : null, token_sha256: token ? crypto.createHash('sha256').update(token).digest('hex') : null, warnings,
    routes: ROUTES.map((route) => {
      if (!token && !NO_TOKEN.has(route)) return { route, result: 'error', detail: 'no token (set PROBE_TOKEN)' };
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
  const shaped = c.routes.every((r) => r && typeof r === 'object' && typeof r.route === 'string' && typeof r.result === 'string');
  if (!shaped) return ['control file has a malformed route entry'];
  const seen = new Set(c.routes.map((r) => r.route));
  if (seen.size !== c.routes.length) return ['control file lists a route more than once'];
  const missing = ROUTES.filter((r) => !seen.has(r));
  if (missing.length) out.push(`control run lacks route(s): ${missing.join(', ')}`);
  if (c.target !== res.target) out.push('target differs from the control run');
  if (c.write_target !== res.write_target) out.push('write-target differs from the control run');
  if ((c.factory_home ?? null) !== (res.factory_home ?? null)) out.push('factory-home differs from the control run');
  if ((c.net_host ?? null) !== (res.net_host ?? null)) out.push('net-host differs from the control run');
  if (!c.token_sha256 || c.token_sha256 !== res.token_sha256) out.push('token differs from the control run');
  const exempt = (r) => r.detail === 'tool missing' || (typeof r.detail === 'string' && r.detail.startsWith('not configured'));
  for (const r of c.routes) if (!WEAK.has(r.route) && !exempt(r) && r.result !== 'leaked') out.push(`control run did not leak via ${r.route} (${r.result})`);
  return out;
}

// host:port for --net-host: a plain host name, IPv4 or bracketed IPv6 address (never a shell word), not loopback.
export function parseNetHost(v, { allowLocal = false } = {}) {
  const m = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(String(v));
  if (!m) return null;
  const host = m[1].replace(/^\[|\]$/g, ''); const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  if (allowLocal) return { host, port };
  if (/^(localhost|localhost\.|.*\.localhost)$/i.test(host) || /^127\./.test(host) || /^0+(\.0+){0,3}$/.test(host) || /^(::1?|0*:0*:.*:0*1)$/.test(host) || /^::ffff:127\./i.test(host)) return null;
  return { host, port };
}

// A route is saved `denied` only when the accepted control run leaked through that same route (for net bash: it connected).
// A control route that was not configured, missing a tool or errored proves nothing: the route is saved as `error`.
export function savedValue(r, ctl) {
  if (r.result !== 'denied') return r.result;
  const c = ctl && Array.isArray(ctl.routes) ? ctl.routes.find((x) => x && x.route === r.route) : null;
  return c && c.result === 'leaked' ? 'denied' : 'error';
}

const isSaved = (p) => p && typeof p === 'object' && p.routes && typeof p.routes === 'object' && !Array.isArray(p.routes) && Array.isArray(p.targets);
const HOME_ROUTES = new Set([...Object.keys(HOME_SUBDIRS), 'write config.json']);

// Merge this run into the earlier saved result. ctl: the accepted control document, or null.
export function mergeSaved(prev, res, ctl, { now = new Date(), builderSha } = {}) {
  const base = isSaved(prev) && prev.builder_settings_sha256 === builderSha ? prev : { routes: {}, targets: [], factory_home: null, net_host: null };
  const routes = { ...base.routes }; const read = {};
  let factoryHome = base.factory_home ?? null; let netHost = base.net_host ?? null;
  if (res.factory_home) { factoryHome = res.factory_home; for (const k of HOME_ROUTES) delete routes[k]; }
  if (res.net_host) { netHost = res.net_host; delete routes['net bash']; }
  for (const r of res.routes) {
    const v = savedValue(r, ctl);
    if (!NO_TOKEN.has(r.route)) read[r.route] = v;
    else if (HOME_ROUTES.has(r.route)) { if (res.factory_home) routes[r.route] = v; }
    else if (r.route === 'net bash') { if (res.net_host) routes[r.route] = v; }
    else routes[r.route] = v;
  }
  const targets = base.targets.filter((t) => t && t.target !== res.target).concat([{ target: res.target, routes: read }]);
  return { ts: now.toISOString(), builder_settings_sha256: builderSha, factory_home: factoryHome, net_host: netHost, target: res.target, routes, targets };
}

// build(prev) returns the document to write; prev is the current saved result (null when absent or corrupt).
export function saveResult(home, build) {
  const dir = path.join(home, 'probes');
  const st = (p) => { try { return fs.lstatSync(p); } catch { return null; } };
  if (!st(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const d = st(dir);
  if (!d || d.isSymbolicLink() || !d.isDirectory() || (process.getuid && d.uid !== process.getuid())) throw new Error(`refusing to save: ${dir} is a symlink, not a directory, or owned by another user`);
  if ((d.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'last.json');
  if (st(file) && !st(file).isFile()) throw new Error(`refusing to save: ${file} is a symlink or not a regular file`);
  let prev = null;
  if (st(file)) { try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { prev = null; } }
  writeJsonAtomic(file, build(prev));
  return file;
}

// A --json result: every route exactly once, well-formed, with the probed paths as strings (or null where optional).
const strOrNull = (v) => v === null || v === undefined || typeof v === 'string';
const isResult = (j) => j && typeof j === 'object' && typeof j.target === 'string' && strOrNull(j.write_target) && strOrNull(j.factory_home) && strOrNull(j.net_host) && strOrNull(j.token_sha256)
  && Array.isArray(j.routes) && j.routes.length === ROUTES.length && new Set(j.routes.map((r) => r?.route)).size === ROUTES.length
  && j.routes.every((r) => r && typeof r === 'object' && ROUTES.includes(r.route) && ['denied', 'leaked', 'error'].includes(r.result) && typeof r.detail === 'string');

function main(argv) {
  const o = { json: false, save: false };
  const flags = { '--target': 'target', '--target-file': 'targetFile', '--write-target': 'writeTarget', '--workdir': 'workdir', '--control': 'control', '--factory-home': 'factoryHome', '--net-host': 'netHost', '--net-timeout-ms': 'netTimeoutMs', '--from': 'from' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--save') o.save = true;
    else if (flags[argv[i]] && argv[i + 1] !== undefined) o[flags[argv[i]]] = argv[++i];
    else { process.stderr.write(`unknown or incomplete argument: ${argv[i]}\n`); return 2; }
  }
  if (o.netHost !== undefined) {
    o.netHost = parseNetHost(o.netHost);
    if (!o.netHost) { process.stderr.write('--net-host must be host:port (port 1-65535) of a non-local host\n'); return 2; }
  }
  if (o.netTimeoutMs !== undefined) {
    o.netTimeoutMs = Number(o.netTimeoutMs);
    if (!Number.isInteger(o.netTimeoutMs) || o.netTimeoutMs < 100 || o.netTimeoutMs > 60000) { process.stderr.write('--net-timeout-ms must be an integer 100-60000\n'); return 2; }
  }
  let res;
  if (o.from) {
    let j; try { j = JSON.parse(fs.readFileSync(o.from, 'utf8')); } catch { j = null; }
    if (!isResult(j)) { process.stderr.write('--from: not a probe --json result\n'); return 2; }
    res = { ...j, factory_home: j.factory_home ?? null, net_host: j.net_host ?? null, warnings: [] };
  } else {
    if (!(o.target || o.targetFile) || (o.target && o.targetFile) || !o.writeTarget) { process.stderr.write('usage: [PROBE_TOKEN=...] probe.mjs (--target <dir> | --target-file <file>) --write-target <dir> [--workdir <dir>] [--factory-home <dir>] [--net-host <host:port>] [--control <control.json>] [--json] [--save]\n       probe.mjs --from <probe.json> [--control <control.json>] --save\n'); return 2; }
    res = runProbe(o);
  }
  let control = null; let ctlDoc = null;
  if (o.control) {
    let c; try { c = JSON.parse(fs.readFileSync(o.control, 'utf8')); } catch { c = null; }
    const problems = controlProblems(c, res);
    if (problems.length) { for (const p of problems) res.warnings.push(`control rejected: ${p}`); control = 'rejected'; } else { control = 'accepted'; ctlDoc = c; }
  } else if (!res.routes.some((r) => !NO_TOKEN.has(r.route) && r.result === 'leaked')) {
    res.warnings.push('no read route leaked: this proves nothing without a control run (--control)');
  }
  res.control = control;
  if (o.save) {
    try { const sha = builderSettingsSha(); const f = saveResult(factoryHome(), (prev) => mergeSaved(prev, res, ctlDoc, { builderSha: sha })); process.stderr.write(`saved: ${f}${control === 'accepted' ? '' : ' (no accepted control run: denied routes saved as error)'}\n`); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  }
  if (o.json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else for (const r of res.routes) process.stdout.write(`${r.route.padEnd(18)} ${r.result.padEnd(7)} ${r.detail}\n`);
  for (const w of res.warnings) process.stderr.write(`WARNING: ${w}\n`);
  if (control === 'rejected') return 3;
  if (res.routes.some((r) => r.result === 'leaked')) return 1;
  return res.routes.some((r) => r.result === 'error') ? 2 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
