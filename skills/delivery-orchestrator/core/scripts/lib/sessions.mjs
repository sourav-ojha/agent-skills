// `claude -p` sessions for the factory roles (builder, scenario author), their settings files, and the builder result.
// Zero dependencies. Never logs: callers print counts, ids and status only (a session's stream can hold spec or scenario
// text, so nothing from it is written anywhere by this module; `result` is returned to the caller and nothing else).
//
// Status of the Claude Code side (see references/factory-driver.md, "Known gaps"): the settings keys exist in the
// 2.1.325 binary and the argv shape was confirmed with two trivial `claude -p` runs, but whether each deny rule really
// blocks every route is UNVERIFIED until the user runs the sandbox-deny spike steps.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { classifyFailure } from './limits.mjs';
import { registerCleanup } from './proc.mjs';
import { writeJsonAtomic } from './factoryhome.mjs';

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROLES = ['builder', 'author'];
const FEATURE = /^FEATURE-\d{1,9}$/;
const CTRL = /[\u0000-\u001f\u007f]/;

// Environment passed to claude. Subscription auth on macOS is keychain-based: a `claude -p` run with only
// PATH/HOME/LANG/TMPDIR answered "Not logged in"; adding USER, LOGNAME and SHELL made it work (one of USER/LOGNAME is the
// keychain account; which one was not isolated). No token variable is passed: API-key or CLAUDE_CODE_OAUTH_TOKEN auth is
// not supported here (open question, documented). CLAUDE_CONFIG_DIR is set only when the caller passes configDir.
export const ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL']);
// PATH keeps absolute entries only (a relative entry such as "." would resolve inside the session's cwd), and drops any
// entry that is, lexically or by realpath, inside `cwd` (the repo the builder writes).
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
export function scrubEnv(base = process.env, { configDir, tmpDir, cwd } = {}) {
  const env = {};
  for (const k of ENV_ALLOWLIST) if (typeof base[k] === 'string') env[k] = base[k];
  const roots = cwd ? [...new Set([cwd, realOr(cwd)])] : [];
  if (env.PATH !== undefined) env.PATH = env.PATH.split(':').filter((d) => d && path.isAbsolute(d) && !roots.some((r) => inside(d, r) || inside(realOr(d), r))).join(':');
  if (tmpDir) env.TMPDIR = tmpDir;
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// ------------------------------------------------------------------------------------------------ settings

export function settingsTemplate(role) {
  if (!ROLES.includes(role)) throw new TypeError(`unknown role: ${role}`);
  return path.join(CORE, 'settings', `${role}.json`);
}

// CLAUDE_DIR is the home Claude Code config dir (transcripts, credentials), derived from home. GITDIR and GIT_COMMON are the
// repo's git dir and common dir (the same dir for a plain clone; resolved through the `.git` file for a linked worktree).
const PLACEHOLDERS = ['FACTORY_HOME', 'HOME', 'REPO', 'CLAUDE_DIR', 'GITDIR', 'GIT_COMMON'];
const PH = /\{\{([A-Za-z0-9_]*)\}\}/g;
function safeAbs(name, v) {
  if (typeof v !== 'string' || !path.isAbsolute(v)) throw new TypeError(`${name} must be an absolute path`);
  if (v === '/' || path.normalize(v) !== v || v.endsWith('/') || /[\u0000-\u001f\u007f()*?[\]{}\\!]/.test(v)) throw new TypeError(`${name}: unsafe path for a settings rule`);
  return v;
}

// Deep copy of `obj` with {{NAME}} replaced in every string, in one pass (values are never re-scanned). A value may be an
// array of variants (raw path and its realpath): inside arrays each string expands to one entry per variant.
export function substitutePlaceholders(obj, vars) {
  const variants = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined || v === null) continue;
    const list = (Array.isArray(v) ? v : [v]).map((x) => safeAbs(k, x));
    variants[k] = [...new Set(list)];
  }
  const expand = (s) => {
    const names = [...new Set([...s.matchAll(PH)].map((m) => m[1]))];
    for (const n of names) {
      if (!PLACEHOLDERS.includes(n)) throw new TypeError(`unknown placeholder {{${n}}}`);
      if (!variants[n]) throw new TypeError(`missing value for {{${n}}}`);
    }
    let outs = [s];
    // Safe to apply per name: values cannot contain braces (safeAbs), so a substituted value never forms a placeholder.
    for (const n of names) outs = outs.flatMap((o) => variants[n].map((val) => o.replace(PH, (m, x) => (x === n ? val : m))));
    return [...new Set(outs)];
  };
  const walk = (v) => {
    if (typeof v === 'string') return expand(v)[0];
    if (Array.isArray(v)) return [...new Set(v.flatMap((x) => (typeof x === 'string' ? expand(x) : [walk(x)])))];
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}

const variantsOf = (p) => { let real = p; try { real = fs.realpathSync(p); } catch { /* not created yet */ } return real === p ? [p] : [p, real]; };

// The repo's git dir and common dir. A `.git` FILE (linked worktree) points at a gitdir whose config/hooks live elsewhere;
// those must be denied too. Throws on a symlinked or malformed `.git`.
export function gitDirsOf(repo) {
  const dotgit = path.join(repo, '.git');
  let st;
  try { st = fs.lstatSync(dotgit); } catch { return { gitdir: dotgit, common: dotgit, gitFile: false }; }
  if (st.isSymbolicLink()) throw new TypeError('repoDir/.git is a symlink');
  let gitdir = dotgit; let gitFile = false;
  if (st.isFile()) {
    if (st.size > 4096) throw new TypeError('repoDir/.git file too large');
    const m = /^gitdir: ([^\n\r]+)\r?\n?$/.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) throw new TypeError('repoDir/.git file is not a gitdir pointer');
    gitdir = path.resolve(repo, m[1]); gitFile = true;
  }
  let common = gitdir;
  try { const c = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim(); if (c) common = path.resolve(gitdir, c); } catch { /* plain repo */ }
  return { gitdir, common, gitFile };
}

// Entries of the home Claude Code config dir the builder may read: the implementer skill and plugins it runs. Every other
// entry present at materialise time is read-denied (Read rule + sandbox denyRead), on top of the static template list for
// entries that do not exist yet. An entry name that cannot be written safely into a rule fails closed.
export const CONFIG_DIR_READABLE = Object.freeze(['skills', 'plugins', 'agents', 'commands', ['CLAUDE', 'md'].join('.')]);
const SAFE_ENTRY = /^[A-Za-z0-9._@+-]{1,255}$/;
function pushDenyRead(out, abs, isDir) {
  const rule = `Read(/${abs}${isDir ? '/**' : ''})`;
  if (!out.permissions.deny.includes(rule)) out.permissions.deny.push(rule);
  if (!out.sandbox.filesystem.denyRead.includes(abs)) out.sandbox.filesystem.denyRead.push(abs);
}
function denyConfigDirEntries(out, dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    if (CONFIG_DIR_READABLE.includes(d.name)) continue;
    if (!SAFE_ENTRY.test(d.name) || d.name === '.' || d.name === '..') {
      const e = new Error('settings_unsafe: a config dir entry name cannot be written into a deny rule'); e.code = 'settings_unsafe'; throw e;
    }
    for (const base of variantsOf(dir)) pushDenyRead(out, path.join(base, d.name), d.isDirectory());
  }
}
// For every absolute denyRead / denyWrite path that exists and resolves elsewhere (a symlinked ~/.ssh, say), deny the
// real path too. Read twins are mirrored so the twin check keeps holding.
function addRealpathTwins(out) {
  const fsx = out.sandbox.filesystem;
  for (const p of [...fsx.denyRead]) {
    if (!path.isAbsolute(p) || /[*?[\]{}]/.test(p)) continue;
    let real, st; try { real = fs.realpathSync(p); st = fs.statSync(real); } catch { continue; }
    if (real === p) continue;
    safeAbs('denied path', real);
    pushDenyRead(out, real, st.isDirectory());
  }
  for (const p of [...(fsx.denyWrite ?? [])]) {
    if (!path.isAbsolute(p) || /[*?[\]{}]/.test(p)) continue;
    let real; try { real = fs.realpathSync(p); } catch { continue; }
    if (real !== p && !fsx.denyWrite.includes(real)) { safeAbs('denied path', real); fsx.denyWrite.push(real); }
  }
}

// Writes a per-run copy of the role's settings with absolute paths substituted; returns the file path (mode 0600).
export function materialiseSettings(role, { factoryHome, repoDir, home = os.homedir(), outDir } = {}) {
  const tpl = settingsTemplate(role);
  if (role === 'builder' && !repoDir) throw new TypeError('builder settings need repoDir');
  safeAbs('factoryHome', factoryHome);
  if (repoDir) safeAbs('repoDir', repoDir);
  safeAbs('home', home);
  const vars = { FACTORY_HOME: variantsOf(factoryHome), HOME: variantsOf(home), CLAUDE_DIR: variantsOf(path.join(home, '.claude')) };
  let git = null;
  if (repoDir) {
    git = gitDirsOf(repoDir);
    Object.assign(vars, { REPO: variantsOf(repoDir), GITDIR: variantsOf(git.gitdir), GIT_COMMON: variantsOf(git.common) });
  }
  const out = substitutePlaceholders(JSON.parse(fs.readFileSync(tpl, 'utf8')), vars);
  if (out.sandbox?.filesystem?.denyRead) {
    denyConfigDirEntries(out, path.join(home, '.claude'));
    addRealpathTwins(out);
  }
  if (git?.gitFile) { // the pointer file itself must not be re-pointed
    for (const r of vars.REPO) { out.permissions.deny.push(`Edit(/${r}/.git)`); out.sandbox?.filesystem?.denyWrite?.push(`${r}/.git`); }
  }
  const problems = checkSettings(out);
  if (problems.length) throw new Error(`settings for ${role} failed checks: ${problems.join('; ')}`);
  const dir = outDir ? safeAbs('outDir', outDir) : path.join(factoryHome, 'run', 'settings');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${role}-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  writeJsonAtomic(file, out);
  return file;
}

const FAMILY = { Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'read', Glob: 'read' };
const parseRule = (r) => { const m = /^([A-Za-z0-9_*-]+)(?:\((.*)\))?$/s.exec(String(r)); return m ? { tool: m[1], spec: m[2] } : { tool: String(r), spec: undefined }; };
const family = (tool) => FAMILY[tool] ?? tool;
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
// Conservative: in the file-path families any allow rule next to a deny is refused (path forms are too varied to compare);
// for other tools an allow widens a deny when either rule has no specifier or one glob matches the other literally.
function widens(allow, deny) {
  const a = parseRule(allow); const d = parseRule(deny);
  if (a.tool === '*' || d.tool === '*') return true;
  if (family(a.tool) !== family(d.tool)) return false;
  if (family(a.tool) === 'edit' || family(a.tool) === 'read') return true;
  if (a.spec === undefined || d.spec === undefined) return true;
  return globRe(d.spec).test(a.spec) || globRe(a.spec).test(d.spec);
}

// ALLOWLIST of keys our role settings may use. Anything else (hooks, env, apiKeyHelper, statusLine, plugins, ...) is refused.
const KEYS = {
  '': ['$schema', 'permissions', 'disableAllHooks', 'enableAllProjectMcpServers', 'sandbox'],
  permissions: ['allow', 'deny', 'ask', 'defaultMode', 'disableBypassPermissionsMode', 'blockWritesOutsideWorkingDirectories'],
  sandbox: ['enabled', 'failIfUnavailable', 'allowUnsandboxedCommands', 'autoAllowBashIfSandboxed', 'excludedCommands', 'filesystem', 'network'],
  'sandbox.filesystem': ['denyRead', 'denyWrite'],
  'sandbox.network': ['allowedDomains', 'allowLocalBinding'],
};
const keyName = (k) => (/^[A-Za-z0-9_$]{1,64}$/.test(k) ? k : '<key>');
function unknownKeys(s) {
  const out = [];
  for (const [scope, allowed] of Object.entries(KEYS)) {
    const o = scope ? scope.split('.').reduce((a, k) => (isObj(a) ? a[k] : undefined), s) : s;
    if (o === undefined) continue;
    if (!isObj(o)) { out.push(`${scope} must be an object`); continue; }
    for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push(`unknown key ${scope ? scope + '.' : ''}${keyName(k)}`);
  }
  return out;
}
// `Read(//abs/**)` / `Read(/{{X}}/**)` / `Read(~/p)` -> the path a sandbox denyRead entry must name.
const canonRead = (spec) => spec.replace(/^\/(?=\/|\{\{)/, '').replace(/\/\*\*$/, '');
// Returns a list of problems (empty = acceptable). Shape and policy only; it cannot prove Claude Code enforces the rules.
export function checkSettings(s, { allowPlaceholders = false } = {}) {
  const p = [];
  if (!isObj(s)) return ['not an object'];
  p.push(...unknownKeys(s));
  const perm = s.permissions;
  if (!perm || typeof perm !== 'object') return ['no permissions'];
  const deny = perm.deny; const allow = perm.allow ?? [];
  if (!Array.isArray(deny) || !deny.length || !deny.every((x) => typeof x === 'string')) p.push('permissions.deny must be a non-empty string list');
  if (!Array.isArray(allow) || !allow.every((x) => typeof x === 'string')) p.push('permissions.allow must be a string list');
  if (perm.ask !== undefined && !(Array.isArray(perm.ask) && perm.ask.length === 0)) p.push('permissions.ask must be empty');
  if (perm.defaultMode === 'bypassPermissions') p.push('bypassPermissions mode');
  if (perm.disableBypassPermissionsMode !== 'disable') p.push('bypass mode not disabled');
  if (Array.isArray(deny) && Array.isArray(allow)) for (const a of allow) for (const d of deny) if (widens(a, d)) { p.push(`allow rule widens deny (${parseRule(a).tool})`); break; }
  if (s.disableAllHooks !== true) p.push('hooks not disabled');
  if (s.enableAllProjectMcpServers !== false) p.push('project MCP servers not disabled');
  const sb = s.sandbox;
  if (!sb || sb.enabled !== true) p.push('sandbox not enabled');
  else {
    if (sb.failIfUnavailable !== true) p.push('sandbox.failIfUnavailable not true');
    if (sb.allowUnsandboxedCommands !== false) p.push('sandbox.allowUnsandboxedCommands not false');
    if (sb.excludedCommands !== undefined && !(Array.isArray(sb.excludedCommands) && sb.excludedCommands.length === 0)) p.push('sandbox.excludedCommands not empty');
    const dom = sb.network?.allowedDomains;
    if (dom !== undefined && !(Array.isArray(dom) && dom.length === 0)) p.push('sandbox network allows domains');
  }
  // Every Read(...) path deny needs a sandbox denyRead twin: the Read rule covers the Read tool, the sandbox covers Bash children.
  const denyRead = new Set((Array.isArray(sb?.filesystem?.denyRead) ? sb.filesystem.denyRead : []).map((x) => String(x).replace(/\/\*\*$/, '')));
  if (Array.isArray(deny)) deny.forEach((d, i) => { const r = parseRule(d); if (r.tool === 'Read' && r.spec !== undefined && !denyRead.has(canonRead(r.spec))) p.push(`Read deny #${i} has no sandbox denyRead entry`); });
  if (!allowPlaceholders && JSON.stringify(s).includes('{{')) p.push('unsubstituted placeholder');
  return p;
}

// `--setting-sources user` loads the user settings file (<config dir>/settings.json) UNDER our --settings: lists merge and
// keys we do not set would apply to the session. ALLOWLIST: only the keys below pass; everything else (hooks, statusLine,
// apiKeyHelper, sandbox keys, permissions other than deny, ...) refuses the session by KEY NAME (cleaned, never values).
// enabledPlugins must be empty: plugins bring hooks, and whether our disableAllHooks overrides user or plugin hooks is
// unverified (known gap 15).
const USER_TOP_OK = ['$schema', 'model', 'env', 'permissions', 'cleanupPeriodDays', 'includeCoAuthoredBy', 'enabledPlugins', 'sandbox'];
export const USER_ENV_OK = Object.freeze(['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'DISABLE_BUG_COMMAND',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS', 'MAX_THINKING_TOKENS']);
const cleanKey = (k) => String(k).replace(/[^A-Za-z0-9_$.-]/g, '?').slice(0, 64) || '?';
export function checkUserSettings(s) {
  if (!isObj(s)) return ['settings.json (not an object)'];
  const bad = [];
  for (const k of Object.keys(s)) if (!USER_TOP_OK.includes(k)) bad.push(cleanKey(k));
  if (s.env !== undefined) {
    if (!isObj(s.env)) bad.push('env');
    else for (const k of Object.keys(s.env)) if (!USER_ENV_OK.includes(k)) bad.push(`env.${cleanKey(k)}`);
  }
  if (s.permissions !== undefined) {
    if (!isObj(s.permissions)) bad.push('permissions');
    else for (const k of Object.keys(s.permissions)) if (k !== 'deny') bad.push(`permissions.${cleanKey(k)}`);
  }
  if (s.sandbox !== undefined) {
    if (!isObj(s.sandbox)) bad.push('sandbox');
    else for (const k of Object.keys(s.sandbox)) bad.push(`sandbox.${cleanKey(k)}`);
  }
  if (s.enabledPlugins !== undefined && !(isObj(s.enabledPlugins) && Object.keys(s.enabledPlugins).length === 0)) bad.push('enabledPlugins');
  if (s.model !== undefined && typeof s.model !== 'string') bad.push('model');
  return bad;
}
function lintUserSettings(env, configDir, { cwd, tmpDir } = {}) {
  const dir = configDir ?? (env.HOME ? path.join(env.HOME, '.claude') : null);
  if (!dir) return ['HOME unset'];
  const file = path.join(dir, 'settings.json');
  // The settings file and its dir must not live where the builder writes (its repo or its TMPDIR).
  const roots = [cwd, tmpDir].filter(Boolean).flatMap((r) => [r, realOr(r)]);
  for (const p of [dir, file]) if (roots.some((r) => inside(p, r) || inside(realOr(p), r))) return ['settings.json (inside the session cwd or tmpDir)'];
  let st;
  try { st = fs.statSync(file); } catch (e) { return e.code === 'ENOENT' ? [] : ['settings.json (unreadable)']; }
  if (!st.isFile() || st.size > 1024 * 1024) return ['settings.json (not a regular file or too large)'];
  try { return checkUserSettings(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return ['settings.json (unparsable)']; }
}

// Resolves the claude binary to an absolute path once (no PATH lookup at spawn time). Refuses one inside the session's cwd.
function resolveBin(bin, envPath, cwd) {
  const cands = path.isAbsolute(bin) ? [bin] : String(envPath ?? '').split(':').filter((d) => path.isAbsolute(d)).map((d) => path.join(d, bin));
  let found = null;
  for (const c of cands) { try { if (fs.statSync(c).isFile()) { fs.accessSync(c, fs.constants.X_OK); found = c; break; } } catch { /* next */ } }
  if (!found) return { error: 'spawn_failed' };
  let real = found; let realCwd = cwd;
  try { real = fs.realpathSync(found); realCwd = fs.realpathSync(cwd); } catch { /* keep */ }
  for (const [b, c] of [[found, cwd], [real, realCwd]]) if (b === c || b.startsWith(c + path.sep)) return { error: 'unsafe_binary' };
  return { bin: found };
}

// ------------------------------------------------------------------------------------------------ prompts

export function renderPrompt(name, vars = {}) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError('bad prompt name');
  const text = fs.readFileSync(path.join(CORE, 'prompts', `${name}.md`), 'utf8');
  for (const m of text.matchAll(PH)) if (typeof vars[m[1]] !== 'string') throw new TypeError(`prompt variable ${m[1]} missing`);
  return text.replace(PH, (_, k) => vars[k]);
}

// ------------------------------------------------------------------------------------------------ runSession

const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024; // UTF-16 chars per stream line (up to ~3x in bytes); longer lines are dropped (truncated: true)
const MAX_RESULT = 1024 * 1024;
const MAX_SETTINGS = 256 * 1024;
const MAX_IDS = 10000;
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const absNoCtrl = (v) => typeof v === 'string' && path.isAbsolute(v) && !CTRL.test(v) && path.normalize(v) === v;
const bad = (msg) => { throw new TypeError(msg); };

const OPTIONS = ['role', 'cwd', 'prompt', 'settingsFile', 'configDir', 'maxTurns', 'timeoutS', 'model', 'claudeBin', 'baseEnv', 'killGraceMs', 'maxLineChars', 'onSpawn', 'tmpDir'];
function checkArgs(o) {
  if (!o || typeof o !== 'object') bad('runSession needs an options object');
  for (const k of Object.keys(o)) if (!OPTIONS.includes(k)) bad(`unknown option ${cleanKey(k)}`);
  if (!ROLES.includes(o.role)) bad('role must be builder or author');
  if (!absNoCtrl(o.cwd)) bad('cwd must be an absolute path');
  let st; try { st = fs.statSync(o.cwd); } catch { bad('cwd does not exist'); }
  if (!st.isDirectory()) bad('cwd is not a directory');
  // One argv string: Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN). Long input goes in a file (--fix-brief).
  if (typeof o.prompt !== 'string' || !o.prompt || Buffer.byteLength(o.prompt) > 100000) bad('prompt must be a non-empty string of at most 100000 bytes');
  if (o.prompt.startsWith('-')) bad('prompt must not start with "-" (it would be parsed as an option)');
  if (o.prompt.includes('\0')) bad('prompt contains NUL');
  if (!Number.isInteger(o.maxTurns) || o.maxTurns < 1 || o.maxTurns > 1000) bad('maxTurns must be an integer 1-1000');
  if (typeof o.timeoutS !== 'number' || !Number.isFinite(o.timeoutS) || o.timeoutS <= 0 || o.timeoutS > 86400) bad('timeoutS must be a number of seconds');
  if (o.model !== undefined && o.model !== null && (typeof o.model !== 'string' || !MODEL.test(o.model))) bad('bad model name');
  if (o.configDir !== undefined && o.configDir !== null) {
    if (o.role !== 'author') bad('configDir is for the author role only');
    if (!absNoCtrl(o.configDir)) bad('configDir must be an absolute path');
  }
  if (o.claudeBin !== undefined && o.claudeBin !== 'claude' && !absNoCtrl(o.claudeBin)) bad('claudeBin must be "claude" or an absolute path');
  if (o.tmpDir !== undefined && o.tmpDir !== null) {
    if (!absNoCtrl(o.tmpDir)) bad('tmpDir must be an absolute path');
    let t; try { t = fs.lstatSync(o.tmpDir); } catch { bad('tmpDir does not exist'); }
    if (!t.isDirectory()) bad('tmpDir must be a directory (not a symlink)');
  }
  if (!absNoCtrl(o.settingsFile)) bad('settingsFile must be an absolute path');
  let lst; try { lst = fs.lstatSync(o.settingsFile); } catch { bad('settingsFile does not exist'); }
  if (!lst.isFile()) bad('settingsFile must be a regular file (not a symlink)');
  if (lst.size > MAX_SETTINGS) bad('settingsFile too large');
  let s; try { s = JSON.parse(fs.readFileSync(o.settingsFile, 'utf8')); } catch { bad('settingsFile is not JSON'); }
  const problems = checkSettings(s);
  if (problems.length) bad(`settingsFile failed checks: ${problems.join('; ')}`);
}

export function buildArgv({ role, prompt, settingsFile, maxTurns, model }) {
  const argv = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns),
    '--settings', settingsFile, '--setting-sources', 'user', '--strict-mcp-config', '--permission-prompts', 'none'];
  if (model) argv.push('--model', model);
  // The author needs no tool; its transcript would hold the scenarios, so it is not persisted.
  if (role === 'author') argv.push('--tools', '', '--no-session-persistence');
  return argv;
}

const killGroup = (pgid, sig) => { try { process.kill(-pgid, sig); return true; } catch { return false; } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const mapUsage = (u) => ({ in: num(u?.input_tokens), out: num(u?.output_tokens), cache_create: num(u?.cache_creation_input_tokens), cache_read: num(u?.cache_read_input_tokens) });
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Never throws for a failed session (only for bad arguments). Timeout: a MONOTONIC clock (process.hrtime, which on macOS
// is mach_absolute_time and on Linux CLOCK_MONOTONIC: neither advances while the machine sleeps, so a laptop lid does not
// eat the budget) -> SIGTERM to the process group, SIGKILL after killGraceMs.
export async function runSession(opts) {
  checkArgs(opts);
  const { role, cwd, configDir, timeoutS, claudeBin = 'claude', baseEnv = process.env, killGraceMs = 5000, maxLineChars = DEFAULT_MAX_LINE_CHARS, onSpawn, tmpDir } = opts;
  const argv = buildArgv(opts);
  const env = scrubEnv(baseEnv, { configDir: role === 'author' ? configDir : undefined, tmpDir, cwd });
  const early = (failure) => ({ ok: false, sessionId: null, result: null, usage: { in: 0, out: 0, cache_create: 0, cache_read: 0 }, turns: 0, costUsd: null, failure, timedOut: false, truncated: false, exitCode: null, signal: null });
  const unsafe = lintUserSettings(env, role === 'author' ? configDir : undefined, { cwd, tmpDir });
  if (unsafe.length) return early({ kind: 'settings_unsafe', resetAt: null, keys: unsafe });
  const resolved = resolveBin(claudeBin, env.PATH, cwd);
  if (resolved.error) return early({ kind: resolved.error, resetAt: null });

  return new Promise((resolve) => {
    const st = { sessionId: null, last: null, rejected: null, ids: new Map(), truncated: false };
    let partial = ''; let dropping = false; let timedOut = false; let done = false;
    let child; let tick; let killTimer; let unregister = () => {};

    const handle = (line) => {
      if (!line.trim()) return;
      let e; try { e = JSON.parse(line); } catch { return; }
      if (!isObj(e)) return;
      if (st.sessionId === null && typeof e.session_id === 'string' && SESSION_ID.test(e.session_id)) st.sessionId = e.session_id;
      if (e.type === 'result') st.last = e;
      else if (e.type === 'assistant' && isObj(e.message) && typeof e.message.id === 'string') {
        if (st.ids.has(e.message.id) || st.ids.size < MAX_IDS) st.ids.set(e.message.id, e.message.usage);
      } else if (e.type === 'rate_limit_event' && isObj(e.rate_limit_info) && String(e.rate_limit_info.status).toLowerCase() === 'rejected') st.rejected = e;
    };
    const feed = (s) => {
      let i;
      while ((i = s.indexOf('\n')) !== -1) {
        const head = s.slice(0, i); s = s.slice(i + 1);
        if (dropping) { dropping = false; partial = ''; continue; }
        const line = partial + head; partial = '';
        if (line.length > maxLineChars) { st.truncated = true; continue; }
        handle(line);
      }
      if (dropping) return;
      partial += s;
      if (partial.length > maxLineChars) { st.truncated = true; dropping = true; partial = ''; }
    };

    const finish = ({ exitCode = null, signal = null, spawnFailed = false } = {}) => {
      if (done) return; done = true;
      clearInterval(tick); clearTimeout(killTimer); unregister();
      if (!dropping && partial) { if (partial.length <= maxLineChars) handle(partial); partial = ''; }
      const r = st.last;
      let usage; let turns;
      if (r && isObj(r.usage)) usage = mapUsage(r.usage);
      else { usage = { in: 0, out: 0, cache_create: 0, cache_read: 0 }; for (const u of st.ids.values()) { const m = mapUsage(u); for (const k of Object.keys(usage)) usage[k] += m[k]; } }
      turns = r && Number.isInteger(r.num_turns) && r.num_turns >= 0 ? r.num_turns : st.ids.size;
      const result = r && typeof r.result === 'string' ? r.result.slice(0, MAX_RESULT) : null;
      const costUsd = r && typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null;
      const ok = !timedOut && !spawnFailed && Boolean(r) && r.is_error === false && r.subtype === 'success' && exitCode === 0;
      let failure = null;
      if (timedOut) failure = { kind: 'timeout', resetAt: null };
      else if (spawnFailed) failure = { kind: 'spawn_failed', resetAt: null };
      else if (!ok) {
        // Most specific first: max turns (even with is_error:true); a result naming its own error subtype is classified on
        // its own text (an earlier rejected rate event does not override it); a rejected event decides only when the
        // result is missing or a plain is_error result.
        const specific = r && typeof r.subtype === 'string' && r.subtype !== 'success';
        if (r?.subtype === 'error_max_turns') failure = { kind: 'max_turns', resetAt: null };
        else if (specific) { const c = classifyFailure([{ ...r, is_error: true }]); failure = { kind: c.kind, resetAt: c.resetAt }; }
        else if (st.rejected || r?.is_error === true) {
          const events = [];
          if (st.rejected) events.push(st.rejected);
          events.push({ ...(r ?? {}), is_error: true });
          const c = classifyFailure(events);
          failure = { kind: c.kind, resetAt: c.resetAt };
        } else if (!r) failure = { kind: 'no_result', resetAt: null };
        else failure = { kind: 'other', resetAt: null };
      }
      resolve({ ok, sessionId: st.sessionId, result, usage, turns, costUsd, failure, timedOut, truncated: st.truncated, exitCode, signal });
    };

    try {
      child = spawn(resolved.bin, argv, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return finish({ spawnFailed: true }); }
    const pgid = child.pid;
    if (pgid) {
      unregister = registerCleanup(() => { killGroup(pgid, 'SIGKILL'); });
      try { onSpawn?.({ pgid }); } catch { /* caller bug must not leak the process */ }
    }
    const dec = new StringDecoder('utf8');
    child.stdout.on('data', (d) => feed(dec.write(d)));
    child.stdout.on('end', () => feed(dec.end()));
    child.stderr.on('data', () => {}); // drained, never kept: it can echo prompt text
    // spawn_failed only when no process was created; with a pid, 'exit' follows and decides.
    child.on('error', () => { if (!pgid) finish({ spawnFailed: true }); });
    child.on('exit', (code, signal) => {
      if (pgid) killGroup(pgid, 'SIGKILL'); // sweep what the session left in its group
      let settled = false;
      const end = () => { if (settled) return; settled = true; child.stdout.destroy(); child.stderr.destroy(); finish({ exitCode: code, signal }); };
      child.stdout.once('close', end);
      setTimeout(end, 1000).unref();
    });

    const t0 = process.hrtime.bigint();
    const limit = BigInt(Math.round(timeoutS * 1e9));
    tick = setInterval(() => {
      if (timedOut || process.hrtime.bigint() - t0 < limit) return;
      timedOut = true;
      killGroup(pgid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(pgid, 'SIGKILL'), killGraceMs);
    }, Math.max(10, Math.min(250, Math.floor(timeoutS * 1000))));
  });
}

// ------------------------------------------------------------------------------------------------ builder result

const NO_RESULT = Object.freeze({ status: 'blocked', question: 'no_result' });
const RESULT_MAX = 64 * 1024;
const FIELD_MAX = 2000;
// Control (Cc) and format (Cf: bidi, zero-width, U+061C, U+180E, tags) characters, line/paragraph separators and
// variation selectors are dropped; tabs and newlines become spaces first.
const INVISIBLE = /[\p{Cc}\p{Cf}\u{2028}\u{2029}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/gu;
const clean = (s) => Array.from(s.replace(/[\t\n\r]/g, ' ').replace(INVISIBLE, '')).slice(0, FIELD_MAX).join('').trim();

export function readBuilderResult(cloneDir, id) {
  if (!absNoCtrl(cloneDir)) throw new TypeError('cloneDir must be an absolute path');
  if (typeof id !== 'string' || !FEATURE.test(id)) throw new TypeError('id must be FEATURE-<digits>');
  const impl = path.join(cloneDir, '.implementation');
  const dir = path.join(impl, id);
  const file = path.join(dir, 'result.json');
  let fd = null; let obj;
  try {
    for (const d of [impl, dir]) if (!fs.lstatSync(d).isDirectory()) return { ...NO_RESULT }; // a symlink is not a directory to lstat
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(cloneDir), '.implementation', id)) return { ...NO_RESULT };
    const lst = fs.lstatSync(file);
    if (!lst.isFile() || lst.nlink !== 1 || lst.size > RESULT_MAX) return { ...NO_RESULT };
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.ino !== lst.ino || fst.dev !== lst.dev || fst.nlink !== 1 || fst.size > RESULT_MAX) return { ...NO_RESULT };
    const buf = Buffer.alloc(RESULT_MAX + 1);
    let n = 0; let r;
    while (n < buf.length && (r = fs.readSync(fd, buf, n, buf.length - n, n)) > 0) n += r;
    if (n > RESULT_MAX) return { ...NO_RESULT };
    let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, n));
    if (text.startsWith('\ufeff')) text = text.slice(1);
    obj = JSON.parse(text);
  } catch { return { ...NO_RESULT }; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
  if (!isObj(obj) || (obj.status !== 'done' && obj.status !== 'blocked')) return { ...NO_RESULT };
  const out = { status: obj.status };
  for (const k of ['question', 'summary']) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return { ...NO_RESULT };
    const c = clean(v);
    if (c) out[k] = c;
  }
  if (out.status === 'blocked' && !out.question) out.question = 'no_question';
  return out;
}
