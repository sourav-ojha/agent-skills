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
