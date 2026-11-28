// Untrusted-code sandbox (macOS sandbox-exec). Builder-controlled code (tests, local checks, the app, build scripts) runs under a
// profile that denies writes outside the worktree and a per-run temp dir, denies reads of every home dir, /Users, the user's temp dirs
// and FACTORY_HOME (allowing back only the worktree, the run temp, node and toolchains, then re-denying credential stores), cannot signal
// or inspect processes outside itself, and has a limited network. If the sandbox cannot be applied, callers must refuse to verify:
// there is no unsandboxed fallback.
// Downstream (Task 11): the DRIVER reads worktree files such as `.delivery/pr-<ID>.md` OUTSIDE the sandbox; those reads must refuse
// symlinks (lstat / O_NOFOLLOW), or builder code can point them at the driver's own secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runCmd, runCapture, startApp, registerCleanup, allowEnv } from './proc.mjs';
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
  if (String(s).length > SBPL_MAX) throw new Error(`SBPL string longer than ${SBPL_MAX} characters`);
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};
const SBPL_MAX = 1000; // sandbox-exec fails to parse string literals of ~1024+ characters
const subpath = (p) => `(subpath ${sbplString(p)})`;
const literal = (p) => `(literal ${sbplString(p)})`;

// ---- read policy -----------------------------------------------------------------------------------------------------------------
// Reads are INVERTED for the places a user keeps secrets: every home dir, /Users, the user's temp dirs and FACTORY_HOME are denied
// wholesale; the worktree, the run temp dir, node's own install and the toolchain dirs are allowed back; then credential stores are
// denied again LAST so no allow can re-expose them.

// Relative to each home. Denied after every allow.
export const CREDENTIAL_PATHS = Object.freeze([
  '.ssh', '.aws', '.config/gh', '.netrc', '.git-credentials', '.npmrc', '.yarnrc', '.yarnrc.yml', '.docker', '.kube', '.config/gcloud',
  '.config/git', '.gitconfig', '.azure', '.pypirc', '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials', '.gnupg',
  'Library/Keychains', 'Library/Application Support', 'Library/Cookies', 'Library/Mail', 'Library/Messages', '.claude', '.claude.json',
  '.local/share/pnpm/rc',
  '.codex', '.mcp-auth', '.fly', '.zsh_history', '.bash_history', '.zsh_sessions', '.zshenv', '.viminfo',
]);
// Relative to each home: toolchains that node/npm/python/rust builds may need to READ. Missing ones are skipped. Override with `readAllow`.
export const TOOLCHAIN_PATHS = Object.freeze([
  '.nvm', '.volta', '.fnm', '.asdf', '.pyenv', '.rustup', '.bun', '.cargo/bin', '.cargo/registry', '.local/share/pnpm',
]);
// `.local/bin` is NOT a default: it is a general scripts dir (a token in a script would be readable). Add it via readAllow if needed.
// Toolchain layouts a node prefix under a home may live in (then the whole prefix is allowed, minus credential names).
const NODE_TOOLCHAIN_DIRS = ['.nvm', '.volta', '.fnm', '.asdf', '.pyenv', '.bun', '.cargo', '.rustup'];

// EXACT credential basenames denied (as regular files only) anywhere under an allowed read dir: toolchains, the node prefix, npm,
// corepack. No prefix patterns: `token*` once hid npm's tokenize.js, syn's token.rs and Python's token.py, and SBPL misparses a class with
// a trailing dash ([._-]). Backup copies of these exact names (.bak .orig ~ .swp .old) count too. Residual (accepted): a secret stored
// under another name inside a toolchain dir stays readable. `.envrc` is deliberately readable (direnv script, not a credential store).
export const CRED_EXACT_NAMES = Object.freeze(['.npmrc', 'npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', 'pip.conf', 'pip.ini', '.netrc', '_netrc',
  'auth.json', 'auth.ini', 'credentials', 'credentials.toml', 'credentials.json', '.git-credentials', '.env', '.env.local', '.env.production',
  '.env.development', '.env.staging', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'bunfig.toml', 'token.json', 'tokens.json']);
const CRED_SUFFIXES = ['.bak', '.orig', '~', '.swp', '.old'];
const reLit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// SBPL regex has no (?i): every letter becomes [xX]; letter RANGES inside a class are folded too ([a-z] -> [a-zA-Z]).
export const caseFold = (re) => re.replace(/\\.|\[[^\]]*\]|[a-zA-Z]/g, (m) => {
  if (m.startsWith('\\')) return m;
  if (m.startsWith('[')) return m.replace(/([a-z])-([a-z])|([A-Z])-([A-Z])/g, (r, a, b, c, d) => (a ? `${a}-${b}${a.toUpperCase()}-${b.toUpperCase()}` : `${c}-${d}${c.toLowerCase()}-${d.toLowerCase()}`));
  return `[${m.toLowerCase()}${m.toUpperCase()}]`;
});
// One short regex per name: SBPL rejects string literals over ~1024 characters ("Error reading string"), and the case-folded
// alternation of all names exceeded that under a long toolchain path.
// Key material (restored as separate short rules): any basename ending in .key/.p12/.pfx, and .pem ONLY for private-key-shaped names
// (privkey*.pem, private*.pem, *-key.pem, *_key.pem). Certificates (cacert.pem, cert.pem, fullchain.pem, ca-bundle.crt) stay readable.
const KEY_MATERIAL = [String.raw`[^/]*\.(key|p12|pfx)`, String.raw`(privkey[^/]*|private[^/]*|[^/]*-key|[^/]*_key)\.pem`];
export function credNameRegexBodies(dir) {
  const suffixes = CRED_SUFFIXES.map(reLit).join('|');
  return [...CRED_EXACT_NAMES.map((n) => `^${regexEscape(dir)}/(.*/)?${caseFold(`${reLit(n)}(${suffixes})?`)}$`),
    ...KEY_MATERIAL.map((k) => `^${regexEscape(dir)}/(.*/)?${caseFold(k)}$`)];
}
// Every regex literal is length-checked on its FINAL text (after escaping, name and suffix expansion).
const regexLit = (body) => {
  if (body.length > SBPL_MAX) throw new Error(`SBPL string longer than ${SBPL_MAX} characters`);
  return `(regex #"${body}")`;
};
const credNameRule = (dir) => credNameRegexBodies(dir).map((b) => `(require-all ${regexLit(b)} (vnode-type REGULAR-FILE))`).join(' ');

// os.userInfo().homedir AND $HOME when they differ (a planted HOME must not move the deny away from the real home).
export function homeDirs(env = process.env) {
  const homes = [os.userInfo().homedir];
  if (env.HOME && path.isAbsolute(env.HOME)) homes.push(env.HOME);
  return [...new Set(homes.map(canonical))];
}

let userDirsCache = null;
// /private/tmp/claude-<uid> and the per-user /var/folders/<xx>/<id> dir (holds T = DARWIN_USER_TEMP_DIR, C = caches, 0 = user dir).
export function userTempDirs() {
  if (userDirsCache) return userDirsCache;
  const dirs = [canonical(`/private/tmp/claude-${process.getuid()}`)];
  const g = spawnSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', env: PROBE_ENV, timeout: 5000 });
  const t = (g.status === 0 && g.stdout.trim()) || (os.tmpdir().includes('/var/folders/') ? os.tmpdir() : '');
  if (t) dirs.push(path.dirname(canonical(t))); // /private/var/folders/<xx>/<id>
  userDirsCache = dirs;
  return dirs;
}

// Secrets and scenarios the sandboxed code must never read: FACTORY_HOME plus each home's credential stores.
export function defaultReadDeny(home = os.userInfo().homedir, fh = factoryHome()) {
  const homes = Array.isArray(home) ? home : [home];
  return [fh, ...homes.flatMap((h) => CREDENTIAL_PATHS.map((r) => path.join(h, r)))];
}

// libinfo/membership: getpwuid (os.userInfo, ~ expansion); notification_center + loggers: libSystem; trustd: TLS certificate checks for
// git/curl https; FSEvents: file watchers (read-only events).
export const MACH_ALLOW = Object.freeze([
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.system.notification_center',
  'com.apple.system.logger', 'com.apple.logd', 'com.apple.diagnosticd', 'com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.FSEvents',
]);

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
const regexEscape = (s) => {
  if (s.includes('"')) throw new Error(`path cannot be used in an SBPL regex: ${s}`);
  return s.replace(/[.*+?^${}()|[\]\\/]/g, (c) => (c === '/' ? '/' : `\\${c}`));
};
const sameFile = (a, b) => { try { const x = fs.statSync(a), y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };

function networkRules(network) {
  if (network === 'none') return ['(deny network*)'];
  if (network === 'registries') {
    // Outbound TCP 443/80 to any PUBLIC host, plus the mDNSResponder socket so name resolution works (found empirically: without it every
    // lookup is ENOTFOUND; UDP 53 is not needed on macOS). Loopback is denied last. SBPL hosts can only be `*` or `localhost`, so LAN,
    // link-local and cloud-metadata addresses (192.168/16, 10/8, 169.254.169.254) on 80/443 CANNOT be expressed and stay reachable (known gap).
    return ['(deny network*)', '(allow network-outbound (remote tcp "*:443") (remote tcp "*:80") (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
      '(deny network-outbound (remote ip "localhost:*"))'];
  }
  if (network && typeof network === 'object' && Object.keys(network).length === 1 && 'localhostPort' in network) {
    const port = network.localhostPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`localhostPort must be an integer 1-65535: ${port}`);
    // Connect to localhost:<port> only; bind/listen (network-inbound) on that port only. No DNS, no other port, no other host.
    return ['(deny network*)', `(allow network-outbound (remote ip "localhost:${port}"))`, `(allow network-bind network-inbound (local ip "localhost:${port}"))`];
  }
  throw new Error(`network must be 'registries', 'none' or { localhostPort }: ${JSON.stringify(network)}`);
}

// Read access for node itself. For each node binary (process.execPath and `node` on PATH by default) with prefix P = dirname(dirname(realpath)):
//  - P outside every deny root (e.g. /opt/homebrew/Cellar/node/X, /usr/local)      -> allow P
//  - P inside a home's toolchain layout (~/.nvm, ~/.volta, ~/.fnm, ~/.asdf, ...)      -> allow P
//  - anything else (e.g. ~/opt/node, ~/bin)  -> allow only P/bin/{node,npm,npx,corepack} (literal) and P/lib/node_modules/{npm,corepack}
// Exact credential names under every allowed subpath stay denied (credNameRule).
export function nodeReadPaths({ nodePaths = defaultNodePaths(), homes = homeDirs(), denyRoots = [] } = {}) {
  const subpaths = [], literals = [];
  for (const b of nodePaths) {
    let real; try { real = fs.realpathSync.native(b); } catch { continue; }
    const prefix = path.dirname(path.dirname(real));
    const containsRoot = prefix === '/' || denyRoots.some((r) => within(r, prefix)); // e.g. ~/bin/node -> prefix ~
    const underRoot = denyRoots.some((r) => within(prefix, r));
    const inToolchain = homes.some((h) => NODE_TOOLCHAIN_DIRS.some((d) => within(prefix, path.join(h, d)) && prefix !== path.join(h, d)));
    if (!containsRoot && (!underRoot || inToolchain)) { subpaths.push(prefix); continue; }
    literals.push(...['node', 'npm', 'npx', 'corepack'].map((n) => path.join(prefix, 'bin', n)));
    if (real !== path.join(prefix, 'bin', 'node')) literals.push(real);
    // A dynamically linked node (e.g. Homebrew's @rpath/libnode.<n>.dylib) needs its own dylibs from <prefix>/lib.
    try { for (const f of fs.readdirSync(path.join(prefix, 'lib'))) if (/\.dylib$/.test(f)) literals.push(path.join(prefix, 'lib', f)); } catch { /* no lib dir */ }
    subpaths.push(...['npm', 'corepack'].map((n) => path.join(prefix, 'lib', 'node_modules', n)));
  }
  return { subpaths: [...new Set(subpaths)], literals: [...new Set(literals)] };
}
function defaultNodePaths() {
  const out = [process.execPath];
  for (const d of String(process.env.PATH || '').split(':')) if (d && path.isAbsolute(d)) { const f = path.join(d, 'node'); if (fs.existsSync(f)) { out.push(f); break; } }
  return out;
}

const READ_ROOTS_EXTRA = ['/Users'];

// SBPL for untrusted code. Later rules win, so the order is:
//   allow default; deny all writes; deny reads of homes, /Users, user temp dirs, FACTORY_HOME; stat-only on ancestors of allowed paths;
//   allow reads of node/toolchains; allow read+write of writable dirs; deny writes to .git in them; deny credential reads (LAST of the
//   file rules); /dev writes; deny signals and process-info outside this sandbox; mach allowlist; network.
// Writable dirs must be under realpath(FACTORY_HOME)/work or /tmp unless `unsafeAllowOutsideFactoryHome` (TESTS ONLY).
// `readOnly` dirs (the cli run phase's worktree) are readable and never writable: they get only a file-read* allow, so the initial
// `(deny file-write*)` still covers them. Same placement rules as writable dirs, and none may lie inside a writable dir (whose write
// allow would cover it). Read-only is enforced BY PATH (SBPL subpath rules), not by inode. Probed: from the sandbox,
// link() of a read-only file into a writable dir fails EPERM (so does creating a symlink there and renaming a file out of the worktree),
// so no second name for a read-only file can be made. The by-inode check in the placement code below only confirms the path sits under FACTORY_HOME/work or /tmp.
export function sandboxProfile({
  writable = [], readOnly = [], network, readDeny = [], readAllow, tmpDir, home, factoryHome: fhIn = factoryHome(), unsafeAllowOutsideFactoryHome = false, nodePaths,
} = {}) {
  if (!Array.isArray(writable) || !Array.isArray(readOnly) || !Array.isArray(readDeny)) throw new Error('writable, readOnly and readDeny must be arrays');
  const homes = home === undefined ? homeDirs() : (Array.isArray(home) ? home : [home]).map(canonical);
  const fh = canonical(fhIn);
  const tmp = tmpDir ? realDir(tmpDir) : null;
  const wr = [...new Set([...writable.map(realDir), ...(tmp ? [tmp] : [])])];
  const ro = [...new Set(readOnly.map(realDir))];
  // FACTORY_HOME is a deny ROOT (first deny), not a credential: re-denying it last would hide the worktree under FACTORY_HOME/work.
  const credentials = [...new Set([...defaultReadDeny(homes, fh).slice(1), ...readDeny].map(canonical))];
  const denyRoots = [...new Set([...homes, ...READ_ROOTS_EXTRA.map(canonical), ...userTempDirs(), fh])];
  const placed = (w, what) => {
    if (w === '/') throw new Error(`${what} path must not be /`);
    for (const d of [...credentials, ...homes, fh]) if (within(d, w)) throw new Error(`${what} path ${w} contains protected path ${d}`);
    if (!unsafeAllowOutsideFactoryHome) {
      const okRoots = [path.join(fh, 'work'), path.join(fh, 'tmp')];
      if (!okRoots.some((r) => within(w, r) && w !== r)) throw new Error(`${what} path ${w} must be inside ${okRoots.join(' or ')}`);
      if (!okRoots.some((r) => [w, ...ancestorsOf(w)].some((a) => a !== w && sameFile(a, r)))) throw new Error(`${what} path ${w} is not under FACTORY_HOME by inode`);
    }
  };
  for (const w of wr) placed(w, 'writable');
  for (const r of ro) {
    placed(r, 'readOnly');
    if (wr.some((w) => within(r, w))) throw new Error(`readOnly path ${r} is inside a writable path`);
  }
  const toolchains = (readAllow ?? homes.flatMap((h) => TOOLCHAIN_PATHS.map((r) => path.join(h, r))))
    .map((p) => { checkPath(p); return p; }).filter((p) => fs.existsSync(p)).map(canonical);
  for (const a of toolchains) for (const r of denyRoots) if (within(r, a)) throw new Error(`readAllow path ${a} contains denied root ${r}`);
  const node = nodeReadPaths({ nodePaths: nodePaths ?? defaultNodePaths(), homes, denyRoots });
  const readAllowAll = [...new Set([...node.subpaths, ...toolchains])];
  const ancestors = new Set();
  for (const p of [...wr, ...ro, ...readAllowAll, ...node.literals]) for (const a of ancestorsOf(p)) ancestors.add(a);
  const historyRegex = homes.map((h) => regexLit(`^${regexEscape(h)}/\\.[^/]*_history$`));
  // Credential-named files INSIDE an allowed toolchain dir (found by probe: ~/.nvm/.npmrc, a pnpm auth.json) stay denied too.
  const toolchainCreds = readAllowAll.map(credNameRule);
  const lines = [
    '(version 1)',
    `; factory-tmpdir: ${tmp ?? ''}`,
    '(allow default)',
    '(deny file-write*)',
    `(deny file-read* ${denyRoots.map(subpath).join(' ')})`,
  ];
  // Node's realpath lstats every ancestor of the cwd/script; stat only (no listing, no content) of the ancestors keeps that working.
  if (ancestors.size) lines.push(`(allow file-read-metadata ${[...ancestors].sort().map(literal).join(' ')})`);
  if (readAllowAll.length || node.literals.length) lines.push(`(allow file-read* ${[...readAllowAll.map(subpath), ...node.literals.map(literal)].join(' ')})`);
  if (ro.length) lines.push(`(allow file-read* ${ro.map(subpath).join(' ')})`); // read only: no write allow follows for these
  if (wr.length) {
    lines.push(`(allow file-read* file-write* ${wr.map(subpath).join(' ')})`);
    // No `.git` (directory, gitfile or symlink; any case) can be created or written at ANY depth of a worktree: an embedded repo's
    // config (filters, textconv) would run UNSANDBOXED when the driver later runs git there. The run temp dir is exempt (tests may
    // `git init` scratch repos in $TMPDIR): it is never a gitSafe cwd. gitSafe's worktree preflight is the second layer.
    const repoDirs = wr.filter((w) => w !== tmp);
    if (repoDirs.length) lines.push(`(deny file-write* ${repoDirs.map((w) => regexLit(`^${regexEscape(w)}/(.*/)?${caseFold(String.raw`\.git`)}(/.*)?$`)).join(' ')})`);
  }
  lines.push(`(deny file-read* ${[...credentials.map(subpath), ...historyRegex, ...toolchainCreds].join(' ')})`);
  lines.push('(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))');
  // Same-user processes outside the sandbox (the driver, the evaluator) cannot be signalled (kill -9, SIGSTOP, SIGUSR1 = node inspector)
  // or inspected (ps eww env, KERN_PROCARGS2, lsof -p). Its own children are in the same sandbox and stay reachable.
  lines.push('(deny signal)', '(allow signal (target same-sandbox))');
  lines.push('(deny process-info*)', '(allow process-info* (target self) (target same-sandbox))');
  // process-info does NOT cover sysctl: kern.procargs2 returned the argv AND environment of every same-user process (the driver's
  // tokens included). The exact name "kern.procargs2" does not match; the prefix does. kern.proc.* (kern.proc.all/pid/pgrp listings)
  // is denied too; node, npm, git and node --test still work, and a process can still read its own procargs.
  lines.push('(deny sysctl-read (sysctl-name-prefix "kern.procargs") (sysctl-name-prefix "kern.proc."))');
  // Mach services run OUTSIDE the sandbox and act for the caller: found empirically that LaunchServices (`open -n X.app`) starts an
  // unsandboxed app, cfprefsd (`defaults write`) writes ~/Library/Preferences, securityd (`security dump-keychain`) reads the keychain,
  // and the pasteboard leaks. So mach-lookup is deny-by-default with a short allowlist that node, npm, git, curl and python need.
  lines.push('(deny mach-lookup)', `(allow mach-lookup ${MACH_ALLOW.map((n) => `(global-name ${sbplString(n)})`).join(' ')})`);
  // Shared memory and semaphores are a same-user channel that bypasses every file rule: a sandboxed program could leave data in POSIX shm
  // (confirmed with python3 multiprocessing.shared_memory) for an outside process to read. Denied for all three IPC classes.
  // Residual: notification_center (darwin notifications) stays allowed through MACH_ALLOW and could still carry a few bits; see
  // references/factory-driver.md known gaps.
  lines.push('(deny ipc-posix-shm*)', '(deny ipc-posix-sem*)', '(deny ipc-sysv*)');
  lines.push(...networkRules(network));
  return `${lines.join('\n')}\n`;
}

function realDir(p) {
  checkPath(p);
  let real;
  try { real = fs.realpathSync.native(p); } catch { throw new Error(`writable path does not exist: ${p}`); }
  if (!fs.statSync(real).isDirectory()) throw new Error(`writable path is not a directory: ${p}`);
  return real;
}
function ancestorsOf(p) { const out = []; for (let a = path.dirname(p); a !== path.dirname(a); a = path.dirname(a)) out.push(a); out.push('/'); return out.filter((a) => a !== '/'); }

// The run temp dir a profile was built with (recorded in its `; factory-tmpdir:` comment), so TMPDIR is derived once.
export function profileTmpDir(profile) {
  const m = /^; factory-tmpdir: (.*)$/m.exec(String(profile));
  return m && m[1] ? m[1] : null;
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

// Keeps the dir (an escaped sandboxed process may still use it) and drops its on-exit delete, so the driver's exit cannot rm it
// out from under that process (a symlink-swap race). Someone must remove it later (Task 11's restart sweep or a person).
export function keepRunTemp(dir) {
  const un = runTemps.get(dir);
  if (un) { un(); runTemps.delete(dir); }
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
// TMPDIR (and HOME) come from the profile (one source of truth); a different explicit tmpDir is refused.
function withTmp(env, tmpDir, profile) {
  const fromProfile = profileTmpDir(profile);
  if (tmpDir && fromProfile && fs.realpathSync.native(tmpDir) !== fromProfile) throw new Error('tmpDir does not match the profile\'s run temp dir');
  const t = fromProfile ?? (tmpDir ? fs.realpathSync.native(tmpDir) : null);
  if (!t) return env;
  // HOME is a fresh dir inside the run temp: the real home is unreadable, and tools that treat an unreadable ~/.gitconfig as fatal
  // (git: "unable to access ... Operation not permitted") or write ~/.npm/_logs then just see an empty, writable home.
  const home = path.join(t, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return { ...(env ?? allowEnv(null)), TMPDIR: t, HOME: home };
}

export async function runSandboxed(argv, { cwd, env, timeoutS, profile, tmpDir, sandbox } = {}) {
  const full = sandboxArgv(argv, profile, sandbox);
  return runCmd(full, { cwd, env: withTmp(env, tmpDir, profile), timeoutS });
}

// runSandboxed with the output captured (runCapture): stdin written then closed, stdout and stderr kept separately up to maxBytes each.
export async function runSandboxedCapture(argv, { cwd, env, timeoutS, profile, tmpDir, stdin, sandbox, maxBytes } = {}) {
  const full = sandboxArgv(argv, profile, sandbox);
  return runCapture(full, { cwd, env: withTmp(env, tmpDir, profile), timeoutS, stdin, maxBytes });
}

export function startSandboxed(argv, { cwd, env, profile, tmpDir, sandbox } = {}) {
  const full = sandboxArgv(argv, profile, sandbox);
  return startApp(full, { cwd, env: withTmp(env, tmpDir, profile) });
}
