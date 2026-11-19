// Anti-gaming diff checks G1-G5 (factory Phase 1a, spec P1.3). Computed by the trusted driver from the git diff between the
// merge base of a trusted base ref and the builder's head commit. Nothing from the diff is executed, interpolated into a
// command or passed through a shell: file names are read NUL-separated (-z) and only ever compared as data; content is read
// as added/removed lines of a --unified=0 patch, or as blobs fetched by object id. Hits name repo-relative files only (they
// can reach builder-visible text); diff content is never included.
//
// git is injected: (...argv) => { code, out, err }, run without a shell (the driver passes gitSafe; tests a spawnSync wrapper).
// Any git failure or unparseable output THROWS (fail closed): the caller must treat an exception as a hold, never as clean.
// baseRef is `refs/remotes/origin/<branch>` or a raw 40-hex commit sha (e.g. the base sha recorded at merge time).
//
// OUT OF SCOPE for this mechanical check (the hidden verification scenarios are the backstop): semantic stubs and hard-coded
// results; skips built dynamically (`Reflect.get(it, "skip")`, `globalThis['i' + 't']`); stub strings built at runtime; a new
// Go `_test.go` whose TestMain calls os.Exit(0); a test that patches `assert`; lockfiles; tsconfig; helpers in directories
// that are not test-file patterns (e.g. `test/` singular) unless listed in verification.test_globs; package.yaml /
// package.json5 manifests; script names built at run time beyond the `$`/backtick rule; the SOURCE of files a script runs
// (e.g. the content of scripts/test.js); option keys built from computed values; dependency sources outside package.json
// (requirements*.txt, Pipfile, Cargo.toml, Gemfile) and lockfiles.
import { globToRegex } from './config.mjs';
import { CI_PATHS } from './queue.mjs';
import { canonicalSpec, specRegions, MAX_LINE } from './criteria.mjs';

const SHA = /^[0-9a-f]{40}$/;
const NULL_SHA = /^0+$/;
const SPEC_MAX = 256 * 1024; // G5 DoS guard: a bigger head spec is a hit, never parsed
const BLOB_MAX = 1024 * 1024; // package.json read for G4; bigger = hit
const SCRIPTS_MAX = 500;

const fail = (msg) => { throw new Error(`antigaming: ${msg}`); };

// ---- file classes ---------------------------------------------------------------------------------------------------------
const segs = (p) => p.split('/');
const base = (p) => segs(p).at(-1);
const dirs = (p) => segs(p).slice(0, -1).map((s) => s.toLowerCase());

// verification.test_globs are repo-relative matchers; absolute globs and globs with a ".." segment are ignored.
function testGlobs(config) {
  const g = config?.verification?.test_globs;
  if (!Array.isArray(g)) return [];
  return g.filter((x) => typeof x === 'string' && x.trim() && !/^\s*[/\\]/.test(x) && !/^[A-Za-z]:/.test(x) && !x.split(/[/\\]/).includes('..'))
    .map((x) => globToRegex(x.trim().replace(/^(\.\/)+/, '')));
}
export function isTestFile(p, globs = []) {
  const b = base(p);
  if (/\.(?:test|spec)(?:\.|$)/i.test(b) || /^test_.*\.py$/i.test(b) || /_test\.go$/i.test(b)) return true;
  if (dirs(p).some((d) => d === '__tests__' || d === 'tests')) return true;
  return globs.some((re) => re.test(p));
}
const isDoc = (p) => /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(p);

// Python test configuration is protected whole (no TOML/INI parser here: any change to these files holds; over-protects).
const PROTECTED_BASENAMES = new Set(['.mcp.json', 'claude.md', 'claude.local.md', 'agents.md', '.gitattributes', '.gitmodules',
  'pytest.ini', '.pytest.ini', 'pytest.toml', 'pyproject.toml', 'setup.cfg', 'conftest.py', 'tox.ini',
  '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml',
  '.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml',
  '.travis.yml', 'bitbucket-pipelines.yml', '.drone.yml', // CI systems not in queue.mjs CI_PATHS
  'pnpm-workspace.yaml', '.pnpmfile.cjs', '.pnp.cjs', '.pnp.loader.mjs', // install-time resolution / hooks
  'sitecustomize.py', 'usercustomize.py']); // imported by every Python process that has the directory on sys.path
const PROTECTED_BASE_RE = [/^jest\.(config|setup)\./i, /^vitest\.(config|workspace|setup)\./i, /^vite\.config\./i, /^karma\.conf\./i,
  /^playwright\.config\./i, /^cypress\.config\./i, /^ava\.config\./i, /^\.mocharc/i, /^\.nycrc/i, /^\.c8rc/i, /^setuptests\./i,
  /^babel\.config\./i, /^\.babelrc/i, /\.pth$/i];
const PROTECTED_DIRS = new Set(['.claude', '.husky', '.githooks', '__mocks__', '.gitea', '.forgejo', 'patches', 'node_modules']); // patches/: patch-package; node_modules/: committed bin/package shadowing
// Case-insensitive: on a case-insensitive file system a lower-case agent file is read under its upper-case name.
export function isProtectedPath(p) {
  if (p.toLowerCase() === '.product/delivery.json') return true;
  const b = base(p).toLowerCase();
  if (PROTECTED_BASENAMES.has(b) || PROTECTED_BASE_RE.some((re) => re.test(b))) return true;
  if (dirs(p).some((d) => PROTECTED_DIRS.has(d))) return true;
  if (/(^|\/)\.yarn\/(patches|releases|plugins)\//i.test(p)) return true;
  return CI_PATHS.some((re) => re.test(p));
}

// ---- line patterns (added lines only) ---------------------------------------------------------------------------------------
// G2 in test files: every listed form plus the trivial dodges: a reference without a call (`const s = it.skip`), bracket or
// computed access on a test function (`it['sk' + 'ip']`), destructuring (`const { skip } = test`), `.each`/tagged-template
// chains, bare x-aliases (`const later = xit`), focus (= only), node:test / jasmine idioms (`{ skip: true }`, `{ todo: 'x' }`,
// `it.todo(`, `pending(`). `.skip` followed by a word is prose and not matched. A `skip|todo|only` option key (bare, quoted
// or shorthand `{ skip }`) is a hit unless its value is exactly the literal `false` followed by `,` or `}` (so `false || x`
// and `false ? a : b` are hits). Over-protects: a pagination `{ skip: 2 }` in a test file costs one fix round.
// Matched over the file's added lines joined by "\n" (so `it.\nskip(` is seen), raw and with /* */ comments removed.
const SKIP_IN_TESTS = [
  /\.\s*(?:skip|only|skipIf|todo)\b(?!\s+[a-z])/,
  /\[\s*(['"`])(?:skip|only|skipIf|todo)\1\s*\]/,
  /(?<![\w$])(['"`]?)(?:skip|todo|only)\1\s*:(?!\s*false\s*[,}])/,
  /[{,]\s*(?:skip|todo|only)\s*[,}]/,
  /(['"`])[^'"`\n]{0,40}\\(?:u|x)[^'"`\n]{0,40}\1\s*:/, // escaped option key, e.g. { "\u0073kip": true }
  /(?<![\w$.])pending\s*\(/,
  /(?<![\w$.])(?:describe|it|test|context|suite|specify|bench)\s*\[/,
  /\{[^{}]{0,200}(?<![\w$])(?:skip|only|skipIf|todo)(?![\w$])[^{}]{0,200}\}\s*=/, // bounded: no quadratic scan on hostile input
  /(?<![\w$.])(?:xit|xdescribe|xtest|xcontext|xspecify)(?![\w$])/,
  /(?<![\w$.])(?:fit|fdescribe|fcontext)\s*\(/,
  /\bpytest\s*\.\s*mark\s*\.\s*(?:skip|xfail)/,
  /\bpytest\s*\.\s*(?:skip|xfail|importorskip)\s*\(/,
  /@(?:unittest\.)?(?:skip|skipIf|skipUnless|expectedFailure)\b/,
  /\.skipTest\s*\(/,
  /@(?:Disabled|Ignore)\b/,
  /\.Skip(?:Now|f)?\s*\(/,
  /#\[\s*ignore\b/,
];
// G2 in non-test files (test code moved under a non-test name): only framework-qualified markers, so `iter.skip(n)` or the
// word "skip" in prose is not a hit.
const SKIP_ANYWHERE = [
  /(?<![\w$])(?:describe|it|test|context|suite|specify|bench)\s*(?:\.\s*(?:skip|only|skipIf)\b|\[\s*(['"`])(?:skip|only|skipIf)\1\s*\])/,
  /(?<![\w$.])(?:xit|xdescribe|xtest|fdescribe)\s*\(/,
  /\bpytest\s*\.\s*mark\s*\.\s*(?:skip|xfail)/,
  /\bpytest\s*\.\s*(?:skip|xfail)\s*\(/,
  /@Disabled\b/,
  /\bt\.Skip(?:Now|f)?\s*\(/,
  /\bt\s*\.\s*(?:skip|todo)\s*\(/, // node:test context
  // any `<identifier>.skip()` / `.skip("reason")` (a node:test context under another name: ctx, t2, ...). Costs a fix round
  // for a non-test API with that exact shape (e.g. `iter.skip()` without a count); `rows.skip(2)` is not matched.
  /(?<![\w$])[A-Za-z_$][\w$]*\s*\.\s*skip\s*\(\s*(?:(['"`])[^'"`\n]{0,200}\1\s*)?\)/,
  /\bunittest\s*\.\s*(?:skip|expectedFailure)/,
];
// G3 in non-test, non-doc files (joined added text, so `throw new Error(\n  "not implemented")` is seen).
const STUBS = [
  /\bNotImplemented(?:Error|Exception)\b/,
  /\bunimplemented!\s*\(/,
  /\btodo!\s*\(/,
  /\b(?:throw|raise|panic)\b[^;]{0,60}?(['"`])\s*not\s+(?:yet\s+)?implemented/i,
];

// Linear (a lazy /\/\*[\s\S]*?\*\//g rescans to the end for every unclosed "/*": quadratic on hostile input).
function stripBlockComments(t) {
  let out = ''; let i = 0;
  for (;;) {
    const j = t.indexOf('/*', i);
    if (j === -1) return out + t.slice(i);
    const k = t.indexOf('*/', j + 2);
    if (k === -1) return out + t.slice(i);
    out += t.slice(i, j); i = k + 2;
  }
}

// ---- git plumbing -------------------------------------------------------------------------------------------------------------
function runGit(git, ...args) {
  const r = git('-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false', ...args);
  if (!r || typeof r.code !== 'number' || r.code !== 0) fail(`git ${args[0]} failed (exit ${r?.code})`);
  if (typeof r.out !== 'string') fail(`git ${args[0]} returned no output string`); // a missing stdout must never read as clean
  return r.out;
}

// git's C-style quoting of a path in a patch header (with core.quotePath=false only ", \ and control bytes are escaped).
const ESC = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
function cquote(s) {
  if (!/["\\\x00-\x1f\x7f]/.test(s)) return s;
  let o = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    o += ESC[c] ?? (c < 0x20 || c === 0x7f ? `\\${c.toString(8).padStart(3, '0')}` : ch);
  }
  return `${o}"`;
}

// `git diff --raw -z`: entries { oldMode, newMode, oldSha, newSha, status, path }.
function rawEntries(out) {
  const parts = out.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const entries = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/.exec(parts[i]);
    if (!m || parts[i + 1] === undefined || parts[i + 1] === '') fail('unparseable diff --raw output');
    entries.push({ oldMode: m[1], newMode: m[2], oldSha: m[3], newSha: m[4], status: m[5], path: parts[i + 1] });
  }
  return entries;
}

// --unified=0 patch -> Map(path -> { added: string[], removed: string[] }). Sections are matched to paths by their exact
// header (never by order), and hunks are read by their line counts, so file content can never be taken for a header.
// A type change (status T, e.g. file <-> symlink) is printed as two sections (delete + add) with the same header: merged.
function patchLines(out, entries) {
  const paths = entries.map((e) => e.path);
  const byHeader = new Map(paths.map((p) => [`diff --git ${cquote(`a/${p}`)} ${cquote(`b/${p}`)}`, p]));
  const maxSections = new Map(entries.map((e) => [e.path, e.status === 'T' ? 2 : 1]));
  const seen = new Map();
  const res = new Map();
  const lines = out.split('\n');
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const p = byHeader.get(l);
      if (p === undefined) fail('unexpected patch header');
      const n = (seen.get(p) ?? 0) + 1;
      if (n > maxSections.get(p)) fail('unexpected repeated patch header');
      seen.set(p, n);
      if (!res.has(p)) res.set(p, { added: [], removed: [], base: [], head: [] });
      cur = res.get(p);
      continue;
    }
    if (!cur) { if (l === '' && i === lines.length - 1) continue; fail('patch output before the first header'); }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (!h) continue; // extended header lines (index, mode, ---/+++) before the first hunk
    let rem = Number(h[1] ?? 1); let add = Number(h[2] ?? 1);
    while (rem + add > 0) {
      const x = lines[++i];
      if (x === undefined) fail('truncated hunk');
      if (x.startsWith('\\')) continue; // "\ No newline at end of file"
      if (x[0] === '+' && add > 0) { cur.added.push(x.slice(1)); cur.head.push(x.slice(1)); add--; }
      else if (x[0] === '-' && rem > 0) { cur.removed.push(x.slice(1)); cur.base.push(x.slice(1)); rem--; }
      else if (x[0] === ' ' && rem > 0 && add > 0) { cur.base.push(x.slice(1)); cur.head.push(x.slice(1)); rem--; add--; } // full-context diff only
      else fail('malformed hunk');
    }
  }
  for (const p of paths) if (!res.has(p)) fail('patch section missing');
  return res;
}

function blob(git, sha, max) {
  if (NULL_SHA.test(sha)) return { text: '' };
  const size = Number(runGit(git, 'cat-file', '-s', sha).trim());
  if (!Number.isFinite(size)) fail('bad blob size');
  if (size > max) return { tooBig: true };
  return { text: runGit(git, 'cat-file', 'blob', sha) };
}

// ---- G4 content checks (package.json) --------------------------------------------------------------------------------------
// Script names an argv runs through npm/pnpm/yarn/bun: every non-flag token after the tool, minus run/run-script (an
// over-approximation: a flag value such as `--prefix web` is also protected, which only protects more); `node --run <name>`.
// A shell as the tool, or a delegation flag in the argv, makes every scripts change in every package.json protected.
const PM = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh']);
const NPM_ALIASES = { t: 'test', tst: 'test' };
const DELEGATE_ARGS = /^(?:--prefix|-C|--dir|--cwd|-w|--workspace|--workspaces|-ws|--filter|-F|-r|--recursive|workspace|workspaces)(?:=.*)?$/;
const tool = (a) => String(a).split(/[/\\]/).at(-1).replace(/\.(cmd|exe)$/i, '').toLowerCase();
function scriptNames(config) {
  const cmds = [config?.tests?.all, ...(Array.isArray(config?.local_checks) ? config.local_checks.map((c) => c?.command) : [])];
  const names = new Set(); let global = false;
  for (const argv of cmds) {
    if (!Array.isArray(argv) || !argv.length) continue;
    const t = tool(argv[0]); const rest = argv.slice(1).map(String);
    if (SHELLS.has(t)) { global = true; continue; }
    if (t === 'node') {
      rest.forEach((a, i) => { if (a === '--run' && rest[i + 1]) names.add(rest[i + 1]); else if (a.startsWith('--run=')) names.add(a.slice(6)); });
      continue;
    }
    if (!PM.has(t)) continue;
    if (rest.some((a) => DELEGATE_ARGS.test(a))) global = true;
    for (const a of rest) {
      if (!a || a.startsWith('-') || ['run', 'run-script', 'rum', 'urn'].includes(a)) continue;
      names.add(NPM_ALIASES[a] ?? a);
    }
  }
  return { names, global };
}
// npm lifecycle scripts run by an install (the driver's test setup) or pack: always protected in every package.json.
const LIFECYCLE = ['prepare', 'preinstall', 'install', 'postinstall', 'prepublish', 'prepublishOnly', 'prepack', 'postpack'];
// A protected script value that selects scripts by pattern, runs through a multi-script runner, delegates to another package
// (--prefix, -C, --dir, --cwd, -w/--workspace(s), --filter/-F, -r/--recursive, `workspace`, cd/pushd) or builds a command at
// run time ($VAR, $(...), backticks) can reach any script in any package: every scripts change in every package.json is G4.
const WILDCARD = /[*?{}[\]/$`]|(?<![\w-])(?:npm-run-all2?|run-s|run-p|concurrently|wireit)(?![\w-])/;
const DELEGATE = /(?<![\w-])(?:--prefix|-C|--dir|--cwd|-w|--workspace|--workspaces|-ws|--filter|-F|-r|--recursive)(?![\w-])|(?<![\w-])(?:workspaces?|cd|pushd)\s/;
const PKG_TEST_KEYS = ['jest', 'mocha', 'ava', 'c8', 'nyc', 'vitest'];
// Compared whole: any change is G4 (workspace layout, resolution rewrites, patches, bins can all swap a test runner).
const PKG_WHOLE_KEYS = ['workspaces', 'pnpm', 'resolutions', 'overrides', 'bin', 'dependenciesMeta', 'bundledDependencies', 'bundleDependencies'];
// Any new or changed non-registry specifier in a dependency section (file:, link:, git, URL, workspace:, portal:, patch:,
// npm: alias, a path, owner/repo shorthand). A registry version/range change is not a hit. Lockfiles are out of scope.
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const nonRegistry = (v) => typeof v !== 'string' || /[:/\\]/.test(v) || /^\s*[.~]/.test(v);
const own = (o, k) => (o && typeof o === 'object' && !Array.isArray(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const PKG_MAX_FILES = 50;

// Per-file checks that need no script closure. true = G4.
function pkgFileHit(b, h) {
  if (PKG_TEST_KEYS.some((k) => !same(own(b, k), own(h, k)))) return true;
  if (PKG_WHOLE_KEYS.some((k) => !same(own(b, k), own(h, k)))) return true;
  const pmB = own(b, 'packageManager'); const pmH = own(h, 'packageManager'); // corepack accepts a URL
  if (!same(pmB, pmH) && pmH !== undefined && (typeof pmH !== 'string' || /[:/\\]/.test(pmH.replace(/^[^@]*@/, '')))) return true;
  for (const sct of DEP_SECTIONS) {
    const hd = own(h, sct); const bd = own(b, sct);
    if (hd === undefined) continue;
    if (!hd || typeof hd !== 'object' || Array.isArray(hd)) { if (!same(bd, hd)) return true; continue; }
    for (const k of Object.keys(hd)) if (nonRegistry(hd[k]) && !same(own(bd, k), hd[k])) return true;
  }
  return false;
}
const scriptsOf = (o) => { const sc = own(o, 'scripts'); return sc && typeof sc === 'object' && !Array.isArray(sc) ? sc : {}; };

// pkgs: [{ path, b, h }] (parsed base/head objects of every package.json in the diff). Returns the set of paths that are G4.
// The protected-name closure is computed across ALL of them (a root script may call a workspace script) and applied to each.
function pkgScriptHits(pkgs, config) {
  const hits = new Set();
  const { names, global: argvGlobal } = scriptNames(config);
  const keys = new Set(); for (const x of pkgs) for (const k of [...Object.keys(scriptsOf(x.b)), ...Object.keys(scriptsOf(x.h))]) keys.add(k);
  const changedKeys = (x) => [...new Set([...Object.keys(scriptsOf(x.b)), ...Object.keys(scriptsOf(x.h))])].filter((k) => !same(own(scriptsOf(x.b), k), own(scriptsOf(x.h), k)));
  let global = argvGlobal || keys.size > SCRIPTS_MAX;
  const prot = new Set(); const todo = [];
  const add = (n) => { for (const v of [n, `pre${n}`, `post${n}`]) if (!prot.has(v)) { prot.add(v); todo.push(v); } };
  for (const n of [...names, ...LIFECYCLE]) add(n);
  while (!global && todo.length) {
    const n = todo.pop();
    const vals = pkgs.flatMap((x) => [own(scriptsOf(x.b), n), own(scriptsOf(x.h), n)]).filter((v) => v !== undefined).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
    if (!vals) continue;
    if (WILDCARD.test(vals) || DELEGATE.test(vals)) { global = true; break; }
    const tokens = new Set(vals.split(/[^\w:.-]+/));
    for (const k of keys) {
      if (prot.has(k)) continue;
      // A key with other characters falls back to a substring test (over-protects, never under-protects).
      if (/^[\w:.-]+$/.test(k) ? tokens.has(k) : vals.includes(k)) add(k);
    }
  }
  for (const x of pkgs) {
    const ch = changedKeys(x);
    if (global ? ch.length > 0 : ch.some((k) => prot.has(k))) hits.add(x.path);
  }
  return hits;
}

// ---- G5 ---------------------------------------------------------------------------------------------------------------------
// The head spec is untrusted: size and line length are checked BEFORE any parsing (region/extraction code is quadratic on
// hostile long lines). Regions are computed from each file itself; base regions never mask head lines.
function tooLong(text) {
  if (text.length > SPEC_MAX) return true;
  let start = 0;
  for (;;) {
    const j = text.indexOf('\n', start);
    const end = j === -1 ? text.length : j;
    if (end - start > MAX_LINE) return true;
    if (j === -1) return false;
    start = j + 1;
  }
}
function specChanged(git, e, parser) {
  if (NULL_SHA.test(e.oldSha) || NULL_SHA.test(e.newSha)) return true; // added or deleted
  if (!/^100(644|755)$/.test(e.newMode) || !/^100(644|755)$/.test(e.oldMode)) return true;
  const h = blob(git, e.newSha, SPEC_MAX);
  if (h.tooBig || tooLong(h.text)) return true;
  const b = blob(git, e.oldSha, SPEC_MAX);
  if (b.tooBig || tooLong(b.text)) return true;
  if (parser.canonicalSpec(b.text) !== parser.canonicalSpec(h.text)) return true;
  return parser.specRegions(h.text).problems.length > 0 && parser.specRegions(b.text).problems.length === 0;
}

// ---- entry points -----------------------------------------------------------------------------------------------------------
const validBase = (r) => SHA.test(r) || (/^refs\/remotes\/origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(r) && !r.includes('..') && !r.includes('//') && !r.endsWith('/') && !r.endsWith('.lock'));

// checkDiff({ git, baseRef, headSha, config, specPaths }) -> [{ id: 'G1'..'G5', files: [repo-relative path] }] (no entry = clean).
// `parser` is injectable for tests only (defaults to criteria.mjs).
export function checkDiff({ git, baseRef, headSha, config = {}, specPaths = [], parser = { canonicalSpec, specRegions } }) {
  if (typeof git !== 'function') fail('git runner required');
  if (typeof headSha !== 'string' || !SHA.test(headSha)) fail('head must be a 40-hex commit sha');
  if (typeof baseRef !== 'string' || !validBase(baseRef)) fail('base must be refs/remotes/origin/<branch> or a commit sha');
  if (!Array.isArray(specPaths)) fail('specPaths must be an array');
  // Exact repo-relative paths: a non-normalised one would silently never match and disable G5, so it is refused.
  for (const sp of specPaths) {
    if (typeof sp !== 'string' || !sp || sp.startsWith('/') || sp.includes('\\') || /^[A-Za-z]:/.test(sp) || /[\0\n]/.test(sp)
      || sp.split('/').some((x) => x === '' || x === '.' || x === '..')) fail(`spec path is not a normalised repo-relative path: ${JSON.stringify(String(sp)).slice(0, 80)}`);
  }
  const head = runGit(git, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${headSha}^{commit}`).trim();
  runGit(git, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`);
  const mb = runGit(git, 'merge-base', '--end-of-options', baseRef, head).trim();
  if (!SHA.test(mb) || !SHA.test(head)) fail('could not resolve the merge base');

  const common = ['--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', mb, head, '--'];
  const entries = rawEntries(runGit(git, 'diff', '--raw', '-z', '--no-abbrev', ...common));
  if (!entries.length) return [];
  const patch = patchLines(runGit(git, 'diff', '--no-color', '--text', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', ...common), entries);

  const globs = testGlobs(config);
  const pkgEntries = [];
  const specs = new Set(specPaths);
  const found = { G1: new Set(), G2: new Set(), G3: new Set(), G4: new Set(), G5: new Set() };
  for (const e of entries) {
    const p = e.path; const { added } = patch.get(p);
    const test = isTestFile(p, globs);
    // Raw text and a copy with /* */ comments removed (raw is kept: a "/*" inside a string must not hide a marker).
    const txt = added.join('\n'); const texts = [txt, stripBlockComments(txt)];
    const any = (res) => texts.some((t) => res.some((re) => re.test(t)));
    if (test && !NULL_SHA.test(e.oldSha)) found.G1.add(p);
    if (any(test ? SKIP_IN_TESTS : SKIP_ANYWHERE)) found.G2.add(p);
    if (!test && !isDoc(p) && any(STUBS)) found.G3.add(p);
    if (isProtectedPath(p)) found.G4.add(p);
    else if (base(p).toLowerCase() === 'go.mod' && any([/(^|\n)\s*replace\b/, /=>/])) found.G4.add(p); // module replace (e.g. a fake testify)
    else if (base(p).toLowerCase() === 'package.json') pkgEntries.push(e);
    if (specs.has(p) && specChanged(git, e, parser)) found.G5.add(p);
  }
  // package.json: all base/head texts from ONE full-context diff limited by a fixed pathspec (no names in argv, no per-file
  // process). More than PKG_MAX_FILES changed manifests is a hit without reading them.
  if (pkgEntries.length > PKG_MAX_FILES) for (const e of pkgEntries) found.G4.add(e.path);
  else if (pkgEntries.length) {
    const full = patchLines(runGit(git, 'diff', '--no-color', '--text', '--unified=100000000', '--src-prefix=a/', '--dst-prefix=b/', ...common, ':(glob,icase)**/package.json'), pkgEntries);
    const pkgs = [];
    for (const e of pkgEntries) {
      const { base: bl, head: hl } = full.get(e.path);
      const bt = bl.join('\n'); const ht = hl.join('\n');
      let b; let h;
      try {
        if (bt.length > BLOB_MAX || ht.length > BLOB_MAX) throw new Error('too big');
        b = bt === '' ? {} : JSON.parse(bt); h = ht === '' ? {} : JSON.parse(ht);
      } catch { found.G4.add(e.path); continue; }
      if (pkgFileHit(b, h)) found.G4.add(e.path);
      pkgs.push({ path: e.path, b, h });
    }
    // The configured commands run at the repo root: an unchanged root manifest still feeds the closure (read by fixed path).
    if (!pkgEntries.some((e) => e.path === 'package.json')) {
      const t = runGit(git, 'ls-tree', '-z', head, '--', 'package.json');
      const m = /^100(?:644|755) blob ([0-9a-f]{40,64})\tpackage\.json\0?$/.exec(t);
      if (t && !m) found.G4.add('package.json'); // root manifest is not a regular file: hold
      else if (m) {
        const r = blob(git, m[1], BLOB_MAX); let o;
        try { if (r.tooBig) throw new Error('too big'); o = JSON.parse(r.text); } catch { o = undefined; }
        if (o === undefined) for (const x of pkgs) found.G4.add(x.path); // unreadable root: cannot prove the closure
        else pkgs.push({ path: 'package.json', b: o, h: o });
      }
    }
    for (const p of pkgScriptHits(pkgs, config)) found.G4.add(p);
  }
  return Object.entries(found).filter(([, s]) => s.size).map(([id, s]) => ({ id, files: [...s].sort() }));
}

const HOLD_AT_BUILT = new Set(['G1', 'G4', 'G5']);
// P1.3 table. built: G2/G3 -> a builder fix attempt; G1/G4/G5 -> continue to PR, then hold at pr_open (the stricter wins when
// both kinds hit). merge: any hit holds.
export function classify(hits, stage) {
  if (stage !== 'built' && stage !== 'merge') fail(`unknown stage "${stage}"`);
  if (!Array.isArray(hits) || !hits.length) return 'clean';
  if (stage === 'merge') return 'hold';
  return hits.some((h) => HOLD_AT_BUILT.has(h.id)) ? 'hold' : 'fix';
}

// What the driver / `deliver merge` record on a held feature: f.hold_kind = kind, plus the ids (deliver retry --note keys on
// hold_kind === 'antigaming'). null when there is nothing to hold for.
export function holdReason(hits) {
  const ids = [...new Set((hits || []).map((h) => h.id))].sort();
  return ids.length ? { kind: 'antigaming', ids } : null;
}
