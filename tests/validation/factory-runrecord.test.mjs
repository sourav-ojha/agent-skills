// delivery-orchestrator run records (P0.2): one metadata-only line per feature outcome, in .skill-runs/factory-runs.jsonl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { REPO, tmpDir } from './helpers.mjs';

const SK = path.join(REPO, 'skills', 'delivery-orchestrator');
const DELIVER = path.join(SK, 'core', 'scripts', 'deliver.mjs');
const FAKE = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const q = await import(path.join(SK, 'core', 'scripts', 'lib', 'queue.mjs'));

const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

function spec(id, { status = 'ready', delivery, deps, title = `Feature ${id}` } = {}) {
  return `---\ntype: feature-spec\nid: ${id}\nopportunity: OPP-001\nstatus: ${status}\n${delivery ? `delivery: ${delivery}\n` : ''}${deps ? `depends_on: ${deps}\n` : ''}---\n# ${title}\n\nbody\n`;
}

// A work clone of a bare origin, a fake gh on PATH, and the given specs committed to main.
function setup(specs = { 'FEATURE-001': {} }, { config = { protected_branches: [] }, base = null } = {}) {
  const root = tmpDir('deliver-');
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, work);
  for (const [k, v] of [['user.email', 't@x'], ['user.name', 't']]) sh(work, 'config', k, v);
  sh(work, 'config', `url.${origin}.insteadOf`, 'git@github.com:o/r.git'); // origin looks like the GitHub repo gh targets, but pushes go to the local bare repo
  sh(work, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git');
  fs.mkdirSync(path.join(work, '.product/features'), { recursive: true });
  for (const [id, o] of Object.entries(specs)) fs.writeFileSync(path.join(work, `.product/features/${id}.md`), spec(id, o));
  if (config) fs.writeFileSync(path.join(work, '.product/delivery.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  sh(work, 'checkout', '-q', '-b', 'main');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'init'); sh(work, 'push', '-q', '-u', 'origin', 'main');
  if (base) { sh(work, 'checkout', '-q', '-b', base); sh(work, 'push', '-q', '-u', 'origin', base); sh(work, 'checkout', '-q', 'main'); }
  const state = path.join(root, 'gh-state.json');
  const gs = { origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [[{ name: 'ci', bucket: 'pass', link: 'http://ci/1', state: 'SUCCESS' }]] };
  fs.writeFileSync(state, JSON.stringify(gs));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, SKILL_RUNLOG: 'off', FACTORY_HOME: path.join(root, 'fhome') };
  const d = (...a) => { const r = spawnSync('node', [DELIVER, ...a, '--dir', work], { encoding: 'utf8', env }); let json; try { json = JSON.parse(r.stdout); } catch { /* not json */ } return { code: r.status, out: r.stdout, err: r.stderr, json }; };
  const gh = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const setGh = (fn) => { const s = gh(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  return { root, origin, work, d, gh, setGh };
}

// What the implementer would leave behind: commits on the feature branch and a spec that says delivery: complete.
function build(env, id, { delivery = 'complete', file = `src/${id}.txt`, tier = 'T2' } = {}) {
  const spc = path.join(env.work, `.product/features/${id}.md`);
  fs.mkdirSync(path.dirname(path.join(env.work, file)), { recursive: true });
  fs.writeFileSync(path.join(env.work, file), `${id}\n`);
  fs.writeFileSync(spc, fs.readFileSync(spc, 'utf8').replace(/^status: ready/m, 'status: implemented').replace(/^---\n/, `---\ndelivery: ${delivery}\n`));
  sh(env.work, 'add', '-A'); sh(env.work, 'commit', '-q', '-m', `feat: ${id}`);
  return tier;
}
const body = (env) => { fs.mkdirSync(path.join(env.work, '.delivery'), { recursive: true }); const f = path.join(env.work, '.delivery', 'pr-body.md'); fs.writeFileSync(f, 'body\n'); return f; };
const FAST = ['--interval', '0', '--grace', '0', '--timeout', '1'];

function ship(env, id, { tier = 'T2', build: b = {} } = {}) {
  const n = env.d('next'); assert.equal(n.json.feature.id, id, n.out + n.err);
  build(env, id, b);
  assert.equal(env.d('built', id, '--tier', tier).code, 0);
  assert.equal(env.d('pr', id, '--title', `feat: ${id} thing`, '--body-file', body(env)).code, 0);
  return env.d('ci', id, ...FAST);
}

const SI = path.join(REPO, 'skills', 'skill-insights', 'core', 'scripts', 'si.mjs');
const rr = await import(path.join(SK, 'core', 'scripts', 'lib', 'runrecord.mjs'));
const records = (env) => { const f = path.join(env.work, '.skill-runs', 'factory-runs.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
const siHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 6); // what si.mjs does to a transcript folder name

test('projectHash equals the hash skill-insights computes for the transcript folder name', () => {
  assert.equal(rr.projectHash('/Users/a/b'), siHash('-Users-a-b'));
  assert.equal(rr.projectHash('/Users/a.b/c d'), siHash('-Users-a-b-c-d'));
  assert.equal(rr.projectHash('/x').length, 6);
});

test('skillStamp reads metadata.version and a sha256 prefix; latestPerFeature keeps the last record per run and feature', () => {
  const s = rr.skillStamp(SK);
  assert.match(s.version, /^\d+\.\d+\.\d+$/);
  assert.match(s.sha, /^[0-9a-f]{12}$/);
  const l = rr.latestPerFeature([
    { kind: 'factory-run', run: 'r', feature: 'F1', outcome: 'awaiting_human' }, { kind: 'factory-run', run: 'r', feature: 'F2', outcome: 'blocked' },
    { kind: 'factory-run', run: 'r', feature: 'F1', outcome: 'merged' }, { kind: 'factory-run', run: 'r2', feature: 'F1', outcome: 'skipped' },
  ]);
  assert.deepEqual(l.map((r) => `${r.run}/${r.feature}/${r.outcome}`), ['r/F1/merged', 'r/F2/blocked', 'r2/F1/skipped']);
});

test('a full pipeline writes one merged record per feature with the spec fields and no event key', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-001' } });
  e.d('init', '--merge', '--note', 'merge them all');
  for (const id of ['FEATURE-001', 'FEATURE-002']) { assert.equal(ship(e, id).json.result, 'passed'); assert.equal(e.d('merge', id).json.state, 'merged'); }
  const recs = records(e);
  assert.equal(recs.length, 2);
  for (const [i, r] of recs.entries()) {
    assert.equal(r.kind, 'factory-run');
    assert.ok(!('event' in r));
    assert.equal(r.feature, `FEATURE-00${i + 1}`);
    assert.equal(r.outcome, 'merged');
    assert.equal(r.tier, 'T2');
    assert.equal(r.ci_runs, 1);
    assert.equal(r.fix_rounds, 0);
    assert.ok(Number.isInteger(r.ci_wait_ms) && r.ci_wait_ms >= 0);
    assert.equal(r.pr, i + 1);
    assert.match(r.base_sha, /^[0-9a-f]{40}$/);
    assert.match(r.merge_sha, /^[0-9a-f]{40}$/);
    assert.equal(r.readiness_level, null);
    assert.ok(Date.parse(r.ts_start) <= Date.parse(r.ts_end));
    assert.ok(r.wall_ms >= 0);
    assert.equal(r.project, siHash(fs.realpathSync(e.work).replace(/[^A-Za-z0-9]/g, '-')));
    assert.match(r.skills['delivery-orchestrator'].version, /^\d+\.\d+\.\d+$/);
    assert.match(r.skills['delivery-orchestrator'].sha, /^[0-9a-f]{12}$/);
    assert.equal(typeof r.run, 'string');
  }
  assert.notEqual(recs[0].merge_sha, recs[1].merge_sha);
  const raw = fs.readFileSync(path.join(e.work, '.skill-runs', 'factory-runs.jsonl'), 'utf8');
  assert.ok(!raw.includes(e.root) && !raw.includes(os.tmpdir()), 'no paths in a record');
  assert.equal(fs.readFileSync(path.join(e.work, '.skill-runs', '.gitignore'), 'utf8'), '*\n');
});

test('a CI failure then a fix records ci_runs 2 and fix_rounds 1 on the merged record', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'fail', link: 'http://ci/9' }]]; });
  assert.equal(ship(e, 'FEATURE-001').json.result, 'failed');
  assert.equal(e.d('fix', 'FEATURE-001').code, 0);
  fs.writeFileSync(path.join(e.work, 'src/fix.txt'), 'fix\n'); sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'fix: ci');
  assert.equal(e.d('push', 'FEATURE-001').code, 0);
  e.setGh((s) => { s.checkQueue = [[{ name: 'ci', bucket: 'pass', link: 'http://ci/2', state: 'SUCCESS' }]]; });
  assert.equal(e.d('ci', 'FEATURE-001', ...FAST).json.result, 'passed');
  assert.equal(e.d('merge', 'FEATURE-001').json.state, 'merged');
  const recs = records(e);
  assert.deepEqual(recs.map((r) => r.outcome), ['merged']);
  assert.equal(recs[0].ci_runs, 2);
  assert.equal(recs[0].fix_rounds, 1);
});

test('a blocked feature and a dependency-skipped feature each produce a record', () => {
  const e = setup({ 'FEATURE-001': {}, 'FEATURE-002': { deps: 'FEATURE-001' } });
  e.d('init');
  e.d('next');
  assert.equal(e.d('block', 'FEATURE-001', '--reason', 'cannot build /home/u/secret/path').json.state, 'blocked');
  assert.equal(e.d('next').json.done, true); // pickNext skips FEATURE-002
  const recs = records(e);
  assert.deepEqual(recs.map((r) => `${r.feature}:${r.outcome}`), ['FEATURE-001:blocked', 'FEATURE-002:skipped']);
  assert.match(recs[0].reason, /cannot build/);
  assert.ok(!recs[0].reason.includes('/home/u'), 'paths are scrubbed from reasons');
  assert.match(recs[1].reason, /dependency FEATURE-001 is blocked/);
  assert.ok(recs[0].ts_start && recs[0].wall_ms >= 0);
  assert.equal(recs[1].ts_start, null);
  assert.equal(recs[1].wall_ms, null);
});

test('awaiting_human then a person merging it gives two records and latestPerFeature keeps the merged one', () => {
  const e = setup();
  e.d('init'); // merging not authorised: the PR is held for a person
  ship(e, 'FEATURE-001');
  assert.equal(e.d('merge', 'FEATURE-001').code, 2);
  assert.deepEqual(records(e).map((r) => r.outcome), ['awaiting_human']);
  assert.match(records(e)[0].reason, /not authorised/);
  e.setGh((s) => { s.prs[0].state = 'MERGED'; });
  e.d('next'); // refresh discovers the merge
  const recs = records(e);
  assert.deepEqual(recs.map((r) => r.outcome), ['awaiting_human', 'merged']);
  const latest = rr.latestPerFeature(recs);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].outcome, 'merged');
});

test('an awaiting_human stop from ci (no CI reported) is recorded', () => {
  const e = setup();
  e.d('init');
  e.setGh((s) => { s.required = []; s.checkQueue = [[]]; });
  const r = ship(e, 'FEATURE-001');
  assert.equal(r.json.result, 'unconfirmed');
  const recs = records(e);
  assert.deepEqual(recs.map((x) => x.outcome), ['awaiting_human']);
  assert.equal(recs[0].ci_runs, 1);
});

test('records are not skill events: si export ingests nothing from factory-runs.jsonl', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001'); e.d('merge', 'FEATURE-001');
  assert.equal(records(e).length, 1);
  const lines = fs.readFileSync(path.join(e.work, '.skill-runs', 'factory-runs.jsonl'), 'utf8');
  fs.writeFileSync(path.join(e.work, '.skill-runs', 'only.jsonl'), '');
  fs.rmSync(path.join(e.work, '.skill-runs', 'delivery-orchestrator.jsonl'), { force: true }); // leave only factory-runs.jsonl
  fs.rmSync(path.join(e.work, '.skill-runs', 'only.jsonl'));
  const r = spawnSync('node', [SI, 'export', '--dir', e.work, '--json', '--projects-dir', path.join(e.root, 'no-projects')], { encoding: 'utf8', env: { ...process.env, FACTORY_HOME: path.join(e.root, 'fhome') } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).runs, [], 'no events came from factory-runs.jsonl');
  assert.equal(fs.readFileSync(path.join(e.work, '.skill-runs', 'factory-runs.jsonl'), 'utf8'), lines, 'export never edits the records');
});

test('two inits in one repo give different run ids, so records of separate runs never share a key', () => {
  const e = setup();
  e.d('init'); e.d('next'); e.d('block', 'FEATURE-001', '--reason', 'first');
  e.d('reset', '--yes');
  e.d('init'); e.d('next'); e.d('block', 'FEATURE-001', '--reason', 'second');
  const recs = records(e);
  assert.equal(recs.length, 2);
  assert.notEqual(recs[0].run, recs[1].run);
  assert.equal(rr.latestPerFeature(recs).length, 2);
});

test('a reason is a short category: command output and free text after the first colon never reach a record', () => {
  const e = setup();
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001');
  e.setGh((s) => { s.mergeRefuse = 'ghp_SECRET0123456789abcdef token=hunter2'; });
  const m = e.d('merge', 'FEATURE-001');
  assert.match(m.json.reason, /hunter2/, 'the console still shows the full reason');
  e.d('block', 'FEATURE-001', '--reason', 'gave up: password=hunter2 ' + 'x'.repeat(300));
  const recs = records(e);
  assert.deepEqual(recs.map((r) => r.outcome), ['awaiting_human', 'skipped']);
  assert.equal(recs[0].reason, 'gh pr merge refused');
  assert.equal(recs[1].reason, 'gave up');
  assert.ok(!JSON.stringify(recs).includes('hunter2') && !JSON.stringify(recs).includes('SECRET'));
  assert.ok(recs.every((r) => r.reason.length <= 80));
});

test('.skill-runs as a symlink: nothing is written through it', () => {
  const e = setup();
  const target = path.join(e.root, 'elsewhere'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(e.work, '.skill-runs'));
  sh(e.work, 'add', '-A'); sh(e.work, 'commit', '-q', '-m', 'a cloned repo that ships .skill-runs as a symlink');
  e.d('init', '--merge', '--note', 'ok');
  ship(e, 'FEATURE-001'); assert.equal(e.d('merge', 'FEATURE-001').json.state, 'merged');
  assert.deepEqual(fs.readdirSync(target), []);
  // and a symlinked jsonl file is refused too
  const e2 = setup();
  fs.mkdirSync(path.join(e2.work, '.skill-runs'));
  const victim = path.join(e2.root, 'victim.txt'); fs.writeFileSync(victim, 'keep\n');
  fs.symlinkSync(victim, path.join(e2.work, '.skill-runs', 'factory-runs.jsonl'));
  sh(e2.work, 'add', '-A'); sh(e2.work, 'commit', '-q', '-m', 'shipped symlink');
  e2.d('init', '--merge', '--note', 'ok');
  ship(e2, 'FEATURE-001'); assert.equal(e2.d('merge', 'FEATURE-001').json.state, 'merged');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
});
