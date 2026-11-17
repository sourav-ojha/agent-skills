import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, tmpDir, projectFrom, pi } from './helpers.mjs';
import { logEvent } from '../../skills/implementer/core/scripts/lib/runlog.mjs';

const IMPL = path.join(REPO, 'skills/implementer/core/scripts/impl.mjs');
const SI = path.join(REPO, 'skills/skill-insights/core/scripts/si.mjs');
const events = (dir, skill) => {
  const f = path.join(dir, '.skill-runs', `${skill}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const impl = (dir, ...a) => { const r = spawnSync('node', [IMPL, ...a, '--dir', dir], { encoding: 'utf8' }); return { code: r.status, out: r.stdout + r.stderr }; };
const task = (id) => ({ id, title: id, deps: [], files: [`src/${id}.js`], verify: 'npm test', criteria: [{ id: `${id}-c1`, text: 'Given x When y Then z', tests: ['t'] }] });

test('AC1 runlog: appends one metadata line, self-ignoring dir, caps strings, never throws, can be turned off', () => {
  const dir = tmpDir('rl-');
  logEvent(dir, 'implementer', 'run1', { event: 'start', task: 'A', long: 'x'.repeat(1000), nested: { no: 1 } });
  const [e] = events(dir, 'implementer');
  assert.equal(e.run, 'run1'); assert.equal(e.skill, 'implementer'); assert.ok(e.ts);
  assert.ok(e.long.length <= 200); assert.equal(e.nested, undefined);
  assert.equal(fs.readFileSync(path.join(dir, '.skill-runs', '.gitignore'), 'utf8').trim(), '*');
  assert.doesNotThrow(() => logEvent('/proc/definitely/not/writable', 'implementer', 'r', { event: 'x' }));
  const off = tmpDir('rl-');
  process.env.SKILL_RUNLOG = 'off';
  try { logEvent(off, 'implementer', 'r', { event: 'x' }); } finally { delete process.env.SKILL_RUNLOG; }
  assert.deepEqual(events(off, 'implementer'), []);
});

test('AC1 the runlog copies in each skill stay identical', () => {
  const read = (s) => fs.readFileSync(path.join(REPO, 'skills', s, 'core/scripts/lib/runlog.mjs'), 'utf8');
  assert.equal(read('implementer'), read('product-intelligence'));
});

test('AC2 impl logs one event per command with outcome; failures logged; free text never logged', () => {
  const dir = tmpDir('rl-');
  impl(dir, 'init', '--name', 'x', '--tier', 'T2', '--spec', '.product/features/FEATURE-007.md');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ tasks: [task('A')] }));
  impl(dir, 'plan', '--name', 'x', '--file', path.join(dir, 'plan.json'));
  impl(dir, 'start', 'A', '--name', 'x'); impl(dir, 'finish', 'A', '--name', 'x');
  assert.notEqual(impl(dir, 'pass', 'A', '--name', 'x', '--cmd', 'npm test', '--exit', '1').code, 0);
  impl(dir, 'pass', 'A', '--name', 'x', '--cmd', 'SECRET-CMD', '--exit', '0');
  impl(dir, 'ruling', '--name', 'x', '--what', 'SECRET-RULING', '--why', 'y', '--cost', 'c');
  const ev = events(dir, 'implementer');
  assert.deepEqual(ev.map((e) => e.event), ['init', 'plan', 'start', 'finish', 'pass', 'pass', 'ruling']);
  assert.equal(ev[0].tier, 'T2'); assert.equal(ev[0].spec, 'FEATURE-007'); assert.equal(ev[1].tasks, 1);
  assert.deepEqual([ev[4].ok, ev[5].ok], [false, true]);
  assert.ok(new Set(ev.map((e) => e.run)).size === 1);
  assert.ok(!JSON.stringify(ev).includes('SECRET'));
});

test('AC3 pi logs commands with outcome and ids, not content', () => {
  const dir = projectFrom('a');
  pi(dir, ['status']);
  pi(dir, ['validate']);
  const ev = events(dir, 'product-intelligence');
  assert.deepEqual(ev.map((e) => e.event), ['status', 'validate']);
  assert.ok(ev.every((e) => typeof e.ok === 'boolean' && typeof e.ms === 'number'));
  assert.equal(typeof ev[1].errors, 'number');
});

test('AC4 retro self-report: needs at least one field, is logged on both helpers', () => {
  const dir = projectFrom('a');
  assert.notEqual(impl(dir, 'retro', '--name', 'x').code, 0);
  assert.equal(impl(dir, 'retro', '--name', 'x', '--unclear', 'AC wording unclear').code, 0);
  assert.equal(pi(dir, ['retro', '--skipped', 'review phase']).code, 0);
  assert.equal(events(dir, 'implementer').find((e) => e.event === 'retro' && e.unclear).unclear, 'AC wording unclear');
  assert.equal(events(dir, 'product-intelligence').find((e) => e.event === 'retro').skipped, 'review phase');
});

function exportFixture() {
  const dir = tmpDir('rl-');
  impl(dir, 'init', '--name', 'x', '--tier', 'T2');
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ tasks: [task('A')] }));
  impl(dir, 'plan', '--name', 'x', '--file', path.join(dir, 'plan.json'));
  impl(dir, 'start', 'A', '--name', 'x'); impl(dir, 'finish', 'A', '--name', 'x');
  impl(dir, 'reopen', 'A', '--name', 'x'); impl(dir, 'finish', 'A', '--name', 'x');
  impl(dir, 'pass', 'A', '--name', 'x', '--cmd', 'npm test', '--exit', '0');
  impl(dir, 'retro', '--name', 'x', '--unclear', `see ${dir}/src/a.js mail bob@example.com`);
  return dir;
}

test('AC5 export summarises runs (fix rounds, passes), carries retro notes, redacts paths and emails', () => {
  const dir = exportFixture();
  const r = spawnSync('node', [SI, 'export', '--dir', dir, '--projects-dir', path.join(dir, 'none')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /implementer/);
  assert.match(r.stdout, /fix rounds: 1/i);
  assert.match(r.stdout, /unclear/i);
  for (const bad of [dir, 'bob@example.com', '/Users/']) assert.ok(!r.stdout.includes(bad), `leaked ${bad}`);
});

test('AC5 export with no run logs says so clearly instead of failing', () => {
  const r = spawnSync('node', [SI, 'export', '--dir', tmpDir('rl-'), '--projects-dir', tmpDir('rl-')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no run logs/i);
});

test('AC3 run-log writes never count as application changes for verify-clean', () => {
  const dir = projectFrom('a');
  assert.equal(pi(dir, ['snapshot']).code, 0);
  pi(dir, ['status']);
  assert.ok(fs.existsSync(path.join(dir, '.skill-runs', 'product-intelligence.jsonl')));
  const v = pi(dir, ['verify-clean']);
  assert.equal(v.code, 0, v.out + v.err);
});
