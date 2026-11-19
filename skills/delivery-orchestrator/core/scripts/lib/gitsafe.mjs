// Hardened git for the driver: fixed argv (never a shell), GIT_* environment scrubbed, a timeout, and a CONFIG ALLOWLIST: before any
// command, the repository's own config (local, worktree and include files; system and global are off) is listed read-only and every key
// must be on ALLOWED_CONFIG, so a builder-written .git/config cannot define filters, textconv/merge drivers, editors, gpg programs,
// credential helpers, upload/receive-pack commands, includes or URL rewrites. The neutralising -c flags stay as a second layer.
// Supported: read-only commands, plus fetch/checkout/worktree/merge --ff-only against a config the driver itself wrote.
// Returns the RAW result: stdout is not trimmed and the real exit code is kept (checkDiff needs exact full-context diffs). A signal,
// timeout or buffer overflow THROWS (without output): a partial `out` is never returned.
import { spawnSync } from 'node:child_process';

// Every key below is accepted by git 2.52. Command-line -c beats repo-local config.
export const GIT_SAFE_FLAGS = Object.freeze([
  '-c', 'core.hooksPath=/dev/null', // planted .git/hooks never run
  '-c', 'core.fsmonitor=false', // a repo-configured fsmonitor command never runs
  '-c', 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes', // no ssh wrapper, no password/host-key prompt
  '-c', 'protocol.ext.allow=never', // ext:: remote URLs cannot run commands
  '-c', 'core.pager=cat', // no repo-configured pager
  '-c', 'core.editor=true', '-c', 'sequence.editor=true', // no editor
  '-c', 'gpg.program=false', '-c', 'commit.gpgSign=false', // no signing program
  '-c', 'credential.helper=', '-c', 'core.askPass=', // no credential helper or askpass program
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null',
  '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', // auto-gc / maintenance never runs inside a driver git call
  // `-c diff.external=` is NOT used: git 2.52 then tries to exec "" and every `git diff` dies ("cannot run :"). Config cannot be unset
  // with -c, so diff-producing commands get --no-ext-diff --no-textconv instead (DIFF_GUARD below).
]);
const DIFF_CMDS = new Set(['diff', 'log', 'show', 'blame', 'format-patch']);
const DIFF_GUARD = ['--no-ext-diff', '--no-textconv'];
const MAX_BUFFER = 128 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120 * 1000;

// Exact keys (lower-case) allowed in a repository's config; anything else throws. The list is what this git (2.52) writes for a
// driver-created repo: `git init`, `git clone`, `git clone --bare`, `git worktree add` (with extensions.worktreeConfig), a sha256
// repo; plus user identity, init.defaultBranch, fetch.prune and gc.auto. core.worktree / core.sparseCheckout* are NOT allowed: a value
// could redirect where checkout writes. Partial clones (remote.*.promisor) are not supported.
const ALLOWED_EXACT = new Set([
  'core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode',
  'core.symlinks', 'extensions.worktreeconfig', 'extensions.objectformat', 'user.name', 'user.email', 'init.defaultbranch', 'fetch.prune', 'gc.auto',
]);
const ALLOWED_PATTERNS = [/^remote\.[^\n]+\.(url|pushurl|fetch)$/, /^branch\.[^\n]+\.(remote|merge)$/];
// A variable name that names a hook or a program is never allowed, whatever the section.
const DANGEROUS_NAME = /^hooks?$|cmd|command|program|helper|driver|process|smudge|clean|textconv|external/;
// https://host/... or scp-style user@host:path / ssh://user@host/...; never ext::, file://, local paths or an option-looking value.
const HOST = '[A-Za-z0-9][A-Za-z0-9.-]*', USER = '[A-Za-z0-9][A-Za-z0-9._-]*';
const SAFE_URL = new RegExp(`^(?:https://${HOST}(?::\\d+)?/\\S*|ssh://(?:${USER}@)?${HOST}(?::\\d+)?/\\S*|${USER}@${HOST}:[^\\s/-]\\S*)$`);
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Host of an https://, ssh:// or scp-style URL (already shape-checked by SAFE_URL).
const urlHost = (u) => (/^(?:https|ssh):\/\/(?:[^@/]+@)?([^/:]+)/.exec(u) ?? /^[^@]+@([^:]+):/.exec(u) ?? [])[1] ?? '';
// Driver-side SSRF guard: no loopback/localhost, mDNS .local, and no numeric IP literal of any spelling (dotted, decimal, hex, octal,
// short forms like 127.1). Private ranges are numeric too, so every 10.*, 172.16-31.*, 192.168.*, 169.254.*, 0.0.0.0 is covered;
// IPv6 literals ([::1], [fe80::], [fd00::]) cannot pass SAFE_URL's host pattern. A NAME that resolves privately (DNS rebinding) is not caught.
export function publicHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return false;
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/.test(h) || h.split('.').some((l) => /^0x[0-9a-f]*$/.test(l)) || /^[0-9a-fx.]+$/.test(h) && /\d$/.test(h)) return false;
  return true;
}

// Lower-cases section and variable name; the subsection (between them) is case-sensitive in git and is kept as is.
const normKey = (k) => { const a = k.indexOf('.'), b = k.lastIndexOf('.'); return a === b ? k.toLowerCase() : `${k.slice(0, a).toLowerCase()}${k.slice(a, b)}${k.slice(b).toLowerCase()}`; };
export function configAllowed(key, value) {
  const k = normKey(key);
  const lk = k.toLowerCase();
  if (DANGEROUS_NAME.test(lk.slice(lk.lastIndexOf('.') + 1))) return false;
  if (ALLOWED_EXACT.has(lk)) return true;
  if (!ALLOWED_PATTERNS.some((re) => re.test(lk))) return false;
  if (/^remote\..+\.(url|pushurl)$/.test(lk)) return typeof value === 'string' && SAFE_URL.test(value) && publicHost(urlHost(value));
  if (/^(remote\..+\.fetch|branch\..+\.merge)$/.test(lk)) return typeof value === 'string' && !value.startsWith('-');
  if (/^branch\..+\.remote$/.test(lk)) return typeof value === 'string' && REMOTE_NAME.test(value); // a name, never a URL
  return true;
}

// Process env minus every GIT_* variable (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG*, GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND, GIT_ASKPASS, ...), then pinned values.
export function gitEnv(base = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^GIT_/i.test(k) && k !== 'SSH_ASKPASS') env[k] = String(v);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.SSH_ASKPASS_REQUIRE = 'never';
  env.GIT_NO_REPLACE_OBJECTS = '1'; // refs/replace/* cannot swap the commits or blobs the driver inspects
  return env;
}

// Splits args into git global options and the rest. Only these global options are accepted; `-c k=v` keys must pass the allowlist.
const GLOBAL_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree']);
const GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks']);
export function splitGlobal(args) {
  const global = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) break;
    if (a === '-c') {
      const kv = args[i + 1];
      if (typeof kv !== 'string') throw new Error('gitSafe: -c needs key=value');
      const eq = kv.indexOf('=');
      const key = eq < 0 ? kv : kv.slice(0, eq);
      if (!configAllowed(key, eq < 0 ? undefined : kv.slice(eq + 1))) throw new Error(`git config not allowed: ${key}`);
      global.push(a, kv); i++;
    } else if (GLOBAL_WITH_VALUE.has(a)) {
      if (typeof args[i + 1] !== 'string') throw new Error(`gitSafe: ${a} needs a value`);
      global.push(a, args[i + 1]); i++;
    } else if (/^--(git-dir|work-tree)=/.test(a) || GLOBAL_FLAGS.has(a)) {
      global.push(a);
    } else {
      throw new Error(`gitSafe: global option not allowed: ${a.split('=')[0]}`);
    }
  }
  return { global, rest: args.slice(i) };
}

function spawnGit(cwd, argv, timeout) {
  const r = spawnSync('git', argv, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: MAX_BUFFER, shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL' });
  const what = argv.slice(GIT_SAFE_FLAGS.length).find((a) => !a.startsWith('-')) ?? 'git';
  if (r.error) throw new Error(`git ${what} failed: ${r.error.code === 'ETIMEDOUT' ? `timed out after ${timeout} ms` : r.error.code === 'ENOBUFS' ? 'output exceeded 128 MB' : r.error.code || r.error.message}`);
  if (r.signal || r.status === null) throw new Error(`git ${what} was killed by ${r.signal ?? 'a signal'}`);
  return r;
}

// Lists the repository config with origins (no command executes) and throws `git config not allowed: <key>` on the first key not allowed.
export function verifyGitConfig(cwd, { global = [], timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const loc = []; // only the options that select the repository; caller -c pairs were checked by splitGlobal
  for (let i = 0; i < global.length; i++) {
    if (global[i] === '-c') { i++; continue; }
    loc.push(global[i]);
    if (GLOBAL_WITH_VALUE.has(global[i])) loc.push(global[++i]);
  }
  const r = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...loc, 'config', '--list', '--show-origin', '-z'], timeout);
  if (r.status !== 0) throw new Error(`git config could not be verified (exit ${r.status})`);
  const parts = r.stdout.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i], entry = parts[i + 1];
    if (origin.startsWith('command line:')) continue; // GIT_SAFE_FLAGS
    const nl = entry.indexOf('\n');
    const key = nl < 0 ? entry : entry.slice(0, nl);
    if (!configAllowed(key, nl < 0 ? undefined : entry.slice(nl + 1))) throw new Error(`git config not allowed: ${key}`);
  }
}

// gitSafeOpts(cwd, args, { timeout, verified }): `verified: true` skips the config listing; pass it only within one call chain right
// after a verified call on the same cwd.
export function gitSafeOpts(cwd, args, { timeout = DEFAULT_TIMEOUT_MS, verified = false } = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('gitSafe: cwd is required');
  if (!Array.isArray(args)) throw new Error('gitSafe: args must be an array');
  for (const a of args) if (typeof a !== 'string') throw new Error('gitSafe: every argument must be a string');
  const { global, rest } = splitGlobal(args);
  if (!verified) verifyGitConfig(cwd, { global, timeout });
  let argv = rest;
  if (DIFF_CMDS.has(rest[0])) argv = [rest[0], ...DIFF_GUARD, ...rest.slice(1)];
  else if (rest[0] === 'stash' && rest[1] === 'show') argv = ['stash', 'show', ...DIFF_GUARD, ...rest.slice(2)];
  const r = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...global, ...argv], timeout);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function gitSafe(cwd, ...args) {
  return gitSafeOpts(cwd, args);
}
