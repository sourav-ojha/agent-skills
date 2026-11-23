// Parity between the config schema and the parsers: a change to one side only fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const LIB = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'lib');
const s = await import(path.join(LIB, 'configschema.mjs'));
const { parseConfig } = await import(path.join(LIB, 'config.mjs'));
const { parseLocalConfig, KEYS } = await import(path.join(LIB, 'localconfig.mjs'));

const parse = (e, doc) => (e.file === 'local' ? parseLocalConfig(doc, { classifierReal: true }) : parseConfig(doc));
const setAt = (p, v) => { const doc = {}; let o = doc; const ps = p.split('.'); ps.slice(0, -1).forEach((k) => { o = o[k] = {}; }); o[ps.at(-1)] = v; return doc; };
const sample = (e) => (e.default === null ? e.example : e.default);
const wrong = (e) => (['bool', 'int'].includes(e.type) ? {} : 5);
const all = [...s.SCHEMA];
const failsOn = (e, value) => parse(e, setAt(e.path, value)).errors.some((m) => m.includes(e.path));

test('every schema path is accepted by the parser', () => {
  for (const e of all) {
    assert.ok(e.default !== null || e.example !== undefined, `${e.path}: null default needs an example`);
    assert.deepEqual(parse(e, setAt(e.path, sample(e))).errors, [], e.path);
  }
});

test('schema defaults equal the parser defaults', () => {
  for (const e of all) {
    const cfg = e.file === 'local' ? parseLocalConfig({}).config : parseConfig(e.path.startsWith('readiness.') ? { readiness: {} } : {}).config;
    assert.deepEqual(e.path.split('.').reduce((o, k) => o?.[k], cfg), e.default, e.path);
  }
});

test("schema keys equal the parser's allowed keys", () => {
  const allowedAt = (probe) => {
    const m = parseConfig(probe).errors.find((x) => x.includes('__nope__'))?.match(/\(allowed: (.*)\)/);
    assert.ok(m, `no allowed list for ${JSON.stringify(probe)}`);
    return m[1].split(', ').sort();
  };
  const childrenOf = (prefix) => {
    const names = new Set();
    for (const e of all.filter((x) => x.file === 'project')) {
      if (prefix === '') names.add(e.path.split('.')[0]);
      else if (e.path.startsWith(`${prefix}.`)) names.add(e.path.slice(prefix.length + 1).split('.')[0]);
    }
    if (prefix === '') names.add('version');
    return [...names].sort();
  };
  const objects = ['', 'github', 'merge', 'autonomy', 'budgets', 'budgets.feature', 'checks', 'limits', 'app', 'tests', 'readiness', 'verification', 'verification.session_timeout_s', 'verification.max_turns', 'verification.model'];
  for (const p of objects) assert.deepEqual(allowedAt(p === '' ? { __nope__: 1 } : setAt(p, { __nope__: 1 })), childrenOf(p), p || 'root');
  for (const leaf of ['app.ready', 'local_checks']) {
    const e = s.entry(leaf);
    const probe = leaf === 'local_checks' ? { local_checks: [{ __nope__: 1 }] } : setAt(leaf, { __nope__: 1 });
    assert.deepEqual(allowedAt(probe), [...e.children].sort(), leaf);
  }
  assert.deepEqual([...KEYS].sort(), [...new Set(all.filter((x) => x.file === 'local').map((x) => x.path.split('.')[0]))].sort());
  assert.deepEqual(s.keysOf('local').length, all.filter((x) => x.file === 'local').length);
});

test('enum values and numeric bounds are exact', () => {
  for (const e of all.filter((x) => x.type === 'enum')) {
    for (const { v } of e.values) assert.deepEqual(parse(e, setAt(e.path, v)).errors, [], `${e.path}=${v}`);
    assert.ok(failsOn(e, '__bad__'), `${e.path} accepted __bad__`);
  }
  for (const e of all.filter((x) => x.type === 'int')) {
    assert.deepEqual(parse(e, setAt(e.path, e.min)).errors, [], `${e.path} min`);
    assert.deepEqual(parse(e, setAt(e.path, e.max)).errors, [], `${e.path} max`);
    assert.ok(failsOn(e, e.min - 1), `${e.path} accepted ${e.min - 1}`);
    assert.ok(failsOn(e, e.max + 1), `${e.path} accepted ${e.max + 1}`);
  }
  const notes = s.entry('implementer_notes');
  assert.deepEqual(parseConfig({ implementer_notes: 'x'.repeat(notes.maxLen) }).errors, []);
  assert.ok(failsOn(notes, 'x'.repeat(notes.maxLen + 1)));
});

test('bool values are both accepted', () => {
  for (const e of all.filter((x) => x.type === 'bool')) for (const v of [true, false]) assert.deepEqual(parse(e, setAt(e.path, v)).errors, [], `${e.path}=${v}`);
});

test('wrong types are rejected', () => {
  for (const e of all) assert.ok(failsOn(e, wrong(e)), `${e.path} accepted ${JSON.stringify(wrong(e))}`);
});

test('null is accepted exactly when the entry is nullable', () => {
  for (const e of all) {
    if (e.nullable) assert.deepEqual(parse(e, setAt(e.path, null)).errors, [], `${e.path} null`);
    else assert.ok(failsOn(e, null), `${e.path} accepted null`);
  }
});

test('every entry has what, why, readBy; what is one short line', () => {
  for (const e of all) {
    assert.ok(e.what && !e.what.includes('\n') && e.what.length < 120, `${e.path}: what`);
    assert.ok(e.why, `${e.path}: why`);
    assert.ok(Array.isArray(e.readBy) && e.readBy.length > 0, `${e.path}: readBy`);
    assert.ok(s.GROUPS.includes(e.group), `${e.path}: group`);
    assert.equal(typeof e.sensitive, 'boolean', e.path);
  }
});

test('paths are unique, groups are in walk order, sensitive keys are marked', () => {
  const keyOf = (e) => `${e.file}:${e.path}`;
  assert.equal(new Set(all.map(keyOf)).size, all.length);
  assert.deepEqual(s.GROUPS, ['repo', 'merge', 'ci', 'app', 'tests', 'budgets', 'verification', 'readiness', 'notes', 'local']);
  const sensitive = ['autonomy.level', 'merge.mode', 'merge.allow_tier3', 'checks.allow_without_ci', 'checks.ignored', 'protected_branches', 'hold_paths', 'local_checks', 'verification.required', 'verification.scenario_approval', 'budgets.feature.tokens', 'budgets.feature.turns'];
  assert.deepEqual(all.filter((e) => e.sensitive).map((e) => e.path).sort(), [...sensitive, 'budgets.day_tokens'].sort());
});

test('merge.mode is an alias of autonomy.level and version is not an entry', () => {
  assert.deepEqual(s.entry('merge.mode').alias, { to: 'autonomy.level', map: { 'pr-only': 'L0', squash: 'L1' } });
  assert.equal(s.entry('version'), undefined);
  assert.equal(s.entry('readiness').type, 'object-null');
  assert.equal(s.entry('app.ready').type, 'ready');
  assert.equal(s.entry('local_checks').type, 'local_checks');
});

test('entry and keysOf look up by file; budgets.day_tokens is local only', () => {
  assert.equal(s.entry('budgets.day_tokens'), undefined);
  assert.equal(s.entry('budgets.day_tokens', 'local').file, 'local');
  assert.equal(s.entry('max_wait_h', 'local').path, 'max_wait_h');
  assert.ok(s.keysOf('project').includes('autonomy.level'));
  assert.ok(!s.keysOf('project').includes('keep_awake'));
  assert.ok(s.keysOf('local').includes('keep_awake'));
});

test('nearest returns up to three closest valid keys', () => {
  assert.equal(s.nearest('autonomy.levl', 'project')[0], 'autonomy.level');
  assert.ok(s.nearest('autonomy.levl', 'project').length <= 3);
  assert.equal(s.nearest('keep_awak', 'local')[0], 'keep_awake');
  assert.ok(!s.nearest('keep_awak', 'local').includes('autonomy.level'));
  assert.equal(s.nearest('limits.max_failure', 'project', 1).length, 1);
});

// --- config explain (CLI) and generated docs ---
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const DELIVER = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts', 'deliver.mjs');
const CONFIG_MD = path.join(REPO, 'skills', 'delivery-orchestrator', 'references', 'config.md');
const run = (...args) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-explain-'));
  const r = spawnSync('node', [DELIVER, 'config', ...args, '--dir', dir], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
};
const block = (name) => {
  const md = fs.readFileSync(CONFIG_MD, 'utf8');
  const a = `<!-- config-schema:${name}:start -->\n`;
  const i = md.indexOf(a);
  const j = md.indexOf(`\n<!-- config-schema:${name}:end -->`);
  assert.ok(i >= 0 && j > i, `markers for ${name}`);
  return md.slice(i + a.length, j);
};

test('explain shows values, what, default and SENSITIVE', () => {
  const r = run('explain', 'autonomy.level');
  assert.equal(r.status, 0, r.stderr);
  for (const t of ['L0', 'L1', s.entry('autonomy.level').what, 'default: "L0"', 'SENSITIVE']) assert.ok(r.stdout.includes(t), t);
  assert.equal(JSON.parse(run('explain', 'autonomy.level', '--json').stdout).path, 'autonomy.level');
});

test('explain --list lists every key grouped, one line each; --local lists the local keys', () => {
  const lines = run('explain', '--list').stdout.split('\n').filter((l) => l.startsWith('  '));
  assert.equal(lines.length, s.keysOf('project').length);
  for (const k of s.keysOf('project')) assert.ok(lines.some((l) => l.trim().startsWith(k)), k);
  const loc = run('explain', '--list', '--local').stdout.split('\n').filter((l) => l.startsWith('  '));
  assert.equal(loc.length, 6);
  assert.equal(run('explain', 'keep_awake', '--local').status, 0);
  assert.equal(run('explain', 'keep_awake').status, 1);
});

test('explain on a mistyped key exits 1 and names the nearest key', () => {
  const r = run('explain', 'app.redy');
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('app.ready'), r.stderr);
});

test('explain --docs equals the generated blocks in references/config.md', () => {
  assert.equal(run('explain', '--docs').stdout.trimEnd(), block('project'));
  assert.equal(run('explain', '--docs', '--local').stdout.trimEnd(), block('local'));
});

test('config subcommands not built yet exit 1', () => {
  for (const sub of ['init', 'edit', 'set', 'unset']) assert.equal(run(sub).status, 1, sub);
});
