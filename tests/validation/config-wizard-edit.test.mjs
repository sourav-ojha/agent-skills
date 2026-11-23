// `deliver config set|unset` and the editing core (lib/configedit.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SCRIPTS = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts');
const DELIVER = path.join(SCRIPTS, 'deliver.mjs');
const E = await import(path.join(SCRIPTS, 'lib', 'configedit.mjs'));
const { runConfigCommand } = await import(path.join(SCRIPTS, 'lib', 'configcmd.mjs'));
const { entry, SCHEMA } = await import(path.join(SCRIPTS, 'lib', 'configschema.mjs'));

const project = (doc) => {
  const dir = tmpDir('cfg-edit-');
  fs.mkdirSync(path.join(dir, '.product'));
  const file = path.join(dir, '.product', 'delivery.json');
  if (doc !== undefined) fs.writeFileSync(file, typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  return { dir, file };
};
const cli = (dir, ...args) => {
  const r = spawnSync('node', [DELIVER, 'config', ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: path.join(dir, 'fhome') } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const run = async (dir, sub, args, { tty = false, answer = 'yes', opt = {}, home } = {}) => {
  const out = [], err = [], asked = [];
  const code = await runConfigCommand({ sub, args, opt, root: dir, home: home || path.join(dir, 'fhome'), tty, io: { out: (t) => out.push(t), err: (t) => err.push(t), ask: async (p) => { asked.push(p); return answer; } } });
  return { code, out: out.join('\n'), err: err.join('\n'), asked };
};

test('set writes 2-space JSON with trailing newline and reports old and new', () => {
  const { dir, file } = project({ version: 1 });
  const r = cli(dir, 'set', 'base', 'develop');
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "version": 1,\n  "base": "develop"\n}\n');
  const o = JSON.parse(r.out);
  assert.equal(o.key, 'base'); assert.equal(o.old, null); assert.equal(o.new, 'develop'); assert.deepEqual(o.warnings, []);
});

test('set creates nested objects and a missing file', () => {
  const dir = tmpDir('cfg-edit-');
  const r = cli(dir, 'set', 'budgets.feature.tokens', '2000000');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.product', 'delivery.json'), 'utf8')), { budgets: { feature: { tokens: 2000000 } } });
  assert.equal(JSON.parse(r.out).new, 2000000);
  assert.equal(cli(dir, 'set', 'budgets.feature.tokens', '4000000').code, 1); // raising the cap needs a person
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
});

test('wrong-typed values are refused with the parser message and the file is unchanged', () => {
  const { dir, file } = project({ version: 1 });
  const before = fs.readFileSync(file);
  for (const [k, v] of [['budgets.feature.tokens', '"5"'], ['checks.required', '"x"']]) {
    const r = cli(dir, 'set', k, v);
    assert.equal(r.code, 1, k);
    assert.match(r.err, k.startsWith('budgets') ? /an integer/ : /list/);
    assert.deepEqual(fs.readFileSync(file), before);
  }
});

test('a mistyped key is refused with the nearest keys and nothing is written', () => {
  const { dir, file } = project({ version: 1 });
  const before = fs.readFileSync(file);
  const r = cli(dir, 'set', 'autonomy.levl', 'L0');
  assert.equal(r.code, 1);
  assert.match(r.err, /autonomy\.level/);
  assert.ok(r.err.split('did you mean ')[1].split(',').length <= 3);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('merge.mode is an alias: writes autonomy.level and removes merge.mode', async () => {
  const { dir, file } = project({ version: 1, merge: { mode: 'pr-only', allow_tier3: false } });
  let r = await run(dir, 'set', ['merge.mode', 'squash'], { tty: true });
  assert.equal(r.code, 0, r.err);
  let doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.autonomy.level, 'L1'); assert.equal('mode' in doc.merge, false); assert.equal(doc.merge.allow_tier3, false);
  r = await run(dir, 'set', ['merge.mode', 'pr-only']);
  assert.equal(r.code, 0, r.err);
  doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.autonomy.level, 'L0'); assert.equal('mode' in (doc.merge || {}), false);
});

test('merge.mode squash without a TTY is refused as a loosening', async () => {
  const { dir, file } = project({ version: 1 });
  const before = fs.readFileSync(file);
  const r = await run(dir, 'set', ['merge.mode', 'squash']);
  assert.equal(r.code, 1);
  assert.match(r.err, /config edit/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('no TTY: loosening is refused, tightening works', () => {
  const { dir, file } = project({ version: 1, autonomy: { level: 'L1' }, verification: { required: true }, protected_branches: ['main', 'prod'] });
  const before = fs.readFileSync(file);
  for (const [k, v] of [['autonomy.level', 'L1'], ['verification.required', 'false'], ['protected_branches', '["main"]']]) {
    fs.writeFileSync(file, before);
    if (k === 'autonomy.level') fs.writeFileSync(file, JSON.stringify({ version: 1 }));
    const b = fs.readFileSync(file);
    const r = cli(dir, 'set', k, v);
    assert.equal(r.code, 1, k);
    assert.match(r.err, /person must run .*config edit/, k);
    assert.deepEqual(fs.readFileSync(file), b);
  }
  fs.writeFileSync(file, before);
  assert.equal(cli(dir, 'set', 'autonomy.level', 'L0').code, 0);
  assert.equal(cli(dir, 'set', 'verification.required', 'true').code, 0);
  assert.equal(cli(dir, 'set', 'protected_branches', '["main","prod","staging"]').code, 0);
  assert.equal(cli(dir, 'set', 'verification.required', 'false').code, 1);
});

test('TTY: loosening needs the literal answer yes', async () => {
  const { dir, file } = project({ version: 1 });
  const before = fs.readFileSync(file);
  let r = await run(dir, 'set', ['autonomy.level', 'L1'], { tty: true, answer: 'y' });
  assert.equal(r.code, 1); assert.equal(r.asked.length, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  r = await run(dir, 'set', ['autonomy.level', 'L1'], { tty: true, answer: 'yes' });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).autonomy.level, 'L1');
});

test('loosens rules', () => {
  const L = (path_, b, a) => E.loosens(entry(path_), b, a);
  const cfg = (o) => o;
  assert.ok(L('merge.allow_tier3', { merge: { allow_tier3: false } }, { merge: { allow_tier3: true } }));
  assert.equal(L('merge.allow_tier3', { merge: { allow_tier3: true } }, { merge: { allow_tier3: false } }), null);
  assert.ok(L('checks.ignored', { checks: { ignored: [] } }, { checks: { ignored: ['x'] } }));
  assert.equal(L('checks.ignored', { checks: { ignored: ['x'] } }, { checks: { ignored: [] } }), null);
  assert.ok(L('hold_paths', { hold_paths: ['a/'] }, { hold_paths: [] }));
  assert.equal(L('hold_paths', { hold_paths: [] }, { hold_paths: ['a/'] }), null);
  assert.ok(L('local_checks', { local_checks: [] }, { local_checks: [{ name: 'a', command: ['x'], timeout_s: 9 }] }));
  assert.ok(L('local_checks', { local_checks: [{ name: 'a', command: ['x'], timeout_s: 9 }] }, { local_checks: [{ name: 'a', command: ['y'], timeout_s: 9 }] }));
  assert.equal(L('local_checks', { local_checks: [{ name: 'a', command: ['x'], timeout_s: 9 }] }, { local_checks: [] }), null);
  assert.ok(L('verification.scenario_approval', { verification: { scenario_approval: 'human' } }, { verification: { scenario_approval: 'auto' } }));
  assert.ok(L('budgets.feature.turns', { budgets: { feature: { turns: 400 } } }, { budgets: { feature: { turns: 500 } } }));
  assert.equal(L('budgets.feature.turns', { budgets: { feature: { turns: 400 } } }, { budgets: { feature: { turns: 300 } } }), null);
  assert.equal(L('base', cfg({ base: 'a' }), cfg({ base: 'b' })), null);
});

test('unset: removing protected_branches reverts to a default and is checked on the effective value', async () => {
  const { dir, file } = project({ version: 1, protected_branches: ['main', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'main2', 'prod', 'master', 'production', 'release/*', 'release-*', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen'] });
  const r = await run(dir, 'unset', ['protected_branches']);
  assert.equal(r.code, 1);
  assert.match(r.err, /config edit/);
  assert.ok(fs.readFileSync(file, 'utf8').includes('"seventeen"'));
});

test('unset removes the key and prunes empty parents; absent key exits 0 and says so', () => {
  const { dir, file } = project({ version: 1, app: { ready: { url: 'http://127.0.0.1:3000/' }, base_url: 'http://127.0.0.1:3000' } });
  let r = cli(dir, 'unset', 'app.ready');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, app: { base_url: 'http://127.0.0.1:3000' } });
  r = cli(dir, 'unset', 'app.base_url');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1 });
  r = cli(dir, 'unset', 'base');
  assert.equal(r.code, 0);
  assert.match(r.out, /not set/);
});

test('unset of a loosening key without a TTY is refused; an unknown key is refused', () => {
  const { dir } = project({ version: 1, hold_paths: ['docs/'] });
  const r = cli(dir, 'unset', 'hold_paths');
  assert.equal(r.code, 1); assert.match(r.err, /config edit/);
  assert.equal(cli(dir, 'unset', 'hold_path').code, 1);
});

test('a stale sha or a symlink refuses the write (unit)', () => {
  const { dir, file } = project({ version: 1 });
  const read = E.readDoc(file);
  fs.writeFileSync(file, '{"version":1,"base":"other"}\n');
  assert.throws(() => E.writeDoc(file, { version: 1, base: 'mine' }, { sha: read.sha, mode: 0o644 }), /changed/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).base, 'other');
  assert.deepEqual(fs.readdirSync(path.join(dir, '.product')), ['delivery.json']);
  // a file that must not exist yet
  const fresh = path.join(dir, '.product', 'new.json');
  fs.writeFileSync(fresh, '{}');
  assert.throws(() => E.writeDoc(fresh, {}, { sha: null, mode: 0o644 }), /changed/);
  // symlinked file
  const real = path.join(dir, 'real.json'); fs.writeFileSync(real, '{}\n');
  const link = path.join(dir, '.product', 'link.json'); fs.symlinkSync(real, link);
  assert.throws(() => E.readDoc(link), /symlink/);
  assert.throws(() => E.writeDoc(link, {}, { sha: E.readDoc(real).sha, mode: 0o644 }), /symlink/);
  // symlinked folder
  const d2 = tmpDir('cfg-edit-'); const realDir = path.join(d2, 'real'); fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, path.join(d2, '.product'));
  assert.throws(() => E.writeDoc(path.join(d2, '.product', 'delivery.json'), {}, { sha: null, mode: 0o644 }), /symlink/);
  assert.deepEqual(fs.readdirSync(realDir), []);
});

test('symlinked config and folder make the CLI exit 1', () => {
  const dir = tmpDir('cfg-edit-'); const real = path.join(dir, 'elsewhere'); fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(dir, '.product'));
  const r = cli(dir, 'set', 'base', 'x');
  assert.equal(r.code, 1); assert.match(r.err, /symlink/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test('writeDoc modes and no leftover temp files', () => {
  const dir = tmpDir('cfg-edit-');
  const a = path.join(dir, 'a', 'x.json'), b = path.join(dir, 'b', 'y.json');
  E.writeDoc(a, { v: 1 }, { sha: null, mode: 0o644 });
  E.writeDoc(b, { v: 1 }, { sha: null, mode: 0o600 });
  assert.equal(fs.statSync(a).mode & 0o777, 0o644);
  assert.equal(fs.statSync(b).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(a)), ['x.json']);
});

test('unrelated existing errors: a clean change succeeds and prints warnings; invalid JSON is refused', () => {
  const { dir, file } = project({ version: 1, bogus: true });
  const r = cli(dir, 'set', 'base', 'develop');
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out);
  assert.equal(o.warnings.length, 1); assert.match(o.warnings[0], /bogus/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).base, 'develop');
  fs.writeFileSync(file, '{ not json');
  const r2 = cli(dir, 'set', 'base', 'x');
  assert.equal(r2.code, 1); assert.match(r2.err, /delivery\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('--local edits <home>/config.json with mode 0600', () => {
  const dir = tmpDir('cfg-edit-');
  const r = cli(dir, 'set', 'max_wait_h', '4', '--local');
  assert.equal(r.code, 0, r.err);
  const f = path.join(dir, 'fhome', 'config.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { max_wait_h: 4 });
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(cli(dir, 'set', 'wait_for_reset', 'true', '--local').code, 1);
  assert.equal(cli(dir, 'set', 'budgets.day_tokens', '20000000', '--local').code, 0); // adding a cap tightens
  assert.equal(cli(dir, 'set', 'budgets.day_tokens', '30000000', '--local').code, 1); // raising it needs a person
  assert.equal(cli(dir, 'unset', 'budgets.day_tokens', '--local').code, 1); // no cap at all needs a person
  assert.equal(fs.existsSync(path.join(dir, '.product')), false);
});

test('pure helpers', () => {
  assert.deepEqual(E.setPath({ a: 1 }, 'b.c', 2), { a: 1, b: { c: 2 } });
  const orig = { a: { b: 1 } };
  E.setPath(orig, 'a.b', 2); assert.equal(orig.a.b, 1);
  assert.deepEqual(E.unsetPath({ a: { b: { c: 1 } }, d: 1 }, 'a.b.c'), { d: 1 });
  assert.equal(E.getPath({ a: { b: 3 } }, 'a.b'), 3);
  assert.equal(E.getPath({}, 'a.b'), undefined);
  assert.equal(E.parseValue('4'), 4); assert.equal(E.parseValue('develop'), 'develop'); assert.deepEqual(E.parseValue('["a"]'), ['a']);
  assert.deepEqual(E.diffLines({ a: 1 }, { a: 2 }), ['-   "a": 1', '+   "a": 2']);
  assert.equal(E.validateChange({ version: 1 }, { version: 1, base: 5 }, 'project').ok, false);
  assert.equal(E.validateChange({ bogus: 1 }, { bogus: 1, base: 'x' }, 'project').ok, true);
});

test('set to the value a list already has exits 0, changed:false, file untouched', () => {
  const { dir, file } = project({ version: 1, protected_branches: ['main'] });
  const b = fs.readFileSync(file), st = fs.statSync(file);
  const r = cli(dir, 'set', 'protected_branches', '["main"]');
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).changed, false);
  const st2 = fs.statSync(file);
  assert.deepEqual(fs.readFileSync(file), b);
  assert.equal(st2.ino, st.ino); assert.equal(st2.mtimeMs, st.mtimeMs);
  assert.equal(JSON.parse(cli(dir, 'set', 'base', 'x').out).changed, true);
});

test('command, required-check and test-glob changes are loosenings', () => {
  const L = (p, b, a) => E.loosens(entry(p), b, a);
  const cmd = (k, v) => { const [g, n] = k.split('.'); return { [g]: { [n]: v } }; };
  for (const k of ['app.setup', 'app.start', 'app.stop', 'app.seed', 'tests.setup', 'tests.all']) {
    assert.equal(L(k, cmd(k, null), cmd(k, ['a'])), 'changes a command that runs as you', k);
    assert.ok(L(k, cmd(k, ['a']), cmd(k, ['b'])), k);
    assert.ok(L(k, cmd(k, ['a']), cmd(k, null)), k);
    assert.equal(L(k, cmd(k, ['a']), cmd(k, ['a'])), null, k);
  }
  assert.ok(L('checks.required', { checks: { required: ['a', 'b'] } }, { checks: { required: ['a'] } }));
  assert.ok(L('checks.required', { checks: { required: ['a'] } }, { checks: { required: [] } }));
  assert.equal(L('checks.required', { checks: { required: [] } }, { checks: { required: ['a'] } }), null);
  assert.ok(L('verification.test_globs', { verification: { test_globs: ['t/'] } }, { verification: { test_globs: [] } }));
  assert.equal(L('verification.test_globs', { verification: { test_globs: [] } }, { verification: { test_globs: ['t/'] } }), null);
});

test('a sensitive key without an explicit rule fails closed; every sensitive key has a loosening example', () => {
  assert.equal(E.loosens({ path: 'x.y', type: 'bool', sensitive: true }, { x: { y: false } }, { x: { y: true } }), 'changes a sensitive setting');
  assert.equal(E.loosens({ path: 'x.y', type: 'bool', sensitive: false }, { x: { y: false } }, { x: { y: true } }), null);
  const o = (p, v) => p.split('.').reduceRight((acc, k) => ({ [k]: acc }), v);
  const ex = {
    'autonomy.level': ['L0', 'L1'], 'merge.mode': ['pr-only', 'squash'], 'merge.allow_tier3': [false, true], 'checks.allow_without_ci': [false, true],
    protected_branches: [['main'], []], hold_paths: [['a/'], []], 'checks.required': [['a'], []], 'checks.ignored': [[], ['a']],
    local_checks: [[], [{ name: 'a', command: ['x'], timeout_s: 9 }]], 'verification.test_globs': [['t/'], []],
    'verification.required': [true, false], 'verification.scenario_approval': ['human', 'auto'],
    'budgets.feature.tokens': [1000000, 2000000], 'budgets.feature.turns': [100, 200], 'budgets.day_tokens': [20000000, 30000000],
    'app.setup': [['a'], ['b']], 'app.start': [['a'], ['b']], 'app.stop': [['a'], ['b']], 'app.seed': [['a'], ['b']], 'tests.setup': [['a'], ['b']], 'tests.all': [['a'], ['b']],
  };
  for (const e of SCHEMA.filter((x) => x.sensitive)) {
    assert.ok(ex[e.path], `sensitive key ${e.path} needs a loosening example`);
    const [b, a] = ex[e.path];
    const t = e.alias ? e.alias.to : e.path;
    const [bv, av] = e.alias ? [e.alias.map[b], e.alias.map[a]] : [b, a];
    assert.ok(E.loosens(e, o(t, bv), o(t, av)), e.path);
  }
});

// ---- wizard: parseAnswer, walk, init, edit -------------------------------------------------------------------------
const W = await import(path.join(SCRIPTS, 'lib', 'wizard.mjs'));
const { GROUPS } = await import(path.join(SCRIPTS, 'lib', 'configschema.mjs'));
const ENTRIES = GROUPS.flatMap((g) => SCHEMA.filter((x) => x.file === 'project' && x.group === g));
const scripted = (answers) => {
  const out = [], asked = [];
  return { out, asked, io: { out: (t) => out.push(t), err: (t) => out.push(t), ask: async (p) => { asked.push(p); return answers.shift(); } } };
};
const walk = (doc, answers, extra = {}) => {
  const s = scripted([...answers]);
  const p = W.walk({ entries: ENTRIES, doc, io: s.io, validateChange: (b, a) => E.validateChange(b, a, 'project'), loosens: (e, b, a) => E.loosens(e, E.effective(b, 'project'), E.effective(a, 'project')), ...extra });
  return p.then((r) => ({ ...r, ...s }));
};

test('parseAnswer: keep, choose, unset, help, skip, quit', () => {
  const lvl = entry('autonomy.level');
  assert.equal(W.parseAnswer(lvl, '', 'L0').action, 'keep');
  assert.deepEqual(W.parseAnswer(lvl, '2', 'L0'), { action: 'set', value: 'L1' });
  const bad = W.parseAnswer(lvl, '9', 'L0');
  assert.equal(bad.action, 'invalid'); assert.match(bad.message, /1-2/);
  assert.equal(W.parseAnswer(entry('base'), '-', 'x').action, 'unset');
  assert.equal(W.parseAnswer(lvl, '-', 'L0').action, 'invalid');
  assert.equal(W.parseAnswer(lvl, '?', 'L0').action, 'help');
  assert.equal(W.parseAnswer(lvl, 's', 'L0').action, 'skip-group');
  assert.equal(W.parseAnswer(lvl, 'q', 'L0').action, 'quit');
});

test('parseAnswer: int bounds, text length, list and argv forms', () => {
  const n = entry('limits.max_fix_rounds');
  assert.deepEqual(W.parseAnswer(n, '3', 2), { action: 'set', value: 3 });
  for (const t of ['abc', '9', '-1']) { const r = W.parseAnswer(n, t, 2); assert.equal(r.action, 'invalid', t); assert.match(r.message, /0 to 5/); }
  assert.equal(W.parseAnswer(entry('implementer_notes'), 'x'.repeat(501), '').action, 'invalid');
  assert.deepEqual(W.parseAnswer(entry('hold_paths'), '["a/","b"]', []), { action: 'set', value: ['a/', 'b'] });
  assert.deepEqual(W.parseAnswer(entry('hold_paths'), '+ c/', ['a/']), { action: 'set', value: ['a/', 'c/'] });
  assert.deepEqual(W.parseAnswer(entry('hold_paths'), '- a/', ['a/', 'b']), { action: 'set', value: ['b'] });
  assert.equal(W.parseAnswer(entry('hold_paths'), '- zzz', ['a/']).action, 'invalid');
  assert.deepEqual(W.parseAnswer(entry('app.start'), '["npm","start"]', null), { action: 'set', value: ['npm', 'start'] });
  assert.equal(W.parseAnswer(entry('hold_paths'), '[1', []).action, 'invalid');
  assert.deepEqual(W.parseAnswer(entry('app.base_url'), '4000', null), { action: 'set', value: 'http://127.0.0.1:4000' });
  assert.equal(W.parseAnswer(entry('app.base_url'), 'http://localhost:4000/x', null).value, 'http://localhost:4000/x');
  assert.equal(W.parseAnswer(entry('app.base_url'), 'https://example.com', null).action, 'invalid');
});

test('renderPrompt shows the design layout', () => {
  const t = W.renderPrompt(entry('autonomy.level'), 'L0');
  assert.match(t, /^autonomy\.level {3}\(current: L0, default: L0\) {3}SENSITIVE/);
  assert.match(t, /1\) L0 {3}PRs only; nothing is merged/);
  assert.match(t, /Enter keep {3}1-2 choose {3}\? more {3}s skip group {3}q quit without saving/);
  assert.match(W.renderPrompt(entry('base'), undefined), /- unset/);
});

test('walk: keeping everything changes nothing', async () => {
  const doc = { version: 1, base: 'develop' };
  const r = await walk(doc, new Array(200).fill(''));
  assert.deepEqual(r.changed, []); assert.deepEqual(r.doc, doc); assert.equal(r.quit, false);
});

test('walk: a loosening needs the literal yes; any other answer keeps the old value', async () => {
  const no = await walk({ autonomy: { level: 'L0' } }, ['2', 'no'], { only: 'autonomy.level' });
  assert.equal(no.doc.autonomy.level, 'L0'); assert.deepEqual(no.changed, []);
  assert.ok(no.out.some((l) => /squash-merge without a person/.test(l)));
  const yes = await walk({ autonomy: { level: 'L0' } }, ['2', 'yes'], { only: 'autonomy.level' });
  assert.equal(yes.doc.autonomy.level, 'L1'); assert.deepEqual(yes.changed, ['autonomy.level']);
  const tight = await walk({ autonomy: { level: 'L1' } }, ['1'], { only: 'autonomy.level' });
  assert.equal(tight.doc.autonomy.level, 'L0'); assert.equal(tight.asked.length, 1);
});

test('walk: q quits, an invalid answer re-asks the same key, s skips the group', async () => {
  const q = await walk({}, ['q']);
  assert.equal(q.quit, true);
  const re = await walk({}, ['9', '3'], { only: 'limits.max_fix_rounds' });
  assert.equal(re.doc.limits.max_fix_rounds, 3); assert.equal(re.asked.length, 2);
  const quoted = await walk({}, ['"x"'], { only: 'github.host' });
  assert.equal(quoted.doc.github.host, 'x');
  const skip = await walk({}, ['s', 'q']);
  assert.ok(skip.out.join('\n').includes('protected_branches')); // went on to the next group
  assert.equal(skip.asked.length, 2);
});

test('walk: a validateChange rejection re-asks', async () => {
  const r = await walk({}, ['/etc', '..', 'docs'], { only: 'features_dir' });
  assert.equal(r.doc.features_dir, 'docs'); assert.equal(r.asked.length, 3);
});

test('walk cross-key: app.ready, app.base_url port, autonomy.level drops merge.mode', async () => {
  const a = await walk({ app: { base_url: 'http://127.0.0.1:3000', ready: { log_pattern: 'up', timeout_s: 30 } } }, ['1', '', '45'], { only: 'app.ready' });
  assert.deepEqual(a.doc.app.ready, { url: 'http://127.0.0.1:3000', timeout_s: 45 });
  assert.ok(a.asked.some((x) => x.includes('3000'))); // the base_url port is offered
  const b = await walk({}, ['4000'], { only: 'app.base_url' });
  assert.equal(b.doc.app.base_url, 'http://127.0.0.1:4000');
  const c = await walk({ merge: { mode: 'pr-only' }, autonomy: { level: 'L0' } }, ['1'], { only: 'autonomy.level' });
  assert.equal(c.doc.merge, undefined); assert.equal(c.doc.autonomy.level, 'L0');
  const d = await walk({ app: { ready: { url: 'http://127.0.0.1:3000' } } }, ['2', 'Listening on', ''], { only: 'app.ready' });
  assert.deepEqual(d.doc.app.ready, { log_pattern: 'Listening on', timeout_s: 120 });
});

test('walk: readiness children only when present or opted in; verification.required pulls factory keys', async () => {
  const off = await walk({}, ['n'], { only: 'readiness' });
  assert.equal(off.doc.readiness, undefined); assert.equal(off.asked.length, 1);
  const on = await walk({}, ['y', '', ''], { only: 'readiness' });
  assert.deepEqual(on.doc.readiness, {});
  assert.equal(on.asked.length, 3);
  const pulled = await walk({}, ['1', '["npm","start"]', 'yes', '4000', '1', '', '', 'y', '', ''], { only: 'verification.required' });
  assert.equal(pulled.doc.verification.required, true);
  assert.deepEqual(pulled.doc.app.start, ['npm', 'start']);
  assert.equal(pulled.doc.app.base_url, 'http://127.0.0.1:4000');
  assert.equal(pulled.doc.app.ready.url, 'http://127.0.0.1:4000');
  assert.equal(pulled.doc.readiness.min_level, 4);
  assert.ok(pulled.changed.includes('readiness.min_level'));
});

test('walk: local_checks keep / replace / clear', async () => {
  const lc = [{ name: 'lint', command: ['npm', 'run', 'lint'], timeout_s: 60 }];
  const clear = await walk({ local_checks: lc }, ['clear'], { only: 'local_checks' });
  assert.deepEqual(clear.doc.local_checks, []);
  const keep = await walk({ local_checks: lc }, [''], { only: 'local_checks' });
  assert.deepEqual(keep.doc.local_checks, lc);
});

test('wizard.mjs has no import at all', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'lib', 'wizard.mjs'), 'utf8');
  assert.deepEqual(src.split('\n').filter((l) => /^\s*import\b|\bimport\s*\(|\brequire\s*\(/.test(l) && !/^\s*\/\//.test(l)), []);
  assert.ok(src.split('\n').length <= 350);
});

test('walk: app.ready timeout is validated like an int, and q quits', async () => {
  const doc = { app: { base_url: 'http://127.0.0.1:3000' } };
  const r = await walk(doc, ['1', '', 'abc', '9999', '30'], { only: 'app.ready' });
  assert.deepEqual(r.doc.app.ready, { url: 'http://127.0.0.1:3000', timeout_s: 30 });
  assert.ok(r.out.some((l) => /1 to 600/.test(l)));
  const q = await walk(doc, ['2', 'q'], { only: 'app.ready' });
  assert.equal(q.quit, true); assert.equal(q.doc.app.ready, undefined);
  const qt = await walk(doc, ['1', '', 'q'], { only: 'app.ready' });
  assert.equal(qt.quit, true);
});

test('walk: local_checks replace with a JSON line', async () => {
  const line = JSON.stringify([{ name: 'lint', command: ['npm', 'run', 'lint'], timeout_s: 60 }]);
  const r = await walk({}, [line, 'yes'], { only: 'local_checks' });
  assert.equal(r.doc.local_checks[0].name, 'lint'); assert.deepEqual(r.changed, ['local_checks']);
});

// Walk answers run out as "keep"; the "Write <path>?" confirm gets `confirm`; a "Type yes" prompt not covered by the
// answers gets `yes` when given; `during(prompt)` runs before each answer; `eof` makes every ask return null.
const wiz = async (dir, sub, args, answers, { opt = {}, tty = true, confirm = 'y', yes, during, eof } = {}) => {
  const out = [], asked = [], rest = [...answers];
  const io = { out: (t) => out.push(t), err: (t) => out.push(t), ask: async (p) => {
    asked.push(p); during?.(p);
    if (eof) return null;
    if (/^Write /.test(p)) return confirm;
    if (yes !== undefined && /Type yes to apply/.test(p) && !rest.length) return yes;
    return rest.length ? rest.shift() : '';
  } };
  const code = await runConfigCommand({ sub, args, opt, root: dir, home: path.join(dir, 'fhome'), tty, io });
  return { code, out: out.join('\n'), asked };
};

test('init: refuses when the file exists and names edit', async () => {
  const { dir, file } = project({ version: 1 });
  const r = await wiz(dir, 'init', [], []);
  assert.equal(r.code, 1); assert.match(r.out, /edit/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "version": 1\n}\n');
});

test('init: walks, shows the diff, writes on y; n writes nothing; q writes nothing', async () => {
  const dir = tmpDir('cfg-init-');
  const file = path.join(dir, '.product', 'delivery.json');
  const no = await wiz(dir, 'init', [], [], { confirm: 'n' });
  assert.equal(no.code, 0); assert.match(no.out, /nothing written/); assert.equal(fs.existsSync(file), false);
  const q = await wiz(dir, 'init', [], ['q']);
  assert.equal(q.code, 0); assert.equal(fs.existsSync(file), false);
  const walked = await wiz(dir, 'init', [], ['', '', 'develop']); // github.account, github.host, base
  assert.equal(walked.code, 0, walked.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { base: 'develop' });
  assert.match(walked.out, /\+ {3}"base": "develop"/); assert.match(walked.out, /commit/); assert.match(walked.out, /merge/);
});

test('init --from-draft starts from the draft and walks its failing keys first', async () => {
  const dir = tmpDir('cfg-init-');
  const draft = path.join(dir, 'draft.json');
  fs.writeFileSync(draft, JSON.stringify({ base: 'develop', limits: { max_fix_rounds: 9 } }));
  const r = await wiz(dir, 'init', [], ['3'], { opt: { 'from-draft': draft } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /limits\.max_fix_rounds/);
  assert.equal(/^(\S+) {3}\(current:/m.exec(r.out)[1], 'limits.max_fix_rounds'); // the failing key comes first
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.product', 'delivery.json'), 'utf8')), { base: 'develop', limits: { max_fix_rounds: 3 } });
});

test('init --from-draft refuses a symlink, a big file, invalid JSON and a missing file', async () => {
  const dir = tmpDir('cfg-init-');
  const real = path.join(dir, 'd.json'); fs.writeFileSync(real, '{}');
  const link = path.join(dir, 'l.json'); fs.symlinkSync(real, link);
  const big = path.join(dir, 'b.json'); fs.writeFileSync(big, JSON.stringify({ implementer_notes: 'x'.repeat(70000) }));
  const bad = path.join(dir, 'x.json'); fs.writeFileSync(bad, '{nope');
  for (const f of [link, big, bad, path.join(dir, 'missing.json')]) {
    const r = await wiz(dir, 'init', [], [], { opt: { 'from-draft': f } });
    assert.equal(r.code, 1, f);
  }
  assert.equal(fs.existsSync(path.join(dir, '.product', 'delivery.json')), false);
});

test('edit <key> walks one key; edit <group> walks one group; edit writes only on y', async () => {
  const { dir, file } = project({ version: 1 });
  const one = await wiz(dir, 'edit', ['autonomy.level'], ['2', 'yes']);
  assert.equal(one.code, 0, one.out); assert.equal(one.asked.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).autonomy.level, 'L1');
  assert.match(one.out, /sensitive/i);
  const repo = await wiz(dir, 'edit', ['repo'], []);
  assert.equal(repo.code, 0); assert.equal(repo.asked.length, 5); assert.match(repo.out, /no changes/);
  const nope = await wiz(dir, 'edit', ['autonomy.levl'], []);
  assert.equal(nope.code, 1); assert.match(nope.out, /autonomy\.level/);
  const before = fs.readFileSync(file);
  const decline = await wiz(dir, 'edit', ['base'], ['main'], { confirm: 'n' });
  assert.equal(decline.code, 0); assert.deepEqual(fs.readFileSync(file), before);
});

test('edit on an invalid existing file walks the failing keys first; invalid JSON exits 1 naming the file', async () => {
  const { dir, file } = project({ base: 'develop', limits: { max_fix_rounds: 9 } });
  const r = await wiz(dir, 'edit', [], ['4']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /limits\.max_fix_rounds/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).limits.max_fix_rounds, 4);
  const broken = project('{nope');
  const b = await wiz(broken.dir, 'edit', [], []);
  assert.equal(b.code, 1); assert.match(b.out, /delivery\.json/);
  assert.equal(fs.readFileSync(broken.file, 'utf8'), '{nope');
});

test('init and edit without a TTY exit 1 and point to config set', () => {
  const { dir } = project({ version: 1 });
  for (const sub of ['init', 'edit']) {
    const r = cli(dir, sub);
    assert.equal(r.code, 1, sub); assert.match(r.err, /config set/);
  }
});

const draftFile = (dir, doc) => { const f = path.join(dir, 'draft.json'); fs.writeFileSync(f, JSON.stringify(doc)); return f; };

test('init --from-draft: loosening values in the draft need a typed yes before anything is written', async () => {
  const dir = tmpDir('cfg-init-');
  const file = path.join(dir, '.product', 'delivery.json');
  const draft = draftFile(dir, { autonomy: { level: 'L1' }, merge: { allow_tier3: true }, local_checks: [{ name: 'x', command: ['true'] }] });
  const no = await wiz(dir, 'init', [], [], { opt: { 'from-draft': draft } });
  assert.equal(no.code, 1, no.out); assert.match(no.out, /autonomy\.level|not confirmed/); assert.equal(fs.existsSync(file), false);
  assert.match(no.out, /sensitive changes: .*autonomy\.level/);
  const ok = await wiz(dir, 'init', [], [], { opt: { 'from-draft': draft }, yes: 'yes' });
  assert.equal(ok.code, 0, ok.out);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).autonomy.level, 'L1');
  assert.equal(ok.asked.filter((p) => /Type yes/.test(p)).length, 3); // one prompt per reason
});

test('init --from-draft: an alias spelling (merge.mode squash) is gated too; tightening and defaults are not', async () => {
  const dir = tmpDir('cfg-init-');
  const file = path.join(dir, '.product', 'delivery.json');
  const alias = await wiz(dir, 'init', [], [], { opt: { 'from-draft': draftFile(dir, { merge: { mode: 'squash' } }) } });
  assert.equal(alias.code, 1); assert.equal(fs.existsSync(file), false);
  const safe = await wiz(dir, 'init', [], [], { opt: { 'from-draft': draftFile(dir, { autonomy: { level: 'L0' }, limits: { max_fix_rounds: 1 }, base: 'develop' }) } });
  assert.equal(safe.code, 0, safe.out); assert.equal(safe.asked.some((p) => /Type yes/.test(p)), false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).limits.max_fix_rounds, 1);
});

test('init --from-draft with an unknown key is refused up front with the parser text', async () => {
  const dir = tmpDir('cfg-init-');
  const r = await wiz(dir, 'init', [], [], { opt: { 'from-draft': draftFile(dir, { zzz: 1 }) } });
  assert.equal(r.code, 1); assert.match(r.out, /unknown key "zzz"/); assert.equal(r.asked.length, 0);
});

test('edit: unchanged sensitive values already in the file do not re-prompt', async () => {
  const { dir } = project({ autonomy: { level: 'L1' }, base: 'develop' });
  const r = await wiz(dir, 'edit', ['base'], ['main']);
  assert.equal(r.code, 0, r.out); assert.equal(r.asked.some((p) => /Type yes/.test(p)), false);
});

test('edit: a side effect alone (merge.mode dropped) still gets the diff, validation and the write', async () => {
  const { dir, file } = project({ merge: { mode: 'pr-only' }, autonomy: { level: 'L0' } });
  const r = await wiz(dir, 'edit', ['autonomy.level'], ['1']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /- {3}"merge"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { autonomy: { level: 'L0' } });
});

test('edit: a file changed on disk between the walk and the write is refused and left as it was', async () => {
  const { dir, file } = project({ version: 1 });
  const other = '{\n  "version": 1,\n  "base": "other"\n}\n';
  const r = await wiz(dir, 'edit', ['base'], ['develop'], { during: (p) => { if (/^Write /.test(p)) fs.writeFileSync(file, other); } });
  assert.equal(r.code, 1); assert.match(r.out, /changed on disk/);
  assert.equal(fs.readFileSync(file, 'utf8'), other);
});

test('init: a file created during the walk is refused and left as it was', async () => {
  const dir = tmpDir('cfg-init-');
  const file = path.join(dir, '.product', 'delivery.json');
  const mine = '{"version":1}\n';
  const r = await wiz(dir, 'init', [], ['', '', 'develop'], { during: (p) => { if (/^Write /.test(p)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, mine); } } });
  assert.equal(r.code, 1); assert.match(r.out, /changed on disk/);
  assert.equal(fs.readFileSync(file, 'utf8'), mine);
});

test('edit on a file with unknown keys shows the errors and still fixes a valid key', async () => {
  const { dir, file } = project({ zzz: 1, base: 'develop' });
  const r = await wiz(dir, 'edit', ['base'], ['main']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /unknown key "zzz"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { zzz: 1, base: 'main' });
});

test('closed input exits 1 with nothing written; q and n exit 0', async () => {
  const { dir, file } = project({ version: 1 });
  const before = fs.readFileSync(file);
  const eof = await wiz(dir, 'edit', [], [], { eof: true });
  assert.equal(eof.code, 1); assert.match(eof.out, /input closed; nothing written/);
  const eofConfirm = await wiz(dir, 'edit', ['base'], ['develop'], { confirm: null });
  assert.equal(eofConfirm.code, 1); assert.match(eofConfirm.out, /input closed/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal((await wiz(dir, 'edit', [], ['q'])).code, 0);
});

test('readDraft opens without following symlinks', async () => {
  const dir = tmpDir('cfg-init-');
  const real = path.join(dir, 'd.json'); fs.writeFileSync(real, '{}');
  const link = path.join(dir, 'l.json'); fs.symlinkSync(real, link);
  const r = await wiz(dir, 'init', [], [], { opt: { 'from-draft': link } });
  assert.equal(r.code, 1); assert.match(r.out, /symlink/);
});
