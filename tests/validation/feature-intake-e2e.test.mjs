// feature-intake M5: an approved intake spec flows through the existing consumers unchanged: the delivery queue
// (deliver init --dry-run), the factory's criteria extraction and scenario lint, the implementer's close-out and pi validate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, FIXTURES, tmpDir, projectFrom, validateJson } from './helpers.mjs';

const FI = path.join(REPO, 'skills', 'feature-intake', 'core', 'scripts', 'fi.mjs');
const DO = path.join(REPO, 'skills', 'delivery-orchestrator', 'core', 'scripts');
const DELIVER = path.join(DO, 'deliver.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'validation', 'fixtures-gh', 'gh.mjs');
const { extractCriteria, canonicalSpec, criteriaHash } = await import(path.join(DO, 'lib', 'criteria.mjs'));
const { lintScenarios, approve, isCurrentApproved } = await import(path.join(DO, 'lib', 'scenarios.mjs'));
const TODAY = '2026-11-22';
const ENV = { SKILL_RUNLOG: 'off', FI_TODAY: TODAY, PI_TODAY: TODAY };

// A draft intake spec from the valid-minimal fixture (status draft, empty Approval history), with its own id, title and deps.
function draft(id, { title = `Health check ${id}`, deps = '' } = {}) {
  return fs.readFileSync(path.join(FIXTURES, 'intake', 'valid-minimal.md'), 'utf8')
    .replace(/^status: ready$/m, 'status: draft').replace(/^id: FEATURE-001$/m, `id: ${id}`)
    .replace(/^title: .*$/m, `title: ${title}`).replace(/^# .*$/m, `# ${title}`).replace(/^depends_on:$/m, `depends_on:${deps ? ` ${deps}` : ''}`);
}
const specFile = (dir, id) => path.join(dir, '.product', 'features', `${id}.md`);
const read = (dir, id) => fs.readFileSync(specFile(dir, id), 'utf8');
const fi = (dir, ...args) => { const r = spawnSync('node', [FI, ...args, '--dir', dir], { encoding: 'utf8', env: { ...process.env, ...ENV } }); return { code: r.status, out: r.stdout, err: r.stderr }; };
// Write the drafts, then make each ready through the real `fi approve` (never by hand-setting status: ready).
function addIntake(dir, drafts, approveIds = Object.keys(drafts)) {
  fs.mkdirSync(path.join(dir, '.product', 'features'), { recursive: true });
  for (const [id, text] of Object.entries(drafts)) fs.writeFileSync(specFile(dir, id), text);
  for (const id of approveIds) { const r = fi(dir, 'approve', id, '--by', 'Sourav', '--note', 'ship it'); assert.equal(r.code, 0, r.err + r.out); }
  return dir;
}

// The minimum of delivery-orchestrator.test.mjs's setup: commit `dir` as a clone of a local bare origin that looks like the
// GitHub repo o/r to the fake gh, then run `deliver init --dry-run` and return its JSON.
const git = (cwd, env, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }); assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`); };
function dryRun(work) {
  const root = tmpDir('fi-e2e-');
  const origin = path.join(root, 'origin.git');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.copyFileSync(FAKE_GH, path.join(bin, 'gh.mjs'));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node "${path.join(bin, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
  const rw = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${origin}.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:o/r.git' };
  git(root, {}, 'init', '-q', '--bare', '-b', 'main', origin);
  git(work, {}, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@x'], ['user.name', 't']]) git(work, {}, 'config', k, v);
  git(work, {}, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
  fs.writeFileSync(path.join(work, '.product', 'delivery.json'), JSON.stringify({ protected_branches: [] }, null, 2));
  git(work, rw, 'add', '-A'); git(work, rw, 'commit', '-q', '-m', 'init'); git(work, rw, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(root, 'gh-state.json');
  fs.writeFileSync(state, JSON.stringify({ origin, prs: [], calls: [], required: [{ name: 'ci', bucket: 'pass' }], checkQueue: [] }));
  const env = { ...process.env, ...ENV, ...rw, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, FACTORY_HOME: path.join(root, 'fhome') };
  const r = spawnSync('node', [DELIVER, 'init', '--dry-run', '--dir', work], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const json = JSON.parse(r.stdout);
  assert.equal(json.dry_run, true);
  return json.queue.map((f) => ({ id: f.id, title: f.title, deps: f.deps }));
}

test('an approved intake spec appears in deliver init --dry-run with its title and order', () => {
  const dir = addIntake(tmpDir('fi-e2e-w-'), { 'FEATURE-001': draft('FEATURE-001', { title: 'Health check endpoint' }) });
  assert.match(read(dir, 'FEATURE-001'), /^status: ready$/m);
  assert.deepEqual(dryRun(dir), [{ id: 'FEATURE-001', title: 'Health check endpoint', deps: [] }]);
});

test('depends_on between two intake specs orders the queue; a draft intake spec is not queued', () => {
  // FEATURE-002 depends on FEATURE-003, so it is queued after it despite its lower id; FEATURE-004 stays a draft.
  const dir = addIntake(tmpDir('fi-e2e-w-'), {
    'FEATURE-002': draft('FEATURE-002', { title: 'Health dashboard', deps: 'FEATURE-003' }),
    'FEATURE-003': draft('FEATURE-003', { title: 'Health route' }),
    'FEATURE-004': draft('FEATURE-004', { title: 'Unapproved idea' }),
  }, ['FEATURE-003', 'FEATURE-002']);
  assert.match(read(dir, 'FEATURE-004'), /^status: draft$/m);
  assert.deepEqual(dryRun(dir), [
    { id: 'FEATURE-003', title: 'Health route', deps: [] },
    { id: 'FEATURE-002', title: 'Health dashboard', deps: ['FEATURE-003'] },
  ]);
});

test('an intake spec and a product-intelligence spec coexist in one queue', () => {
  const dir = projectFrom('a'); // .product/features/FEATURE-001.md is a ready product-intelligence spec
  addIntake(dir, { 'FEATURE-002': draft('FEATURE-002', { title: 'Health check endpoint' }) });
  assert.deepEqual(dryRun(dir), [
    { id: 'FEATURE-001', title: 'Batch image processing', deps: [] },
    { id: 'FEATURE-002', title: 'Health check endpoint', deps: [] },
  ]);
});

// An API scenario doc in the shape of the valid doc in factory-scenarios.test.mjs, for valid-minimal's criteria.
const CAN = 'fx-7f3a9c';
const scenarioDoc = (hash) => ({
  feature: 'FEATURE-001', criteria_hash: hash, canary: CAN,
  scenarios: [
    { id: 'S-1', covers: ['AC-1', 'EC-1'], kind: 'api', request: { method: 'GET', path: `/api/health?probe=${CAN}` }, assert: [{ status: 200 }] },
    { id: 'S-2', covers: ['ER-1'], kind: 'ui', steps: ['Send a POST to the health route'], expect: ['It answers HTTP 405'] },
  ],
});
const approvedOne = () => addIntake(tmpDir('fi-e2e-s-'), { 'FEATURE-001': draft('FEATURE-001') });

test('scenario lint accepts an API scenario for an intake spec with an HTTP contract', () => {
  const text = read(approvedOne(), 'FEATURE-001');
  const c = extractCriteria(text);
  assert.equal(c.ok, true, c.errors.join('\n'));
  assert.deepEqual([...c.ac, ...c.ec, ...c.er].map((x) => x.id), ['AC-1', 'EC-1', 'ER-1']);
  assert.deepEqual(c.contract, [{ method: 'GET', path: '/api/health' }]);
  const h = criteriaHash(canonicalSpec(text));
  assert.equal(h, criteriaHash(c.sections));
  assert.deepEqual(lintScenarios(scenarioDoc(h), c, h), { ok: true, problems: [] });
});

test('simulated close-out edits keep the spec valid and the criteria hash unchanged', () => {
  const dir = projectFrom('a');
  addIntake(dir, { 'FEATURE-002': draft('FEATURE-002') });
  const ready = read(dir, 'FEATURE-002');
  const h = criteriaHash(canonicalSpec(ready));
  const check = (what) => {
    const v = fi(dir, 'validate', 'FEATURE-002');
    assert.equal(v.code, 0, `${what}: ${v.out}${v.err}`);
    assert.equal(criteriaHash(canonicalSpec(read(dir, 'FEATURE-002'))), h, what);
    assert.deepEqual(validateJson(dir).errors, [], `${what}: pi validate`);
  };
  // run 1 (partial): status stays ready, delivery and the first Delivery log row say it is part built
  const log = '\n## Delivery log\n| Date | Branch / PR | Delivered | Pending (code) | Pending (non-code) | Notes |\n|---|---|---|---|---|---|\n| 2026-11-22 | feat/health (commits a1b2c3) | AC-1 | EC-1, ER-1 | none | wave 1 |\n';
  const partial = ready.replace(/^delivery: none$/m, 'delivery: partial');
  assert.notEqual(partial, ready, 'the fixture has a delivery: none line to replace');
  fs.writeFileSync(specFile(dir, 'FEATURE-002'), partial + log);
  check('partial');
  // run 2 (complete): status implemented, delivery complete, one more row; no opportunity, so no pi transition
  const run1 = read(dir, 'FEATURE-002');
  const implemented = run1.replace(/^status: ready$/m, 'status: implemented');
  assert.notEqual(implemented, run1, 'the spec has a status: ready line to replace');
  const complete = implemented.replace(/^delivery: partial$/m, 'delivery: complete');
  assert.notEqual(complete, implemented, 'the spec has a delivery: partial line to replace');
  fs.writeFileSync(specFile(dir, 'FEATURE-002'), complete + '| 2026-11-23 | feat/health (commits d4e5f6) | EC-1, ER-1 | none | none | wave 2 |\n');
  check('complete');
  assert.match(read(dir, 'FEATURE-002'), /^status: implemented$/m);
  assert.doesNotMatch(read(dir, 'FEATURE-002'), /^opportunity:/m);
});

test('editing an AC after approval invalidates scenario binding', () => {
  const text = read(approvedOne(), 'FEATURE-001');
  const h = criteriaHash(canonicalSpec(text));
  const doc = approve(scenarioDoc(h), 'alice');
  assert.equal(isCurrentApproved(doc, h), true);
  const edited = text.replace('it receives HTTP 200', 'it receives HTTP 204');
  assert.notEqual(edited, text);
  const h2 = criteriaHash(canonicalSpec(edited));
  assert.notEqual(h2, h);
  assert.equal(isCurrentApproved(doc, h2), false);
  const lint = lintScenarios(doc, extractCriteria(edited), h2);
  assert.equal(lint.ok, false);
  assert.ok(lint.problems.includes('criteria_hash is not current'), lint.problems.join('\n'));
});

test('close-out.md documents the no-opportunity branch', () => {
  const doc = fs.readFileSync(path.join(REPO, 'skills', 'implementer', 'references', 'close-out.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(doc.includes('do not run `pi transition`: there is no opportunity to transition'), 'no-opportunity sentence');
  assert.ok(doc.includes('touch only the `status` and `delivery` frontmatter lines and the trailing `## Delivery log`'), 'intake edit rule');
  assert.ok(doc.includes('fi validate'), 'mentions fi validate');
  assert.ok(doc.includes('run `pi transition <OPP-id> Implemented`'), 'existing opportunity rule kept');
});
