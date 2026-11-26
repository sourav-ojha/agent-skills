// Hardened git for the driver: fixed argv (never a shell), GIT_* environment scrubbed, a timeout, and a CONFIG ALLOWLIST: before any
// command, the repository's own config (local, worktree and include files; system and global are off) is listed read-only and every key
// must be on ALLOWED_CONFIG, so a builder-written .git/config cannot define filters, textconv/merge drivers, editors, gpg programs,
// credential helpers, upload/receive-pack commands, includes or URL rewrites. The neutralising -c flags stay as a second layer.
// Supported: read-only commands, plus fetch/checkout/worktree/merge --ff-only against a config the driver itself wrote.
// WORKTREE PREFLIGHT: every command that may touch the work tree (status, add, commit, checkout, diff/log/show without explicit
// revisions, diff --submodule=..., ...) first runs checkWorktreeSafe: it THROWS on a gitlink in the index, a .gitmodules, or any entry
// named .git (any case: dir, gitfile, symlink) below the top level, found by a bounded walk (WORKTREE_WALK_CAP entries, symlinks not
// followed). An embedded repo's own config (filters, textconv, fsmonitor) would otherwise run UNSANDBOXED in the driver: git consults
// nested repos for `status`/`add`/`diff --submodule=diff`. Only fetch, ls-remote, rev-parse, cat-file, ls-tree, rev-list, merge-base,
// show-ref, for-each-ref, config reads, and diff/log/show whose every revision is a full SHA or a refs/... name skip the walk.
// The driver should not run `add`/`commit` in builder worktrees at all (it reads them; the builder commits).
// Network commands: a positional remote NAME must be a configured remote (git otherwise falls through to a same-named local path,
// e.g. a builder-planted bare repo `./origin` whose receive hooks then run); file:// transport is off; options are allowlisted per
// command; `submodule` is refused (.gitmodules URLs are builder-writable).
// CARRY (Task 7): the builder's own Claude Code session is NOT sandbox-exec'd, so its settings must also deny Write/Edit/Bash writes to
// any `.git` at any depth of the worktree; the sandbox profile does this only for code it runs.
import fs from 'node:fs';
import path from 'node:path';
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
  '-c', 'http.followRedirects=false', // an allowed public remote cannot redirect the driver to a private/metadata address
  '-c', 'protocol.file.allow=never', // no local-path / file:// transport (local transport also drops these -c flags for the other side)
  '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', // never recurse into submodule repos
  // A planted commit-graph (objects/info/commit-graph[s]) can carry false parents / generations and so falsify merge-base and
  // ancestry: never read one, never write one.
  '-c', 'core.commitGraph=false', '-c', 'gc.writeCommitGraph=false', '-c', 'fetch.writeCommitGraph=false',
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
  const h = String(host).toLowerCase().replace(/\.+$/, '');
  if (!h || h.split('.').includes('')) return false; // empty labels (a..b)
  if (['ip6-localhost', 'ip6-loopback'].includes(h)) return false;
  if (/(^|\.)\d+\.\d+\.\d+\.\d+(\.|$)/.test(h)) return false; // embedded dotted IPv4 (127.0.0.1.nip.io, 10.0.0.1.sslip.io)
  if (h === 'localhost' || /\.(localhost|local|localdomain|internal|home\.arpa)$/.test(h) || h === 'localhost.localdomain') return false;
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
  env.GIT_NO_LAZY_FETCH = '1'; // a (promisor) repo never fetches missing objects behind a read
  return env;
}

// Splits args into git global options and the rest. Only these global options are accepted; `-c k=v` keys must pass the allowlist.
const GLOBAL_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree']);
const GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-replace-objects', '--literal-pathspecs', '--no-optional-locks']);
// Command-line only (never accepted in a repo's own config): the exact display pairs antigaming.mjs checkDiff passes on every call,
// so checkDiff can run on gitSafe. Key case-insensitive, value exact.
const CLI_ONLY = new Set(['core.quotepath=false', 'diff.suppressblankempty=false', 'core.commitgraph=false', 'gc.writecommitgraph=false', 'fetch.writecommitgraph=false']);
const cliOnly = (kv) => { const eq = kv.indexOf('='); return eq > 0 && CLI_ONLY.has(`${kv.slice(0, eq).toLowerCase()}=${kv.slice(eq + 1)}`); };
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
      if (!cliOnly(kv) && !configAllowed(key, eq < 0 ? undefined : kv.slice(eq + 1))) throw new Error(`git config not allowed: ${key}`);
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

// Only the global options that select the repository (-C, --git-dir, --work-tree); caller -c pairs were checked by splitGlobal.
function locationOf(global) {
  const loc = [];
  for (let i = 0; i < global.length; i++) {
    if (global[i] === '-c') { i++; continue; }
    loc.push(global[i]);
    if (GLOBAL_WITH_VALUE.has(global[i])) loc.push(global[++i]);
  }
  return loc;
}
function readConfig(cwd, loc, timeout) {
  const r = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...loc, 'config', '--list', '--show-origin', '-z'], timeout);
  if (r.status !== 0) throw new Error(`git config could not be verified (exit ${r.status})`);
  const parts = r.stdout.split('\0'), entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i].startsWith('command line:')) continue; // GIT_SAFE_FLAGS
    const nl = parts[i + 1].indexOf('\n');
    entries.push(nl < 0 ? [parts[i + 1], undefined] : [parts[i + 1].slice(0, nl), parts[i + 1].slice(nl + 1)]);
  }
  return entries;
}
const remotesOf = (entries) => new Set(entries.map(([k]) => /^remote\.(.+)\.url$/i.exec(k)?.[1]).filter(Boolean));

// Lists the repository config with origins (no command executes) and throws `git config not allowed: <key>` on the first key not allowed.
// Returns the configured remote names (those with a url).
export function verifyGitConfig(cwd, { global = [], timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const entries = readConfig(cwd, locationOf(global), timeout);
  for (const [key, value] of entries) if (!configAllowed(key, value)) throw new Error(`git config not allowed: ${key}`);
  return { remotes: remotesOf(entries) };
}

// ---- worktree preflight -----------------------------------------------------------------------------------------------------------
export const WORKTREE_WALK_CAP = 100000;
const SAFE_NO_WORKTREE = new Set(['fetch', 'ls-remote', 'rev-parse', 'cat-file', 'ls-tree', 'rev-list', 'merge-base', 'show-ref', 'for-each-ref']);
const REVISION = /^([0-9a-f]{40}|[0-9a-f]{64}|refs\/[A-Za-z0-9._/-]+)$/;
export function touchesWorktree(rest) {
  const [cmd, ...a] = rest;
  if (SAFE_NO_WORKTREE.has(cmd)) return false;
  if (cmd === 'config') return !a.some((x) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(x));
  if (cmd === 'remote' && a[0] === 'get-url') return false; // reads config only
  if (cmd === 'diff' && a.includes('--')) {
    // A diff between exactly two full commit ids reads only the object database, whatever pathspecs follow `--` (attr magic aside:
    // it consults .gitattributes files). checkDiff runs this shape; a walk would make any large tree (node_modules) a permanent hold.
    const i = a.indexOf('--'), opts = a.slice(0, i), specs = a.slice(i + 1);
    const revs = opts.filter((x) => !x.startsWith('-'));
    if (revs.length === 2 && revs.every((x) => REVISION.test(x)) && !opts.some((x) => /^--(submodule|no-index|cached|staged)/.test(x))
      && !specs.some((x) => /^:\(.*attr/i.test(x))) return false;
    return true;
  }
  if (['diff', 'log', 'show'].includes(cmd)) {
    if (a.includes('--') || a.some((x) => x.startsWith('--submodule'))) return true;
    const revs = a.filter((x) => !x.startsWith('-'));
    return !(revs.length >= (cmd === 'diff' ? 2 : 1) && revs.every((x) => REVISION.test(x)));
  }
  return true;
}
// Repository-level redirections a builder could plant, checked in the git dir and the common dir: alternates (object store
// elsewhere), info/grafts (rewrites parents: a planted `<base tip> <head>` makes merge-base return head, so a diff looks empty),
// shallow (cuts history the same way), commit-graph files (false parents; also ignored via core.commitGraph=false) and
// per-worktree config. Throws `git worktree not safe: <file> present`.
// objects/info/packs is not refused: it only lists packs for dumb http transport and never changes what an object id resolves to.
const PLANTED = [['objects', 'info', 'alternates'], ['objects', 'info', 'http-alternates'], ['info', 'grafts'], ['shallow'], ['config.worktree'],
  ['objects', 'info', 'commit-graph'], ['objects', 'info', 'commit-graphs']];
export function checkRepoMetadata(cwd, { global = [], timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const dirs = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...locationOf(global), 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], timeout);
  if (dirs.status !== 0) throw new Error('git worktree not safe: git dir unreadable');
  const [gitDir, commonDir] = dirs.stdout.split('\n');
  if (!gitDir || !commonDir) throw new Error('git worktree not safe: git dir unreadable');
  // An EMPTY objects/info/commit-graphs directory holds no graph, so it cannot change a parent: a builder session's clone ends up
  // with one (seen with git 2.52 and Claude Code 2.1), and refusing it stopped every built feature. A file inside it, or a
  // symlink in its place, is still refused.
  const emptyDir = (p) => { try { return fs.lstatSync(p).isDirectory() && fs.readdirSync(p).length === 0; } catch { return false; } };
  const exists = (p) => { try { fs.lstatSync(p); } catch { return false; } return !(path.basename(p) === 'commit-graphs' && emptyDir(p)); };
  for (const rel of PLANTED) for (const d of new Set([commonDir, gitDir])) if (exists(path.join(d, ...rel))) throw new Error(`git worktree not safe: ${rel.join('/')} present`);
}
// Throws when <git dir>/hooks or <common dir>/hooks holds anything but git's own *.sample files (core.hooksPath itself is refused by
// the config allowlist). For plain-git commands that must run in a checkout before it is otherwise trusted (deliver merge's fetch).
export function checkNoHooks(cwd, { global = [], timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const dirs = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...locationOf(global), 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], timeout);
  if (dirs.status !== 0) throw new Error('git repository not safe: git dir unreadable');
  for (const d of new Set(dirs.stdout.split('\n').filter(Boolean))) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(d, 'hooks')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`git repository not safe: hooks unreadable (${e.code})`); }
    if (ents.some((n) => !n.endsWith('.sample'))) throw new Error('git repository not safe: a hook is installed');
  }
}
// Throws when any refs/replace/* ref exists (loose, packed or reftable: listed by for-each-ref; a failing listing throws). gitSafe
// itself ignores replace refs (GIT_NO_REPLACE_OBJECTS), so ordinary gitSafe calls do not need this; a checkout whose PLAIN git
// (deliver's fetch, ciFiles, a person's own commands) would see swapped objects is refused where trust in it matters (merge gate).
export function checkNoReplaceRefs(cwd, { global = [], timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const r = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...locationOf(global), 'for-each-ref', '--format=%(refname)', 'refs/replace/'], timeout);
  if (r.status !== 0) throw new Error('git repository not safe: refs unreadable');
  if (r.stdout.trim()) throw new Error('git repository not safe: refs/replace present');
}
// Throws `git worktree not safe: <reason>` (an entry INDEX, never a path) on a gitlink, a .gitmodules or a nested .git.
export function checkWorktreeSafe(cwd, { global = [], timeout = DEFAULT_TIMEOUT_MS, cap = WORKTREE_WALK_CAP } = {}) {
  const loc = locationOf(global);
  const top = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...loc, 'rev-parse', '--show-toplevel'], timeout);
  if (top.status !== 0) return; // not in a work tree (bare repo or no repo): nothing to walk; git itself will report the error
  const root = top.stdout.replace(/\n$/, '');
  checkRepoMetadata(cwd, { global, timeout });
  const st = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...loc, 'ls-files', '-z', '--stage'], timeout);
  if (st.status !== 0) throw new Error('git worktree not safe: index unreadable');
  if (st.stdout.split('\0').some((e) => e.startsWith('160000 '))) throw new Error('git worktree not safe: gitlink in the index');
  if (fs.existsSync(path.join(root, '.gitmodules')) || isLink(path.join(root, '.gitmodules'))) throw new Error('git worktree not safe: .gitmodules present');
  let seen = 0;
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new Error(`git worktree not safe: unreadable directory (${e.code})`); }
    for (const d of ents) {
      if (depth === 0 && d.name.toLowerCase() === '.git') continue; // the work tree's own repository
      if (++seen > cap) throw new Error(`git worktree not safe: more than ${cap} entries`);
      if (d.name.toLowerCase() === '.git') throw new Error(`git worktree not safe: nested .git at entry ${seen}`);
      if (d.isDirectory() && !d.isSymbolicLink()) stack.push([path.join(dir, d.name), depth + 1]);
    }
  }
}
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Network commands. git treats ANY argument with a ':' whose part before the first ':' has no '/' as an scp-like remote, and a plain
// NAME that is not a configured remote as a local path. So:
//   fetch/ls-remote/pull/push: the repository (first positional) must be a CONFIGURED remote name or an https/ssh URL passing
//     SAFE_URL + publicHost; later positionals must be ref names or refspecs ([+][src]:refs/...).
//   clone: the first positional must be an https/ssh URL (SAFE_URL + publicHost); an optional second is a RELATIVE destination
//     without '..' segments; nothing more.
//   options: allowlisted per command (OPTIONS below); every other option (--upload-pack, --receive-pack, --exec, --template, --config,
//     -c, --recurse-submodules, --server-option, push -o, --separate-git-dir, --reference, --shared, --mirror, --bare, ...) is refused.
//   remote add/set-url: URL arguments are checked like positional URLs. submodule: refused. archive --remote/--exec: refused.
// Errors name the argument INDEX only. DNS-resolve-before-fetch is NOT done. `unsafeAllowLocalUrls` (tests only) skips this check.
const NET_CMDS = new Set(['fetch', 'ls-remote', 'clone', 'pull', 'push']);
const NAMEISH = /^[A-Za-z0-9_*][A-Za-z0-9._/*-]*$/;
const REFSPEC = /^\+?(HEAD|refs\/[A-Za-z0-9._/*-]*|[A-Za-z0-9_*][A-Za-z0-9._/*-]*)?:refs\/[A-Za-z0-9._/*-]+$/;
const COMMON_OPTS = ['--quiet', '-q', '--verbose', '-v'];
const OPTIONS = {
  fetch: { flags: [...COMMON_OPTS, '--prune', '--no-prune', '--tags', '--no-tags', '--force', '-f', '--all', '--atomic', '--no-recurse-submodules'], depth: true },
  pull: { flags: [...COMMON_OPTS, '--ff-only', '--no-rebase', '--prune', '--no-prune', '--tags', '--no-tags', '--force', '-f', '--no-recurse-submodules'], depth: true },
  push: { flags: [...COMMON_OPTS, '--force', '-f', '--atomic', '--set-upstream', '-u', '--tags', '--no-verify', '--porcelain', '--all'] },
  'ls-remote': { flags: [...COMMON_OPTS, '--tags', '--heads', '--refs', '--exit-code'] },
  clone: { flags: [...COMMON_OPTS, '--single-branch', '--no-checkout', '--no-tags', '--no-recurse-submodules'], depth: true, withName: ['--branch', '-b', '--origin', '-o'] },
};
const isSafeUrl = (a) => /^(https|ssh):\/\//.test(a) && SAFE_URL.test(a) && publicHost(urlHost(a));
const refArg = (a) => (a.includes(':') ? REFSPEC.test(a) : NAMEISH.test(a.replace(/^\+/, '')));
export function checkNetworkArgs(rest, { remotes = new Set(), unsafeAllowLocalUrls = false } = {}) {
  const cmd = rest[0];
  if (unsafeAllowLocalUrls) return; // tests only
  if (cmd === 'remote') {
    for (let i = 1; i < rest.length; i++) if (/[:/]/.test(rest[i]) && !rest[i].startsWith('-') && !isSafeUrl(rest[i])) throw new Error(`git URL not allowed: argument ${i}`);
    return;
  }
  if (cmd === 'archive') {
    for (let i = 1; i < rest.length; i++) if (/^--(remote|exec)/.test(rest[i])) throw new Error(`git option not allowed: argument ${i}`);
    return;
  }
  if (!NET_CMDS.has(cmd)) return;
  const spec = OPTIONS[cmd];
  const positional = [];
  let afterDashDash = false;
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (afterDashDash || !a.startsWith('-')) { positional.push(i); continue; }
    if (a === '--') { afterDashDash = true; continue; }
    if (spec.flags.includes(a)) continue;
    if (spec.depth && /^--depth=[1-9][0-9]{0,6}$/.test(a)) continue;
    if (spec.withName?.includes(a) && typeof rest[i + 1] === 'string' && NAMEISH.test(rest[i + 1])) { i++; continue; }
    throw new Error(`git option not allowed: argument ${i}`);
  }
  if (cmd === 'clone') {
    const [src, dst, ...extra] = positional;
    if (src === undefined || !isSafeUrl(rest[src])) throw new Error(`git URL not allowed: argument ${src ?? 0}`);
    if (dst !== undefined) {
      const d = rest[dst];
      if (path.isAbsolute(d) || d.includes(':') || d.split('/').includes('..') || !d || d.startsWith('-')) throw new Error(`git URL not allowed: argument ${dst}`);
    }
    if (extra.length) throw new Error(`git URL not allowed: argument ${extra[0]}`);
    return;
  }
  for (const [n, i] of positional.entries()) {
    const a = rest[i];
    if (n === 0) {
      if (isSafeUrl(a)) continue;
      if (/^(https|ssh):\/\//.test(a) || a.includes(':') || a.includes('/') || !REMOTE_NAME.test(a)) throw new Error(`git URL not allowed: argument ${i}`);
      if (!remotes.has(a)) throw new Error(`git remote not configured: argument ${i}`);
      continue;
    }
    if (!refArg(a)) throw new Error(`git URL not allowed: argument ${i}`);
  }
}

// gitSafeOpts(cwd, args, { timeout, verified, unsafeSkipWorktreeCheck, worktreeWalkCap, unsafeAllowLocalUrls }):
//   verified: true skips the config allowlist (only within one call chain right after a verified call on the same cwd);
//   unsafeSkipWorktreeCheck / unsafeAllowLocalUrls: TESTS ONLY; worktreeWalkCap can only LOWER WORKTREE_WALK_CAP.
export function gitSafeOpts(cwd, args, { timeout = DEFAULT_TIMEOUT_MS, verified = false, unsafeAllowLocalUrls = false, unsafeSkipWorktreeCheck = false, worktreeWalkCap = WORKTREE_WALK_CAP } = {}) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('gitSafe: cwd is required');
  if (!Array.isArray(args)) throw new Error('gitSafe: args must be an array');
  for (const a of args) if (typeof a !== 'string') throw new Error('gitSafe: every argument must be a string');
  if (!Number.isInteger(worktreeWalkCap) || worktreeWalkCap < 1 || worktreeWalkCap > WORKTREE_WALK_CAP) throw new Error(`gitSafe: worktreeWalkCap must be 1..${WORKTREE_WALK_CAP}`);
  const { global, rest } = splitGlobal(args);
  if (rest[0] === 'submodule') throw new Error('gitSafe: submodule is not supported');
  if (DIFF_CMDS.has(rest[0]) || rest[0] === 'stash') {
    for (let i = 1; i < rest.length; i++) if (/^--(ext-diff|textconv)$/.test(rest[i])) throw new Error(`git option not allowed: argument ${i}`);
  }
  let remotes;
  if (!verified) ({ remotes } = verifyGitConfig(cwd, { global, timeout }));
  else if (NET_CMDS.has(rest[0]) && !unsafeAllowLocalUrls) remotes = remotesOf(readConfig(cwd, locationOf(global), timeout));
  checkNetworkArgs(rest, { remotes, unsafeAllowLocalUrls });
  if (!unsafeSkipWorktreeCheck && touchesWorktree(rest)) checkWorktreeSafe(cwd, { global, timeout, cap: worktreeWalkCap });
  let argv = rest;
  if (DIFF_CMDS.has(rest[0])) argv = [rest[0], ...DIFF_GUARD, ...rest.slice(1)];
  else if (rest[0] === 'stash' && rest[1] === 'show') argv = ['stash', 'show', ...DIFF_GUARD, ...rest.slice(2)];
  const r = spawnGit(cwd, [...GIT_SAFE_FLAGS, ...global, ...argv], timeout);
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function gitSafe(cwd, ...args) {
  return gitSafeOpts(cwd, args);
}
