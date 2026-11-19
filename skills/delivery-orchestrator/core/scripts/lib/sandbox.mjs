// Untrusted-code sandbox (macOS sandbox-exec). Builder-controlled code (tests, local checks, the app, build scripts) runs under a
// profile that denies writes outside the worktree and a per-run temp dir, denies reads of FACTORY_HOME and the user's credentials,
// and limits the network. If the sandbox cannot be applied, callers must refuse to verify: there is no unsandboxed fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runCmd, startApp, registerCleanup, allowEnv } from './proc.mjs';
import { factoryHome } from './factoryhome.mjs';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PROBE_ENV = { PATH: '/usr/bin:/bin' };

let cached = null;
// Tests that sandbox-exec really applies AND enforces a profile here (nested sandboxes fail with "sandbox_apply: Operation not permitted";
// a stub binary would apply nothing). Cached per process for the default platform and binary.
export function sandboxAvailable({ platform = process.platform, exec = SANDBOX_EXEC } = {}) {
  if (platform !== 'darwin') return { ok: false, reason: 'sandbox-exec is macOS only' };
  const useCache = exec === SANDBOX_EXEC && platform === process.platform;
  if (useCache && cached) return cached;
  const result = probe(exec);
  if (useCache) cached = result;
  return result;
}

function probe(exec) {
  if (!fs.existsSync(exec)) return { ok: false, reason: `${exec} not found` };
  const allow = spawnSync(exec, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { env: PROBE_ENV, encoding: 'utf8', timeout: 15000 });
  if (allow.status !== 0) return { ok: false, reason: `sandbox-exec cannot apply a profile here: ${(allow.stderr || allow.error?.message || `exit ${allow.status}`).trim()}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sbx-probe-'));
  try {
    const marker = path.join(dir, 'marker');
    spawnSync(exec, ['-p', '(version 1)(allow default)(deny file-write*)', '/usr/bin/touch', marker], { env: PROBE_ENV, encoding: 'utf8', timeout: 15000 });
    if (fs.existsSync(marker)) return { ok: false, reason: 'sandbox-exec ran but did not enforce a deny rule' };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return { ok: true };
}

export function requireSandbox(opts) {
  const a = sandboxAvailable(opts);
  if (!a.ok) throw new Error(`untrusted-code sandbox unavailable (${a.reason}); refusing to run builder code: there is no unsandboxed fallback`);
  return a;
}

// ---- profile -----------------------------------------------------------------------------------------------------------------
// Realpath of the longest existing prefix plus the rest, so /var/... becomes /private/var/... even for paths that do not exist yet.
export function canonical(p) {
  checkPath(p);
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function checkPath(p) {
  if (typeof p !== 'string' || !p) throw new Error('sandbox path must be a non-empty string');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) throw new Error(`sandbox path contains a control character: ${JSON.stringify(p)}`);
  if (!path.isAbsolute(p)) throw new Error(`sandbox path must be absolute: ${p}`);
}

// SBPL string literal: escape backslash and double quote; control characters were rejected by checkPath.
export const sbplString = (s) => {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error('control character in SBPL string');
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};
const subpath = (p) => `(subpath ${sbplString(p)})`;
const literal = (p) => `(literal ${sbplString(p)})`;

// Secrets and scenarios the sandboxed code must never read. FACTORY_HOME is always included; `readDeny` adds to this list.
export function defaultReadDeny(home = os.homedir(), fh = factoryHome()) {
  return [fh, ...['.ssh', '.aws', '.config/gh', '.netrc', 'Library/Keychains', '.claude', '.claude.json', '.gnupg'].map((r) => path.join(home, r))];
}

// libinfo/membership: getpwuid (os.userInfo, ~ expansion); notification_center + loggers: libSystem; trustd: TLS certificate checks for
// git/curl https; FSEvents: file watchers (read-only events).
export const MACH_ALLOW = Object.freeze([
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.system.notification_center',
  'com.apple.system.logger', 'com.apple.logd', 'com.apple.diagnosticd', 'com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.FSEvents',
]);

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

function networkRules(network) {
  if (network === 'none') return ['(deny network*)'];
  if (network === 'registries') {
    // Outbound TCP 443/80 to any host, plus the mDNSResponder socket so name resolution works (found empirically: without it every lookup is ENOTFOUND;
    // UDP 53 is not needed on macOS). Nothing listens; no other ports, no other local sockets (ssh-agent, docker.sock stay denied).
    return ['(deny network*)', '(allow network-outbound (remote tcp "*:443") (remote tcp "*:80") (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))'];
  }
  if (network && typeof network === 'object' && Object.keys(network).length === 1 && 'localhostPort' in network) {
    const port = network.localhostPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`localhostPort must be an integer 1-65535: ${port}`);
    // Connect to localhost:<port> only; bind/listen (network-inbound) on that port only. No DNS, no other port, no other host.
    return ['(deny network*)', `(allow network-outbound (remote ip "localhost:${port}"))`, `(allow network-bind network-inbound (local ip "localhost:${port}"))`];
  }
  throw new Error(`network must be 'registries', 'none' or { localhostPort }: ${JSON.stringify(network)}`);
}

// SBPL for untrusted code. Later rules win in SBPL, so the order is: allow everything, deny all writes, deny reads of secrets,
// re-allow read+write of the writable dirs, deny writes to any .git inside them, re-allow a few device files, then network.
export function sandboxProfile({ writable = [], network, readDeny = [], tmpDir, home = os.homedir(), factoryHome: fh = factoryHome() } = {}) {
  if (!Array.isArray(writable) || !Array.isArray(readDeny)) throw new Error('writable and readDeny must be arrays');
  const wr = [...writable, ...(tmpDir ? [tmpDir] : [])].map((p) => {
    checkPath(p);
    let real;
    try { real = fs.realpathSync.native(p); } catch { throw new Error(`writable path does not exist: ${p}`); }
    if (!fs.statSync(real).isDirectory()) throw new Error(`writable path is not a directory: ${p}`);
    if (real === '/') throw new Error('writable path must not be /');
    return real;
  });
  const denied = [...new Set([...defaultReadDeny(home, fh), ...readDeny].map(canonical))];
  for (const w of wr) for (const d of denied) if (within(d, w)) throw new Error(`writable path ${w} contains protected path ${d}`);
  const ancestors = new Set();
  for (const w of wr) for (let a = path.dirname(w); a !== path.dirname(a); a = path.dirname(a)) ancestors.add(a);
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(deny file-read* ${denied.map(subpath).join(' ')})`,
  ];
  // Node's realpath lstats every ancestor of the cwd/script; stat only (no listing, no content) of the ancestors keeps that working.
  if (ancestors.size) lines.push(`(allow file-read-metadata ${[...ancestors].sort().map(literal).join(' ')})`);
  if (wr.length) {
    lines.push(`(allow file-read* file-write* ${wr.map(subpath).join(' ')})`);
    // A full clone's .git (config, hooks, attributes) stays read-only: driver git must not pick up planted config or hooks.
    lines.push(`(deny file-write* ${wr.map((w) => subpath(path.join(w, '.git'))).join(' ')})`);
  }
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))');
  // Mach services run OUTSIDE the sandbox and act for the caller: found empirically that LaunchServices (`open -n X.app`) starts an
  // unsandboxed app, cfprefsd (`defaults write`) writes ~/Library/Preferences, securityd (`security dump-keychain`) reads the keychain,
  // and the pasteboard leaks. So mach-lookup is deny-by-default with a short allowlist that node, npm, git, curl and python need.
  lines.push('(deny mach-lookup)', `(allow mach-lookup ${MACH_ALLOW.map((n) => `(global-name ${sbplString(n)})`).join(' ')})`);
  lines.push(...networkRules(network));
  return `${lines.join('\n')}\n`;
}

// ---- per-run temp dir ----------------------------------------------------------------------------------------------------------
const runTemps = new Map();
// FACTORY_HOME/tmp/<random>, mode 0700, returned as a realpath. Removed on process exit unless removeRunTemp is called first.
export function makeRunTemp(fh = factoryHome()) {
  const base = path.join(canonical(fh), 'tmp');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(base).isSymbolicLink()) throw new Error(`refusing: ${base} is a symlink`);
  const dir = path.join(fs.realpathSync.native(base), crypto.randomBytes(12).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  runTemps.set(dir, registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true })));
  return dir;
}

export function removeRunTemp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  const un = runTemps.get(dir);
  if (un) { un(); runTemps.delete(dir); }
}

// ---- runners (wrap Phase 0 runCmd/startApp; stop semantics stay stopApp's) ------------------------------------------------------
// `sandbox` ({ platform, exec }) is passed to requireSandbox; it exists so tests can prove the refusal path.
function sandboxArgv(argv, profile, sandbox) {
  requireSandbox(sandbox);
  if (typeof profile !== 'string' || !profile.startsWith('(version 1)')) throw new Error('a sandbox profile from sandboxProfile() is required');
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) throw new Error('argv must be a non-empty string array');
  return [SANDBOX_EXEC, '-p', profile, ...argv];
}
const withTmp = (env, tmpDir) => (tmpDir ? { ...(env ?? allowEnv(null)), TMPDIR: tmpDir } : env);

export async function runSandboxed(argv, { cwd, env, timeoutS, profile, tmpDir, sandbox } = {}) {
  return runCmd(sandboxArgv(argv, profile, sandbox), { cwd, env: withTmp(env, tmpDir), timeoutS });
}

export function startSandboxed(argv, { cwd, env, profile, tmpDir, sandbox } = {}) {
  return startApp(sandboxArgv(argv, profile, sandbox), { cwd, env: withTmp(env, tmpDir) });
}
