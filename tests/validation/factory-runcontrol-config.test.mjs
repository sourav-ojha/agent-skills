// factory phase 2 run control: committed config keys `autonomy` and `budgets.feature`, and how `deliver init` treats --merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator');
const DELIVER = path.join(SK, 'core', 'scripts', 'deliver.mjs');
const FAKE = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const c = await import(path.join(SK, 'core', 'scripts', 'lib', 'config.mjs'));

test('autonomy: neither key -> L0, not explicit, merge.mode pr-only', () => {
  const { config, errors } = c.parseConfig({});
  assert.deepEqual(errors, []);
  assert.deepEqual(config.autonomy, { level: 'L0', explicit: false });
  assert.equal(config.merge.mode, 'pr-only');
});
test('autonomy: only merge.mode maps squash->L1 and pr-only->L0, never explicit', () => {
  const a = c.parseConfig({ merge: { mode: 'squash' } });
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.config.autonomy, { level: 'L1', explicit: false });
  const b = c.parseConfig({ merge: { mode: 'pr-only' } });
  assert.deepEqual(b.config.autonomy, { level: 'L0', explicit: false });
});
test('autonomy: level alone sets merge.mode and is explicit', () => {
  const a = c.parseConfig({ autonomy: { level: 'L1' } });
  assert.deepEqual(a.errors, []);
  assert.equal(a.config.merge.mode, 'squash');
  assert.deepEqual(a.config.autonomy, { level: 'L1', explicit: true });
  const b = c.parseConfig({ autonomy: { level: 'L0' } });
  assert.equal(b.config.merge.mode, 'pr-only');
  assert.deepEqual(b.config.autonomy, { level: 'L0', explicit: true });
});
test('autonomy: level and merge.mode that disagree are an error; agreeing pairs pass', () => {
  assert.ok(c.parseConfig({ autonomy: { level: 'L0' }, merge: { mode: 'squash' } }).errors.some((e) => e.includes('autonomy.level and merge.mode disagree')));
  assert.ok(c.parseConfig({ autonomy: { level: 'L1' }, merge: { mode: 'pr-only' } }).errors.some((e) => e.includes('autonomy.level and merge.mode disagree')));
  assert.deepEqual(c.parseConfig({ autonomy: { level: 'L1' }, merge: { mode: 'squash' } }).errors, []);
  assert.deepEqual(c.parseConfig({ autonomy: { level: 'L0' }, merge: { mode: 'pr-only' } }).errors, []);
});
test('autonomy: L2 names Phase 6, L3 names Phase 8, anything else is a generic error; unknown keys rejected', () => {
  assert.match(c.parseConfig({ autonomy: { level: 'L2' } }).errors.join('\n'), /Phase 6/);
  assert.match(c.parseConfig({ autonomy: { level: 'L3' } }).errors.join('\n'), /Phase 8/);
  const g = c.parseConfig({ autonomy: { level: 'L9' } }).errors.join('\n');
  assert.match(g, /autonomy\.level/);
  assert.doesNotMatch(g, /Phase/);
  assert.match(c.parseConfig({ autonomy: { level: 'L0', extra: 1 } }).errors.join('\n'), /unknown key "extra"/);
  assert.match(c.parseConfig({ autonomy: 'L1' }).errors.join('\n'), /autonomy: expected an object/);
});
test('budgets.feature: defaults and bounds', () => {
  assert.deepEqual(c.parseConfig({}).config.budgets, { feature: { tokens: 3000000, turns: 400 } });
  const ok = (b) => c.parseConfig({ budgets: { feature: b } });
  for (const [k, good, bad] of [['tokens', [10000, 1000000000], [9999, 1000000001]], ['turns', [10, 5000], [9, 5001]]]) {
    for (const v of good) { const r = ok({ [k]: v }); assert.deepEqual(r.errors, [], `${k}=${v}`); assert.equal(r.config.budgets.feature[k], v); }
    for (const v of bad) assert.match(ok({ [k]: v }).errors.join('\n'), new RegExp(`budgets\\.feature\\.${k}`), `${k}=${v}`);
    assert.ok(ok({ [k]: 12.5 }).errors.length, `${k} non-integer`);
    assert.ok(ok({ [k]: '100' }).errors.length, `${k} string`);
  }
  assert.match(c.parseConfig({ budgets: { run: {} } }).errors.join('\n'), /unknown key "run"/);
  assert.match(c.parseConfig({ budgets: { feature: { cost: 1 } } }).errors.join('\n'), /unknown key "cost"/);
  assert.match(c.parseConfig({ budgets: 5 }).errors.join('\n'), /budgets: expected an object/);
});

// ---- deliver init ----------------------------------------------------------------------------------------------------
const sh = (cwd, env, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function initWith(config, args) {
  const root = tmpDir('rc-config-');
  const origin = path.join(root, 'origin.git'); const work = path.join(root, 'work'); const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  const rw = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:o/r.git' };
  const genv = { ...process.env, ...rw };
  sh(root, genv, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, genv, 'clone', '-q', origin, work);
  for (const [k, v] of [['user.email', 't@x'], ['user.name', 't']]) sh(work, genv, 'config', k, v);
  sh(work, genv, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  fs.writeFileSync(path.join(work, '.product/features/FEATURE-001.md'), '---\ntype: feature-spec\nid: FEATURE-001\nopportunity: OPP-001\nstatus: ready\n---\n# F\n\nbody\n');
  fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify({ protected_branches: [], ...config }));
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, genv, 'checkout', '-q', '-b', 'main'); sh(work, genv, 'add', '-A'); sh(work, genv, 'commit', '-q', '-m', 'init'); sh(work, genv, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh-state.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [] }));
  const env = { ...genv, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(root, 'fhome') };
  const r = spawnSync('node', [DELIVER, 'init', ...args, '--dir', work], { encoding: 'utf8', env });
  let json; try { json = JSON.parse(r.stdout); } catch { /* not json */ }
  return { code: r.status, err: r.stderr, json };
}
test('deliver init: explicit L0 ignores --merge and says so; legacy pr-only still honours it', () => {
  const l0 = initWith({ autonomy: { level: 'L0' } }, ['--merge', '--note', 'merge them']);
  assert.equal(l0.code, 0, l0.err);
  assert.equal(l0.json.merge, false);
  assert.ok(l0.json.warnings.some((w) => /--merge/.test(w) && /L0/.test(w)), l0.json.warnings.join('|'));
  const legacy = initWith({ merge: { mode: 'pr-only' } }, ['--merge', '--note', 'merge them']);
  assert.equal(legacy.code, 0, legacy.err);
  assert.equal(legacy.json.merge, true);
  const l1 = initWith({ autonomy: { level: 'L1' } }, []);
  assert.equal(l1.json.merge, true);
});
