// factory sessions: `claude -p` runner, builder/author settings, builder result. Uses the fake claude only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const SKILL_DIR = path.join(REPO, 'skills', 'delivery-orchestrator');
const LIB = path.join(SKILL_DIR, 'core', 'scripts', 'lib', 'sessions.mjs');
const S = await import(LIB);
const FAKE = path.join(REPO, 'tests', 'fixtures', 'fake-claude');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// An isolated HOME: runSession lints <HOME>/.claude/settings.json, and the developer's real one must not decide the tests.
const ISO_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-sess-home-')));
process.env.HOME = ISO_HOME;
process.on('exit', () => fs.rmSync(ISO_HOME, { recursive: true, force: true }));

const tmp = (t, prefix = 'factory-sess-') => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
// A temp dir holding `claude` -> the committed shim, plus fake.json. Returns the absolute binary path and log reader.
function fake(t, cfg = {}) {
  const d = tmp(t, 'fake-claude-');
  fs.symlinkSync(path.join(FAKE, 'claude'), path.join(d, 'claude'));
  const log = path.join(d, 'log.jsonl');
  fs.writeFileSync(path.join(d, 'fake.json'), JSON.stringify({ log, ...cfg }));
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin: path.join(d, 'claude'), dir: d, log, entries };
}
function setup(t, role = 'builder') {
  const fh = tmp(t, 'factory-home-');
  const cwd = tmp(t, 'factory-clone-');
  const settingsFile = S.materialiseSettings(role, { factoryHome: fh, repoDir: cwd });
  return { fh, cwd, settingsFile };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitDead(pid, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end && alive(pid)) await sleep(50); return !alive(pid); }

// ---------------------------------------------------------------- settings

const readTemplate = (role) => JSON.parse(fs.readFileSync(S.settingsTemplate(role), 'utf8'));

// The lists a reviewer signed off on. Kept here, independent of the settings file, so deleting a rule fails a test.
const CRED_DIRS = ['.ssh', '.aws', '.config/gcloud', '.kube', '.gnupg', '.config/gh'];
const CRED_FILES = ['.npmrc', '.docker/config.json', '.claude.json', '.git-credentials', '.netrc'];
const CLAUDE_DIRS = ['projects', 'todos', 'file-history', 'sessions', 'session-env', 'shell-snapshots', 'paste-cache', 'tasks', 'backups', 'ide'];
const CLAUDE_FILES = ['.credentials.json', 'history.jsonl'];
const GIT_PARTS = ['config', 'hooks/**', 'info/**', 'modules/**', 'commondir', 'config.worktree', 'objects/info/**', 'worktrees/**'];
const READ_PAIRS = [['/{{FACTORY_HOME}}/**', '{{FACTORY_HOME}}']];
for (const d of CRED_DIRS) READ_PAIRS.push([`~/${d}/**`, `~/${d}`], [`/{{HOME}}/${d}/**`, `{{HOME}}/${d}`]);
for (const f of CRED_FILES) READ_PAIRS.push([`~/${f}`, `~/${f}`], [`/{{HOME}}/${f}`, `{{HOME}}/${f}`]);
for (const d of CLAUDE_DIRS) READ_PAIRS.push([`~/.claude*/${d}/**`, `~/.claude*/${d}`], [`/{{CLAUDE_DIR}}/${d}/**`, `{{CLAUDE_DIR}}/${d}`]);
for (const f of CLAUDE_FILES) READ_PAIRS.push([`~/.claude*/${f}`, `~/.claude*/${f}`], [`/{{CLAUDE_DIR}}/${f}`, `{{CLAUDE_DIR}}/${f}`]);
const REQUIRED_BUILDER_DENY = [
  ...READ_PAIRS.map(([r]) => `Read(${r})`),
  'Edit(/{{FACTORY_HOME}}/**)', 'Write(/{{FACTORY_HOME}}/**)',
  'Edit(~/.claude*/**)', 'Edit(/{{HOME}}/.claude*/**)', 'Edit(~/.claude.json)', 'Edit(/{{CLAUDE_DIR}}/**)', 'Edit(/{{HOME}}/.claude.json)',
  ...GIT_PARTS.map((g) => `Edit(**/.git/${g})`), ...GIT_PARTS.map((g) => `Edit(/{{GITDIR}}/${g})`), ...GIT_PARTS.map((g) => `Edit(/{{GIT_COMMON}}/${g})`),
  'Edit(/{{REPO}}/*/**/.git)', 'Edit(/{{REPO}}/*/**/.git/**)',
  'Write(**/.git/**)', 'Write(**/.git)', 'NotebookEdit(**/.git/**)',
  'Bash(gh)', 'Bash(gh *)', 'Bash(git push)', 'Bash(git push *)', 'Bash(git * push)', 'Bash(git * push *)',
  'Bash(node *factory.mjs*)', 'Bash(node *deliver.mjs*)', 'Bash(*factory.mjs*)', 'Bash(*deliver.mjs*)',
  'WebFetch', 'WebSearch',
];
const REQUIRED_DENY_WRITE = ['{{FACTORY_HOME}}', '{{CLAUDE_DIR}}', '{{HOME}}/.claude.json', '{{REPO}}/*/**/.git',
  ...['{{GITDIR}}', '{{GIT_COMMON}}'].flatMap((b) => GIT_PARTS.map((g) => `${b}/${g.replace('/**', '')}`))];
const REQUIRED_AUTHOR_DENY = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'Read(/{{FACTORY_HOME}}/**)', 'Edit(/{{FACTORY_HOME}}/**)', 'Read(~/.claude*/projects/**)', 'Read(/{{CLAUDE_DIR}}/projects/**)'];

test('builder settings: every required deny rule, sandbox, hooks and bypass locks are present', () => {
  const s = readTemplate('builder');
  for (const r of REQUIRED_BUILDER_DENY) assert.ok(s.permissions.deny.includes(r), `missing deny ${r}`);
  assert.deepEqual([...s.permissions.deny].sort(), [...REQUIRED_BUILDER_DENY].sort(), 'deny list changed: update the reviewed list');
  assert.deepEqual([...s.sandbox.filesystem.denyRead].sort(), READ_PAIRS.map(([, p]) => p).sort(), 'every credential/transcript path is denied to Bash children too');
  assert.deepEqual([...s.sandbox.filesystem.denyWrite].sort(), [...REQUIRED_DENY_WRITE].sort());
  assert.equal(s.permissions.defaultMode, 'acceptEdits');
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(s.permissions.blockWritesOutsideWorkingDirectories, true);
  assert.deepEqual(s.permissions.allow, []);
  assert.equal(s.permissions.ask, undefined);
  assert.equal(s.disableAllHooks, true);
  assert.equal(s.enableAllProjectMcpServers, false);
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.failIfUnavailable, true);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(s.sandbox.excludedCommands, []);
  assert.deepEqual(s.sandbox.network.allowedDomains, []);
  assert.deepEqual(S.checkSettings(s, { allowPlaceholders: true }), []);
});

test('builder settings: the top-level .git stays committable (no Edit deny on the whole .git, which the sandbox would merge)', () => {
  const s = readTemplate('builder');
  for (const r of s.permissions.deny) assert.ok(!/^Edit\((?:\*\*\/\.git|\/\{\{REPO\}\}\/\.git|\/\{\{GITDIR\}\}|\/\{\{GIT_COMMON\}\})(?:\/\*\*)?\)$/.test(r), `over-broad ${r}`);
  for (const p of s.sandbox.filesystem.denyWrite) assert.ok(!['{{REPO}}/.git', '{{GITDIR}}', '{{GIT_COMMON}}', '{{GITDIR}}/objects', '{{GITDIR}}/refs'].includes(p), p);
});

test('checkSettings: a Read deny without a sandbox denyRead twin, and unknown keys at any level, are refused', () => {
  const base = () => JSON.parse(JSON.stringify(readTemplate('builder')));
  const a = base(); a.sandbox.filesystem.denyRead = a.sandbox.filesystem.denyRead.filter((x) => x !== '~/.ssh');
  assert.ok(S.checkSettings(a, { allowPlaceholders: true }).some((m) => /has no sandbox denyRead entry/.test(m)));
  const b = base(); b.permissions.deny.push('Read(~/.secret/**)');
  assert.ok(S.checkSettings(b, { allowPlaceholders: true }).some((m) => /has no sandbox denyRead entry/.test(m)));
  for (const mut of [(s) => { s.env = {}; }, (s) => { s.statusLine = {}; }, (s) => { s.apiKeyHelper = 'x'; }, (s) => { s.enabledPlugins = {}; },
    (s) => { s.permissions.additionalDirectories = []; }, (s) => { s.sandbox.enableWeakerNestedSandbox = true; }, (s) => { s.sandbox.filesystem.allowWrite = []; },
    (s) => { s.sandbox.network.allowUnixSockets = []; }, (s) => { s.sandbox.network = []; }]) {
    const s = base(); mut(s); assert.ok(S.checkSettings(s, { allowPlaceholders: true }).some((m) => /unknown key|must be an object/.test(m)), String(mut));
  }
});

test('author settings: no tools, no network, hooks off', () => {
  const s = readTemplate('author');
  for (const r of REQUIRED_AUTHOR_DENY) assert.ok(s.permissions.deny.includes(r), `missing deny ${r}`);
  assert.deepEqual([...s.permissions.deny].sort(), [...REQUIRED_AUTHOR_DENY].sort());
  assert.deepEqual(s.permissions.allow, []);
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(s.disableAllHooks, true);
  assert.equal(s.enableAllProjectMcpServers, false);
  assert.equal(s.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(s.sandbox.network.allowedDomains, []);
  assert.deepEqual(S.checkSettings(s, { allowPlaceholders: true }), []);
});

test('checkSettings: an allow rule that widens a deny, bypass mode, escape hatches and leftover placeholders are refused', () => {
  const base = () => JSON.parse(JSON.stringify(readTemplate('builder')));
  const cases = [
    (s) => { s.permissions.allow = ['Bash(gh pr list)']; },
    (s) => { s.permissions.allow = ['Bash']; },
    (s) => { s.permissions.allow = ['Write(/tmp/x)']; }, // Write is in the Edit family
    (s) => { s.permissions.allow = ['WebFetch(domain:example.com)']; },
    (s) => { s.permissions.allow = ['Read(~/.factory/**)']; }, // Read is denied for FACTORY_HOME
    (s) => { s.permissions.ask = ['Bash(gh *)']; },
    (s) => { s.permissions.defaultMode = 'bypassPermissions'; },
    (s) => { delete s.permissions.disableBypassPermissionsMode; },
    (s) => { s.sandbox.allowUnsandboxedCommands = true; },
    (s) => { s.sandbox.excludedCommands = ['git']; },
    (s) => { s.sandbox.enabled = false; },
    (s) => { s.sandbox.failIfUnavailable = false; },
    (s) => { s.sandbox.network.allowedDomains = ['github.com']; },
    (s) => { s.disableAllHooks = false; },
    (s) => { s.enableAllProjectMcpServers = true; },
    (s) => { s.hooks = { Stop: [] }; },
  ];
  for (const [i, mut] of cases.entries()) { const s = base(); mut(s); assert.ok(S.checkSettings(s, { allowPlaceholders: true }).length > 0, `case ${i} accepted`); }
  assert.ok(S.checkSettings(base()).length > 0, 'placeholders left in a materialised file must be refused');
  const ok = base(); ok.permissions.allow = ['Bash(npm test)'];
  assert.deepEqual(S.checkSettings(ok, { allowPlaceholders: true }), []);
});

test('settingsTemplate: absolute path under the skill dir', () => {
  for (const role of ['builder', 'author']) {
    const p = S.settingsTemplate(role);
    assert.ok(path.isAbsolute(p));
    assert.ok(p.startsWith(path.join(SKILL_DIR, 'core', 'settings') + path.sep));
  }
  assert.throws(() => S.settingsTemplate('evaluator'), /role/);
});

test('materialiseSettings: substitutes FACTORY_HOME, HOME and REPO as absolute paths, writes a private file under FACTORY_HOME', (t) => {
  const fh = tmp(t, 'fh-'); const repo = tmp(t, 'repo-'); const home = tmp(t, 'home-');
  const file = S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home });
  assert.ok(path.isAbsolute(file) && file.startsWith(fh + path.sep));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('{{'), 'placeholders left');
  const s = JSON.parse(text);
  assert.ok(s.permissions.deny.includes(`Read(/${fh}/**)`));
  assert.ok(s.permissions.deny.includes(`Edit(/${repo}/.git/config)`));
  assert.ok(s.permissions.deny.includes(`Read(/${path.join(home, '.claude', 'projects')}/**)`));
  assert.ok(s.sandbox.filesystem.denyRead.includes(fh));
  assert.ok(s.sandbox.filesystem.denyRead.includes(path.join(home, '.claude', 'projects')));
  assert.ok(s.sandbox.filesystem.denyRead.includes(`${home}/.ssh`) && s.permissions.deny.includes(`Read(/${home}/.ssh/**)`));
  assert.ok(s.sandbox.filesystem.denyWrite.includes(`${repo}/.git/hooks`));
  assert.ok(s.permissions.deny.includes('Bash(gh *)'));
  assert.deepEqual(S.checkSettings(s), []);
  const a = S.materialiseSettings('author', { factoryHome: fh, home });
  assert.notEqual(a, file);
  assert.ok(JSON.parse(fs.readFileSync(a, 'utf8')).permissions.deny.includes(`Read(/${fh}/**)`));
});

test('materialiseSettings: a non-canonical path also gets its realpath form', (t) => {
  const fh = tmp(t, 'fh-'); const repo = tmp(t, 'repo-');
  fs.mkdirSync(path.join(fh, 'real'));
  fs.symlinkSync(path.join(fh, 'real'), path.join(fh, 'alias'));
  const file = S.materialiseSettings('builder', { factoryHome: path.join(fh, 'alias'), repoDir: repo, outDir: fh });
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(s.sandbox.filesystem.denyRead.includes(path.join(fh, 'alias')));
  assert.ok(s.sandbox.filesystem.denyRead.includes(path.join(fh, 'real')));
});

test('substitutePlaceholders: unknown or missing placeholders throw; unsafe values throw; single pass', () => {
  assert.throws(() => S.substitutePlaceholders({ a: ['x {{NOPE}}'] }, { FACTORY_HOME: '/f' }), /unknown placeholder/);
  assert.throws(() => S.substitutePlaceholders({ a: ['{{REPO}}/x'] }, { FACTORY_HOME: '/f' }), /REPO/);
  for (const bad of ['rel/path', '/a/../b', '/a\nb', '/a)b', '/a*b', '/', '/a{{HOME}}']) {
    assert.throws(() => S.substitutePlaceholders({ a: ['{{FACTORY_HOME}}'] }, { FACTORY_HOME: bad }), /unsafe|absolute/, bad);
  }
  assert.deepEqual(S.substitutePlaceholders({ a: ['Read(/{{FACTORY_HOME}}/**)'], b: { c: '{{FACTORY_HOME}}' } }, { FACTORY_HOME: '/f' }),
    { a: ['Read(//f/**)'], b: { c: '/f' } });
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: '/f' }), /repoDir/);
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: 'rel', repoDir: '/r' }), /absolute/);
});

// ---------------------------------------------------------------- runSession

test('runSession done: argv has every required flag in order, stdin is /dev/null, result/usage/session id parsed', async (t) => {
  const f = fake(t, { mode: 'done' });
  const { cwd, settingsFile } = setup(t);
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'Build FEATURE-001', settingsFile, maxTurns: 7, timeoutS: 30, model: 'sonnet', claudeBin: f.bin });
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(r.result, 'finished');
  assert.deepEqual(r.usage, { in: 120, out: 45, cache_create: 300, cache_read: 9000 });
  assert.equal(r.turns, 2);
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.failure, null);
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
  const [e] = f.entries();
  assert.deepEqual(e.argv, ['-p', 'Build FEATURE-001', '--output-format', 'stream-json', '--verbose', '--max-turns', '7',
    '--settings', settingsFile, '--setting-sources', 'user', '--strict-mcp-config', '--permission-prompts', 'none', '--model', 'sonnet']);
  assert.ok(path.isAbsolute(e.argv[8]));
  assert.equal(e.stdin.devNull, true);
  assert.equal(e.stdin.fifo, false);
  assert.equal(e.cwd, cwd);
  assert.deepEqual(S.readBuilderResult(cwd, 'FEATURE-001'), { status: 'done', summary: 'implemented' });
});

test('runSession author: no tools, no session persistence; CLAUDE_CONFIG_DIR only when passed', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { fh, cwd, settingsFile } = setup(t, 'author');
  const base = { ...process.env, CLAUDE_CONFIG_DIR: '/parent/config' };
  await S.runSession({ role: 'author', cwd, prompt: 'Write scenarios', settingsFile, maxTurns: 3, timeoutS: 30, claudeBin: f.bin, baseEnv: base });
  const cfgDir = path.join(fh, 'claude-author');
  await S.runSession({ role: 'author', cwd, prompt: 'Write scenarios', settingsFile, maxTurns: 3, timeoutS: 30, claudeBin: f.bin, configDir: cfgDir, baseEnv: base });
  const [a, b] = f.entries();
  assert.deepEqual(a.argv, ['-p', 'Write scenarios', '--output-format', 'stream-json', '--verbose', '--max-turns', '3',
    '--settings', settingsFile, '--setting-sources', 'user', '--strict-mcp-config', '--permission-prompts', 'none', '--tools', '', '--no-session-persistence']);
  assert.ok(!a.envKeys.includes('CLAUDE_CONFIG_DIR'), 'parent CLAUDE_CONFIG_DIR leaked');
  assert.ok(b.envKeys.includes('CLAUDE_CONFIG_DIR'));
});

test('hs-merge-gate: runSession env: only the allowlist reaches claude (no GH_TOKEN, cloud keys, API keys)', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { cwd, settingsFile } = setup(t);
  const base = { ...process.env, GH_TOKEN: 'ghp_fake', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', ANTHROPIC_API_KEY: 'z', NPM_TOKEN: 'n', FACTORY_HOME: '/f', USER: 'u', LOGNAME: 'u', SHELL: '/bin/zsh' };
  await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, baseEnv: base });
  const [e] = f.entries();
  for (const k of e.envKeys) assert.ok(S.ENV_ALLOWLIST.includes(k) || k === 'FAKE_CLAUDE_DIR' || k === '__CF_USER_TEXT_ENCODING' || k === 'PWD' || k === 'SHLVL' || k === '_', `leaked ${k}`);
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'FACTORY_HOME']) assert.ok(!e.envKeys.includes(k), k);
  assert.ok(e.envKeys.includes('USER') && e.envKeys.includes('PATH'));
  assert.deepEqual(Object.keys(S.scrubEnv(base)).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER'].filter((k) => base[k] !== undefined));
});

test('runSession via PATH: the committed shim is found by name and the real claude is not called', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { cwd, settingsFile } = setup(t);
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, baseEnv: { ...process.env, PATH: `${f.dir}:${path.dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.equal(r.ok, true);
  assert.equal(f.entries().length, 1);
});

test('runSession blocked: builder result carries the question', async (t) => {
  const f = fake(t, { mode: 'blocked', feature: 'FEATURE-042' });
  const { cwd, settingsFile } = setup(t);
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin });
  assert.equal(r.ok, true);
  assert.deepEqual(S.readBuilderResult(cwd, 'FEATURE-042'), { status: 'blocked', question: 'Which database?', summary: 'stopped' });
});

test('runSession usage limit: is_error result with session-limit text is classified session with a reset time', async (t) => {
  const f = fake(t, { mode: 'usage-limit' });
  const { cwd, settingsFile } = setup(t);
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin });
  assert.equal(r.ok, false);
  assert.equal(r.failure.kind, 'session');
  assert.match(r.failure.resetAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(S.readBuilderResult(cwd, 'FEATURE-001'), { status: 'blocked', question: 'no_result' });
});

test('runSession rejected rate event: classified from the event, reset from its epoch', async (t) => {
  const f = fake(t, { mode: 'rejected-rate-event' });
  const { cwd, settingsFile } = setup(t);
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failure, { kind: 'session', resetAt: new Date(1900000000 * 1000).toISOString() });
});

test('runSession no result event / malformed stream / max turns: not ok, never throws', async (t) => {
  const { cwd, settingsFile } = setup(t);
  const nr = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: fake(t, { mode: 'no-result' }).bin });
  assert.equal(nr.ok, false); assert.deepEqual(nr.failure, { kind: 'no_result', resetAt: null });
  assert.equal(nr.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.equal(nr.turns, 1);
  const ms = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: fake(t, { mode: 'malformed-stream' }).bin });
  assert.equal(ms.ok, false); assert.equal(ms.failure.kind, 'no_result'); assert.equal(ms.sessionId, null); assert.equal(ms.result, null);
  const mt = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: fake(t, { mode: 'max-turns' }).bin });
  assert.equal(mt.ok, false); assert.equal(mt.failure.kind, 'max_turns');
  const missing = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: path.join(cwd, 'no-such-claude') });
  assert.equal(missing.ok, false); assert.equal(missing.failure.kind, 'spawn_failed');
});

test('runSession timeout: SIGTERM to the group, result timedOut, process gone', async (t) => {
  const f = fake(t, { mode: 'timeout' });
  const { cwd, settingsFile } = setup(t);
  const t0 = Date.now();
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 1, claudeBin: f.bin, killGraceMs: 3000 });
  assert.equal(r.timedOut, true); assert.equal(r.ok, false);
  assert.deepEqual(r.failure, { kind: 'timeout', resetAt: null });
  assert.ok(Date.now() - t0 < 3500, 'TERM should end it well before the KILL grace');
  assert.equal(r.sessionId, '00000000-0000-4000-8000-000000000001');
  assert.ok(await waitDead(f.entries()[0].pid, 2000));
});

test('runSession timeout: a TERM-ignoring claude and its grandchild are SIGKILLed after the grace', async (t) => {
  const f = fake(t, { mode: 'sleep-forever' });
  const { cwd, settingsFile } = setup(t);
  let pgid = null;
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 1, claudeBin: f.bin, killGraceMs: 300, onSpawn: (g) => { pgid = g.pgid; } });
  assert.equal(r.timedOut, true);
  assert.ok(Number.isInteger(pgid));
  const es = f.entries();
  const gc = es.find((e) => e.grandchild)?.grandchild;
  assert.ok(gc, 'grandchild pid recorded');
  assert.ok(await waitDead(es[0].pid, 3000), 'claude survived');
  assert.ok(await waitDead(gc, 3000), 'grandchild survived');
});

test('runSession: a session that exits normally has its leftover process group swept', async (t) => {
  const f = fake(t, { mode: 'orphan-on-exit' });
  const { cwd, settingsFile } = setup(t);
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin });
  assert.equal(r.ok, true); assert.equal(r.timedOut, false);
  const gc = f.entries().find((e) => e.grandchild).grandchild;
  const dead = await waitDead(gc, 2000);
  if (!dead) try { process.kill(gc, 'SIGKILL'); } catch { /* gone */ }
  assert.ok(dead, 'leftover child survived the session');
});

test('runSession output cap: an over-long line inside one chunk, and an unterminated over-long tail, are flagged', async (t) => {
  const { cwd, settingsFile } = setup(t);
  const long = JSON.stringify({ type: 'assistant', pad: 'y'.repeat(5000) }) + '\n';
  const a = fake(t, script([{ b: long + ev(RES) }]));
  const ra = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: a.bin, maxLineChars: 1000 });
  assert.equal(ra.truncated, true); assert.equal(ra.ok, true);
  const b = fake(t, script([{ b: ev(RES) + '{"type":"assistant","pad":"' + 'z'.repeat(5000) }]));
  const rb = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: b.bin, maxLineChars: 1000 });
  assert.equal(rb.truncated, true);
});

test('runSession output cap: a huge line is dropped and flagged, the result is still parsed', async (t) => {
  const f = fake(t, { mode: 'big-output', bigBytes: 6 * 1024 * 1024 });
  const { cwd, settingsFile } = setup(t);
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 60, claudeBin: f.bin, maxLineChars: 1024 * 1024 });
  assert.equal(r.truncated, true);
  assert.equal(r.ok, true);
  assert.equal(r.result, 'finished');
});

const script = (chunks, extra = {}) => ({ mode: 'script', chunks: chunks.map((c) => ({ b64: Buffer.isBuffer(c.b) ? c.b.toString('base64') : Buffer.from(c.b).toString('base64'), delayMs: c.d ?? 0 })), ...extra });
const ev = (o) => JSON.stringify(o) + '\n';
const RES = { type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'one', session_id: 'sid-1', usage: { input_tokens: 1, output_tokens: 2 } };

test('runSession stream parsing: split lines across chunks, invalid UTF-8, two results (last wins), result not last', async (t) => {
  const { cwd, settingsFile } = setup(t);
  const line = ev({ type: 'system', subtype: 'init', session_id: 'sid-1' });
  const f = fake(t, script([
    { b: line.slice(0, 10) }, { b: line.slice(10), d: 50 },
    { b: Buffer.concat([Buffer.from('{"type":"assistant","x":"'), Buffer.from([0xff, 0xfe, 0xe2, 0x82]), Buffer.from('"}\n')]) },
    { b: ev(RES) },
    { b: ev({ ...RES, result: 'two\u00e9', num_turns: 4, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 'NaN', cache_read_input_tokens: -5 } }).slice(0, 7) },
    { b: ev({ ...RES, result: 'two\u00e9', num_turns: 4, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 'NaN', cache_read_input_tokens: -5 } }).slice(7), d: 30 },
    { b: ev({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) },
  ]));
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin });
  assert.equal(r.ok, true);
  assert.equal(r.result, 'two\u00e9');
  assert.equal(r.turns, 4);
  assert.deepEqual(r.usage, { in: 10, out: 20, cache_create: 0, cache_read: 0 });
  assert.equal(r.sessionId, 'sid-1');
});

test('runSession: an is_error result without text is a failure of kind other; a hostile session id is dropped', async (t) => {
  const { cwd, settingsFile } = setup(t);
  const f = fake(t, script([{ b: ev({ type: 'system', subtype: 'init', session_id: '../../etc\npasswd' }) }, { b: ev({ type: 'result', subtype: 'success', is_error: true }) }]));
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin });
  assert.equal(r.ok, false);
  assert.deepEqual(r.failure, { kind: 'other', resetAt: null });
  assert.equal(r.sessionId, null);
  assert.equal(r.result, null);
});

test('runSession: a success result with a non-zero exit is not ok', async (t) => {
  const { cwd, settingsFile } = setup(t);
  const f = fake(t, script([{ b: ev(RES) }], { exitCode: 3 }));
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin });
  assert.equal(r.ok, false); assert.equal(r.failure.kind, 'other'); assert.equal(r.exitCode, 3);
});

test('runSession argument checks: injection-shaped prompt/model/settings and bad roles throw before spawning', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { fh, cwd, settingsFile } = setup(t);
  const ok = { role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 5, claudeBin: f.bin };
  const bad = [
    { prompt: '--dangerously-skip-permissions' }, { prompt: '-p' }, { prompt: 'x'.repeat(100001) }, { prompt: '' }, { prompt: 'a\0b' }, { prompt: 42 },
    { model: '--settings' }, { model: 'sonnet\n--x' }, { model: 'a b' },
    { settingsFile: 'rel.json' }, { settingsFile: '{"permissions":{}}' }, { settingsFile: S.settingsTemplate('builder') },
    { settingsFile: path.join(fh, 'missing.json') }, { settingsFile: `${settingsFile}\n--x` },
    { role: 'evaluator' }, { cwd: 'relative' }, { cwd: path.join(fh, 'nope') },
    { maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: '3' }, { timeoutS: 0 }, { timeoutS: Infinity },
    { configDir: path.join(fh, 'cfg') }, // builder never gets a config dir
    { claudeBin: 'claude --x' }, { claudeBin: 'rel/claude' },
  ];
  for (const b of bad) await assert.rejects(S.runSession({ ...ok, ...b }), TypeError, JSON.stringify(b));
  const link = path.join(fh, 'link.json'); fs.symlinkSync(settingsFile, link);
  await assert.rejects(S.runSession({ ...ok, settingsFile: link }), TypeError);
  const wide = path.join(fh, 'wide.json');
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); s.permissions.allow = ['Bash(gh *)'];
  fs.writeFileSync(wide, JSON.stringify(s));
  await assert.rejects(S.runSession({ ...ok, settingsFile: wide }), TypeError);
  assert.equal(f.entries().length, 0, 'nothing may be spawned');
  // a multi-line prompt with shell syntax is passed literally as one argument
  await S.runSession({ ...ok, prompt: 'line1\n$(touch pwned) `id` ; rm -rf x' });
  assert.equal(f.entries()[0].argv[1], 'line1\n$(touch pwned) `id` ; rm -rf x');
  assert.equal(fs.existsSync(path.join(cwd, 'pwned')), false);
});

test('runSession cleanup registry: a parent killed by SIGTERM takes the claude group with it', async (t) => {
  const f = fake(t, { mode: 'sleep-forever' });
  const { cwd, settingsFile } = setup(t);
  const driver = path.join(tmp(t), 'driver.mjs');
  fs.writeFileSync(driver, `import { runSession } from ${JSON.stringify(LIB)};
runSession({ role: 'builder', cwd: ${JSON.stringify(cwd)}, prompt: 'x', settingsFile: ${JSON.stringify(settingsFile)}, maxTurns: 1, timeoutS: 600, claudeBin: ${JSON.stringify(f.bin)}, onSpawn: () => process.stdout.write('spawned\\n') });`);
  const p = spawn(process.execPath, [driver], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => p.stdout.on('data', (d) => { if (String(d).includes('spawned')) res(); }));
  const end = Date.now() + 5000;
  while (Date.now() < end && !f.entries().some((e) => e.grandchild)) await sleep(50);
  const es = f.entries();
  const gc = es.find((e) => e.grandchild).grandchild;
  p.kill('SIGTERM');
  await new Promise((res) => p.on('exit', res));
  assert.ok(await waitDead(es[0].pid, 3000), 'claude orphaned');
  assert.ok(await waitDead(gc, 3000), 'grandchild orphaned');
});

// ---------------------------------------------------------------- readBuilderResult

const NO = { status: 'blocked', question: 'no_result' };
function clone(t) { return tmp(t, 'factory-result-'); }
function put(dir, id, content) {
  const d = path.join(dir, '.implementation', id); fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, 'result.json'); fs.writeFileSync(f, content); return f;
}

test('readBuilderResult: valid done/blocked, BOM tolerated, fields cleaned and capped, extras dropped', (t) => {
  const c = clone(t);
  put(c, 'FEATURE-1', JSON.stringify({ status: 'done', summary: 'ok', extra: 'x' }));
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-1'), { status: 'done', summary: 'ok' });
  put(c, 'FEATURE-2', '\ufeff' + JSON.stringify({ status: 'blocked', question: 'Q\u0000\u001b[31m?\u202e\u0085', summary: 's'.repeat(5000) }));
  const r = S.readBuilderResult(c, 'FEATURE-2');
  assert.equal(r.status, 'blocked'); assert.equal(r.question, 'Q[31m?'); assert.equal(r.summary.length, 2000);
  put(c, 'FEATURE-3', JSON.stringify({ status: 'blocked' }));
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-3'), { status: 'blocked', question: 'no_question' });
});

test('readBuilderResult: missing, malformed, wrong shapes, UTF-16, NUL, deep nesting, oversized => no_result', (t) => {
  const c = clone(t);
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-9'), NO);
  const cases = {
    'FEATURE-10': '{not json', 'FEATURE-11': '[]', 'FEATURE-12': '"done"', 'FEATURE-13': JSON.stringify({ status: 'passed' }),
    'FEATURE-14': JSON.stringify({ status: 'done', summary: 7 }), 'FEATURE-15': JSON.stringify({ status: 'done', question: { a: 1 } }),
    'FEATURE-16': Buffer.from('\ufeff' + JSON.stringify({ status: 'done' }), 'utf16le'), 'FEATURE-17': '{"status":"done"}\0',
    'FEATURE-18': '['.repeat(20000) + ']'.repeat(20000), 'FEATURE-19': JSON.stringify({ status: 'done', summary: 'x'.repeat(70 * 1024) }),
    'FEATURE-20': '', 'FEATURE-21': 'null', 'FEATURE-23': JSON.stringify({ status: 'done' }) + ' '.repeat(70 * 1024),
    'FEATURE-22': Buffer.concat([Buffer.from('{"status":"done","summary":"a'), Buffer.from([0xff, 0xc0]), Buffer.from('b"}')]),
  };
  for (const [id, content] of Object.entries(cases)) { put(c, id, content); assert.deepEqual(S.readBuilderResult(c, id), NO, id); }
});

test('readBuilderResult: symlinked file, dir or .implementation, FIFO and hard link are refused without hanging', (t) => {
  const c = clone(t); const outside = tmp(t, 'outside-');
  const secret = path.join(outside, 'r.json'); fs.writeFileSync(secret, JSON.stringify({ status: 'done', summary: 'leaked' }));
  fs.mkdirSync(path.join(c, '.implementation', 'FEATURE-1'), { recursive: true });
  fs.symlinkSync(secret, path.join(c, '.implementation', 'FEATURE-1', 'result.json'));
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-1'), NO);
  fs.mkdirSync(path.join(outside, 'FEATURE-2')); fs.writeFileSync(path.join(outside, 'FEATURE-2', 'result.json'), JSON.stringify({ status: 'done' }));
  fs.symlinkSync(path.join(outside, 'FEATURE-2'), path.join(c, '.implementation', 'FEATURE-2'));
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-2'), NO);
  const c2 = clone(t);
  fs.mkdirSync(path.join(outside, 'impl', 'FEATURE-3'), { recursive: true }); fs.writeFileSync(path.join(outside, 'impl', 'FEATURE-3', 'result.json'), JSON.stringify({ status: 'done' }));
  fs.symlinkSync(path.join(outside, 'impl'), path.join(c2, '.implementation'));
  assert.deepEqual(S.readBuilderResult(c2, 'FEATURE-3'), NO);
  fs.mkdirSync(path.join(c, '.implementation', 'FEATURE-4'));
  assert.equal(spawnSync('mkfifo', [path.join(c, '.implementation', 'FEATURE-4', 'result.json')]).status, 0);
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-4'), NO);
  fs.mkdirSync(path.join(c, '.implementation', 'FEATURE-5'));
  fs.linkSync(secret, path.join(c, '.implementation', 'FEATURE-5', 'result.json'));
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-5'), NO);
  fs.mkdirSync(path.join(c, '.implementation', 'FEATURE-6', 'result.json'), { recursive: true });
  assert.deepEqual(S.readBuilderResult(c, 'FEATURE-6'), NO);
});

test('readBuilderResult: the id must be FEATURE-<digits>', (t) => {
  const c = clone(t);
  for (const id of ['../x', 'FEATURE-', 'feature-1', 'FEATURE-1/..', 'FEATURE-1\n', '', null]) assert.throws(() => S.readBuilderResult(c, id), TypeError, String(id));
  assert.throws(() => S.readBuilderResult('relative', 'FEATURE-1'), TypeError);
});

// ---------------------------------------------------------------- prompts and implementer contract

test('renderPrompt: scenario-author placeholders filled in one pass; unknown or missing variables throw', () => {
  const p = S.renderPrompt('scenario-author', { FEATURE_ID: 'FEATURE-7', CANARY: 'fx-abc123', SPEC_SECTIONS: 'AC-1 uses {{CANARY}} literally' });
  assert.ok(p.includes('feature FEATURE-7') && p.includes('fx-abc123'));
  assert.ok(p.includes('AC-1 uses {{CANARY}} literally'), 'values must not be re-substituted');
  assert.ok(!/^-/.test(p));
  assert.throws(() => S.renderPrompt('scenario-author', { FEATURE_ID: 'FEATURE-7', CANARY: 'fx-abc123' }), /SPEC_SECTIONS/);
  assert.throws(() => S.renderPrompt('../settings/builder', {}), /prompt/);
});

test('renderPrompt: the continue brief names the feature, the step, the branch and ledger, and result.json; the implementer documents it', () => {
  const p = S.renderPrompt('continue-brief', { FEATURE_ID: 'FEATURE-7', STEP: 'fix' });
  assert.match(p, /interrupted fix step of FEATURE-7/);
  assert.match(p, /continue from the current branch and the `\.implementation\/FEATURE-7\/` ledger; finish with `result\.json`/);
  assert.ok(!/^-/.test(p));
  assert.throws(() => S.renderPrompt('continue-brief', { FEATURE_ID: 'FEATURE-7' }), /STEP/);
  const text = fs.readFileSync(path.join(REPO, 'skills', 'implementer', 'SKILL.md'), 'utf8');
  assert.match(text, /\*\*continue brief\*\*/); assert.match(text, /wip\(<ID>\): interrupted \(<kind>\)/);
});

test('implementer SKILL.md: --fix-brief input and the unattended result.json contract', () => {
  const text = fs.readFileSync(path.join(REPO, 'skills', 'implementer', 'SKILL.md'), 'utf8');
  assert.match(text, /--fix-brief <file>/);
  assert.match(text, /\.implementation\/<ID>\/result\.json/);
  assert.match(text, /"status": "done" \| "blocked"/);
  assert.match(text, /last act/i);
});

// ---------------------------------------------------------------- fix round 1

const userSettings = (t, obj) => {
  const home = tmp(t, 'user-home-');
  fs.mkdirSync(path.join(home, '.claude'));
  if (obj !== undefined) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
  return home;
};

test('user settings: an ALLOWLIST; anything else refuses the session before spawning, naming cleaned keys only', async (t) => {
  const f = fake(t, { mode: 'done' });
  const { cwd, settingsFile } = setup(t);
  const cases = [
    [{ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cat SECRETVALUE' }] }] } }, ['hooks']],
    [{ env: { GH_TOKEN: 'SECRETVALUE', DISABLE_TELEMETRY: '1', DISABLE_FOO: '1' } }, ['env.GH_TOKEN', 'env.DISABLE_FOO']],
    [{ apiKeyHelper: '/bin/SECRETVALUE', statusLine: {}, fileSuggestion: {}, subagentStatusLine: {} }, ['apiKeyHelper', 'statusLine', 'fileSuggestion', 'subagentStatusLine']],
    [{ permissions: { allow: ['Bash(gh *)'], additionalDirectories: ['/'], defaultMode: 'acceptEdits', deny: ['Bash(rm *)'] } }, ['permissions.allow', 'permissions.additionalDirectories', 'permissions.defaultMode']],
    [{ sandbox: { excludedCommands: ['git'], network: {}, enabled: true } }, ['sandbox.excludedCommands', 'sandbox.network', 'sandbox.enabled']],
    [{ enabledPlugins: { 'x@y': true } }, ['enabledPlugins']],
    [{ ['evil\nkey' + 'k'.repeat(100)]: 1 }, [('evil?key' + 'k'.repeat(100)).slice(0, 64)]],
    [{ model: 7, env: 'x', permissions: [] }, ['env', 'permissions', 'model']],
    ['{not json', ['settings.json (unparsable)']],
  ];
  for (const [obj, keys] of cases) {
    const home = userSettings(t, obj);
    const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, baseEnv: { ...process.env, HOME: home } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.failure, { kind: 'settings_unsafe', resetAt: null, keys }, JSON.stringify(obj));
    assert.ok(!JSON.stringify(r).includes('SECRETVALUE'));
  }
  assert.equal(f.entries().length, 0, 'nothing may be spawned');
  const fine = { $schema: 'x', model: 'opus', env: { DISABLE_TELEMETRY: '1', BASH_MAX_TIMEOUT_MS: '1' }, permissions: { deny: ['Bash(rm *)'] }, cleanupPeriodDays: 30, includeCoAuthoredBy: false, enabledPlugins: {}, sandbox: {} };
  for (const ok of [undefined, fine]) {
    const home = userSettings(t, ok);
    const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, baseEnv: { ...process.env, HOME: home } });
    assert.equal(r.ok, true, JSON.stringify(ok));
  }
});

test('user settings: a settings file inside the session cwd or tmpDir is refused', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { fh, cwd, settingsFile } = setup(t, 'author');
  const inCwd = path.join(cwd, 'cfg'); fs.mkdirSync(inCwd);
  const r = await S.runSession({ role: 'author', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, configDir: inCwd });
  assert.deepEqual(r.failure?.keys, ['settings.json (inside the session cwd or tmpDir)']);
  const td = path.join(fh, 'tmp'); fs.mkdirSync(path.join(td, '.claude'), { recursive: true });
  const r2 = await S.runSession({ role: 'author', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, tmpDir: td, baseEnv: { ...process.env, HOME: td } });
  assert.deepEqual(r2.failure?.keys, ['settings.json (inside the session cwd or tmpDir)']);
  const elsewhere = tmp(t, 'cfg-'); fs.symlinkSync(elsewhere, path.join(cwd, 'link'));
  fs.symlinkSync(inCwd, path.join(elsewhere, 'viaLink'));
  const r3 = await S.runSession({ role: 'author', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, configDir: path.join(elsewhere, 'viaLink') });
  assert.equal(r3.failure?.kind, 'settings_unsafe', 'realpath inside cwd');
});

test('materialiseSettings: every config dir entry except skills/agents/commands/memory file is read-denied (plugins too); unsafe names fail closed', (t) => {
  const fh = tmp(t, 'fh-'); const repo = tmp(t, 'repo-'); const home = tmp(t, 'home-'); const ext = tmp(t, 'ext-');
  const cd = path.join(home, '.claude');
  for (const d of ['skills', 'plugins', 'agents', 'commands', 'ide', 'ssh', 'brand-new-dir']) fs.mkdirSync(path.join(cd, d), { recursive: true });
  fs.writeFileSync(path.join(cd, 'ide', 'x.lock'), 'x'); fs.writeFileSync(path.join(cd, 'newthing.json'), '{}'); fs.writeFileSync(path.join(cd, 'CLAUDE.md'), 'x');
  fs.symlinkSync(ext, path.join(cd, 'linkdir')); fs.symlinkSync(path.join(ext, 'gone'), path.join(cd, 'dangling'));
  const s = JSON.parse(fs.readFileSync(S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), 'utf8'));
  for (const [n, forms] of [['ide', ['/**']], ['ssh', ['/**']], ['brand-new-dir', ['/**']], ['plugins', ['/**']], ['newthing.json', ['']], ['linkdir', ['/**']], ['dangling', ['', '/**']]]) {
    const abs = path.join(cd, n);
    assert.ok(s.sandbox.filesystem.denyRead.includes(abs), n);
    for (const f of forms) assert.ok(s.permissions.deny.includes(`Read(/${abs}${f})`), `${n}${f}`);
  }
  assert.ok(s.sandbox.filesystem.denyRead.includes(ext) && s.permissions.deny.includes(`Read(/${ext}/**)`), 'symlinked entry: real path denied as a dir');
  for (const n of ['skills', 'agents', 'commands', 'CLAUDE.md']) {
    const abs = path.join(cd, n);
    assert.ok(!s.sandbox.filesystem.denyRead.some((p) => p === abs || p.startsWith(abs + '/')), n);
    assert.ok(!s.permissions.deny.some((r) => r.startsWith(`Read(/${abs}`)), n);
  }
  assert.deepEqual(S.checkSettings(s), []);
  fs.writeFileSync(path.join(cd, 'bad*name'), 'x');
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), (e) => e.code === 'settings_unsafe');
  fs.rmSync(path.join(cd, 'bad*name'));
  fs.chmodSync(cd, 0o000);
  try {
    assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), (e) => e.code === 'settings_unsafe', 'an unlistable config dir fails closed');
  } finally { fs.chmodSync(cd, 0o755); }
});

test('materialiseSettings: HOME entries named .claude* (backups) are read-denied; the config dir itself is not', (t) => {
  const fh = tmp(t, 'fh-'); const repo = tmp(t, 'repo-'); const home = tmp(t, 'home-');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  for (const f of ['.claude.json.backup', '.claude.json.backup.1700000000', '.claude.json.corrupted.1']) fs.writeFileSync(path.join(home, f), '{}');
  fs.mkdirSync(path.join(home, '.claude-old'));
  const s = JSON.parse(fs.readFileSync(S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), 'utf8'));
  for (const f of ['.claude.json.backup', '.claude.json.backup.1700000000', '.claude.json.corrupted.1']) {
    assert.ok(s.sandbox.filesystem.denyRead.includes(path.join(home, f)) && s.permissions.deny.includes(`Read(/${path.join(home, f)})`), f);
  }
  assert.ok(s.permissions.deny.includes(`Read(/${path.join(home, '.claude-old')}/**)`));
  assert.ok(!s.sandbox.filesystem.denyRead.includes(path.join(home, '.claude')), 'the config dir is handled entry by entry');
  fs.writeFileSync(path.join(home, '.claude bad'), 'x');
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), (e) => e.code === 'settings_unsafe');
});

test('materialiseSettings: a symlinked write-denied path gets real-path Edit/Write/NotebookEdit twins; checkSettings requires an Edit twin for every denyWrite', (t) => {
  const fh = tmp(t, 'fh-'); const repo = tmp(t, 'repo-'); const home = tmp(t, 'home-'); const hooks = tmp(t, 'hooks-');
  fs.mkdirSync(path.join(repo, '.git')); fs.symlinkSync(hooks, path.join(repo, '.git', 'hooks'));
  const s = JSON.parse(fs.readFileSync(S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), 'utf8'));
  assert.ok(s.sandbox.filesystem.denyWrite.includes(hooks));
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) assert.ok(s.permissions.deny.includes(`${tool}(/${hooks}/**)`), tool);
  assert.deepEqual(S.checkSettings(s), []);
  const broken = JSON.parse(JSON.stringify(s));
  broken.permissions.deny = broken.permissions.deny.filter((r) => r !== `Edit(/${hooks}/**)`);
  assert.ok(S.checkSettings(broken).some((m) => /has no Edit deny/.test(m)));
  const tpl = readTemplate('builder'); tpl.permissions.deny = tpl.permissions.deny.filter((r) => r !== 'Edit(/{{CLAUDE_DIR}}/**)');
  assert.ok(S.checkSettings(tpl, { allowPlaceholders: true }).some((m) => /has no Edit deny/.test(m)));
});

test('materialiseSettings: read denies may not cover the repo, the run dir or a readable entry; a readable entry may not resolve into the repo', (t) => {
  const fh = tmp(t, 'fh-'); const repo = tmp(t, 'repo-'); const home = tmp(t, 'home-');
  fs.symlinkSync(repo, path.join(home, '.ssh'));
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), (e) => e.code === 'settings_unsafe', '~/.ssh -> repo');
  const home2 = tmp(t, 'home2-');
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home: home2, runDir: path.join(fh, 'run', 'r1') }), (e) => e.code === 'settings_unsafe', 'run dir under FACTORY_HOME');
  const ok = S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home: home2, runDir: tmp(t, 'run-') });
  assert.ok(fs.existsSync(ok));
  const home3 = tmp(t, 'home3-'); fs.mkdirSync(path.join(home3, '.claude')); fs.mkdirSync(path.join(repo, 'planted'));
  fs.symlinkSync(path.join(repo, 'planted'), path.join(home3, '.claude', 'skills'));
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home: home3 }), (e) => e.code === 'settings_unsafe', 'skills -> repo');
});

test('runSession home: one home for the lint and the child; PATH entries are compared resolved', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { cwd, settingsFile } = setup(t);
  const bad = userSettings(t, { hooks: { Stop: [] } });
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, home: bad });
  assert.deepEqual(r.failure, { kind: 'settings_unsafe', resetAt: null, keys: ['hooks'] });
  assert.equal(S.defaultHome({ HOME: '/h' }), '/h');
  assert.equal(S.scrubEnv({ PATH: `${path.dirname(cwd)}/./${path.basename(cwd)}/nobin:/usr/bin` }, { cwd }).PATH, '/usr/bin');
});


test('materialiseSettings: a symlinked credential dir is denied by its real path too', (t) => {
  const fh = tmp(t, 'fh-'); const repo = tmp(t, 'repo-'); const home = tmp(t, 'home-'); const keys = tmp(t, 'keys-');
  fs.symlinkSync(keys, path.join(home, '.ssh'));
  fs.writeFileSync(path.join(keys, 'npmrc'), 'x'); fs.symlinkSync(path.join(keys, 'npmrc'), path.join(home, '.npmrc'));
  const s = JSON.parse(fs.readFileSync(S.materialiseSettings('builder', { factoryHome: fh, repoDir: repo, home }), 'utf8'));
  assert.ok(s.sandbox.filesystem.denyRead.includes(keys) && s.permissions.deny.includes(`Read(/${keys}/**)`));
  assert.ok(s.sandbox.filesystem.denyRead.includes(path.join(keys, 'npmrc')) && s.permissions.deny.includes(`Read(/${path.join(keys, 'npmrc')})`));
  assert.deepEqual(S.checkSettings(s), []);
});

test('runSession: unknown options (e.g. the old maxLineBytes) are refused, not silently ignored', async (t) => {
  const { cwd, settingsFile } = setup(t);
  await assert.rejects(S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 5, maxLineBytes: 10 }), /unknown option maxLineBytes/);
});

test('user settings: the author with a configDir is linted against that dir, not HOME', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { fh, cwd, settingsFile } = setup(t, 'author');
  const cfg = path.join(fh, 'claude-author'); fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
  const home = userSettings(t, {});
  const r = await S.runSession({ role: 'author', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, configDir: cfg, baseEnv: { ...process.env, HOME: home } });
  assert.deepEqual(r.failure, { kind: 'settings_unsafe', resetAt: null, keys: ['hooks'] });
  const r2 = await S.runSession({ role: 'author', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, baseEnv: { ...process.env, HOME: home } });
  assert.equal(r2.ok, true);
});

test('materialiseSettings: a linked worktree (.git file) gets its gitdir and common dir denied, and the pointer file itself', (t) => {
  const fh = tmp(t, 'fh-'); const main = tmp(t, 'main-'); const wt = path.join(tmp(t, 'wtp-'), 'wt');
  const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  g(main, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(main, 'a'), '1'); g(main, 'add', '.'); g(main, '-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '-qm', 'x');
  g(main, 'worktree', 'add', '-q', wt, '-b', 'feat');
  const dirs = S.gitDirsOf(wt);
  assert.equal(dirs.gitFile, true);
  assert.equal(fs.realpathSync(dirs.common), fs.realpathSync(path.join(main, '.git')));
  const s = JSON.parse(fs.readFileSync(S.materialiseSettings('builder', { factoryHome: fh, repoDir: wt }), 'utf8'));
  const common = fs.realpathSync(path.join(main, '.git'));
  for (const part of ['config', 'hooks', 'info', 'commondir', 'config.worktree', 'objects/info', 'worktrees']) assert.ok(s.sandbox.filesystem.denyWrite.includes(`${common}/${part}`), part);
  assert.ok(s.sandbox.filesystem.denyWrite.some((p) => p.startsWith(`${common}/worktrees/wt`) || p.startsWith(`${dirs.gitdir}/`)), 'worktree gitdir parts');
  assert.ok(s.permissions.deny.includes(`Edit(/${common}/config)`));
  assert.ok(s.permissions.deny.includes(`Edit(/${wt}/.git)`) && s.sandbox.filesystem.denyWrite.includes(`${wt}/.git`));
  assert.ok(!s.sandbox.filesystem.denyWrite.includes(`${main}/.git`), 'a plain clone keeps its .git dir writable');
  const bad = tmp(t, 'bad-'); fs.symlinkSync(main, path.join(bad, '.git'));
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: bad }), /symlink/);
  const bad2 = tmp(t, 'bad2-'); fs.writeFileSync(path.join(bad2, '.git'), 'nonsense');
  assert.throws(() => S.materialiseSettings('builder', { factoryHome: fh, repoDir: bad2 }), /gitdir pointer/);
});

test('failure classification: max turns wins even with is_error; an unrelated error after a rejected rate event is not a limit', async (t) => {
  const { cwd, settingsFile } = setup(t);
  const a = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: fake(t, { mode: 'max-turns-error' }).bin });
  assert.deepEqual(a.failure, { kind: 'max_turns', resetAt: null });
  const b = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: fake(t, { mode: 'rejected-then-error' }).bin });
  assert.deepEqual(b.failure, { kind: 'other', resetAt: null });
  const c = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: fake(t, { mode: 'rejected-rate-event' }).bin });
  assert.equal(c.failure.kind, 'session', 'a plain is_error result after a rejected event is still a limit');
});

test('binary and PATH: relative PATH entries dropped; a claude inside cwd is refused; a missing one is spawn_failed', async (t) => {
  assert.equal(S.scrubEnv({ PATH: '.:bin::/usr/bin:./x:/bin' }).PATH, '/usr/bin:/bin');
  const { cwd, settingsFile } = setup(t);
  fs.symlinkSync(path.join(FAKE, 'claude'), path.join(cwd, 'claude'));
  fs.writeFileSync(path.join(cwd, 'fake.json'), JSON.stringify({ mode: 'echo-argv' }));
  const viaPath = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, baseEnv: { ...process.env, PATH: `${cwd}:${path.dirname(process.execPath)}:/usr/bin:/bin` } });
  assert.deepEqual(viaPath.failure, { kind: 'spawn_failed', resetAt: null }, 'a PATH entry inside cwd is dropped');
  assert.equal(S.scrubEnv({ PATH: `${cwd}:${cwd}/bin:/usr/bin` }, { cwd }).PATH, '/usr/bin');
  const abs = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: path.join(cwd, 'claude') });
  assert.deepEqual(abs.failure, { kind: 'unsafe_binary', resetAt: null });
  const rel = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, baseEnv: { ...process.env, PATH: `.:${path.dirname(process.execPath)}` } });
  assert.deepEqual(rel.failure, { kind: 'spawn_failed', resetAt: null }, 'the relative "." entry must not find ./claude');
});

test('tmpDir: TMPDIR for the session is the private dir the caller passes', async (t) => {
  const f = fake(t, { mode: 'echo-argv' });
  const { fh, cwd, settingsFile } = setup(t);
  const td = path.join(fh, 'run', 'tmp-1'); fs.mkdirSync(td, { recursive: true });
  await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, tmpDir: td });
  const { createHash } = await import('node:crypto');
  assert.equal(f.entries()[0].tmpdirHash, createHash('sha256').update(td).digest('hex'));
  await assert.rejects(S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 1, timeoutS: 30, claudeBin: f.bin, tmpDir: 'rel' }), TypeError);
});

test('readBuilderResult: tag characters, Arabic letter mark, Mongolian vowel separator and variation selectors are stripped', (t) => {
  const c = clone(t);
  const cp = (...x) => String.fromCodePoint(...x);
  put(c, 'FEATURE-30', JSON.stringify({ status: 'blocked', question: `a${cp(0xe0041, 0xe007f)}b${cp(0x061c)}c${cp(0x180e)}d${cp(0xfe0f)}e${cp(0xe0100)}f${cp(0x2028)}g${cp(0x2029, 0x200b, 0xad)}h${cp(0x034f, 0x115f, 0x1160, 0x3164, 0xffa0)}i${cp(0xe000, 0x0378, 0xe0000)}j${String.fromCharCode(0xd800)}k` }));
  assert.equal(S.readBuilderResult(c, 'FEATURE-30').question, 'abcdefghijk');
});

test('runSession abort: the flag set after 200 ms ends the session as stopped within 2 s and the group is gone', async (t) => {
  const f = fake(t, { mode: 'timeout' });
  const { cwd, settingsFile } = setup(t);
  const t0 = Date.now(); let flag = false; setTimeout(() => { flag = true; }, 200).unref();
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin, killGraceMs: 1000, abortPollMs: 20, shouldAbort: () => flag });
  assert.equal(r.ok, false); assert.equal(r.timedOut, false);
  assert.deepEqual(r.failure, { kind: 'stopped', resetAt: null });
  assert.ok(Date.now() - t0 < 2000, 'abort should end the session quickly');
  assert.ok(await waitDead(f.entries()[0].pid, 2000));
});

test('runSession abort: a Date.now jump of +1 hour mid-session does not trigger the timeout', async (t) => {
  const f = fake(t, { mode: 'timeout' });
  const { cwd, settingsFile } = setup(t);
  const realNow = Date.now; let jumped = false; let flag = false;
  setTimeout(() => { Date.now = () => realNow() + 3600e3; jumped = true; }, 100).unref();
  setTimeout(() => { flag = true; }, 700).unref();
  try {
    const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin, killGraceMs: 1000, abortPollMs: 20, shouldAbort: () => flag });
    assert.ok(jumped);
    assert.equal(r.timedOut, false); assert.equal(r.failure.kind, 'stopped');
  } finally { Date.now = realNow; }
});

test('runSession abort: a shouldAbort that throws is treated as false (the session runs to its natural timeout)', async (t) => {
  const f = fake(t, { mode: 'timeout' });
  const { cwd, settingsFile } = setup(t);
  let calls = 0;
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 1, claudeBin: f.bin, killGraceMs: 1000, abortPollMs: 10, shouldAbort: () => { calls++; throw new Error('boom'); } });
  assert.ok(calls > 0, 'shouldAbort was polled');
  assert.equal(r.timedOut, true); assert.equal(r.failure.kind, 'timeout');
});

test('runSession abort: with abortPollMs 100 shouldAbort is polled every 80-180 ms (cadence measured on the calls)', async (t) => {
  const f = fake(t, { mode: 'timeout' });
  const { cwd, settingsFile } = setup(t);
  const stamps = [];
  const r = await S.runSession({ role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 1, claudeBin: f.bin, killGraceMs: 300, abortPollMs: 100, shouldAbort: () => { stamps.push(process.hrtime.bigint()); return false; } });
  assert.equal(r.failure.kind, 'timeout');
  assert.ok(stamps.length >= 5, `only ${stamps.length} polls`);
  for (let i = 1; i < stamps.length; i++) {
    const gap = Number(stamps[i] - stamps[i - 1]) / 1e6;
    assert.ok(gap >= 80 && gap <= 180, `poll gap ${gap.toFixed(0)} ms`);
  }
});

test('runSession abort: bad abort options throw', async (t) => {
  const f = fake(t, { mode: 'done' });
  const { cwd, settingsFile } = setup(t);
  const base = { role: 'builder', cwd, prompt: 'x', settingsFile, maxTurns: 5, timeoutS: 30, claudeBin: f.bin };
  await assert.rejects(S.runSession({ ...base, shouldAbort: 'yes' }), TypeError);
  await assert.rejects(S.runSession({ ...base, abortPollMs: 9 }), TypeError);
  await assert.rejects(S.runSession({ ...base, abortPollMs: 1.5 }), TypeError);
});
