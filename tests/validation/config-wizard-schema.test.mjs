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
const wrong = (e) => (['bool', 'int', 'number'].includes(e.type) ? {} : 5);
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
  const sensitive = ['autonomy.level', 'merge.mode', 'merge.allow_tier3', 'checks.allow_without_ci', 'checks.ignored', 'protected_branches', 'hold_paths', 'local_checks', 'verification.required', 'verification.scenario_approval', 'budgets.feature.tokens', 'budgets.feature.turns', 'app.cli', 'app.setup', 'app.start', 'app.stop', 'app.seed', 'tests.setup', 'tests.all', 'checks.required', 'verification.test_globs'];
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
  assert.equal(JSON.parse(run('explain', 'autonomy.level', '--json').stdout).path, 'autonomy.level');  assert.ok(r.stdout.includes('read by: deliver init, factory run'));
  assert.ok(r.stdout.includes('factory run: must be L0 or L1; merging needs L1'));
});

test('explain renders factory, alias, range and example lines', () => {
  assert.ok(run('explain', 'app.ready').stdout.includes(`factory run: ${s.entry('app.ready').factory}`));
  assert.ok(run('explain', 'app.ready').stdout.includes(`example: ${JSON.stringify(s.entry('app.ready').example)}`));
  assert.ok(run('explain', 'merge.mode').stdout.includes('alias:   older spelling of autonomy.level'));
  assert.ok(run('explain', 'limits.max_fix_rounds').stdout.includes('type:    an integer, 0 to 5'));
  assert.ok(run('explain', 'github.account').stdout.includes('example: "work-login"'));
  assert.ok(run('explain', 'github.account').stdout.includes('null:    allowed (unset)'));
});

test('generated docs carry every numeric range and list cap', () => {
  const md = run('explain', '--docs').stdout;
  for (const e of s.SCHEMA.filter((x) => x.file === 'project' && x.type === 'int')) assert.ok(md.includes(`an integer, ${e.min} to ${e.max}`), e.path);
  assert.ok(md.includes('up to 50 items'));
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

test('number entries: parser accepts min, max and a fraction, rejects just outside and non-numbers', () => {
  const nums = s.SCHEMA.filter((x) => x.type === 'number');
  assert.deepEqual(nums.map((x) => x.path).sort(), ['max_wait_h', 'max_wait_weekly_h']);
  for (const e of nums) {
    for (const v of [e.min, e.max, (e.min + e.max) / 2 + 0.25, 0.5]) assert.deepEqual(parse(e, setAt(e.path, v)).errors, [], `${e.path}=${v}`);
    for (const v of [e.min - 0.001, e.max + 0.001, 'x', null, {}, true]) assert.ok(failsOn(e, v), `${e.path} accepted ${JSON.stringify(v)}`);
  }
});

test('number entries render as "a number, min to max" in explain and the docs', () => {
  assert.ok(run('explain', 'max_wait_h', '--local').stdout.includes('type:    a number, 0 to 12'));
  assert.ok(run('explain', '--docs', '--local').stdout.includes('a number, 0 to 168'));
});

// ---- docs, changelog and the audit of other configs ------------------------------------------------------------------
const readRepo = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const unreleased = () => readRepo('CHANGELOG.md').split(/^## /m).find((x) => x.startsWith('[Unreleased]'));

test('the guide and SKILL.md mention config explain and config edit', () => {
  for (const f of [['docs', 'guides', 'delivery-orchestrator.md'], ['skills', 'delivery-orchestrator', 'SKILL.md']]) {
    const t = readRepo(...f);
    assert.match(t, /config explain/, f.join('/'));
    assert.match(t, /config edit/, f.join('/'));
  }
  assert.match(readRepo('skills', 'delivery-orchestrator', 'SKILL.md'), /references\/config\.md/);
});

test('references/config.md explains the wizard commands outside the generated blocks', () => {
  const t = readRepo('skills', 'delivery-orchestrator', 'references', 'config.md').replace(/<!-- config-schema:[^>]*:start -->[\s\S]*?<!-- config-schema:[^>]*:end -->/g, '');
  for (const c of ['config init', 'config edit', 'config explain', 'config set', 'config unset', '--local', '--from-draft']) assert.ok(t.includes(c), c);
});

test('CHANGELOG [Unreleased] has a config wizard section naming the five commands', () => {
  const u = unreleased();
  assert.ok(u, 'no [Unreleased] section');
  const i = u.indexOf('### Added (delivery-orchestrator: config wizard)');
  assert.ok(i >= 0, 'no config wizard section');
  assert.equal(u.slice(0, i).includes('### Added (feature-intake'), false, 'the new section goes above the existing ones');
  const sec = u.slice(i).split(/^### /m)[1];
  for (const c of ['config init', 'config edit', 'config explain', 'config set', 'config unset']) assert.ok(sec.includes(c), c);
});

test('the config audit exists and names every config file it lists', () => {
  const t = readRepo('docs', 'superpowers', 'specs', '2026-11-23-config-wizard-audit.md');
  assert.match(t, /skills\/product-intelligence\/core\/schemas\/config\.schema\.json/);
  const listed = [...t.matchAll(/`(skills\/[^`\s]+\.json)`/g)].map((m) => m[1]);
  assert.ok(listed.length >= 5, 'lists the config files');
  for (const f of listed) assert.ok(fs.existsSync(path.join(REPO, f)), `${f} does not exist`);
  assert.match(t, /wizard\.mjs/); assert.match(t, /byte-identical/);
});

test('the design spec is marked implemented', () => {
  assert.match(readRepo('docs', 'superpowers', 'specs', '2026-11-23-config-wizard-design.md'), /^Status: implemented/m);
});
